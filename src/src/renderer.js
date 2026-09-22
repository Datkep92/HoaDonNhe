'use strict';
const $ = id => document.getElementById(id);
const labels = { idle: 'Sẵn sàng', searching: 'Đang tra cứu', downloading: 'Đang tải', paused: 'Tạm dừng', auth_required: 'Cần đăng nhập', ready: 'Sẵn sàng tải', completed: 'Hoàn tất', failed: 'Có lỗi', partial: 'Còn hóa đơn lỗi', queued: 'Chờ tải', running: 'Đang xử lý', skipped: 'Đã có sẵn – bỏ qua', done: 'Đã tải' };
let current = { busy: false, accounts: [] }, pending = false, initialized = false;
let loginId = '', preparedMst = '', loginWorking = false, polling = false;
// "Tải hóa đơn" must never be silently dead: it either runs, or it says exactly what to do next.
function downloadPlan(state) {
  if (pending || state.busy) return { disabled: true, reason: '' };
  if (!state.total) return { disabled: false, reason: state.selected ? 'Chưa có hóa đơn nào trong lượt này — bấm “Tra cứu hóa đơn” trước rồi mới tải.' : 'Chưa chọn MST — bấm “Thêm MST / Đăng nhập” trước.' };
  if (['searching', 'downloading'].includes(state.state)) return { disabled: false, reason: 'Lượt tải đang chạy, số liệu tự cập nhật — xem thanh tiến độ bên dưới.' };
  if (state.state === 'completed') return { disabled: false, reason: `Đã tải xong ${state.done || 0}/${state.total} hóa đơn. Bấm “Tra cứu hóa đơn” nếu muốn chạy lượt mới.` };
  return { disabled: false, reason: '' };
}
async function call(url, body) {
  let response;
  try { response = await fetch(url, { method: url === '/api/state' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('Không kết nối được ứng dụng. Hãy mở lại HoaDonNhe-v4.exe.'); }
  const result = await response.json(); if (!result.ok) throw new Error(result.error); return result.value;
}
// Thông báo ở góc phải; có thể kèm nút hành động bấm được (ví dụ “Mở file”, “Mở thư mục”).
function notice(text, actions) {
  const box = $('notice');
  box.replaceChildren();
  const span = document.createElement('span'); span.textContent = text; box.append(span);
  for (const action of actions || []) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'link'; button.textContent = action.label;
    button.onclick = async () => {
      try { await call(action.url, action.body || {}); if (action.keep !== true) box.hidden = true; }
      catch (error) { notice(error.message); }
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
const SESSION_LABEL = { live: 'Đang dùng phiên đăng nhập của phiên làm việc này', saved: 'Còn phiên đã lưu — bấm để vào tra cứu', none: 'Chưa đăng nhập — bấm để đăng nhập' };
const displayName = account => account.name || account.label || account.mst;
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
    item('Sửa MST', () => openMstForm(account)),
    item('Xoá mật khẩu đã lưu', () => forgetPassword(account)),
    item('Bỏ khỏi danh sách', () => removeMst(account), true)
  );
  row.append(panel);
}
// Bấm một dòng: còn phiên đã lưu thì vào thẳng giao diện chính, hết phiên thì mở form đăng nhập.
async function chooseMst(mst) {
  closeRowMenus();
  if (pending || current.busy) return;
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
  } catch (error) { notice(error.message); }
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
function renderAccounts(state) {
  const list = $('mst-items'); const query = $('mst-search').value.trim().toLowerCase();
  const all = state.accounts || [];
  const shown = query ? all.filter(x => `${displayName(x)} ${x.mst}`.toLowerCase().includes(query)) : all;
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
    sub.textContent = `${account.mst}${account.remembered ? ' · đã lưu mật khẩu' : ''}${account.job ? ` · ${account.job.total} hóa đơn` : ''}`;
    info.append(title, sub);
    const menu = document.createElement('button');
    menu.type = 'button'; menu.className = 'row-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', `Tuỳ chọn cho ${account.mst}`);
    menu.onclick = event => { event.stopPropagation(); openRowMenu(row, account); };
    row.append(dot, info, menu);
    row.onclick = () => chooseMst(account.mst);
    row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMst(account.mst); } };
    list.append(row);
  }
}
function render(state) {
  current = state; renderAccounts(state);
  const browserText = state.browserVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
  // Chrome tự đóng sau khi tải xong, nên nút này không còn phụ thuộc browserReady: chưa có cửa sổ
  // thì bấm vào sẽ mở lại (xem onclick), giống nút trong bảng đăng nhập.
  $('browser-toggle').textContent = browserText; $('browser-toggle').disabled = !state.selected || state.authBusy || pending;
  if ($('login-dialog').open) $('login-show-page').textContent = browserText;
  const selected = state.selected || '';
  const account = (state.accounts || []).find(x => x.mst === selected);
  $('account').textContent = selected ? `${displayName(account || { mst: selected })} · ${selected}` : 'Chưa chọn MST';
  $('account-hint').textContent = selected ? (state.authenticated ? 'Đang dùng phiên còn hiệu lực — sẵn sàng tra cứu.' : (account?.session === 'saved' ? 'Có phiên đã lưu nhưng đã hết hạn — bấm để đăng nhập lại.' : 'Chưa đăng nhập — bấm “Đăng nhập MST này”.')) : 'Chọn một MST trong danh sách bên trái.';
  $('auth-dot').classList.toggle('active', !!state.authenticated);
  $('total').textContent = state.total || 0; $('done').textContent = state.done || 0; $('failed').textContent = state.failed || 0;
  $('state').textContent = labels[state.state] || state.state; $('message').textContent = state.message || '';
  const percent = state.total ? Math.round(100 * ((state.done || 0) + (state.failed || 0)) / state.total) : 0;
  $('percentage').textContent = `${percent}%`; $('progress').value = percent;
  if (!initialized && state.params) {
    for (const key of ['from', 'to', 'direction', 'family', 'status']) $(key).value = state.params[key] || '';
    document.querySelectorAll('.formats input').forEach(x => { x.checked = state.params.formats.includes(x.value); });
    syncPeriodOptions(); // ô Năm/Tháng/Quý khớp khoảng ngày của lượt tải đang mở
  }
  initialized = true;
  // Không ghi đè lên đường dẫn người dùng đang gõ; chỉ cập nhật khi nơi lưu đổi thật.
  const field = $('output');
  if (document.activeElement !== field && field.value !== (state.output || '')) field.value = state.output || '';
  $('rows').replaceChildren();
  for (const [index, inv] of (state.items || []).entries()) {
    const row = document.createElement('tr');
    row.className = inv.state || ''; // dòng đang tải được tô nổi bật (xem style.css)
    const cell = (text, small) => { const td = document.createElement('td'); td.textContent = text ?? ''; if (small) { const sub = document.createElement('small'); sub.textContent = small; td.append(sub); } row.append(td); return td; };
    const stt = cell(String(index + 1)); stt.className = 'stt';
    cell(inv.number, inv.symbol); cell(inv.name || inv.seller, inv.seller); cell(inv.amount == null ? '—' : new Intl.NumberFormat('vi-VN').format(inv.amount));
    const result = cell(labels[inv.state] || inv.state, inv.error); result.className = inv.state;
    // Dòng đã có file: bấm vào để mở hóa đơn bằng ứng dụng mặc định của Windows.
    if ((inv.files || []).length) {
      row.classList.add('clickable'); row.tabIndex = 0; row.title = 'Bấm để mở hóa đơn đã tải';
      const open = () => call('/api/open-file', { path: inv.files[0] }).catch(error => notice(error.message));
      row.onclick = open;
      row.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); open(); } };
    }
    $('rows').append(row);
  }
  $('empty').hidden = !!state.total; $('limit').textContent = state.total > 1000 ? 'Hiển thị 1.000 dòng đầu; engine vẫn xử lý toàn bộ.' : '';
  const busy = state.busy || state.authBusy || pending;
  ['choose', 'add-mst', 'mst-login', 'account-login'].forEach(id => { $(id).disabled = busy; });
  // Nút Tra cứu: khi đang tra cứu thì đổi thành "Tạm dừng tra cứu" (cùng logic với nút Tạm dừng).
  const searching = !!state.busy && state.state === 'searching';
  const downloading = !!state.busy && state.state === 'downloading';
  $('search').textContent = searching ? 'Tạm dừng tra cứu' : 'Tra cứu hóa đơn';
  $('search').classList.toggle('btn-loading', searching);
  $('search').disabled = state.authBusy || pending || (state.busy && !searching);
  $('download').classList.toggle('btn-loading', downloading);
  $('resume').classList.toggle('btn-loading', downloading);
  // Nút "Xuất Excel theo mẫu MISA" chỉ bật khi đã có kết quả tra cứu; dòng thống kê đọc từ kết quả xử lý.
  $('export-excel').disabled = busy || !state.total || !state.selected;
  const stats = state.stats;
  $('stats').textContent = stats ? `Tổng ${stats.total} · đã có sẵn ${stats.existed} · đưa vào hàng tải ${stats.queued} · đã tải ${stats.downloaded} · bỏ qua ${stats.skipped} · lỗi ${stats.failed}` : '';
  $('browser-toggle').disabled = busy || state.authBusy || !state.selected;
  document.querySelectorAll('.filters input:not([readonly]), .filters select').forEach(x => { x.disabled = busy; });
  $('pause').disabled = !state.busy; const plan = downloadPlan(state);
  $('download').disabled = plan.disabled; $('download').title = plan.reason || 'Tải toàn bộ hóa đơn của lượt tra cứu này';
  $('resume').disabled = busy || !['paused', 'failed', 'partial', 'auth_required'].includes(state.state);
}
async function refresh() { if (polling) return; polling = true; try { render(await call('/api/state')); } catch (error) { notice(error.message); } finally { polling = false; } }
async function work(url, data) { pending = true; render(current); try { return await call(url, data); } catch (error) { notice(error.message); return null; } finally { pending = false; await refresh(); } }
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
  if (!/^(\d{10}(?:-\d{3})?|\d{13})$/.test(mst)) { loginError('Nhập MST hợp lệ trước khi lấy CAPTCHA.'); return; }
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
$('mst-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
$('account-login').onclick = () => { if (current.selected) openLogin(current.selected); else notice('Chọn một MST trong danh sách trước.'); };
$('mst-search').oninput = () => renderAccounts(current);
$('mst-close').onclick = () => $('mst-dialog').close();
$('mst-cancel').onclick = () => $('mst-dialog').close();
document.addEventListener('click', event => { if (!event.target.closest('.mst-row')) closeRowMenus(); });
$('mst-form').onsubmit = async event => {
  event.preventDefault();
  const input = { previous: editingMst, mst: $('mst-code').value.trim(), name: $('mst-name').value.trim(), password: $('mst-password').value, remember: $('mst-remember').checked };
  if (!/^(\d{10}(?:-\d{3})?|\d{13})$/.test(input.mst)) { $('mst-error').textContent = 'MST phải gồm 10, 13 số hoặc dạng 10 số-3 số.'; $('mst-error').hidden = false; return; }
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
  try {
    const wantVisible = !current.browserVisible;
    if (!current.browserReady) await call('/api/account/show', { mst: $('login-mst').value.trim() });
    else await call('/api/account/visibility', { visible: wantVisible });
    $('login-show-page').textContent = wantVisible ? 'Ẩn Chrome đăng nhập' : 'Hiện Chrome đăng nhập';
    $('login-status').textContent = wantVisible ? 'Chrome đăng nhập đang hiển thị.' : 'Chrome đăng nhập đang chạy ẩn.';
    await refresh();
  }
  catch (error) { loginError(error.message); }
};
$('browser-toggle').onclick = async () => {
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
  } catch (error) { notice(error.message); }
};
$('output').onchange = async () => {
  const typed = $('output').value.trim();
  if (!typed || typed === (current.output || '')) return;
  try {
    const folder = await call('/api/folder', { path: typed });
    $('output').value = folder; current.output = folder; notice(`Đã đặt thư mục lưu: ${folder}`); await refresh();
  } catch (error) { notice(error.message); $('output').value = current.output || ''; }
};
$('search').onclick = async () => {
  if (pending) return;
  // Lấy trạng thái MỚI NHẤT trước khi quyết định (dữ liệu hiển thị chỉ cập nhật 1,5 giây một lần).
  let state = current;
  try { state = await call('/api/state'); render(state); } catch {}
  // Đang tra cứu: nút này hoạt động như nút Tạm dừng (cùng gọi /api/pause).
  if (state.busy && state.state === 'searching') {
    await work('/api/pause', {});
    notice('Đã tạm dừng tra cứu. Bấm “Tải tiếp / Thử lại lỗi” để chạy tiếp phần còn lại.', [{ label: 'Tải tiếp', url: '/api/resume', body: {} }]);
    return;
  }
  if (state.busy) { notice('Đang có tác vụ chạy — bấm “Tạm dừng” nếu muốn dừng.'); return; }
  const folder = $('output').value.trim();
  if (!folder) { notice('Chọn thư mục lưu hóa đơn trước khi tra cứu.'); $('output').focus(); return; }
  // Người dùng có thể gõ/dán đường dẫn rồi bấm Tra cứu ngay: lưu lại trước khi chạy.
  if (folder !== (current.output || '')) {
    try { const saved = await call('/api/folder', { path: folder }); $('output').value = saved; current.output = saved; }
    catch (error) { notice(error.message); $('output').focus(); return; }
  }
  // Không hiện toast sau khi tra cứu: kết quả đã nằm trong bảng + dòng trạng thái/tiến độ.
  await work('/api/search', { from: $('from').value, to: $('to').value, direction: $('direction').value, family: $('family').value, status: $('status').value, formats: [...document.querySelectorAll('.formats input:checked')].map(x => x.value), output: folder });
};
$('download').onclick = async () => {
  const plan = downloadPlan(current);
  if (plan.disabled) return;
  if (plan.reason) { notice(plan.reason); return; }
  const result = await work('/api/download', {});
  if (result) notice(result.message || 'Đã xử lý xong.');
};
$('resume').onclick = async () => {
  if (!current.total) { notice('Chưa có lượt tải nào để tiếp tục — bấm “Tra cứu hóa đơn” trước.'); return; }
  const result = await work('/api/resume', {});
  if (result) notice(result.message || 'Đã xử lý xong.');
};
$('pause').onclick = () => work('/api/pause', {}); $('open').onclick = () => work('/api/open-folder', {});
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
  } catch (error) { notice(error.message); }
}
['period-mode', 'period-year', 'period-month', 'period-quarter'].forEach(id => { $(id).onchange = applyPeriod; });
syncPeriodOptions();
refresh(); setInterval(refresh, 1500);
