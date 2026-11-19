import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface SalesVoucherInput {
  company_id: string;
  series_name?: string;
  date: string; // YYYY-MM-DD
  party_account_id: string; // Customer / Cash
  material_centre_id: string; // Godown
  narration?: string;
  pos_settlement_type?: 'CASH' | 'UPI' | 'CARD' | 'SPLIT' | 'CREDIT';
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

  // Find system sales & tax accounts
  const salesAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'SALES'").get(input.company_id) as any;
  const cgstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'CGST_OUT'").get(input.company_id) as any;
  const sgstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'SGST_OUT'").get(input.company_id) as any;
  const igstAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'IGST_OUT'").get(input.company_id) as any;

  // Determine Inter-state vs Intra-state GST
  const isInterState = party.state_code && party.state_code !== company.state_code;

  return db.transaction(() => {
    // 1. Next Voucher Number
    const nextNum = series.current_number + 1;
    const voucherNumber = `${series.prefix || ''}${String(nextNum).padStart(4, '0')}${series.suffix || ''}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, series.id);

    const voucherId = randomUUID();
    let totalTaxable = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;

    // Process line items
    const processedItems = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      const discountRate = it.discount_pct || 0;
      const baseAmount = it.qty * it.rate;
      const discountAmount = (baseAmount * discountRate) / 100;
      const taxable = baseAmount - discountAmount;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (isInterState) {
        igst = (taxable * itemRow.gst_rate) / 100;
      } else {
        cgst = (taxable * (itemRow.gst_rate / 2)) / 100;
        sgst = (taxable * (itemRow.gst_rate / 2)) / 100;
      }

      totalTaxable += taxable;
      totalCgst += cgst;
      totalSgst += sgst;
      totalIgst += igst;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        batch_id: it.batch_id || null,
        material_centre_id: input.material_centre_id,
        qty: it.qty,
        unit_id: it.unit_id,
        rate: it.rate,
        discount_pct: discountRate,
        taxable_amount: taxable,
        gst_rate: itemRow.gst_rate,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        net_amount: taxable + cgst + sgst + igst,
      };
    });

    const taxTotal = totalCgst + totalSgst + totalIgst;
    const grossTotal = Math.round((totalTaxable + taxTotal) * 100) / 100;

    // 2. Insert Voucher Header
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

    // 3. Insert Voucher Items & Deduct Perpetual Stock
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

    for (const line of processedItems) {
      insertVchItem.run(
        line.id, voucherId, line.item_id, line.batch_id, line.material_centre_id,
        line.qty, line.unit_id, line.rate, line.discount_pct, line.taxable_amount,
        line.gst_rate, line.cgst_amount, line.sgst_amount, line.igst_amount, line.net_amount
      );

      // Stock ledger entry (Outward)
      insertStock.run(
        randomUUID(), input.company_id, voucherId, line.item_id, line.batch_id,
        line.material_centre_id, line.qty, line.rate, input.date
      );
    }

    // 4. Double-Entry General Ledger Postings
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, company_id, voucher_id, account_id, debit, credit, entry_date, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Debit Party Account (Gross Total)
    insertLedger.run(randomUUID(), input.company_id, voucherId, input.party_account_id, grossTotal, 0, input.date, `Sales: ${voucherNumber}`);

    // Credit Sales Account (Taxable Value)
    insertLedger.run(randomUUID(), input.company_id, voucherId, salesAcc.id, 0, totalTaxable, input.date, `Sales: ${voucherNumber}`);

    // Credit GST Output Accounts
    if (totalCgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, cgstAcc.id, 0, totalCgst, input.date, 'CGST Output');
    if (totalSgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, sgstAcc.id, 0, totalSgst, input.date, 'SGST Output');
    if (totalIgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, igstAcc.id, 0, totalIgst, input.date, 'IGST Output');

    // 5. Bill-by-Bill Reference Entry
    db.prepare(`
      INSERT INTO bill_references (
        id, company_id, account_id, ref_voucher_id, ref_number, bill_date, total_amount, pending_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.company_id, input.party_account_id, voucherId,
      voucherNumber, input.date, grossTotal, grossTotal
    );

    // 6. Outbox Sync Queue (Replicates to Cloud for Silver Cloud & Gold Cloud)
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
      taxableTotal: totalTaxable
    };
  })();
}
