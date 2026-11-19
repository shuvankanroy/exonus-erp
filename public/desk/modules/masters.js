// Core Master Lists (Parties & Items)
window.renderPartiesPage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="text-slate-800 font-semibold">Accounting Masters</span>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-blue-600 font-medium">Parties</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-address-book text-blue-600"></i>
            Parties Master (Debtors & Creditors)
          </h1>
          <p class="text-xs text-slate-500">Commercial parties with GSTIN compliance, state codes, and current ledger balances.</p>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="renderPartiesPage(document.getElementById('desk-content'))" class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrows-rotate text-[11px]"></i> Refresh
          </button>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
              <th class="p-3">Party Name</th>
              <th class="p-3">Account Group</th>
              <th class="p-3">GSTIN</th>
              <th class="p-3">State Code</th>
              <th class="p-3 text-right">Current Balance</th>
            </tr>
          </thead>
          <tbody id="parties-tbody" class="divide-y divide-slate-100">
            <tr><td colspan="5" class="p-6 text-center text-slate-400">Loading parties...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/accounts');
    const accs = await res.json();
    const partyAccs = accs.filter(a => a.group_name === 'Sundry Debtors' || a.group_name === 'Sundry Creditors');
    
    document.getElementById('parties-tbody').innerHTML = partyAccs.map(p => `
      <tr class="hover:bg-slate-50">
        <td class="p-3 font-bold text-slate-800">${p.name}</td>
        <td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${p.group_name === 'Sundry Debtors' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}">${p.group_name}</span></td>
        <td class="p-3 font-mono">${p.gstin || '-'}</td>
        <td class="p-3 font-mono">${p.state_code || '-'}</td>
        <td class="p-3 text-right font-mono font-bold ${Number(p.current_balance) >= 0 ? 'text-slate-800' : 'text-rose-600'}">₹${Math.abs(Number(p.current_balance || 0)).toFixed(2)} ${Number(p.current_balance) >= 0 ? 'Dr' : 'Cr'}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('parties-tbody').innerHTML = `<tr><td colspan="5" class="p-4 text-center text-red-600">Failed to load: ${err.message}</td></tr>`;
  }
};

window.renderItemsPage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="text-slate-800 font-semibold">Inventory Masters</span>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-emerald-600 font-medium">Items</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-boxes-packing text-emerald-600"></i>
            Items & Products Master
          </h1>
          <p class="text-xs text-slate-500">Commercial catalogue of goods and services with HSN/SAC codes, standard rates, and units.</p>
        </div>

        <div class="flex items-center gap-2">
          <button onclick="renderItemsPage(document.getElementById('desk-content'))" class="px-3 py-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-arrows-rotate text-[11px]"></i> Refresh
          </button>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
              <th class="p-3">Item Name</th>
              <th class="p-3">SKU / Code</th>
              <th class="p-3">HSN/SAC</th>
              <th class="p-3">Primary Unit</th>
              <th class="p-3 text-right">Sale Rate</th>
              <th class="p-3 text-right">Purchase Rate</th>
              <th class="p-3 text-center">Batch/Serial Tracked</th>
            </tr>
          </thead>
          <tbody id="items-tbody" class="divide-y divide-slate-100">
            <tr><td colspan="7" class="p-6 text-center text-slate-400">Loading items...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/items');
    const items = await res.json();
    document.getElementById('items-tbody').innerHTML = items.map(it => `
      <tr class="hover:bg-slate-50">
        <td class="p-3 font-bold text-slate-800">${it.name}</td>
        <td class="p-3 font-mono">${it.sku || '-'}</td>
        <td class="p-3 font-mono">${it.hsn_code || '-'}</td>
        <td class="p-3"><span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold">${it.unit_symbol || 'Pcs'}</span></td>
        <td class="p-3 text-right font-mono font-bold text-slate-800">₹${Number(it.standard_sale_rate || 0).toFixed(2)}</td>
        <td class="p-3 text-right font-mono text-slate-600">₹${Number(it.standard_purchase_rate || 0).toFixed(2)}</td>
        <td class="p-3 text-center">
          ${it.is_batch_tracked ? '<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-bold">BATCH</span>' : ''}
          ${it.is_serial_tracked ? '<span class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[9px] font-bold">SERIAL</span>' : ''}
          ${!it.is_batch_tracked && !it.is_serial_tracked ? '<span class="text-slate-400 text-[10px]">-</span>' : ''}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('items-tbody').innerHTML = `<tr><td colspan="7" class="p-4 text-center text-red-600">Failed to load: ${err.message}</td></tr>`;
  }
};
