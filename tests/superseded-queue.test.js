'use strict';
// ---------------------------------------------------------------------------
// Hoá đơn cổng thuế báo "Đã bị thay thế" (tthai = 4) KHÔNG được vào lượt tra cứu/tải,
// nhưng engine phải ghi lại khoá để bộ nhập dọn khỏi kho dữ liệu (xem tests/superseded.test.js).
// Dùng cùng harness với tests/core.test.js (request giả, không gọi mạng).
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/core');

const account = { key: '123|user', mst: '0123456789', label: 'user' };
const params = { from: '2026-01-01', to: '2026-01-31', direction: 'sold', family: 'query', formats: ['xml'], status: '' };

function setup(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-superseded-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { store: path.join(dir, 'job.json'), identity: async () => account, request, emit: () => {}, pdf: async () => Buffer.from('%PDF'), excel: async () => Buffer.from('PK') };
  return { dir, options, engine: new Engine(options) };
}

const invoice = n => ({ shdon: String(n), nbmst: '0123456789', khhdon: 'C26TAA', khmshdon: '1', tthai: 1 });
const page = datas => Buffer.from(JSON.stringify({ datas, total: datas.length }));
const markerFile = dir => path.join(dir, 'MST-0123456789', 'hoa-don-bi-thay-the.json');
const readMarker = dir => JSON.parse(fs.readFileSync(markerFile(dir), 'utf8'));

test('tthai = 4 không vào lượt tải, nhưng được ghi vào danh sách để dọn kho', async t => {
  const { dir, engine } = setup(t, async () => page([invoice(1), { ...invoice(2), tthai: 4 }, invoice(3)]));
  await engine.search(params, dir);
  assert.deepEqual(engine.job.items.map(item => item.invoice.shdon), ['1', '3'], 'hoá đơn "Đã bị thay thế" bị loại khỏi lượt');
  assert.ok(fs.existsSync(markerFile(dir)), 'phải ghi danh sách hoá đơn bị thay thế');
  assert.deepEqual(readMarker(dir).keys, ['0123456789|1|C26TAA|2'], 'đúng khoá tầng dữ liệu của hoá đơn số 2');
});

test('chọn ĐÚNG trạng thái "Đã bị thay thế" thì vẫn lấy về và KHÔNG ghi danh sách dọn', async t => {
  const { dir, engine } = setup(t, async () => page([{ ...invoice(2), tthai: 4 }]));
  await engine.search({ ...params, status: '4' }, dir);
  assert.deepEqual(engine.job.items.map(item => item.invoice.shdon), ['2'], 'người dùng chủ động chọn thì vẫn lấy');
  assert.equal(fs.existsSync(markerFile(dir)), false, 'không được ghi vào danh sách dọn');
});

test('ghi danh sách dọn kho KIỂU GỘP: khoá đã có trong file không bị xoá', async t => {
  const { dir, engine } = setup(t, async () => page([{ ...invoice(2), tthai: 4 }]));
  fs.mkdirSync(path.dirname(markerFile(dir)), { recursive: true });
  fs.writeFileSync(markerFile(dir), JSON.stringify({ updatedAt: 'x', keys: ['0123456789|1|C26TAA|9'] }));
  await engine.search(params, dir);
  assert.deepEqual(readMarker(dir).keys.slice().sort(), ['0123456789|1|C26TAA|2', '0123456789|1|C26TAA|9'], 'khoá cũ phải còn');
});
