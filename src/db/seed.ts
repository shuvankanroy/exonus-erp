import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface CompanyConfig {
  id: string;
  name: string;
  trade_name?: string;
  gstin?: string;
  state_code: string;
  financial_year_start: string;
  financial_year_end: string;
}

export function seedCompanyAndStandardMasters(db: Database.Database, config: CompanyConfig) {
  const insertCompany = db.prepare(`
    INSERT INTO companies (id, name, trade_name, gstin, state_code, financial_year_start, financial_year_end)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertGroup = db.prepare(`
    INSERT INTO account_groups (id, company_id, name, parent_group_id, nature, is_primary)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, company_id, group_id, name, code, is_active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  const insertSeries = db.prepare(`
    INSERT INTO voucher_series (id, company_id, voucher_type, series_name, prefix, auto_numbering)
    VALUES (?, ?, ?, ?, ?, 1)
  `);

  const insertUnit = db.prepare(`
    INSERT INTO units (id, company_id, name, symbol, uqc_code)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMC = db.prepare(`
    INSERT INTO material_centres (id, company_id, name, is_default)
    VALUES (?, ?, ?, 1)
  `);

  const seedTransaction = db.transaction(() => {
    // 1. Company
    insertCompany.run(
      config.id,
      config.name,
      config.trade_name || config.name,
      config.gstin || '',
      config.state_code,
      config.financial_year_start,
      config.financial_year_end
    );

    // 2. Standard Primary Groups (BUSY Standard)
    const grpAssets = randomUUID();
    const grpLiabilities = randomUUID();
    const grpIncome = randomUUID();
    const grpExpenses = randomUUID();

    insertGroup.run(grpAssets, config.id, 'Current Assets', null, 'ASSET', 1);
    insertGroup.run(grpLiabilities, config.id, 'Current Liabilities', null, 'LIABILITY', 1);
    insertGroup.run(grpIncome, config.id, 'Direct Incomes', null, 'INCOME', 1);
    insertGroup.run(grpExpenses, config.id, 'Direct Expenses', null, 'EXPENSE', 1);

    // Sub-groups
    const grpDebtors = randomUUID();
    const grpCreditors = randomUUID();
    const grpBank = randomUUID();
    const grpCash = randomUUID();
    const grpDuties = randomUUID();

    insertGroup.run(grpDebtors, config.id, 'Sundry Debtors', grpAssets, 'ASSET', 0);
    insertGroup.run(grpCreditors, config.id, 'Sundry Creditors', grpLiabilities, 'LIABILITY', 0);
    insertGroup.run(grpBank, config.id, 'Bank Accounts', grpAssets, 'ASSET', 0);
    insertGroup.run(grpCash, config.id, 'Cash-in-hand', grpAssets, 'ASSET', 0);
    insertGroup.run(grpDuties, config.id, 'Duties & Taxes', grpLiabilities, 'LIABILITY', 0);

    // 3. Standard System Accounts
    insertAccount.run(randomUUID(), config.id, grpCash, 'Cash', 'CASH');
    insertAccount.run(randomUUID(), config.id, grpIncome, 'Sales Account', 'SALES');
    insertAccount.run(randomUUID(), config.id, grpExpenses, 'Purchase Account', 'PURCHASE');
    
    // GST Output / Input Accounts
    insertAccount.run(randomUUID(), config.id, grpDuties, 'CGST Output', 'CGST_OUT');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'SGST Output', 'SGST_OUT');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'IGST Output', 'IGST_OUT');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'CGST Input', 'CGST_IN');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'SGST Input', 'SGST_IN');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'IGST Input', 'IGST_IN');
    insertAccount.run(randomUUID(), config.id, grpDuties, 'Round Off (+/-)', 'ROUND_OFF');

    // 4. Standard Voucher Series
    const vtypes = ['SALES', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'CONTRA', 'JOURNAL', 'STOCK_TRANSFER'];
    for (const vt of vtypes) {
      insertSeries.run(randomUUID(), config.id, vt, 'Main', `${vt.slice(0, 3)}/`);
    }

    // 5. Default Units & Material Centre
    insertUnit.run(randomUUID(), config.id, 'Pieces', 'Pcs', 'PCS');
    insertUnit.run(randomUUID(), config.id, 'Boxes', 'Box', 'BOX');
    insertMC.run(randomUUID(), config.id, 'Main Godown');
  });

  seedTransaction();
}
