import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface StockLedgerInput {
  company_id: string;
  voucher_id: string;
  voucher_type: string;
  voucher_number: string;
  posting_date: string; // YYYY-MM-DD
  posting_time?: string; // HH:mm:ss
  item_id: string;
  material_centre_id: string;
  batch_id?: string;
  actual_qty: number; // positive for inward, negative for outward
  incoming_rate?: number;
  outgoing_rate?: number;
}

export interface StockQueueLayer {
  qty: number;
  rate: number;
}

export class StockLedgerEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Post a Stock Ledger Entry (SLE) with strict FIFO / Moving Average valuation
   * and update real-time Bin cache.
   */
  public postEntry(entry: StockLedgerInput) {
    const postingTime = entry.posting_time || new Date().toTimeString().split(' ')[0];

    // 1. Fetch Company Stock Settings
    const settings = this.db.prepare(`
      SELECT * FROM stock_settings WHERE company_id = ?
    `).get(entry.company_id) as any;

    const valuationMethod = settings?.default_valuation_method || 'FIFO';
    const allowNegativeStock = !!settings?.allow_negative_stock;

    // 2. Fetch or create Bin for item + material_centre
    let bin = this.db.prepare(`
      SELECT * FROM bins WHERE company_id = ? AND item_id = ? AND material_centre_id = ?
    `).get(entry.company_id, entry.item_id, entry.material_centre_id) as any;

    if (!bin) {
      const binId = randomUUID();
      this.db.prepare(`
        INSERT INTO bins (id, company_id, item_id, material_centre_id, actual_qty, valuation_rate, stock_value)
        VALUES (?, ?, ?, ?, 0, 0, 0)
      `).run(binId, entry.company_id, entry.item_id, entry.material_centre_id);
      bin = { id: binId, actual_qty: 0, ordered_qty: 0, reserved_qty: 0, indented_qty: 0, planned_qty: 0, projected_qty: 0, valuation_rate: 0, stock_value: 0 };
    }

    // 3. Retrieve the previous SLE to get latest queue state
    const previousSle = this.db.prepare(`
      SELECT * FROM stock_ledger_entries
      WHERE item_id = ? AND material_centre_id = ? AND is_cancelled = 0
      ORDER BY posting_date DESC, posting_time DESC, created_at DESC
      LIMIT 1
    `).get(entry.item_id, entry.material_centre_id) as any;

    let prevQty = previousSle ? Number(previousSle.qty_after_transaction) : Number(bin.actual_qty);
    let prevValuationRate = previousSle ? Number(previousSle.valuation_rate) : Number(bin.valuation_rate);
    let prevStockValue = previousSle ? Number(previousSle.stock_value) : Number(bin.stock_value);
    let stockQueue: StockQueueLayer[] = previousSle?.stock_queue ? JSON.parse(previousSle.stock_queue) : [];

    const actualQty = Number(entry.actual_qty);
    const newQty = Math.round((prevQty + actualQty) * 1000) / 1000;

    // Check negative stock guard
    if (newQty < 0 && !allowNegativeStock) {
      const item = this.db.prepare('SELECT name FROM items WHERE id = ?').get(entry.item_id) as any;
      throw new Error(`Negative stock error: Item '${item?.name || entry.item_id}' would drop to ${newQty}. Current stock: ${prevQty}, requested: ${actualQty}`);
    }

    let valuationRate = prevValuationRate;
    let stockValue = prevStockValue;
    let stockValueDiff = 0;

    if (valuationMethod === 'FIFO') {
      // === FIFO QUEUE COMPUTATION (Same as ERPNext FIFOValuation) ===
      if (actualQty > 0) {
        // Inward: append layer
        const inRate = Number(entry.incoming_rate || 0);
        stockQueue.push({ qty: actualQty, rate: inRate });
        stockValueDiff = Math.round((actualQty * inRate) * 100) / 100;
        stockValue = Math.round((prevStockValue + stockValueDiff) * 100) / 100;
        valuationRate = newQty > 0 ? Math.round((stockValue / newQty) * 1000) / 1000 : inRate;
      } else {
        // Outward: pop from head of queue
        let remainingQtyToPop = Math.abs(actualQty);
        let consumedValue = 0;

        while (remainingQtyToPop > 0 && stockQueue.length > 0) {
          const headLayer = stockQueue[0];
          if (headLayer.qty <= remainingQtyToPop) {
            consumedValue += headLayer.qty * headLayer.rate;
            remainingQtyToPop = Math.round((remainingQtyToPop - headLayer.qty) * 1000) / 1000;
            stockQueue.shift(); // fully consumed
          } else {
            consumedValue += remainingQtyToPop * headLayer.rate;
            headLayer.qty = Math.round((headLayer.qty - remainingQtyToPop) * 1000) / 1000;
            remainingQtyToPop = 0;
          }
        }

        // If queue exhausted (or negative stock allowed)
        if (remainingQtyToPop > 0) {
          const fallbackRate = entry.outgoing_rate || prevValuationRate;
          consumedValue += remainingQtyToPop * fallbackRate;
        }

        stockValueDiff = -Math.round(consumedValue * 100) / 100;
        stockValue = Math.max(0, Math.round((prevStockValue + stockValueDiff) * 100) / 100);
        valuationRate = newQty > 0 ? Math.round((stockValue / newQty) * 1000) / 1000 : prevValuationRate;
      }
    } else {
      // === MOVING AVERAGE COMPUTATION (Same as ERPNext get_moving_average_values) ===
      if (actualQty > 0) {
        const inRate = Number(entry.incoming_rate || 0);
        if (prevQty <= 0) {
          valuationRate = inRate;
          stockValue = Math.round((actualQty * inRate) * 100) / 100;
          stockValueDiff = stockValue;
        } else {
          const newTotalValue = (prevQty * prevValuationRate) + (actualQty * inRate);
          valuationRate = Math.round((newTotalValue / newQty) * 1000) / 1000;
          stockValue = Math.round((newQty * valuationRate) * 100) / 100;
          stockValueDiff = Math.round((stockValue - prevStockValue) * 100) / 100;
        }
      } else {
        const outRate = entry.outgoing_rate || prevValuationRate;
        stockValueDiff = -Math.round((Math.abs(actualQty) * outRate) * 100) / 100;
        stockValue = Math.max(0, Math.round((prevStockValue + stockValueDiff) * 100) / 100);
        valuationRate = prevValuationRate;
      }
    }

    // 4. Insert Immutable Stock Ledger Entry
    const sleId = randomUUID();
    this.db.prepare(`
      INSERT INTO stock_ledger_entries (
        id, company_id, voucher_id, voucher_type, voucher_number, posting_date, posting_time,
        item_id, material_centre_id, batch_id, actual_qty, qty_after_transaction,
        incoming_rate, outgoing_rate, valuation_rate, stock_value, stock_value_difference, stock_queue
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sleId, entry.company_id, entry.voucher_id, entry.voucher_type, entry.voucher_number,
      entry.posting_date, postingTime, entry.item_id, entry.material_centre_id,
      entry.batch_id || null, actualQty, newQty,
      entry.incoming_rate || 0, entry.outgoing_rate || 0,
      valuationRate, stockValue, stockValueDiff, JSON.stringify(stockQueue)
    );

    // 5. Update Bin Cache (actual_qty and projected_qty)
    const projectedQty = (newQty + Number(bin.ordered_qty) + Number(bin.indented_qty) + Number(bin.planned_qty)) - Number(bin.reserved_qty);

    this.db.prepare(`
      UPDATE bins SET
        actual_qty = ?,
        valuation_rate = ?,
        stock_value = ?,
        projected_qty = ?
      WHERE company_id = ? AND item_id = ? AND material_centre_id = ?
    `).run(newQty, valuationRate, stockValue, projectedQty, entry.company_id, entry.item_id, entry.material_centre_id);

    return {
      sleId,
      actualQty,
      qtyAfterTransaction: newQty,
      valuationRate,
      stockValue,
      stockValueDifference: stockValueDiff
    };
  }

  /**
   * Get Bin live status for an item across all warehouses
   */
  public getBinStatus(company_id: string, item_id: string) {
    return this.db.prepare(`
      SELECT b.*, mc.name as warehouse_name
      FROM bins b
      JOIN material_centres mc ON b.material_centre_id = mc.id
      WHERE b.company_id = ? AND b.item_id = ?
    `).all(company_id, item_id);
  }

  /**
   * Get audit-grade Stock Ledger for reporting
   */
  public getStockLedger(company_id: string, filters: { item_id?: string; material_centre_id?: string; from_date?: string; to_date?: string }) {
    let query = `
      SELECT sle.*, i.name as item_name, mc.name as warehouse_name
      FROM stock_ledger_entries sle
      JOIN items i ON sle.item_id = i.id
      JOIN material_centres mc ON sle.material_centre_id = mc.id
      WHERE sle.company_id = ? AND sle.is_cancelled = 0
    `;
    const params: any[] = [company_id];

    if (filters.item_id) {
      query += ` AND sle.item_id = ?`;
      params.push(filters.item_id);
    }
    if (filters.material_centre_id) {
      query += ` AND sle.material_centre_id = ?`;
      params.push(filters.material_centre_id);
    }
    if (filters.from_date) {
      query += ` AND sle.posting_date >= ?`;
      params.push(filters.from_date);
    }
    if (filters.to_date) {
      query += ` AND sle.posting_date <= ?`;
      params.push(filters.to_date);
    }

    query += ` ORDER BY sle.posting_date ASC, sle.posting_time ASC, sle.created_at ASC`;
    return this.db.prepare(query).all(...params);
  }
}
