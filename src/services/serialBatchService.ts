import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface BatchInput {
  company_id: string;
  item_id: string;
  batch_number: string;
  mfg_date?: string; // YYYY-MM-DD
  exp_date?: string; // YYYY-MM-DD
  mrp?: number;
  sale_rate?: number;
  cost_price?: number;
}

export interface SerialNumberInput {
  company_id: string;
  item_id: string;
  serial_no: string;
  batch_id?: string;
  material_centre_id?: string;
  purchase_rate?: number;
  purchase_voucher_id?: string;
  warranty_expiry_date?: string;
}

export class SerialBatchService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // --- BATCH MANAGEMENT ---

  public createBatch(input: BatchInput) {
    const existing = this.db.prepare(`
      SELECT * FROM item_batches WHERE item_id = ? AND batch_number = ?
    `).get(input.item_id, input.batch_number) as any;

    if (existing) {
      throw new Error(`Batch '${input.batch_number}' already exists for this item.`);
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO item_batches (
        id, company_id, item_id, batch_number, mfg_date, exp_date, mrp, sale_rate, cost_price, disabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id, input.company_id, input.item_id, input.batch_number,
      input.mfg_date || null, input.exp_date || null,
      input.mrp || 0, input.sale_rate || 0, input.cost_price || 0
    );

    return { id, batch_number: input.batch_number };
  }

  public getBatchesForItem(itemId: string, activeOnly: boolean = true) {
    let query = `SELECT * FROM item_batches WHERE item_id = ?`;
    if (activeOnly) {
      query += ` AND disabled = 0`;
    }
    query += ` ORDER BY exp_date ASC, created_at DESC`;
    return this.db.prepare(query).all(itemId);
  }

  public validateBatchUsable(batchId: string, transactionDate: string) {
    const batch = this.db.prepare(`SELECT * FROM item_batches WHERE id = ?`).get(batchId) as any;
    if (!batch) throw new Error(`Batch ID '${batchId}' not found.`);
    if (batch.disabled) throw new Error(`Batch '${batch.batch_number}' is disabled.`);
    if (batch.exp_date && batch.exp_date < transactionDate) {
      throw new Error(`Batch '${batch.batch_number}' expired on ${batch.exp_date}. Cannot dispatch expired stock.`);
    }
    return batch;
  }

  // --- SERIAL NUMBER MANAGEMENT ---

  public registerSerialNumbers(inputs: SerialNumberInput[]) {
    const insertStmt = this.db.prepare(`
      INSERT INTO serial_numbers (
        id, company_id, item_id, batch_id, serial_no, material_centre_id, status, purchase_rate, purchase_voucher_id, warranty_expiry_date
      ) VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?)
    `);

    const registered: string[] = [];

    const tx = this.db.transaction(() => {
      for (const sn of inputs) {
        const cleanSn = sn.serial_no.trim();
        const existing = this.db.prepare(`
          SELECT * FROM serial_numbers WHERE company_id = ? AND serial_no = ?
        `).get(sn.company_id, cleanSn) as any;

        if (existing) {
          throw new Error(`Serial Number '${cleanSn}' is already registered in the system.`);
        }

        const id = randomUUID();
        insertStmt.run(
          id, sn.company_id, sn.item_id, sn.batch_id || null, cleanSn,
          sn.material_centre_id || null, sn.purchase_rate || 0,
          sn.purchase_voucher_id || null, sn.warranty_expiry_date || null
        );
        registered.push(cleanSn);
      }
    });

    tx();
    return registered;
  }

  public getAvailableSerials(itemId: string, materialCentreId?: string) {
    let query = `
      SELECT sn.*, mc.name as warehouse_name, b.batch_number
      FROM serial_numbers sn
      LEFT JOIN material_centres mc ON sn.material_centre_id = mc.id
      LEFT JOIN item_batches b ON sn.batch_id = b.id
      WHERE sn.item_id = ? AND sn.status = 'Active'
    `;
    const params: any[] = [itemId];
    if (materialCentreId) {
      query += ` AND sn.material_centre_id = ?`;
      params.push(materialCentreId);
    }
    query += ` ORDER BY sn.created_at ASC`;
    return this.db.prepare(query).all(...params);
  }

  public markSerialsDelivered(serialNos: string[], deliveryVoucherId: string) {
    const updateStmt = this.db.prepare(`
      UPDATE serial_numbers
      SET status = 'Delivered', delivery_voucher_id = ?
      WHERE serial_no = ? AND status = 'Active'
    `);

    const tx = this.db.transaction(() => {
      for (const sn of serialNos) {
        const cleanSn = sn.trim();
        const res = updateStmt.run(deliveryVoucherId, cleanSn);
        if (res.changes === 0) {
          throw new Error(`Serial No '${cleanSn}' is not Active or already delivered.`);
        }
      }
    });

    tx();
  }

  // --- INVENTORY DIMENSIONS (Rack, Shelf, Bin, Bay) ---

  public createDimension(companyId: string, dimensionName: string, isMandatory: boolean = false) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO inventory_dimensions (id, company_id, dimension_name, is_mandatory)
      VALUES (?, ?, ?, ?)
    `).run(id, companyId, dimensionName.trim(), isMandatory ? 1 : 0);
    return { id, dimension_name: dimensionName };
  }

  public getDimensions(companyId: string) {
    return this.db.prepare(`
      SELECT * FROM inventory_dimensions WHERE company_id = ? ORDER BY dimension_name ASC
    `).all(companyId);
  }

  public addDimensionValue(companyId: string, dimensionId: string, dimensionValue: string, materialCentreId?: string) {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO inventory_dimension_values (id, company_id, dimension_id, dimension_value, material_centre_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, companyId, dimensionId, dimensionValue.trim(), materialCentreId || null);
    return { id, dimension_value: dimensionValue };
  }

  public getDimensionValues(companyId: string, dimensionId?: string) {
    let query = `
      SELECT v.*, d.dimension_name, mc.name as warehouse_name
      FROM inventory_dimension_values v
      JOIN inventory_dimensions d ON v.dimension_id = d.id
      LEFT JOIN material_centres mc ON v.material_centre_id = mc.id
      WHERE v.company_id = ?
    `;
    const params: any[] = [companyId];
    if (dimensionId) {
      query += ` AND v.dimension_id = ?`;
      params.push(dimensionId);
    }
    query += ` ORDER BY d.dimension_name ASC, v.dimension_value ASC`;
    return this.db.prepare(query).all(...params);
  }
}
