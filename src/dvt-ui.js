'use strict';
// ---------------------------------------------------------------------------
// Tab "Chuyển đổi DVT" — Renderer logic
// ---------------------------------------------------------------------------

(function () {
  const $ = id => document.getElementById(id);
  const optional = id => document.getElementById(id);

  let dvtMappings = [];
  let dvtEditId = null;
  let dvtSearchTimer = null;

  // Tab switching
  const viewDvtBtn = $('view-dvt');
  const paneDvt = $('pane-dvt');

  if (viewDvtBtn && paneDvt) {
    viewDvtBtn.addEventListener('click', () => {
      // Hide all panes
      document.querySelectorAll('.workspace').forEach(p => p.hidden = true);
      // Show DVT pane
      paneDvt.hidden = false;
      // Update tab active state
      document.querySelectorAll('#view-switch button').forEach(b => {
        b.classList.toggle('active', b === viewDvtBtn);
        b.setAttribute('aria-selected', b === viewDvtBtn);
      });
      // Load DVT mappings
      loadDvtMappings();
    });
  }

  // ============================================================
  // API Calls
  // ============================================================

  async function call(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: url === '/api/state' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw new Error('Không kết nối được ứng dụng. Hãy mở lại CN-Tax-Tools.exe.');
    }
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  // ============================================================
  // DVT Mappings CRUD
  // ============================================================

  async function loadDvtMappings() {
    try {
      const data = await call('/api/dvt/mappings');
      dvtMappings = data || [];
      renderDvtTable();
    } catch (error) {
      if (window.noticeFail) window.noticeFail(error.message);
      else console.error(error);
    }
  }

  function renderDvtTable() {
    const tbody = $('dvt-rows');
    const countEl = $('dvt-count');
    const search = ($('dvt-search')?.value || '').toLowerCase();
    const sourceFilter = $('dvt-filter-source')?.value || 'all';
    const statusFilter = $('dvt-filter-status')?.value || 'all';

    if (!tbody) return;

    let filtered = dvtMappings;
    if (search) {
      filtered = filtered.filter(m =>
        m.maHang.toLowerCase().includes(search) ||
        m.tenHang.toLowerCase().includes(search) ||
        m.dvtGoc.toLowerCase().includes(search) ||
        m.dvtDich.toLowerCase().includes(search)
      );
    }
    if (sourceFilter !== 'all') {
      filtered = filtered.filter(m => m.nguon === sourceFilter);
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter(m => m.trangThai === statusFilter);
    }

    if (countEl) countEl.textContent = `${filtered.length} mapping`;

    tbody.innerHTML = '';
    filtered.forEach((m, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="stt">${idx + 1}</td>
        <td>${escapeHtml(m.maHang)}</td>
        <td>${escapeHtml(m.tenHang)}</td>
        <td>${escapeHtml(m.dvtGoc)}</td>
        <td>${escapeHtml(m.dvtDich)}</td>
        <td class="num">${Number(m.tyLe).toLocaleString('vi-VN')}</td>
        <td>${formatSource(m.nguon)}</td>
        <td><span class="status-badge ${m.trangThai}">${formatStatus(m.trangThai)}</span></td>
        <td>
          <button class="icon-btn edit" data-id="${m.id}" title="Sửa" aria-label="Sửa mapping">✏️</button>
          <button class="icon-btn delete" data-id="${m.id}" title="Xoá" aria-label="Xoá mapping">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Bind edit/delete buttons
    tbody.querySelectorAll('.edit').forEach(btn => {
      btn.onclick = () => openEditForm(btn.dataset.id);
    });
    tbody.querySelectorAll('.delete').forEach(btn => {
      btn.onclick = () => deleteMapping(btn.dataset.id);
    });
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#039;');
  }

  function formatSource(source) {
    const map = {
      manual: 'Tạo thủ công',
      auto_learn: 'Tự động học',
      import: 'Import Excel',
      product_master: 'Từ Product Master'
    };
    return map[source] || source;
  }

  function formatStatus(status) {
    return status === 'active' ? 'Đang hoạt động' : 'Đã vô hiệu';
  }

  // Search/filter handlers
  const dvtSearch = $('dvt-search');
  if (dvtSearch) {
    dvtSearch.addEventListener('input', () => {
      clearTimeout(dvtSearchTimer);
      dvtSearchTimer = setTimeout(renderDvtTable, 150);
    });
  }
  ['dvt-filter-source', 'dvt-filter-status'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', renderDvtTable);
  });

  // ============================================================
  // Edit Form
  // ============================================================

  const editForm = $('dvt-edit-form');
  const editDialog = $('dvt-edit-dialog');

  function openEditForm(id = null) {
    dvtEditId = id;
    const mapping = id ? dvtMappings.find(m => m.id === Number(id)) : null;

    $('dvt-edit-ma-hang').disabled = !!id; // Disable ma_hang when editing
    $('dvt-edit-ma-hang').value = mapping ? mapping.maHang : '';
    $('dvt-edit-ten-hang').value = mapping ? mapping.tenHang : '';
    $('dvt-edit-dvt-goc').value = mapping ? mapping.dvtGoc : '';
    $('dvt-edit-dvt-dich').value = mapping ? mapping.dvtDich : '';
    $('dvt-edit-ty-le').value = mapping ? mapping.tyLe : 1;
    $('dvt-edit-ghi-chu').value = mapping ? mapping.ghiChu || '' : '';
    $('dvt-edit-nguon').value = mapping ? mapping.nguon : 'manual';
    $('dvt-edit-trang-thai').value = mapping ? mapping.trangThai : 'active';

    const titleEl = $('dvt-edit-title');
    if (titleEl) titleEl.textContent = id ? 'Sửa mapping DVT' : 'Thêm mapping DVT';

    if (editDialog) editDialog.showModal();
    $('dvt-edit-ma-hang').focus();
  }

  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const maHang = $('dvt-edit-ma-hang').value.trim();
      const tenHang = $('dvt-edit-ten-hang').value.trim();
      const dvtGoc = $('dvt-edit-dvt-goc').value.trim();
      const dvtDich = $('dvt-edit-dvt-dich').value.trim();
      const tyLe = Number($('dvt-edit-ty-le').value) || 1;
      const ghiChu = $('dvt-edit-ghi-chu').value.trim();
      const nguon = $('dvt-edit-nguon').value;
      const trangThai = $('dvt-edit-trang-thai').value;

      if (!maHang || !dvtGoc || !dvtDich) {
        if (window.noticeFail) window.noticeFail('Mã hàng, DVT gốc, DVT đích là bắt buộc');
        return;
      }
      if (Number($('dvt-edit-ty-le').value) <= 0) {
        if (window.noticeFail) window.noticeFail('Tỷ lệ phải > 0');
        return;
      }

      const btn = editForm.querySelector('button[type="submit"]');
      const restore = busyButton(btn, 'Đang lưu...');

      try {
        await call('/api/dvt/mappings' + (dvtEditId ? '/' + dvtEditId : ''), {
          maHang, tenHang: $('dvt-edit-ten-hang').value.trim(),
          dvtGoc: $('dvt-edit-dvt-goc').value.trim(),
          dvtDich: $('dvt-edit-dvt-dich').value.trim(),
          tyLe: Number($('dvt-edit-ty-le').value) || 1,
          ghiChu: $('dvt-edit-ghi-chu').value.trim(),
          nguon: $('dvt-edit-nguon').value,
          trangThai: $('dvt-edit-trang-thai').value
        }, dvtEditId ? 'PUT' : 'POST');
        editDialog.close();
        if (window.notice) window.notice('Đã lưu mapping DVT');
        loadDvtMappings();
      } catch (error) {
        if (window.noticeFail) window.noticeFail(error.message);
      } finally {
        restore();
      }
    });
  }

  // ============================================================
  // Delete Mapping
  // ============================================================

  async function deleteMapping(id) {
    const ok = await window.askConfirm({ title: 'Xoá mapping', text: 'Xoá mapping này?', tone: 'warn' });
    if (!ok) return;
    try {
      await call('/api/dvt/mappings/' + id, {}, 'DELETE');
      if (window.notice) window.notice('Đã vô hiệu mapping');
      loadDvtMappings();
    } catch (error) {
      if (window.noticeFail) window.noticeFail(error.message);
    }
  }

  // ============================================================
  // Import/Export
  // ============================================================

  const importBtn = $('dvt-import');
  if (importBtn) {
    importBtn.onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xlsx,.xls';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const result = await call('/api/dvt/mappings/import', { rows });
        if (window.notice) window.notice(`Import: ${result.success} thành công${result.errors.length ? ', ' + result.errors.length + ' lỗi' : ''}`);
        if (result.errors.length && window.noticeFail) window.noticeFail(result.errors.join('; '));
        loadDvtMappings();
      };
      input.click();
    };
  }

  const exportBtn = $('dvt-export');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      try {
        const data = await call('/api/dvt/mappings/export');
        // Convert to XLSX
        const ws = XLSX.utils.json_to_sheet(data.map(r => ({
          'Mã hàng': r['Mã hàng'],
          'Tên hàng': r['Tên hàng'],
          'DVT gốc': r['DVT gốc'],
          'DVT đích': r['DVT đích'],
          'Tỷ lệ': r['Tỷ lệ'],
          'Ghi chú': r['Ghi chú'],
          'Nguồn': r['Nguồn'],
          'Trạng thái': r['Trạng thái']
        })));
const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'DVT Mapping');
        const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const blob = new Blob([wbout], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `DVT_Mapping_${new Date().toISOString().slice(0,10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        if (window.noticeFail) window.noticeFail(error.message);
      }
    };
  }

  // Auto-learn
  const autoLearnBtn = $('dvt-auto-learn');
  if (autoLearnBtn) {
    autoLearnBtn.onclick = async () => {
      const btn = autoLearnBtn;
      const restore = busyButton(btn, 'Đang học...');
      try {
        const result = await call('/api/dvt/auto-learn', {}, 'POST');
        if (window.notice) window.notice(`Auto-learn: ${result.created} mapping mới`);
        loadDvtMappings();
      } catch (error) {
        if (window.noticeFail) window.noticeFail(error.message);
      } finally {
        restore();
      }
    };
  }

  // Close edit dialog
  const editClose = $('dvt-edit-close');
  if (editClose) editClose.onclick = () => editDialog.close();
  const editCancel = $('dvt-edit-cancel');
  if (editCancel) editCancel.onclick = () => editDialog.close();

  // Search/filter debounce
  if (dvtSearch) {
    dvtSearch.addEventListener('input', () => {
      clearTimeout(dvtSearchTimer);
      dvtSearchTimer = setTimeout(renderDvtTable, 150);
    });
  }
  ['dvt-filter-source', 'dvt-filter-status'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', renderDvtTable);
  });

  // Busy button helper
  function busyButton(button, label) {
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    return () => { button.disabled = false; if (button.textContent === label) button.textContent = original; };
  }

  // Expose for testing
  window.HD_DVT = {
    loadMappings: loadDvtMappings,
    render: renderDvtTable,
  };
})();