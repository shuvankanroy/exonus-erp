import Database from 'better-sqlite3';

export interface ProfitAndLossReport {
  trading: {
    openingStock: number;
    purchases: number;
    directExpenses: number;
    sales: number;
    closingStock: number;
    grossProfit: number; // positive = Profit, negative = Loss
  };
  operating: {
    grossProfit: number;
    indirectIncomes: number;
    indirectExpenses: number;
    netProfit: number; // positive = Profit, negative = Loss
  };
  directExpenseAccounts: Array<{ name: string; amount: number }>;
  directIncomeAccounts: Array<{ name: string; amount: number }>;
  indirectExpenseAccounts: Array<{ name: string; amount: number }>;
  indirectIncomeAccounts: Array<{ name: string; amount: number }>;
}

export interface BalanceSheetReport {
  asOfDate: string;
  closingStockValuation: number;
  netProfitOrLoss: number;
  liabilities: Array<{ group_name: string; accounts: Array<{ name: string; balance: number }>; total: number }>;
  assets: Array<{ group_name: string; accounts: Array<{ name: string; balance: number }>; total: number }>;
  totalLiabilitiesAndEquity: number;
  totalAssets: number;
  isBalanced: boolean;
}

export function calculateProfitAndLoss(db: Database.Database, companyId: string): ProfitAndLossReport {
  // 1. Fetch grouped ledger sums by nature and group name
  const rows = db.prepare(`
    SELECT 
      ag.nature,
      ag.name as group_name,
      a.name as account_name,
      COALESCE(SUM(le.debit), 0) as total_debit,
      COALESCE(SUM(le.credit), 0) as total_credit,
      (COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) as net_balance
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    LEFT JOIN ledger_entries le ON a.id = le.account_id
    WHERE a.company_id = ?
    GROUP BY a.id
    HAVING total_debit > 0 OR total_credit > 0
  `).all(companyId) as Array<{
    nature: string;
    group_name: string;
    account_name: string;
    total_debit: number;
    total_credit: number;
    net_balance: number;
  }>;

  // 2. Fetch Closing Stock Valuation based on Perpetual Inventory
  const stockItems = db.prepare(`
    SELECT 
      i.id,
      i.standard_purchase_rate,
      (COALESCE(SUM(se.inward_qty), 0) - COALESCE(SUM(se.outward_qty), 0)) as balance_qty
    FROM items i
    LEFT JOIN stock_entries se ON i.id = se.item_id
    WHERE i.company_id = ?
    GROUP BY i.id
  `).all(companyId) as Array<{ id: string; standard_purchase_rate: number; balance_qty: number }>;

  const closingStock = stockItems.reduce((sum, item) => {
    return sum + (Math.max(0, item.balance_qty) * (item.standard_purchase_rate || 0));
  }, 0);

  const directExpenseAccounts: Array<{ name: string; amount: number }> = [];
  const directIncomeAccounts: Array<{ name: string; amount: number }> = [];
  const indirectExpenseAccounts: Array<{ name: string; amount: number }> = [];
  const indirectIncomeAccounts: Array<{ name: string; amount: number }> = [];

  let directExpensesTotal = 0;
  let directIncomesTotal = 0;
  let indirectExpensesTotal = 0;
  let indirectIncomesTotal = 0;

  for (const r of rows) {
    if (r.nature === 'EXPENSE') {
      if (r.group_name === 'Direct Expenses' || r.account_name.includes('Purchase')) {
        directExpenseAccounts.push({ name: r.account_name, amount: r.net_balance });
        directExpensesTotal += r.net_balance;
      } else {
        indirectExpenseAccounts.push({ name: r.account_name, amount: r.net_balance });
        indirectExpensesTotal += r.net_balance;
      }
    } else if (r.nature === 'INCOME') {
      const creditAmt = Math.abs(r.net_balance);
      if (r.group_name === 'Direct Incomes' || r.account_name.includes('Sales')) {
        directIncomeAccounts.push({ name: r.account_name, amount: creditAmt });
        directIncomesTotal += creditAmt;
      } else {
        indirectIncomeAccounts.push({ name: r.account_name, amount: creditAmt });
        indirectIncomesTotal += creditAmt;
      }
    }
  }

  const openingStock = 0; // Default financial year start
  const grossProfit = (directIncomesTotal + closingStock) - (openingStock + directExpensesTotal);
  const netProfit = (grossProfit + indirectIncomesTotal) - indirectExpensesTotal;

  return {
    trading: {
      openingStock,
      purchases: directExpensesTotal,
      directExpenses: directExpensesTotal,
      sales: directIncomesTotal,
      closingStock,
      grossProfit
    },
    operating: {
      grossProfit,
      indirectIncomes: indirectIncomesTotal,
      indirectExpenses: indirectExpensesTotal,
      netProfit
    },
    directExpenseAccounts,
    directIncomeAccounts,
    indirectExpenseAccounts,
    indirectIncomeAccounts
  };
}

export function calculateBalanceSheet(db: Database.Database, companyId: string): BalanceSheetReport {
  const pl = calculateProfitAndLoss(db, companyId);
  const netProfitOrLoss = pl.operating.netProfit;

  const rows = db.prepare(`
    SELECT 
      ag.nature,
      ag.name as group_name,
      a.name as account_name,
      COALESCE(SUM(le.debit), 0) as total_debit,
      COALESCE(SUM(le.credit), 0) as total_credit,
      (COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) as net_balance
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    LEFT JOIN ledger_entries le ON a.id = le.account_id
    WHERE a.company_id = ?
    GROUP BY a.id
    HAVING total_debit > 0 OR total_credit > 0
  `).all(companyId) as Array<{
    nature: string;
    group_name: string;
    account_name: string;
    total_debit: number;
    total_credit: number;
    net_balance: number;
  }>;

  const assetGroupMap = new Map<string, Array<{ name: string; balance: number }>>();
  const liabGroupMap = new Map<string, Array<{ name: string; balance: number }>>();

  let rawAssetTotal = 0;
  let rawLiabTotal = 0;

  for (const r of rows) {
    if (r.nature === 'ASSET') {
      const bal = r.net_balance;
      rawAssetTotal += bal;
      if (!assetGroupMap.has(r.group_name)) assetGroupMap.set(r.group_name, []);
      assetGroupMap.get(r.group_name)!.push({ name: r.account_name, balance: bal });
    } else if (r.nature === 'LIABILITY') {
      const bal = (r.total_credit - r.total_debit);
      rawLiabTotal += bal;
      if (!liabGroupMap.has(r.group_name)) liabGroupMap.set(r.group_name, []);
      liabGroupMap.get(r.group_name)!.push({ name: r.account_name, balance: bal });
    }
  }

  // Add Closing Stock as a Current Asset
  if (pl.trading.closingStock > 0) {
    const stockGroup = 'Current Assets (Stock-in-hand)';
    if (!assetGroupMap.has(stockGroup)) assetGroupMap.set(stockGroup, []);
    assetGroupMap.get(stockGroup)!.push({ name: 'Closing Stock Valuation', balance: pl.trading.closingStock });
  }

  // Add Profit/Loss into Capital / Reserves (Liabilities side)
  const capitalGroup = 'Reserves & Surplus / Capital Account';
  if (!liabGroupMap.has(capitalGroup)) liabGroupMap.set(capitalGroup, []);
  liabGroupMap.get(capitalGroup)!.push({ name: 'Profit & Loss A/c (Current Year)', balance: netProfitOrLoss });

  const assets: Array<{ group_name: string; accounts: Array<{ name: string; balance: number }>; total: number }> = [];
  for (const [group_name, accounts] of assetGroupMap.entries()) {
    const total = accounts.reduce((s, a) => s + a.balance, 0);
    assets.push({ group_name, accounts, total });
  }

  const liabilities: Array<{ group_name: string; accounts: Array<{ name: string; balance: number }>; total: number }> = [];
  for (const [group_name, accounts] of liabGroupMap.entries()) {
    const total = accounts.reduce((s, a) => s + a.balance, 0);
    liabilities.push({ group_name, accounts, total });
  }

  const totalAssets = rawAssetTotal + pl.trading.closingStock;
  const totalLiabilitiesAndEquity = rawLiabTotal + netProfitOrLoss;
  const isBalanced = Math.abs(totalAssets - totalLiabilitiesAndEquity) < 0.01;

  return {
    asOfDate: new Date().toISOString().split('T')[0],
    closingStockValuation: pl.trading.closingStock,
    netProfitOrLoss,
    liabilities,
    assets,
    totalLiabilitiesAndEquity,
    totalAssets,
    isBalanced
  };
}

export function getAccountLedgerStatement(db: Database.Database, companyId: string, accountId: string) {
  const account = db.prepare(`
    SELECT a.*, ag.name as group_name, ag.nature 
    FROM accounts a 
    JOIN account_groups ag ON a.group_id = ag.id 
    WHERE a.id = ? AND a.company_id = ?
  `).get(accountId, companyId) as any;
  if (!account) throw new Error('Account not found');

  const entries = db.prepare(`
    SELECT 
      le.id,
      le.entry_date,
      le.debit,
      le.credit,
      le.narration,
      v.voucher_number,
      v.voucher_type
    FROM ledger_entries le
    LEFT JOIN vouchers v ON le.voucher_id = v.id
    WHERE le.account_id = ? AND le.company_id = ?
    ORDER BY le.entry_date ASC, le.id ASC
  `).all(accountId, companyId) as Array<{
    id: string;
    entry_date: string;
    debit: number;
    credit: number;
    narration: string;
    voucher_number: string;
    voucher_type: string;
  }>;

  let runningBalance = 0;
  const statement = entries.map(e => {
    runningBalance += (e.debit - e.credit);
    return {
      ...e,
      balance: runningBalance,
      balanceType: runningBalance >= 0 ? 'Dr' : 'Cr'
    };
  });

  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);

  return {
    account,
    totalDebit,
    totalCredit,
    closingBalance: runningBalance,
    closingBalanceType: runningBalance >= 0 ? 'Dr' : 'Cr',
    entries: statement
  };
}

export function getGSTSummaryReport(db: Database.Database, companyId: string) {
  // Compile B2B Invoices for GSTR-1
  const b2bSales = db.prepare(`
    SELECT 
      v.voucher_number as doc_number,
      v.date as doc_date,
      a.name as party_name,
      a.gstin as party_gstin,
      a.state_code as pos,
      vi.gst_rate,
      SUM(vi.taxable_amount) as taxable_value,
      SUM(vi.cgst_amount) as cgst,
      SUM(vi.sgst_amount) as sgst,
      SUM(vi.igst_amount) as igst,
      SUM(vi.net_amount) as total_invoice_value
    FROM voucher_items vi
    JOIN vouchers v ON vi.voucher_id = v.id
    JOIN accounts a ON v.party_account_id = a.id
    WHERE v.company_id = ? AND v.voucher_type = 'SALES'
    GROUP BY v.id, vi.gst_rate
    ORDER BY v.date DESC
  `).all(companyId);

  // Compile HSN Summary for GSTR-1
  const hsnSummary = db.prepare(`
    SELECT 
      i.hsn_code,
      i.name as item_name,
      u.symbol as uqc,
      SUM(vi.qty) as total_qty,
      SUM(vi.taxable_amount) as total_taxable_value,
      SUM(vi.cgst_amount) as total_cgst,
      SUM(vi.sgst_amount) as total_sgst,
      SUM(vi.igst_amount) as total_igst,
      SUM(vi.net_amount) as total_value
    FROM voucher_items vi
    JOIN vouchers v ON vi.voucher_id = v.id
    JOIN items i ON vi.item_id = i.id
    JOIN units u ON i.primary_unit_id = u.id
    WHERE v.company_id = ? AND v.voucher_type = 'SALES'
    GROUP BY i.hsn_code
  `).all(companyId);

  // Compile Inward ITC for GSTR-3B
  const inwardPurchases = db.prepare(`
    SELECT 
      SUM(vi.taxable_amount) as inward_taxable,
      SUM(vi.cgst_amount) as itc_cgst,
      SUM(vi.sgst_amount) as itc_sgst,
      SUM(vi.igst_amount) as itc_igst
    FROM voucher_items vi
    JOIN vouchers v ON vi.voucher_id = v.id
    WHERE v.company_id = ? AND v.voucher_type = 'PURCHASE'
  `).get(companyId) as any;

  // Compile Outward Tax Liability for GSTR-3B
  const outwardSales = db.prepare(`
    SELECT 
      SUM(vi.taxable_amount) as outward_taxable,
      SUM(vi.cgst_amount) as liability_cgst,
      SUM(vi.sgst_amount) as liability_sgst,
      SUM(vi.igst_amount) as liability_igst
    FROM voucher_items vi
    JOIN vouchers v ON vi.voucher_id = v.id
    WHERE v.company_id = ? AND v.voucher_type = 'SALES'
  `).get(companyId) as any;

  return {
    b2bSales,
    hsnSummary,
    gstr3b: {
      outwardTaxable: outwardSales?.outward_taxable || 0,
      liabilityCGST: outwardSales?.liability_cgst || 0,
      liabilitySGST: outwardSales?.liability_sgst || 0,
      liabilityIGST: outwardSales?.liability_igst || 0,
      inwardTaxable: inwardPurchases?.inward_taxable || 0,
      itcCGST: inwardPurchases?.itc_cgst || 0,
      itcSGST: inwardPurchases?.itc_sgst || 0,
      itcIGST: inwardPurchases?.itc_igst || 0,
      netPayableCGST: Math.max(0, (outwardSales?.liability_cgst || 0) - (inwardPurchases?.itc_cgst || 0)),
      netPayableSGST: Math.max(0, (outwardSales?.liability_sgst || 0) - (inwardPurchases?.itc_sgst || 0)),
      netPayableIGST: Math.max(0, (outwardSales?.liability_igst || 0) - (inwardPurchases?.itc_igst || 0))
    }
  };
}

export function getBillOutstandingReport(db: Database.Database, companyId: string, type: 'RECEIVABLE' | 'PAYABLE') {
  const targetGroup = type === 'RECEIVABLE' ? 'Sundry Debtors' : 'Sundry Creditors';

  return db.prepare(`
    SELECT 
      br.id,
      br.ref_number,
      br.bill_date,
      br.total_amount,
      br.pending_amount,
      (br.total_amount - br.pending_amount) as paid_amount,
      a.id as account_id,
      a.name as party_name,
      a.credit_period_days,
      CAST((julianday('now') - julianday(br.bill_date)) AS INTEGER) as age_days
    FROM bill_references br
    JOIN accounts a ON br.account_id = a.id
    JOIN account_groups ag ON a.group_id = ag.id
    WHERE br.company_id = ? AND ag.name = ? AND br.pending_amount > 0
    ORDER BY br.bill_date ASC
  `).all(companyId, targetGroup);
}
