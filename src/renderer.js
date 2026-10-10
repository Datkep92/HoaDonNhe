'use strict';
const $ = id => document.getElementById(id);
const optional = id => document.getElementById(id);
const labels = { idle: 'Sẵn sàng', searching: 'Đang tra cứu', downloading: 'Đang tải', paused: 'Tạm dừng', auth_required: 'Cần đăng nhập', ready: 'Sẵn sàng tải', completed: 'Hoàn tất', failed: 'Có lỗi', partial: 'Còn hóa đơn lỗi', queued: 'Chờ tải', running: 'Đang xử lý', skipped: 'Đã có sẵn – bỏ qua', done: 'Đã tải', retrying: 'Đang thử lại' };
// mst-format.js nạp bằng <script> TRƯỚC file này. Nếu vì lý do gì đó nó không nạp được thì dùng bản
// dự phòng ngay tại đây — nếu không sẽ ném "Cannot read properties of undefined" tại chỗ nhập MST.
const MstFormat = window.MstFormat || (() => {
  const HINT = 'Không nạp được bộ kiểm tra định dạng (mst-format.js). Mở lại ứng dụng.';
  return { MST_HINT: HINT, isValidMst: () => true, normalizeMst: v => String(v ?? '').trim(), baseMst: v => String(v ?? '').trim().split('-')[0], mstAliases: v => [String(v ?? '').trim()] };
})();
const errorLabels = { auth: 'Cần đăng nhập lại', rate_limited: 'Cổng đang giới hạn nhịp', timeout: 'Cổng phản hồi chậm', network: 'Lỗi kết nối', invalid_xml: 'XML/ZIP không hợp lệ', portal: 'Lỗi từ cổng thuế' };
let current = { busy: false, accounts: [] }, pending = false, initialized = false, initialLoading = true;
// Bảng 1.000 dòng được server TÁCH khỏi /api/state (payload rảnh giảm từ hàng trăm KB còn vài KB):
// /api/state chỉ chứa tổng hợp + revision; bảng fetch riêng và chỉ khi revision đổi.
// Danh sách CUỘN như bản cũ (một payload, KHÔNG nút sang trang) nhưng MỚI NHẤT Ở TRÊN — server trả
// thứ tự đảo nên hoá đơn vừa tải xong nằm ngay đầu bảng, người dùng không phải cuộn xuống tìm.
let itemsRevisionSeen = 0;
let itemsLoading = false;

// ---------------------------------------------------------------------------
// CACHE NHẸ DANH SÁCH MST (localStorage) — dòng MST phiên gần nhất được tô sáng NGAY từ khung
// hình đầu tiên, không phải chờ 1–3 giây `/api/state` (lúc đó sidebar trống trơn, trông "vô tri").
// Chỉ vài chục phần tử, vài trăm byte; KHÔNG chứa mật khẩu, cookie hay gì nhạy cảm (chỉ mã, tên,
// trạng thái phiên và số mã định danh để vẽ dòng cho giống). Khi dữ liệu thật về thì ghi đè và
// cache được cập nhật lại — nên cache chỉ là "ảnh chụp" cho nhịp đầu, không phải nguồn sự thật.
const MST_CACHE_KEY = 'hd.mst-cache.v1';
const MST_CACHE_MAX = 60; // danh sách dài hơn thì cắt — cache chỉ để vẽ nhanh, không cần đủ
function readMstCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MST_CACHE_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.accounts) || !parsed.accounts.length) return null;
    return parsed;
  } catch { return null; } // cache hỏng (bản cũ, JSON lỗi…) coi như không có
}
// Nguồn CHÍNH cho khung hình đầu là `window.HD_BOOT_CACHE` do máy chủ phát (xem bootCacheScript
// trong server.js). Máy chủ mở cổng NGẪU NHIÊN mỗi lần chạy nên origin đổi ⇒ localStorage KHÔNG
// đọc lại được giữa hai lần mở app; cache dưới đây chỉ là đường DỰ PHÒNG cho môi trường chạy ở
// cổng cố định (mock dev server) và cho bản giao diện cũ còn cache sẵn. Hàm này chuẩn hoá cả hai
// về cùng một hình dạng để chỗ gọi không phải phân biệt.
function firstPaintMstList() {
  const boot = typeof window !== 'undefined' && window.HD_BOOT_CACHE;
  if (boot && Array.isArray(boot.accounts) && boot.accounts.length) {
    return { selected: boot.selected || '', accounts: boot.accounts.slice(0, MST_CACHE_MAX) };
  }
  return readMstCache();
}
let mstCacheSignature = '';
function writeMstCache(state) {
  try {
    const accounts = (state.accounts || []).slice(0, MST_CACHE_MAX).map(account => ({
      mst: account.mst,
      name: account.name || '',
      session: account.session || '',
      identifiers: (account.identifiers || []).slice(0, 8),
      remembered: !!account.remembered,
    }));
    const selected = state.selected || '';
    // Bỏ qua khi y hệt lần trước: vòng poll 1,5 giây không nên ghi localStorage liên tục.
    const signature = [selected, ...accounts.map(a => `${a.mst}\u0001${a.name}\u0001${a.session}\u0001${a.remembered}\u0001${a.identifiers.join(',')}`)].join('\u0002');
    if (signature === mstCacheSignature) return;
    mstCacheSignature = signature;
    localStorage.setItem(MST_CACHE_KEY, JSON.stringify({ selected, accounts }));
  } catch { /* hết quota / chặn localStorage — cache là tuỳ chọn, bỏ qua */ }
}

// Ngày lập của cổng thuế (`tdlap`) là MỐC UTC: "2026-08-30T17:00:00Z" chính là 00:00 ngày 31/08
// giờ Việt Nam. Cắt 10 ký tự đầu sẽ lệch MỘT NGÀY (lỗi thật đã gặp ở file Excel) — phải quy đổi
// theo múi giờ Việt Nam, cùng quy tắc với src/vn-date.js ở phía máy chủ.
const dayFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
const dayOf = value => { const time = Date.parse(String(value ?? '')); return Number.isFinite(time) ? dayFormat.format(new Date(time)) : ''; };

async function loadItemsIfChanged(revision) {
  if (itemsLoading || revision === itemsRevisionSeen) return;
  itemsLoading = true;
  try {
    const response = await fetch('/api/state/items');
    const result = await response.json();
    if (result && result.ok) {
      if (current) current.items = result.value;
      itemsRevisionSeen = result.revision;
      renderItemsTable(current);
    }
  } catch { /* nhịp sau thử lại; bảng cũ vẫn hiển thị */ }
  finally { itemsLoading = false; }
}
let loginId = '', preparedMst = '', loginWorking = false, polling = false;
// "selectingMst": MST vừa được bấm, đang chờ máy chủ xác nhận chọn. Chỉ để VẼ phản hồi tức thì
// (dòng tô sáng + xoay trong danh sách) — KHÔNG dùng để chặn bấm: chọn MST khác vẫn tự do, MST
// sau sẽ ghi đè lên MST trước, logic chọn giữ nguyên như cũ.
let selectingMst = '';
async function call(url, body) {
  let response;
  try { response = await fetch(url, { method: url === '/api/state' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Không kết nối được ứng dụng. Hãy mở lại CN-Tax-Tools.exe.'); }
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
}
// Thông báo ở góc phải; có thể kèm nút hành động bấm được (ví dụ “Mở file”, “Mở thư mục”).
// Thông báo dạng TOAST ở GÓC PHẢI TRÊN — xếp chồng nhiều toast, mượt vào/ra (style.css).
// Mỗi toast là một phần tử riêng: thông báo mới không xoá thông báo cũ (trước đây chỉ có một
// ô #notice — thông báo sau đè thông báo trước, dễ bỏ lỡ). Lỗi = đỏ, còn lại = xanh.
// Tự tắt 6s (thường) / 10s (có nút hành động), luônn có nút ✕; hover thì tạm dừng đồng hồ.
const NOTICE_MAX = 4; // tối đa 4 toast cùng lúc — quá thì toast cũ nhất tự nhường chỗ
function notice(text, actions, kind) {
  const stack = $('notice-stack');
  if (!stack) return;
  const isError = kind === 'error';
  // Quá số toast cho phép: gỡ cái cũ nhất cho gọn gàng.
  while (stack.children.length >= NOTICE_MAX) stack.firstElementChild.remove();
  const box = document.createElement('div');
  box.className = `toast ${isError ? 'notice-error' : 'notice-ok'}`;
  box.setAttribute('role', isError ? 'alert' : 'status');
  const span = document.createElement('span'); span.className = 'toast-text'; span.textContent = text; box.append(span);
  for (const action of actions || []) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'link'; button.textContent = action.label;
    button.onclick = async () => {
      try { await call(action.url, action.body || {}); dismiss(); }
      catch (error) { noticeFail(error.message); }
    };
    box.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'notice-close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Đóng thông báo');
  close.onclick = () => dismiss();
  box.append(close);
  let timer = setTimeout(() => dismiss(), actions?.length ? 10000 : 6000);
  function dismiss() {
    clearTimeout(timer);
    if (box.dataset.leaving) return;
    box.dataset.leaving = '1';
    box.classList.add('toast-leave'); // hiệu ứng thu nhỏ/mờ rồi mới gỡ khỏi DOM
    setTimeout(() => box.remove(), 200);
  }
  // Hover = người dùng đang đọc: tạm dừng đồng hồ tự tắt, rời ra mới đếm tiếp.
  box.onmouseenter = () => clearTimeout(timer);
  box.onmouseleave = () => { clearTimeout(timer); timer = setTimeout(() => dismiss(), actions?.length ? 10000 : 6000); };
  stack.append(box);
}
window.notice = notice;
// Báo lỗi: dùng đúng màu đỏ. Mọi thông báo khác đi qua notice() sẽ là màu xanh.
window.noticeFail = (text, actions) => notice(text, actions, 'error');
// Tiến trình nhập file: cùng chỗ, cùng khung với toast — có thanh chạy, rồi TỰ BIẾN thành
// kết quả (xanh = xong, đỏ = hỏng) và tự tắt. Trả về handle để nơi gọi cập nhật từng bước.
//   const job = noticeProgress('Đang đọc …');
//   job.set(45, 'Đang chuẩn hoá …');  // % + chữ
//   job.finish('ok', 'Đã nhập …');    // hoặc job.finish('error', 'Lỗi …')
function noticeProgress(text) {
  const stack = $('notice-stack');
  const noop = { set() {}, finish() {}, close() {} };
  if (!stack) return noop;
  while (stack.children.length >= NOTICE_MAX) stack.firstElementChild.remove();
  const box = document.createElement('div');
  box.className = 'toast toast-progress';
  box.setAttribute('role', 'status');
  const span = document.createElement('span'); span.className = 'toast-text'; span.textContent = text;
  const bar = document.createElement('progress'); bar.className = 'toast-bar'; bar.max = 100; bar.value = 0;
  const body = document.createElement('div'); body.className = 'toast-progress-body'; body.append(span, bar);
  box.append(body);
  let timer = null;
  function dismiss() {
    if (box.dataset.leaving) return;
    box.dataset.leaving = '1';
    clearTimeout(timer);
    box.classList.add('toast-leave'); // cùng hiệu ứng thu nhỏ/mờ của toast
    setTimeout(() => box.remove(), 200);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'notice-close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Đóng thông báo');
  close.onclick = () => dismiss();
  box.append(close);
  box.onmouseenter = () => clearTimeout(timer); // đang đọc thì dừng đồng hồ
  stack.append(box);
  return {
    set(value, message) {
      if (message) span.textContent = message;
      if (typeof value === 'number') { bar.hidden = false; bar.value = Math.max(0, Math.min(100, value)); }
    },
    finish(kind, message) {
      if (message) span.textContent = message;
      bar.remove();
      box.classList.remove('toast-progress');
      box.classList.add(kind === 'error' ? 'notice-error' : 'notice-ok');
      box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      clearTimeout(timer);
      timer = setTimeout(dismiss, kind === 'error' ? 10000 : 6000);
    },
    close: dismiss,
  };
}
window.noticeProgress = noticeProgress;
// Hộp XÁC NHẬN dùng chung — thay cho confirm() gốc của trình duyệt (hộp xám "127.0.0.1 says"
// nhìn lệch hẳn tông app). Dựng bằng <dialog> + showModal(), đúng tông mint/teal của app.
//   const ok = await askConfirm({ title, text, ok: 'Lưu', cancel: 'Huỷ', tone: 'warn' });
// tone: 'ok' (mặc định, xanh) · 'warn' (cam, có cảnh báo) · 'error' (đỏ).
// Thêm input: { placeholder, value, options: ['MST1', ...] } khi cần hỏi một giá trị (thay prompt()):
//   const mst = await askConfirm({ title, text, input: { placeholder: 'MST đích', options: [...] } });
//   → OK trả về chuỗi đã gõ, Huỷ trả về null.
// <dialog> + showModal() là BẮT BUỘC, không phải sở thích: hộp này được mở từ bên trong các
// hộp khác đang modal (nút Xoá / Chuyển MST… trong hộp Quản lý file sao kê). Chỉ có
// showModal() mới đưa hộp vào TOP LAYER — nơi không `z-index` nào vượt được — nên nó luôn
// nằm trên hộp cha; dựng bằng <div> thì nằm dưới hộp cha và không bấm được.
// Không có HTML (bản cũ) thì rơi về confirm()/prompt() để không vỡ luồng.
function askConfirm(info) {
  const options = typeof info === 'string' ? { text: info } : (info || {});
  const box = $('app-confirm');
  if (!box) return Promise.resolve(options.input ? prompt(options.text || '') : confirm(options.text || ''));
  // Đóng dở hộp cũ (nếu người dùng bấm chồng nhiều lần) để không dồn hai modal một lúc.
  let closeTimer = null;
  if (!box) return Promise.resolve(options.input ? prompt(options.text || '') : confirm(options.text || ''));
  const text = options.text || '';
  $('app-confirm-title').textContent = options.title || 'Xác nhận';
  const paragraph = $('app-confirm-text');
  paragraph.textContent = text;
  paragraph.hidden = !text;
  const ok = $('app-confirm-ok'), cancel = $('app-confirm-cancel');
  ok.textContent = options.ok || 'OK';
  cancel.textContent = options.cancel || 'Huỷ';
  box.querySelector('.app-confirm-card').className = `app-confirm-card tone-${options.tone || 'ok'}`;
  // Ô NHẬP (tuỳ chọn) — dùng thay prompt() gốc. Danh sách gợi ý bấm chọn nằm ngay dưới ô.
  const slot = $('app-confirm-input');
  const wantsInput = !!options.input && !!slot;
  let field = null;
  if (slot) { slot.textContent = ''; slot.hidden = !wantsInput; }
  if (wantsInput) {
    const spec = typeof options.input === 'object' ? options.input : {};
    field = document.createElement('input');
    field.type = 'text';
    field.value = spec.value || '';
    field.placeholder = spec.placeholder || '';
    field.autocomplete = 'off';
    slot.append(field);
    const choices = (Array.isArray(spec.options) ? spec.options : []).filter(Boolean);
    if (choices.length) {
      const chips = document.createElement('div');
      chips.className = 'app-confirm-chips';
      choices.forEach(choice => {
        const chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'app-confirm-chip'; chip.textContent = choice;
        chip.onclick = () => {
          field.value = choice;
          chips.querySelectorAll('.app-confirm-chip').forEach(other => other.classList.toggle('on', other === chip));
          field.focus();
        };
        chips.append(chip);
      });
      slot.append(chips);
    }
  }
  return new Promise(resolve => {
    let settled = false;
    const done = value => {
      if (settled) return; settled = true;
      document.removeEventListener('keydown', onKey, true);
      box.removeEventListener('cancel', onCancel);
      ok.onclick = cancel.onclick = box.onclick = null;
      if (field) field.onkeydown = null;
      box.classList.remove('show'); // mờ + thu nhỏ rồi mới đóng, mượt như toast
      // Chờ hết hiệu ứng mới đóng dialog: đóng ngay lập tức sẽ mất chuyển cảnh mờ dần.
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => { if (box.open) box.close(); }, 160);
      resolve(value);
    };
    // Có ô nhập: OK trả chuỗi đã gõ (rỗng coi như huỷ, giống prompt gốc), Huỷ trả null.
    const dismiss = () => done(wantsInput ? null : false);
    const accept = () => done(wantsInput ? (field.value.trim() || null) : true);
    // Esc = Huỷ. <dialog> KHÔNG huỷ bằng default action của keydown mà bằng sự kiện `cancel`
    // riêng. Chỉ chặn keydown là không đủ: hộp cha (Quản lý file sao kê) cũng nhận `cancel`
    // và bị đóng theo ⇒ bấm Esc một lần mất cả hai hộp. `cancel` không nổi lên nên chặn ở
    // đây là đủ, và kết quả vẫn do mình quyết định ⇒ Promise luôn resolve.
    const onCancel = event => { event.preventDefault(); dismiss(); };
    const onKey = event => { if (event.key === 'Escape' && typeof box.showModal !== 'function') dismiss(); };
    if (field) field.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); accept(); } };
    ok.onclick = accept;
    cancel.onclick = dismiss;
    box.onclick = event => { if (event.target === box || event.target === box.querySelector('.app-confirm-card')) dismiss(); }; // bấm ra ngoài = Huỷ
    box.addEventListener('cancel', onCancel);
    document.addEventListener('keydown', onKey, true);
    // showModal(): đưa hộp vào TOP LAYER nên luôn nằm TRÊN mọi hộp modal khác đang mở
    // (nút "Xoá" / "Chuyển MST…" nằm trong hộp Quản lý file sao kê). Rơi về show() cho
    // trình duyệt quá cũ không có modal ⇒ vẫn hiện được, chỉ kém canh tâm.
    if (!box.hidden) box.close();
    clearTimeout(closeTimer);
    if (typeof box.showModal === 'function') box.showModal();
    else { box.setAttribute('open', ''); box.style.position = 'fixed'; box.style.inset = '0'; box.style.zIndex = '80'; box.style.display = 'flex'; }
    requestAnimationFrame(() => box.classList.add('show'));
    (field || ok).focus();
  });
}
window.askConfirm = askConfirm;
const SESSION_LABEL = { live: 'Đang dùng phiên đăng nhập của phiên làm việc này', saved: 'Còn phiên đã lưu — bấm để vào tra cứu', none: 'Chưa đăng nhập — bấm để đăng nhập' };
const displayName = account => account.name || account.label || account.mst;
// Tạo một lần rồi dùng lại: new Intl.NumberFormat cho từng dòng là chi phí thuần tuý (bảng có thể
// tới 1.000 dòng) mà kết quả định dạng không đổi.
const amountFormat = new Intl.NumberFormat('vi-VN');
// Phản hồi tức thì cho nút phải chờ máy chủ (mở cửa sổ Chrome mất vài giây): khoá nút và đổi nhãn
// ngay lúc bấm. Khi xong, mở khoá và chỉ trả lại nhãn cũ nếu handler chưa tự đặt nhãn mới.
function busyButton(button, label) {
  const original = button.textContent;
  button.disabled = true; button.textContent = label;
  return () => { button.disabled = false; if (button.textContent === label) button.textContent = original; };
}
let editingMst = '';
function closeRowMenus() {
  document.querySelectorAll('.row-menu-panel').forEach(x => x.remove());
  document.querySelectorAll('.mst-row.menu-open').forEach(x => x.classList.remove('menu-open'));
  rowMenuAnchor = null;
  rowMenuOpen = false;
}
// Menu ⋯ đang mở nằm TRONG một dòng MST, mà renderAccounts dựng lại toàn bộ danh sách mỗi nhịp
// khi có job chạy — bấm ⋯ xong 1,5 giây là panel biến mất. Khi có menu mở, hoãn dựng lại danh sách
// (chỉ một nhịp poll, logic hiển thị giữ nguyên) và ghi nhớ dòng đó để dựng lại sau khi menu đóng.
let rowMenuOpen = false;
// Panel ⋯ là con của dòng nhưng dùng position:fixed (xem style.css) để MỞ RA NGOÀI cột trái, bung
// sang vùng nội dung — nên phải ghi nhớ cặp (dòng, panel) và đặt lại toạ độ khi cửa sổ đổi kích
// thước hoặc danh sách MST cuộn; nếu không menu sẽ lơ lửng sai chỗ.
let rowMenuAnchor = null;
function placeRowMenu() {
  const anchor = rowMenuAnchor;
  if (!anchor || !anchor.row.isConnected || !anchor.panel.isConnected) return;
  const panel = anchor.panel;
  const row = anchor.row.getBoundingClientRect();
  const side = document.querySelector('aside');
  const width = panel.offsetWidth, height = panel.offsetHeight;
  // Neo mép trái panel vào sát mép phải sidebar (không nhét trong cột hẹp), luôn giữ trong cửa sổ.
  const edge = side ? side.getBoundingClientRect().right : row.right;
  const left = Math.max(8, Math.min(edge + 8, window.innerWidth - width - 8));
  let top = row.top - 6;
  if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.max(8, top)}px`;
}
window.addEventListener('resize', placeRowMenu);
document.addEventListener('scroll', placeRowMenu, true);
// One ⋯ menu per row: log in for that MST, edit it, forget its password, or drop it from the list.
function openRowMenu(row, account) {
  const opened = row.querySelector('.row-menu-panel');
  closeRowMenus(); if (opened) return;
  rowMenuOpen = true;
  // Nền dòng giữ nguyên lúc menu mở: menu treo NGOÀI biên dòng (xem .mst-row trong style.css —
  // KHÔNG được đặt overflow:hidden trên dòng), hover không làm nền nhấp nháy khi dựng lại.
  row.classList.add('menu-open');
  const panel = document.createElement('div'); panel.className = 'row-menu-panel';
  const item = (text, fn, danger) => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = text; if (danger) button.className = 'danger';
    button.onclick = event => { event.stopPropagation(); closeRowMenus(); fn(); };
    return button;
  };
  panel.append(
    item('Đăng nhập / nhập CAPTCHA', () => openLogin(account.mst)),
    // Auto Sync theo từng MST: chọn đúng MST này rồi mở hộp thoại trong tab Kho dữ liệu.
    item('Auto Sync (dò hoá đơn mới)…', async () => {
      try {
        if (account.mst !== current.selected) {
          initialized = false;
          await work('/api/account/select', { mst: account.mst });
        }
        const view = window.HD_DATA_VIEW;
        if (!view) { notice('Phần Kho dữ liệu chưa sẵn sàng.'); return; }
        view.show('data');
        await view.openAutoSync();
      } catch (error) { noticeFail(error.message); }
    }),
    item('CCCD/MST bổ sung…', () => openIdentifiers(account)),
    item('Sửa MST', () => openMstForm(account)),
    item('Xoá mật khẩu đã lưu', () => forgetPassword(account)),
    item('Bỏ khỏi danh sách', () => removeMst(account), true)
  );
  // Bấm vào nền panel (khe 5px giữa các mục) không được rơi xuống dòng ⇒ không chọn MST oan.
  panel.onclick = event => event.stopPropagation();
  row.append(panel);
  rowMenuAnchor = { row, panel };
  placeRowMenu();
}
function openIdentifiers(account) {
  $('identifiers-primary').value = account.mst;
  $('identifiers-values').value = (account.identifiers || []).join('\n');
  $('identifiers-subtitle').textContent = `Hóa đơn khớp MST chính ${account.mst} hoặc một mã dưới đây sẽ được đưa vào cùng kho dữ liệu.`;
  $('identifiers-error').hidden = true;
  $('identifiers-dialog').showModal();
  $('identifiers-values').focus();
}
// Bấm một dòng: còn phiên đã lưu thì vào thẳng giao diện chính. Hết phiên: TỰ ĐỘNG ĐĂNG NHẬP
// ngay bằng mật khẩu đã lưu (solver JS giải CAPTCHA hộ) — chỉ khi THẤT BẠI (quá 5 lần thử, sai mật
// khẩu, chưa lưu mật khẩu…) mới mở modal cho người dùng chọn cách đăng nhập tiếp.
async function autoLoginMst(mst, { silent = false } = {}) {
  const result = await call('/api/account/auto-login', { mst, remember: true });
  if (result && result.authenticated) {
    notice(`MST ${mst}: đăng nhập tự động thành công sau ${result.attempts || 1} lần thử. Phiên đã lưu.`);
    await refresh();
    return true;
  }
  if (!silent) noticeFail(`MST ${mst}: đăng nhập tự động không thành công — chọn cách đăng nhập tiếp theo.`);
  await prepareManualLogin(mst, result);
  return false;
}
// Chuẩn bị sẵn form đăng nhập thủ công (MST + nút "Thử lại tự động" + CAPTCHA của lượt vừa lỗi)
// nhưng KHÔNG hiện: modal chọn cách đăng nhập sẽ hiện lại đúng form này khi người dùng bấm
// "Mở giao diện đăng nhập", nên mã CAPTCHA vừa lấy không bị mất. Dùng lại openLogin/acceptLoginResult.
async function prepareManualLogin(mst, result) {
  openLogin(mst, { retryAuto: true });
  if (result) await acceptLoginResult(result);
  $('login-dialog').close();
}
// CHỈ khi tự động đăng nhập không được mới mở modal này, cho người dùng chọn 1 trong 3 đường —
// tất cả đều dùng lại hàm/API đang có, không có luồng đăng nhập mới:
// auto lại = autoLoginMst · nhập thủ công = form đã chuẩn bị sẵn (prepareManualLogin) · mở Chrome = account/show.
function openLoginChoice(mst) {
  const dialog = $('login-choice-dialog');
  $('login-choice-subtitle').textContent = `MST ${mst} chưa đăng nhập tự động được. Chọn cách đăng nhập tiếp:`;
  $('login-choice-status').textContent = '';
  const auto = $('login-choice-auto'), manual = $('login-choice-form'), chrome = $('login-choice-chrome');
  const close = () => { if (dialog.open) dialog.close(); };
  // Auto LẠI: thử lại ngay trong modal. Được thì đóng modal; không được thì giữ modal + báo lý do
  // (form thủ công đã chuẩn bị sẵn từ lượt lỗi trước nên vẫn sẵn sàng nếu người dùng đổi cách).
  auto.onclick = async () => {
    auto.disabled = manual.disabled = chrome.disabled = true;
    $('login-choice-status').textContent = `Đang đăng nhập tự động lại cho MST ${mst}…`;
    try {
      if (await autoLoginMst(mst)) { close(); return; }
      $('login-choice-status').textContent = 'Vẫn không đăng nhập tự động được. Chọn “Mở giao diện đăng nhập” hoặc “Mở Chrome để đăng nhập”.';
    } catch (error) { $('login-choice-status').textContent = error.message; }
    finally { auto.disabled = manual.disabled = chrome.disabled = false; }
  };
  // Nhập thủ công: chỉ HIỆN lại form đã chuẩn bị sẵn (MST + CAPTCHA vừa lấy) — không dựng lại từ đầu.
  manual.onclick = () => { close(); $('login-dialog').showModal(); $('login-mst').focus(); loginBusy(false); };
  // Chrome: y như nút "Mở Chrome dự phòng" trong form đăng nhập (account/show mở đúng MST này).
  chrome.onclick = async () => {
    close();
    try {
      await call('/api/account/show', { mst });
      notice(`MST ${mst}: Chrome đăng nhập đang hiển thị.`);
      await refresh();
    } catch (error) { noticeFail(error.message); }
  };
  dialog.showModal();
  auto.focus();
}
async function chooseMst(mst) {
  closeRowMenus();
  if (pending) return;
  if (mst === current.selected && current.authenticated) { notice(`Đang dùng phiên đăng nhập sẵn có của MST ${mst}.`); return; }
  initialized = false;
  const result = await selectMst(mst);
  if (!result) return;
  if (result.authenticated) { notice(`MST ${mst}: còn phiên đăng nhập — tra cứu được ngay.`); return; }
  // Hết phiên: tự động đăng nhập NGAY như cũ; chỉ khi không được mới mở modal 3 lựa chọn.
  notice(`MST ${mst} hết phiên — đang tự động đăng nhập…`);
  try { if (!(await autoLoginMst(mst))) openLoginChoice(mst); }
  catch (error) { noticeFail(error.message); await prepareManualLogin(mst); openLoginChoice(mst); }
}
async function forgetPassword(account) {
  if (!await askConfirm({
    title: 'Xoá mật khẩu đã lưu', tone: 'error', ok: 'Xoá mật khẩu', cancel: 'Giữ lại',
    text: `Xoá mật khẩu đã lưu của MST ${account.mst}? Phiên đang đăng nhập vẫn giữ.`,
  })) return;
  try {
    if (account.mst !== current.selected) await work('/api/account/select', { mst: account.mst });
    await call('/api/account/forget', {});
    notice(`Đã xoá mật khẩu đã lưu của MST ${account.mst}.`); await refresh();
  } catch (error) { noticeFail(error.message); }
}
async function removeMst(account) {
  if (!await askConfirm({
    title: 'Bỏ MST khỏi danh sách', tone: 'error', ok: 'Bỏ MST', cancel: 'Giữ lại',
    text: `Bỏ MST ${account.mst} khỏi danh sách? Profile Chrome và tiến độ vẫn giữ trong du_lieu, nhưng phiên + mật khẩu đã lưu của MST này sẽ bị xoá.`,
  })) return;
  await work('/api/account/remove', { mst: account.mst });
}
function openMstForm(account) {
  editingMst = account ? account.mst : '';
  $('mst-title').textContent = account ? 'Sửa MST' : 'Thêm MST';
  $('mst-subtitle').textContent = account
    ? `Đang sửa ${displayName(account)} (${account.mst}). Đổi MST sẽ đổi luôn thư mục profile Chrome và tiến độ tải.`
    : 'Lưu khách hàng vào danh sách bên trái. Mỗi MST dùng một phiên Chrome riêng để giữ cookie.';
  $('mst-name').value = account ? (account.name || '') : '';
  $('mst-code').value = account ? account.mst : '';
  $('mst-password').value = '';
  $('mst-password').placeholder = account && account.remembered ? 'Đang có mật khẩu đã lưu — để trống nếu không đổi' : 'Để lưu sẵn cho lần sau';
  $('mst-remember').checked = account ? !!account.remembered : true;
  // Ô "Thư mục lưu" CHỈ hiện khi THÊM MST. Vì sao: khách mới phải có chỗ ghi file NGAY, nếu không
  // lượt quét 10 ngày đầu (xem src/first-scan.js) không chạy được vì không có thư mục đích.
  // Sửa MST thì KHÔNG hỏi lại — thư mục lưu là DÙNG CHUNG cho mọi MST nên đã có sẵn.
  const adding = !account;
  const hasFolder = !!current.output;
  $('mst-output-row').hidden = !adding;
  $('mst-output-hint').hidden = !adding;
  $('mst-output').value = adding ? (current.output || '') : '';
  // ĐÃ có thư mục lưu ⇒ KHOÁ luôn ô này: thư mục dùng CHUNG cho mọi MST nên thêm khách mới không
  // được đổi (đổi ở đây là đổi cho CẢ app, kéo theo dữ liệu cũ không còn hiện). Muốn đổi thì vào
  // tab "Tra cứu & tải" bấm "Đổi thư mục…" — ở đó có cảnh báo mất dữ liệu.
  $('mst-output').readOnly = adding && hasFolder;
  $('mst-output-choose').hidden = adding && hasFolder;
  $('mst-output-hint').textContent = !adding ? '' : (hasFolder
    ? `Đã khoá theo thư mục dùng chung: ${current.output}. Muốn đổi, vào tab “Tra cứu & tải” bấm “Đổi thư mục…” (sẽ có cảnh báo mất dữ liệu).`
    : `Bỏ trống (hoặc bấm Huỷ ở hộp chọn thư mục) = dùng mặc định ${current.defaultOutput || 'Documents\\CN-invoice'}. Thư mục này dùng chung cho mọi MST.`);
  $('mst-error').hidden = true; $('mst-dialog').showModal(); $('mst-name').focus();
}
// Mốc thời gian ngắn "15:01 25/09" cho banner trạng thái MST.
// Trạng thái CUỐI (lỗi / xong / trống) luôn đi kèm mốc đã ghi trong sync.json; mốc này được ghi lại
// mỗi lượt Auto Sync nên nhìn banner là biết trạng thái đó CŨ hay MỚI — không còn cảnh báo đỏ cho
// một lỗi đã hết từ lâu (lỗi thật: "database disk image is malformed" treo mãi vì không ai xoá).
function bannerWhen(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'chưa rõ lúc nào';
  const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  return `${time} ${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// Banner trạng thái Auto Sync hiện NGAY TRÊN DÒNG MST, để nhìn vào danh sách là biết MST nào
// đang tra cứu / đang tải bao nhiêu / đã xong / không có hóa đơn mới / lỗi.
function syncBanner(sync) {
  if (!sync) return null;
  if (sync.running) {
    const progress = sync.progress;
    if (progress && progress.queued) {
      return { kind: 'running', text: `Đang đồng bộ ${progress.downloaded}/${progress.queued}${progress.failed ? ` · lỗi ${progress.failed}` : ''}` };
    }
    return { kind: 'running', text: sync.phase ? `Đang đồng bộ · ${sync.phase}` : 'Đang đồng bộ…' };
  }
  if (sync.lastError) return { kind: 'error', text: `Lỗi (${bannerWhen(sync.lastErrorTime)}): ${String(sync.lastError).slice(0, 90)}` };
  // Chưa tải đủ dữ liệu hôm nay (một ngày một lần — xem dailySyncState trong sync-scheduler.js).
  // Đứng TRƯỚC nhánh "Xong" để không hiện mốc CŨ như thể vừa chạy xong.
  if (sync.syncedToday === false) {
    const missing = (sync.missingToday || []).join(', ');
    return null;
  }
  if (sync.lastSuccess) {
    const when = bannerWhen(sync.lastSuccess);
    const downloaded = (sync.buyDownloaded || 0) + (sync.sellDownloaded || 0);
    const found = (sync.buyFound || 0) + (sync.sellFound || 0);
    // GỌN GÀNG: “Xong · 110 HĐ mới · 10:51 26/09” — đủ ý trong một cụm ngắn, chữ tràn thì CSS cắt “…”.
    if (downloaded > 0) return { kind: 'done', text: `Đã đồng bộ · ${downloaded} HĐ mới · ${when}` };
    if (found > 0) return { kind: 'done', text: `Đã đồng bộ · ${found} HĐ, không mới · ${when}` };
    return { kind: 'empty', text: `Không có HĐ mới · ${when}` };
  }
  return null;
}

// Chống bấm đúp nút ▶/⏹: một MST chỉ cho phép MỘT chuỗi (chọn → chạy/ngưng) diễn ra cùng lúc. Cờ
// đặt NGAY lúc bấm và xoá khi chuỗi xong — còn sống qua các lần dựng lại dòng (khác biến cục bộ).
let laneBusy = '';
function renderAccounts(state) {
  // Đang có menu ⋯ mở ⇒ không dựng lại danh sách trong nhịp này (menu sẽ bị xoá mất). Nhịp poll
  // kế tiếp (sau khi menu đóng) sẽ vẽ lại như thường — chỉ hoãn một nhịp, không đổi logic.
  if (rowMenuOpen) return;
  const list = $('mst-items'); const query = mstQuery().toLowerCase();
  const all = state.accounts || [];
  const shown = query ? all.filter(x => `${displayName(x)} ${x.mst} ${(x.identifiers || []).join(' ')}`.toLowerCase().includes(query)) : all;
  // Ô đếm: đang TÌM thì hiện "khớp/tổng" — chỉ khi số khớp khác tổng, để không thành "3/3" vô nghĩa.
  // Không tìm thì hiện mỗi tổng. Trước đây luôn hiện "khớp/tổng" khi có >1 MST (nên "3/3" vừa thừa
  // vừa dễ tưởng thiếu), còn đúng 1 MST thì không hiện số nào — bất nhất.
  $('mst-count').textContent = query && shown.length !== all.length
    ? `Danh sách MST (${shown.length}/${all.length})`
    : `Danh sách MST (${all.length})`;
  list.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement('p'); empty.className = 'mst-empty';
    if (initialLoading) {
      empty.innerHTML = '<span class="loading-spinner"></span> Đang tải danh sách MST…';
    } else {
      empty.textContent = all.length ? 'Không có MST nào khớp từ khoá.' : 'Chưa có MST nào — bấm “＋ Thêm MST”.';
    }
    list.append(empty); return;
  }
  for (const account of shown) {
    const row = document.createElement('div');
    // Phản hồi tức thì khi bấm chọn: dòng vừa bấm (selectingMst) tô sáng + nút ▶/⏹ xoay NGAY trong
    // lúc chờ máy chủ xác nhận. Hết kiểm tra phiên thì state.selected đổi và selectingMst rỗng nên
    // dòng về đúng trạng thái cũ. Chỉ hiệu ứng — KHÔNG bật `pending`, vì chọn MST không được khoá UI.
    const selecting = account.mst === selectingMst;
    row.className = 'mst-row' + (account.mst === state.selected ? ' active' : (selecting ? ' selecting' : '')); row.dataset.mst = account.mst; row.tabIndex = 0;
    row.title = SESSION_LABEL[account.session] || '';
    const dot = document.createElement('span'); dot.className = `mst-dot ${account.session || 'none'}`;
    const info = document.createElement('div'); info.className = 'mst-info';
    const title = document.createElement('strong'); title.textContent = displayName(account);
    const sub = document.createElement('small');
    const syncing = !!account.sync?.running;
    const jobRunning = account.job?.state === 'searching' || account.job?.state === 'downloading' || account.job?.state === 'running';
    const running = syncing || jobRunning;
    // Trạng thái ĐÃ ĐỒNG BỘ / CHƯA ĐỒNG BỘ hôm nay — hiện ngay trên dòng MST.
    // Một ngày chỉ cần đủ một lần nên nhìn đây là biết còn phải chạy hay không.
    const sync = account.sync;
    const syncNote = sync && sync.running ? ''
      : sync && sync.syncedToday ? ' · đã đồng bộ hôm nay'
        : sync ? ` · chưa đồng bộ hôm nay${sync.missingToday?.length ? ` (thiếu ${sync.missingToday.join(', ')})` : ''}` : '';
    // Hoá đơn LỖI TẢI của lượt gần nhất — nói rõ để biết còn phải thử lại, thay vì im lặng.
    const failNote = sync && sync.failedToday ? ` · ${sync.failedToday} HĐ lỗi tải` : '';
    // Quét bù lịch sử (chỉ chạy khi cửa sổ app đóng): hiện đang quét tới đâu, hoặc đã quét bù tới ngày nào.
    // Không thêm dòng banner thứ hai vì mỗi dòng MST chỉ có MỘT khe banner (xem .mst-banner grid-row).
    const catchup = account.catchup;
    const catchupNote = catchup && catchup.running
      ? ` · đang quét bù ${dayOf(catchup.from)} → ${dayOf(catchup.to)}`
      : (catchup && catchup.scannedTo ? ` · quét bù tới ${dayOf(catchup.scannedTo)} (${catchup.scannedDays} ngày)` : '');
    sub.textContent = `${account.mst}${account.identifiers?.length ? ` · +${account.identifiers.length} mã` : ''}${account.remembered ? ' · đã lưu mật khẩu' : ''}${running ? ' · đang xử lý' : ''}${account.job ? ` · ${account.job.total} hóa đơn` : ''}${syncNote}${failNote}${catchupNote}${selecting ? ' · Đang kiểm tra phiên…' : ''}`;
    info.append(title, sub);
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'mst-stop';
    stop.innerHTML = running
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    // Nút này là CÔNG TẮC AUTO SYNC của MST: bấm play ⇒ chạy Auto Sync cho đúng MST này
    // (không chạy các MST khác); bấm stop ⇒ ngưng mọi tác vụ của MST này.
    stop.title = running
      ? `Ngưng mọi tác vụ đang hoạt động của MST ${account.mst}`
      : `Chạy Auto Sync cho MST ${account.mst}`;
    stop.setAttribute('aria-label', stop.title);
    stop.disabled = !!pending;
    stop.onclick = async event => {
      event.stopPropagation();
      if (laneBusy === account.mst) return; // chuỗi trước của MST này chưa xong — bỏ cú bấm đúp
      laneBusy = account.mst;
      try {
        if (account.mst !== current.selected) {
          initialized = false;
          await work('/api/account/select', { mst: account.mst });
        }
        // Đang chạy Auto Sync ⇒ ngưng Auto Sync; đang tải thủ công ⇒ tạm dừng lượt tải;
        // đang rảnh ⇒ bắt đầu Auto Sync cho MST này.
        if (syncing) await work('/api/db/autosync/stop', {});
        else if (jobRunning) await work('/api/pause', {});
        else await work('/api/db/autosync/run', { mst: account.mst });
      } catch (error) { noticeFail(error.message); }
      finally { if (laneBusy === account.mst) laneBusy = ''; }
    };
    // Banner trạng thái: gắn vào DÒNG (không gắn vào .mst-info) để trải hết bề ngang — trước đây
    // nằm trong khối chữ nên chỉ còn ~65px và luôn bị cắt "…".
    const banner = syncBanner(account.sync);
    let line = null;
    if (banner) {
      line = document.createElement('small');
      line.className = `mst-banner ${banner.kind}`;
      line.textContent = banner.text;
    }
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'row-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', `Tuỳ chọn cho ${account.mst}`);
    menu.onclick = event => { event.stopPropagation(); openRowMenu(row, account); };
    // 2 nút (chạy/ngưng Auto Sync + tuỳ chọn MST) xếp DỌC sát mép phải (xem .mst-actions trong
    // style.css): nhường gần hết bề ngang cho banner và tách vùng bấm khỏi chỗ bấm-chọn dòng.
    const actions = document.createElement('div'); actions.className = 'mst-actions';
    actions.append(stop, menu);
    row.append(dot, info, actions);
    if (line) row.append(line);
    row.onclick = () => chooseMst(account.mst);
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMst(account.mst); } };
    list.append(row);
  }
}
let lastRenderedState = '';
// Chữ ký NHẸ của state: nối từng trường thành MỘT CHUỖI rồi so chuỗi — so chuỗi mới đúng nghĩa
// "y hệt lần trước". ⚠ Lỗi thật của đợt 1: từng so MẢNG bằng `!==`, mà mảng mới là tham chiếu mới
// mỗi nhịp nên nhánh bỏ qua dựng DOM chưa từng có tác dụng. Bảng 1.000 dòng giờ nằm ở
// /api/state/items riêng (xem loadItemsIfChanged) nên chữ ký không cần soi items nữa;
// `itemsRevision` là revision do SERVER đếm (Engine.jobRevision tăng khi nội dung job đổi).
// accounts/pool/stats được JSON.stringify (nhỏ, vài chục phần tử) để bắt cả thay đổi bên trong.
function stateSignature(state) {
  return [pending, selectingMst, $('login-dialog').open ? 1 : 0, state.state, state.busy ? 1 : 0, state.authBusy ? 1 : 0, state.backgroundAuth ? 1 : 0, state.autoLoginBlocked ? 1 : 0,  state.authenticated ? 1 : 0, state.selected, state.output, state.companyName, state.browserVisible ? 1 : 0, state.browserReady ? 1 : 0, state.mode, state.message, state.total, state.done, state.failed, state.percentage, state.itemsRevision, JSON.stringify(state.accounts), JSON.stringify(state.pool), JSON.stringify(state.stats)].join('\u0001');
}
// 4 thẻ số chi tiết (TỔNG HÓA ĐƠN / ĐÃ TẢI / ĐÃ CÓ SẴN / LỖI) đọc ĐÚNG bộ đếm state.stats mà dòng
// chữ #stats đang dùng (core.js đếm sẵn: total · downloaded · existed · failed) — không thêm logic
// đếm mới. Khi Auto Sync chiếm bảng thì tính từ danh sách preview (xem paintSyncPreviewInto).
function paintStatBreakdown(stats) {
  const value = stats || {};
  for (const [id, key] of [['stat-total', 'total'], ['stat-downloaded', 'downloaded'], ['stat-existed', 'existed'], ['stat-failed', 'failed']]) {
    const box = optional(id);
    if (box) box.textContent = value[key] || 0;
  }
}
function render(state) {
  // Bảng có thể tới 1.000 dòng nên dựng lại toàn bộ DOM mỗi 1,5 giây là nguồn giật chính khi app
  // đứng yên. So chữ ký NHẸ (xem stateSignature): chỉ bỏ qua phần dựng DOM khi mọi thứ y hệt lần
  // trước — nội dung và thứ tự render không đổi so với bản stringify.
  let signature = null;
  try { signature = stateSignature(state); } catch { signature = null; }
  const changed = signature === null || signature !== lastRenderedState;
  if (signature !== null) lastRenderedState = signature;
  // Đổi MST ⇒ buộc fetch lại bảng: revision là bộ đếm RIÊNG của từng engine, MST mới có thể trùng số.
  if ((current && current.selected) !== state.selected) itemsRevisionSeen = -1;
  current = state;
  if (changed) renderAccounts(state);
  else refreshLoginDialogButton(state);
  // Cho các module khác (hộp thoại cập nhật) bám theo trạng thái mới nhất mà không cần poll riêng.
  window.HD_LAST_STATE = state;
  try { window.dispatchEvent(new CustomEvent('hd:state', { detail: state })); } catch {}
  if (!changed) return;
  const browserText = state.browserVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
  // Chrome tự đóng sau khi tải xong, nên nút này không còn phụ thuộc browserReady: chưa có cửa sổ
  // thì bấm vào sẽ mở lại (xem onclick), giống nút trong bảng đăng nhập.
  const browserToggle = optional('browser-toggle');
  if (browserToggle) { browserToggle.textContent = browserText; browserToggle.disabled = !state.selected || state.authBusy || pending; }
  // Nút trong hộp thoại đăng nhập là DOM ngoài state: khi không dựng lại toàn bộ, vá nhãn trực tiếp.
  refreshLoginDialogButton(state);
  const selected = state.selected || '';
  const account = (state.accounts || []).find(x => x.mst === selected);
  // Dòng tài khoản: MST trước (dạng nhãn), sau đó tên công ty/HKD in đậm cho dễ thấy.
  // Không lặp lại MST hai lần khi chưa biết tên công ty.
  const companyName = String(state.companyName || '').trim();
  const label = companyName || displayName(account || { mst: selected });
  const name = selected && label && label !== selected ? label : '';
  const box = $('account');
  box.title = [selected, name].filter(Boolean).join(' · ');
  box.replaceChildren();
  if (!selected) {
    box.textContent = 'Chưa chọn MST';
  } else {
    const mstSpan = document.createElement('span');
    mstSpan.className = 'account-mst';
    mstSpan.textContent = selected;
    box.append(mstSpan);
    if (name) {
      const nameSpan = document.createElement('span');
      nameSpan.className = 'account-name';
      nameSpan.textContent = name;
      box.append(nameSpan);
    }
  }
  const isSelectingNew = selectingMst && selectingMst !== selected;
  // Nhãn phiên. `saved` + `sessionChecked=false` nghĩa là CÓ token đã lưu nhưng CHƯA
// kiểm tra — KHÔNG phải hết hạn. Trước đây gộp chung hai thứ này nên lúc mở app mọi
// MST đều hiện "Có phiên đã lưu nhưng đã hết hạn", đẩy người dùng vào đăng nhập lại
// trong khi phiên vẫn dùng được.
const sessionHint = (account, state) => {
  if (!account) return 'Chọn một MST trong danh sách bên trái.';
  // Đăng nhập nền đang chạy: nói rõ để người dùng hiểu vì sao nút chưa bật, thay vì
  // tưởng app treo. KHÔNG khoá giao diện — xem foregroundAuth ở server.js.
  if (state.backgroundAuth) return 'Đang tự đăng nhập lại bằng mật khẩu đã lưu…';
  if (account.autoLoginBlocked) return 'Tự đăng nhập không thành công — bấm MST để đăng nhập tay.';
  if (account.session === 'live') return 'Đang online';
  if (account.session === 'saved') return state.sessionChecked ? 'Có phiên đã lưu nhưng đã hết hạn.' : 'Đang kiểm tra phiên đã lưu…';
  return 'Chưa đăng nhập.';
};
$('account-hint').textContent = isSelectingNew
    ? `Đang kiểm tra phiên đăng nhập cho MST ${selectingMst}…`
    : state.authenticated ? 'Đang online'
      : (selected ? sessionHint(account, state) : 'Chọn một MST trong danh sách bên trái.');
  $('auth-dot').classList.toggle('active', !!state.authenticated);
  // Trạng thái "đang tải" của tab Tổng quan do data-ui.js quản lý (chip cạnh nút cập nhật).
  // Renderer KHÔNG đụng vào đây để hai bên không giành nhau ẩn/hiện gây nháy.
  $('state').textContent = labels[state.state] || state.state; $('message').textContent = state.message || '';
  // Hiện spinner ở tiêu đề bảng kết quả khi đang chọn MST mới
  const resultsTitle = $('results-title');
  if (isSelectingNew) {
    resultsTitle.innerHTML = '<span class="loading-spinner"></span> Đang kiểm tra phiên đăng nhập…';
  } else {
    resultsTitle.textContent = state.mode === 'stream' ? 'Hóa đơn tải thành công' : 'Danh sách hóa đơn';
  }
  const percent = state.total ? Math.round(100 * ((state.done || 0) + (state.failed || 0)) / state.total) : 0;
  $('percentage').textContent = `${percent}%`; $('progress').value = percent;
  // KHÔNG tự điền lại cấu hình của lượt tra cứu CŨ vào form khi mở app: người dùng mở app là thấy
  // form trống như mới. Form chỉ được điền khi (a) người dùng tự chọn, hoặc (b) Auto Sync chủ động
  // đẩy cấu hình đang chạy lên để nhìn cho trực quan (xem window.HD_SHOW_SYNC).
  initialized = true;
  // Không ghi đè lên đường dẫn người dùng đang gõ; chỉ cập nhật khi nơi lưu đổi thật.
  const field = $('output');
  if (document.activeElement !== field && field.value !== (state.output || '')) field.value = state.output || '';
  // KHOÁ THƯ MỤC LƯU: đã lưu thư mục rồi thì KHÔNG cho sửa thẳng. Vì sao: đổi thư mục là app chuyển
  // sang đọc data.db/hoá đơn ở chỗ khác ⇒ dữ liệu đã tải ở thư mục cũ KHÔNG còn hiện trong app
  // (file vẫn nằm nguyên trên đĩa). Chỉ cần gõ nhầm một ký tự là dính. Muốn đổi phải bấm
  // "Đổi thư mục…" rồi XÁC NHẬN cảnh báo mất dữ liệu ở dưới.
  const folderLocked = !!state.output;
  field.readOnly = folderLocked;
  field.classList.toggle('locked', folderLocked);
  field.title = folderLocked
    ? `Đã khoá theo thư mục đang dùng: ${state.output}. Bấm “Đổi thư mục…” nếu muốn đổi (sẽ có cảnh báo mất dữ liệu).`
    : 'Gõ/dán đường dẫn đầy đủ, hoặc bấm “Chọn thư mục…”';
  $('empty').hidden = !!state.total;
  // KHÔNG dựng màn hình chặn chờ đợi ở đây nữa. Trước đây khu vực kết quả bị thay bằng
  // lời nhắc phải chờ suốt lúc kiểm tra phiên, dù dữ liệu của MST đang chọn đã nằm
  // sẵn trên đĩa và sidebar đã vẽ xong. Chỉ còn hiện spinner ở danh sách MST khi
  // thực sự chưa có dòng nào để vẽ.
  if (initialLoading && !state.selected) {
    const emptyEl = $('empty');
    if (emptyEl && !emptyEl.hidden) {
      emptyEl.innerHTML = '<h3>Chưa có kết quả</h3><p>Bấm “Tải hóa đơn” để bắt đầu. Dữ liệu đã tải trước đó vẫn còn nguyên.</p>';
    }
  }
  const busy = state.busy || state.authBusy || pending;
  ['choose', 'add-mst', 'mst-login', 'account-login'].forEach(id => { const el = optional(id); if (el) el.disabled = busy; });
  // Chỉ hiện MỘT trong hai nút: chưa có thư mục ⇒ "Chọn thư mục…"; đã có (đang khoá) ⇒ "Đổi thư mục…".
  const changeFolderButton = optional('change-output');
  const chooseFolderButton = optional('choose');
  if (changeFolderButton) changeFolderButton.hidden = !folderLocked;
  if (chooseFolderButton) chooseFolderButton.hidden = folderLocked;
  // Dòng ghi chú dưới ô phải KHỚP trạng thái: khoá rồi thì không thể "gõ/dán đường dẫn" nữa.
  const outputHintNote = optional('output-hint-note');
  if (outputHintNote) {
    outputHintNote.textContent = folderLocked
      ? 'Thư mục đã khoá để không đổi nhầm. Muốn đổi, bấm “Đổi thư mục…” (sẽ có cảnh báo mất dữ liệu).'
      : 'Có thể gõ/dán đường dẫn đầy đủ rồi bấm ra ngoài ô.';
  }
  // Nút "Đồng bộ tất cả": một nút vừa khởi động vừa ngưng. Hiện số luồng đang chạy để thấy
  // bể luôn giữ đủ 3 — MST nào xong thì MST kế tiếp vào chỗ.
  const pool = state.pool || {};
  const syncAll = optional('sync-all');
  if (syncAll) {
    const lanes = (pool.active || []).length;
    syncAll.textContent = pool.running ? `Đang đồng bộ ${lanes} luồng · Ngưng` : 'Đồng bộ tất cả';
    syncAll.className = pool.running ? 'danger' : 'secondary';
    syncAll.disabled = pending || !(state.accounts || []).length;
  }
  reportPoolOutcome();
  // NÚT TẢI HÓA ĐƠN — nhãn, kiểu, và công thức khoá đều lấy từ downloadButtonState(): một nguồn
  // sự thật, nơi vẽ và nơi xử lý cú bấm không thể lệch nhau.
  const downloadButton = $('download-btn');
  const downloadView = downloadButtonState(state);
  downloadButton.textContent = downloadView.label;
  downloadButton.classList.toggle('btn-loading', downloadView.loading);
  // Nút của tác vụ ĐANG CHẠY luôn phải BẤM ĐƯỢC để dừng: `pending` = true suốt thời gian request
  // dài đang chờ (server trả lời khi tác vụ kết thúc), nên không được dùng `pending` trần để khoá.
  // Công thức ghim trong test (tests/ui-wiring.test.js): `state.authBusy || (!!state.busy && !<đang-chạy>) || (pending && !<đang-chạy>)`.
  const downloadRunning = downloadView.action === 'pause';
  // Mọi khoá (đang đăng nhập / đang bận / request dài đang chờ) đều BỎ QUAA khi nút đang ở trạng
  // thái "Ngưng": đang tải mà đăng nhập nền MST khác bật thì người dùng vẫn phải dừng được.
  downloadButton.disabled = (state.authBusy || !!state.busy || pending) && !downloadRunning;
  // Nút "Xuất Excel theo mẫu MISA" chỉ bật khi đã có kết quả tra cứu; dòng thống kê đọc từ kết quả xử lý.
  $('export-excel').disabled = busy || !state.total || !state.selected;
  const stats = state.stats;
  $('stats').textContent = stats ? `Tổng ${stats.total} · đã có sẵn ${stats.existed} · đưa vào hàng tải ${stats.queued} · đã tải ${stats.downloaded} · bỏ qua ${stats.skipped} · lỗi ${stats.failed}${stats.retrying ? ` · đang thử lại ${stats.retrying}` : ''}` : '';
  if (state.directions?.length) {
    const labels = { pending: 'chờ', idle: 'chờ', completed: 'xong', ready: 'đã tra cứu', partial: 'chưa hoàn tất', paused: 'đã ngưng', auth_required: 'cần đăng nhập', searching: 'đang tra cứu', downloading: 'đang tải', failed: 'lỗi' };
    $('stats').textContent += ' · ' + state.directions.map(one => `${one.direction === 'purchase' ? 'Mua vào' : 'Bán ra'}: ${one.done}/${one.total} (${labels[one.state] || 'chưa xác định'})`).join(' · ');
  }
  // Lượt tra cứu chưa vào giai đoạn tải thì máy chủ chưa có state.stats (core.js chỉ tạo j.stats khi
  // bắt đầu tải) — lúc đó lấy tạm tổng/lỗi của state; "đã tải" và "đã có sẵn" chắc chắn = 0.
  paintStatBreakdown(stats || { total: state.total || 0, downloaded: 0, existed: 0, failed: state.failed || 0 });
  if (browserToggle) browserToggle.disabled = busy || state.authBusy || !state.selected;
  document.querySelectorAll('.filters input:not([readonly]), .filters select').forEach(x => { x.disabled = busy; });
}
// Dựng bảng kết quả từ state.items — bảng nằm ở endpoint RIÊNG /api/state/items (fetch trong
// loadItemsIfChanged khi revision đổi) nên render() KHÔNG dựng lại bảng theo nhịp poll nữa.
// Diff theo dòng: so chữ ký từng dòng (trường y hệt những gì vẽ ra) — giống hệt lần trước thì
// KHÔNG đụng DOM (bỏ trọn phần dựng 1.000 dòng + replaceChildren khi chỉ bật/tắt một ô nào đó).
let lastRowSigs = [];
function renderItemsTable(state) {
  const items = state.items || [];
  const sigs = items.map(inv => `${inv.state}\u0001${inv.number}\u0001${inv.symbol}\u0001${inv.seller}\u0001${inv.name}\u0001${inv.buyer}\u0001${inv.buyerName}\u0001${inv.date}\u0001${inv.amount}\u0001${inv.error}\u0001${inv.errorType}\u0001${inv.warning}\u0001${(inv.files || [])[0] || ''}`);
  const unchanged = sigs.length === lastRowSigs.length && sigs.every((sig, index) => sig === lastRowSigs[index]);
  lastRowSigs = sigs;
  if (unchanged) return; // không có gì đổi: khỏi đụng DOM, cuộn giữ nguyên tự nhiên
  const table = $('rows');
  const tableRows = document.createDocumentFragment();
  for (const [index, inv] of (state.items || []).entries()) {
    const row = document.createElement('tr');
    row.className = inv.state || ''; // dòng đang tải được tô nổi bật (xem style.css)
    const cell = (text, small) => { const td = document.createElement('td'); td.textContent = text ?? ''; if (small) { const sub = document.createElement('small'); sub.textContent = small; td.append(sub); } row.append(td); return td; };
    const stt = cell(String(index + 1)); stt.className = 'stt';
    cell(dayOf(inv.date));
    cell(inv.number, inv.symbol);
    cell(inv.name || inv.seller, inv.seller);
    cell(inv.buyerName || inv.buyer, inv.buyer);
    cell(inv.amount == null ? '—' : amountFormat.format(inv.amount));
    const detail = inv.error ? `${errorLabels[inv.errorType] || ''}${errorLabels[inv.errorType] ? ': ' : ''}${inv.error}` : (inv.warning || '');
    const result = cell(labels[inv.state] || inv.state, detail); result.className = inv.state;
    // Dòng đã có XML trên đĩa: xem trước từ chính file đó. Dòng CHƯA tải: xem trước bằng cách hỏi
    // API chi tiết của cổng (một request, đi qua nhịp an toàn) — trước đây chỉ dòng đã tải mới bấm được.
    const xmlFile = (inv.files || []).find(name => /\.xml$/i.test(name));
    if (xmlFile || (inv.number && inv.seller)) {
      row.classList.add('clickable'); row.tabIndex = 0;
      row.title = xmlFile ? 'Bấm để xem trước hoá đơn khổ A4 (chuẩn Cục Thuế)' : 'Bấm để xem trước hoá đơn khổ A4 (lấy từ cổng thuế — chưa tải về máy)';
      const open = () => openInvoicePreview(xmlFile ? { ...inv, files: [xmlFile] } : inv);
      row.onclick = open;
      row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); open(); } };
    }
    tableRows.append(row);
  }
  // Gắn một lần thay vì 1.000 lần: cùng cây DOM, cùng thứ tự, chỉ bớt mỗi dòng một lần layout.
  // Giữ vị trí cuộn: dựng lại tbody làm Chrome nảy về đầu bảng trong khi người dùng đang đọc.
  const scroll = table.closest('.table-scroll'); const scrollTop = scroll ? scroll.scrollTop : 0;
  table.replaceChildren(tableRows);
  if (scroll && scroll.scrollTop !== scrollTop) scroll.scrollTop = scrollTop;
  // Danh sách cuộn như bản cũ; quá 1.000 dòng thì chỉ hiện 1.000 dòng MỚI NHẤT (engine vẫn xử lý đủ).
  $('empty').hidden = !!state.total; $('limit').textContent = (state.total || 0) > 1000 ? 'Hiển thị 1.000 hoá đơn mới nhất; engine vẫn xử lý toàn bộ.' : '';
}

// ------------------------------------------------------------------ Xem trước hoá đơn khổ A4 từ tab Tra cứu
// Bấm dòng đã tải (cũ: mở file bằng app Windows) → mở xem trước A4 chuẩn hiển thị của Cục Thuế,
// dựng từ ĐÚNG file XML của hoá đơn (endpoint /api/preview-invoice — cùng engine A4 với tab Kho
// dữ liệu). Vẫn mở được app ngoài bằng menu ⋯? — không: dòng này chỉ xem trước; mở app ngoài là
// việc của ô Số/Ký hiệu ở Kho dữ liệu và menu chuột phải. In/Lưu PDF ngay trong dialog.
function openInvoicePreview(inv) {
  const frame = $('preview-frame');
  const title = $('preview-title');
  title.textContent = `Hoá đơn ${inv.number || ''}${inv.symbol ? ` · ${inv.symbol}` : ''}${inv.stateLabel ? ` · ${inv.stateLabel}` : ''}`;
  const file = (inv.files || [])[0];
  // Có file XML cục bộ ⇒ dựng từ file (đầy đủ nhất, không gọi mạng).
  // Chưa có ⇒ để máy chủ hỏi API chi tiết của cổng thuế rồi dựng cùng một bộ A4.
  frame.src = file
    ? `/api/preview-invoice?${new URLSearchParams({ file, state: inv.tthai || '' })}`
    : `/api/preview-invoice?${new URLSearchParams({
      family: inv.family || 'query', nbmst: inv.seller || '', khhdon: inv.symbol || '',
      shdon: inv.number || '', khmshdon: inv.form || '', state: inv.tthai || '',
    })}`;
  const dialog = $('preview-dialog');
  if (!dialog.open) dialog.showModal();
}
function closeInvoicePreview() {
  const dialog = $('preview-dialog');
  if (dialog.open) dialog.close();
  $('preview-frame').src = 'about:blank';
}
function printInvoicePreview() {
  try { $('preview-frame').contentWindow.print(); }
  catch { noticeFail('Chưa in được — mở lại hoá đơn rồi thử lại.'); }
}
// Phốt cho data-ui.js gắn nút đóng/in của dialog preview (cùng một trang, script nạp chung).
window.HD_PREVIEW = { close: closeInvoicePreview, print: printInvoicePreview };
function refreshLoginDialogButton(state) {
  // Nhãn nút "Mở Chrome dự phòng" trong hộp thoại phụ thuộc browserVisible — một đầu vào DOM
  // ngoài state, cần cập nhật cả nhánh không dựng lại DOM (xem render).
  const showPage = optional('login-show-page');
  if (showPage && $('login-dialog').open) showPage.textContent = state.browserVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
}
// ---- Nhịp poll THÍCH ỨNG: đang chạy 0,8 giây, đứng yên 4 giây ----
// Trước đây setInterval(refresh, 1500) chạy đều mọi lúc. Mọi thao tác đều đi qua work() ⇒ refresh()
// gọi ngay khi tác vụ xong, nên khi app đứng yên lùi nhịp không làm chậm phản hồi nào — chỉ bớt
// hàng chục request/phút khi không cần thiết. Tab bị ẩn thì dùng nhịp rảnh (4 giây).
const POLL_BUSY_MS = 800;
const POLL_IDLE_MS = 4000;
let pollTimer = null;
let pollFailures = 0; // đếm nhịp poll hụt liên tiếp — chỉ báo lỗi 1 lần, không spam toast
function pollDelay() {
  if (document.hidden) return POLL_IDLE_MS;
  const running = !!current.busy || !!current.authBusy || (current.accounts || []).some(a => (a.sync && a.sync.running) || ['searching', 'downloading', 'running'].includes(a.job && a.job.state));
  return running ? POLL_BUSY_MS : POLL_IDLE_MS;
}
function schedulePoll() { clearTimeout(pollTimer); pollTimer = setTimeout(refresh, pollDelay()); }
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const state = await call('/api/state');
    writeMstCache(state); // giữ cache khớp dữ liệu thật cho lần mở app sau
    render(state);
  }
  catch (error) {
    // Một nhịp poll hụt (tắt/mở máy chủ, chờ response…) KHÔNG được phép làm treo vòng poll —
    // treo vòng poll là nguyên nhân UI kẹt "Đang tải" dù tác vụ đã xong. Báo lỗi đúng 1 lần,
    // các nhịp sau tự thử lại; khi state thật khác state đang vẽ thì vẽ lại ngay để thoát kẹt.
    pollFailures += 1;
    if (pollFailures === 1) noticeFail(error.message);
    if (current && (current.state === 'searching' || current.state === 'downloading')) {
      lastRenderedState = '';
      render(current);
    }
  }
  finally { polling = false; }
  if (pollFailures) pollFailures = 0; // nhịp này gọi thành công — xoá bộ đếm lỗi
  initialLoading = false;
  if (window.hdBootReady) window.hdBootReady('session');
  await paintSyncPreview();
  // Bảng kết quả nằm ở endpoint riêng: chỉ fetch lại khi revision của engine đổi.
  if (typeof current.itemsRevision === 'number') await loadItemsIfChanged(current.itemsRevision);
  schedulePoll();
}

// ---------------------------------------------------------------------------
// AUTO SYNC ĐANG CHẠY — hiện lên tab "Tra cứu & tải" cho trực quan:
//   • điền cấu hình của lượt Auto Sync (khoảng ngày, Mua vào/Bán ra) vào form;
//   • hiện danh sách hoá đơn đang được tra cứu/tải kèm trạng thái từng dòng.
// Chỉ vẽ khi lượt tải THỦ CÔNG không bận — không giành bảng với người dùng đang thao tác.
// Banner trên dòng MST (renderer) vẫn giữ, phần này chi tiết hơn.
let syncPreviewActive = false;
let syncPreviewBusy = false;
let syncPreviewSignature = '';
let syncPreviewApplied = '';
let syncPreviewStamp = 0; // tăng mỗi lần fetch thấy danh sách Auto Sync đổi → đồng bộ với itemsRevision của render()

function clearSyncPreview() {
  if (!syncPreviewActive) return;
  syncPreviewActive = false;
  syncPreviewSignature = '';
  // Bảng đang hiển thị danh sách của lượt Auto Sync: vẽ lại NGAY từ items của lượt thủ công
  // (bảng không còn được render() dựng lại theo nhịp poll nữa — xem renderItemsTable).
  if (current) renderItemsTable(current);
  // Buộc render() vẽ lại bảng/labels theo state thật ở nhịp kế tiếp.
  lastRenderedState = '';
}

async function paintSyncPreview() {
  const selected = current.selected || '';
  if (!selected || current.busy || current.authBusy || pending) { clearSyncPreview(); return; }
  // Tối ưu nhịp poll: không có MST nào đang chạy Auto Sync thì preview chắc chắn trống — dọn lần
  // cuối rồi thoát, KHÔNG gọi /api/db/autosync/status mỗi 1,5 giây nữa (bớt một nửa request nền).
  if (!(current.accounts || []).some(account => account.sync && account.sync.running)) { syncPreviewSignature = ''; clearSyncPreview(); return; }
  if (syncPreviewBusy) return;
  syncPreviewBusy = true;
  try {
    const response = await fetch(`/api/db/autosync/status?mst=${encodeURIComponent(selected)}`);
    const result = await response.json();
    const preview = result && result.ok ? result.value.preview : null;
    if (!preview || !(preview.items || []).length) { syncPreviewSignature = ''; clearSyncPreview(); return; }
    syncPreviewStamp += 1;
    paintSyncPreviewInto(preview, result.value);
  } catch { clearSyncPreview(); }
  finally { syncPreviewBusy = false; }
}

function paintSyncPreviewInto(preview, status) {
  const params = preview.params || {};
  // Cấu hình đang chạy: người dùng nhìn là biết Auto Sync đang tải khoảng thời gian nào.
  if (params.from) $('from').value = params.from;
  if (params.to) $('to').value = params.to;
  if (params.direction) $('direction').value = params.direction;
  $('results-title').textContent = 'Auto Sync đang tải hóa đơn';
  $('state').textContent = labels[preview.state] || preview.state || 'Đang chạy';
  $('message').textContent = preview.message || 'Auto Sync đang chạy…';
  // Bảng đang hiển thị lượt Auto Sync: 4 thẻ số phải theo ĐÚNG lượt này (preview.items dùng chung
  // bộ trạng thái done / skipped / failed) và cũng là nguồn cho thanh tiến trình bên dưới.
  const counts = {
    total: preview.items.length,
    downloaded: preview.items.filter(x => x.state === 'done').length,
    existed: preview.items.filter(x => x.state === 'skipped').length,
    failed: preview.items.filter(x => x.state === 'failed').length,
  };
  paintStatBreakdown(counts);
  const percent = counts.total ? Math.round(100 * (counts.downloaded + counts.existed + counts.failed) / counts.total) : 0;
  $('percentage').textContent = `${percent}%`; $('progress').value = percent;

  syncPreviewSignature = (status.mst || '') + ':' + preview.items.length + ':' + syncPreviewStamp;
  if (syncPreviewSignature === syncPreviewApplied) return;
  syncPreviewApplied = syncPreviewSignature;
  syncPreviewActive = true;
  lastRowSigs = []; // bảng vừa bị preview chiếm: lần sau renderItemsTable phải dựng lại

  const table = $('rows');
  const fragment = document.createDocumentFragment();
  const cell = (text, small) => {
    const td = document.createElement('td'); td.textContent = text ?? '';
    if (small) { const sub = document.createElement('small'); sub.textContent = small; td.append(sub); }
    return td;
  };
  for (const [index, inv] of preview.items.entries()) {
    const row = document.createElement('tr');
    row.className = inv.state || '';
    const stt = cell(String(index + 1)); stt.className = 'stt';
    const day = cell(dayOf(inv.date));
    const number = cell(inv.number, `${inv.symbol || ''}${params.direction === 'sold' ? ' · Bán ra' : (params.direction === 'purchase' ? ' · Mua vào' : '')}`);
    const seller = cell(inv.name || inv.seller, inv.seller);
    const buyer = cell(inv.buyerName || inv.buyer, inv.buyer);
    const amount = cell(inv.amount == null ? '—' : amountFormat.format(inv.amount));
    const detail = inv.error ? `${errorLabels[inv.errorType] || ''}${errorLabels[inv.errorType] ? ': ' : ''}${inv.error}` : (inv.warning || '');
    const result = cell(labels[inv.state] || inv.state, detail); result.className = inv.state;
    row.append(stt, day, number, seller, buyer, amount, result);
    fragment.append(row);
  }
  table.replaceChildren(fragment);
  $('empty').hidden = true;
  $('limit').textContent = 'Danh sách này là của lượt Auto Sync đang chạy (không phải lượt tra cứu thủ công).';
}
// `longMst`: MST đang có tác vụ DÀI (tra cứu/tải) — dùng để hiện, KHÔNG dùng để chặn chuyển MST.
let longMst = '';
// `options.long`: tác vụ DÀI (tra cứu / tải cuốn chiếu) là MỘT request mở suốt nhiều phút. Trước đây
// nó đặt `pending = true` suốt thời gian đó, mà `chooseMst()` lại `if (pending) return;` nên KHÔNG
// THỂ bấm sang MST khác để làm việc. Nay tác vụ dài không giữ `pending` — chỉ yêu cầu UI ngắn
// (chọn MST, thêm, đăng nhập…) mới giữ, để vẫn chặn bấm trùng.
async function work(url, data, options = {}) {
  const isLong = !!options.long;
  if (isLong) longMst = String((data && data.mst) || (current && current.selected) || '');
  else { pending = true; if (typeof data?.mst === 'string' && data.mst) selectingMst = data.mst; }
  render(current);
  try { return await call(url, data); }
  catch (error) { noticeFail(error.message); return null; }
  finally { if (isLong) longMst = ''; else { pending = false; selectingMst = ''; } await refresh(); }
}
// Chọn MST KHÔNG khoá UI: đây chỉ là thao tác NHẸ (đổi MST đang xem + kiểm tra còn phiên hay không,
// để biết lúc nào phải đăng nhập lại). Khác `work()`, hàm này KHÔNG bật `pending` — thanh công cụ
// vẫn dùng được trong lúc máy chủ kiểm tra. Chỉ tô sáng dòng vừa bấm cho có phản hồi tức thì.
async function selectMst(mst) {
  selectingMst = mst;
  render(current);
  try { return await call('/api/account/select', { mst }); }
  catch (error) { noticeFail(error.message); return null; }
  finally { selectingMst = ''; await refresh(); }
}
function loginError(text) { $('login-error').textContent = text || ''; $('login-error').hidden = !text; }
function invalidateChallenge() {
  loginId = ''; preparedMst = ''; $('login-captcha').value = '';
  $('login-captcha-image').removeAttribute('src'); $('login-captcha-image').hidden = true; $('login-captcha-placeholder').hidden = false;
  $('login-submit').disabled = true; $('login-refresh').disabled = true;
  $('login-credentials').hidden = true;
  $('login-forget').hidden = true; $('login-password').placeholder = 'Mật khẩu cổng thuế';
}
function loginBusy(busy) {
  loginWorking = busy;
  ['login-mst','login-user','login-password','login-captcha','login-prepare','login-refresh','login-close'].forEach(id => { $(id).disabled = busy; });
  $('login-submit').disabled = busy || !loginId; $('login-refresh').disabled = busy || !loginId;
}
async function acceptLoginResult(result) {
  if (result.authenticated) {
    $('login-password').value = ''; invalidateChallenge(); $('login-dialog').close();
    notice(result.remembered ? 'Đăng nhập thành công. Phiên đã lưu — lần sau chỉ cần gõ mã CAPTCHA.' : 'Đăng nhập thành công. Có thể tra cứu hóa đơn.'); await refresh(); return;
  }
  loginId = result.loginId || ''; preparedMst = result.mst || '';
  $('login-remember').checked = result.remembered === true || $('login-remember').checked;
  $('login-forget').hidden = result.remembered !== true;
  $('login-password').placeholder = result.remembered === true ? 'Đang dùng mật khẩu đã lưu — để trống nếu không đổi' : 'Mật khẩu cổng thuế';
  $('login-captcha').value = '';
  const captcha = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(result.captcha || '') ? result.captcha : '';
  $('login-captcha-image').hidden = !captcha; $('login-captcha-placeholder').hidden = !!captcha;
  if (captcha) $('login-captcha-image').src = captcha; else $('login-captcha-image').removeAttribute('src');
  $('login-credentials').hidden = !loginId;
  $('login-status').textContent = captcha ? 'Nhập mật khẩu và mã trong ảnh, sau đó bấm Đăng nhập.' : 'Chưa lấy được ảnh CAPTCHA. Bấm Lấy CAPTCHA để thử lại.';
  loginError(result.error || ''); loginBusy(false);
}
async function prepareLogin() {
  const mst = $('login-mst').value.trim();
  if (!MstFormat.isValidMst(mst)) { loginError(MstFormat.MST_HINT + ' Trước khi lấy CAPTCHA.'); return; }
  if (!$('login-user').value.trim()) $('login-user').value = mst;
  invalidateChallenge(); loginBusy(true); loginError(''); $('login-status').textContent = 'Đang mở phiên cổng thuế và lấy CAPTCHA…';
  try { await acceptLoginResult(await call('/api/account/login', { mst })); }
  catch (error) { loginError(error.message); }
  finally { loginBusy(false); await refresh(); }
}
function openLogin(mst = '', { retryAuto = false } = {}) {
  invalidateChallenge(); loginError(''); $('login-form').reset();
  $('login-mst').value = mst; $('login-user').value = mst; $('login-remember').checked = true;
  $('login-status').textContent = 'Nhập MST rồi bấm Lấy CAPTCHA. Chrome chỉ dùng khi cần đăng nhập dự phòng.';
  if (mst && mst === current.selected && current.remembered) { $('login-forget').hidden = false; $('login-password').placeholder = 'Đang dùng mật khẩu đã lưu — để trống nếu không đổi'; }
  // Nút "Thử lại tự động" chỉ hiện khi mở từ một lượt tự động đăng nhập vừa THẤT BẠI — bấm
  // là chạy lại autoLoginAccount (solver JS tự giải CAPTCHA) mà không cần gõ gì.
  const retry = $('login-retry-auto');
  if (retry) {
    retry.hidden = !(retryAuto && mst);
    retry.onclick = async event => {
      event.preventDefault();
      retry.disabled = true;
      $('login-status').textContent = `Đang thử lại đăng nhập tự động cho MST ${mst}…`;
      try {
        const value = await call('/api/account/auto-login', { mst, remember: true });
        if (value && value.authenticated) {
          $('login-dialog').close();
          notice(`MST ${mst}: đăng nhập tự động thành công sau ${value.attempts || 1} lần thử. Phiên đã lưu.`);
          await refresh();
        } else {
          await acceptLoginResult(value);
          retry.disabled = false;
        }
      } catch (error) {
        loginError(error.message);
        retry.disabled = false;
      }
    };
  }
  $('login-dialog').showModal(); $('login-mst').focus(); loginBusy(false);
  if (mst) void prepareLogin();
}
$('add-mst').onclick = () => openMstForm(null);
// "Đồng bộ tất cả": bấm lần đầu thì chạy, đang chạy thì bấm để ngưng.
// Chạy NGAY (không phụ thuộc khung giờ / cửa sổ đóng) vì đây là ý người dùng.
// "Đồng bộ tất cả": bấm lần đầu thì chạy, đang chạy thì bấm để ngưng. Cờ atWork dọn ngay trong
// finally TRƯỚC khi refresh vẽ nhãn mới — nhờ đó nhìn thấy đúng: chưa kịp vẽ thì nút vẫn khoá,
// vẽ rồi thì tự mở khoá theo nhãn mới.
if (optional('sync-all')) optional('sync-all').onclick = async () => {
  const button = optional('sync-all');
  const wasRunning = !!(current && current.pool && current.pool.running);
  if (wasRunning) {
    // Đang chạy: bấm là NGƯNG — nếu bấm đúp thì request thứ hai cũng vô hại (server idempotent).
    await work('/api/db/autosync/run-all/stop', {});
    notice('Đã ngưng đồng bộ tất cả.');
    // Cờ kết quả được xoá để dòng tổng kết báo lại lần này (lượt sau không bị nhận là đã báo).
    lastPoolReport = '';
    return;
  }
  // Chưa chạy: khoá nút NGAY để cú bấm thứ hai không gửi lệnh chạy thêm lần nữa.
  const restore = busyButton(button, 'Đang khởi động…');
  let result = null;
  try { result = await work('/api/db/autosync/run-all', {}); }
  finally { restore(); }
  if (!result) return;
  if (!result.started) { notice(result.message || 'Không có MST nào để chạy.'); return; }
  resetPoolReport();
  const skipped = (result.skipped || []).map(x => `${x.mst} (${x.reason})`);
  notice(`Đang đồng bộ ${result.queued} MST · ${result.concurrency} luồng song song, xong cái nào rút cái kế tiếp.${skipped.length ? ` Bỏ qua: ${skipped.join(', ')}.` : ''}`);
};

// Tổng kết bể "Đồng bộ tất cả" khi nó không còn chạy nữa. Trước đây không có dòng này: sau khi bể
// xong, người dùng không biết MST nào đồng bộ, MST nào lỗi — phải tự click từng dòng MST.
// Người dùng BẤM NGƯNG thì đó là kết thúc bình thường, nên `stopped` tách riêng khỏi `failed`
// (xem sync-pool.js) — không thì báo "lỗi" cho một việc chính họ yêu cầu.
let lastPoolReport = '';
// Báo lại từ 0 khi bể được khởi động lại, không thì lượt sau có kết quả y hệt lượt trước thì
// bị nhận là "đã báo rồi" và im lặng.
function resetPoolReport() { lastPoolReport = ''; }
function reportPoolOutcome() {
  const pool = (current && current.pool) || null;
  if (!pool || pool.running) return;
  const done = pool.done || [], failed = pool.failed || [], stopped = pool.stopped || [];
  if (!done.length && !failed.length && !stopped.length) return;
  // Khoá theo nội dung: chỉ báo đúng một lần cho mỗi kết quả, không lặp mỗi nhịp poll.
  const signature = `${done.join(',')}|${stopped.join(',')}|${failed.map(x => x.mst + x.error).join(',')}`;
  if (signature === lastPoolReport) return;
  lastPoolReport = signature;
  const parts = [];
  if (done.length) parts.push(`${done.length} MST xong`);
  if (stopped.length) parts.push(`${stopped.length} MST đã dừng (${stopped.join(', ')})`);
  if (failed.length) parts.push(`${failed.length} MST lỗi (${failed.map(x => x.mst).join(', ')})`);
  if (!parts.length) return;
  const detail = failed.length ? [{ label: 'Xem MST bị lỗi', url: '/api/account/select', body: { mst: failed[0].mst } }] : [];
  notice(`Đồng bộ tất cả: ${parts.join(' · ')}.`, detail, failed.length ? 'error' : undefined);
}
if (optional('mst-login')) optional('mst-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
if (optional('account-login')) optional('account-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
// Ô tìm MST: gõ liên tục chỉ lọc MỘT lần sau 150ms im — không dựng lại danh sách từng ký tự.
let mstSearchTimer = null;
const mstQuery = () => $('mst-search').value;
$('mst-search').oninput = () => { clearTimeout(mstSearchTimer); mstSearchTimer = setTimeout(() => renderAccounts(current), 150); };
$('mst-close').onclick = () => $('mst-dialog').close();
$('mst-cancel').onclick = () => $('mst-dialog').close();
$('identifiers-close').onclick = () => $('identifiers-dialog').close();
$('identifiers-cancel').onclick = () => $('identifiers-dialog').close();
$('identifiers-form').onsubmit = async event => {
  event.preventDefault();
  const mst = $('identifiers-primary').value;
  const identifiers = $('identifiers-values').value.split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
  const invalid = identifiers.find(value => !/^\d{6,20}$/.test(value));
  if (invalid) {
    $('identifiers-error').textContent = `Mã “${invalid}” không hợp lệ. Chỉ nhập 6–20 chữ số.`;
    $('identifiers-error').hidden = false;
    return;
  }
  $('identifiers-save').disabled = true;
  try {
    const account = await call('/api/account/identifiers', { mst, identifiers });
    $('identifiers-dialog').close();
    notice(`Đã lưu ${account.identifiers.length} mã bổ sung cho MST ${mst}.`);
    await refresh();
  } catch (error) {
    $('identifiers-error').textContent = error.message;
    $('identifiers-error').hidden = false;
  } finally { $('identifiers-save').disabled = false; }
};
document.addEventListener('click', event => { if (!event.target.closest('.mst-row')) closeRowMenus(); });
$('mst-form').onsubmit = async event => {
  event.preventDefault();
  const wasEditing = editingMst;
  const input = {
    previous: editingMst, mst: $('mst-code').value.trim(), name: $('mst-name').value.trim(),
    password: $('mst-password').value, remember: $('mst-remember').checked,
    // THÊM MST: gửi kèm thư mục lưu. BỎ TRỐNG ⇒ server tự dùng mặc định Documents\CN-invoice —
    // yêu cầu người dùng: khách bấm Huỷ ở hộp chọn thư mục thì KHÔNG được chặn việc thêm MST.
    ...(wasEditing ? {} : { output: $('mst-output').value.trim() }),
  };
  if (!MstFormat.isValidMst(input.mst)) { $('mst-error').textContent = MstFormat.MST_HINT; $('mst-error').hidden = false; return; }
  $('mst-submit').disabled = true;
  try {
    const account = await call('/api/account/save', input);
    $('mst-dialog').close(); $('mst-password').value = ''; $('mst-error').hidden = true; await refresh();
    if (wasEditing) { notice(`Đã cập nhật ${displayName(account)}.`); return; }
    // Thêm MST mới: lưu xong là TỰ ĐỘNG ĐĂNG NHẬP luôn (mật khẩu vừa nhập trong form được saveAccount
    // lưu sẵn). Chỉ khi thất bại mới mở form Đăng nhập thủ công.
    notice(`Đã lưu ${displayName(account)} — đang tự động đăng nhập…`);
    // LƯU Ý: autoLoginMst() KHÔNG ném lỗi khi đăng nhập sai — nó trả về false (bên trong đã dựng
    // sẵn form thủ công rồi ĐÓNG lại). Vì vậy phải bắt cả giá trị false, nếu chỉ có `catch` thì
    // khách lưu MST với mật khẩu sai sẽ chỉ thấy một dòng toast và KHÔNG có hộp thoại đăng nhập nào.
    // Đăng nhập thành công ⇒ server tự chạy lượt quét 10 ngày đầu cho MST mới (src/first-scan.js).
    try { if (!(await autoLoginMst(account.mst))) openLoginChoice(account.mst); }
    catch (error) { noticeFail(error.message); await prepareManualLogin(account.mst); openLoginChoice(account.mst); }
  } catch (error) { $('mst-error').textContent = error.message; $('mst-error').hidden = false; }
  finally { $('mst-submit').disabled = false; editingMst = ''; }
};
$('login-close').onclick = () => $('login-dialog').close();
$('login-choice-close').onclick = () => $('login-choice-dialog').close();
$('login-dialog').addEventListener('cancel', event => { if (loginWorking) event.preventDefault(); });
$('login-dialog').addEventListener('close', () => { $('login-password').value = ''; invalidateChallenge(); });
$('login-mst').oninput = () => { invalidateChallenge(); };
$('login-prepare').onclick = prepareLogin;
$('login-refresh').onclick = async () => {
  loginBusy(true); loginError('');
  try { await acceptLoginResult(await call('/api/account/captcha', {})); }
  catch (error) { invalidateChallenge(); loginError(error.message); }
  finally { loginBusy(false); }
};
$('login-show-page').onclick = async () => {
  const restore = busyButton($('login-show-page'), 'Đang mở Chrome…');
  try {
    const wantVisible = !current.browserVisible;
    if (!current.browserReady) await call('/api/account/show', { mst: $('login-mst').value.trim() });
    else await call('/api/account/visibility', { visible: wantVisible });
    $('login-show-page').textContent = wantVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
    $('login-status').textContent = wantVisible ? 'Chrome đăng nhập đang hiển thị.' : 'Chrome đăng nhập đang chạy ẩn.';
    await refresh();
  }
  catch (error) { loginError(error.message); }
  finally { restore(); }
};
if (optional('browser-toggle')) optional('browser-toggle').onclick = async () => {
  // Chưa có cửa sổ (Chrome đã tự đóng sau lượt tải trước) thì mở lại và hiện lên, đúng như nút
  // "Hiện Chrome đăng nhập" trong bảng đăng nhập.
  const result = current.browserReady
    ? await work('/api/account/visibility', { visible: !current.browserVisible })
    : await work('/api/account/show', { mst: current.selected || '' });
  if (result === true) notice('Chrome đăng nhập đang hiển thị.');
  else if (result) notice(result.visible ? 'Chrome đăng nhập đang hiển thị.' : 'Chrome đăng nhập đã ẩn, phiên và cookie vẫn được giữ.');
};
$('login-form').onsubmit = async event => {
  event.preventDefault(); if (loginWorking || !loginId) return;
  loginBusy(true); loginError(''); $('login-status').textContent = 'Đang đăng nhập…';
  const credentials = { mst: preparedMst, loginId, username: $('login-user').value.trim(), password: $('login-password').value, captcha: $('login-captcha').value.trim(), remember: $('login-remember').checked };
  try { await acceptLoginResult(await call('/api/account/submit', credentials)); }
  catch (error) { invalidateChallenge(); loginError(error.message); }
  finally { credentials.password = ''; loginBusy(false); await refresh(); }
};
$('login-forget').onclick = async () => {
  if (!current.selected || !await askConfirm({
    title: 'Xoá mật khẩu đã lưu', tone: 'error', ok: 'Xoá mật khẩu', cancel: 'Giữ lại',
    text: `Xoá mật khẩu đã lưu của MST ${current.selected}? Phiên đăng nhập hiện tại vẫn giữ.`,
  })) return;
  try {
    await call('/api/account/forget', {});
    $('login-forget').hidden = true; $('login-remember').checked = true;
    $('login-password').placeholder = 'Mật khẩu cổng thuế';
    notice('Đã xoá mật khẩu đã lưu trên máy này.'); await refresh();
  } catch (error) { loginError(error.message); }
};
$('choose').onclick = async () => {
  // Hộp thoại của Windows mở qua PowerShell; nếu vì lý do gì đó không thấy hộp thoại thì gõ thẳng
  // đường dẫn đầy đủ vào ô “Thư mục lưu” rồi bấm ra ngoài ô. busyButton: phản hồi tức thì + chống
  // bấm đúp mở 2 hộp thoại (request mất vài trăm ms đến vài giây khi máy bận).
  const restore = busyButton($('choose'), 'Đang mở…');
  notice('Đang mở hộp thoại chọn thư mục… Nếu không thấy hộp thoại, gõ hoặc dán đường dẫn đầy đủ vào ô “Thư mục lưu” rồi bấm ra ngoài ô.');
  try {
    const before = current.output || '';
    const folder = await call('/api/folder', {});
    $('output').value = folder || ''; current.output = folder || '';
    if (folder && folder !== before) notice(`Thư mục lưu: ${folder}`);
    else if (!folder) notice('Chưa chọn thư mục lưu — chọn lại, hoặc gõ đường dẫn vào ô “Thư mục lưu”.');
  } catch (error) { noticeFail(error.message); }
  finally { restore(); }
};
// Nút "Chọn thư mục…" TRONG form Thêm MST: dùng ĐÚNG hộp thoại Windows của tab Tra cứu
// (POST /api/folder KHÔNG kèm path). Bấm HUỶ ở hộp thoại ⇒ folder rỗng ⇒ GIỮ NGUYÊN ô; nếu ô vẫn
// trống thì lúc lưu server tự dùng thư mục mặc định (Documents\CN-invoice) — không chặn việc thêm.
$('mst-output-choose').onclick = async () => {
  const restore = busyButton($('mst-output-choose'), 'Đang mở…');
  notice('Đang mở hộp thoại chọn thư mục… Nếu không thấy hộp thoại, gõ hoặc dán đường dẫn đầy đủ vào ô rồi bấm ra ngoài ô.');
  try {
    const folder = await call('/api/folder', {});
    if (folder) { $('mst-output').value = folder; notice(`Thư mục lưu: ${folder}`); }
    else notice('Không chọn thư mục — khi lưu sẽ dùng thư mục mặc định.');
  } catch (error) { noticeFail(error.message); }
  finally { restore(); }
};
// Gõ/dán đường dẫn thẳng vào ô của form Thêm MST: kiểm ngay như ô "Thư mục lưu" ở tab Tra cứu
// (server tạo thư mục + thử ghi) để không phải đợi tới lúc lưu mới báo lỗi.
$('mst-output').onchange = async () => {
  const typed = $('mst-output').value.trim();
  if (!typed) return; // để trống = dùng mặc định, không cần kiểm
  try { const folder = await call('/api/folder', { path: typed }); $('mst-output').value = folder; notice(`Đã đặt thư mục lưu: ${folder}`); }
  catch (error) { noticeFail(error.message); $('mst-output').value = ''; }
};
// ĐỔI THƯ MỤC LƯU — thao tác NGUY HIỂM nên đi đường riêng, có cảnh báo. Ô "Thư mục lưu" bị KHOÁ
// (xem render()) để không gõ nhầm; muốn đổi phải xác nhận rồi mới mở hộp thoại chọn thư mục.
// `confirm: true` gửi kèm là xác nhận để SERVER cho phép đổi — chốt nằm ở server chứ không chỉ ở
// giao diện, nên không đường nào đổi thư mục mà thiếu xác nhận.
$('change-output').onclick = async () => {
  const from = current.output || '';
  const accepted = await askConfirm({
    title: 'Đổi thư mục lưu hóa đơn',
    tone: 'error',
    ok: 'Tôi hiểu — đổi thư mục',
    cancel: 'Giữ nguyên',
    text: `App đang dùng thư mục:\n${from}\n\n`
      + 'Nếu đổi sang thư mục khác thì hóa đơn và kho dữ liệu ĐÃ CÓ ở thư mục trên sẽ KHÔNG còn hiện trong app '
      + '(Tổng quan, Kho dữ liệu, Sao kê ngân hàng đều đọc thư mục mới).\n\n'
      + 'FILE KHÔNG BỊ XOÁ — vẫn nằm nguyên trong thư mục cũ. Muốn thấy lại dữ liệu cũ thì đổi về thư mục đó.',
  });
  if (!accepted) return;
  const restore = busyButton($('change-output'), 'Đang mở…');
  try {
    const folder = await call('/api/folder', { confirm: true });
    if (!folder || folder === from) { notice('Không đổi thư mục — giữ nguyên thư mục hiện tại.'); return; }
    $('output').value = folder; current.output = folder;
    notice(`Đã đổi thư mục lưu: ${folder}`);
    await refresh();
  } catch (error) { noticeFail(error.message); }
  finally { restore(); }
};
$('output').onchange = async () => {
  const typed = $('output').value.trim();
  if (!typed || typed === (current.output || '')) return;
  try {
    const folder = await call('/api/folder', { path: typed });
    $('output').value = folder; current.output = folder; notice(`Đã đặt thư mục lưu: ${folder}`); await refresh();
  } catch (error) { noticeFail(error.message); $('output').value = current.output || ''; }
};
// ---------------------------------------------------------------------------
// NÚT "Tải hóa đơn" — MỘT NÚT DUY NHẤT, tự đổi nhãn theo trạng thái (2026-10)
// ---------------------------------------------------------------------------
// Trước đây có 3 nút (#search "Tra cứu", #stream-download "Tải ngay", #resume "Tải tiếp").
// Người dùng phải tự nhớ: muốn xem danh sách thì bấm nút nào, muốn tải file thì bấm nút nào,
// lỗi rồi thì bấm nút thứ ba. Nay gộp còn MỘT nút với 3 trạng thái:
//   · rảnh / đã xong   → "Tải hóa đơn"  → quét + tải TOÀN BỄ khoảng ngày đang chọn
//   · đang chạy        → "Ngưng"        → dừng, giữ nguyên tiến độ
//   · lượt còn dở      → "Tải tiếp"     → chạy tiếp đúng chỗ dừng (lỗi tạm thời đã tự thử lại)
// Server đoán trạng thái từ job (isResumableJob trong core.js) nên giao diện KHÔNG cần chọn
// "chỉ tra cứu" hay "tải luôn" — hai việc đó giờ là một.
//
// DANH SÁCH TRẠNG THÁI "còn dở" KHÔNG khai báo ở đây: server gửi sẵn `resumable` trong
// /api/state (đúng isResumableJob của core.js). Trước đây renderer chép lại một mảng trạng
// thái riêng rồi còn thêm hai điều kiện lọc (state.authenticated, state.total > 0) mà server
// không có ⇒ hai bên lệch nhau: hết phiên thì server coi là "còn dở" (chạy tiếp được) mà
// giao diện lại hiện "Tải hoá đơn"; và ngưng lúc còn đang quét (chưa tìm thấy hoá đơn nào,
// total = 0) thì mất luôn nút "Tải tiếp". Một nguồn duy nhất là isResumableJob.
function downloadButtonState(state) {
  if (!state) return { label: 'Tải hóa đơn', action: 'start', loading: false };
  if (state.busy) return { label: 'Ngưng', action: 'pause', loading: true };
  // Lượt còn dở NHƯNG điều kiện tra cứu đã đổi (người dùng đổi Từ ngày/Đến ngày…) thì bấm là
  // chạy lượt MỚI, không phải chạy tiếp — nhãn phải nói đúng việc sẽ làm. Server cũng tự kiểm
  // lại bằng sameDownloadParams() nên nếu giao diện có sai thì vẫn không tải nhầm khoảng ngày.
  if (state.resumable && sameSearchForm(state.params)) return { label: 'Tải tiếp', action: 'resume', loading: false };
  return { label: 'Tải hóa đơn', action: 'start', loading: false };
}
// So bộ điều kiện tra cứu đang chọn trên màn hình với bộ của lượt đang dở. Thứ tự phần tử của
// `formats` không quan trọng (đã sắp) — cùng cách so sánh như core.js.
function sameSearchForm(jobParams) {
  if (!jobParams) return false;
  const form = {
    from: $('from').value, to: $('to').value, direction: $('direction').value,
    family: $('family').value, status: $('status').value,
    formats: [...document.querySelectorAll('.formats input:checked')].map(x => x.value),
  };
  const key = value => JSON.stringify({ ...value, formats: [...(value.formats || [])].sort() });
  return key(jobParams) === key(form);
}
async function runLookup(url) {
  // KHÔNG chặn ở đây: `pending` = true suốt thời gian request dài đang chờ (server trả lời khi
  // tác vụ kết thúc), nên phải xử lý nhánh DỪNG trước rồi mới tới guard pending — nếu không,
  // bấm "Ngưng" bị nuốt im lặng.
  // Trạng thái MỚI NHẤT: render() vừa chạy trong nhịp poll, hoặc sẽ chạy ngay khi work()/refresh()
  // xong — KHÔNG gọi thêm /api/state một lần nữa như trước đây (bỏ một vòng trọn vẹn).
  const action = downloadButtonState(current).action;
  // Nhánh DỪNG trước tiên: đang chạy thì bấm là ngưng. Gọi /api/pause TRỰC TIẾP bằng
  // call() (không qua work()) để guard `pending` không nuốt — pending đúng lúc này là true.
  if (action === 'pause') {
    const mst = current.selected;
    const jobId = current.jobId;
    notice('Đang ngưng tác vụ của MST ' + mst + '…');
    try {
      await call('/api/pause', { mst, jobId });
      await refresh();
    } catch (error) { noticeFail(error.message); }
    return;
  }
  if (pending) return; // chỉ chặn thao tác MỚI khi đang có request khác
  if (current.busy) return;
  const folder = $('output').value.trim();
  if (!folder) { notice('Chọn thư mục lưu hóa đơn trước khi tải.'); $('output').focus(); return; }
  if (!current.selected) { notice('Chọn MST trước khi tải hóa đơn.'); return; }
  // Người dùng có thể gõ/dán đường dẫn rồi bấm ngay: lưu lại trước khi chạy.
  if (folder !== (current.output || '')) {
    try { const saved = await call('/api/folder', { path: folder }); $('output').value = saved; current.output = saved; }
    catch (error) { noticeFail(error.message); $('output').focus(); return; }
  }
  // Vẽ NGAY trạng thái "đang chạy" TRƯỚC khi gửi — bấm là UI phản hồi, không đợi mạng.
  // Quan trọng: vẽ vào CHÍNH `current` chứ không tạo bản sao, để `refresh()` (chạy ngay sau
  // đó trong finally của work()) không ghi đè mất trạng thái lạc lưỡng.
  current.busy = true;
  current.mode = 'stream';
  current.state = action === 'resume' ? 'downloading' : 'searching';
  current.message = action === 'resume' ? 'Đang chạy tiếp từ chỗ đã dừng…' : 'Đang quét và tải toàn bộ hóa đơn…';
  // Không hiện toast sau khi bấm: kết quả đã nằm trong bảng + dòng trạng thái/tiến độ.
  await work(url, { mst: current.selected, from: $('from').value, to: $('to').value, direction: $('direction').value, family: $('family').value, status: $('status').value, formats: [...document.querySelectorAll('.formats input:checked')].map(x => x.value), output: folder, confirm: action === 'resume' }, { long: true });
}
// Nút MỘT duy nhất: bấm là chạy / dừng / chạy tiếp tuỳ trạng thái — server tự đoán (xem /api/download).
$('download-btn').onclick = () => runLookup('/api/download');
$('open').onclick = async () => {
  const restore = busyButton($('open'), 'Đang mở…');
  try { await work('/api/open-folder', {}); }
  finally { restore(); }
};
$('export-excel').onclick = async () => {
  if (!current.total) { notice('Chưa có kết quả để xuất Excel. Bấm “Tải hóa đơn” trước.'); return; }
  // busyButton = phản hồi tức thì + chống bấm đúp (không xuất 2 file vì cùng một cú bấm).
  const restore = busyButton($('export-excel'), 'Đang xuất…');
  try {
    const result = await work('/api/export-excel', {});
    if (!result) return;
    notice(`Đã xuất Excel theo mẫu MISA: ${result.rows} dòng × ${result.columns} cột — ${result.file}`, [
      ...(result.files || [result.file]).map((file, i) => ({ label: result.files ? `Mở Excel ${i + 1}` : 'Mở file Excel', url: '/api/open-file', body: { path: file }, keep: true })),
      { label: 'Mở thư mục', url: '/api/open-folder', body: {}, keep: true }
    ]);
  }
  finally { restore(); }
};
const today = new Date(); const local = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
$('to').value = local(today); $('from').value = local(new Date(today.getFullYear(), today.getMonth(), 1));
// ---- Chọn nhanh: Năm + Tháng / Quý / Cả năm, tự điền Từ ngày — Đến ngày ----
function syncPeriodOptions() {
  const from = String($('from').value || ''); const year = Number(from.slice(0, 4)) || today.getFullYear();
  const years = []; for (let y = today.getFullYear() - 5; y <= today.getFullYear() + 1; y++) years.push(y);
  if (!years.includes(year)) years.push(year);
  years.sort((a, b) => a - b);
  $('period-year').replaceChildren(...years.map(y => new Option(String(y), String(y), false, y === year)));
  // Nhãn ngắn để cả hàng vừa một dòng: T1…T12 và Q1…Q4 (xem tiêu đề đầy đủ khi rê chuột).
  $('period-month').replaceChildren(...Array.from({ length: 12 }, (_, i) => new Option(`T${i + 1}`, String(i + 1))));
  $('period-quarter').replaceChildren(...Array.from({ length: 4 }, (_, i) => new Option(`Q${i + 1}`, String(i + 1))));
  const month = Number(from.slice(5, 7)) || 1;
  $('period-month').value = String(month); $('period-month').title = `Tháng ${month}`;
  $('period-quarter').value = String(Period.quarterOf(month)); $('period-quarter').title = `Quý ${Period.quarterOf(month)}`;
}
function applyPeriod() {
  const mode = $('period-mode').value;
  $('period-month').hidden = mode !== 'month'; // chọn quý thì ẩn tháng…
  $('period-quarter').hidden = mode !== 'quarter'; // …chọn tháng thì ẩn quý
  $('period-month').title = `Tháng ${$('period-month').value}`;
  $('period-quarter').title = `Quý ${$('period-quarter').value}`;
  const unit = mode === 'quarter' ? $('period-quarter').value : $('period-month').value;
  try {
    const range = Period.rangeFor(mode, $('period-year').value, unit);
    $('from').value = range.from; $('to').value = range.to;
    notice(`${range.label}: từ ${range.from} đến ${range.to}`);
  } catch (error) { noticeFail(error.message); }
}
['period-mode', 'period-year', 'period-month', 'period-quarter'].forEach(id => { $(id).onchange = applyPeriod; });
syncPeriodOptions();
// Vòng poll TỰ LÊN LỊCH (schedulePoll cuối refresh) thay cho setInterval cứng 1,5 giây: bận 0,8s,
// rảnh 4s. refresh() có cờ polling nên không bao giờ chồng nhau.
// ---- Màn hình chờ khởi động (boot splash) ----
// Che màn hình trong lúc kiểm tra phiên đăng nhập + nạp dữ liệu Tổng quan rồi mờ dần để lộ
// giao diện Tổng quan của MST phiên làm việc gần nhất. Hai "cửa" phải cùng xong mới mở:
//   • 'session' — do refresh() đầu tiên phát (renderer.js)
//   • 'overview' — do lần refreshOverview() đầu phát (data-ui.js)
// Một cửa treo KHÔNG được giữ người dùng ở màn hình chờ: có trần thời gian an toàn ở dưới.
const bootFlags = { session: false, overview: false };
const BOOT_MAX_MS = 9000;
let bootDismissed = false;
// Màn hình chờ KHÔNG đứng yên: luân phiên câu mẹo/giới thiệu để người dùng có thứ để đọc
// trong lúc chờ kiểm tra phiên + nạp Tổng quan, thay vì nhìn một khoảng trống “vô tri”.
const BOOT_TIPS = [
  'Mẹo: bấm trực tiếp một dòng MST ở cột trái để chuyển sang phiên làm việc của khách hàng đó.',
  'Mẹo: dùng “Chọn nhanh” theo Tháng / Quý / Cả năm để điền khoảng ngày cần tải hóa đơn.',
  'Mẹo: tab Kho dữ liệu tra cứu hóa đơn đã nhập, đối chiếu sao kê ngân hàng và phương thức thanh toán.',
  'Mẹo: hóa đơn vừa tải xong luôn nằm ở đầu bảng kết quả — không cần cuộn xuống tìm.',
  'Mẹo: bật Auto Sync cho một MST để tự động tra cứu và nhập kho theo lịch.',
];
let bootTipTimer = null, bootTipIndex = -1;
function rotateBootTip() {
  const tip = $('boot-tip');
  if (!tip || bootDismissed) return;
  bootTipIndex = (bootTipIndex + 1) % BOOT_TIPS.length;
  tip.classList.remove('show');
  setTimeout(() => {
    if (bootDismissed || !tip.isConnected) return;
    tip.textContent = BOOT_TIPS[bootTipIndex];
    tip.classList.add('show');
  }, 260);
}

function paintBoot() {
  const step = !bootFlags.session ? 'session' : (!bootFlags.overview ? 'overview' : '');
  const status = $('boot-status');
  // Khi đã biết MST của phiên gần nhất (state về), gọi đích danh nó để chuyển cảnh có "đích đến"
  // rõ ràng: người dùng biết app đang mở Tổng quan của ai, không phải mở chung chung.
  const mstName = current && (current.companyName || current.selected);
  if (status) status.textContent = step === 'session' ? 'Đang kiểm tra phiên đăng nhập…'
    : step === 'overview' ? (mstName ? `Đang mở dữ liệu Tổng quan · ${mstName}…` : 'Đang tải dữ liệu tổng quan…')
    : (mstName ? `Đã sẵn sàng — đang mở Tổng quan của ${mstName}…` : 'Đã sẵn sàng — đang mở giao diện Tổng quan…');
  for (const [id, key] of [['boot-step-session', 'session'], ['boot-step-overview', 'overview']]) {
    const item = $(id);
    if (!item) continue;
    item.classList.toggle('done', bootFlags[key]);
    item.classList.toggle('active', step === key);
  }
  const ready = $('boot-step-ready');
  if (ready) ready.classList.toggle('done', !step);
}

// Hai script KHÔNG cần cho lúc mở app — chat hỗ trợ và kiểm tra bản cập nhật — trước đây nằm ngay
// trong luồng parse cuối body. Vì mọi script đều chạy tuần tự, trình duyệt không chạy nổi một
// callback nào cho tới khi CẢ 10 thẻ đã tải + chạy xong, mà hai script đó lại bắn request riêng
// NGAY khi nạp (`/api/support/device`, kiểm tra cập nhật) ⇒ tranh 6 khe kết nối HTTP/1.1 mỗi
// origin với `/api/state` và `/api/db/summary`, đúng hai thứ quyết định lúc app "sẵn sàng".
// Nay nạp SAU khi màn hình chờ đóng lại. `async = false` để hai script vẫn chạy ĐÚNG THỨ TỰ cũ
// (script chèn qua DOM mặc định là async, không đảm bảo thứ tự).
const DEFERRED_SCRIPTS = ['chat-widget.js', 'update-ui.js'];
function loadDeferredScripts() {
  for (const name of DEFERRED_SCRIPTS) {
    const tag = document.createElement('script');
    tag.src = name;
    tag.async = false;
    document.body.appendChild(tag);
  }
}

function dismissBootSplash() {
  if (bootDismissed) return;
  bootDismissed = true;
  if (bootTipTimer) { clearInterval(bootTipTimer); bootTipTimer = null; }
  const tip = $('boot-tip');
  if (tip) tip.classList.remove('show');
  const splash = $('boot-splash');
  // Giao diện bên dưới đã dựng sẵn Tổng quan của MST phiên gần nhất: cho nó hé lộ dần
  // (mờ + nhích lên) cùng lúc màn hình chờ mờ đi ⇒ chuyển cảnh mượt, không "bụp".
  document.body.classList.add('app-ready');
  // Cửa cho phần còn lại của giao diện: ai cần "sau khi mở app xong" thì nghe sự kiện này thay vì
  // chạy ngay lúc parse (xem app-settings.js — thông báo hỗ trợ). Cũng từ đây mới nạp 2 script trên.
  loadDeferredScripts();
  // Cờ cho ai gắn listener MUỘN (script nạp sau khi màn hình chờ đã đóng) — sự kiện chỉ bắn một lần.
  window.hdBootDismissed = true;
  window.dispatchEvent(new Event('hd:boot-done'));
  if (!splash) return;
  splash.classList.add('is-ready');
  setTimeout(() => {
    splash.classList.add('is-hidden');
    splash.setAttribute('aria-hidden', 'true');
    setTimeout(() => { splash.hidden = true; }, 500);
  }, 320); // giữ khoảnh khắc "đã sẵn sàng" cho chuyển cảnh mượt, không giật cục
}

window.hdBootReady = name => {
  if (!name || bootFlags[name]) return;
  bootFlags[name] = true;
  paintBoot();
  if (bootFlags.session && bootFlags.overview) dismissBootSplash();
};
paintBoot();
rotateBootTip();
bootTipTimer = setInterval(rotateBootTip, 3800);
setTimeout(dismissBootSplash, BOOT_MAX_MS);

// Hiển thị trạng thái loading NGAY LẬP TỨC khi mở app — không đợi /api/state về.
// Có cache MST thì dựng luôn danh sách + tô sáng MST phiên gần nhất ngay khung hình đầu;
// nhịp /api/state kế tiếp ghi đè bằng dữ liệu thật (MST đã bị xoá thì server đã tự rơi về
// MST gần nhất còn hoạt động — xem rememberSelectedMst trong server.js).
const cachedMstList = firstPaintMstList();
if (cachedMstList) current = { ...current, accounts: cachedMstList.accounts, selected: cachedMstList.selected || '' };
render(current);
refresh();

// ---- Version đang chạy + thông báo bản mới ----
// Chỉ ĐỌC thông tin bản phát hành mới nhất từ server (server gọi GitHub Releases).
// Không tự tải/ghi đè EXE đang chạy — người dùng tự tải bản mới từ GitHub.
// Chữ thương hiệu ở đáy sidebar: "CN" tô mint rồi phần còn lại — cùng kiểu với wordmark ở đầu
// sidebar (xem .brand-mark trong style.css). Trước đây gán textContent nên chỉ có một màu chữ.
// Tên nào không bắt đầu bằng "CN " thì trả về chuỗi thường, không tự thêm chữ.
function brandMark(text) {
  const value = String(text);
  if (!value.startsWith('CN ')) return document.createTextNode(value);
  const fragment = document.createDocumentFragment();
  const head = document.createElement('b'); head.textContent = 'CN';
  fragment.append(head, document.createTextNode(value.slice(2)));
  return fragment;
}
async function initVersion() {
  try {
    const response = await fetch('/api/version');
    const data = await response.json();
    const el = document.getElementById('app-version');
    if (data && data.ok && data.value && el) {
      // Số phiên bản để cỡ nhỏ + màu xám: chữ thương hiệu 17px đã chiếm gần hết bề ngang sidebar
      // hẹp (200px), để chung cỡ là bị cắt "…" khi bản sau lên số dài (vd v1.10.12).
      const tag = document.createElement('span');
      tag.className = 'app-version-tag'; tag.textContent = ` v${data.value.version}`;
      el.replaceChildren(brandMark(data.value.name), tag);
    }
  } catch { /* không có version cũng không sao */ }
}
async function initUpdateCheck() {
  try {
    const response = await fetch('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await response.json();
    const value = data && data.value;
    const badge = document.getElementById('update-available');
    if (!badge || !value || !value.updateAvailable) return;
    badge.textContent = `Có bản mới v${value.latest}`;
    badge.title = value.url || '';
    badge.hidden = false;
    badge.onclick = () => { if (value.url) window.open(value.url, '_blank', 'noopener'); };
  } catch { /* kiểm tra bản mới là tuỳ chọn, lỗi mạng bỏ qua */ }
}
initVersion();
initUpdateCheck();
