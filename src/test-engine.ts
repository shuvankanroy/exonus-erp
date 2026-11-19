import { initDatabase } from './db/schema.js';
import { seedCompanyAndStandardMasters } from './db/seed.js';
import { createSalesVoucher } from './services/salesService.js';
import { getTrialBalance, getStockStatus } from './services/reportService.js';
import { randomUUID } from 'crypto';

console.log('🚀 Initializing Exonus ERP Engine...');
const db = initDatabase(':memory:'); // In-memory verification for test run

// 1. Seed Company & Standard Masters
const companyId = randomUUID();
seedCompanyAndStandardMasters(db, {
  id: companyId,
  name: 'Exonus Trading & Retail Pvt Ltd',
  trade_name: 'Exonus Enterprises',
  gstin: '07AAAAA0000A1Z5',
  state_code: '07', // Delhi
  financial_year_start: '2026-04-01',
  financial_year_end: '2027-03-31',
});

// 2. Create a Customer (Sundry Debtor)
const debtorGroup = db.prepare("SELECT id FROM account_groups WHERE company_id = ? AND name = 'Sundry Debtors'").get(companyId) as any;
const customerId = randomUUID();
db.prepare(`
  INSERT INTO accounts (id, company_id, group_id, name, state_code, gstin)
  VALUES (?, ?, ?, 'Sharma Retail Store', '07', '07BBBBB1111B1Z2')
`).run(customerId, companyId, debtorGroup.id);

// 3. Create an Item
const unit = db.prepare("SELECT id FROM units WHERE company_id = ? AND symbol = 'Pcs'").get(companyId) as any;
const godown = db.prepare("SELECT id FROM material_centres WHERE company_id = ?").get(companyId) as any;
const itemId = randomUUID();

db.prepare(`
  INSERT INTO items (id, company_id, name, sku, hsn_code, gst_rate, primary_unit_id, standard_sale_rate)
  VALUES (?, ?, 'Wireless Barcode Scanner', 'SCAN-W01', '84719000', 18.0, ?, 2500)
`).run(itemId, companyId, unit.id);

// Seed initial stock inward
db.prepare(`
  INSERT INTO stock_entries (id, company_id, voucher_id, item_id, material_centre_id, inward_qty, rate, entry_date)
  VALUES (?, ?, NULL, ?, ?, 50, 1800, '2026-04-01')
`).run(randomUUID(), companyId, itemId, godown.id);

console.log('✅ Setup & Masters initialized successfully.');

// 4. Record a Sales Voucher (BUSY Double-Entry & Stock Movement Workflow)
console.log('⚡ Processing Sales Invoice via Exonus Transaction Engine...');
const result = createSalesVoucher(db, {
  company_id: companyId,
  date: '2026-04-05',
  party_account_id: customerId,
  material_centre_id: godown.id,
  narration: 'Counter Sales Bill',
  pos_settlement_type: 'CREDIT',
  items: [
    {
      item_id: itemId,
      qty: 2,
      unit_id: unit.id,
      rate: 2500,
      discount_pct: 10, // 10% discount
    },
  ],
});

console.log('🎉 Voucher Created Successfully:');
console.log(JSON.stringify(result, null, 2));

// 5. Verify Trial Balance (Strict Double-Entry Guarantee)
console.log('\n📊 Generating Real-Time Trial Balance:');
const trialBalance = getTrialBalance(db, companyId);
console.table(trialBalance.rows);
console.log(`\nDouble-Entry Verification: Total Debits = ₹${trialBalance.totalDebits} | Total Credits = ₹${trialBalance.totalCredits}`);
console.log(`Is Balanced: ${trialBalance.isBalanced ? '✅ TRUE (Zero Discrepancy)' : '❌ FALSE'}`);

// 6. Verify Perpetual Stock Ledger
console.log('\n📦 Checking Real-Time Stock Status:');
const stock = getStockStatus(db, companyId);
console.table(stock);

// 7. Check Outbox Sync Queue (Ready for Silver Cloud / Gold Cloud replication)
const outbox = db.prepare('SELECT id, entity_type, action, status, payload FROM sync_outbox').all();
console.log('\n☁️ Outbox Sync Queue (Pending replication to Cloud):');
console.log(JSON.stringify(outbox, null, 2));
