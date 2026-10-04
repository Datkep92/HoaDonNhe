'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { URL } = require('node:url');
const { Engine, atomicWrite, validateParams, canReuseSearch, sameDownloadParams, companyNameFromItems, isResumableJob, classifyDownloadError } = require('./core');
const { TaxBrowser, browserPath, jwtAccount } = require('./browser');
const tct = require('./tct-api');
const loginAuto = require('./login-auto');
const mstFormat = require('./mst-format');
const vnDate = require('./vn-date');
// Hai module này THUẦN (không node:sqlite, không mạng) nên require thẳng được, không phá
// quy tắc nạp lười tầng dữ liệu ở dưới.
const syncWindow = require('./data/sync-window');
const { createSyncScheduler, dailySyncState } = require('./data/sync-scheduler');
const { planCatchup, createCatchupJob, catchupGateReason, pickCatchupTargets, catchupCacheKey } = require('./data/backfill-catchup');
const outputLock = require('./data/output-lock');
const { createSyncPool } = require('./data/sync-pool');
// Quét lần đầu cho MST mới thêm (10 ngày gần nhất). Module THUẦN – quyết định chạy/không chạy và
// cửa sổ ngày nằm cả ở đó để test được mà không phải dựng server (tests/first-scan.test.js).
const firstScan = require('./first-scan');
// Xuất Excel CHẠY TRONG WORKER THREAD (src/excel-worker.js): gói SheetJS nặng, dựng workbook tới
// nghìn dòng làm vòng lặp sự kiện khựng lại – đúng lúc UI đang poll. Lỗi worker tự rơi về đường
// đỒng bộ trong luỒng chính, vẫn xuất được file (chỉ là chậm hơn một chút).
const { buildExcelBuffer } = require('./excel-worker');
const { ensureFolder } = require('./folders');
const { SupportStore } = require('./support');
const { AppLockStore } = require('./app-lock');
const VERSION = require('./version');
const { checkUpdate } = require('./update-check');
const { Updater, applySelfUpdate, cleanupUpdateTemp } = require('./updater');
const autostart = require('./autostart');

// ---------------------------------------------------------------------------
// SELF-UPDATE: bản MỚI được khởi động với `--apply-update` để thay chính file đang chạy
// rỒi mở lại. Phải xử lý TRƯỚC khi chạm tới dữ liệu người dùng (du_lieu, secrets, Chrome…).
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
// Local packaging checks must not contact the gateway or start its stream.
const localSelfCheck = process.argv.includes('--smoke-test') || process.argv.includes('--ocr-check');
const dataDir = testServer && process.env.HOADON_TEST_DATA ? path.resolve(process.env.HOADON_TEST_DATA) : path.join(appDir, 'du_lieu');
// PHASE 1 ‒ Data Core: tự kiểm tra tầng dữ liệu (node:sqlite + schema + repository) rỒi thoát.
// Dùng để xác minh BÊN TRONG EXE đã đóng gói:  CN-Tax-Tools.exe --data-core-check
// Chỉ làm việc trong thư mục tạm của hệ điều hành, không ghi vào du_lieu, không gọi mạng.
if (process.argv.includes('--data-core-check')) {
  console.log(JSON.stringify(require('./data/self-check').runSelfCheck()));
  process.exit(0);
}
// PHASE 2 ‒ XML Data Engine: quét XML đã tải về và ghi vào data.db của MST.
//   CN-Tax-Tools.exe --data-import "<thư mục lưu>" <MST>
// Chỉ đọc/ghi trong thư mục lưu của người dùng, không gọi mạng, không đụng luỒng tải.
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
// Ghi vào du_lieu/nhat-ky.log rỒi hiện hộp thoại để không còn cảnh "bấm EXE mà không thấy gì".
process.on('uncaughtException', error => {
  reportFatal(error && error.message ? error.message : String(error));
  setTimeout(() => process.exit(1), 1500); // chờ hộp thoại kịp hiện
});
// Mở app: MỘT lần gọi /v1/sync lấy về bản quyền + thông báo + token phiên.
// Trước đây là register() rỒi notice() thành hai chuyến vào Apps Script.
// sync() trả Promise nên bọc Promise.resolve để không chết ở bước khởi động.
if (!localSelfCheck) Promise.resolve(support.sync('mo-app')).catch(error => { log('Không đỒng bộ được lúc mở app: ' + (error && error.message ? error.message : String(error))); })
  .then(() => { ensureSupportStream(); startSupportChecks(); });

// ---- KIỂM TRA ĐỊNH KỲ KHI APP CHẠY NỀN ----------------------------------
// KHÓNG polling theo đỒng hỒ cứng. Mỗi nhịp (4 giờ, có chênh lệch riêng cho từng
// máy) app tự hỏi xem có DẤU HIỆU nào cần hỏi máy chủ không (needsServerCheck):
// key sắp hết hạn, chưa hỏi bao giờ, hoặc mã máy bị lệch. Không có dấu hiệu thì
// không gọi mạng. Có thì hỏi nhẹ qua /v1/ping – chỉ đọc Firebase, không tốn
// quota Google Apps Script. Nhịp được rải theo mã máy để không dỒn 1 lúc.
let supportCheckTimer = null;
let presenceTimer = null;
function nextSupportCheckDelay() {
  const base = 4 * 60 * 60 * 1000;
  const seed = crypto.createHash('sha256').update(String(support.data.device.machineId || '')).digest();
  return base - 30 * 60 * 1000 + (seed.readUInt32BE(0) % (60 * 60 * 1000));
}

// ---- NHỊP SỐNG: GIỮ "ĐANG MỞ APP" ĐÚNH TRONG TELEGRAM -----------------------
//
// Vì sao TÁCH khỏi nhịp kiểm tra bản quyền: nhịp 4 giờ chỉ gọi /v1/ping khi
// needsServerCheck() có lý do. Key còn hạn + mã máy khớp ⇒ 4 giờ không gọi gì cả.
// Gateway đọc mốc lastSeen, hết 15 phút là báo khách offline – trong khi app đang
// chạy. Đó là lý do "chạy nền vẫn phải tính là online" bị sai.
//
// Nhịp này luôn gửi, không điều kiện: /v1/ping chỉ đọc/ghi Firebase, KHÓNG gọi Apps
// Script nên không tốn quota. 10 phút nhịp với cửa sổ 15 phút ⇒ hệ số an toàn 1,5,
// đủ để một nhịp trễ (máy ngủ, mạng chập chờn) không khiến khách bị báo offline.
//
// Rải pha theo mã máy để nhiều máy không cùng gửi đúng một giây.
function nextPresenceDelay() {
  const base = 10 * 60 * 1000;
  const seed = crypto.createHash('sha256').update('presence|' + String(support.data.device.machineId || '')).digest();
  return base - 60 * 1000 + (seed.readUInt32BE(0) % (2 * 60 * 1000));
}
function startPresenceHeartbeat() {
  if (presenceTimer) return;
  const run = async () => {
    try { await support.ping('nhip-song'); }
    catch (error) { log('Gửi nhịp sống lỗi: ' + (error && error.message ? error.message : String(error))); }
    presenceTimer = setTimeout(run, nextPresenceDelay());
    if (presenceTimer.unref) presenceTimer.unref();
  };
  presenceTimer = setTimeout(run, nextPresenceDelay());
  if (presenceTimer.unref) presenceTimer.unref();
}

function startSupportChecks() {
  if (supportCheckTimer) return;
  const run = async () => {
    try {
      const reason = support.needsServerCheck();
      if (reason) {
        await support.ping(reason);
        const license = support.publicLicense();
        log('Kiểm tra nền (' + reason + '): ' + license.status + (license.expiryAt ? ' – hạn ' + license.expiryAt : ''));
      }
    } catch (error) {
      log('Kiểm tra nền lỗi: ' + (error && error.message ? error.message : String(error)));
    }
    supportCheckTimer = setTimeout(run, nextSupportCheckDelay());
    if (supportCheckTimer.unref) supportCheckTimer.unref();
  };
  supportCheckTimer = setTimeout(run, nextSupportCheckDelay());
  if (supportCheckTimer.unref) supportCheckTimer.unref();
  startPresenceHeartbeat();
}
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
  && !localSelfCheck && (!testServer || process.env.HOADON_FORCE_UPDATE_CHECK === '1');
if (updateCheckEnabled) updater.check().catch(() => {});
// Dọn thư mục tạm của lần tự cập nhật trước (file đang bị khoá sẽ được dọn ở lần mở sau).
cleanupUpdateTemp();
let lastUiPoll = 0;
let accounts = loadJson(accountsFile, { accounts: [], selected: '' });
// MỐC "THIẾT BỊ BẮT ĐẦU HOẠT ĐỘNG": ghi một lần khi chạy app lần đầu, rỒi giữ nguyên.
// Là điểm bắt đầu cho phần quét bù lịch sử (xem backfill-catchup.js) – máy đã dùng trước khi có
// trường này thì lấy thêm ngày hoá đơn cũ nhất trong kho, xem catchupStartFor().
if (accounts && typeof accounts === 'object' && !accounts.firstRunAt) {
  accounts.firstRunAt = new Date().toISOString();
  saveAccounts();
}
let engine = null;
const engines = new Map();
// Tầng dữ liệu SQLite chỉ nạp khi thật sự dùng tới, để các phần khác của app vẫn chạy được
// kể cả khi môi trường không có node:sqlite (Node < 22).
function dataLayer() {
  try { return require('./data'); }
  catch (error) { throw new Error(`Không nạp được tầng dữ liệu SQLite (cần Node 22 trở lên): ${error.message}`); }
}
// Đối chiếu hỏng thì PHẢI có dấu vết. `reconcile()`/`forceReconcile()` nuốt lỗi để một lỗi ở
// lớp phụ không làm hỏng cả lượt nhập – nhưng nuốt im lặng thì kho cứ để trạng thái NULL và
// giao diện hiện số 0 như thể đã chạy. Nối reporter để lỗi được ghi ra nhật ký.
try {
  dataLayer().reconciliation.setErrorReporter((where, error) => {
    log(`Đối chiếu ngân hàng lỗi (${where}): ${(error && error.message) || error}`);
  });
} catch { /* môi trường không có node:sqlite thì chưa cần đối chiếu */ }
// ---- PHASE 4: AUTO SYNC (§23‒§28, §66) ----------------------------------------------------
// Bộ điều phối ở src/data/auto-sync.js; phần “việc thật” (tra cứu, tải, nhập) ở dưới.
// MỖI MST MỘT BỘ ĐIỀU PHỐI RIÊNG (`autoSyncByMst`). Nhờ vậy Auto Sync của MST này KHÓNG chặn
// MST khác: mỗi dòng trong danh sách là một luỒng độc lập, bấm play MST B trong lúc MST A đang chạy
// vẫn được. Trước đây chỉ có MỘT instance + một biến `autoSyncTarget` toàn cục nên chỉ chạy được
// một MST tại một thời điểm.
const autoSyncByMst = new Map();
function autoSyncFor(mst) {
  const key = String(mst || selected || '').trim();
  if (!key) return null;
  let instance = autoSyncByMst.get(key);
  if (instance) return instance;
  const { createAutoSync } = require('./data/auto-sync');
  instance = createAutoSync({
    // sync.json nằm trong vùng dữ liệu CỦA MST NÀY (mục 4/§28).
    syncFile: () => (key && output ? path.join(dataLayer().mst.mstDirectory(output, key), 'sync.json') : ''),
    // Chỉ nhường khi CHÍNH lượt tải thủ công của MST này đang bận – không nhường vì MST khác.
    manualBusy: () => !!engineFor(key)?.busy,
    // Hai hướng chạy SONG SONG khi MST này đã có token lưu: lúc đó mọi request đi qua
    // tct.request bằng chính phiên của MST này (kho cookie đã tách theo MST).
    // Chưa có token thì phải qua cửa sổ Chrome (một cửa sổ dùng chung) ⇒ chạy tuần tự cho an toàn.
    // Tắt bằng HOADON_AUTOSYNC_PARALLEL=0.
    parallel: () => process.env.HOADON_AUTOSYNC_PARALLEL !== '0' && directTokens.has(key),
    log,
    runDirection: ({ direction, days }) => runAutoSyncDirection({ direction, days, mst: key }),
  });
  // KHÓNG gọi schedule(): từ 1.0.2 Auto Sync chỉ chạy khi người dùng bấm nút trên dòng MST.
  autoSyncByMst.set(key, instance);
  return instance;
}
// Tương thích: bộ điều phối của MST đang chọn.
function autoSync() { return autoSyncFor(selected); }
// Có bất kỳ MST nào đang chạy Auto Sync không (dùng cho bộ theo dõi XML tạm nhường).
function anyAutoSyncRunning() { for (const one of autoSyncByMst.values()) if (one.running) return true; return false; }
// Ảnh chụp lượt Auto Sync ĐANG CHẠY của một MST, để giao diện "Tra cứu & tải" hiện trực quan:
// cấu hình (khoảng ngày, mua/bán) + danh sách hoá đơn đang tải. Lấy từ chính Engine đang chạy nên
// số liệu khớp với banner. Ưu tiên hướng đang tải hơn hướng đang tra cứu; gộp cả hai nếu chạy song song.
function autoSyncPreview(mst) {
  const engines = [...autoSyncEngines].filter(one => one.job && one.job.account && one.job.account.mst === mst);
  if (!engines.length) return null;
  const rank = one => (one.job.phase === 'download' ? 0 : 1);
  const chosen = engines.slice().sort((a, b) => rank(a) - rank(b))[0];
  const shots = engines.map(one => one.snapshot());
  const items = shots.flatMap(shot => shot.items || []).slice(0, 300);
  return {
    params: chosen.job.params || null,
    directions: shots.map(shot => (shot.params || {}).direction).filter(Boolean),
    state: chosen.job.state || '',
    message: chosen.job.message || '',
    stats: chosen.job.stats || {},
    items,
  };
}
async function runAutoSyncFor(mst, reason) {
  if (!safeMst(mst)) throw new Error('Chọn MST trước khi chạy Auto Sync.');
  const instance = autoSyncFor(mst);
  if (!instance) throw new Error('Chọn thư mục lưu trước khi chạy Auto Sync.');
  return instance.run(reason);
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

// `mst` cho phép chạy cho MỘT MST chỉ định (dùng cho quét bù nền – vốn không phụ thuộc MST
// người dùng đang xem). Không truyền thì giữ nguyên hành vi cũ: dùng MST đang chọn.
async function runBackfillRange({ direction, from, to, onProgress, isCancelled, mst: targetMst }) {
  const data = dataLayer();
  const mst = targetMst || selected;
  if (!mst) throw new Error('Chưa chọn MST.');
  if (!output) throw new Error('Chưa chọn thư mục lưu.');
  const { dir, db } = data.mst.ensureMst({ output, mst });
  let engine = null;
  try {
    // XML đã có trên đĩa mà DB thiếu ⇒ nhập trước, khỏi tải lại (mục 18/19 lớp 2).
    await data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir });
    engine = new Engine({
      store: path.join(dir, 'backfill-job.json'),
      request: async (route, action, check) => {
        check(); const token = directTokens.get(mst);
        if (!token) return browser.request(route, action, check);
        try { return await tct.request(token, route, action, mst, check.signal); }
        catch (error) { if (error.auth) forgetSession(mst); throw error; }
      },
      identity: () => (directTokens.has(mst) ? (tokenAccounts.get(mst) || authAccount) : browser.verify(mst)),
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
    // onlyFiles: như runAutoSyncDirection – chỉ nhập đúng các file vừa tải (engine biết chính xác).
    const justDownloaded = [...new Set(((engine.job && engine.job.items) || []).flatMap(item => item.files || []))].filter(name => String(name).toLowerCase().endsWith('.xml'));
    const after = await data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir, onlyFiles: justDownloaded, profileNames: profileNameList(mst, db) });
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
// Chỉ tải XML (không PDF/HTML/Excel) – mục 24/25 nói Auto Sync tải XML.
//
// Khi Mua vào và Bán ra chạy SONG SONG: hai lượt quét cùng mở một data.db nên phải xếp hàng
// (`withScanLock`) – SQLite chỉ cho một luỒng ghi tại một thời điểm (WAL) và ghi chỒng sẽ báo BUSY.
// Job tách theo hướng để hai engine không ghi chung một file tiến độ.
let scanChain = Promise.resolve();
function withScanLock(fn) {
  const next = scanChain.then(fn, fn);
  scanChain = next.then(() => {}, () => {});
  return next;
}
// Engine của các lượt Auto Sync đang chạy – để nút "Ngưng" gọi pause() được.
// Là một TẬP vì khi Mua vào và Bán ra chạy song song thì có HAI engine cùng lúc; dùng một biến
// đơn thì hướng này ghi đè hướng kia ⇒ bấm Ngưng chỉ dừng được một nửa.
const autoSyncEngines = new Set();

async function runAutoSyncDirection({ direction, days, mst: targetMst }) {
  const data = dataLayer();
  const mst = targetMst || selected;
  if (!mst) throw new Error('Chưa chọn MST.');
  if (!output) throw new Error('Chưa chọn thư mục lưu.');
  const { dir, db } = data.mst.ensureMst({ output, mst });
  // Khai báo NGOÀI try để khối finally dọn được: nếu đặt const trong try thì finally không thấy
  // biến nữa (lỗi thật đã gặp: "syncEngine is not defined" làm hỏng cả lượt Auto Sync).
  let syncEngine = null;
  try {
    // 1) XML đã có trên đĩa mà SQLite chưa có ⇒ nhập trước, khỏi tải lại (mục 18/19 lớp 2).
    await withScanLock(() => data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir, profileNames: profileNameList(mst, db) }));
    // 2) Tra cứu + tải phần còn thiếu.
    syncEngine = new Engine({
      store: path.join(dir, `autosync-job-${direction === 'BUY' ? 'buy' : 'sell'}.json`),
      request: async (route, action, check) => {
        check(); const token = directTokens.get(mst);
        if (!token) return browser.request(route, action, check);
        // Truyền mst làm phạm vi cookie: mỗi MST một kho riêng nên nhiều MST chạy song song
        // không gửi cookie lẫn nhau.
        try { return await tct.request(token, route, action, mst, check.signal); }
        catch (error) { if (error.auth) forgetSession(mst); throw error; }
      },
      identity: () => (directTokens.has(mst) ? (tokenAccounts.get(mst) || authAccount) : browser.verify(mst)),
      pdf: async () => { throw new Error('Auto Sync chỉ tải XML.'); },
      excel: makeExcel,
      emit: () => {},
      // Mục 19 lớp 1 / §86.7: hoá đơn đã có trong SQLite thì không tải lại.
      shouldSkip: async inv => !!data.repository.findInvoiceByKey(db, data.invoiceKey.buildInvoiceKey({
        mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon,
      })),
    });
    autoSyncEngines.add(syncEngine);
    // Bị bấm "Ngưng" thì Engine ném lỗi có cờ paused; đổi thành thông báo dễ hiểu để không bị
    // ghi vào sync.json như một lỗi thật.
    const stopNote = error => {
      if (error && error.paused) throw Object.assign(new Error('Đã ngưng theo yêu cầu.'), { paused: true });
      throw error;
    };
    // Cửa sổ "N ngày gần nhất" của Auto Sync tính theo NGÀY VIỆT NAM. Trước đây dùng
    // toISOString() của mốc giờ VN nên trong khoảng 00:00‒07:00 lại trả về ngày HÓM TRƯỚC.
    const iso = date => vnDate.dayOf(date) || '';
    const to = new Date();
    const from = new Date(Date.now() - (Math.max(1, Number(days) || 7) - 1) * 86400000);
    const params = {
      direction: direction === 'BUY' ? 'purchase' : 'sold',
      family: 'both', from: iso(from), to: iso(to), status: '', formats: ['xml'],
    };
    let found = 0;
    let stats = {};
    let after = { imported: 0, skipped: 0, errors: 0 };
    // Nghỉ ngắn trước khi thử lại, để không dội cổng thuế ngay sau khi vừa bị lỗi.
    const RETRY_FAILED_PAUSE_MS = 5000;
    try {
      await syncEngine.search(params, output);
      found = (syncEngine.job && syncEngine.job.items.length) || 0;
      await syncEngine.resume(true);
      // LỖI TẢI thường chỉ là tạm thời (mạng chập, cổng thuế bận). Thử lại NGAY MỘT LƯỢT, và chỉ
      // thử khi có hoá đơn lỗi thuộc loại còn thử được – hoá đơn XML hỏng thì thử lại cũng vô ích.
      // Không có bước này thì lỗi tải bị bỏ quên tới lượt sau, mà lượt sau là mai.
      const failedItems = () => ((syncEngine.job && syncEngine.job.items) || []).filter(item => item.state === 'failed');
      if (failedItems().some(item => item.retryable)) {
        log(`Auto Sync ${direction}: ${failedItems().length} hoá đơn lỗi tải – thử lại một lượt.`);
        await new Promise(resolve => setTimeout(resolve, RETRY_FAILED_PAUSE_MS));
        await syncEngine.retryFailed();
      }
      stats = (syncEngine.job && syncEngine.job.stats) || {};
    } catch (error) { stopNote(error); }
    // 3) Nhập XML vừa tải về (mục 22) – sau bước này data.db mới có dữ liệu mới.
    // Ngưng giữa chừng thì vẫn nhập những gì đã tải được, không bỏ phí công đã làm.
    // onlyFiles: chỉ nhập ĐÚNG các file engine vừa tải (item.files) thay vì quét lại toàn bộ kho –
    // file cũ đã được xử lý ở bước ① và giữa hai lần quét không ai ghi vào vùng này ngoài engine.
    // File đặt tay ngoài app vẫn được bắt ở lần quét ĐẦU lượt hoặc lượt kế tiếp.
    const justDownloaded = [...new Set(((syncEngine.job && syncEngine.job.items) || []).flatMap(item => item.files || []))].filter(name => String(name).toLowerCase().endsWith('.xml'));
    after = await withScanLock(() => data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir, onlyFiles: justDownloaded, profileNames: profileNameList(mst, db) }));
    return {
      found,
      downloaded: stats.downloaded || 0,
      skipped: (stats.skipped || 0) + (after.skipped || 0),
      imported: after.imported || 0,
      errors: after.errors || 0,
      // Lỗi TẢI (cổng thuế / mạng) SAU khi đã thử lại – khác `errors` là lỗi NHẬP XML.
      // Trước đây trường này bị bỏ sót nên lỗi tải không hiện ở log, sync.json hay kết quả bể.
      failed: stats.failed || 0,
    };
  } finally {
    if (syncEngine) autoSyncEngines.delete(syncEngine);
    data.sqlite.closeDatabase(db);
  }
}

// Sau khi người dùng tải xong (luỒng thủ công): tự nhập XML vào kho dữ liệu, chạy nền.
// Chỉ THÊM một bước sau lượt tải đã xong ⇒ không đổi hành vi tra cứu/tải (mục 12).
// Tên hỒ sơ để bộ nhập so "cùng một người" khi mã ghi trong XML khác MST hỒ sơ (một chủ có nhiều
// mã: MST + CCCD, MST chi nhánh…). GỒm account.name + tên đã có trong kho ở các dòng mà mã hỒ sơ là
// bên liên quan – hoá đơn nào đã nhập được thì tên người đó là chuẩn.
function profileNameList(mst, db) {
  const names = new Set();
  const account = accountFor(String(mst), true);
  if (account && account.name) names.add(String(account.name));
  try {
    if (output) {
      const dir = dataLayer().mst.mstDirectory(output, mst);
      const file = path.join(dir, 'data.db');
      if (fs.existsSync(file)) {
        const connection = db || readDatabase(file);
        const ids = accountIdentifiers(mst);
        if (ids.length) {
          const marks = ids.map(() => '?').join(',');
          for (const row of connection.prepare(
            `SELECT DISTINCT ten_mua AS ten FROM invoices WHERE mst_mua IN (${marks}) AND ten_mua IS NOT NULL AND ten_mua != ''
             UNION
             SELECT DISTINCT ten_ban AS ten FROM invoices WHERE mst_ban IN (${marks}) AND ten_ban IS NOT NULL AND ten_ban != ''`,
          ).all(...ids, ...ids)) {
            if (row && row.ten) names.add(String(row.ten));
          }
        }
      }
    }
  } catch { /* kho chưa có/chưa mở được – vẫn còn account.name để so */ }
  return [...names];
}

async function autoImportAfterDownload(label) {
  try {
    const data = dataLayer();
    if (!selected || !output) return;
    if (data.importJob.status().running) return;
    log(`Tự nhập XML vào kho dữ liệu sau khi ${label} (MST ${selected})…`);
    // profileNames: tên hỒ sơ để bộ nhập nhận diện hoá đơn thuộc hỒ sơ khi mã trong XML là mã
    // KHÁC MST hỒ sơ (một chủ có nhiều mã). Xem xml-scanner.js resolveOwnCode().
    data.importJob.start({ output, mst: selected, identifiers: accountIdentifiers(selected), profileNames: profileNameList(selected) })
      .then(result => {
        const own = result && result.ownCode;
        if (own) log(`Tự nhập: nhận diện mã ${own.code} là mã của hỒ sơ (${own.reason}, chiều ${own.direction}) → nhập lại ${own.files} file.`);
        else if (result && result.errors) log(`Tự nhập: còn ${result.errors} file chưa nhập được – xem ma-chua-xac-dinh.json trong thư mục MST.`);
      })
      .catch(error => log('Tự nhập dữ liệu lỗi: ' + (error && error.message ? error.message : error)));
  } catch (error) {
    log('Không tự nhập được vào kho dữ liệu: ' + (error && error.message ? error.message : error));
  }
}
// (Đã bỏ đường tự khôi phục phiên bằng Chrome ẩn lúc khởi động: trước đây app mở Chrome cho TỪNG
// MST để thử lấy lại phiên từ cookie. Từ 1.0.2 chỉ đọc token đã lưu; MST không có phiên sẵn thì bỏ
// qua, để người dùng bấm vào MST đó rỒi đăng nhập. Xem startupSessionCheck().)

// Lúc mở app: kiểm tra phiên của MỌI MST trong danh sách (để chấm màu đúng cho từng dòng).
//
// KHÓNG tự tra cứu, KHÓNG tự tải, KHÓNG tự Auto Sync – người dùng bấm nút trên dòng MST mới chạy.
// MST nào KHÓNG có phiên sẵn (phải đăng nhập lại / mất cookie) thì BỎ QUA ngay: chỉ đọc token đã
// lưu trên máy, KHÓNG mở Chrome ẩn để thử khôi phục – mở Chrome cho từng MST lúc khởi động rất chậm
// và dễ làm cổng thuế khó chịu. Người dùng bấm vào MST đó thì app mới mở form đăng nhập.
// ---- TỰ ĐĂNG NHẬP NỀN ------------------------------------------------------
//
// Mục tiêu: khi phiên một MST chết, tự đăng nhập lại bằng mật khẩu đã lưu mà
// KHÓNG mở hộp thoại và KHÓNG khoá giao diện. Người dùng vẫn chủ động bấm MST khi
// cần nhập tay.
//
// Vì sao phải tách `foregroundAuth` khỏi `authBusy`:
//   • authBusy = "đang đăng nhập MST này" → dùng CHẶN chạy trùng (server-side).
//   • foregroundAuth = "người dùng đang chờ kết quả lượt này" → dùng KHOÁ UI.
// Trước đây appState().authBusy lấy thẳng từ authBusy, nên một lần đăng nhập nền
// sẽ tắt luôn nút Tra cứu/Tải/resume – đúng cái người dùng không muốn.
//
// Vì sao có hạn số lần và thời gian chờ: mỗi lượt đăng nhập là một lần gọi cổng
// thuế. Sai mật khẩu mà cứ thử là dội cổng và có thể khiến tài khoản bị khoá.
// Hết lượt thì BỎ QUA hẳn và chờ người dùng đăng nhập tay.
//
// Vì sao chạy SONG SONG nhiều MST vẫn an toàn: cả hai hằng số này tính THEO TỪNG MST
// (móc trong `backgroundAuthFails`, khoá theo `mst`), nên 10 MST đăng nhập cùng lúc vẫn mỗi
// MST tự hạn mức riêng – không MST nào làm tăng lượt thử của MST khác. Phần chậm thật sự
// không phải số lần thử mà là thứ tự: trước đây chỉ login MST đang chọn, các MST còn lại
// phải chờ người dùng bấm tay.
const BACKGROUND_AUTH_COOLDOWN_MS = 30000;   // giữa hai lượt thử lỗi (giữ 30s – xem ghi chú)
const BACKGROUND_AUTH_MAX_ATTEMPTS = 3;      // hết số này thì thôi thử tự động
const backgroundAuth = new Set();            // MST đang tự đăng nhập nền
const backgroundAuthFails = new Map();       // mst -> { count, lastAt, reason }
const backgroundAuthTasks = new Map();       // mst -> promise lượt đang chạy (để request chờ được)

// Chờ lượt tự đăng nhập nền đang chạy cho MST này, có trần thời gian.
// Vì sao cần: nút Tra cứu/Tải KHÓNG bị khoá khi đăng nhập nền (đó là điều kiện để
// tính năng này không đóng băng giao diện). Nếu endpoint ném lỗi "đang tự đăng nhập"
// thì người dùng bấm nút hoạt động rỒi nhận lỗi – tệ hơn cả lúc khoá nút.
async function waitBackgroundAuth(mst) {
  const task = backgroundAuthTasks.get(mst);
  if (!task) return;
  // Trần 90s: đăng nhập tự động có thật sự bị treo thì không kéo dài vô hạn, và
  // người dùng vẫn nhận được thông báo rõ thay vì treo chờ.
  await Promise.race([task.catch(() => {}), new Promise(resolve => setTimeout(resolve, 90000))]);
}

function canAutoRelogin(mst) {
  if (testServer) return false;
  if (!mst) return false;
  if (!safeMst(mst) || !accountFor(mst)) return false;
  if (authBusy.has(mst) || foregroundAuth.has(mst) || backgroundAuth.has(mst)) return false;
  if (engineFor(mst)?.busy) return false;              // đang tra cứu, xen vào sẽ hỏng lượt
  if (!isRemembered(mst)) return false;                // không có mật khẩu thì không thể tự động
  const fails = backgroundAuthFails.get(mst);
  if (fails && fails.count >= BACKGROUND_AUTH_MAX_ATTEMPTS) return false;
  if (fails && Date.now() - fails.lastAt < BACKGROUND_AUTH_COOLDOWN_MS) return false;
  return true;
}

function noteBackgroundAuthFail(mst, reason) {
  const previous = backgroundAuthFails.get(mst) || { count: 0, lastAt: 0, reason: '' };
  const count = previous.count + 1;
  backgroundAuthFails.set(mst, { count, lastAt: Date.now(), reason: String(reason || '') });
  log(`Tự đăng nhập nền MST ${mst} không thành công (lần ${count}/${BACKGROUND_AUTH_MAX_ATTEMPTS}): ${reason}`
    + (count >= BACKGROUND_AUTH_MAX_ATTEMPTS ? ' – tạm dừng thử tự động, bấm MST để đăng nhập tay.' : ''));
}

// Chạy đăng nhập nền. KHÓNG await và KHÓNG ném lỗi ra ngoài: đây là việc phụ,
// người dùng đang bấm bấm cần phản hỒi ngay.
//
// Dùng `autoLoginFor` (KHÓNG đụng `selected` / `loginChallenge`) để NHIỀU MST chạy SONG SONG
// được. Bản cũ gọi `autoLoginAccount` vốn gọi `selectAccount(mst)` ⇒ mỗi lượt ghi đè biến
// `selected` toàn cục, vài lượt chạy song song sẽ giành nhau biến này và đổi MST đang xem của
// người dùng. Ở đây chỉ ghi trạng thái theo MST (directTokens/tokenAccounts đã tách sẵn).
function maybeAutoRelogin(mst, reason) {
  if (!canAutoRelogin(mst)) return null;
  backgroundAuth.add(mst);
  authBusy.add(mst);
  log(`Tự đăng nhập nền MST ${mst} (${reason}).`);
  // Giữ lại promise: endpoint Tra cứu/Tải phải CHỜ lượt này thay vì báo lỗi cho
  // người dùng. Nút không bị khoá (đó là điều kiện để đăng nhập nền không đóng băng
  // giao diện) nên bấm vào là phải chạy được, không phải để người dùng tự đoán.
  const task = autoLoginFor(mst, { remember: true })
    .then(result => {
      if (result && result.ok) {
        backgroundAuthFails.delete(mst);
        log(`Tự đăng nhập nền MST ${mst} thành công (${reason}) sau ${result.attempts || 1} lần thử.`);
        // Đăng nhập xong thì đỒng bộ ngầm luôn: dữ liệu sẵn sàng mà không cần bấm nút.
        const instance = autoSyncFor(mst);
        if (instance && !instance.running) {
          instance.run('auto-login').catch(() => { /* lỗi đã ghi vào sync.json */ });
        }
      } else {
        // Trả challenge thay vì ném lỗi ⇒ cần người dùng nhập tay.
        noteBackgroundAuthFail(mst, (result && result.error) || 'cần nhập CAPTCHA thủ công');
      }
      return result;
    })
    .catch(error => { noteBackgroundAuthFail(mst, (error && error.message) || String(error)); return null; })
    .finally(() => {
      backgroundAuth.delete(mst);
      authBusy.delete(mst);
      backgroundAuthTasks.delete(mst);
    });
  backgroundAuthTasks.set(mst, task);
  return task;
}

// ---- CồNG KIỂM TRA PHIÊN LÚC KHỞI ĐỘNG ------------------------------------
//
// Vì sao cần: kiểm tra phiên đọc token/cookie của mọi MST, tốn vài giây. Trước đây
// nó chạy ở giây thứ 3 và giao diện hiện "Đang kiểm tra phiên đăng nhập… Vui lòng
// chờ trong giây lát" cho tới khi xong – người dùng ngỒi nhìn màn hình trắng dù dữ
// liệu của họ đã có sẵn trên máy.
//
// Nay: giao diện vào thẳng bằng dữ liệu cục bộ, kiểm tra phiên chạy NỀN ngay khi mở app
// (SESSION_CHECK_DELAY_MS = 0) – yêu cầu: phiên phải sẵn sàng CÙNG LÚC mở ứng dụng, không
// phải chờ người dùng bấm rỒi mới có. Nơi thật sự cần phiên sống (bấm Tải hoá đơn) thì chờ đúng
// lần đang chạy qua ensureSessionCheck() ⇒ không bao giờ phải đăng nhập lại chỉ vì bấm nhanh.
//
// Vì sao trước đây có độ trễ 10s: đợi giao diện dựng xong. Nay việc đó đã tách riêng – đọc token
// hàng loạt chỉ spawn PowerShell, không chặn phần vẽ giao diện, nên chạy song song được.
const SESSION_CHECK_DELAY_MS = 0;
let sessionCheckPromise = null;
let sessionCheckFinished = false;

// Idempotent: gọi lại trong lúc đang chạy trả về ĐÚNG promise cũ, không dựng
// lần thứ hai (hai lần kiểm tra cùng lúc sẽ đè lên nhau trên engine).
function ensureSessionCheck() {
  if (testServer) return Promise.resolve(null);
  if (!sessionCheckPromise) {
    sessionCheckPromise = startupSessionCheck()
      .catch(error => ({ error: error && error.message ? error.message : String(error) }))
      .then(result => { sessionCheckFinished = true; return result; });
  }
  return sessionCheckPromise;
}

async function startupSessionCheck() {
  const summary = { checked: [], session: null, started: 0, skipped: 0, error: '' };
  const original = selected;
  try {
    const queue = activeAccounts().slice().sort((a, b) => (Number(b.lastUsedAt || b.lastVerifiedAt || 0) - Number(a.lastUsedAt || a.lastVerifiedAt || 0)));
    // Đọc token/cookie/MẬT KHẨU của MỌI MST trong MỘT lần giải mã. Đọc tuần tự sẽ spawn
    // PowerShell 2×N lần (mỗi lần ~500ms và chặn cứng event loop của cả server),
    // nên 7 MST là ~7 giây đứng hình – đúng lúc giao diện đang mở.
    //
    // Vì sao MẬT KHẨU nằm trong cùng lô: isRemembered() đọc riêng blob 'password' và
    // spawn PowerShell đỒng bộ ~500ms. Nó được gọi từ canAutoRelogin(), tức nằm trong
    // selectAccount() – lần đầu bấm MST sẽ đứng thêm nửa giây. Nạp sẵn ở đây thì lô
    // này không tốn thêm request (cùng một tiến trình PowerShell) và lần bấm đầu tiên
    // không còn độ trễ nào.
    let stored = new Map();
    try { stored = secrets.readMany(queue.map(item => item.mst), ['token', 'cookies', 'password']); }
    catch (error) { log('Giải mã phiên hàng loạt lỗi, chuyển sang đọc từng MST: ' + (error && error.message ? error.message : error)); }
    // Nạp sẵn cờ "đã nhớ mật khẩu" để isRemembered() không phải đọc lại từ đĩa.
    for (const [mst, value] of stored) if (!remembered.has(mst)) remembered.set(mst, !!value.password);
    for (const item of queue) {
      const mst = item.mst;
      let restored = false;
      try {
        const cached = stored.get(mst);
        restored = cached ? restoreSession(mst, cached) : restoreSession(mst);
      } catch { restored = false; }
      const row = { mst, ok: restored, reason: restored ? 'token đã lưu còn hiệu lực' : 'chưa có phiên – cần đăng nhập' };
      if (restored) { summary.started += 1; summary.session = summary.session || row; }
      else { summary.skipped += 1; }
      summary.checked.push(row);
      log(`Kiểm tra phiên MST ${mst}: ${row.reason}`);
    }
    log(`Kiểm tra phiên lúc khởi động: ${summary.started}/${summary.checked.length} MST có phiên sẵn.`);
    // Tự đăng nhập nền cho TẤT CẢ MST có mật khẩu đã lưu và phiên đã chết – SONG SONG.
    // Trước đây chỉ login MST đang chọn (`mst !== selected`), các MST khác phải chờ người
    // dùng bấm tay. Nay mỗi MST có kho cookie riêng (tct-api `jars`) nên chạy đỒng thời được.
    const needLogin = queue
      .filter(item => !directTokens.has(item.mst) && isRemembered(item.mst))
      .map(item => item.mst);
    if (needLogin.length) {
      log(`Tự đăng nhập nền song song cho ${needLogin.length} MST: ${needLogin.join(', ')}`);
      Promise.all(needLogin.map(mst => {
        const task = maybeAutoRelogin(mst, 'phiên hết hạn lúc khởi động');
        return task ? task.catch(() => {}) : Promise.resolve();
      })).catch(() => { /* mỗi MST tự ghi lỗi vào nhật ký */ });
    }
  } catch (error) {
    summary.error = error && error.message ? error.message : String(error);
    log('Kiểm tra phiên lúc khởi động lỗi: ' + summary.error);
  } finally {
    selected = original || selected;
    accounts.selected = selected;
    setCurrentEngine(selected);
    saveAccounts();
  }
  return summary;
}
let selected = accounts.selected || '';
let output = accounts.output || ''; // người dùng chọn; không tự đặt mặc định ngầm
// Kết quả TỰ GÁN theo tên gần nhất mỗi MST (afterScan chạy nền) – GET panel/UI đọc để thông báo.
const recentAutoAssign = new Map();
const xmlWatcher = dataLayer().xmlWatcher.createXmlWatcher({
  onChange: result => log(`XML MST ${result.mst}: nhập mới ${result.imported || 0}, cập nhật ${result.updated || 0}.`),
  // TỰ GÁN theo tên ngay sau mỗi lượt quét nền (không cần ai mở tab): mã lạ trùng tên hỒ sơ
  // (vd CCCD 058168004258 của cùng người MST 4500487170) tự vào định danh, lượt quét hẹn sẵn
  // (pendingRescan) nhập nốt. Kết quả gán gần nhất để GET panel/UI thông báo đúng lúc.
  afterScan: (mst, result) => {
    if (!result) return;
    // Mã đã được bộ nhập nhận diện theo bằng chứng chiều tra cứu + tên/số lượng (một chủ nhiều
    // mã) ⇒ GHI VÀO HỒ SƠ để những lượt sau nhận luôn, không phải nhận diện lại từ đầu.
    if (result.ownCode && result.ownCode.code) {
      const code = result.ownCode.code;
      const account = accountFor(mst);
      const occupied = new Set(accountIdentifiers(mst));
      let clash = '';
      for (const other of activeAccounts()) {
        if (other.mst === mst) continue;
        if (accountIdentifiers(other.mst).includes(code)) { clash = other.mst; break; }
      }
      if (account && !clash && !occupied.has(code)) {
        account.identifiers = cleanIdentifiers([...(account.identifiers || []), code]);
        saveAccounts();
        log(`MST ${mst}: gán mã ${code} vào hỒ sơ (${result.ownCode.reason}, chiều ${result.ownCode.direction}) – ${result.ownCode.files} file.`);
        recentAutoAssign.set(mst, { codes: [code], at: new Date().toISOString() });
      } else if (clash) {
        log(`MST ${mst}: KHÓNG gán mã ${code} vì đang thuộc hỒ sơ MST ${clash}.`);
      }
    }
    // Trước đây chỉ chạy khi có lỗi – lượt quét sạch thì bỏ qua, nên mã lạ còn sót không bao giờ
    // được tự gán. Giờ chạy luôn (rẻ: chỉ đọc ma-chua-xac-dinh.json và so tên trong bộ nhớ).
    if (!(result.errors || result.pendingRescan || result.ownCode)) return;
    const assigned = autoAssignByPersonName(mst);
    if (assigned.length) recentAutoAssign.set(mst, { codes: assigned, at: new Date().toISOString() });
  },
  onStatus: state => { if (state.error) log(`Theo dõi XML${state.mst ? ` MST ${state.mst}` : ''} lỗi: ${state.error}`); },
  shouldPause: mst => {
    const importing = dataLayer().importJob.status();
    return (importing.running && importing.mst === mst)
      || anyAutoSyncRunning()
      || catchupJob.running
      || !!(backfillJobInstance && backfillJobInstance.status().running);
  },
  identifiersFor: mst => accountIdentifiers(mst),
});
function configureXmlWatcher() {
  xmlWatcher.configure(output, activeAccounts().map(account => account.mst));
}
let uiProcess = null;
let trayProcess = null;
let trayRetryTimer = null;
let trayStopped = false;
let trayFailCount = 0;
let trayNextTry = 0;
const authBusy = new Set();
// authBusy = "đang có lượt đăng nhập chạy cho MST này" → CHẶN chạy trùng (phía server).
// foregroundAuth = "người dùng đang CHỜ kết quả lượt này" → mới được phép khoá UI.
// Tách hai cái ra là để đăng nhập NỀN không khoá giao diện. Xem maybeAutoRelogin().
const foregroundAuth = new Set();
// Các tác vụ DÀI đang chạy nền (fire-and-forget có sổ sách): app tắt ⇒ tạm dừng đúng lượt.
const detachedTasks = [];
let loginChallenge = null;
let authAccount = null;
const directTokens = new Map();
const tokenAccounts = new Map();

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveAccounts() { atomicWrite(accountsFile, JSON.stringify(accounts, null, 2)); }
function safeMst(mst) { return mstFormat.isValidMst(mst); }
function jobStore(mst) { return path.join(dataDir, 'jobs', `${mst}.json`); }
// Thư mục lưu MẶC ĐỊNH cho khách chưa chọn gì: Documents\CN-invoice của tài khoản Windows đang
// dùng. CHỈ áp cho đường THÊM MST (khách bỏ trống ô "Thư mục lưu" hoặc bấm Huỷ ở hộp chọn thư
// mục). Tab Tra cứu giữ nguyên chính sách cũ: `output` rỗng thì vẫn báo "Chọn thư mục lưu…".
function defaultOutputFolder() { return path.join(os.homedir(), 'Documents', 'CN-invoice'); }
// CHỐT AN TOÀN KHI ĐồI THƯ MỤC LƯU – dùng chung cho /api/folder và /api/account/save.
//
// Vì sao phải chặn ở SERVER chứ không chỉ ở giao diện: đổi thư mục lưu là app chuyển sang đọc
// `data.db` / hoá đơn ở chỗ khác, nên dữ liệu ĐÃ TẢI ở thư mục cũ KHÓNG còn hiện trong app (tab
// Tổng quan, Kho dữ liệu, Sao kê ngân hàng đều đọc thư mục mới). File không bị xoá, nhưng với
// người dùng thì như "mất sạch dữ liệu". Chỉ cần gõ nhầm một ký tự là dính, nên đổi thư mục BẮT
// BUỘC phải kèm xác nhận của người dùng (`confirm: true`) – giao diện hỏi trước rỒi mới gửi.
function assertFolderChangeAllowed(next, confirmed) {
  if (output && next && next !== output && confirmed !== true) {
    throw new Error(`Đang dùng thư mục "${output}". Đổi sang thư mục khác sẽ khiến hóa đơn và kho dữ liệu đã có ở thư mục đó KHÓNG còn hiện trong app (file không bị xoá) – cần xác nhận trước khi đổi.`);
  }
}
function engineFor(mst) { return mst ? engines.get(mst) || null : null; }
// Engine của ĐÚNG MST được yêu cầu. Mỗi MST một engine riêng trong `engines`, nên endpoint thủ công
// nhận `mst` để chạy đúng luỒng đó – không phụ thuộc việc người dùng đang xem MST nào.
function engineOf(mst) { return mst ? engineFor(mst) : engineFor(selected); }
// Lấy engine của MST, TẠO MỚI nếu chưa có.
//
// Vì sao cần: `engines` chỉ có phần tử sau khi createEngine() chạy, mà createEngine() trước đây
// chỉ được gọi khi bấm chọn MST / đăng nhập. Mở lại app thì `selected` lấy lại từ accounts.json
// và phiên được restoreSession() – nhưng KHÓNG engine nào tỒn tại. Bấm "Tải hoá đơn" ngay ⇒
// engineOf() trả null ⇒ toast "Chọn MST và kiểm tra phiên trước." dù người dùng đã bấm MST và
// phiên vốn còn. Endpoint tải phải tự dựng engine thay vì đòi người dùng bấm lại MST.
function ensureEngineFor(mst) {
  const wanted = String(mst || '').trim() || selected;
  if (!wanted) return null;
  if (!engines.has(wanted)) createEngine(wanted);
  return engineFor(wanted);
}
function setCurrentEngine(mst) { engine = engineFor(mst); return engine; }
// makeExcel giữ nguyên hợp đỒng cũ (items → Buffer xlsx) nên mọi caller không đổi; chỉ đổi NƠI dựng
// workbook: worker thread thay vì luỒng chính. Nhận kết quả là Buffer; worker trả Uint8Array → convert.
const makeExcel = items => Promise.resolve(buildExcelBuffer(items)).then(result => (Buffer.isBuffer(result) ? result : Buffer.from(result)));
function accountFor(mst, includeRemoved = false) { return accounts.accounts.find(x => x.mst === mst && (includeRemoved || !x.removedAt)) || null; }
function activeAccounts() { return accounts.accounts.filter(x => !x.removedAt); }
// Nhớ "MST của phiên làm việc gần nhất": mỗi lần người dùng chọn một dòng, `accounts.selected`
// được ghi ngay xuống du_lieu/accounts.json. Mở lại app là vào thẳng Tổng quan của khách hàng ấy
// và dòng đó được tô sáng sẵn trong danh sách.
// Nhưng dữ liệu lưu có thể CŨ: MST đã bị XOÁ khỏi danh sách (removedAt) hoặc không còn tỒn tại
// thì KHÓNG được mở vào một hỒ sơ "ma" (Tổng quan trống, sidebar không dòng nào sáng) – rơi về
// MST dùng gần nhất còn hoạt động và ghi lại lựa chọn đã sửa.
function mostRecentlyUsed(active = activeAccounts()) {
  return active.slice().sort((a, b) =>
    Number(b.lastUsedAt || b.lastVerifiedAt || 0) - Number(a.lastUsedAt || a.lastVerifiedAt || 0),
  )[0] || null;
}
function rememberSelectedMst() {
  if (accountFor(selected)) return selected;
  const fallback = mostRecentlyUsed();
  const previous = selected;
  selected = fallback ? fallback.mst : '';
  accounts.selected = selected;
  saveAccounts();
  if (previous || selected) log(`MST đã chọn "${previous || '(chưa chọn)'}" không còn trong danh sách – mở lại MST dùng gần nhất: ${selected || '(chưa có MST nào)'}.`);
  return selected;
}
rememberSelectedMst();
function cleanIdentifiers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}
function accountIdentifiers(mst) {
  const account = accountFor(String(mst), true);
  // GỒm CẢ MST gốc để XML (cổng thuế chỉ ghi MST gốc) vẫn khớp hỒ sơ có mã chi nhánh.
  return cleanIdentifiers([...mstFormat.mstAliases(mst), ...(account?.identifiers || [])]);
}
function saveIdentifiers(mst, values) {
  const account = accountFor(String(mst));
  if (!account) throw new Error('MST không còn trong danh sách.');
  const identifiers = cleanIdentifiers(values).filter(value => value !== account.mst);
  if (identifiers.some(value => !/^\d{6,20}$/.test(value))) throw new Error('CCCD/MST bổ sung chỉ gỒm 6‒20 chữ số.');
  for (const other of activeAccounts()) {
    if (other.mst === account.mst) continue;
    const occupied = new Set(accountIdentifiers(other.mst));
    const conflict = identifiers.find(value => occupied.has(value));
    if (conflict) throw new Error(`Mã ${conflict} đang thuộc hỒ sơ MST ${other.mst}.`);
  }
  account.identifiers = identifiers;
  saveAccounts();
  // Mã gán từ panel "Mã định danh chưa gán" (dù qua ô bổ sung hay nút Gán riêng) được đánh dấu
  // assigned để panel ngừng hỏi; quét lại được hẹn ở dưới nên XML UNKNOWN cũ tự nhập vào kho.
  try {
    if (output) {
      const dir = dataLayer().mst.mstDirectory(output, mst);
      const known = new Set(identifiers);
      for (const candidate of dataLayer().identityCandidates.listCandidates(dir)) {
        if (candidate.decided === 'assigned' && !known.has(candidate.code)) dataLayer().identityCandidates.setDecision(dir, candidate.code, '');
      }
    }
  } catch { /* chưa có thư mục/vùng MST thì bỏ qua – vết sẽ tự cập nhật ở lượt quét sau */ }
  xmlWatcher.schedule(account.mst);
  return publicAccount(account);
}
// Ghi cờ "hỒ sơ này đã đăng nhập bằng CCCD/MST bổ sung" (bài toán MST gốc ↓ CCCD của CÙNG một
// người). jwtAccount() trả mst lấy từ token; nếu nó không thuộc aliases của hỒ sơ nhưng TRÙNG
// một identifier đã khai báo ⇒ đó vẫn là người đúng, chỉ là hoá đơn do bên kia lập bằng CCCD.
// Chỉ ghi nhận, KHÓNG đổi hành vi đăng nhập: hỒ sơ vẫn đăng nhập bằng MST gốc như cũ.
function noteLoginIdentifier(mst) {
  try {
    const account = accountFor(String(mst));
    if (!account || !output) return;
    const known = new Set(accountIdentifiers(mst));
    const logged = [...known].find(code => code !== account.mst && /^\d{6,20}$/.test(code));
    if (!logged) return;
    const dir = dataLayer().mst.mstDirectory(output, mst);
    const candidates = dataLayer().identityCandidates.listCandidates(dir)
      .filter(candidate => known.has(candidate.code) && candidate.decided !== 'assigned');
    for (const candidate of candidates) dataLayer().identityCandidates.setDecision(dir, candidate.code, 'assigned', `login:${logged}`);
  } catch { /* vết phụ – không được làm lỗi luỒng đăng nhập */ }
}
// TỰ GÁN mã CÙNG MỘT NGƯỜI theo TÊN – hệ thống tự hiểu, người dùng không phải bấm.
// Ví dụ thật: hỒ sơ MST 4500487170 (HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN) có hoá đơn ghi người
// mua bằng CCCD 058168004258 cùng tên ⇒ so tên chuẩn hoá (bỏ dấu, bỏ "HỘ KINH DOANH"…) trùng
// thì gán luôn vào identifiers. Tên "của hỒ sơ" lấy từ: account.name (người dùng nhập) + TẤT
// CẢ tên xuất hiện trong kho ở các dòng mà mã hỒ sơ là bên liên quan (ten_mua WHERE mst_mua ∈
// định danh hỒ sơ, và ten_ban tương ứng) – hoá đơn nào đã nhập được thì tên người đó là chuẩn.
// db tuỳ chọn: có rỒi thì dùng (GET panel đã mở sẵn), không thì mở kết nối đọc qua readDatabase.
function autoAssignByPersonName(mst, db) {
  const data = dataLayer();
  const account = accountFor(String(mst));
  if (!account || !output) return [];
  const dir = data.mst.mstDirectory(output, mst);
  const pending = data.identityCandidates.listCandidates(dir)
    .filter(candidate => candidate.decided === '' && candidate.ownSide !== false && candidate.ten);
  if (!pending.length) return [];
  const selfNames = new Set(account.name ? [account.name] : []);
  try {
    // readDatabase là kết nối đọc DÙNG LẠI (đợt 3) – gọi thêm không tốn mở/đóng mới.
    if (!db) db = readDatabase(path.join(dir, 'data.db'));
    const ids = accountIdentifiers(mst);
    if (ids.length) {
      const marks = ids.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT DISTINCT ten_mua AS ten FROM invoices WHERE mst_mua IN (${marks}) AND ten_mua IS NOT NULL AND ten_mua != ''
         UNION
         SELECT DISTINCT ten_ban AS ten FROM invoices WHERE mst_ban IN (${marks}) AND ten_ban IS NOT NULL AND ten_ban != ''`,
      ).all(...ids, ...ids);
      for (const row of rows) selfNames.add(row.ten);
    }
  } catch { /* kho chưa có/chưa mở được – vẫn còn account.name để so */ }
  const assigned = [];
  for (const candidate of pending) {
    const match = [...selfNames].find(name => data.identityCandidates.samePersonName(candidate.ten, name));
    if (!match) continue;
    // Kiểm tra mã không thuộc hỒ sơ khác trước khi gán (như saveIdentifiers).
    const occupied = new Set(accountIdentifiers(mst));
    let clash = '';
    for (const other of activeAccounts()) {
      if (other.mst === mst) continue;
      if (accountIdentifiers(other.mst).includes(candidate.code)) { clash = other.mst; break; }
    }
    if (clash || occupied.has(candidate.code)) continue;
    account.identifiers = cleanIdentifiers([...(account.identifiers || []), candidate.code]);
    data.identityCandidates.setDecision(dir, candidate.code, 'assigned', `auto:${candidate.ten}`);
    assigned.push(candidate.code);
  }
  if (assigned.length) {
    saveAccounts();
    log(`Tự gán ${assigned.length} mã định danh trùng tên hỒ sơ MST ${mst}: ${assigned.join(', ')}.`);
    xmlWatcher.schedule(mst); // quét lại với định danh mới – các hoá đơn UNKNOWN cũ tự vào kho
  }
  return assigned;
}
// Saved portal session per MST (token + cookies + remembered password), kept on this machine
// only. This is what makes the next run "already logged in" like VNIT instead of asking for the
// CAPTCHA again. The password is only read when the login form leaves it empty.
const remembered = new Map();
function isRemembered(mst) {
  if (!remembered.has(mst)) remembered.set(mst, !!secrets.read(mst, ['password']).password);
  return remembered.get(mst);
}
function restoreSession(mst, preloaded) {
  if (directTokens.has(mst)) return true;
  // `preloaded` là dữ liệu đã giải mã sẵn từ readMany() – dùng để khỏi giải mã lại.
  const stored = preloaded || secrets.read(mst, ['token', 'cookies']);
  if (stored.cookies) tct.setCookies(stored.cookies, mst);
  const account = jwtAccount(stored.token);
  if (!account) { if (stored.token) secrets.clear(mst, ['token']); return false; }
  if (!account.mst && /^(\d{10}(?:-\d{3})?|\d{13})$/.test(account.label)) account.mst = account.label;
  // So theo MST GỐC: người dùng có thể lưu hỒ sơ là "8021214462-001" còn token/XML chỉ ghi
  // "8021214462" – so nguyên văn sẽ báo sai phiên và xoá token oan.
  if (account.mst && !mstFormat.mstAliases(mst).includes(String(account.mst))) { secrets.clear(mst, ['token']); return false; }
  directTokens.set(mst, stored.token); tokenAccounts.set(mst, account); authAccount = account;
  return true;
}
// Lưu phiên đăng nhập. `async` = ghi ra ĐĐỢI event loop rảnh: `protect()` spawn PowerShell
// ~500ms/blob và chặn cả server. Đăng nhập nền chạy N MST SONG SONG nên ghi đỒng bộ sẽ chặn
// ~500ms × N lần, làm giao diện poll 800ms đứng hình. Dữ liệu vẫn được ghi đầy đủ, chỉ không
// chặn request khác trong lúc đợi; khi app thoát, `stop()` gọi `flushWrites()` nên không mất gì.
function storeSession(mst, token, password, keep, async) {
  if (!token) { secrets.clear(mst, ['token', 'cookies']); sessionCache.set(mst, false); return; }
  // Cookie lưu theo ĐÚNG MST này – không lấy cookie của MST khác đang chạy song song.
  const patch = { token, cookies: tct.cookies(mst), ...(password ? { password: keep ? password : '' } : {}) };
  if (async) secrets.writeAsync(mst, patch); else secrets.write(mst, patch);
  remembered.set(mst, !!keep && !!password); sessionCache.set(mst, true);
}function forgetSession(mst) {
  directTokens.delete(mst); tokenAccounts.delete(mst); tct.clearCookies(mst); secrets.clear(mst, ['token', 'cookies']);
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
// Cache tóm tắt sync.json theo mtime: /api/state chạy mỗi 1,5 giây và trước đây đọc + parse file
// này cho TỪNG MST mỗi nhịp. File chỉ đổi khi Auto Sync ghi nên giữa hai lần ghi kết quả là như nhau.
const syncCache = new Map();
function invalidateSyncCache(mst) { if (mst) syncCache.delete(mst); else syncCache.clear(); }
function syncSummary(mst) {
  try {
    if (!output) return null;
    const data = dataLayer();
    const file = path.join(data.mst.mstDirectory(output, mst), 'sync.json');
    let stamp = 0;
    try { stamp = fs.statSync(file).mtimeMs; } catch { syncCache.delete(mst); }
    const cached = syncCache.get(mst);
    if (cached && cached.stamp === stamp) return cached.value;
    const state = data.mst.readSyncState(file);
    const instance = autoSyncByMst.get(mst) || null;
    const running = !!(instance && instance.running);
    const settings = state.settings || {};
    // Tiến độ SỐNG của lượt đang chạy (Engine riêng của Auto Sync) để dòng MST hiện banner:
    // đang tra cứu / đang tải x/y – người dùng nhìn danh sách là biết MST nào đang làm gì.
    const live = running ? [...autoSyncEngines].map(one => one.job).find(job => job && job.account && job.account.mst === mst) || null : null;
    // Ghép CẶP lỗi với ĐÚNG mốc thời gian của nó: lấy lỗi MỚI NHẤT trong hai hướng.
    // Trước đây lấy rời (buy.lastError || sell.lastError) và (buy.lastErrorTime || sell.lastErrorTime)
    // nên khi cả hai hướng cùng lỗi, banner có thể hiện lỗi của hướng này kèm giờ của hướng kia.
    const errorSide = [state.buy, state.sell]
      .filter(side => side.lastError)
      .sort((a, b) => String(b.lastErrorTime || '').localeCompare(String(a.lastErrorTime || '')))[0] || null;
    // Lượt thành công GẦN NHẤT, để banner "Xong …" mang đúng mốc của lần chạy cuối.
    const lastSuccess = [state.buy.lastSuccess, state.sell.lastSuccess].filter(Boolean).sort().pop() || '';
    // Trạng thái theo NGÀY: đã tải đủ dữ liệu (và phần còn thiếu) hôm nay hay chưa.
    const daily = dailySyncState(state, syncWindow.vnClock(new Date()));
    return {
      running,
      phase: running && instance ? instance.status().phase : '',
      buy: state.buy.status,
      sell: state.sell.status,
      buyFound: state.buy.found || 0,
      sellFound: state.sell.found || 0,
      buyDownloaded: state.buy.downloaded || 0,
      sellDownloaded: state.sell.downloaded || 0,
      lastSuccess,
      lastError: errorSide ? errorSide.lastError : '',
      lastErrorTime: errorSide ? errorSide.lastErrorTime || '' : '',
      // Đã đỒng bộ / chưa đỒng bộ hôm nay – UI hiện thẳng, bộ lập lịch dùng để bỏ qua.
      syncedToday: daily.synced,
      syncedAt: daily.at,
      missingToday: daily.missing,
      // Số hoá đơn LỖI TẢI của lượt gần nhất (cổng thuế / mạng) – khác `errors` là lỗi NHẬP XML.
      failedToday: (state.buy.failed || 0) + (state.sell.failed || 0),
      days: settings.days || 7,
      progress: live ? {
        phase: live.phase || '',
        queued: (live.items || []).length,
        downloaded: (live.stats && live.stats.downloaded) || 0,
        failed: (live.stats && live.stats.failed) || 0,
        message: live.message || '',
      } : null,
    };
    // Giá trị sống (phase/progress) KHÓNG cache: chỉ phần đọc từ sync.json mới được cache theo mtime.
    if (!running) syncCache.set(mst, { stamp, value });
    return value;
  } catch { return null; }
}
function publicAccount(account) {
  const mst = account.mst;
  return { mst, identifiers: cleanIdentifiers(account.identifiers), name: account.name || '', label: account.label || '', lastVerifiedAt: account.lastVerifiedAt || 0, lastUsedAt: account.lastUsedAt || 0, session: directTokens.has(mst) ? 'live' : (hasSavedSession(mst) ? 'saved' : 'none'), remembered: isRemembered(mst), autoLoginBlocked: (backgroundAuthFails.get(mst)?.count || 0) >= BACKGROUND_AUTH_MAX_ATTEMPTS, job: jobSummary(mst), sync: syncSummary(mst), catchup: catchupFor(mst) };
}
// ẢNH CHỤP DANH SÁCH MST CHO KHUNG HÌNH ĐẦU – "tô sáng MST phiên gần nhất ngay lập tức".
// Vì sao cần ĐƯỜNG RIÊNG chứ không chỉ localStorage: server mở cổng NGẪU NHIÊN mỗi lần chạy
// (`server.listen(0, ...)`), nên origin đổi từ `http://127.0.0.1:51234` sang `…:51877` sau mỗi
// lần mở app. localStorage khoá theo ORIGIN ⇒ cache ở đó KHÓNG BAO GIỜ đọc lại được giữa hai lần
// mở app. Cache phải đến từ CHÍNH máy chủ, nơi giữ `du_lieu/accounts.json`.
// Trả một file JS nhỏ, đỒng bộ, cùng origin nên hợp CSP `script-src 'self'`; nạp TRƯỚC renderer.js
// nên sidebar + dòng đang làm việc được vẽ ngay khung hình đầu, không chờ `/api/state` (1‒3 giây).
// CHỈ trường để vẽ dòng (mã, tên, nhãn, trạng thái phiên, mã định danh, đã ghi nhớ mật khẩu chưa)
// – KHÓNG token, cookie, mật khẩu hay đường dẫn hỒ sơ. Là ảnh chụp cho nhịp đầu, không phải nguỒn
// sự thật: `/api/state` về là ghi đè (renderer.js).
const BOOT_CACHE_MAX = 60; // danh sách dài hơn thì cắt – chỉ cần đủ để khung hình đầu trông đúng
function bootCacheSnapshot() {
  const list = activeAccounts().slice(0, BOOT_CACHE_MAX);
  const msts = new Set(list.map(account => account.mst));
  return {
    // `selected` luôn phải là một dòng CÒ trong danh sách vừa gửi, nếu không sidebar sẽ không tô
    // sáng dòng nào (đúng lỗi "hỒ sơ ma" mà rememberSelectedMst() đã chặn ở phía máy chủ).
    selected: msts.has(selected) ? selected : (list[0] ? list[0].mst : ''),
    accounts: list.map(account => ({
      mst: account.mst,
      name: account.name || '',
      label: account.label || '',
      session: directTokens.has(account.mst) ? 'live' : (hasSavedSession(account.mst) ? 'saved' : 'none'),
      identifiers: cleanIdentifiers(account.identifiers).slice(0, 8),
      remembered: isRemembered(account.mst),
    })),
  };
}
function bootCacheScript(res) {
  let body;
  try { body = `window.HD_BOOT_CACHE=${JSON.stringify(bootCacheSnapshot())};`; }
  catch (error) {
    // Cache là tuỳ chọn: hỏng thì trả script RỖNG (không phải 500) để trang vẫn nạp tiếp và
    // renderer rơi về đường thường (/api/state) – không được vì cache mà chặn cả giao diện.
    log('Không dựng được ảnh chụp MST cho khung hình đầu: ' + ((error && error.message) || error));
    body = 'window.HD_BOOT_CACHE=null;';
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function migrateMst(from, to) {
  const move = (a, b) => { try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch (error) { throw new Error(`Không đổi được MST ${from} → ${to}: ${error.message}. Đóng cửa sổ Chrome của MST này rỒi thử lại.`); } };
  move(jobStore(from), jobStore(to));
  move(path.join(dataDir, 'secrets', `${from}.json`), path.join(dataDir, 'secrets', `${to}.json`));
  move(path.join(dataDir, 'profiles', from), path.join(dataDir, 'profiles', to));
  for (const cache of [sessionCache, jobCache, remembered]) { cache.delete(from); cache.delete(to); }
  invalidateSyncCache();
  // Đợt 3: kết nối đọc cache theo đường dẫn data.db – đổi MST là đường dẫn đổi ⇒ đóng kết nối cũ.
  try { invalidateReadConn(dataLayer().mst.mstDirectory(output, from)); } catch { /* chưa có thư mục lưu */ }
  try { invalidateReadConn(dataLayer().mst.mstDirectory(output, to)); } catch { /* chưa có thư mục lưu */ }
  directTokens.delete(from); tokenAccounts.delete(from);
  const oldEngine = engines.get(from);
  if (oldEngine) { engines.delete(from); engines.set(to, oldEngine); oldEngine.mst = to; }
  if (selected === from) { selected = to; setCurrentEngine(to); }
}
// Thêm MST hoặc sửa MST đã có (đổi tên khách / đổi MST / đổi mật khẩu đã lưu) - luôn ghi vào danh sách.
function saveAccount(input) {
  const previous = String(input.previous || '').trim();
  const mst = String(input.mst || '').trim();
  const name = String(input.name || '').trim().slice(0, 120);
  if (!safeMst(mst)) throw new Error(mstFormat.MST_HINT);
  const owner = activeAccounts().find(account => account.mst !== previous && accountIdentifiers(account.mst).includes(mst));
  if (owner) throw new Error(`Mã ${mst} đang thuộc hỒ sơ MST ${owner.mst}.`);
  if (previous && !accountFor(previous)) throw new Error('MST cần sửa không còn trong danh sách.');
  if (mst !== previous && accountFor(mst)) throw new Error(`MST ${mst} đã có trong danh sách.`);
  if (previous && mst !== previous) migrateMst(previous, mst);
  const record = accountFor(mst, true) || accountFor(previous, true);
  if (record) { record.mst = mst; record.name = name; record.removedAt = ''; if (!record.label || record.label === previous) record.label = mst; }
  // MST MỚI: kèm ô nhớ `firstScan` (trạng thái pending) – dấu hiệu DUY NHẤT để biết MST này thuộc
  // diện "quét 10 ngày ở lần đăng nhập đầu". MST cũ không có ô này nên KHÓNG bao giờ bị quét.
  else accounts.accounts.push({ mst, name, label: mst, lastVerifiedAt: 0, firstScan: firstScan.newRecord() });
  if (input.remember === false) { secrets.clear(mst, ['password']); remembered.set(mst, false); }
  else if (typeof input.password === 'string' && input.password) { secrets.write(mst, { password: input.password }); remembered.set(mst, true); }
  accounts.selected = selected; saveAccounts();
  return publicAccount(accountFor(mst));
}
// ---------------------------------------------------------------------------
// QUÉT LẦN ĐẦU CHO MST MỚI THÊM – 10 ngày gần nhất (phần QUYẾT ĐỊNH nằm ở src/first-scan.js).
//
// Móc vào CUỐI checkLogin() vì đó là NƠI DUY NHẤT mọi đường đăng nhập đều đi qua: tự động sau khi
// lưu MST (autoLoginAccount), nhập CAPTCHA tay (submitLogin), đăng nhập trong cửa sổ Chrome
// (/api/account/captcha), và bấm dòng MST còn phiên sẵn (addOrLogin).
// Nhờ móc ở đó:
//   · Đăng nhập THẤT BẠI ⇒ không đi qua checkLogin ⇒ KHÓNG đánh dấu gì ⇒ lần đăng nhập sau VẪN chạy
//     luỒng này (đúng yêu cầu người dùng).
//   · /api/state (vòng poll 0,8‒1,5s) KHÓNG gọi checkLogin ⇒ không có nguy cơ kích hoạt do poll.
//   · startupSessionCheck() lúc mở app chỉ restoreSession() ⇒ mở app KHÓNG quét hàng loạt.
// ---------------------------------------------------------------------------
const firstScanInFlight = new Set();
let firstScanQueue = Promise.resolve();

function markFirstScan(mst, patch) {
  const record = accountFor(mst);
  if (!record || !record.firstScan) return;
  Object.assign(record.firstScan, patch);
  saveAccounts();
}

// Xếp hàng quét lần đầu. KHÓNG async và KHÓNG await: đăng nhập phải trả lời giao diện NGAY, việc
// tải chạy nền như mọi lượt tải khác của app.
function maybeFirstScan(mst) {
  try {
    if (!mst || firstScanInFlight.has(mst)) return;
    const decision = firstScan.decide(accountFor(mst), {
      output,
      // MST đang có tác vụ (khách tự bấm tra cứu/tải) ⇒ nhường, để lần đăng nhập sau.
      busy: !!(engineFor(mst) && engineFor(mst).busy),
      alreadyQueued: false,
      now: Date.now(),
    });
    if (!decision.run) return;
    firstScanInFlight.add(mst);
    const run = async () => {
      try {
        // Cổng LICENSE giữ nguyên như đường thủ công – lượt tự quét KHÓNG được lách.
        await ensureLicenseAllowed();
        if (!output) { log(`Quét lần đầu MST ${mst}: chưa có thư mục lưu – để lần đăng nhập sau.`); return; }
        const target = engineFor(mst);
        if (!target) { log(`Quét lần đầu MST ${mst}: chưa có phiên làm việc – bỏ qua.`); return; }
        if (target.busy) { log(`Quét lần đầu MST ${mst}: đang bận tác vụ khác – bỏ qua lượt này.`); return; }
        const window = firstScan.windowFor(vnDate.dayOf);
        // Ghi `running` TRƯỚC khi tải: tắt app giữa chừng thì lần sau không quét lại từ đầu.
        markFirstScan(mst, { state: firstScan.STATE.RUNNING, at: new Date().toISOString(), from: window.from, to: window.to });
        log(`Quét lần đầu MST ${mst}: ${window.from} → ${window.to}, XML, mua vào trước rỒi bán ra.`);
        for (const request of firstScan.requestsFor(window)) {
          const requested = validateParams(request);
          const label = `Quét lần đầu ${request.direction === 'purchase' ? 'mua vào' : 'bán ra'} MST ${mst}`;
          // AWAIT: mua vào phải xong mới sang bán ra (không dỒn request vào cổng thuế).
          const result = await runDetached(target, target.job?.id || '', label, async () => {
            await target.stream(requested, output);
            await closeBrowserWhenIdle('quét lần đầu xong');
            autoImportAfterDownload('quét lần đầu xong');
          });
          if (!result.ok) throw result.error || new Error(result.message || 'lượt quét lần đầu thất bại');
        }
        markFirstScan(mst, { state: firstScan.STATE.DONE, at: new Date().toISOString() });
        log(`Quét lần đầu MST ${mst}: xong.`);
      } catch (error) {
        // Lỗi (mạng / cổng chặn / hết phiên) ⇒ `failed` để lần đăng nhập sau chạy lại. KHÓNG để
        // `running` mãi, cũng KHÓNG đánh dấu `done` – nếu không thì khách mất dữ liệu lần đầu mà
        // không ai biết.
        markFirstScan(mst, { state: firstScan.STATE.FAILED });
        log(`Quét lần đầu MST ${mst} lỗi: ${error && error.message ? error.message : String(error)}`);
      } finally {
        firstScanInFlight.delete(mst);
      }
    };
    // Hàng đợi TUẦN TỰ dùng chung cho MỌI MST: nhiều khách thêm cùng lúc thì lần lượt, không dỒn
    // request vào cổng thuế. `then(run, run)` để một lượt lỗi không làm đứt hàng đợi.
    firstScanQueue = firstScanQueue.then(run, run);
  } catch (error) {
    log(`Không xếp được lượt quét lần đầu cho MST ${mst}: ${error && error.message ? error.message : String(error)}`);
  }
}
function createEngine(mst) {
  if (engines.has(mst)) { engine = engines.get(mst); return engine; }
  engine = new Engine({
    store: jobStore(mst),
    // A stale token must not be reused: drop the saved session so the UI asks for a fresh login.
    request: async (route, action, check) => {
      check(); const token = directTokens.get(mst);
      if (!token) return browser.request(route, action, check);
      try { return await tct.request(token, route, action, mst, check.signal); }
      catch (error) { if (error.auth) forgetSession(mst); throw error; }
    },
    identity: () => directTokens.has(mst) ? (tokenAccounts.get(mst) || authAccount) : browser.verify(mst),
    // Xuất PDF cần một cửa sổ Chrome điều khiển được. Khi tải bằng phiên đăng nhập thẳng (không mở
    // trình duyệt), tự mở Chrome ẩn rỒi dùng lại cho các hóa đơn PDF tiếp theo.
    pdf: async html => {
      if (!browser.client) await browser.open(mst, false);
      return browser.pdf(html);
    },
    excel: makeExcel,
    emit: () => invalidateSyncCache(mst),
    // LƯỚT THỦ CÓNG (nút Tải hóa đơn) tự thử lại hoá đơn lỗi tạm thời ngay trong lượt chạy
    // (timeout / network / portal) – người dùng không phải bấm "Tải tiếp" cho lỗi mạng chập.
    // Auto Sync dựng Engine RIÊNG ở runAutoSyncDirection và KHÓNG bật cờ này: lịch nền giữ
    // hành vi cũ (tự quyết định lúc nào thử lượt) nên test và backfill không đổi.
    autoRetry: true,
    log: message => log(`MST ${mst}: ${message}`),
  });
  engine.mst = mst;
  engines.set(mst, engine);
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
// Chạy tác vụ DÀI trong nền, trả HTTP NGAY: giao diện bấm là có phản hỒi (không đợi nhiều phút),
// tiến độ vẫn cập nhật đều qua vòng poll /api/state vì Engine tự emit/save suốt lượt chạy.
// server.js giữ tham chiếu promise; nếu app bị tắt giữa đường thì tạm dừng đúng tác vụ đó trước
// khi đóng (giữ nguyên nghĩa vụ dọn dẹp – KHÓNG bỏ lửng tác vụ).
function runDetached(target, jobId, label, fn) {
  const task = (async () => {
    try {
      await fn();
      log(`${label}: hoàn tất.`);
      return { ok: true };
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (!error || (!error.paused && !error.auth)) log(`LỖI (${label}): ${message}`);
      // Lỗi PHIÊN (auth) thì tự đăng nhập nền ngay thay vì để người dùng bấm lại nút và ăn 400
      // lần nữa. Cần làm ở ĐÂY chứ không chỉ ở /api/download vì các lỗi auth ném ra trước lúc
      // run() tạo job (stream()/search() kiểm tra identity() trước) không bao giờ để lại
      // job.state='auth_required' cho các nhánh if (job.state==='auth_required') bắt.
      if (error && error.auth && target && target.mst) maybeAutoRelogin(target.mst, `phiên không dùng được khi ${label}`);
      // Trả về { ok:false } thay vì NÉM LỖI: chỗ gọi cũ bỏ qua giá trị trả về nên hành vi không
      // đổi, mà không có nguy cơ unhandled rejection. Lượt QUÉT LẦN ĐẦU cần biết thành công hay
      // không để đánh dấu done/failed (xem maybeFirstScan).
      return { ok: false, error, message };
    }
  })();
  detachedTasks.push({ target, jobId, label, task });
  task.finally(() => { const index = detachedTasks.indexOf(detachedTasks.find(x => x.task === task)); if (index >= 0) detachedTasks.splice(index, 1); });
  return task;
}
// Cửa sổ Chrome điều khiển cổng thuế chỉ cần trong lúc tra cứu/tải (và lúc xuất PDF). Tải xong thì
// đóng lại cho gọn, không để cửa sổ nằm lại cho người dùng phải tự tắt.
// Chỉ đóng khi MST đang chọn có token trực tiếp (phiên đã lưu trong du_lieu/secrets): khi đó mọi
// request đi bằng Node nên cửa sổ Chrome không giữ phiên. Nếu phiên chỉ nằm trong chính cửa sổ đó
// (đăng nhập bằng trang thuế, chưa lưu token) thì giữ nguyên, đóng đi là mất đăng nhập.
async function closeBrowserWhenIdle(reason) {
  if (!browser.client) return;
  if (authBusy.has(selected) || loginChallenge || engine?.busy) return;   // đang đăng nhập/CAPTCHA hoặc còn tác vụ
  if (!selected || !directTokens.has(selected)) return;
  const mst = selected;
  await browser.close();
  log(`Đã đóng cửa sổ Chrome tải hóa đơn của MST ${mst} (${reason}).`);
}
// ---- Support Chat realtime ------------------------------------------------------------------
// Giao diện nối tới /api/support/events (SSE nội bộ). Server giữ MỘT kết nối tới Gateway
// (/v1/chats/stream) và chỉ chuyển tiếp khi Firebase báo thay đổi – KHÓNG hỏi định kỳ.
// Timer duy nhất ở đây là hẹn nối lại khi luỒng đứt, backoff tăng dần 5s -> 300s.
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
    { signal: controller.signal, onOpen: () => { openedAt = Date.now(); setSupportRealtime(true); log('Đã nối luỒng chat realtime tới Gateway.'); } },
  ).then(result => finishSupportStream(controller, result, openedAt)).catch(error => finishSupportStream(controller, { ok: false, reason: error.message }, openedAt));
}
// Kết thúc một kết nối: luỒng sống đủ lâu (>= 30s) thì nối lại nhanh (2s); đóng sớm hoặc lỗi thì
// backoff tăng dần 5s -> 10s -> 20s… tối đa 300s, tránh vòng lặp nối lại liên tục khi upstream flapping.
const SUPPORT_STREAM_STABLE_MS = 30000;
function finishSupportStream(controller, result, openedAt) {
  if (supportStreamController !== controller) return; // đã có luỒng mới thay thế
  supportStreamController = null;
  setSupportRealtime(false);
  const stable = !!(result && result.ok) && openedAt > 0 && (Date.now() - openedAt) >= SUPPORT_STREAM_STABLE_MS;
  const delay = stable ? 2000 : supportStreamBackoff;
  supportStreamBackoff = stable ? 5000 : Math.min(supportStreamBackoff * 2, 300000);
  supportStreamRetryAt = Date.now() + delay;
  log(`LuỒng chat dừng (${(result && result.reason) || 'không rõ'}) – thử lại sau ${Math.round(delay / 1000)}s.`);
  scheduleSupportStream();
}
function stopSupportStream() {
  if (supportStreamRetryTimer) { clearTimeout(supportStreamRetryTimer); supportStreamRetryTimer = null; }
  const controller = supportStreamController;
  supportStreamController = null;
  if (controller) controller.abort();
}
// Tên công ty/HKD của MST – LẤY TỪ KHO dữ liệu (đọc data.db). Đây là đường CHÍNH THỨC (đã nhập XML)
// và là nguỒn dự phòng khi chưa có kết quả tra cứu nào trong bộ nhớ.
// Chỉ đọc khi data.db đã tỒn tại (không tạo file mới từ màn hình trạng thái) và chỉ nhớ kết quả
// không rỗng, để MST chưa nhập dữ liệu vẫn thử lại được ở lần sau.
// Đường NHANH HƠN cho lúc chưa nhập gì: companyNameFromItems() đọc thẳng kết quả tra cứu đang có
// trong bộ nhớ – xem `companyName` trong appState().
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
  configureXmlWatcher();
  setCurrentEngine(selected);
  // jobRevision do chính Engine tăng khi nội dung job đổi (save()) – UI so số này thay vì dựng lại
  // toàn bộ bảng. KHÓNG tự tăng mỗi nhịp poll: làm vậy là mất ý nghĩa "đã thay đổi chưa".
  const snapshot = engine ? engine.snapshot() : { state: 'idle', busy: false, items: [], total: 0, done: 0, failed: 0, message: 'Chọn hoặc thêm MST để bắt đầu.' };
  snapshot.jobId = engine?.job?.id || '';
  const { items, ...rest } = snapshot; // eslint-disable-line no-unused-vars
  return { ...rest, resumable: isResumableJob(engine && engine.job), itemsRevision: engine ? engine.jobRevision : 0, accounts: activeAccounts().map(publicAccount), selected, output, defaultOutput: defaultOutputFolder(), companyName: companyNameFor(selected) || companyNameFromItems(engine && engine.job ? engine.job.items : null, selected), remembered: !!selected && isRemembered(selected), browserReady: !!browser.client, browserVisible: !!browser.visible, authenticated: !!selected && !!(authAccount || directTokens.has(selected)), authBusy: foregroundAuth.has(selected), backgroundAuth: backgroundAuth.has(selected), autoLoginBlocked: (backgroundAuthFails.get(selected)?.count || 0) >= BACKGROUND_AUTH_MAX_ATTEMPTS, sessionChecked: sessionCheckFinished, update: updater.status(), pool: syncPool.status() };
}
// Chỉ kiểm tra engine của ĐÚNG MST đích. Trước đây có nhánh dự phòng `|| engine`: MST đích chưa
// từng dùng thì engineFor() = null, nó rơi vào engine của MST ĐANG CHỌN ⇒ tác vụ của MST A chặn
// luôn việc thêm/đăng nhập MST B.
function ensureIdle(mst = selected) {
  const target = engineFor(mst);
  if (target && target.busy) throw new Error(`MST ${mst} đang chạy tác vụ – ngưng tác vụ của MST đó trước.`);
}
async function ensureLicenseAllowed() { return support.enforceLicense(); }
async function authOperation(fn, mst) {
  const key = mst || selected;
  if (authBusy.has(key)) throw new Error('Đang xử lý phiên đăng nhập cho MST này. Vui lòng chờ.');
  authBusy.add(key);
  // Đây là luỒng người dùng CHỜ kết quả (form đăng nhập, đăng nhập tay) ⇒ được khoá UI.
  // Ghi cả hai cờ và xoá CẢ HAI trong finally: nếu chỉ xoá authBusy thì MST kẹt trong
  // foregroundAuth mãi mãi và giao diện bị khoá vĩnh viễn, không mở lại được.
  foregroundAuth.add(key);
  try { return await fn(); } finally { authBusy.delete(key); foregroundAuth.delete(key); }
}
// Chọn MST là thao tác NHẸ (đặt MST đang xem + kiểm tra còn phiên). KHÓNG bật `authBusy` như một
// lượt đăng nhập thật: khoá đó làm giao diện khoá cả thanh công cụ và chặn mọi request khác trong
// suốt thời gian kiểm tra. Chỉ từ chối khi CHÍNH MST đang chọn đang có lượt đăng nhập. Vì UI không khoá khi
// bấm chọn (có thể bấm liên tiếp), các lượt CHỌN được xếp hàng để không cùng lúc ghi đè `selected`.
let selectQueue = Promise.resolve();
async function selectOperation(fn, mst) {
  if (authBusy.has(mst)) throw new Error('Đang xử lý phiên đăng nhập cho MST này. Vui lòng chờ.');
  const run = selectQueue.then(fn, fn);
  selectQueue = run.then(() => {}, () => {});
  return run;
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
  loginChallenge = null; authAccount = null;
  const restored = restoreSession(mst);
  selected = mst;
  const record = accountFor(mst); if (record) record.lastUsedAt = Date.now();
  accounts.selected = mst; saveAccounts(); createEngine(mst);
  const account = await checkLogin();
  // Người dùng bấm vào MST mà phiên đã chết ⇒ tự đăng nhập lại bằng mật khẩu đã lưu,
  // chạy nền, không mở hộp thoại. Đây là kịch bản chính: "vào trang thấy MST hết
  // phiên thì tự đăng nhập lại". `restored` = token còn dùng được ⇒ không cần.
  if (!restored && !account) maybeAutoRelogin(mst, 'bạn vừa chọn MST này');
  return { mst, authenticated: !!account || !!directTokens.get(mst), account, name: accountFor(mst)?.name || '' };
}
async function addOrLogin(mst) {
  if (!safeMst(mst)) throw new Error(mstFormat.MST_HINT);
  ensureIdle(mst); loginChallenge = null; authAccount = null;
  if (!engine || selected !== mst) createEngine(mst);
  selected = mst;
  const saved = isRemembered(mst);
  if (restoreSession(mst)) return { authenticated: true, ready: false, direct: true, error: '', remembered: saved, account: await checkLogin() };
  const value = await tct.captcha(mst);
  return challengeResponse({ ...value, ready: true, authenticated: false, direct: true, remembered: saved, error: '' });
}
async function checkLogin() {
  if (!selected) throw new Error('Chọn hoặc thêm MST trước.');
  const token = directTokens.get(selected) || (restoreSession(selected) ? directTokens.get(selected) : '');
  const identity = token ? (tokenAccounts.get(selected) || jwtAccount(token) || authAccount) : await browser.verify(selected);
  authAccount = identity;
  if (token && identity) tokenAccounts.set(selected, identity);
  if (!identity) return null;
  const current = accountFor(selected);
  const record = { mst: selected, name: current?.name || '', label: identity.label || selected, lastVerifiedAt: Date.now() };
  if (current) Object.assign(current, record); else accounts.accounts.push(record);
  accounts.selected = selected; saveAccounts(); if (!engine) createEngine(selected);
  // Ghi nhận: phiên thuộc CCCD/MST bổ sung của hỒ sơ (cùng một người, khác loại mã) ⇒ đánh dấu
  // mã đó là "đã gán" trong panel mã chưa nhận diện. Chỉ ghi vết, không đổi luỒng đăng nhập.
  if (identity?.mst) noteLoginIdentifier(selected);
  // ĐĂNG NHẬP THÀNH CÓNG ⇒ xét lượt quét 10 ngày đầu cho MST mới thêm (xem maybeFirstScan).
  // KHÓNG await: đăng nhập phải trả lời giao diện ngay; việc tải chạy nền.
  maybeFirstScan(selected);
  return record;
}
async function submitLogin(input) {
  const challenge = loginChallenge;
  if (!challenge || input.loginId !== challenge.loginId || input.mst !== selected || challenge.mst !== selected) throw new Error('Phiên CAPTCHA không còn hợp lệ. Bấm Lấy CAPTCHA lại.');
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 120 || typeof input.captcha !== 'string' || !/^[a-z0-9]{1,10}$/i.test(input.captcha.trim())) throw new Error('Nhập tên đăng nhập và mã CAPTCHA trong ảnh.');
  // A saved password is used when the field is left empty (same idea as VNIT's remembered password).
  const password = (typeof input.password === 'string' ? input.password : '') || secrets.read(selected, ['password']).password;
  if (!password) throw new Error('Nhập mật khẩu – MST này chưa lưu mật khẩu.');
  const keep = input.remember !== false;
  const remember = () => { secrets.write(selected, { password: keep ? password : '' }); remembered.set(selected, keep && !!password); };
  loginChallenge = null;
  if (challenge.key) {
    try {
      const token = await tct.authenticate({ username: input.username.trim(), password, captcha: input.captcha.trim().toUpperCase(), ckey: challenge.key }, selected);
      const identity = jwtAccount(token);
      if (identity?.mst && !mstFormat.mstAliases(selected).includes(String(identity.mst))) throw new Error(`Tài khoản này thuộc MST ${identity.mst}, không khớp hỒ sơ ${selected}.`);
      directTokens.set(selected, token); authAccount = identity || { mst: selected, label: input.username.trim() }; tokenAccounts.set(selected, authAccount);
      storeSession(selected, token, password, keep);
      const account = await checkLogin(); return { authenticated: true, account, mst: selected, remembered: keep && !!password };
    } catch (error) {
      const next = await tct.captcha(selected).catch(() => null);
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
// Lõi đăng nhập tự động: KHÓNG đụng `selected`, KHÓNG đụng `loginChallenge`.
// Đây là phần CHẠY SONG SONG được cho nhiều MST lúc mở app (xem startupSessionCheck).
// `autoLoginAccount` bọc lại phần này và có thêm bước chọn MST cho luỒng người dùng.
async function autoLoginFor(mst, input) {
  const savedPassword = secrets.read(mst, ['password']).password;
  const password = (typeof input.password === 'string' ? input.password : '') || savedPassword;
  if (!password) throw new Error('MST này chưa lưu mật khẩu – nhập mật khẩu một lần trong form Đăng nhập rỒi bấm Tự động đăng nhập sau.');
  const username = String(input.username || '').trim() || mst;
  const keep = input.remember !== false;
  const result = await loginAuto.autoLogin({ username, password, mst, maxAttempts: input.maxAttempts }, mst);
  if (!result.ok) {
    // Hết lượt thử: trả về thông tin lỗi để bên gọi quyết định (báo lỗi hay mở form tay).
    const error = `Tự động đăng nhập chưa thành công sau ${result.attempts} lần thử. ${result.error || ''}`.trim();
    const next = await tct.captcha(mst).catch(() => null);
    return { ok: false, error, attempts: result.attempts, challenge: next };
  }
  const token = result.token;
  const identity = jwtAccount(token);
  if (identity?.mst && !mstFormat.mstAliases(mst).includes(String(identity.mst))) {
    forgetSession(mst);
    throw new Error(`Tài khoản này thuộc MST ${identity.mst}, không khớp hỒ sơ ${mst}.`);
  }
  directTokens.set(mst, token);
  tokenAccounts.set(mst, identity || { mst, label: username });
  storeSession(mst, token, keep ? password : '', keep, true);   // async: đăng nhập nền song song
  // `authAccount` là biến toàn cục của MST ĐANG CHỌN – chỉ cập nhật khi đúng MST đó, nếu không
  // lượt login MST khác sẽ cài nhầm danh tính vào phiên đang xem của người dùng.
  if (mst === selected) authAccount = identity || { mst, label: username };
  const account = identity || await checkLogin();
  return { ok: true, account, mst, remembered: keep && !!password, attempts: result.attempts };
}
// Auto login hoàn toàn: dùng mật khẩu đã lưu (hoặc mật khẩu gửi lên), solver JS tự giải CAPTCHA.
// Trả về cùng hình dạng với submitLogin để renderer dùng lại acceptLoginResult.
// LuỒng NÀY gọn về MST đang chọn / đang bấm ở giao diện – có đổi `selected` và `loginChallenge`.
async function autoLoginAccount(input) {
  const mst = String(input.mst || selected || '');
  if (!mst) throw new Error('Chọn hoặc thêm MST trước.');
  if (mst !== selected) await selectAccount(mst);
  ensureIdle(mst);
  loginChallenge = null;
  const result = await autoLoginFor(mst, input);
  if (!result.ok) {
    if (result.challenge) {
      return challengeResponse({ ...result.challenge, ready: true, authenticated: false, remembered: isRemembered(mst), error: result.error });
    }
    throw new Error(result.error);
  }
  return { authenticated: true, account: await checkLogin(), mst, remembered: result.remembered, attempts: result.attempts };
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

// Hộp thoại CHỌN FILE PDF (Mục 3) – cùng khuôn với hộp chọn thư mục: OpenFileDialog là
// lớp .NET mặc định, không cần thêm thư viện. `InitialDirectory` trỏ sẵn thư mục
// pdf-goc của đúng chiều hóa đơn để người dùng không phải dò từ gốc rễ.
function fileDialogScript(initialDir, title) {
  const dir = String(initialDir || '').replace(/'/g, "''");
  const label = String(title || 'Chọn file').replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    `$d.Title = '${label}'`,
    "$d.Filter = 'PDF của nhà cung cấp (*.pdf)|*.pdf|Tất cả (*.*)|*.*'",
    "$d.Multiselect = $false",
    "$d.CheckFileExists = $true",
    `if ('${dir}' -and [System.IO.Directory]::Exists('${dir}')) { $d.InitialDirectory = '${dir}' }`,
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }'
  ].join('; ');
}

async function choosePdfFile(initialDir, title) {
  const result = await runPowerShell(fileDialogScript(initialDir, title));
  if (result.error) throw new Error(`Không mở được hộp thoại chọn file: ${(result.err || 'không rõ lỗi').split(/\r?\n/)[0] || 'không rõ lỗi'}`);
  return result.out || '';
}
async function chooseFolder() {
  const first = await runPowerShell(FOLDER_DIALOG);
  if (!first.error) return first.out; // '' khi người dùng bấm Cancel
  const backup = await runPowerShell(FOLDER_DIALOG_BACKUP);
  if (!backup.error) return backup.out;
  const detail = (first.err || backup.err || 'không rõ lỗi').split(/\r?\n/).filter(Boolean)[0] || 'không rõ lỗi';
  throw new Error(`Không mở được hộp thoại chọn thư mục (${detail}). Gõ hoặc dán đường dẫn đầy đủ vào ô “Thư mục lưu” rỒi bấm ra ngoài ô.`);
}
// Hạn mức body. JSON thường 1 MB; SAO KÊ dùng hạn mức riêng (20 MB) vì UI gửi TOÀN BỘ dòng
// đã xem lại lên /import-rows và /preview-rows. 4.000 dòng sao kê (mô tả tiếng Việt đầy đủ)
// vào khoảng 1,2 MB – vượt hạn mức cũ. Bản cũ gọi req.destroy() khi vượt, tức GIẾT socket
// không gửi response nào: UI chỉ hiện lỗi mạng chung chung, người dùng không biết vì sao.
// Nay trả 413 kèm lý do rõ ràng.
const JSON_BODY_LIMIT = 1024 * 1024;
const BANK_JSON_BODY_LIMIT = 20 * 1024 * 1024;
// Nhãn route để câu lỗi 413 nói đúng chỗ người dùng đang làm.
function readJsonBody(req, limit = JSON_BODY_LIMIT, label = 'dữ liệu yêu cầu') {
  return new Promise((resolve, reject) => {
    let text = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      text += chunk;
      if (text.length > limit) { tooLarge = true; text = ''; }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new Error(`${label} vượt quá ${Math.round(limit / 1048576)} MB – hãy chia nhỏ sao kê theo từng tháng rỒi nhập lại từng phần.`));
        return;
      }
      try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('JSON không hợp lệ.')); }
    });
    // Vượt hạn mức thì NGỪNG đọc nhưng KHÓNG destroy socket – phải còn đường gửi câu lỗi 413.
    req.on('error', reject);
  });
}
function readBody(req) { return readJsonBody(req); }
function readBankJson(req) {
  return readJsonBody(req, BANK_JSON_BODY_LIMIT, 'Bảng giao dịch sao kê');
}
// Body upload SAO KÊ (JSON { fileName, dataBase64 }): cho phép file lớn hơn JSON thường (20 MB),
// dữ liệu vẫn nằm toàn bộ trong RAM – file sao kê Excel/CSV thực tế nhỏ hơn nhiều con số này.
function readBankUpload(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => { text += chunk; if (text.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const input = text ? JSON.parse(text) : {};
        const fileName = String(input.fileName || 'sao-ke.xlsx').trim();
        if (!/\.(xlsx|xls|csv|pdf|png|jpe?g)$/i.test(fileName)) throw new Error('Chỉ nhận file .xlsx, .xls, .csv, .pdf, .png hoặc .jpg.');
        const buffer = Buffer.from(String(input.data || ''), 'base64');
        if (!buffer.length) throw new Error('File rỗng hoặc đọc không được nội dung.');
        resolve({ fileName, buffer });
      } catch (error) { reject(error instanceof SyntaxError ? new Error('JSON không hợp lệ.') : error); }
    });
    req.on('error', reject);
  });
}
// ---- AI DEVEXTHUB: chuyển PDF scan/ảnh thành bảng (dùng đúng cách gọi của extension pdf conver).
// Khoá định danh MẶC ĐỊNH ghim sẵn trong EXE; biến môi trường ghi đè được (DEVEXTHUB_INSTALL_ID /
// DEVEXTHUB_FINGERPRINT) khi cần đổi khoá mà không phải build lại.
const DEVEXTHUB_URL = 'https://api.devexthub.com:8443/api/convert';
const DEVEXTHUB_INSTALL_ID = process.env.DEVEXTHUB_INSTALL_ID || '10386d78-7c25-46ee-8512-a4f6e6319b75';
const DEVEXTHUB_FINGERPRINT = process.env.DEVEXTHUB_FINGERPRINT || 'e41db5f08f6491c3586c54b663fd9f9fbdba6084ac284dd2551c726d1fee5a2d';
async function aiConvertPdfToTables(buffer) {
  let resp;
  try {
    resp = await fetch(DEVEXTHUB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pdf: buffer.toString('base64'),
        fingerprint: DEVEXTHUB_FINGERPRINT,
        install_id: DEVEXTHUB_INSTALL_ID,
        pages: 1, chars: 0, items: 0,
        force_provider: null,
      }),
    });
  } catch (error) {
    throw new Error(`Không kết nối được máy chủ AI (devexthub): ${error.message}. Kiểm tra mạng rỒi thử lại.`);
  }
  if (!resp.ok) {
    let detail = '';
    try { const json = await resp.json(); detail = json?.detail || ''; } catch { try { detail = await resp.text(); } catch { /* bỏ qua */ } }
    if (resp.status === 429) throw new Error('AI hết lượt hôm nay (giới hạn của bên cấp). Thử lại vào ngày mai hoặc dùng file Excel/PDF chữ.');
    if (resp.status === 413) throw new Error('PDF/ảnh quá lớn cho AI (tối đa ~10 MB). Tách file nhỏ hơn rỒi thử lại.');
    throw new Error(`Máy chủ AI từ chối (HTTP ${resp.status}): ${String(detail).slice(0, 200) || 'không rõ lý do'}.`);
  }
  const data = await resp.json();
  const tables = Array.isArray(data?.tables) ? data.tables : [];
  if (!tables.length) throw new Error('AI không đọc ra bảng dữ liệu nào từ file này.');
  // Ghép mọi bảng thành MỘT grid: header bảng + các dòng, ngăn cách bằng dòng trống.
  const rows = [];
  for (const table of tables) {
    rows.push([table.name || 'Bảng']);
    if (Array.isArray(table.headers) && table.headers.length) rows.push(table.headers.map(cell => String(cell ?? '')));
    for (const row of (Array.isArray(table.rows) ? table.rows : [])) {
      rows.push((Array.isArray(row) ? row : []).map(cell => String(cell ?? '')));
    }
    rows.push([]);
  }
  return rows;
}
function reply(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function allowed(req) {
  const expectedHost = `127.0.0.1:${server.address().port}`;
  const cookies = String(req.headers.cookie || '').split(';').map(x => x.trim());
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && req.headers.host === expectedHost && cookies.includes(`hd_session=${sessionSecret}`)
    && (!req.headers.origin || req.headers.origin === `http://${expectedHost}`);
}
// Cache file tĩnh trong RAM (renderer.js ~30KB, index.html ~100KB…): UI poll liên tục nên static
// file chỉ được nạp đúng một lần mỗi phiên – trước đây mỗi request đọc lại đĩa. File tĩnh bất biến
// theo build; mtime+size giữ lại làm khoá (an toàn khi dev, gần như không bao giờ miss khi chạy EXE)
// và cũng là nguỒn sinh ETag cho 304. `checkedAt` để bước kiểm tra lại mtime có TTL – xem staticEntry.
const staticCache = new Map();
// Cache bản xem A4 theo đường dẫn XML + mtime + size: XML gốc bất biến (app chỉ ghi một lần khi
// tải) mà người dùng mở lại bản xem cùng hoá đơn rất thường xuyên. Giới hạn 100 mục (FIFO).
const a4HtmlCache = new Map();
// ---- ĐỢT 3: cache kết nối SQLite ĐỌC theo data.db của từng MST ----
// Đường đọc /api/db/* trước đây MỞ LẠI database mỗi request (mở file + 7 PRAGMA + kiểm tra schema +
// đóng ≈ 5,7 ms/request đo thực tế, đang trả thuần tuý cho quản lý – không phải việc của người
// dùng) kể cả poller nền 1‒3 giây/lần. Giữ kết nối mở dùng lại: request chỉ còn đúng phần truy vấn.
// Khoá = SCHEMA_VERSION + đường dẫn data.db: nâng schema là key đổi, kết nối cũ tự bị bỏ.
// Kết nối nhàn rỗi 5 phút tự đóng (bộ quét 60 giây/lần, unref – không giữ tiến trình sống).
// Đường GHI (quét XML, import, autosync engine) KHÓNG đi qua cache này: vẫn mở riêng như cũ nên
// không đụng vòng ghi; WAL cho phép đọc song song với một ghi.
const READ_CONN_IDLE_MS = 5 * 60 * 1000;
const readConnCache = new Map();
let readConnSweeper = null;
function readDatabase(dbFile) {
  const key = `${require('./data/sqlite').SCHEMA_VERSION}|${dbFile}`;
  const entry = readConnCache.get(key);
  if (entry) { entry.lastUsed = Date.now(); return entry.db; }
  // Nhánh miss (mỗi MST mỗi 5 phút chỉ 1 lần): tạo vùng MST như ensureMst (mkdir + sync.json) rỒi
  // mở db MỘT lần duy nhất.
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  try { for (const name of dataLayer().mst.XML_FOLDERS) fs.mkdirSync(path.join(dir, name), { recursive: true }); } catch { /* thiếu thư mục thì quét XML sau tự tạo */ }
  try {
    const syncFile = path.join(dir, 'sync.json');
    if (!fs.existsSync(syncFile)) dataLayer().mst.writeSyncState(syncFile, dataLayer().mst.defaultSyncState());
  } catch { /* thiếu sync.json không sao – readSyncState tự rơi về mặc định */ }
  const fresh = { db: dataLayer().sqlite.openDatabase(dbFile), lastUsed: Date.now() };
  readConnCache.set(key, fresh);
  if (!readConnSweeper) {
    readConnSweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, item] of readConnCache) {
        if (now - item.lastUsed > READ_CONN_IDLE_MS) { readConnCache.delete(key); try { item.db.close(); } catch { /* đã đóng */ } }
      }
    }, 60000);
    if (readConnSweeper.unref) readConnSweeper.unref();
  }
  return fresh.db;
}
function invalidateReadConn(dbFile) {
  if (!dbFile) return;
  for (const key of [...readConnCache.keys()]) {
    if (key.endsWith(`|${dbFile}`)) {
      const item = readConnCache.get(key);
      readConnCache.delete(key);
      try { if (item) item.db.close(); } catch { /* đã đóng */ }
    }
  }
}
// Tài sản tĩnh đọc từ đĩa MỘT lần rỒi giữ trong RAM, nhưng vẫn phải thấy file dev sửa giữa chừng.
// Bước kiểm tra lại mtime là I/O ĐỒNG BỘ trên chính event loop đang phục vụ /api/state và các job
// nền; một lần tải trang = 16 request tài sản ⇒ 16 lần statSync xếp hàng trước câu trả lời API.
// TTL 2 giây: dev sửa file rỒi F5 vẫn thấy thay đổi ngay, mà đường nóng không đụng đĩa.
const STAT_TTL_MS = 2000;
function staticEntry(name) {
  const now = Date.now();
  const entry = staticCache.get(name);
  if (entry && now - entry.checkedAt < STAT_TTL_MS) return entry;
  const file = path.join(__dirname, name);
  const stat = fs.statSync(file);
  if (entry && entry.stamp === stat.mtimeMs && entry.size === stat.size) {
    entry.checkedAt = now;
    return entry;
  }
  const fresh = { stamp: stat.mtimeMs, size: stat.size, checkedAt: now, body: fs.readFileSync(file) };
  staticCache.set(name, fresh);
  return fresh;
}
// Tài sản giao diện có BẢN RÚT GỌN (.min.js/.min.css) do tools/minify-ui.cjs sinh ra lúc đóng gói:
// 272 KB nguỒn → 200 KB (−27%) – bớt cả byte truyền lẫn thời gian parse của trình duyệt. Trình duyệt
// vẫn xin đúng tên cũ (`/renderer.js`), server tự đưa bản rút gọn, nên index.html không phải đổi gì.
// Tài sản không phải .js/.css (ảnh, vendor/pdfjs/*.mjs…) không có bản rút gọn.
function minifiedSibling(name) {
  const match = /^(.*\.(js|css))$/.exec(String(name || ''));
  if (!match) return '';
  const dot = match[1].lastIndexOf('.');
  return `${match[1].slice(0, dot)}.min${match[1].slice(dot)}`;
}
// ETag suy từ mtime+size: sửa file là mtime đổi ⇒ ETag đổi. Dùng được cho If-None-Match.
function staticEtag(entry) { return `"${Math.round(entry.stamp).toString(16)}-${entry.size.toString(16)}"`; }
function ifNoneMatch(req) {
  const raw = req && req.headers && req.headers['if-none-match'];
  if (!raw) return '';
  return String(raw).trim();
}
// `no-store` cũ bắt trình duyệt tải lại TOÀN BỘ tài sản mỗi lần F5 hoặc mở lại cửa sổ (~16
// request, ~324 KB) dù không có gì đổi. Nay trả ETag + `no-cache`: trình duyệt VẪN hỏi lại máy chủ
// mỗi lần (không tái dùng mù – route vẫn nằm sau allowed() nên không lộ gì), nhưng máy chủ trả 304
// rỗng thay vì thân file. Giữ đúng tính riêng tư, chỉ bỏ phần truyền lại vô ích.
function staticFile(req, res, name, type) {
  let entry;
  try {
    entry = staticEntry(name);
  } catch {
    staticCache.delete(name);
    res.writeHead(404, { 'Cache-Control': 'no-cache' });
    return res.end();
  }
  // Ưu tiên bản rút gọn – nhưng CHỈ khi nó KHÓNG CŨ HƠN bản gốc. Dev sửa renderer.js rỒi F5 thì phải
  // thấy bản vừa sửa, không phải file .min còn sót lại từ lần đóng gói trước; build thì bản .min
  // luôn được sinh ngay trước khi đóng gói nên luôn mới hơn.
  const shrink = minifiedSibling(name);
  if (shrink) {
    try {
      const candidate = staticEntry(shrink);
      if (!candidate.missing && candidate.stamp >= entry.stamp) entry = candidate;
    } catch {
      // Chưa có bản rút gọn (chạy dev, hoặc máy build không có esbuild). Ghi nhớ "thiếu" kèm TTL:
      // không có mốc này thì MỖI request tài sản lại ném một statSync ENOENT vô ích.
      staticCache.set(shrink, { missing: true, stamp: 0, size: 0, checkedAt: Date.now() });
    }
  }
  const etag = staticEtag(entry);
  const cache = { 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': new Date(entry.stamp).toUTCString() };
  const sent = ifNoneMatch(req);
  // If-None-Match có thể là danh sách hoặc '*'; W/ chỉ là chỉ báo yếu, giá trị đem so vẫn so được.
  if (sent && (sent === '*' || sent.split(',').some(one => one.trim().replace(/^W\//, '') === etag))) {
    res.writeHead(304, cache);
    return res.end();
  }
  res.writeHead(200, { ...cache, 'Content-Type': type });
  res.end(entry.body);
}

// ---- PHASE 5: CHẠY NỀN THEO KHUNG GIỜ ------------------------------------------------------
// Hai cổng phải CÙNG mở: trong khung giờ (mặc định 08:00‒18:00 giờ VN) VÀ cửa sổ app đã đóng.
// Người dùng là ưu tiên số 1: mở lại cửa sổ hoặc thao tác là nền ngưng ngay MST đang chạy.
let lastUiSeen = 0; // mốc cuối cùng giao diện gọi /api/state
const UI_CLOSED_MS = 10000;
const syncWindowFile = path.join(dataDir, 'sync-window.json');
function syncWindowConfig() {
  const saved = loadJson(syncWindowFile, null);
  return { enabled: !(saved && saved.enabled === false), windows: (saved && saved.windows) || syncWindow.DEFAULT_WINDOWS };
}
// Cửa sổ app đã đóng: không còn /api/state trong 10 giây. UI poll 1,5 giây/lần (renderer.js) nên
// 10 giây là khoảng lùi an toàn. KHÓNG dùng lastUiPoll vì mọi lời gọi /api/* đều cập nhật nó –
// kể cả /api/ping của instance thứ hai, sẽ làm tưởng cửa sổ còn mở mãi.
function uiClosed() { return !lastUiSeen || Date.now() - lastUiSeen > UI_CLOSED_MS; }
function manualBusyNow() {
  if (authBusy.size > 0 || loginChallenge) return true;
  // Bể "ĐỒng bộ tất cả" do người dùng bấm ⇒ lịch nền theo khung giờ đứng ngoài, không tranh MST.
  if (syncPool.running) return true;
  for (const one of engines.values()) if (one && one.busy) return true;
  try { if (dataLayer().importJob.status().running) return true; } catch { /* chưa cần tầng dữ liệu */ }
  return false;
}
// MST nền được phép chạy: còn trong danh sách, CÒ phiên lưu (âm thầm – không mở Chrome, không hỏi
// CAPTCHA), và đã quá `intervalMinutes` kể từ lượt trước. Xếp MST LÂU CHƯA ĐỒNG BỘ NHẤT lên trước
// để không dòng nào bị bỏ đói. Hàng đợi suy ra từ sync.json nên không cần file riêng.
function dueMsts() {
  if (!output) return [];
  const data = dataLayer();
  const nowMs = Date.now();
  const clock = syncWindow.vnClock(new Date());
  const rows = [];
  for (const account of activeAccounts()) {
    const mst = account.mst;
    if (!hasSavedSession(mst)) continue;
    if (syncPool.isActive(mst)) continue; // đang chạy trong bể "ĐỒng bộ tất cả" rỒi
    // Lượt Auto Sync của CHÍNH MST này đang chạy – có thể do người dùng bấm ▶ rỒi đóng cửa
    // sổ, nên cổng "cửa sổ đã đóng" VẪN mở và lịch sẽ tưởng máy rảnh. Không bỏ qua thì
    // autoSyncFor(mst).run() ném "Auto Sync đang chạy." mỗi nhịp 20 giây cho tới khi lượt đó
    // xong – bộ lập lịch báo lỗi liên tục, banner MST nhảy "Lỗi" giả. (catchupEligible()
    // đã có đúng chốt này; lịch theo khung giờ thiếu nên hai nơi lệch nhau.)
    const instance = autoSyncByMst.get(mst);
    if (instance && instance.running) continue;
    let state = null;
    try { state = data.mst.readSyncState(path.join(data.mst.mstDirectory(output, mst), 'sync.json')); } catch { state = null; }
    // Đã đỒng bộ đủ hôm nay ⇒ BỎ QUA tới hết ngày. Một ngày một lần, không lặp lại.
    if (dailySyncState(state, clock).synced) continue;
    // Chưa xong mà vừa thử cách đây chưa lâu ⇒ chờ, không dội cổng thuế (chống vòng lặp khi lỗi).
    const intervalMs = Math.max(5, Number((state && state.settings && state.settings.intervalMinutes) || 30)) * 60000;
    const stamps = [state && state.buy && state.buy.lastSync, state && state.sell && state.sell.lastSync]
      .map(value => Date.parse(value || '') || 0);
    const lastAttempt = Math.max(...stamps, 0);
    if (lastAttempt && nowMs - lastAttempt < intervalMs) continue;
    rows.push({ mst, lastSync: lastAttempt });
  }
  // Thứ tự (lâu chưa đỒng bộ nhất trước) do bộ lập lịch tự sắp – xem sync-scheduler.js.
  return rows;
}
// Ngưng CHỈ engine của đúng MST đó – không đụng lượt Auto Sync người dùng tự bấm ở MST khác.
function pauseBackgroundFor(mst) {
  // Bộ điều phối của MST này phải biết là được yêu cầu dừng – không chỉ pause engine. Lý do:
  // khi Mua vào vừa xong mà Bán ra chưa bắt đầu thì `autoSyncEngines` đã TRỐNG, nên pause()
  // không tìm thấy gì và lượt vẫn chạy tiếp Bán ra. yieldNow() đặt cờ để oneDirection() bỏ qua
  // hướng kia (xem auto-sync.js). Không có chốt này thì người dùng mở lại cửa sổ đúng lúc chuyển
  // hướng thì app báo "đã nhường" nhưng vẫn quét tiếp vào cổng thuế.
  const instance = autoSyncByMst.get(mst);
  if (instance) instance.yieldNow('có người dùng hoặc hết khung giờ');
  for (const one of autoSyncEngines) {
    if (one && one.job && one.job.account && one.job.account.mst === mst) one.pause();
  }
}
// KHOÁ THEO THƯ MỤC LƯU – nhiều bản app (bản gốc / bản copy / EXE đã cài) có thể cùng trỏ vào MỘT
// thư mục lưu (đã kiểm chứng thật). Chốt "một instance" theo workspace không nhìn thấy nhau;
// khoá này nằm trong chính thư mục lưu nên nhìn thấy mọi bản.
const WORKSPACE = path.resolve(__dirname, '..');
let lockBlockedLogged = false;
function outputBusy() {
  if (!output) return true; // chưa có thư mục lưu thì không chạy nền
  return outputLock.inspect(output, { pid: process.pid, workspace: WORKSPACE }).state === 'other';
}
function touchOutputLock() {
  if (!output) return;
  const result = outputLock.claim(output, { pid: process.pid, workspace: WORKSPACE });
  // Chỉ ghi log khi TRẠNG THÁI ĐồI, không rải một dòng mỗi nhịp 20 giây.
  if (!result.ok && result.state === 'other') {
    if (!lockBlockedLogged) { log(`Chạy nền nhường: ${result.reason}.`); lockBlockedLogged = true; }
  } else if (lockBlockedLogged) {
    log('Chạy nền: đã giành lại khoá thư mục lưu.');
    lockBlockedLogged = false;
  }
}
const backgroundSync = createSyncScheduler({
  get windows() { return syncWindowConfig().windows; },
  dueMsts,
  runOne: (mst, { days }) => autoSyncFor(mst).run('window', { days }),
  pauseOne: pauseBackgroundFor,
  uiClosed,
  // Quét bù cũng là "việc nền" ⇒ lịch theo khung giờ đứng ngoài, không tranh MST/cổng thuế.
  manualBusy: () => manualBusyNow() || catchupJob.running,
  outputBusy,
  heartbeat: touchOutputLock,
  log,
});
// BỂ "ĐỒNG BỘ TẤT CẢ" – người dùng bấm là chạy NGAY (không phụ thuộc khung giờ / cửa sổ app).
// Mỗi MST một profile Chrome + kho cookie riêng nên chạy song song không lẫn phiên. Giữ luôn đủ
// số luỒng: MST nào xong thì rút MST kế tiếp. Dùng `days` của TỪNG MST – giống nút ▶ trên dòng,
// để "tải toàn bộ" không tự ý đổi khoảng ngày người dùng đã đặt cho hỒ sơ đó.
const syncPool = createSyncPool({
  concurrency: 3,
  runOne: mst => autoSyncFor(mst).run('pool'),
  pause: pauseBackgroundFor,
  // Không tranh việc ưu tiên cao hơn. `false` cứng (bản trước) khiến bể vẫn chạy khi quét bù
  // đang chạy và khi một bản app KHÁC đang giữ khoá thư mục lưu – hai nơi đều ghi vào cùng
  // data.db mà khoá chỉ bảo vệ đường chạy NỀN. Ưu tiên: người dùng > bể > lịch nền.
  shouldStop: () => catchupJob.running || outputBusy(),
  log,
});
// Đối soát lúc khởi động: dòng nào `status: 'running'` mà không còn engine sống nghĩa là tiến trình
// trước bị ngắt giữa lượt (đã gặp thật hôm nay). Để nguyên thì banner báo "đang chạy" mãi và bộ lập
// lịch tưởng MST đó đang bận. Đưa về 'idle', giữ nguyên mọi trường khác.
function reconcileInterruptedSync() {
  try {
    if (!output) return;
    const data = dataLayer();
    for (const account of activeAccounts()) {
      const file = path.join(data.mst.mstDirectory(output, account.mst), 'sync.json');
      if (!fs.existsSync(file)) continue;
      const state = data.mst.readSyncState(file);
      let touched = false;
      for (const key of ['buy', 'sell']) {
        if (state[key] && state[key].status === 'running') { state[key] = { ...state[key], status: 'idle' }; touched = true; }
      }
      if (touched) { data.mst.writeSyncState(file, state); log(`Đối soát: MST ${account.mst} có lượt chạy bị ngắt – đưa về trạng thái nghỉ.`); }
    }
  } catch (error) { log('Đối soát trạng thái đỒng bộ lỗi: ' + (error && error.message ? error.message : error)); }
}

// ---- QUÉT BÙ LỊCH SỬ: lấp những NGÀY CÒN THIẾU trong toàn bộ thời gian thiết bị đã hoạt động ----
// NGUYÊN TẮC: người dùng là ưu tiên số 1. Chỉ chạy khi cửa sổ app đã IM ≥ 10 giây (không còn
// giao diện gọi về) VÀ lượt quét NGÀY HÓM NAY của MST đó đã xong. Mở lại cửa sổ giữa chừng là
// đoạn đang chạy dừng gọn ở hoá đơn kế tiếp và lượt sau tiếp đúng chỗ dừng (không ghi sổ).
// Mỗi lượt làm MỘT đoạn (tối đa ~1 tháng) nên nhường người dùng rất nhanh.
// NHIỀU MST chạy SONG SONG được khi máy rảnh: mỗi MST có data.db/sync.json/kho cookie riêng nên
// không lẫn phiên (giống "ĐỒng bộ tất cả"). Chỉ MST CHƯA có token mới phải đi một mình vì phải
// dùng chung cửa sổ Chrome.
const CATCHUP_STATE_KEY = 'catchup.scan';
const CATCHUP_TICK_MS = 30000;
// Lượt quét bù lỗi ⇒ tạm nghỉ MST đó vài phút: vừa tránh dội cổng thuế mỗi 30 giây, vừa để MST
// khác không bị chặn (MST còn ngày thiếu vẫn luôn được chọn lại nếu không có cooldown).
const CATCHUP_FAIL_COOLDOWN_MS = 5 * 60 * 1000;
let catchupTimer = null;
let catchupReason = 'chưa chạy';
let catchupTargetCache = { msts: [], at: '' }; // chỉ để UI biết đang nhắm (các) MST nào
const catchupCooldown = new Map();              // (thư mục + mst) → mốc hết tạm nghỉ sau lượt lỗi

// Sổ quét bù nằm trong bảng sync_state của ĐÚNG MST đó (đã có sẵn, không thêm bảng/schema).
function readCatchupLedger(mst) {
  try {
    if (!output) return null;
    const data = dataLayer();
    const dbFile = path.join(data.mst.mstDirectory(output, mst), 'data.db');
    if (!fs.existsSync(dbFile)) return null;
    return data.repository.getSyncState(readDatabase(dbFile), CATCHUP_STATE_KEY);
  } catch { return null; }
}
// Tóm tắt sổ quét bù để hiện lên dòng MST. Đọc DB mỗi nhịp poll 1,5 giây là quá nặng nên nhớ đệm;
// sổ chỉ đổi qua writeCatchupLedger (đã xoá đệm) nên số liệu luôn đúng.
// Khoá đệm gắn CẢ thư mục lưu (catchupCacheKey): đổi thư mục lưu là số liệu cũ tự bị bỏ qua.
const catchupSummaryCache = new Map();
function writeCatchupLedger(mst, ledger) {
  try {
    if (!output) return;
    const data = dataLayer();
    const dbFile = path.join(data.mst.mstDirectory(output, mst), 'data.db');
    data.repository.setSyncState(readDatabase(dbFile), CATCHUP_STATE_KEY, ledger);
    catchupSummaryCache.delete(catchupCacheKey(output, mst)); // sổ vừa đổi – bỏ đệm để UI thấy ngay
  } catch (error) { log('Ghi sổ quét bù lỗi: ' + (error && error.message ? error.message : error)); }
}
function catchupSummaryFor(mst) {
  // Đệm gắn khoá theo CẢ thư mục lưu: đổi "Thư mục lưu" thì sổ cũ tự bị bỏ qua, không hiện nhầm
  // "đã quét bù tới ngày X" của thư mục trước.
  const key = catchupCacheKey(output, mst);
  const cached = catchupSummaryCache.get(key);
  if (cached) return cached;
  const ledger = readCatchupLedger(mst) || {};
  const days = Object.keys(ledger.days || {}).sort();
  const value = { scannedTo: days.length ? days[days.length - 1] : '', scannedDays: days.length };
  catchupSummaryCache.set(key, value);
  return value;
}
// Trạng thái quét bù của MỘT MST cho giao diện: đang quét MST này hay không + đã quét tới ngày nào.
function catchupFor(mst) {
  const summary = catchupSummaryFor(mst);
  let live = null;
  try { live = (catchupJob.status().progresses || []).find(item => item.mst === mst) || null; } catch { live = null; }
  return {
    running: !!live,
    from: live ? live.from || '' : '',
    to: live ? live.to || '' : '',
    scannedTo: summary.scannedTo,
    scannedDays: summary.scannedDays,
  };
}
// Ngày hoá đơn cũ nhất đang có trong kho (chỉ đọc file đã tỒn tại – không tạo DB rỗng).
function earliestInvoiceDay(mst) {
  try {
    if (!output) return '';
    const data = dataLayer();
    const dbFile = path.join(data.mst.mstDirectory(output, mst), 'data.db');
    if (!fs.existsSync(dbFile)) return '';
    const row = readDatabase(dbFile).prepare('SELECT MIN(ngay_lap) AS day FROM invoices').get();
    return row && row.day ? String(row.day).slice(0, 10) : '';
  } catch { return ''; }
}
// Mốc bắt đầu quét bù. Máy đã dùng trước khi app ghi `firstRunAt` thì lấy thêm ngày hoá đơn cũ
// nhất (nếu cũ hơn) để không bỏ sót dữ liệu cũ.
function catchupStartFor(mst) {
  const first = vnDate.dayOf(accounts.firstRunAt) || '';
  const oldest = earliestInvoiceDay(mst);
  if (first && oldest) return first < oldest ? first : oldest;
  return first || oldest;
}
function catchupEndDay() { return vnDate.dayOf(Date.now() - 86400000) || ''; }

// Cổng của quét bù: KHÁC bộ lập lịch theo khung giờ – không phụ thuộc giờ làm việc, chỉ phụ thuộc
// "máy có thật sự rảnh không".
function catchupGate() {
  const reason = catchupGateReason({
    output,
    uiOpen: !uiClosed(),
    manualBusy: manualBusyNow(),
    authBusy: authBusy.size > 0 || !!loginChallenge,
    // Lượt Auto Sync BẤM TAY (▶) vẫn chạy tiếp sau khi đóng cửa sổ ⇒ phải tính là "đang bận",
    // nếu không quét bù sẽ chạy chỒng lên đúng MST đó.
    autoSyncRunning: anyAutoSyncRunning(),
    poolRunning: syncPool.running,
    backgroundRunning: backgroundSync.running,
    outputBusy: outputBusy(),
  });
  return { ok: !reason, reason };
}

// Số MST quét bù chạy SONG SONG. Mỗi MST có data.db/sync.json/kho cookie riêng nên chạy song song
// không lẫn phiên. Số luỒng được CHỌN NGẪU NHIÊN 2‒5 mỗi nhịp để tối ưu (không phải lúc nào cũng
// dỒn hết vào cổng thuế); đặt HOADON_CATCHUP_PARALLEL để cố định một số.
const CATCHUP_MIN_LANES = 2;
const CATCHUP_MAX_LANES = 5;
function catchupLaneCount() {
  const forced = Number(process.env.HOADON_CATCHUP_PARALLEL);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  return CATCHUP_MIN_LANES + Math.floor(Math.random() * (CATCHUP_MAX_LANES - CATCHUP_MIN_LANES + 1));
}
let catchupLanes = CATCHUP_MIN_LANES; // số luỒng dùng ở nhịp này (hiện lên trạng thái cho UI)

// Danh sách MST tới lượt quét bù: còn phiên lưu + đã xong lượt quét HÓM NAY + sổ còn ngày thiếu.
// KHÓNG lọc MST đang chạy ở đây – nơi chọn tự bỏ qua, để không bỏ sót MST đang chạy dở.
function catchupEligible() {
  if (!output) return [];
  const data = dataLayer();
  const end = catchupEndDay();
  if (!end) return [];
  const nowMs = Date.now();
  const clock = syncWindow.vnClock(new Date());
  const rows = [];
  for (const account of activeAccounts()) {
    const mst = account.mst;
    if (!hasSavedSession(mst)) continue;
    if (syncPool.isActive(mst)) continue;
    // Lượt Auto Sync BẤM TAY của CHÍNH MST này đang chạy ⇒ nhường (xem catchupGate).
    const manual = autoSyncByMst.get(mst);
    if (manual && manual.running) continue;
    if (Number(catchupCooldown.get(catchupCacheKey(output, mst))) > nowMs) continue;
    let state = null;
    try { state = data.mst.readSyncState(path.join(data.mst.mstDirectory(output, mst), 'sync.json')); } catch { state = null; }
    // Điều kiện người dùng yêu cầu: CHỈ quét bù SAU KHI lượt quét ngày hiện tại đã xong.
    if (!dailySyncState(state, clock).synced) continue;
    const start = catchupStartFor(mst);
    if (!start) continue;
    const ledger = readCatchupLedger(mst);
    const plan = planCatchup({ start, end, scanned: (ledger && ledger.days) || {}, now: nowMs });
    if (!plan.segments.length) continue;
    // `lastRunAt` để xếp hàng công bằng: MST lâu chưa quét nhất được chọn trước.
    rows.push({ mst, start, end, plan, lastRunAt: (ledger && ledger.lastRunAt) || '' });
  }
  return rows;
}

// Chọn MST chạy NGAY ở nhịp này: lấp đầy số luỒng còn trống, không chọn lại MST đang chạy.
// MST đã có token đi thẳng (song song được); MST CHƯA token phải qua cửa sổ Chrome DÙNG CHUNG nên
// chỉ cho chạy MỘT MÌNH – tránh hai MST tranh cùng một cửa sổ.
function catchupPick() {
  const running = catchupJob.status().msts;
  return pickCatchupTargets({
    eligible: catchupEligible(),
    running,
    lanes: catchupLanes,
    hasToken: mst => directTokens.has(mst),
  });
}

const catchupJob = createCatchupJob({
  readLedger: mst => readCatchupLedger(mst),
  writeLedger: (mst, ledger) => writeCatchupLedger(mst, ledger),
  runRange: range => runBackfillRange(range),
  log,
});

// Chạy MỘT đoạn cho MỘT MST. Nhiều lượt như vậy chạy song song được (xem catchupTick).
async function catchupRunTarget(target) {
  try {
    const result = await catchupJob.runOne(target.mst, {
      start: target.start,
      end: target.end,
      // Ngưng NGAY khi có người dùng trở lại (mở cửa sổ) hoặc có việc thủ công chen vào.
      isCancelled: () => !catchupGate().ok,
    });
    if (result && result.cancelled) {
      catchupReason = 'đã nhường người dùng – lượt sau tiếp tục';
    } else if (result && result.ok) {
      catchupCooldown.delete(catchupCacheKey(output, target.mst));
      const where = result.segment ? ` ${result.segment.from} → ${result.segment.to}` : '';
      log(`Quét bù MST ${target.mst}${where}: tải ${result.totals.downloaded}, nhập ${result.totals.imported}, còn ${result.remaining} ngày thiếu.`);
      catchupReason = result.done ? 'không còn ngày thiếu' : `MST ${target.mst}: đã quét ${result.segment ? result.segment.from + ' → ' + result.segment.to : ''}, còn ${result.remaining} ngày`;
    } else {
      // Lỗi ⇒ KHÓNG ghi sổ nên ngày đó vẫn thiếu; tạm nghỉ MST này rỒi làm lại ở lượt sau.
      catchupCooldown.set(catchupCacheKey(output, target.mst), Date.now() + CATCHUP_FAIL_COOLDOWN_MS);
      catchupReason = result && result.error ? String(result.error) : 'lượt quét bù không xong';
      log(`Quét bù MST ${target.mst} tạm nghỉ do lỗi: ${catchupReason}`);
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    catchupReason = message;
    catchupCooldown.set(catchupCacheKey(output, target.mst), Date.now() + CATCHUP_FAIL_COOLDOWN_MS);
    log('Quét bù lỗi: ' + message);
  }
}

async function catchupTick() {
  const gate = catchupGate();
  if (!gate.ok) { catchupReason = gate.reason; return; }
  catchupLanes = catchupLaneCount(); // mỗi nhịp chọn lại 2‒5 luỒng
  let picks = [];
  try { picks = catchupPick(); }
  catch (error) { catchupReason = 'lỗi đọc sổ quét bù: ' + (error && error.message ? error.message : error); return; }
  if (!picks.length) {
    // Không có gì mới để chạy: chỉ báo "hết việc" khi thật sự không còn lượt nào đang chạy.
    if (!catchupJob.running) { catchupReason = 'không MST nào cần quét bù'; catchupTargetCache = { msts: [], at: '' }; }
    return;
  }
  catchupTargetCache = { msts: picks.map(target => target.mst), at: new Date().toISOString() };
  catchupReason = `đang quét bù ${picks.length} MST: ${picks.map(target => target.mst).join(', ')}`;
  // KHÓNG await: nhịp sau vẫn lấp được chỗ trống. Chốt chạy-trùng nằm trong job (theo từng MST).
  for (const target of picks) catchupRunTarget(target);
}

function startCatchupTimer() {
  if (catchupTimer) return catchupTimer;
  catchupTimer = setInterval(() => { catchupTick().catch(() => {}); }, CATCHUP_TICK_MS);
  if (catchupTimer.unref) catchupTimer.unref();
  return catchupTimer;
}
function stopCatchupTimer() { if (catchupTimer) { clearInterval(catchupTimer); catchupTimer = null; } }
function catchupStatus() {
  const job = catchupJob.status();
  return {
    enabled: true,
    running: job.running,
    mst: job.running && job.progress ? job.progress.mst : (catchupTargetCache.msts[0] || ''),
    msts: job.msts,                    // danh sách MST đang quét bù (nhiều MST một lúc)
    lanes: catchupLanes,               // số luỒng dùng ở nhịp này (ngẫu nhiên 2‒5)
    // Chi tiết từng MST đang quét bù (MST nào · tới ngày nào) cho giao diện.
    active: job.msts.map(mst => {
      const progress = (job.progresses || []).find(item => item.mst === mst) || {};
      return { mst, from: progress.from || '', to: progress.to || '', direction: progress.direction || '', message: progress.message || '' };
    }),
    reason: catchupReason,
    targetAt: catchupTargetCache.at,
    progress: job.progress,
  };
}

// Agent adapter wraps existing services; no model-generated SQL, shell or page JS.
function getAgentServices() {
  const clean = row => Object.fromEntries(Object.entries(row).filter(([key]) => !/file|path|url|lookup|token|password|secret/i.test(key)));
  const withAgentDb = fn => {
    if (!selected) throw Object.assign(new Error('Chưa chọn MST. Chọn MST rồi thử lại.'), { code: 'MST_REQUIRED' });
    if (!output) throw new Error('Chưa chọn thư mục lưu dữ liệu.');
    const data = dataLayer(), dir = data.mst.mstDirectory(output, selected), file = path.join(dir, 'data.db');
    if (!fs.existsSync(file)) throw Object.assign(new Error('MST này chưa có kho dữ liệu. Tải hoặc nhập XML trước.'), { code: 'DATA_NOT_READY' });
    return fn(readDatabase(file), data);
  };
  const context = () => ({
    app: { name: 'CNTaxTools', version: require('../package.json').version, today: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }) },
    currentUser: { selectedMst: selected, accountStatus: !!selected && !!(authAccount || directTokens.has(selected)) ? 'authenticated' : 'unauthenticated' },
    accounts: activeAccounts().map(account => ({ mst: account.mst, label: account.label || '' })),
    download: downloadStatus(),
  });
  const downloadStatus = () => {
    const target = engineOf(selected), state = target?.snapshot() || {};
    return { mst: selected, jobId: target?.job?.id || null, busy: !!target?.busy, state: state.state || 'idle', total: state.total || 0, done: state.done || 0, failed: state.failed || 0, message: state.message || '' };
  };
  return {
    context, downloadStatus,
    permissionContext: () => ({ deviceId: support.data.device.machineId,
      fingerprint: crypto.createHash('sha256').update(JSON.stringify({ selected, output, accounts: activeAccounts().map(a => a.mst), jobId: engineOf(selected)?.job?.id || '' })).digest('hex') }),
    openExport: file => new Promise((resolve, reject) => {
      // Called only by a user's file button; service resolves the export ID, never model paths.
      const child = spawn('explorer.exe', [file], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    }),
    search: args => withAgentDb((db, data) => {
      const first = data.queries.listInvoices(db, { ...args, limit: 200, offset: 0 });
      if (first.total > 20000) throw new Error('Có hơn 20.000 hóa đơn. Chọn khoảng ngày hẹp hơn hoặc dùng tổng hợp.');
      const rows = first.rows;
      for (let offset = 200; offset < first.total; offset += 200) rows.push(...data.queries.listInvoices(db, { ...args, limit: 200, offset }).rows);
      return rows.map(clean);
    }),
    latest: args => withAgentDb((db, data) => {
      const first = data.queries.listInvoices(db, { ...args, limit: 1, offset: 0 });
      const invoice = first.rows[0];
      const sameDateCount = invoice ? data.queries.listInvoices(db, { ...args, from: invoice.ngay_lap, to: invoice.ngay_lap, limit: 1, offset: 0 }).total : 0;
      return { invoice: invoice ? clean(invoice) : null, sameDateCount, note: 'Ngày lập mới nhất; cùng ngày ưu tiên hóa đơn được nhập kho sau. Ngày lập không xác định thứ tự thời gian trong ngày.' };
    }),
    goods: args => withAgentDb((db, data) => {
      const value = data.queries.products(db, { ...args, limit: 500 });
      if (value.rows.length >= 500) throw new Error('Có ít nhất 500 nhóm hàng; lọc theo tên/chiều/kỳ để xuất đầy đủ.');
      return value.rows.map(clean);
    }),
    read: key => withAgentDb((db, data) => {
      const value = data.queries.getInvoice(db, key);
      if (!value) throw new Error('Không tìm thấy hóa đơn.');
      return { invoice: clean(value.invoice), items: value.items.slice(0, 500).map(clean), itemCount: value.items.length, truncated: value.items.length > 500 };
    }),
    items: key => withAgentDb((db, data) => {
      const value = data.queries.getInvoice(db, key);
      if (!value) throw new Error('Không tìm thấy hóa đơn.');
      if (value.items.length > 20000) throw new Error('Hóa đơn có hơn 20.000 dòng hàng; cần engine dữ liệu lớn trước khi xuất đầy đủ.');
      return value.items.map(clean);
    }),
    summary: args => withAgentDb((db, data) => data.queries.summary(db, args)),
    select: async (mst, expectedSourceMst, signal) => {
      if (!activeAccounts().some(account => account.mst === mst)) throw new Error('MST không có trong danh sách ứng dụng.');
      await selectOperation(() => {
        signal?.throwIfAborted();
        if (expectedSourceMst !== selected) throw Object.assign(new Error('MST nguồn đã đổi; cần phê duyệt lại.'), { code: 'COMPANY_SCOPE_CHANGED' });
        return selectAccount(mst);
      }, mst);
      if (selected !== mst) throw new Error('Chưa chọn được MST.');
      return { selectedMst: selected };
    },
    refresh: async (signal, expectedMst) => {
      if (!selected) throw Object.assign(new Error('Chưa chọn MST.'), { code: 'MST_REQUIRED' });
      if (expectedMst !== selected) throw Object.assign(new Error('MST đã đổi; không dùng quyền của công ty khác.'), { code: 'COMPANY_SCOPE_CHANGED' });
      const mst = selected;
      signal.throwIfAborted();
      const account = await authOperation(checkLogin, mst);
      signal.throwIfAborted();
      if (selected !== mst) throw new Error('MST đã thay đổi trong lúc kiểm tra phiên.');
      if (!account) throw Object.assign(new Error('Phiên hết hạn. Đăng nhập lại bằng form ứng dụng.'), { code: 'SESSION_EXPIRED' });
      return { mst, authenticated: true };
    },
    download: async (args, signal, expectedMst) => {
      const approvedFolder = output;
      if (expectedMst !== selected) throw Object.assign(new Error('MST đã đổi; không bắt đầu tải ở công ty khác.'), { code: 'COMPANY_SCOPE_CHANGED' });
      await ensureLicenseAllowed(); await ensureSessionCheck(); signal.throwIfAborted();
      if (expectedMst !== selected || approvedFolder !== output) throw Object.assign(new Error('Phạm vi tải đã đổi; cần phê duyệt lại.'), { code: 'COMPANY_SCOPE_CHANGED' });
      const mst = selected;
      if (!mst) throw Object.assign(new Error('Chưa chọn MST.'), { code: 'MST_REQUIRED' });
      const target = ensureEngineFor(mst);
      if (target.busy) throw new Error('MST đang có tác vụ tải. Kiểm tra tiến độ, không bắt đầu lượt mới.');
      if (authBusy.has(mst)) throw new Error('Đang đăng nhập MST này, thử lại khi hoàn tất.');
      if (!directTokens.has(mst) && !authAccount) throw Object.assign(new Error('Đăng nhập cổng thuế trước khi tải.'), { code: 'SESSION_EXPIRED' });
      const params = validateParams({ ...args, direction: args.direction === 'SELL' ? 'sold' : 'purchase', family: 'both', status: '', formats: ['xml', 'xlsx'] });
      await ensureFolder(approvedFolder); signal.throwIfAborted();
      if (expectedMst !== selected || approvedFolder !== output || target.busy) throw Object.assign(new Error('Phạm vi/tác vụ tải đã đổi; kiểm tra trạng thái và phê duyệt lại.'), { code: 'COMPANY_SCOPE_CHANGED' });
      const folder = output;
      let started = false;
      const ready = Promise.withResolvers();
      const task = runDetached(target, target.job?.id || '', `AI tải MST ${mst}`, async () => {
        await target.stream(params, folder, {
          authorizeStart: ensureLicenseAllowed,
          validateStart: () => { signal.throwIfAborted(); if (selected !== mst || output !== folder) throw Object.assign(new Error('Phạm vi đã đổi trước khi tạo job tải.'), { code: 'COMPANY_SCOPE_CHANGED' }); },
          onStarted: value => { started = true; ready.resolve(value); },
        });
        await closeBrowserWhenIdle('AI tải xong'); autoImportAfterDownload('AI tải xong');
      });
      task.then(result => { if (!started) ready.reject(result.error || new Error('Không tạo được job tải; không tự thử lại.')); });
      const beginning = await ready.promise;
      if (target.job?.id !== beginning.jobId) throw new Error('Không đọc lại được job vừa tạo; kiểm tra tab tải, không tự thử lại.');
      return { started: true, mst, jobId: beginning.jobId, message: 'Đã tạo và lưu job tải nền. Kiểm tra download_status để biết kết quả; chưa xác nhận tải hoàn tất.' };
    },
  };
}
let aiService;
async function endpoint(req, res, url) {
  if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Không có quyền truy cập giao diện.' });
  lastUiPoll = Date.now();
  if (url.pathname.startsWith('/api/ai/')) {
    try {
      if (!aiService) aiService = require('./ai-service').createAiService({
        dataDir, secrets, app: getAgentServices(), checkLicense: ensureLicenseAllowed,
        licenseSignature: () => {
          const value = support.publicLicense();
          return JSON.stringify([value.status, value.expiryAt, value.keyName, value.trial]);
        },
      });
      return await aiService.handle(req, res, url, readBody, reply);
    }
    catch (error) { return reply(res, 400, { ok: false, error: error.message }); }
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') { lastUiSeen = Date.now(); return reply(res, 200, { ok: true, value: appState() }); }
    // Bảng 1.000 dòng tách KHỎI /api/state: trạng thái tổng hợp (vài KB) poll mỗi nhịp, bảng chỉ
    // fetch lại khi engine.jobRevision đổi – payload mỗi nhịp rảnh giảm từ hàng trăm KB còn vài KB.
    if (req.method === 'GET' && url.pathname === '/api/state/items') {
      setCurrentEngine(selected);
      // Danh sách CUỘN như bản cũ – MỘT payload, KHÓNG nút sang trang (đo thật: 1.000 dòng
      // ≈ 145 KB mỗi nhịp poll khi đang tải, nên giữ trần 1.000 cho payload gọn; engine vẫn xử lý
      // và tải đủ toàn bộ). Thứ tự MỚI NHẤT TRƯỚC để hoá đơn vừa tải xong hiện ngay đầu bảng.
      const page = engine
        ? engine.itemsPage({ offset: 0, limit: 1000, newestFirst: true })
        : { total: 0, rows: [] };
      // `revision` của ĐÚNG engine trả về: UI so với revision đã vẽ để quyết định fetch lần sau.
      return reply(res, 200, { ok: true, revision: engine ? engine.jobRevision : 0, value: page.rows, total: page.total });
    }
  // ---- PHASE 3: Kho dữ liệu hoá đơn – đọc từ SQLite, KHÓNG quét XML khi mở danh sách (mục 15, 50, 33) ----
  if (url.pathname.startsWith('/api/db/')) {
    const data = dataLayer();
    const currentMst = () => {
      if (!selected) throw new Error('Chọn một MST trước.');
      if (!output) throw new Error('Chọn thư mục lưu trước.');
      return selected;
    };
    // Đợt 3: dùng kết nối ĐỌC dùng lại (readDatabase) thay vì mở/đóng mỗi request – không đổi
    // hình dạng dữ liệu trả về, chỉ bỏ phần mở + 7 PRAGMA + kiểm tra schema + đóng mỗi lần.
    // Van an toàn: HOADON_READ_CONN=0 quay về đúng đường cũ (mở/đóng mỗi request) khi cần chẩn đoán.
    const withDatabase = fn => {
      const mst = currentMst();
      const dir = data.mst.mstDirectory(output, mst);
      if (process.env.HOADON_READ_CONN === '0') {
        const { dir: dir2, db } = data.mst.ensureMst({ output, mst });
        try { return fn(db, dir2, mst); } finally { data.sqlite.closeDatabase(db); }
      }
      const db = readDatabase(path.join(dir, 'data.db'));
      return fn(db, dir, mst);
    };
    if (req.method === 'GET' && url.pathname === '/api/db/summary') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase((db, dir, mst) => reply(res, 200, { ok: true, value: { ...data.queries.summary(db, range), mst, dir, output } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/overview') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase((db, dir, mst) => reply(res, 200, { ok: true, value: { ...data.queries.overview(db, range), mst } }));
    }
    // CÓNG NỢ (mục 25) – PHẢI THU / PHẢI TRẢ tính từ kết quả đối chiếu ĐÃ LƯU.
    if (req.method === 'GET' && url.pathname === '/api/db/debts') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.debts(db, range) }));
    }
    // CHI TIẾT CÓNG NỢ (mục 5): bấm khách hàng / nhà cung cấp → danh sách hoá đơn của ĐỐI TÁC đó,
    // cùng công thức nhóm và cùng kỳ với2 con số trên thẻ CÓNG NỢ.
    if (req.method === 'GET' && url.pathname === '/api/db/debts/detail') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.debtsDetail(db, {
        direction: p.get('direction') || '', name: p.get('name') || '', range,
      }) }));
    }
    // DANH SÁCH CHI TIẾT HÀNG HÒA (mục 27): bấm một trong 4 cảnh báo trên thẻ Hàng hóa → danh sách
    // mặt hàng bị dính, lọc theo ĐÚNG công thức đã đếm trên thẻ (dùng chung goodsAnalysis).
    if (req.method === 'GET' && url.pathname === '/api/db/goods/detail') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true,
        value: data.queries.goodsDetail(db, { kind: p.get('kind') || '', range }) }));
    }
    // HÒA ĐƠN CHỨA một mặt hàng (bấm dòng top hàng hóa → danh sách để mở xem hoá đơn A4).
    if (req.method === 'GET' && url.pathname === '/api/db/products/invoices') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.productInvoices(db, {
        name: p.get('name') || '', direction: p.get('direction') || '', range,
      }) }));
    }
    // THUẾ / NGƯỠNG (mục 26) – ngưỡng lấy theo NĂM + LOẠI HÌNH KINH DOANH đã chọn,
    // KHÓNG có con số thuế nào được hard-code trong giao diện.
    if (req.method === 'GET' && url.pathname === '/api/db/tax') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.taxOverview(db, { year: p.get('year') || '', businessType: p.get('businessType') || '' }) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/invoices') {
      const p = url.searchParams;
      return withDatabase(async (db, dir) => {
        const value = data.queries.listInvoices(db, {
          q: p.get('q') || '', direction: p.get('direction') || '', from: p.get('from') || '', to: p.get('to') || '',
          state: p.get('state') || '',
          limit: p.get('limit'), offset: p.get('offset'),
        });
        // Nhãn trạng thái và trạng thái PDF GỐC (Mục 3) gắn ngay tại máy chủ: giao diện, Excel và
        // mọi đầu ra khác dùng CÙNG một nguỒn – không chép lại nhãn ở phía trình duyệt.
        // Thư mục pdf-goc chỉ quét 2 lần mỗi lần tải trang (mỗi chiều 1 lần), không quét
        // lại theo từng dòng.
        const index = {
          Mua_vao: data.originalPdf.indexOriginalFolder(dir, 'Mua_vao'),
          Ban_ra: data.originalPdf.indexOriginalFolder(dir, 'Ban_ra'),
        };
        return reply(res, 200, {
          ok: true,
          value: {
            ...value,
              rows: value.rows.map(row => {
                row = data.providerRegistry.resolveInvoice(row);
              const dirName = row.direction === 'SELL' ? 'Ban_ra' : 'Mua_vao';
              const original = data.originalPdf.findOriginalPdf(dir, dirName, row, index[dirName]);
              const badge = data.originalPdf.badgeFor(row, original);
              return {
                ...row,
                stateLabel: data.invoiceState.label(row.tthai),
                original_state: badge.kind,
                original_reason: original ? '' : data.originalPdf.reasonMissing(row),
              };
            }),
          },
        });
      });
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
    // §35: xem trước hoá đơn khổ A4 chuẩn Tổng cục Thuế – đọc ĐÚNG MỘT file XML, KHÓNG gọi API.
    // Trả về tài liệu HTML (không phải JSON) để nhúng vào iframe; tài liệu này tự đặt CSP riêng:
    // chặn mọi tài nguyên ngoài, chỉ cho style inline (bộ dựng A4 dùng style inline).
    if (req.method === 'GET' && url.pathname === '/api/db/invoice/html') {
      const key = url.searchParams.get('key') || '';
      const html = withDatabase(db => {
        const found = data.queries.getInvoice(db, key);
        if (!found) throw new Error('Không tìm thấy hoá đơn trong data.db.');
        const fileXml = String(found.invoice.file_xml || '');
        if (!fileXml || !fs.existsSync(fileXml)) throw new Error('File XML không còn ở đường dẫn đã lưu trong data.db.');
        // Cache theo mtime: file XML gốc không đổi ⇒ HTML dựng lại y hệt; file đổi (hiếm) thì cache miss tự tính lại.
        const stat = fs.statSync(fileXml);
        // tthai: lấy từ kho (XML không mang trạng thái) để bản xem trước/PDF ghi đúng trạng thái.
        const state = found.invoice.tthai == null ? '' : String(found.invoice.tthai);
        const cacheKey = `${fileXml}|${stat.mtimeMs}|${stat.size}|${state}`;
        let cached = a4HtmlCache.get(cacheKey);
        if (!cached) {
          cached = require('./data/invoice-a4').buildInvoiceA4Document(fs.readFileSync(fileXml, 'utf8'), { state });
          if (a4HtmlCache.size >= 100) a4HtmlCache.delete(a4HtmlCache.keys().next().value); // FIFO đơn giản
          a4HtmlCache.set(cacheKey, cached);
        }
        return cached;
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
    if (req.method === 'GET' && url.pathname === '/api/db/partners/invoices') {
      // Toàn bộ hoá đơn của một đối tác – mở khi bấm một dòng trong tab Đối tác. from/to là
      // tuỳ chọn: tab Đối tác cố ý KHÓNG lọc theo kỳ (giống sheet "Nhà cung cấp" khi xuất
      // Excel) nên UI thường không gửi, và chi tiết cũng vậy ⇒ số dòng khớp đúng số đã hiện.
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: data.queries.partnerInvoices(db, {
          direction: p.get('direction') || '', mst: p.get('mst') || '', ten: p.get('ten') || '',
          from: p.get('from') || '', to: p.get('to') || '', limit: p.get('limit'), offset: p.get('offset'),
        }),
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/partners') {
      const p = url.searchParams;
      const requested = String(p.get('kind') || 'all');
      const kind = ['supplier', 'buyer', 'all'].includes(requested) ? requested : 'all';
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: { rows: data.queries.partners(db, { kind, limit: p.get('limit'), from: p.get('from') || '', to: p.get('to') || '' }) },
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/import/status') {
      return reply(res, 200, { ok: true, value: data.importJob.status() });
    }
    // ---- SAO KÊ NGÂN HÀNG (tab riêng ở header) ----
    // POST /api/db/bank/preview : đọc file (Excel/CSV/PDF chữ local qua UI, PDF scan/ảnh qua AI),
    //   chuẩn hoá + KIỂM TRA SỐ LIỆU – KHÓNG ghi gì vào DB. UI hiển thị kết quả rỒi user quyết định.
    if (req.method === 'POST' && url.pathname === '/api/db/bank/preview') {
      await ensureLicenseAllowed();
      const input = await readBankUpload(req);
      const kind = /\.pdf$/i.test(input.fileName) ? 'pdf-scan-ai'
        : (/\.(png|jpe?g)$/i.test(input.fileName) ? 'image-ai' : 'excel');
      let rows;
      if (kind === 'pdf-scan-ai' || kind === 'image-ai') rows = await aiConvertPdfToTables(input.buffer);
      else rows = data.bankStatement.parseWorkbookBuffer(input.buffer, input.fileName);
      const preview = data.bankStatement.previewRows(rows);
      return reply(res, 200, {
        ok: true,
        value: {
          kind,
          fileName: input.fileName,
          fileHash: kind === 'excel' ? require('node:crypto').createHash('sha1').update(input.buffer).digest('hex') : '',
          rawRowCount: rows.length,
          ...preview,
        },
      });
    }
    // POST /api/db/bank/import-rows : CHỈ LƯU sau khi user đã xem preview (xác nhận rỒi mới gọi).
    if (req.method === 'POST' && url.pathname === '/api/db/bank/import-rows') {
      await ensureLicenseAllowed();
      const input = await readBankJson(req);
      const rows = Array.isArray(input.rows) ? input.rows : [];
      if (!rows.length) throw new Error('Không có dòng nào để lưu.');
      return withDatabase(db => {
        // Chuẩn hoá LẠI trên server từ chính các dòng user xác nhận – không tin dữ liệu đã chuẩn hoá sẵn.
        // Dựng grid bằng hàm dùng chung với module (một nguỒn sự thật, tránh lệch giữa test và server).
        const grid = data.bankStatement.normalizedRowsToGrid(rows);
        const value = data.bankStatement.importRows(db, {
          fileName: String(input.fileName || 'sao-ke.pdf'),
          fileHash: String(input.fileHash || ''),
          rows: grid,
        });
        return reply(res, 200, { ok: true, value });
      });
    }
    // POST /api/db/bank/preview-rows : giống /preview nhưng UI đã đọc được GRID (PDF chữ local
    // bằng pdfjs) – server chỉ chuẩn hoá + kiểm tra, KHÓNG đọc file, KHÓNG ghi DB.
    if (req.method === 'POST' && url.pathname === '/api/db/bank/preview-rows') {
      await ensureLicenseAllowed();
      const input = await readBankJson(req);
      if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('Không nhận được bảng chữ từ PDF.');
      return reply(res, 200, {
        ok: true,
        value: { kind: 'pdf-text', fileName: String(input.fileName || 'sao-ke.pdf'), fileHash: '', ...data.bankStatement.previewRows(input.rows) },
      });
    }
    // POST /api/db/bank/import : đường CŨ (Excel/CSV nhập thẳng) – giữ nguyên cho tương thích.
    if (req.method === 'POST' && url.pathname === '/api/db/bank/import') {
      await ensureLicenseAllowed();
      const input = await readBankUpload(req);
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: data.bankStatement.importWorkbook(db, { buffer: input.buffer, fileName: input.fileName }),
      }));
    }
    // POST /api/db/bank/move : chuyển TOÀN BỘ file sao kê (fileId) sang data.db của MST khác.
    if (req.method === 'POST' && url.pathname === '/api/db/bank/move') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const toMst = String(input.toMst || '').trim();
      if (!toMst) throw new Error('Chưa chọn MST đích.');
      return withDatabase((sourceDb, dir, mst) => {
        if (toMst === mst) throw new Error('MST đích trùng với MST hiện tại.');
        const { dir: targetDir, db: targetDb } = data.mst.ensureMst({ output, mst: toMst });
        try {
          const value = data.bankStatement.moveFileToMst(sourceDb, targetDb, { fileId: input.fileId, toMst });
          return reply(res, 200, { ok: true, value });
        } finally { data.sqlite.closeDatabase(targetDb); }
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/summary') {
      const p = url.searchParams;
      const range = {
        q: p.get('q') || '', from: p.get('from') || '', to: p.get('to') || '', flow: p.get('flow') || '',
        min: p.get('min') || '', max: p.get('max') || '', category: p.get('category') || '',
        status: p.get('status') || '', account: p.get('account') || '',
      };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.summary(db, range) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/files') {
      return withDatabase(db => reply(res, 200, { ok: true, value: { rows: data.bankStatement.listFiles(db) } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/transactions') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, {
        ok: true,
        value: data.bankStatement.listTransactions(db, {
          q: p.get('q') || '', from: p.get('from') || '', to: p.get('to') || '',
          flow: p.get('flow') || '', min: p.get('min') || '', max: p.get('max') || '',
          category: p.get('category') || '', status: p.get('status') || '', account: p.get('account') || '',
          limit: p.get('limit'), offset: p.get('offset'),
        }),
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/daily') {
      const p = url.searchParams;
      // dailyTotals() trả { rows, truncated, totalDays, firstDay, limit } – phần cắt 400 ngày
      // phải nói ra để giao diện báo người dùng thay vì vẽ thiếu trong im lặng.
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.dailyTotals(db, {
        q: p.get('q') || '', from: p.get('from') || '', to: p.get('to') || '', flow: p.get('flow') || '',
        min: p.get('min') || '', max: p.get('max') || '', category: p.get('category') || '',
        status: p.get('status') || '', account: p.get('account') || '',
      }) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/categories') {
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.categories(db) }));
    }
    // Mọi route GHI vào kho đều phải qua ensureLicenseAllowed() – nếu không, bản quyền hết
    // hạn vẫn tạo/xoá/phân loại được dữ liệu. Bỏ sót: delete · categories · category (nhóm
    // nhẹ) và /reconciliation/run (nặng nhất – chạy trọn rebuild() toàn database).
    if (req.method === 'POST' && url.pathname === '/api/db/bank/categories') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.createCategory(db, input) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/db/bank/category') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.setCategory(db, input) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/db/reconciliation/run') {
      await ensureLicenseAllowed();
      return withDatabase(db => reply(res, 200, { ok: true, value: data.reconciliation.rebuild(db) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/reconciliation/summary') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.reconciliation.summary(db, range) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/reconciliation/list') {
      return withDatabase(db => reply(res, 200, { ok: true, value: { rows: data.reconciliation.list(db, { limit: url.searchParams.get('limit') }) } }));
    }
    // Danh sách CẦN KIỂM TRA (mục 27): bấm vào con số cảnh báo ở Tổng quan là ra danh sách này.
    if (req.method === 'GET' && url.pathname === '/api/db/reconciliation/pending') {
      return withDatabase(db => reply(res, 200, { ok: true, value: data.reconciliation.listPending(db, { limit: url.searchParams.get('limit') }) }));
    }
    // REPROCESS PAYMENT METHOD (mục 32): đọc lại file XML gốc để bù hình thức thanh toán
    // cho hoá đơn nhập trước khi hệ thống có cột này. KHÓNG sửa XML, KHÓNG sửa số tiền.
    if (req.method === 'POST' && url.pathname === '/api/db/invoices/reprocess-payment') {
      return withDatabase(async (db, dir) => reply(res, 200,
        { ok: true, value: await data.xmlScanner.reprocessPaymentMethods({ db, mstDir: dir }) }));
    }
    // Xuất bảng tổng hợp quý ra Excel – cùng bộ số liệu với màn hình, KHÓNG phải bảng
    // hoá đơn. Xuất riêng theo kỳ đang chọn.
    if (req.method === 'GET' && url.pathname === '/api/db/vat/quarter.xlsx') {
      return withDatabase((db, dir, mst) => {
        const p = url.searchParams;
        const year = Number(p.get('year')) || new Date().getFullYear();
        const quarter = Number(p.get('quarter')) || 1;
        let value;
        try { value = data.vatSummary.quarterSummary(db, { year, quarter, deduction: Number(p.get('deduction')) || 0 }); }
        catch (error) { return reply(res, 400, { ok: false, error: error.message }); }
        const book = data.excelExport.vatQuarterWorkbook(value);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="tong-hop-quy-${mst}-${book.filename}"`,
          'Content-Length': book.buffer.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(book.buffer);
      });
    }
    // MỤC 4.2 – BẢNG TồNG HỢP THEO QUÝ: số liệu để kê khai thuế GTGT. Chưa sinh XML
    // (Mục 4.3) – endpoint này chỉ TRẢ SỐ LIỆU, kèm lý do ước lượng nếu có.
    if (req.method === 'GET' && url.pathname === '/api/db/vat/quarter') {
      return withDatabase(db => {
        const periods = data.vatSummary.availablePeriods(db);
        const year = Number(url.searchParams.get('year')) || (periods[0] ? periods[0].year : new Date().getFullYear());
        const quarter = Number(url.searchParams.get('quarter')) || (periods[0] ? periods[0].quarter : 1);
        const deduction = Number(url.searchParams.get('deduction')) || 0;
        try {
          const value = data.vatSummary.quarterSummary(db, { year, quarter, deduction });
          return reply(res, 200, { ok: true, value: { ...value, periods } });
        } catch (error) {
          return reply(res, 400, { ok: false, error: error.message });
        }
      });
    }
    // ========== MỤC 3 – PDF GỐC CỦA NHÀ CUNG CẤP ==========
    // Xem PDF gốc NGAY TRONG APP: trả file để iframe hiển thị (inline), KHÓNG mở
    // trình duyệt/ứng dụng khác. Chỉ phục vụ file nằm trong thư mục của MST đang chọn.
    if (req.method === 'GET' && url.pathname === '/api/db/invoice-original') {
      return withDatabase((db, dir, mst) => {
        const key = String(url.searchParams.get('key') || '').trim();
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        const dirName = row.direction === 'SELL' ? 'Ban_ra' : 'Mua_vao';
        const file = data.originalPdf.findOriginalPdf(dir, dirName, row);
        if (!file) throw new Error('Hóa đơn này chưa có file PDF gốc của nhà cung cấp.');
        const bytes = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${path.basename(file)}"`,
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(bytes);
      });
    }
    // Người dùng tự chọn file PDF gốc cho một hóa đơn (PDF tải tay từ cổng NCC, hoặc
    // PDF của chính hỒ sơ bán ra). Lưu đường dẫn TƯƠNG ĐỐI so với thư mục MST.
    if (req.method === 'POST' && url.pathname === '/api/db/invoice-original/attach') {
      const input = await readBody(req);
      return withDatabase(async (db, dir) => {
        const key = String(input.key || '').trim();
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        if (input.clear === true) {
          db.prepare('UPDATE invoices SET original_pdf = NULL WHERE id = ?').run(row.id);
          return reply(res, 200, { ok: true, value: { attached: false } });
        }
        const chosen = String(input.file || '').trim();
        if (!chosen) throw new Error('Chưa chọn file PDF.');
        const resolved = path.resolve(chosen);
        // Chỉ nhận file PDF nằm trong thư mục lưu đã chọn – không mở được file tuỳ ý
        // từ đường dẫn do người dùng gửi lên.
        const root = path.resolve(output);
        if (!root || !resolved.startsWith(root + path.sep)) {
          throw new Error('Chỉ được chọn file nằm trong thư mục lưu đã chọn.');
        }
        if (!/\.pdf$/i.test(resolved)) throw new Error('Chỉ nhận file .pdf.');
        if (!fs.existsSync(resolved)) throw new Error('Không thấy file trên đĩa.');
        const head = fs.readFileSync(resolved, { encoding: null }).subarray(0, 5).toString('latin1');
        if (head !== '%PDF-') throw new Error('File này không phải PDF thật (thiếu chữ ký %PDF- ở đầu file).');
        const relative = path.relative(path.resolve(dir), resolved);
        db.prepare('UPDATE invoices SET original_pdf = ? WHERE id = ?').run(relative, row.id);
        const dirName = row.direction === 'SELL' ? 'Ban_ra' : 'Mua_vao';
        const found = data.originalPdf.findOriginalPdf(dir, dirName, { ...row, original_pdf: relative });
        if (!found) throw new Error('Đã lưu nhưng không mở được file. Kiểm tra lại thư mục lưu.');
        return reply(res, 200, { ok: true, value: { attached: true, file: found } });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/provider/lookup') {
      const input = await readBody(req);
      return withDatabase((db, dir) => {
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(String(input.key || ''));
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        const recovered = require('./data/lookup-code').recoverLookup(db, dir, row);
        return reply(res, 200, { ok: true, value: { lookup_code: recovered.lookup_code, lookup_url: recovered.lookup_url,
          provider_id: recovered.provider_id, provider_name: recovered.provider_name } });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/provider/download') {
      const input = await readBody(req);
      const context = withDatabase((db, dir) => {
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(String(input.key || ''));
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        return { row: input.session ? row : require('./data/lookup-code').recoverLookup(db, dir, row), dir };
      });
      const download = require('./provider-download');
      const value = input.cancel && input.session
        ? await download.cancel(browser, String(input.session), context.row, context.dir)
        : input.session
        ? await download.scan(browser, String(input.session), context.row, context.dir)
        : await download.start(browser, context.row, context.dir);
      if (value.downloaded) {
        const db = readDatabase(path.join(context.dir, 'data.db'));
        db.prepare('UPDATE invoices SET original_pdf = ? WHERE invoice_key = ?').run(value.relative, context.row.invoice_key);
      }
      return reply(res, 200, { ok: true, value });
    }
    // Mở cổng tra cứu của NCC trong CHÍNH Chromium của app (browser.js), không mở
    // trình duyệt hệ thống. Cửa sổ hiện ra để người dùng tự nhập CAPTCHA/mã rỒi tải.
    if (req.method === 'POST' && url.pathname === '/api/db/provider/open-portal') {
      const input = await readBody(req);
      // PHẢI async + await openPortal. Bản đầu viết `opened: openPortal(url)` — hàm async
      // trả về Promise, JSON hoá thành `{}`, mà `{}` là truthy nên giao diện LUÔN báo
      // "Đã mở …" kể cả khi hỏng. Người dùng bấm xong không thấy gì mà vẫn tin là đã mở.
      return withDatabase(async (db, dir) => {
        const key = String(input.key || '').trim();
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        // LÀM SẠCH trước khi kiểm tra: URL kiểu `…vnpt-invoice.com.vn;817503;` (VNPT
        // ghi cổng dính vào tên miền) không mở được và tên miền của nó không khớp
        // biểu thức kiểm tra bên dưới ⇒ 15 hóa đơn VNPT trong kho thật bị từ chối.
        const resolved = require('./data/lookup-code').recoverLookup(db, dir, row);
        const url = data.originalPdf.cleanPortalUrl(input.url || resolved.lookup_url || '');
        if (!url) throw new Error('Hóa đơn này không có cổng tra cứu dùng được nào.');
        const host = data.originalPdf.portalHost(url);
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) {
          throw new Error(`Tên miền lạ (${host}) – không mở tự động. Hãy tự mở cổng tra cứu.`);
        }
        const result = await openPortal(url, resolved);
        return reply(res, 200, { ok: true, value: {
          url, host,
          opened: result.opened,
          error: result.error,
          filled: result.filled,
          missing: result.missing,
          supported: result.supported,
        } });
      });
    }
﻿
// LƯU mã tra cứu / URL cổng mà người dùng nhập tay (mục 3). Nhập một lần, lần sau
    // bấm là có, không hỏi lại — cùng cách bản tham chiếu đánh dấu nguồn là "user-entered".
    // CHỈ cho sửa đúng hai cột này: không nhận tên cột tùy ý từ phía trình duyệt, nếu
    // không route này sẽ thành cổng ghi tuỳ ý vào data.db.
    if (req.method === 'POST' && url.pathname === '/api/db/invoice-lookup') {
      const input = await readBody(req);
      return withDatabase(db => {
        const key = String(input.key || '').trim();
        const field = String(input.field || '').trim();
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        const value = String(input.value || '').trim();
        if (field === 'lookup_code') {
          if (value.length > 120) throw new Error('Mã tra cứu quá dài (tối đa 120 ký tự).');
          db.prepare('UPDATE invoices SET lookup_code = ? WHERE id = ?').run(value || null, row.id);
          return reply(res, 200, { ok: true, value: { field, value } });
        }
        if (field === 'lookup_url') {
          // Cột này sau đó được dùng để MỞ trang, nên chỉ nhận http(s) có tên miền.
// Lưu URL đã LÀM SẠCH: `…vnpt-invoice.com.vn;817503;` → `…vnpt-invoice.com.vn`. Nhập
          // tay thì cũng qua cùng một cửa, để cột luôn lưu đúng dạng dùng được.
          const clean = data.originalPdf.cleanPortalUrl(value);
          if (value && !clean) {
            if (!/^https?:\/\//i.test(value)) throw new Error('URL phải bắt đầu bằng http:// hoặc https://');
            throw new Error('URL phải có tên miền, ví dụ https://tenmien.vn/');
          }
          db.prepare('UPDATE invoices SET lookup_url = ? WHERE id = ?').run(clean || null, row.id);
          return reply(res, 200, { ok: true, value: { field, value: clean } });
        }
        throw new Error('Chỉ được cập nhật mã tra cứu hoặc URL cổng tra cứu.');
      });
    }

    // MỤC 2 – BÙ CỘT TRA CỨU NCC: đọc lại file XML gốc để điền MSTTCGP / mã tra cứu /
    // cổng tra cứu cho hoá đơn nhập trước khi có các cột này. Lượt quét thường KHÓNG làm
    // được việc này (file đã nhập bị đánh dấu trùng nên không cập nhật dòng cũ).
    if (req.method === 'POST' && url.pathname === '/api/db/invoices/backfill-lookup') {
      return withDatabase(async (db, dir) => reply(res, 200,
        { ok: true, value: await data.xmlScanner.backfillProviderLookup({ db, mstDir: dir }) }));
    }
    // MỤC 3 – PHÂN LOẠI THỦ CÓNG: người dùng bấm, máy chỉ GHI lại đúng giá trị đó (không tự đoán).
    // Đổi TM/CK thì chạy lại đối chiếu để các thẻ Tổng quan phản ánh ngay; payment_method_raw
    // (giá trị gốc từ XML) không bao giờ bị đụng tới.
    if (req.method === 'POST' && url.pathname === '/api/db/invoices/review') {
      const input = await readBody(req);
      return withDatabase(db => {
        const value = data.repository.setReview(db, { id: input.id, action: input.action });
        if (value.changedMethod) value.reconciliation = data.reconciliation.rebuild(db);
        return reply(res, 200, { ok: true, value });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/bank/delete') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.deleteFile(db, input.fileId) }));
    }
    // ---- Mã định danh CHƯA GÁN (MST gốc ↓ CCCD của cùng một người) ----
    // GET: danh sách cho panel tab Kho dữ liệu; POST: gán (thêm vào identifiers + quét lại),
    // bỏ qua, hoặc nhận lại. POST cờ assignImport=true mở lượt nhập lại chạy nền (importJob).
    if (req.method === 'GET' && url.pathname === '/api/db/identity-candidates') {
      return withDatabase((db, dir, mst) => {
        // Hệ thống TỰ HIỂU "cùng một người": mã lạ trùng TÊN hỒ sơ (so tên chuẩn hoá) thì gán
        // luôn trước khi trả panel – CCCD 058168004258 của HKD Phùng Thị Kỳ Duyên tự vào định
        // danh, lượt quét hẹn sẵn sẽ nhập nốt các hoá đơn đang UNKNOWN. Lỗi tự gán không chặn panel.
        let autoAssigned = [];
        try { autoAssigned = autoAssignByPersonName(mst, db); } catch { autoAssigned = []; }
        // Gộp cả mã đã tự gán NỀN (afterScan) trong 2 phút gần nhất để UI thông báo đúng lúc.
        const recent = recentAutoAssign.get(mst);
        if (recent && Date.now() - new Date(recent.at).getTime() < 2 * 60 * 1000) {
          autoAssigned = [...new Set([...autoAssigned, ...recent.codes])];
        }
        return reply(res, 200, { ok: true, value: {
          mst,
          identifiers: accountIdentifiers(mst),
          autoAssigned,
          rows: data.identityCandidates.listCandidates(dir),
        } });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/identity-candidates') {
      currentMst();
      const input = await readBody(req);
      const code = String(input.code || '').trim();
      const decision = String(input.decision || '').trim();
      if (!/^\d{6,20}$/.test(code)) throw new Error('Mã phải gỒm 6‒20 chữ số.');
      if (!['assigned', 'ignored', ''].includes(decision)) throw new Error('Quyết định không hợp lệ (assigned / ignored / rỗng).');
      const dir = data.mst.mstDirectory(output, selected);
      const existing = data.identityCandidates.readCandidates(dir);
      if (!existing[code]) throw new Error('Mã này không nằm trong danh sách chưa gán (lượt quét sau sẽ cập nhật).');
      if (decision === 'assigned') {
        const account = accountFor(selected);
        if (!account) throw new Error('MST không còn trong danh sách.');
        const occupied = new Set(accountIdentifiers(selected));
        for (const other of activeAccounts()) {
          if (other.mst === selected) continue;
          for (const value of accountIdentifiers(other.mst)) occupied.add(value);
        }
        if (occupied.has(code)) throw new Error(`Mã ${code} đã thuộc một hỒ sơ khác.`);
        account.identifiers = cleanIdentifiers([...(account.identifiers || []), code]);
        saveAccounts();
      } else if (decision === '') {
        // "Nhận lại": gỡ khỏi định danh hỒ sơ (nếu có) – undo thực sự cho cả gán tay lẫn tự gán.
        const account = accountFor(selected, true);
        if (account && Array.isArray(account.identifiers) && account.identifiers.includes(code)) {
          account.identifiers = account.identifiers.filter(value => value !== code);
          saveAccounts();
        }
      }
      data.identityCandidates.setDecision(dir, code, decision, decision === 'assigned' ? 'panel' : '');
      xmlWatcher.schedule(selected);
      let importQueued = false;
      if (input.assignImport) {
        try {
          if (!data.importJob.status().running) {
            data.importJob.start({ output, mst: selected, identifiers: accountIdentifiers(selected) }).catch(() => { /* lỗi đã nằm trong status */ });
            importQueued = true;
          }
        } catch { /* đang chạy lượt khác – watcher sẽ quét lại sau */ }
      }
      return reply(res, 200, { ok: true, value: {
        code, decision,
        identifiers: accountIdentifiers(selected),
        rows: data.identityCandidates.listCandidates(dir),
        importQueued, importStatus: data.importJob.status(),
      } });
    }
    if (req.method === 'GET' && url.pathname === '/api/db/changes') {
      const mst = currentMst();
      return reply(res, 200, { ok: true, value: xmlWatcher.status(mst) });
    }
    // ---- AUTO SYNC: trạng thái, cấu hình, chạy ngay (§26/§28/§30) ----
    if (req.method === 'GET' && url.pathname === '/api/db/autosync/status') {
      const p = url.searchParams;
      const mst = String(p.get('mst') || selected || '').trim();
      const instance = mst ? autoSyncFor(mst) : null;
      const value = instance ? instance.status() : { running: false, phase: '', settings: { enabled: false, days: 7, intervalMinutes: 30 }, directions: { buy: {}, sell: {} } };
      return reply(res, 200, {
        ok: true,
        value: {
          ...value,
          mst: mst || '',
          dir: mst && output ? data.mst.mstDirectory(output, mst) : '',
          // Danh sách hoá đơn đang tải: UI tab Tra cứu & tải hiện lên cho trực quan.
          preview: value.running ? autoSyncPreview(mst) : null,
          // Chạy nền theo khung giờ (chỉ đọc, không gọi cổng thuế).
          window: backgroundSync.status(),
          // Bể "ĐỒng bộ tất cả" (chỉ đọc).
          pool: syncPool.status(),
          // Quét bù lịch sử chạy nền khi máy rảnh (chỉ đọc).
          catchup: catchupStatus(),
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/settings') {
      const input = await readBody(req);
      // Cấu hình lưu trong sync.json của MST – ghi cho đúng MST đang chọn.
      const settings = autoSync().configure({ enabled: input.enabled, days: input.days, intervalMinutes: input.intervalMinutes });
      return reply(res, 200, { ok: true, value: settings });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run') {
      await ensureLicenseAllowed();
      // Chạy Auto Sync cho ĐÚNG MST được bấm. Mỗi MST là một luỒng riêng nên MST khác đang chạy
      // KHÓNG chặn – chỉ chặn khi chính MST này đã đang chạy.
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!safeMst(mst) || !accountFor(mst)) throw new Error('MST chưa có trong danh sách.');
      if (!output) throw new Error('Chọn thư mục lưu trước khi chạy Auto Sync.');
      const instance = autoSyncFor(mst);
      if (instance && instance.running) throw new Error(`MST ${mst} đang chạy Auto Sync. Bấm Ngưng trước nếu muốn dừng.`);
      runAutoSyncFor(mst, 'manual').catch(error => log(`Auto Sync MST ${mst} lỗi: ${error && error.message ? error.message : error}`));
      return reply(res, 200, { ok: true, value: { ...(instance ? instance.status() : {}), mst } });
    }
    // "ĐỒNG BỘ TẤT CẢ": chạy SONG SONG nhiều MST – mỗi MST một profile Chrome và một kho cookie
    // riêng nên không lẫn phiên. Bể giữ LUÓN đủ số luỒng: MST nào xong thì rút MST kế tiếp.
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run-all') {
      await ensureLicenseAllowed();
      if (!output) throw new Error('Chọn thư mục lưu trước khi đỒng bộ tất cả.');
      const entries = [];
      const skipped = [];
      for (const account of activeAccounts()) {
        const mst = account.mst;
        // Không có phiên lưu thì không chạy ÂM THẦM được (phải mở Chrome + nhập CAPTCHA thủ công),
        // nên bỏ qua và nói rõ lý do thay vì mở một loạt cửa sổ đăng nhập.
        if (!hasSavedSession(mst)) { skipped.push({ mst, reason: 'chưa có phiên – cần đăng nhập' }); continue; }
        const instance = autoSyncFor(mst);
        if (instance && instance.running) { skipped.push({ mst, reason: 'đang chạy' }); continue; }
        entries.push({ mst });
      }
      const result = syncPool.start(entries);
      if (!result.started) return reply(res, 200, { ok: true, value: { ...syncPool.status(), skipped, message: result.reason } });
      log(`ĐỒng bộ tất cả: ${result.queued} MST · ${result.concurrency} luỒng song song${skipped.length ? ` · bỏ qua ${skipped.length} MST` : ''}.`);
      result.done.catch(() => { /* lỗi từng MST đã ghi trong status() */ });
      return reply(res, 200, { ok: true, value: { ...syncPool.status(), skipped } });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run-all/stop') {
      const stopped = syncPool.stop();
      return reply(res, 200, { ok: true, value: { ...syncPool.status(), stopped } });
    }
    // Ngưng mọi tác vụ của MỘT MST: lượt Auto Sync (engine riêng) và lượt tải thủ công của MST đó.
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/stop') {
      const input = await readBody(req);
      const target = String(input.mst || selected || '').trim();
      const instance = target ? autoSyncByMst.get(target) : null;
      const wasRunning = !!(instance && instance.running);
      // Cờ nhường trước rỒi pause engine sau: giữa hai hướng thì autoSyncEngines đã trống, nên
      // chỉ pause() sẽ không dừng được – hướng chưa chạy vẫn khởi động (xem pauseBackgroundFor).
      if (instance) instance.yieldNow('người dùng bấm Ngưng');
      // Chỉ pause engine thuộc ĐÚNG MST này – không đụng MST khác đang chạy.
      for (const one of autoSyncEngines) {
        if (one.job && one.job.account && one.job.account.mst === target) one.pause();
      }
      for (const candidate of [engine, target ? engineFor(target) : null]) {
        if (candidate && candidate.busy) candidate.pause();
      }
      log(`Yêu cầu ngưng tác vụ${target ? ` của MST ${target}` : ''}${wasRunning ? ' (đang chạy Auto Sync)' : ' (không có Auto Sync đang chạy)'}.`);
      return reply(res, 200, { ok: true, value: { ...(instance ? instance.status() : {}), mst: target || '', stopped: wasRunning } });
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
      data.importJob.start({ output, mst: selected, identifiers: accountIdentifiers(selected) }).catch(() => { /* lỗi đã nằm trong status */ });
      return reply(res, 200, { ok: true, value: data.importJob.status() });
    }
    // ---- HỖ TRỢ KẾ TOÁN: xuất file "Mẫu bán hàng" để nhập vào MISA AMIS ----------------
    // Danh mục hàng hoá công ty (nhập từ Danhsach.xlsx) – CHỈ dùng để đối chiếu mã hàng.
    if (req.method === 'GET' && url.pathname === '/api/db/misa/catalog') {
      return withDatabase(db => reply(res, 200, { ok: true, value: data.productMaster.summary(db) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/db/misa/catalog') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const buffer = Buffer.from(String(input.data || ''), 'base64');
      if (!buffer.length) throw new Error('Không nhận được nội dung file danh mục.');
      return withDatabase(db => {
        const value = data.productMaster.importWorkbook(db, { buffer });
        log(`Danh mục hàng hoá: nhập ${value.imported} mã, bỏ qua ${value.skipped} dòng.`);
        return reply(res, 200, { ok: true, value: { ...value, ...data.productMaster.summary(db) } });
      });
    }
    // XEM TRƯỚC: dựng ĐÚNG các dòng sẽ ghi ra file + danh sách LỖI CHẶN XUẤT. Không ghi gì vào DB.
    if (req.method === 'POST' && url.pathname === '/api/db/misa/preview') {
      const input = await readBody(req);
      const from = String(input.from || ''); const to = String(input.to || '');
      return withDatabase((db, dir, mst) => {
        const prefix = String(input.prefix || 'PT').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'PT';
        const startNo = input.startNo === '' || input.startNo === undefined || input.startNo === null ? null : Number(input.startNo);
        // missingCode: hoá đơn không ghi Mã hàng thì lấy mã theo tên / dùng tên làm mã, hay CHẶN.
        const missingCode = String(input.missingCode || 'name') === 'block' ? 'block' : 'name';
        const result = data.misaExport.prepare(db, { from, to, prefix, startNo, missingCode });
        return reply(res, 200, {
          ok: true,
          value: {
            headers: data.misaExport.HEADERS, allRows: result.rows.length, rows: result.rows.slice(0, 200),
            errors: result.errors.slice(0, 200), errorTotal: result.errors.length,
            warnings: result.warnings, stats: result.stats,
            fileName: data.misaExport.fileName(mst, from, to),
          },
        });
      });
    }
    // XUẤT FILE: giữ NGUYÊN 8 hàng đầu của file mẫu, dữ liệu từ hàng 9. Có lỗi ⇒ KHÓNG xuất.
    // Mặc định .xlsx vì CHỈ .xlsx mang được khối dataValidation (danh sách chọn) của mẫu – thứ
    // MISA dùng để GHÉP CỘT. .xls giữ đúng định dạng mẫu nhưng SheetJS không ghi được dataValidation.
    if (req.method === 'GET' && url.pathname === '/api/db/misa/export') {
      const p = url.searchParams;
      const from = String(p.get('from') || ''); const to = String(p.get('to') || '');
      const prefix = String(p.get('prefix') || 'PT').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'PT';
      const rawStart = String(p.get('startNo') || '');
      const startNo = /^\d+$/.test(rawStart) ? Number(rawStart) : null;
      const missingCode = String(p.get('missingCode') || 'name') === 'block' ? 'block' : 'name';
      const format = String(p.get('format') || 'xlsx') === 'xls' ? 'xls' : 'xlsx';
      // Dựng sheet ĐỒNG BỘ bên trong withDatabase (mọi truy cập DB nằm ở đây), rỒi mới nén file ở
      // ngoài – không giữ kết nối DB qua await.
      const parts = withDatabase((db, dir, mst) => data.misaExport.assemble(db, { from, to, prefix, startNo, missingCode, mst }));
      const buffer = format === 'xls' ? data.misaExport.renderXls(parts) : await data.misaExport.renderXlsx(parts);
      const fileName = `${parts.baseName}.${format}`;
      const { stats, warnings } = parts.result;
      log(`Xuất Mẫu bán hàng cho MST ${parts.mst || ''}: ${stats.lines} dòng hàng / ${stats.invoices} hoá đơn (${fileName}).`);
      res.writeHead(200, {
        'Content-Type': format === 'xls'
          ? 'application/vnd.ms-excel'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Export-Stats': JSON.stringify({ ...stats, warnings: warnings.length }),
      });
      res.end(buffer);
    }
    // Xuất Excel "Kho dữ liệu": MỘT workbook nhiều sheet (HĐ mua vào/bán ra, hàng hóa, đối tác),
    // tôn trọng ĐÚNG bộ lọc đang xem (q + khoảng ngày). Trả về file .xlsx để tải xuống.
    if (req.method === 'GET' && url.pathname === '/api/db/export') {
      const p = url.searchParams;
      return withDatabase((db, dir, mst) => {
        // parts: danh sách bảng muốn xuất (vd "sell" = chỉ hoá đơn bán ra). Trống ⇒ xuất TẤT CẢ.
        const parts = String(p.get('parts') || '').split(',').map(part => part.trim()).filter(Boolean);
        // Truyền ĐỦ bộ lọc đang xem, kể cả TRẠNG THÁI và CHIỀU – thiếu là file xuất khác màn hình.
        const { buffer, counts } = data.excelExport.buildWorkbook(db, {
          q: p.get('q') || '', from: p.get('from') || '', to: p.get('to') || '',
          state: p.get('state') || '', direction: p.get('direction') || '',
        }, parts);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${data.excelExport.fileName(mst, new Date(), parts)}"`,
          'Content-Length': buffer.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Export-Counts': JSON.stringify(counts),
        });
        res.end(buffer);
      });
    }
    return reply(res, 404, { ok: false, error: 'Không rõ đường dẫn dữ liệu.' });
  }



    // ---- CHUYỂN ĐồI DVT (tab "Chuyển đổi DVT") ------------------------------
    // GET /api/dvt/mappings - Lấy danh sách mapping DVT của MST đang chọn
    if (req.method === 'GET' && url.pathname === '/api/dvt/mappings') {
      const mst = String(url.searchParams.get('mst') || selected || '').trim();
      if (!mst) return reply(res, 200, { ok: true, value: [] });
      const instance = autoSyncFor(mst);
      if (!instance) return reply(res, 200, { ok: true, value: [] });
      // Đọc mapping từ dvt_mapping table của MST này
      const { data } = require('./data');
      try {
        const db = data.mst.ensureMst({ output, mst }).db;
        const mappings = db.prepare(`
          SELECT id, ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai
          FROM dvt_mapping
          WHERE trang_thai = 'active'
          ORDER BY ma_hang, dvt_goc
        `).all();
        return reply(res, 200, { ok: true, value: mappings.map(r => ({
          id: r.id,
          maHang: r.ma_hang,
          tenHang: r.ten_hang,
          tenChuan: r.ten_chuan,
          dvtGoc: r.dvt_goc,
          dvtDich: r.dvt_dich,
          tyLe: Number(r.ty_le) || 1,
          ghiChu: r.ghi_chu,
          nguon: r.nguon,
          trangThai: r.trang_thai,
        })) });
      } catch (e) {
        return reply(res, 200, { ok: true, value: [] });
      }
    }

    // POST /api/dvt/mappings - Thêm mapping mới
    if (req.method === 'POST' && url.pathname === '/api/dvt/mappings') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      const { maHang, tenHang, dvtGoc, dvtDich, tyLe, ghiChu, nguon } = input;
      if (!maHang || !dvtGoc || !dvtDich) return reply(res, 400, { ok: false, error: 'Thiếu mã hàng, DVT gốc hoặc DVT đích.' });
      const tyLeNumber = Number(tyLe) || 1;
      if (tyLe <= 0) return reply(res, 400, { ok: false, error: 'Tỷ lệ phải > 0.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const tenChuan = require('./mst-format').normalizeTenHang(String(tenHang || '').trim());
        const existing = db.prepare(`
          SELECT id FROM dvt_mapping
          WHERE ma_hang = ? AND dvt_goc = ? AND dvt_dich = ?
        `).get(input.maHang, input.dvtGoc, input.dvtDich);
        if (existing) {
          db.prepare(`
            UPDATE dvt_mapping
            SET ten_hang = ?, ten_chuan = ?, ty_le = ?, ghi_chu = ?, nguon = ?, updated_at = ?
            WHERE id = ?
          `).run(input.tenHang, require('./mst-format').normalizeTenHang(input.tenHang), Number(input.tyLe) || 1, input.ghiChu || '', input.nguon || 'manual', new Date().toISOString(), existing.id);
          return reply(res, 200, { ok: true, value: { id: existing.id, updated: true } });
        } else {
          const info = db.prepare(`
            INSERT INTO dvt_mapping (ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
          `).run(input.maHang, input.tenHang, require('./mst-format').normalizeTenHang(input.tenHang), input.dvtGoc, input.dvtDich, Number(input.tyLe) || 1, input.ghiChu || '', input.nguon || 'manual', new Date().toISOString(), new Date().toISOString());
          return reply(res, 200, { ok: true, value: { id: Number(info.lastInsertRowid), created: true } });
        }
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // PUT /api/dvt/mappings/:id - Cập nhật mapping
    if (req.method === 'PUT' && url.pathname.startsWith('/api/dvt/mappings/')) {
      await ensureLicenseAllowed();
      const id = url.pathname.split('/').pop();
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      const { tenHang, dvtGoc, dvtDich, tyLe, ghiChu, nguon, trangThai } = input;
      if (!dvtGoc || !dvtDich) return reply(res, 400, { ok: false, error: 'DVT gốc và DVT đích là bắt buộc.' });
      const tyLeNumber = Number(tyLe) || 1;
      if (tyLe <= 0) return reply(res, 400, { ok: false, error: 'Tỷ lệ phải > 0.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const tenChuan = require('./mst-format').normalizeTenHang(String(input.tenHang || '').trim());
        const existing = db.prepare('SELECT * FROM dvt_mapping WHERE id = ?').get(id);
        if (!existing) return reply(res, 404, { ok: false, error: 'Mapping không tỒn tại.' });
        // Kiểm tra trùng lặp (nếu đổi dvt_goc/dvt_dich)
        if ((dvtGoc !== existing.dvt_goc || dvtDich !== existing.dvt_dich)) {
          const dup = db.prepare(`
            SELECT id FROM dvt_mapping
            WHERE ma_hang = ? AND dvt_goc = ? AND dvt_dich = ? AND id != ?
          `).get(existing.ma_hang, input.dvtGoc, input.dvtDich, id);
          if (dup) return reply(res, 400, { ok: false, error: 'Đã tỒn tại mapping với cùng mã hàng, DVT gốc, DVT đích.' });
        }
        db.prepare(`
          UPDATE dvt_mapping
          SET ten_hang = ?, ten_chuan = ?, dvt_goc = ?, dvt_dich = ?, ty_le = ?, ghi_chu = ?, nguon = ?, trang_thai = ?, updated_at = ?
          WHERE id = ?
        `).run(input.tenHang, require('./mst-format').normalizeTenHang(input.tenHang), input.dvtGoc, input.dvtDich, Number(input.tyLe) || 1, input.ghiChu || '', input.nguon || 'manual', input.trangThai || 'active', new Date().toISOString(), id);
        return reply(res, 200, { ok: true, value: { updated: true } });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // DELETE /api/dvt/mappings/:id - Xoá mapping (soft delete)
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/dvt/mappings/')) {
      await ensureLicenseAllowed();
      const id = url.pathname.split('/').pop();
      const mst = String(input.mst || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const info = db.prepare(`UPDATE dvt_mapping SET trang_thai = 'inactive', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
        if (info.changes === 0) return reply(res, 404, { ok: false, error: 'Mapping không tỒn tại.' });
        return reply(res, 200, { ok: true, value: { deleted: true } });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // POST /api/dvt/mappings/import - Import từ Excel
    if (req.method === 'POST' && url.pathname === '/api/dvt/mappings/import') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      const { rows } = input;
      if (!Array.isArray(rows) || !rows.length) return reply(res, 400, { ok: false, error: 'Không có dữ liệu import.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        let success = 0;
        const errors = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const maHang = String(row['Mã hàng'] || '').trim();
          const tenHang = String(row['Tên hàng'] || '').trim();
          const dvtGoc = String(row['DVT gốc'] || '').trim();
          const dvtDich = String(row['DVT đích'] || '').trim();
          const tyLe = Number(row['Tỷ lệ']) || 1;
          const ghiChu = String(row['Ghi chú'] || '').trim();
          if (!maHang) { errors.push(`Dòng ${i + 1}: thiếu mã hàng`); continue; }
          if (!dvtGoc) { errors.push(`Dòng ${i + 1}: thiếu DVT gốc`); continue; }
          if (!dvtDich) { errors.push(`Dòng ${i + 1}: thiếu DVT đích`); continue; }
          if (tyLe <= 0) { errors.push(`Dòng ${i + 1}: tỷ lệ phải > 0`); continue; }
          try {
            const tenChuan = require('./mst-format').normalizeTenHang(String(row['Tên hàng'] || '').trim());
            const existing = db.prepare(`SELECT id FROM dvt_mapping WHERE ma_hang = ? AND dvt_goc = ? AND dvt_dich = ?`).get(maHang, dvtGoc, dvtDich);
            if (existing) {
              db.prepare(`
                UPDATE dvt_mapping
                SET ten_hang = ?, ten_chuan = ?, ty_le = ?, ghi_chu = ?, nguon = ?, updated_at = ?
                WHERE id = ?
              `).run(row['Tên hàng'] || '', require('./mst-format').normalizeTenHang(String(row['Tên hàng'] || '').trim()), Number(row['Tỷ lệ']) || 1, row['Ghi chú'] || '', row['NguỒn'] || 'import', new Date().toISOString(), existing.id);
            } else {
              db.prepare(`
                INSERT INTO dvt_mapping (ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
              `).run(maHang, row['Tên hàng'] || '', require('./mst-format').normalizeTenHang(String(row['Tên hàng'] || '').trim()), dvtGoc, dvtDich, tyLe, row['Ghi chú'] || '', row['NguỒn'] || 'import', new Date().toISOString(), new Date().toISOString());
            }
            success++;
          } catch (e) {
            errors.push(`Dòng ${i + 1}: ${e.message}`);
          }
        }
        return reply(res, 200, { ok: true, value: { success, errors } });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // GET /api/dvt/mappings/export - Export ra Excel
    if (req.method === 'GET' && url.pathname === '/api/dvt/mappings/export') {
      const mst = String(url.searchParams.get('mst') || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const mappings = db.prepare(`
          SELECT ma_hang as 'Mã hàng', ten_hang as 'Tên hàng', dvt_goc as 'DVT gốc', dvt_dich as 'DVT đích', ty_le as 'Tỷ lệ', ghi_chu as 'Ghi chú', nguon as 'NguỒn', trang_thai as 'Trạng thái'
          FROM dvt_mapping
          WHERE trang_thai = 'active'
          ORDER BY ma_hang, dvt_goc
        `).all();
        return reply(res, 200, { ok: true, value: mappings });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // POST /api/dvt/auto-learn - Auto learn mapping 1:1 cho items chưa có map
    if (req.method === 'POST' && url.pathname === '/api/dvt/auto-learn') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        // Lấy items từ hóa đơn bán ra gần đây chưa có mapping
        const items = db.prepare(`
          SELECT DISTINCT ma_hang, ten_hang, don_vi
          FROM invoice_items
          WHERE invoice_id IN (SELECT id FROM invoices WHERE direction = 'SELL')
        `).all();
        let created = 0;
        for (const item of items) {
          const maHang = item.ma_hang;
          const dvtGoc = item.don_vi;
          if (!maHang) continue;
          const exists = db.prepare('SELECT id FROM dvt_mapping WHERE ma_hang = ? AND dvt_goc = ?').get(maHang, dvtGoc);
          if (!exists) {
            db.prepare(`
              INSERT INTO dvt_mapping (ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, '', 'auto_learn', 'active', ?, ?)
            `).run(maHang, item.ten_hang || '', require('./mst-format').normalizeTenHang(item.ten_hang || ''), dvtGoc, dvtGoc, new Date().toISOString(), new Date().toISOString());
            created++;
          }
        }
        return reply(res, 200, { ok: true, value: { created } });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // GET /api/dvt/logs - Lịch sử chuyển đổi
    if (req.method === 'GET' && url.pathname === '/api/dvt/logs') {
      const mst = String(url.searchParams.get('mst') || selected || '').trim();
      const limit = Number(url.searchParams.get('limit') || 100);
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const logs = db.prepare(`
          SELECT l.*, m.ma_hang, m.dvt_goc, m.dvt_dich
          FROM dvt_conversion_log l
          LEFT JOIN dvt_mapping m ON l.mapping_id = m.id
          WHERE l.invoice_id IN (SELECT id FROM invoices WHERE direction = 'SELL')
          ORDER BY l.created_at DESC
          LIMIT ?
        `).all(limit);
        return reply(res, 200, { ok: true, value: logs });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    // POST /api/dvt/convert - Chuyển đổi thủ công (cho testing)
    if (req.method === 'POST' && url.pathname === '/api/dvt/convert') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      const { items } = input;
      if (!mst || !accountFor(mst)) return reply(res, 400, { ok: false, error: 'MST không hợp lệ.' });
      if (!Array.isArray(items)) return reply(res, 400, { ok: false, error: 'Thiếu danh sách items.' });
      if (!output) return reply(res, 400, { ok: false, error: 'Chưa chọn thư mục lưu.' });
      const { data } = require('./data');
      try {
        const { db } = data.mst.ensureMst({ output, mst });
        const mappings = db.prepare(`
          SELECT id, ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai
          FROM dvt_mapping
          WHERE trang_thai = 'active'
          ORDER BY ma_hang, dvt_goc
        `).all().map(r => ({
          id: r.id, maHang: r.ma_hang, tenHang: r.ten_hang, tenChuan: r.ten_chuan,
          dvtGoc: r.dvt_goc, dvtDich: r.dvt_dich, tyLe: Number(r.ty_le) || 1,
          ghiChu: r.ghi_chu, nguon: r.nguon, trangThai: r.trang_thai,
        }));
        const { applyConversion } = require('./data/dvt-converter');
        const converted = applyConversion(items, mappings);
        return reply(res, 200, { ok: true, value: { converted } });
      } catch (e) {
        return reply(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/support/notice') return reply(res, 200, { ok: true, value: await support.notice() });
    // ---- Support: License và Chat là HAI luỒng độc lập, chỉ chạy khi được gọi ----
    // /api/support/device : ảnh chụp local, KHÓNG gọi máy chủ (header chat, hiển thị tức thì)
    // /api/support/license: kiểm tra License khi có luỒng chức năng gọi tới (không polling)
    // /api/support/chat   : đọc tin nhắn theo yêu cầu (không kéo theo License)
    // /api/support/events : SSE realtime – server đẩy thay đổi từ Firebase qua Gateway xuống UI
    if (url.pathname === '/api/support/device') return reply(res, 200, { ok: true, value: support.snapshot() });
    if (url.pathname === '/api/support/license') {
      const value = await support.checkLicense();
      ensureSupportStream(); // token phiên có thể vừa xuất hiện -> mở luỒng chat nếu chưa có
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
        // Không còn cửa sổ nào nghe thì đóng luôn kết nối tới Gateway (không giữ luỒng "chết").
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
  // POST /api/window/show: hiện lại cửa sổ giao diện. Có cửa sổ rỒi thì ĐƯA LÊN TRƯỚC (không mở thêm),
  // chỉ mở cửa sổ mới khi cửa sổ cũ đã đóng – dùng lại đúng instance + profile hiện tại.
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
    log('Nhận yêu cầu thoát hoàn toàn – dọn dẹp rỒi thoát.');
    reply(res, 200, { ok: true, value: { quitting: true } });
    setTimeout(() => { stop().catch(() => process.exit(0)); }, 200);
    return;
  }
  // ---- Tự khởi động cùng Windows ----
  // GET để đọc trạng thái, POST {enabled} để bật/tắt. Chỉ cần thi hành registry –
  // phần "khởi động mà không mở cửa sổ" xử lý bằng cờ --start-hidden lúc chạy.
  if (req.method === 'GET' && url.pathname === '/api/autostart') {
    return reply(res, 200, { ok: true, value: await autostart.status(dataDir) });
  }
  if (req.method === 'POST' && url.pathname === '/api/autostart') {
    const input = await readBody(req);
    try {
      const value = await autostart.setEnabled(dataDir, input.enabled);
      log(value.enabled
        ? 'Đã bật khởi động cùng Windows: ' + value.command
        : 'Đã tắt khởi động cùng Windows.');
      if (value.error) log('Cảnh báo autostart: ' + value.error);
      return reply(res, 200, { ok: true, value });
    } catch (error) {
      return reply(res, 400, { ok: false, error: error.message });
    }
  }
  if (url.pathname === '/api/update') return reply(res, 200, { ok: true, value: { ...updater.status(), url: updater.status().releaseUrl } });
  // ---- Self update: mỗi thao tác do người dùng chủ động gọi ----
  if (url.pathname === '/api/update/check') return reply(res, 200, { ok: true, value: await updater.check(true) });
  if (url.pathname === '/api/update/cancel') return reply(res, 200, { ok: true, value: updater.cancel() });
  if (url.pathname === '/api/update/start') {
    const result = await updater.start();
    // Tải + xác minh xong và helper đã khởi động -> trả lời rỒi tự đóng để helper thay file.
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
    // Khách bấm nút /check trong khung hỗ trợ → lấy thông tin bản quyền của máy này.
    if (req.method === 'POST' && url.pathname === '/api/support/check') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await support.check(input.command) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/login') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => addOrLogin(input.mst), input.mst) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/submit') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => submitLogin(input), input.mst || selected) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/captcha') return reply(res, 200, { ok: true, value: await authOperation(async () => { if (!selected) throw new Error('Chọn MST trước.'); const value = await browser.loginAction({ mode: 'refresh' }); if (value.authenticated) return { ...value, account: await checkLogin() }; return challengeResponse(value); }, selected) });
    // Auto login hoàn toàn: solver JS (ddddocr) tự giải CAPTCHA rỒi authenticate – không cần gõ tay.
    // Không dùng authOperation toàn cục: auto-login chạy per-MST, không chặn MST khác.
    if (req.method === 'POST' && url.pathname === '/api/account/auto-login') { const input = await readBody(req); const mst = String(input.mst || selected || ''); if (authBusy.has(mst)) throw new Error('Đang tự động đăng nhập cho MST này. Vui lòng chờ.'); authBusy.add(mst); foregroundAuth.add(mst); try { return reply(res, 200, { ok: true, value: await autoLoginAccount(input) }); } finally { authBusy.delete(mst); foregroundAuth.delete(mst); } }
    if (req.method === 'POST' && url.pathname === '/api/account/show') {
      const input = await readBody(req); const mst = input.mst || selected;
      ensureIdle(); if (!safeMst(mst)) throw new Error('Nhập MST hợp lệ trước khi mở trang thuế.');
      if (authBusy.has(mst)) {
        if (browser.client && browser.mst === mst) { await browser.show(); return reply(res, 200, { ok: true, value: true }); }
        throw new Error('Đang xử lý phiên đăng nhập cho MST này. Thử mở trang thuế lại sau vài giây.');
      }
      return reply(res, 200, { ok: true, value: await authOperation(async () => {
        await browser.open(mst, true);
        if (selected !== mst || !engine) { authAccount = null; loginChallenge = null; createEngine(mst); }
        selected = mst; return true;
      }, mst) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/visibility') return reply(res, 200, { ok: true, value: await authOperation(async () => {
      if (!browser.client) throw new Error('Chưa có phiên đăng nhập. Nhập MST để bắt đầu trước.');
      const visible = !!(await readBody(req)).visible;
      if (visible) await browser.show(); else await browser.hide();
      return { visible: browser.visible };
    }, browser.mst) });
    if (req.method === 'POST' && url.pathname === '/api/account/check') return reply(res, 200, { ok: true, value: await authOperation(checkLogin, selected) });
    if (req.method === 'POST' && url.pathname === '/api/account/select') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await selectOperation(() => selectAccount(input.mst), input.mst) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/save') {
      const input = await readBody(req);
      const mst = String(input.mst || input.previous || '').trim();
      // THÊM MST có gửi kèm `output` (ô "Thư mục lưu" trong form). BỎ TRỐNG ⇒ dùng mặc định
      // Documents\CN-invoice – khách bấm Huỷ ở hộp chọn thư mục thì KHÓNG bị chặn việc thêm MST.
      // Thư mục lưu là DÙNG CHUNG cho mọi MST nên gán luôn vào biến `output` của server.
      if (!String(input.previous || '').trim() && input.output !== undefined) {
        const wanted = String(input.output || '').trim() || defaultOutputFolder();
        const folder = await ensureFolder(wanted);
        // Cùng chốt với /api/folder: đổi thư mục khi ĐÃ có ⇒ phải xác nhận.
        assertFolderChangeAllowed(folder, input.confirmOutput);
        output = folder; accounts.output = output; saveAccounts();
        log(`Thư mục lưu cho khách mới: ${folder}`);
      }
      return reply(res, 200, { ok: true, value: await authOperation(() => saveAccount(input), mst) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/identifiers') {
      const input = await readBody(req);
      return reply(res, 200, { ok: true, value: saveIdentifiers(input.mst, input.identifiers) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/remove') {
      const mst = (await readBody(req)).mst;
      if (authBusy.has(mst)) throw new Error('Đang xử lý đăng nhập cho MST này.');
      const account = accountFor(mst, true);
      if (account) account.removedAt = new Date().toISOString();
      // Xoá đúng MST đang làm việc: đừng để app "nhớ" một hỒ sơ đã xoá – chuyển sang MST dùng
      // gần nhất còn lại (rememberSelectedMst ghi lại lựa chọn mới xuống accounts.json).
      if (selected === mst) { selected = ''; engine = null; authAccount = null; loginChallenge = null; rememberSelectedMst(); }
      accounts.selected = selected; saveAccounts(); return reply(res, 200, { ok: true, value: appState() });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/forget') { const body = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => forgetSecret(body), selected) }); }
    if (req.method === 'POST' && url.pathname === '/api/folder') {
      // Không có `path` thì mở hộp thoại chọn thư mục của Windows; có `path` thì lưu đường dẫn
      // người dùng tự gõ/dán (phải là đường dẫn đầy đủ, thư mục được tạo nếu chưa có).
      const input = await readBody(req); const typed = String(input.path || '').trim();
      const folder = typed ? typed : await chooseFolder();
      if (typed && !path.isAbsolute(typed)) throw new Error('Đường dẫn phải đầy đủ, ví dụ D:\\HoaDon\\2026.');
      if (folder) {
        const next = await ensureFolder(folder);
        // Đã có thư mục mà đổi sang thư mục KHÁC ⇒ phải có xác nhận (xem assertFolderChangeAllowed).
        assertFolderChangeAllowed(next, input.confirm);
        output = next; accounts.output = output; saveAccounts(); configureXmlWatcher();
      }
      return reply(res, 200, { ok: true, value: output });
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      await ensureLicenseAllowed();
      // Người dùng có thể bấm ngay lúc vừa mở app, trước lúc lượt kiểm tra phiên
      // nền kịp chạy. Chờ đúng lần đang chạy thay vì báo "chưa đăng nhập" – rỒi
      // người dùng phải đăng nhập lại phiên vốn đã còn.
      await ensureSessionCheck();
      const input = await readBody(req);
      // Chạy đúng luỒng của MST được yêu cầu ⇒ MST A đang tra cứu vẫn bấm sang MST B làm việc được.
      // ensureEngineFor tự dựng engine nếu chưa có (mở lại app là `engines` còn trống).
      const target = ensureEngineFor(input.mst);
      if (!target) throw new Error('Chọn MST trước khi tra cứu.');
      // Đang chạy tác vụ thì nút Tra cứu đóng vai nút Tạm dừng (tránh trường hợp giao diện chưa kịp
      // cập nhật trạng thái mà người dùng bấm lần nữa).
      if (target.busy) { target.pause(); return reply(res, 200, { ok: true, value: target.snapshot() }); }
      // Đang tự đăng nhập nền thì CHỠ lượt đang chạy rối mới chạy tiếp. Nót Tra cứu không bị khoá (nếu khoá, tính năng nèy sự đóng băng giao diện) nên bấm vào phải chổ đếi, không phải nêm lỗi cho người dùng.
      if (authBusy.has(target.mst)) { await waitBackgroundAuth(target.mst); }
      const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder); // báo lỗi rõ nếu là ổ gốc / ổ chỉ đọc / không có quyền ghi
      output = folder; accounts.output = output; saveAccounts();
      // Trả lời NGAY, tác vụ chạy nền: progress/paused theo dõi qua /api/state (poll 0,8s khi bận).
      runDetached(target, target.job?.id || '', `Tra cứu MST ${target.mst}`, async () => {
        await target.search(input, output);
        await closeBrowserWhenIdle('tra cứu xong');
      }).then(() => {
        // Lượt dừng vì hết phiên ⇒ đăng lại ngay để lượt sau (nút Tiếp tục) chạy được.
        if (target.job?.state === 'auth_required') maybeAutoRelogin(target.mst, 'phiên hết hạn khi tra cứu');
      });
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/api/stream') {
      await ensureLicenseAllowed();
      await ensureSessionCheck();
      const input = await readBody(req);
      const target = ensureEngineFor(input.mst);
      if (!target) throw new Error('Chọn MST trước khi tải hóa đơn.');
      if (target.busy) { target.pause(); return reply(res, 200, { ok: true, value: target.snapshot() }); }
      // Đang tự đăng nhập nền thì chưa dùng được: báo rõ là đang đăng nhập, KHÓNG báo
      // "chưa đăng nhập" (sai – mật khẩu có, chỉ là chưa xong) và không cho chạy lượt
      // với phiên nửa vời.
      if (authBusy.has(target.mst)) { await waitBackgroundAuth(target.mst); }
      const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder);
      output = folder; accounts.output = output; saveAccounts();
      const requested = validateParams(input);
      const currentJob = target.job;
      // Luật tái sử dụng nằm ở core để test được (canReuseSearch + tests/core.test.js).
      const reuse = canReuseSearch(currentJob, requested);
      // Trả lời NGAY, tải chạy nền (đây là request từng giữ mở nhiều phút – nguỒn trễ khi bấm).
      runDetached(target, currentJob?.id || '', `Tải cuốn chiếu MST ${target.mst}`, async () => {
        if (reuse) {
          currentJob.mode = 'stream';
          currentJob.output = output;
          await target.resume(true);
        } else {
          await target.stream(requested, output);
        }
        await closeBrowserWhenIdle('tải cuốn chiếu xong');
        autoImportAfterDownload('tải cuốn chiếu xong');
      });
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    // Xuất Excel danh sách hóa đơn từ chính kết quả tra cứu (không gọi API chi tiết, không tải XML/PDF).
    if (req.method === 'POST' && url.pathname === '/api/export-excel') {
      await ensureLicenseAllowed();
      const target = engineOf(String((await readBody(req)).mst || '').trim());
      if (!target) throw new Error('Chưa chọn MST và chưa tra cứu.');
      await applyOutput();
      return reply(res, 200, { ok: true, value: await target.exportList() });
    }
    // ---------------------------------------------------------------------------
    // /api/download – MỘT ENDPOINT DUY NHẤT cho nút "Tải hóa đơn" của giao diện.
    // Ba trạng thái của nút đều quy về đây, server tự đoán theo trạng thái job:
    //   1) đang chạy            → DỪNG (bấm lần 2 = Ngưng, không cần endpoint riêng)
    //   2) lượt còn dở          → CHẠY TIẾP từ đúng chỗ dừng (resume, tự thử lại lỗi)
    //   3) chưa có / đã xong    → CHẠY MỚI: quét + tải cuốn chiếu (stream)
    // Giao diện không còn cần phân biệt "Tra cứu" với "Tải ngay" nữa – cùng một đường.
    // ---------------------------------------------------------------------------
    if (req.method === 'POST' && url.pathname === '/api/download') {
      await ensureLicenseAllowed();
      // Người dùng có thể bấm ngay lúc vừa mở app, trước lúc lượt kiểm tra phiên nền kịp
      // chạy. Chờ đúng lần đang chạy thay vì báo "chưa đăng nhập" (nghĩa là phải đăng nhập lại
      // trong khi phiên vốn đã còn).
      await ensureSessionCheck();
      const input = await readBody(req);
      // ensureEngineFor (KHÓNG phải engineOf): mở lại app thì `engines` còn trống, bấm Tải hoá
      // đơn sẽ không có engine để chạy ⇒ tự dựng thay vì bắt người dùng bấm lại MST.
      const target = ensureEngineFor(input.mst);
      if (!target) throw new Error('Chọn MST trước khi tải hóa đơn.');
      // (1) ĐANG CHẠY → dừng. Idempotent: bấm Ngưng hai lần vẫn chỉ dừng một lần.
      if (target.busy) { target.pause(); return reply(res, 200, { ok: true, value: target.snapshot() }); }
      // Đang tự đăng nhập nền thì CHỜ lượt đang chạy rỒi mới làm tiếp. Nút không bị khoá (khoá
      // thì tính năng tự đăng nhập nền đóng băng cả giao diện) nên bấm là phải chạy được.
      if (authBusy.has(target.mst)) { await waitBackgroundAuth(target.mst); }
      const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder); // báo lỗi rõ nếu là ổ gốc / ổ chỉ đọc / không có quyền ghi
      output = folder; accounts.output = output; saveAccounts();
      const currentJob = target.job;
      // validateParams() phải chạy TRƯỚC cả hai nhánh: nhánh (2) cần điều kiện tra cứu đã chuẩn
      // hoá để so với lượt cũ. Nó cũng là chốt chặn báo lỗi sớm, trước cả khi bấm "Ngưng".
      const requested = validateParams(input);
      // (2) LƯỢT CÒN DỞ → chạy tiếp đúng chỗ dừng. isResumableJob() dùng CHUNG danh sách trạng
      // thái với giao diện (core.js) nên hai bên không tự chế mỗi bên một danh sách khác nhau.
      // Cần `confirm` từ giao diện: nếu không có, coi như người dùng bấm nút mới và chạy lượt mới
      // – cũng là hành vi hợp lý (lượt cũ đã dở thì bắt đầu lại vẫn đúng ý).
      //
      // PHẢI khớp cả điều kiện tra cứu: lượt còn dở mà người dùng đã đổi khoảng ngày thì chạy
      // tiếp sẽ tải KHOẢNG NGÀY CŨ – trái nhãn nút ("khoảng ngày đang chọn") và mất hàng đã tải
      // trong lúc người dùng tưởng đang tải kỳ mới. Lệch thì rơi xuống nhánh (3): lượt mới.
      if (input.confirm && isResumableJob(currentJob) && sameDownloadParams(currentJob, requested)) {
        log(`Tiếp tục lượt dở của MST ${target.mst} (${currentJob.state}): ${currentJob.items.filter(x => x.state === 'done' || x.state === 'skipped').length}/${currentJob.items.length} đã xong.`);
        runDetached(target, currentJob.id, `Chạy tiếp MST ${target.mst}`, async () => {
          await target.resume(true);
          await closeBrowserWhenIdle('tải xong');
          autoImportAfterDownload('chạy tiếp');
        });
        return reply(res, 200, { ok: true, value: target.snapshot() });
      }
      // (3) CHƯA CÒ / ĐÃ XONG → chạy lượt mới. Tái sử dụng danh sách đã tra cứu sẵn khi mọi
      // điều kiện trùng khớp (luật nằm ở core để test được – canReuseSearch + core.test.js).
      const reuse = canReuseSearch(currentJob, requested);
      // Trả lời NGAY, tác vụ chạy nền (đây là request từng giữ mở nhiều phút – nguỒn trễ khi bấm).
      runDetached(target, currentJob?.id || '', `Tải hóa đơn MST ${target.mst}`, async () => {
        if (reuse) {
          currentJob.mode = 'stream';
          currentJob.output = output;
          await target.resume(true);
        } else {
          await target.stream(requested, output);
        }
        await closeBrowserWhenIdle('tải xong');
        autoImportAfterDownload('tải xong');
        // Lượt dừng vì hết phiên ⇒ đăng lại ngay để lần bấm "Tải tiếp" sau chạy được.
        if (target.job?.state === 'auth_required') maybeAutoRelogin(target.mst, 'phiên hết hạn khi tải hóa đơn');
      });
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/api/resume') {
      await ensureLicenseAllowed();
      const target = engineOf(String((await readBody(req)).mst || '').trim());
      if (!target) throw new Error('Chưa chọn MST.');
      await applyOutput();
      runDetached(target, target.job?.id || '', `Chạy tiếp MST ${target.mst}`, async () => {
        await target.resume();
        await closeBrowserWhenIdle('tải xong');
        autoImportAfterDownload('chạy tiếp');
      });
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/api/pause') {
      const input = await readBody(req);
      const target = engineOf(String(input.mst || selected || '').trim());
      if (!target) throw new Error('Không tìm thấy luỒng của MST yêu cầu.');
      // jobId chỉ là chống ngưng nhầm LƯỢT CŨ: engine đã chuyển sang lượt khác thì báo lại, KHÓNG
      // coi là lỗi cứng – người dùng bấm Ngưng phải luôn có tác động (đúng tinh thần nút dừng).
      if (input.jobId && input.jobId !== target.job?.id) throw new Error('Lượt tải đã thay đổi. Hãy cập nhật trạng thái.');
      target.pause();
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const base = engine?.job?.output || output;
      if (!base) throw new Error('Chưa chọn thư mục lưu. Bấm “Chọn thư mục…” trước.');
      const mst = engine?.job?.account?.mst || selected; const own = mst ? path.join(base, `MST-${mst}`) : '';
      const folder = own && fs.existsSync(own) ? own : base; // mở thẳng MST-<số MST> khi đã có
      if (!fs.existsSync(folder)) throw new Error(`Thư mục "${folder}" chưa có. Chọn lại thư mục lưu rỒi bấm Tải hóa đơn.`);
      spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref();
      return reply(res, 200, { ok: true, value: folder });
    }
    // Hộp thoại chọn file PDF gốc (Mục 3). Chỉ trả về ĐƯỜNG DẪN – không tự liên kết, để
// người dùng thấy file mình chọn rỒi mới ghi vào kho (bước attach kiểm tra %PDF-).
    if (req.method === 'POST' && url.pathname === '/api/db/invoice-original/pick') {
      const input = await readBody(req);
      return withDatabase(async (db, dir) => {
        const row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(String(input.key || '').trim());
        if (!row) throw new Error('Không tìm thấy hóa đơn.');
        const dirName = row.direction === 'SELL' ? 'Ban_ra' : 'Mua_vao';
        const hint = path.join(dir, dirName, data.originalPdf.ORIGINAL_FOLDER);
        try { fs.mkdirSync(hint, { recursive: true }); } catch { /* không tạo được vẫn mở được hộp thoại */ }
        return reply(res, 200, { ok: true, value: { path: await choosePdfFile(hint, 'Chọn PDF hoá đơn gốc của nhà cung cấp'), dir: hint } });
      });
    }
    // Mở cổng tra cứu NCC trong CHÍNH Chromium của app (Mục 3) – không mở trình duyệt hệ
// thống, để người dùng nhập CAPTCHA/mã rỒi tải PDF gốc trong một cửa sổ duy nhất.
// Trả về false nếu không mở được – UI cần báo để người dùng tự mở bằng trình duyệt.
// Mở cổng tra cứu NCC trong cửa sổ Chrome RIÊNG của app (mục 3) — không mở trình
// duyệt hệ thống, không đụng tới cửa sổ Chrome của cổng thuế đang chạy.
// Mở cổng tra cứu NCC trong cửa sổ Chrome RIÊNG của app (mục 3), rồi TỰ ĐIỀN biểu mẫu.
// Không mở trình duyệt hệ thống, không đụng cửa sổ Chrome của cổng thuế đang chạy.
//
// Trả về kết quả trung thực: đã điền được gì, còn thiếu gì, và lý do hỏng nếu hỏng.
// Giao diện dựa vào đây để nói thật với người dùng — bản đầu trả Promise chưa await nên
// JSON hoá thành {} và luôn báo "Đã mở" dù không mở được gì.
async function openPortal(url, invoice) {
  try {
    const result = await browser.openPortalAndFill(url, invoice || {});
    return {
      opened: true,
      error: '',
      filled: result.filled || [],
      missing: result.missing || [],
      supported: result.supported !== false,
    };
  } catch (error) {
    const message = (error && error.message) || String(error);
    log(`Không mở được cổng tra cứu (${url}): ${message}`);
    return { opened: false, error: message, filled: [], missing: [], supported: false };
  }
}
    // Mở 1 file (hoặc thư mục) bằng ứng dụng mặc định của Windows – chỉ cho phép trong thư mục lưu.
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
    // Xem trước hoá đơn A4 từ tab Tra cứu: nhận ĐƯỜNG DẪN file XML (chỉ chấp nhận file nằm
    // trong thư mục lưu đã chọn – cùng luật với /api/open-file), dựng HTML chuẩn A4 bằng đúng
    // engine của tab Kho dữ liệu (invoice-a4), cache theo mtime+size như /api/db/invoice/html.
    if (req.method === 'GET' && url.pathname === '/api/preview-invoice') {
      const target = String(url.searchParams.get('file') || '').trim();
      const state = String(url.searchParams.get('state') || '').trim();
      const base = engine?.job?.output || output;
      const send = html => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        });
        return res.end(html);
      };
      if (target) {
        if (!base) throw new Error('Chưa chọn thư mục lưu.');
        const resolved = path.resolve(target); const root = path.resolve(base);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Chỉ xem trước được file nằm trong thư mục lưu đã chọn.');
        if (!fs.existsSync(resolved)) throw new Error(`Không thấy file: ${resolved}`);
        if (!/\.xml$/i.test(resolved)) throw new Error('Xem trước cần file XML của hoá đơn.');
        const stat = fs.statSync(resolved);
        const cacheKey = `${resolved}|${stat.mtimeMs}|${stat.size}|${state}`;
        let html = a4HtmlCache.get(cacheKey);
        if (!html) {
          html = require('./data/invoice-a4').buildInvoiceA4Document(fs.readFileSync(resolved, 'utf8'), { state });
          if (a4HtmlCache.size >= 100) a4HtmlCache.delete(a4HtmlCache.keys().next().value); // FIFO đơn giản
          a4HtmlCache.set(cacheKey, html);
        }
        return send(html);
      }
      // KHÓNG có file cục bộ: hoá đơn mới chỉ TRA CỨU, chưa tải về. Hỏi thẳng API chi tiết của cổng.
      // Đây là request THÊM lên cổng thuế – đi qua đúng pace.wait() như mọi request khác của ứng
      // dụng nên không tạo burst; cổng giới hạn nhịp thì lỗi hiện nguyên văn cho người dùng.
      //
      // Kiểm đầu vào TRƯỚC, kiểm trạng thái ứng dụng SAU: tham số sai phải bị từ chối vì chính nó,
      // không phụ thuộc việc đã có lượt tra cứu hay chưa. `family` còn được dùng để dựng đường dẫn
      // gọi cổng nên BẮT BUỘC nằm trong danh sách trắng.
      const family = String(url.searchParams.get('family') || 'query');
      if (!['query', 'sco-query'].includes(family)) throw new Error('Loại hoá đơn không hợp lệ.');
      const inv = {
        family, tthai: state || null,
        shdon: String(url.searchParams.get('shdon') || '').trim(),
        khhdon: String(url.searchParams.get('khhdon') || '').trim(),
        khmshdon: String(url.searchParams.get('khmshdon') || '').trim(),
        nbmst: String(url.searchParams.get('nbmst') || '').trim(),
      };
      if (!inv.shdon || !inv.nbmst) throw new Error('Thiếu số hoá đơn hoặc MST người bán để xem trước.');
      if (!engine || !engine.job) throw new Error('Chưa có lượt tra cứu nào. Hãy tra cứu trước rỒi bấm xem trước.');
      const query = new URLSearchParams({ nbmst: inv.nbmst, khhdon: inv.khhdon, shdon: inv.shdon, khmshdon: inv.khmshdon }).toString();
      const bytes = await engine.request(`/${family}/invoices/detail?${query}`, 'Xem chi tiết', () => {});
      const detail = JSON.parse(bytes.toString('utf8'));
      const html = require('./data/invoice-a4').withStatusNote(require('./core').invoiceHtml(inv, detail), inv.tthai);
      return send(html);
    }

    // ========== TRA CỨU MST HÀNG LOẠT (tab "Tra cứu MST") ==========
    // KHÓNG tự mở cửa sổ Chrome ở đây. open() đóng phiên hiện có trước (nó gọi close()),
    // nên bấm tab một cái là lượt tải hóa đơn đang dở bị giật, rỒi cửa sổ Chrome mọc lên
    // và còn lại sau khi app đóng. Chỉ dùng phiên đã có – không có thì báo rõ.
    if (url.pathname.startsWith('/api/mst/lookup/')) {
      return mstLookupRoute(req, res, url, requireSession('Tra cứu MST'));
    }

    // ========== TỜ KHAI / DVC (tab "Tải tờ khai") ==========
    if (url.pathname.startsWith('/api/tokhai/')) {
      return tokhaiRoute(req, res, url, requireSession('Tờ khai'));
    }

    // ĐỒng bộ phiên DVC/TDT từ cửa sổ Chrome đang mở (nút "📔 ĐỒng bộ Web").
    if (req.method === 'POST' && url.pathname === '/api/sync-token') {
      const input = await readBody(req);
      const targetMst = requireSession('ĐỒng bộ Web');
      const portal = String(input.portal || 'dvc');
      const found = portal === 'dvc' ? await findDvcSession(targetMst) : await findTdtSession(targetMst);
      if (!found.ok) return reply(res, 200, { ok: false, error: found.error });
      return reply(res, 200, { ok: true, value: found });
    }

    return reply(res, 404, { ok: false, error: 'Không tìm thấy lệnh.' });
  } catch (error) {
    // Mọi lỗi của route đều ra 400, nên giao diện chỉ thấy "400 (Bad Request)" ở console mà
    // không biết guard nào chặn (đã gặp: bấm nút Tải hoá đơn ra 400, log trống, không truy được).
    // Ghi lại route + lý do để lần sau đọc nhat-ky.log là ra ngay.
    log(`LỖI ${req.method} ${url.pathname}: ${error && error.message ? error.message : String(error)}`);
    return reply(res, 400, { ok: false, error: error.message || 'Lỗi không xác định.' });
  }
}

// ---------------------------------------------------------------------------
// PHÂN HỆ MỞ RỘNG: Tra cứu MST + Tờ khai/DVC
//
// Cả hai đều là CHỨC NĂNG ĐỌC, không ghi vào kho dữ liệu, nên không đi qua
// ensureLicenseAllowed() – giống các route GET của tab Kho dữ liệu.
//
// VÌ SAO DÙNG CDP (mở Chrome) THAY VÌ HTTP THUẦN:
//   · tracuuhoadon.gdt.gov.vn chỉ chấp nhận phiên cookie của chính nó; không có
//     API token như hoadondientu.
//   · dichvucong / thuedientu dùng session + CSRF token lấy từ trang login.
//   · Cả hai đều cần CAPTCHA, mà CAPTCHA chỉ lấy được trong phiên đã mở.
// Nên route tự mở cửa sổ trình duyệt của MST đang chọn (nếu chưa mở) rỒi chạy
// script trong chính tab đó – cookie/phiên do trình duyệt giữ, không phải dựng lại.
// ---------------------------------------------------------------------------

// Trạng thái tiến trình đang chạy cho UI poll /api/*/progress và để bấm "Ngưng".
const mstLookupJob = { running: false, progress: {}, controller: null, results: [] };
const tokhaiJob = { running: false, progress: {}, controller: null, results: [], portal: 'dvc' };

// Chỉ dùng phiên Chrome ĐANG CÒ của đúng MST đang chọn. Không tự mở: xem ghi chú
// ở trên endpoint. Người dùng tự mở qua luỒng đăng nhập sẵn có của app.
function requireSession(feature) {
  const mst = String(selected || '').trim();
  if (!mst || !accountFor(mst)) throw new Error(`Chọn một MST trong danh sách bên trái trước khi dùng ${feature}.`);
  if (!browser.client) {
    throw new Error(`Chưa có cửa sổ Chrome cho MST này. Bấm "Đăng nhập" ở tab Tra cứu & tải để mở phiên cổng thuế, rỒi quay lại dùng ${feature}.`);
  }
  if (browser.mst !== mst) {
    throw new Error(`Cửa sổ Chrome đang đăng nhập MST ${browser.mst}, không phải MST đang chọn (${mst}). Chuyển sang MST ${browser.mst} hoặc đóng cửa sổ Chrome rỒi đăng nhập lại.`);
  }
  return mst;
}

async function mstLookupRoute(req, res, url, mst) {
  const { MstLookupController } = require('./mst-lookup');
  const action = url.pathname.slice('/api/mst/lookup/'.length);

  if (req.method === 'POST' && action === 'captcha') {
    const ctl = new MstLookupController({ browser, dataDir, mst, log });
    const captcha = await ctl.loadCaptcha();
    return reply(res, 200, { ok: true, value: captcha });
  }

  if (req.method === 'GET' && action === 'progress') {
    return reply(res, 200, { ok: true, value: mstLookupJob.progress });
  }

  if (req.method === 'POST' && action === 'stop') {
    if (mstLookupJob.controller) mstLookupJob.controller.shouldStop = true;
    return reply(res, 200, { ok: true, value: { stopped: true } });
  }

  if (req.method === 'POST' && action === 'search') {
    if (mstLookupJob.running) throw new Error('Đang tra cứu MST. Bấm Ngưng nếu muốn dừng.');
    const input = await readBody(req);
    const list = mstFormat ? null : null; // placeholder, xem dưới
    const mstList = Array.isArray(input.mstList)
      ? input.mstList
      : String(input.text || '').split(/[\r\n,\t\s;]+/).map(s => s.replace(/[^0-9A-Za-z-]/g, '').trim()).filter(s => s.length >= 8);
    const captchaCode = String(input.captchaCode || '').trim().toUpperCase();
    const unique = [...new Set(mstList)];
    if (!unique.length) throw new Error('Danh sách MST trống. Nhập ít nhất một MST hợp lệ.');
    if (!captchaCode) throw new Error('Chưa nhập mã CAPTCHA. Bấm nút 📔 để lấy mã, hoặc gõ tay.');

    const ctl = new MstLookupController({
      browser, dataDir, mst, log,
      onProgress: p => Object.assign(mstLookupJob.progress, p),
    });
    mstLookupJob.controller = ctl;
    mstLookupJob.running = true;
    mstLookupJob.results = [];
    mstLookupJob.progress = { stage: 'start', total: unique.length, done: 0, message: `Bắt đầu tra cứu ${unique.length} MST…` };

    // Chạy nền + trả ngay: UI poll /progress nên không giữ request mở.
    ctl.search(unique, captchaCode)
      .then(rows => {
        mstLookupJob.results = rows || [];
        Object.assign(mstLookupJob.progress, {
          stage: 'complete',
          done: (mstLookupJob.results || []).length,
          rows: mstLookupJob.results,
          message: `Hoàn thành! Đã tra cứu ${(mstLookupJob.results || []).length}/${unique.length} MST.`,
        });
      })
      .catch(error => { Object.assign(mstLookupJob.progress, { stage: 'error', error: error.message, message: `Lỗi: ${error.message}` }); })
      .finally(() => { mstLookupJob.running = false; mstLookupJob.controller = null; });
    return reply(res, 200, { ok: true, value: { started: true, total: unique.length } });
  }

  if (req.method === 'POST' && action === 'export') {
    const rows = mstLookupJob.results || [];
    if (!rows.length) throw new Error('Chưa có kết quả để xuất.');
    const input = await readBody(req);
    const now = new Date();
    const name = String(input.filename || `Tra_Cuu_Trang_Thai_MST_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`);
    const target = String(input.path || path.join(output || '', name));
    const { MstLookupController } = require('./mst-lookup');
    MstLookupController.writeExcel(rows, target);
    return reply(res, 200, { ok: true, value: { filename: name, path: target, rows: rows.length } });
  }

  return reply(res, 404, { ok: false, error: 'Không rõ lệnh tra cứu MST.' });
}

async function tokhaiRoute(req, res, url, mst) {
  const { TokhaiController } = require('./tokhai');
  const action = url.pathname.slice('/api/tokhai/'.length);

  if (req.method === 'GET' && action === 'progress') {
    return reply(res, 200, { ok: true, value: tokhaiJob.progress });
  }

  if (req.method === 'POST' && action === 'stop') {
    if (tokhaiJob.controller) tokhaiJob.controller.shouldStop = true;
    return reply(res, 200, { ok: true, value: { stopped: true } });
  }

  if (req.method === 'POST' && action === 'captcha') {
    const input = await readBody(req);
    const portal = String(input.portal || 'dvc');
    const ctl = new TokhaiController({ browser, dataDir, mst, log });
    ctl.currentPortal = portal;
    const captcha = await ctl.loadCaptcha();
    return reply(res, 200, { ok: true, value: captcha });
  }

  if (req.method === 'POST' && action === 'login') {
    const input = await readBody(req);
    const username = String(input.username || '').trim();
    const password = String(input.password || '');
    const captcha = String(input.captcha || '').trim().toUpperCase();
    const portal = String(input.portal || 'dvc');
    if (!username || !password) throw new Error('Thiếu tài khoản hoặc mật khẩu.');
    if (!captcha) throw new Error('Thiếu mã CAPTCHA.');
    const ctl = new TokhaiController({ browser, dataDir, mst, log });
    ctl.currentPortal = portal;
    const result = portal === 'tdt'
      ? await ctl.loginTdt(username, password, captcha)
      : await ctl.loginDvc(username, password, captcha);
    if (input.remember && portal === 'dvc') {
      try { secrets.writeAsync(mst, { dvc_login: { username, password: secrets.protect(password), savedAt: Date.now() } }); }
      catch (error) { log('Không lưu được thông tin đăng nhập DVC: ' + error.message); }
    }
    tokhaiJob.portal = portal;
    return reply(res, 200, { ok: true, value: result });
  }

  if (req.method === 'POST' && action === 'search') {
    if (tokhaiJob.running) throw new Error('Đang tra cứu. Bấm Ngưng nếu muốn dừng.');
    const input = await readBody(req);
    const tuNgay = String(input.tuNgay || '').trim();
    const denNgay = String(input.denNgay || '').trim();
    const captcha = String(input.captcha || '').trim().toUpperCase();
    const portal = String(input.portal || 'dvc');
    if (!tuNgay || !denNgay) throw new Error('Chọn đủ Từ ngày và Đến ngày.');

    const ctl = new TokhaiController({
      browser, dataDir, mst, log,
      onProgress: p => Object.assign(tokhaiJob.progress, p),
    });
    ctl.currentPortal = portal;
    tokhaiJob.controller = ctl;
    tokhaiJob.running = true;
    tokhaiJob.portal = portal;
    tokhaiJob.results = [];
    tokhaiJob.progress = { stage: 'start', message: `Đang tra cứu ${portal === 'tdt' ? 'Thuế Điện Tử' : 'Dịch Vụ Công'}…` };

    const task = portal === 'tdt' ? ctl.searchTdt(tuNgay, denNgay) : ctl.searchDvc(tuNgay, denNgay, captcha);
    task.then(rows => {
      tokhaiJob.results = rows || [];
      Object.assign(tokhaiJob.progress, { stage: 'complete', count: tokhaiJob.results.length, rows: tokhaiJob.results, message: `Tìm thấy ${tokhaiJob.results.length} hỒ sơ.` });
    }).catch(error => {
      Object.assign(tokhaiJob.progress, { stage: 'error', error: error.message, message: `Lỗi: ${error.message}` });
    }).finally(() => { tokhaiJob.running = false; tokhaiJob.controller = null; });
    return reply(res, 200, { ok: true, value: { started: true } });
  }

  if (req.method === 'POST' && action === 'download') {
    const input = await readBody(req);
    const list = Array.isArray(input.maHoSoList) ? input.maHoSoList.map(String).filter(Boolean) : [];
    if (!list.length) throw new Error('Chưa chọn hỒ sơ nào để tải.');
    if (tokhaiJob.running) throw new Error('Đang tra cứu. Đợi xong rỒi tải.');

    const portal = tokhaiJob.portal || String(input.portal || 'dvc');
    const ctl = new TokhaiController({
      browser, dataDir, mst, log,
      onProgress: p => Object.assign(tokhaiJob.progress, p),
    });
    ctl.currentPortal = portal;
    tokhaiJob.controller = ctl;
    tokhaiJob.running = true;
    tokhaiJob.progress = { stage: 'download', total: list.length, done: 0, message: `Đang tải ${list.length} hỒ sơ…` };

    // Thư mục đích: <thư mục lưu>/MST-<mst>/To_khai/
    const dir = output ? path.join(output, `MST-${mst}`, 'To_khai') : '';
    const task = ctl.bulkDownload(list, { outputDir: dir, output });
    task.then(result => {
      Object.assign(tokhaiJob.progress, { stage: 'complete', ...result, message: `Tải xong ${result.succeeded || 0}/${list.length} hỒ sơ.` });
    }).catch(error => {
      Object.assign(tokhaiJob.progress, { stage: 'error', error: error.message, message: `Lỗi tải: ${error.message}` });
    }).finally(() => { tokhaiJob.running = false; tokhaiJob.controller = null; });
    return reply(res, 200, { ok: true, value: { started: true, total: list.length } });
  }

  return reply(res, 404, { ok: false, error: 'Không rõ lệnh tờ khai.' });
}

// DVC: đọc phiên đang có trong tab. Trả về { ok, mst, name } hoặc { ok:false, error }.
async function findDvcSession(mst) {
  const tabs = await browser.listTabs();
  const tab = tabs.find(t => t.url && t.url.includes('dichvucong.gdt.gov.vn'));
  if (!tab) return { ok: false, error: 'Chưa mở tab Dịch Vụ Công. Bấm "Mở cổng trên Chrome" rỒi đăng nhập.' };
  try {
    const info = await browser.evalInTab(tab.id, `(() => {
      try {
        const pick = o => { for (const k of ['tenDN','mst','maSoThue','username','hoTen']) { const v = o && o[k]; if (v) return String(v); } return ''; };
        const body = (document.body && document.body.innerText || '').slice(0, 4000);
        const m = body.match(/(?:MST|Mã số thuế|Tài khoản)\\s*:\\s*([0-9A-Za-z\\-]{8,})/i);
        return { mst: m ? m[1] : '', csrf: (document.querySelector('meta[name="csrf-token"]')||{}).content || '', ok: true };
      } catch (e) { return { ok: false, error: e.message }; }
    })()`);
    if (!info || !info.ok) return { ok: false, error: (info && info.error) || 'Không đọc được phiên DVC.' };
    if (!info.mst) return { ok: false, error: 'Đã mở Dịch Vụ Công nhưng chưa đăng nhập (không thấy MST trên trang).' };
    return { ok: true, mst: info.mst, name: 'Cổng Dịch Vụ Công Thuế', portal: 'dvc' };
  } catch (error) { return { ok: false, error: error.message }; }
}

// Thuế Điện Tử: đọc dse_sessionId + tên đơn vị từ trang đã đăng nhập.
async function findTdtSession(mst) {
  const tabs = await browser.listTabs();
  const tab = tabs.find(t => t.url && t.url.includes('thuedientu.gdt.gov.vn'));
  if (!tab) return { ok: false, error: 'Chưa mở tab Thuế Điện Tử. Bấm "Mở cổng trên Chrome" rỒi đăng nhập.' };
  try {
    const info = await browser.evalInTab(tab.id, `(() => {
      try {
        const url = new URLSearchParams(location.search).get('dse_sessionId')
          || (document.querySelector("input[name='dse_sessionId']") || {}).value || '';
        const text = (document.body && document.body.innerText || '').slice(0, 4000);
        const nameM = text.match(/Tên đơn vị\\s*:\\s*([^\\n]{2,80})/i);
        const mstM = text.match(/(?:Mã số thuế|MST)\\s*:\\s*([0-9A-Za-z\\-]{8,})/i);
        return { sessionId: url, name: nameM ? nameM[1].trim() : '', mst: mstM ? mstM[1] : '' };
      } catch (e) { return { error: e.message }; }
    })()`);
    if (!info || info.error) return { ok: false, error: (info && info.error) || 'Không đọc được phiên Thuế điện tử.' };
    if (!info.sessionId) return { ok: false, error: 'Chưa đăng nhập Thuế Điện Tử (không thấy dse_sessionId trên trang).' };
    return { ok: true, mst: info.mst || mst, name: info.name || 'Cổng Thuế Điện Tử (eTax)', portal: 'tdt', sessionId: info.sessionId };
  } catch (error) { return { ok: false, error: error.message }; }
}
// ---------------------------------------------------------------------------
// Vòng đời ứng dụng: MỘT instance duy nhất + System Tray. Chỉ lớp này thay đổi;
// KHÓNG đụng SQLite, API cũ, engine tra cứu/tải, job JSON, updater hay nghiệp vụ.
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

// Gọi một endpoint của instance đang chạy – cùng cookie phiên như giao diện đang dùng.
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

// Bản EXE mở lần hai: nếu instance cũ còn sống thì nhờ nó mở lại cửa sổ rỒi THOÁT NGAY
// (không tạo thêm Node server, Chrome hay Tray). File instance ghi trong du_lieu của app.
async function claimSingleInstance(port) {
  if (testServer) return true;
  const existing = readInstanceFile();
  if (existing && Number(existing.pid) !== process.pid) {
    const ping = await callInstance(existing, '/api/ping');
    if (ping && ping.status === 200) {
      log(`Đã có bản đang chạy (pid ${existing.pid}, cổng ${existing.port}) – nhờ bản đó mở lại cửa sổ rỒi thoát.`);
      await callInstance(existing, '/api/window/show', 'POST');
      return false;
    }
    log('File instance cũ không còn phản hỒi – tiếp tục khởi động bản mới.');
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
// chính, rỒi ShowWindow (khôi phục nếu thu nhỏ) + SetForegroundWindow.
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
  // trong snapshot của pkg (/snapshot/...), nên chỉ xét icon cạnh EXE – build copy resources/icon.ico
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
    // Gọi endpoint bằng .NET HttpWebRequest, KHÓNG dùng Invoke-WebRequest: PowerShell 5.1 không gửi
    // header Cookie truyền qua -Headers (đã kiểm chứng: /api/ping trả 403 ⇒ helper tự thoát sau ~0,4 giây
    // và icon khay hiện rỒi biến mất). Proxy = $null để không phụ thuộc proxy của máy.
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

// Icon khay tự phục hỒi THEO SỰ KIỆN – KHÓNG hỏi vòng định kỳ.
// Chỉ hẹn dựng lại khi helper ĐÃ chết; lúc mọi thứ bình thường thì không có timer nào chạy.
// Bản trước quét mỗi 20 giây một lần bằng setInterval – vừa thừa vừa chậm tới 20 giây.
const TRAY_STABLE_MS = 2500;
function scheduleTrayRetry() {
  if (trayStopped || process.platform !== 'win32' || trayRetryTimer) return trayRetryTimer;
  const wait = Math.max(5000, trayNextTry - Date.now());
  trayRetryTimer = setTimeout(() => {
    trayRetryTimer = null;
    try { ensureTray(); } catch { /* ensureTray đã ghi log */ }
    // Còn trong thời gian lùi ⇒ hẹn lại. Thiếu bước này thì helper chết sớm sẽ bị bỏ rơi vĩnh viễn.
    if (!trayAlive()) scheduleTrayRetry();
  }, wait);
  if (trayRetryTimer.unref) trayRetryTimer.unref();
  return trayRetryTimer;
}

function ensureTray() {
  if (process.platform !== 'win32' || trayStopped) return null;
  if (trayAlive()) return trayProcess;
  if (Date.now() < trayNextTry) { scheduleTrayRetry(); return null; }
  trayNextTry = Date.now() + 15000;
  try {
    const encoded = Buffer.from(trayScript(server.address().port), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: 'ignore' });
    trayProcess = child;
    const startedAt = Date.now();
    if (trayRetryTimer) { clearTimeout(trayRetryTimer); trayRetryTimer = null; }
    child.on('error', error => { if (trayProcess === child) trayProcess = null; log('Không mở được icon khay: ' + error.message); });
    // ĐÂY là nơi DUY NHẤT quyết định lỗi/lùi (trước đây bộ hẹn 2,5 giây cũng phạt, thành ra trừ hai lần
    // cho cùng một lần hỏng). Helper chết thì dựng lại ngay theo sự kiện; chết sớm liên tục thì lùi dần.
    child.on('exit', () => {
      if (trayProcess !== child) return;
      trayProcess = null;
      if (trayStopped) return;
      const lived = Date.now() - startedAt;
      if (lived < TRAY_STABLE_MS) {
        trayFailCount += 1;
        trayNextTry = Date.now() + Math.min(300000, 15000 * trayFailCount);
        log(`Icon khay dừng sớm (mã ${child.exitCode}, sống ${lived}ms) – sẽ dựng lại. Chi tiết: ${path.join(dataDir, 'tray.log')}`);
      } else {
        trayFailCount = 0;
        trayNextTry = Date.now() + 5000;
        log('Icon khay đã dừng – dựng lại sau 5 giây.');
      }
      scheduleTrayRetry();
    });
    // Chỉ báo thành công SAU KHI kiểm chứng helper còn sống. Trước đây log ghi ngay sau spawn nên
    // báo "đã hiện icon khay" trong khi helper đã thoát vì lỗi – log không đúng sự thật.
    setTimeout(() => {
      if (trayProcess === child && child.exitCode === null) {
        trayFailCount = 0;
        log('Đã hiện icon khay hệ thống (trái: mở ứng dụng · phải: Mở ứng dụng / Thoát hoàn toàn).');
      }
    }, TRAY_STABLE_MS).unref();
    return child;
  } catch (error) {
    trayFailCount += 1;
    trayNextTry = Date.now() + Math.min(300000, 15000 * trayFailCount);
    log('Không mở được icon khay: ' + (error && error.message ? error.message : error));
    scheduleTrayRetry();
    return null;
  }
}

function stopTray() {
  trayStopped = true;
  if (trayRetryTimer) { clearTimeout(trayRetryTimer); trayRetryTimer = null; }
  if (!trayProcess) return;
  const child = trayProcess;
  trayProcess = null;
  try { child.kill(); } catch { /* đã thoát */ }
}

// Cửa sổ app là cửa sổ Chrome (--app) nên app KHÓNG thể chặn nút X. Vì vậy: cửa sổ đóng ⇒
// ứng dụng VẪN CHẠY NỀN + hiện icon System Tray để mở lại (không thoát).
// Chỉ thoát khi người dùng chọn "Thoát hoàn toàn" trong khay, hoặc nhận SIGINT/SIGTERM.
function watchUi() {
  // Chrome có thể kết thúc tiến trình khởi chạy sớm (bàn giao cho instance khác), nên chỉ coi là
  // "đã đóng cửa sổ" khi giao diện ĐÃ ngừng gọi /api/state.
  uiProcess.once('exit', () => setTimeout(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 8000) {
      log('Cửa sổ giao diện đã đóng – ứng dụng vẫn chạy nền trong khay hệ thống. Bấm icon khay để mở lại.');
      ensureTray();
    } else log('Tiến trình khởi chạy Chrome đã kết thúc nhưng giao diện vẫn phản hỒi – tiếp tục chạy.');
  }, 10000));
  const timer = setInterval(() => {
    if (lastUiPoll && Date.now() - lastUiPoll > 150000 && !uiSilentLogged) {
      uiSilentLogged = true;
      log('Giao diện không phản hỒi trong 2,5 phút – vẫn giữ ứng dụng chạy nền (không thoát). Bấm icon khay để mở lại.');
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
  if (url.pathname === '/') return staticFile(req, res, 'index.html', 'text/html; charset=utf-8');
  // Favicon: Chrome lấy làm icon cửa sổ --app (taskbar / Alt-Tab / icon ghim).
  if (url.pathname === '/icon.png') return staticFile(req, res, 'icon.png', 'image/png');
  // Logo sidebar. Trước đây nhúng base64 1024×1024 thẳng vào index.html (2 MB cho một chỗ hiển thị
  // 44px); nay là file 88×88 (~10 KB) do tools/make-icon.cjs sinh ra cùng lúc với icon. Không có
  // file này thì đúng một ảnh trong sidebar hỏng – phần còn lại của giao diện vẫn chạy.
  if (url.pathname === '/brand-logo.png') return staticFile(req, res, 'brand-logo.png', 'image/png');
  if (url.pathname === '/style.css') return staticFile(req, res, 'style.css', 'text/css; charset=utf-8');
  if (url.pathname === '/login.css') return staticFile(req, res, 'login.css', 'text/css; charset=utf-8');
  if (url.pathname === '/renderer.js') return staticFile(req, res, 'renderer.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/chat-widget.js') return staticFile(req, res, 'chat-widget.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/ai-chat.js') return staticFile(req, res, 'ai-chat.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/ai-providers.js') return staticFile(req, res, 'ai-providers.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/vendor/sound.js') return staticFile(req, res, 'vendor/sound.js', 'text/javascript; charset=utf-8');
  // Âm thanh thông báo TUỲ CHỌN: bỏ file src/template/thong-bao.mp3 là app dùng file đó, không có thì
  // renderer tự dùng chuông sinh sẵn trong vendor/sound.js.
  // Thiếu file thì trả 204 (thành công, rỗng) NHƯNG 404: đây là tài sản tuỳ chọn, không phải lỗi,
  // và 404 làm trình duyệt ghi "Failed to load resource" mỗi lần mở app dù app vẫn chạy đúng.
  if (url.pathname === '/template/thong-bao.mp3') {
    const optionalSound = path.join(__dirname, 'template', 'thong-bao.mp3');
    if (!fs.existsSync(optionalSound)) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
    return staticFile(req, res, 'template/thong-bao.mp3', 'audio/mpeg');
  }
  if (url.pathname === '/app-settings.js') return staticFile(req, res, 'app-settings.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/update-ui.js') return staticFile(req, res, 'update-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/period.js') return staticFile(req, res, 'period.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/mst-format.js') return staticFile(req, res, 'mst-format.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/data-ui.js') return staticFile(req, res, 'data-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/bank-pdf.js') return staticFile(req, res, 'bank-pdf.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/dvt-ui.js') return staticFile(req, res, 'dvt-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/mst-lookup-ui.js') return staticFile(req, res, 'mst-lookup-ui.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/tokhai-ui.js') return staticFile(req, res, 'tokhai-ui.js', 'text/javascript; charset=utf-8');
  // pdfjs (module + worker) cho "Sao kê ngân hàng" đọc PDF có chữ ngay trong máy.
  if (url.pathname === '/vendor/pdfjs/pdf.min.mjs') return staticFile(req, res, 'vendor/pdfjs/pdf.min.mjs', 'text/javascript; charset=utf-8');
  if (url.pathname === '/vendor/pdfjs/pdf.worker.min.mjs') return staticFile(req, res, 'vendor/pdfjs/pdf.worker.min.mjs', 'text/javascript; charset=utf-8');
  if (url.pathname === '/data-view.css') return staticFile(req, res, 'data-view.css', 'text/css; charset=utf-8');
  // Ảnh chụp danh sách MST cho khung hình ĐẦU TIÊN – xem bootCacheScript().
  if (url.pathname === '/boot-cache.js') return bootCacheScript(res);
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
  // Kiểm CHÍNH BẢN ĐÒNG GÒI: bộ giải CAPTCHA có chạy được trong EXE không?
  // Vì sao cần cờ này: `pkg` KHÓNG tự nhúng thư viện native của gói phụ thuộc. Đã xảy ra thật –
  // thiếu sharp/libvips nên EXE không rasterize được SVG CAPTCHA ⇒ đăng nhập hỏng, trong khi
  // `node src/server.js` (có node_modules) vẫn tốt. Ảnh mẫu tại chỗ: KHÓNG gọi mạng, KHÓNG dùng
  // tài khoản nào – nên chạy được cả trên CI lẫn trên máy người dùng.
  if (process.argv.includes('--ocr-check')) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="15" y="30" font-size="26" font-family="DejaVu Sans Mono" fill="black">A7K2</text></svg>';
    // Nạp TỪNG thư viện native và ghi lại LỖI THẬT: bộ giải nuốt lỗi khi require nên nếu chỉ chạy
    // solve() thì chỉ thấy "Thiếu sharp", không biết thiếu cái gì. Đây là chỗ cần lỗi thô.
    const libs = {};
    for (const name of ['sharp', 'onnxruntime-node']) {
      try { require(name); libs[name] = 'ok'; }
      catch (error) { libs[name] = String((error && error.message) || error).split('\n')[0].slice(0, 300); }
    }
    try {
      const solver = require('./captcha-solver');
      const text = await solver.solve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      const ok = text === 'A7K2';
      console.log(JSON.stringify({ packed, ocr: ok, text, solverError: solver.lastErrorMessage(), libs }, null, 1));
      process.exitCode = ok ? 0 : 1; server.close();
    } catch (error) {
      console.error(JSON.stringify({ packed, ocr: false, thrown: String((error && error.message) || error).slice(0, 300), libs }, null, 1));
      process.exitCode = 1; server.close();
    }
  }
  else if (process.argv.includes('--smoke-test')) {
    try {
      const [page, state] = await Promise.all([localGet(port, '/'), localGet(port, '/api/state')]);
      if (page.status !== 200 || !page.body.includes('CN Tax Tools') || state.status !== 200 || JSON.parse(state.body).ok !== true) throw new Error('Giao diện hoặc API localhost không phản hỒi đúng.');
      // ĐỦ TÍNH NĂNG, KHÓNG CHỈ "MỞ ĐƯỢC": pkg khi thiếu asset chỉ CẢNH BÁO rỒi vẫn xuất EXE, nên bản
      // 1.0.7 phát hành thiếu HẲN tab "Sao kê ngân hàng" (bank-pdf.js + vendor/pdfjs/*.mjs không nằm
      // trong gói) mà build vẫn "xanh". Kiểm MỌI file giao diện có thật sự được phục vụ: danh sách
      // lấy từ chính index.html nên sau này thêm file mới là tự động được kiểm theo.
      const referenced = [...page.body.matchAll(/(?:src|href)="([^":#]+)"/g)].map(match => match[1]);
      const assets = [...new Set([
        ...referenced,
        'icon.png',
        // pdfjs nạp bằng import() động trong bank-pdf.js nên không xuất hiện trong index.html.
        'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
      ])];
      const broken = [];
      for (const asset of assets) {
        const reply = await localGet(port, '/' + asset.replace(/^\.?\//, ''));
        if (reply.status !== 200 || !reply.body) broken.push(`${asset} (HTTP ${reply.status})`);
      }
if (broken.length) throw new Error(`EXE thiếu file giao diện: ${broken.join(', ')}`);
      // ĐỌC THẬT 4 script runner tải PDF gốc. Đây là kiểm DUY NHẤT đáng tin cho phần này:
      // pkg nhúng asset theo đường dẫn nhưng bảng tên trong EXE lưu phẳng, nên quét byte
      // theo "provider-reference/x.js" sẽ kết luận thiếu dù file CÓ trong gói (đã xảy ra:
      // build xoá mất bản phát hành hai lần rồi mới phát hiện ra). Ở đây ta gọi đúng đường
      // dẫn mà provider-download.js gọi lúc chạy — đọc hỏng thì tính năng chết âm thầm.
      const runnerFiles = ['generic-runner.js', 'misa-runner.js', 'misa-adapter.js', 'captcha-panel.js'];
      const unreadable = [];
      for (const name of runnerFiles) {
        try { require('node:fs').readFileSync(path.join(__dirname, 'provider-reference', name)); }
        catch { unreadable.push(name); }
      }
      if (unreadable.length) throw new Error(`EXE không đọc được script tải PDF gốc: ${unreadable.join(', ')} — tính năng sẽ chết lúc chạy.`);
      const aiResult = await require('./ai/safe-js').executeSafeJs('return input.filter(x=>helpers.number(x.total)>10)', [{ total: 20 }, { total: 5 }]);
      if (JSON.stringify(aiResult) !== '[{"total":20}]') throw new Error('Runtime JS của AI Agent không hoạt động trong EXE.');
      console.log(JSON.stringify({ ok: true, packed, port, browser: browserPath() || null, ui: true, api: true, aiRuntime: true, assets: assets.length })); process.exitCode = 0; server.close();
    } catch (error) { console.error(error.message); process.exitCode = 1; server.close(); }
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
    // Kiểm chứng trong EXE: chạy đúng phần “kiểm tra phiên lúc khởi động” rỒi thoát.
    startupSessionCheck()
      .then(summary => { console.log(JSON.stringify(summary)); server.close(() => process.exit(0)); })
      .catch(error => { console.error(String(error && error.message ? error.message : error)); server.close(() => process.exit(1)); });
  }
  else if (testServer) console.log(JSON.stringify({ testUrl: `http://127.0.0.1:${port}/?launch=${sessionSecret}`, packed }));
  else {
    log(`Khởi động CN Tax Tools (${packed ? 'EXE' : 'node'}) · dữ liệu: ${dataDir} · cổng ${port}`);
    // Một instance duy nhất: bản mở sau chỉ nhờ bản cũ mở lại cửa sổ rỒi thoát.
    claimSingleInstance(port).then(keepAlive => {
      if (!keepAlive) { server.close(() => process.exit(0)); return; }
      // --start-hidden: đây là lúc Windows mở app cùng lúc khởi động máy. Không
      // mở cửa sổ Chrome – chỉ hiện icon khay, người dùng bấm vào mới mở. Không có
      // cờ này thì hành vi cũ: mở cửa sổ luôn.
      const hidden = process.argv.includes(autostart.START_FLAG);
      try {
        if (hidden) log('Khởi động ẩn (do Windows gọi) – chỉ hiện icon khay, bấm icon để mở ứng dụng.');
        else launchUi(port);
        ensureTray();
      } catch (error) { reportFatal(error.message); stop(); return; }
      // ĐỒng bộ khoá Run theo lựa chọn của người dùng. Làm ở đây (không chặn
      // khởi động) vì nó đụng reg.exe; lần chạy đầu sẽ ghi khoá Run, các lần sau
      // chỉ đọc để tự sửa khi đường dẫn EXE đổi.
      autostart.sync(dataDir).then(result => {
        if (result.error) log('Không đỒng bộ được khởi động cùng Windows: ' + result.error);
        else if (result.changed) log('Đã đỒng bộ khởi động cùng Windows theo cài đặt.');
      }).catch(() => { /* im lặng: không có autostart vẫn dùng app được */ });
      // Kiểm tra phiên chạy NỀN, NGAY khi mở app (delay 0): yêu cầu là phiên phải sẵn sàng
      // cùng lúc mở ứng dụng, không phải chờ người dùng bấm rỒi mới đăng nhập. Nó chỉ đọc
      // token/cookie (một lần giải mã hàng loạt) nên không chặn phần vẽ giao diện; bấm Tải
      // hoá đơn sớm thì endpoint tự chờ đúng lần đang chạy (ensureSessionCheck).
      ensureSessionCheck();
      // Đối soát trước khi bật lịch: nếu không, một dòng kẹt `running` sẽ khiến lịch tưởng MST đó bận.
      setTimeout(() => {
        reconcileInterruptedSync();
        if (syncWindowConfig().enabled) backgroundSync.startTimer();
        // Quét bù lịch sử: KHÓNG phụ thuộc cài đặt khung giờ – chạy nền khi máy rảnh.
        startCatchupTimer();
      }, 5000);
    }).catch(error => log('Khởi động lỗi: ' + (error && error.message ? error.message : error)));
  }
});
// Đóng cửa sổ giao diện của CHÍNH app này (Chrome/Edge --app, profile ui-browser của app).
// Cần cho "Thoát hoàn toàn": (1) yêu cầu là phải đóng các cửa sổ, và (2) cửa sổ còn mở giữ kết nối
// keep-alive ⇒ server.close() không bao giờ gọi callback ⇒ tiến trình treo, không thoát hẳn.
// Chỉ đụng tiến trình mang profile dưới du_lieu của app – KHÓNG ảnh hưởng Chrome cá nhân.
function closeUiWindows() {
  try { if (uiProcess && !uiProcess.killed) uiProcess.kill(); } catch { /* đã đóng */ }
  try {
    const profile = path.join(dataDir, 'ui-browser').replace(/'/g, "''");
    execFile('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true }, () => {});
  } catch { /* bỏ qua */ }
}

// Thoát THẬT: đóng tray, xoá file instance, dừng luỒng nền, đóng cửa sổ + trình duyệt rỒi thoát tiến trình.
// Đây vẫn là đường thoát duy nhất – /api/app/quit và SIGINT/SIGTERM đều gọi hàm này.
async function stop() {
  if (engine?.busy) engine.pause();
  // Tác vụ nền của MỌI MST (fire-and-forget) cũng phải tạm dừng đúng lượt trước khi thoát.
  for (const item of detachedTasks) { try { item.target.pause(); } catch {} }
  await Promise.allSettled(detachedTasks.map(x => x.task));
  xmlWatcher.stop();
  // Ghi secrets đang chờ trong hàng đợi bất đỒng bộ – phải xong trước khi thoát, không thì mất
  // phiên vừa đăng (xem storeSession – đường đăng nhập nền ghi không chặn event loop).
  try { secrets.flushWrites(); } catch { /* không được chặn việc thoát */ }
  stopTray();
  backgroundSync.stop();
  stopCatchupTimer();
  outputLock.release(output, { pid: process.pid, workspace: WORKSPACE });
  removeInstanceFile();
  stopSupportStream();
  aiService?.close();
  closeUiWindows();
  await browser.close();
  log('Đã thoát chương trình.');
  // Trần 3 giây: còn kết nối đang mở làm server.close() không bao giờ kết thúc thì vẫn phải thoát hẳn.
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  server.close(() => { clearTimeout(force); process.exit(0); });
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
