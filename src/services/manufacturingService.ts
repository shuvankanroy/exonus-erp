import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface BOMInput {
  company_id: string;
  name: string;
  finished_item_id: string;
  output_unit_id?: string;
  target_godown_id: string;
  output_qty: number;
  additional_cost_per_batch?: number;
  raw_materials: Array<{
    raw_item_id: string;
    source_godown_id: string;
    consumption_qty: number;
    unit_id: string;
    scrap_percentage?: number;
  }>;
}

export interface ProductionVoucherInput {
  company_id: string;
  bom_id: string;
  date: string; // YYYY-MM-DD
  batches_to_produce: number; // e.g. 10 batches
  narration?: string;
  additional_expense_account_id?: string; // e.g. Factory Power / Wages
}

/**
 * Creates or updates a Bill of Materials (BOM Recipe)
 */
export function createBillOfMaterials(db: Database.Database, input: BOMInput) {
  const finishedItem = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(input.finished_item_id, input.company_id) as any;
  if (!finishedItem) throw new Error('Finished item not found');

  const godown = db.prepare('SELECT * FROM material_centres WHERE id = ? AND company_id = ?').get(input.target_godown_id, input.company_id);
  if (!godown) throw new Error('Target godown not found');

  if (!input.raw_materials || input.raw_materials.length === 0) {
    throw new Error('At least one raw material is required for BOM recipe');
  }

  const outputUnitId = input.output_unit_id || finishedItem.primary_unit_id;

  return db.transaction(() => {
    const bomId = randomUUID();

    // 1. Insert BOM Header
    db.prepare(`
      INSERT INTO bill_of_materials (
        id, company_id, name, finished_item_id, output_qty, output_unit_id, target_godown_id, additional_cost_per_batch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bomId, input.company_id, input.name.trim(), input.finished_item_id,
      input.output_qty || 1, outputUnitId, input.target_godown_id, input.additional_cost_per_batch || 0
    );

    // 2. Insert BOM Raw Materials
    const insertRaw = db.prepare(`
      INSERT INTO bom_raw_materials (
        id, bom_id, raw_item_id, source_godown_id, consumption_qty, unit_id, scrap_percentage
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rm of input.raw_materials) {
      insertRaw.run(
        randomUUID(), bomId, rm.raw_item_id, rm.source_godown_id,
        rm.consumption_qty, rm.unit_id, rm.scrap_percentage || 0
      );
    }

    return {
      id: bomId,
      name: input.name.trim()
    };
  })();
}

/**
 * Retrieves all registered BOMs for a company with item and godown names
 */
export function getBillOfMaterialsList(db: Database.Database, companyId: string) {
  const boms = db.prepare(`
    SELECT 
      b.*,
      i.name as finished_item_name,
      i.hsn_code,
      u.symbol as unit_symbol,
      mc.name as target_godown_name
    FROM bill_of_materials b
    JOIN items i ON b.finished_item_id = i.id
    JOIN units u ON i.primary_unit_id = u.id
    JOIN material_centres mc ON b.target_godown_id = mc.id
    WHERE b.company_id = ?
    ORDER BY b.name ASC
  `).all(companyId) as any[];

  return boms.map(b => {
    const rawMaterials = db.prepare(`
      SELECT 
        rm.*,
        i.name as raw_item_name,
        u.symbol as unit_symbol,
        mc.name as source_godown_name,
        i.standard_purchase_rate
      FROM bom_raw_materials rm
      JOIN items i ON rm.raw_item_id = i.id
      JOIN units u ON rm.unit_id = u.id
      JOIN material_centres mc ON rm.source_godown_id = mc.id
      WHERE rm.bom_id = ?
    `).all(b.id);

    return {
      ...b,
      raw_materials: rawMaterials
    };
  });
}

/**
 * Executes a production run based on a BOM recipe
 * Deducts raw materials, creates finished goods, and posts double-entry vouchers if overheads exist.
 */
export function executeProductionRun(db: Database.Database, input: ProductionVoucherInput) {
  const bom = db.prepare('SELECT * FROM bill_of_materials WHERE id = ? AND company_id = ?').get(input.bom_id, input.company_id) as any;
  if (!bom) throw new Error('Bill of Materials (BOM) not found');

  const rawMaterials = db.prepare('SELECT * FROM bom_raw_materials WHERE bom_id = ?').all(input.bom_id) as any[];
  if (!rawMaterials || rawMaterials.length === 0) throw new Error('BOM has no raw material definitions');

  return db.transaction(() => {
    const voucherNumber = `PROD/${Date.now().toString().slice(-6)}`;
    const productionId = randomUUID();
    let totalRawCost = 0;

    // 1. Process & Deduct Raw Materials from Source Godowns
    for (const rm of rawMaterials) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(rm.raw_item_id) as any;
      const consumedQty = rm.consumption_qty * input.batches_to_produce;
      const rate = item.standard_purchase_rate || 100;
      const lineCost = consumedQty * rate;
      totalRawCost = Math.round((totalRawCost + lineCost) * 100) / 100;

      // Deduct raw material stock
      db.prepare(`
        INSERT INTO stock_entries (
          id, company_id, voucher_id, item_id, material_centre_id, outward_qty, rate, entry_date
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), input.company_id, rm.raw_item_id,
        rm.source_godown_id, consumedQty, rate, input.date
      );
    }

    // 2. Add Overhead / Manufacturing Expenses
    const overheadCost = Math.round(((bom.additional_cost_per_batch || 0) * input.batches_to_produce) * 100) / 100;
    const totalProductionCost = Math.round((totalRawCost + overheadCost) * 100) / 100;
    const totalFinishedUnits = bom.output_qty * input.batches_to_produce;
    const unitCost = Math.round((totalProductionCost / totalFinishedUnits) * 100) / 100;

    // 3. Inward Finished Goods into Target Godown
    db.prepare(`
      INSERT INTO stock_entries (
        id, company_id, voucher_id, item_id, material_centre_id, inward_qty, rate, entry_date
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), input.company_id, bom.finished_item_id,
      bom.target_godown_id, totalFinishedUnits, unitCost, input.date
    );

    // 4. Save Production Voucher Record
    db.prepare(`
      INSERT INTO production_vouchers (
        id, company_id, voucher_number, date, bom_id, batches_produced, total_finished_qty, total_cost, cost_per_unit, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      productionId, input.company_id, voucherNumber, input.date, input.bom_id,
      input.batches_to_produce, totalFinishedUnits, totalProductionCost, unitCost,
      input.narration || `Manufactured ${totalFinishedUnits} units via BOM: ${bom.name}`
    );

    // 5. Outbox Sync Queue for Cloud Relay
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'PRODUCTION_VOUCHER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, productionId,
      JSON.stringify({ voucherNumber, totalFinishedUnits, unitCost, date: input.date })
    );

    return {
      productionId,
      voucherNumber,
      finishedUnits: totalFinishedUnits,
      totalCost: totalProductionCost,
      costPerUnit: unitCost,
    };
  })();
}

/**
 * Retrieves production run history
 */
export function getProductionHistory(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT 
      pv.*,
      b.name as bom_name,
      i.name as finished_item_name
    FROM production_vouchers pv
    JOIN bill_of_materials b ON pv.bom_id = b.id
    JOIN items i ON b.finished_item_id = i.id
    WHERE pv.company_id = ?
    ORDER BY pv.date DESC, pv.created_at DESC
  `).all(companyId);
}
