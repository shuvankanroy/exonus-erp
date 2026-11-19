// Stock Ledger Register (SLE) Module (ERPNext v16 Specification)
window.renderStockLedgerPage = async function(container, params) {
  const whFilter = params.get('warehouse_id') || '';

  container.innerHTML = `
    <div class="space-y-6">
      <!-- Breadcrumb & Header -->
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <a href="#stock/workspace" class="hover:text-blue-600">Stock</a>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-slate-800 font-semibold">Stock Ledger (SLE)</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-file-invoice text-blue-600"></i>
            Immutable Stock Ledger Register (SLE)
          </h1>
          <p class="text-xs text-slate-500">Chronological, immutable audit ledger maintaining item valuations, incoming/outgoing movements, and running balance.</p>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="renderStockLedgerPage(document.getElementById('desk-content'), new URLSearchParams(window.location.hash.split('?')[1] || ''))" class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrows-rotate text-[11px]"></i> Refresh SLE
          </button>
        </div>
      </div>

      <!-- Ledger Table -->
      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs border-collapse">
            <thead>
              <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
                <th class="p-3">Posting Date & Time</th>
                <th class="p-3">Voucher Details</th>
                <th class="p-3">Item Name</th>
                <th class="p-3">Warehouse</th>
                <th class="p-3 text-right">Qty Change</th>
                <th class="p-3 text-right">Balance Qty</th>
                <th class="p-3 text-right">Incoming Rate</th>
                <th class="p-3 text-right">Valuation Rate</th>
                <th class="p-3 text-right">Stock Value Diff</th>
              </tr>
            </thead>
            <tbody id="sle-tbody" class="divide-y divide-slate-100 font-mono">
              <tr>
                <td colspan="9" class="p-8 text-center text-slate-400 font-sans">
                  <i class="fa-solid fa-spinner fa-spin text-base mb-1 text-blue-500"></i><br>
                  Loading immutable stock ledger entries...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  try {
    const url = whFilter ? `/api/stock/ledger?warehouse_id=${whFilter}` : '/api/stock/ledger';
    const res = await fetch(url);
    const entries = await res.json();

    if (!entries || entries.length === 0) {
      document.getElementById('sle-tbody').innerHTML = `
        <tr><td colspan="9" class="p-8 text-center text-slate-400 font-sans">No stock ledger entries recorded yet.</td></tr>
      `;
      return;
    }

    const rows = entries.map(e => {
      const isPositive = Number(e.actual_qty) > 0;
      return `
        <tr class="hover:bg-slate-50/80 transition">
          <td class="p-3 text-slate-600 font-sans">${e.posting_date} <span class="text-slate-400 text-[10px]">${e.posting_time}</span></td>
          <td class="p-3 font-sans">
            <span class="font-bold text-slate-800">${e.voucher_no || e.voucher_id || '-'}</span>
            <span class="ml-1 text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">${e.voucher_type}</span>
          </td>
          <td class="p-3 font-sans font-medium text-slate-800">${e.item_name}</td>
          <td class="p-3 font-sans text-slate-600">${e.warehouse_name}</td>
          <td class="p-3 text-right font-bold ${isPositive ? 'text-emerald-600' : 'text-rose-600'}">
            ${isPositive ? '+' : ''}${e.actual_qty}
          </td>
          <td class="p-3 text-right font-bold text-slate-800">${e.qty_after_transaction}</td>
          <td class="p-3 text-right text-slate-600">₹${Number(e.incoming_rate || 0).toFixed(2)}</td>
          <td class="p-3 text-right text-indigo-700 font-semibold">₹${Number(e.valuation_rate || 0).toFixed(2)}</td>
          <td class="p-3 text-right font-bold ${Number(e.stock_value_difference) >= 0 ? 'text-emerald-700' : 'text-rose-700'}">
            ₹${Number(e.stock_value_difference || 0).toFixed(2)}
          </td>
        </tr>
      `;
    }).join('');

    document.getElementById('sle-tbody').innerHTML = rows;
  } catch (err) {
    document.getElementById('sle-tbody').innerHTML = `
      <tr><td colspan="9" class="p-4 text-center text-red-600 font-sans">Failed to load ledger: ${err.message}</td></tr>
    `;
  }
};
