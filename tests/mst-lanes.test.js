'use strict';
// ---------------------------------------------------------------------------
// MỖI MST MỘT LUỒNG RIÊNG — không chặn nhau.
//
// Lỗi thật: đang ở MST A tra cứu/tải cuốn chiếu ở tab Tra cứu thì bấm sang MST B KHÔNG được.
// Ba nguyên nhân đã tìm ra và bị khoá bằng test này:
//   1. UI: `work()` giữ `pending = true` suốt request dài, mà `chooseMst()` lại `if (pending) return;`
//   2. UI: `busy` khoá cả bảng lọc và các nút theo engine ĐANG XEM
//   3. server: `ensureIdle(mst)` có nhánh dự phòng `|| engine` ⇒ MST đích chưa dùng thì lại đi
//      kiểm engine của MST đang chọn ⇒ tác vụ của A chặn việc thêm/đăng nhập B
// Và endpoint thủ công phải nhận `mst` để chạy đúng luồng của MST đó.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('UI: tác vụ DÀI không giữ `pending` ⇒ bấm sang MST khác được', () => {
  const renderer = read('src/renderer.js');
  // work() phải phân biệt tác vụ dài: dài thì KHÔNG đặt pending.
  assert.ok(renderer.includes('async function work(url, data, options = {})'), 'work() phải nhận options');
  assert.ok(renderer.includes('if (isLong) longMst = '), 'tác vụ dài phải ghi nhớ MST riêng, không dùng `pending`');
  assert.ok(renderer.includes('else pending = true;'), 'chỉ yêu cầu UI ngắn mới giữ `pending`');
  // Tra cứu và tải cuốn chiếu là hai đường dài.
  assert.ok(renderer.includes('}, { long: true });'), 'tra cứu/tải phải được đánh dấu là tác vụ dài');
  assert.ok(renderer.includes("work('/api/resume', { mst: current.selected }, { long: true })"), 'nút Tải tiếp cũng là tác vụ dài của đúng MST đó');
});

test('UI: gửi kèm `mst` cho tra cứu để server chạy đúng luồng', () => {
  const renderer = read('src/renderer.js');
  assert.ok(renderer.includes("await work(url, { mst: current.selected,"), 'tra cứu/tải phải nói rõ MST nào');
});

test('server: endpoint thủ công chạy ĐÚNG engine của MST được yêu cầu', () => {
  const server = read('src/server.js');
  assert.ok(server.includes('function engineOf(mst)'), 'phải có engineOf(mst)');
  // /api/search và /api/stream phải đọc body TRƯỚC khi kiểm busy (để biết đang nói tới MST nào).
  const search = server.slice(server.indexOf("url.pathname === '/api/search'"), server.indexOf("url.pathname === '/api/stream'"));
  assert.ok(search.includes('const input = await readBody(req);'), 'phải đọc body để lấy mst');
  assert.ok(search.includes("const target = engineOf(String(input.mst || '').trim());"), 'phải chọn engine theo mst');
  assert.ok(search.includes('await target.search(input, output)'), 'phải chạy trên engine của MST đó');
  assert.ok(!search.includes('await engine.search('), 'không được dùng engine toàn cục nữa');
  const stream = server.slice(server.indexOf("url.pathname === '/api/stream'"), server.indexOf("url.pathname === '/api/export-excel'"));
  assert.ok(stream.includes("const target = engineOf(String(input.mst || '').trim());"), 'tải cuốn chiếu cũng phải theo mst');
  assert.ok(stream.includes('await target.stream(requested, output)'), 'phải chạy trên engine của MST đó');
  for (const name of ['/api/download', '/api/resume', '/api/export-excel']) {
    assert.ok(server.includes(`url.pathname === '${name}'`), `thiếu ${name}`);
  }
  assert.equal((server.match(/const target = engineOf\(String\(\(await readBody\(req\)\)\.mst/g) || []).length, 3, 'download/resume/export-excel đều phải nhận mst');
});

test('server: ensureIdle chỉ kiểm tra engine của ĐÚNG MST đích', () => {
  const server = read('src/server.js');
  assert.ok(server.includes('function ensureIdle(mst = selected) {'), 'phải còn ensureIdle(mst)');
  assert.ok(server.includes('const target = engineFor(mst);'), 'phải lấy engine của MST đích');
  assert.ok(!server.includes('const target = engineFor(mst) || engine;'), 'KHÔNG được rơi về engine của MST đang chọn');
  assert.ok(server.includes('MST ${mst} đang chạy tác vụ'), 'thông báo phải nói rõ MST nào đang chạy');
});

test('nền móng song song theo MST đã có (để mỗi luồng thật sự độc lập)', () => {
  const server = read('src/server.js');
  assert.ok(server.includes('const engines = new Map()'), 'mỗi MST một engine riêng');
  assert.ok(server.includes("const browser = new TaxBrowser(dataDir)"), 'cửa sổ Chrome là tài nguyên DÙNG CHUNG duy nhất');
  const tct = read('src/tct-api.js');
  assert.ok(tct.includes('const jars = new Map()'), 'kho cookie tách theo MST');
  const pool = read('src/data/sync-pool.js');
  assert.ok(pool.includes('concurrency'), 'bể song song theo MST đã có');
  assert.ok(read('src/index.html').includes('id="sync-all"'), 'nút Đồng bộ tất cả đã có');
});
