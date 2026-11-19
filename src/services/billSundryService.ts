import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface BillSundryDefinition {
  id: string;
  company_id: string;
  name: string;
  type: 'ADDITION' | 'DEDUCTION';
  calc_mode: 'PERCENTAGE' | 'LUMPSUM' | 'ROUND_OFF';
  default_value: number;
  impact_taxable_value: number; // 1 for Pre-tax (adjusts GST taxable base), 0 for Post-tax
  linked_account_id: string;
}

export interface AppliedSundryInput {
  bill_sundry_id: string;
  rate?: number; // Optional percentage override or flat amount
  amount?: number; // Optional flat amount override
}

export interface CalculatedSundryLine {
  id: string;
  bill_sundry_id: string;
  name: string;
  type: 'ADDITION' | 'DEDUCTION';
  calc_mode: 'PERCENTAGE' | 'LUMPSUM' | 'ROUND_OFF';
  impact_taxable_value: boolean;
  rate: number;
  amount: number;
  signed_amount: number; // positive for ADDITION, negative for DEDUCTION
  linked_account_id: string;
}

/**
 * Seeds standard default Bill Sundries for an Exonus ERP company
 * Includes: Trade Discount, Cash Discount, Freight & Forwarding, Packaging Charges, Insurance, and Round Off.
 */
export function seedDefaultBillSundries(db: Database.Database, companyId: string) {
  const insertGroup = db.prepare(`
    INSERT OR IGNORE INTO account_groups (id, company_id, name, parent_group_id, nature, is_primary)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertAccount = db.prepare(`
    INSERT OR IGNORE INTO accounts (id, company_id, group_id, name, code)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSundry = db.prepare(`
    INSERT OR IGNORE INTO bill_sundries (
      id, company_id, name, type, calc_mode, default_value, impact_taxable_value, linked_account_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Ensure Indirect Incomes & Indirect Expenses groups exist
  const grpIndirectExpId = randomUUID();
  const grpIndirectIncId = randomUUID();
  insertGroup.run(grpIndirectExpId, companyId, 'Indirect Expenses', null, 'EXPENSE', 1);
  insertGroup.run(grpIndirectIncId, companyId, 'Indirect Incomes', null, 'INCOME', 1);

  // Helper to fetch or create account
  const getOrCreateAccount = (name: string, code: string, groupId: string) => {
    let acc = db.prepare('SELECT id FROM accounts WHERE company_id = ? AND (code = ? OR name = ?)').get(companyId, code, name) as any;
    if (!acc) {
      const id = randomUUID();
      insertAccount.run(id, companyId, groupId, name, code);
      return id;
    }
    return acc.id;
  };

  const discountGivenAccId = getOrCreateAccount('Discount Allowed', 'DISCOUNT_ALLOWED', grpIndirectExpId);
  const discountRecvAccId = getOrCreateAccount('Discount Received', 'DISCOUNT_RECEIVED', grpIndirectIncId);
  const freightExpAccId = getOrCreateAccount('Freight & Forwarding Charges', 'FREIGHT_EXPENSE', grpIndirectExpId);
  const packagingAccId = getOrCreateAccount('Packaging & Handling Charges', 'PACKAGING_CHARGES', grpIndirectExpId);
  const insuranceAccId = getOrCreateAccount('Transit Insurance', 'TRANSIT_INSURANCE', grpIndirectExpId);

  const roundOffAcc = db.prepare("SELECT id FROM accounts WHERE company_id = ? AND code = 'ROUND_OFF'").get(companyId) as any;
  const roundOffAccId = roundOffAcc ? roundOffAcc.id : getOrCreateAccount('Round Off (+/-)', 'ROUND_OFF', grpIndirectExpId);

  // Standard Bill Sundries Definitions
  const defaults = [
    {
      name: 'Trade Discount (-)',
      type: 'DEDUCTION',
      calc_mode: 'PERCENTAGE',
      default_value: 0,
      impact_taxable_value: 1, // Pre-tax: Reduces GST taxable value
      linked_account_id: discountGivenAccId,
    },
    {
      name: 'Cash Discount (-)',
      type: 'DEDUCTION',
      calc_mode: 'PERCENTAGE',
      default_value: 0,
      impact_taxable_value: 0, // Post-tax: Financial settlement deduction
      linked_account_id: discountGivenAccId,
    },
    {
      name: 'Freight & Forwarding (+)',
      type: 'ADDITION',
      calc_mode: 'LUMPSUM',
      default_value: 0,
      impact_taxable_value: 1, // Pre-tax: Adds to taxable value under Section 15 of CGST Act
      linked_account_id: freightExpAccId,
    },
    {
      name: 'Packaging & Handling (+)',
      type: 'ADDITION',
      calc_mode: 'LUMPSUM',
      default_value: 0,
      impact_taxable_value: 1, // Pre-tax
      linked_account_id: packagingAccId,
    },
    {
      name: 'Transit Insurance (+)',
      type: 'ADDITION',
      calc_mode: 'LUMPSUM',
      default_value: 0,
      impact_taxable_value: 1, // Pre-tax
      linked_account_id: insuranceAccId,
    },
    {
      name: 'Auto Round Off',
      type: 'ADDITION',
      calc_mode: 'ROUND_OFF',
      default_value: 0,
      impact_taxable_value: 0, // Post-tax
      linked_account_id: roundOffAccId,
    },
  ];

  for (const d of defaults) {
    const existing = db.prepare('SELECT id FROM bill_sundries WHERE company_id = ? AND name = ?').get(companyId, d.name) as any;
    if (!existing) {
      insertSundry.run(
        randomUUID(), companyId, d.name, d.type, d.calc_mode,
        d.default_value, d.impact_taxable_value, d.linked_account_id
      );
    }
  }
}

/**
 * Retrieves all registered bill sundries for a company.
 */
export function getBillSundries(db: Database.Database, companyId: string) {
  // Ensure default bill sundries exist
  seedDefaultBillSundries(db, companyId);

  return db.prepare(`
    SELECT 
      bs.*,
      a.name as linked_account_name,
      a.code as linked_account_code
    FROM bill_sundries bs
    LEFT JOIN accounts a ON bs.linked_account_id = a.id
    WHERE bs.company_id = ?
    ORDER BY bs.impact_taxable_value DESC, bs.name ASC
  `).all(companyId);
}

/**
 * Creates or updates a custom Bill Sundry
 */
export function saveBillSundry(db: Database.Database, input: {
  id?: string;
  company_id: string;
  name: string;
  type: 'ADDITION' | 'DEDUCTION';
  calc_mode: 'PERCENTAGE' | 'LUMPSUM' | 'ROUND_OFF';
  default_value: number;
  impact_taxable_value: boolean;
  linked_account_id: string;
}) {
  const id = input.id || randomUUID();
  db.prepare(`
    INSERT INTO bill_sundries (id, company_id, name, type, calc_mode, default_value, impact_taxable_value, linked_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      calc_mode = excluded.calc_mode,
      default_value = excluded.default_value,
      impact_taxable_value = excluded.impact_taxable_value,
      linked_account_id = excluded.linked_account_id
  `).run(
    id, input.company_id, input.name, input.type, input.calc_mode,
    input.default_value, input.impact_taxable_value ? 1 : 0, input.linked_account_id
  );
  return { id, name: input.name };
}

/**
 * Calculates applied Bill Sundries against invoice line items and tax brackets.
 * Implements Section 15 of Indian CGST Act (composite supply apportionment)
 */
export function calculateBillSundries(
  db: Database.Database,
  companyId: string,
  baseTaxableTotal: number,
  appliedSundries: AppliedSundryInput[],
  isInterState: boolean,
  lines: Array<{
    item_id: string;
    taxable_amount: number;
    gst_rate: number;
  }>
) {
  const calculatedLines: CalculatedSundryLine[] = [];
  let preTaxAdditionTotal = 0;
  let preTaxDeductionTotal = 0;
  let postTaxAdditionTotal = 0;
  let postTaxDeductionTotal = 0;

  for (const item of appliedSundries) {
    const sundry = db.prepare('SELECT * FROM bill_sundries WHERE id = ? AND company_id = ?').get(item.bill_sundry_id, companyId) as any;
    if (!sundry) continue;

    let computedAmount = 0;
    const rate = item.rate !== undefined ? item.rate : sundry.default_value;

    if (sundry.calc_mode === 'PERCENTAGE') {
      computedAmount = Math.round(((baseTaxableTotal * rate) / 100) * 100) / 100;
    } else if (sundry.calc_mode === 'LUMPSUM') {
      computedAmount = item.amount !== undefined ? Math.round(item.amount * 100) / 100 : Math.round(sundry.default_value * 100) / 100;
    }

    const isPreTax = Boolean(sundry.impact_taxable_value);
    const signedAmount = sundry.type === 'ADDITION' ? computedAmount : -computedAmount;

    if (isPreTax) {
      if (sundry.type === 'ADDITION') preTaxAdditionTotal += computedAmount;
      else preTaxDeductionTotal += computedAmount;
    } else {
      if (sundry.type === 'ADDITION') postTaxAdditionTotal += computedAmount;
      else postTaxDeductionTotal += computedAmount;
    }

    calculatedLines.push({
      id: randomUUID(),
      bill_sundry_id: sundry.id,
      name: sundry.name,
      type: sundry.type,
      calc_mode: sundry.calc_mode,
      impact_taxable_value: isPreTax,
      rate,
      amount: computedAmount,
      signed_amount: signedAmount,
      linked_account_id: sundry.linked_account_id,
    });
  }

  // Net pre-tax sundry adjustment to be apportioned to items
  const netPreTaxAdjustment = Math.round((preTaxAdditionTotal - preTaxDeductionTotal) * 100) / 100;
  
  // Apportion pre-tax sundries across line items proportionally to compute GST
  let adjustedTaxableTotal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

  const adjustedLines = lines.map((line, idx) => {
    let lineShare = 0;
    if (baseTaxableTotal > 0) {
      lineShare = Math.round(((line.taxable_amount / baseTaxableTotal) * netPreTaxAdjustment) * 100) / 100;
    }
    const adjustedLineTaxable = Math.max(0, Math.round((line.taxable_amount + lineShare) * 100) / 100);
    adjustedTaxableTotal = Math.round((adjustedTaxableTotal + adjustedLineTaxable) * 100) / 100;

    let lineCgst = 0;
    let lineSgst = 0;
    let lineIgst = 0;

    if (isInterState) {
      lineIgst = Math.round(((adjustedLineTaxable * line.gst_rate) / 100) * 100) / 100;
      totalIgst = Math.round((totalIgst + lineIgst) * 100) / 100;
    } else {
      lineCgst = Math.round(((adjustedLineTaxable * (line.gst_rate / 2)) / 100) * 100) / 100;
      lineSgst = Math.round(((adjustedLineTaxable * (line.gst_rate / 2)) / 100) * 100) / 100;
      totalCgst = Math.round((totalCgst + lineCgst) * 100) / 100;
      totalSgst = Math.round((totalSgst + lineSgst) * 100) / 100;
    }

    return {
      ...line,
      adjusted_taxable_amount: adjustedLineTaxable,
      cgst_amount: lineCgst,
      sgst_amount: lineSgst,
      igst_amount: lineIgst,
      net_amount: Math.round((adjustedLineTaxable + lineCgst + lineSgst + lineIgst) * 100) / 100,
    };
  });

  const taxTotal = Math.round((totalCgst + totalSgst + totalIgst) * 100) / 100;
  const netPostTaxAdjustment = Math.round((postTaxAdditionTotal - postTaxDeductionTotal) * 100) / 100;
  
  const unroundedGross = Math.round((adjustedTaxableTotal + taxTotal + netPostTaxAdjustment) * 100) / 100;
  const finalGross = Math.round(unroundedGross);
  const roundOffDiff = Math.round((finalGross - unroundedGross) * 100) / 100;

  return {
    calculatedLines,
    adjustedLines,
    preTaxAdjustment: netPreTaxAdjustment,
    postTaxAdjustment: netPostTaxAdjustment,
    adjustedTaxableTotal,
    totalCgst,
    totalSgst,
    totalIgst,
    taxTotal,
    unroundedGross,
    finalGross,
    roundOffDiff,
  };
}
