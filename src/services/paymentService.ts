import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface PaymentReceiptInput {
  company_id: string;
  voucher_type: 'PAYMENT' | 'RECEIPT'; // PAYMENT = Outflow to Creditor/Expense, RECEIPT = Inflow from Debtor/Income
  date: string;
  party_account_id: string; // Customer or Supplier
  bank_cash_account_id: string; // Bank or Cash ledger
  amount: number;
  narration?: string;
  adjust_bills?: Array<{
    bill_reference_id: string;
    amount_to_adjust: number;
  }>;
}

export function createPaymentReceiptVoucher(db: Database.Database, input: PaymentReceiptInput) {
  const series = db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? AND voucher_type = ? AND series_name = 'Main'
  `).get(input.company_id, input.voucher_type) as any;
  if (!series) throw new Error(`${input.voucher_type} series not found`);

  return db.transaction(() => {
    const nextNum = series.current_number + 1;
    const voucherNumber = `${series.prefix || ''}${String(nextNum).padStart(4, '0')}${series.suffix || ''}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, series.id);

    const voucherId = randomUUID();

    // 1. Voucher Header
    db.prepare(`
      INSERT INTO vouchers (
        id, company_id, series_id, voucher_type, voucher_number, date, 
        party_account_id, narration, gross_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      voucherId, input.company_id, series.id, input.voucher_type, voucherNumber,
      input.date, input.party_account_id, input.narration || '', input.amount
    );

    // 2. Double-Entry General Ledger Postings
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, company_id, voucher_id, account_id, debit, credit, entry_date, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (input.voucher_type === 'RECEIPT') {
      // Inflow: Debit Cash/Bank, Credit Party (Debtor)
      insertLedger.run(randomUUID(), input.company_id, voucherId, input.bank_cash_account_id, input.amount, 0, input.date, `Receipt: ${voucherNumber}`);
      insertLedger.run(randomUUID(), input.company_id, voucherId, input.party_account_id, 0, input.amount, input.date, `Receipt: ${voucherNumber}`);
    } else {
      // Outflow: Debit Party (Creditor), Credit Cash/Bank
      insertLedger.run(randomUUID(), input.company_id, voucherId, input.party_account_id, input.amount, 0, input.date, `Payment: ${voucherNumber}`);
      insertLedger.run(randomUUID(), input.company_id, voucherId, input.bank_cash_account_id, 0, input.amount, input.date, `Payment: ${voucherNumber}`);
    }

    // 3. Bill-by-Bill FIFO or Manual Adjustments
    let remainingToAdjust = input.amount;

    if (input.adjust_bills && input.adjust_bills.length > 0) {
      for (const adj of input.adjust_bills) {
        db.prepare(`
          INSERT INTO bill_adjustments (id, bill_reference_id, payment_voucher_id, adjusted_amount, adjustment_date)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), adj.bill_reference_id, voucherId, adj.amount_to_adjust, input.date);

        db.prepare(`
          UPDATE bill_references 
          SET pending_amount = pending_amount - ? 
          WHERE id = ?
        `).run(adj.amount_to_adjust, adj.bill_reference_id);
      }
    } else {
      // Auto FIFO Settlement against open bills
      const openBills = db.prepare(`
        SELECT * FROM bill_references 
        WHERE company_id = ? AND account_id = ? AND pending_amount > 0 
        ORDER BY bill_date ASC
      `).all(input.company_id, input.party_account_id) as any[];

      for (const bill of openBills) {
        if (remainingToAdjust <= 0) break;
        const settleAmt = Math.min(bill.pending_amount, remainingToAdjust);

        db.prepare(`
          INSERT INTO bill_adjustments (id, bill_reference_id, payment_voucher_id, adjusted_amount, adjustment_date)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), bill.id, voucherId, settleAmt, input.date);

        db.prepare(`
          UPDATE bill_references 
          SET pending_amount = pending_amount - ? 
          WHERE id = ?
        `).run(settleAmt, bill.id);

        remainingToAdjust -= settleAmt;
      }
    }

    // 4. Outbox Sync
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'VOUCHER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, voucherId,
      JSON.stringify({ voucherNumber, amount: input.amount, type: input.voucher_type, date: input.date })
    );

    return {
      voucherId,
      voucherNumber,
      amount: input.amount,
      voucher_type: input.voucher_type
    };
  })();
}
