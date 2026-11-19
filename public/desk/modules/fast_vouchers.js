// Fast Voucher Forms Module (Sales F8, Purchase F9, Payment F5)
window.renderSalesCreatePage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6 max-w-5xl mx-auto">
      <div class="flex items-center justify-between pb-4 border-b border-slate-200">
        <div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-receipt text-blue-600"></i>
            Sales Invoice (BUSY High-Speed F8)
          </h1>
          <p class="text-xs text-slate-500">Fast keyboard-driven billing with instant GST calculation and FIFO stock allocation.</p>
        </div>
        <a href="#vouchers/daybook" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg transition">
          <i class="fa-solid fa-arrow-left mr-1"></i> Back to Daybook
        </a>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <form onsubmit="submitFastSale(event)" class="space-y-4 text-xs">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block font-bold text-slate-700 mb-1">Invoice Date</label>
              <input type="date" id="sale-date" value="${new Date().toISOString().split('T')[0]}" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
            </div>
            <div>
              <label class="block font-bold text-slate-700 mb-1">Customer / Party *</label>
              <select id="sale-party" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
                <option value="">Loading parties...</option>
              </select>
            </div>
            <div>
              <label class="block font-bold text-slate-700 mb-1">Source Warehouse (Storage Leaf) *</label>
              <select id="sale-warehouse" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none">
                <option value="">Loading warehouses...</option>
              </select>
            </div>
          </div>

          <!-- Items Row -->
          <div class="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
            <div class="font-bold text-slate-700 uppercase tracking-wider text-[11px]">Item Details</div>
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div class="md:col-span-2">
                <label class="block font-medium text-slate-600 mb-1">Select Item</label>
                <select id="sale-item" onchange="onSaleItemChange()" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white">
                  <option value="">Choose item...</option>
                </select>
              </div>
              <div>
                <label class="block font-medium text-slate-600 mb-1">Quantity</label>
                <input type="number" id="sale-qty" value="1" min="1" oninput="calcSaleTotal()" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white">
              </div>
              <div>
                <label class="block font-medium text-slate-600 mb-1">Sale Rate (₹)</label>
                <input type="number" id="sale-rate" step="0.01" value="0.00" oninput="calcSaleTotal()" required class="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs bg-white">
              </div>
            </div>
          </div>

          <!-- Summary and Save -->
          <div class="flex items-center justify-between pt-4 border-t border-slate-200">
            <div class="text-sm font-extrabold text-slate-800">
              Total Amount: <span id="sale-total-display" class="font-mono text-blue-600">₹0.00</span>
            </div>
            <button type="submit" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-md transition text-xs flex items-center gap-2">
              <i class="fa-solid fa-floppy-disk"></i> Post Sales Voucher (F8)
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  // Hydrate dropdowns
  const [parties, whs, items] = await Promise.all([
    fetch('/api/accounts').then(r => r.json()),
    fetch('/api/warehouses/tree').then(r => r.json()),
    fetch('/api/items').then(r => r.json())
  ]);

  window.saleItemsCatalog = items;

  const partySel = document.getElementById('sale-party');
  partySel.innerHTML = parties.filter(p => p.group_name === 'Sundry Debtors').map(p => `
    <option value="${p.id}">${p.name} (${p.gstin || 'Unregistered'})</option>
  `).join('');

  const whSel = document.getElementById('sale-warehouse');
  whSel.innerHTML = whs.filter(w => w.is_group === 0).map(w => `
    <option value="${w.id}">${w.name} (Stock: ${w.total_qty || 0})</option>
  `).join('');

  const itemSel = document.getElementById('sale-item');
  itemSel.innerHTML = '<option value="">Choose item...</option>' + items.map(it => `
    <option value="${it.id}">${it.name} (${it.sku || it.hsn_code})</option>
  `).join('');
};

window.onSaleItemChange = function() {
  const itemId = document.getElementById('sale-item').value;
  const item = (window.saleItemsCatalog || []).find(i => i.id === itemId);
  if (item) {
    document.getElementById('sale-rate').value = item.standard_sale_rate || 0;
  }
  window.calcSaleTotal();
};

window.calcSaleTotal = function() {
  const qty = Number(document.getElementById('sale-qty')?.value || 0);
  const rate = Number(document.getElementById('sale-rate')?.value || 0);
  const total = qty * rate;
  const disp = document.getElementById('sale-total-display');
  if (disp) disp.textContent = `₹${total.toFixed(2)}`;
};

window.submitFastSale = async function(e) {
  e.preventDefault();
  const party_id = document.getElementById('sale-party').value;
  const material_centre_id = document.getElementById('sale-warehouse').value;
  const date = document.getElementById('sale-date').value;
  const item_id = document.getElementById('sale-item').value;
  const qty = Number(document.getElementById('sale-qty').value);
  const rate = Number(document.getElementById('sale-rate').value);

  try {
    const res = await fetch('/api/vouchers/sales', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date,
        party_id,
        material_centre_id,
        items: [{ item_id, quantity: qty, rate, discount_percent: 0 }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to post sale voucher');
    alert(`Success: Sales invoice ${data.voucher_no || 'posted'} successfully!`);
    window.router.navigate('vouchers/daybook');
  } catch (err) {
    alert('Error posting sale: ' + err.message);
  }
};
