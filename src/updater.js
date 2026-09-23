'use strict';
// ---------------------------------------------------------------------------
// SELF-UPDATE (cập nhật tại chỗ) cho HoaDonNhe.
//
// CÀI LẦN ĐẦU : Setup EXE -> HoaDonNhe.exe  (Setup cũng dùng để repair/uninstall)
// CÁC LẦN SAU : app tự tải `HoaDonNhe-v<version>.exe` -> xác minh SHA-256 -> chạy helper
//               để thay chính file đang chạy -> mở lại bản mới. KHÔNG chạy Setup lại.
//
// Vì sao an toàn:
//   * App đang chạy KHÔNG tự ghi đè chính nó: nó khởi động BẢN MỚI (đã tải + đã xác minh)
//     với cờ `--apply-update`, rồi thoát. Bản mới đóng vai trò updater.
//   * Updater chỉ đổi ĐÚNG file chương trình: backup -> thay -> kiểm tra -> mở lại; lỗi ở
//     bước nào cũng khôi phục bản cũ. Không đụng tới `du_lieu` hay bất kỳ dữ liệu người dùng.
//   * Chỉ tải asset thuộc `Datkep92/HoaDonNhe`, HTTPS, đúng tên quy ước, và SHA-256 phải khớp.
//   * Chỉ nâng cấp (latest > current), không bao giờ hạ cấp.
//   * Không truyền dữ liệu từ Internet vào shell: chỉ spawn với mảng tham số.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = 'Datkep92/HoaDonNhe';
const RELEASE_HOST = 'github.com';
const ALLOWED_REDIRECT_HOSTS = new Set([RELEASE_HOST, 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const USER_AGENT = 'HoaDonNhe-Updater';
const UPDATE_DIR_NAME = 'HoaDonNhe-update';
const NEW_BINARY_NAME = 'HoaDonNhe-new.exe';
const BACKUP_SUFFIX = '.old';

// Tên asset cho self-update (binary) và cho cài mới (Setup).
const appNameFor = version => `HoaDonNhe-v${version}.exe`;
const appShaNameFor = version => `HoaDonNhe-v${version}.exe.sha256`;
const setupNameFor = version => `HoaDonNhe-Setup-v${version}.exe`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Chỉ nhận URL tải thuộc repo này, HTTPS, đúng tên file mong đợi.
function trustedAssetUrl(rawUrl, expectedName) {
  let url;
  try { url = new URL(String(rawUrl || '')); } catch { return ''; }
  if (url.protocol !== 'https:') return '';
  if (url.hostname !== RELEASE_HOST) return '';
  if (!url.pathname.startsWith(`/${REPO}/releases/download/`)) return '';
  if (path.posix.basename(url.pathname) !== expectedName) return '';
  return url.toString();
}

// Từ JSON release -> kế hoạch self-update (payload là BINARY, không phải Setup). Thuần, không I/O.
function planUpdate(release, currentVersion) {
  const tag = String((release && release.tag_name) || '').trim().replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(tag)) return { ok: false, error: 'Bản phát hành không có tag hợp lệ.' };
  if (release.draft || release.prerelease) return { ok: false, error: 'Bản phát hành không hợp lệ (draft/prerelease).', latest: tag };
  if (compareVersions(tag, currentVersion) <= 0) return { ok: false, error: 'Không có bản mới.', latest: tag };

  const binaryName = appNameFor(tag);
  const shaName = appShaNameFor(tag);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const binary = assets.find(item => item && item.name === binaryName);
  const sha = assets.find(item => item && item.name === shaName);
  if (!binary) return { ok: false, error: `Bản phát hành thiếu ${binaryName}.`, latest: tag };
  if (!sha) return { ok: false, error: `Bản phát hành thiếu ${shaName} nên không thể xác minh.`, latest: tag };

  const binaryUrl = trustedAssetUrl(binary.browser_download_url, binaryName);
  const shaUrl = trustedAssetUrl(sha.browser_download_url, shaName);
  if (!binaryUrl) return { ok: false, error: 'URL tải không hợp lệ (phải là HTTPS thuộc Datkep92/HoaDonNhe).', latest: tag };
  if (!shaUrl) return { ok: false, error: 'URL SHA-256 không hợp lệ (phải là HTTPS thuộc Datkep92/HoaDonNhe).', latest: tag };

  return {
    ok: true,
    latest: tag,
    version: tag,
    binary: { name: binaryName, url: binaryUrl, size: Number(binary.size) || 0 },
    sha: { name: shaName, url: shaUrl, size: Number(sha.size) || 0 },
  };
}

function parseSha256(text, expectedName) {
  const line = String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)[0] || '';
  const match = line.match(/^([0-9a-f]{64})(?:\s+\*?(.+))?$/i);
  if (!match) return null;
  const name = match[2] ? path.basename(match[2].trim()) : '';
  if (name && expectedName && name !== expectedName) return null;
  return match[1].toLowerCase();
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function updateTempDir(tempDir) { return path.join(tempDir || os.tmpdir(), UPDATE_DIR_NAME); }

// Dọn thư mục tạm của lần cập nhật trước (gọi lúc khởi động). Bỏ qua lỗi: file đang bị khoá
// (helper còn chạy) sẽ được dọn ở lần mở sau.
function cleanupUpdateTemp(tempDir) {
  const dir = updateTempDir(tempDir);
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

// Thư mục chứa app có cho ghi không? Ghi thử một file tạm rồi xoá — chính xác hơn chỉ xem quyền.
function canWriteDir(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function detectMode(execPath) { return { mode: 'in-place', dir: path.dirname(String(execPath || '')) }; }

// Tải theo luồng xuống file (không nạp cả file vào RAM). Lỗi -> xoá file dở dang.
function download(url, dest, options = {}) {
  const { onProgress, signal, allowHttp = false, maxRedirects = 5 } = options;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = 0;
    let total = 0;
    const file = fs.createWriteStream(dest);
    const fail = error => {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch { /* bỏ */ }
      try { fs.unlinkSync(dest); } catch { /* bỏ */ }
      reject(error);
    };
    const finish = () => { if (!settled) { settled = true; file.close(() => resolve({ path: dest, received, total })); } };
    const request = (target, depth) => {
      if (depth > maxRedirects) return fail(new Error('Quá nhiều lần chuyển hướng.'));
      const allowed = target.protocol === 'https:' || (allowHttp && target.protocol === 'http:');
      if (!allowed) return fail(new Error(`Giao thức không được phép: ${target.protocol}`));
      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.get(target, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, target); } catch { return fail(new Error('Chuyển hướng không hợp lệ.')); }
          if (!ALLOWED_REDIRECT_HOSTS.has(next.hostname) && !allowHttp) return fail(new Error(`Chuyển hướng tới host lạ: ${next.hostname}`));
          return request(next, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return fail(new Error(`Máy chủ trả HTTP ${res.statusCode}.`)); }
        total = Number(res.headers['content-length']) || 0;
        res.on('data', chunk => { received += chunk.length; if (onProgress) onProgress(received, total); });
        res.on('error', fail);
        res.pipe(file);
        file.on('finish', finish);
        file.on('error', fail);
        return undefined;
      });
      req.on('error', fail);
      if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Đã huỷ tải.')), { once: true });
    };
    request(new URL(url), 0);
  });
}

function fetchText(url, options = {}) {
  const { allowHttp = false, maxRedirects = 5 } = options;
  return new Promise((resolve, reject) => {
    const request = (target, depth) => {
      if (depth > maxRedirects) return reject(new Error('Quá nhiều lần chuyển hướng.'));
      const allowed = target.protocol === 'https:' || (allowHttp && target.protocol === 'http:');
      if (!allowed) return reject(new Error(`Giao thức không được phép: ${target.protocol}`));
      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.get(target, { headers: { 'User-Agent': USER_AGENT } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, target); } catch { return reject(new Error('Chuyển hướng không hợp lệ.')); }
          if (!ALLOWED_REDIRECT_HOSTS.has(next.hostname) && !allowHttp) return reject(new Error(`Chuyển hướng tới host lạ: ${next.hostname}`));
          return request(next, depth + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Máy chủ trả HTTP ${res.statusCode}.`)); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(new Error('Nội dung quá lớn.')); });
        res.on('end', () => resolve(body));
        return undefined;
      });
      req.on('error', reject);
    };
    request(new URL(url), 0);
  });
}

// Chạy một file và chỉ xác nhận khi process THỰC SỰ khởi động. Không dùng shell.
function launchDetached(file, args = [], timeoutMs = 8000) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { detached: true, stdio: 'ignore' }); }
    catch (error) { return resolve({ ok: false, error: error.message || String(error) }); }
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    child.on('error', error => done({ ok: false, error: error.message || String(error) }));
    child.on('spawn', () => { try { child.unref(); } catch { /* bỏ */ } done({ ok: true, pid: child.pid }); });
    setTimeout(() => done({ ok: false, error: 'Không khởi động được tiến trình.' }), timeoutMs);
  });
}

function processAlive(pid) {
  const value = Number(pid);
  if (!value) return false;
  try { process.kill(value, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}

async function waitForExit(pid, timeoutMs = 60000, intervalMs = 250) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!processAlive(pid)) return true;
    await sleep(intervalMs);
  }
  return !processAlive(pid);
}

function renameWithRetry(from, to, attempts = 20, intervalMs = 250) {
  return new Promise(resolve => {
    const attempt = left => {
      try { fs.renameSync(from, to); return resolve({ ok: true }); }
      catch (error) {
        if (left <= 1) return resolve({ ok: false, error: error.message || String(error) });
        setTimeout(() => attempt(left - 1), intervalMs);
        return undefined;
      }
    };
    attempt(attempts);
  });
}

// Parse tham số của helper (do chính app truyền vào, không phải dữ liệu Internet).
function parseApplyArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const valueOf = name => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && index + 1 < args.length ? String(args[index + 1]) : '';
  };
  return {
    target: valueOf('target'),
    next: valueOf('next'),
    pid: Number(valueOf('pid')) || 0,
    noLaunch: args.includes('--no-launch'),
  };
}

// ---------------------------------------------------------------------------
// Helper: chạy từ BINARY MỚI để thay binary cũ rồi mở lại.
// Trả { ok, error, restored } — không bao giờ ném ra ngoài để app gọi được an toàn.
// ---------------------------------------------------------------------------
async function applySelfUpdate(argv, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const args = parseApplyArgs(argv);
  const launchFn = options.launch || launchDetached;
  const copyFn = typeof options.copyFile === 'function' ? options.copyFile : (from, to) => fs.copyFileSync(from, to);
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 60000;

  if (!args.target || !args.next) return { ok: false, error: 'Thiếu tham số cập nhật.' };
  if (!fs.existsSync(args.next)) return { ok: false, error: 'Không tìm thấy file cập nhật đã tải.' };
  if (!fs.existsSync(args.target)) return { ok: false, error: 'Không tìm thấy chương trình đang chạy.' };

  const backup = `${args.target}${BACKUP_SUFFIX}`;
  log(`Bắt đầu cập nhật: ${path.basename(args.target)} -> bản mới`);

  // 1) Chờ app cũ thoát hoàn toàn (tránh ghi đè file đang chạy).
  if (args.pid) {
    const exited = await waitForExit(args.pid, waitMs);
    if (!exited) return { ok: false, error: 'Ứng dụng cũ chưa thoát nên chưa thể cập nhật.' };
  }

  // 2) Backup binary hiện tại (dọn backup cũ nếu còn sót).
  try { if (fs.existsSync(backup)) fs.unlinkSync(backup); } catch { /* bỏ */ }
  const renamed = await renameWithRetry(args.target, backup);
  if (!renamed.ok) return { ok: false, error: `Không thay được file chương trình: ${renamed.error}` };

  // 3) Đưa binary mới vào đúng vị trí.
  try {
    copyFn(args.next, args.target);
  } catch (error) {
    const restored = await renameWithRetry(backup, args.target);
    return { ok: false, error: `Không ghi được bản mới: ${error.message}`, restored: restored.ok };
  }

  // 4) Kiểm tra bản thay thế đúng là binary mới (so hash với chính file đã tải).
  try {
    const [expected, actual] = await Promise.all([sha256File(args.next), sha256File(args.target)]);
    if (expected !== actual) {
      const restored = await renameWithRetry(backup, args.target);
      return { ok: false, error: 'Bản cập nhật không khớp sau khi thay file.', restored: restored.ok };
    }
  } catch (error) {
    const restored = await renameWithRetry(backup, args.target);
    return { ok: false, error: `Không kiểm tra được bản cập nhật: ${error.message}`, restored: restored.ok };
  }

  // 5) Mở lại ứng dụng. Không mở được -> khôi phục bản cũ để người dùng vẫn dùng được.
  if (args.noLaunch) {
    try { fs.unlinkSync(backup); } catch { /* bỏ */ }
    log('Đã thay binary (không mở lại theo yêu cầu).');
    return { ok: true, launched: false };
  }
  const started = await launchFn(args.target, []);
  if (!started.ok) {
    const restored = await renameWithRetry(backup, args.target);
    const retry = restored.ok ? await launchFn(args.target, []) : { ok: false };
    log(`Mở bản mới thất bại (${started.error}). Đã khôi phục bản cũ: ${restored.ok ? 'có' : 'không'}.`);
    return { ok: false, error: `Không mở được bản mới: ${started.error}`, restored: restored.ok, relaunchedOld: !!retry.ok };
  }

  // 6) Thành công: dọn backup.
  try { fs.unlinkSync(backup); } catch { /* bỏ */ }
  log('Cập nhật xong, đã mở lại ứng dụng.');
  return { ok: true, launched: true, pid: started.pid };
}

// ---------------------------------------------------------------------------
// Máy trạng thái phía app: kiểm tra -> (người dùng xác nhận) -> tải -> xác minh -> chạy helper.
// ---------------------------------------------------------------------------
class Updater {
  constructor(options = {}) {
    this.currentVersion = String(options.version || '0.0.0');
    this.checkUpdate = typeof options.checkUpdate === 'function' ? options.checkUpdate : async () => ({ ok: false, error: 'Thiếu bộ kiểm tra.' });
    this.execPath = options.execPath || process.execPath;
    this.tempDir = options.tempDir || os.tmpdir();
    this.allowHttp = options.allowHttp === true; // chỉ cho test
    this.downloadFn = options.download || download;
    this.fetchTextFn = options.fetchText || fetchText;
    this.launchFn = options.launch || launchDetached;
    this.canWrite = typeof options.canWrite === 'function' ? options.canWrite : canWriteDir;
    this.now = options.now || (() => Date.now());

    this.state = {
      stage: 'idle', // idle | available | downloading | verifying | applying | error
      current: this.currentVersion,
      latest: '',
      updateAvailable: false,
      canSelfUpdate: false,
      percent: null,
      received: 0,
      total: 0,
      error: '',
      version: '',
      assetName: '',
      releaseUrl: '',
      lastCheckedAt: 0,
    };
    this.plan = null;
    this.controller = null;
    this.newBinary = '';
  }

  status() { return { ...this.state }; }

  // Kiểm tra bản mới: chỉ khi mở app hoặc khi người dùng bấm "Kiểm tra cập nhật".
  async check(force) {
    this.state.stage = 'idle';
    this.state.error = '';
    let result;
    try { result = await this.checkUpdate(force === true); }
    catch (error) { result = { ok: false, error: error.message || String(error) }; }
    this.state.lastCheckedAt = this.now();
    this.state.current = result.current || this.currentVersion;
    this.state.latest = result.latest || '';
    this.state.updateAvailable = !!result.updateAvailable;
    this.state.releaseUrl = result.url || '';
    this.state.canSelfUpdate = false;
    this.plan = null;
    if (!result.ok) return this.status(); // mất mạng: im lặng
    if (!result.updateAvailable) { this.state.version = ''; this.state.assetName = ''; return this.status(); }

    this.plan = planUpdate({ tag_name: `v${result.latest}`, assets: result.assets }, this.state.current);
    if (!this.plan.ok) {
      this.state.updateAvailable = false;
      this.state.error = this.plan.error;
      return this.status();
    }
    this.state.version = this.plan.version;
    this.state.assetName = this.plan.binary.name;
    this.state.stage = 'available';
    const dir = path.dirname(this.execPath);
    this.state.canSelfUpdate = this.canWrite(dir);
    if (!this.state.canSelfUpdate) {
      this.state.error = `Thư mục ứng dụng không cho phép ghi (${dir}). Hãy tải bản mới từ ${this.state.releaseUrl || 'trang Release'}.`;
    }
    return this.status();
  }

  // Tải + xác minh. Chặn tải trùng.
  async start() {
    if (this.controller) return { ok: false, error: 'Đang tải bản cập nhật.' };
    if (!this.plan || !this.plan.ok) return { ok: false, error: this.plan ? this.plan.error : 'Chưa có thông tin bản mới.' };
    if (!this.state.canSelfUpdate) return { ok: false, error: this.state.error || 'Không thể tự cập nhật.' };

    const dest = path.join(updateTempDir(this.tempDir), NEW_BINARY_NAME);
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch { /* sẽ báo lỗi khi tải nếu không tạo được */ }
    const controller = new AbortController();
    this.controller = controller;
    this.state.stage = 'downloading';
    this.state.error = '';
    this.state.received = 0;
    this.state.total = this.plan.binary.size;
    this.state.percent = this.plan.binary.size ? 0 : null;
    this.state.assetName = this.plan.binary.name;

    try {
      const result = await this.downloadFn(this.plan.binary.url, dest, {
        allowHttp: this.allowHttp,
        signal: controller.signal,
        onProgress: (received, total) => {
          this.state.received = received;
          this.state.total = total || this.plan.binary.size;
          this.state.percent = this.state.total ? Math.min(100, Math.floor((received / this.state.total) * 100)) : null;
        },
      });
      this.state.received = result.received;
      this.state.total = result.total || this.state.total;

      // Xác minh SHA-256: bắt buộc.
      this.state.stage = 'verifying';
      let expected = '';
      try {
        const shaText = await this.fetchTextFn(this.plan.sha.url, { allowHttp: this.allowHttp });
        expected = parseSha256(shaText, this.plan.binary.name) || '';
      } catch { expected = ''; }
      if (!expected) {
        this.remove(dest);
        this.state.stage = 'error';
        this.state.error = 'Không đọc được mã SHA-256 của bản cập nhật.';
        this.state.percent = null;
        return { ok: false, error: this.state.error };
      }
      const actual = await sha256File(dest);
      if (actual !== expected) {
        this.remove(dest);
        this.state.stage = 'error';
        this.state.error = 'Không thể xác minh bản cập nhật (SHA-256 không khớp).';
        this.state.percent = null;
        return { ok: false, error: this.state.error };
      }
      this.state.percent = 100;

      // Chạy helper = chính binary mới, để nó chờ app này thoát rồi thay file và mở lại.
      this.state.stage = 'applying';
      const started = await this.launchFn(dest, ['--apply-update', '--target', this.execPath, '--next', dest, '--pid', String(process.pid)]);
      if (!started.ok) {
        this.state.stage = 'error';
        this.state.error = `Không khởi động được bộ cập nhật: ${started.error}`;
        return { ok: false, error: this.state.error };
      }
      this.newBinary = dest;
      return { ok: true, restarting: true };
    } catch (error) {
      this.remove(dest);
      this.state.stage = 'error';
      this.state.error = error && error.message ? error.message : String(error);
      this.state.percent = null;
      return { ok: false, error: this.state.error };
    } finally {
      this.controller = null;
    }
  }

  // "Để sau" / huỷ: dừng tải, xoá file dở dang, giữ nguyên bản đang chạy.
  cancel() {
    if (this.controller) { try { this.controller.abort(); } catch { /* bỏ */ } this.controller = null; }
    if (this.newBinary) { this.remove(this.newBinary); this.newBinary = ''; }
    this.state.stage = this.state.updateAvailable ? 'available' : 'idle';
    this.state.error = '';
    this.state.percent = null;
    this.state.received = 0;
    return this.status();
  }

  remove(file) { try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch { /* bỏ */ } }
}

module.exports = {
  Updater,
  applySelfUpdate,
  parseApplyArgs,
  compareVersions,
  planUpdate,
  parseSha256,
  sha256File,
  trustedAssetUrl,
  canWriteDir,
  cleanupUpdateTemp,
  updateTempDir,
  download,
  fetchText,
  launchDetached,
  waitForExit,
  appNameFor,
  appShaNameFor,
  setupNameFor,
  detectMode,
  NEW_BINARY_NAME,
  BACKUP_SUFFIX,
  REPO,
};
