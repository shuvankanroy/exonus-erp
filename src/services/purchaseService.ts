import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { calculateBillSundries, AppliedSundryInput } from './billSundryService.js';
import { StockLedgerEngine } from './stockLedgerService.js';

export interface PurchaseVoucherInput {
  company_id: string;
  series_name?: string;
  date: string; // YYYY-MM-DD
  vendor_account_id: string; // Supplier (Sundry Creditor)
  material_centre_id: string; // Destination Godown
  purchase_order_id?: string; // Optional Link to PO
  goods_receipt_note_id?: string; // Optional Link to GRN
  vendor_invoice_number?: string;
  vendor_invoice_date?: string;
  narration?: string;
  bill_sundries?: AppliedSundryInput[];
  items: Array<{
    item_id: string;
    batch_number?: string;
    mfg_date?: string;
    exp_date?: string;
    qty: number;
    unit_id: string;
    purchase_rate: number;
    discount_pct?: number;
  }>;
}

export function createPurchaseVoucher(db: Database.Database, input: PurchaseVoucherInput) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(input.company_id) as any;
  if (!company) throw new Error('Company not found');

  const vendor = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.vendor_account_id) as any;
  if (!vendor) throw new Error('Vendor account not found');

  const series = db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? AND voucher_type = 'PURCHASE' AND series_name = ?
  `).get(input.company_id, input.series_name || 'Main') as any;
  if (!series) throw new Error('Purchase voucher series not found');

  const purchaseAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'PURCHASE'").get(input.company_id) as any;
  const cgstInAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'CGST_IN'").get(input.company_id) as any;
  const sgstInAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'SGST_IN'").get(input.company_id) as any;
  const igstInAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'IGST_IN'").get(input.company_id) as any;
  const roundOffAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'ROUND_OFF'").get(input.company_id) as any;

  const isInterState = vendor.state_code && vendor.state_code !== company.state_code;

  return db.transaction(() => {
    const nextNum = series.current_number + 1;
    const voucherNumber = `${series.prefix || ''}${String(nextNum).padStart(4, '0')}${series.suffix || ''}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, series.id);

    const voucherId = randomUUID();

    // Raw lines
    let baseTaxableTotal = 0;
    const rawLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      // Handle batch creation if batch provided
      let batchId: string | null = null;
      if (it.batch_number) {
        const existingBatch = db.prepare('SELECT id FROM item_batches WHERE item_id = ? AND batch_number = ?').get(it.item_id, it.batch_number) as any;
        if (existingBatch) {
          batchId = existingBatch.id;
        } else {
          batchId = randomUUID();
          db.prepare(`
            INSERT INTO item_batches (id, item_id, batch_number, mfg_date, exp_date, cost_price)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(batchId, it.item_id, it.batch_number, it.mfg_date || null, it.exp_date || null, it.purchase_rate);
        }
      }

      const discountRate = it.discount_pct || 0;
      const baseAmount = it.qty * it.purchase_rate;
      const discountAmount = Math.round(((baseAmount * discountRate) / 100) * 100) / 100;
      const lineTaxable = Math.round((baseAmount - discountAmount) * 100) / 100;
      baseTaxableTotal = Math.round((baseTaxableTotal + lineTaxable) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        batch_id: batchId,
        material_centre_id: input.material_centre_id,
        qty: it.qty,
        unit_id: it.unit_id,
        rate: it.purchase_rate,
        discount_pct: discountRate,
        taxable_amount: lineTaxable,
        gst_rate: itemRow.gst_rate,
      };
    });

    // Calculate dynamic bill sundries
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

    // 1. Insert Voucher Header
    db.prepare(`
      INSERT INTO vouchers (
        id, company_id, series_id, voucher_type, voucher_number, date, 
        party_account_id, material_centre_id, narration, sub_total, tax_total, gross_total
      ) VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      voucherId, input.company_id, series.id, voucherNumber, input.date,
      input.vendor_account_id, input.material_centre_id,
      input.narration || (input.vendor_invoice_number ? `Vendor Inv: ${input.vendor_invoice_number}` : ''),
      totalTaxable, taxTotal, grossTotal
    );

    // 2. Insert Voucher Items & Inward Stock
    const insertVchItem = db.prepare(`
      INSERT INTO voucher_items (
        id, voucher_id, item_id, batch_id, material_centre_id, qty, unit_id, rate, 
        discount_pct, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, net_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStock = db.prepare(`
      INSERT INTO stock_entries (
        id, company_id, voucher_id, item_id, batch_id, material_centre_id, inward_qty, rate, entry_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of sundryResult.adjustedLines as any[]) {
      insertVchItem.run(
        line.id, voucherId, line.item_id, line.batch_id, line.material_centre_id,
        line.qty, line.unit_id, line.rate, line.discount_pct, line.adjusted_taxable_amount,
        line.gst_rate, line.cgst_amount, line.sgst_amount, line.igst_amount, line.net_amount
      );

      // Inward Perpetual Stock - Only inward if NOT already receipted via GRN
      if (!input.goods_receipt_note_id) {
        insertStock.run(
          randomUUID(), input.company_id, voucherId, line.item_id, line.batch_id,
          line.material_centre_id, line.qty, line.rate, input.date
        );

        // ERPNext Immutable Stock Ledger Entry (SLE) & Bin Update
        try {
          const sleEngine = new StockLedgerEngine(db);
          sleEngine.postEntry({
            company_id: input.company_id,
            voucher_id: voucherId,
            voucher_type: 'PURCHASE',
            voucher_number: voucherNumber,
            posting_date: input.date,
            item_id: line.item_id,
            material_centre_id: line.material_centre_id,
            batch_id: line.batch_id,
            actual_qty: line.qty,
            incoming_rate: line.rate
          });
        } catch (e) {
          console.warn('SLE posting notice:', e);
        }
      }

      // If linked to PO, update backlog
      if (input.purchase_order_id) {
        db.prepare(`
          UPDATE purchase_order_items 
          SET received_qty = received_qty + ?, 
              pending_qty = MAX(0, pending_qty - ?)
          WHERE po_id = ? AND item_id = ?
        `).run(line.qty, line.qty, input.purchase_order_id, line.item_id);
      }
    }

    // Insert applied sundry lines
    const insertSundryLine = db.prepare(`
      INSERT INTO voucher_bill_sundry_lines (id, voucher_id, bill_sundry_id, rate, amount)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const sl of sundryResult.calculatedLines) {
      insertSundryLine.run(sl.id, voucherId, sl.bill_sundry_id, sl.rate, sl.amount);
    }

    if (input.purchase_order_id) {
      const remainingPending = db.prepare(`
        SELECT SUM(pending_qty) as total_pending FROM purchase_order_items WHERE po_id = ?
      `).get(input.purchase_order_id) as any;
      const newStatus = (remainingPending.total_pending || 0) === 0 ? 'COMPLETED' : 'PARTIAL';
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(newStatus, input.purchase_order_id);
    }

    if (input.goods_receipt_note_id) {
      db.prepare("UPDATE goods_receipt_notes SET status = 'BILLED' WHERE id = ?").run(input.goods_receipt_note_id);
    }

    // 3. Double-Entry General Ledger Postings
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, company_id, voucher_id, account_id, debit, credit, entry_date, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Debit Purchase Account (Base Item Taxable Total)
    insertLedger.run(randomUUID(), input.company_id, voucherId, purchaseAcc.id, baseTaxableTotal, 0, input.date, `Purchase: ${voucherNumber}`);

    // Post Applied Bill Sundries to General Ledger
    for (const sl of sundryResult.calculatedLines) {
      if (sl.amount === 0 || !sl.linked_account_id) continue;
      if (sl.type === 'ADDITION') {
        // Expense incurred by buyer (e.g. Freight Paid, Packaging): Debit expense
        insertLedger.run(randomUUID(), input.company_id, voucherId, sl.linked_account_id, sl.amount, 0, input.date, sl.name);
      } else {
        // Discount received from vendor: Credit discount income
        insertLedger.run(randomUUID(), input.company_id, voucherId, sl.linked_account_id, 0, sl.amount, input.date, sl.name);
      }
    }

    // Debit Input GST (Tax Credit)
    if (totalCgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, cgstInAcc.id, totalCgst, 0, input.date, 'CGST Input Credit');
    if (totalSgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, sgstInAcc.id, totalSgst, 0, input.date, 'SGST Input Credit');
    if (totalIgst > 0) insertLedger.run(randomUUID(), input.company_id, voucherId, igstInAcc.id, totalIgst, 0, input.date, 'IGST Input Credit');

    // Post Round-Off differential
    if (roundOffDiff !== 0 && roundOffAcc) {
      if (roundOffDiff > 0) {
        // We added cents: Credit Round-Off
        insertLedger.run(randomUUID(), input.company_id, voucherId, roundOffAcc.id, 0, roundOffDiff, input.date, 'Round-Off (+)');
      } else {
        // We deducted cents: Debit Round-Off
        insertLedger.run(randomUUID(), input.company_id, voucherId, roundOffAcc.id, Math.abs(roundOffDiff), 0, input.date, 'Round-Off (-)');
      }
    }

    // Credit Vendor Account (Gross Total Liability)
    insertLedger.run(randomUUID(), input.company_id, voucherId, input.vendor_account_id, 0, grossTotal, input.date, `Purchase: ${voucherNumber}`);

    // 4. Bill-by-Bill Reference (Payable)
    db.prepare(`
      INSERT INTO bill_references (
        id, company_id, account_id, ref_voucher_id, ref_number, bill_date, total_amount, pending_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.company_id, input.vendor_account_id, voucherId,
      input.vendor_invoice_number || voucherNumber, input.date, grossTotal, grossTotal
    );

    // 5. Outbox Sync
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'VOUCHER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, voucherId,
      JSON.stringify({ voucherNumber, grossTotal, date: input.date, type: 'PURCHASE' })
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
