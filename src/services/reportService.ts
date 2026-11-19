import Database from 'better-sqlite3';

export function getTrialBalance(db: Database.Database, companyId: string) {
  const rows = db.prepare(`
    SELECT 
      a.id,
      a.name,
      a.code,
      ag.name as group_name,
      ag.nature,
      COALESCE(SUM(le.debit), 0) as total_debit,
      COALESCE(SUM(le.credit), 0) as total_credit,
      (COALESCE(SUM(le.debit), 0) - COALESCE(SUM(le.credit), 0)) as balance
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    LEFT JOIN ledger_entries le ON a.id = le.account_id
    WHERE a.company_id = ?
    GROUP BY a.id
    HAVING total_debit > 0 OR total_credit > 0
    ORDER BY ag.nature, a.name
  `).all(companyId) as Array<{
    id: string;
    name: string;
    code: string;
    group_name: string;
    nature: string;
    total_debit: number;
    total_credit: number;
    balance: number;
  }>;

  const totalDebits = rows.reduce((sum, r) => sum + r.total_debit, 0);
  const totalCredits = rows.reduce((sum, r) => sum + r.total_credit, 0);
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.001;

  return {
    rows,
    totalDebits,
    totalCredits,
    isBalanced, // Mathematical guarantee
  };
}

export function getStockStatus(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT 
      i.id as item_id,
      i.name as item_name,
      i.hsn_code,
      u.symbol as unit,
      mc.name as godown_name,
      COALESCE(SUM(se.inward_qty), 0) as total_inward,
      COALESCE(SUM(se.outward_qty), 0) as total_outward,
      (COALESCE(SUM(se.inward_qty), 0) - COALESCE(SUM(se.outward_qty), 0)) as current_stock
    FROM items i
    JOIN units u ON i.primary_unit_id = u.id
    CROSS JOIN material_centres mc ON mc.company_id = i.company_id
    LEFT JOIN stock_entries se ON i.id = se.item_id AND mc.id = se.material_centre_id
    WHERE i.company_id = ?
    GROUP BY i.id, mc.id
    ORDER BY i.name
  `).all(companyId);
}
