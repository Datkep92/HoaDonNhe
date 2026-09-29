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
const OVERVIEW_PERIOD_KEY = 'hoadon.overview.period';
// Loại hình kinh doanh để đọc NGƯỠNG THUẾ (mục 26) — chỉ là lựa chọn của người dùng;
// con số ngưỡng nằm trong src/data/tax-rules.js theo từng NĂM, không nằm ở đây.
const TAX_KEY = 'hoadon.overview.tax';
  // Nhãn menu xuất Excel (dùng cho thông báo sau khi xuất).
  const PART_LABEL = { all: 'toàn bộ kho dữ liệu', buy: 'hóa đơn mua vào', sell: 'hóa đơn bán ra', productsBuy: 'hàng hóa mua vào', productsSell: 'hàng hóa bán ra', suppliers: 'nhà cung cấp', buyers: 'khách hàng' };

  let app = {};
  let view = 'overview';
  // Đã tải xong Tổng quan lần nào chưa. Chỉ hiện chip "Đang tải" ở LẦN ĐẦU; vào lại tab sau đó
  // giữ nguyên dữ liệu cũ và làm mới ngầm — tránh nháy khối xám mỗi lần chuyển tab.
let overviewReady = false;
// Tổng quan cập nhật theo kiểu "stale while revalidate": giữ DOM cũ khi tải, nhớ ảnh DOM của từng
// kỳ để quay lại hiện tức thì, và bỏ phản hồi cũ nếu người dùng đổi kỳ liên tiếp.
let overviewRequestVersion = 0;
const overviewDomCache = new Map();
const OVERVIEW_CACHE_IDS = [
  'overview-kpis', 'overview-monthly', 'overview-sell', 'overview-buy',
  'overview-reconciliation', 'overview-bank', 'overview-products', 'overview-debt',
  'overview-tax', 'overview-alerts', 'ai-summary-json',
];
  let page = 0;
  let size = 50;
  let total = 0;
  let rows = [];
  let selectedKey = '';
  let products = [];
  let range = { from: '', to: '', chip: 'all' };
let taxBusinessType = '';
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

  const isoDay = date => {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const now = new Date();
  const currentMonth = window.Period.rangeFor('month', now.getFullYear(), now.getMonth() + 1);
  let overviewPeriod = { key: 'current_month', from: currentMonth.from, to: currentMonth.to, label: 'Tháng hiện tại' };
  // Năm mà biểu đồ 12 tháng đang vẽ — để bấm vào một tháng thì biết đích danh tháng/năm nào (mục 7).
  let overviewYear = new Date().getFullYear();
  // Chuỗi query đi kèm cho MỌI lệnh tải của Tổng quan (không chọn kỳ → chuỗi rỗng, URL giữ nguyên).
  function periodQuery() {
    if (!overviewPeriod.from) return '';
    return `?from=${encodeURIComponent(overviewPeriod.from)}&to=${encodeURIComponent(overviewPeriod.to)}`;
  }
  function overviewRangeLabel() {
    return overviewPeriod.label || 'Tháng hiện tại';
  }
  function paintOverviewPeriodMode() {
    const mode = $('overview-period-mode').value;
    $('overview-year-wrap').hidden = mode === 'current_month' || mode === 'custom';
    $('overview-month-wrap').hidden = mode !== 'month';
    $('overview-quarter-wrap').hidden = mode !== 'quarter';
    $('overview-from-wrap').hidden = mode !== 'custom';
    $('overview-to-wrap').hidden = mode !== 'custom';
  }
  function applyOverviewPeriod(reload = true) {
    const mode = $('overview-period-mode').value;
    const year = Number($('overview-period-year').value) || now.getFullYear();
    const month = Number($('overview-period-month').value) || now.getMonth() + 1;
    const quarter = Number($('overview-period-quarter').value) || Math.floor(now.getMonth() / 3) + 1;
    let chosen;
    if (mode === 'current_month') chosen = { ...window.Period.rangeFor('month', now.getFullYear(), now.getMonth() + 1), label: 'Tháng hiện tại' };
    else if (mode === 'month') chosen = window.Period.rangeFor('month', year, month);
    else if (mode === 'quarter') chosen = window.Period.rangeFor('quarter', year, quarter);
    else if (mode === 'year') chosen = window.Period.rangeFor('year', year);
    else {
      const from = $('overview-period-from').value;
      const to = $('overview-period-to').value;
      chosen = { from, to, label: from && to ? `${shortDay(from)} - ${shortDay(to)}` : 'Khoảng thời gian' };
    }
    overviewPeriod = { key: mode, from: chosen.from || '', to: chosen.to || '', label: chosen.label };
    $('overview-period-label').textContent = overviewPeriod.label;
    paintOverviewPeriodMode();
    try {
      localStorage.setItem(OVERVIEW_PERIOD_KEY, JSON.stringify({
        ...overviewPeriod, year, month, quarter,
      }));
    } catch { /* chế độ riêng tư */ }
    if (reload && (mode !== 'custom' || (overviewPeriod.from && overviewPeriod.to))) {
      restoreOverviewSnapshot();
      setOverviewLoading(true);
      void refreshOverview(false);
    }
  }
  function initOverviewPeriod() {
    const years = [];
    for (let year = now.getFullYear() + 1; year >= now.getFullYear() - 12; year -= 1) years.push(String(year));
    $('overview-period-year').replaceChildren(...years.map(year => new Option(year, year)));
    $('overview-period-month').replaceChildren(...Array.from({ length: 12 }, (_, index) => new Option(`Tháng ${index + 1}`, String(index + 1))));
    $('overview-period-quarter').replaceChildren(...Array.from({ length: 4 }, (_, index) => new Option(`Quý ${index + 1}`, String(index + 1))));
    $('overview-period-year').value = String(now.getFullYear());
    $('overview-period-month').value = String(now.getMonth() + 1);
    $('overview-period-quarter').value = String(Math.floor(now.getMonth() / 3) + 1);
    try {
      const saved = JSON.parse(localStorage.getItem(OVERVIEW_PERIOD_KEY) || '{}');
      if (['current_month', 'month', 'quarter', 'year', 'custom'].includes(saved.key)) {
        $('overview-period-mode').value = saved.key;
        if (saved.year) $('overview-period-year').value = String(saved.year);
        if (saved.month) $('overview-period-month').value = String(saved.month);
        if (saved.quarter) $('overview-period-quarter').value = String(saved.quarter);
        $('overview-period-from').value = saved.from || '';
        $('overview-period-to').value = saved.to || '';
      }
    } catch { /* bỏ qua */ }
    applyOverviewPeriod(false);
  }

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
  // Chip "Đang tải tổng quan…" cạnh nút cập nhật: phản hồi rõ ràng khi đang chờ dữ liệu mà
  // không dựng khối skeleton giả (nhìn dễ như giao diện lỗi).
  function setOverviewLoading(on) {
    const chip = $('overview-loading');
    if (chip) chip.hidden = !on;
  }

  function showView(next) {
    view = next;
    const viewInfo = {
      overview: ['TỔNG QUAN', 'Tình hình kinh doanh', 'Doanh thu, mua vào, đối soát và công nợ theo kỳ.'],
      download: ['TRA CỨU & TẢI', 'Tải hóa đơn điện tử', 'Tra cứu cổng thuế và tải chứng từ theo điều kiện đã chọn.'],
      data: ['KHO DỮ LIỆU', 'Quản lý dữ liệu hóa đơn', 'Tìm kiếm, tổng hợp và xuất dữ liệu đã lưu trên máy.'],
      bank: ['SAO KÊ NGÂN HÀNG', 'Đối chiếu dòng tiền', 'Nhập sao kê, kiểm tra giao dịch và đối chiếu với hóa đơn.'],
    };
    const info = viewInfo[next] || viewInfo.overview;
    $('view-eyebrow').textContent = info[0];
    $('view-title').textContent = info[1];
    $('view-note').textContent = info[2];
    // Pane: bỏ hidden ở cái mới trước khi gán hidden cho cái cũ
    // để animation fadeIn chạy đúng (nếu gán hidden trước, pane mới sẽ
    // bị display:none → không animate được).
    const allPanes = ['pane-overview', 'pane-download', 'pane-data', 'pane-bank'];
    const paneMap = { overview:'pane-overview', download:'pane-download', data:'pane-data', bank:'pane-bank' };
    // Bước 1: show pane mới TRƯỚC
    for (const pid of allPanes) $(pid).hidden = pid !== paneMap[next];
    // Bước 2: cập nhật active class trên nút
    for (const [id, name] of [['view-overview', 'overview'], ['view-download', 'download'], ['view-data', 'data'], ['view-bank', 'bank']]) {
      const button = $(id);
      button.classList.toggle('active', name === next);
      button.setAttribute('aria-selected', name === next ? 'true' : 'false');
    }
    // Bước 3: gạch dưới trượt — tạo indicator nếu chưa có
    const switchEl = document.querySelector('.view-switch');
    let indicator = switchEl && switchEl.querySelector('.tab-indicator');
    if (!indicator && switchEl) {
      indicator = document.createElement('span');
      indicator.className = 'tab-indicator';
      switchEl.appendChild(indicator);
    }
    if (indicator && switchEl) {
      const activeBtn = switchEl.querySelector('button.active');
      if (activeBtn) {
        // Dùng requestAnimationFrame để đảm bảo layout đã xong (quan trọng lần đầu load)
        requestAnimationFrame(() => {
          const padLeft = parseFloat(getComputedStyle(switchEl).paddingLeft) || 0;
          indicator.style.left = (activeBtn.offsetLeft - padLeft) + 'px';
          indicator.style.width = activeBtn.offsetWidth + 'px';
          indicator.hidden = false;
        });
      } else {
        indicator.hidden = true;
      }
    }
    // Chuyển vào Tổng quan: chỉ hiện chip "Đang tải" khi CHƯA có dữ liệu lần nào (lần đầu);
    // các lần sau vào lại giữ dữ liệu cũ rồi làm mới ngầm để không nháy.
    if (next === 'overview') {
      if (!overviewReady) setOverviewLoading(true);
      refreshOverview(false);
    }
    if (next === 'data') refreshAll();
    if (next === 'bank') refreshBank();
  }

  // Dòng thống kê thẻ Tổng quan: [nhãn, giá trị, màu?, ghi chú?]. Ghi chú (nếu có) in DƯỚI nhãn
  // bên trái — dùng cho mục 20/21/22 để gắn thêm TIỀN hoặc điều kiện mà không đẩy cột giá trị
  // ra khỏi thẻ hẹp (mỗi thẻ chỉ rộng 4/12 bề ngang).
  const overviewRows = rows => `<div class="overview-metrics">${rows.map(([label, value, tone = '', note = '']) => `<div><span>${label}${note ? `<em>${note}</em>` : ''}</span><strong class="${tone}">${value}</strong></div>`).join('')}</div>`;

  // Vá DOM theo node thay vì gán innerHTML cho cả card. Text/số/thuộc tính đổi tại chỗ nên không
  // mất hover/focus, không nháy card và trình duyệt không phải dựng lại toàn bộ cây con.
  function patchNode(current, next) {
    if (!current || !next || current.nodeType !== next.nodeType
      || (current.nodeType === Node.ELEMENT_NODE && current.tagName !== next.tagName)) {
      if (current && next) current.replaceWith(next.cloneNode(true));
      return;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.data !== next.data) current.data = next.data;
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    const oldChildren = [...current.childNodes];
    const newChildren = [...next.childNodes];
    const common = Math.min(oldChildren.length, newChildren.length);
    for (let index = 0; index < common; index += 1) patchNode(oldChildren[index], newChildren[index]);
    for (let index = oldChildren.length - 1; index >= newChildren.length; index -= 1) oldChildren[index].remove();
    for (let index = common; index < newChildren.length; index += 1) current.append(newChildren[index].cloneNode(true));
  }
  function setOverviewHtml(id, html) {
    const target = $(id);
    const value = String(html ?? '');
    if (!target || target.innerHTML === value) return;
    const template = document.createElement('template');
    template.innerHTML = value;
    const nextChildren = [...template.content.childNodes];
    const oldChildren = [...target.childNodes];
    const common = Math.min(oldChildren.length, nextChildren.length);
    for (let index = 0; index < common; index += 1) patchNode(oldChildren[index], nextChildren[index]);
    for (let index = oldChildren.length - 1; index >= nextChildren.length; index -= 1) oldChildren[index].remove();
    for (let index = common; index < nextChildren.length; index += 1) target.append(nextChildren[index].cloneNode(true));
  }
  function overviewCacheKey() { return `${overviewPeriod.from}|${overviewPeriod.to}`; }
  function saveOverviewSnapshot() {
    const snapshot = {};
    for (const id of OVERVIEW_CACHE_IDS) if ($(id)) snapshot[id] = $(id).innerHTML;
    overviewDomCache.set(overviewCacheKey(), snapshot);
    // Chỉ giữ các kỳ dùng gần đây trong RAM; đóng app là tự mất, không ghi dữ liệu thống kê ra đĩa.
    if (overviewDomCache.size > 12) overviewDomCache.delete(overviewDomCache.keys().next().value);
  }
  function restoreOverviewSnapshot() {
    const snapshot = overviewDomCache.get(overviewCacheKey());
    if (!snapshot) return false;
    for (const [id, html] of Object.entries(snapshot)) setOverviewHtml(id, html);
    return true;
  }
  // NÚT Ở CHÂN THẺ (mục 7) — bấm vào là mở đúng danh sách chi tiết của con số trong thẻ:
  //   ["list:SELL", …] → danh sách hoá đơn chiều đó · ["bank", …] → tab cần sang tới
  //   ["needs_review", …] → bộ lọc của popup "Cần kiểm tra".
  const cardLinks = links => links && links.length
    ? `<div class="card-links">${links.map(([key, label]) => key.startsWith('list:')
      ? `<button type="button" class="link card-link" data-invoices="${key.slice(5)}">${label}</button>`
      : ['bank', 'data', 'overview', 'download'].includes(key)
        ? `<button type="button" class="link card-link" data-goto="${key}">${label}</button>`
        : `<button type="button" class="link card-link" data-filter="${key}">${label}</button>`).join('')}</div>`
    : '';
  const overviewDonut = (segments, totalLabel) => {
    const totalValue = segments.reduce((sum, segment) => sum + Number(segment.value || 0), 0);
    let offset = 0;
    const circles = totalValue ? segments.map(segment => {
      const percent = Number(segment.value || 0) / totalValue * 100;
      const circle = `<circle cx="58" cy="58" r="48" fill="none" stroke="${segment.color}" stroke-width="16" pathLength="100" stroke-dasharray="${percent} ${100 - percent}" stroke-dashoffset="${-offset}"/>`;
      offset += percent;
      return circle;
    }).join('') : '<circle cx="58" cy="58" r="48" fill="none" stroke="#e8edf2" stroke-width="16"/>';
    return `<div class="overview-donut"><svg viewBox="0 0 116 116" aria-hidden="true"><g transform="rotate(-90 58 58)">${circles}</g></svg><div class="overview-donut-center"><strong>${num.format(totalValue)}</strong><span>${totalLabel}</span></div></div>`;
  };
  const safeOverviewText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

  // --------------------------------------------------- CÔNG NỢ (mục 25) — 2 thẻ cuối
  // Số liệu đến thẳng từ SQLite (queries.debts); UI chỉ định dạng lại, KHÔNG tự cộng trừ gì.
  function renderDebt(debt) {
    if (!debt || debt.empty) {
      setOverviewHtml('overview-debt', '<p class="hint">Chưa có dữ liệu hóa đơn.</p>');
      return;
    }
    // MỤC 5 — mỗi đối tượng là NÚT BẤM → popup chi tiết: ngày, số hóa đơn, xem A4, phân loại.
    const parties = (rows, title, direction) => rows && rows.length
      ? `<div class="debt-parties"><span class="debt-parties-title">${title}</span>${rows.map(row => `<button type="button" class="debt-party" data-direction="${direction}" data-name="${safeOverviewText(row.name)}" title="Bấm để xem chi tiết hóa đơn của đối tượng này">`
        + `<span title="${safeOverviewText(row.name)}">${safeOverviewText(row.name)}</span>`
        + `<strong>${shortMoney(row.amount)}</strong>`
        + `<small>${row.last_date ? shortDay(row.last_date) : '—'}</small></button>`).join('')}</div>`
      : '';
    const unclear = debt.unclearCount
      ? `${shortMoney(debt.unclear)} · ${num.format(debt.unclearCount)} hóa đơn`
      : 'Không có';
    setOverviewHtml('overview-debt', `<div class="overview-split-grid"><section class="overview-split-panel sell"><span class="overview-caption">PHẢI THU</span>${overviewRows([
      ['Tổng phải thu', shortMoney(debt.receivable), debt.receivable ? 'warn' : ''],
      ['Số hóa đơn', num.format(debt.receivableCount || 0)],
    ])}${parties(debt.customers, 'Khách hàng còn nợ', 'SELL')}</section><section class="overview-split-panel buy"><span class="overview-caption">PHẢI TRẢ</span>${overviewRows([
      ['Tổng phải trả', shortMoney(debt.payable), debt.payable ? 'warn' : ''],
      ['Số hóa đơn', num.format(debt.payableCount || 0)],
    ])}${parties(debt.suppliers, 'Nhà cung cấp còn nợ', 'BUY')}</section></div>`
      + overviewRows([['Chưa rõ hình thức thanh toán', unclear, debt.unclearCount ? 'warn' : '']])
      + (debt.receivable || debt.payable ? '' : '<p class="hint">Không có khoản nào chưa thu/chưa trả.</p>'));
  }

  // ------------------------------------------------ THUẾ / NGƯỠNG (mục 26)
  // Chỉ ĐỊNH DẠNG số do server trả về. Ngưỡng + văn bản dẫn chiếu lấy trong tax-rules.js
  // theo năm đã chọn; KHÔNG gọi con số nào là "thuế phải nộp".
  function renderTax(tax) {
    if (!tax) { setOverviewHtml('overview-tax', '<p class="hint">Chưa có dữ liệu.</p>'); return; }
    const select = $('tax-rule');
    const wanted = String(taxBusinessType || '');
    if (select.dataset.year !== String(tax.year)) {
      select.innerHTML = '<option value="">— Chọn loại hình kinh doanh —</option>'
        + (tax.rules || []).map(rule => `<option value="${rule.businessType}">${safeOverviewText(rule.label)}</option>`).join('');
      select.dataset.year = String(tax.year);
      select.value = wanted;
      // Lựa chọn đã lưu không còn trong danh sách (đổi năm) → bỏ trống, không giữ giá trị lạ.
      if (select.value !== wanted) { taxBusinessType = ''; select.value = ''; }
    }
    const rows = [
      ['Doanh thu lũy kế', shortMoney(tax.revenue), tax.revenue ? 'ok' : '', tax.toDate ? `đến ${shortDay(tax.toDate)}` : ''],
      ['Thuế dự kiến', tax.taxAvailable ? shortMoney(tax.tax) : 'Chưa đủ dữ liệu', tax.taxAvailable ? '' : 'warn',
        tax.taxAvailable ? 'Ước tính từ hóa đơn bán ra' : 'Hóa đơn chưa ghi tiền thuế'],
      ['Tiến độ theo ngưỡng', tax.progress ? `${Math.round(tax.progress.percent)}%` : 'Chưa chọn loại hình',
        tax.progress ? (tax.progress.over ? 'warn' : 'ok') : '', tax.progress ? `ngưỡng ${Number(tax.progress.threshold).toLocaleString('vi-VN')} đồng/năm` : ''],
    ];
    const bar = tax.progress
      ? `<progress class="overview-tax-bar" max="100" value="${Math.min(100, Math.round(tax.progress.percent))}"></progress>`
      : '';
    const ruleNote = tax.rule
      ? `<p class="hint">${safeOverviewText(tax.rule.label)} · quy định năm ${tax.year}<br>${safeOverviewText(tax.rule.legalRef)}</p>`
      : '<p class="hint">Chưa chọn loại hình kinh doanh nên chưa hiển thị ngưỡng áp dụng.</p>';
    setOverviewHtml('overview-tax', `<div class="overview-metrics">${rows.map(([label, value, tone = '', note = '']) => `<div><span>${label}${note ? `<br><em>${note}</em>` : ''}</span><strong class="${tone}">${value}</strong></div>`).join('')}</div>`
      + bar + ruleNote
      + '<p class="hint">Chỉ là ước tính — hệ thống KHÔNG công bố “thuế phải nộp”.</p>');
  }

  // MỤC 29 — AI SUMMARY: hệ thống CHƯA có AI ⇒ KHÔNG gọi API nào, KHÔNG thêm route mới. Chỉ dựng
  // sẵn đúng 7 trường của spec, số liệu lấy 100% từ SQLite (summary + reconciliation + debts);
  // sau này có AI thì chỉ gửi đúng object này và AI diễn giải, KHÔNG được tự tính lại số.
  let aiSummaryJson = '';
  function renderAiSummary({ summary, reconciliation, debt }) {
    const box = $('ai-summary-json');
    const copy = $('ai-summary-copy');
    const hasInvoice = Number(summary.sell || 0) + Number(summary.buy || 0) > 0;
    // Chưa có hoá đơn hoặc chưa chạy đối chiếu ⇒ KHÔNG dựng JSON: số 0 ở đây sẽ là số 0 giả
    // (transfer_unmatched/bank_unmatched sinh ra từ trạng thái chưa được ghi) — mục 35.
    if (!hasInvoice || !reconciliation.ran) {
      aiSummaryJson = '';
      box.textContent = !hasInvoice
        ? 'Chưa có dữ liệu hoá đơn → chưa dựng JSON.'
        : 'Chưa chạy đối chiếu sao kê → chưa dựng JSON (tránh hiện số 0 giả).';
      copy.disabled = true;
      return;
    }
    aiSummaryJson = JSON.stringify({
      revenue: Number(summary.amountSell || 0),
      purchase: Number(summary.amountBuy || 0),
      cash_invoice: Number(reconciliation.cashAmount || 0),
      transfer_invoice: Number(reconciliation.transferAmount || 0),
      transfer_unmatched: Number(reconciliation.transferBankNotFound || 0),
      bank_unmatched: Number(reconciliation.bankNoInvoice || 0),
      supplier_debt: Number(debt.payable || 0),
    }, null, 2);
    box.textContent = aiSummaryJson;
    copy.disabled = false;
  }

  async function refreshOverview(rebuild) {
    const requestVersion = ++overviewRequestVersion;
    try {
      if (rebuild) await post('/api/db/reconciliation/run', {});
      // Kỳ đang chọn ở header đi kèm MỌI lệnh tải của Tổng quan (mục 1).
      const period = periodQuery();
      const [summary, bank, reconciliation, overview, debt, tax] = await Promise.all([
        api(`/api/db/summary${period}`), api(`/api/db/bank/summary${period}`), api(`/api/db/reconciliation/summary${period}`), api(`/api/db/overview${period}`),
        // Công nợ (mục 25) + Thuế/ngưỡng (mục 26): đều đọc từ SQLite, không có số nào
        // được giao diện tự tính. THUẾ vẫn theo NĂM + loại hình (mục 26) nên không lọc theo kỳ.
        api(`/api/db/debts${period}`),
        api(`/api/db/tax?businessType=${encodeURIComponent(taxBusinessType || '')}`),
      ]);
      if (requestVersion !== overviewRequestVersion) return;
      // Danh sách cảnh báo (mục 27) tính MỘT LẦN ngay đây: số trên KPI "Cần kiểm tra" phải bằng
      // TỔNG các dòng trong thẻ cảnh báo bên dưới — cùng một bộ đếm, không đếm hai kiểu.
      const alertCounts = [
        [reconciliation.transferBankNotFound, 'transfer_missing', 'hóa đơn chuyển khoản chưa tìm thấy sao kê'],
        [reconciliation.bankNoInvoice, 'bank_no_invoice', 'giao dịch ngân hàng chưa có hóa đơn chuyển khoản'],
        [reconciliation.amountMismatch, 'amount_mismatch', 'hóa đơn lệch số tiền với sao kê'],
        [reconciliation.paymentMethodUnknown, 'payment_unknown', 'hóa đơn thiếu phương thức thanh toán'],
        [reconciliation.paymentMethodAmbiguous, 'payment_ambiguous', 'hóa đơn TM/CK cần phân loại'],
        [reconciliation.transferNeedsReview, 'needs_review', 'kết quả đối chiếu cần kiểm tra'],
      ];
      const reviewCount = alertCounts.reduce((total, [count]) => total + Number(count || 0), 0);
      // Thanh phiên chỉ giữ MST · tên (renderer.js) · thời gian cập nhật gần nhất.
      $('overview-period').textContent = `Cập nhật ${shortWhen(summary.lastImport)}`;
      const difference = Number(summary.amountSell || 0) - Number(summary.amountBuy || 0);
      // MỤC 19 – KPI CHÍNH: doanh thu bán ra, mua vào, chênh lệch, số hoá đơn bán, số hoá đơn mua
      // + 2 dòng thêm: LŨY KẾ NĂM và SO VỚI KỲ TRƯỚC. Cả 2 đều do server tính từ SQLite
      // (summary.yearToDate / summary.previousPeriod) — giao diện chỉ định dạng, không tự nhân
      //chia, và khi thiếu dữ liệu thì ghi "Chưa có dữ liệu" chứ không hiện số 0 (mục 35).
      const ytd = summary.yearToDate || {};
      const ytdHasSell = Number(ytd.sellInvoices || 0) > 0;
      const ytdValue = ytdHasSell ? shortMoney(ytd.amountSell) : 'Chưa có dữ liệu';
      const ytdNote = ytdHasSell
        ? `Doanh thu bán ra từ 01/01 · ${num.format(ytd.sellInvoices)} hóa đơn`
        : `Năm ${ytd.year || ''} chưa có hóa đơn bán`;
      const previous = summary.previousPeriod || null;
      let previousValue = '—';
      let previousTone = '';
      let previousNote = 'Chưa chọn kỳ trên header';
      if (previous) {
        const percent = previous.changePercent;
        if (percent === null || percent === undefined) {
          // Kỳ trước không có hoá đơn bán ⇒ không tính được % (0 ở đây = "không có dữ liệu").
          previousNote = `Kỳ ${shortDay(previous.from)} - ${shortDay(previous.to)} chưa có hóa đơn bán`;
        } else {
          const rounded = Math.round(percent);
          previousValue = `${rounded > 0 ? '+' : ''}${rounded}%`;
          previousTone = rounded > 0 ? 'sell' : rounded < 0 ? 'warn' : '';
          previousNote = `Doanh thu bán ra · kỳ trước ${shortMoney(previous.amountSell)}`;
        }
      }
      setOverviewHtml('overview-kpis', [
        ['Doanh thu bán ra', shortMoney(summary.amountSell), 'sell', `${num.format(summary.sell || 0)} hóa đơn`],
        ['Mua vào', shortMoney(summary.amountBuy), 'buy', `${num.format(summary.buy || 0)} hóa đơn`],
        ['Chênh lệch bán - mua', shortMoney(difference), difference < 0 ? 'warn' : '', 'Không phải lợi nhuận'],
        ['Lũy kế năm', ytdValue, ytdHasSell ? 'sell' : '', ytdNote],
        ['Số hóa đơn bán', num.format(summary.sell || 0), 'sell', `Còn hiệu lực ${num.format(summary.sellActive || 0)}`],
        ['Số hóa đơn mua', num.format(summary.buy || 0), 'buy', `Còn hiệu lực ${num.format(summary.buyActive || 0)}`],
        ['So với kỳ trước', previousValue, previousTone, previousNote],
        ['Cần kiểm tra', num.format(reviewCount), 'warn', 'Đối chiếu và dữ liệu', 'needs_review'],
      ].map(([label, value, tone, note, filter]) => {
        // MỤC 7 — riêng dòng "Cần kiểm tra" là NÚT BẤM → mở đúng popup danh sách chi tiết (mục 27).
        const open = filter ? `<button type="button" class="overview-kpi kpi-link" data-filter="${filter}">` : '<div class="overview-kpi">';
        return `${open}<span>${label}</span><strong class="${tone}">${value}</strong><small>${note}</small>${filter ? '</button>' : '</div>'}`;
      }).join(''));
      const maxMonth = Math.max(1, ...overview.months.flatMap(month => [Number(month.sell || 0), Number(month.buy || 0)]));
      overviewYear = Number(overview.year) || overviewYear;
      $('overview-monthly-title').textContent = `Bán ra và mua vào · ${overview.year} — bấm một tháng để xem hóa đơn`;
      const chartBars = overview.months.map((month, index) => {
        const x = 31 + index * 48;
        const sellHeight = Math.max(2, Number(month.sell || 0) / maxMonth * 160);
        const buyHeight = Math.max(2, Number(month.buy || 0) / maxMonth * 160);
        return `<g data-month="${month.month}"><title>T${month.month}: Bán ${num.format(month.sell)} · Mua ${num.format(month.buy)}</title><rect class="sell" x="${x}" y="${175 - sellHeight}" width="13" height="${sellHeight}" rx="3"/><rect class="buy" x="${x + 16}" y="${175 - buyHeight}" width="13" height="${buyHeight}" rx="3"/><text x="${x + 14}" y="198" text-anchor="middle">T${month.month}</text></g>`;
      }).join('');
      setOverviewHtml('overview-monthly', `<svg viewBox="0 0 610 205" preserveAspectRatio="none" aria-label="Biểu đồ bán ra và mua vào theo tháng"><line x1="12" y1="175" x2="600" y2="175"/>${chartBars}</svg>`);
      // MỤC 4 — HAI THẺ TÁCH CHIỀU: "Bán ra — Khách hàng (tiền vào)" và "Mua vào — Nhà cung cấp
      // (tiền ra)". Mỗi thẻ tự có phân loại tiền mặt/chuyển khoản + kết quả đối chiếu của CHÍNH
      // chiều đó ⇒ không còn gộp tiền vào với tiền ra thành một con số chung (nhìn là biết bên nào).
      const sides = summary.paymentSides || {};
      const reconSides = reconciliation.byDirection || {};
      const METHOD_ROWS = [
        ['Tiền mặt', 'cash', '', '#087f70'],
        ['Chuyển khoản', 'transfer', '', '#4c78a8'],
        ['TM/CK', 'ambiguous', 'warn', '#d79052'],
        ['Chưa rõ', 'unknown', 'warn', '#b9c2cc'],
      ];
      const sideCard = (targetId, key, direction) => {
        const data = sides[key] || {};
        const side = reconSides[direction] || {};
        const totalInvoices = METHOD_ROWS.reduce((sum, [, field]) => sum + Number((data[field] || {}).invoices || 0), 0);
        const box = $(targetId);
        if (!totalInvoices) {
          // Kỳ không có hoá đơn của chiều này → không vẽ vòng tròn 0 / bảng số 0 như số thật (mục 35).
          setOverviewHtml(targetId, '<p class="hint">Chưa có hóa đơn trong kỳ.</p>');
          return;
        }
        const segments = METHOD_ROWS.map(([, field, , color]) => ({ value: Number((data[field] || {}).invoices || 0), color }));
        const rows = [
          ['Tổng hóa đơn', num.format(totalInvoices), '',
            shortMoney(direction === 'SELL' ? summary.amountSell : summary.amountBuy)],
          ...METHOD_ROWS.map(([label, field, tone]) => {
            const cell = data[field] || {};
            return [label, `${num.format(cell.invoices || 0)} hóa đơn`, tone, shortMoney(cell.amount)];
          }),
          ['Đã khớp sao kê', `${num.format(side.found || 0)} hóa đơn`, 'ok', shortMoney(side.foundAmount || 0)],
          ['Chưa khớp sao kê', `${num.format(side.missing || 0)} hóa đơn`, side.missing ? 'warn' : '',
            shortMoney(side.missingAmount || 0)],
        ];
        setOverviewHtml(targetId, `<div class="overview-donut-layout">${overviewDonut(segments, 'hóa đơn')}${overviewRows(rows)}</div>`
          // MỤC 7 — bấm để mở danh sách hoá đơn CỦA CHIỀU NÀY trong kỳ đang chọn.
          + cardLinks([[`list:${direction}`, direction === 'SELL' ? 'Xem danh sách hóa đơn bán ra ›' : 'Xem danh sách hóa đơn mua vào ›']]));
      };
      sideCard('overview-sell', 'sell', 'SELL');
      sideCard('overview-buy', 'buy', 'BUY');
      const reconciliationSegments = [
        { value: reconciliation.transferBankFound, color: '#087f70' }, { value: reconciliation.transferBankNotFound, color: '#cf6f4d' },
        { value: reconciliation.transferNeedsReview, color: '#e2b15e' },
      ];
      const notRan = reconciliation.ran ? '' : '<p class="hint">Chưa chạy đối chiếu sao kê — bấm “Cập nhật đối chiếu”.</p>';
      // MỤC 21 — THỐNG KÊ ĐỐI CHIẾU CHUYỂN KHOẢN: tổng hoá đơn CK · đã tìm thấy · chưa tìm thấy ·
      // sai số tiền · cần kiểm tra. MỤC 22 — dòng tiền mặt: số hoá đơn + giá trị, ghi rõ KHÔNG yêu
      // cầu đối chiếu sao kê (mục 8).
      setOverviewHtml('overview-reconciliation', `${notRan}<div class="overview-donut-layout">${overviewDonut(reconciliationSegments, 'hóa đơn CK')}${overviewRows([
        ['Tổng hóa đơn CK', num.format(reconciliation.transferTotal || 0)],
        ['Đã tìm thấy giao dịch', num.format(reconciliation.transferBankFound || 0), 'ok'],
        ['Chưa tìm thấy giao dịch', num.format(reconciliation.transferBankNotFound || 0), 'warn'],
        ['Sai số tiền', num.format(reconciliation.amountMismatch || 0), reconciliation.amountMismatch ? 'warn' : ''],
        ['Cần kiểm tra', num.format(reconciliation.transferNeedsReview || 0), reconciliation.transferNeedsReview ? 'warn' : ''],
        ['Tiền mặt', num.format(reconciliation.cashNoBankRequired || 0), '',
          `không cần đối chiếu sao kê · ${shortMoney(reconciliation.cashAmount || 0)}`],
      ])}</div>${cardLinks([['needs_review', 'Xem danh sách cần kiểm tra ›']])}`);
      // MỤC 23 — NGÂN HÀNG: tiền vào/ra, số giao dịch, đã/ chưa đối chiếu, cần kiểm tra.
      // "Chưa đối chiếu" = dòng chưa có trạng thái (chỉ > 0 khi chưa chạy đối chiếu).
      const bankUndecided = Math.max(0, Number(bank.transactions || 0) - Number(reconciliation.bankMatched || 0) - Number(reconciliation.bankNoInvoice || 0));
      setOverviewHtml('overview-bank', overviewRows([
        ['Tổng tiền vào', shortMoney(bank.moneyIn)], ['Tổng tiền ra', shortMoney(bank.moneyOut)], ['Số giao dịch', num.format(bank.transactions || 0)],
        ['Đã đối chiếu', num.format(reconciliation.bankMatched || 0), 'ok', 'gắn với hóa đơn chuyển khoản'],
        ['Chưa đối chiếu', num.format(bankUndecided), bankUndecided ? 'warn' : '', 'chưa phân loại'],
        ['Cần kiểm tra', num.format(reconciliation.bankNoInvoice || 0), reconciliation.bankNoInvoice ? 'warn' : '', 'sao kê chưa tìm thấy hóa đơn CK'],
      ]) + cardLinks([
        ...(reconciliation.bankNoInvoice ? [['bank_no_invoice', 'Xem giao dịch chưa gắn hóa đơn ›']] : []),
        ['bank', 'Xem tab Sao kê ngân hàng ›'],
      ]));
      // MỤC 24 – HÀNG HÓA: tổng hợp mua/bán (dòng đầu) + top bán / top mua + cảnh báo dữ liệu.
      // Số liệu từ queries.overview().goods — UI chỉ định dạng, không tự cộng lại.
      const goods = overview.goods || {};
      // MỤC 6 — mỗi dòng top hàng hóa là NÚT BẤM → danh sách hóa đơn chứa mặt hàng đó (mở xem A4).
      // Chỉ hiện 3 dòng đầu, phần còn lại ẩn sau nút "Xem thêm" → thẻ không bị dài.
      const goodsRow = (item, direction) => `<button type="button" class="overview-product" data-product="${safeOverviewText(item.name)}" data-direction="${direction}" title="Bấm để xem hóa đơn có mặt hàng này">`
        + `<span title="${safeOverviewText(item.name)}">${safeOverviewText(item.name)}`
        + `<em>Số lượng ${num.format(Number(item.quantity || 0))}</em></span>`
        + `<strong>${shortMoney(item.amount)}</strong>`
        + `<progress max="${Math.max(1, Number(item.amount || 0))}" value="${Number(item.amount || 0)}"></progress></button>`;
      const goodsTop = (title, items, direction) => {
        if (!items || !items.length) return '';
        const head = items.slice(0, 3).map(item => goodsRow(item, direction)).join('');
        const extra = items.slice(3);
        return `<div class="goods-list"><div class="overview-caption overview-group">${title}</div>${head}`
          + (extra.length
            ? `<span class="goods-extra" hidden>${extra.map(item => goodsRow(item, direction)).join('')}</span>`
            + `<button type="button" class="link goods-more" data-goods-more>Xem thêm ${num.format(extra.length)} mặt hàng</button>`
            : '') + '</div>';
      };
      // 4 cảnh báo là NÚT BẤM → danh sách mặt hàng bị dính (mục 27) — nhãn lấy từ GOODS_WARNINGS,
      // cùng chỗ với danh sách chi tiết nên con số và nội dung không thể lệch nhau.
      const goodsWarnings = [
        ['sell_over_buy', goods.sellOverBuy],
        ['missing_buy', goods.missingBuy],
        ['not_normalized', goods.notNormalized],
        ['code_mismatch', goods.codeMismatch],
      ].filter(([, count]) => Number(count || 0) > 0);
      setOverviewHtml('overview-products', Number(goods.total || 0) === 0
        // Chưa có dòng hàng nào → không hiện số 0 như số thật (mục 35).
        ? '<p class="hint">Chưa có dữ liệu hàng hóa.</p>'
        : `<div class="overview-split-grid"><section class="overview-split-panel sell"><span class="overview-caption">HÀNG HÓA BÁN RA</span>${overviewRows([
          ['Số lượng bán', num.format(goods.qtySell || 0)],
          ['Giá trị bán', shortMoney(goods.amountSell)],
        ])}${goodsTop('Top hàng bán', overview.topProducts, 'SELL')}</section><section class="overview-split-panel buy"><span class="overview-caption">HÀNG HÓA MUA VÀO</span>${overviewRows([
          ['Số lượng mua', num.format(goods.qtyBuy || 0)],
          ['Giá trị mua', shortMoney(goods.amountBuy)],
        ])}${goodsTop('Top hàng mua', overview.topProductsBuy, 'BUY')}</section></div>`
          + overviewRows([['Tổng số mặt hàng', num.format(goods.total || 0)]])
          + (goodsWarnings.length
            ? `<div class="overview-caption overview-group">Cần xem lại</div>${goodsWarnings.map(([kind, count]) => `<button type="button" class="goods-warn" data-warn="${kind}" title="Bấm để xem danh sách mặt hàng"><strong>${num.format(count)}</strong> ${GOODS_WARNINGS[kind] || kind}<span class="alert-go" aria-hidden="true">›</span></button>`).join('')}`
            : ''));
      renderDebt(debt);
      renderTax(tax);
      // MỤC 29 — dựng sẵn JSON thống kê (không gọi AI) từ đúng 3 payload vừa đọc ở trên.
      renderAiSummary({ summary, reconciliation, debt });
      const alerts = alertCounts.filter(([count]) => Number(count) > 0);
      // Mỗi cảnh báo là một NÚT BẤM → mở đúng danh sách chi tiết (mục 27: bấm vào là thấy ngay).
      setOverviewHtml('overview-alerts', alerts.length
        ? alerts.map(([count, filter, label]) => `<button type="button" class="alert-row" data-filter="${filter}"><strong>${num.format(count)}</strong> ${label}<span class="alert-go" aria-hidden="true">›</span></button>`).join('')
        : '<p class="overview-clear">Không có cảnh báo đối chiếu.</p>');
      saveOverviewSnapshot();
      // Đã có dữ liệu: đánh dấu để các lần vào lại tab không hiện chip "Đang tải" nữa.
      overviewReady = true;
      setOverviewLoading(false);
    } catch (error) {
      if (requestVersion !== overviewRequestVersion) return;
      fail(error);
      setOverviewLoading(false);
    } finally {
      // Báo cho màn hình chờ khởi động biết cửa "dữ liệu Tổng quan" đã xong (thành công HAY lỗi
      // đều phải mở — không giữ người dùng ở màn hình chờ vì một lỗi mạng).
      if (requestVersion === overviewRequestVersion && window.hdBootReady) window.hdBootReady('overview');
    }
  }

  // ------------------------------------------------------- DANH SÁCH "CẦN KIỂM TRA" (mục 27)
  // Bấm một dòng cảnh báo ở Tổng quan → mở đúng danh sách chi tiết. Nguồn là /api/db/
  // reconciliation/pending — tức KẾT QUẢ ĐÃ LƯU trong SQLite, UI không tự tính lại.
  // Bộ lọc ĐANG mở — dùng để nạp lại popup sau khi người dùng phân loại một dòng (mục 3).
  let pendingFilter = 'needs_review';
  const pendingLabels = {
    invoice: 'Hóa đơn', bank: 'Sao kê',
    TRANSFER_BANK_NOT_FOUND: 'Chưa tìm thấy sao kê',
    PAYMENT_METHOD_UNKNOWN: 'Chưa rõ hình thức thanh toán',
    PAYMENT_METHOD_AMBIGUOUS: 'TM/CK cần phân loại',
    BANK_NO_INVOICE: 'Chưa gắn hóa đơn',
    AMOUNT_MISMATCH: 'Lệch số tiền', DATE_MISMATCH: 'Lệch ngày', PARTNER_MISMATCH: 'Lệch đối tượng',
    NEEDS_REVIEW: 'Cần kiểm tra',
  };
  const pendingFilters = {
    transfer_missing: row => row.kind === 'invoice' && row.reconciliation_status === 'TRANSFER_BANK_NOT_FOUND',
    bank_no_invoice: row => row.kind === 'bank',
    amount_mismatch: row => row.issues.includes('AMOUNT_MISMATCH'),
    payment_unknown: row => row.kind === 'invoice' && row.reconciliation_status === 'PAYMENT_METHOD_UNKNOWN',
    payment_ambiguous: row => row.kind === 'invoice' && row.reconciliation_status === 'PAYMENT_METHOD_AMBIGUOUS',
    needs_review: row => row.issues.includes('NEEDS_REVIEW'),
  };
  const pendingTitles = {
    transfer_missing: 'Hóa đơn chuyển khoản chưa tìm thấy sao kê',
    bank_no_invoice: 'Giao dịch ngân hàng chưa có hóa đơn chuyển khoản',
    amount_mismatch: 'Dòng lệch số tiền với sao kê',
    payment_unknown: 'Hóa đơn thiếu hình thức thanh toán',
    payment_ambiguous: 'Hóa đơn TM/CK cần phân loại',
    needs_review: 'Kết quả đối chiếu cần kiểm tra',
  };

  // ------------------------------------- THAO TÁC TRÊN TỪNG DÒNG HÓA ĐƠN (mục 3 + mục 5)
  // Mọi popup liệt kê hóa đơn (Cần kiểm tra, Công nợ, mặt hàng) dùng CÙNG một bộ nút:
  //   Xem      → mở chính hóa đơn đó ở khổ A4 (đọc đúng 1 file XML)
  //   TM       → người dùng xác nhận "chưa khớp sao kê ⇒ tạm ghi tiền mặt"
  //   CK       → người dùng xác nhận "khớp sao kê ⇒ ghi chuyển khoản"
  //   phân loại → Đã kiểm tra / Đã xử lý / Thiếu – Đủ tài liệu / Lỗi
  // MÁY KHÔNG BAO GIỜ tự chọn giúp: HTTToan trên XML ghi "TM/CK" nên không tự phân loại được.
  const REVIEW_OPTIONS = [
    ['', '— Phân loại —'],
    ['checked', 'Đã kiểm tra'],
    ['processed', 'Đã xử lý'],
    ['missing_docs', 'Thiếu tài liệu'],
    ['complete_docs', 'Đủ tài liệu'],
    ['error', 'Lỗi'],
    ['cash_manual', 'Tiền mặt (thủ công)'],
    ['transfer_manual', 'Chuyển khoản (thủ công)'],
  ];
  const PAYMENT_LABELS = { CASH: 'Tiền mặt', TRANSFER: 'Chuyển khoản', CASH_TRANSFER: 'TM/CK', UNKNOWN: 'Chưa rõ' };

  function reviewActionsHtml(row) {
    if (row.kind === 'bank' || !row.invoice_key) {
      return '<span class="row-actions row-actions-none">Giao dịch sao kê</span>';
    }
    const current = String(row.review_status || '');
    const options = REVIEW_OPTIONS.map(([value, label]) =>
      `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
    return '<span class="row-actions">'
      + '<button type="button" class="link" data-act="view" title="Mở hóa đơn khổ A4">Xem</button>'
      + '<button type="button" class="secondary" data-act="cash_manual" title="Chưa khớp sao kê → tạm ghi tiền mặt">TM</button>'
      + '<button type="button" class="secondary" data-act="transfer_manual" title="Khớp sao kê → ghi chuyển khoản">CK</button>'
      + `<select class="row-review" data-act="review" aria-label="Phân loại hóa đơn">${options}</select>`
      + '</span>';
  }

  // Bấm vào một dòng → xem hoặc phân loại. `reload` nạp lại popup đang mở để thấy ngay kết quả
  // vừa lưu; các thẻ Tổng quan cũng làm mới (đối chiếu tự chạy lại khi đổi TM/CK).
  function handleRowAction(event, reload) {
    const control = event.target.closest('[data-act]');
    if (!control) return;
    const host = control.closest('tr[data-id]');
    if (!host) return;
    const act = control.dataset.act;
    if (act === 'view') {
      if (host.dataset.key) openInvoice(host.dataset.key);
      return;
    }
    const action = act === 'review' ? control.value : act;
    if (!action) return;                       // chưa chọn gì trong ô phân loại ⇒ không gửi gì
    void (async () => {
      try {
        await post('/api/db/invoices/review', { id: Number(host.dataset.id), action });
        window.notice('Đã lưu phân loại hóa đơn.');
        if (reload) await reload();
        await refreshOverview(false);
      } catch (error) { fail(error); }
    })();
  }

  // --------------------------------------- POPUP DANH SÁCH DÙNG CHUNG (mục 5 / 6 / 27)
  // Một khung bảng duy nhất cho: chi tiết công nợ theo đối tác, hóa đơn của một mặt hàng và
  // mặt hàng bị dính cảnh báo — chỉ đổi tiêu đề + cấu trúc cột.
  const INVOICE_LIST_HEAD = '<tr><th>Ngày</th><th>Số / Ký hiệu</th><th>Ghi chú</th><th class="num">Số tiền</th><th>Thao tác</th></tr>';
  const GOODS_LIST_HEAD = '<tr><th>Tên hàng</th><th class="num">Bán ra</th><th class="num">Mua vào</th><th class="num">Mã hàng</th></tr>';
  let listReload = null;

  function showList({ title, subtitle, head, rows, emptyText, reload }) {
    $('list-title').textContent = title;
    $('list-subtitle').textContent = subtitle;
    $('list-head').innerHTML = head;
    $('list-rows').innerHTML = rows;
    $('list-empty').textContent = emptyText || 'Không có dòng nào trong kỳ này.';
    $('list-empty').hidden = Boolean(rows);
    listReload = reload || null;
    $('list-dialog').showModal();
  }

  function invoiceListRows(rows, noteOf) {
    return (rows || []).map(row => `<tr data-id="${Number(row.id) || ''}" data-key="${safeOverviewText(row.invoice_key || '')}">`
      + `<td>${safeOverviewText(shortDay(row.ngay_lap))}</td>`
      + `<td><button type="button" class="link invoice-link" data-act="view" title="Bấm để mở hóa đơn khổ A4">`
      + `${safeOverviewText(row.khh_hd ? `${row.so_hd || ''} · ${row.khh_hd}` : (row.so_hd || ''))}</button></td>`
      + `<td>${safeOverviewText(noteOf ? noteOf(row) : '')}</td>`
      + `<td class="num">${shortMoney(row.tong_tien)}</td>`
      + `<td>${reviewActionsHtml(row)}</td></tr>`).join('');
  }

  // Kỳ đang chọn ở header đi kèm mọi popup (mục 1) — nối vào chuỗi query đã có tham số.
  const rangeTail = () => overviewPeriod.from
    ? `&from=${encodeURIComponent(overviewPeriod.from)}&to=${encodeURIComponent(overviewPeriod.to)}` : '';

  // ----------------------------------------------------- CÔNG NỢ → CHI TIẾT (mục 5)
  async function openParty(direction, name) {
    const label = direction === 'BUY' ? 'Nhà cung cấp' : 'Khách hàng';
    const value = await api(`/api/db/debts/detail?direction=${encodeURIComponent(direction)}`
      + `&name=${encodeURIComponent(name)}${rangeTail()}`);
    const rows = value.rows || [];
    showList({
      title: `${label}: ${name || 'Chưa rõ tên'}`,
      subtitle: `${num.format(rows.length)} hóa đơn chuyển khoản chưa đối chiếu · ${shortMoney(value.amount)}`
        + (overviewPeriod.from ? ` · kỳ ${overviewPeriod.label}` : ''),
      head: INVOICE_LIST_HEAD,
      rows: invoiceListRows(rows, row => `${PAYMENT_LABELS[row.payment_method] || 'Chưa rõ'} · ${pendingLabels[row.reconciliation_status] || 'Chưa đối chiếu'}`),
      emptyText: 'Không có hóa đơn nào của đối tượng này trong kỳ.',
      reload: () => openParty(direction, name),
    });
  }

  // ------------------------------------------------- TOP HÀNG HÓA → HÓA ĐƠN (mục 6)
  async function openProduct(name, direction) {
    const value = await api(`/api/db/products/invoices?name=${encodeURIComponent(name)}`
      + `&direction=${encodeURIComponent(direction)}${rangeTail()}`);
    const rows = value.rows || [];
    showList({
      title: `Mặt hàng: ${name}`,
      subtitle: `${num.format(rows.length)} hóa đơn ${direction === 'BUY' ? 'mua vào' : 'bán ra'} · ${shortMoney(value.amount)}`,
      head: INVOICE_LIST_HEAD,
      rows: invoiceListRows(rows, row => PAYMENT_LABELS[row.payment_method] || 'Chưa rõ'),
      emptyText: 'Không có hóa đơn nào chứa mặt hàng này trong kỳ.',
      reload: () => openProduct(name, direction),
    });
  }

  // ------------------------------------------- CẢNH BÁO HÀNG HÓA → DANH SÁCH (mục 27)
  const GOODS_WARNINGS = {
    sell_over_buy: 'mặt hàng bán nhiều hơn số đã mua (theo số lượng)',
    missing_buy: 'mặt hàng bán ra chưa có dữ liệu mua',
    not_normalized: 'tên hàng chưa chuẩn hóa',
    code_mismatch: 'mặt hàng có nhiều mã hàng khác nhau',
  };

  async function openGoodsWarn(kind) {
    const value = await api(`/api/db/goods/detail?kind=${encodeURIComponent(kind)}${rangeTail()}`);
    const rows = value.rows || [];
    showList({
      title: 'Cần xem lại hàng hóa',
      subtitle: `${num.format(rows.length)} mặt hàng · ${GOODS_WARNINGS[kind] || kind}`,
      head: GOODS_LIST_HEAD,
      rows: rows.map(row => '<tr>'
        + `<td>${safeOverviewText(row.name)}</td>`
        + `<td class="num">${num.format(row.sellQty)} · ${shortMoney(row.sellAmount)}</td>`
        + `<td class="num">${num.format(row.buyQty)} · ${shortMoney(row.buyAmount)}</td>`
        + `<td class="num">${Number(row.codes || 0) > 1 ? `${num.format(row.codes)} mã` : '1 mã'}</td></tr>`).join(''),
      emptyText: 'Không có mặt hàng nào thuộc nhóm này trong kỳ.',
      reload: null,
    });
  }

  // ------------------------------------ THẺ SỐ / BIỂU ĐỒ → DANH SÁCH HÓA ĐƠN (mục 7)
  // Mọi thẻ còn lại (KPI, 2 thẻ chiều bán/mua, biểu đồ theo tháng) kéo về MỘT cách xem chi
  // tiết: popup hoá đơn lọc theo ĐÚNG kỳ + ĐÚNG chiều người vừa bấm — số trong popup vẫn do
  // server đếm (total), UI không tự lọc lại.
  async function openInvoiceList({ direction = '', from = '', to = '', title = '', noteOf } = {}) {
    const query = new URLSearchParams({ limit: '200', offset: '0' });
    const usedFrom = from || overviewPeriod.from;
    const usedTo = to || overviewPeriod.to;
    if (direction) query.set('direction', direction);
    if (usedFrom) query.set('from', usedFrom);
    if (usedTo) query.set('to', usedTo);
    const value = await api(`/api/db/invoices?${query}`);
    const rows = value.rows || [];
    const total = Number(value.total || rows.length);
    showList({
      title: title || (direction === 'SELL' ? 'Hóa đơn bán ra' : direction === 'BUY' ? 'Hóa đơn mua vào' : 'Hóa đơn trong kỳ'),
      subtitle: `${num.format(total)} hóa đơn`
        + (rows.length < total ? ` · đang hiện ${num.format(rows.length)} dòng đầu` : '')
        + (usedFrom ? ` · ${shortDay(usedFrom)} - ${shortDay(usedTo)}` : ' · tất cả thời gian'),
      head: INVOICE_LIST_HEAD,
      rows: invoiceListRows(rows, noteOf || (row => PAYMENT_LABELS[row.payment_method] || 'Chưa rõ')),
      emptyText: 'Không có hóa đơn nào trong kỳ này.',
      reload: () => openInvoiceList({ direction, from, to, title, noteOf }),
    });
  }

  // Bấm một tháng trên biểu đồ 12 tháng → hoá đơn của CHÍNH tháng đó (không đổi kỳ ở header).
  async function openMonthList(year, month) {
    const pad = value => String(value).padStart(2, '0');
    const from = `${year}-${pad(month)}-01`;
    const to = `${year}-${pad(month)}-${pad(new Date(Number(year), Number(month), 0).getDate())}`;
    await openInvoiceList({
      from, to, title: `Hóa đơn tháng ${month}/${year}`,
      noteOf: row => `${row.direction === 'BUY' ? 'Mua vào' : 'Bán ra'} · ${PAYMENT_LABELS[row.payment_method] || 'Chưa rõ'}`,
    });
  }

  async function openPending(filter) {
    pendingFilter = filter;
    const value = await api('/api/db/reconciliation/pending');
    const match = pendingFilters[filter] || pendingFilters.needs_review;
    const rows = [...(value.invoices || []), ...(value.bank || [])].filter(match);
    $('pending-title').textContent = pendingTitles[filter] || 'Cần kiểm tra';
    $('pending-empty').hidden = rows.length > 0;
    $('pending-rows').innerHTML = rows.map(row => {
      const amount = row.kind === 'bank'
        ? (Number(row.credit || 0) || -Number(row.debit || 0))
        : Number(row.tong_tien || 0);
      const title = row.kind === 'bank' ? row.description || ''
        : `${row.khh_hd || ''} ${row.so_hd || ''}`.trim() || row.invoice_key || '';
      const issues = (row.issues || []).map(code => pendingLabels[code] || code).join(', ')
        || pendingLabels[row.reconciliation_status] || '';
      return `<tr data-id="${Number(row.id) || ''}" data-key="${safeOverviewText(row.invoice_key || '')}">`
        + `<td>${pendingLabels[row.kind] || row.kind}</td><td>${safeOverviewText(row.ngay_lap || row.tran_date || '')}</td>`
        + `<td>${safeOverviewText(title)}</td><td>${safeOverviewText(row.partner || '')}</td>`
        + `<td class="num">${shortMoney(amount)}</td><td>${safeOverviewText(issues)}</td>`
        // MỤC 3 — cột thao tác: xem file xem trước + phân loại (TM/CK theo kết quả đối chiếu).
        + `<td>${reviewActionsHtml(row)}</td></tr>`;
    }).join('');
    // Hai cảnh báo về HÌNH THỨC THANH TOÁN có cách xử lý: đọc lại file hóa đơn gốc (mục 32).
    const fixable = filter === 'payment_unknown' || filter === 'payment_ambiguous';
    $('pending-actions').hidden = !fixable;
    const reprocess = $('pending-reprocess');
    if (reprocess) {
      reprocess.onclick = async () => {
        const restore = busyButton(reprocess, 'Đang đọc…');
        try {
          const result = await post('/api/db/invoices/reprocess-payment', {});
          restore();
          const parts = [`đã bù ${num.format(result.updated || 0)} hóa đơn`];
          if (result.empty) parts.push(`${num.format(result.empty)} hóa đơn file không ghi hình thức`);
          if (result.missing) parts.push(`${num.format(result.missing)} file đã mất`);
          window.notice(`Xong: ${parts.join(' · ')}.`);
          $('pending-dialog').close();
          await refreshOverview(true);
        } catch (error) { restore(); fail(error); }
      };
    }
    $('pending-dialog').showModal();
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
      localStorage.setItem(TAX_KEY, taxBusinessType);
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
    initOverviewPeriod();
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || '{}');
      if (saved.range && typeof saved.range === 'object') range = { from: saved.range.from || '', to: saved.range.to || '', chip: saved.range.chip || 'all' };
      const savedSize = Number(localStorage.getItem(SIZE_KEY));
      if ([50, 100, 200].includes(savedSize)) size = savedSize;
      const savedTax = localStorage.getItem(TAX_KEY);
      if (savedTax) taxBusinessType = savedTax;
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

  // Hộp thoại "Kiểm tra trước khi lưu" — chỉ dùng khi phải nhờ AI đọc lại: hiện bảng đối chiếu
  // ĐỌC TỰ ĐỘNG vs AI để user biết AI có đáng tin không rồi mới quyết định lưu.
  // Trả về Promise<boolean>: true = lưu, false = bỏ. Không có HTML (bản cũ) thì rơi về confirm().
  function askBankSave(info) {
    const dialog = $('bank-check-dialog');
    if (!dialog) return Promise.resolve(confirm(`${info.subtitle}\n\n${info.verdict}\n\nLưu vào MST ${info.mst}?`));
    $('bank-check-sub').textContent = info.subtitle;
    $('bank-check-why').textContent = `Đọc tự động không ra dữ liệu nên file đã được gửi cho AI đọc lại. Soát bảng dưới rồi hãy lưu.`;
    const compare = $('bank-check-compare');
    compare.hidden = !info.local;
    if (info.local) {
      // Lần đọc tự động không ra dòng nào ⇒ hiện “—” cho khỏi rối, lý do nằm ở dòng ghi chú bên dưới.
      const shown = value => (value > 0 ? num.format(value) : '—');
      $('bank-check-local-rows').textContent = shown(info.local.rows || 0);
      $('bank-check-local-in').textContent = shown(info.local.moneyIn || 0);
      $('bank-check-local-out').textContent = shown(info.local.moneyOut || 0);
      $('bank-check-local-note').textContent = info.local.reason || '';
    }
    const stats = info.stats || {};
    $('bank-check-ai-rows').textContent = num.format(stats.rows || 0);
    $('bank-check-ai-in').textContent = num.format(stats.moneyIn || 0);
    $('bank-check-ai-out').textContent = num.format(stats.moneyOut || 0);
    $('bank-check-ai-note').textContent = info.balanceNote || '';
    // Nhãn tin cậy: số dư khớp = đáng tin; lệch = phải soát lại; không có cột số dư = chỉ kiểm tra mức nhẹ.
    const badge = $('bank-check-ai-badge');
    if (stats.balanceChecks && stats.balanceBreaks) { badge.textContent = `lệch ${num.format(stats.balanceBreaks)} chỗ`; badge.className = 'bank-compare-badge warn'; }
    else if (stats.balanceChecks) { badge.textContent = 'số dư khớp'; badge.className = 'bank-compare-badge ok'; }
    else { badge.textContent = 'không có cột số dư'; badge.className = 'bank-compare-badge'; }
    const verdict = $('bank-check-verdict');
    verdict.textContent = (info.level === 'warn' ? '! ' : '✓ ') + (info.verdict || '');
    verdict.classList.toggle('warn', info.level === 'warn');
    const issues = $('bank-check-issues');
    const lines = info.issues || [];
    issues.hidden = !lines.length;
    issues.replaceChildren(...lines.map(line => { const p = document.createElement('p'); p.textContent = line; return p; }));
    $('bank-check-save').textContent = `Lưu vào MST ${info.mst}`;
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (settled) return; settled = true; if (dialog.open) dialog.close(); resolve(value); };
      $('bank-check-save').onclick = () => done(true);
      $('bank-check-cancel').onclick = () => done(false);
      $('bank-check-close').onclick = () => done(false);
      dialog.oncancel = () => done(false);
      dialog.showModal();
    });
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
    if (!await askConfirm({
      title: 'Kiểm tra tài khoản trước khi nhập',
      ok: 'OK, chọn file',
      cancel: 'Chọn MST khác',
      text: `Nhập file sao kê cho đúng tài khoản này?

${label}

Bấm OK rồi chọn file. Nếu SAI tài khoản, bấm Huỷ và chọn MST khác trước.`,
    })) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const bar = $('data-bank-bar');
      const note = $('data-bank-note');
      // Popup tiến trình nằm cùng chỗ/chung khung với toast — chạy rồi TỰ BIẾN thành kết quả
      // (xanh = xong, đỏ = hỏng). Dòng chữ + thanh trong tab vẫn giữ làm đường dự phòng.
      const job = window.noticeProgress ? window.noticeProgress(`Đang đọc ${file.name}…`) : null;
      const setProgress = (value, text) => {
        bar.hidden = value === null; if (value !== null) bar.value = value; note.textContent = text;
        if (job) job.set(value === null ? undefined : value, text);
      };
      // Tên đường đọc — hiện trong kết quả để biết file được xử lý theo cách nào.
      let route = 'Excel/CSV';
      $('data-bank-import').disabled = true;
      try {
        // Bước 2: đọc theo loại file.
        setProgress(20, `Đang đọc ${file.name}…`);
        const fileToBase64 = () => new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('Đọc file không được.'));
          reader.readAsDataURL(file);
        });
        // Đường AI dùng chung: PDF-chữ đọc local không khớp, PDF-scan và ảnh đều đi qua đây.
        const aiPreview = async message => {
          setProgress(40, message);
          return post('/api/db/bank/preview', { fileName: file.name, data: await fileToBase64() });
        };
        // Kết quả đọc coi là "không dùng được" khi server báo lỗi hoặc không có giao dịch nào.
        const unusable = value => {
          const v = (value && value.verification) || {};
          return v.level === 'error' || !(((v.stats) || {}).rows > 0);
        };
        const parsed = await window.BankPdf.readAny(file);
        let preview;
        // Lần thử ĐỌC TỰ ĐỘNG của PDF có chữ (chỉ có khi phải nhờ AI) — dùng để đối chiếu trước khi lưu.
        let localAttempt = null;
        if (parsed.kind === 'excel') {
          route = 'Excel/CSV';
          setProgress(45, `Đang chuẩn hoá + kiểm tra ${file.name}…`);
          preview = await post('/api/db/bank/preview', { fileName: file.name, data: await fileToBase64() });
        } else if (parsed.kind === 'pdf-text') {
          route = 'PDF text';
          setProgress(45, `Đã đọc PDF có chữ (${parsed.pages} trang) — đang chuẩn hoá + kiểm tra…`);
          try {
            preview = await post('/api/db/bank/preview-rows', { fileName: file.name, rows: parsed.grid });
          } catch (error) {
            preview = { verification: { level: 'error', issues: [error.message] } };
          }
          // Có chữ mà đọc tự động không ra dữ liệu dùng được → xin phép gửi AI đọc lại (tốn 1 lượt AI).
          if (unusable(preview)) {
            const localVerification = preview.verification || {};
            const localStats = localVerification.stats || {};
            localAttempt = {
              rows: localStats.rows || 0,
              moneyIn: localStats.moneyIn || 0,
              moneyOut: localStats.moneyOut || 0,
              reason: (localVerification.issues || [])[0] || 'Không đọc ra dòng giao dịch nào.',
            };
            const problems = (localVerification.issues || []).join('\n');
            if (await askConfirm({
              title: 'PDF có chữ nhưng đọc tự động không ra dữ liệu',
              tone: 'warn',
              ok: 'Gửi AI đọc lại',
              cancel: 'Không gửi, bỏ qua',
              text: `PDF có chữ nhưng đọc tự động không ra dữ liệu.${problems ? '\n' + problems : ''}\n\nGửi file này cho AI đọc lại? (tốn 1 lượt AI, có thể mất tới 1 phút)`,
            })) {
              route = 'PDF AI (đọc lại)';
              preview = await aiPreview('PDF có chữ nhưng đọc tự động không khớp — đang gửi AI đọc lại… (có thể mất tới 1 phút)');
            }
          }
        } else if (parsed.kind === 'pdf-scan' || parsed.kind === 'image') {
          route = parsed.kind === 'image' ? 'Ảnh AI' : 'PDF AI';
          preview = await aiPreview(parsed.kind === 'image' ? 'Đang gửi ảnh cho AI đọc… (có thể mất tới 1 phút)' : 'PDF không có chữ (scan) — đang gửi AI đọc… (có thể mất tới 1 phút)');
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
        if (localAttempt) {
          // Phải nhờ AI đọc lại → hiện bảng đối chiếu rõ ràng trước khi hỏi lưu.
          const balanceNote = stats.balanceChecks
            ? `Kiểm tra số dư: ${stats.balanceChecks} cặp dòng — ${stats.balanceBreaks ? 'LỆCH ' + stats.balanceBreaks + ' chỗ' : 'khớp'}`
            : 'File không có cột số dư — kiểm tra mức nhẹ (đủ ngày, đủ tiền).';
          const verdict = stats.balanceChecks
            ? (stats.balanceBreaks
              ? `AI đọc được ${num.format(stats.rows)} giao dịch, nhưng số dư LỆCH ${num.format(stats.balanceBreaks)} chỗ — nên kiểm tra lại trước khi lưu.`
              : `AI đọc được ${num.format(stats.rows)} giao dịch và chuỗi số dư KHỚP — kết quả đọc lại đáng tin.`)
            : `AI đọc được ${num.format(stats.rows)} giao dịch. File không có cột số dư nên chỉ kiểm tra mức nhẹ.`;
          confirmed = await askBankSave({
            mst,
            subtitle: `${file.name} · ${label}`,
            local: localAttempt,
            stats,
            balanceNote,
            verdict,
            level: verification.level,
            issues: verification.issues || [],
          });
        } else if (verification.level === 'warn') {
          confirmed = await askConfirm({
            title: 'CẢNH BÁO — kiểm tra kỹ trước khi lưu',
            tone: 'warn',
            ok: `Vẫn lưu vào MST ${mst}`,
            cancel: 'Bỏ, không lưu',
            text: `${summary}
CẢNH BÁO: phát hiện vấn đề:
${(verification.issues || []).join('\n')}`,
          });
        } else {
          confirmed = await askConfirm({
            title: 'Số liệu KHỚP — lưu vào kho?',
            ok: `Lưu vào MST ${mst}`,
            cancel: 'Bỏ, không lưu',
            text: summary,
          });
        }
        if (!confirmed) {
          setProgress(null, `Đã bỏ ${file.name} — không lưu gì vào kho.`);
          if (job) job.finish('ok', `Đã bỏ ${file.name} (${route}) — không lưu gì.`);
          return;
        }

        setProgress(80, `Đang lưu ${file.name} vào kho MST ${mst}…`);
        const result = await post('/api/db/bank/import-rows', { fileName: file.name, fileHash: preview.fileHash || '', rows: preview.rows });
        setProgress(100, `Đã lưu ${file.name}: mới ${num.format(result.imported)}, trùng ${num.format(result.duplicate)}, lỗi ${num.format(result.failed)}.`);
        const doneText = `✓ ${route}: đã nhập ${file.name} — ${num.format(result.imported)} giao dịch mới, ${num.format(result.duplicate)} trùng, ${num.format(result.failed)} dòng lỗi.`;
        if (job) job.finish('ok', doneText);
        else if (window.notice) window.notice(`Đã nhập sao kê ${file.name} vào MST ${mst}: ${num.format(result.imported)} giao dịch mới, ${num.format(result.duplicate)} trùng, ${num.format(result.failed)} dòng lỗi.`);
        bankPage = 0;
        await loadBankSummary().catch(ignoreAbort);
        await loadBank();
      } catch (error) {
        setProgress(null, `Lỗi nhập ${file.name}: ${error.message}`);
        if (job) job.finish('error', `Lỗi nhập ${file.name} (${route}): ${error.message}`);
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
        if (!await askConfirm({
          title: 'Xoá file sao kê',
          tone: 'error',
          ok: 'Xoá file',
          cancel: 'Giữ lại',
          text: `Xoá file "${file.file_name}" khỏi MST ${mst}?
Xoá luôn ${num.format(file.rows_imported || 0)} giao dịch của file này. Không thể hoàn tác.`,
        })) return;
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
        // Hộp của app (không dùng prompt() gốc): ô nhập + danh sách MST bấm chọn cho khỏi gõ sai.
        const toMst = await askConfirm({
          title: 'Chuyển file sang MST khác', tone: 'warn', ok: 'Chuyển', cancel: 'Huỷ',
          text: `Chuyển "${file.file_name}" sang kho của MST nào?\nBấm một MST bên dưới hoặc gõ vào ô.`,
          input: { placeholder: 'MST đích', options: mstOptions },
        });
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
    if (!await askConfirm({
      title: 'Xoá toàn bộ sao kê của MST này',
      tone: 'error',
      ok: 'Xoá toàn bộ',
      cancel: 'Giữ lại',
      text: `Xoá toàn bộ sao kê ngân hàng của MST này (${num.format(value.transactions)} giao dịch, ${value.files} file)? Không thể hoàn tác.`,
    })) return;
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
    $('view-overview').onclick = () => showView('overview');
    $('view-download').onclick = () => showView('download');
    $('view-data').onclick = () => showView('data');
    $('view-bank').onclick = () => showView('bank');
    $('overview-refresh').onclick = () => {
      const restore = busyButton($('overview-refresh'), 'Đang đối chiếu…');
      void refreshOverview(true).finally(restore);
    };
    // Bộ lọc kỳ nằm riêng trong tab Tổng quan.
    $('overview-period-mode').onchange = () => applyOverviewPeriod();
    for (const id of ['overview-period-year', 'overview-period-month', 'overview-period-quarter']) $(id).onchange = () => applyOverviewPeriod();
    for (const id of ['overview-period-from', 'overview-period-to']) $(id).onchange = () => applyOverviewPeriod();
    // Bấm một dòng "Cần kiểm tra" → mở đúng danh sách chi tiết tương ứng (mục 27).
    $('overview-alerts').onclick = event => {
      const row = event.target.closest('button.alert-row');
      if (row) openPending(row.dataset.filter || 'needs_review').catch(fail);
    };
    $('pending-close').onclick = () => $('pending-dialog').close();
    // MỤC 3 — popup "Cần kiểm tra": bấm Xem / TM / CK / chọn phân loại trên TỪNG dòng.
    $('pending-rows').onclick = event => handleRowAction(event, () => openPending(pendingFilter));
    $('pending-rows').onchange = event => handleRowAction(event, () => openPending(pendingFilter));
    // POPUP DANH SÁCH DÙNG CHUNG (mục 5 / 6) — cùng bộ thao tác như popup "Cần kiểm tra".
    $('list-close').onclick = () => $('list-dialog').close();
    $('list-rows').onclick = event => handleRowAction(event, listReload);
    $('list-rows').onchange = event => handleRowAction(event, listReload);
    // MỤC 5 — bấm khách hàng / nhà cung cấp ở thẻ CÔNG NỢ → chi tiết hóa đơn của đối tượng đó.
    $('overview-debt').onclick = event => {
      const row = event.target.closest('.debt-party');
      if (row) openParty(row.dataset.direction, row.dataset.name).catch(fail);
    };
    // MỤC 6 + MỤC 27 — bấm mặt hàng / nút "Xem thêm" / một trong4 cảnh báo ở thẻ Hàng hóa.
    $('overview-products').onclick = event => {
      const more = event.target.closest('[data-goods-more]');
      if (more) {
        const list = more.closest('.goods-list');
        const extra = list && list.querySelector('.goods-extra');
        if (!extra) return;
        const show = extra.hidden;
        extra.hidden = !show;
        if (!more.dataset.label) more.dataset.label = more.textContent;
        more.textContent = show ? 'Thu gọn' : more.dataset.label;
        return;
      }
      const warn = event.target.closest('[data-warn]');
      if (warn) { openGoodsWarn(warn.dataset.warn).catch(fail); return; }
      const product = event.target.closest('[data-product]');
      if (product) openProduct(product.dataset.product, product.dataset.direction || 'SELL').catch(fail);
    };
    // MỤC 7 — nút ở chân các thẻ → mở đúng danh sách chi tiết của con số trong thẻ:
    //   [data-filter] → popup "Cần kiểm tra" · [data-invoices] → popup hoá đơn theo chiều
    //   [data-goto]   → chuyển sang tab cần tới (vd. Sao kê ngân hàng).
    const openCardLink = event => {
      const filter = event.target.closest('[data-filter]');
      if (filter) { openPending(filter.dataset.filter).catch(fail); return; }
      const invoices = event.target.closest('[data-invoices]');
      if (invoices) { openInvoiceList({ direction: invoices.dataset.invoices }).catch(fail); return; }
      const goto = event.target.closest('[data-goto]');
      if (goto) showView(goto.dataset.goto);
    };
    $('overview-reconciliation').onclick = openCardLink;
    $('overview-bank').onclick = openCardLink;
    $('overview-sell').onclick = openCardLink;
    $('overview-buy').onclick = openCardLink;
    // MỤC 19 — riêng dòng "Cần kiểm tra" ở dải KPI là nút bấm → danh sách chi tiết.
    $('overview-kpis').onclick = openCardLink;
    // MỤC 28 + 7 — bấm một tháng trên biểu đồ 12 tháng → hoá đơn của tháng đó.
    $('overview-monthly').onclick = event => {
      const month = event.target.closest('[data-month]');
      if (month) openMonthList(overviewYear, Number(month.dataset.month)).catch(fail);
    };
    // MỤC 29 — sao chép JSON thống kê. CHƯA có AI nên không gửi đi đâu cả: người dùng tự dán vào
    // chỗ nào cần; khi tích hợp AI thì route mới chỉ nhận đúng object này.
    $('ai-summary-copy').onclick = async () => {
      const button = $('ai-summary-copy');
      if (!aiSummaryJson) return;
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(aiSummaryJson);
        button.textContent = 'Đã sao chép ✓';
      } catch {
        // Không có quyền clipboard → chọn sẵn nội dung để người dùng Ctrl+C, KHÔNG hiện hộp thoại.
        const range = document.createRange();
        range.selectNodeContents($('ai-summary-json'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        button.textContent = 'Đã chọn — bấm Ctrl+C';
      }
      setTimeout(() => { button.textContent = original; }, 2000);
    };
    // Chọn loại hình kinh doanh → đọc lại NGƯỠNG theo đúng năm (mục 26), không đổi gì khác.
    $('tax-rule').onchange = () => {
      taxBusinessType = $('tax-rule').value;
      savePrefs();
      void refreshOverview(false);
    };

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
        if (view === 'overview') refreshOverview(false);
      }
    });
  }

  restorePrefs();
  bind();
  // Vẽ tab Tổng quan ngay khi mở app: bố cục thật hiện ra tức thì kèm chip "Đang tải…",
  // dữ liệu về thì chip tự ẩn. Không còn khoảng trống "vô tri" lúc chờ kiểm tra phiên.
  showView('overview');
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
