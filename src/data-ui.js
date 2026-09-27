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
  const PERIOD_KEY = 'hoadon.data.period';
  // Nhãn menu xuất Excel (dùng cho thông báo sau khi xuất).
  const PART_LABEL = { all: 'toàn bộ kho dữ liệu', buy: 'hóa đơn mua vào', sell: 'hóa đơn bán ra', productsBuy: 'hàng hóa mua vào', productsSell: 'hàng hóa bán ra', suppliers: 'nhà cung cấp', buyers: 'khách hàng' };

  let app = {};
  let view = 'download';
  let page = 0;
  let size = 50;
  let total = 0;
  let rows = [];
  let selectedKey = '';
  let products = [];
  let range = { from: '', to: '', chip: 'all' };
  let periodLabel = '';
  // Mỗi bảng có lựa chọn chiều riêng, không dùng chung một ô lọc.
  const tabState = { products: { dir: '' }, list: { dir: '', state: 'all' }, partners: { kind: 'all' }, bank: { flow: '' } };
  // Bộ lọc RIÊNG của tab Sao kê ngân hàng (không dùng chung với Kho dữ liệu).
  let bankRange = { from: '', to: '' };
  let bankPage = 0;
  let bankTotal = 0;
  let importPoll = null;
  let autosyncPoll = null;
  let backfillPoll = null;
  let seenImportRunning = false;
  let autoRunning = false;
  // Cờ "đang sửa trong hộp Auto Sync": bật khi người dùng đụng vào ô cấu hình, tắt khi lưu/đóng.
  // loadAutoSync dùng cờ này để không ghi đè giá trị người dùng đang gã (xem loadAutoSync).
  let syncEditing = false;
  let newInvoices = 0;
  let activeDataTab = 'products';
  let changeRevision = -1;
  let changePollBusy = false;
  const requests = new Map();

  // Phản hồi tức thì + chống bấm đúp cho nút gọi máy chủ (lưu cấu hình, chạy ngay…): khoá nút và
  // đổi nhãn NGAY lúc bấm — cùng cơ chế busyButton của renderer.js/app-settings.js/chat-widget.js.
  function busyButton(button, label) {
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    return () => { button.disabled = false; if (button.textContent === label) button.textContent = original; };
  }
  const fail = error => {
    if (window.noticeFail) window.noticeFail(error.message);
    else if (window.notice) window.notice(error.message);
    else console.error(error);
  };
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
  // Huỷ yêu cầu cũ là chuyện BÌNH THƯỜNG (bấm nhanh, đổi tab, lật trang…), nhưng trình duyệt báo
  // lỗi huỷ với tên/mã/message khác nhau — Chrome: "signal is aborted without reason", Node: AbortError…
  // Gộp về một chỗ để lỗi huỷ KHÔNG bao giờ hiện lên người dùng.
  const isAbort = error => !!error && (error.name === 'AbortError' || error.code === 20 || /abort/i.test(String(error.message || '')));
  const ignoreAbort = error => { if (!isAbort(error)) fail(error); };
  const aborted = () => Object.assign(new Error('Yêu cầu đã được thay thế.'), { name: 'AbortError' });
  async function latestApi(channel, path) {
    const previous = requests.get(channel);
    if (previous) previous.abort();
    const controller = new AbortController();
    requests.set(channel, controller);
    try {
      return await api(path, { signal: controller.signal });
    } catch (error) {
      // Chính yêu cầu này đã bị huỷ (hoặc là lỗi huỷ) ⇒ trả AbortError chuẩn để call site bỏ qua.
      if (controller.signal.aborted || isAbort(error)) throw aborted();
      throw error;
    } finally {
      if (requests.get(channel) === controller) requests.delete(channel);
    }
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  // ------------------------------------------------------------------ điều hướng
  function showView(next) {
    view = next;
    $('pane-download').hidden = next !== 'download';
    $('pane-data').hidden = next !== 'data';
    $('pane-bank').hidden = next !== 'bank';
    for (const [id, name] of [['view-download', 'download'], ['view-data', 'data'], ['view-bank', 'bank']]) {
      const button = $(id);
      button.classList.toggle('active', name === next);
      button.setAttribute('aria-selected', name === next ? 'true' : 'false');
    }
    if (next === 'data') refreshAll();
    if (next === 'bank') refreshBank();
  }

  // ------------------------------------------------------------------ Mã định danh của "cùng một người" (MST gốc ↔ CCCD) — chỉ THÔNG BÁO
  // KHÔNG có panel hỏi/gán tay: hệ thống TỰ SO TÊN (bỏ dấu, bỏ "HỘ KINH DOANH"…) giữa mã lạ
  // trong XML với tên hồ sơ/kho; trùng thì TỰ GÁN vào định danh hồ sơ + nhập lại hoá đơn đang
  // bỏ qua, và CHỈ hiện MỘT thông báo. Không trùng ⇒ im lặng hoàn toàn (mã lạ vẫn ghi vết
  // trong ma-chua-xac-dinh.json để chẩn đoán, nhưng UI không hiện gì).
  const announcedAutoAssign = new Set(); // không nhắc lại mỗi nhịp poll cho cùng một mã
  async function loadCandidates() {
    const value = await api('/api/db/identity-candidates');
    const assigned = (value.autoAssigned || []).filter(code => !announcedAutoAssign.has(code));
    if (assigned.length && window.notice) {
      for (const code of assigned) announcedAutoAssign.add(code);
      window.notice(`Đã phát hiện trùng MST/CCCD của cùng một người: ${assigned.join(', ')} — đã gán vào hồ sơ và nhập lại các hoá đơn còn bỏ qua.`);
    }
  }

  async function refreshAll() {
    try {
      const visible = activeDataTab === 'products' ? loadProducts()
        : (activeDataTab === 'list' ? loadList() : loadPartners());
      await Promise.all([loadSummary(), visible, loadImportStatus(), loadAutoSync(), loadBackfill()]);
      // Panel mã chưa gán chỉ cần khi vào tab; lỗi của nó không được làm sập refreshAll.
      await loadCandidates().catch(() => {});
    } catch (error) { if (!isAbort(error)) fail(error); }
  }

  async function refreshVisibleData() {
    await loadSummary();
    if (activeDataTab === 'products') await loadProducts();
    else if (activeDataTab === 'list') await loadList();
    else await loadPartners();
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
    $('data-tax-note').textContent = '';
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

  // Chọn nhanh theo Năm / Quý / Tháng — dùng chung công thức ngày với tab Tra cứu & tải (src/period.js).
  function syncPeriodOptions() {
    const now = new Date();
    const years = [];
    for (let year = now.getFullYear() + 1; year >= now.getFullYear() - 12; year -= 1) years.push(String(year));
    $('data-period-year').replaceChildren(...years.map(year => new Option(year, year)));
    $('data-period-month').replaceChildren(...Array.from({ length: 12 }, (_, i) => new Option(`Tháng ${i + 1}`, String(i + 1))));
    $('data-period-quarter').replaceChildren(...Array.from({ length: 4 }, (_, i) => new Option(`Quý ${i + 1}`, String(i + 1))));
    $('data-period-year').value = String(now.getFullYear());
    $('data-period-month').value = String(now.getMonth() + 1);
    $('data-period-quarter').value = String(Math.floor(now.getMonth() / 3) + 1);
    paintPeriodMode();
  }

  function paintPeriodMode() {
    const mode = $('data-period-mode').value;
    $('data-period-month').hidden = mode !== 'month';
    $('data-period-quarter').hidden = mode !== 'quarter';
  }

  // Áp khoảng ngày của kỳ đã chọn rồi tải lại bảng đang mở. Nhãn hiện đúng kiểu:
  // "2023" · "Quý 1 2023" · "Tháng 1 2023".
  function applyPeriod() {
    const mode = $('data-period-mode').value;
    const year = Number($('data-period-year').value);
    const unit = mode === 'quarter' ? Number($('data-period-quarter').value) : Number($('data-period-month').value);
    const chosen = window.Period.rangeFor(mode, year, unit);
    range = { from: chosen.from, to: chosen.to, chip: 'period' };
    periodLabel = mode === 'year' ? String(year) : (mode === 'quarter' ? `Quý ${unit} ${year}` : `Tháng ${unit} ${year}`);
    savePrefs();
    paintRange();
    reloadAll();
  }

  function paintRange() {
    for (const button of document.querySelectorAll('.data-chips button')) button.classList.toggle('active', button.dataset.range === range.chip);
    $('data-from').value = range.from;
    $('data-to').value = range.to;
    $('data-period-label').textContent = range.chip === 'period' ? periodLabel : '';
  }

  function savePrefs() {
    try {
      localStorage.setItem(RANGE_KEY, JSON.stringify({ range, size }));
      localStorage.setItem(PERIOD_KEY, JSON.stringify({
        label: periodLabel,
        mode: $('data-period-mode').value,
        year: $('data-period-year').value,
        month: $('data-period-month').value,
        quarter: $('data-period-quarter').value,
      }));
    } catch { /* chế độ riêng tư */ }
  }

  function restorePrefs() {
    syncPeriodOptions();
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || '{}');
      if (saved.range && typeof saved.range === 'object') range = { from: saved.range.from || '', to: saved.range.to || '', chip: saved.range.chip || 'all' };
      const savedSize = Number(localStorage.getItem(SIZE_KEY));
      if ([50, 100, 200].includes(savedSize)) size = savedSize;
      const savedPeriod = JSON.parse(localStorage.getItem(PERIOD_KEY) || '{}');
      if (savedPeriod.mode) {
        $('data-period-mode').value = savedPeriod.mode;
        if (savedPeriod.year) $('data-period-year').value = savedPeriod.year;
        if (savedPeriod.month) $('data-period-month').value = savedPeriod.month;
        if (savedPeriod.quarter) $('data-period-quarter').value = savedPeriod.quarter;
        periodLabel = String(savedPeriod.label || '');
      }
    } catch { /* bỏ qua */ }
    paintPeriodMode();
    $('data-size').value = String(size);
    paintRange();
  }

  function activeFilters() {
    return { q: $('data-q').value.trim(), from: range.from, to: range.to };
  }

  function reloadAll() {
    page = 0; savePrefs();
    const loading = activeDataTab === 'products' ? loadProducts()
      : (activeDataTab === 'list' ? loadList() : loadPartners());
    loading.catch(ignoreAbort);
  }

  // ------------------------------------------------------------------ danh sách hoá đơn
  // Hiệu ứng "đang tải" trên BẢNG ĐANG MỞ: mờ + khoá tương tác. Chỉ hiệu ứng vẽ — dữ liệu vẫn do
  // AbortController của latestApi đảm bảo là của lần bấm mới nhất (không đổi logic tải).
  function paintTableLoading(loading) {
    const table = document.querySelector('#data-tab-' + activeDataTab + ' table');
    if (table) table.classList.toggle('loading', !!loading);
  }

  async function loadList() {
    paintTableLoading(true);
    try {
    const filters = activeFilters();
    const params = new URLSearchParams({ ...filters, direction: tabState.list.dir, state: tabState.list.state === 'all' ? '' : tabState.list.state, limit: String(size), offset: String(page * size) });
    const value = await latestApi('list', `/api/db/invoices?${params.toString()}`);
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
      // Trạng thái đến từ kết quả tra cứu (XML không mang) — server gắn nhãn sẵn, cùng nguồn với Excel.
      tr.append(td(inv.stateLabel || ''));
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
    finally { paintTableLoading(false); }
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
    activeDataTab = name;
    for (const one of ['products', 'list', 'partners']) $('data-tab-' + one).hidden = one !== name;
    for (const [key, id] of [['products', 'data-tab-products-btn'], ['list', 'data-tab-list-btn'], ['partners', 'data-tab-partners-btn']]) {
      const button = $(id);
      button.classList.toggle('active', key === name);
      button.setAttribute('aria-selected', key === name ? 'true' : 'false');
    }
    if (name === 'products') loadProducts().catch(ignoreAbort);
    if (name === 'list') loadList().catch(ignoreAbort);
    if (name === 'partners') loadPartners().catch(ignoreAbort);
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
    paintTableLoading(true);
    try {
    const filters = activeFilters();
    const params = new URLSearchParams({ ...filters, direction: tabState.products.dir, limit: '200' });
    const value = await latestApi('products', `/api/db/products?${params.toString()}`);
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
    finally { paintTableLoading(false); }
  }

  // ------------------------------------------------------------------ đối tác
  async function loadPartners() {
    paintTableLoading(true);
    try {
    // Tab Đối tác là DANH BẠ đối tác: tổng hợp mọi hoá đơn đã nhập, KHÔNG lọc theo kỳ
    // — đúng như sheet "Nhà cung cấp"/"Khách hàng" trong file Excel xuất ra.
    const value = await latestApi('partners', `/api/db/partners?kind=${encodeURIComponent(tabState.partners.kind)}&limit=200`);
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
    finally { paintTableLoading(false); }
  }

  // Xuất Excel "Kho dữ liệu" — máy chủ dựng workbook từ SQLite, tôn trọng ĐÚNG bộ lọc đang xem
  // (q + khoảng ngày). part = 'all' (6 bảng) hoặc một mã bảng để xuất RIÊNG bảng đó.
  let exportBusy = false; // chống bấm đúp: một lượt xuất Excel đang chạy thì cú bấm thêm bị bỏ qua
  async function exportExcel(part) {
    const summary = $('data-export');
    const chosen = part || 'all';
    if (exportBusy) return;
    exportBusy = true;
    const filters = activeFilters();
    const params = new URLSearchParams({ q: filters.q || '', from: filters.from || '', to: filters.to || '', state: tabState.list.state === 'all' ? '' : (tabState.list.state || '') });
    if (chosen !== 'all') params.set('parts', chosen);
    const label = summary.textContent;
    summary.setAttribute('aria-busy', 'true');
    summary.textContent = 'Đang xuất…';
    try {
      const response = await fetch(`/api/db/export?${params.toString()}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `Không xuất được Excel (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const counts = JSON.parse(response.headers.get('X-Export-Counts') || '{}');
      const now = new Date();
      const pad = value => String(value).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kho-du-lieu-${chosen === 'all' ? '' : `${chosen}-`}${app.selected || 'MST'}-${stamp}.xlsx`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      // Chỉ kể ra những bảng THỰC SỰ có trong file vừa xuất.
      const pieces = [];
      if ('buy' in counts) pieces.push(`${num.format(counts.buy)} HĐ mua vào`);
      if ('sell' in counts) pieces.push(`${num.format(counts.sell)} HĐ bán ra`);
      if ('productsBuy' in counts) pieces.push(`${num.format(counts.productsBuy)} mặt hàng mua vào`);
      if ('productsSell' in counts) pieces.push(`${num.format(counts.productsSell)} mặt hàng bán ra`);
      if ('suppliers' in counts) pieces.push(`${num.format(counts.suppliers)} nhà cung cấp`);
      if ('buyers' in counts) pieces.push(`${num.format(counts.buyers)} khách hàng`);
      if (window.notice) window.notice(`Đã xuất ${PART_LABEL[chosen] || chosen}: ${pieces.join(' · ') || 'không có dòng nào theo bộ lọc này'}.`);
    } catch (error) {
      if (!isAbort(error)) fail(error);
    } finally {
      summary.removeAttribute('aria-busy');
      summary.textContent = label;
      exportBusy = false;
    }
  }

  // ------------------------------------------------------------------ nhập XML
  function renderImport(status) {
    const bar = $('data-import-bar');
    const line = $('data-import-status');
    // Hoá đơn không còn hiệu lực (bị thay thế / bị điều chỉnh / đã huỷ) VẪN nằm trong kho — chỉ
    // không cộng vào hàng hoá và tổng tiền. Hiện số ra đây để hiểu vì sao tổng lệch số hoá đơn.
    const inactive = status.inactive ? ` · ${num.format(status.inactive)} HĐ không còn hiệu lực (không cộng vào hàng hóa)` : '';
    if (status.running) {
      bar.hidden = false;
      bar.value = status.total ? Math.round(100 * status.scanned / status.total) : 0;
      line.textContent = `Đang nhập ${num.format(status.scanned)}/${num.format(status.total)} file · mới ${status.imported} · cập nhật ${status.updated || 0} · trùng ${status.duplicates} · bỏ qua ${status.skipped}${inactive} · lỗi ${status.errors}${status.current ? ` · ${status.current}` : ''}`;
      return;
    }
    if (status.finishedAt) {
      bar.hidden = false;
      bar.value = 100;
      line.textContent = status.total
        ? `Nhập xong ${num.format(status.total)} file · mới ${status.imported}, cập nhật ${status.updated || 0}, trùng ${status.duplicates}, bỏ qua ${status.skipped}${inactive}, lỗi ${status.errors} · ${num.format(status.itemsTotal)} dòng hàng hóa.`
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
      if (document.hidden) return; // trang ẩn: không fetch, giữ timer để cập nhật khi hiện lại
      try {
        const status = await api('/api/db/import/status');
        renderImport(status);
        if (!status.running) { stopImportPolling(); if (status.imported || status.updated) announceNew((status.imported || 0) + (status.updated || 0)); await refreshAll(); }
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
    autosyncPoll = setInterval(() => { if (!document.hidden) loadAutoSync().catch(() => {}); }, 1500);
  }

  async function loadAutoSync() {
    const value = await api('/api/db/autosync/status');
    // Người dùng đang gã/sửa trong hộp thoại thì KHÔNG ghi đè ô nhập bằng giá trị server (nếu không
    // gã của họ biến mất giữa chừng sau mỗi nhịp poll). Chỉ áp giá trị khi hộp thoại vừa mở hoặc
    // sau khi lưu — hộp đóng là không ai đang xem, áp tự do để cấu hình mới từ nơi khác vẫn tới.
    const dialogOpen = $('autosync-dialog').open;
    if (!dialogOpen || !syncEditing) {
      $('autosync-enabled').checked = !!value.settings.enabled;
      $('autosync-days').value = value.settings.days;
      $('autosync-interval').value = value.settings.intervalMinutes;
    }
    $('autosync-mst').textContent = value.mst ? `MST ${value.mst} · tự tra cứu → tải XML còn thiếu → nhập vào kho dữ liệu.` : 'Chọn một MST ở cột bên trái trước.';
    // Trạng thái cuối LUÔN kèm mốc thời gian đã ghi; mốc này được ghi lại mỗi lượt Auto Sync.
    const line = (label, state) => {
      if (state.status === 'error') return `${label}: lỗi${state.lastErrorTime ? ` (${shortWhen(state.lastErrorTime)})` : ''} — ${state.lastError || ''}`;
      return `${label}: ${shortWhen(state.lastSuccess)}`;
    };
    const parts = [];
    if (value.running) parts.push(`Đang chạy: ${value.phase || '…'}`);
    parts.push(line('Mua vào', value.directions.buy), line('Bán ra', value.directions.sell));
    parts.push(`giãn cách mỗi MST ${value.settings.intervalMinutes} phút`);
    // CHẠY NỀN: hai cổng là KHUNG GIỜ và CỬA SỔ APP ĐÃ ĐÓNG (src/data/sync-scheduler.js).
    // Hiện một dòng chữ gọn — không hộp thoại, không tiếng — để không làm phiền người dùng.
    const win = value.window;
    if (win && win.windows && win.windows.length) {
      const span = win.windows.map(w => `${w.from}–${w.to || '…'}`).join(', ');
      const state = win.phase === 'running' ? `đang chạy nền MST ${win.mst}` : (win.reason || 'chờ');
      parts.push(`chạy nền ${span}: ${state}`);
    }
    // BỂ "Đồng bộ tất cả" do người dùng bấm: hiện số luồng đang chạy để thấy nó luôn giữ đủ 3.
    const pool = value.pool;
    if (pool && (pool.running || (pool.done || []).length || (pool.failed || []).length)) {
      parts.push(pool.running
        ? `đồng bộ tất cả: ${(pool.active || []).length}/${pool.concurrency} luồng · còn ${(pool.queued || []).length} chờ`
        : `đồng bộ tất cả: ${(pool.done || []).length} xong${(pool.failed || []).length ? `, ${pool.failed.length} lỗi` : ''}`);
    }
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
    // Khoá nút + nhãn "Đang lưu…" NGAY lúc bấm (busyButton) — chống bấm đúp và cho phản hồi tức thì.
    const restore = busyButton($('autosync-save'), 'Đang lưu…');
    try {
      await post('/api/db/autosync/settings', {
        enabled: $('autosync-enabled').checked,
        days: Number($('autosync-days').value) || 7,
        intervalMinutes: Number($('autosync-interval').value) || 30,
      });
      syncEditing = false; // đã lưu: giá trị server giờ là mới nhất, cho áp lại bình thường
      if (window.notice) window.notice('Đã lưu cấu hình Auto Sync.');
      await loadAutoSync();
    } catch (error) { fail(error); }
    finally { restore(); }
  }

  async function runAutoSyncNow() {
    // Khoá nút + nhãn "Đang khởi động…" NGAY lúc bấm — chống bấm đúp gửi lệnh chạy 2 lần.
    const restore = busyButton($('autosync-run'), 'Đang khởi động…');
    try {
      const value = await post('/api/db/autosync/run', {});
      if (window.notice) window.notice(`Auto Sync đang chạy: ${value.phase || 'bắt đầu'}…`);
      startAutoSyncPolling();
      await loadAutoSync();
    } catch (error) { fail(error); }
    finally { restore(); }
  }

  // ------------------------------------------------------------------ Tải lịch sử
  function stopBackfillPolling() { if (backfillPoll) { clearInterval(backfillPoll); backfillPoll = null; } }
  function startBackfillPolling() {
    if (backfillPoll) return;
    backfillPoll = setInterval(() => { if (!document.hidden) loadBackfill().catch(() => {}); }, 1500);
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
    // busyButton khoá nút + nhãn "Đang khởi động…" NGAY lúc bấm: trước đây chỉ disable SAU khi
    // fetch trả về nên cú bấm đúp trong khe hở ấy gửi 2 lệnh chạy (máy chủ phải tự lọc).
    const restore = busyButton($('backfill-start'), 'Đang khởi động…');
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
    finally { restore(); }
  }

  async function cancelBackfill() {
    try {
      await post('/api/db/backfill/cancel', {});
      if (window.notice) window.notice('Đã yêu cầu dừng tải lịch sử.');
      await loadBackfill();
    } catch (error) { fail(error); }
  }

  // ------------------------------------------------------------------ sao kê ngân hàng (TAB RIÊNG ở header)
  // Gán theo MST: máy chủ mở data.db của MST đang chọn — click MST nào thấy sao kê MST đó.
  // Bộ lọc RIÊNG (tìm kiếm, từ/đến ngày, khoảng tiền, chiều vào/ra), không dùng chung với Kho dữ liệu.
  function bankFilters() {
    const min = $('data-bank-min').value.trim();
    const max = $('data-bank-max').value.trim();
    return {
      q: $('data-bank-q').value.trim(),
      from: bankRange.from, to: bankRange.to,
      min: min === '' ? '' : String(Number(min) || 0),
      max: max === '' ? '' : String(Number(max) || 0),
    };
  }

  function paintBankTiles(summary) {
    const tiles = $('data-bank-tiles');
    tiles.replaceChildren();
    const show = (label, value, kind) => {
      const box = document.createElement('div');
      box.className = kind ? `data-tile ${kind}` : 'data-tile';
      box.append(Object.assign(document.createElement('span'), { textContent: label }));
      box.append(Object.assign(document.createElement('strong'), { textContent: value }));
      tiles.append(box);
    };
    const ky = summary.from ? `${shortDay(summary.from)} → ${shortDay(summary.to)}` : '—';
    show('MST', app.selected || '—');
    show('Khoảng ngày', ky, 'range');
    show('Giao dịch', num.format(summary.transactions || 0));
    show('Tiền vào', num.format(summary.moneyIn || 0), 'bank-in');
    show('Tiền ra', num.format(summary.moneyOut || 0), 'bank-out');
    show('File đã nhập', num.format(summary.files || 0), 'time');
  }

  async function refreshBank() {
    await loadBankSummary().catch(error => { if (!isAbort(error)) fail(error); });
    await loadBank().catch(ignoreAbort);
  }

  async function loadBankSummary() {
    paintBankTiles(await latestApi('bankSummary', '/api/db/bank/summary'));
  }

  // Cùng cơ chế với các bảng khác: mờ khi tải, AbortController huỷ request cũ, phân trang riêng.
  async function loadBank() {
    const card = document.querySelector('#pane-bank .table-card');
    if (card) card.classList.toggle('loading', true);
    try {
      const filters = bankFilters();
      const params = new URLSearchParams({ ...filters, flow: tabState.bank.flow, limit: String(size), offset: String(bankPage * size) });
      const value = await latestApi('bank', `/api/db/bank/transactions?${params.toString()}`);
      bankTotal = value.total || 0;
      const body = $('data-bank-rows');
      body.replaceChildren();
      for (const [index, tran] of (value.rows || []).entries()) {
        const tr = document.createElement('tr');
        tr.append(td(String(bankPage * size + index + 1), 'stt'));
        tr.append(td(shortDay(tran.tran_date)));
        tr.append(td(tran.description || ''));
        tr.append(td(tran.counterparty_name || ''));
        tr.append(td(tran.reference || ''));
        tr.append(td(tran.credit == null ? '—' : num.format(tran.credit), 'num in'));
        tr.append(td(tran.debit == null ? '—' : num.format(tran.debit), 'num out'));
        tr.append(td(tran.balance == null ? '—' : num.format(tran.balance), 'num'));
        tr.append(td(tran.file_name || ''));
        tr.title = 'Đối ứng: ' + (tran.counterparty_account || '—') + (tran.detail ? ' · ' + tran.detail : '');
        body.append(tr);
      }
      const pages = Math.max(1, Math.ceil(bankTotal / size));
      if (bankPage >= pages) bankPage = pages - 1;
      $('data-bank-count').textContent = `${num.format(bankTotal)} giao dịch`;
      $('data-bank-page').textContent = `Trang ${bankPage + 1} / ${pages}`;
      $('data-bank-prev').disabled = bankPage <= 0;
      $('data-bank-next').disabled = bankPage + 1 >= pages;
    }
    finally { if (card) card.classList.toggle('loading', false); }
  }

  // Nhập file sao kê — LUỒNG 3 BƯỚC (chống up nhầm MST + kiểm tra số liệu trước khi lưu):
  // 1) XÁC NHẬN: hiện tên MST + tên hộ KD/công ty, user OK mới đọc file.
  // 2) ĐỌC + KIỂM TRA: Excel/CSV/PDF-chữ đọc local (BankPdf); PDF scan/ảnh gửi server gọi AI.
  //    Server chuẩn hoá + kiểm tra số dư liên mạch, TRẢ VỀ KẾT QUẢ — chưa ghi gì vào DB.
  // 3) XÁC NHẬN LƯU: khớp → lưu; lệch → hiện chi tiết dòng sai, user chọn "Vẫn lưu"/"Huỷ".
  async function importBankFile() {
    // Bước 0: lấy MST + tên công ty NGAY trong lần bấm nút (hộp file phải mở cùng lượt bấm).
    const state = await api('/api/state?items=0').catch(() => null);
    const mst = (state && state.selected) || (app.selected || '');
    const company = (state && state.companyName) || app.companyName || '';
    if (!mst) { if (window.notice) window.notice('Chọn một MST trước khi nhập file sao kê.'); return; }
    const label = company ? `MST ${mst} — ${company}` : `MST ${mst}`;
    if (!confirm(`Nhập file sao kê cho đúng tài khoản này?

${label}

Bấm OK rồi chọn file. Nếu SAI tài khoản, bấm Huỷ và chọn MST khác trước.`)) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const bar = $('data-bank-bar');
      const note = $('data-bank-note');
      const setProgress = (value, text) => { bar.hidden = value === null; if (value !== null) bar.value = value; note.textContent = text; };
      $('data-bank-import').disabled = true;
      try {
        // Bước 2: đọc theo loại file.
        setProgress(20, `Đang đọc ${file.name}…`);
        const parsed = await window.BankPdf.readAny(file);
        let preview;
        if (parsed.kind === 'excel') {
          const dataBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error('Đọc file không được.'));
            reader.readAsDataURL(file);
          });
          setProgress(45, `Đang chuẩn hoá + kiểm tra ${file.name}…`);
          preview = await post('/api/db/bank/preview', { fileName: file.name, data: dataBase64 });
        } else if (parsed.kind === 'pdf-text') {
          setProgress(45, `Đã đọc PDF có chữ (${parsed.pages} trang) — đang chuẩn hoá + kiểm tra…`);
          preview = await post('/api/db/bank/preview-rows', { fileName: file.name, rows: parsed.grid });
        } else if (parsed.kind === 'pdf-scan' || parsed.kind === 'image') {
          const dataBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = () => reject(new Error('Đọc file không được.'));
            reader.readAsDataURL(file);
          });
          setProgress(40, parsed.kind === 'image' ? 'Đang gửi ảnh cho AI đọc… (có thể mất tới 1 phút)' : 'PDF không có chữ (scan) — đang gửi AI đọc… (có thể mất tới 1 phút)');
          preview = await post('/api/db/bank/preview', { fileName: file.name, data: dataBase64 });
        } else {
          throw new Error('Chỉ nhận file .xlsx, .xls, .csv, .pdf, .png hoặc .jpg.');
        }

        // Bước 3: hiện kết quả kiểm tra, user quyết định.
        const verification = preview.verification || {};
        const stats = verification.stats || {};
        const summary = `File: ${file.name}
Tài khoản: ${label}

Đọc được ${stats.rows || 0} giao dịch.
Tổng tiền vào: ${num.format(stats.moneyIn || 0)}
Tổng tiền ra: ${num.format(stats.moneyOut || 0)}
` + (stats.balanceChecks ? `Kiểm tra số dư: ${stats.balanceChecks} cặp dòng — ${stats.balanceBreaks ? 'LỆCH ' + stats.balanceBreaks + ' chỗ!' : 'khớp.'}
` : `File không có cột số dư — kiểm tra mức nhẹ (đủ ngày, đủ tiền).`);
        if (verification.level === 'error' || !(stats.rows > 0)) {
          throw new Error(`File không đọc ra giao dịch nào hợp lệ.${(verification.issues || []).length ? '\n' + verification.issues.join('\n') : ''}`);
        }
        let confirmed;
        if (verification.level === 'warn') {
          confirmed = confirm(`${summary}
CẢNH BÁO: phát hiện vấn đề:
${(verification.issues || []).join('\n')}

Bấm OK = VẪN LƯU vào MST ${mst}. Bấm Huỷ = bỏ, không lưu gì.`);
        } else {
          confirmed = confirm(`${summary}
Số liệu KHỚP. Lưu vào MST ${mst}?

(OK = lưu · Huỷ = bỏ)`);
        }
        if (!confirmed) { setProgress(null, `Đã bỏ ${file.name} — không lưu gì vào kho.`); return; }

        setProgress(80, `Đang lưu ${file.name} vào kho MST ${mst}…`);
        const result = await post('/api/db/bank/import-rows', { fileName: file.name, fileHash: preview.fileHash || '', rows: preview.rows });
        setProgress(100, `Đã lưu ${file.name}: mới ${num.format(result.imported)}, trùng ${num.format(result.duplicate)}, lỗi ${num.format(result.failed)}.`);
        if (window.notice) window.notice(`Đã nhập sao kê ${file.name} vào MST ${mst}: ${num.format(result.imported)} giao dịch mới, ${num.format(result.duplicate)} trùng, ${num.format(result.failed)} dòng lỗi.`);
        bankPage = 0;
        await loadBankSummary().catch(ignoreAbort);
        await loadBank();
      } catch (error) {
        setProgress(null, `Lỗi nhập ${file.name}: ${error.message}`);
        fail(error);
      } finally {
        $('data-bank-import').disabled = false;
      }
    };
    input.click();
  }

  // ---- Hộp quản lý file sao kê: Xoá từng file / Chuyển sang MST khác ----
  async function openBankFiles() {
    $('bank-file-dialog').showModal();
    await loadBankFiles().catch(error => fail(error));
  }

  async function loadBankFiles() {
    const status = $('bank-file-status');
    status.textContent = 'Đang tải danh sách file…';
    const [summary, files] = await Promise.all([
      api('/api/db/bank/summary'),
      api('/api/db/bank/files').then(v => v.rows || []),
    ]);
    const mst = app.selected || '';
    const company = app.companyName || '';
    status.textContent = files.length
      ? `${files.length} file · ${num.format(summary.transactions || 0)} giao dịch của MST ${mst}${company ? ' — ' + company : ''}.`
      : 'Chưa có file sao kê nào trong kho của MST này.';
    const body = $('bank-file-rows');
    body.replaceChildren();
    const mstOptions = (app.accounts || []).filter(a => a.mst && a.mst !== mst).map(a => a.mst);
    for (const file of files) {
      const tr = document.createElement('tr');
      tr.append(td(file.file_name || '(không tên)'));
      tr.append(td(num.format(file.rows_imported || 0), 'num'));
      tr.append(td(num.format(file.rows_duplicate || 0), 'num'));
      tr.append(td(num.format(file.rows_error || 0), 'num'));
      tr.append(td(file.period_from ? `${shortDay(file.period_from)} → ${shortDay(file.period_to)}` : '—'));
      const actions = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'danger'; del.textContent = 'Xoá';
      del.title = 'Xoá file này và toàn bộ giao dịch của nó khỏi kho MST này.';
      del.onclick = async () => {
        if (!confirm(`Xoá file "${file.file_name}" khỏi MST ${mst}?
Xoá luôn ${num.format(file.rows_imported || 0)} giao dịch của file này. Không thể hoàn tác.`)) return;
        del.disabled = true;
        try {
          await post('/api/db/bank/delete', { fileId: file.id });
          if (window.notice) window.notice(`Đã xoá ${file.file_name}.`);
          await loadBankFiles();
          await loadBankSummary().catch(ignoreAbort);
          await loadBank().catch(ignoreAbort);
        } catch (error) { fail(error); del.disabled = false; }
      };
      const move = document.createElement('button');
      move.type = 'button'; move.className = 'secondary'; move.textContent = 'Chuyển MST…';
      move.title = 'Chuyển toàn bộ giao dịch của file này sang kho của MST khác.';
      if (!mstOptions.length) { move.disabled = true; move.title = 'Không có MST nào khác trong danh sách.'; }
      move.onclick = async () => {
        const toMst = prompt(`Chuyển "${file.file_name}" sang MST nào?
Các MST đang có: ${mstOptions.join(', ') || '(không có MST nào khác)'}`);
        if (!toMst) return;
        if (!mstOptions.includes(toMst.trim())) { if (window.notice) window.notice(`MST "${toMst}" không có trong danh sách hồ sơ.`); return; }
        move.disabled = true;
        try {
          const result = await post('/api/db/bank/move', { fileId: file.id, toMst: toMst.trim() });
          if (window.notice) window.notice(`Đã chuyển ${file.file_name} sang MST ${result.toMst}: ${num.format(result.moved)} giao dịch, trùng bỏ qua ${num.format(result.duplicate)}.`);
          await loadBankFiles();
          await loadBankSummary().catch(ignoreAbort);
          await loadBank().catch(ignoreAbort);
        } catch (error) { fail(error); move.disabled = false; }
      };
      actions.append(del, move);
      tr.append(actions);
      body.append(tr);
    }
  }

  async function deleteBankFile() {
    // Xoá TOÀN BỘ sao kê đã nhập của MST đang chọn (dùng khi nhập nhầm).
    const value = await api('/api/db/bank/summary').catch(() => null);
    if (!value || !value.files) { if (window.notice) window.notice('Chưa có file sao kê nào để xoá.'); return; }
    if (!confirm(`Xoá toàn bộ sao kê ngân hàng của MST này (${num.format(value.transactions)} giao dịch, ${value.files} file)?`)) return;
    try {
      for (const file of await api('/api/db/bank/files').then(v => v.rows || [])) {
        await post('/api/db/bank/delete', { fileId: file.id });
      }
      if (window.notice) window.notice('Đã xoá toàn bộ sao kê ngân hàng của MST này.');
      bankPage = 0;
      await loadBankSummary().catch(ignoreAbort);
      await loadBank();
    } catch (error) { fail(error); }
  }

  // ------------------------------------------------------------------ gắn sự kiện
  function bind() {
    $('view-download').onclick = () => showView('download');
    $('view-data').onclick = () => showView('data');
    $('view-bank').onclick = () => showView('bank');

    // "Tải lại": nhãn "Đang tải…" NGAY lúc bấm — 5 request song song dưới đây mất vài trăm ms
    // tới vài giây, trước đây bấm xong nút đứng im khiến người dùng bấm thêm nhiều lần.
    $('data-refresh').onclick = () => {
      const restore = busyButton($('data-refresh'), 'Đang tải…');
      savePrefs();
      void refreshAll().finally(restore);
    };
    $('data-import').onclick = startImport;
    // Menu "Xuất Excel": "Tải toàn bộ" hoặc mở từng nhóm (Hóa đơn / Hàng hóa / Đối tác)
    // rồi chọn Mua vào · Bán ra (hoặc Nhà cung cấp · Khách hàng).
    const exportMenu = $('data-export-menu');
    const closeExportMenu = () => {
      exportMenu.open = false;
      for (const group of $('data-export-list').querySelectorAll('details.group')) group.open = false;
    };
    for (const button of $('data-export-list').querySelectorAll('button[data-part]')) {
      button.onclick = () => { closeExportMenu(); exportExcel(button.dataset.part).catch(() => { /* đã báo lỗi bên trong */ }); };
    }
    document.addEventListener('click', event => { if (exportMenu.open && !exportMenu.contains(event.target)) closeExportMenu(); });

    // Chọn nhanh Năm / Quý / Tháng.
    $('data-period-mode').onchange = () => { paintPeriodMode(); applyPeriod(); };
    for (const id of ['data-period-year', 'data-period-quarter', 'data-period-month']) $(id).onchange = applyPeriod;
    $('data-prev').onclick = () => { if (page > 0) { page -= 1; loadList().catch(ignoreAbort); } };
    $('data-next').onclick = () => { page += 1; loadList().catch(ignoreAbort); };
    $('data-size').onchange = () => { size = Number($('data-size').value) || 50; reloadAll(); };
    $('data-from').onchange = () => { range = { from: $('data-from').value, to: $('data-to').value, chip: 'custom' }; paintRange(); reloadAll(); };
    $('data-to').onchange = () => { range = { from: $('data-from').value, to: $('data-to').value, chip: 'custom' }; paintRange(); reloadAll(); };
      $('data-clear').onclick = () => {
      $('data-q').value = '';
      range = { from: '', to: '', chip: 'all' };
      tabState.products.dir = '';
      tabState.list.dir = '';
      tabState.list.state = 'all';
      tabState.partners.kind = 'all';
      for (const id of ['data-seg-products', 'data-seg-list']) for (const button of $(id).querySelectorAll('button')) button.classList.toggle('active', button.dataset.dir === 'all');
      for (const button of $('data-seg-state').querySelectorAll('button')) button.classList.toggle('active', button.dataset.state === 'all');
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
    bindSegment('data-seg-products', button => { tabState.products.dir = button.dataset.dir === 'all' ? '' : button.dataset.dir; loadProducts().catch(ignoreAbort); });
    bindSegment('data-seg-list', button => { tabState.list.dir = button.dataset.dir === 'all' ? '' : button.dataset.dir; page = 0; loadList().catch(ignoreAbort); loadSummary().catch(ignoreAbort); });
    // Lọc theo trạng thái hoá đơn (1..6). Đổi bộ lọc thì quay về trang 1 để không đứng ở trang rỗng.
    bindSegment('data-seg-state', button => { tabState.list.state = button.dataset.state; page = 0; loadList().catch(ignoreAbort); });
    bindSegment('data-seg-partners', button => { tabState.partners.kind = button.dataset.kind; loadPartners().catch(ignoreAbort); });

    // Sao kê ngân hàng (tab riêng): bộ lọc chi tiết, chiều, phân trang, nhập file, xoá lọc.
    bindSegment('data-seg-bank', button => { tabState.bank.flow = button.dataset.flow || ''; bankPage = 0; loadBank().catch(ignoreAbort); });
    $('data-bank-prev').onclick = () => { if (bankPage > 0) { bankPage -= 1; loadBank().catch(ignoreAbort); } };
    $('data-bank-next').onclick = () => { bankPage += 1; loadBank().catch(ignoreAbort); };
    $('data-bank-import').onclick = importBankFile;
    $('data-bank-files').onclick = openBankFiles;
    $('bank-file-close').onclick = () => $('bank-file-dialog').close();
    let bankTyping = null;
    const bankReload = () => { clearTimeout(bankTyping); bankTyping = setTimeout(() => { bankPage = 0; loadBank().catch(ignoreAbort); }, 250); };
    $('data-bank-q').oninput = bankReload;
    $('data-bank-min').oninput = bankReload;
    $('data-bank-max').oninput = bankReload;
    $('data-bank-from').onchange = () => { bankRange.from = $('data-bank-from').value; bankPage = 0; loadBank().catch(ignoreAbort); };
    $('data-bank-to').onchange = () => { bankRange.to = $('data-bank-to').value; bankPage = 0; loadBank().catch(ignoreAbort); };
    $('data-bank-clear').onclick = () => {
      $('data-bank-q').value = ''; $('data-bank-min').value = ''; $('data-bank-max').value = '';
      $('data-bank-from').value = ''; $('data-bank-to').value = '';
      bankRange = { from: '', to: '' };
      tabState.bank.flow = '';
      for (const button of $('data-seg-bank').querySelectorAll('button')) button.classList.toggle('active', button.dataset.flow === '');
      bankPage = 0;
      loadBank().catch(ignoreAbort);
    };
    // Bấm đúp vào nhãn trạng thái = xoá toàn bộ sao kê (ít dùng, giấu để khỏi bấm nhầm).
    $('data-bank-note').ondblclick = deleteBankFile;
    $('data-bank-note').title = 'Bấm đúp để xoá toàn bộ sao kê của MST này.';

    $('invoice-close').onclick = closeInvoice;
    $('invoice-print').onclick = printInvoice;
    $('invoice-dialog').addEventListener('close', () => { $('invoice-frame').src = 'about:blank'; });

    // Dialog xem trước A4 của tab Tra cứu (renderer.js điều khiển nội dung) — gắn đóng/in tại đây
    // vì cùng một trang; tồn tại rồi thì mọi lượt mở sau dùng lại.
    if ($('preview-close')) $('preview-close').onclick = () => window.HD_PREVIEW && window.HD_PREVIEW.close();
    if ($('preview-print')) $('preview-print').onclick = () => window.HD_PREVIEW && window.HD_PREVIEW.print();
    if ($('preview-dialog')) $('preview-dialog').addEventListener('close', () => { $('preview-frame').src = 'about:blank'; });

    $('autosync-close').onclick = () => $('autosync-dialog').close();
    $('autosync-save').onclick = saveAutoSync;
    $('autosync-run').onclick = runAutoSyncNow;

    $('backfill-open').onclick = () => { $('backfill-dialog').showModal(); loadBackfill().catch(ignoreAbort); };
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
        bankPage = 0;
        changeRevision = -1;
        if (view === 'data') refreshAll();
        if (view === 'bank') refreshBank();
      }
    });
  }

  restorePrefs();
  bind();
  // ?items=0: /api/state không còn kèm bảng 1.000 dòng (nó nằm ở /api/state/items riêng) — tab này
  // chỉ cần tổng hợp.
  fetch('/api/state?items=0').then(response => response.json()).then(result => { if (result && result.ok) app = result.value; }).catch(() => {});

  // Auto Sync / tự nhập có thể bắt đầu NGOÀI tab này (ví dụ ngay sau khi bấm Tải hóa đơn).
  // Trang ẩn (cửa sổ thu nhỏ/khoá màn hình) thì bỏ nhịp — không fetch vô ích, quay lại là chạy tiếp.
  setInterval(async () => {
    if (document.hidden || view === 'data') return;
    try {
      const status = await api('/api/db/import/status');
      if (status.running && !seenImportRunning) {
        seenImportRunning = true;
        if (window.notice) window.notice(`Đang nhập ${num.format(status.total)} file XML vào kho dữ liệu… mở tab “Kho dữ liệu” để xem tiến độ.`);
      }
      if (!status.running) {
        if (seenImportRunning && (status.imported || status.updated)) announceNew((status.imported || 0) + (status.updated || 0));
        seenImportRunning = false;
      }
    } catch { /* lần sau thử lại */ }
  }, 3000);

  // Scanner nền phát hiện XML mới/thay đổi; chỉ làm mới thống kê và bảng con đang mở.
  setInterval(async () => {
    if (document.hidden || view !== 'data' || changePollBusy || !app.selected) return;
    changePollBusy = true;
    try {
      const status = await api('/api/db/changes');
      if (changeRevision < 0) changeRevision = status.revision || 0;
      else if ((status.revision || 0) > changeRevision) {
        changeRevision = status.revision || 0;
        announceNew((status.imported || 0) + (status.updated || 0));
        await refreshVisibleData();
        // Scanner vừa gặp mã lạ/hồ sơ vừa gán mã ⇒ danh sách mã chưa gán có thể đã đổi.
        await loadCandidates().catch(() => {});
      }
    } catch { /* lần sau thử lại */ }
    finally { changePollBusy = false; }
  }, 1200);

  window.HD_DATA_VIEW = { show: showView, refresh: refreshAll, openAutoSync };
})();
