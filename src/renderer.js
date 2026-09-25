'use strict';
const $ = id => document.getElementById(id);
const optional = id => document.getElementById(id);
const labels = { idle: 'Sẵn sàng', searching: 'Đang tra cứu', downloading: 'Đang tải', paused: 'Tạm dừng', auth_required: 'Cần đăng nhập', ready: 'Sẵn sàng tải', completed: 'Hoàn tất', failed: 'Có lỗi', partial: 'Còn hóa đơn lỗi', queued: 'Chờ tải', running: 'Đang xử lý', skipped: 'Đã có sẵn – bỏ qua', done: 'Đã tải' };
// mst-format.js nạp bằng <script> TRƯỚC file này. Nếu vì lý do gì đó nó không nạp được thì dùng bản
// dự phòng ngay tại đây — nếu không sẽ ném "Cannot read properties of undefined" tại chỗ nhập MST.
const MstFormat = window.MstFormat || (() => {
  const HINT = 'Không nạp được bộ kiểm tra định dạng (mst-format.js). Mở lại ứng dụng.';
  return { MST_HINT: HINT, isValidMst: () => true, normalizeMst: v => String(v ?? '').trim(), baseMst: v => String(v ?? '').trim().split('-')[0], mstAliases: v => [String(v ?? '').trim()] };
})();
const errorLabels = { auth: 'Cần đăng nhập lại', rate_limited: 'Cổng đang giới hạn nhịp', timeout: 'Cổng phản hồi chậm', network: 'Lỗi kết nối', invalid_xml: 'XML/ZIP không hợp lệ', portal: 'Lỗi từ cổng thuế' };
let current = { busy: false, accounts: [] }, pending = false, initialized = false;
let loginId = '', preparedMst = '', loginWorking = false, polling = false;
async function call(url, body) {
  let response;
  try { response = await fetch(url, { method: url === '/api/state' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Không kết nối được ứng dụng. Hãy mở lại CN-Tax-Tools.exe.'); }
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
}
// Thông báo ở góc phải; có thể kèm nút hành động bấm được (ví dụ “Mở file”, “Mở thư mục”).
function notice(text, actions, kind) {
  const box = $('notice');
  // Toast lỗi = đỏ, mọi thông báo khác = xanh (xem style.css).
  const isError = kind === 'error';
  box.classList.toggle('notice-error', isError);
  box.classList.toggle('notice-ok', !isError);
  box.replaceChildren();
  const span = document.createElement('span'); span.textContent = text; box.append(span);
  for (const action of actions || []) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'link'; button.textContent = action.label;
    button.onclick = async () => {
      try { await call(action.url, action.body || {}); if (action.keep !== true) box.hidden = true; }
      catch (error) { noticeFail(error.message); }
    };
    box.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'notice-close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Đóng thông báo');
  close.onclick = () => { clearTimeout(notice.timer); box.hidden = true; };
  box.append(close);
  box.hidden = false; clearTimeout(notice.timer);
  // Tự tắt: 12 giây; có nút hành động thì 18 giây. Luôn có nút ✕ để tắt ngay.
  notice.timer = setTimeout(() => { box.hidden = true; }, actions?.length ? 18000 : 12000);
}
window.notice = notice;
// Báo lỗi: dùng đúng màu đỏ. Mọi thông báo khác đi qua notice() sẽ là màu xanh.
window.noticeFail = (text, actions) => notice(text, actions, 'error');
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
function closeRowMenus() { document.querySelectorAll('.row-menu-panel').forEach(x => x.remove()); }
// One ⋯ menu per row: log in for that MST, edit it, forget its password, or drop it from the list.
function openRowMenu(row, account) {
  const opened = row.querySelector('.row-menu-panel');
  closeRowMenus(); if (opened) return;
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
  row.append(panel);
}
function openIdentifiers(account) {
  $('identifiers-primary').value = account.mst;
  $('identifiers-values').value = (account.identifiers || []).join('\n');
  $('identifiers-subtitle').textContent = `Hóa đơn khớp MST chính ${account.mst} hoặc một mã dưới đây sẽ được đưa vào cùng kho dữ liệu.`;
  $('identifiers-error').hidden = true;
  $('identifiers-dialog').showModal();
  $('identifiers-values').focus();
}
// Bấm một dòng: còn phiên đã lưu thì vào thẳng giao diện chính, hết phiên thì mở form đăng nhập.
async function chooseMst(mst) {
  closeRowMenus();
  if (pending) return;
  if (mst === current.selected && current.authenticated) { notice(`Đang dùng phiên đăng nhập sẵn có của MST ${mst}.`); return; }
  initialized = false;
  const result = await work('/api/account/select', { mst });
  if (!result) return;
  if (result.authenticated) notice(`MST ${mst}: còn phiên đăng nhập — tra cứu được ngay.`);
  else { notice(`MST ${mst} hết phiên hoặc chưa đăng nhập — nhập CAPTCHA để vào.`); openLogin(mst); }
}
async function forgetPassword(account) {
  if (!confirm(`Xoá mật khẩu đã lưu của MST ${account.mst}? Phiên đang đăng nhập vẫn giữ.`)) return;
  try {
    if (account.mst !== current.selected) await work('/api/account/select', { mst: account.mst });
    await call('/api/account/forget', {});
    notice(`Đã xoá mật khẩu đã lưu của MST ${account.mst}.`); await refresh();
  } catch (error) { noticeFail(error.message); }
}
async function removeMst(account) {
  if (!confirm(`Bỏ MST ${account.mst} khỏi danh sách? Profile Chrome và tiến độ vẫn giữ trong du_lieu, nhưng phiên + mật khẩu đã lưu của MST này sẽ bị xoá.`)) return;
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
      return { kind: 'running', text: `Đang tải ${progress.downloaded}/${progress.queued}${progress.failed ? ` · lỗi ${progress.failed}` : ''}` };
    }
    return { kind: 'running', text: sync.phase ? `Đang chạy · ${sync.phase}` : 'Đang tra cứu…' };
  }
  if (sync.lastError) return { kind: 'error', text: `Lỗi (${bannerWhen(sync.lastErrorTime)}): ${String(sync.lastError).slice(0, 120)}` };
  if (sync.lastSuccess) {
    const when = bannerWhen(sync.lastSuccess);
    const downloaded = (sync.buyDownloaded || 0) + (sync.sellDownloaded || 0);
    const found = (sync.buyFound || 0) + (sync.sellFound || 0);
    if (downloaded > 0) return { kind: 'done', text: `Xong · ${downloaded} hóa đơn mới · ${when}` };
    if (found > 0) return { kind: 'done', text: `Xong · ${found} hóa đơn, không có bản mới · ${when}` };
    return { kind: 'empty', text: `Không có hóa đơn mới · ${when}` };
  }
  return null;
}

function renderAccounts(state) {
  const list = $('mst-items'); const query = $('mst-search').value.trim().toLowerCase();
  const all = state.accounts || [];
  const shown = query ? all.filter(x => `${displayName(x)} ${x.mst} ${(x.identifiers || []).join(' ')}`.toLowerCase().includes(query)) : all;
  $('mst-count').textContent = all.length > 1 ? `Danh sách MST (${shown.length}/${all.length})` : 'Danh sách MST';
  list.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement('p'); empty.className = 'mst-empty';
    empty.textContent = all.length ? 'Không có MST nào khớp từ khoá.' : 'Chưa có MST nào — bấm “＋ Thêm MST”.';
    list.append(empty); return;
  }
  for (const account of shown) {
    const row = document.createElement('div');
    row.className = 'mst-row' + (account.mst === state.selected ? ' active' : ''); row.dataset.mst = account.mst; row.tabIndex = 0;
    row.title = SESSION_LABEL[account.session] || '';
    const dot = document.createElement('span'); dot.className = `mst-dot ${account.session || 'none'}`;
    const info = document.createElement('div'); info.className = 'mst-info';
    const title = document.createElement('strong'); title.textContent = displayName(account);
    const sub = document.createElement('small');
    const syncing = !!account.sync?.running;
    const jobRunning = account.job?.state === 'searching' || account.job?.state === 'downloading' || account.job?.state === 'running';
    const running = syncing || jobRunning;
    sub.textContent = `${account.mst}${account.identifiers?.length ? ` · +${account.identifiers.length} mã` : ''}${account.remembered ? ' · đã lưu mật khẩu' : ''}${running ? ' · đang xử lý' : ''}${account.job ? ` · ${account.job.total} hóa đơn` : ''}`;
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
    };
    // Banner trạng thái ngay trên dòng MST đang chạy để nhìn vào danh sách là biết.
    const banner = syncBanner(account.sync);
    if (banner) {
      const line = document.createElement('small');
      line.className = `mst-banner ${banner.kind}`;
      line.textContent = banner.text;
      info.append(line);
    }
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'row-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', `Tuỳ chọn cho ${account.mst}`);
    menu.onclick = event => { event.stopPropagation(); openRowMenu(row, account); };
    row.append(dot, info, stop, menu);
    row.onclick = () => chooseMst(account.mst);
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMst(account.mst); } };
    list.append(row);
  }
}
let lastRenderedState = null;
function render(state) {
  // Bảng có thể tới 1.000 dòng nên dựng lại toàn bộ DOM mỗi 1,5 giây là nguồn giật chính khi app
  // đứng yên. Chuỗi JSON của state là chữ ký đầy đủ (state đến từ JSON của server) nên chỉ bỏ qua
  // phần dựng DOM khi mọi thứ y hệt lần trước — nội dung và thứ tự render không đổi.
  // Chữ ký gồm cả `pending` (work() gọi render(current) để khoá nút trong lúc chạy) và trạng thái
  // mở của hộp thoại đăng nhập — đó là hai đầu vào DOM không nằm trong state, thiếu chúng thì nút
  // hoặc nhãn trong hộp thoại sẽ không được cập nhật như trước.
  let signature = null;
  try { signature = JSON.stringify([pending, $('login-dialog').open ? 1 : 0, state]); } catch { signature = null; }
  const changed = signature === null || signature !== lastRenderedState;
  current = state;
  if (changed) { lastRenderedState = signature; renderAccounts(state); }
  // Cho các module khác (hộp thoại cập nhật) bám theo trạng thái mới nhất mà không cần poll riêng.
  window.HD_LAST_STATE = state;
  try { window.dispatchEvent(new CustomEvent('hd:state', { detail: state })); } catch {}
  if (!changed) return;
  const browserText = state.browserVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
  // Chrome tự đóng sau khi tải xong, nên nút này không còn phụ thuộc browserReady: chưa có cửa sổ
  // thì bấm vào sẽ mở lại (xem onclick), giống nút trong bảng đăng nhập.
  const browserToggle = optional('browser-toggle');
  if (browserToggle) { browserToggle.textContent = browserText; browserToggle.disabled = !state.selected || state.authBusy || pending; }
  if ($('login-dialog').open) $('login-show-page').textContent = browserText;
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
  $('account-hint').textContent = selected ? (state.authenticated ? 'Đang online' : (account?.session === 'saved' ? 'Có phiên đã lưu nhưng đã hết hạn.' : 'Chưa đăng nhập.')) : 'Chọn một MST trong danh sách bên trái.';
  $('auth-dot').classList.toggle('active', !!state.authenticated);
  $('total').textContent = state.total || 0; $('done').textContent = state.done || 0; $('failed').textContent = state.failed || 0;
  $('state').textContent = labels[state.state] || state.state; $('message').textContent = state.message || '';
  $('results-title').textContent = state.mode === 'stream' ? 'Hóa đơn tải thành công' : 'Danh sách hóa đơn';
  const percent = state.total ? Math.round(100 * ((state.done || 0) + (state.failed || 0)) / state.total) : 0;
  $('percentage').textContent = `${percent}%`; $('progress').value = percent;
  // KHÔNG tự điền lại cấu hình của lượt tra cứu CŨ vào form khi mở app: người dùng mở app là thấy
  // form trống như mới. Form chỉ được điền khi (a) người dùng tự chọn, hoặc (b) Auto Sync chủ động
  // đẩy cấu hình đang chạy lên để nhìn cho trực quan (xem window.HD_SHOW_SYNC).
  initialized = true;
  // Không ghi đè lên đường dẫn người dùng đang gõ; chỉ cập nhật khi nơi lưu đổi thật.
  const field = $('output');
  if (document.activeElement !== field && field.value !== (state.output || '')) field.value = state.output || '';
  const table = $('rows');
  const tableRows = document.createDocumentFragment();
  for (const [index, inv] of (state.items || []).entries()) {
    const row = document.createElement('tr');
    row.className = inv.state || ''; // dòng đang tải được tô nổi bật (xem style.css)
    const cell = (text, small) => { const td = document.createElement('td'); td.textContent = text ?? ''; if (small) { const sub = document.createElement('small'); sub.textContent = small; td.append(sub); } row.append(td); return td; };
    const stt = cell(String(index + 1)); stt.className = 'stt';
    cell(inv.number, inv.symbol); cell(inv.name || inv.seller, inv.seller); cell(inv.amount == null ? '—' : amountFormat.format(inv.amount));
    const detail = inv.error ? `${errorLabels[inv.errorType] || ''}${errorLabels[inv.errorType] ? ': ' : ''}${inv.error}` : (inv.warning || '');
    const result = cell(labels[inv.state] || inv.state, detail); result.className = inv.state;
    // Dòng đã có file: bấm vào để mở hóa đơn bằng ứng dụng mặc định của Windows.
    if ((inv.files || []).length) {
      row.classList.add('clickable'); row.tabIndex = 0; row.title = 'Bấm để mở hóa đơn đã tải';
      const open = () => call('/api/open-file', { path: inv.files[0] }).catch(error => noticeFail(error.message));
      row.onclick = open;
      row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); open(); } };
    }
    tableRows.append(row);
  }
  // Gắn một lần thay vì 1.000 lần: cùng cây DOM, cùng thứ tự, chỉ bớt mỗi dòng một lần layout.
  table.replaceChildren(tableRows);
  $('empty').hidden = !!state.total; $('limit').textContent = state.total > 1000 ? 'Hiển thị 1.000 dòng đầu; engine vẫn xử lý toàn bộ.' : '';
  const busy = state.busy || state.authBusy || pending;
  ['choose', 'add-mst', 'mst-login', 'account-login'].forEach(id => { const el = optional(id); if (el) el.disabled = busy; });
  const searching = !!state.busy && state.mode !== 'stream' && state.state === 'searching';
  const downloading = !!state.busy && (state.mode === 'stream' || state.state === 'downloading');
  $('search').textContent = searching ? 'Ngưng tra cứu' : 'Tra cứu';
  $('search').classList.toggle('btn-loading', searching);
  // Nút của tác vụ ĐANG chạy luôn phải BẤM ĐƯỢC để dừng: `pending` = true suốt thời gian request
  // dài đang chờ (server trả lời khi tác vụ kết thúc), nên không được dùng `pending` trần để khoá.
  $('search').disabled = state.authBusy || (!!state.busy && !searching) || (pending && !searching);
  $('stream-download').textContent = downloading ? 'Ngưng tải' : 'Tải ngay';
  $('stream-download').classList.toggle('btn-loading', downloading);
  $('stream-download').disabled = state.authBusy || (!!state.busy && !downloading) || (pending && !downloading);
  // Nút "Xuất Excel theo mẫu MISA" chỉ bật khi đã có kết quả tra cứu; dòng thống kê đọc từ kết quả xử lý.
  $('export-excel').disabled = busy || !state.total || !state.selected;
  const stats = state.stats;
  $('stats').textContent = stats ? `Tổng ${stats.total} · đã có sẵn ${stats.existed} · đưa vào hàng tải ${stats.queued} · đã tải ${stats.downloaded} · bỏ qua ${stats.skipped} · lỗi ${stats.failed}` : '';
  if (browserToggle) browserToggle.disabled = busy || state.authBusy || !state.selected;
  document.querySelectorAll('.filters input:not([readonly]), .filters select').forEach(x => { x.disabled = busy; });
  $('resume').disabled = busy || !state.authenticated || !['paused', 'failed', 'partial', 'auth_required'].includes(state.state);
}
async function refresh() { if (polling) return; polling = true; try { render(await call('/api/state')); } catch (error) { noticeFail(error.message); } finally { polling = false; } await paintSyncPreview(); }

// ---------------------------------------------------------------------------
// AUTO SYNC ĐANG CHẠY — hiện lên tab "Tra cứu & tải" cho trực quan:
//   • điền cấu hình của lượt Auto Sync (khoảng ngày, Mua vào/Bán ra) vào form;
//   • hiện danh sách hoá đơn đang được tra cứu/tải kèm trạng thái từng dòng.
// Chỉ vẽ khi lượt tải THỦ CÔNG không bận — không giành bảng với người dùng đang thao tác.
// Banner trên dòng MST (renderer) vẫn giữ, phần này chi tiết hơn.
let syncPreviewActive = false;
let syncPreviewBusy = false;
let syncPreviewSignature = '';

function clearSyncPreview() {
  if (!syncPreviewActive) return;
  syncPreviewActive = false;
  syncPreviewSignature = '';
  // Buộc render() vẽ lại bảng/labels theo state thật ở nhịp kế tiếp.
  lastRenderedState = null;
}

async function paintSyncPreview() {
  const selected = current.selected || '';
  if (!selected || current.busy || current.authBusy || pending) { clearSyncPreview(); return; }
  if (syncPreviewBusy) return;
  syncPreviewBusy = true;
  try {
    const response = await fetch(`/api/db/autosync/status?mst=${encodeURIComponent(selected)}`);
    const result = await response.json();
    const preview = result && result.ok ? result.value.preview : null;
    if (!preview || !(preview.items || []).length) { clearSyncPreview(); return; }
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
  $('total').textContent = preview.items.length;
  $('done').textContent = preview.items.filter(x => x.state === 'done' || x.state === 'skipped').length;
  $('failed').textContent = preview.items.filter(x => x.state === 'failed').length;
  const percent = preview.items.length ? Math.round(100 * (+$('done').textContent + +$('failed').textContent) / preview.items.length) : 0;
  $('percentage').textContent = `${percent}%`; $('progress').value = percent;

  const signature = JSON.stringify([status.mst, preview.items.map(x => [x.number, x.state]).join()]);
  if (signature === syncPreviewSignature) return;
  syncPreviewSignature = signature;
  syncPreviewActive = true;

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
    const number = cell(inv.number, `${inv.symbol || ''}${params.direction === 'sold' ? ' · Bán ra' : (params.direction === 'purchase' ? ' · Mua vào' : '')}`);
    const seller = cell(inv.name || inv.seller, inv.seller);
    const amount = cell(inv.amount == null ? '—' : amountFormat.format(inv.amount));
    const detail = inv.error ? `${errorLabels[inv.errorType] || ''}${errorLabels[inv.errorType] ? ': ' : ''}${inv.error}` : (inv.warning || '');
    const result = cell(labels[inv.state] || inv.state, detail); result.className = inv.state;
    row.append(stt, number, seller, amount, result);
    fragment.append(row);
  }
  table.replaceChildren(fragment);
  $('empty').hidden = true;
  $('limit').textContent = 'Danh sách này là của lượt Auto Sync đang chạy (không phải lượt tra cứu thủ công).';
}
async function work(url, data) { pending = true; render(current); try { return await call(url, data); } catch (error) { noticeFail(error.message); return null; } finally { pending = false; await refresh(); } }
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
function openLogin(mst = '') {
  invalidateChallenge(); loginError(''); $('login-form').reset();
  $('login-mst').value = mst; $('login-user').value = mst; $('login-remember').checked = true;
  $('login-status').textContent = 'Nhập MST rồi bấm Lấy CAPTCHA. Chrome chỉ dùng khi cần đăng nhập dự phòng.';
  if (mst && mst === current.selected && current.remembered) { $('login-forget').hidden = false; $('login-password').placeholder = 'Đang dùng mật khẩu đã lưu — để trống nếu không đổi'; }
  $('login-dialog').showModal(); $('login-mst').focus(); loginBusy(false);
  if (mst) void prepareLogin();
}
$('add-mst').onclick = () => openMstForm(null);
if (optional('mst-login')) optional('mst-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
if (optional('account-login')) optional('account-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
$('mst-search').oninput = () => renderAccounts(current);
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
  const input = { previous: editingMst, mst: $('mst-code').value.trim(), name: $('mst-name').value.trim(), password: $('mst-password').value, remember: $('mst-remember').checked };
  if (!MstFormat.isValidMst(input.mst)) { $('mst-error').textContent = MstFormat.MST_HINT; $('mst-error').hidden = false; return; }
  const wasEditing = editingMst;
  $('mst-submit').disabled = true;
  try {
    const account = await call('/api/account/save', input);
    $('mst-dialog').close(); $('mst-password').value = ''; $('mst-error').hidden = true; await refresh();
    if (wasEditing) { notice(`Đã cập nhật ${displayName(account)}.`); return; }
    notice(`Đã lưu ${displayName(account)} vào danh sách. Nhập CAPTCHA để đăng nhập.`);
    await chooseMst(account.mst);
  } catch (error) { $('mst-error').textContent = error.message; $('mst-error').hidden = false; }
  finally { $('mst-submit').disabled = false; editingMst = ''; }
};
$('login-close').onclick = () => $('login-dialog').close();
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
  if (!current.selected || !confirm(`Xoá mật khẩu đã lưu của MST ${current.selected}? Phiên đăng nhập hiện tại vẫn giữ.`)) return;
  try {
    await call('/api/account/forget', {});
    $('login-forget').hidden = true; $('login-remember').checked = true;
    $('login-password').placeholder = 'Mật khẩu cổng thuế';
    notice('Đã xoá mật khẩu đã lưu trên máy này.'); await refresh();
  } catch (error) { loginError(error.message); }
};
$('choose').onclick = async () => {
  // Hộp thoại của Windows mở qua PowerShell; nếu vì lý do gì đó không thấy hộp thoại thì gõ thẳng
  // đường dẫn đầy đủ vào ô “Thư mục lưu” rồi bấm ra ngoài ô.
  notice('Đang mở hộp thoại chọn thư mục… Nếu không thấy hộp thoại, gõ hoặc dán đường dẫn đầy đủ vào ô “Thư mục lưu” rồi bấm ra ngoài ô.');
  try {
    const before = current.output || '';
    const folder = await call('/api/folder', {});
    $('output').value = folder || ''; current.output = folder || '';
    if (folder && folder !== before) notice(`Thư mục lưu: ${folder}`);
    else if (!folder) notice('Chưa chọn thư mục lưu — chọn lại, hoặc gõ đường dẫn vào ô “Thư mục lưu”.');
  } catch (error) { noticeFail(error.message); }
};
$('output').onchange = async () => {
  const typed = $('output').value.trim();
  if (!typed || typed === (current.output || '')) return;
  try {
    const folder = await call('/api/folder', { path: typed });
    $('output').value = folder; current.output = folder; notice(`Đã đặt thư mục lưu: ${folder}`); await refresh();
  } catch (error) { noticeFail(error.message); $('output').value = current.output || ''; }
};
async function runLookup(url) {
  // KHÔNG chặn ở đây: `pending` = true suốt thời gian request dài đang chờ (server chỉ trả lời khi
  // tác vụ xong), nên phải xử lý nhánh DỪNG trước rồi mới tới guard pending — nếu không, bấm
  // "Ngưng tải" / "Ngưng tra cứu" bị nuốt im lặng.
  // Lấy trạng thái MỚI NHẤT trước khi quyết định (dữ liệu hiển thị chỉ cập nhật 1,5 giây một lần).
  let state = current;
  try { state = await call('/api/state'); render(state); } catch {}
  const stoppingSearch = url === '/api/search' && state.busy && state.mode !== 'stream' && state.state === 'searching';
  const stoppingDownload = url === '/api/stream' && state.busy && (state.mode === 'stream' || state.state === 'downloading');
  if (stoppingSearch || stoppingDownload) {
    await work('/api/pause', {});
    notice(`Đã ngưng ${stoppingSearch ? 'tra cứu' : 'tải'}. Bấm “Tải tiếp / Thử lại lỗi” để tiếp tục.`, [{ label: 'Tải tiếp', url: '/api/resume', body: {} }]);
    return;
  }
  if (pending) return; // chỉ chặn thao tác MỚI khi đang có request khác
  if (state.busy) return;
  const folder = $('output').value.trim();
  if (!folder) { notice('Chọn thư mục lưu hóa đơn trước khi tra cứu.'); $('output').focus(); return; }
  // Người dùng có thể gõ/dán đường dẫn rồi bấm Tra cứu ngay: lưu lại trước khi chạy.
  if (folder !== (current.output || '')) {
    try { const saved = await call('/api/folder', { path: folder }); $('output').value = saved; current.output = saved; }
    catch (error) { noticeFail(error.message); $('output').focus(); return; }
  }
  // Không hiện toast sau khi tra cứu: kết quả đã nằm trong bảng + dòng trạng thái/tiến độ.
  await work(url, { from: $('from').value, to: $('to').value, direction: $('direction').value, family: $('family').value, status: $('status').value, formats: [...document.querySelectorAll('.formats input:checked')].map(x => x.value), output: folder });
}
$('search').onclick = () => runLookup('/api/search');
$('stream-download').onclick = () => runLookup('/api/stream');
$('resume').onclick = async () => {
  if (!current.total) { notice('Chưa có lượt tải nào để tiếp tục — bấm “Tra cứu hóa đơn” trước.'); return; }
  const result = await work('/api/resume', {});
  if (result) notice(result.message || 'Đã xử lý xong.');
};
$('open').onclick = () => work('/api/open-folder', {});
$('export-excel').onclick = async () => {
  if (!current.total) { notice('Chưa có kết quả tra cứu để xuất Excel. Bấm “Tra cứu hóa đơn” trước.'); return; }
  const result = await work('/api/export-excel', {});
  if (!result) return;
  notice(`Đã xuất Excel theo mẫu MISA: ${result.rows} dòng × ${result.columns} cột — ${result.file}`, [
    { label: 'Mở file Excel', url: '/api/open-file', body: { path: result.file }, keep: true },
    { label: 'Mở thư mục', url: '/api/open-folder', body: {}, keep: true }
  ]);
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
refresh(); setInterval(refresh, 1500);

// ---- Version đang chạy + thông báo bản mới ----
// Chỉ ĐỌC thông tin bản phát hành mới nhất từ server (server gọi GitHub Releases).
// Không tự tải/ghi đè EXE đang chạy — người dùng tự tải bản mới từ GitHub.
async function initVersion() {
  try {
    const response = await fetch('/api/version');
    const data = await response.json();
    const el = document.getElementById('app-version');
    if (data && data.ok && data.value && el) el.textContent = `${data.value.name} v${data.value.version}`;
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
