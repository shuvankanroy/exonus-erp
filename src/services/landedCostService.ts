import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { StockLedgerEngine } from './stockLedgerService.js';

export type LcvDistributionMethod = 'Qty' | 'Amount' | 'Manual';

export interface LandedCostVoucherInput {
  company_id: string;
  posting_date: string; // YYYY-MM-DD
  distribute_charges_based_on: LcvDistributionMethod;
  receipt_voucher_id: string; // Purchase Receipt / GRN ID
  charges: Array<{
    expense_account_id: string;
    description: string;
    amount: number;
  }>;
}

export class LandedCostService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Allocates third-party landed expenses (freight, customs, insurance)
   * across goods in a Purchase Receipt and revalues the inventory in SQLite.
   */
  public executeLandedCostVoucher(input: LandedCostVoucherInput) {
    const totalCharges = input.charges.reduce((sum, c) => sum + Number(c.amount), 0);
    if (totalCharges <= 0) throw new Error('Total charges must be greater than zero.');

    // 1. Fetch line items of the receipt
    const items = this.db.prepare(`
      SELECT * FROM grn_items WHERE grn_id = ?
    `).all(input.receipt_voucher_id) as any[];

    if (!items || items.length === 0) {
      throw new Error('No items found for the given Purchase Receipt.');
    }

    const lcvId = randomUUID();
    const lcvCount = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_ledger_entries WHERE voucher_type = 'LANDED_COST' AND company_id = ?
    `).get(input.company_id) as any;
    const lcvNumber = `LCV/${String(lcvCount.count + 1).padStart(4, '0')}`;

    // 2. Compute allocation per item (identical to ERPNext LCV distribute_charges)
    const basisField = input.distribute_charges_based_on === 'Qty' ? 'received_qty' : 'amount';
    const totalBasis = items.reduce((sum, it) => {
      const val = basisField === 'received_qty' ? Number(it.received_qty) : (Number(it.received_qty) * Number(it.rate));
      return sum + val;
    }, 0);

    if (totalBasis <= 0) throw new Error(`Total ${input.distribute_charges_based_on} of receipt items is zero.`);

    const chargesPerUnit = totalCharges / totalBasis;
    let allocatedTotal = 0;

    const allocations = items.map((it, idx) => {
      const itBasis = basisField === 'received_qty' ? Number(it.received_qty) : (Number(it.received_qty) * Number(it.rate));
      let lineCharge = Math.round((itBasis * chargesPerUnit) * 100) / 100;
      
      // Absorb rounding discrepancy on last item (same as ERPNext absorb_rounding_difference)
      if (idx === items.length - 1) {
        lineCharge = Math.round((totalCharges - allocatedTotal) * 100) / 100;
      } else {
        allocatedTotal += lineCharge;
      }

      const additionalRatePerUnit = Math.round((lineCharge / it.received_qty) * 1000) / 1000;
      const newIncomingRate = Math.round((Number(it.rate) + additionalRatePerUnit) * 1000) / 1000;

      return {
        item_id: it.item_id,
        received_qty: it.received_qty,
        original_rate: it.rate,
        allocated_charge: lineCharge,
        new_incoming_rate: newIncomingRate
      };
    });

    // 3. Post SLE revaluation entries
    const sleEngine = new StockLedgerEngine(this.db);
    const grn = this.db.prepare('SELECT material_centre_id FROM goods_receipt_notes WHERE id = ?').get(input.receipt_voucher_id) as any;

    return this.db.transaction(() => {
      for (const alloc of allocations) {
        sleEngine.postEntry({
          company_id: input.company_id,
          voucher_id: lcvId,
          voucher_type: 'LANDED_COST',
          voucher_number: lcvNumber,
          posting_date: input.posting_date,
          item_id: alloc.item_id,
          material_centre_id: grn.material_centre_id,
          actual_qty: 0, // Rate revaluation adjustment
          incoming_rate: alloc.new_incoming_rate
        });
      }

      return {
        lcvId,
        lcvNumber,
        totalCharges,
        distributionMethod: input.distribute_charges_based_on,
        allocations
      };
    })();
  }
}
