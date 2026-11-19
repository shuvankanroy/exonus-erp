import Database from 'better-sqlite3';

/**
 * Rebuilds the lft and rgt nested set tree for material_centres (Warehouses)
 * Mirrors frappe.utils.nestedset.rebuild_tree and rebuild_node
 */
export function rebuildWarehouseTree(db: Database.Database, companyId: string) {
  // 1. Find all root nodes (parent_centre_id is NULL or empty string)
  const rootNodes = db.prepare(`
    SELECT id, name FROM material_centres 
    WHERE company_id = ? AND (parent_centre_id IS NULL OR parent_centre_id = '')
    ORDER BY is_group DESC, name ASC
  `).all(companyId) as Array<{ id: string; name: string }>;

  let counter = 1;

  function processNode(nodeId: string, left: number): number {
    let right = left + 1;
    // Get all children of this node
    const children = db.prepare(`
      SELECT id FROM material_centres 
      WHERE company_id = ? AND parent_centre_id = ?
      ORDER BY is_group DESC, name ASC
    `).all(companyId, nodeId) as Array<{ id: string }>;

    for (const child of children) {
      right = processNode(child.id, right);
    }

    db.prepare(`
      UPDATE material_centres 
      SET lft = ?, rgt = ?
      WHERE id = ?
    `).run(left, right, nodeId);

    return right + 1;
  }

  for (const root of rootNodes) {
    counter = processNode(root.id, counter);
  }
}

/**
 * Checks if a warehouse is a group node or ancestor before movement/posting
 */
export function validateWarehousePosting(db: Database.Database, warehouseId: string): void {
  const wh = db.prepare('SELECT name, is_group FROM material_centres WHERE id = ?').get(warehouseId) as { name: string; is_group: number } | undefined;
  if (!wh) {
    throw new Error(`Warehouse with ID ${warehouseId} does not exist`);
  }
  if (wh.is_group === 1) {
    throw new Error(`Transactions cannot be booked against Group Warehouse "${wh.name}". Please select a child/leaf warehouse.`);
  }
}

/**
 * Ensures standard root warehouse hierarchy exists for a company
 */
export function ensureDefaultWarehouseHierarchy(db: Database.Database, companyId: string, companyAbbr: string = 'EX') {
  const count = db.prepare('SELECT COUNT(*) as count FROM material_centres WHERE company_id = ?').get(companyId) as { count: number };
  
  // Find or create Root Warehouse: "All Warehouses - EX"
  let root = db.prepare(`
    SELECT id FROM material_centres 
    WHERE company_id = ? AND (parent_centre_id IS NULL OR parent_centre_id = '') AND is_group = 1
  `).get(companyId) as { id: string } | undefined;

  if (!root) {
    const rootId = 'wh-root-' + companyId.slice(0, 8);
    const rootName = `All Warehouses - ${companyAbbr}`;
    db.prepare(`
      INSERT OR IGNORE INTO material_centres (id, company_id, name, warehouse_type, parent_centre_id, is_group, address, is_default, disabled)
      VALUES (?, ?, ?, 'Actual', NULL, 1, 'Headquarters / All Territories', 0, 0)
    `).run(rootId, companyId, rootName);
    root = { id: rootId };
  }

  // Any leaf warehouses without parent should now be under Root
  db.prepare(`
    UPDATE material_centres 
    SET parent_centre_id = ?
    WHERE company_id = ? AND id != ? AND (parent_centre_id IS NULL OR parent_centre_id = '')
  `).run(root.id, companyId, root.id);

  // Rebuild lft and rgt tree
  rebuildWarehouseTree(db, companyId);
}
