'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { URL } = require('node:url');
const { Engine, atomicWrite, validateParams, canReuseSearch, companyNameFromItems } = require('./core');
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
// Xuất Excel CHẠY TRONG WORKER THREAD (src/excel-worker.js): gói SheetJS nặng, dựng workbook tới
// nghìn dòng làm vòng lặp sự kiện khựng lại — đúng lúc UI đang poll. Lỗi worker tự rơi về đường
// đồng bộ trong luồng chính, vẫn xuất được file (chỉ là chậm hơn một chút).
const { buildExcelBuffer } = require('./excel-worker');
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
// MỐC "THIẾT BỊ BẮT ĐẦU HOẠT ĐỘNG": ghi một lần khi chạy app lần đầu, rồi giữ nguyên.
// Là điểm bắt đầu cho phần quét bù lịch sử (xem backfill-catchup.js) — máy đã dùng trước khi có
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
// ---- PHASE 4: AUTO SYNC (§23–§28, §66) ----------------------------------------------------
// Bộ điều phối ở src/data/auto-sync.js; phần “việc thật” (tra cứu, tải, nhập) ở dưới.
// MỖI MST MỘT BỘ ĐIỀU PHỐI RIÊNG (`autoSyncByMst`). Nhờ vậy Auto Sync của MST này KHÔNG chặn
// MST khác: mỗi dòng trong danh sách là một luồng độc lập, bấm play MST B trong lúc MST A đang chạy
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
    // Chỉ nhường khi CHÍNH lượt tải thủ công của MST này đang bận — không nhường vì MST khác.
    manualBusy: () => !!engineFor(key)?.busy,
    // Hai hướng chạy SONG SONG khi MST này đã có token lưu: lúc đó mọi request đi qua
    // tct.request bằng chính phiên của MST này (kho cookie đã tách theo MST).
    // Chưa có token thì phải qua cửa sổ Chrome (một cửa sổ dùng chung) ⇒ chạy tuần tự cho an toàn.
    // Tắt bằng HOADON_AUTOSYNC_PARALLEL=0.
    parallel: () => process.env.HOADON_AUTOSYNC_PARALLEL !== '0' && directTokens.has(key),
    log,
    runDirection: ({ direction, days }) => runAutoSyncDirection({ direction, days, mst: key }),
  });
  // KHÔNG gọi schedule(): từ 1.0.2 Auto Sync chỉ chạy khi người dùng bấm nút trên dòng MST.
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

// `mst` cho phép chạy cho MỘT MST chỉ định (dùng cho quét bù nền — vốn không phụ thuộc MST
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
    // onlyFiles: như runAutoSyncDirection — chỉ nhập đúng các file vừa tải (engine biết chính xác).
    const justDownloaded = [...new Set(((engine.job && engine.job.items) || []).flatMap(item => item.files || []))].filter(name => String(name).toLowerCase().endsWith('.xml'));
    const after = await data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir, onlyFiles: justDownloaded });
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
//
// Khi Mua vào và Bán ra chạy SONG SONG: hai lượt quét cùng mở một data.db nên phải xếp hàng
// (`withScanLock`) — SQLite chỉ cho một luồng ghi tại một thời điểm (WAL) và ghi chồng sẽ báo BUSY.
// Job tách theo hướng để hai engine không ghi chung một file tiến độ.
let scanChain = Promise.resolve();
function withScanLock(fn) {
  const next = scanChain.then(fn, fn);
  scanChain = next.then(() => {}, () => {});
  return next;
}
// Engine của các lượt Auto Sync đang chạy — để nút "Ngưng" gọi pause() được.
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
    await withScanLock(() => data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir }));
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
    // toISOString() của mốc giờ VN nên trong khoảng 00:00–07:00 lại trả về ngày HÔM TRƯỚC.
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
      // thử khi có hoá đơn lỗi thuộc loại còn thử được — hoá đơn XML hỏng thì thử lại cũng vô ích.
      // Không có bước này thì lỗi tải bị bỏ quên tới lượt sau, mà lượt sau là mai.
      const failedItems = () => ((syncEngine.job && syncEngine.job.items) || []).filter(item => item.state === 'failed');
      if (failedItems().some(item => item.retryable)) {
        log(`Auto Sync ${direction}: ${failedItems().length} hoá đơn lỗi tải — thử lại một lượt.`);
        await new Promise(resolve => setTimeout(resolve, RETRY_FAILED_PAUSE_MS));
        await syncEngine.retryFailed();
      }
      stats = (syncEngine.job && syncEngine.job.stats) || {};
    } catch (error) { stopNote(error); }
    // 3) Nhập XML vừa tải về (mục 22) — sau bước này data.db mới có dữ liệu mới.
    // Ngưng giữa chừng thì vẫn nhập những gì đã tải được, không bỏ phí công đã làm.
    // onlyFiles: chỉ nhập ĐÚNG các file engine vừa tải (item.files) thay vì quét lại toàn bộ kho —
    // file cũ đã được xử lý ở bước ① và giữa hai lần quét không ai ghi vào vùng này ngoài engine.
    // File đặt tay ngoài app vẫn được bắt ở lần quét ĐẦU lượt hoặc lượt kế tiếp.
    const justDownloaded = [...new Set(((syncEngine.job && syncEngine.job.items) || []).flatMap(item => item.files || []))].filter(name => String(name).toLowerCase().endsWith('.xml'));
    after = await withScanLock(() => data.xmlScanner.scanXmlFolder({ db, mst, identifiers: accountIdentifiers(mst), mstDir: dir, onlyFiles: justDownloaded }));
    return {
      found,
      downloaded: stats.downloaded || 0,
      skipped: (stats.skipped || 0) + (after.skipped || 0),
      imported: after.imported || 0,
      errors: after.errors || 0,
      // Lỗi TẢI (cổng thuế / mạng) SAU khi đã thử lại — khác `errors` là lỗi NHẬP XML.
      // Trước đây trường này bị bỏ sót nên lỗi tải không hiện ở log, sync.json hay kết quả bể.
      failed: stats.failed || 0,
    };
  } finally {
    if (syncEngine) autoSyncEngines.delete(syncEngine);
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
    data.importJob.start({ output, mst: selected, identifiers: accountIdentifiers(selected) }).catch(error => log('Tự nhập dữ liệu lỗi: ' + (error && error.message ? error.message : error)));
  } catch (error) {
    log('Không tự nhập được vào kho dữ liệu: ' + (error && error.message ? error.message : error));
  }
}
// (Đã bỏ đường tự khôi phục phiên bằng Chrome ẩn lúc khởi động: trước đây app mở Chrome cho TỪNG
// MST để thử lấy lại phiên từ cookie. Từ 1.0.2 chỉ đọc token đã lưu; MST không có phiên sẵn thì bỏ
// qua, để người dùng bấm vào MST đó rồi đăng nhập. Xem startupSessionCheck().)

// Lúc mở app: kiểm tra phiên của MỌI MST trong danh sách (để chấm màu đúng cho từng dòng).
//
// KHÔNG tự tra cứu, KHÔNG tự tải, KHÔNG tự Auto Sync — người dùng bấm nút trên dòng MST mới chạy.
// MST nào KHÔNG có phiên sẵn (phải đăng nhập lại / mất cookie) thì BỎ QUA ngay: chỉ đọc token đã
// lưu trên máy, KHÔNG mở Chrome ẩn để thử khôi phục — mở Chrome cho từng MST lúc khởi động rất chậm
// và dễ làm cổng thuế khó chịu. Người dùng bấm vào MST đó thì app mới mở form đăng nhập.
async function startupSessionCheck() {
  const summary = { checked: [], session: null, started: 0, skipped: 0, error: '' };
  const original = selected;
  try {
    const queue = activeAccounts().slice().sort((a, b) => (Number(b.lastUsedAt || b.lastVerifiedAt || 0) - Number(a.lastUsedAt || a.lastVerifiedAt || 0)));
    for (const item of queue) {
      const mst = item.mst;
      let restored = false;
      try { restored = restoreSession(mst); } catch { restored = false; }
      const row = { mst, ok: restored, reason: restored ? 'token đã lưu còn hiệu lực' : 'chưa có phiên — cần đăng nhập' };
      if (restored) { summary.started += 1; summary.session = summary.session || row; }
      else { summary.skipped += 1; }
      summary.checked.push(row);
      log(`Kiểm tra phiên MST ${mst}: ${row.reason}`);
    }
    log(`Kiểm tra phiên lúc khởi động: ${summary.started}/${summary.checked.length} MST có phiên sẵn.`);
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
// Kết quả TỰ GÁN theo tên gần nhất mỗi MST (afterScan chạy nền) — GET panel/UI đọc để thông báo.
const recentAutoAssign = new Map();
const xmlWatcher = dataLayer().xmlWatcher.createXmlWatcher({
  onChange: result => log(`XML MST ${result.mst}: nhập mới ${result.imported || 0}, cập nhật ${result.updated || 0}.`),
  // TỰ GÁN theo tên ngay sau mỗi lượt quét nền (không cần ai mở tab): mã lạ trùng tên hồ sơ
  // (vd CCCD 058168004258 của cùng người MST 4500487170) tự vào định danh, lượt quét hẹn sẵn
  // (pendingRescan) nhập nốt. Kết quả gán gần nhất để GET panel/UI thông báo đúng lúc.
  afterScan: (mst, result) => {
    if (!(result && (result.errors || result.pendingRescan))) return;
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
function engineFor(mst) { return mst ? engines.get(mst) || null : null; }
// Engine của ĐÚNG MST được yêu cầu. Mỗi MST một engine riêng trong `engines`, nên endpoint thủ công
// nhận `mst` để chạy đúng luồng đó — không phụ thuộc việc người dùng đang xem MST nào.
function engineOf(mst) { return mst ? engineFor(mst) : engineFor(selected); }
function setCurrentEngine(mst) { engine = engineFor(mst); return engine; }
// makeExcel giữ nguyên hợp đồng cũ (items → Buffer xlsx) nên mọi caller không đổi; chỉ đổi NƠI dựng
// workbook: worker thread thay vì luồng chính. Nhận kết quả là Buffer; worker trả Uint8Array → convert.
const makeExcel = items => Promise.resolve(buildExcelBuffer(items)).then(result => (Buffer.isBuffer(result) ? result : Buffer.from(result)));
function accountFor(mst, includeRemoved = false) { return accounts.accounts.find(x => x.mst === mst && (includeRemoved || !x.removedAt)) || null; }
function activeAccounts() { return accounts.accounts.filter(x => !x.removedAt); }
// Nhớ "MST của phiên làm việc gần nhất": mỗi lần người dùng chọn một dòng, `accounts.selected`
// được ghi ngay xuống du_lieu/accounts.json. Mở lại app là vào thẳng Tổng quan của khách hàng ấy
// và dòng đó được tô sáng sẵn trong danh sách.
// Nhưng dữ liệu lưu có thể CŨ: MST đã bị XOÁ khỏi danh sách (removedAt) hoặc không còn tồn tại
// thì KHÔNG được mở vào một hồ sơ "ma" (Tổng quan trống, sidebar không dòng nào sáng) — rơi về
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
  if (previous || selected) log(`MST đã chọn "${previous || '(chưa chọn)'}" không còn trong danh sách — mở lại MST dùng gần nhất: ${selected || '(chưa có MST nào)'}.`);
  return selected;
}
rememberSelectedMst();
function cleanIdentifiers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}
function accountIdentifiers(mst) {
  const account = accountFor(String(mst), true);
  // Gồm CẢ MST gốc để XML (cổng thuế chỉ ghi MST gốc) vẫn khớp hồ sơ có mã chi nhánh.
  return cleanIdentifiers([...mstFormat.mstAliases(mst), ...(account?.identifiers || [])]);
}
function saveIdentifiers(mst, values) {
  const account = accountFor(String(mst));
  if (!account) throw new Error('MST không còn trong danh sách.');
  const identifiers = cleanIdentifiers(values).filter(value => value !== account.mst);
  if (identifiers.some(value => !/^\d{6,20}$/.test(value))) throw new Error('CCCD/MST bổ sung chỉ gồm 6–20 chữ số.');
  for (const other of activeAccounts()) {
    if (other.mst === account.mst) continue;
    const occupied = new Set(accountIdentifiers(other.mst));
    const conflict = identifiers.find(value => occupied.has(value));
    if (conflict) throw new Error(`Mã ${conflict} đang thuộc hồ sơ MST ${other.mst}.`);
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
  } catch { /* chưa có thư mục/vùng MST thì bỏ qua — vết sẽ tự cập nhật ở lượt quét sau */ }
  xmlWatcher.schedule(account.mst);
  return publicAccount(account);
}
// Ghi cờ "hồ sơ này đã đăng nhập bằng CCCD/MST bổ sung" (bài toán MST gốc ↔ CCCD của CÙNG một
// người). jwtAccount() trả mst lấy từ token; nếu nó không thuộc aliases của hồ sơ nhưng TRÙNG
// một identifier đã khai báo ⇒ đó vẫn là người đúng, chỉ là hoá đơn do bên kia lập bằng CCCD.
// Chỉ ghi nhận, KHÔNG đổi hành vi đăng nhập: hồ sơ vẫn đăng nhập bằng MST gốc như cũ.
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
  } catch { /* vết phụ — không được làm lỗi luồng đăng nhập */ }
}
// TỰ GÁN mã CÙNG MỘT NGƯỜI theo TÊN — hệ thống tự hiểu, người dùng không phải bấm.
// Ví dụ thật: hồ sơ MST 4500487170 (HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN) có hoá đơn ghi người
// mua bằng CCCD 058168004258 cùng tên ⇒ so tên chuẩn hoá (bỏ dấu, bỏ "HỘ KINH DOANH"…) trùng
// thì gán luôn vào identifiers. Tên "của hồ sơ" lấy từ: account.name (người dùng nhập) + TẤT
// CẢ tên xuất hiện trong kho ở các dòng mà mã hồ sơ là bên liên quan (ten_mua WHERE mst_mua ∈
// định danh hồ sơ, và ten_ban tương ứng) — hoá đơn nào đã nhập được thì tên người đó là chuẩn.
// db tuỳ chọn: có rồi thì dùng (GET panel đã mở sẵn), không thì mở kết nối đọc qua readDatabase.
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
    // readDatabase là kết nối đọc DÙNG LẠI (đợt 3) — gọi thêm không tốn mở/đóng mới.
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
  } catch { /* kho chưa có/chưa mở được — vẫn còn account.name để so */ }
  const assigned = [];
  for (const candidate of pending) {
    const match = [...selfNames].find(name => data.identityCandidates.samePersonName(candidate.ten, name));
    if (!match) continue;
    // Kiểm tra mã không thuộc hồ sơ khác trước khi gán (như saveIdentifiers).
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
    log(`Tự gán ${assigned.length} mã định danh trùng tên hồ sơ MST ${mst}: ${assigned.join(', ')}.`);
    xmlWatcher.schedule(mst); // quét lại với định danh mới — các hoá đơn UNKNOWN cũ tự vào kho
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
function restoreSession(mst) {
  if (directTokens.has(mst)) return true;
  const stored = secrets.read(mst, ['token', 'cookies']);
  if (stored.cookies) tct.setCookies(stored.cookies, mst);
  const account = jwtAccount(stored.token);
  if (!account) { if (stored.token) secrets.clear(mst, ['token']); return false; }
  if (!account.mst && /^(\d{10}(?:-\d{3})?|\d{13})$/.test(account.label)) account.mst = account.label;
  // So theo MST GỐC: người dùng có thể lưu hồ sơ là "8021214462-001" còn token/XML chỉ ghi
  // "8021214462" — so nguyên văn sẽ báo sai phiên và xoá token oan.
  if (account.mst && !mstFormat.mstAliases(mst).includes(String(account.mst))) { secrets.clear(mst, ['token']); return false; }
  directTokens.set(mst, stored.token); tokenAccounts.set(mst, account); authAccount = account;
  return true;
}
function storeSession(mst, token, password, keep) {
  if (!token) { secrets.clear(mst, ['token', 'cookies']); sessionCache.set(mst, false); return; }
  // Cookie lưu theo ĐÚNG MST này — không lấy cookie của MST khác đang chạy song song.
  secrets.write(mst, { token, cookies: tct.cookies(mst), ...(password ? { password: keep ? password : '' } : {}) });
  remembered.set(mst, !!keep && !!password); sessionCache.set(mst, true);
}
function forgetSession(mst) {
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
    // đang tra cứu / đang tải x/y — người dùng nhìn danh sách là biết MST nào đang làm gì.
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
      // Đã đồng bộ / chưa đồng bộ hôm nay — UI hiện thẳng, bộ lập lịch dùng để bỏ qua.
      syncedToday: daily.synced,
      syncedAt: daily.at,
      missingToday: daily.missing,
      // Số hoá đơn LỖI TẢI của lượt gần nhất (cổng thuế / mạng) — khác `errors` là lỗi NHẬP XML.
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
    // Giá trị sống (phase/progress) KHÔNG cache: chỉ phần đọc từ sync.json mới được cache theo mtime.
    if (!running) syncCache.set(mst, { stamp, value });
    return value;
  } catch { return null; }
}
function publicAccount(account) {
  const mst = account.mst;
  return { mst, identifiers: cleanIdentifiers(account.identifiers), name: account.name || '', label: account.label || '', lastVerifiedAt: account.lastVerifiedAt || 0, lastUsedAt: account.lastUsedAt || 0, session: directTokens.has(mst) ? 'live' : (hasSavedSession(mst) ? 'saved' : 'none'), remembered: isRemembered(mst), job: jobSummary(mst), sync: syncSummary(mst), catchup: catchupFor(mst) };
}
// ẢNH CHỤP DANH SÁCH MST CHO KHUNG HÌNH ĐẦU — "tô sáng MST phiên gần nhất ngay lập tức".
// Vì sao cần ĐƯỜNG RIÊNG chứ không chỉ localStorage: server mở cổng NGẪU NHIÊN mỗi lần chạy
// (`server.listen(0, ...)`), nên origin đổi từ `http://127.0.0.1:51234` sang `…:51877` sau mỗi
// lần mở app. localStorage khoá theo ORIGIN ⇒ cache ở đó KHÔNG BAO GIỜ đọc lại được giữa hai lần
// mở app. Cache phải đến từ CHÍNH máy chủ, nơi giữ `du_lieu/accounts.json`.
// Trả một file JS nhỏ, đồng bộ, cùng origin nên hợp CSP `script-src 'self'`; nạp TRƯỚC renderer.js
// nên sidebar + dòng đang làm việc được vẽ ngay khung hình đầu, không chờ `/api/state` (1–3 giây).
// CHỈ trường để vẽ dòng (mã, tên, nhãn, trạng thái phiên, mã định danh, đã ghi nhớ mật khẩu chưa)
// — KHÔNG token, cookie, mật khẩu hay đường dẫn hồ sơ. Là ảnh chụp cho nhịp đầu, không phải nguồn
// sự thật: `/api/state` về là ghi đè (renderer.js).
const BOOT_CACHE_MAX = 60; // danh sách dài hơn thì cắt — chỉ cần đủ để khung hình đầu trông đúng
function bootCacheSnapshot() {
  const list = activeAccounts().slice(0, BOOT_CACHE_MAX);
  const msts = new Set(list.map(account => account.mst));
  return {
    // `selected` luôn phải là một dòng CÓ trong danh sách vừa gửi, nếu không sidebar sẽ không tô
    // sáng dòng nào (đúng lỗi "hồ sơ ma" mà rememberSelectedMst() đã chặn ở phía máy chủ).
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
    // renderer rơi về đường thường (/api/state) — không được vì cache mà chặn cả giao diện.
    log('Không dựng được ảnh chụp MST cho khung hình đầu: ' + ((error && error.message) || error));
    body = 'window.HD_BOOT_CACHE=null;';
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function migrateMst(from, to) {
  const move = (a, b) => { try { if (fs.existsSync(a) && !fs.existsSync(b)) fs.renameSync(a, b); } catch (error) { throw new Error(`Không đổi được MST ${from} → ${to}: ${error.message}. Đóng cửa sổ Chrome của MST này rồi thử lại.`); } };
  move(jobStore(from), jobStore(to));
  move(path.join(dataDir, 'secrets', `${from}.json`), path.join(dataDir, 'secrets', `${to}.json`));
  move(path.join(dataDir, 'profiles', from), path.join(dataDir, 'profiles', to));
  for (const cache of [sessionCache, jobCache, remembered]) { cache.delete(from); cache.delete(to); }
  invalidateSyncCache();
  // Đợt 3: kết nối đọc cache theo đường dẫn data.db — đổi MST là đường dẫn đổi ⇒ đóng kết nối cũ.
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
  if (owner) throw new Error(`Mã ${mst} đang thuộc hồ sơ MST ${owner.mst}.`);
  if (previous && !accountFor(previous)) throw new Error('MST cần sửa không còn trong danh sách.');
  if (mst !== previous && accountFor(mst)) throw new Error(`MST ${mst} đã có trong danh sách.`);
  if (previous && mst !== previous) migrateMst(previous, mst);
  const record = accountFor(mst, true) || accountFor(previous, true);
  if (record) { record.mst = mst; record.name = name; record.removedAt = ''; if (!record.label || record.label === previous) record.label = mst; }
  else accounts.accounts.push({ mst, name, label: mst, lastVerifiedAt: 0 });
  if (input.remember === false) { secrets.clear(mst, ['password']); remembered.set(mst, false); }
  else if (typeof input.password === 'string' && input.password) { secrets.write(mst, { password: input.password }); remembered.set(mst, true); }
  accounts.selected = selected; saveAccounts();
  return publicAccount(accountFor(mst));
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
    // trình duyệt), tự mở Chrome ẩn rồi dùng lại cho các hóa đơn PDF tiếp theo.
    pdf: async html => {
      if (!browser.client) await browser.open(mst, false);
      return browser.pdf(html);
    },
    excel: makeExcel,
    emit: () => invalidateSyncCache(mst)
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
// Chạy tác vụ DÀI trong nền, trả HTTP NGAY: giao diện bấm là có phản hồi (không đợi nhiều phút),
// tiến độ vẫn cập nhật đều qua vòng poll /api/state vì Engine tự emit/save suốt lượt chạy.
// server.js giữ tham chiếu promise; nếu app bị tắt giữa đường thì tạm dừng đúng tác vụ đó trước
// khi đóng (giữ nguyên nghĩa vụ dọn dẹp — KHÔNG bỏ lửng tác vụ).
function runDetached(target, jobId, label, fn) {
  const task = (async () => {
    try {
      await fn();
      log(`${label}: hoàn tất.`);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      if (!error || (!error.paused && !error.auth)) log(`LỖI (${label}): ${message}`);
    }
  })();
  detachedTasks.push({ target, jobId, label, task });
  task.finally(() => { const index = detachedTasks.indexOf(detachedTasks.find(x => x.task === task)); if (index >= 0) detachedTasks.splice(index, 1); });
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
// Tên công ty/HKD của MST — LẤY TỪ KHO dữ liệu (đọc data.db). Đây là đường CHÍNH THỨC (đã nhập XML)
// và là nguồn dự phòng khi chưa có kết quả tra cứu nào trong bộ nhớ.
// Chỉ đọc khi data.db đã tồn tại (không tạo file mới từ màn hình trạng thái) và chỉ nhớ kết quả
// không rỗng, để MST chưa nhập dữ liệu vẫn thử lại được ở lần sau.
// Đường NHANH HƠN cho lúc chưa nhập gì: companyNameFromItems() đọc thẳng kết quả tra cứu đang có
// trong bộ nhớ — xem `companyName` trong appState().
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
  // jobRevision do chính Engine tăng khi nội dung job đổi (save()) — UI so số này thay vì dựng lại
  // toàn bộ bảng. KHÔNG tự tăng mỗi nhịp poll: làm vậy là mất ý nghĩa "đã thay đổi chưa".
  const snapshot = engine ? engine.snapshot() : { state: 'idle', busy: false, items: [], total: 0, done: 0, failed: 0, message: 'Chọn hoặc thêm MST để bắt đầu.' };
  snapshot.jobId = engine?.job?.id || '';
  const { items, ...rest } = snapshot; // eslint-disable-line no-unused-vars
  return { ...rest, itemsRevision: engine ? engine.jobRevision : 0, accounts: activeAccounts().map(publicAccount), selected, output, companyName: companyNameFor(selected) || companyNameFromItems(engine && engine.job ? engine.job.items : null, selected), remembered: !!selected && isRemembered(selected), browserReady: !!browser.client, browserVisible: !!browser.visible, authenticated: !!selected && !!(authAccount || directTokens.has(selected)), authBusy: authBusy.has(selected), update: updater.status(), pool: syncPool.status() };
}
// Chỉ kiểm tra engine của ĐÚNG MST đích. Trước đây có nhánh dự phòng `|| engine`: MST đích chưa
// từng dùng thì engineFor() = null, nó rơi vào engine của MST ĐANG CHỌN ⇒ tác vụ của MST A chặn
// luôn việc thêm/đăng nhập MST B.
function ensureIdle(mst = selected) {
  const target = engineFor(mst);
  if (target && target.busy) throw new Error(`MST ${mst} đang chạy tác vụ — ngưng tác vụ của MST đó trước.`);
}
async function ensureLicenseAllowed() { return support.enforceLicense(); }
async function authOperation(fn, mst) {
  const key = mst || selected;
  if (authBusy.has(key)) throw new Error('Đang xử lý phiên đăng nhập cho MST này. Vui lòng chờ.');
  authBusy.add(key);
  try { return await fn(); } finally { authBusy.delete(key); }
}
// Chọn MST là thao tác NHẸ (đặt MST đang xem + kiểm tra còn phiên). KHÔNG bật `authBusy` như một
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
  restoreSession(mst);
  selected = mst;
  const record = accountFor(mst); if (record) record.lastUsedAt = Date.now();
  accounts.selected = mst; saveAccounts(); createEngine(mst);
  const account = await checkLogin();
  return { mst, authenticated: !!account, account, name: accountFor(mst)?.name || '' };
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
  // Ghi nhận: phiên thuộc CCCD/MST bổ sung của hồ sơ (cùng một người, khác loại mã) ⇒ đánh dấu
  // mã đó là "đã gán" trong panel mã chưa nhận diện. Chỉ ghi vết, không đổi luồng đăng nhập.
  if (identity?.mst) noteLoginIdentifier(selected);
  return record;
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
      const token = await tct.authenticate({ username: input.username.trim(), password, captcha: input.captcha.trim().toUpperCase(), ckey: challenge.key }, selected);
      const identity = jwtAccount(token);
      if (identity?.mst && !mstFormat.mstAliases(selected).includes(String(identity.mst))) throw new Error(`Tài khoản này thuộc MST ${identity.mst}, không khớp hồ sơ ${selected}.`);
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
// Auto login hoàn toàn: dùng mật khẩu đã lưu (hoặc mật khẩu gửi lên), solver JS tự giải CAPTCHA.
// Trả về cùng hình dạng với submitLogin để renderer dùng lại acceptLoginResult.
async function autoLoginAccount(input) {
  const mst = String(input.mst || selected || '');
  if (!mst) throw new Error('Chọn hoặc thêm MST trước.');
  if (mst !== selected) await selectAccount(mst);
  ensureIdle(mst);
  const savedPassword = secrets.read(mst, ['password']).password;
  const password = (typeof input.password === 'string' ? input.password : '') || savedPassword;
  if (!password) throw new Error('MST này chưa lưu mật khẩu — nhập mật khẩu một lần trong form Đăng nhập rồi bấm Tự động đăng nhập sau.');
  const username = String(input.username || '').trim() || mst;
  const keep = input.remember !== false;
  loginChallenge = null;
  const result = await loginAuto.autoLogin({ username, password, mst, maxAttempts: input.maxAttempts }, mst);
  if (!result.ok) {
    // Hết lượt thử: trả về challenge mới để form đăng nhập tay vẫn dùng được ngay.
    const next = await tct.captcha(mst).catch(() => null);
    if (next) return challengeResponse({ ...next, ready: true, authenticated: false, remembered: isRemembered(mst), error: `Tự động đăng nhập chưa thành công sau ${result.attempts} lần thử. ${result.error || ''}`.trim() });
    throw new Error(`Tự động đăng nhập chưa thành công sau ${result.attempts} lần thử. ${result.error || ''}`.trim());
  }
  const token = result.token;
  const identity = jwtAccount(token);
  if (identity?.mst && !mstFormat.mstAliases(mst).includes(String(identity.mst))) {
    forgetSession(mst);
    throw new Error(`Tài khoản này thuộc MST ${identity.mst}, không khớp hồ sơ ${mst}.`);
  }
  directTokens.set(mst, token); authAccount = identity || { mst, label: username }; tokenAccounts.set(mst, authAccount);
  storeSession(mst, token, keep ? password : '', keep);
  const account = await checkLogin();
  return { authenticated: true, account, mst, remembered: keep && !!password, attempts: result.attempts };
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
// Body upload SAO KÊ (JSON { fileName, dataBase64 }): cho phép file lớn hơn JSON thường (20 MB),
// dữ liệu vẫn nằm toàn bộ trong RAM — file sao kê Excel/CSV thực tế nhỏ hơn nhiều con số này.
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
    throw new Error(`Không kết nối được máy chủ AI (devexthub): ${error.message}. Kiểm tra mạng rồi thử lại.`);
  }
  if (!resp.ok) {
    let detail = '';
    try { const json = await resp.json(); detail = json?.detail || ''; } catch { try { detail = await resp.text(); } catch { /* bỏ qua */ } }
    if (resp.status === 429) throw new Error('AI hết lượt hôm nay (giới hạn của bên cấp). Thử lại vào ngày mai hoặc dùng file Excel/PDF chữ.');
    if (resp.status === 413) throw new Error('PDF/ảnh quá lớn cho AI (tối đa ~10 MB). Tách file nhỏ hơn rồi thử lại.');
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
// file chỉ được nạp đúng một lần mỗi phiên — trước đây mỗi request đọc lại đĩa. File tĩnh bất biến
// theo build; mtime+size giữ lại làm khoá (an toàn khi dev, gần như không bao giờ miss khi chạy EXE)
// và cũng là nguồn sinh ETag cho 304. `checkedAt` để bước kiểm tra lại mtime có TTL — xem staticEntry.
const staticCache = new Map();
// Cache bản xem A4 theo đường dẫn XML + mtime + size: XML gốc bất biến (app chỉ ghi một lần khi
// tải) mà người dùng mở lại bản xem cùng hoá đơn rất thường xuyên. Giới hạn 100 mục (FIFO).
const a4HtmlCache = new Map();
// ---- ĐỢT 3: cache kết nối SQLite ĐỌC theo data.db của từng MST ----
// Đường đọc /api/db/* trước đây MỞ LẠI database mỗi request (mở file + 7 PRAGMA + kiểm tra schema +
// đóng ≈ 5,7 ms/request đo thực tế, đang trả thuần tuý cho quản lý — không phải việc của người
// dùng) kể cả poller nền 1–3 giây/lần. Giữ kết nối mở dùng lại: request chỉ còn đúng phần truy vấn.
// Khoá = SCHEMA_VERSION + đường dẫn data.db: nâng schema là key đổi, kết nối cũ tự bị bỏ.
// Kết nối nhàn rỗi 5 phút tự đóng (bộ quét 60 giây/lần, unref — không giữ tiến trình sống).
// Đường GHI (quét XML, import, autosync engine) KHÔNG đi qua cache này: vẫn mở riêng như cũ nên
// không đụng vòng ghi; WAL cho phép đọc song song với một ghi.
const READ_CONN_IDLE_MS = 5 * 60 * 1000;
const readConnCache = new Map();
let readConnSweeper = null;
function readDatabase(dbFile) {
  const key = `${require('./data/sqlite').SCHEMA_VERSION}|${dbFile}`;
  const entry = readConnCache.get(key);
  if (entry) { entry.lastUsed = Date.now(); return entry.db; }
  // Nhánh miss (mỗi MST mỗi 5 phút chỉ 1 lần): tạo vùng MST như ensureMst (mkdir + sync.json) rồi
  // mở db MỘT lần duy nhất.
  const dir = path.dirname(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  try { for (const name of dataLayer().mst.XML_FOLDERS) fs.mkdirSync(path.join(dir, name), { recursive: true }); } catch { /* thiếu thư mục thì quét XML sau tự tạo */ }
  try {
    const syncFile = path.join(dir, 'sync.json');
    if (!fs.existsSync(syncFile)) dataLayer().mst.writeSyncState(syncFile, dataLayer().mst.defaultSyncState());
  } catch { /* thiếu sync.json không sao — readSyncState tự rơi về mặc định */ }
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
// Tài sản tĩnh đọc từ đĩa MỘT lần rồi giữ trong RAM, nhưng vẫn phải thấy file dev sửa giữa chừng.
// Bước kiểm tra lại mtime là I/O ĐỒNG BỘ trên chính event loop đang phục vụ /api/state và các job
// nền; một lần tải trang = 16 request tài sản ⇒ 16 lần statSync xếp hàng trước câu trả lời API.
// TTL 2 giây: dev sửa file rồi F5 vẫn thấy thay đổi ngay, mà đường nóng không đụng đĩa.
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
// 272 KB nguồn → 200 KB (−27%) — bớt cả byte truyền lẫn thời gian parse của trình duyệt. Trình duyệt
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
// mỗi lần (không tái dùng mù — route vẫn nằm sau allowed() nên không lộ gì), nhưng máy chủ trả 304
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
  // Ưu tiên bản rút gọn — nhưng CHỈ khi nó KHÔNG CŨ HƠN bản gốc. Dev sửa renderer.js rồi F5 thì phải
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
// Hai cổng phải CÙNG mở: trong khung giờ (mặc định 08:00–18:00 giờ VN) VÀ cửa sổ app đã đóng.
// Người dùng là ưu tiên số 1: mở lại cửa sổ hoặc thao tác là nền ngưng ngay MST đang chạy.
let lastUiSeen = 0; // mốc cuối cùng giao diện gọi /api/state
const UI_CLOSED_MS = 10000;
const syncWindowFile = path.join(dataDir, 'sync-window.json');
function syncWindowConfig() {
  const saved = loadJson(syncWindowFile, null);
  return { enabled: !(saved && saved.enabled === false), windows: (saved && saved.windows) || syncWindow.DEFAULT_WINDOWS };
}
// Cửa sổ app đã đóng: không còn /api/state trong 10 giây. UI poll 1,5 giây/lần (renderer.js) nên
// 10 giây là khoảng lùi an toàn. KHÔNG dùng lastUiPoll vì mọi lời gọi /api/* đều cập nhật nó —
// kể cả /api/ping của instance thứ hai, sẽ làm tưởng cửa sổ còn mở mãi.
function uiClosed() { return !lastUiSeen || Date.now() - lastUiSeen > UI_CLOSED_MS; }
function manualBusyNow() {
  if (authBusy.size > 0 || loginChallenge) return true;
  // Bể "Đồng bộ tất cả" do người dùng bấm ⇒ lịch nền theo khung giờ đứng ngoài, không tranh MST.
  if (syncPool.running) return true;
  for (const one of engines.values()) if (one && one.busy) return true;
  try { if (dataLayer().importJob.status().running) return true; } catch { /* chưa cần tầng dữ liệu */ }
  return false;
}
// MST nền được phép chạy: còn trong danh sách, CÓ phiên lưu (âm thầm — không mở Chrome, không hỏi
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
    if (syncPool.isActive(mst)) continue; // đang chạy trong bể "Đồng bộ tất cả" rồi
    let state = null;
    try { state = data.mst.readSyncState(path.join(data.mst.mstDirectory(output, mst), 'sync.json')); } catch { state = null; }
    // Đã đồng bộ đủ hôm nay ⇒ BỎ QUA tới hết ngày. Một ngày một lần, không lặp lại.
    if (dailySyncState(state, clock).synced) continue;
    // Chưa xong mà vừa thử cách đây chưa lâu ⇒ chờ, không dội cổng thuế (chống vòng lặp khi lỗi).
    const intervalMs = Math.max(5, Number((state && state.settings && state.settings.intervalMinutes) || 30)) * 60000;
    const stamps = [state && state.buy && state.buy.lastSync, state && state.sell && state.sell.lastSync]
      .map(value => Date.parse(value || '') || 0);
    const lastAttempt = Math.max(...stamps, 0);
    if (lastAttempt && nowMs - lastAttempt < intervalMs) continue;
    rows.push({ mst, lastSync: lastAttempt });
  }
  // Thứ tự (lâu chưa đồng bộ nhất trước) do bộ lập lịch tự sắp — xem sync-scheduler.js.
  return rows;
}
// Ngưng CHỈ engine của đúng MST đó — không đụng lượt Auto Sync người dùng tự bấm ở MST khác.
function pauseBackgroundFor(mst) {
  for (const one of autoSyncEngines) {
    if (one && one.job && one.job.account && one.job.account.mst === mst) one.pause();
  }
}
// KHOÁ THEO THƯ MỤC LƯU — nhiều bản app (bản gốc / bản copy / EXE đã cài) có thể cùng trỏ vào MỘT
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
  // Chỉ ghi log khi TRẠNG THÁI ĐỔI, không rải một dòng mỗi nhịp 20 giây.
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
// BỂ "ĐỒNG BỘ TẤT CẢ" — người dùng bấm là chạy NGAY (không phụ thuộc khung giờ / cửa sổ app).
// Mỗi MST một profile Chrome + kho cookie riêng nên chạy song song không lẫn phiên. Giữ luôn đủ
// số luồng: MST nào xong thì rút MST kế tiếp. Dùng `days` của TỪNG MST — giống nút ▶ trên dòng,
// để "tải toàn bộ" không tự ý đổi khoảng ngày người dùng đã đặt cho hồ sơ đó.
const syncPool = createSyncPool({
  concurrency: 3,
  runOne: mst => autoSyncFor(mst).run('pool'),
  pause: pauseBackgroundFor,
  shouldStop: () => false,
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
      if (touched) { data.mst.writeSyncState(file, state); log(`Đối soát: MST ${account.mst} có lượt chạy bị ngắt — đưa về trạng thái nghỉ.`); }
    }
  } catch (error) { log('Đối soát trạng thái đồng bộ lỗi: ' + (error && error.message ? error.message : error)); }
}

// ---- QUÉT BÙ LỊCH SỬ: lấp những NGÀY CÒN THIẾU trong toàn bộ thời gian thiết bị đã hoạt động ----
// NGUYÊN TẮC: người dùng là ưu tiên số 1. Chỉ chạy khi cửa sổ app đã IM ≥ 10 giây (không còn
// giao diện gọi về) VÀ lượt quét NGÀY HÔM NAY của MST đó đã xong. Mở lại cửa sổ giữa chừng là
// đoạn đang chạy dừng gọn ở hoá đơn kế tiếp và lượt sau tiếp đúng chỗ dừng (không ghi sổ).
// Mỗi lượt làm MỘT đoạn (tối đa ~1 tháng) nên nhường người dùng rất nhanh.
// NHIỀU MST chạy SONG SONG được khi máy rảnh: mỗi MST có data.db/sync.json/kho cookie riêng nên
// không lẫn phiên (giống "Đồng bộ tất cả"). Chỉ MST CHƯA có token mới phải đi một mình vì phải
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
    catchupSummaryCache.delete(catchupCacheKey(output, mst)); // sổ vừa đổi — bỏ đệm để UI thấy ngay
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
// Ngày hoá đơn cũ nhất đang có trong kho (chỉ đọc file đã tồn tại — không tạo DB rỗng).
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

// Cổng của quét bù: KHÁC bộ lập lịch theo khung giờ — không phụ thuộc giờ làm việc, chỉ phụ thuộc
// "máy có thật sự rảnh không".
function catchupGate() {
  const reason = catchupGateReason({
    output,
    uiOpen: !uiClosed(),
    manualBusy: manualBusyNow(),
    authBusy: authBusy.size > 0 || !!loginChallenge,
    // Lượt Auto Sync BẤM TAY (▶) vẫn chạy tiếp sau khi đóng cửa sổ ⇒ phải tính là "đang bận",
    // nếu không quét bù sẽ chạy chồng lên đúng MST đó.
    autoSyncRunning: anyAutoSyncRunning(),
    poolRunning: syncPool.running,
    backgroundRunning: backgroundSync.running,
    outputBusy: outputBusy(),
  });
  return { ok: !reason, reason };
}

// Số MST quét bù chạy SONG SONG. Mỗi MST có data.db/sync.json/kho cookie riêng nên chạy song song
// không lẫn phiên. Số luồng được CHỌN NGẪU NHIÊN 2–5 mỗi nhịp để tối ưu (không phải lúc nào cũng
// dồn hết vào cổng thuế); đặt HOADON_CATCHUP_PARALLEL để cố định một số.
const CATCHUP_MIN_LANES = 2;
const CATCHUP_MAX_LANES = 5;
function catchupLaneCount() {
  const forced = Number(process.env.HOADON_CATCHUP_PARALLEL);
  if (Number.isFinite(forced) && forced >= 1) return Math.floor(forced);
  return CATCHUP_MIN_LANES + Math.floor(Math.random() * (CATCHUP_MAX_LANES - CATCHUP_MIN_LANES + 1));
}
let catchupLanes = CATCHUP_MIN_LANES; // số luồng dùng ở nhịp này (hiện lên trạng thái cho UI)

// Danh sách MST tới lượt quét bù: còn phiên lưu + đã xong lượt quét HÔM NAY + sổ còn ngày thiếu.
// KHÔNG lọc MST đang chạy ở đây — nơi chọn tự bỏ qua, để không bỏ sót MST đang chạy dở.
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

// Chọn MST chạy NGAY ở nhịp này: lấp đầy số luồng còn trống, không chọn lại MST đang chạy.
// MST đã có token đi thẳng (song song được); MST CHƯA token phải qua cửa sổ Chrome DÙNG CHUNG nên
// chỉ cho chạy MỘT MÌNH — tránh hai MST tranh cùng một cửa sổ.
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
      catchupReason = 'đã nhường người dùng — lượt sau tiếp tục';
    } else if (result && result.ok) {
      catchupCooldown.delete(catchupCacheKey(output, target.mst));
      const where = result.segment ? ` ${result.segment.from} → ${result.segment.to}` : '';
      log(`Quét bù MST ${target.mst}${where}: tải ${result.totals.downloaded}, nhập ${result.totals.imported}, còn ${result.remaining} ngày thiếu.`);
      catchupReason = result.done ? 'không còn ngày thiếu' : `MST ${target.mst}: đã quét ${result.segment ? result.segment.from + ' → ' + result.segment.to : ''}, còn ${result.remaining} ngày`;
    } else {
      // Lỗi ⇒ KHÔNG ghi sổ nên ngày đó vẫn thiếu; tạm nghỉ MST này rồi làm lại ở lượt sau.
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
  catchupLanes = catchupLaneCount(); // mỗi nhịp chọn lại 2–5 luồng
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
  // KHÔNG await: nhịp sau vẫn lấp được chỗ trống. Chốt chạy-trùng nằm trong job (theo từng MST).
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
    lanes: catchupLanes,               // số luồng dùng ở nhịp này (ngẫu nhiên 2–5)
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

async function endpoint(req, res, url) {
  if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Không có quyền truy cập giao diện.' });
  lastUiPoll = Date.now(); // giao diện còn sống; dùng để tự thoát khi người dùng đóng cửa sổ
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') { lastUiSeen = Date.now(); return reply(res, 200, { ok: true, value: appState() }); }
    // Bảng 1.000 dòng tách KHỎI /api/state: trạng thái tổng hợp (vài KB) poll mỗi nhịp, bảng chỉ
    // fetch lại khi engine.jobRevision đổi — payload mỗi nhịp rảnh giảm từ hàng trăm KB còn vài KB.
    if (req.method === 'GET' && url.pathname === '/api/state/items') {
      setCurrentEngine(selected);
      // Danh sách CUỘN như bản cũ — MỘT payload, KHÔNG nút sang trang (đo thật: 1.000 dòng
      // ≈ 145 KB mỗi nhịp poll khi đang tải, nên giữ trần 1.000 cho payload gọn; engine vẫn xử lý
      // và tải đủ toàn bộ). Thứ tự MỚI NHẤT TRƯỚC để hoá đơn vừa tải xong hiện ngay đầu bảng.
      const page = engine
        ? engine.itemsPage({ offset: 0, limit: 1000, newestFirst: true })
        : { total: 0, rows: [] };
      // `revision` của ĐÚNG engine trả về: UI so với revision đã vẽ để quyết định fetch lần sau.
      return reply(res, 200, { ok: true, revision: engine ? engine.jobRevision : 0, value: page.rows, total: page.total });
    }
  // ---- PHASE 3: Kho dữ liệu hoá đơn — đọc từ SQLite, KHÔNG quét XML khi mở danh sách (mục 15, 50, 33) ----
  if (url.pathname.startsWith('/api/db/')) {
    const data = dataLayer();
    const currentMst = () => {
      if (!selected) throw new Error('Chọn một MST trước.');
      if (!output) throw new Error('Chọn thư mục lưu trước.');
      return selected;
    };
    // Đợt 3: dùng kết nối ĐỌC dùng lại (readDatabase) thay vì mở/đóng mỗi request — không đổi
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
    // CÔNG NỢ (mục 25) — PHẢI THU / PHẢI TRẢ tính từ kết quả đối chiếu ĐÃ LƯU.
    if (req.method === 'GET' && url.pathname === '/api/db/debts') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.debts(db, range) }));
    }
    // CHI TIẾT CÔNG NỢ (mục 5): bấm khách hàng / nhà cung cấp → danh sách hoá đơn của ĐỐI TÁC đó,
    // cùng công thức nhóm và cùng kỳ với2 con số trên thẻ CÔNG NỢ.
    if (req.method === 'GET' && url.pathname === '/api/db/debts/detail') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.debtsDetail(db, {
        direction: p.get('direction') || '', name: p.get('name') || '', range,
      }) }));
    }
    // DANH SÁCH CHI TIẾT HÀNG HÓA (mục 27): bấm một trong 4 cảnh báo trên thẻ Hàng hóa → danh sách
    // mặt hàng bị dính, lọc theo ĐÚNG công thức đã đếm trên thẻ (dùng chung goodsAnalysis).
    if (req.method === 'GET' && url.pathname === '/api/db/goods/detail') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true,
        value: data.queries.goodsDetail(db, { kind: p.get('kind') || '', range }) }));
    }
    // HÓA ĐƠN CHỨA một mặt hàng (bấm dòng top hàng hóa → danh sách để mở xem hoá đơn A4).
    if (req.method === 'GET' && url.pathname === '/api/db/products/invoices') {
      const p = url.searchParams;
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.productInvoices(db, {
        name: p.get('name') || '', direction: p.get('direction') || '', range,
      }) }));
    }
    // THUẾ / NGƯỠNG (mục 26) — ngưỡng lấy theo NĂM + LOẠI HÌNH KINH DOANH đã chọn,
    // KHÔNG có con số thuế nào được hard-code trong giao diện.
    if (req.method === 'GET' && url.pathname === '/api/db/tax') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, { ok: true, value: data.queries.taxOverview(db, { year: p.get('year') || '', businessType: p.get('businessType') || '' }) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/invoices') {
      const p = url.searchParams;
      return withDatabase(db => {
        const value = data.queries.listInvoices(db, {
          q: p.get('q') || '', direction: p.get('direction') || '', from: p.get('from') || '', to: p.get('to') || '',
          state: p.get('state') || '',
          limit: p.get('limit'), offset: p.get('offset'),
        });
        // Nhãn trạng thái gắn ngay tại máy chủ: giao diện, file Excel và mọi đầu ra khác dùng
        // CÙNG một nguồn (src/data/invoice-state.js) — không chép lại 6 nhãn ở phía trình duyệt.
        return reply(res, 200, {
          ok: true,
          value: { ...value, rows: value.rows.map(row => ({ ...row, stateLabel: data.invoiceState.label(row.tthai) })) },
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
    //   chuẩn hoá + KIỂM TRA SỐ LIỆU — KHÔNG ghi gì vào DB. UI hiển thị kết quả rồi user quyết định.
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
    // POST /api/db/bank/import-rows : CHỈ LƯU sau khi user đã xem preview (xác nhận rồi mới gọi).
    if (req.method === 'POST' && url.pathname === '/api/db/bank/import-rows') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const rows = Array.isArray(input.rows) ? input.rows : [];
      if (!rows.length) throw new Error('Không có dòng nào để lưu.');
      return withDatabase(db => {
        // Chuẩn hoá LẠI trên server từ chính các dòng user xác nhận — không tin dữ liệu đã chuẩn hoá sẵn.
        // Dựng grid bằng hàm dùng chung với module (một nguồn sự thật, tránh lệch giữa test và server).
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
    // bằng pdfjs) — server chỉ chuẩn hoá + kiểm tra, KHÔNG đọc file, KHÔNG ghi DB.
    if (req.method === 'POST' && url.pathname === '/api/db/bank/preview-rows') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      if (!Array.isArray(input.rows) || !input.rows.length) throw new Error('Không nhận được bảng chữ từ PDF.');
      return reply(res, 200, {
        ok: true,
        value: { kind: 'pdf-text', fileName: String(input.fileName || 'sao-ke.pdf'), fileHash: '', ...data.bankStatement.previewRows(input.rows) },
      });
    }
    // POST /api/db/bank/import : đường CŨ (Excel/CSV nhập thẳng) — giữ nguyên cho tương thích.
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
      const range = { from: p.get('from') || '', to: p.get('to') || '' };
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
          limit: p.get('limit'), offset: p.get('offset'),
        }),
      }));
    }
    if (req.method === 'GET' && url.pathname === '/api/db/bank/daily') {
      const p = url.searchParams;
      return withDatabase(db => reply(res, 200, { ok: true, value: { rows: data.bankStatement.dailyTotals(db, { from: p.get('from') || '', to: p.get('to') || '' }) } }));
    }
    if (req.method === 'POST' && url.pathname === '/api/db/reconciliation/run') {
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
    // cho hoá đơn nhập trước khi hệ thống có cột này. KHÔNG sửa XML, KHÔNG sửa số tiền.
    if (req.method === 'POST' && url.pathname === '/api/db/invoices/reprocess-payment') {
      return withDatabase(async (db, dir) => reply(res, 200,
        { ok: true, value: await data.xmlScanner.reprocessPaymentMethods({ db, mstDir: dir }) }));
    }
    // MỤC 3 — PHÂN LOẠI THỦ CÔNG: người dùng bấm, máy chỉ GHI lại đúng giá trị đó (không tự đoán).
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
      const input = await readBody(req);
      return withDatabase(db => reply(res, 200, { ok: true, value: data.bankStatement.deleteFile(db, input.fileId) }));
    }
    // ---- Mã định danh CHƯA GÁN (MST gốc ↔ CCCD của cùng một người) ----
    // GET: danh sách cho panel tab Kho dữ liệu; POST: gán (thêm vào identifiers + quét lại),
    // bỏ qua, hoặc nhận lại. POST cờ assignImport=true mở lượt nhập lại chạy nền (importJob).
    if (req.method === 'GET' && url.pathname === '/api/db/identity-candidates') {
      return withDatabase((db, dir, mst) => {
        // Hệ thống TỰ HIỂU "cùng một người": mã lạ trùng TÊN hồ sơ (so tên chuẩn hoá) thì gán
        // luôn trước khi trả panel — CCCD 058168004258 của HKD Phùng Thị Kỳ Duyên tự vào định
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
      if (!/^\d{6,20}$/.test(code)) throw new Error('Mã phải gồm 6–20 chữ số.');
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
        if (occupied.has(code)) throw new Error(`Mã ${code} đã thuộc một hồ sơ khác.`);
        account.identifiers = cleanIdentifiers([...(account.identifiers || []), code]);
        saveAccounts();
      } else if (decision === '') {
        // "Nhận lại": gỡ khỏi định danh hồ sơ (nếu có) — undo thực sự cho cả gán tay lẫn tự gán.
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
        } catch { /* đang chạy lượt khác — watcher sẽ quét lại sau */ }
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
          // Bể "Đồng bộ tất cả" (chỉ đọc).
          pool: syncPool.status(),
          // Quét bù lịch sử chạy nền khi máy rảnh (chỉ đọc).
          catchup: catchupStatus(),
        },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/settings') {
      const input = await readBody(req);
      // Cấu hình lưu trong sync.json của MST — ghi cho đúng MST đang chọn.
      const settings = autoSync().configure({ enabled: input.enabled, days: input.days, intervalMinutes: input.intervalMinutes });
      return reply(res, 200, { ok: true, value: settings });
    }
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run') {
      await ensureLicenseAllowed();
      // Chạy Auto Sync cho ĐÚNG MST được bấm. Mỗi MST là một luồng riêng nên MST khác đang chạy
      // KHÔNG chặn — chỉ chặn khi chính MST này đã đang chạy.
      const input = await readBody(req);
      const mst = String(input.mst || selected || '').trim();
      if (!safeMst(mst) || !accountFor(mst)) throw new Error('MST chưa có trong danh sách.');
      if (!output) throw new Error('Chọn thư mục lưu trước khi chạy Auto Sync.');
      const instance = autoSyncFor(mst);
      if (instance && instance.running) throw new Error(`MST ${mst} đang chạy Auto Sync. Bấm Ngưng trước nếu muốn dừng.`);
      runAutoSyncFor(mst, 'manual').catch(error => log(`Auto Sync MST ${mst} lỗi: ${error && error.message ? error.message : error}`));
      return reply(res, 200, { ok: true, value: { ...(instance ? instance.status() : {}), mst } });
    }
    // "ĐỒNG BỘ TẤT CẢ": chạy SONG SONG nhiều MST — mỗi MST một profile Chrome và một kho cookie
    // riêng nên không lẫn phiên. Bể giữ LUÔN đủ số luồng: MST nào xong thì rút MST kế tiếp.
    if (req.method === 'POST' && url.pathname === '/api/db/autosync/run-all') {
      await ensureLicenseAllowed();
      if (!output) throw new Error('Chọn thư mục lưu trước khi đồng bộ tất cả.');
      const entries = [];
      const skipped = [];
      for (const account of activeAccounts()) {
        const mst = account.mst;
        // Không có phiên lưu thì không chạy ÂM THẦM được (phải mở Chrome + nhập CAPTCHA thủ công),
        // nên bỏ qua và nói rõ lý do thay vì mở một loạt cửa sổ đăng nhập.
        if (!hasSavedSession(mst)) { skipped.push({ mst, reason: 'chưa có phiên — cần đăng nhập' }); continue; }
        const instance = autoSyncFor(mst);
        if (instance && instance.running) { skipped.push({ mst, reason: 'đang chạy' }); continue; }
        entries.push({ mst });
      }
      const result = syncPool.start(entries);
      if (!result.started) return reply(res, 200, { ok: true, value: { ...syncPool.status(), skipped, message: result.reason } });
      log(`Đồng bộ tất cả: ${result.queued} MST · ${result.concurrency} luồng song song${skipped.length ? ` · bỏ qua ${skipped.length} MST` : ''}.`);
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
      // Chỉ pause engine thuộc ĐÚNG MST này — không đụng MST khác đang chạy.
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
    // Xuất Excel "Kho dữ liệu": MỘT workbook nhiều sheet (HĐ mua vào/bán ra, hàng hóa, đối tác),
    // tôn trọng ĐÚNG bộ lọc đang xem (q + khoảng ngày). Trả về file .xlsx để tải xuống.
    if (req.method === 'GET' && url.pathname === '/api/db/export') {
      const p = url.searchParams;
      return withDatabase((db, dir, mst) => {
        // parts: danh sách bảng muốn xuất (vd "sell" = chỉ hoá đơn bán ra). Trống ⇒ xuất TẤT CẢ.
        const parts = String(p.get('parts') || '').split(',').map(part => part.trim()).filter(Boolean);
        const { buffer, counts } = data.excelExport.buildWorkbook(db, { q: p.get('q') || '', from: p.get('from') || '', to: p.get('to') || '', state: p.get('state') || '' }, parts);
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
    if (req.method === 'POST' && url.pathname === '/api/account/login') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => addOrLogin(input.mst), input.mst) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/submit') { const input = await readBody(req); return reply(res, 200, { ok: true, value: await authOperation(() => submitLogin(input), input.mst || selected) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/captcha') return reply(res, 200, { ok: true, value: await authOperation(async () => { if (!selected) throw new Error('Chọn MST trước.'); const value = await browser.loginAction({ mode: 'refresh' }); if (value.authenticated) return { ...value, account: await checkLogin() }; return challengeResponse(value); }, selected) });
    // Auto login hoàn toàn: solver JS (ddddocr) tự giải CAPTCHA rồi authenticate — không cần gõ tay.
    // Không dùng authOperation toàn cục: auto-login chạy per-MST, không chặn MST khác.
    if (req.method === 'POST' && url.pathname === '/api/account/auto-login') { const input = await readBody(req); const mst = String(input.mst || selected || ''); if (authBusy.has(mst)) throw new Error('Đang tự động đăng nhập cho MST này. Vui lòng chờ.'); authBusy.add(mst); try { return reply(res, 200, { ok: true, value: await autoLoginAccount(input) }); } finally { authBusy.delete(mst); } }
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
    if (req.method === 'POST' && url.pathname === '/api/account/save') { const input = await readBody(req); const mst = String(input.mst || input.previous || '').trim(); return reply(res, 200, { ok: true, value: await authOperation(() => saveAccount(input), mst) }); }
    if (req.method === 'POST' && url.pathname === '/api/account/identifiers') {
      const input = await readBody(req);
      return reply(res, 200, { ok: true, value: saveIdentifiers(input.mst, input.identifiers) });
    }
    if (req.method === 'POST' && url.pathname === '/api/account/remove') {
      const mst = (await readBody(req)).mst;
      if (authBusy.has(mst)) throw new Error('Đang xử lý đăng nhập cho MST này.');
      const account = accountFor(mst, true);
      if (account) account.removedAt = new Date().toISOString();
      // Xoá đúng MST đang làm việc: đừng để app "nhớ" một hồ sơ đã xoá — chuyển sang MST dùng
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
      if (folder) { output = await ensureFolder(folder); accounts.output = output; saveAccounts(); configureXmlWatcher(); }
      return reply(res, 200, { ok: true, value: output });
    }
    if (req.method === 'POST' && url.pathname === '/api/search') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      // Chạy đúng luồng của MST được yêu cầu ⇒ MST A đang tra cứu vẫn bấm sang MST B làm việc được.
      const target = engineOf(String(input.mst || '').trim());
      if (!target) throw new Error('Chọn MST và kiểm tra phiên trước.');
      // Đang chạy tác vụ thì nút Tra cứu đóng vai nút Tạm dừng (tránh trường hợp giao diện chưa kịp
      // cập nhật trạng thái mà người dùng bấm lần nữa).
      if (target.busy) { target.pause(); return reply(res, 200, { ok: true, value: target.snapshot() }); }
      const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder); // báo lỗi rõ nếu là ổ gốc / ổ chỉ đọc / không có quyền ghi
      output = folder; accounts.output = output; saveAccounts();
      // Trả lời NGAY, tác vụ chạy nền: progress/paused theo dõi qua /api/state (poll 0,8s khi bận).
      runDetached(target, target.job?.id || '', `Tra cứu MST ${target.mst}`, async () => {
        await target.search(input, output);
        await closeBrowserWhenIdle('tra cứu xong');
      });
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/api/stream') {
      await ensureLicenseAllowed();
      const input = await readBody(req);
      const target = engineOf(String(input.mst || '').trim());
      if (!target) throw new Error('Chọn MST và kiểm tra phiên trước.');
      if (target.busy) { target.pause(); return reply(res, 200, { ok: true, value: target.snapshot() }); }
      const folder = String(input.output ?? output ?? '').trim();
      await ensureFolder(folder);
      output = folder; accounts.output = output; saveAccounts();
      const requested = validateParams(input);
      const currentJob = target.job;
      // Luật tái sử dụng nằm ở core để test được (canReuseSearch + tests/core.test.js).
      const reuse = canReuseSearch(currentJob, requested);
      // Trả lời NGAY, tải chạy nền (đây là request từng giữ mở nhiều phút — nguồn trễ khi bấm).
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
    if (req.method === 'POST' && url.pathname === '/api/download') {
      await ensureLicenseAllowed();
      const target = engineOf(String((await readBody(req)).mst || '').trim());
      if (!target) throw new Error('Chưa chọn MST.');
      await applyOutput();
      runDetached(target, target.job?.id || '', `Tải hóa đơn MST ${target.mst}`, async () => {
        await target.resume(true);
        await closeBrowserWhenIdle('tải xong');
        autoImportAfterDownload('tải xong');
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
      if (!target) throw new Error('Không tìm thấy luồng của MST yêu cầu.');
      // jobId chỉ là chống ngưng nhầm LƯỢT CŨ: engine đã chuyển sang lượt khác thì báo lại, KHÔNG
      // coi là lỗi cứng — người dùng bấm Ngưng phải luôn có tác động (đúng tinh thần nút dừng).
      if (input.jobId && input.jobId !== target.job?.id) throw new Error('Lượt tải đã thay đổi. Hãy cập nhật trạng thái.');
      target.pause();
      return reply(res, 200, { ok: true, value: target.snapshot() });
    }
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
    // Xem trước hoá đơn A4 từ tab Tra cứu: nhận ĐƯỜNG DẪN file XML (chỉ chấp nhận file nằm
    // trong thư mục lưu đã chọn — cùng luật với /api/open-file), dựng HTML chuẩn A4 bằng đúng
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
      // KHÔNG có file cục bộ: hoá đơn mới chỉ TRA CỨU, chưa tải về. Hỏi thẳng API chi tiết của cổng.
      // Đây là request THÊM lên cổng thuế — đi qua đúng pace.wait() như mọi request khác của ứng
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
      if (!engine || !engine.job) throw new Error('Chưa có lượt tra cứu nào. Hãy tra cứu trước rồi bấm xem trước.');
      const query = new URLSearchParams({ nbmst: inv.nbmst, khhdon: inv.khhdon, shdon: inv.shdon, khmshdon: inv.khmshdon }).toString();
      const bytes = await engine.request(`/${family}/invoices/detail?${query}`, 'Xem chi tiết', () => {});
      const detail = JSON.parse(bytes.toString('utf8'));
      const html = require('./data/invoice-a4').withStatusNote(require('./core').invoiceHtml(inv, detail), inv.tthai);
      return send(html);
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

// Icon khay tự phục hồi THEO SỰ KIỆN — KHÔNG hỏi vòng định kỳ.
// Chỉ hẹn dựng lại khi helper ĐÃ chết; lúc mọi thứ bình thường thì không có timer nào chạy.
// Bản trước quét mỗi 20 giây một lần bằng setInterval — vừa thừa vừa chậm tới 20 giây.
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
        log(`Icon khay dừng sớm (mã ${child.exitCode}, sống ${lived}ms) — sẽ dựng lại. Chi tiết: ${path.join(dataDir, 'tray.log')}`);
      } else {
        trayFailCount = 0;
        trayNextTry = Date.now() + 5000;
        log('Icon khay đã dừng — dựng lại sau 5 giây.');
      }
      scheduleTrayRetry();
    });
    // Chỉ báo thành công SAU KHI kiểm chứng helper còn sống. Trước đây log ghi ngay sau spawn nên
    // báo "đã hiện icon khay" trong khi helper đã thoát vì lỗi — log không đúng sự thật.
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
  if (url.pathname === '/') return staticFile(req, res, 'index.html', 'text/html; charset=utf-8');
  // Favicon: Chrome lấy làm icon cửa sổ --app (taskbar / Alt-Tab / icon ghim).
  if (url.pathname === '/icon.png') return staticFile(req, res, 'icon.png', 'image/png');
  // Logo sidebar. Trước đây nhúng base64 1024×1024 thẳng vào index.html (2 MB cho một chỗ hiển thị
  // 44px); nay là file 88×88 (~10 KB) do tools/make-icon.cjs sinh ra cùng lúc với icon. Không có
  // file này thì đúng một ảnh trong sidebar hỏng — phần còn lại của giao diện vẫn chạy.
  if (url.pathname === '/brand-logo.png') return staticFile(req, res, 'brand-logo.png', 'image/png');
  if (url.pathname === '/style.css') return staticFile(req, res, 'style.css', 'text/css; charset=utf-8');
  if (url.pathname === '/login.css') return staticFile(req, res, 'login.css', 'text/css; charset=utf-8');
  if (url.pathname === '/renderer.js') return staticFile(req, res, 'renderer.js', 'text/javascript; charset=utf-8');
  if (url.pathname === '/chat-widget.js') return staticFile(req, res, 'chat-widget.js', 'text/javascript; charset=utf-8');
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
  // pdfjs (module + worker) cho "Sao kê ngân hàng" đọc PDF có chữ ngay trong máy.
  if (url.pathname === '/vendor/pdfjs/pdf.min.mjs') return staticFile(req, res, 'vendor/pdfjs/pdf.min.mjs', 'text/javascript; charset=utf-8');
  if (url.pathname === '/vendor/pdfjs/pdf.worker.min.mjs') return staticFile(req, res, 'vendor/pdfjs/pdf.worker.min.mjs', 'text/javascript; charset=utf-8');
  if (url.pathname === '/data-view.css') return staticFile(req, res, 'data-view.css', 'text/css; charset=utf-8');
  // Ảnh chụp danh sách MST cho khung hình ĐẦU TIÊN — xem bootCacheScript().
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
  // Kiểm CHÍNH BẢN ĐÓNG GÓI: bộ giải CAPTCHA có chạy được trong EXE không?
  // Vì sao cần cờ này: `pkg` KHÔNG tự nhúng thư viện native của gói phụ thuộc. Đã xảy ra thật —
  // thiếu sharp/libvips nên EXE không rasterize được SVG CAPTCHA ⇒ đăng nhập hỏng, trong khi
  // `node src/server.js` (có node_modules) vẫn tốt. Ảnh mẫu tại chỗ: KHÔNG gọi mạng, KHÔNG dùng
  // tài khoản nào — nên chạy được cả trên CI lẫn trên máy người dùng.
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
      server.close(() => process.exit(ok ? 0 : 1));
    } catch (error) {
      console.error(JSON.stringify({ packed, ocr: false, thrown: String((error && error.message) || error).slice(0, 300), libs }, null, 1));
      server.close(() => process.exit(1));
    }
  }
  else if (process.argv.includes('--smoke-test')) {
    try {
      const [page, state] = await Promise.all([localGet(port, '/'), localGet(port, '/api/state')]);
      if (page.status !== 200 || !page.body.includes('CN Tax Tools') || state.status !== 200 || JSON.parse(state.body).ok !== true) throw new Error('Giao diện hoặc API localhost không phản hồi đúng.');
      // ĐỦ TÍNH NĂNG, KHÔNG CHỈ "MỞ ĐƯỢC": pkg khi thiếu asset chỉ CẢNH BÁO rồi vẫn xuất EXE, nên bản
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
      console.log(JSON.stringify({ ok: true, packed, port, browser: browserPath() || null, ui: true, api: true, assets: assets.length })); server.close(() => process.exit(0));
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
    // Kiểm chứng trong EXE: chạy đúng phần “kiểm tra phiên lúc khởi động” rồi thoát.
    startupSessionCheck()
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
      // Sau khi cửa sổ đã mở: CHỈ kiểm tra phiên của MST dùng gần nhất. KHÔNG tự tra cứu/tải.
      setTimeout(() => { startupSessionCheck(); }, 3000);
      // Đối soát trước khi bật lịch: nếu không, một dòng kẹt `running` sẽ khiến lịch tưởng MST đó bận.
      setTimeout(() => {
        reconcileInterruptedSync();
        if (syncWindowConfig().enabled) backgroundSync.startTimer();
        // Quét bù lịch sử: KHÔNG phụ thuộc cài đặt khung giờ — chạy nền khi máy rảnh.
        startCatchupTimer();
      }, 5000);
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
  // Tác vụ nền của MỌI MST (fire-and-forget) cũng phải tạm dừng đúng lượt trước khi thoát.
  for (const item of detachedTasks) { try { item.target.pause(); } catch {} }
  await Promise.allSettled(detachedTasks.map(x => x.task));
  xmlWatcher.stop();
  stopTray();
  backgroundSync.stop();
  stopCatchupTimer();
  outputLock.release(output, { pid: process.pid, workspace: WORKSPACE });
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
