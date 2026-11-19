import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface SalesQuotationInput {
  company_id: string;
  party_account_id: string;
  date: string;
  valid_until?: string;
  narration?: string;
  items: Array<{
    item_id: string;
    qty: number;
    unit_id: string;
    rate: number;
    discount_pct?: number;
  }>;
}

export function createSalesQuotation(db: Database.Database, input: SalesQuotationInput) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(input.company_id) as any;
  if (!company) throw new Error('Company not found');

  const party = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.party_account_id) as any;
  if (!party) throw new Error('Customer account not found');

  return db.transaction(() => {
    const quoteCount = db.prepare('SELECT COUNT(*) as count FROM sales_quotations WHERE company_id = ?').get(input.company_id) as any;
    const quotationNumber = `SQ/${String(quoteCount.count + 1).padStart(4, '0')}`;
    const quotationId = randomUUID();

    let totalTaxable = 0;
    let totalTax = 0;
    const isInterState = party.state_code && party.state_code !== company.state_code;

    const processedLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      const disc = it.discount_pct || 0;
      const base = it.qty * it.rate;
      const discountAmount = Math.round(((base * disc) / 100) * 100) / 100;
      const taxable = Math.round((base - discountAmount) * 100) / 100;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (isInterState) {
        igst = Math.round(((taxable * itemRow.gst_rate) / 100) * 100) / 100;
      } else {
        cgst = Math.round(((taxable * (itemRow.gst_rate / 2)) / 100) * 100) / 100;
        sgst = Math.round(((taxable * (itemRow.gst_rate / 2)) / 100) * 100) / 100;
      }

      totalTaxable = Math.round((totalTaxable + taxable) * 100) / 100;
      totalTax = Math.round((totalTax + cgst + sgst + igst) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        qty: it.qty,
        unit_id: it.unit_id,
        rate: it.rate,
        discount_pct: disc,
        taxable_amount: taxable,
        gst_rate: itemRow.gst_rate,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        net_amount: Math.round((taxable + cgst + sgst + igst) * 100) / 100,
      };
    });

    const grossTotal = Math.round((totalTaxable + totalTax) * 100) / 100;

    db.prepare(`
      INSERT INTO sales_quotations (
        id, company_id, quotation_number, date, valid_until, party_account_id, status, narration, sub_total, tax_total, gross_total
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
    `).run(
      quotationId, input.company_id, quotationNumber, input.date,
      input.valid_until || null, input.party_account_id, input.narration || '',
      totalTaxable, totalTax, grossTotal
    );

    const insertLine = db.prepare(`
      INSERT INTO sales_quotation_items (
        id, quotation_id, item_id, qty, unit_id, rate, discount_pct, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, net_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of processedLines) {
      insertLine.run(
        l.id, quotationId, l.item_id, l.qty, l.unit_id, l.rate, l.discount_pct,
        l.taxable_amount, l.gst_rate, l.cgst_amount, l.sgst_amount, l.igst_amount, l.net_amount
      );
    }

    return {
      quotationId,
      quotationNumber,
      grossTotal,
      itemCount: processedLines.length
    };
  })();
}

export function getSalesQuotations(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT sq.*, a.name as party_name 
    FROM sales_quotations sq
    JOIN accounts a ON sq.party_account_id = a.id
    WHERE sq.company_id = ?
    ORDER BY sq.date DESC, sq.created_at DESC
  `).all(companyId);
}

export interface SalesOrderInput {
  company_id: string;
  party_account_id: string; // Customer
  material_centre_id: string; // Default Warehouse
  date: string; // YYYY-MM-DD
  expected_delivery_date?: string;
  customer_po_number?: string;
  customer_po_date?: string;
  narration?: string;
  items: Array<{
    item_id: string;
    ordered_qty: number;
    unit_id: string;
    rate: number;
    discount_pct?: number;
  }>;
}

export function convertQuotationToOrder(db: Database.Database, quotationId: string, materialCentreId: string) {
  const quote = db.prepare('SELECT * FROM sales_quotations WHERE id = ?').get(quotationId) as any;
  if (!quote) throw new Error('Quotation not found');

  const quoteItems = db.prepare('SELECT * FROM sales_quotation_items WHERE quotation_id = ?').all(quotationId) as any[];

  return db.transaction(() => {
    const orderResult = createSalesOrder(db, {
      company_id: quote.company_id,
      party_account_id: quote.party_account_id,
      material_centre_id: materialCentreId,
      date: new Date().toISOString().split('T')[0],
      narration: `Converted from Quotation: ${quote.quotation_number}`,
      items: quoteItems.map(qi => ({
        item_id: qi.item_id,
        ordered_qty: qi.qty,
        unit_id: qi.unit_id,
        rate: qi.rate,
        discount_pct: qi.discount_pct
      }))
    });

    db.prepare("UPDATE sales_quotations SET status = 'ACCEPTED' WHERE id = ?").run(quotationId);

    return orderResult;
  })();
}

export interface DeliveryChallanInput {
  company_id: string;
  party_account_id: string;
  material_centre_id: string;
  date: string;
  sales_order_id?: string;
  transporter_name?: string;
  vehicle_number?: string;
  lr_number?: string;
  narration?: string;
  items: Array<{
    item_id: string;
    batch_id?: string;
    dispatched_qty: number;
    unit_id: string;
    rate: number;
  }>;
}

/**
 * Creates a Sales Order in Exonus ERP (BUSY Commercial Lifecycle)
 * Enforces atomic transaction and initializes pending delivery backlogs.
 */
export function createSalesOrder(db: Database.Database, input: SalesOrderInput) {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(input.company_id) as any;
  if (!company) throw new Error('Company not found');

  const party = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.party_account_id) as any;
  if (!party) throw new Error('Customer account not found');

  return db.transaction(() => {
    // Generate sequential order number
    const orderCount = db.prepare('SELECT COUNT(*) as count FROM sales_orders WHERE company_id = ?').get(input.company_id) as any;
    const orderNumber = `SO/${String(orderCount.count + 1).padStart(4, '0')}`;
    const orderId = randomUUID();

    let totalTaxable = 0;
    let totalTax = 0;

    const isInterState = party.state_code && party.state_code !== company.state_code;

    const processedLines = input.items.map((it) => {
      const itemRow = db.prepare('SELECT * FROM items WHERE id = ?').get(it.item_id) as any;
      if (!itemRow) throw new Error(`Item ${it.item_id} not found`);

      const disc = it.discount_pct || 0;
      const base = it.ordered_qty * it.rate;
      const discountAmount = Math.round(((base * disc) / 100) * 100) / 100;
      const taxable = Math.round((base - discountAmount) * 100) / 100;

      let cgst = 0;
      let sgst = 0;
      let igst = 0;

      if (isInterState) {
        igst = Math.round(((taxable * itemRow.gst_rate) / 100) * 100) / 100;
      } else {
        cgst = Math.round(((taxable * (itemRow.gst_rate / 2)) / 100) * 100) / 100;
        sgst = Math.round(((taxable * (itemRow.gst_rate / 2)) / 100) * 100) / 100;
      }

      totalTaxable = Math.round((totalTaxable + taxable) * 100) / 100;
      totalTax = Math.round((totalTax + cgst + sgst + igst) * 100) / 100;

      return {
        id: randomUUID(),
        item_id: it.item_id,
        ordered_qty: it.ordered_qty,
        pending_qty: it.ordered_qty,
        unit_id: it.unit_id,
        rate: it.rate,
        discount_pct: disc,
        taxable_amount: taxable,
        gst_rate: itemRow.gst_rate,
        cgst_amount: cgst,
        sgst_amount: sgst,
        igst_amount: igst,
        net_amount: Math.round((taxable + cgst + sgst + igst) * 100) / 100,
      };
    });

    const grossTotal = Math.round((totalTaxable + totalTax) * 100) / 100;

    // 1. Insert Sales Order Header
    db.prepare(`
      INSERT INTO sales_orders (
        id, company_id, order_number, date, party_account_id, material_centre_id, status, narration, sub_total, tax_total, gross_total
      ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
    `).run(
      orderId, input.company_id, orderNumber, input.date, input.party_account_id,
      input.material_centre_id, input.narration || '', totalTaxable, totalTax, grossTotal
    );

    // 2. Insert Line Items
    const insertItem = db.prepare(`
      INSERT INTO sales_order_items (
        id, order_id, item_id, ordered_qty, delivered_qty, pending_qty, unit_id, rate, discount_pct, taxable_amount, gst_rate, cgst_amount, sgst_amount, igst_amount, net_amount
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of processedLines) {
      insertItem.run(
        l.id, orderId, l.item_id, l.ordered_qty, l.pending_qty,
        l.unit_id, l.rate, l.discount_pct, l.taxable_amount,
        l.gst_rate, l.cgst_amount, l.sgst_amount, l.igst_amount, l.net_amount
      );
    }

    // 3. Outbox Sync for Silver Cloud & Gold Cloud
    db.prepare(`
      INSERT INTO sync_outbox (id, company_id, entity_type, entity_id, action, payload)
      VALUES (?, ?, 'SALES_ORDER', ?, 'CREATE', ?)
    `).run(
      randomUUID(), input.company_id, orderId,
      JSON.stringify({ orderNumber, party: party.name, grossTotal, date: input.date })
    );

    return {
      orderId,
      orderNumber,
      grossTotal,
      itemCount: processedLines.length,
      status: 'OPEN'
    };
  })();
}

/**
 * Creates a Delivery Challan (Material Out)
 * Deducts perpetual stock from the warehouse and updates the originating Sales Order fulfillment backlog.
 */
export function createDeliveryChallan(db: Database.Database, input: DeliveryChallanInput) {
  return db.transaction(() => {
    const challanCount = db.prepare('SELECT COUNT(*) as count FROM delivery_challans WHERE company_id = ?').get(input.company_id) as any;
    const challanNumber = `DC/${String(challanCount.count + 1).padStart(4, '0')}`;
    const challanId = randomUUID();

    // 1. Insert Delivery Challan Header
    db.prepare(`
      INSERT INTO delivery_challans (
        id, company_id, challan_number, date, party_account_id, sales_order_id, material_centre_id, transporter_name, vehicle_number, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_INVOICE')
    `).run(
      challanId, input.company_id, challanNumber, input.date, input.party_account_id,
      input.sales_order_id || null, input.material_centre_id, input.transporter_name || '', input.vehicle_number || ''
    );

    // 2. Deduct Stock & Insert Challan Lines
    const insertChallanItem = db.prepare(`
      INSERT INTO delivery_challan_items (id, challan_id, item_id, batch_id, qty, unit_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertStockOut = db.prepare(`
      INSERT INTO stock_entries (id, company_id, voucher_id, item_id, batch_id, material_centre_id, outward_qty, rate, entry_date)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);

    for (const it of input.items) {
      insertChallanItem.run(randomUUID(), challanId, it.item_id, it.batch_id || null, it.dispatched_qty, it.unit_id);

      // Perpetual stock deduction on physical dispatch
      insertStockOut.run(
        randomUUID(), input.company_id, it.item_id, it.batch_id || null,
        input.material_centre_id, it.dispatched_qty, it.rate, input.date
      );

      // If linked to Sales Order, update fulfillment backlog
      if (input.sales_order_id) {
        db.prepare(`
          UPDATE sales_order_items 
          SET delivered_qty = delivered_qty + ?, 
              pending_qty = MAX(0, pending_qty - ?)
          WHERE order_id = ? AND item_id = ?
        `).run(it.dispatched_qty, it.dispatched_qty, input.sales_order_id, it.item_id);
      }
    }

    // Update Sales Order status if fully fulfilled
    if (input.sales_order_id) {
      const remainingPending = db.prepare(`
        SELECT SUM(pending_qty) as total_pending FROM sales_order_items WHERE order_id = ?
      `).get(input.sales_order_id) as any;

      const newStatus = (remainingPending.total_pending || 0) === 0 ? 'COMPLETED' : 'PARTIAL';
      db.prepare('UPDATE sales_orders SET status = ? WHERE id = ?').run(newStatus, input.sales_order_id);
    }

    return {
      challanId,
      challanNumber,
      status: 'PENDING_INVOICE'
    };
  })();
}

/**
 * Retrieves all Sales Orders with pending items for invoicing or challan fulfillment.
 */
export function getSalesOrders(db: Database.Database, companyId: string) {
  return db.prepare(`
    SELECT 
      so.*,
      a.name as party_name,
      mc.name as godown_name
    FROM sales_orders so
    JOIN accounts a ON so.party_account_id = a.id
    JOIN material_centres mc ON so.material_centre_id = mc.id
    WHERE so.company_id = ?
    ORDER BY so.date DESC, so.created_at DESC
  `).all(companyId);
}
