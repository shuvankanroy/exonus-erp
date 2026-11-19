// Vouchers & Fast Transaction Entries (Sales, Purchase, Day Book)
window.renderVouchersPage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="text-slate-800 font-semibold">Accounting</span>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-blue-600 font-medium">Day Book</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-book-open text-sky-500"></i>
            Day Book & Financial Vouchers
          </h1>
          <p class="text-xs text-slate-500">Complete double-entry general ledger journal for all sales, purchases, payments, and contra entries.</p>
        </div>

        <div class="flex items-center gap-2">
          <a href="#sales/create" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-plus text-[11px]"></i> Sale (F8)
          </a>
          <a href="#purchase/create" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5 transition">
            <i class="fa-solid fa-plus text-[11px]"></i> Purchase (F9)
          </a>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
              <th class="p-3">Date</th>
              <th class="p-3">Voucher No</th>
              <th class="p-3">Type</th>
              <th class="p-3">Party / Account</th>
              <th class="p-3 text-right">Debit (₹)</th>
              <th class="p-3 text-right">Credit (₹)</th>
            </tr>
          </thead>
          <tbody id="vouchers-tbody" class="divide-y divide-slate-100">
            <tr><td colspan="6" class="p-6 text-center text-slate-400">Loading vouchers...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/vouchers');
    const vouchers = await res.json();
    if (!vouchers || vouchers.length === 0) {
      document.getElementById('vouchers-tbody').innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400">No vouchers found in active FY.</td></tr>`;
      return;
    }
    document.getElementById('vouchers-tbody').innerHTML = vouchers.map(v => `
      <tr class="hover:bg-slate-50">
        <td class="p-3 text-slate-600 font-mono">${v.date}</td>
        <td class="p-3 font-bold text-slate-800 font-mono">${v.voucher_no}</td>
        <td class="p-3"><span class="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[10px] font-bold uppercase">${v.voucher_type}</span></td>
        <td class="p-3 text-slate-700 font-medium">${v.party_name || v.narration || '-'}</td>
        <td class="p-3 text-right font-mono font-bold text-slate-800">${Number(v.total_amount || 0).toFixed(2)}</td>
        <td class="p-3 text-right font-mono text-slate-600">${Number(v.total_amount || 0).toFixed(2)}</td>
      </tr>
    `).join('');
  } catch (err) {
    document.getElementById('vouchers-tbody').innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-600">Failed to load: ${err.message}</td></tr>`;
  }
};

window.renderTrialBalancePage = async function(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between pb-4 border-b border-slate-200 gap-4">
        <div>
          <div class="flex items-center gap-2 text-xs text-slate-500 mb-1">
            <span class="text-slate-800 font-semibold">Audit & Reports</span>
            <i class="fa-solid fa-chevron-right text-[10px]"></i>
            <span class="text-amber-600 font-medium">Trial Balance</span>
          </div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-scale-balanced text-amber-500"></i>
            Trial Balance (Zero-Discrepancy Audit)
          </h1>
          <p class="text-xs text-slate-500">Dual-column double-entry verification of all debit and credit account balances.</p>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-slate-100/70 text-slate-600 font-bold border-b border-slate-200 text-[11px] uppercase tracking-wider">
              <th class="p-3">Account Name</th>
              <th class="p-3">Group</th>
              <th class="p-3 text-right">Debit (₹)</th>
              <th class="p-3 text-right">Credit (₹)</th>
            </tr>
          </thead>
          <tbody id="tb-tbody" class="divide-y divide-slate-100">
            <tr><td colspan="4" class="p-6 text-center text-slate-400">Computing trial balance...</td></tr>
          </tbody>
          <tfoot class="bg-slate-100 font-bold text-slate-800">
            <tr>
              <td colspan="2" class="p-3 text-right uppercase">Grand Total:</td>
              <td id="tb-tot-debit" class="p-3 text-right font-mono">₹0.00</td>
              <td id="tb-tot-credit" class="p-3 text-right font-mono">₹0.00</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;

  try {
    const res = await fetch('/api/reports/trial-balance');
    const tb = await res.json();
    let totDr = 0;
    let totCr = 0;

    const rows = (tb.accounts || []).map(a => {
      totDr += Number(a.debit || 0);
      totCr += Number(a.credit || 0);
      return `
        <tr class="hover:bg-slate-50">
          <td class="p-3 font-bold text-slate-800">${a.name}</td>
          <td class="p-3 text-slate-500">${a.group_name || '-'}</td>
          <td class="p-3 text-right font-mono text-slate-800">${Number(a.debit || 0) > 0 ? Number(a.debit).toFixed(2) : '-'}</td>
          <td class="p-3 text-right font-mono text-slate-800">${Number(a.credit || 0) > 0 ? Number(a.credit).toFixed(2) : '-'}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('tb-tbody').innerHTML = rows;
    document.getElementById('tb-tot-debit').textContent = `₹${totDr.toFixed(2)}`;
    document.getElementById('tb-tot-credit').textContent = `₹${totCr.toFixed(2)}`;
  } catch (err) {
    document.getElementById('tb-tbody').innerHTML = `<tr><td colspan="4" class="p-4 text-center text-red-600">Failed to load: ${err.message}</td></tr>`;
  }
};
