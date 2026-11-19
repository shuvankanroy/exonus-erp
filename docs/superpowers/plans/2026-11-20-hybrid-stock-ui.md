# Hybrid ERPNext Stock Workspace & BUSY Keyboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Option B Hybrid Frontend UI in Exonus ERP, giving users an ERPNext-grade visual Stock Workspace & Dashboard alongside BUSY-style high-speed keyboard voucher sub-windows (<kbd>F2</kbd>, <kbd>F8</kbd>, <kbd>F9</kbd>, <kbd>Enter</kbd>).

**Architecture:** A Vue 3 SPA Single Page Application component inside `public/index.html` communicating with the newly built Phase 1–5 backend REST APIs (`/api/stock/bins`, `/api/stock/ledger`, `/api/stock/settings`, `/api/batches`, `/api/serials`, `/api/dimensions`, `/api/stock/entry`, `/api/stock/reconciliation`, `/api/stock/landed-cost`, `/api/stock/ageing`).

**Tech Stack:** Vue 3 (Composition API / reactive state), Tailwind CSS, Vanilla JS Canvas / SVG icons, SQLite WAL backend on Node.js/Express.

**Spec:** [Hybrid_Stock_UI_Design_Spec.md](file:///home/ankan/.gemini/antigravity/brain/a37cf6af-c8e7-4415-8293-4eb272839473/Hybrid_Stock_UI_Design_Spec.md)

## Global Constraints
- Must run cleanly on port `4200` without any external CDN dependencies.
- Zero breaking changes to existing double-entry GL vouchers (<kbd>F4</kbd>, <kbd>F5</kbd>, <kbd>F6</kbd>, <kbd>F8</kbd>, <kbd>F9</kbd>).
- High keyboard velocity: dialogs and sub-windows must open on <kbd>Enter</kbd> / key shortcuts and close on <kbd>Esc</kbd> / <kbd>Enter</kbd>.
- Pure mathematical synchronization between frontend Bins, Stock Ledger, and Trial Balance.

---

### Task 1: Stock Workspace Dashboard & Metrics Component
**Files:**
- Modify: `public/index.html`
- Test: Playwright Browser Test / Curl API Verification

**Description:**
Add a dedicated **Stock Workspace** view (`view === 'stock_workspace'`) accessible from the top menu bar (`Stock` menu or `Administration > Inventory Workspace`).

**Steps:**
- [ ] Add `Stock Workspace` navigation item to top horizontal bar.
- [ ] Implement Top KPI metric summary cards:
  - Total Stock Valuation (dynamically computed from `/api/stock/bins`).
  - Total Active SKUs.
  - Projected Reorder Alerts (count of items where `projected_qty < min_stock_level`).
  - Pending Dispatches & Goods Receipts.
- [ ] Implement Quick Navigation grid for all ERPNext stock doctypes:
  - `Stock Ledger Register`, `Stock Balance (Bins)`, `Stock Entry`, `Delivery Notes`, `Purchase Receipts`, `Stock Reconciliation`, `Landed Cost Voucher`, `Batches & Serials`, `Warehouses Tree`.
- [ ] Test in browser and confirm live API data loading.

---

### Task 2: Real-Time Bins Explorer & Reorder Alert Widget
**Files:**
- Modify: `public/index.html`

**Description:**
Embed the real-time Bin inventory explorer inside the Stock Workspace with multi-warehouse filtering and projected stock calculation.

**Steps:**
- [ ] Implement live search and warehouse dropdown filter for Bins.
- [ ] Render data columns: SKU, Item Name, Warehouse, Actual Stock, Ordered Qty, Reserved Qty, Projected Qty, Valuation Rate, Total Value.
- [ ] Color-code Projected Qty: red badge if below minimum reorder level, green if healthy.
- [ ] Add "Quick Draft Material Request" button on low-stock items.

---

### Task 3: Audit-Grade Stock Ledger Register Modal
**Files:**
- Modify: `public/index.html`

**Description:**
Build the chronological Stock Ledger viewer (`/api/stock/ledger`) displaying every inward, outward, and transfer movement.

**Steps:**
- [ ] Add Stock Ledger modal dialog with date range picker and item/warehouse filters.
- [ ] Render tabular columns: Date, Time, Voucher Type, Voucher No, Warehouse, Actual Qty (+/-), Valuation Rate, Balance Qty, Balance Value.
- [ ] Add expandable toggle to view the internal FIFO queue JSON (`stock_queue = [[qty, rate], ...]`).

---

### Task 4: Keyboard-Driven Batch & Serial Number Sub-Window in Vouchers
**Files:**
- Modify: `public/index.html`

**Description:**
Integrate BUSY-style rapid sub-windows during voucher entry (<kbd>F8</kbd> Sales, <kbd>F9</kbd> Purchase, Delivery Note, GRN).

**Steps:**
- [ ] When entering an item row in invoice grids, detect if item is batch-tracked or serial-tracked.
- [ ] If batch-tracked, popup modal asking for `Batch No`, `Expiry Date`, `MRP`, and `Sale Rate` with instant keyboard save.
- [ ] If serial-tracked, display barcode scanning field to quickly add serial numbers without touching the mouse.
- [ ] Wire selected batches and serials into the transaction payload.

---

### Task 5: Stock Reconciliation & Landed Cost Voucher Modals
**Files:**
- Modify: `public/index.html`

**Description:**
Add the operational tools for physical count audits and landed cost absorption.

**Steps:**
- [ ] Build Stock Reconciliation grid: loads current book stock per warehouse, allows typing counted physical stock, computes variance, and calls `POST /api/stock/reconciliation`.
- [ ] Build Landed Cost Voucher dialog: selects a Purchase Receipt (GRN), allows adding freight/customs expenses, selects distribution by Quantity or Amount, and calls `POST /api/stock/landed-cost`.
- [ ] Commit all changes and verify live on browser.
