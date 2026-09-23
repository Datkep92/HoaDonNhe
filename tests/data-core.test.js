'use strict';
// ---------------------------------------------------------------------------
// Test PHASE 1 – Data Core: schema, khoá hoá đơn, transaction, chống trùng, MST manager.
// Không gọi mạng, không cần cổng thuế. Chạy: npm test
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const data = require('../src/data');
const { openDatabase, closeDatabase, withTransaction, tableNames, schemaVersion, applySchema } = require('../src/data/sqlite');
const { insertInvoice, findInvoiceByKey, countInvoices, countItems, itemsOfInvoice, recordImportedFile, listInvoices, setSyncState, getSyncState } = require('../src/data/repository');
const { buildInvoiceKey, parseInvoiceKey, stripLeadingZeros } = require('../src/data/invoice-key');
const mstManager = require('../src/data/mst-manager');
const { runSelfCheck } = require('../src/data/self-check');

function withDatabase(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-data-core-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    return fn(db, dir);
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sampleRecord = (over = {}) => ({
  direction: 'BUY',
  mstBan: '4500222022',
  mstMua: '4500677693',
  tenBan: 'CÔNG TY TRÁCH NHIỆM HỮU HẠN THƯƠNG MẠI DỊCH VỤ TRÚC NGUYÊN',
  tenMua: 'CÔNG TY TNHH THƯƠNG MẠI DỊCH VỤ HƯNG THỊNH PHÁT NT',
  ngayLap: '2026-09-21',
  khmsHd: '1',
  khhHd: 'C26TNT',
  soHd: '00075757',
  loaiHoaDon: 'Hóa đơn giá trị gia tăng',
  tienTruocThue: 16960296,
  tienThue: 1356824,
  tongTien: 18317120,
  fileXml: 'C:/HoaDon/MST-4500677693/Mua_vao/4500222022_1_C26TNT_75757_43102b5029.xml',
  items: [
    { stt: 1, maHang: '1ORC01024', tenHang: 'DẦU THỰC VẬT HẢO HẠNG NHÃN HIỆU ORCHID 880ML', donVi: 'Chai', soLuong: 120, donGia: 31867.28, chietKhau: 0, thanhTien: 3824074, thueSuat: '8%', tienThue: null },
    { stt: 2, maHang: '1ORC01025', tenHang: 'DẦU THỰC VẬT HẢO HẠNG 1L', donVi: 'Chai', soLuong: 5, donGia: 50000, chietKhau: 0, thanhTien: 250000, thueSuat: '8%', tienThue: null },
  ],
  ...over,
});

test('khoá hoá đơn: bỏ số 0 đầu nên XML và API cho CÙNG một khoá', () => {
  const fromXml = buildInvoiceKey({ mstBan: '4500222022', khmshDon: '1', khhDon: 'C26TNT', shDon: '00075757' });
  const fromApi = buildInvoiceKey({ mstBan: '4500222022', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' });
  assert.equal(fromXml, '4500222022|1|C26TNT|75757');
  assert.equal(fromXml, fromApi, 'khoá từ XML phải trùng khoá từ API, nếu không sẽ tải trùng');
  assert.deepEqual(parseInvoiceKey(fromXml), { mstBan: '4500222022', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' });
  assert.equal(stripLeadingZeros('0000'), '0');
  assert.equal(stripLeadingZeros('C26TNT'), 'C26TNT');
  assert.equal(parseInvoiceKey('thieu|truong'), null);
  assert.throws(() => buildInvoiceKey({ mstBan: '4500222022', khmshDon: '1', khhDon: '', shDon: '75757' }), /Không đủ trường/);
});

test('khoá hoá đơn KHÔNG phụ thuộc tên file', () => {
  const a = buildInvoiceKey({ mstBan: '4500222022', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' });
  const b = buildInvoiceKey({ mstBan: '4500222022', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' });
  assert.equal(a, b);
  assert.ok(!a.includes('.xml'));
});

test('khoá hoá đơn GIỮ NGUYÊN số 0 đầu của MST (MST Việt Nam thường bắt đầu bằng 0)', () => {
  const key = buildInvoiceKey({ mstBan: '0100000001', khmshDon: '1', khhDon: 'C26TNT', shDon: '00075757' });
  assert.equal(key, '0100000001|1|C26TNT|75757');
  assert.notEqual(
    buildInvoiceKey({ mstBan: '0100000001', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' }),
    buildInvoiceKey({ mstBan: '100000001', khmshDon: '1', khhDon: 'C26TNT', shDon: '75757' }),
    'hai MST khác nhau không được cho cùng khoá',
  );
});

test('mở data.db: tạo đủ 4 bảng + index và đặt schema version', () => {
  withDatabase((db, dir) => {
    assert.equal(schemaVersion(db), 1);
    const names = tableNames(db);
    for (const table of ['imported_files', 'invoice_items', 'invoices', 'sync_state']) {
      assert.ok(names.includes(table), `thiếu bảng ${table}`);
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    for (const index of ['idx_invoice_key', 'idx_invoice_date', 'idx_invoice_direction', 'idx_invoice_sell_mst', 'idx_invoice_buy_mst', 'idx_invoice_number', 'idx_item_code', 'idx_item_invoice']) {
      assert.ok(indexes.includes(index), `thiếu index ${index}`);
    }
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.ok(fs.existsSync(path.join(dir, 'data.db')));
    // Mở lại lần hai: không tạo lại schema, không lỗi.
    assert.deepEqual(applySchema(db), { changed: false, version: 1 });
  });
});

test('ghi hoá đơn + dòng hàng trong một transaction', () => {
  withDatabase(db => {
    const result = insertInvoice(db, sampleRecord());
    assert.equal(result.inserted, true);
    assert.equal(result.itemsInserted, 2);
    assert.equal(result.invoiceKey, '4500222022|1|C26TNT|75757');
    assert.equal(countInvoices(db), 1);
    assert.equal(countItems(db), 2);
    const stored = findInvoiceByKey(db, '4500222022|1|C26TNT|75757');
    assert.equal(stored.direction, 'BUY');
    assert.equal(stored.so_hd, '00075757', 'so_hd giữ nguyên dạng trong XML');
    assert.equal(stored.tong_tien, 18317120);
    assert.ok(stored.file_xml.endsWith('.xml'));
    const items = itemsOfInvoice(db, stored.id);
    assert.equal(items.length, 2);
    assert.equal(items[0].ma_hang, '1ORC01024');
    assert.equal(items[0].ten_hang, 'DẦU THỰC VẬT HẢO HẠNG NHÃN HIỆU ORCHID 880ML');
    assert.equal(items[0].so_luong, 120);
  });
});

test('chống trùng: cùng khoá thì KHÔNG tạo record thứ hai (mục 19 lớp 4)', () => {
  withDatabase(db => {
    assert.equal(insertInvoice(db, sampleRecord()).inserted, true);
    const again = insertInvoice(db, { ...sampleRecord(), fileXml: 'C:/khac/ten-file-khac.xml', soHd: '75757' });
    assert.equal(again.inserted, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(countInvoices(db), 1);
    assert.equal(countItems(db), 2, 'không được ghi thêm dòng hàng cho bản trùng');
  });
});

test('transaction: lỗi giữa đường thì KHÔNG để lại dữ liệu nửa chừng (mục 45)', () => {
  withDatabase(db => {
    assert.throws(() => withTransaction(db, () => {
      db.prepare(`INSERT INTO invoices (invoice_key, direction, file_xml) VALUES (?, ?, ?)`).run('X|1|C26TNT|1', 'BUY', 'C:/x.xml');
      db.prepare(`INSERT INTO invoice_items (invoice_id, stt, ma_hang) VALUES (?, ?, ?)`).run(1, 1, 'MH1');
      throw new Error('lỗi giả lập giữa transaction');
    }), /lỗi giả lập/);
    assert.equal(countInvoices(db), 0);
    assert.equal(countItems(db), 0);
  });
});

test('dữ liệu sai bị chặn trước transaction nên không ghi gì', () => {
  withDatabase(db => {
    assert.throws(() => insertInvoice(db, sampleRecord({ items: [{ stt: 1, maHang: 'MH1', soLuong: {} }] })), /Giá trị số không hợp lệ/);
    assert.equal(countInvoices(db), 0);
    assert.throws(() => insertInvoice(db, sampleRecord({ direction: 'KHONG_BIET' })), /direction/);
    assert.throws(() => insertInvoice(db, sampleRecord({ fileXml: '' })), /file_xml/);
    assert.equal(countInvoices(db), 0);
  });
});

test('xoá hoá đơn thì dòng hàng bị xoá theo (ON DELETE CASCADE – mục 9)', () => {
  withDatabase(db => {
    insertInvoice(db, sampleRecord());
    const invoice = findInvoiceByKey(db, '4500222022|1|C26TNT|75757');
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
    assert.equal(countItems(db), 0);
  });
});

test('imported_files: theo dõi file XML đã xử lý (mục 10)', () => {
  withDatabase(db => {
    insertInvoice(db, sampleRecord({
      importedFile: { filePath: 'C:/HoaDon/MST-4500677693/Mua_vao/a.xml', fileName: 'a.xml', fileSize: 27102, status: 'imported' },
    }));
    const rows = db.prepare('SELECT * FROM imported_files').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].invoice_key, '4500222022|1|C26TNT|75757');
    assert.equal(rows[0].status, 'imported');
    assert.equal(rows[0].file_size, 27102);
    assert.ok(rows[0].import_time);
    assert.throws(() => recordImportedFile(db, {}), /file_path/);
  });
});

test('danh sách hoá đơn có phân trang (nền cho PHASE 3)', () => {
  withDatabase(db => {
    insertInvoice(db, sampleRecord({ soHd: '00000001', ngayLap: '2026-09-01' }));
    insertInvoice(db, sampleRecord({ soHd: '00000002', ngayLap: '2026-09-02' }));
    insertInvoice(db, sampleRecord({ soHd: '00000003', ngayLap: '2026-09-03' }));
    assert.equal(countInvoices(db), 3);
    const page1 = listInvoices(db, { limit: 2, offset: 0 });
    const page2 = listInvoices(db, { limit: 2, offset: 2 });
    assert.equal(page1.length, 2);
    assert.equal(page2.length, 1);
    assert.equal(page1[0].ngay_lap, '2026-09-03', 'sắp xếp ngày giảm dần');
    assert.equal(listInvoices(db, { direction: 'SELL' }).length, 0);
    assert.equal(listInvoices(db, { direction: 'BUY' }).length, 3);
  });
});

test('sync_state: đọc/ghi trạng thái đồng bộ (mục 11)', () => {
  withDatabase(db => {
    assert.equal(getSyncState(db, 'last_buy_sync'), null);
    setSyncState(db, 'last_buy_sync', { at: '2026-09-23T00:00:00Z', totalDownloaded: 5 });
    assert.deepEqual(getSyncState(db, 'last_buy_sync'), { at: '2026-09-23T00:00:00Z', totalDownloaded: 5 });
    setSyncState(db, 'status', 'idle');
    assert.equal(getSyncState(db, 'status'), 'idle');
  });
});

test('MST manager: tạo vùng dữ liệu MST với data.db + sync.json + 2 thư mục XML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-mst-'));
  try {
    const { dir, dbFile, syncFile, db } = mstManager.ensureMst({ output: root, mst: '4500677693' });
    try {
      assert.equal(path.basename(dir), 'MST-4500677693');
      assert.ok(fs.existsSync(dbFile));
      assert.ok(fs.existsSync(syncFile));
      for (const name of ['Mua_vao', 'Ban_ra']) assert.ok(fs.existsSync(path.join(dir, name)), `thiếu thư mục ${name}`);
      const state = mstManager.readSyncState(syncFile);
      assert.equal(state.buy.status, 'idle');
      assert.equal(state.sell.status, 'idle');
      assert.equal(schemaVersion(db), 1);
    } finally {
      closeDatabase(db);
    }
    // MST khác ⇒ vùng dữ liệu khác, không lẫn nhau (mục 5)
    const other = mstManager.ensureMst({ output: root, mst: '4500222022' });
    try {
      assert.notEqual(other.dir, dir);
      assert.ok(other.dir.endsWith('MST-4500222022'));
    } finally {
      closeDatabase(other.db);
    }
    assert.throws(() => mstManager.mstDirectory('', '4500677693'), /thư mục lưu/);
    assert.throws(() => mstManager.mstDirectory(root, ''), /MST/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bộ tự kiểm tra tầng dữ liệu (dùng cho EXE) chạy đúng', () => {
  const result = runSelfCheck();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.schema_version, 1);
  assert.equal(result.invoices, 1);
  assert.equal(result.items, 1);
  assert.equal(result.duplicate_blocked, true);
  assert.equal(result.invoice_key, '4500222022|1|C26TNT|75757');
});

test('điểm vào tầng dữ liệu xuất đúng các module con', () => {
  for (const key of ['invoiceKey', 'schema', 'sqlite', 'repository', 'mst']) {
    assert.ok(data[key], `thiếu ${key}`);
  }
  assert.equal(typeof data.repository.insertInvoice, 'function');
  assert.equal(typeof data.sqlite.openDatabase, 'function');
});
