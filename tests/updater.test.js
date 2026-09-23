'use strict';
// Test cho SELF-UPDATE (cập nhật tại chỗ): phát hiện bản mới, tải, xác minh SHA-256, thay binary,
// mở lại, rollback khi lỗi — và tuyệt đối không đụng dữ liệu người dùng.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  Updater, applySelfUpdate, parseApplyArgs, compareVersions, planUpdate, parseSha256,
  trustedAssetUrl, canWriteDir, cleanupUpdateTemp, updateTempDir, waitForExit,
  appNameFor, appShaNameFor, setupNameFor, NEW_BINARY_NAME, BACKUP_SUFFIX,
} = require('../src/updater');

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const NEW_BYTES = Buffer.from('MZ new binary payload for self-update tests\n'.repeat(32));
const NEW_SHA = crypto.createHash('sha256').update(NEW_BYTES).digest('hex');
const OLD_BYTES = Buffer.from('MZ old binary still running\n'.repeat(16));
const REL = 'https://github.com/Datkep92/HoaDonNhe/releases/download/v1.0.2/';

function releaseFor(version, options = {}) {
  const { withSha = true, draft = false, binaryUrl = `${REL}${appNameFor(version)}`, shaUrl = `${REL}${appShaNameFor(version)}` } = options;
  const assets = [{ name: appNameFor(version), size: NEW_BYTES.length, browser_download_url: binaryUrl }];
  if (withSha) assets.push({ name: appShaNameFor(version), size: 94, browser_download_url: shaUrl });
  // Setup cũng nằm trong Release nhưng KHÔNG được dùng cho self-update.
  assets.push({ name: setupNameFor(version), size: 999, browser_download_url: `${REL}${setupNameFor(version)}` });
  return { tag_name: `v${version}`, draft, prerelease: false, assets };
}

function assetsServer({ failBinary = false, shaBody = `${NEW_SHA}  ${appNameFor('1.0.2')}\n` } = {}) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/binary')) {
        if (failBinary) { res.writeHead(500); return res.end('nope'); }
        res.writeHead(200, { 'Content-Length': NEW_BYTES.length });
        return res.end(NEW_BYTES);
      }
      if (req.url.startsWith('/sha')) { res.writeHead(200); return res.end(shaBody); }
      res.writeHead(404); return res.end('x');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeUpdater(port, options = {}) {
  return new Updater({
    version: '1.0.1',
    execPath: options.execPath || path.join(tempDir('hd-self-'), 'HoaDonNhe.exe'),
    tempDir: options.tempDir || tempDir('hd-selftmp-'),
    allowHttp: true,
    checkUpdate: options.checkUpdate || (async () => ({ ok: true, current: '1.0.1', latest: '1.0.2', updateAvailable: true, assets: releaseFor('1.0.2').assets })),
    canWrite: options.canWrite || (() => true),
    download: options.download,
    fetchText: options.fetchText,
    launch: options.launch,
  });
}

function useLocalPlan(updater, port) {
  updater.state.updateAvailable = true;
  updater.state.canSelfUpdate = true;
  updater.state.stage = 'available';
  updater.state.latest = '1.0.2';
  updater.plan = {
    ok: true, version: '1.0.2',
    binary: { name: appNameFor('1.0.2'), url: `http://127.0.0.1:${port}/binary`, size: NEW_BYTES.length },
    sha: { name: appShaNameFor('1.0.2'), url: `http://127.0.0.1:${port}/sha`, size: 94 },
  };
  return updater;
}

// Dựng một "thư mục ứng dụng" để thử thay binary thật.
function makeAppDir(options = {}) {
  const dir = tempDir('hd-appdir-');
  const exe = path.join(dir, 'HoaDonNhe.exe');
  fs.writeFileSync(exe, OLD_BYTES);
  if (options.installed) {
    fs.writeFileSync(path.join(dir, 'Uninstall.exe'), 'uninstaller');
    fs.writeFileSync(path.join(dir, 'HoaDonNhe.ico'), 'icon');
  }
  fs.mkdirSync(path.join(dir, 'du_lieu'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'du_lieu', 'support.json'), '{"device":"giu-nguyen"}');
  fs.writeFileSync(path.join(dir, 'du_lieu', 'accounts.json'), '{"accounts":[1,2,3]}');
  return { dir, exe };
}

function makeNewBinary() {
  const dir = tempDir('hd-new-');
  const file = path.join(dir, NEW_BINARY_NAME);
  fs.writeFileSync(file, NEW_BYTES);
  return file;
}

// ---------------------------------------------------------------- version
test('không có update khi current == latest', () => {
  const plan = planUpdate(releaseFor('1.0.2'), '1.0.2');
  assert.equal(plan.ok, false);
  assert.match(plan.error, /Không có bản mới/);
  assert.equal(compareVersions('1.0.2', '1.0.2'), 0);
});

test('phát hiện bản mới: current < latest', () => {
  const plan = planUpdate(releaseFor('1.0.2'), '1.0.1');
  assert.equal(plan.ok, true);
  assert.equal(plan.version, '1.0.2');
  assert.equal(plan.binary.name, 'HoaDonNhe-v1.0.2.exe');
  assert.equal(plan.sha.name, 'HoaDonNhe-v1.0.2.exe.sha256');
  assert.equal(compareVersions('1.0.2', '1.0.10'), -1);
});

test('KHÔNG hạ cấp: bản phát hành cũ hơn thì bỏ qua', () => {
  assert.equal(planUpdate(releaseFor('1.0.0'), '1.0.1').ok, false);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  const updater = new Updater({ version: '1.0.1', execPath: 'C:\\x\\HoaDonNhe.exe', checkUpdate: async () => ({ ok: true, current: '1.0.1', latest: '1.0.0', updateAvailable: false, assets: releaseFor('1.0.0').assets }) });
  return updater.check().then(() => assert.equal(updater.status().updateAvailable, false));
});

test('payload phải đúng repo/HTTPS/tên quy ước, và phải có .sha256', () => {
  assert.equal(trustedAssetUrl(`${REL}${appNameFor('1.0.2')}`, appNameFor('1.0.2')).startsWith('https://github.com/Datkep92/'), true);
  assert.equal(trustedAssetUrl(`http://github.com/Datkep92/HoaDonNhe/releases/download/v1.0.2/${appNameFor('1.0.2')}`, appNameFor('1.0.2')), '');
  assert.equal(trustedAssetUrl(`https://evil.example/${appNameFor('1.0.2')}`, appNameFor('1.0.2')), '');
  assert.equal(planUpdate(releaseFor('1.0.2', { withSha: false }), '1.0.1').ok, false, 'thiếu .sha256 thì không cập nhật');
  assert.equal(planUpdate(releaseFor('1.0.2', { binaryUrl: 'https://evil.example/HoaDonNhe-v1.0.2.exe' }), '1.0.1').ok, false);
  assert.equal(planUpdate(releaseFor('1.0.2', { draft: true }), '1.0.1').ok, false);
  assert.equal(planUpdate(releaseFor('1.0.2', { binaryUrl: `${REL}HoaDonNhe-Setup-v1.0.2.exe` }), '1.0.1').ok, false, 'không nhận Setup làm payload self-update');
});

test('parseSha256 đọc đúng và từ chối tên khác', () => {
  assert.equal(parseSha256(`${NEW_SHA}  ${appNameFor('1.0.2')}\n`), NEW_SHA);
  assert.equal(parseSha256(`${NEW_SHA}  Khac.exe`, appNameFor('1.0.2')), null);
  assert.equal(parseSha256('khong-phai-hash'), null);
});

// ---------------------------------------------------------------- tải + xác minh
test('"Để sau": chỉ kiểm tra, KHÔNG tải', async () => {
  const server = await assetsServer();
  try {
    let downloads = 0;
    const updater = makeUpdater(server.address().port, { download: async () => { downloads += 1; return { received: 1, total: 1 }; } });
    await updater.check();
    assert.equal(updater.status().stage, 'available');
    assert.equal(downloads, 0);
    updater.cancel();
    assert.equal(updater.status().stage, 'available');
  } finally { server.close(); }
});

test('tải + SHA-256 khớp -> chạy helper để thay binary', async () => {
  const server = await assetsServer();
  const launches = [];
  try {
    const updater = useLocalPlan(makeUpdater(server.address().port, { launch: async (file, args) => { launches.push({ file, args }); return { ok: true, pid: 99 }; } }), server.address().port);
    const result = await updater.start();
    assert.equal(result.ok, true, result.error);
    assert.equal(result.restarting, true);
    const state = updater.status();
    assert.equal(state.stage, 'applying');
    assert.equal(state.percent, 100);
    const dest = path.join(updateTempDir(updater.tempDir), NEW_BINARY_NAME);
    assert.equal(fs.existsSync(dest), true, 'payload nằm trong thư mục TEMP riêng');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].file, dest, 'helper chính là binary mới đã tải');
    assert.deepEqual(launches[0].args.slice(0, 2), ['--apply-update', '--target']);
    assert.ok(launches[0].args.includes('--pid'));
  } finally { server.close(); }
});

test('tải lỗi -> giữ nguyên app, không thay gì, cho phép thử lại', async () => {
  const server = await assetsServer({ failBinary: true });
  try {
    const updater = useLocalPlan(makeUpdater(server.address().port), server.address().port);
    const result = await updater.start();
    assert.equal(result.ok, false);
    assert.equal(updater.status().stage, 'error');
    assert.equal(fs.existsSync(path.join(updateTempDir(updater.tempDir), NEW_BINARY_NAME)), false);
  } finally { server.close(); }
});

test('SHA-256 sai -> xoá payload, KHÔNG chạy helper', async () => {
  const wrong = crypto.createHash('sha256').update('khac').digest('hex');
  const server = await assetsServer({ shaBody: `${wrong}  ${appNameFor('1.0.2')}\n` });
  const launches = [];
  try {
    const updater = useLocalPlan(makeUpdater(server.address().port, { launch: async (f, a) => { launches.push(a); return { ok: true, pid: 1 }; } }), server.address().port);
    const result = await updater.start();
    assert.equal(result.ok, false);
    assert.match(updater.status().error, /Không thể xác minh/);
    assert.equal(launches.length, 0, 'checksum sai thì tuyệt đối không chạy updater');
    assert.equal(fs.existsSync(path.join(updateTempDir(updater.tempDir), NEW_BINARY_NAME)), false);
  } finally { server.close(); }
});

test('không tải trùng: bấm nhiều lần chỉ một lượt tải', async () => {
  const server = await assetsServer();
  try {
    let downloads = 0;
    const updater = useLocalPlan(makeUpdater(server.address().port, {
      download: async (url, dest) => { downloads += 1; await new Promise(r => setTimeout(r, 80)); fs.writeFileSync(dest, NEW_BYTES); return { received: NEW_BYTES.length, total: NEW_BYTES.length }; },
      launch: async () => ({ ok: true, pid: 5 }),
    }), server.address().port);
    const results = await Promise.all([updater.start(), updater.start()]);
    assert.equal(downloads, 1);
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(results.filter(r => !r.ok).length, 1);
  } finally { server.close(); }
});

test('thư mục không cho ghi -> báo rõ, không tải, không phá bản hiện tại', async () => {
  const updater = makeUpdater(0, { canWrite: () => false });
  await updater.check();
  assert.equal(updater.status().canSelfUpdate, false);
  assert.match(updater.status().error, /không cho phép ghi/);
  const result = await updater.start();
  assert.equal(result.ok, false);
  assert.equal(updater.status().stage, 'available');
});

test('mất mạng: im lặng, không làm phiền', async () => {
  const updater = new Updater({ version: '1.0.1', execPath: 'C:\\x\\HoaDonNhe.exe', checkUpdate: async () => ({ ok: false, current: '1.0.1', latest: '', updateAvailable: false, error: 'Hết thời gian chờ GitHub.' }) });
  await updater.check();
  assert.equal(updater.status().error, '');
  assert.equal(updater.status().updateAvailable, false);
});

// ---------------------------------------------------------------- helper thay binary
test('parseApplyArgs đọc đúng tham số helper', () => {
  const args = parseApplyArgs(['--apply-update', '--target', 'C:\\a\\HoaDonNhe.exe', '--next', 'C:\\t\\new.exe', '--pid', '1234', '--no-launch']);
  assert.equal(args.target, 'C:\\a\\HoaDonNhe.exe');
  assert.equal(args.next, 'C:\\t\\new.exe');
  assert.equal(args.pid, 1234);
  assert.equal(args.noLaunch, true);
});

test('helper chờ process cũ thoát (chưa thoát thì KHÔNG thay file)', async () => {
  const app = makeAppDir();
  const next = makeNewBinary();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next, '--pid', String(process.pid)], { waitMs: 500, launch: async () => ({ ok: true }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /chưa thoát/);
  assert.equal(fs.readFileSync(app.exe).toString(), OLD_BYTES.toString(), 'binary cũ còn nguyên');
});

test('waitForExit trả về đúng khi process đã thoát', async () => {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise(resolve => child.on('exit', resolve));
  assert.equal(await waitForExit(pid, 3000, 50), true);
});

test('thay binary: backup -> thay -> kiểm tra -> dọn backup, dữ liệu người dùng nguyên vẹn', async () => {
  const app = makeAppDir({ installed: true });
  const next = makeNewBinary();
  const before = fs.readdirSync(path.join(app.dir, 'du_lieu')).sort();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next, '--no-launch'], {});
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(app.exe).toString(), NEW_BYTES.toString(), 'binary đã được thay bằng bản mới');
  assert.equal(fs.existsSync(`${app.exe}${BACKUP_SUFFIX}`), false, 'đã dọn backup sau khi thành công');
  assert.deepEqual(fs.readdirSync(path.join(app.dir, 'du_lieu')).sort(), before, 'du_lieu không đổi');
  assert.equal(fs.readFileSync(path.join(app.dir, 'du_lieu', 'support.json'), 'utf8'), '{"device":"giu-nguyen"}');
  assert.equal(fs.existsSync(path.join(app.dir, 'Uninstall.exe')), true, 'uninstall entry/file vẫn còn');
  assert.equal(fs.existsSync(path.join(app.dir, 'HoaDonNhe.ico')), true, 'icon vẫn còn');
});

test('Portable: thay tại chỗ, KHÔNG tạo file/thư mục mới ngoài binary', async () => {
  const app = makeAppDir();
  const next = makeNewBinary();
  const before = fs.readdirSync(app.dir).sort();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next, '--no-launch'], {});
  assert.equal(result.ok, true, result.error);
  const after = fs.readdirSync(app.dir).sort();
  assert.deepEqual(after, before, 'không thêm file nào (không shortcut/registry/installer)');
});

test('mở lại bản mới thành công -> báo đã restart', async () => {
  const app = makeAppDir();
  const next = makeNewBinary();
  const launched = [];
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next], { launch: async (file, args) => { launched.push({ file, args }); return { ok: true, pid: 777 }; } });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.launched, true);
  assert.equal(launched[0].file, app.exe, 'mở lại đúng file trong thư mục ứng dụng');
  assert.deepEqual(launched[0].args, [], 'không truyền tham số lạ cho app mới');
});

test('ROLLBACK: copy bản mới lỗi -> khôi phục binary cũ', async () => {
  const app = makeAppDir();
  const next = makeNewBinary();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next, '--no-launch'], {
    copyFile: () => { throw new Error('đĩa lỗi'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(fs.readFileSync(app.exe).toString(), OLD_BYTES.toString(), 'đã khôi phục bản cũ');
  assert.equal(fs.existsSync(`${app.exe}${BACKUP_SUFFIX}`), false, 'không để lại backup rác');
});

test('ROLLBACK: không mở được bản mới -> khôi phục bản cũ', async () => {
  const app = makeAppDir();
  const next = makeNewBinary();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', next], { launch: async () => ({ ok: false, error: 'không chạy được' }) });
  assert.equal(result.ok, false);
  assert.equal(result.restored, true);
  assert.equal(fs.readFileSync(app.exe).toString(), OLD_BYTES.toString(), 'người dùng vẫn mở được app cũ');
});

test('thiếu file payload -> báo lỗi, không đụng binary đang chạy', async () => {
  const app = makeAppDir();
  const result = await applySelfUpdate(['--apply-update', '--target', app.exe, '--next', path.join(tempDir('hd-missing-'), 'khong-co.exe')], {});
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(app.exe).toString(), OLD_BYTES.toString());
});

test('cleanupUpdateTemp xoá thư mục tạm nhưng không ném lỗi', () => {
  const base = tempDir('hd-clean-');
  const dir = updateTempDir(base);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, NEW_BINARY_NAME), 'x');
  assert.equal(cleanupUpdateTemp(base), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(cleanupUpdateTemp(base), true, 'gọi lại vẫn không lỗi');
});

test('canWriteDir phản ánh đúng khả năng ghi và không để lại file rác', () => {
  const dir = tempDir('hd-write-');
  assert.equal(canWriteDir(dir), true);
  assert.deepEqual(fs.readdirSync(dir), [], 'file thăm dò đã bị xoá');
  assert.equal(canWriteDir(path.join(dir, 'khong-ton-tai')), false);
});

test('không update loop: sau khi lên bản mới thì không còn bản mới', async () => {
  const assets = releaseFor('1.0.2').assets;
  const before = new Updater({ version: '1.0.1', execPath: 'C:\\x\\HoaDonNhe.exe', canWrite: () => true, checkUpdate: async () => ({ ok: true, current: '1.0.1', latest: '1.0.2', updateAvailable: true, assets }) });
  await before.check();
  assert.equal(before.status().updateAvailable, true);
  const after = new Updater({ version: '1.0.2', execPath: 'C:\\x\\HoaDonNhe.exe', canWrite: () => true, checkUpdate: async () => ({ ok: true, current: '1.0.2', latest: '1.0.2', updateAvailable: false, assets }) });
  await after.check();
  assert.equal(after.status().updateAvailable, false);
  assert.equal(after.status().stage, 'idle');
});
