import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface ProductionVoucherInput {
  company_id: string;
  bom_id: string;
  date: string; // YYYY-MM-DD
  batches_to_produce: number; // e.g. 10 batches
  narration?: string;
}

export function executeProductionRun(db: Database.Database, input: ProductionVoucherInput) {
  const bom = db.prepare('SELECT * FROM bill_of_materials WHERE id = ?').get(input.bom_id) as any;
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
      const lineCost = consumedQty * (item.standard_purchase_rate || 100);
      totalRawCost += lineCost;

      // Deduct raw material stock
      db.prepare(`
        INSERT INTO stock_entries (
          id, company_id, voucher_id, item_id, material_centre_id, outward_qty, rate, entry_date
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), input.company_id, rm.raw_item_id,
        rm.source_godown_id, consumedQty, item.standard_purchase_rate || 100, input.date
      );
    }

    // 2. Add Overhead / Manufacturing Expenses
    const overheadCost = (bom.additional_cost_per_batch || 0) * input.batches_to_produce;
    const totalProductionCost = totalRawCost + overheadCost;
    const totalFinishedUnits = bom.output_qty * input.batches_to_produce;
    const unitCost = totalProductionCost / totalFinishedUnits;

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
