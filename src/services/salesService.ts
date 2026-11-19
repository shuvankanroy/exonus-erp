import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { calculateBillSundries, AppliedSundryInput } from './billSundryService.js';

export interface SalesVoucherInput {
  company_id: string;
  series_name?: string;
  date: string; // YYYY-MM-DD
  party_account_id: string; // Customer / Cash
  material_centre_id: string; // Godown
  sales_order_id?: string; // Optional Link to Sales Order
  delivery_challan_id?: string; // Optional Link to Delivery Challan
  narration?: string;
  pos_settlement_type?: 'CASH' | 'UPI' | 'CARD' | 'SPLIT' | 'CREDIT';
  bill_sundries?: AppliedSundryInput[];
  items: Array<{
    item_id: string;
    batch_id?: string;
    qty: number;
    unit_id: string;
    rate: number;
    discount_pct?: number;
  }>;
}

export function createSalesVoucher(db: Database.Database, input: SalesVoucherInput) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(input.company_id) as any;
  if (!company) throw new Error('Company not found');

  const party = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.party_account_id) as any;
  if (!party) throw new Error('Party account not found');

  const series = db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? AND voucher_type = 'SALES' AND series_name = ?
  `).get(input.company_id, input.series_name || 'Main') as any;
  if (!series) throw new Error('Voucher series not found');

  // Find system accounts
  const salesAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'SALES'").get(input.company_id) as any;
  const cgstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'CGST_OUT'").get(input.company_id) as any;
  const sgstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'SGST_OUT'").get(input.company_id) as any;
  const igstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'IGST_OUT'").get(input.company_id) as any;
  const roundOffAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'ROUND_OFF'").get(input.company_id) as any;
  const cashAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'CASH'").get(input.company_id) as any;

  // Determine Inter-state vs Intra-state GST
  const isInterState = party.state_code && party.state_code !== company.state_code;

  return db.transaction(() => {
    // 1. Next Voucher Number
    const nextNum = series.current_number + 1;
    const voucherNumber = `${series.prefix || ''}${String(nextNum).padStart(4, '0')}${series.suffix || ''}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, series.id);

    const voucherId = randomUUID();

    // Prepare raw lines
    let baseTaxableTotal = 0;
    const rawLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      const discountRate = it.discount_pct || 0;
      const baseAmount = it.qty * it.rate;
      const discountAmount = Math.round(((baseAmount * discountRate) / 100) * 100) / 100;
      const lineTaxable = Math.round((baseAmount - discountAmount) * 100) / 100;
      baseTaxableTotal = Math.round((baseTaxableTotal + lineTaxable) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        batch_id: it.batch_id || null,
        material_centre_id: input.material_centre_id,
        qty: it.qty,
        unit_id: it.unit_id,
        rate: it.rate,
        discount_pct: discountRate,
        taxable_amount: lineTaxable,
        gst_rate: itemRow.gst_rate,
      };
    });

    // 2. Dynamic Bill Sundries Calculation Engine (Pre-tax & Post-tax GST compliance)
    const sundryResult = calculateBillSundries(
      db,
      input.company_id,
      baseTaxableTotal,
      input.bill_sundries || [],
      Boolean(isInterState),
      rawLines
    );

    const totalTaxable = sundryResult.adjustedTaxableTotal;
    const totalCgst = sundryResult.totalCgst;
    const totalSgst = sundryResult.totalSgst;
    const totalIgst = sundryResult.totalIgst;
    const taxTotal = sundryResult.taxTotal;
    const grossTotal = sundryResult.finalGross;
    const roundOffDiff = sundryResult.roundOffDiff;

    // 3. Insert Voucher Header
    db.prepare(`
      INSERT INTO vouchers (
        id, company_id, series_id, voucher_type, voucher_number, date, 
        party_account_id, material_centre_id, narration, sub_total, tax_total, gross_total, pos_settlement_type
      ) VALUES (?, ?, ?, 'SALES', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      voucherId, input.company_id, series.id, voucherNumber, input.date,
      input.party_account_id, input.material_centre_id, input.narration || '',
      totalTaxable, taxTotal, grossTotal, input.pos_settlement_type || 'CREDIT'
    );

    // 4. Insert Voucher Items & Deduct Perpetual Stock
    const insertVchItem = db.prepare(`
      INSERT INTO voucher_items (
        id, voucher_id, item_id, batch_id, material_centre_id, qty, unit_id, rate, 
        discount_pct, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, net_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStock = db.prepare(`
      INSERT INTO stock_entries (
        id, company_id, voucher_id, item_id, batch_id, material_centre_id, outward_qty, rate, entry_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of sundryResult.adjustedLines as any[]) {
      insertVchItem.run(
        line.id, voucherId, line.item_id, line.batch_id, line.material_centre_id,
        line.qty, line.unit_id, line.rate, line.discount_pct, line.adjusted_taxable_amount,
        line.gst_rate, line.cgst_amount, line.sgst_amount, line.igst_amount, line.net_amount
      );

      // Stock ledger entry (Outward) - Only deduct if NOT already dispatched via Delivery Challan
      if (!input.delivery_challan_id) {
        insertStock.run(
          randomUUID(), input.company_id, voucherId, line.item_id, line.batch_id,
          line.material_centre_id, line.qty, line.rate, input.date
        );
      }

      // If linked to Sales Order, update order backlog
      if (input.sales_order_id) {
        db.prepare(`
          UPDATE sales_order_items 
          SET delivered_qty = delivered_qty + ?, 
              pending_qty = MAX(0, pending_qty - ?)
          WHERE order_id = ? AND item_id = ?
        `).run(line.qty, line.qty, input.sales_order_id, line.item_id);
      }
    }

    // 5. Insert Applied Bill Sundry Lines
    const insertSundryLine = db.prepare(`
      INSERT INTO voucher_bill_sundry_lines (id, voucher_id, bill_sundry_id, rate, amount)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const sl of sundryResult.calculatedLines) {
      insertSundryLine.run(sl.id, voucherId, sl.bill_sundry_id, sl.rate, sl.amount);
    }

    if (input.sales_order_id) {
      const remainingPending = db.prepare(`
        SELECT SUM(pending_qty) as total_pending FROM sales_order_items WHERE order_id = ?
      `).get(input.sales_order_id) as any;
      const newStatus = (remainingPending.total_pending || 0) === 0 ? 'COMPLETED' : 'PARTIAL';
      db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?').run(newStatus, input.sales_order_id);
    }

    if (input.delivery_challan_id) {
      db.prepare("UPDATE delivery_challans SET status = 'INVOICED' WHERE id = ?").run(input.delivery_challan_id);
    }

    // 6. Double-Entry General Ledger Postings (Immutable Ledger)
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, company_id, voucher_id, account_id, debit, credit, entry_date, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Debit Party or Cash Account (Based on POS settlement)
    const isCashSettlement = input.pos_settlement_type === 'CASH' && cashAcc;
    const debitAccountId = isCashSettlement ? cashAcc.id : input.party_account_id;
    insertLedger.run(randomUUID(), input.company_id, voucherId, debitAccountId, grossTotal, 0, input.date, `Sales: ${voucherNumber}`);

    // Credit Sales Account (Base Item Taxable Total)
    insertLedger.run(randomUUID(), input.company_id, voucherId, salesAcc.id, 0, baseTaxableTotal, input.date, `Sales: ${voucherNumber}`);

    // Post Applied Bill Sundries to General Ledger
    for (const sl of sundryResult.calculatedLines) {
      if (sl.amount === 0 || !sl.linked_account_id) continue;
      if (sl.type === 'ADDITION') {
        // Income or recovery of expense: Credit sundry ledger
        insertLedger.run(randomUUID(), input.company_id, voucherId, sl.linked_account_id, 0, sl.amount, input.date, sl.name);
      } else {
        // Deduction / discount allowed: Debit sundry expense ledger
        insertLedger.run(randomUUID(), input.company_id, voucherId, sl.linked_account_id, sl.amount, 0, input.date, sl.name);
      }
    }

    // Credit GST Output Accounts
    if (totalCgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, cgstAcc.id, 0, totalCgst, input.date, 'CGST Output');
    if (totalSgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, sgstAcc.id, 0, totalSgst, input.date, 'SGST Output');
    if (totalIgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, igstAcc.id, 0, totalIgst, input.date, 'IGST Output');

    // Post Round-Off differential to ensure mathematical perfection (Debits === Credits)
    if (roundOffDiff !== 0 && roundOffAcc) {
      if (roundOffDiff > 0) {
        // We added cents to round up: Credit Round-Off
        insertLedger.run(randomUUID(), input.company_id, voucherId, roundOffAcc.id, 0, roundOffDiff, input.date, 'Round-Off (+)');
      } else {
        // We subtracted cents to round down: Debit Round-Off
        insertLedger.run(randomUUID(), input.company_id, voucherId, roundOffAcc.id, Math.abs(roundOffDiff), 0, input.date, 'Round-Off (-)');
      }
    }

    // 7. Bill-by-Bill Reference Entry (Only for Credit sales)
    if (!isCashSettlement) {
      db.prepare(`
        INSERT INTO bill_references (
          id, company_id, account_id, ref_voucher_id, ref_number, bill_date, total_amount, pending_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), input.company_id, input.party_account_id, voucherId,
        voucherNumber, input.date, grossTotal, grossTotal
      );
    }

    // 8. Outbox Sync Queue (Replicates to Cloud for Silver Cloud & Gold Cloud)
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'VOUCHER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, voucherId,
      JSON.stringify({ voucherNumber, grossTotal, date: input.date, party_account_id: input.party_account_id })
    );

    return {
      voucherId,
      voucherNumber,
      grossTotal,
      taxTotal,
      taxableTotal: totalTaxable,
      sundryLines: sundryResult.calculatedLines
    };
  })();
}
