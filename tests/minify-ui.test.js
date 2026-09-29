'use strict';
// ---------------------------------------------------------------------------
// RÚT GỌN BYTE TÀI SẢN GIAO DIỆN LÚC ĐÓNG GÓI (tools/minify-ui.cjs).
//
// Vì sao: giao diện là HTML + 12 file .js/.css tự viết, phần lớn là chú thích tiếng Việt giải thích
// lý do — đọc thì tốt mà tải thì nặng. Đo thực tế: 272 KB → 200 KB (−27%) không đổi một dòng logic.
// Bản rút gọn ghi ra file RIÊNG (`src/renderer.min.js`) và KHÔNG vào git; server tự đưa bản .min khi
// phục vụ nhưng CHỈ khi nó không cũ hơn bản gốc — nếu không, dev sửa renderer.js sẽ mãi thấy bản cũ.
//
// Test này khoá 5 mặt, trong đó (5) là mặt dễ vỡ nhất và im lặng nhất:
//   1) rút gọn KHÔNG đổi hành vi: các script là <script> cổ điển dùng chung phạm vi toàn cục nên
//      mọi tên định danh cấp cao nhất phải còn nguyên (minifyIdentifiers: false);
//   2) rút gọn thật sự nhỏ hơn nguồn, và dọn được bản .min mồ côi;
//   3) danh sách đích PHẢI trùng đúng các route tài sản tĩnh trong server.js — lệch là thêm file mới
//      mà quên rút gọn (hoặc rút gọn file không ai phục vụ);
//   4) server phục vụ bản .min khi có, và RƠI VỀ BẢN GỐC khi bản .min đã cũ;
//   5) build đòi bản .min có mặt trong EXE, và pkg.assets có khai nó.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const { TARGETS, minify, minifySource, minifiedName } = require('../tools/minify-ui.cjs');
const read = name => fs.readFileSync(path.join(srcDir, name), 'utf8');

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    cwd: root,
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  let match = null;
  for (let i = 0; i < 300 && !match; i += 1) {
    match = out.match(/\{"testUrl":"[^"]+"/);
    if (!match) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!match) { child.kill(); throw new Error(`server không khởi động: ${out}`); }
  return { url: new URL(JSON.parse(`${match[0]}}`).testUrl), stop: () => child.kill() };
}

function getText(url, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: Number(url.port), path: pathname, headers: { Cookie: `hd_session=${url.searchParams.get('launch')}` } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

const generated = () => TARGETS.map(target => path.join(srcDir, minifiedName(target.name)));
const clearGenerated = () => { for (const file of generated()) { try { fs.unlinkSync(file); } catch { /* chưa có */ } } };

test('rút gọn KHÔNG đổi tên định danh — các script dùng chung phạm vi toàn cục', () => {
  const renderer = read('renderer.js');
  const min = minifySource(renderer, 'js');
  // Tên cấp cao nhất mà file khác gọi tới: đổi tên là giao diện vỡ ngay (data-ui.js gọi
  // window.hdBootReady, mst-format.js/period.js cung cấp hàm cho renderer.js).
  for (const name of ['window.hdBootReady', 'function firstPaintMstList', 'function loadDeferredScripts', 'hdBootDismissed', 'writeMstCache']) {
    assert.ok(min.includes(name), `bản rút gọn phải còn "${name}" — đổi tên định danh là vỡ giao diện`);
  }
  // Chỉ thị 'use strict' ở đầu file là hành vi, không phải chú thích: mất nó là đổi ngữ nghĩa.
  assert.match(min.slice(0, 40), /^['"]use strict['"]/, 'phải giữ chỉ thị "use strict"');
  // Chú thích thì PHẢI mất — nếu còn nguyên thì bước rút gọn chưa chạy.
  assert.ok(!min.includes('// ---- '), 'chú thích phải bị cắt');
  const css = minifySource(read('data-view.css'), 'css');
  assert.ok(css.includes('.overview-pane'), 'CSS phải giữ nguyên tên lớp');
});

test('mọi tài sản đích đều nhỏ hơn bản gốc và bản .min mồ côi bị dọn', () => {
  const orphan = path.join(srcDir, 'khong-con-dung.min.js');
  fs.writeFileSync(orphan, 'window.rac=1;\n');
  let rows;
  try {
    rows = minify({ log: () => {} });
  } finally {
    clearGenerated();
  }
  for (const row of rows) {
    assert.ok(row.after > 0 && row.after < row.before, `${row.name}: ${row.before} → ${row.after} phải nhỏ hơn`);
    assert.equal(row.out, minifiedName(row.name), 'tên file phải theo quy ước <tên>.min.<ext>');
  }
  const saved = rows.reduce((sum, row) => sum + (row.before - row.after), 0);
  // Ngưỡng thấp hơn thực đo (72 KB) để không đỏ khi CSS/JS đổi đôi chút, nhưng đủ chặt để bắt
  // trường hợp "rút gọn chạy mà chẳng cắt được gì".
  assert.ok(saved > 40000, `phải tiết kiệm đáng kể byte, thực tế chỉ ${saved}`);
  assert.ok(!fs.existsSync(orphan), 'bản .min không còn trong danh sách đích phải bị xoá — nếu không server sẽ phục vụ mã chết');
});

test('danh sách rút gọn TRÙNG khớp các route tài sản tĩnh trong server.js', () => {
  const server = read('server.js');
  const routes = [...server.matchAll(/staticFile\(req, res, '([^']+\.(?:js|css))'/g)].map(match => match[1]);
  // vendor/ là thư viện bên thứ ba (một số đã rút gọn sẵn) — cố ý không đụng tới.
  const own = [...new Set(routes.filter(name => !name.startsWith('vendor/')))].sort();
  const targets = TARGETS.map(target => target.name).sort();
  assert.deepEqual(targets, own,
    'mỗi tài sản tự viết được phục vụ qua HTTP phải có trong TARGETS, và ngược lại — thêm file mới mà quên là bản phát hành tự nhiên nặng thêm');
  assert.deepEqual(own, [...own].sort(), 'danh sách phải ổn định để so sánh');
});

test('server phục vụ bản .min khi có, RƠI VỀ BẢN GỐC khi bản .min đã cũ', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-minify-'));
  minify({ log: () => {} });
  // renderer.js: bản .min MỚI (vừa sinh) ⇒ phải được phục vụ thay bản gốc.
  // data-ui.js: bản .min bị làm CŨ hơn nguồn ⇒ phải rơi về bản gốc, đúng cảnh dev sửa file rồi F5.
  const stale = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(srcDir, 'data-ui.min.js'), stale, stale);
  const server = await startServer(dataDir);
  try {
    const shrunk = await getText(server.url, '/renderer.js');
    assert.equal(shrunk.status, 200);
    assert.equal(shrunk.text, read('renderer.min.js'), 'khi có bản .min mới hơn, server phải phục vụ nó');
    assert.ok(shrunk.text.length < read('renderer.js').length, 'bản phục vụ phải nhẹ hơn bản nguồn');

    const original = await getText(server.url, '/data-ui.js');
    assert.equal(original.status, 200);
    assert.equal(original.text, read('data-ui.js'),
      'bản .min cũ hơn nguồn ⇒ PHẢI trả bản gốc, nếu không dev sửa mãi mà giao diện không đổi');

    // Tài sản không phải .js/.css không có bản rút gọn: phải vẫn phục vụ bình thường.
    const icon = await getText(server.url, '/icon.png');
    assert.equal(icon.status, 200, 'ảnh không có bản .min — nhánh tìm bản rút gọn không được làm hỏng route');
  } finally {
    server.stop();
    clearGenerated();
  }
});

test('build đòi bản .min trong EXE và pkg.assets có khai nó', () => {
  const build = fs.readFileSync(path.join(root, 'tools', 'build-app.cjs'), 'utf8');
  const minifyAt = build.indexOf("require('./minify-ui.cjs')");
  const pkgAt = build.indexOf("pkgBin, '.'");
  assert.ok(minifyAt > -1, 'build phải chạy bước rút gọn');
  assert.ok(minifyAt < pkgAt, 'rút gọn phải chạy TRƯỚC khi đóng gói, nếu không bản .min không được nhúng');
  assert.ok(build.includes('verify(exe, shrink)'),
    'phải ĐÒI bản rút gọn trong EXE: thiếu nó app vẫn chạy nên lỗi sẽ im lặng, build phải đỏ thay vì phát hành bản nặng');
  const pkg = require('../package.json').pkg;
  for (const pattern of ['src/*.min.js', 'src/*.min.css']) {
    assert.ok(pkg.assets.includes(pattern), `pkg.assets phải khai "${pattern}" để bản rút gọn vào được EXE`);
  }
  // Bản gốc vẫn phải nằm trong gói: đó là đường lùi khi máy build không có esbuild.
  for (const name of ['src/renderer.js', 'src/style.css']) {
    assert.ok(pkg.assets.includes(name), `${name} phải giữ trong assets làm đường lùi`);
  }
});
