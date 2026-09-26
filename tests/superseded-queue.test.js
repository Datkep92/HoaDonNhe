'use strict';
// ---------------------------------------------------------------------------
// Mọi trạng thái hoá đơn đều được TẢI VỀ và trạng thái được ghi lại để kho phân loại.
//
// Bản trước chặn tthai = 4 khỏi lượt tra cứu/tải. Nay KHÔNG chặn: hoá đơn bị thay thế / bị điều
// chỉnh / đã huỷ vẫn tải về bình thường, và engine ghi MST-<mst>/trang-thai-hoa-don.json ĐỦ cả 6
// trạng thái để bộ nhập lưu vào cột invoices.tthai (xem tests/superseded.test.js).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-state-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { store: path.join(dir, 'job.json'), identity: async () => account, request, emit: () => {}, pdf: async () => Buffer.from('%PDF'), excel: async () => Buffer.from('PK') };
  return { dir, options, engine: new Engine(options) };
}

const invoice = n => ({ shdon: String(n), nbmst: '0123456789', khhdon: 'C26TAA', khmshdon: '1', tthai: 1 });
const page = datas => Buffer.from(JSON.stringify({ datas, total: datas.length }));
const stateFile = dir => path.join(dir, 'MST-0123456789', 'trang-thai-hoa-don.json');
const legacyFile = dir => path.join(dir, 'MST-0123456789', 'hoa-don-bi-thay-the.json');
const readStates = dir => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')).states;

test('KHÔNG chặn trạng thái nào: hoá đơn bị thay thế vẫn vào lượt tải và được ghi trạng thái', async t => {
  const { dir, engine } = setup(t, async () => page([invoice(1), { ...invoice(2), tthai: 4 }, invoice(3)]));
  await engine.search(params, dir);
  assert.deepEqual(engine.job.items.map(item => item.invoice.shdon), ['1', '2', '3'], 'tải về HẾT, không loại trạng thái nào');
  assert.deepEqual(readStates(dir), {
    '0123456789|1|C26TAA|1': '1',
    '0123456789|1|C26TAA|2': '4',
    '0123456789|1|C26TAA|3': '1',
  }, 'ghi đủ trạng thái của mọi hoá đơn, đúng khoá tầng dữ liệu');
});

test('sổ trạng thái ghi được ĐỦ cả 6 trạng thái', async t => {
  const datas = [1, 2, 3, 4, 5, 6].map(n => ({ ...invoice(n), tthai: n }));
  const { dir, engine } = setup(t, async () => page(datas));
  await engine.search(params, dir);
  assert.deepEqual(readStates(dir), {
    '0123456789|1|C26TAA|1': '1',
    '0123456789|1|C26TAA|2': '2',
    '0123456789|1|C26TAA|3': '3',
    '0123456789|1|C26TAA|4': '4',
    '0123456789|1|C26TAA|5': '5',
    '0123456789|1|C26TAA|6': '6',
  }, 'đủ 1..6 — không chỉ riêng trạng thái bị thay thế');
});

test('lọc theo ô "Trạng thái hóa đơn" vẫn hoạt động (chỉ lấy đúng trạng thái đã chọn)', async t => {
  const { dir, engine } = setup(t, async () => page([invoice(1), { ...invoice(2), tthai: 4 }, { ...invoice(3), tthai: 6 }]));
  await engine.search({ ...params, status: '4' }, dir);
  assert.deepEqual(engine.job.items.map(item => item.invoice.shdon), ['2'], 'chọn trạng thái 4 ⇒ chỉ lấy hoá đơn 2');
  // Vẫn ghi trạng thái của MỌI hoá đơn cổng trả về — kể cả cái bị bộ lọc loại khỏi lượt tải.
  assert.deepEqual(Object.keys(readStates(dir)).sort(), ['0123456789|1|C26TAA|1', '0123456789|1|C26TAA|2', '0123456789|1|C26TAA|3']);
});

test('ghi KIỂU GỘP: khoá của lượt trước không bị xoá, khoá trùng thì lấy giá trị mới', async t => {
  const { dir, engine } = setup(t, async () => page([{ ...invoice(2), tthai: 4 }]));
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  fs.writeFileSync(stateFile(dir), JSON.stringify({ updatedAt: 'x', states: { '0123456789|1|C26TAA|9': '6', '0123456789|1|C26TAA|2': '1' } }));
  await engine.search(params, dir);
  assert.deepEqual(readStates(dir), {
    '0123456789|1|C26TAA|9': '6', // khoá cũ còn nguyên
    '0123456789|1|C26TAA|2': '4', // khoá trùng ⇒ giá trị MỚI thắng
  });
});

test('file của bản cũ (hoa-don-bi-thay-the.json) được nạp tiếp với tthai = 4 khi ghi sổ mới', async t => {
  const { dir, engine } = setup(t, async () => page([invoice(1)]));
  fs.mkdirSync(path.dirname(legacyFile(dir)), { recursive: true });
  fs.writeFileSync(legacyFile(dir), JSON.stringify({ updatedAt: 'x', keys: ['0123456789|1|C26TAA|77'] }));
  await engine.search(params, dir);
  const states = readStates(dir);
  assert.equal(states['0123456789|1|C26TAA|77'], '4', 'không mất dấu hoá đơn bản cũ đã đánh dấu');
  assert.equal(states['0123456789|1|C26TAA|1'], '1', 'và vẫn ghi được trạng thái của lượt này');
});
