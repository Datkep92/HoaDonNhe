'use strict';
// ---------------------------------------------------------------------------
// Bảo vệ lớp VÒNG ĐỜI MỚI (System Tray) — kiểm tra tĩnh trên source: nhanh, không cần chạy app,
// và sẽ đỏ ngay nếu sau này ai đó lỡ làm cửa sổ đóng ⇒ thoát app trở lại.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `không tìm thấy ${name}() trong server.js`);
  const open = source.indexOf('{', start);
  const end = source.indexOf('\n}', open);
  assert.ok(open >= 0 && end > open, `không cắt được thân ${name}()`);
  return source.slice(open, end + 2);
}

test('watchUi: cửa sổ đóng KHÔNG được gọi stop() nữa (X = chạy nền + icon khay)', () => {
  const body = functionBody('watchUi');
  assert.ok(!/stop\(\)/.test(body), 'watchUi() còn gọi stop() — đóng cửa sổ sẽ thoát app');
  assert.ok(body.includes('ensureTray()'), 'watchUi() phải hiện icon khay khi cửa sổ đóng');
});

test('stop() vẫn là cơ chế thoát duy nhất và dọn sạch tray + file instance', () => {
  const body = functionBody('stop');
  assert.ok(body.includes('stopTray()'), 'stop() phải dọn icon khay');
  assert.ok(body.includes('removeInstanceFile()'), 'stop() phải xoá app.pid.json');
  assert.ok(body.includes('browser.close()') && body.includes('stopSupportStream()'), 'giữ nguyên dọn dẹp cũ');
  assert.ok(body.includes('process.exit(0)'), 'stop() vẫn thoát tiến trình');
  assert.ok(body.includes('engine.pause()'), 'vẫn tạm dừng lượt tải đang chạy trước khi thoát');
});

test('endpoint vòng đời: /api/ping, /api/window/show, /api/app/quit — và quit gọi stop()', () => {
  for (const route of ["'/api/ping'", "'/api/window/show'", "'/api/app/quit'"]) {
    assert.ok(source.includes(route), `thiếu endpoint ${route}`);
  }
  const quitIndex = source.indexOf("url.pathname === '/api/app/quit'");
  const quitBlock = source.slice(quitIndex, quitIndex + 400);
  assert.ok(quitBlock.includes('stop()'), '/api/app/quit phải gọi đúng stop() hiện có');
});

test('chống nhiều instance: app.pid.json + nhường cho bản đang chạy rồi thoát', () => {
  assert.ok(source.includes("'app.pid.json'"), 'phải dùng du_lieu/app.pid.json');
  const claim = functionBody('claimSingleInstance');
  assert.ok(claim.includes("'/api/ping'"), 'phải ping instance cũ');
  assert.ok(claim.includes("'/api/window/show'"), 'phải nhờ instance cũ mở cửa sổ');
  assert.ok(claim.includes('return false'), 'bản mới phải thoát, không tạo instance thứ hai');
  assert.ok(source.includes('claimSingleInstance(port)'), 'khởi động phải đi qua kiểm tra instance');
});

test('System Tray: NotifyIcon + menu Mở ứng dụng / Thoát hoàn toàn + dùng resources/icon.ico', () => {
  const tray = functionBody('trayScript');
  assert.ok(tray.includes('NotifyIcon'), 'phải tạo NotifyIcon');
  assert.ok(tray.includes('Mở ứng dụng') && tray.includes('Thoát hoàn toàn'), 'thiếu mục menu khay');
  assert.ok(tray.includes('add_MouseClick'), 'chuột trái phải mở ứng dụng');
  assert.ok(tray.includes("'/api/window/show'") && tray.includes("'/api/app/quit'"), 'menu khay phải gọi đúng endpoint');
  const icon = functionBody('trayIconPath');
  assert.ok(icon.includes("'resources', 'icon.ico'"), 'phải dùng resources/icon.ico có sẵn cạnh app');
  assert.ok(icon.includes("path.join(appDir, 'icon.ico')"), 'bản portable lấy icon.ico ngay cạnh EXE');
  assert.ok(!icon.includes('__dirname'), 'không đưa đường dẫn snapshot của pkg cho helper PowerShell (helper không đọc được)');
  assert.ok(tray.includes('New-Object System.Drawing.Icon'), 'phải nạp icon riêng khi có file thật');
  assert.ok(source.includes("'-EncodedCommand'"), 'truyền script khay qua -EncodedCommand (an toàn dấu nháy/đường dẫn)');
  assert.ok(source.includes('function stopTray()'), 'phải có hàm dọn icon khay');
});

test('helper khay gọi endpoint bằng .NET WebRequest (PowerShell 5.1 KHÔNG gửi cookie qua -Headers)', () => {
  // Lỗi thật đã gặp: Invoke-WebRequest -Headers @{Cookie=...} không gửi cookie ⇒ /api/ping trả 403
  // ⇒ helper tự thoát sau ~0,4 giây và icon khay hiện rồi biến mất.
  const tray = functionBody('trayScript');
  assert.ok(!/-UseBasicParsing/.test(tray) && !tray.includes('Invoke-WebRequest -Uri'), 'không được dùng Invoke-WebRequest cho cookie phiên (PowerShell 5.1 không gửi cookie qua -Headers)');
  assert.ok(tray.includes('System.Net.WebRequest'), 'phải gọi endpoint bằng .NET WebRequest');
  assert.ok(tray.includes("Headers.Add('Cookie', $cookie)"), 'phải gắn cookie hd_session vào request');
  assert.ok(tray.includes('Proxy = $null'), 'không đi qua proxy của máy');
  assert.ok(tray.includes('$fails -ge 20'), 'chỉ tự đóng sau nhiều lần liên tiếp không phản hồi');
});

test('ensureTray: báo thành công SAU KHI kiểm chứng helper sống + phục hồi THEO SỰ KIỆN, không hỏi vòng', () => {
  const ensure = functionBody('ensureTray');
  assert.ok(ensure.includes('child.exitCode === null'), 'phải kiểm chứng helper còn sống trước khi ghi log thành công');
  assert.ok(ensure.includes("child.on('exit'"), 'phải phục hồi icon khay khi helper thoát');
  assert.ok(ensure.includes('scheduleTrayRetry()'), 'handler thoát phải hẹn dựng lại icon khay');
  // Bỏ hẳn bộ quét định kỳ 20 giây: lúc bình thường không được có timer nào chạy.
  assert.ok(!source.includes('superviseTray'), 'đã bỏ bộ đếm 20 giây — không còn superviseTray');
  assert.ok(!source.includes('trayBusy'), 'đã bỏ biến timer định kỳ trayBusy');
  assert.ok(!ensure.includes('setInterval'), 'ensureTray không được hỏi vòng định kỳ');
  const retry = functionBody('scheduleTrayRetry');
  assert.ok(!retry.includes('setInterval'), 'bộ hẹn lại cũng không được hỏi vòng định kỳ');
  assert.ok(retry.includes('Math.max(5000'), 'chờ tối thiểu 5 giây giữa hai lần dựng lại');
  assert.ok(retry.includes('trayStopped'), 'đã Thoát hoàn toàn thì không hẹn lại');
  // Thiếu bước này thì helper chết sớm bị bỏ rơi vĩnh viễn (đã kiểm bằng mô phỏng).
  assert.ok(retry.includes('if (!trayAlive()) scheduleTrayRetry()'), 'còn trong thời gian lùi thì phải hẹn lại, không bỏ rơi icon khay');
  // Chết sớm thì lùi dần, chết sau khi đã sống đủ lâu thì chỉ chờ 5 giây.
  assert.ok(ensure.includes('TRAY_STABLE_MS'), 'phải phân biệt chết sớm với đã sống đủ lâu');
  assert.ok(ensure.includes('trayFailCount += 1'), 'chết sớm phải tăng số lần lỗi để lùi dần');
  assert.ok(ensure.includes('Math.min(300000'), 'lùi tối đa 5 phút');
  // Chỉ MỘT nơi quyết định lỗi/lùi — nếu bộ hẹn 2,5 giây cũng phạt thì bị trừ hai lần cho cùng lần hỏng.
  const logCheck = ensure.slice(ensure.indexOf('setTimeout(() => {'), ensure.indexOf('}, TRAY_STABLE_MS)'));
  assert.ok(!/trayFailCount \+= 1/.test(logCheck), 'bộ hẹn thành công KHÔNG được tăng số lần lỗi (tránh trừ hai lần)');
  assert.ok(!/trayNextTry\s*=/.test(logCheck), 'bộ hẹn thành công KHÔNG được đặt thời gian lùi — chỉ child.exit() mới quyết định');
  const stop = functionBody('stopTray');
  assert.ok(stop.includes('trayStopped = true'), 'stopTray phải đánh dấu đã dừng để không dựng lại');
  assert.ok(stop.includes('trayRetryTimer'), 'stopTray phải huỷ lần dựng lại đang chờ');
});

test('stop(): đóng cửa sổ giao diện + thoát tiến trình CHẮC CHẮN (không treo ở server.close)', () => {
  // Lỗi thật đã gặp khi kiểm chứng: /api/app/quit đóng tray + xoá pid file nhưng tiến trình TREO
  // (server.close không bao giờ kết thúc vì cửa sổ UI giữ kết nối) và cửa sổ Chrome còn nguyên.
  const body = functionBody('stop');
  assert.ok(body.includes('closeUiWindows()'), 'stop() phải đóng cửa sổ giao diện');
  assert.ok(body.includes('process.exit(0)'), 'stop() vẫn thoát tiến trình');
  assert.ok(body.includes('setTimeout'), 'phải có trần thời gian để tiến trình luôn thoát hẳn');
  const close = functionBody('closeUiWindows');
  assert.ok(close.includes("'ui-browser'"), 'chỉ đóng cửa sổ dùng profile UI của app (không đụng Chrome cá nhân)');
  assert.ok(close.includes('uiProcess.kill()'), 'phải đóng tiến trình giao diện đã mở');
});

test('bấm icon khay: cửa sổ đang mở thì đưa lên trước, KHÔNG mở thêm cửa sổ mới', () => {
  // Lỗi thật đã gặp: relaunchUi() luôn spawn `chrome --app=…` nên mỗi lần bấm khay là thêm một cửa sổ.
  const show = functionBody('showUiWindow');
  assert.ok(show.includes('focusUiWindow()'), 'phải thử đưa cửa sổ đang mở lên trước');
  assert.ok(show.includes('relaunchUi()'), 'chỉ mở cửa sổ mới khi không còn cửa sổ nào');
  const focus = functionBody('focusUiWindow');
  assert.ok(focus.includes('ShowWindow') && focus.includes('SetForegroundWindow'), 'phải khôi phục + đưa cửa sổ lên trước bằng Win32');
  assert.ok(focus.includes("'ui-browser'"), 'chỉ tác động cửa sổ của app (profile ui-browser)');
  const route = source.slice(source.indexOf("url.pathname === '/api/window/show'"), source.indexOf("url.pathname === '/api/app/quit'"));
  assert.ok(route.includes('showUiWindow()'), '/api/window/show phải đi qua showUiWindow()');
});

test('icon: ICO nhiều kích cỡ (khay + shortcut) và favicon cho cửa sổ app trên taskbar', () => {
  const ico = fs.readFileSync(path.join(root, 'resources', 'icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO: reserved = 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO: type = 1 (icon)');
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 5, `ICO phải có nhiều kích cỡ (đang có ${count})`);
  const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
  for (const need of [16, 32, 48, 256]) assert.ok(sizes.includes(need), `ICO thiếu kích cỡ ${need}`);
  const favicon = fs.readFileSync(path.join(root, 'src', 'icon.png'));
  assert.ok(favicon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'favicon phải là PNG');
  assert.equal(favicon.readUInt32BE(16), 64, 'favicon phải 64×64');
  assert.ok(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8').includes('rel="icon"'), 'index.html phải khai báo favicon');
  assert.ok(source.includes("'/icon.png'") && source.includes("staticFile(res, 'icon.png', 'image/png')"), 'server phải phục vụ /icon.png');
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).pkg.assets;
  assert.ok(assets.includes('src/icon.png'), 'EXE đóng gói phải kèm src/icon.png');
  assert.ok(functionBody('trayIconPath').includes("'CN-Tax-Tools.ico'"), 'nhận cả tên icon do bộ cài NSIS đặt cạnh app');
});

test('cửa sổ app: tắt bong bóng dịch của Chrome (--disable-features=Translate)', () => {
  const body = functionBody('launchUi');
  assert.ok(body.includes('--disable-features=Translate'), 'phải tắt tính năng dịch của Chrome trên cửa sổ --app');
  assert.ok(body.includes('--user-data-dir='), 'vẫn dùng profile riêng cho giao diện');
  assert.ok(body.includes('--app='), 'vẫn mở ở dạng cửa sổ ứng dụng');
});

test('không đụng nghiệp vụ: SQLite/API/updater/engine vẫn như cũ', () => {
  // Các dấu vết nghiệp vụ phải còn nguyên trong server.js
  for (const marker of ['data.mst.ensureMst({ output, mst })', '/api/db/invoices', 'runAutoSyncFor(', 'updater.status()']) {
    assert.ok(source.includes(marker), `mất dấu vết nghiệp vụ: ${marker}`);
  }
});
