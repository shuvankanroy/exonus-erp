// General Desk Pages (Company Profile, GST Reports, Help & Shortcuts)
window.renderCompanyProfilePage = async function(container) {
  const comp = await fetch('/api/company').then(r => r.json());
  container.innerHTML = `
    <div class="space-y-6 max-w-4xl mx-auto">
      <div class="flex items-center justify-between pb-4 border-b border-slate-200">
        <div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-building text-blue-600"></i>
            Company Master Profile
          </h1>
          <p class="text-xs text-slate-500">Statutory and commercial configuration for ${comp.name}.</p>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4 text-xs">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label class="block font-bold text-slate-700 mb-1">Company Registered Name</label>
            <input type="text" readonly value="${comp.name}" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 font-bold">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">GSTIN</label>
            <input type="text" readonly value="${comp.gstin || '-'}" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 font-mono">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">State Code</label>
            <input type="text" readonly value="${comp.state_code || '07 (Delhi)'}" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 font-mono">
          </div>
          <div>
            <label class="block font-bold text-slate-700 mb-1">Active Financial Year</label>
            <input type="text" readonly value="01-04-2026 to 31-03-2027" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 font-mono">
          </div>
        </div>
      </div>
    </div>
  `;
};

window.renderGSTReportsPage = async function(container) {
  const gst = await fetch('/api/reports/gst-summary').then(r => r.json());
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex items-center justify-between pb-4 border-b border-slate-200">
        <div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-file-shield text-emerald-600"></i>
            GST Returns & Statutory Audit (GSTR-1 / GSTR-3B)
          </h1>
          <p class="text-xs text-slate-500">Outward taxable supplies, input tax credits (ITC), and net payable duties.</p>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div class="text-xs font-bold text-slate-500 uppercase mb-1">Outward Supplies (GSTR-1)</div>
          <div class="text-2xl font-black text-slate-900 font-mono">₹${Number(gst.outward_taxable_value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
          <div class="text-[11px] text-emerald-600 font-medium mt-1">Output GST: ₹${Number(gst.output_tax || 0).toLocaleString('en-IN')}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div class="text-xs font-bold text-slate-500 uppercase mb-1">Inward Tax Credit (GSTR-2B)</div>
          <div class="text-2xl font-black text-slate-900 font-mono">₹${Number(gst.inward_taxable_value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
          <div class="text-[11px] text-blue-600 font-medium mt-1">Eligible ITC: ₹${Number(gst.input_tax || 0).toLocaleString('en-IN')}</div>
        </div>
        <div class="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <div class="text-xs font-bold text-slate-500 uppercase mb-1">Net GST Liability</div>
          <div class="text-2xl font-black text-slate-900 font-mono">₹${Number(gst.net_liability || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
          <div class="text-[11px] text-purple-600 font-medium mt-1">Payable in Cash / Credit</div>
        </div>
      </div>
    </div>
  `;
};

window.renderShortcutsHelpPage = function(container) {
  container.innerHTML = `
    <div class="space-y-6 max-w-3xl mx-auto">
      <div class="flex items-center justify-between pb-4 border-b border-slate-200">
        <div>
          <h1 class="text-xl font-black text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-keyboard text-purple-600"></i>
            Keyboard Shortcuts & High-Speed Operations
          </h1>
          <p class="text-xs text-slate-500">Accelerated navigation designed for experienced accountants and billing operators.</p>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100 text-xs">
        <div class="p-4 flex items-center justify-between">
          <div><div class="font-bold text-slate-800">Sales Invoice Creation</div><div class="text-slate-400 text-[11px]">Open fast point-of-sale invoice voucher</div></div>
          <kbd class="px-2.5 py-1 bg-slate-100 border border-slate-300 rounded font-mono font-bold text-slate-700">F8</kbd>
        </div>
        <div class="p-4 flex items-center justify-between">
          <div><div class="font-bold text-slate-800">Purchase Inward Bill</div><div class="text-slate-400 text-[11px]">Open inward purchase receipt voucher</div></div>
          <kbd class="px-2.5 py-1 bg-slate-100 border border-slate-300 rounded font-mono font-bold text-slate-700">F9</kbd>
        </div>
        <div class="p-4 flex items-center justify-between">
          <div><div class="font-bold text-slate-800">Warehouses Nested Tree</div><div class="text-slate-400 text-[11px]">Jump to warehouse hierarchy and rollups</div></div>
          <kbd class="px-2.5 py-1 bg-slate-100 border border-slate-300 rounded font-mono font-bold text-slate-700">F7</kbd>
        </div>
        <div class="p-4 flex items-center justify-between">
          <div><div class="font-bold text-slate-800">Trial Balance Audit</div><div class="text-slate-400 text-[11px]">Open zero-discrepancy double-entry trial balance</div></div>
          <kbd class="px-2.5 py-1 bg-slate-100 border border-slate-300 rounded font-mono font-bold text-slate-700">F6</kbd>
        </div>
      </div>
    </div>
  `;
};
