import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface PurchaseOrderInput {
  company_id: string;
  vendor_account_id: string; // Supplier
  material_centre_id: string; // Target Godown
  date: string; // YYYY-MM-DD
  expected_delivery_date?: string;
  narration?: string;
  items: Array<{
    item_id: string;
    ordered_qty: number;
    unit_id: string;
    rate: number;
  }>;
}

export interface GoodsReceiptNoteInput {
  company_id: string;
  vendor_account_id: string;
  material_centre_id: string;
  date: string;
  purchase_order_id?: string;
  vendor_delivery_doc?: string;
  narration?: string;
  items: Array<{
    item_id: string;
    batch_number?: string;
    mfg_date?: string;
    exp_date?: string;
    received_qty: number;
    unit_id: string;
    rate: number;
  }>;
}

/**
 * Creates a Purchase Order (PO) in Exonus ERP
 * Tracks procurement requirements and vendor backorders.
 */
export function createPurchaseOrder(db: Database.Database, input: PurchaseOrderInput) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(input.company_id) as any;
  if (!company) throw new Error('Company not found');

  const vendor = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.vendor_account_id) as any;
  if (!vendor) throw new Error('Vendor account not found');

  return db.transaction(() => {
    const poCount = db.prepare('SELECT COUNT(*) as count FROM purchase_orders WHERE company_id = ?').get(input.company_id) as any;
    const poNumber = `PO/${String(poCount.count + 1).padStart(4, '0')}`;
    const poId = randomUUID();

    let totalTaxable = 0;
    let totalTax = 0;
    const isInterState = vendor.state_code && vendor.state_code !== company.state_code;

    const processedLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      const taxable = Math.round(it.ordered_qty * it.rate * 100) / 100;
      let tax = 0;
      if (isInterState) {
        tax = Math.round(((taxable * itemRow.gst_rate) / 100) * 100) / 100;
      } else {
        tax = Math.round(((taxable * itemRow.gst_rate) / 100) * 100) / 100;
      }

      totalTaxable = Math.round((totalTaxable + taxable) * 100) / 100;
      totalTax = Math.round((totalTax + tax) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        ordered_qty: it.ordered_qty,
        pending_qty: it.ordered_qty,
        unit_id: it.unit_id,
        rate: it.rate,
        taxable_amount: taxable,
        gst_rate: itemRow.gst_rate,
        net_amount: Math.round((taxable + tax) * 100) / 100,
      };
    });

    const grossTotal = Math.round((totalTaxable + totalTax) * 100) / 100;

    // 1. Insert PO Header
    db.prepare(`
      INSERT INTO purchase_orders (
        id, company_id, po_number, date, vendor_account_id, material_centre_id, status, gross_total
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).run(
      poId, input.company_id, poNumber, input.date, input.vendor_account_id,
      input.material_centre_id, grossTotal
    );

    // 2. Insert PO Items
    const insertItem = db.prepare(`
      INSERT INTO purchase_order_items (
        id, po_id, item_id, ordered_qty, received_qty, pending_qty, unit_id, rate, taxable_amount, gst_rate, net_amount
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of processedLines) {
      insertItem.run(
        l.id, poId, l.item_id, l.ordered_qty, l.pending_qty,
        l.unit_id, l.rate, l.taxable_amount, l.gst_rate, l.net_amount
      );
    }

    // 3. Outbox Sync Queue for Cloud Relay
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'PURCHASE_ORDER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, poId,
      JSON.stringify({ poNumber, vendor: vendor.name, grossTotal, date: input.date })
    );

    return {
      poId,
      poNumber,
      grossTotal,
      itemCount: processedLines.length,
      status: 'OPEN'
    };
  })();
}

/**
 * Creates a Goods Receipt Note (GRN / Material Inward Challan)
 * Inwards physical stock into the warehouse and reconciles PO fulfillment backlogs.
 */
export function createGoodsReceiptNote(db: Database.Database, input: GoodsReceiptNoteInput) {
  return db.transaction(() => {
    const grnCount = db.prepare('SELECT COUNT(*) as count FROM goods_receipt_notes WHERE company_id = ?').get(input.company_id) as any;
    const grnNumber = `GRN/${String(grnCount.count + 1).padStart(4, '0')}`;
    const grnId = randomUUID();

    // 1. Insert GRN Header
    db.prepare(`
      INSERT INTO goods_receipt_notes (
        id, company_id, grn_number, date, vendor_account_id, purchase_order_id, material_centre_id, vendor_delivery_doc, status, narration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_BILL', ?)
    `).run(
      grnId, input.company_id, grnNumber, input.date, input.vendor_account_id,
      input.purchase_order_id || null, input.material_centre_id,
      input.vendor_delivery_doc || '', input.narration || ''
    );

    // 2. Insert GRN Items & Inward Perpetual Stock
    const insertGRNItem = db.prepare(`
      INSERT INTO grn_items (id, grn_id, item_id, batch_number, mfg_date, exp_date, received_qty, unit_id, rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStockIn = db.prepare(`
      INSERT INTO stock_entries (id, company_id, voucher_id, item_id, batch_id, material_centre_id, inward_qty, rate, entry_date)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of input.items) {
      // Create batch if batch number provided
      let batchId: string | null = null;
      if (it.batch_number) {
        const existingBatch = db.prepare('SELECT id FROM item_batches WHERE item_id = ? AND batch_number = ?').get(it.item_id, it.batch_number) as any;
        if (existingBatch) {
          batchId = existingBatch.id;
        } else {
          batchId = randomUUID();
          db.prepare(`
            INSERT INTO item_batches (id, item_id, batch_number, mfg_date, exp_date, cost_price)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(batchId, it.item_id, it.batch_number, it.mfg_date || null, it.exp_date || null, it.rate);
        }
      }

      insertGRNItem.run(
        randomUUID(), grnId, it.item_id, it.batch_number || null,
        it.mfg_date || null, it.exp_date || null, it.received_qty, it.unit_id, it.rate
      );

      // Inward physical stock into Godown
      insertStockIn.run(
        randomUUID(), input.company_id, it.item_id, batchId,
        input.material_centre_id, it.received_qty, it.rate, input.date
      );

      // If linked to PO, update backlog
      if (input.purchase_order_id) {
        db.prepare(`
          UPDATE purchase_order_items 
          SET received_qty = received_qty + ?, 
              pending_qty = MAX(0, pending_qty - ?)
          WHERE po_id = ? AND item_id = ?
        `).run(it.received_qty, it.received_qty, input.purchase_order_id, it.item_id);
      }
    }

    // Update PO status if all items received
    if (input.purchase_order_id) {
      const remainingPending = db.prepare(`
        SELECT SUM(pending_qty) as total_pending FROM purchase_order_items WHERE po_id = ?
      `).get(input.purchase_order_id) as any;

      const newStatus = (remainingPending.total_pending || 0) === 0 ? 'COMPLETED' : 'PARTIAL';
      db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(newStatus, input.purchase_order_id);
    }

    return {
      grnId,
      grnNumber,
      status: 'PENDING_BILL'
    };
  })();
}

/**
 * Retrieves Purchase Orders with pending items.
 */
export function getPurchaseOrders(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT 
      po.*,
      a.name as vendor_name,
      mc.name as godown_name
    FROM purchase_orders po
    JOIN accounts a ON po.vendor_account_id = a.id
    JOIN material_centres mc ON po.material_centre_id = mc.id
    WHERE po.company_id = ?
    ORDER BY po.date DESC, po.created_at DESC
  `).all(companyId);
}

/**
 * Retrieves unbilled Goods Receipt Notes (GRNs).
 */
export function getGoodsReceiptNotes(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT 
      grn.*,
      a.name as vendor_name,
      mc.name as godown_name
    FROM goods_receipt_notes grn
    JOIN accounts a ON grn.vendor_account_id = a.id
    JOIN material_centres mc ON grn.material_centre_id = mc.id
    WHERE grn.company_id = ?
    ORDER BY grn.date DESC, grn.created_at DESC
  `).all(companyId);
}
