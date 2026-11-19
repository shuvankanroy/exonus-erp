import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { registerBankInstrument } from './brsService.js';

export interface ContraInput {
  company_id: string;
  date: string;
  source_account_id: string;      // Account from which funds are transferred (Credited)
  destination_account_id: string; // Account to which funds are deposited (Debited)
  amount: number;
  narration?: string;
  cheque_instrument_number?: string;
  cheque_date?: string;
}

/**
 * Creates an atomic Contra Voucher (Cash Deposit, Cash Withdrawal, or Bank-to-Bank Transfer)
 */
export function createContraVoucher(db: Database.Database, input: ContraInput) {
  if (!input.source_account_id || !input.destination_account_id) {
    throw new Error('Both Source and Destination accounts are required for Contra voucher');
  }
  if (input.source_account_id === input.destination_account_id) {
    throw new Error('Source and Destination accounts cannot be the same in Contra voucher');
  }
  if (input.amount <= 0) {
    throw new Error('Transfer amount must be greater than zero');
  }

  // Validate that both accounts belong to Bank Accounts or Cash-in-hand
  const sourceAcc = db.prepare(`
    SELECT a.*, ag.name as group_name 
    FROM accounts a 
    JOIN account_groups ag ON a.group_id = ag.id 
    WHERE a.id = ? AND a.company_id = ?
  `).get(input.source_account_id, input.company_id) as any;

  const destAcc = db.prepare(`
    SELECT a.*, ag.name as group_name 
    FROM accounts a 
    JOIN account_groups ag ON a.group_id = ag.id 
    WHERE a.id = ? AND a.company_id = ?
  `).get(input.destination_account_id, input.company_id) as any;

  if (!sourceAcc || !destAcc) throw new Error('Source or Destination account not found');

  const validGroups = ['Bank Accounts', 'Cash-in-hand'];
  if (!validGroups.includes(sourceAcc.group_name) || !validGroups.includes(destAcc.group_name)) {
    throw new Error('Contra vouchers only permit transfers between Bank and Cash accounts');
  }

  const series = db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? AND voucher_type = 'CONTRA' AND series_name = 'Main'
  `).get(input.company_id) as any;
  if (!series) throw new Error('CONTRA voucher series not found');

  return db.transaction(() => {
    const nextNum = series.current_number + 1;
    const voucherNumber = `${series.prefix || 'CON/'}${String(nextNum).padStart(4, '0')}${series.suffix || ''}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, series.id);

    const voucherId = randomUUID();

    // 1. Voucher Header
    db.prepare(`
      INSERT INTO vouchers (
        id, company_id, series_id, voucher_type, voucher_number, date, 
        party_account_id, narration, gross_total
      ) VALUES (?, ?, ?, 'CONTRA', ?, ?, ?, ?, ?)
    `).run(
      voucherId, input.company_id, series.id, voucherNumber,
      input.date, destAcc.id, input.narration || `Transfer from ${sourceAcc.name} to ${destAcc.name}`, input.amount
    );

    // 2. Double-Entry General Ledger Postings
    const insertLedger = db.prepare(`
      INSERT INTO ledger_entries (
        id, company_id, voucher_id, account_id, debit, credit, entry_date, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Debit Destination Account (Inflow)
    insertLedger.run(
      randomUUID(), input.company_id, voucherId, destAcc.id, input.amount, 0, input.date,
      `Contra Inflow: Received from ${sourceAcc.name}`
    );

    // Credit Source Account (Outflow)
    insertLedger.run(
      randomUUID(), input.company_id, voucherId, sourceAcc.id, 0, input.amount, input.date,
      `Contra Outflow: Transferred to ${destAcc.name}`
    );

    // 3. Register Bank Instrument for BRS if Source is a Bank (e.g. Cheque / Online Transfer)
    if (sourceAcc.group_name === 'Bank Accounts') {
      registerBankInstrument(db, {
        company_id: input.company_id,
        bank_account_id: sourceAcc.id,
        voucher_id: voucherId,
        cheque_instrument_number: input.cheque_instrument_number,
        cheque_date: input.cheque_date || input.date,
        amount: input.amount
      });
    }

    // 4. Outbox Sync for Cloud Relay
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'VOUCHER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, voucherId,
      JSON.stringify({ voucherNumber, amount: input.amount, type: 'CONTRA', date: input.date })
    );

    return {
      voucherId,
      voucherNumber,
      amount: input.amount,
      sourceAccount: sourceAcc.name,
      destinationAccount: destAcc.name
    };
  })();
}
