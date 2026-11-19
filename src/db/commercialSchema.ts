import Database from 'better-sqlite3';

export function extendCommercialSchema(db: Database.Database) {
  db.exec(`
    -- =========================================================================
    -- 1. ORDER-TO-CASH & PROCURE-TO-PAY LIFECYCLE (Quotations, Orders, Challans)
    -- =========================================================================

    -- Sales Orders
    CREATE TABLE IF NOT EXISTS sales_orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      order_number TEXT NOT NULL,
      date TEXT NOT NULL,
      party_account_id TEXT NOT NULL,
      material_centre_id TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'PARTIAL', 'COMPLETED', 'CANCELLED')),
      narration TEXT,
      sub_total REAL DEFAULT 0,
      tax_total REAL DEFAULT 0,
      gross_total REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (party_account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS sales_order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      ordered_qty REAL NOT NULL,
      delivered_qty REAL DEFAULT 0,
      pending_qty REAL NOT NULL,
      unit_id TEXT NOT NULL,
      rate REAL NOT NULL,
      discount_pct REAL DEFAULT 0,
      taxable_amount REAL NOT NULL,
      gst_rate REAL NOT NULL,
      cgst_amount REAL DEFAULT 0,
      sgst_amount REAL DEFAULT 0,
      igst_amount REAL DEFAULT 0,
      net_amount REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES sales_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- Delivery Challans (Material Out before Invoice)
    CREATE TABLE IF NOT EXISTS delivery_challans (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      challan_number TEXT NOT NULL,
      date TEXT NOT NULL,
      party_account_id TEXT NOT NULL,
      sales_order_id TEXT,
      material_centre_id TEXT NOT NULL,
      transporter_name TEXT,
      vehicle_number TEXT,
      status TEXT DEFAULT 'PENDING_INVOICE' CHECK(status IN ('PENDING_INVOICE', 'INVOICED', 'CANCELLED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (party_account_id) REFERENCES accounts(id),
      FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id)
    );

    CREATE TABLE IF NOT EXISTS delivery_challan_items (
      id TEXT PRIMARY KEY,
      challan_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      batch_id TEXT,
      qty REAL NOT NULL,
      unit_id TEXT NOT NULL,
      FOREIGN KEY (challan_id) REFERENCES delivery_challans(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- Purchase Orders (Procurement Lifecycle)
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      po_number TEXT NOT NULL,
      date TEXT NOT NULL,
      vendor_account_id TEXT NOT NULL,
      material_centre_id TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'PARTIAL', 'COMPLETED', 'CANCELLED')),
      gross_total REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (vendor_account_id) REFERENCES accounts(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      po_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      ordered_qty REAL NOT NULL,
      received_qty REAL DEFAULT 0,
      pending_qty REAL NOT NULL,
      unit_id TEXT NOT NULL,
      rate REAL NOT NULL,
      taxable_amount REAL NOT NULL,
      gst_rate REAL NOT NULL,
      net_amount REAL NOT NULL,
      FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    -- =========================================================================
    -- 2. MANUFACTURING & ASSEMBLY (Bill of Materials - BOM)
    -- =========================================================================

    CREATE TABLE IF NOT EXISTS bill_of_materials (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL, -- e.g., 'Recipe for Assembled Barcode Scanner'
      finished_item_id TEXT NOT NULL,
      output_qty REAL NOT NULL DEFAULT 1,
      output_unit_id TEXT NOT NULL,
      target_godown_id TEXT NOT NULL,
      additional_cost_per_batch REAL DEFAULT 0, -- Labor, Power, Machinery
      is_active BOOLEAN DEFAULT 1,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (finished_item_id) REFERENCES items(id),
      FOREIGN KEY (output_unit_id) REFERENCES units(id),
      FOREIGN KEY (target_godown_id) REFERENCES material_centres(id)
    );

    CREATE TABLE IF NOT EXISTS bom_raw_materials (
      id TEXT PRIMARY KEY,
      bom_id TEXT NOT NULL,
      raw_item_id TEXT NOT NULL,
      source_godown_id TEXT NOT NULL,
      consumption_qty REAL NOT NULL,
      unit_id TEXT NOT NULL,
      scrap_percentage REAL DEFAULT 0,
      FOREIGN KEY (bom_id) REFERENCES bill_of_materials(id) ON DELETE CASCADE,
      FOREIGN KEY (raw_item_id) REFERENCES items(id),
      FOREIGN KEY (source_godown_id) REFERENCES material_centres(id)
    );

    CREATE TABLE IF NOT EXISTS production_vouchers (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      voucher_number TEXT NOT NULL,
      date TEXT NOT NULL,
      bom_id TEXT NOT NULL,
      batches_produced REAL NOT NULL,
      total_finished_qty REAL NOT NULL,
      total_cost REAL NOT NULL,
      cost_per_unit REAL NOT NULL,
      narration TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (bom_id) REFERENCES bill_of_materials(id)
    );

    -- =========================================================================
    -- 3. BANK RECONCILIATION STATEMENT (BRS Engine)
    -- =========================================================================

    CREATE TABLE IF NOT EXISTS bank_reconciliations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      bank_account_id TEXT NOT NULL,
      voucher_id TEXT NOT NULL,
      cheque_instrument_number TEXT,
      cheque_date TEXT,
      bank_clearance_date TEXT, -- Date cleared in bank statement
      status TEXT DEFAULT 'UNCLEARED' CHECK(status IN ('UNCLEARED', 'CLEARED', 'BOUNCED')),
      amount REAL NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (bank_account_id) REFERENCES accounts(id),
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
    );

    -- =========================================================================
    -- 4. PAYROLL & HRMS MODULE
    -- =========================================================================

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      emp_code TEXT NOT NULL,
      name TEXT NOT NULL,
      designation TEXT NOT NULL,
      department TEXT NOT NULL,
      joining_date TEXT NOT NULL,
      basic_salary REAL NOT NULL,
      hra REAL DEFAULT 0,
      conveyance REAL DEFAULT 0,
      special_allowance REAL DEFAULT 0,
      pan_number TEXT,
      pf_uan TEXT,
      esi_number TEXT,
      bank_account_number TEXT,
      bank_ifsc TEXT,
      is_active BOOLEAN DEFAULT 1,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      UNIQUE(company_id, emp_code)
    );

    CREATE TABLE IF NOT EXISTS payroll_runs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      month INTEGER NOT NULL, -- 1 to 12
      year INTEGER NOT NULL,
      total_gross_salary REAL NOT NULL,
      total_pf_deduction REAL NOT NULL,
      total_esi_deduction REAL NOT NULL,
      total_pt_deduction REAL NOT NULL,
      total_net_payable REAL NOT NULL,
      gl_voucher_id TEXT, -- Journal voucher booking expense & liability
      processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (gl_voucher_id) REFERENCES vouchers(id)
    );

    -- =========================================================================
    -- 5. INDIAN STATUTORY COMPLIANCE: E-WAY BILL & E-INVOICE
    -- =========================================================================

    CREATE TABLE IF NOT EXISTS gst_e_invoices (
      id TEXT PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      irn_hash TEXT NOT NULL UNIQUE,
      ack_number TEXT NOT NULL,
      ack_date TEXT NOT NULL,
      signed_qr_code TEXT NOT NULL,
      signed_invoice_json TEXT NOT NULL,
      status TEXT DEFAULT 'ACT' CHECK(status IN ('ACT', 'CNL')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gst_e_way_bills (
      id TEXT PRIMARY KEY,
      voucher_id TEXT NOT NULL,
      eway_bill_number TEXT NOT NULL UNIQUE,
      eway_bill_date TEXT NOT NULL,
      valid_upto TEXT NOT NULL,
      transporter_id TEXT,
      transporter_name TEXT,
      vehicle_number TEXT,
      distance_km INTEGER,
      status TEXT DEFAULT 'ACT' CHECK(status IN ('ACT', 'CNL')),
      FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
    );

    -- Foreign Key Indexes for Commercial Tables
    CREATE INDEX IF NOT EXISTS idx_brs_vch ON bank_reconciliations(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_payroll_runs_vch ON payroll_runs(gl_voucher_id);
    CREATE INDEX IF NOT EXISTS idx_einvoice_vch ON gst_e_invoices(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_eway_vch ON gst_e_way_bills(voucher_id);
    CREATE INDEX IF NOT EXISTS idx_so_items_order ON sales_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id);
    CREATE INDEX IF NOT EXISTS idx_challan_items_challan ON delivery_challan_items(challan_id);
    CREATE INDEX IF NOT EXISTS idx_bom_raw_bom ON bom_raw_materials(bom_id);
  `);
}
