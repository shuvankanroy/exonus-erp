import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface ProcessPayrollInput {
  company_id: string;
  month: number;
  year: number;
  payment_date: string;
}

export function processMonthlyPayroll(db: Database.Database, input: ProcessPayrollInput) {
  const employees = db.prepare('SELECT * FROM employees WHERE company_id = ? AND is_active = 1').all(input.company_id) as any[];
  if (!employees || employees.length === 0) throw new Error('No active employees found to process payroll');

  return db.transaction(() => {
    let totalGross = 0;
    let totalPF = 0;
    let totalESI = 0;
    let totalPT = 0;
    let totalNet = 0;

    for (const emp of employees) {
      const gross = emp.basic_salary + (emp.hra || 0) + (emp.conveyance || 0) + (emp.special_allowance || 0);
      
      // Standard Statutory Deductions:
      // Employee PF: 12% of Basic (capped at standard limits)
      const pf = Math.round(emp.basic_salary * 0.12);
      // Employee ESI: 0.75% of Gross if Gross <= ₹21,000
      const esi = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
      // Professional Tax: Flat ₹200 (approximate Indian slab)
      const pt = 200;

      const net = gross - (pf + esi + pt);

      totalGross += gross;
      totalPF += pf;
      totalESI += esi;
      totalPT += pt;
      totalNet += net;
    }

    // Book General Ledger Salary Journal Voucher
    const journalSeries = db.prepare("SELECT id, prefix, current_number, suffix FROM voucher_series WHERE company_id = ? AND voucher_type = 'JOURNAL'").get(input.company_id) as any;
    const nextNum = (journalSeries?.current_number || 0) + 1;
    const vchNumber = `${journalSeries?.prefix || 'JRN/'}${String(nextNum).padStart(4, '0')}`;
    if (journalSeries) {
      db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, journalSeries.id);
    }

    const journalVchId = randomUUID();
    db.prepare(`
      INSERT INTO vouchers (id, company_id, series_id, voucher_type, voucher_number, date, narration, gross_total)
      VALUES (?, ?, ?, 'JOURNAL', ?, ?, ?, ?)
    `).run(
      journalVchId, input.company_id, journalSeries?.id || 'JRN', vchNumber,
      input.payment_date, `Monthly Salary Processing for ${input.month}/${input.year}`, totalGross
    );

    // Get or Create Salary Expense & Liability Accounts
    let salaryExp = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND name = 'Salary & Wages'").get(input.company_id) as any;
    if (!salaryExp) {
      const expGroup = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND nature = 'EXPENSE' LIMIT 1").get(input.company_id) as any;
      salaryExp = { id: randomUUID() };
      db.prepare("INSERT INTO accounts (id, company_id, group_id, name) VALUES (?, ?, ?, 'Salary & Wages')").run(salaryExp.id, input.company_id, expGroup.id);
    }

    let salaryPayable = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND name = 'Salary Payable'").get(input.company_id) as any;
    if (!salaryPayable) {
      const liabGroup = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND nature = 'LIABILITY' LIMIT 1").get(input.company_id) as any;
      salaryPayable = { id: randomUUID() };
      db.prepare("INSERT INTO accounts (id, company_id, group_id, name) VALUES (?, ?, ?, 'Salary Payable')").run(salaryPayable.id, input.company_id, liabGroup.id);
    }

    // Debit Salary Expense (Gross)
    db.prepare(`
      INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'Gross Salary Expense')
    `).run(randomUUID(), input.company_id, journalVchId, salaryExp.id, totalGross, input.payment_date);

    // Credit Salary Payable (Net)
    db.prepare(`
      INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
      VALUES (?, ?, ?, ?, 0, ?, ?, 'Net Salaries Payable to Staff')
    `).run(randomUUID(), input.company_id, journalVchId, salaryPayable.id, totalNet, input.payment_date);

    // Record Payroll Run Table
    const payrollRunId = randomUUID();
    db.prepare(`
      INSERT INTO payroll_runs (
        id, company_id, month, year, total_gross_salary, total_pf_deduction, total_esi_deduction, total_pt_deduction, total_net_payable, gl_voucher_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payrollRunId, input.company_id, input.month, input.year,
      totalGross, totalPF, totalESI, totalPT, totalNet, journalVchId
    );

    return {
      payrollRunId,
      journalVchNumber: vchNumber,
      employeeCount: employees.length,
      totalGrossSalary: totalGross,
      totalPFDeduction: totalPF,
      totalESIDeduction: totalESI,
      totalNetPayable: totalNet,
    };
  })();
}
