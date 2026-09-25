'use strict';
// ---------------------------------------------------------------------------
// Hoá đơn cổng thuế báo "Đã bị thay thế" (tthai = 4) phải bị LOẠI khỏi kho dữ liệu.
//
// XML KHÔNG mang trạng thái hóa đơn, nên nguồn duy nhất biết được là kết quả tra cứu:
// engine ghi danh sách khoá vào MST-<mst>/hoa-don-bi-thay-the.json, bộ nhập đọc file đó
// để bỏ qua và DỌN những bản đã nhập trước đây.
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { runImport } = require('../src/data/xml-import');
const { readSuperseded, SUPERSEDED_FILE } = require('../src/data/xml-scanner');

const MST = '0312345678';
const OTHER = '0100000001';

// Cùng fixture với các test khác: XML tối thiểu, sinh tại chỗ (không dùng dữ liệu thật).
const xml = (shDon, seller, buyer) => `<HDon><DLHDon Id="X"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn GTGT</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TNT</KHHDon><SHDon>${shDon}</SHDon><NLap>2026-09-21</NLap></TTChung><NDHDon><NBan><Ten>Bên bán ví dụ</Ten><MST>${seller}</MST></NBan><NMua><Ten>Bên mua ví dụ</Ten><MST>${buyer}</MST></NMua><DSHHDVu><HHDVu><STT>1</STT><MHHDVu>MH1</MHHDVu><THHDVu>Hàng ví dụ</THHDVu><DVTinh>Chai</DVTinh><SLuong>2.000000</SLuong><DGia>1000.000000</DGia><ThTien>2000.000000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu></NDHDon><TToan><TgTCThue>2000.000000</TgTCThue><TgTThue>200.000000</TgTThue><TgTTTBSo>2200.000000</TgTTTBSo></TToan></DLHDon></HDon>`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-superseded-'));

test('readSuperseded: đọc được cả mảng trần lẫn { keys }, file hỏng coi như rỗng', () => {
  const dir = tempDir();
  try {
    assert.equal(readSuperseded(dir).size, 0, 'chưa có file ⇒ rỗng');
    fs.writeFileSync(path.join(dir, SUPERSEDED_FILE), JSON.stringify(['a|1|X|1']));
    assert.deepEqual([...readSuperseded(dir)], ['a|1|X|1'], 'mảng trần');
    fs.writeFileSync(path.join(dir, SUPERSEDED_FILE), JSON.stringify({ updatedAt: 'x', keys: ['b|1|Y|2'] }));
    assert.deepEqual([...readSuperseded(dir)], ['b|1|Y|2'], 'dạng { keys }');
    fs.writeFileSync(path.join(dir, SUPERSEDED_FILE), '{ hong');
    assert.equal(readSuperseded(dir).size, 0, 'JSON hỏng ⇒ rỗng, không ném lỗi');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hoá đơn bị thay thế: bộ nhập BỎ QUA và DỌN bản đã nhập trước đó (kèm dòng hàng)', async () => {
  const root = tempDir();
  try {
    const dir = path.join(root, `MST-${MST}`);
    fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'giu.xml'), xml('00000001', OTHER, MST));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'bo.xml'), xml('00000002', OTHER, MST));

    // Lượt đầu: cả hai hoá đơn vào kho, mỗi hoá đơn 1 dòng hàng.
    const first = await runImport({ output: root, mst: MST });
    assert.equal(first.scan.imported, 2);
    assert.equal(first.invoices, 2);
    assert.equal(first.items, 2);

    // Cổng thuế báo hoá đơn số 2 "Đã bị thay thế" ⇒ engine ghi danh sách khoá.
    const supersededKey = `${OTHER}|1|C26TNT|2`;
    fs.writeFileSync(path.join(dir, SUPERSEDED_FILE), JSON.stringify({ updatedAt: new Date().toISOString(), keys: [supersededKey] }));

    const second = await runImport({ output: root, mst: MST });
    assert.equal(second.scan.superseded, 1, 'file của hoá đơn bị thay thế được đánh dấu loại');
    assert.equal(second.invoices, 1, 'bản đã nhập trước đó bị dọn khỏi kho');
    assert.equal(second.items, 1, 'dòng hàng xoá theo nhờ ON DELETE CASCADE');

    const db = openDatabase(path.join(dir, 'data.db'));
    try {
      const keys = db.prepare('SELECT invoice_key FROM invoices ORDER BY invoice_key').all().map(row => row.invoice_key);
      assert.deepEqual(keys, [`${OTHER}|1|C26TNT|1`], 'chỉ còn hoá đơn KHÔNG bị thay thế');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 1, 'index tìm kiếm cũng sạch theo');
    } finally { closeDatabase(db); }

    // Quét lại: file đã xử lý nên bỏ qua, hoá đơn bị thay thế KHÔNG quay trở lại kho.
    const third = await runImport({ output: root, mst: MST });
    assert.equal(third.invoices, 1, 'quét lại không làm bản bị thay thế quay về');
    assert.equal(third.scan.imported, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('không có danh sách bị thay thế: bộ nhập giữ nguyên hành vi cũ', async () => {
  const root = tempDir();
  try {
    const dir = path.join(root, `MST-${MST}`);
    fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), xml('00000001', OTHER, MST));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'b.xml'), xml('00000002', OTHER, MST));
    const only = await runImport({ output: root, mst: MST });
    assert.equal(only.scan.superseded || 0, 0);
    assert.equal(only.invoices, 2, 'không có marker ⇒ nhập đủ 2');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
