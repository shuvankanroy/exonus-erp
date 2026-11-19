// Warehouse NestedSet Tree View (ERPNext v16 Specification)
window.renderWarehouseTreePage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <!-- Breadcrumb & Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <a href="#stock/workspace" class="hover:text-blue-600">Stock</a>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-slate-800 font-semibold">Warehouse Tree</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-network-wired text-amber-500"></i>
            Warehouse Hierarchy (Nested Set Tree)
          </h1>
          <p class="text-xs text-slate-500">ERPNext Nested Set structure (<span class="font-mono">lft</span>/<span class="font-mono">rgt</span> indices). Rollup valuation and stock balances automatically aggregate from leaf warehouses to parent groups.</p>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="openAddWarehouseModal()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-plus text-[11px]"></i> Add Warehouse Node
          </button>
          <button onclick="renderWarehouseTreePage(document.getElementById('desk-content'))" class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrows-rotate text-[11px]"></i> Refresh Tree
          </button>
        </div>
      </div>

      <!-- Main Tree Panel -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Interactive Tree Structure (2 cols) -->
        <div class="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <div class="flex items-center justify-between pb-3 mb-4 border-b border-slate-100">
            <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 flex items-center gap-2">
              <i class="fa-solid fa-folder-tree text-blue-600"></i> Organization Structure
            </h3>
            <span class="text-[11px] font-mono text-slate-400">Total Valuation & Qty Rollup</span>
          </div>
          <div id="warehouse-tree-canvas" class="space-y-1">
            <div class="p-8 text-center text-slate-400 text-xs">
              <i class="fa-solid fa-spinner fa-spin text-lg mb-2 text-blue-500"></i><br>
              Loading Nested Set Warehouse Hierarchy...
            </div>
          </div>
        </div>

        <!-- Node Inspector & Properties (1 col) -->
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-500 pb-3 mb-4 border-b border-slate-100 flex items-center gap-2">
            <i class="fa-solid fa-circle-info text-indigo-600"></i> Node Details
          </h3>
          <div id="warehouse-detail-pane" class="text-xs text-slate-500 space-y-4">
            <p class="italic text-slate-400">Click any warehouse node on the left to inspect its parameters, parent linkage, and stock ledger entries.</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // Fetch Tree
  try {
    const res = await fetch('/api/warehouses/tree');
    const nodes = await res.json();
    renderTreeNodes(nodes);
  } catch (err) {
    document.getElementById('warehouse-tree-canvas').innerHTML = `
      <div class="p-4 bg-red-50 text-red-600 rounded-lg text-xs">Failed to load warehouse tree: ${err.message}</div>
    `;
  }
};

function renderTreeNodes(nodes) {
  const canvas = document.getElementById('warehouse-tree-canvas');
  if (!nodes || nodes.length === 0) {
    canvas.innerHTML = '<p class="text-xs text-slate-400">No warehouses configured.</p>';
    return;
  }

  // Find min lft to calculate depth
  const html = nodes.map(node => {
    const isGroup = node.is_group === 1;
    // Calculate indentation based on tree depth or parent
    let depth = 0;
    if (node.parent_centre_id) {
      depth = 1; // Direct children
    }
    const indentPx = depth * 24;

    return `
      <div onclick="selectWarehouseNode('${node.id}')" class="group flex items-center justify-between p-2.5 rounded-lg hover:bg-slate-50 border border-transparent hover:border-slate-200 cursor-pointer transition text-xs" style="margin-left: ${indentPx}px">
        <div class="flex items-center gap-2.5 min-w-0">
          <i class="fa-solid ${isGroup ? 'fa-folder text-amber-500' : 'fa-warehouse text-blue-500'} text-sm"></i>
          <div>
            <div class="font-bold text-slate-800 flex items-center gap-1.5">
              <span>${node.name}</span>
              ${isGroup ? '<span class="px-1.5 py-0.2 bg-amber-100 text-amber-800 rounded text-[9px] font-black uppercase">GROUP</span>' : '<span class="px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded text-[9px] font-bold">STORAGE LEAF</span>'}
              ${node.is_default ? '<span class="px-1.5 py-0.2 bg-blue-100 text-blue-800 rounded text-[9px] font-bold">DEFAULT</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 font-mono">
              LFT: ${node.lft} | RGT: ${node.rgt} ${node.parent_name ? `| Parent: ${node.parent_name}` : '| Root Node'}
            </div>
          </div>
        </div>

        <div class="text-right">
          <div class="font-bold font-mono text-slate-800">₹${Number(node.total_stock_value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
          <div class="text-[10px] text-slate-400">${Number(node.total_qty || 0)} Units</div>
        </div>
      </div>
    `;
  }).join('');

  canvas.innerHTML = html;

  // Auto-select root or first leaf
  if (nodes.length > 0) {
    window.selectWarehouseNode(nodes[0].id, nodes);
  }
}

window.selectWarehouseNode = async function(nodeId, cachedNodes) {
  let nodes = cachedNodes;
  if (!nodes) {
    const res = await fetch('/api/warehouses/tree');
    nodes = await res.json();
  }
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  const pane = document.getElementById('warehouse-detail-pane');
  if (!pane) return;

  const isGroup = node.is_group === 1;

  pane.innerHTML = `
    <div class="p-3 bg-slate-50 rounded-lg border border-slate-200">
      <div class="text-sm font-black text-slate-800 mb-1">${node.name}</div>
      <div class="text-[11px] text-slate-500 mb-2">${isGroup ? 'Group Node (Aggregates child stock)' : 'Leaf Storage Node (Direct physical transactions)'}</div>
      <div class="grid grid-cols-2 gap-2 text-[11px] pt-2 border-t border-slate-200">
        <div><span class="text-slate-400">Warehouse Type:</span> <span class="font-bold text-slate-700">${node.warehouse_type || 'Actual'}</span></div>
        <div><span class="text-slate-400">GL Account:</span> <span class="font-bold text-slate-700">${node.account_name || 'Stock In Hand'}</span></div>
        <div><span class="text-slate-400">Total Qty:</span> <span class="font-bold font-mono text-slate-700">${node.total_qty}</span></div>
        <div><span class="text-slate-400">Total Value:</span> <span class="font-bold font-mono text-slate-700">₹${Number(node.total_stock_value || 0).toLocaleString('en-IN')}</span></div>
      </div>
    </div>

    ${!isGroup ? `
      <div class="pt-2">
        <a href="#stock/ledger?warehouse_id=${node.id}" class="w-full text-center block px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold rounded-lg transition">
          <i class="fa-solid fa-list-check mr-1.5"></i> View Stock Ledger for this Warehouse
        </a>
      </div>
    ` : `
      <div class="p-2.5 bg-amber-50 text-amber-800 rounded-lg text-[11px] border border-amber-200">
        <i class="fa-solid fa-triangle-exclamation mr-1"></i> <strong>ERPNext Constraint:</strong> Vouchers cannot directly book stock into Group Warehouses. Stock must be stored in child leaf warehouses.
      </div>
    `}
  `;
};

window.openAddWarehouseModal = function() {
  const modal = document.createElement('div');
  modal.id = 'add-warehouse-modal';
  modal.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-slate-200 animate-in fade-in zoom-in duration-150">
      <div class="flex items-center justify-between pb-3 border-b border-slate-100 mb-4">
        <h3 class="font-extrabold text-sm text-slate-800 flex items-center gap-2">
          <i class="fa-solid fa-plus text-blue-600"></i> New Warehouse Node
        </h3>
        <button onclick="document.getElementById('add-warehouse-modal').remove()" class="text-slate-400 hover:text-slate-600 text-xs">
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      </div>

      <form id="add-wh-form" onsubmit="submitNewWarehouse(event)" class="space-y-4 text-xs">
        <div>
          <label class="block font-bold text-slate-700 mb-1">Warehouse Name *</label>
          <input type="text" id="new-wh-name" required placeholder="e.g. Raw Material Store - EX" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
        </div>

        <div>
          <label class="block font-bold text-slate-700 mb-1">Parent Warehouse</label>
          <select id="new-wh-parent" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <option value="">(Root Node - All Warehouses)</option>
          </select>
        </div>

        <div>
          <label class="block font-bold text-slate-700 mb-1">Warehouse Type</label>
          <select id="new-wh-type" class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <option value="Actual">Actual / Physical Storage</option>
            <option value="Transit">In-Transit Godown</option>
            <option value="WIP">Work-in-Progress (Manufacturing)</option>
            <option value="Rejected">Rejected Materials Godown</option>
          </select>
        </div>

        <div class="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center gap-2">
          <input type="checkbox" id="new-wh-isgroup" class="rounded border-slate-300 text-blue-600 focus:ring-blue-500">
          <label for="new-wh-isgroup" class="font-bold text-slate-700 cursor-pointer">
            Is Group (Can contain child warehouses)
          </label>
        </div>

        <div class="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button type="button" onclick="document.getElementById('add-warehouse-modal').remove()" class="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition">Cancel</button>
          <button type="submit" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-sm transition">Create Node</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  // Populate parents dropdown
  fetch('/api/warehouses/tree').then(r => r.json()).then(nodes => {
    const sel = document.getElementById('new-wh-parent');
    if (sel && nodes) {
      nodes.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n.id;
        opt.textContent = `${n.name} (${n.is_group ? 'Group' : 'Leaf'})`;
        if (n.is_group) opt.selected = true;
        sel.appendChild(opt);
      });
    }
  });
};

window.submitNewWarehouse = async function(e) {
  e.preventDefault();
  const name = document.getElementById('new-wh-name').value;
  const parent_centre_id = document.getElementById('new-wh-parent').value;
  const warehouse_type = document.getElementById('new-wh-type').value;
  const is_group = document.getElementById('new-wh-isgroup').checked;

  try {
    const res = await fetch('/api/warehouses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parent_centre_id, warehouse_type, is_group })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create warehouse');
    
    document.getElementById('add-warehouse-modal').remove();
    window.renderWarehouseTreePage(document.getElementById('desk-content'));
  } catch (err) {
    alert('Error: ' + err.message);
  }
};
