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
  // else { pending = true; selectingMst = ... } — nhánh UI ngắn giữ `pending` (kèm ghi nhớ MST vừa
  // bấm cho hiệu ứng chọn tức thì; selectingMst chỉ để VẼ, không chặn bấm — xem ui-wiring.test.js).
  assert.ok(renderer.includes('else { pending = true;'), 'chỉ yêu cầu UI ngắn mới giữ `pending`');
  // Tải hóa đơn là một đường dài. Từ 1.1.2 chỉ còn MỘT nút (#download-btn) thay cho
  // #search + #stream-download + #resume, nên "Tải tiếp" cũng đi qua đường dài này.
  assert.ok(renderer.includes('}, { long: true });'), 'tải hóa đơn phải được đánh dấu là tác vụ dài');
  assert.ok(renderer.includes("runLookup('/api/download')"), 'nút tải phải gọi /api/download');
  assert.ok(!renderer.includes("/api/resume"), 'không còn gọi /api/resume từ giao diện (đã gộp vào /api/download)');
});

test('UI: gửi kèm `mst` cho tra cứu để server chạy đúng luồng', () => {
  const renderer = read('src/renderer.js');
  assert.ok(renderer.includes("await work(url, { mst: current.selected,"), 'tra cứu/tải phải nói rõ MST nào');
});

test('server: endpoint thủ công chạy ĐÚNG engine của MST được yêu cầu', () => {
  const server = read('src/server.js');
  assert.ok(server.includes('function engineOf(mst)'), 'phải có engineOf(mst)');
  assert.ok(server.includes('function ensureEngineFor(mst)'), 'phải có ensureEngineFor(mst) — tự dựng engine khi chưa có');
  // /api/search và /api/stream phải đọc body TRƯỚC khi kiểm busy (để biết đang nói tới MST nào).
  const search = server.slice(server.indexOf("url.pathname === '/api/search'"), server.indexOf("url.pathname === '/api/stream'"));
  assert.ok(search.includes('const input = await readBody(req);'), 'phải đọc body để lấy mst');
  assert.ok(search.includes('const target = ensureEngineFor(input.mst);'), 'phải chọn engine theo mst');
  assert.ok(search.includes('await target.search(input, output)'), 'phải chạy trên engine của MST đó');
  assert.ok(!search.includes('await engine.search('), 'không được dùng engine toàn cục nữa');
  const stream = server.slice(server.indexOf("url.pathname === '/api/stream'"), server.indexOf("url.pathname === '/api/export-excel'"));
  assert.ok(stream.includes('const target = ensureEngineFor(input.mst);'), 'tải cuốn chiếu cũng phải theo mst');
  assert.ok(stream.includes('await target.stream(requested, output)'), 'phải chạy trên engine của MST đó');
  for (const name of ['/api/download', '/api/resume', '/api/export-excel']) {
    assert.ok(server.includes(`url.pathname === '${name}'`), `thiếu ${name}`);
  }
  // /api/download là đường DUY NHẤT của nút tải: phải đọc body TRƯỚC khi kiểm busy (để biết
  // đang nói tới MST nào — nếu không thì bấm Ngưng nhầm sang MST đang chọn).
  const download = server.slice(server.indexOf("url.pathname === '/api/download'"), server.indexOf("url.pathname === '/api/resume'"));
  assert.ok(download.includes('const input = await readBody(req);'), '/api/download phải đọc body để lấy mst');
  assert.ok(download.includes('const target = ensureEngineFor(input.mst);'), '/api/download phải chọn engine theo mst');
  assert.ok(download.includes('if (target.busy) { target.pause();'), 'đang chạy thì bấm nút = dừng, phải xử lý ở server');
  // Ba việc của nút: dừng / chạy tiếp lượt dở / chạy lượt mới.
  assert.ok(download.includes('isResumableJob(currentJob)'), 'phải nhận ra lượt còn dở để chạy tiếp');
  assert.ok(download.includes('await target.resume(true)'), 'nhánh chạy tiếp phải resume');
  assert.ok(download.includes('await target.stream(requested, output)'), 'nhánh chạy mới phải stream');
  assert.ok(!download.includes('await engine.stream('), 'không được dùng engine toàn cục');
  assert.equal((server.match(/const target = engineOf\(String\(\(await readBody\(req\)\)\.mst/g) || []).length, 2, 'resume/export-excel đều phải nhận mst');
});

test('REGRESSION: mở lại app thì bấm Tải hóa đơn phải chạy được, không bắt bấm lại MST', () => {
  // Lỗi thật đã gặp: `engines` chỉ có phần tử sau createEngine(), mà createEngine() trước đây chỉ
  // chạy khi bấm chọn MST / đăng nhập. Mở lại app thì `selected` lấy lại từ accounts.json và phiên
  // được restoreSession() — nhưng KHÔNG engine nào tồn tại. Bấm "Tải hóa đơn" ⇒ engineOf() null ⇒
  // toast "Chọn MST và kiểm tra phiên trước." dù người dùng đã bấm MST và phiên vốn còn.
  const server = read('src/server.js');
  // ensureEngineFor phải tự dựng, không chỉ đọc map.
  const fn = server.slice(server.indexOf('function ensureEngineFor(mst)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/if \(!engines\.has\(wanted\)\) createEngine\(wanted\);/.test(body), 'phải tự tạo engine khi MST chưa có');
  assert.ok(body.includes('engineFor(wanted)'), 'phải trả engine vừa tạo');
  // Cả ba đường gọi tay phải dùng nó.
  for (const name of ['/api/search', '/api/stream', '/api/download']) {
    const at = server.indexOf(`url.pathname === '${name}'`);
    assert.ok(at > 0, `không tìm thấy route ${name}`);
    // Cửa sổ 1400 ký tự: đủ quãng từ route tới chỗ chọn engine (route này còn có phần chờ phiên,
    // kiểm tra thư mục, dừng lượt đang chạy phía trước).
    assert.ok(server.slice(at, at + 1400).includes('ensureEngineFor(input.mst)'), `${name} phải dùng ensureEngineFor`);
  }
});

test('server: tra cứu/tải TRẢ LỜI NGAY — tác vụ chạy nền, app tắt vẫn tạm dừng đúng lượt', () => {
  // Bấm là UI có phản hồi: server trả snapshot ngay, tác vụ dài chạy nền (fire-and-forget có sổ sách).
  const server = read('src/server.js');
  assert.ok(server.includes('function runDetached(target, jobId, label, fn)'), 'phải có runDetached');
  // Regex cũng khớp đúng dòng khai báo hàm — bỏ khai báo ra trước khi đếm.
  // 5 lời gọi của các endpoint (search / stream / resume) + 2 nhánh của /api/download (chạy
  // tiếp lượt dở + chạy lượt mới) + 1 lời gọi của LƯỢT QUÉT LẦN ĐẦU cho MST mới thêm
  // (maybeFirstScan). Lượt quét đó CŨNG phải chạy nền và CŨNG phải nằm trong sổ
  // detachedTasks, để thoát app là tạm dừng đúng lượt thay vì cắt ngang giữa lúc đang tải.
  // Nhánh DỪNG của /api/download cố tình không dùng runDetached: pause là thao tác tức thì
  // (engine.pause() chỉ đặt cờ hủy), không phải tác vụ dài — xem mst-lanes "bấm Ngưng tới
  // được nhánh dừng" ở ui-wiring.test.js.
  // AI Agent adds one download entry point and must share the same shutdown tracking.
  assert.equal((server.replace('function runDetached(target, jobId, label, fn)', '').match(/runDetached\(target/g) || []).length, 7, 'search/stream/resume + 2 nhánh download + quét lần đầu + AI tải đều phải chạy nền');
  assert.ok(server.includes('for (const item of detachedTasks) { try { item.target.pause(); } catch {} }'), 'thoát app phải tạm dừng mọi tác vụ nền');
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
