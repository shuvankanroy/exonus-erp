// Stock Workspace Module (ERPNext v16 Specification)
window.renderStockWorkspacePage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <!-- Breadcrumb & Workspace Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="text-slate-800 font-semibold">Stock Workspace</span>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-blue-600 font-medium">Overview</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-cubes-stacked text-amber-500"></i>
            Stock & Inventory Management
          </h1>
          <p class="text-xs text-slate-500">Real-time ERPNext perpetual inventory tracking, real-time Bin balances, moving FIFO valuation queues, and audit registers.</p>
        </div>

        <div class="flex items-center gap-2 flex-wrap">
          <a href="#stock/entry" class="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrow-right-arrow-left text-[11px]"></i> Stock Entry
          </a>
          <a href="#stock/reconciliation" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-scale-balanced text-[11px]"></i> Physical Audit
          </a>
          <button onclick="renderStockWorkspacePage(document.getElementById('desk-content'))" class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrows-rotate text-[11px]"></i> Refresh Bins
          </button>
        </div>
      </div>

      <!-- 4 KPI Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div class="flex items-center justify-between text-slate-500 text-xs font-bold uppercase mb-2">
            <span>Total Stock Value</span>
            <i class="fa-solid fa-indian-rupee-sign text-emerald-500"></i>
          </div>
          <div id="kpi-stock-val" class="text-xl font-extrabold text-slate-900 font-mono">₹0.00</div>
          <div class="text-[11px] text-emerald-600 font-semibold mt-1 flex items-center gap-1">
            <i class="fa-solid fa-circle-check text-[10px]"></i> Perpetual Inventory Synced
          </div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div class="flex items-center justify-between text-slate-500 text-xs font-bold uppercase mb-2">
            <span>Active SKUs</span>
            <i class="fa-solid fa-barcode text-blue-500"></i>
          </div>
          <div id="kpi-sku-count" class="text-xl font-extrabold text-slate-900 font-mono">0 Items</div>
          <div class="text-[11px] text-slate-500 mt-1">Multi-Warehouse Bins</div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div class="flex items-center justify-between text-slate-500 text-xs font-bold uppercase mb-2">
            <span>Reorder Alerts</span>
            <i class="fa-solid fa-triangle-exclamation text-amber-500"></i>
          </div>
          <div id="kpi-reorder-count" class="text-xl font-extrabold text-amber-600 font-mono">0 Items</div>
          <div class="text-[11px] text-slate-500 mt-1">Projected Qty &lt; Minimum</div>
        </div>

        <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
          <div class="flex items-center justify-between text-slate-500 text-xs font-bold uppercase mb-2">
            <span>Valuation Method</span>
            <i class="fa-solid fa-gear text-purple-500"></i>
          </div>
          <div class="text-xl font-extrabold text-slate-900 font-mono">FIFO Mode</div>
          <div class="text-[11px] text-indigo-600 mt-1">Negative Stock Blocked</div>
        </div>
      </div>

      <!-- Real-Time Bin Balances Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
            <i class="fa-solid fa-table-cells text-blue-600"></i>
            Real-Time Bin Balances & Material Planning
          </h3>
          <span class="text-xs text-slate-500 font-mono">Projected = Actual + PO - SO</span>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs border-collapse">
            <thead>
              <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
                <th class="p-3">Item Name & SKU</th>
                <th class="p-3">Warehouse / Godown</th>
                <th class="p-3 text-right">Actual Qty</th>
                <th class="p-3 text-right">Reserved (SO)</th>
                <th class="p-3 text-right">Ordered (PO)</th>
                <th class="p-3 text-right">Projected Qty</th>
                <th class="p-3 text-right">Valuation Rate</th>
                <th class="p-3 text-right">Total Stock Value</th>
              </tr>
            </thead>
            <tbody id="bins-tbody" class="divide-y divide-slate-100">
              <tr>
                <td colspan="8" class="p-8 text-center text-slate-400">
                  <i class="fa-solid fa-spinner fa-spin text-base mb-1 text-blue-500"></i><br>
                  Loading real-time bin balances...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/stock/bins');
    const bins = await res.json();

    let totalVal = 0;
    const skuSet = new Set();

    if (!bins || bins.length === 0) {
      document.getElementById('bins-tbody').innerHTML = `
        <tr><td colspan="8" class="p-8 text-center text-slate-400">No stock bins registered in database yet.</td></tr>
      `;
      return;
    }

    const rows = bins.map(b => {
      totalVal += Number(b.stock_value || 0);
      skuSet.add(b.item_id);

      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="p-3">
            <div class="font-bold text-slate-800">${b.item_name}</div>
            <div class="text-[10px] text-slate-400 font-mono">${b.sku || b.hsn_code}</div>
          </td>
          <td class="p-3">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-medium text-[11px]">
              <i class="fa-solid fa-warehouse text-slate-400 text-[9px]"></i>
              ${b.warehouse_name}
            </span>
          </td>
          <td class="p-3 text-right font-mono font-bold text-slate-900">${b.actual_qty}</td>
          <td class="p-3 text-right font-mono text-slate-500">${b.reserved_qty}</td>
          <td class="p-3 text-right font-mono text-slate-500">${b.ordered_qty}</td>
          <td class="p-3 text-right font-mono font-bold ${b.projected_qty > 0 ? 'text-blue-600' : 'text-slate-500'}">${b.projected_qty}</td>
          <td class="p-3 text-right font-mono text-slate-700">₹${Number(b.valuation_rate || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
          <td class="p-3 text-right font-mono font-extrabold text-slate-900">₹${Number(b.stock_value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('bins-tbody').innerHTML = rows;
    document.getElementById('kpi-stock-val').textContent = `₹${totalVal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    document.getElementById('kpi-sku-count').textContent = `${skuSet.size} Items`;
  } catch (err) {
    document.getElementById('bins-tbody').innerHTML = `
      <tr><td colspan="8" class="p-4 text-center text-red-600">Failed to load bins: ${err.message}</td></tr>
    `;
  }
};
