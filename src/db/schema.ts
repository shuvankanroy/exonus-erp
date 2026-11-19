import Database from 'better-sqlite3';
import path from 'path';

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || path.resolve(process.cwd(), 'data', 'exonus.db');
  const db = new Database(resolvedPath);

  // Enable WAL (Write-Ahead Logging) mode and performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456'); // 256MB zero-copy memory mapped reads
  db.pragma('cache_size = -64000');   // 64MB memory page cache

  db.exec(`
    -- 1. Company & Financial Year Setup
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trade_name TEXT,
      industry_type TEXT DEFAULT 'Trading / Wholesale & Distribution',
      gstin TEXT,
      pan TEXT,
      cin TEXT,
      gst_type TEXT DEFAULT 'Regular Taxpayer', -- Regular Taxpayer, Composition Scheme, Unregistered, SEZ
      udyam_no TEXT,
      state_code TEXT NOT NULL, -- e.g., '07' for Delhi, '27' for Maharashtra
      state_name TEXT,
      address TEXT,
      city TEXT,
      pin_code TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      financial_year_start TEXT NOT NULL, -- YYYY-MM-DD
      financial_year_end TEXT NOT NULL,
      books_commencing_from TEXT,
      base_currency TEXT DEFAULT 'INR',
      currency_symbol TEXT DEFAULT '₹',
      bank_name TEXT,
      bank_acc_no TEXT,
      bank_ifsc TEXT,
      bank_branch TEXT,
      setup_completed BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Voucher Series Configuration (BUSY Style)
    CREATE TABLE IF NOT EXISTS voucher_series (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      voucher_type TEXT NOT NULL, -- 'SALES', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'CONTRA', 'JOURNAL', 'STOCK_TRANSFER'
      series_name TEXT NOT NULL, -- e.g., 'Main', 'POS-Counter1'
      prefix TEXT DEFAULT '',
      suffix TEXT DEFAULT '',
      current_number INTEGER DEFAULT 0,
      auto_numbering BOOLEAN DEFAULT 1,
      allow_zero_value BOOLEAN DEFAULT 0,
      prompt_settlement BOOLEAN DEFAULT 1,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      UNIQUE(company_id, voucher_type, series_name)
    );

    -- 3. Chart of Accounts & Groups (BUSY Hierarchy)
    CREATE TABLE IF NOT EXISTS account_groups (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_group_id TEXT,
      nature TEXT NOT NULL CHECK(nature IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
      is_primary BOOLEAN DEFAULT 0,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_group_id) REFERENCES account_groups(id)
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT,
      gstin TEXT,
      state_code TEXT,
      address TEXT,
      credit_limit REAL DEFAULT 0,
      credit_period_days INTEGER DEFAULT 0,
      bill_by_bill_enabled BOOLEAN DEFAULT 1,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES account_groups(id)
    );

    -- 4. Units of Measurement & Material Centres (Godowns)
    CREATE TABLE IF NOT EXISTS units (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      uqc_code TEXT, -- e.g., 'BOX', 'PCS', 'KGS'
      category TEXT, -- e.g. 'Unit', 'Length', 'Area', 'Volume', 'Weight'
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS material_centres (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL, -- e.g., 'Main Godown', 'Shop Floor'
      parent_centre_id TEXT, -- Hierarchical parent godown (Tree structure)
      is_group BOOLEAN DEFAULT 0, -- Folder group vs leaf storage node
      account_id TEXT, -- Linked Stock-in-Hand GL Account
      address TEXT,
      is_default BOOLEAN DEFAULT 0,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_centre_id) REFERENCES material_centres(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    -- ERPNext-Grade Stock Settings & System Parameters
    CREATE TABLE IF NOT EXISTS stock_settings (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL UNIQUE,
      default_valuation_method TEXT DEFAULT 'FIFO' CHECK(default_valuation_method IN ('FIFO', 'Moving Average')),
      allow_negative_stock BOOLEAN DEFAULT 0,
      stock_freeze_up_to_date TEXT,
      auto_reorder_enabled BOOLEAN DEFAULT 1,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    -- ERPNext-Grade Bins (Real-time Material Planning Cache)
    CREATE TABLE IF NOT EXISTS bins (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      material_centre_id TEXT NOT NULL,
      actual_qty REAL DEFAULT 0,
      ordered_qty REAL DEFAULT 0,
      reserved_qty REAL DEFAULT 0,
      indented_qty REAL DEFAULT 0,
      planned_qty REAL DEFAULT 0,
      projected_qty REAL DEFAULT 0,
      valuation_rate REAL DEFAULT 0,
      stock_value REAL DEFAULT 0,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      FOREIGN KEY (material_centre_id) REFERENCES material_centres(id) ON DELETE CASCADE,
      UNIQUE(item_id, material_centre_id)
    );

    -- ERPNext-Grade Stock Ledger Entries (Immutable Journal)
    CREATE TABLE IF NOT EXISTS stock_ledger_entries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      voucher_id TEXT, -- Nullable/unconstrained for opening stock or pre-voucher movements
      voucher_type TEXT NOT NULL, -- 'SALES', 'PURCHASE', 'STOCK_TRANSFER', 'STOCK_ENTRY', 'STOCK_RECON', 'DELIVERY_NOTE', 'PURCHASE_RECEIPT'
      voucher_number TEXT NOT NULL,
      posting_date TEXT NOT NULL,
      posting_time TEXT NOT NULL,
      item_id TEXT NOT NULL,
      material_centre_id TEXT NOT NULL,
      batch_id TEXT,
      actual_qty REAL NOT NULL, -- + for inward, - for outward
      qty_after_transaction REAL NOT NULL,
      incoming_rate REAL DEFAULT 0,
      outgoing_rate REAL DEFAULT 0,
      valuation_rate REAL NOT NULL,
      stock_value REAL NOT NULL,
      stock_value_difference REAL NOT NULL,
      stock_queue TEXT DEFAULT '[]', -- JSON serialized FIFO queue: [[qty, rate], ...]
      is_cancelled BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (material_centre_id) REFERENCES material_centres(id)
    );

    -- 5. Items, Batches & Pricing
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sku TEXT,
      barcode TEXT,
      hsn_code TEXT NOT NULL,
      gst_rate REAL NOT NULL, -- e.g. 5, 12, 18, 28
      primary_unit_id TEXT NOT NULL,
      alt_unit_id TEXT,
      alt_conversion_factor REAL DEFAULT 1, -- e.g. 1 Box = 24 Pcs
      standard_sale_rate REAL DEFAULT 0,
      standard_purchase_rate REAL DEFAULT 0,
      mrp REAL DEFAULT 0,
      min_stock_level REAL DEFAULT 0,
      is_batch_tracked BOOLEAN DEFAULT 0,
      is_serial_tracked BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (primary_unit_id) REFERENCES units(id),
      FOREIGN KEY (alt_unit_id) REFERENCES units(id)
    );

    CREATE TABLE IF NOT EXISTS item_batches (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      batch_number TEXT NOT NULL,
      mfg_date TEXT,
      exp_date TEXT,
      mrp REAL,
      sale_rate REAL,
      cost_price REAL,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
      UNIQUE(item_id, batch_number)
    );

    -- 6. Bill Sundries (Discount, Freight, Packaging, Round-off)
    CREATE TABLE IF NOT EXISTS bill_sundries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('ADDITION', 'DEDUCTION')),
      calc_mode TEXT NOT NULL CHECK(calc_mode IN ('PERCENTAGE', 'LUMPSUM', 'ROUND_OFF')),
      default_value REAL DEFAULT 0,
      impact_taxable_value BOOLEAN DEFAULT 1,
      linked_account_id TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_account_id) REFERENCES accounts(id)
    );

    -- 7. Vouchers Header (All transaction types)
    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      series_id TEXT NOT NULL,
      voucher_type TEXT NOT NULL,
      voucher_number TEXT NOT NULL,
      date TEXT NOT NULL, -- YYYY-MM-DD
      party_account_id TEXT, -- Customer, Supplier, or Contra account
      material_centre_id TEXT, -- Default godown for transaction
      narration TEXT,
      sub_total REAL DEFAULT 0,
      tax_total REAL DEFAULT 0,
      bill_sundry_total REAL DEFAULT 0,
      gross_total REAL DEFAULT 0,
      pos_settlement_type TEXT, -- 'CASH', 'UPI', 'CARD', 'SPLIT', 'CREDIT'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (series_id) REFERENCES voucher_series(id),
      FOREIGN KEY (party_account_id) REFERENCES accounts(id),
      FOREIGN KEY (material_centre_id) REFERENCES material_centres(id)
    );

    -- 8. Voucher Line Items (Inventory movements)
    CREATE TABLE IF NOT EXISTS voucher_items (
      id TEXT PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      batch_id TEXT,
      material_centre_id TEXT NOT NULL,
      qty REAL NOT NULL,
      unit_id TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL DEFAULT 0,
      taxable_amount REAL NOT NULL,
      gst_rate REAL NOT NULL,
      cgst_amount REAL DEFAULT 0,
      sgst_amount REAL DEFAULT 0,
      igst_amount REAL DEFAULT 0,
      net_amount REAL NOT NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (batch_id) REFERENCES item_batches(id),
      FOREIGN KEY (material_centre_id) REFERENCES material_centres(id),
      FOREIGN KEY (unit_id) REFERENCES units(id)
    );

    -- 9. Voucher Bill Sundry Applied Lines
    CREATE TABLE IF NOT EXISTS voucher_bill_sundry_lines (
      id TEXT PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      bill_sundry_id TEXT NOT NULL,
      rate REAL DEFAULT 0, -- percentage or flat rate
      amount REAL NOT NULL,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (bill_sundry_id) REFERENCES bill_sundries(id)
    );

    -- 10. Double-Entry General Ledger Postings (Immutable Financial Journal)
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      voucher_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      debit REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      entry_date TEXT NOT NULL,
      narration TEXT,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    -- 11. Perpetual Inventory Stock Ledger (Stock Status & Movements)
    CREATE TABLE IF NOT EXISTS stock_entries (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      voucher_id TEXT, -- Nullable for opening stock
      item_id TEXT NOT NULL,
      batch_id TEXT,
      material_centre_id TEXT NOT NULL,
      inward_qty REAL DEFAULT 0,
      outward_qty REAL DEFAULT 0,
      rate REAL NOT NULL,
      entry_date TEXT NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (material_centre_id) REFERENCES material_centres(id)
    );

    -- 12. Bill-by-Bill Outstanding Tracking
    CREATE TABLE IF NOT EXISTS bill_references (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      ref_voucher_id TEXT NOT NULL,
      ref_number TEXT NOT NULL,
      bill_date TEXT NOT NULL,
      due_date TEXT,
      total_amount REAL NOT NULL,
      pending_amount REAL NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (ref_voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bill_adjustments (
      id TEXT PRIMARY KEY,
      bill_reference_id TEXT NOT NULL,
      payment_voucher_id TEXT NOT NULL,
      adjusted_amount REAL NOT NULL,
      adjustment_date TEXT NOT NULL,
      FOREIGN KEY (bill_reference_id) REFERENCES bill_references(id) ON DELETE CASCADE,
      FOREIGN KEY (payment_voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
    );

    -- 13. Universal Outbox Sync Engine (Silver Cloud & Gold Cloud replication)
    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, -- 'VOUCHER', 'ACCOUNT', 'ITEM', 'MASTER'
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE'
      payload TEXT NOT NULL, -- JSON serialized snapshot
      status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SYNCED', 'FAILED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      synced_at DATETIME
    );

    -- Performance Indexes & Covering Scans (Audited by Systems Debugger)
    CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id);
    CREATE INDEX IF NOT EXISTS idx_account_groups_company ON account_groups(company_id);
    CREATE INDEX IF NOT EXISTS idx_items_company ON items(company_id);
    CREATE INDEX IF NOT EXISTS idx_mc_company ON material_centres(company_id);

    -- Covering Indexes for Financial & Stock Aggregations (Index-only scans)
    CREATE INDEX IF NOT EXISTS idx_ledger_acc_covering ON ledger_entries(account_id, debit, credit);
    CREATE INDEX IF NOT EXISTS idx_stock_covering ON stock_entries(item_id, material_centre_id, inward_qty, outward_qty);

    -- Compound Indexes for Voucher Point & Range Retrievals
    CREATE INDEX IF NOT EXISTS idx_vouchers_comp_date ON vouchers(company_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vouchers_comp_party_date ON vouchers(company_id, party_account_id, date DESC, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbox_comp_created ON sync_outbox(company_id, created_at DESC);

    -- Foreign Key Cascade Protection Indexes (Eliminates table scans on voucher edit/delete)
    CREATE INDEX IF NOT EXISTS idx_voucher_items_vch ON voucher_items(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_voucher_bs_vch ON voucher_bill_sundry_lines(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_vch ON ledger_entries(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_stock_vch ON stock_entries(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_bill_refs_vch ON bill_references(ref_voucher_id);
    CREATE INDEX IF NOT EXISTS idx_bill_adj_vch ON bill_adjustments(payment_voucher_id);

    -- Backward compatibility legacy indexes
    CREATE INDEX IF NOT EXISTS idx_ledger_account_date ON ledger_entries(account_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_stock_item_mc ON stock_entries(item_id, material_centre_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON sync_outbox(status);

    -- Stock Ledger & Bin Indexing
    CREATE INDEX IF NOT EXISTS idx_sle_item_mc ON stock_ledger_entries(item_id, material_centre_id, posting_date, posting_time);
    CREATE INDEX IF NOT EXISTS idx_bins_lookup ON bins(item_id, material_centre_id);
  `);

  // Auto-migration helper for material_centres
  const existingMcCols = db.prepare("PRAGMA table_info(material_centres)").all() as Array<{ name: string }>;
  const mcColNames = new Set(existingMcCols.map(c => c.name));
  const newMcCols: Array<{ name: string; type: string }> = [
    { name: 'parent_centre_id', type: 'TEXT' },
    { name: 'is_group', type: 'BOOLEAN DEFAULT 0' },
    { name: 'account_id', type: 'TEXT' }
  ];
  for (const col of newMcCols) {
    if (!mcColNames.has(col.name)) {
      try {
        db.exec(`ALTER TABLE material_centres ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {}
    }
  }

  // Auto-migration helper for existing databases: ensure new company columns exist
  const existingCols = db.prepare("PRAGMA table_info(companies)").all() as Array<{ name: string }>;
  const colNames = new Set(existingCols.map(c => c.name));
  const newCols: Array<{ name: string; type: string }> = [
    { name: 'industry_type', type: 'TEXT DEFAULT "Trading / Wholesale & Distribution"' },
    { name: 'pan', type: 'TEXT' },
    { name: 'cin', type: 'TEXT' },
    { name: 'gst_type', type: 'TEXT DEFAULT "Regular Taxpayer"' },
    { name: 'udyam_no', type: 'TEXT' },
    { name: 'state_name', type: 'TEXT' },
    { name: 'city', type: 'TEXT' },
    { name: 'pin_code', type: 'TEXT' },
    { name: 'phone', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'website', type: 'TEXT' },
    { name: 'books_commencing_from', type: 'TEXT' },
    { name: 'currency_symbol', type: 'TEXT DEFAULT "₹"' },
    { name: 'bank_name', type: 'TEXT' },
    { name: 'bank_acc_no', type: 'TEXT' },
    { name: 'bank_ifsc', type: 'TEXT' },
    { name: 'bank_branch', type: 'TEXT' },
    { name: 'setup_completed', type: 'BOOLEAN DEFAULT 0' }
  ];

  for (const col of newCols) {
    if (!colNames.has(col.name)) {
      try {
        db.exec(`ALTER TABLE companies ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        // column may already exist
      }
    }
  }

  return db;
}
