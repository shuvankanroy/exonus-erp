import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface CompanyFeaturesConfig {
  company_id: string;
  // Regional
  country: string;
  state_code: string;
  currency_symbol: string;
  currency_formal_name: string;
  currency_decimal_places: number;
  // Accounts
  bill_by_bill_tracking: boolean;
  credit_limits_enforce: boolean;
  multi_currency_enabled: boolean;
  interest_calculation: boolean;
  // Inventory
  multi_godown_enabled: boolean;
  batch_tracking_enabled: boolean;
  serial_tracking_enabled: boolean;
  mfg_expiry_tracking: boolean;
  valuation_method: 'FIFO' | 'WEIGHTED_AVG' | 'LAST_PRICE';
  qty_decimal_places: number;
  // GST / Statutory
  gst_enabled: boolean;
  gstin: string;
  composition_scheme: boolean;
  e_way_bill_enabled: boolean;
  e_invoice_enabled: boolean;
  // POS
  pos_billing_enabled: boolean;
  auto_round_off: boolean;
}

export function initConfigurationSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_features (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL UNIQUE,
      country TEXT DEFAULT 'India',
      state_code TEXT DEFAULT '07',
      currency_symbol TEXT DEFAULT '₹',
      currency_formal_name TEXT DEFAULT 'Indian Rupee',
      currency_decimal_places INTEGER DEFAULT 2,
      bill_by_bill_tracking INTEGER DEFAULT 1,
      credit_limits_enforce INTEGER DEFAULT 1,
      multi_currency_enabled INTEGER DEFAULT 0,
      interest_calculation INTEGER DEFAULT 0,
      multi_godown_enabled INTEGER DEFAULT 1,
      batch_tracking_enabled INTEGER DEFAULT 1,
      serial_tracking_enabled INTEGER DEFAULT 0,
      mfg_expiry_tracking INTEGER DEFAULT 0,
      valuation_method TEXT DEFAULT 'FIFO',
      qty_decimal_places INTEGER DEFAULT 2,
      gst_enabled INTEGER DEFAULT 1,
      gstin TEXT,
      composition_scheme INTEGER DEFAULT 0,
      e_way_bill_enabled INTEGER DEFAULT 1,
      e_invoice_enabled INTEGER DEFAULT 1,
      pos_billing_enabled INTEGER DEFAULT 1,
      auto_round_off INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS data_freezing_rules (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      freeze_type TEXT DEFAULT 'FULL', -- FULL or VOUCHER_TYPE
      voucher_type TEXT,
      freeze_up_to_date TEXT NOT NULL,
      reason TEXT,
      is_active INTEGER DEFAULT 1
    );
  `);
}

export function getCompanyFeatures(db: Database.Database, companyId: string): CompanyFeaturesConfig {
  initConfigurationSchema(db);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) as any;
  let features = db.prepare('SELECT * FROM company_features WHERE company_id = ?').get(companyId) as any;

  if (!features) {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO company_features (
        id, company_id, country, state_code, currency_symbol, currency_formal_name,
        currency_decimal_places, bill_by_bill_tracking, credit_limits_enforce,
        multi_godown_enabled, batch_tracking_enabled, valuation_method, qty_decimal_places,
        gst_enabled, gstin, e_way_bill_enabled, e_invoice_enabled, pos_billing_enabled, auto_round_off
      ) VALUES (?, ?, 'India', ?, '₹', 'Indian Rupee', 2, 1, 1, 1, 1, 'FIFO', 2, 1, ?, 1, 1, 1, 1)
    `).run(id, companyId, company?.state_code || '07', company?.gstin || '07AAAAA0000A1Z5');

    features = db.prepare('SELECT * FROM company_features WHERE id = ?').get(id) as any;
  }

  return {
    company_id: features.company_id,
    country: features.country,
    state_code: features.state_code,
    currency_symbol: features.currency_symbol,
    currency_formal_name: features.currency_formal_name,
    currency_decimal_places: features.currency_decimal_places,
    bill_by_bill_tracking: Boolean(features.bill_by_bill_tracking),
    credit_limits_enforce: Boolean(features.credit_limits_enforce),
    multi_currency_enabled: Boolean(features.multi_currency_enabled),
    interest_calculation: Boolean(features.interest_calculation),
    multi_godown_enabled: Boolean(features.multi_godown_enabled),
    batch_tracking_enabled: Boolean(features.batch_tracking_enabled),
    serial_tracking_enabled: Boolean(features.serial_tracking_enabled),
    mfg_expiry_tracking: Boolean(features.mfg_expiry_tracking),
    valuation_method: features.valuation_method,
    qty_decimal_places: features.qty_decimal_places,
    gst_enabled: Boolean(features.gst_enabled),
    gstin: features.gstin,
    composition_scheme: Boolean(features.composition_scheme),
    e_way_bill_enabled: Boolean(features.e_way_bill_enabled),
    e_invoice_enabled: Boolean(features.e_invoice_enabled),
    pos_billing_enabled: Boolean(features.pos_billing_enabled),
    auto_round_off: Boolean(features.auto_round_off)
  };
}

export function updateCompanyFeatures(db: Database.Database, input: CompanyFeaturesConfig) {
  initConfigurationSchema(db);
  db.prepare(`
    UPDATE company_features SET
      country = ?, state_code = ?, currency_symbol = ?, currency_formal_name = ?,
      currency_decimal_places = ?, bill_by_bill_tracking = ?, credit_limits_enforce = ?,
      multi_currency_enabled = ?, interest_calculation = ?, multi_godown_enabled = ?,
      batch_tracking_enabled = ?, serial_tracking_enabled = ?, mfg_expiry_tracking = ?,
      valuation_method = ?, qty_decimal_places = ?, gst_enabled = ?, gstin = ?,
      composition_scheme = ?, e_way_bill_enabled = ?, e_invoice_enabled = ?,
      pos_billing_enabled = ?, auto_round_off = ?, updated_at = CURRENT_TIMESTAMP
    WHERE company_id = ?
  `).run(
    input.country, input.state_code, input.currency_symbol, input.currency_formal_name,
    input.currency_decimal_places, input.bill_by_bill_tracking ? 1 : 0, input.credit_limits_enforce ? 1 : 0,
    input.multi_currency_enabled ? 1 : 0, input.interest_calculation ? 1 : 0, input.multi_godown_enabled ? 1 : 0,
    input.batch_tracking_enabled ? 1 : 0, input.serial_tracking_enabled ? 1 : 0, input.mfg_expiry_tracking ? 1 : 0,
    input.valuation_method, input.qty_decimal_places, input.gst_enabled ? 1 : 0, input.gstin,
    input.composition_scheme ? 1 : 0, input.e_way_bill_enabled ? 1 : 0, input.e_invoice_enabled ? 1 : 0,
    input.pos_billing_enabled ? 1 : 0, input.auto_round_off ? 1 : 0, input.company_id
  );

  return { success: true };
}

export function getVoucherSeriesList(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? 
    ORDER BY voucher_type ASC, series_name ASC
  `).all(companyId);
}

export function updateVoucherSeries(db: Database.Database, input: {
  id: string;
  series_name: string;
  prefix: string;
  suffix: string;
  current_number: number;
  auto_numbering: boolean;
  allow_zero_value: boolean;
  prompt_settlement: boolean;
}) {
  db.prepare(`
    UPDATE voucher_series SET
      series_name = ?, prefix = ?, suffix = ?, current_number = ?,
      auto_numbering = ?, allow_zero_value = ?, prompt_settlement = ?
    WHERE id = ?
  `).run(
    input.series_name, input.prefix, input.suffix, input.current_number,
    input.auto_numbering ? 1 : 0, input.allow_zero_value ? 1 : 0, input.prompt_settlement ? 1 : 0,
    input.id
  );

  return { success: true };
}

export function freezeDataUpToDate(db: Database.Database, input: {
  company_id: string;
  freeze_up_to_date: string;
  reason?: string;
}) {
  initConfigurationSchema(db);
  const id = randomUUID();
  db.prepare(`
    INSERT INTO data_freezing_rules (id, company_id, freeze_type, freeze_up_to_date, reason, is_active)
    VALUES (?, ?, 'FULL', ?, ?, 1)
  `).run(id, input.company_id, input.freeze_up_to_date, input.reason || 'Period Audit Locked');

  return { id, freezeDate: input.freeze_up_to_date };
}

export function getActiveFreezeDate(db: Database.Database, companyId: string): string | null {
  initConfigurationSchema(db);
  const rule = db.prepare(`
    SELECT freeze_up_to_date FROM data_freezing_rules 
    WHERE company_id = ? AND is_active = 1 
    ORDER BY freeze_up_to_date DESC LIMIT 1
  `).get(companyId) as any;

  return rule ? rule.freeze_up_to_date : null;
}
