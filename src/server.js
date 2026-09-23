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
        execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${quoted}, 'CN Tax Tools', 'OK', 'Warning') | Out-Null`], { windowsHide: true }, () => {});
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
// PHASE 1 – Data Core: tự kiểm tra tầng dữ liệu (node:sqlite + schema + repository) rồi thoát.
// Dùng để xác minh BÊN TRONG EXE đã đóng gói:  CN-Tax-Tools.exe --data-core-check
// Chỉ làm việc trong thư mục tạm của hệ điều hành, không ghi vào du_lieu, không gọi mạng.
if (process.argv.includes('--data-core-check')) {
  console.log(JSON.stringify(require('./data/self-check').runSelfCheck()));
  process.exit(0);
}
// PHASE 2 – XML Data Engine: quét XML đã tải về và ghi vào data.db của MST.
//   CN-Tax-Tools.exe --data-import "<thư mục lưu>" <MST>
// Chỉ đọc/ghi trong thư mục lưu của người dùng, không gọi mạng, không đụng luồng tải.
if (process.argv.includes('--data-import')) {
  const index = process.argv.indexOf('--data-import');
  require('./data/xml-import').runImport({ output: process.argv[index + 1], mst: process.argv[index + 2] })
    .then(result => { console.log(JSON.stringify(result)); process.exit(result.ok ? 0 : 1); })
    .catch(error => { console.log(JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) })); process.exit(1); });
  return;
}
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
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show(${quoted}, 'CN Tax Tools', 'OK', 'Error') | Out-Null`], { windowsHide: true }, () => {});
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
// Tầng dữ liệu SQLite chỉ nạp khi thật sự dùng tới, để các phần khác của app vẫn chạy được
// kể cả khi môi trường không có node:sqlite (Node < 22).
function dataLayer() {
  try { return require('./data'); }
  catch (error) { throw new Error(`Không nạp được tầng dữ liệu SQLite (cần Node 22 trở lên): ${error.message}`); }
}
// ---- PHASE 4: AUTO SYNC (§23–§28, §66) ----------------------------------------------------
// Bộ điều phối ở src/data/auto-sync.js; phần “việc thật” (tra cứu, tải, nhập) ở dưới.
let autoSyncInstance = null;
function autoSync() {
  if (autoSyncInstance) return autoSyncInstance;
  const { createAutoSync } = require('./data/auto-sync');
  autoSyncInstance = createAutoSync({
    // sync.json nằm trong vùng dữ liệu của MST đang chọn (mục 4/§28).
    syncFile: () => (selected && output ? path.join(dataLayer().mst.mstDirectory(output, selected), 'sync.json') : ''),
    manualBusy: () => !!(engine && engine.busy),
    log,
    runDirection: ({ direction, days }) => runAutoSyncDirection({ direction, days }),
  });
  autoSyncInstance.schedule();
  return autoSyncInstance;
}

// ---- PHASE 5: BACKFILL (§29/§67) ---------------------------------------------------------
// Tải lịch sử dùng ĐÚNG pipeline trên, chỉ khác là khoảng ngày do người dùng chọn
// (Năm/Quý/Tháng/Khoảng ngày) và chạy như một job có tiến độ, dừng được.
let backfillJobInstance = null;
function backfillJob() {
  if (backfillJobInstance) return backfillJobInstance;
  const { createBackfillJob } = require('./data/backfill');
  backfillJobInstance = createBackfillJob({ runRange: range => runBackfillRange(range), log });
  return backfillJobInstance;
}

async function runBackfillRange({ direction, from, to, onProgress, isCancelled }) {
  const data = dataLayer();
  const mst = selected;
  if (!mst) throw new Error('Chưa chọn MST.');
  if (!output) throw new Error('Chưa chọn thư mục lưu.');
  const { dir, db } = data.mst.ensureMst({ output, mst });
  let engine = null;
  try {
    // XML đã có trên đĩa mà DB thiếu ⇒ nhập trước, khỏi tải lại (mục 18/19 lớp 2).
    await data.xmlScanner.scanXmlFolder({ db, mst, mstDir: dir });
    engine = new Engine({
      store: path.join(dir, 'backfill-job.json'),
      request: async (route, action, check) => {
        check(); const token = directTokens.get(mst);
        if (!token) return browser.request(route, action, check);
        try { return await tct.request(token, route, action); }
        catch (error) { if (error.auth) forgetSession(mst); throw error; }
      },
      identity: () => (directTokens.has(mst) ? authAccount : browser.verify(mst)),
      pdf: async () => { throw new Error('Tải lịch sử chỉ tải XML.'); },
      excel: makeExcel,
      emit: snapshot => {
        if (typeof onProgress === 'function') onProgress({ message: snapshot.message, state: snapshot.state, total: snapshot.total, done: snapshot.done });
        // Dừng theo yêu cầu: engine.pause() làm lượt tải kết thúc gọn ở hoá đơn kế tiếp.
        if (typeof isCancelled === 'function' && isCancelled() && engine) engine.pause();
      },
      // Mục 19 lớp 1 / §86.7: hoá đơn đã có trong SQLite thì không tải lại.
      shouldSkip: async inv => !!data.repository.findInvoiceByKey(db, data.invoiceKey.buildInvoiceKey({
        mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon,
      })),
    });
    await engine.search({ direction: direction === 'BUY' ? 'purchase' : 'sold', family: 'both', from, to, status: '', formats: ['xml'] }, output);
    await engine.resume(true);
    const stats = (engine.job && engine.job.stats) || {};
    const after = await data.xmlScanner.scanXmlFolder({ db, mst, mstDir: dir });
    return {
      found: (engine.job && engine.job.items.length) || 0,
      downloaded: stats.downloaded || 0,
      skipped: (stats.skipped || 0) + (after.skipped || 0),
      imported: after.imported || 0,
      errors: after.errors || 0,
    };
  } catch (error) {
    if (typeof isCancelled === 'function' && isCancelled() && error) error.cancelled = true;
    throw error;
  } finally {
    data.sqlite.closeDatabase(db);
  }
}

// Một hướng của Auto Sync: nhập XML đã có → tra cứu → tải phần còn thiếu → nhập XML vừa tải.
// Dùng Engine RIÊNG (job riêng, file riêng) nên không đụng lượt tải thủ công đang chạy (mục 12/23).
// Chỉ tải XML (không PDF/HTML/Excel) — mục 24/25 nói Auto Sync tải XML.
async function runAutoSyncDirection({ direction, days }) {
  const data = dataLayer();
  const mst = selected;
  if (!mst) throw new Error('Chưa chọn MST.');
  if (!output) throw new Error('Chưa chọn thư mục lưu.');
  const { dir, db } = data.mst.ensureMst({ output, mst });
  try {
    // 1) XML đã có trên đĩa mà SQLite chưa có ⇒ nhập trước, khỏi tải lại (mục 18/19 lớp 2).
    await data.xmlScanner.scanXmlFolder({ db, mst, mstDir: dir });
    // 2) Tra cứu + tải phần còn thiếu.
    const syncEngine = new Engine({
      store: path.join(dir, 'autosync-job.json'),
      request: async (route, action, check) => {
        check(); const token = directTokens.get(mst);
        if (!token) return browser.request(route, action, check);
        try { return await tct.request(token, route, action); }
        catch (error) { if (error.auth) forgetSession(mst); throw error; }
      },
      identity: () => (directTokens.has(mst) ? authAccount : browser.verify(mst)),
      pdf: async () => { throw new Error('Auto Sync chỉ tải XML.'); },
      excel: makeExcel,
      emit: () => {},
      // Mục 19 lớp 1 / §86.7: hoá đơn đã có trong SQLite thì không tải lại.
      shouldSkip: async inv => !!data.repository.findInvoiceByKey(db, data.invoiceKey.buildInvoiceKey({
        mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon,
      })),
    });
    const iso = date => date.toISOString().slice(0, 10);
    const to = new Date();
    const from = new Date(Date.now() - (Math.max(1, Number(days) || 7) - 1) * 86400000);
    const params = {
      direction: direction === 'BUY' ? 'purchase' : 'sold',
      family: 'both', from: iso(from), to: iso(to), status: '', formats: ['xml'],
    };
    await syncEngine.search(params, output);
    const found = (syncEngine.job && syncEngine.job.items.length) || 0;
    await syncEngine.resume(true);
    const stats = (syncEngine.job && syncEngine.job.stats) || {};
    // 3) Nhập XML vừa tải về (mục 22) — sau bước này data.db mới có dữ liệu mới.
    const after = await data.xmlScanner.scanXmlFolder({ db, mst, mstDir: dir });
    return {
      found,
      downloaded: stats.downloaded || 0,
      skipped: (stats.skipped || 0) + (after.skipped || 0),
      imported: after.imported || 0,
      errors: after.errors || 0,
    };
  } finally {
    data.sqlite.closeDatabase(db);
  }
}

// Sau khi người dùng tải xong (luồng thủ công): tự nhập XML vào kho dữ liệu, chạy nền.
// Chỉ THÊM một bước sau lượt tải đã xong ⇒ không đổi hành vi tra cứu/tải (mục 12).
async function autoImportAfterDownload(label) {
  try {
    const data = dataLayer();
    if (!selected || !output) return;
    if (data.importJob.status().running) return;
    log(`Tự nhập XML vào kho dữ liệu sau khi ${label} (MST ${selected})…`);
    data.importJob.start({ output, mst: selected }).catch(error => log('Tự nhập dữ liệu lỗi: ' + (error && error.message ? error.message : error)));
  } catch (error) {
    log('Không tự nhập được vào kho dữ liệu: ' + (error && error.message ? error.message : error));
  }
}
// Tự làm mới phiên khi mở app: nếu chưa có token còn hạn, thử lấy lại phiên từ profile Chrome
// của chính MST đó (profile giữ cookie của cổng thuế). KHÔNG thể tự nhập CAPTCHA — nếu profile
// cũng hết phiên thì báo rõ để người dùng đăng nhập một lần.
async function refreshSessionOnStartup(mst) {
  const value = String(mst || '').trim();
  if (!/^\d+$/.test(value)) return { ok: false, reason: 'chưa chọn MST' };
  if (directTokens.has(value)) return { ok: true, reason: 'token đã lưu còn hiệu lực' };
  if (!fs.existsSync(path.join(dataDir, 'profiles', value))) return { ok: false, reason: 'chưa có profile Chrome cho MST này' };
  try {
    await browser.open(value, false);
    const account = await browser.verify(value);
    if (!account) {
      // Không có phiên trong profile: đóng cửa sổ ẩn để không để tiến trình Chrome treo.
      await browser.close();
      return { ok: false, reason: 'phiên trong profile đã hết' };
    }
    authAccount = account;
    sessionCache.set(value, true);
    log(`Đã tự khôi phục phiên cổng thuế của MST ${value} từ profile Chrome (không cần đăng nhập lại).`);
    return { ok: true, reason: 'khôi phục từ profile Chrome' };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`Không tự khôi phục được phiên cho MST ${value}: ${message}`);
    return { ok: false, reason: message };
  }
}

// Chạy SAU khi cửa sổ đã mở: làm mới phiên rồi (nếu có phiên) tự dò hoá đơn mới trong nền.
// Không chặn UI, không thay đổi hành vi nào của luồng tải thủ công.
async function autoStartBackground() {
  const summary = { mst: selected || '', session: null, hasSession: false, autoSyncEnabled: false, started: false };
  try {
    const result = await refreshSessionOnStartup(selected);
    summary.session = result;
    log(`Kiểm tra phiên lúc khởi động: ${result.ok ? 'OK' : 'chưa có'} — ${result.reason}`);
    const hasSession = directTokens.has(selected) || !!browser.client;
    summary.hasSession = hasSession;
    if (!hasSession) { log('Chưa có phiên cổng thuế — tạm bỏ lượt dò hoá đơn mới cho tới khi đăng nhập.'); return summary; }
    const status = autoSync().status();
    summary.autoSyncEnabled = !!status.settings.enabled;
    if (!status.settings.enabled) { log('Auto Sync đang tắt — không dò hoá đơn mới.'); return summary; }
    log('Bắt đầu dò hoá đơn mới trong nền (Auto Sync)…');
    summary.started = true;
    autoSync().run('startup').catch(error => log('Auto Sync lúc khởi động lỗi: ' + (error && error.message ? error.message : error)));
  } catch (error) {
    summary.error = error && error.message ? error.message : String(error);
    log('Khởi động nền lỗi: ' + summary.error);
  }
  return summary;
}
let selected = accounts.selected || '';
let output = accounts.output || ''; // người dùng chọn; không tự đặt mặc định ngầm
let uiProcess = null;
let trayProcess = null;
let trayBusy = null;
let trayFailCount = 0;
let trayNextTry = 0;
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
// Tên công ty/HKD của MST: lấy từ chính dữ liệu hoá đơn đã nhập (XML là nguồn gốc).
// Chỉ đọc khi data.db đã tồn tại (không tạo file mới từ màn hình trạng thái) và chỉ nhớ kết quả
// không rỗng, để MST chưa nhập dữ liệu vẫn thử lại được ở lần sau.
const companyNameCache = new Map();
function companyNameFor(mst) {
  const key = String(mst || '').trim();
  if (!key || !output) return '';
  const cached = companyNameCache.get(key);
  if (cached) return cached;
  try {
    const data = dataLayer();
    const dbFile = path.join(data.mst.mstDirectory(output, key), 'data.db');
    if (!fs.existsSync(dbFile)) return '';
    const db = data.sqlite.openDatabase(dbFile);
    try {
      const row = db.prepare("SELECT ten_ban AS ten FROM invoices WHERE mst_ban = ? AND ten_ban <> '' LIMIT 1").get(key)
        || db.prepare("SELECT ten_mua AS ten FROM invoices WHERE mst_mua = ? AND ten_mua <> '' LIMIT 1").get(key);
      const name = row && row.ten ? String(row.ten).trim() : '';
      if (name) { companyNameCache.set(key, name); return name; }
    } finally {
      data.sqlite.closeDatabase(db);
    }
  } catch { /* chưa có dữ liệu / chưa chọn thư mục */ }
  return '';
}
function appState() {
  const snapshot = engine ? engine.snapshot() : { state: 'idle', busy: false, items: [], total: 0, done: 0, failed: 0, message: 'Chọn hoặc thêm MST để bắt đầu.' };
  return { ...snapshot, accounts: accounts.accounts.map(publicAccount), selected, output, companyName: companyNameFor(selected), remembered: !!selected && isRemembered(selected), browserReady: !!browser.client, browserVisible: !!browser.visible, authenticated: !!authAccount, authBusy, update: updater.status() };
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
  // ---- PHASE 3: Kho dữ liệu hoá đơn — đọc từ SQLite, KHÔNG quét XML khi mở danh sách (mục 15, 50, 33) ----
  if (url.pathname.startsWith('/api/db/')) {
    const data = dataLayer();
    const currentMst = () => {
      if (!selected) throw new Error('Chọn một MST trước.');
      if (!output) throw new Error('Chọn thư mục lưu trước.');
      return selected;
    };
    const withDatabase = fn => {
      const mst = currentMst();
      const { dir, db } = data.mst.ensureMst({ output, mst });
      try { return fn(db, dir, mst); } finally { data.sqlite.closeDatabase(db); }
    };
    if (req.method === 'GET' && url.pathname === '/api/db/summary') {
      return withDatabase((db, dir, mst) => reply(res, 200, { ok: true, value: { ...data.queries.summary(db), mst, dir, output } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/invoices') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: data.queries.listInvoices(db, {
          q: p.get('q') || '', direction: p.get('direction') || '', from: p.get('from') || '', to: p.get('to') || '',
          limit: p.get('limit'), offset: p.get('offset'),
        }),
      }));
    }
    // §35: xem chi tiết = đọc ĐÚNG MỘT file XML của hoá đơn đó, không parse hàng loạt.
    if (req.method === 'GET' && url.pathname === '/api/db/invoice') {
      const key = url.searchParams.get('key') || '';
      return withDatabase(db => {
        const found = data.queries.getInvoice(db, key);
        if (!found) return reply(res, 200, { ok: false, error: 'Không tìm thấy hoá đơn trong data.db.' });
        let xml = null;
        let xmlError = '';
        const fileXml = String(found.invoice.file_xml || '');
        if (fileXml && fs.existsSync(fileXml)) {
          try { xml = data.xmlParser.parseInvoiceXml(fs.readFileSync(fileXml, 'utf8')).record; }
          catch (error) { xmlError = error.message; }
        } else {
          xmlError = 'File XML không còn ở đường dẫn đã lưu trong data.db.';
        }
        return reply(res, 200, { ok: true, value: { invoice: found.invoice, items: found.items, xml, xmlError } });
      });
    }
    // §35: xem trước hoá đơn khổ A4 chuẩn Tổng cục Thuế — đọc ĐÚNG MỘT file XML, KHÔNG gọi API.
    // Trả về tài liệu HTML (không phải JSON) để nhúng vào iframe; tài liệu này tự đặt CSP riêng:
    // chặn mọi tài nguyên ngoài, chỉ cho style inline (bộ dựng A4 dùng style inline).
    if (req.method === 'GET' && url.pathname === '/api/db/invoice/html') {
      const key = url.searchParams.get('key') || '';
      const html = withDatabase(db => {
        const found = data.queries.getInvoice(db, key);
        if (!found) throw new Error('Không tìm thấy hoá đơn trong data.db.');
        const fileXml = String(found.invoice.file_xml || '');
        if (!fileXml || !fs.existsSync(fileXml)) throw new Error('File XML không còn ở đường dẫn đã lưu trong data.db.');
        return require('./data/invoice-a4').buildInvoiceA4Document(fs.readFileSync(fileXml, 'utf8'));
      });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
      });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/db/products') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: data.queries.products(db, {
          q: p.get('q') || '', direction: p.get('direction') || '', from: p.get('from') || '', to: p.get('to') || '', limit: p.get('limit'),
        }),
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/partners') {
      const p = url.searchParams;
      const requested = String(p.get('kind') || 'all');
      const kind = ['supplier', 'buyer', 'all'].includes(requested) ? requested : 'all';
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: { rows: data.queries.partners(db, { kind, limit: p.get('limit') }) },
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/import/status') {
      return reply(res, 200, { ok: true, value: data.importJob.status() });
    }
    // ---- AUTO SYNC: trạng thái, cấu hình, chạy ngay (§26/§28/§30) ----
    if (req.method === 'GET' && url.pathname === '/api/db/autosync/status') {
      const value = autoSync().status();
      return reply(res, 200, {
        ok: true,
        value: { ...value, mst: selected || '', dir: selected && output ? data.mst.mstDirectory(output, selected) : '' },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/settings') {
      const input = await readBody(req);
      const settings = autoSync().configure({ enabled: input.enabled, days: input.days, intervalMinutes: input.intervalMinutes });
      return reply(res, 200, { ok: true, value: settings });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run') {
      await ensureLicenseAllowed();
      currentMst();
      autoSync().run('manual').catch(() => { /* lỗi đã ghi vào sync.json */ });
      return reply(res, 200, { ok: true, value: autoSync().status() });
    }
    // ---- BACKFILL: tải lịch sử theo Năm/Quý/Tháng/Khoảng ngày (§29/§67) ----
    if (req.method === 'GET' && url.pathname === '/api/db/backfill/status') {
      return reply(res, 200, { ok: true, value: backfillJob().status() });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/backfill') {
      await ensureLicenseAllowed();
      currentMst();
      if (backfillJob().status().running) throw new Error('Đang tải lịch sử. Bấm Dừng trước nếu muốn đổi khoảng.');
      const input = await readBody(req);
      const plan = data.backfill.buildPlan(input);
      backfillJob().start({ plan }).catch(() => { /* lỗi đã nằm trong status */ });
      return reply(res, 200, { ok: true, value: { plan, status: backfillJob().status() } });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/backfill/cancel') {
      return reply(res, 200, { ok: true, value: backfillJob().cancel() });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/import') {
      await ensureLicenseAllowed();
      currentMst();
      if (data.importJob.status().running) throw new Error('Đang nhập dữ liệu. Chờ lượt hiện tại chạy xong.');
      data.importJob.start({ output, mst: selected }).catch(() => { /* lỗi đã nằm trong status */ });
      return reply(res, 200, { ok: true, value: data.importJob.status() });
    }
    return reply(res, 404, { ok: false, error: 'Không rõ đường dẫn dữ liệu.' });
  }
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
  // ---- Vòng đời cửa sổ (System Tray): còn sống / mở lại cửa sổ / thoát hoàn toàn ----
  // GET /api/ping: để bản EXE thứ hai biết instance này còn sống mà nhường, không mở bản mới.
  if (req.method === 'GET' && url.pathname === '/api/ping') return reply(res, 200, { ok: true, value: { alive: true, pid: process.pid, version: VERSION.version } });
  // POST /api/window/show: hiện lại cửa sổ giao diện. Có cửa sổ rồi thì ĐƯA LÊN TRƯỚC (không mở thêm),
  // chỉ mở cửa sổ mới khi cửa sổ cũ đã đóng — dùng lại đúng instance + profile hiện tại.
  if (req.method === 'POST' && url.pathname === '/api/window/show') {
    try {
      await showUiWindow();
      ensureTray();
      return reply(res, 200, { ok: true, value: { shown: true } });
    } catch (error) {
      log('Không mở lại được cửa sổ: ' + (error && error.message ? error.message : error));
      return reply(res, 400, { ok: false, error: error.message });
    }
  }
  // POST /api/app/quit: thoát hoàn toàn (dùng đúng stop() hiện có).
  if (req.method === 'POST' && url.pathname === '/api/app/quit') {
    log('Nhận yêu cầu thoát hoàn toàn — dọn dẹp rồi thoát.');
    reply(res, 200, { ok: true, value: { quitting: true } });
    setTimeout(() => { stop().catch(() => process.exit(0)); }, 200);
    return;
  }
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
    if (req.method === 'POST' && url.pathname === '/api/download') { await ensureLicenseAllowed(); if (!engine) throw new Error('Chưa chọn MST.'); await applyOutput(); const value = await engine.resume(true); await closeBrowserWhenIdle('tải xong'); autoImportAfterDownload('tải xong'); return reply(res, 200, { ok: true, value }); }
    if (req.method === 'POST' && url.pathname === '/api/resume') { await ensureLicenseAllowed(); if (!engine) throw new Error('Chưa chọn MST.'); await applyOutput(); const value = await engine.resume(); await closeBrowserWhenIdle('tải xong'); autoImportAfterDownload('chạy tiếp'); return reply(res, 200, { ok: true, value }); }
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
// ---------------------------------------------------------------------------
// Vòng đời ứng dụng: MỘT instance duy nhất + System Tray. Chỉ lớp này thay đổi;
// KHÔNG đụng SQLite, API cũ, engine tra cứu/tải, job JSON, updater hay nghiệp vụ.
// ---------------------------------------------------------------------------
function instanceFile() { return path.join(dataDir, 'app.pid.json'); }

function readInstanceFile() {
  try {
    const value = JSON.parse(fs.readFileSync(instanceFile(), 'utf8'));
    return value && value.port && value.secret ? value : null;
  } catch { return null; }
}

function writeInstanceFile(port) {
  try {
    atomicWrite(instanceFile(), JSON.stringify({ pid: process.pid, port, secret: sessionSecret, startedAt: new Date().toISOString() }, null, 2));
  } catch (error) { log('Không ghi được file instance: ' + (error && error.message ? error.message : error)); }
}

function removeInstanceFile() {
  try {
    const info = readInstanceFile();
    if (!info || Number(info.pid) === process.pid) fs.rmSync(instanceFile(), { force: true });
  } catch { /* bỏ qua */ }
}

// Gọi một endpoint của instance đang chạy — cùng cookie phiên như giao diện đang dùng.
function callInstance(info, pathname, method = 'GET') {
  return new Promise(resolve => {
    if (!info || !info.port || !info.secret) return resolve(null);
    const request = http.request({ host: '127.0.0.1', port: Number(info.port), path: pathname, method, timeout: 2000, headers: { Cookie: `hd_session=${info.secret}` } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(null));
    request.end();
  });
}

// Bản EXE mở lần hai: nếu instance cũ còn sống thì nhờ nó mở lại cửa sổ rồi THOÁT NGAY
// (không tạo thêm Node server, Chrome hay Tray). File instance ghi trong du_lieu của app.
async function claimSingleInstance(port) {
  if (testServer) return true;
  const existing = readInstanceFile();
  if (existing && Number(existing.pid) !== process.pid) {
    const ping = await callInstance(existing, '/api/ping');
    if (ping && ping.status === 200) {
      log(`Đã có bản đang chạy (pid ${existing.pid}, cổng ${existing.port}) — nhờ bản đó mở lại cửa sổ rồi thoát.`);
      await callInstance(existing, '/api/window/show', 'POST');
      return false;
    }
    log('File instance cũ không còn phản hồi — tiếp tục khởi động bản mới.');
  }
  writeInstanceFile(port);
  return true;
}

// Mở lại cửa sổ giao diện: dùng lại đúng tiến trình + profile hiện tại (Chrome gom về instance đang chạy).
function relaunchUi() {
  uiSilentLogged = false;
  lastUiPoll = Date.now();
  launchUi(server.address().port);
}

// Đưa cửa sổ giao diện ĐANG MỞ lên trước. Chrome/Edge không có cờ "focus cửa sổ đang có": cứ spawn
// `--app=...` với cùng profile là Chrome mở THÊM một cửa sổ mới (lỗi người dùng đã gặp: bấm icon khay
// vài lần ⇒ vài cửa sổ). Vì vậy tìm tiến trình đang dùng đúng profile ui-browser của app và có cửa sổ
// chính, rồi ShowWindow (khôi phục nếu thu nhỏ) + SetForegroundWindow.
function focusUiWindow() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false);
    const profile = path.join(dataDir, 'ui-browser').replace(/'/g, "''");
    const script = [
      "Add-Type -Namespace Hd -Name Win -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h, int n); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);'",
      `$profile = '${profile}'`,
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | Where-Object { $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object {",
      '  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue',
      '  if ($p -and $p.MainWindowHandle -ne 0) {',
      '    [Hd.Win]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
      '    [Hd.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
      "    Write-Output 'found'",
      '  }',
      '}',
    ].join('\n');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      resolve(String(stdout || '').includes('found'));
    });
  });
}

// Bấm icon khay / menu "Mở ứng dụng": có cửa sổ thì đưa lên trước, đã đóng hẳn mới mở cửa sổ mới.
async function showUiWindow() {
  if (await focusUiWindow()) {
    lastUiPoll = Date.now();
    log('Đã đưa cửa sổ giao diện đang mở lên trước (không mở thêm cửa sổ).');
    return;
  }
  relaunchUi();
}

// ---- System Tray: PowerShell NotifyIcon (không native module, vẫn portable, không cần cài đặt) ----
function trayIconPath() {
  // Icon phải là file THẬT trên đĩa: tiến trình PowerShell bên ngoài không đọc được đường dẫn
  // trong snapshot của pkg (/snapshot/...), nên chỉ xét icon cạnh EXE — build copy resources/icon.ico
  // ra cạnh EXE (xem tools/build-app.cjs); bộ cài NSIS đặt tên khác là CN-Tax-Tools.ico.
  // Không có thì dùng icon mặc định của Windows.
  for (const file of [path.join(appDir, 'icon.ico'), path.join(appDir, 'CN-Tax-Tools.ico'), path.join(appDir, 'resources', 'icon.ico')]) {
    try { if (fs.existsSync(file)) return file; } catch { /* bỏ qua */ }
  }
  return '';
}

function trayScript(port) {
  const icon = trayIconPath();
  const quote = value => String(value).replace(/'/g, "''");
  const trayLog = quote(path.join(dataDir, 'tray.log'));
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    `$logPath = '${trayLog}'`,
    `$base = 'http://127.0.0.1:${port}'`,
    `$cookie = 'hd_session=${sessionSecret}'`,
    "function Write-TrayLog([string]$m) { try { Add-Content -LiteralPath $logPath -Value ('[' + (Get-Date -Format 'dd/MM/yyyy HH:mm:ss') + '] ' + $m) -Encoding UTF8 } catch { } }",
    // Gọi endpoint bằng .NET HttpWebRequest, KHÔNG dùng Invoke-WebRequest: PowerShell 5.1 không gửi
    // header Cookie truyền qua -Headers (đã kiểm chứng: /api/ping trả 403 ⇒ helper tự thoát sau ~0,4 giây
    // và icon khay hiện rồi biến mất). Proxy = $null để không phụ thuộc proxy của máy.
    'function Invoke-App([string]$path, [string]$method) {',
    '  try {',
    '    $request = [System.Net.WebRequest]::Create($base + $path)',
    '    $request.Method = $method',
    '    $request.Proxy = $null',
    '    $request.Timeout = 5000',
    "    $request.Headers.Add('Cookie', $cookie)",
    '    $response = $request.GetResponse()',
    '    $code = [int]$response.StatusCode',
    '    $response.Close()',
    '    return ($code -ge 200 -and $code -lt 300)',
    '  } catch { Write-TrayLog ("goi " + $path + " loi: " + $_.Exception.Message); return $false }',
    '}',
    'function Test-App { return (Invoke-App "/api/ping" "GET") }',
    '$notify = New-Object System.Windows.Forms.NotifyIcon',
    icon ? `$notify.Icon = New-Object System.Drawing.Icon('${quote(icon)}')` : '$notify.Icon = [System.Drawing.SystemIcons]::Application',
    "$notify.Text = 'Công cụ Thuế - Kế Toán CN'",
    '$notify.Visible = $true',
    '$menu = New-Object System.Windows.Forms.ContextMenuStrip',
    "$showItem = $menu.Items.Add('Mở ứng dụng')",
    "$quitItem = $menu.Items.Add('Thoát hoàn toàn')",
    "$showItem.add_Click({ Invoke-App '/api/window/show' 'POST' | Out-Null })",
    "$quitItem.add_Click({ $script:quit = $true; Invoke-App '/api/app/quit' 'POST' | Out-Null })",
    '$notify.ContextMenuStrip = $menu',
    "$notify.add_MouseClick({ param($sender, $eventArgs) if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-App '/api/window/show' 'POST' | Out-Null } })",
    icon ? `Write-TrayLog 'icon khay da hien (icon rieng: ${icon})'` : "Write-TrayLog 'icon khay da hien (icon mac dinh cua Windows)'",
    // Windows ẩn icon khay mới trong khay: nháy bong bóng một lần để người dùng biết app vẫn chạy nền.
    "try { $notify.ShowBalloonTip(4000, 'Công cụ Thuế - Kế Toán CN', 'Ứng dụng vẫn chạy nền. Bấm icon khay để mở lại, bấm chuột phải để Thoát hoàn toàn.', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }",
    '$script:quit = $false',
    '$fails = 0',
    'while (-not $script:quit) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    // Chỉ tự đóng khi ứng dụng mất hẳn (20 lần liên tiếp ≈ 15 giây), không đóng vì một lần lỗi mạng.
    '  if (Test-App) { $fails = 0 } else { $fails = $fails + 1; if ($fails -ge 20) { Write-TrayLog "ung dung khong phan hoi 20 lan lien tiep - dong icon khay"; break } }',
    '  Start-Sleep -Milliseconds 700',
    '}',
    'Write-TrayLog "dong icon khay"',
    '$notify.Visible = $false',
    '$notify.Dispose()',
  ].join('\n');
}

function trayAlive() { return !!(trayProcess && !trayProcess.killed && trayProcess.exitCode === null); }

function ensureTray() {
  if (process.platform !== 'win32') return null;
  superviseTray();
  if (trayAlive()) return trayProcess;
  if (Date.now() < trayNextTry) return null;
  trayNextTry = Date.now() + 15000;
  try {
    const encoded = Buffer.from(trayScript(server.address().port), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    trayProcess = child;
    child.on('error', error => { if (trayProcess === child) trayProcess = null; log('Không mở được icon khay: ' + error.message); });
    child.on('exit', () => { if (trayProcess === child) trayProcess = null; });
    // Chỉ báo thành công SAU KHI kiểm chứng helper còn sống. Trước đây log ghi ngay sau spawn nên
    // báo "đã hiện icon khay" trong khi helper đã thoát vì lỗi — log không đúng sự thật.
    setTimeout(() => {
      if (trayProcess === child && child.exitCode === null) {
        trayFailCount = 0;
        log('Đã hiện icon khay hệ thống (trái: mở ứng dụng · phải: Mở ứng dụng / Thoát hoàn toàn).');
      } else {
        trayFailCount += 1;
        trayNextTry = Date.now() + Math.min(300000, 15000 * trayFailCount);
        log(`Icon khay không khởi động được (mã ${child.exitCode}). Chi tiết: ${path.join(dataDir, 'tray.log')}`);
      }
    }, 2500).unref();
    return child;
  } catch (error) {
    trayFailCount += 1;
    trayNextTry = Date.now() + Math.min(300000, 15000 * trayFailCount);
    log('Không mở được icon khay: ' + (error && error.message ? error.message : error));
    return null;
  }
}

// Icon khay tự phục hồi: helper chết trong khi ứng dụng vẫn chạy thì dựng lại (chờ lâu dần nếu lỗi liên tục).
function superviseTray() {
  if (process.platform !== 'win32' || trayBusy) return trayBusy;
  trayBusy = setInterval(() => { try { ensureTray(); } catch { /* ensureTray đã ghi log */ } }, 20000);
  trayBusy.unref();
  return trayBusy;
}

function stopTray() {
  if (trayBusy) { clearInterval(trayBusy); trayBusy = null; }
  if (!trayProcess) return;
  const child = trayProcess;
  trayProcess = null;
  try { child.kill(); } catch { /* đã thoát */ }
}

// Cửa sổ app là cửa sổ Chrome (--app) nên app KHÔNG thể chặn nút X. Vì vậy: cửa sổ đóng ⇒
// ứng dụng VẪN CHẠY NỀN + hiện icon System Tray để mở lại (không thoát).
// Chỉ thoát khi người dùng chọn "Thoát hoàn toàn" trong khay, hoặc nhận SIGINT/SIGTERM.
function watchUi() {
  // Chrome có thể kết thúc tiến trình khởi chạy sớm (bàn giao cho instance khác), nên chỉ coi là
  // "đã đóng cửa sổ" khi giao diện ĐÃ ngừng gọi /api/state.
  uiProcess.once('exit', () => setTimeout(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 8000) {
      log('Cửa sổ giao diện đã đóng — ứng dụng vẫn chạy nền trong khay hệ thống. Bấm icon khay để mở lại.');
      ensureTray();
    } else log('Tiến trình khởi chạy Chrome đã kết thúc nhưng giao diện vẫn phản hồi — tiếp tục chạy.');
  }, 10000));
  const timer = setInterval(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 150000 && !uiSilentLogged) {
      uiSilentLogged = true;
      log('Giao diện không phản hồi trong 2,5 phút — vẫn giữ ứng dụng chạy nền (không thoát). Bấm icon khay để mở lại.');
      ensureTray();
    }
  }, 30000);
  timer.unref();
}
let uiSilentLogged = false;
function launchUi(port) {
  const executablePath = browserPath(); if (!executablePath) throw new Error('Không tìm thấy Google Chrome hoặc Microsoft Edge.');
  const url = `http://127.0.0.1:${port}/?launch=${sessionSecret}`;
  // --disable-features=Translate,TranslateUI: tắt bong bóng "Translate this page?" của Chrome trên
  // cửa sổ --app (bong bóng đó hiện như một cửa sổ phụ, làm rối việc đếm/điều khiển cửa sổ app).
  uiProcess = spawn(executablePath, [`--app=${url}`, `--user-data-dir=${path.join(dataDir, 'ui-browser')}`, '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,TranslateUI'], { detached: true, stdio: 'ignore' }); uiProcess.unref();
  log(`Đã mở giao diện: ${url}`);
  // Chỉ gắn bộ theo dõi MỘT lần: mở lại cửa sổ (từ khay) không được tạo thêm interval.
  if (!uiWatchStarted) { uiWatchStarted = true; watchUi(); }
}
let uiWatchStarted = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const host = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== host) return reply(res, 403, { ok: false, error: 'Host không hợp lệ.' });
  if (url.pathname === '/' && url.searchParams.get('launch') === sessionSecret) {
    res.writeHead(302, { Location: '/', 'Set-Cookie': `hd_session=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); return res.end();
  }
  if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Phiên giao diện đã cũ. Mở lại EXE để tiếp tục.' });
  if (url.pathname === '/') return staticFile(res, 'index.html', 'text/html; charset=utf-8');
  // Favicon: Chrome lấy làm icon cửa sổ --app (taskbar / Alt-Tab / icon ghim).
  if (url.pathname === '/icon.png') return staticFile(res, 'icon.png', 'image/png');
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
  if (url.pathname === '/data-ui.js') return staticFile(res, 'data-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/data-view.css') return staticFile(res, 'data-view.css', 'text/css; charset=utf-8');
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
      if (page.status !== 200 || !page.body.includes('CN Tax Tools') || state.status !== 200 || JSON.parse(state.body).ok !== true) throw new Error('Giao diện hoặc API localhost không phản hồi đúng.');
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
  else if (testServer && process.argv.includes('--startup-check')) {
    // Kiểm chứng trong EXE: chạy đúng phần “khởi động nền” rồi thoát.
    autoStartBackground()
      .then(summary => { console.log(JSON.stringify(summary)); server.close(() => process.exit(0)); })
      .catch(error => { console.error(String(error && error.message ? error.message : error)); server.close(() => process.exit(1)); });
  }
  else if (testServer) console.log(JSON.stringify({ testUrl: `http://127.0.0.1:${port}/?launch=${sessionSecret}`, packed }));
  else {
    log(`Khởi động CN Tax Tools (${packed ? 'EXE' : 'node'}) · dữ liệu: ${dataDir} · cổng ${port}`);
    // Một instance duy nhất: bản mở sau chỉ nhờ bản cũ mở lại cửa sổ rồi thoát.
    claimSingleInstance(port).then(keepAlive => {
      if (!keepAlive) { server.close(() => process.exit(0)); return; }
      try { launchUi(port); ensureTray(); } catch (error) { reportFatal(error.message); stop(); return; }
      // Sau khi cửa sổ đã mở: tự làm mới phiên + tự dò hoá đơn mới, chạy nền. Không chặn UI.
      setTimeout(() => { autoStartBackground(); }, 3000);
    }).catch(error => log('Khởi động lỗi: ' + (error && error.message ? error.message : error)));
  }
});
// Đóng cửa sổ giao diện của CHÍNH app này (Chrome/Edge --app, profile ui-browser của app).
// Cần cho "Thoát hoàn toàn": (1) yêu cầu là phải đóng các cửa sổ, và (2) cửa sổ còn mở giữ kết nối
// keep-alive ⇒ server.close() không bao giờ gọi callback ⇒ tiến trình treo, không thoát hẳn.
// Chỉ đụng tiến trình mang profile dưới du_lieu của app — KHÔNG ảnh hưởng Chrome cá nhân.
function closeUiWindows() {
  try { if (uiProcess && !uiProcess.killed) uiProcess.kill(); } catch { /* đã đóng */ }
  try {
    const profile = path.join(dataDir, 'ui-browser').replace(/'/g, "''");
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true }, () => {});
  } catch { /* bỏ qua */ }
}

// Thoát THẬT: đóng tray, xoá file instance, dừng luồng nền, đóng cửa sổ + trình duyệt rồi thoát tiến trình.
// Đây vẫn là đường thoát duy nhất — /api/app/quit và SIGINT/SIGTERM đều gọi hàm này.
async function stop() {
  if (engine?.busy) engine.pause();
  stopTray();
  removeInstanceFile();
  stopSupportStream();
  closeUiWindows();
  await browser.close();
  log('Đã thoát chương trình.');
  // Trần 3 giây: còn kết nối đang mở làm server.close() không bao giờ kết thúc thì vẫn phải thoát hẳn.
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  server.close(() => { clearTimeout(force); process.exit(0); });
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
