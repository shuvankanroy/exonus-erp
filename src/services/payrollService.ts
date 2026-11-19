import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface EmployeeInput {
  company_id: string;
  emp_code: string;
  name: string;
  designation: string;
  department: string;
  joining_date: string;
  basic_salary: number;
  hra?: number;
  conveyance?: number;
  special_allowance?: number;
  pan_number?: string;
  pf_uan?: string;
  esi_number?: string;
  bank_account_number?: string;
  bank_ifsc?: string;
}

export interface ProcessPayrollInput {
  company_id: string;
  month: number;
  year: number;
  payment_date: string;
}

/**
 * Creates or updates an Employee Master in Exonus ERP
 */
export function createOrUpdateEmployee(db: Database.Database, input: EmployeeInput) {
  const existing = db.prepare('SELECT id FROM employees WHERE company_id = ? AND emp_code = ?').get(input.company_id, input.emp_code) as any;
  const id = existing ? existing.id : randomUUID();

  if (existing) {
    db.prepare(`
      UPDATE employees SET
        name = ?, designation = ?, department = ?, joining_date = ?,
        basic_salary = ?, hra = ?, conveyance = ?, special_allowance = ?,
        pan_number = ?, pf_uan = ?, esi_number = ?, bank_account_number = ?, bank_ifsc = ?
      WHERE id = ?
    `).run(
      input.name.trim(), input.designation.trim(), input.department.trim(), input.joining_date,
      input.basic_salary, input.hra || 0, input.conveyance || 0, input.special_allowance || 0,
      input.pan_number || null, input.pf_uan || null, input.esi_number || null,
      input.bank_account_number || null, input.bank_ifsc || null, id
    );
  } else {
    db.prepare(`
      INSERT INTO employees (
        id, company_id, emp_code, name, designation, department, joining_date,
        basic_salary, hra, conveyance, special_allowance,
        pan_number, pf_uan, esi_number, bank_account_number, bank_ifsc, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id, input.company_id, input.emp_code.trim(), input.name.trim(), input.designation.trim(),
      input.department.trim(), input.joining_date, input.basic_salary, input.hra || 0,
      input.conveyance || 0, input.special_allowance || 0, input.pan_number || null,
      input.pf_uan || null, input.esi_number || null, input.bank_account_number || null,
      input.bank_ifsc || null
    );
  }

  return { id, emp_code: input.emp_code, name: input.name };
}

/**
 * Seeds standard sample employees if company employee list is empty
 */
export function seedDefaultEmployees(db: Database.Database, companyId: string) {
  const count = db.prepare('SELECT COUNT(*) as count FROM employees WHERE company_id = ?').get(companyId) as any;
  if (count && count.count > 0) return;

  const defaults: Omit<EmployeeInput, 'company_id'>[] = [
    {
      emp_code: 'EMP-001',
      name: 'Rajesh Sharma',
      designation: 'Senior Accountant',
      department: 'Finance & Accounts',
      joining_date: '2024-01-15',
      basic_salary: 35000,
      hra: 14000,
      conveyance: 3000,
      special_allowance: 8000,
      pan_number: 'ABCPS1234F',
      pf_uan: '100987654321',
      bank_account_number: '50100234567891',
      bank_ifsc: 'HDFC0000123'
    },
    {
      emp_code: 'EMP-002',
      name: 'Sunita Rao',
      designation: 'Warehouse & Logistics Manager',
      department: 'Supply Chain',
      joining_date: '2024-03-01',
      basic_salary: 28000,
      hra: 11200,
      conveyance: 2500,
      special_allowance: 5300,
      pan_number: 'BNPRS5678K',
      pf_uan: '100987654322',
      bank_account_number: '50100234567892',
      bank_ifsc: 'HDFC0000123'
    },
    {
      emp_code: 'EMP-003',
      name: 'Amit Verma',
      designation: 'Assembly Line Technician',
      department: 'Manufacturing',
      joining_date: '2025-06-10',
      basic_salary: 15000,
      hra: 4000,
      conveyance: 1500,
      special_allowance: 500,
      pan_number: 'CRTYV9012L',
      pf_uan: '100987654323',
      esi_number: '3100987654',
      bank_account_number: '50100234567893',
      bank_ifsc: 'HDFC0000123'
    }
  ];

  for (const emp of defaults) {
    createOrUpdateEmployee(db, { ...emp, company_id: companyId });
  }
}

/**
 * Retrieves all employees with calculated monthly salary breakdown
 */
export function getEmployees(db: Database.Database, companyId: string) {
  seedDefaultEmployees(db, companyId);

  const emps = db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY emp_code ASC').all(companyId) as any[];

  return emps.map(emp => {
    const gross = emp.basic_salary + (emp.hra || 0) + (emp.conveyance || 0) + (emp.special_allowance || 0);
    const pf = Math.round(emp.basic_salary * 0.12);
    const esi = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
    const pt = 200;
    const net = gross - (pf + esi + pt);

    return {
      ...emp,
      gross_salary: gross,
      pf_deduction: pf,
      esi_deduction: esi,
      pt_deduction: pt,
      net_salary: net
    };
  });
}

/**
 * Processes monthly payroll for all active employees and posts balancing double-entry salary journal vouchers.
 */
export function processMonthlyPayroll(db: Database.Database, input: ProcessPayrollInput) {
  seedDefaultEmployees(db, input.company_id);

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
      // Employee PF: 12% of Basic
      const pf = Math.round(emp.basic_salary * 0.12);
      // Employee ESI: 0.75% of Gross if Gross <= ₹21,000
      const esi = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
      // Professional Tax: Flat ₹200
      const pt = 200;

      const net = gross - (pf + esi + pt);

      totalGross = Math.round((totalGross + gross) * 100) / 100;
      totalPF = Math.round((totalPF + pf) * 100) / 100;
      totalESI = Math.round((totalESI + esi) * 100) / 100;
      totalPT = Math.round((totalPT + pt) * 100) / 100;
      totalNet = Math.round((totalNet + net) * 100) / 100;
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

    const dutiesGroup = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND nature = 'LIABILITY' LIMIT 1").get(input.company_id) as any;

    let pfPayable = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND name = 'PF Payable'").get(input.company_id) as any;
    if (!pfPayable) {
      pfPayable = { id: randomUUID() };
      db.prepare("INSERT INTO accounts (id, company_id, group_id, name) VALUES (?, ?, ?, 'PF Payable')").run(pfPayable.id, input.company_id, dutiesGroup.id);
    }

    let esiPayable = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND name = 'ESI Payable'").get(input.company_id) as any;
    if (!esiPayable) {
      esiPayable = { id: randomUUID() };
      db.prepare("INSERT INTO accounts (id, company_id, group_id, name) VALUES (?, ?, ?, 'ESI Payable')").run(esiPayable.id, input.company_id, dutiesGroup.id);
    }

    let ptPayable = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND name = 'Professional Tax Payable'").get(input.company_id) as any;
    if (!ptPayable) {
      ptPayable = { id: randomUUID() };
      db.prepare("INSERT INTO accounts (id, company_id, group_id, name) VALUES (?, ?, ?, 'Professional Tax Payable')").run(ptPayable.id, input.company_id, dutiesGroup.id);
    }

    // 1. Debit Gross Salary Expense
    db.prepare(`
      INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
      VALUES (?, ?, ?, ?, ?, 0, ?, 'Gross Salary Expense')
    `).run(randomUUID(), input.company_id, journalVchId, salaryExp.id, totalGross, input.payment_date);

    // 2. Credit Net Salary Payable to Staff
    db.prepare(`
      INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
      VALUES (?, ?, ?, ?, 0, ?, ?, 'Net Salaries Payable to Staff')
    `).run(randomUUID(), input.company_id, journalVchId, salaryPayable.id, totalNet, input.payment_date);

    // 3. Credit Statutory Liabilities (PF, ESI, PT) -> Guaranteed exact balancing
    if (totalPF > 0) {
      db.prepare(`
        INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
        VALUES (?, ?, ?, ?, 0, ?, ?, 'Employee PF Statutory Deduction')
      `).run(randomUUID(), input.company_id, journalVchId, pfPayable.id, totalPF, input.payment_date);
    }

    if (totalESI > 0) {
      db.prepare(`
        INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
        VALUES (?, ?, ?, ?, 0, ?, ?, 'Employee ESI Statutory Deduction')
      `).run(randomUUID(), input.company_id, journalVchId, esiPayable.id, totalESI, input.payment_date);
    }

    if (totalPT > 0) {
      db.prepare(`
        INSERT INTO ledger_entries (id, company_id, voucher_id, account_id, debit, credit, entry_date, narration)
        VALUES (?, ?, ?, ?, 0, ?, ?, 'Professional Tax Deduction')
      `).run(randomUUID(), input.company_id, journalVchId, ptPayable.id, totalPT, input.payment_date);
    }

    // 4. Record Payroll Run Table
    const payrollRunId = randomUUID();
    db.prepare(`
      INSERT INTO payroll_runs (
        id, company_id, month, year, total_gross_salary, total_pf_deduction, total_esi_deduction, total_pt_deduction, total_net_payable, gl_voucher_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payrollRunId, input.company_id, input.month, input.year,
      totalGross, totalPF, totalESI, totalPT, totalNet, journalVchId
    );

    // 5. Outbox Sync for Cloud Relay
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'PAYROLL_RUN', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, payrollRunId,
      JSON.stringify({ month: input.month, year: input.year, totalGross, totalNet, vchNumber })
    );

    return {
      payrollRunId,
      journalVchNumber: vchNumber,
      employeeCount: employees.length,
      totalGrossSalary: totalGross,
      totalPFDeduction: totalPF,
      totalESIDeduction: totalESI,
      totalPTDeduction: totalPT,
      totalNetPayable: totalNet,
    };
  })();
}
