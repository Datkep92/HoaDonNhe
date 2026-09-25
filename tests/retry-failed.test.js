'use strict';
// ---------------------------------------------------------------------------
// HOÁ ĐƠN LỖI TẢI phải được XỬ LÝ, không bị bỏ quên.
//
// Lỗi thật: một lượt tải xong vẫn còn hoá đơn `failed` (mạng chập / cổng thuế bận) nhưng engine
// chỉ báo "xong", và trường `failed` còn không được trả ra ngoài (log/sync.json/UI đều không thấy).
// Với luật "một ngày một lần", lỗi đó bị bỏ tới hôm sau.
//
// Test này khoá ĐÚNG hành vi: `retryFailed()` thử lại CHỈ những hoá đơn lỗi, và không tải lại
// những cái đã thành công.
// Không gọi mạng: `request` là hàm giả.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/core');

const MST = '0123456789';
const account = { key: `${MST}|user`, mst: MST, label: 'user' };
const params = { from: '2026-01-01', to: '2026-01-31', direction: 'sold', family: 'query', formats: ['xml'], status: '' };

const invoice = n => ({ shdon: String(n), nbmst: MST, khhdon: 'C26TAA', khmshdon: '1', tthai: 1, family: 'query', direction: 'sold' });
const page = datas => Buffer.from(JSON.stringify({ datas, total: datas.length }));

// XML hợp lệ và khớp bộ nhận diện của hoá đơn (SHDon/KHHDon/KHMSHDon) để bước kiểm tra không đánh trượt.
const xmlFor = n => Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon>'
  + `<SHDon>${n}</SHDon><NLap>2026-01-05</NLap></TTChung><NDHDon><NBan><Ten>NCC</Ten><MST>${MST}</MST></NBan>`
  + '<NMua><HVTNMHang>Khach le</HVTNMHang></NMua><DSHHDVu><HHDVu><TChat>1</TChat><STT>1</STT><MHHDVu>MH1</MHHDVu>'
  + '<THHDVu>Hang</THHDVu><DVTinh>cai</DVTinh><SLuong>1</SLuong><DGia>1000</DGia><ThTien>1000</ThTien><TSuat>10%</TSuat>'
  + '</HHDVu></DSHHDVu></NDHDon><TToan><TgTCThue>1000</TgTCThue><TgTThue>100</TgTThue><TgTTTBSo>1100</TgTTTBSo></TToan>'
  + '</DLHDon></HDon>', 'utf8');

function setup(t, handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { store: path.join(dir, 'job.json'), identity: async () => account, request: handler, emit: () => {}, pdf: async () => Buffer.from('%PDF'), excel: async () => Buffer.from('PK') };
  return { dir, engine: new Engine(options) };
}

test('retryFailed: thử lại ĐÚNG hoá đơn lỗi và không tải lại cái đã xong', async t => {
  let xmlCalls = 0;
  let failFirst = 1; // cho lần gọi export-xml ĐẦU TIÊN lỗi (loại thử lại được)
  const { dir, engine } = setup(t, async route => {
    if (!String(route).includes('export-xml')) return page([invoice(1), invoice(2)]);
    xmlCalls += 1;
    if (failFirst > 0) { failFirst -= 1; throw new Error('timeout khi tải XML'); }
    // Đọc ĐÚNG tham số `shdon` — không dùng includes('shdon=1') vì `khmshdon=1` cũng chứa chuỗi đó.
    const shdon = new URLSearchParams(String(route).split('?')[1] || '').get('shdon');
    return xmlFor(shdon);
  });

  await engine.search(params, dir);
  await engine.resume(true);

  const failed = engine.job.items.filter(x => x.state === 'failed');
  assert.equal(failed.length, 1, 'một hoá đơn phải ở trạng thái lỗi');
  assert.equal(failed[0].retryable, true, 'lỗi timeout phải được đánh dấu là còn thử lại được');
  assert.equal(engine.job.stats.failed, 1, 'stats.failed phải đếm đúng (đây là con số bị nuốt trước đây)');
  assert.ok(engine.job.items.some(x => x.state === 'done'), 'hoá đơn còn lại vẫn tải xong');
  const afterFirstPass = xmlCalls;

  // Đây là bước trước đây KHÔNG có.
  await engine.retryFailed();
  assert.equal(engine.job.stats.failed, 0, 'thử lại phải xử lý hết hoá đơn lỗi');
  assert.equal(engine.job.items.filter(x => x.state === 'failed').length, 0);
  assert.ok(engine.job.items.every(x => ['done', 'skipped'].includes(x.state)), 'tất cả đều xong');
  assert.equal(xmlCalls, afterFirstPass + 1, 'chỉ gọi thêm ĐÚNG một lần — không tải lại hoá đơn đã xong');
});

test('retryFailed: hoá đơn XML hỏng (không thử lại được) vẫn lỗi, không kéo dài vô ích', async t => {
  const { dir, engine } = setup(t, async route => {
    if (!String(route).includes('export-xml')) return page([invoice(1)]);
    throw new Error('API không trả XML hợp lệ.'); // classifyDownloadError ⇒ invalid_xml, retryable = false
  });
  await engine.search(params, dir);
  await engine.resume(true);
  assert.equal(engine.job.items[0].retryable, false, 'lỗi XML hỏng không phải loại thử lại được');
  await engine.retryFailed();
  assert.equal(engine.job.items[0].state, 'failed', 'vẫn lỗi — thử lại không cứu được file hỏng');
});

test('retryFailed: không còn hoá đơn lỗi thì không gọi cổng thuế lần nào', async t => {
  let xmlCalls = 0;
  const { dir, engine } = setup(t, async route => {
    if (!String(route).includes('export-xml')) return page([invoice(1)]);
    xmlCalls += 1;
    return xmlFor('1');
  });
  await engine.search(params, dir);
  await engine.resume(true);
  const calls = xmlCalls;
  await engine.retryFailed();
  assert.equal(xmlCalls, calls, 'không có gì lỗi thì không được gọi thêm');
});

test('server: có bước thử lại (chỉ khi lỗi còn thử được) và BÁO CÁO lỗi tải ra ngoài', () => {
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const server = read('src/server.js');
  assert.ok(server.includes('await syncEngine.retryFailed()'), 'thiếu bước thử lại sau lượt tải');
  assert.ok(server.includes('item.retryable))'), 'chỉ thử lại khi lỗi thuộc loại còn thử được');
  assert.ok(server.includes('failed: stats.failed || 0'), 'phải trả số hoá đơn lỗi TẢI ra ngoài');
  assert.ok(server.includes('failedToday: (state.buy.failed || 0)'), 'phải gửi lỗi tải ra giao diện');
  const autoSync = read('src/data/auto-sync.js');
  assert.ok(autoSync.includes('failed: result.failed || 0'), 'phải ghi số lỗi tải vào sync.json');
  assert.ok(autoSync.includes('lỗi tải ${result.failed || 0}'), 'log phải phân biệt lỗi NHẬP và lỗi TẢI');
  const core = read('src/core.js');
  assert.ok(core.includes('async retryFailed()'), 'engine phải có retryFailed()');
  assert.ok(core.includes("await this.download({ incremental: true, finalize: true })"), 'thử lại phải dùng incremental để chỉ chạy hoá đơn lỗi');
  const renderer = read('src/renderer.js');
  assert.ok(renderer.includes('HĐ lỗi tải'), 'dòng MST phải hiện số hoá đơn lỗi tải');
});
