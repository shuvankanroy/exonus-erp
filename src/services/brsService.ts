import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface BankAccountDetails {
  id: string;
  name: string;
  code?: string;
  book_balance: number;
}

export interface BRSLineItem {
  reconciliation_id: string;
  voucher_id: string;
  voucher_number: string;
  voucher_type: string;
  voucher_date: string;
  party_name: string;
  cheque_instrument_number?: string;
  cheque_date?: string;
  bank_clearance_date?: string;
  status: 'UNCLEARED' | 'CLEARED' | 'BOUNCED';
  transaction_type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
}

export interface BRSStatement {
  bank_account: BankAccountDetails;
  as_of_date: string;
  book_balance: number; // Balance per company General Ledger
  unpresented_cheques_total: number; // Cheques issued (Payments) but not yet presented to bank (+)
  uncleared_deposits_total: number; // Cheques received (Receipts) deposited but not yet cleared in bank (-)
  statement_balance: number; // Estimated Balance per Bank Passbook
  items: BRSLineItem[];
}

/**
 * Ensures standard default bank account exists (e.g., HDFC Bank Current A/c)
 */
export function ensureDefaultBankAccount(db: Database.Database, companyId: string) {
  const bankGroup = db.prepare(`SELECT id FROM account_groups WHERE company_id = ? AND name = 'Bank Accounts'`).get(companyId) as any;
  if (!bankGroup) return null;

  let defaultBank = db.prepare(`SELECT id, name FROM accounts WHERE company_id = ? AND group_id = ? LIMIT 1`).get(companyId, bankGroup.id) as any;
  if (!defaultBank) {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO accounts (id, company_id, group_id, name, code)
      VALUES (?, ?, ?, 'HDFC Bank (Current A/c)', 'BANK_HDFC')
    `).run(id, companyId, bankGroup.id);
    defaultBank = { id, name: 'HDFC Bank (Current A/c)' };
  }
  return defaultBank;
}

/**
 * Retrieves all bank accounts for a company with their real-time General Ledger book balances.
 */
export function getBankAccounts(db: Database.Database, companyId: string) {
  ensureDefaultBankAccount(db, companyId);

  return db.prepare(`
    SELECT 
      a.id,
      a.name,
      a.code,
      (COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id), 0) -
       COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id), 0)) as book_balance
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    WHERE a.company_id = ? AND ag.name = 'Bank Accounts'
    ORDER BY a.name ASC
  `).all(companyId);
}

/**
 * Records or updates a cheque/payment instrument in BRS tracking.
 */
export function registerBankInstrument(db: Database.Database, input: {
  company_id: string;
  bank_account_id: string;
  voucher_id: string;
  cheque_instrument_number?: string;
  cheque_date?: string;
  amount: number;
}) {
  const existing = db.prepare(`
    SELECT id FROM bank_reconciliations WHERE voucher_id = ? AND bank_account_id = ?
  `).get(input.voucher_id, input.bank_account_id) as any;

  if (existing) {
    db.prepare(`
      UPDATE bank_reconciliations 
      SET cheque_instrument_number = ?, cheque_date = ?, amount = ?
      WHERE id = ?
    `).run(input.cheque_instrument_number || null, input.cheque_date || null, input.amount, existing.id);
    return existing.id;
  } else {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO bank_reconciliations (
        id, company_id, bank_account_id, voucher_id, cheque_instrument_number, cheque_date, status, amount
      ) VALUES (?, ?, ?, ?, ?, ?, 'UNCLEARED', ?)
    `).run(
      id, input.company_id, input.bank_account_id, input.voucher_id,
      input.cheque_instrument_number || null, input.cheque_date || null, input.amount
    );
    return id;
  }
}

/**
 * Updates clearance date for a cheque/instrument (Marking as CLEARED or BOUNCED)
 */
export function updateBankClearance(db: Database.Database, input: {
  reconciliation_id: string;
  bank_clearance_date?: string;
  status: 'UNCLEARED' | 'CLEARED' | 'BOUNCED';
}) {
  db.prepare(`
    UPDATE bank_reconciliations 
    SET bank_clearance_date = ?, status = ?
    WHERE id = ?
  `).run(
    input.status === 'CLEARED' ? (input.bank_clearance_date || new Date().toISOString().split('T')[0]) : null,
    input.status,
    input.reconciliation_id
  );

  return { success: true };
}

/**
 * Generates full Bank Reconciliation Statement (BRS) Report matching BUSY ERP
 * Computes:
 * 1. Balance per Company Books
 * 2. Amounts deposited in bank but not yet credited (Uncleared Receipts)
 * 3. Cheques issued but not yet presented for payment (Unpresented Payments)
 * 4. Balance as per Bank Statement
 */
export function getBankReconciliationStatement(
  db: Database.Database,
  companyId: string,
  bankAccountId: string,
  asOfDate?: string
): BRSStatement {
  const targetDate = asOfDate || new Date().toISOString().split('T')[0];

  const bankAccount = db.prepare(`
    SELECT 
      a.id,
      a.name,
      a.code,
      (COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id AND entry_date <= ?), 0) -
       COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id AND entry_date <= ?), 0)) as book_balance
    FROM accounts a
    WHERE a.id = ? AND a.company_id = ?
  `).get(targetDate, targetDate, bankAccountId, companyId) as any;

  if (!bankAccount) throw new Error('Bank account not found');

  // Auto-sync any bank vouchers that may not have a bank_reconciliations entry yet
  const bankVouchers = db.prepare(`
    SELECT 
      v.id as voucher_id,
      v.voucher_number,
      v.voucher_type,
      v.date as voucher_date,
      v.narration,
      v.gross_total as amount,
      le.debit,
      le.credit
    FROM ledger_entries le
    JOIN vouchers v ON le.voucher_id = v.id
    WHERE le.company_id = ? AND le.account_id = ? AND le.entry_date <= ?
  `).all(companyId, bankAccountId, targetDate) as any[];

  for (const bv of bankVouchers) {
    const exists = db.prepare(`SELECT id FROM bank_reconciliations WHERE voucher_id = ? AND bank_account_id = ?`).get(bv.voucher_id, bankAccountId);
    if (!exists) {
      db.prepare(`
        INSERT INTO bank_reconciliations (
          id, company_id, bank_account_id, voucher_id, cheque_instrument_number, cheque_date, status, amount
        ) VALUES (?, ?, ?, ?, ?, ?, 'UNCLEARED', ?)
      `).run(
        randomUUID(), companyId, bankAccountId, bv.voucher_id,
        null, bv.voucher_date, bv.amount
      );
    }
  }

  // Fetch all reconciliation items
  const rawItems = db.prepare(`
    SELECT 
      br.id as reconciliation_id,
      br.voucher_id,
      br.cheque_instrument_number,
      br.cheque_date,
      br.bank_clearance_date,
      br.status,
      br.amount,
      v.voucher_number,
      v.voucher_type,
      v.date as voucher_date,
      a.name as party_name,
      le.debit,
      le.credit
    FROM bank_reconciliations br
    JOIN vouchers v ON br.voucher_id = v.id
    JOIN ledger_entries le ON le.voucher_id = v.id AND le.account_id = br.bank_account_id
    LEFT JOIN accounts a ON v.party_account_id = a.id
    WHERE br.company_id = ? AND br.bank_account_id = ? AND v.date <= ?
    ORDER BY v.date DESC, v.voucher_number DESC
  `).all(companyId, bankAccountId, targetDate) as any[];

  let unpresentedTotal = 0;
  let unclearedDepositTotal = 0;

  const items: BRSLineItem[] = rawItems.map((r) => {
    // If bank was debited -> it is a deposit into bank (Receipt)
    // If bank was credited -> it is a payment from bank (Payment)
    const txType: 'DEPOSIT' | 'WITHDRAWAL' = r.debit > 0 ? 'DEPOSIT' : 'WITHDRAWAL';
    const isCleared = r.status === 'CLEARED';

    if (!isCleared && r.status !== 'BOUNCED') {
      if (txType === 'WITHDRAWAL') {
        unpresentedTotal = Math.round((unpresentedTotal + r.amount) * 100) / 100;
      } else {
        unclearedDepositTotal = Math.round((unclearedDepositTotal + r.amount) * 100) / 100;
      }
    }

    return {
      reconciliation_id: r.reconciliation_id,
      voucher_id: r.voucher_id,
      voucher_number: r.voucher_number,
      voucher_type: r.voucher_type,
      voucher_date: r.voucher_date,
      party_name: r.party_name || 'N/A',
      cheque_instrument_number: r.cheque_instrument_number || null,
      cheque_date: r.cheque_date || null,
      bank_clearance_date: r.bank_clearance_date || null,
      status: r.status,
      transaction_type: txType,
      amount: r.amount
    };
  });

  const bookBalance = Math.round((bankAccount.book_balance || 0) * 100) / 100;
  // Estimated Bank Passbook Balance = Book Balance + Unpresented Cheques (Payments deducted in books but not yet by bank) - Uncleared Deposits (Deposits added in books but not yet cleared by bank)
  const statementBalance = Math.round((bookBalance + unpresentedTotal - unclearedDepositTotal) * 100) / 100;

  return {
    bank_account: {
      id: bankAccount.id,
      name: bankAccount.name,
      code: bankAccount.code,
      book_balance: bookBalance
    },
    as_of_date: targetDate,
    book_balance: bookBalance,
    unpresented_cheques_total: unpresentedTotal,
    uncleared_deposits_total: unclearedDepositTotal,
    statement_balance: statementBalance,
    items
  };
}
