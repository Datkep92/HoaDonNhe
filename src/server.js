'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { URL } = require('node:url');
const { Engine, atomicWrite } = require('./core');
const { TaxBrowser, browserPath, jwtAccount } = require('./browser');
const tct = require('./tct-api');
const XLSX = require('../resources/xlsx.cjs');
const { ensureFolder } = require('./folders');
const { SupportStore } = require('./support');
const { AppLockStore } = require('./app-lock');
const VERSION = require('./version');
const { checkUpdate } = require('./update-check');
const { Updater, applySelfUpdate, cleanupUpdateTemp } = require('./updater');

// ---------------------------------------------------------------------------
// SELF-UPDATE: bản MỚI được khởi động với `--apply-update` để thay chính file đang chạy
// rồi mở lại. Phải xử lý TRƯỚC khi chạm tới dữ liệu người dùng (du_lieu, secrets, Chrome…).
// ---------------------------------------------------------------------------
if (process.argv.includes('--apply-update')) {
  const logFile = path.join(path.dirname(process.execPath), 'du_lieu', 'nhat-ky.log');
  applySelfUpdate(process.argv, {
    log: message => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toLocaleString('vi-VN')}] ${message}\r\n`); } catch { /* bỏ */ } },
  }).then(result => {
    if (result && !result.ok) {
      const text = `Cập nhật thất bại: ${result.error}${result.restored ? ' (đã khôi phục bản cũ)' : ''}`;
      try { fs.appendFileSync(logFile, `[${new Date().toLocaleString('vi-VN')}] ${text}\r\n`); } catch { /* bỏ */ }
      try {
        const quoted = `'${text.replace(/'/g, "''")}'`;
        execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${quoted}, 'Hoa Don Desktop', 'OK', 'Warning') | Out-Null`], { windowsHide: true }, () => {});
      } catch { /* bỏ */ }
      setTimeout(() => process.exit(1), 2000);
    } else {
      process.exit(0);
    }
  }).catch(() => process.exit(1));
  return; // không chạy tiếp phần khởi động ứng dụng
}

const packed = !!process.pkg;
const appDir = packed ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const testServer = process.argv.includes('--test-server');
const dataDir = testServer && process.env.HOADON_TEST_DATA ? path.resolve(process.env.HOADON_TEST_DATA) : path.join(appDir, 'du_lieu');
const sessionSecret = crypto.randomBytes(32).toString('hex');
const browser = new TaxBrowser(dataDir);
const secrets = require('./secrets').init(dataDir);
const accountsFile = path.join(dataDir, 'accounts.json');
const support = new SupportStore(dataDir);
const appLock = new AppLockStore(dataDir, support);
// EXE chạy không có cửa sổ console, nên thông báo khởi động và lỗi được ghi vào
// du_lieu/nhat-ky.log; lỗi nghiêm trọng thì hiện thêm hộp thoại để người dùng biết.
const logFile = path.join(dataDir, 'nhat-ky.log');
function log(message) {
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toLocaleString('vi-VN')}] ${message}\r\n`); } catch {}
}
function reportFatal(message) {
  log(`LỖI: ${message}`);
  try {
    const quoted = `'${String(message).replace(/'/g, "''")}'`;
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${quoted}, 'Hoa Don Desktop', 'OK', 'Error') | Out-Null`], { windowsHide: true }, () => {});
  } catch {}
}
// EXE chạy ở chế độ GUI nên không có console: lỗi lúc khởi động trước đây không hiện ra đâu cả.
// Ghi vào du_lieu/nhat-ky.log rồi hiện hộp thoại để không còn cảnh "bấm EXE mà không thấy gì".
process.on('uncaughtException', error => {
  reportFatal(error && error.message ? error.message : String(error));
  setTimeout(() => process.exit(1), 1500); // chờ hộp thoại kịp hiện
});
// register() trả Promise khi đã cấu hình Gateway, nhưng trả object ngay khi chạy local mock
// (chưa có du_lieu/support-gateway.json — xem SUPPORT_SETUP.md mục 4). Bọc Promise.resolve để
// không chết ở bước khởi động như bản v12.
Promise.resolve(support.register()).catch(() => {}).then(() => ensureSupportStream());
// Bộ cập nhật: kiểm tra bản mới khi mở app (một lần), tải + xác minh SHA-256 + chạy bộ cài
// CHỈ khi người dùng bấm xác nhận. Không bao giờ tự cài.
const updater = new Updater({
  version: VERSION.version,
  execPath: process.execPath,
  localAppData: process.env.LOCALAPPDATA,
  checkUpdate,
});
// Kiểm tra bản mới MỘT LẦN khi mở app (không polling). Tắt bằng HOADON_NO_UPDATE_CHECK=1.
// HOADON_FORCE_UPDATE_CHECK=1 để bật cả khi chạy --test-server (dùng cho test tự động).
const updateCheckEnabled = process.env.HOADON_NO_UPDATE_CHECK !== '1'
  && (!testServer || process.env.HOADON_FORCE_UPDATE_CHECK === '1');
if (updateCheckEnabled) updater.check().catch(() => {});
// Dọn thư mục tạm của lần tự cập nhật trước (file đang bị khoá sẽ được dọn ở lần mở sau).
cleanupUpdateTemp();
let lastUiPoll = 0;
let accounts = loadJson(accountsFile, { accounts: [], selected: '' });
let engine = null;
let selected = accounts.selected || '';
let output = accounts.output || ''; // người dùng chọn; không tự đặt mặc định ngầm
let uiProcess = null;
let authBusy = false;
let loginChallenge = null;
let authAccount = null;
const directTokens = new Map();

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveAccounts() { atomicWrite(accountsFile, JSON.stringify(accounts, null, 2)); }
function safeMst(mst) { return /^\d+$/.test(String(mst)); }
function jobStore(mst) { return path.join(dataDir, 'jobs', `${mst}.json`); }
function makeExcel(items) {
  const rows = items.map(({ invoice: i, state, error }) => ({ 'Số hóa đơn': String(i.shdon ?? ''), 'Ký hiệu': String(i.khhdon ?? ''), 'Mẫu số': String(i.khmshdon ?? ''), 'Ngày lập': String(i.tdlap ?? ''), 'MST người bán': String(i.nbmst ?? ''), 'Người bán': String(i.nbten ?? ''), 'MST người mua': String(i.nmmst ?? ''), 'Người mua': String(i.nmten ?? ''), 'Tiền trước thuế': i.tgtcthue, 'Tiền thuế': i.tgtthue, 'Tổng tiền': i.tgtttbso, 'Trạng thái tải': state, 'Lỗi': error || '' }));
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.json_to_sheet(rows);
  sheet['!cols'] = [16, 16, 12, 24, 20, 40, 20, 40, 20, 20, 20, 18, 50].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(book, sheet, 'Hoa don'); return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
function accountFor(mst) { return accounts.accounts.find(x => x.mst === mst) || null; }
// Saved portal session per MST (token + cookies + remembered password), kept on this machine
// only. This is what makes the next run "already logged in" like VNIT instead of asking for the
// CAPTCHA again. The password is only read when the login form leaves it empty.
const remembered = new Map();
// Đã tự chạy tiếp cho lượt nào rồi (khoá theo MST + id lượt) — tránh chạy lặp khi chọn lại MST.
const autoResumed = new Set();
function isRemembered(mst) {
  if (!remembered.has(mst)) remembered.set(mst, !!secrets.read(mst, ['password']).password);
  return remembered.get(mst);
}
function restoreSession(mst) {
  if (directTokens.has(mst)) return true;
  const stored = secrets.read(mst, ['token', 'cookies']);
  if (stored.cookies) tct.setCookies(stored.cookies);
  const account = jwtAccount(stored.token);
  if (!account) { if (stored.token) secrets.clear(mst, ['token']); return false; }
  if (!account.mst && /^(\d{10}(?:-\d{3})?|\d{13})$/.test(account.label)) account.mst = account.label;
  if (account.mst && account.mst !== mst) { secrets.clear(mst, ['token']); return false; }
  directTokens.set(mst, stored.token); authAccount = account;
  autoResumeIfNeeded(mst);
  return true;
}
function storeSession(mst, token, password, keep) {
  if (!token) { secrets.clear(mst, ['token', 'cookies']); sessionCache.set(mst, false); return; }
  secrets.write(mst, { token, cookies: tct.cookies(), ...(password ? { password: keep ? password : '' } : {}) });
  remembered.set(mst, !!keep && !!password); sessionCache.set(mst, true);
}
function forgetSession(mst) {
  directTokens.delete(mst); tct.clearCookies(); secrets.clear(mst, ['token', 'cookies']);
  sessionCache.set(mst, false); if (selected === mst) authAccount = null;
}
// "Quên mật khẩu đã lưu": drop the remembered password; with `session` also drop the saved
// session so the next login asks for the CAPTCHA again.
function forgetSecret(input) {
  if (!selected) throw new Error('Chọn MST trước.');
  secrets.clear(selected, ['password']); remembered.set(selected, false);
  if (input?.session) forgetSession(selected);
  return { mst: selected, remembered: false, session: directTokens.has(selected) };
}
// ---- Danh sách nhiều MST: trạng thái từng dòng, sửa MST, lưu vào danh sách ----
// Sidebar rows show "live" (đang đăng nhập trong phiên này), "saved" (có phiên đã lưu trên máy)
// or "none", plus the invoice count of that MST's last run.
const sessionCache = new Map();
function hasSavedSession(mst) {
  if (directTokens.has(mst)) return true;
  if (!sessionCache.has(mst)) sessionCache.set(mst, !!secrets.read(mst, ['token']).token);
  return sessionCache.get(mst);
}
const jobCache = new Map();
function jobSummary(mst) {
  const file = jobStore(mst);
  let stamp = 0;
  try { stamp = fs.statSync(file).mtimeMs; } catch { jobCache.delete(mst); return null; }
  const cached = jobCache.get(mst); if (cached && cached.stamp === stamp) return cached.value;
  let value = null;
  try {
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    value = { state: job.state, total: job.items.length, done: job.items.filter(x => x.state === 'done').length, failed: job.items.filter(x => x.state === 'failed').length };
  } catch {}
  jobCache.set(mst, { stamp, value }); return value;
}
function publicAccount(account) {
  const mst = account.mst;
  return { mst, name: account.name || '', label: account.label || '', lastVerifiedAt: account.lastVerifiedAt || 0, session: directTokens.has(mst) ? 'live' : (hasSavedSession(mst) ? 'saved' : 'none'), remembered: isRemembered(mst), job: jobSummary(mst) };
}
function migrateMst(from, to) {
  const move = (a, b) => { try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch (error) { throw new Error(`Không đổi được MST ${from} → ${to}: ${error.message}. Đóng cửa sổ Chrome của MST này rồi thử lại.`); } };
  move(jobStore(from), jobStore(to));
  move(path.join(dataDir, 'secrets', `${from}.json`), path.join(dataDir, 'secrets', `${to}.json`));
  move(path.join(dataDir, 'profiles', from), path.join(dataDir, 'profiles', to));
  for (const cache of [sessionCache, jobCache, remembered]) { cache.delete(from); cache.delete(to); }
  directTokens.delete(from);
  if (selected === from) { selected = to; engine = null; }
}
// Thêm MST hoặc sửa MST đã có (đổi tên khách / đổi MST / đổi mật khẩu đã lưu) - luôn ghi vào danh sách.
function saveAccount(input) {
  ensureIdle();
  const previous = String(input.previous || '').trim();
  const mst = String(input.mst || '').trim();
  const name = String(input.name || '').trim().slice(0, 120);
  if (!safeMst(mst)) throw new Error('MST chỉ được gồm chữ số.');
  if (previous && !accountFor(previous)) throw new Error('MST cần sửa không còn trong danh sách.');
  if (mst !== previous && accountFor(mst)) throw new Error(`MST ${mst} đã có trong danh sách.`);
  if (previous && mst !== previous) migrateMst(previous, mst);
  const record = accountFor(mst) || accountFor(previous);
  if (record) { record.mst = mst; record.name = name; if (!record.label || record.label === previous) record.label = mst; }
  else accounts.accounts.push({ mst, name, label: mst, lastVerifiedAt: 0 });
  if (input.remember === false) { secrets.clear(mst, ['password']); remembered.set(mst, false); }
  else if (typeof input.password === 'string' && input.password) { secrets.write(mst, { password: input.password }); remembered.set(mst, true); }
  accounts.selected = selected; saveAccounts();
  return publicAccount(accountFor(mst));
}
// Tự chạy tiếp lượt tra cứu/tải bị NGẮT khi app được mở lại — chỉ khi đã có phiên đăng nhập thẳng
// (không mở cửa sổ Chrome ngoài ý muốn) và mỗi lượt chỉ tự chạy một lần.
function autoResumeIfNeeded(mst) {
  if (!engine || !engine.interrupted || engine.mst !== mst) return;
  const key = `${mst}|${(engine.job && engine.job.id) || ''}`;
  if (!directTokens.has(mst) || autoResumed.has(key)) return;
  autoResumed.add(key);
  log(`Tự chạy tiếp lượt ${engine.job.phase === 'search' ? 'tra cứu' : 'tải'} còn dở của MST ${mst}…`);
  engine.autoResume().catch(error => log('Không tự chạy tiếp được: ' + (error && error.message ? error.message : error)));
}
function createEngine(mst) {
  engine = new Engine({
    store: jobStore(mst),
    // A stale token must not be reused: drop the saved session so the UI asks for a fresh login.
    request: async (route, action, check) => {
      check(); const token = directTokens.get(mst);
      if (!token) return browser.request(route, action, check);
      try { return await tct.request(token, route, action); }
      catch (error) { if (error.auth) forgetSession(mst); throw error; }
    },
    identity: () => directTokens.has(mst) ? authAccount : browser.verify(mst),
    // Xuất PDF cần một cửa sổ Chrome điều khiển được. Khi tải bằng phiên đăng nhập thẳng (không mở
    // trình duyệt), tự mở Chrome ẩn rồi dùng lại cho các hóa đơn PDF tiếp theo.
    pdf: async html => {
      if (!browser.client) await browser.open(mst, false);
      return browser.pdf(html);
    },
    excel: makeExcel,
    emit: () => {}
  });
  engine.mst = mst;
  autoResumeIfNeeded(mst);
  // "Thư mục lưu" là một thiết lập chung cho mọi MST: không đổi theo lượt tải của từng MST.
}
// Mọi lượt tải ghi vào thư mục lưu chung. Chỉ khi người dùng chưa chọn thư mục chung thì mới dùng
// thư mục ghi trong lượt tải cũ, để không mất dữ liệu đang dở.
async function applyOutput() {
  if (!engine || !engine.job) return;
  if (path.isAbsolute(output)) engine.job.output = output;
  else if (path.isAbsolute(engine.job.output || '')) output = engine.job.output;
  else throw new Error('Chọn thư mục lưu hóa đơn trước khi tải.');
  await ensureFolder(output); // ổ gốc / ổ chỉ đọc bị chặn ngay, không để lỗi EPERM giữa lúc tải
}
// Cửa sổ Chrome điều khiển cổng thuế chỉ cần trong lúc tra cứu/tải (và lúc xuất PDF). Tải xong thì
// đóng lại cho gọn, không để cửa sổ nằm lại cho người dùng phải tự tắt.
// Chỉ đóng khi MST đang chọn có token trực tiếp (phiên đã lưu trong du_lieu/secrets): khi đó mọi
// request đi bằng Node nên cửa sổ Chrome không giữ phiên. Nếu phiên chỉ nằm trong chính cửa sổ đó
// (đăng nhập bằng trang thuế, chưa lưu token) thì giữ nguyên, đóng đi là mất đăng nhập.
async function closeBrowserWhenIdle(reason) {
  if (!browser.client) return;
  if (authBusy || loginChallenge || engine?.busy) return;   // đang đăng nhập/CAPTCHA hoặc còn tác vụ
  if (!selected || !directTokens.has(selected)) return;
  const mst = selected;
  await browser.close();
  log(`Đã đóng cửa sổ Chrome tải hóa đơn của MST ${mst} (${reason}).`);
}
// ---- Support Chat realtime ------------------------------------------------------------------
// Giao diện nối tới /api/support/events (SSE nội bộ). Server giữ MỘT kết nối tới Gateway
// (/v1/chats/stream) và chỉ chuyển tiếp khi Firebase báo thay đổi — KHÔNG hỏi định kỳ.
// Timer duy nhất ở đây là hẹn nối lại khi luồng đứt, backoff tăng dần 5s -> 300s.
const supportClients = new Set();
let supportStreamController = null;
let supportStreamRetryTimer = null;
let supportStreamRetryAt = 0;
let supportStreamBackoff = 5000;
let supportRealtimeReady = false;
let lastSupportMessages = null;
function supportEvent(payload) { return `data: ${JSON.stringify(payload)}\n\n`; }
function broadcastSupport(payload) {
  const frame = supportEvent(payload);
  for (const res of supportClients) { try { res.write(frame); } catch { /* cửa sổ đã đóng */ } }
}
function setSupportRealtime(ready) {
  if (supportRealtimeReady === ready) return;
  supportRealtimeReady = ready;
  broadcastSupport({ type: 'mode', realtime: ready });
}
function scheduleSupportStream() {
  if (supportStreamRetryTimer || !supportClients.size) return;
  const wait = Math.max(supportStreamRetryAt - Date.now(), 1000);
  supportStreamRetryTimer = setTimeout(() => { supportStreamRetryTimer = null; ensureSupportStream(); }, wait);
  if (supportStreamRetryTimer.unref) supportStreamRetryTimer.unref();
}
function ensureSupportStream() {
  if (supportStreamController || !supportClients.size) return; // không có cửa sổ nào nghe thì không mở
  if (Date.now() < supportStreamRetryAt) return scheduleSupportStream();
  if (!support.streamRequest()) {
    // Có Gateway nhưng chưa có token phiên (đang đăng ký) -> thử lại sau; không có Gateway thì đứng yên.
    if (support.snapshot().mode === 'gateway') { supportStreamRetryAt = Date.now() + 15000; return scheduleSupportStream(); }
    return;
  }
  const controller = new AbortController();
  supportStreamController = controller;
  let openedAt = 0;
  support.watchMessages(
    messages => { lastSupportMessages = messages; broadcastSupport({ type: 'messages', messages }); },
    { signal: controller.signal, onOpen: () => { openedAt = Date.now(); setSupportRealtime(true); log('Đã nối luồng chat realtime tới Gateway.'); } },
  ).then(result => finishSupportStream(controller, result, openedAt)).catch(error => finishSupportStream(controller, { ok: false, reason: error.message }, openedAt));
}
// Kết thúc một kết nối: luồng sống đủ lâu (>= 30s) thì nối lại nhanh (2s); đóng sớm hoặc lỗi thì
// backoff tăng dần 5s -> 10s -> 20s… tối đa 300s, tránh vòng lặp nối lại liên tục khi upstream flapping.
const SUPPORT_STREAM_STABLE_MS = 30000;
function finishSupportStream(controller, result, openedAt) {
  if (supportStreamController !== controller) return; // đã có luồng mới thay thế
  supportStreamController = null;
  setSupportRealtime(false);
  const stable = !!(result && result.ok) && openedAt > 0 && (Date.now() - openedAt) >= SUPPORT_STREAM_STABLE_MS;
  const delay = stable ? 2000 : supportStreamBackoff;
  supportStreamBackoff = stable ? 5000 : Math.min(supportStreamBackoff * 2, 300000);
  supportStreamRetryAt = Date.now() + delay;
  log(`Luồng chat dừng (${(result && result.reason) || 'không rõ'}) — thử lại sau ${Math.round(delay / 1000)}s.`);
  scheduleSupportStream();
}
function stopSupportStream() {
  if (supportStreamRetryTimer) { clearTimeout(supportStreamRetryTimer); supportStreamRetryTimer = null; }
  const controller = supportStreamController;
  supportStreamController = null;
  if (controller) controller.abort();
}
function appState() {
  const snapshot = engine ? engine.snapshot() : { state: 'idle', busy: false, items: [], total: 0, done: 0, failed: 0, message: 'Chọn hoặc thêm MST để bắt đầu.' };
  return { ...snapshot, accounts: accounts.accounts.map(publicAccount), selected, output, remembered: !!selected && isRemembered(selected), browserReady: !!browser.client, browserVisible: !!browser.visible, authenticated: !!authAccount, authBusy, update: updater.status() };
}
function ensureIdle() { if (engine?.busy) throw new Error('Tạm dừng tác vụ tải trước khi thay đổi phiên đăng nhập.'); }
async function ensureLicenseAllowed() { return support.enforceLicense(); }
async function authOperation(fn) {
  ensureIdle(); if (authBusy) throw new Error('Đang xử lý phiên đăng nhập. Vui lòng chờ.');
  authBusy = true; try { return await fn(); } finally { authBusy = false; }
}
function challengeResponse(value) {
  const loginId = crypto.randomBytes(16).toString('hex');
  loginChallenge = value.ready ? { mst: selected, loginId, captcha: value.captcha, key: value.key || '' } : null;
  return { ...value, mst: selected, loginId: value.ready ? loginId : '' };
}
// Click một dòng trong danh sách: còn phiên đã lưu thì vào thẳng giao diện chính để tra cứu,
// hết phiên thì giao diện tự mở form đăng nhập (xem renderer.js). Không tự mở Chrome.
async function selectAccount(mst) {
  if (!safeMst(mst) || !accountFor(mst)) throw new Error('MST chưa có trong danh sách.');
  ensureIdle(); loginChallenge = null; authAccount = null;
  restoreSession(mst);
  selected = mst; accounts.selected = mst; saveAccounts(); createEngine(mst);
  const account = await checkLogin();
  return { mst, authenticated: !!account, account, name: accountFor(mst)?.name || '' };
}
async function addOrLogin(mst) {
  if (!safeMst(mst)) throw new Error('Nhập MST chỉ gồm chữ số.');
  ensureIdle(); loginChallenge = null; authAccount = null;
  if (!engine || selected !== mst) createEngine(mst);
  selected = mst;
  const saved = isRemembered(mst);
  if (restoreSession(mst)) return { authenticated: true, ready: false, direct: true, error: '', remembered: saved, account: await checkLogin() };
  const value = await tct.captcha();
  return challengeResponse({ ...value, ready: true, authenticated: false, direct: true, remembered: saved, error: '' });
}
async function checkLogin() {
  if (!selected) throw new Error('Chọn hoặc thêm MST trước.');
  const token = directTokens.get(selected) || (restoreSession(selected) ? directTokens.get(selected) : '');
  const identity = token ? (jwtAccount(token) || authAccount) : await browser.verify(selected);
  authAccount = identity;
  if (!identity) return null;
  const current = accountFor(selected);
  const record = { mst: selected, name: current?.name || '', label: identity.label || selected, lastVerifiedAt: Date.now() };
  if (current) Object.assign(current, record); else accounts.accounts.push(record);
  accounts.selected = selected; saveAccounts(); if (!engine) createEngine(selected); return record;
}
async function submitLogin(input) {
  const challenge = loginChallenge;
  if (!challenge || input.loginId !== challenge.loginId || input.mst !== selected || challenge.mst !== selected) throw new Error('Phiên CAPTCHA không còn hợp lệ. Bấm Lấy CAPTCHA lại.');
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 120 || typeof input.captcha !== 'string' || !/^[a-z0-9]{1,10}$/i.test(input.captcha.trim())) throw new Error('Nhập tên đăng nhập và mã CAPTCHA trong ảnh.');
  // A saved password is used when the field is left empty (same idea as VNIT's remembered password).
  const password = (typeof input.password === 'string' ? input.password : '') || secrets.read(selected, ['password']).password;
  if (!password) throw new Error('Nhập mật khẩu — MST này chưa lưu mật khẩu.');
  const keep = input.remember !== false;
  const remember = () => { secrets.write(selected, { password: keep ? password : '' }); remembered.set(selected, keep && !!password); };
  loginChallenge = null;
  if (challenge.key) {
    try {
      const token = await tct.authenticate({ username: input.username.trim(), password, captcha: input.captcha.trim().toUpperCase(), ckey: challenge.key });
      const identity = jwtAccount(token);
      if (identity?.mst && identity.mst !== selected) throw new Error(`Tài khoản này thuộc MST ${identity.mst}, không khớp MST đã chọn.`);
      directTokens.set(selected, token); authAccount = identity || { mst: selected, label: input.username.trim() };
      autoResumeIfNeeded(selected);
      storeSession(selected, token, password, keep);
      const account = await checkLogin(); return { authenticated: true, account, mst: selected, remembered: keep && !!password };
    } catch (error) {
      const next = await tct.captcha().catch(() => null);
      if (next) return challengeResponse({ ...next, ready: true, authenticated: false, remembered: isRemembered(selected), error: error.message || 'Đăng nhập không thành công.' });
      throw error;
    } finally { input.password = ''; }
  }
  let result;
  try {
    result = await browser.loginAction({ mode: 'submit', username: input.username.trim(), password, captcha: input.captcha.trim().toUpperCase(), expectedCaptcha: challenge.captcha });
  } catch (error) {
    // A successful sign-in can replace the page context before evaluate returns.
    const account = await checkLogin().catch(() => null);
    if (account) { remember(); return { authenticated: true, account, mst: selected, remembered: keep && !!password }; }
    throw error;
  } finally { input.password = ''; }
  if (result.authenticated) { const account = await checkLogin(); if (!account) throw new Error('Phiên đăng nhập chưa hợp lệ. Bấm Lấy CAPTCHA để thử lại.'); remember(); return { authenticated: true, account, mst: selected, remembered: keep && !!password }; }
  return challengeResponse(result);
}
// Hộp thoại chọn thư mục: cửa sổ "chủ" TopMost để hộp thoại luôn nổi lên trên cửa sổ app,
// có đường lui sang Shell.Application nếu WinForms không dùng được, và timeout để không treo.
function runPowerShell(script, timeout = 300000) {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, out: String(stdout || '').trim(), err: String(stderr || '').trim() }));
  });
}
const FOLDER_DIALOG = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Chọn thư mục lưu hóa đơn"',
  '$d.ShowNewFolderButton = $true',
  '$d.UseDescriptionForTitle = $true',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
].join('; ');
const FOLDER_DIALOG_BACKUP = [
  '$shell = New-Object -ComObject Shell.Application',
  '$f = $shell.BrowseForFolder(0, "Chọn thư mục lưu hóa đơn", 0)',
  'if ($f) { [Console]::Out.Write($f.Self.Path) }'
].join('; ');
async function chooseFolder() {
  const first = await runPowerShell(FOLDER_DIALOG);
  if (!first.error) return first.out; // '' khi người dùng bấm Cancel
  const backup = await runPowerShell(FOLDER_DIALOG_BACKUP);
  if (!backup.error) return backup.out;
  const detail = (first.err || backup.err || 'không rõ lỗi').split(/\r?\n/).filter(Boolean)[0] || 'không rõ lỗi';
  throw new Error(`Không mở được hộp thoại chọn thư mục (${detail}). Gõ hoặc dán đường dẫn đầy đủ vào ô “Thư mục lưu” rồi bấm ra ngoài ô.`);
}
function readBody(req) { return new Promise((resolve, reject) => { let text = ''; req.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(); }); req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('JSON không hợp lệ.')); } }); req.on('error', reject); }); }
function reply(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function allowed(req) {
  const expectedHost = `127.0.0.1:${server.address().port}`;
  const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && req.headers.host === expectedHost && cookies.includes(`hd_session=${sessionSecret}`)
    && (!req.headers.origin || req.headers.origin === `http://${expectedHost}`);
}
function staticFile(res, name, type) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(__dirname, name))); }
async function endpoint(req, res, url) {
  if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Không có quyền truy cập giao diện.' });
  lastUiPoll = Date.now(); // giao diện còn sống; dùng để tự thoát khi người dùng đóng cửa sổ
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, { ok: true, value: appState() });
    if (req.method === 'GET' && url.pathname === '/api/support/notice') return reply(res, 200, { ok: true, value: await support.notice() });
    // ---- Support: License và Chat là HAI luồng độc lập, chỉ chạy khi được gọi ----
    // /api/support/device : ảnh chụp local, KHÔNG gọi máy chủ (header chat, hiển thị tức thì)
    // /api/support/license: kiểm tra License khi có luồng chức năng gọi tới (không polling)
    // /api/support/chat   : đọc tin nhắn theo yêu cầu (không kéo theo License)
    // /api/support/events : SSE realtime — server đẩy thay đổi từ Firebase qua Gateway xuống UI
    if (url.pathname === '/api/support/device') return reply(res, 200, { ok: true, value: support.snapshot() });
    if (url.pathname === '/api/support/license') {
      const value = await support.checkLicense();
      ensureSupportStream(); // token phiên có thể vừa xuất hiện -> mở luồng chat nếu chưa có
      return reply(res, 200, { ok: true, value });
    }
    if (url.pathname === '/api/support/chat') return reply(res, 200, { ok: true, value: await support.messages() });
    if (req.method === 'GET' && url.pathname === '/api/support/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(supportEvent({ type: 'mode', realtime: supportRealtimeReady }));
      if (lastSupportMessages) res.write(supportEvent({ type: 'messages', messages: lastSupportMessages }));
      supportClients.add(res);
      ensureSupportStream();
      req.on('close', () => {
        supportClients.delete(res);
        // Không còn cửa sổ nào nghe thì đóng luôn kết nối tới Gateway (không giữ luồng "chết").
        if (!supportClients.size) stopSupportStream();
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/app-lock/status') return reply(res, 200, { ok: true, value: appLock.status() });
  // Version hiện tại + kiểm tra bản mới (chỉ đọc GitHub Releases, không tự ghi đè EXE).
  if (url.pathname === '/api/version') return reply(res, 200, { ok: true, value: { name: VERSION.name, version: VERSION.version } });
  if (url.pathname === '/api/update') return reply(res, 200, { ok: true, value: { ...updater.status(), url: updater.status().releaseUrl } });
  // ---- Self update: mỗi thao tác do người dùng chủ động gọi ----
  if (url.pathname === '/api/update/check') return reply(res, 200, { ok: true, value: await updater.check(true) });
  if (url.pathname === '/api/update/cancel') return reply(res, 200, { ok: true, value: updater.cancel() });
  if (url.pathname === '/api/update/start') {
    const result = await updater.start();
    // Tải + xác minh xong và helper đã khởi động -> trả lời rồi tự đóng để helper thay file.
    if (result.ok) setTimeout(() => { stop(); }, 1500);
    return reply(res, 200, { ok: true, value: result });
  }
    if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Yêu cầu không hợp lệ.');
    if (req.method === 'POST' && url.pathname === '/api/app-lock/set-pin') { const input = await readBody(req); return reply(res, 200, { ok: true, value: appLock.setPin(input.pin) }); }
    if (req.method === 'POST' && url.pathname === '/api/app-lock/unlock') { const input = await readBody(req); return reply(res, 200, { ok: true, value: appLock.verify(input.pin) }); }
    if (req.method === 'POST' && url.pathname === '/api/app-lock/lock') return reply(res, 200, { ok: true, value: appLock.lock() });
    if (req.method === 'POST' && url.pathname === '/api/app-lock/reset') { const input = await readBody(req); return reply(res, 200, { ok: true, value: appLock.resetWithLicense(input.licenseKey, input.pin) }); }
    if (req.method === 'POST' && url.pathname === '/api/support/register') return reply(res, 200, { ok: true, value: await support.register() });
    if (req.method === 'POST' && url.pathname === '/api/support/info') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await support.updateInfo(input.phone, input.name, input.plan) }); }
    if (req.method === 'POST' && url.pathname === '/api/support/activate') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await support.activate(input.key) }); }
    if (req.method === 'POST' && url.pathname === '/api/support/message') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await support.addMessage('user', input.text) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/login') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => addOrLogin(input.mst)) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/submit') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => submitLogin(input)) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/captcha') return reply(res, 200, { ok: true, value: await authOperation(async () => { if (!selected) throw new Error('Chọn MST trước.'); const value = await browser.loginAction({ mode: 'refresh' }); if (value.authenticated) return { ...value, account: await checkLogin() }; return challengeResponse(value); }) });
    if (req.method === 'POST' && url.pathname === '/api/account/show') {
      const input = await readBody(req); const mst = input.mst || selected;
      ensureIdle(); if (!safeMst(mst)) throw new Error('Nhập MST hợp lệ trước khi mở trang thuế.');
      if (authBusy) {
        if (browser.client && browser.mst === mst) { await browser.show(); return reply(res, 200, { ok: true, value: true }); }
        throw new Error('Đang khởi động trình duyệt. Thử mở trang thuế lại sau vài giây.');
      }
      return reply(res, 200, { ok: true, value: await authOperation(async () => {
        await browser.open(mst, true);
        if (selected !== mst || !engine) { authAccount = null; loginChallenge = null; createEngine(mst); }
        selected = mst; return true;
      }) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/visibility') return reply(res, 200, { ok: true, value: await authOperation(async () => {
      if (!browser.client) throw new Error('Chưa có phiên đăng nhập. Nhập MST để bắt đầu trước.');
      const visible = !!(await readBody(req)).visible;
      if (visible) await browser.show(); else await browser.hide();
      return { visible: browser.visible };
    }) });
    if (req.method === 'POST' && url.pathname === '/api/account/check') return reply(res, 200, { ok: true, value: await authOperation(checkLogin) });
    if (req.method === 'POST' && url.pathname === '/api/account/select') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => selectAccount(input.mst)) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/save') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => saveAccount(input)) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/remove') {
      ensureIdle(); if (authBusy) throw new Error('Đang xử lý đăng nhập.'); const mst = (await readBody(req)).mst;
      accounts.accounts = accounts.accounts.filter(x => x.mst !== mst); directTokens.delete(mst); secrets.clear(mst); remembered.delete(mst); sessionCache.delete(mst); jobCache.delete(mst); if (selected === mst) { selected = ''; engine = null; authAccount = null; loginChallenge = null; await browser.close(); } accounts.selected = selected; saveAccounts(); return reply(res, 200, { ok: true, value: appState() });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/forget') { const body = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => forgetSecret(body)) }); }
    if (req.method === 'POST' && url.pathname === '/api/folder') {
      // Không có `path` thì mở hộp thoại chọn thư mục của Windows; có `path` thì lưu đường dẫn
      // người dùng tự gõ/dán (phải là đường dẫn đầy đủ, thư mục được tạo nếu chưa có).
      const input = await readBody(req); const typed = String(input.path || '').trim();
      const folder = typed ? typed : await chooseFolder();
      if (typed && !path.isAbsolute(typed)) throw new Error('Đường dẫn phải đầy đủ, ví dụ D:\\HoaDon\\2026.');
      if (folder) { if (typed) await ensureFolder(folder); output = folder; accounts.output = output; saveAccounts(); }
      return reply(res, 200, { ok: true, value: output });
    }
    if (req.method === 'POST' && ['/api/search','/api/download','/api/resume','/api/export-excel'].includes(url.pathname) && authBusy) throw new Error('Chờ đăng nhập hoàn tất trước khi tải.');
    if (req.method === 'POST' && url.pathname === '/api/search') {
      await ensureLicenseAllowed();
      if (!engine) throw new Error('Chọn MST và kiểm tra phiên trước.');
      // Đang chạy tác vụ thì nút Tra cứu đóng vai nút Tạm dừng (tránh trường hợp giao diện chưa kịp
      // cập nhật trạng thái mà người dùng bấm lần nữa).
      if (engine.busy) { engine.pause(); return reply(res, 200, { ok: true, value: engine.snapshot() }); }
      const input = await readBody(req); const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder); // báo lỗi rõ nếu là ổ gốc / ổ chỉ đọc / không có quyền ghi
      output = folder; accounts.output = output; saveAccounts();
      const value = await engine.search(input, output);
      await closeBrowserWhenIdle('tra cứu xong');
      return reply(res, 200, { ok: true, value });
    }
    // Xuất Excel danh sách hóa đơn từ chính kết quả tra cứu (không gọi API chi tiết, không tải XML/PDF).
    if (req.method === 'POST' && url.pathname === '/api/export-excel') {
      await ensureLicenseAllowed();
      if (!engine) throw new Error('Chưa chọn MST và chưa tra cứu.');
      await applyOutput();
      return reply(res, 200, { ok: true, value: await engine.exportList() });
    }
    if (req.method === 'POST' && url.pathname === '/api/download') { await ensureLicenseAllowed(); if (!engine) throw new Error('Chưa chọn MST.'); await applyOutput(); const value = await engine.resume(true); await closeBrowserWhenIdle('tải xong'); return reply(res, 200, { ok: true, value }); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { await ensureLicenseAllowed(); if (!engine) throw new Error('Chưa chọn MST.'); await applyOutput(); const value = await engine.resume(); await closeBrowserWhenIdle('tải xong'); return reply(res, 200, { ok: true, value }); }
    if (req.method === 'POST' && url.pathname === '/api/pause') { if (engine) engine.pause(); return reply(res, 200, { ok: true, value: appState() }); }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const base = engine?.job?.output || output;
      if (!base) throw new Error('Chưa chọn thư mục lưu. Bấm “Chọn thư mục…” trước.');
      const mst = engine?.job?.account?.mst || selected; const own = mst ? path.join(base, `MST-${mst}`) : '';
      const folder = own && fs.existsSync(own) ? own : base; // mở thẳng MST-<số MST> khi đã có
      if (!fs.existsSync(folder)) throw new Error(`Thư mục "${folder}" chưa có. Chọn lại thư mục lưu rồi bấm Tra cứu hóa đơn.`);
      spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref();
      return reply(res, 200, { ok: true, value: folder });
    }
    // Mở 1 file (hoặc thư mục) bằng ứng dụng mặc định của Windows — chỉ cho phép trong thư mục lưu.
    if (req.method === 'POST' && url.pathname === '/api/open-file') {
      const input = await readBody(req); const target = String(input.path || '').trim();
      const base = engine?.job?.output || output;
      if (!target) throw new Error('Thiếu đường dẫn file cần mở.');
      if (!base) throw new Error('Chưa chọn thư mục lưu.');
      const resolved = path.resolve(target); const root = path.resolve(base);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Chỉ mở được file nằm trong thư mục lưu đã chọn.');
      if (!fs.existsSync(resolved)) throw new Error(`Không thấy file: ${resolved}`);
      spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
      return reply(res, 200, { ok: true, value: resolved });
    }
    return reply(res, 404, { ok: false, error: 'Không tìm thấy lệnh.' });
  } catch (error) { return reply(res, 400, { ok: false, error: error.message || 'Lỗi không xác định.' }); }
}
// Cửa sổ app (Chrome --app) đóng = thoát chương trình, vì EXE không còn console để đóng.
// Giao diện ngừng gọi /api/state quá 2,5 phút cũng coi như đã đóng.
function watchUi() {
  // Chrome có thể kết thúc tiến trình khởi chạy sớm (bàn giao cho instance khác), nên chỉ thoát khi
  // giao diện ĐÃ ngừng gọi /api/state — tránh app tự tắt ngay sau khi mở.
  uiProcess.once('exit', () => setTimeout(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 8000) { log('Cửa sổ giao diện đã đóng — thoát chương trình.'); stop(); }
    else log('Tiến trình khởi chạy Chrome đã kết thúc nhưng giao diện vẫn phản hồi — tiếp tục chạy.');
  }, 10000));
  const timer = setInterval(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 150000) { log('Giao diện không phản hồi trong 2,5 phút — thoát chương trình.'); stop(); }
  }, 30000);
  timer.unref();
}
function launchUi(port) {
  const executablePath = browserPath(); if (!executablePath) throw new Error('Không tìm thấy Google Chrome hoặc Microsoft Edge.');
  const url = `http://127.0.0.1:${port}/?launch=${sessionSecret}`;
  uiProcess = spawn(executablePath, [`--app=${url}`, `--user-data-dir=${path.join(dataDir, 'ui-browser')}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' }); uiProcess.unref();
  log(`Đã mở giao diện: ${url}`);
  watchUi();
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const host = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== host) return reply(res, 403, { ok: false, error: 'Host không hợp lệ.' });
  if (url.pathname === '/' && url.searchParams.get('launch') === sessionSecret) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': `hd_session=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
  }
  if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Phiên giao diện đã cũ. Mở lại EXE để tiếp tục.' });
  if (url.pathname === '/') return staticFile(res, 'index.html', 'text/html; charset=utf-8');
  if (url.pathname === '/style.css') return staticFile(res, 'style.css', 'text/css; charset=utf-8');
  if (url.pathname === '/login.css') return staticFile(res, 'login.css', 'text/css; charset=utf-8');
  if (url.pathname === '/renderer.js') return staticFile(res, 'renderer.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/chat-widget.js') return staticFile(res, 'chat-widget.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/vendor/sound.js') return staticFile(res, 'vendor/sound.js', 'text/javascript; charset=utf-8');
  // Âm thanh thông báo tuỳ chọn: bỏ file src/template/thong-bao.mp3 là app dùng file đó, không có thì
  // renderer tự dùng chuông sinh sẵn trong vendor/sound.js (xem package.json > pkg.assets).
  if (url.pathname === '/template/thong-bao.mp3' && fs.existsSync(path.join(__dirname, 'template', 'thong-bao.mp3'))) return staticFile(res, 'template/thong-bao.mp3', 'audio/mpeg');
  if (url.pathname === '/app-settings.js') return staticFile(res, 'app-settings.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/update-ui.js') return staticFile(res, 'update-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/period.js') return staticFile(res, 'period.js', 'text/javascript; charset=utf-8');
  if (url.pathname.startsWith('/api/')) return void endpoint(req, res, url);
  res.writeHead(404); res.end();
});
function localGet(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname, headers: { Cookie: `hd_session=${sessionSecret}` } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}
server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  if (process.argv.includes('--smoke-test')) {
    try {
      const [page, state] = await Promise.all([localGet(port, '/'), localGet(port, '/api/state')]);
      if (page.status !== 200 || !page.body.includes('HoaDon Desktop') || state.status !== 200 || JSON.parse(state.body).ok !== true) throw new Error('Giao diện hoặc API localhost không phản hồi đúng.');
      console.log(JSON.stringify({ ok: true, packed, port, browser: browserPath() || null, ui: true, api: true })); server.close(() => process.exit(0));
    } catch (error) { console.error(error.message); server.close(() => process.exit(1)); }
  }
  else if (testServer && process.argv.includes('--check-login-page')) {
    try {
      await browser.open('0000000000', false); await browser.show();
      const value = await browser.prepareLogin();
      console.log(JSON.stringify({ packed, windowShown: true, ready: value.ready, captchaLength: (value.captcha || '').length, error: value.error }));
      process.exitCode = value.ready ? 0 : 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { await browser.close(); server.close(); }
  }
  else if (testServer) console.log(JSON.stringify({ testUrl: `http://127.0.0.1:${port}/?launch=${sessionSecret}`, packed }));
  else { log(`Khởi động HoaDon Desktop (${packed ? 'EXE' : 'node'}) · dữ liệu: ${dataDir} · cổng ${port}`); try { launchUi(port); } catch (error) { reportFatal(error.message); stop(); } }
});
async function stop() { if (engine?.busy) engine.pause(); stopSupportStream(); await browser.close(); log('Đã thoát chương trình.'); server.close(() => process.exit(0)); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
