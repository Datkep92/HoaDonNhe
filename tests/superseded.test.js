'use strict';
// ---------------------------------------------------------------------------
// Trạng thái hoá đơn (tthai) đi từ kết quả tra cứu vào kho dữ liệu.
//
// XML KHÔNG mang trạng thái, nên engine ghi MST-<mst>/trang-thai-hoa-don.json (ĐỦ 1..6) và bộ
// nhập đọc file đó rồi lưu vào cột invoices.tthai.
//
// Hoá đơn bị thay thế / bị điều chỉnh / đã huỷ VẪN NẰM TRONG KHO (bản trước xoá hẳn) — chỉ không
// cộng vào danh sách hàng hoá và tổng tiền, và trạng thái đổi thì kho phải cập nhật lại.
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { runImport } = require('../src/data/xml-import');
const { readStates, STATE_FILE, LEGACY_SUPERSEDED_FILE } = require('../src/data/xml-scanner');
const queries = require('../src/data/queries');

const MST = '0312345678';
const OTHER = '0100000001';

// Cùng fixture với các test khác: XML tối thiểu, sinh tại chỗ (không dùng dữ liệu thật).
const xml = (shDon, seller, buyer) => `<HDon><DLHDon Id="X"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn GTGT</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TNT</KHHDon><SHDon>${shDon}</SHDon><NLap>2026-09-21</NLap></TTChung><NDHDon><NBan><Ten>Bên bán ví dụ</Ten><MST>${seller}</MST></NBan><NMua><Ten>Bên mua ví dụ</Ten><MST>${buyer}</MST></NMua><DSHHDVu><HHDVu><STT>1</STT><MHHDVu>MH1</MHHDVu><THHDVu>Hàng ví dụ</THHDVu><DVTinh>Chai</DVTinh><SLuong>2.000000</SLuong><DGia>1000.000000</DGia><ThTien>2000.000000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu></NDHDon><TToan><TgTCThue>2000.000000</TgTCThue><TgTThue>200.000000</TgTThue><TgTTTBSo>2200.000000</TgTTTBSo></TToan></DLHDon></HDon>`;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-state-'));

test('readStates: đọc file mới, gộp file bản cũ (tthai = 4), bỏ giá trị rác, file hỏng coi như rỗng', () => {
  const dir = tempDir();
  try {
    assert.equal(readStates(dir).size, 0, 'chưa có file ⇒ rỗng');

    // File của BẢN CŨ: mảng khoá trần hoặc { keys } ⇒ mọi khoá là '4'.
    fs.writeFileSync(path.join(dir, LEGACY_SUPERSEDED_FILE), JSON.stringify(['a|1|X|1']));
    assert.deepEqual([...readStates(dir)], [['a|1|X|1', '4']], 'file cũ ⇒ tthai 4');
    fs.writeFileSync(path.join(dir, LEGACY_SUPERSEDED_FILE), JSON.stringify({ updatedAt: 'x', keys: ['b|1|Y|2'] }));
    assert.deepEqual([...readStates(dir)], [['b|1|Y|2', '4']], 'dạng { keys }');

    // File mới ghi đè giá trị của file cũ (cùng khoá) và thêm khoá mới.
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ states: { 'b|1|Y|2': '2', 'c|1|Z|3': '6' } }));
    assert.deepEqual([...readStates(dir)], [['b|1|Y|2', '2'], ['c|1|Z|3', '6']], 'file mới thắng file cũ');

    // Giá trị ngoài 1..6 bị bỏ qua, không làm hỏng cả file.
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ states: { 'd|1|W|4': '9', 'e|1|V|5': '1' } }));
    assert.deepEqual([...readStates(dir)], [['b|1|Y|2', '4'], ['e|1|V|5', '1']], 'chỉ nhận 1..6');

    fs.writeFileSync(path.join(dir, STATE_FILE), '{ hong');
    assert.deepEqual([...readStates(dir)], [['b|1|Y|2', '4']], 'JSON hỏng ⇒ bỏ qua file mới, không ném lỗi');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hoá đơn bị thay thế: VẪN vào kho, lưu tthai = 4, KHÔNG cộng vào hàng hoá và tổng tiền', async () => {
  const root = tempDir();
  try {
    const dir = path.join(root, `MST-${MST}`);
    fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'giu.xml'), xml('00000001', OTHER, MST));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'bo.xml'), xml('00000002', OTHER, MST));

    // Lượt đầu: chưa biết trạng thái ⇒ tthai = null (KHÔNG đoán là '1'), cả hai vào kho.
    const first = await runImport({ output: root, mst: MST });
    assert.equal(first.scan.imported, 2);
    assert.equal(first.invoices, 2);
    assert.equal(first.items, 2);

    // Cổng thuế báo hoá đơn số 2 "Đã bị thay thế" ⇒ engine ghi sổ trạng thái.
    const supersededKey = `${OTHER}|1|C26TNT|2`;
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ updatedAt: new Date().toISOString(), states: { [supersededKey]: '4' } }));

    // File XML KHÔNG đổi, nhưng trạng thái đổi ⇒ bộ nhập phải nhận ra và cập nhật lại.
    const second = await runImport({ output: root, mst: MST });
    assert.equal(second.invoices, 2, 'hoá đơn bị thay thế VẪN nằm trong kho (bản trước xoá hẳn)');
    assert.equal(second.items, 2, 'dòng hàng vẫn còn');
    assert.equal(second.scan.inactive, 1, 'đếm được 1 file thuộc hoá đơn không còn hiệu lực');

    const db = openDatabase(path.join(dir, 'data.db'));
    try {
      const bo = db.prepare('SELECT tthai FROM invoices WHERE invoice_key = ?').get(supersededKey);
      assert.equal(bo.tthai, '4', 'trạng thái đổi được ghi lại dù file XML không đổi');
      const giu = db.prepare('SELECT tthai FROM invoices WHERE invoice_key = ?').get(`${OTHER}|1|C26TNT|1`);
      assert.equal(giu.tthai, null, 'không có trong sổ trạng thái ⇒ null, KHÔNG tự điền 1');

      // Hàng hoá gộp theo (mã + tên + ĐVT + thuế suất) nên 2 hoá đơn cùng mặt hàng ra MỘT dòng —
      // kiểm bằng SỐ LƯỢNG CỘNG, không phải số dòng.
      assert.equal(queries.products(db, {}).rows[0].tong_so_luong, 2, 'hàng hoá chỉ còn của hoá đơn hiệu lực');
      const s = queries.summary(db);
      assert.equal(s.invoices, 2, 'vẫn đếm đủ số hoá đơn trong kho');
      assert.equal(s.inactive, 1, 'báo rõ có 1 hoá đơn không còn hiệu lực');
      assert.equal(s.tax, 200, 'tổng tiền thuế chỉ cộng hoá đơn còn hiệu lực');
      assert.equal(s.taxInactive, 200, 'phần bị loại trừ được báo riêng, không im lặng bỏ');
    } finally { closeDatabase(db); }

    // Quét lại khi trạng thái không đổi: không nhân bản, không tạo thêm gì.
    const third = await runImport({ output: root, mst: MST });
    assert.equal(third.invoices, 2, 'quét lại vẫn đủ 2');
    assert.equal(third.scan.imported + third.scan.updated, 0, 'trạng thái đứng yên ⇒ bỏ qua, không ghi lại');

    // Trạng thái đổi lần nữa (bị điều chỉnh) cũng phải cập nhật được.
    fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ states: { [supersededKey]: '5' } }));
    await runImport({ output: root, mst: MST });
    const after = openDatabase(path.join(dir, 'data.db'));
    try { assert.equal(after.prepare('SELECT tthai FROM invoices WHERE invoice_key = ?').get(supersededKey).tthai, '5'); }
    finally { closeDatabase(after); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('không có sổ trạng thái: bộ nhập giữ nguyên hành vi cũ (tthai null, không loại trừ gì)', async () => {
  const root = tempDir();
  try {
    const dir = path.join(root, `MST-${MST}`);
    fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), xml('00000001', OTHER, MST));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'b.xml'), xml('00000002', OTHER, MST));
    const only = await runImport({ output: root, mst: MST });
    assert.equal(only.scan.inactive || 0, 0);
    assert.equal(only.invoices, 2, 'không có sổ trạng thái ⇒ nhập đủ 2');

    const db = openDatabase(path.join(dir, 'data.db'));
    try {
      // Thiếu dữ liệu trạng thái KHÔNG được coi là mất hiệu lực — nếu không, mọi hoá đơn nhập
      // trước khi có tính năng này sẽ bị loại oan khỏi hàng hoá và tổng tiền.
      assert.equal(queries.products(db, {}).rows[0].tong_so_luong, 4, 'chưa biết trạng thái ⇒ vẫn tính đủ vào hàng hoá');
      assert.equal(queries.summary(db).tax, 400, 'chưa biết trạng thái ⇒ vẫn cộng vào tổng');
    } finally { closeDatabase(db); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
