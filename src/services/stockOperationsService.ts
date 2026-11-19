import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { StockLedgerEngine } from './stockLedgerService.js';

export type StockEntryPurpose = 'Material Transfer' | 'Material Issue' | 'Material Receipt' | 'Manufacture';

export interface StockEntryInput {
  company_id: string;
  purpose: StockEntryPurpose;
  date: string; // YYYY-MM-DD
  from_material_centre_id?: string; // Source Warehouse (for Transfer, Issue, Manufacture)
  to_material_centre_id?: string;   // Target Warehouse (for Transfer, Receipt, Manufacture)
  narration?: string;
  items: Array<{
    item_id: string;
    qty: number;
    rate?: number;
    batch_id?: string;
  }>;
}

export interface StockReconciliationInput {
  company_id: string;
  material_centre_id: string;
  posting_date: string;
  items: Array<{
    item_id: string;
    physical_qty: number;
    valuation_rate?: number;
  }>;
}

export class StockOperationsService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Executes ERPNext-Grade Stock Entry (Transfer, Issue, Receipt, Manufacture)
   */
  public executeStockEntry(input: StockEntryInput) {
    const entryId = randomUUID();
    const count = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_ledger_entries WHERE company_id = ? AND voucher_type = 'STOCK_ENTRY'
    `).get(input.company_id) as any;
    const entryNumber = `STE/${String(count.count + 1).padStart(4, '0')}`;

    const sleEngine = new StockLedgerEngine(this.db);

    return this.db.transaction(() => {
      for (const it of input.items) {
        if (input.purpose === 'Material Transfer') {
          if (!input.from_material_centre_id || !input.to_material_centre_id) {
            throw new Error('Both from_material_centre_id and to_material_centre_id are required for Material Transfer.');
          }

          // Outward from Source
          const outSle = sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: entryId,
            voucher_type: 'STOCK_ENTRY',
            voucher_number: entryNumber,
            posting_date: input.date,
            item_id: it.item_id,
            material_centre_id: input.from_material_centre_id,
            batch_id: it.batch_id,
            actual_qty: -it.qty,
            outgoing_rate: it.rate
          });

          // Inward into Target (at exact valuation rate computed on outward leg)
          sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: entryId,
            voucher_type: 'STOCK_ENTRY',
            voucher_number: entryNumber,
            posting_date: input.date,
            item_id: it.item_id,
            material_centre_id: input.to_material_centre_id,
            batch_id: it.batch_id,
            actual_qty: it.qty,
            incoming_rate: outSle.valuationRate
          });
        } else if (input.purpose === 'Material Issue') {
          if (!input.from_material_centre_id) {
            throw new Error('from_material_centre_id is required for Material Issue.');
          }
          sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: entryId,
            voucher_type: 'STOCK_ENTRY',
            voucher_number: entryNumber,
            posting_date: input.date,
            item_id: it.item_id,
            material_centre_id: input.from_material_centre_id,
            batch_id: it.batch_id,
            actual_qty: -it.qty,
            outgoing_rate: it.rate
          });
        } else if (input.purpose === 'Material Receipt') {
          if (!input.to_material_centre_id) {
            throw new Error('to_material_centre_id is required for Material Receipt.');
          }
          sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: entryId,
            voucher_type: 'STOCK_ENTRY',
            voucher_number: entryNumber,
            posting_date: input.date,
            item_id: it.item_id,
            material_centre_id: input.to_material_centre_id,
            batch_id: it.batch_id,
            actual_qty: it.qty,
            incoming_rate: it.rate || 0
          });
        }
      }

      return {
        entryId,
        entryNumber,
        purpose: input.purpose,
        itemCount: input.items.length
      };
    })();
  }

  /**
   * Executes ERPNext-Grade Physical Stock Reconciliation
   * Compares physical count vs book balance and posts variance SLEs.
   */
  public executeStockReconciliation(input: StockReconciliationInput) {
    const reconId = randomUUID();
    const count = this.db.prepare(`
      SELECT COUNT(*) as count FROM stock_ledger_entries WHERE company_id = ? AND voucher_type = 'STOCK_RECON'
    `).get(input.company_id) as any;
    const reconNumber = `SR/${String(count.count + 1).padStart(4, '0')}`;

    const sleEngine = new StockLedgerEngine(this.db);
    const adjustments: any[] = [];

    return this.db.transaction(() => {
      for (const it of input.items) {
        // Fetch current book qty from Bin
        const bin = this.db.prepare(`
          SELECT * FROM bins WHERE company_id = ? AND item_id = ? AND material_centre_id = ?
        `).get(input.company_id, it.item_id, input.material_centre_id) as any;

        const currentQty = bin ? Number(bin.actual_qty) : 0;
        const currentValRate = bin ? Number(bin.valuation_rate) : 0;
        const diffQty = Math.round((it.physical_qty - currentQty) * 1000) / 1000;

        if (diffQty !== 0) {
          const rate = it.valuation_rate || currentValRate;
          const sle = sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: reconId,
            voucher_type: 'STOCK_RECON',
            voucher_number: reconNumber,
            posting_date: input.posting_date,
            item_id: it.item_id,
            material_centre_id: input.material_centre_id,
            actual_qty: diffQty,
            incoming_rate: diffQty > 0 ? rate : 0,
            outgoing_rate: diffQty < 0 ? rate : 0
          });

          adjustments.push({
            item_id: it.item_id,
            system_qty: currentQty,
            physical_qty: it.physical_qty,
            variance_qty: diffQty,
            stock_value_difference: sle.stockValueDifference
          });
        }
      }

      return {
        reconId,
        reconNumber,
        adjustmentsCount: adjustments.length,
        adjustments
      };
    })();
  }
}
