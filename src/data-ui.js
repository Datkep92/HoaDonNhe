'use strict';
// ---------------------------------------------------------------------------
// Kho dữ liệu hoá đơn — PHASE 3/5.
//
// Bố cục (theo yêu cầu):
//   - Cột MST bên trái (aside dùng chung) điều khiển cả tab Tra cứu & tải và tab Kho dữ liệu.
//   - Đầu tab Kho dữ liệu: thống kê GỌN + bộ lọc (tìm kiếm, chip khoảng ngày, lọc nâng cao).
//   - Bên dưới: 3 bảng con — Hàng hóa | Danh sách hóa đơn | Đối tác — mỗi bảng có nút chuyển
//     chiều Mua vào / Bán ra RIÊNG.
//   - Bấm "Số / Ký hiệu" → popup hoá đơn khổ A4 (máy chủ dựng từ đúng 1 file XML).
//
// Nguyên tắc (§15, §31–§35, §48, §50): danh sách/tổng hợp đọc từ SQLite và KHÔNG quét XML;
// chi tiết chỉ đọc 1 file XML. Việc dài chạy nền, không khoá UI, không reload app.
// ---------------------------------------------------------------------------

(function () {
  const $ = id => document.getElementById(id);
  const num = new Intl.NumberFormat('vi-VN');
  const RANGE_KEY = 'hoadon.data.range';
  const SIZE_KEY = 'hoadon.data.size';

  let app = {};
  let view = 'download';
  let page = 0;
  let size = 50;
  let total = 0;
  let rows = [];
  let selectedKey = '';
  let products = [];
  let range = { from: '', to: '', chip: 'all' };
  // Mỗi bảng có lựa chọn chiều riêng, không dùng chung một ô lọc.
  const tabState = { products: { dir: '' }, list: { dir: '' }, partners: { kind: 'all' } };
  let importPoll = null;
  let autosyncPoll = null;
  let backfillPoll = null;
  let seenImportRunning = false;
  let autoRunning = false;
  let newInvoices = 0;

  const fail = error => {
    if (window.noticeFail) window.noticeFail(error.message);
    else if (window.notice) window.notice(error.message);
    else console.error(error);
  };
  const csvCell = value => { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const shortMoney = value => {
    const n = Math.round(Number(value) || 0);
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2).replace(/\.?0+$/, '')} tỷ`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.?0+$/, '')} tr`;
    return num.format(n);
  };
  const shortWhen = value => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')} ${time}`;
  };
  const shortDay = value => {
    const text = String(value || '');
    const parts = text.split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0].slice(2)}` : text;
  };

  function td(text, className) {
    const cell = document.createElement('td');
    cell.textContent = text ?? '';
    if (className) cell.className = className;
    return cell;
  }

  function makeRow(cells) {
    const tr = document.createElement('tr');
    for (const [text, className] of cells) tr.append(td(text, className));
    return tr;
  }

  async function api(path, options) {
    const response = await fetch(path, options);
    const result = await response.json().catch(() => ({ ok: false, error: 'Ứng dụng trả về dữ liệu không hợp lệ.' }));
    if (!result.ok) throw new Error(result.error || 'Lỗi không rõ.');
    return result.value;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // ------------------------------------------------------------------ điều hướng
  function showView(next) {
    view = next;
    $('pane-download').hidden = next !== 'download';
    $('pane-data').hidden = next !== 'data';
    for (const [id, name] of [['view-download', 'download'], ['view-data', 'data']]) {
      const button = $(id);
      button.classList.toggle('active', name === next);
      button.setAttribute('aria-selected', name === next ? 'true' : 'false');
    }
    if (next === 'data') refreshAll();
  }

  async function refreshAll() {
    try {
      await Promise.all([loadSummary(), loadList(), loadProducts(), loadPartners(), loadImportStatus(), loadAutoSync(), loadBackfill()]);
    } catch (error) { fail(error); }
  }

  // Ô thống kê: nhãn nhỏ mờ + giá trị đậm; màu theo nhóm (mua vào / bán ra / thuế).
  function tile(label, value, kind) {
    const box = document.createElement('div');
    box.className = kind ? `data-tile ${kind}` : 'data-tile';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    box.append(span, strong);
    return box;
  }

  async function loadSummary() {
    const value = await api('/api/db/summary');
    const box = $('data-tiles');
    box.replaceChildren();
    box.append(
      tile('Khoảng ngày', `${shortDay(value.from)} → ${shortDay(value.to)}`, 'range'),
      tile('Tiền mua vào', `${num.format(value.buy || 0)} HĐ · ${shortMoney(value.amountBuy)}`, 'buy'),
      tile('Tiền bán ra', `${num.format(value.sell || 0)} HĐ · ${shortMoney(value.amountSell)}`, 'sell'),
      tile('Thuế mua vào', shortMoney(value.taxBuy), 'tax'),
      tile('Thuế bán ra', shortMoney(value.taxSell), 'tax'),
      tile('Cập nhật', shortWhen(value.lastImport), 'time'),
    );
    // Nói rõ độ phủ của tiền thuế dòng: XML của một số nhà cung cấp KHÔNG có thẻ TThue
    // (đo trên dữ liệu thật), nên bảng hàng hoá để “—” cho những dòng đó — không tự tính bù.
    const covered = Number(value.itemsWithTax) || 0;
    const allItems = Number(value.items) || 0;
    $('data-tax-note').textContent = `Tiền thuế dòng: ${num.format(covered)}/${num.format(allItems)} dòng hàng có sẵn trong XML — dòng nào file XML không có thẻ TThue thì để “—” (không tự tính bù). Tiền thuế của cả hoá đơn luôn có đủ, xem ở tab Danh sách hóa đơn.`;
  }

  function announceNew(count) {
    if (!count) return;
    newInvoices += count;
    const badge = $('data-new-badge');
    badge.hidden = false;
    badge.textContent = `${num.format(newInvoices)} hoá đơn mới`;
    if (window.notice) window.notice(`Đã phát hiện và nhập ${num.format(count)} hoá đơn mới vào kho dữ liệu.`);
  }

  // ------------------------------------------------------------------ bộ lọc gọn
  function quickRange(kind) {
    const now = new Date();
    if (kind === 'all') return { from: '', to: '', chip: 'all' };
    if (kind === 'today') return { from: isoDate(now), to: isoDate(now), chip: kind };
    if (kind === '7d') { const from = new Date(now); from.setDate(from.getDate() - 6); return { from: isoDate(from), to: isoDate(now), chip: kind }; }
    if (kind === 'month') return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)), chip: kind };
    if (kind === 'quarter') { const q = Math.floor(now.getMonth() / 3); return { from: isoDate(new Date(now.getFullYear(), q * 3, 1)), to: isoDate(new Date(now.getFullYear(), q * 3 + 3, 0)), chip: kind }; }
    return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(new Date(now.getFullYear(), 11, 31)), chip: kind };
  }

  function paintRange() {
    for (const button of document.querySelectorAll('.data-chips button')) button.classList.toggle('active', button.dataset.range === range.chip);
    $('data-from').value = range.from;
    $('data-to').value = range.to;
  }

  function savePrefs() {
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify({ range, size }));
    } catch { /* chế độ riêng tư */ }
  }

  function restorePrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || '{}');
      if (saved.range && typeof saved.range === 'object') range = { from: saved.range.from || '', to: saved.range.to || '', chip: saved.range.chip || 'all' };
      const savedSize = Number(localStorage.getItem(SIZE_KEY));
      if ([50, 100, 200].includes(savedSize)) size = savedSize;
    } catch { /* bỏ qua */ }
    $('data-size').value = String(size);
    paintRange();
  }

  function activeFilters() {
    return { q: $('data-q').value.trim(), from: range.from, to: range.to };
  }

  function reloadAll() { page = 0; savePrefs(); loadList().catch(fail); loadProducts().catch(fail); if (tabState.partners.kind) loadPartners().catch(fail); loadSummary().catch(fail); }

  // ------------------------------------------------------------------ danh sách hoá đơn
  async function loadList() {
    const filters = activeFilters();
    const params = new URLSearchParams({ ...filters, direction: tabState.list.dir, limit: String(size), offset: String(page * size) });
    const value = await api(`/api/db/invoices?${params.toString()}`);
    total = value.total || 0;
    rows = value.rows || [];
    const body = $('data-rows');
    body.replaceChildren();
    for (const [index, inv] of rows.entries()) {
      const tr = document.createElement('tr');
      tr.append(td(String(page * size + index + 1), 'stt'));
      tr.append(td(shortDay(inv.ngay_lap)));
      const numberCell = document.createElement('td');
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'link invoice-link';
      openButton.textContent = inv.khh_hd ? `${inv.so_hd || ''} · ${inv.khh_hd}` : (inv.so_hd || '');
      openButton.title = 'Bấm để mở hoá đơn khổ A4 (đọc đúng 1 file XML)';
      openButton.onclick = event => { event.stopPropagation(); openInvoice(inv.invoice_key); };
      numberCell.append(openButton);
      tr.append(numberCell);
      tr.append(td(inv.ten_ban || inv.mst_ban || ''));
      tr.append(td(inv.ten_mua || inv.mst_mua || ''));
      tr.append(td(inv.tien_truoc_thue == null ? '—' : num.format(inv.tien_truoc_thue), 'num'));
      tr.append(td(inv.tien_thue == null ? '—' : num.format(inv.tien_thue), 'num'));
      tr.append(td(inv.tong_tien == null ? '—' : num.format(inv.tong_tien), 'num'));
      tr.className = 'clickable';
      tr.tabIndex = 0;
      tr.title = 'Bấm để mở hoá đơn A4 (hoặc ↑ ↓ rồi Enter)';
      tr.classList.toggle('selected', inv.invoice_key === selectedKey);
      tr.onclick = () => openInvoice(inv.invoice_key);
      tr.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); openInvoice(inv.invoice_key); } };
      body.append(tr);
    }
    const pages = Math.max(1, Math.ceil(total / size));
    if (page >= pages) page = pages - 1;
    $('data-count').textContent = `${num.format(total)} hóa đơn`;
    $('data-page').textContent = `Trang ${page + 1} / ${pages}`;
    $('data-prev').disabled = page <= 0;
    $('data-next').disabled = page + 1 >= pages;
  }

  function moveSelection(step) {
    if (!rows.length) return;
    const index = rows.findIndex(row => row.invoice_key === selectedKey);
    const next = Math.max(0, Math.min(rows.length - 1, (index === -1 ? 0 : index + step)));
    selectedKey = rows[next].invoice_key;
    const children = $('data-rows').children;
    for (const row of children) row.classList.remove('selected');
    if (children[next]) { children[next].classList.add('selected'); children[next].scrollIntoView({ block: 'nearest' }); }
  }

  // ------------------------------------------------------------------ hoá đơn khổ A4 (§35)
  function openInvoice(key) {
    if (!key) return;
    selectedKey = key;
    $('invoice-frame').src = `/api/db/invoice/html?key=${encodeURIComponent(key)}`;
    const dialog = $('invoice-dialog');
    if (!dialog.open) dialog.showModal();
  }

  function closeInvoice() {
    const dialog = $('invoice-dialog');
    if (dialog.open) dialog.close();
    $('invoice-frame').src = 'about:blank';
  }

  function printInvoice() {
    try { $('invoice-frame').contentWindow.print(); }
    catch { fail(new Error('Chưa in được — mở lại hoá đơn rồi thử lại.')); }
  }

  // ------------------------------------------------------------------ tab con + chiều riêng từng bảng
  function showDataTab(name) {
    for (const one of ['products', 'list', 'partners']) $('data-tab-' + one).hidden = one !== name;
    for (const [key, id] of [['products', 'data-tab-products-btn'], ['list', 'data-tab-list-btn'], ['partners', 'data-tab-partners-btn']]) {
      const button = $(id);
      button.classList.toggle('active', key === name);
      button.setAttribute('aria-selected', key === name ? 'true' : 'false');
    }
    if (name === 'products') loadProducts().catch(fail);
    if (name === 'list') loadList().catch(fail);
    if (name === 'partners') loadPartners().catch(fail);
  }

  function bindSegment(id, onPick) {
    for (const button of $(id).querySelectorAll('button')) {
      button.onclick = () => {
        for (const other of $(id).querySelectorAll('button')) other.classList.toggle('active', other === button);
        onPick(button);
      };
    }
  }

  // ------------------------------------------------------------------ hàng hóa tổng hợp
  async function loadProducts() {
    const filters = activeFilters();
    const params = new URLSearchParams({ ...filters, direction: tabState.products.dir, limit: '200' });
    const value = await api(`/api/db/products?${params.toString()}`);
    products = value.rows || [];
    const body = $('data-products');
    body.replaceChildren();
    for (const item of products) {
      body.append(makeRow([
        [item.ma_hang || ''], [item.ten_hang || ''], [item.don_vi || ''],
        [num.format(item.tong_so_luong || 0), 'num'],
        [item.thue_suat || '—', 'num'],
        // Tiền thuế từng dòng chỉ có khi XML có thẻ TThue; cổng thuế hiện không trả ⇒ để “—”, KHÔNG hiện 0 và KHÔNG tự tính.
        [item.tong_thue == null ? '—' : num.format(item.tong_thue), 'num'],
        [num.format(item.tong_tien || 0), 'num'],
      ]));
    }
    $('data-products-count').textContent = `${num.format(products.length)} mặt hàng`;
  }

  // ------------------------------------------------------------------ đối tác
  async function loadPartners() {
    const value = await api(`/api/db/partners?kind=${encodeURIComponent(tabState.partners.kind)}&limit=200`);
    const body = $('data-partners');
    body.replaceChildren();
    for (const partner of value.rows || []) {
      body.append(makeRow([
        [partner.loai === 'NCC' ? 'NCC' : (partner.loai === 'KH' ? 'Khách' : (tabState.partners.kind === 'supplier' ? 'NCC' : 'Khách'))],
        [partner.mst || ''], [partner.ten || ''],
        [num.format(partner.so_hoa_don || 0), 'num'],
        [num.format(partner.tong_thue || 0), 'num'],
        [num.format(partner.tong_tien || 0), 'num'],
      ]));
    }
  }

  function exportProducts() {
    if (!products.length) {
      fail(new Error('Chưa có dữ liệu hàng hóa. Bấm “Tải lại” hoặc “Nhập / cập nhật từ XML” trước.'));
      return;
    }
    const lines = [['Mã hàng', 'Tên hàng', 'ĐVT', 'Số lượng', 'Thuế suất', 'Tiền thuế', 'Thành tiền'].join(',')]
      .concat(products.map(item => [item.ma_hang, item.ten_hang, item.don_vi, item.tong_so_luong, item.thue_suat, item.tong_thue, item.tong_tien].map(csvCell).join(',')));
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hang-hoa-${app.selected || 'MST'}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (window.notice) window.notice(`Đã xuất ${num.format(products.length)} mặt hàng ra CSV.`);
  }

  // ------------------------------------------------------------------ nhập XML
  function renderImport(status) {
    const bar = $('data-import-bar');
    const line = $('data-import-status');
    if (status.running) {
      bar.hidden = false;
      bar.value = status.total ? Math.round(100 * status.scanned / status.total) : 0;
      line.textContent = `Đang nhập ${num.format(status.scanned)}/${num.format(status.total)} file · nhập ${status.imported} · trùng ${status.duplicates} · bỏ qua ${status.skipped} · lỗi ${status.errors}${status.current ? ` · ${status.current}` : ''}`;
      return;
    }
    if (status.finishedAt) {
      bar.hidden = false;
      bar.value = 100;
      line.textContent = status.total
        ? `Nhập xong ${num.format(status.total)} file · nhập ${status.imported}, trùng ${status.duplicates}, bỏ qua ${status.skipped}, lỗi ${status.errors} · ${num.format(status.itemsTotal)} dòng hàng hóa.`
        : `Không tìm thấy file XML nào cho MST ${status.mst || '…'} trong ${status.dir || '…'} (đã tìm cả thư mục con Mua_vao / Ban_ra).`;
      return;
    }
    bar.hidden = true;
    line.textContent = 'Chưa nhập lần nào trong phiên này.';
  }

  function stopImportPolling() { if (importPoll) { clearInterval(importPoll); importPoll = null; } }
  function startImportPolling() {
    if (importPoll) return;
    importPoll = setInterval(async () => {
      try {
        const status = await api('/api/db/import/status');
        renderImport(status);
        if (!status.running) { stopImportPolling(); if (status.imported) announceNew(status.imported); await refreshAll(); }
      } catch { /* lần sau thử lại */ }
    }, 800);
  }

  async function loadImportStatus() {
    const status = await api('/api/db/import/status');
    renderImport(status);
    if (status.running) startImportPolling();
  }

  async function startImport() {
    $('data-import').disabled = true;
    try {
      renderImport(await post('/api/db/import', {}));
      startImportPolling();
    } catch (error) {
      fail(error);
    } finally {
      $('data-import').disabled = false;
    }
  }

  // ------------------------------------------------------------------ Auto Sync (mở từ menu ⋯ của MST)
  function stopAutoSyncPolling() { if (autosyncPoll) { clearInterval(autosyncPoll); autosyncPoll = null; } }
  function startAutoSyncPolling() {
    if (autosyncPoll) return;
    autosyncPoll = setInterval(() => loadAutoSync().catch(() => {}), 1500);
  }

  async function loadAutoSync() {
    const value = await api('/api/db/autosync/status');
    $('autosync-enabled').checked = !!value.settings.enabled;
    $('autosync-days').value = value.settings.days;
    $('autosync-interval').value = value.settings.intervalMinutes;
    $('autosync-mst').textContent = value.mst ? `MST ${value.mst} · tự tra cứu → tải XML còn thiếu → nhập vào kho dữ liệu.` : 'Chọn một MST ở cột bên trái trước.';
    const line = (label, state) => `${label}: ${state.status === 'error' ? `lỗi — ${state.lastError || ''}` : shortWhen(state.lastSuccess)}`;
    const parts = [];
    if (value.running) parts.push(`Đang chạy: ${value.phase || '…'}`);
    parts.push(line('Mua vào', value.directions.buy), line('Bán ra', value.directions.sell));
    parts.push(value.settings.enabled ? `tự chạy mỗi ${value.settings.intervalMinutes} phút cho ${value.settings.days} ngày gần nhất` : 'đang tắt tự động');
    const downloaded = (value.directions.buy.downloaded || 0) + (value.directions.sell.downloaded || 0);
    if (downloaded) parts.push(`lượt gần nhất tải ${downloaded} hoá đơn mới`);
    $('autosync-status').textContent = parts.join(' · ');
    if (!value.running && autoRunning && downloaded) announceNew(downloaded);
    autoRunning = !!value.running;
    $('autosync-run').disabled = !!value.running;
    if (value.running) startAutoSyncPolling();
    else if (autosyncPoll) { stopAutoSyncPolling(); await refreshAll(); }
  }

  async function openAutoSync() {
    if (!view || view !== 'data') showView('data');
    $('autosync-dialog').showModal();
    await loadAutoSync();
  }

  async function saveAutoSync() {
    try {
      await post('/api/db/autosync/settings', {
        enabled: $('autosync-enabled').checked,
        days: Number($('autosync-days').value) || 7,
        intervalMinutes: Number($('autosync-interval').value) || 30,
      });
      if (window.notice) window.notice('Đã lưu cấu hình Auto Sync.');
      await loadAutoSync();
    } catch (error) { fail(error); }
  }

  async function runAutoSyncNow() {
    try {
      const value = await post('/api/db/autosync/run', {});
      if (window.notice) window.notice(`Auto Sync đang chạy: ${value.phase || 'bắt đầu'}…`);
      startAutoSyncPolling();
      await loadAutoSync();
    } catch (error) { fail(error); }
  }

  // ------------------------------------------------------------------ Tải lịch sử
  function stopBackfillPolling() { if (backfillPoll) { clearInterval(backfillPoll); backfillPoll = null; } }
  function startBackfillPolling() {
    if (backfillPoll) return;
    backfillPoll = setInterval(() => loadBackfill().catch(() => {}), 1500);
  }

  function syncBackfillFields() {
    const mode = $('backfill-mode').value;
    $('backfill-year-label').hidden = mode === 'range';
    $('backfill-quarter-label').hidden = mode !== 'quarter';
    $('backfill-month-label').hidden = mode !== 'month';
    $('backfill-from-label').hidden = mode !== 'range';
    $('backfill-to-label').hidden = mode !== 'range';
  }

  async function loadBackfill() {
    const value = await api('/api/db/backfill/status');
    const bar = $('backfill-bar');
    const line = $('backfill-status');
    if (value.running) {
      bar.hidden = false;
      const progress = value.progress || {};
      bar.value = progress.total ? Math.round(100 * (progress.done || 0) / progress.total) : 5;
      line.textContent = `Đang tải lịch sử ${value.label} · ${value.current === 'SELL' ? 'Bán ra' : 'Mua vào'}`
        + (progress.message ? ` · ${progress.message}` : '')
        + ` · tìm ${value.totals.found}, tải ${value.totals.downloaded}, nhập ${value.totals.imported}, lỗi ${value.totals.errors}`;
      $('backfill-start').disabled = true;
      $('backfill-cancel').disabled = false;
      startBackfillPolling();
      return;
    }
    $('backfill-cancel').disabled = true;
    $('backfill-start').disabled = false;
    if (!value.finishedAt) { bar.hidden = true; line.textContent = 'Chưa chạy lần nào.'; return; }
    bar.hidden = false;
    bar.value = 100;
    const steps = (value.steps || []).map(step => `${step.direction === 'SELL' ? 'Bán ra' : 'Mua vào'}: ${step.cancelled ? 'đã dừng' : (step.ok ? `tìm ${step.found || 0}, tải ${step.downloaded || 0}, nhập ${step.imported || 0}` : `lỗi — ${step.error || ''}`)}`).join(' · ');
    line.textContent = `${value.cancelled ? 'Đã dừng' : (value.ok ? 'Xong' : 'Có lỗi')} ${value.label} · ${steps}`;
    if (backfillPoll) { stopBackfillPolling(); await refreshAll(); }
  }

  async function startBackfill() {
    const directions = $('backfill-directions').value;
    try {
      const value = await post('/api/db/backfill', {
        mode: $('backfill-mode').value,
        year: Number($('backfill-year').value) || undefined,
        quarter: Number($('backfill-quarter').value) || undefined,
        month: Number($('backfill-month').value) || undefined,
        from: $('backfill-from').value || undefined,
        to: $('backfill-to').value || undefined,
        directions: directions === 'both' ? ['BUY', 'SELL'] : [directions],
      });
      if (window.notice) window.notice(`Bắt đầu tải lịch sử ${value.plan.label}…`);
      await loadBackfill();
    } catch (error) { fail(error); }
  }

  async function cancelBackfill() {
    try {
      await post('/api/db/backfill/cancel', {});
      if (window.notice) window.notice('Đã yêu cầu dừng tải lịch sử.');
      await loadBackfill();
    } catch (error) { fail(error); }
  }

  // ------------------------------------------------------------------ gắn sự kiện
  function bind() {
    $('view-download').onclick = () => showView('download');
    $('view-data').onclick = () => showView('data');

    $('data-refresh').onclick = () => { savePrefs(); refreshAll(); };
    $('data-import').onclick = startImport;
    $('data-export').onclick = exportProducts;
    $('data-prev').onclick = () => { if (page > 0) { page -= 1; loadList().catch(fail); } };
    $('data-next').onclick = () => { page += 1; loadList().catch(fail); };
    $('data-size').onchange = () => { size = Number($('data-size').value) || 50; reloadAll(); };
    $('data-from').onchange = () => { range = { from: $('data-from').value, to: $('data-to').value, chip: 'custom' }; paintRange(); reloadAll(); };
    $('data-to').onchange = () => { range = { from: $('data-from').value, to: $('data-to').value, chip: 'custom' }; paintRange(); reloadAll(); };
    $('data-clear').onclick = () => {
      $('data-q').value = '';
      range = { from: '', to: '', chip: 'all' };
      tabState.products.dir = '';
      tabState.list.dir = '';
      tabState.partners.kind = 'all';
      for (const id of ['data-seg-products', 'data-seg-list']) for (const button of $(id).querySelectorAll('button')) button.classList.toggle('active', button.dataset.dir === 'all');
      for (const button of $('data-seg-partners').querySelectorAll('button')) button.classList.toggle('active', button.dataset.kind === 'all');
      paintRange();
      reloadAll();
    };
    for (const button of document.querySelectorAll('.data-chips button')) {
      button.onclick = () => { range = quickRange(button.dataset.range); paintRange(); reloadAll(); };
    }
    let typing = null;
    $('data-q').oninput = () => { clearTimeout(typing); typing = setTimeout(reloadAll, 250); };

    $('data-tab-products-btn').onclick = () => showDataTab('products');
    $('data-tab-list-btn').onclick = () => showDataTab('list');
    $('data-tab-partners-btn').onclick = () => showDataTab('partners');
    bindSegment('data-seg-products', button => { tabState.products.dir = button.dataset.dir === 'all' ? '' : button.dataset.dir; loadProducts().catch(fail); });
    bindSegment('data-seg-list', button => { tabState.list.dir = button.dataset.dir === 'all' ? '' : button.dataset.dir; page = 0; loadList().catch(fail); loadSummary().catch(fail); });
    bindSegment('data-seg-partners', button => { tabState.partners.kind = button.dataset.kind; loadPartners().catch(fail); });

    $('invoice-close').onclick = closeInvoice;
    $('invoice-print').onclick = printInvoice;
    $('invoice-dialog').addEventListener('close', () => { $('invoice-frame').src = 'about:blank'; });

    $('autosync-close').onclick = () => $('autosync-dialog').close();
    $('autosync-save').onclick = saveAutoSync;
    $('autosync-run').onclick = runAutoSyncNow;

    $('backfill-open').onclick = () => { $('backfill-dialog').showModal(); loadBackfill().catch(fail); };
    $('backfill-close').onclick = () => $('backfill-dialog').close();
    $('backfill-mode').onchange = syncBackfillFields;
    $('backfill-start').onclick = startBackfill;
    $('backfill-cancel').onclick = cancelBackfill;
    $('backfill-year').value = $('backfill-year').value || String(new Date().getFullYear());
    $('backfill-month').value = $('backfill-month').value || String(new Date().getMonth() + 1);
    syncBackfillFields();

    document.addEventListener('keydown', event => {
      if (view !== 'data' || $('invoice-dialog').open) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
      else if (event.key === 'Enter' && selectedKey) { event.preventDefault(); openInvoice(selectedKey); }
    });

    window.addEventListener('hd:state', event => {
      const next = event.detail || {};
      const changed = next.selected !== app.selected || next.output !== app.output;
      app = { ...app, ...next };
      if (changed) {
        selectedKey = '';
        newInvoices = 0;
        $('data-new-badge').hidden = true;
        page = 0;
        if (view === 'data') refreshAll();
      }
    });
  }

  restorePrefs();
  bind();
  fetch('/api/state').then(response => response.json()).then(result => { if (result && result.ok) app = result.value; }).catch(() => {});

  // Auto Sync / tự nhập có thể bắt đầu NGOÀI tab này (ví dụ ngay sau khi bấm Tải hóa đơn).
  setInterval(async () => {
    if (view === 'data') return;
    try {
      const status = await api('/api/db/import/status');
      if (status.running && !seenImportRunning) {
        seenImportRunning = true;
        if (window.notice) window.notice(`Đang nhập ${num.format(status.total)} file XML vào kho dữ liệu… mở tab “Kho dữ liệu” để xem tiến độ.`);
      }
      if (!status.running) {
        if (seenImportRunning && status.imported) announceNew(status.imported);
        seenImportRunning = false;
      }
    } catch { /* lần sau thử lại */ }
  }, 3000);

  window.HD_DATA_VIEW = { show: showView, refresh: refreshAll, openAutoSync };
})();
