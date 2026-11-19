import express from 'express';
import cors from 'cors';
import { initDatabase } from './db/schema.js';
import { extendCommercialSchema } from './db/commercialSchema.js';
import { seedCompanyAndStandardMasters } from './db/seed.js';
import { createSalesVoucher } from './services/salesService.js';
import { createPurchaseVoucher } from './services/purchaseService.js';
import { createPaymentReceiptVoucher } from './services/paymentService.js';
import { executeProductionRun } from './services/manufacturingService.js';
import { processMonthlyPayroll } from './services/payrollService.js';
import { generateEWayBill, generateEInvoice } from './services/gstComplianceService.js';
import { getTrialBalance, getStockStatus } from './services/reportService.js';
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
    SELECT a.*, ag.name as group_name, ag.nature 
    FROM accounts a
    JOIN account_groups ag ON a.group_id = ag.id
    WHERE a.company_id = ?
    ORDER BY a.name
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

  res.json({ accounts, items, godowns, units });
});

// 3. Transactions / Vouchers
app.get('/api/vouchers', (req, res) => {
  const vouchers = db.prepare(`
    SELECT v.*, a.name as party_name 
    FROM vouchers v
    LEFT JOIN accounts a ON v.party_account_id = a.id
    WHERE v.company_id = ?
    ORDER BY v.date DESC, v.created_at DESC
    LIMIT 100
  `).all(activeCompanyId);
  res.json(vouchers);
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

// 7. Manufacturing & Production BOM
app.get('/api/boms', (req, res) => {
  const boms = db.prepare(`
    SELECT b.*, i.name as finished_item_name, u.symbol as output_unit_symbol, mc.name as target_godown_name
    FROM bill_of_materials b
    JOIN items i ON b.finished_item_id = i.id
    JOIN units u ON b.output_unit_id = u.id
    JOIN material_centres mc ON b.target_godown_id = mc.id
    WHERE b.company_id = ?
  `).all(activeCompanyId);
  res.json(boms);
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
  const emps = db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY name').all(activeCompanyId);
  res.json(emps);
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
