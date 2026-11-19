import express from 'express';
import cors from 'cors';
import { initDatabase } from './db/schema.js';
import { extendCommercialSchema } from './db/commercialSchema.js';
import { seedCompanyAndStandardMasters } from './db/seed.js';
import { createSalesVoucher } from './services/salesService.js';
import { createPurchaseVoucher } from './services/purchaseService.js';
import { createPaymentReceiptVoucher } from './services/paymentService.js';
import { createSalesOrder, createDeliveryChallan, getSalesOrders, createSalesQuotation, getSalesQuotations, convertQuotationToOrder } from './services/orderService.js';
import { createPurchaseOrder, createGoodsReceiptNote, getPurchaseOrders, getGoodsReceiptNotes } from './services/procurementService.js';
import { getBillSundries, saveBillSundry, seedDefaultBillSundries } from './services/billSundryService.js';
import { getBankAccounts, getBankReconciliationStatement, updateBankClearance, ensureDefaultBankAccount } from './services/brsService.js';
import { executeStockTransfer, getGodownStockReport, getGodownsSummary } from './services/stockTransferService.js';
import { executeProductionRun, createBillOfMaterials, getBillOfMaterialsList, getProductionHistory } from './services/manufacturingService.js';
import { processMonthlyPayroll, getEmployees, createOrUpdateEmployee } from './services/payrollService.js';
import { generateEWayBill, generateEInvoice } from './services/gstComplianceService.js';
import { getTrialBalance, getStockStatus } from './services/reportService.js';
import { calculateProfitAndLoss, calculateBalanceSheet, getAccountLedgerStatement, getGSTSummaryReport, getBillOutstandingReport } from './services/finalReportsService.js';
import { createContraVoucher } from './services/contraService.js';
import { getCompanyFeatures, updateCompanyFeatures, getVoucherSeriesList, updateVoucherSeries, freezeDataUpToDate, getActiveFreezeDate } from './services/configurationService.js';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(express.json());

// Ensure data folder
const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = initDatabase(path.join(dataDir, 'exonus.db'));
// Extend full commercial schema tables (BOM, Payroll, Orders, E-Way/E-Invoice)
extendCommercialSchema(db);

// Check if company exists, if not seed default demo company
const existingCompany = db.prepare('SELECT * FROM companies LIMIT 1').get() as any;
let activeCompanyId: string;

if (!existingCompany) {
  activeCompanyId = randomUUID();
  seedCompanyAndStandardMasters(db, {
    id: activeCompanyId,
    name: 'Exonus Trading & Retail Pvt Ltd',
    trade_name: 'Exonus Supermarket & Electronics',
    gstin: '07AAAAA0000A1Z5',
    state_code: '07', // Delhi
    financial_year_start: '2026-04-01',
    financial_year_end: '2027-03-31',
  });

  // Add initial sample customer & supplier
  const debtorGrp = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND name = 'Sundry Debtors'").get(activeCompanyId) as any;
  const creditorGrp = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND name = 'Sundry Creditors'").get(activeCompanyId) as any;
  const pcsUnit = db.prepare("SELECT id FROM units WHERE company_id = ? AND symbol = 'Pcs'").get(activeCompanyId) as any;
  const mainGodown = db.prepare("SELECT id FROM material_centres WHERE company_id = ?").get(activeCompanyId) as any;

  db.prepare(`
    INSERT INTO accounts (id, company_id, group_id, name, state_code, gstin)
    VALUES (?, ?, ?, 'Metro Traders', '07', '07BBBBB1111B1Z2')
  `).run(randomUUID(), activeCompanyId, debtorGrp.id);

  db.prepare(`
    INSERT INTO accounts (id, company_id, group_id, name, state_code, gstin)
    VALUES (?, ?, ?, 'Global Tech Wholesalers', '27', '27CCCCC2222C1Z3')
  `).run(randomUUID(), activeCompanyId, creditorGrp.id);

  const sampleItem = randomUUID();
  db.prepare(`
    INSERT INTO items (id, company_id, name, sku, hsn_code, gst_rate, primary_unit_id, standard_sale_rate, standard_purchase_rate)
    VALUES (?, ?, 'Wireless Barcode Scanner', 'SCAN-W01', '84719000', 18, ?, 2500, 1800)
  `).run(sampleItem, activeCompanyId, pcsUnit.id);

  // Inward initial stock
  db.prepare(`
    INSERT INTO stock_entries (id, company_id, item_id, material_centre_id, inward_qty, rate, entry_date)
    VALUES (?, ?, ?, ?, 100, 1800, '2026-04-01')
  `).run(randomUUID(), activeCompanyId, sampleItem, mainGodown.id);
} else {
  activeCompanyId = existingCompany.id;
}

// 1. Company & Info
app.get('/api/company', (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(activeCompanyId);
  res.json(company);
});

// 2. Masters List (Accounts, Items, Godowns, Units)
app.get('/api/masters', (req, res) => {
  const accounts = db.prepare(`
    SELECT 
      a.*, 
      ag.name as group_name, 
      ag.nature,
      (COALESCE((SELECT SUM(debit) FROM ledger_entries WHERE account_id = a.id), 0) -
       COALESCE((SELECT SUM(credit) FROM ledger_entries WHERE account_id = a.id), 0)) as current_balance
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    WHERE a.company_id = ?
    ORDER BY a.name
  `).all(activeCompanyId);

  const groups = db.prepare(`
    SELECT * FROM account_groups WHERE company_id = ? ORDER BY name
  `).all(activeCompanyId);

  const items = db.prepare(`
    SELECT i.*, u.symbol as unit_symbol 
    FROM items i
    JOIN units u ON i.primary_unit_id = u.id
    WHERE i.company_id = ?
    ORDER BY i.name
  `).all(activeCompanyId);

  const godowns = db.prepare('SELECT * FROM material_centres WHERE company_id = ?').all(activeCompanyId);
  const units = db.prepare('SELECT * FROM units WHERE company_id = ?').all(activeCompanyId);
  const billSundries = getBillSundries(db, activeCompanyId);

  res.json({ accounts, groups, items, godowns, units, billSundries });
});

// 2.1 Create Party / Account Master (BUSY Style)
app.post('/api/accounts', (req, res) => {
  try {
    const { name, group_id, gstin, state_code, address, credit_limit, credit_period_days } = req.body;
    if (!name || !name.trim()) throw new Error('Party name is required');
    if (!group_id) throw new Error('Account Group is required');

    const id = randomUUID();
    db.prepare(`
      INSERT INTO accounts (
        id, company_id, group_id, name, gstin, state_code, address, credit_limit, credit_period_days, bill_by_bill_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id, activeCompanyId, group_id, name.trim(), gstin || null,
      state_code || null, address || null, credit_limit || 0, credit_period_days || 0
    );

    // Outbox Sync for Silver Cloud & Gold Cloud
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'ACCOUNT', ?, 'CREATE', ?)
    `).run(
      randomUUID(), activeCompanyId, id,
      JSON.stringify({ id, name: name.trim(), group_id, gstin })
    );

    res.json({ success: true, id, name: name.trim() });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2.2 Create Item Master (Product / Service)
app.post('/api/items', (req, res) => {
  try {
    const { name, sku, hsn_code, gst_rate, primary_unit_id, standard_sale_rate, standard_purchase_rate } = req.body;
    if (!name || !name.trim()) throw new Error('Item name is required');
    if (!hsn_code) throw new Error('HSN code is required');
    if (!primary_unit_id) throw new Error('Unit of measurement is required');

    const id = randomUUID();
    db.prepare(`
      INSERT INTO items (
        id, company_id, name, sku, hsn_code, gst_rate, primary_unit_id, standard_sale_rate, standard_purchase_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, activeCompanyId, name.trim(), sku || null, hsn_code,
      gst_rate || 18, primary_unit_id, standard_sale_rate || 0, standard_purchase_rate || 0
    );

    res.json({ success: true, id, name: name.trim() });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2.3 Create Unit Master
app.post('/api/units', (req, res) => {
  try {
    const { name, symbol, uqc_code } = req.body;
    if (!name || !name.trim()) throw new Error('Unit name is required');
    if (!symbol || !symbol.trim()) throw new Error('Unit symbol is required');

    const id = randomUUID();
    db.prepare(`
      INSERT INTO units (id, company_id, name, symbol, uqc_code)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, activeCompanyId, name.trim(), symbol.trim(), uqc_code || symbol.trim().toUpperCase());

    res.json({ success: true, id, name: name.trim(), symbol: symbol.trim() });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2.4 Create Material Centre (Godown / Warehouse)
app.post('/api/godowns', (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name || !name.trim()) throw new Error('Godown name is required');

    const id = randomUUID();
    db.prepare(`
      INSERT INTO material_centres (id, company_id, name, address, is_default)
      VALUES (?, ?, ?, ?, 0)
    `).run(id, activeCompanyId, name.trim(), address || null);

    res.json({ success: true, id, name: name.trim() });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 2.5 Get Pending Bills for Party (Bill-by-Bill Settlement)
app.get('/api/accounts/:id/pending-bills', (req, res) => {
  try {
    const bills = db.prepare(`
      SELECT 
        b.id,
        b.ref_number,
        b.bill_date,
        b.due_date,
        b.total_amount,
        b.pending_amount,
        v.voucher_type
      FROM bill_references b
      JOIN vouchers v ON b.ref_voucher_id = v.id
      WHERE b.company_id = ? AND b.account_id = ? AND b.pending_amount > 0
      ORDER BY b.bill_date ASC
    `).all(activeCompanyId, req.params.id);
    res.json(bills);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 2.6 Bill Sundries Master API
app.get('/api/bill-sundries', (req, res) => {
  try {
    const sundries = getBillSundries(db, activeCompanyId);
    res.json(sundries);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bill-sundries', (req, res) => {
  try {
    const result = saveBillSundry(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3. Transactions / Vouchers (Full Double-Entry Day Book)
app.get('/api/vouchers', (req, res) => {
  const vouchers = db.prepare(`
    SELECT 
      v.*, 
      a.name as party_name,
      v.gross_total as total_debit,
      v.gross_total as total_credit,
      ewb.eway_bill_number,
      ewb.vehicle_number,
      einv.irn_hash,
      einv.ack_number
    FROM vouchers v
    LEFT JOIN accounts a ON v.party_account_id = a.id
    LEFT JOIN gst_e_way_bills ewb ON v.id = ewb.voucher_id
    LEFT JOIN gst_e_invoices einv ON v.id = einv.voucher_id
    WHERE v.company_id = ?
    ORDER BY v.date DESC, v.created_at DESC
    LIMIT 200
  `).all(activeCompanyId);
  res.json(vouchers);
});

// =========================================================================
// PHASE 2: ORDER-TO-CASH (SALES ORDERS, QUOTATIONS & DELIVERY CHALLANS)
// =========================================================================

app.get('/api/quotations/sales', (req, res) => {
  try {
    const quotes = getSalesQuotations(db, activeCompanyId);
    res.json(quotes);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/quotations/sales', (req, res) => {
  try {
    const result = createSalesQuotation(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/quotations/:id/convert-to-order', (req, res) => {
  try {
    const defaultGodown = db.prepare('SELECT id FROM material_centres WHERE company_id = ? LIMIT 1').get(activeCompanyId) as any;
    const result = convertQuotationToOrder(db, req.params.id, defaultGodown?.id);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/orders/sales', (req, res) => {
  try {
    const orders = getSalesOrders(db, activeCompanyId);
    res.json(orders);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders/sales/:id/items', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT 
        soi.*, 
        i.name as item_name, 
        i.hsn_code, 
        u.symbol as unit_symbol
      FROM sales_order_items soi
      JOIN items i ON soi.item_id = i.id
      JOIN units u ON soi.unit_id = u.id
      WHERE soi.order_id = ?
    `).all(req.params.id);
    res.json(items);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/sales', (req, res) => {
  try {
    const result = createSalesOrder(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/challans/delivery', (req, res) => {
  try {
    const result = createDeliveryChallan(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3.4 Purchase Orders (Procurement)
app.get('/api/orders/purchase', (req, res) => {
  try {
    const orders = getPurchaseOrders(db, activeCompanyId);
    res.json(orders);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/orders/purchase/:id/items', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT 
        poi.*, 
        i.name as item_name, 
        i.hsn_code, 
        u.symbol as unit_symbol
      FROM purchase_order_items poi
      JOIN items i ON poi.item_id = i.id
      JOIN units u ON poi.unit_id = u.id
      WHERE poi.po_id = ?
    `).all(req.params.id);
    res.json(items);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/orders/purchase', (req, res) => {
  try {
    const result = createPurchaseOrder(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 3.5 Goods Receipt Notes (GRN / Material Inward Challan)
app.get('/api/grn', (req, res) => {
  try {
    const grns = getGoodsReceiptNotes(db, activeCompanyId);
    res.json(grns);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/grn/:id/items', (req, res) => {
  try {
    const items = db.prepare(`
      SELECT 
        gi.*, 
        i.name as item_name, 
        i.hsn_code, 
        u.symbol as unit_symbol
      FROM grn_items gi
      JOIN items i ON gi.item_id = i.id
      JOIN units u ON gi.unit_id = u.id
      WHERE gi.grn_id = ?
    `).all(req.params.id);
    res.json(items);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/grn', (req, res) => {
  try {
    const result = createGoodsReceiptNote(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 4. Create Sales Voucher
app.post('/api/vouchers/sales', (req, res) => {
  try {
    const result = createSalesVoucher(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 5. Create Purchase Voucher
app.post('/api/vouchers/purchase', (req, res) => {
  try {
    const result = createPurchaseVoucher(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6. Create Payment / Receipt
app.post('/api/vouchers/payment-receipt', (req, res) => {
  try {
    const result = createPaymentReceiptVoucher(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 6.1 Create Contra Voucher (Cash/Bank Transfer)
app.post('/api/vouchers/contra', (req, res) => {
  try {
    const result = createContraVoucher(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 7. Manufacturing & Production BOM
app.get('/api/boms', (req, res) => {
  try {
    const boms = getBillOfMaterialsList(db, activeCompanyId);
    res.json(boms);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/boms', (req, res) => {
  try {
    const result = createBillOfMaterials(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/production/history', (req, res) => {
  try {
    const history = getProductionHistory(db, activeCompanyId);
    res.json(history);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/vouchers/production', (req, res) => {
  try {
    const result = executeProductionRun(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 8. Payroll HRMS & Salary Processing
app.get('/api/employees', (req, res) => {
  try {
    const emps = getEmployees(db, activeCompanyId);
    res.json(emps);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/employees', (req, res) => {
  try {
    const result = createOrUpdateEmployee(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/payroll/process', (req, res) => {
  try {
    const result = processMonthlyPayroll(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 9. GST E-Way Bill & E-Invoice Generation
app.post('/api/gst/eway-bill', (req, res) => {
  try {
    const result = generateEWayBill(db, req.body);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 9.1 Bank Reconciliation Statement (BRS Module)
app.get('/api/brs/banks', (req, res) => {
  try {
    const banks = getBankAccounts(db, activeCompanyId);
    res.json(banks);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/brs/statement', (req, res) => {
  try {
    const bankAccountId = req.query.bank_account_id as string;
    const asOfDate = req.query.as_of_date as string;
    if (!bankAccountId) throw new Error('bank_account_id is required');

    const statement = getBankReconciliationStatement(db, activeCompanyId, bankAccountId, asOfDate);
    res.json(statement);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/brs/clearance', (req, res) => {
  try {
    const result = updateBankClearance(db, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/gst/einvoice', (req, res) => {
  try {
    const result = generateEInvoice(db, req.body.voucher_id);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 10. Real-Time Reports
app.get('/api/reports/trial-balance', (req, res) => {
  const tb = getTrialBalance(db, activeCompanyId);
  res.json(tb);
});

app.get('/api/reports/stock-status', (req, res) => {
  const stock = getStockStatus(db, activeCompanyId);
  res.json(stock);
});

// 10.2 Final Results & Advanced MIS Reports (BUSY Magic Display Engine)
app.get('/api/reports/profit-loss', (req, res) => {
  try {
    const pl = calculateProfitAndLoss(db, activeCompanyId);
    res.json(pl);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/reports/balance-sheet', (req, res) => {
  try {
    const bs = calculateBalanceSheet(db, activeCompanyId);
    res.json(bs);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/reports/account-ledger', (req, res) => {
  try {
    const accountId = req.query.account_id as string;
    if (!accountId) throw new Error('account_id is required');
    const statement = getAccountLedgerStatement(db, activeCompanyId, accountId);
    res.json(statement);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/reports/gst-summary', (req, res) => {
  try {
    const gstReport = getGSTSummaryReport(db, activeCompanyId);
    res.json(gstReport);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/reports/outstandings', (req, res) => {
  try {
    const type = (req.query.type as string)?.toUpperCase() === 'PAYABLE' ? 'PAYABLE' : 'RECEIVABLE';
    const report = getBillOutstandingReport(db, activeCompanyId, type);
    res.json(report);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 10.3 Configuration & Administration (BUSY Features/Options & Series Engine)
app.get('/api/config/features', (req, res) => {
  try {
    const features = getCompanyFeatures(db, activeCompanyId);
    res.json(features);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/config/features', (req, res) => {
  try {
    const result = updateCompanyFeatures(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/config/series', (req, res) => {
  try {
    const list = getVoucherSeriesList(db, activeCompanyId);
    res.json(list);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/config/series', (req, res) => {
  try {
    const result = updateVoucherSeries(db, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/config/freeze', (req, res) => {
  try {
    const activeDate = getActiveFreezeDate(db, activeCompanyId);
    res.json({ freeze_up_to_date: activeDate });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/config/freeze', (req, res) => {
  try {
    const result = freezeDataUpToDate(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// 10.1 Multi-Godown Reports & Transfers
app.get('/api/godowns/summary', (req, res) => {
  try {
    const summary = getGodownsSummary(db, activeCompanyId);
    res.json(summary);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/godowns/report', (req, res) => {
  try {
    const godownId = req.query.godown_id as string;
    const report = getGodownStockReport(db, activeCompanyId, godownId);
    res.json(report);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stock/transfer', (req, res) => {
  try {
    const result = executeStockTransfer(db, {
      ...req.body,
      company_id: activeCompanyId,
    });
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 8. Cloud Outbox Status (Silver Cloud & Gold Cloud Sync)
app.get('/api/sync/outbox', (req, res) => {
  const outbox = db.prepare(`
    SELECT * FROM sync_outbox WHERE company_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(activeCompanyId);
  res.json(outbox);
});

// Serve frontend build if present
const publicDir = path.resolve(process.cwd(), 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      return res.sendFile(path.join(publicDir, 'index.html'));
    }
    next();
  });
}

const PORT = process.env.PORT || 4200;
app.listen(PORT, () => {
  console.log(`⚡ Exonus ERP Local Server running on http://localhost:${PORT}`);
});
