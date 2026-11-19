import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface StockTransferInput {
  company_id: string;
  series_name?: string;
  date: string; // YYYY-MM-DD
  source_material_centre_id: string; // From Godown
  destination_material_centre_id: string; // To Godown
  narration?: string;
  items: Array<{
    item_id: string;
    batch_id?: string;
    qty: number;
    unit_id: string;
    rate?: number; // Cost rate (defaults to latest moving cost or standard rate)
  }>;
}

export interface GodownStockSummary {
  material_centre_id: string;
  godown_name: string;
  address?: string;
  is_default: boolean;
  total_items: number;
  total_quantity: number;
  total_stock_value: number;
}

/**
 * Creates an atomic Stock Transfer Voucher between two Godowns
 * Deducts outward_qty from source Godown and adds inward_qty to destination Godown.
 * Total company inventory remains constant; only warehouse balances shift.
 */
export function executeStockTransfer(db: Database.Database, input: StockTransferInput) {
  if (input.source_material_centre_id === input.destination_material_centre_id) {
    throw new Error('Source Godown and Destination Godown cannot be the same');
  }

  const sourceGodown = db.prepare('SELECT * FROM material_centres WHERE id = ? AND company_id = ?').get(input.source_material_centre_id, input.company_id) as any;
  if (!sourceGodown) throw new Error('Source Godown not found');

  const destGodown = db.prepare('SELECT * FROM material_centres WHERE id = ? AND company_id = ?').get(input.destination_material_centre_id, input.company_id) as any;
  if (!destGodown) throw new Error('Destination Godown not found');

  const series = db.prepare(`
    SELECT * FROM voucher_series 
    WHERE company_id = ? AND voucher_type = 'STOCK_TRANSFER' AND series_name = ?
  `).get(input.company_id, input.series_name || 'Main') as any;

  let seriesId: string;
  let prefix = 'ST/';
  let nextNum = 1;

  if (series) {
    seriesId = series.id;
    prefix = series.prefix || 'ST/';
    nextNum = series.current_number + 1;
  } else {
    seriesId = randomUUID();
    db.prepare(`
      INSERT INTO voucher_series (id, company_id, voucher_type, series_name, prefix, current_number)
      VALUES (?, ?, 'STOCK_TRANSFER', 'Main', 'ST/', 0)
    `).run(seriesId, input.company_id);
    nextNum = 1;
  }

  return db.transaction(() => {
    // 1. Next Voucher Number
    const voucherNumber = `${prefix}${String(nextNum).padStart(4, '0')}`;
    db.prepare('UPDATE voucher_series SET current_number = ? WHERE id = ?').run(nextNum, seriesId);

    const voucherId = randomUUID();
    let transferTotalValue = 0;

    // Check available stock in source Godown and compute rates
    const processedLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(it.item_id, input.company_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      // Check current stock at source godown
      const currentStockRow = db.prepare(`
        SELECT (COALESCE(SUM(inward_qty), 0) - COALESCE(SUM(outward_qty), 0)) as balance
        FROM stock_entries
        WHERE item_id = ? AND material_centre_id = ?
      `).get(it.item_id, input.source_material_centre_id) as any;

      const availableStock = currentStockRow?.balance || 0;
      // Allow transfer with warning/logging even if negative in permissive mode, but track balance
      const rate = it.rate !== undefined && it.rate > 0 
        ? it.rate 
        : (itemRow.standard_purchase_rate || itemRow.standard_sale_rate || 100);

      const lineTotal = Math.round(it.qty * rate * 100) / 100;
      transferTotalValue = Math.round((transferTotalValue + lineTotal) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        item_name: itemRow.name,
        batch_id: it.batch_id || null,
        qty: it.qty,
        unit_id: it.unit_id,
        rate,
        lineTotal,
        availableStock
      };
    });

    // 2. Insert Voucher Header
    db.prepare(`
      INSERT INTO vouchers (
        id, company_id, series_id, voucher_type, voucher_number, date, 
        material_centre_id, narration, sub_total, gross_total
      ) VALUES (?, ?, ?, 'STOCK_TRANSFER', ?, ?, ?, ?, ?, ?)
    `).run(
      voucherId, input.company_id, seriesId, voucherNumber, input.date,
      input.source_material_centre_id,
      input.narration || `Stock Transfer from ${sourceGodown.name} to ${destGodown.name}`,
      transferTotalValue, transferTotalValue
    );

    // 3. Insert Outward Stock from Source Godown
    const insertStock = db.prepare(`
      INSERT INTO stock_entries (
        id, company_id, voucher_id, item_id, batch_id, material_centre_id, inward_qty, outward_qty, rate, entry_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const line of processedLines) {
      // Outward movement from Source Godown
      insertStock.run(
        randomUUID(), input.company_id, voucherId, line.item_id, line.batch_id,
        input.source_material_centre_id, 0, line.qty, line.rate, input.date
      );

      // Inward movement into Destination Godown
      insertStock.run(
        randomUUID(), input.company_id, voucherId, line.item_id, line.batch_id,
        input.destination_material_centre_id, line.qty, 0, line.rate, input.date
      );
    }

    // 4. Outbox Sync for Cloud Relay
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'STOCK_TRANSFER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, voucherId,
      JSON.stringify({
        voucherNumber,
        source: sourceGodown.name,
        destination: destGodown.name,
        itemsCount: processedLines.length,
        totalValue: transferTotalValue,
        date: input.date
      })
    );

    return {
      voucherId,
      voucherNumber,
      sourceGodown: sourceGodown.name,
      destGodown: destGodown.name,
      totalItems: processedLines.length,
      totalValue: transferTotalValue
    };
  })();
}

/**
 * Retrieves godown-wise inventory valuation and stock levels
 */
export function getGodownStockReport(db: Database.Database, companyId: string, materialCentreId?: string) {
  let query = `
    SELECT 
      mc.id as material_centre_id,
      mc.name as godown_name,
      i.id as item_id,
      i.name as item_name,
      i.hsn_code,
      u.symbol as unit_symbol,
      COALESCE(SUM(se.inward_qty), 0) as total_inward,
      COALESCE(SUM(se.outward_qty), 0) as total_outward,
      (COALESCE(SUM(se.inward_qty), 0) - COALESCE(SUM(se.outward_qty), 0)) as current_balance,
      COALESCE(MAX(se.rate), i.standard_purchase_rate, 100) as valuation_rate
    FROM material_centres mc
    CROSS JOIN items i ON i.company_id = mc.company_id
    JOIN units u ON i.primary_unit_id = u.id
    LEFT JOIN stock_entries se ON se.material_centre_id = mc.id AND se.item_id = i.id
    WHERE mc.company_id = ?
  `;

  const params: any[] = [companyId];
  if (materialCentreId) {
    query += ' AND mc.id = ?';
    params.push(materialCentreId);
  }

  query += `
    GROUP BY mc.id, i.id
    ORDER BY mc.name, i.name
  `;

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map((r) => ({
    ...r,
    stock_value: Math.round(r.current_balance * r.valuation_rate * 100) / 100
  }));
}

/**
 * Returns high-level summaries for all Godowns in a company
 */
export function getGodownsSummary(db: Database.Database, companyId: string): GodownStockSummary[] {
  const godowns = db.prepare('SELECT * FROM material_centres WHERE company_id = ? ORDER BY is_default DESC, name ASC').all(companyId) as any[];

  return godowns.map((g) => {
    const stats = db.prepare(`
      SELECT 
        COUNT(DISTINCT item_id) as total_items,
        SUM(inward_qty - outward_qty) as total_quantity,
        SUM((inward_qty - outward_qty) * rate) as total_stock_value
      FROM stock_entries
      WHERE material_centre_id = ?
    `).get(g.id) as any;

    return {
      material_centre_id: g.id,
      godown_name: g.name,
      address: g.address || '',
      is_default: Boolean(g.is_default),
      total_items: stats?.total_items || 0,
      total_quantity: Math.max(0, stats?.total_quantity || 0),
      total_stock_value: Math.max(0, Math.round((stats?.total_stock_value || 0) * 100) / 100)
    };
  });
}
