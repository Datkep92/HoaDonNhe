'use strict';
// ---------------------------------------------------------------------------
// Xuất Excel "Kho dữ liệu" — mỗi chiều / mỗi loại đối tác nằm RIÊNG một sheet:
//   Hóa đơn mua vào | Hóa đơn bán ra | Hàng hóa mua vào | Hàng hóa bán ra | Nhà cung cấp | Khách hàng
// Kiểm tra cả việc tôn trọng bộ lọc đang xem (khoảng ngày + tìm kiếm dùng chung FTS5).
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../resources/xlsx.cjs');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');
const excelExport = require('../src/data/excel-export');

const { SHEET } = excelExport;
const MST = '0312345678';
const OTHER = '0100000001';

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-export-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try { return fn(db); } finally { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); }
}

const sample = (over = {}) => ({
  direction: 'BUY',
  mstBan: OTHER,
  mstMua: MST,
  tenBan: 'NHÀ CUNG CẤP VÍ DỤ',
  tenMua: 'CÔNG TY VÍ DỤ NGƯỜI MUA',
  ngayLap: '2026-09-21',
  khmsHd: '1',
  khhHd: 'C26TNT',
  soHd: '00000001',
  loaiHoaDon: 'Hóa đơn giá trị gia tăng',
  tongTien: 22000,
  fileXml: 'C:/x/a.xml',
  items: [{ stt: 1, maHang: 'MH1', tenHang: 'Hàng một', donVi: 'Chai', soLuong: 10, donGia: 1000, chietKhau: 0, thanhTien: 10000, thueSuat: '10%', tienThue: 1000 }],
  ...over,
});

function seed(db) {
  insertInvoice(db, sample());                                                                                       // BUY  01/09-21
  insertInvoice(db, sample({ soHd: '00000002', ngayLap: '2026-09-10' }));                                            // BUY  02/09-10
  insertInvoice(db, sample({ direction: 'SELL', soHd: '00006423', khhHd: 'C26MTH', ngayLap: '2026-09-23', mstBan: MST, mstMua: null, tenMua: 'Bán cho người tiêu dùng' })); // SELL 6423/09-23
}

const open = buffer => {
  const book = XLSX.read(buffer, { type: 'buffer' });
  return { names: book.SheetNames, rows: name => XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1 }) };
};

test('buildWorkbook: đủ 6 sheet riêng theo chiều/loại, đúng header và số dòng', () => {
  withDb(db => {
    seed(db);
    const { buffer, counts } = excelExport.buildWorkbook(db, {});
    const { names, rows } = open(buffer);
    assert.deepEqual(names, [SHEET.buy, SHEET.sell, SHEET.productsBuy, SHEET.productsSell, SHEET.suppliers, SHEET.buyers]);
    assert.equal(counts.buy, 2, 'hai hoá đơn mua vào');
    assert.equal(counts.sell, 1, 'một hoá đơn bán ra');
    assert.equal(counts.suppliers, 1, 'một nhà cung cấp');
    assert.equal(counts.buyers, 1, 'một khách hàng');
    assert.deepEqual(rows(SHEET.buy)[0], excelExport.INVOICE_HEADERS);
    assert.deepEqual(rows(SHEET.sell)[0], excelExport.INVOICE_HEADERS);
    assert.equal(rows(SHEET.buy).length, 3, 'header + 2 dòng');
    assert.equal(rows(SHEET.sell).length, 2, 'header + 1 dòng');
    assert.deepEqual(rows(SHEET.productsBuy)[0], excelExport.PRODUCT_HEADERS);
    assert.deepEqual(rows(SHEET.productsSell)[0], excelExport.PRODUCT_HEADERS, 'hai sheet hàng hóa cùng cấu trúc');
    assert.deepEqual(rows(SHEET.suppliers)[0], excelExport.PARTNER_HEADERS);
    assert.deepEqual(rows(SHEET.buyers)[0], excelExport.PARTNER_HEADERS, 'hai sheet đối tác cùng cấu trúc');
  });
});

test('mỗi sheet chỉ chứa ĐÚNG chiều/loại của nó (không trộn mua vào với bán ra)', () => {
  withDb(db => {
    seed(db);
    const { rows } = open(excelExport.buildWorkbook(db, {}).buffer);

    const buy = rows(SHEET.productsBuy);
    assert.equal(buy.length, 2, 'header + 1 mặt hàng mua vào');
    assert.equal(buy[1][4], 20, 'số lượng mua vào = 10 + 10 (gộp 2 hoá đơn)');
    const sell = rows(SHEET.productsSell);
    assert.equal(sell.length, 2, 'header + 1 mặt hàng bán ra');
    assert.equal(sell[1][4], 10, 'số lượng bán ra = 10 (chỉ 1 hoá đơn)');

    // Nhà cung cấp lấy từ mst người bán của hoá đơn MUA VÀO; khách hàng từ mst người mua của BÁN RA.
    const suppliers = rows(SHEET.suppliers).slice(1);
    assert.equal(suppliers.length, 1);
    assert.equal(suppliers[0][0], OTHER, 'MST nhà cung cấp');
    assert.equal(suppliers[0][2], 2, 'gộp 2 hoá đơn mua vào');
    const buyers = rows(SHEET.buyers).slice(1);
    assert.equal(buyers.length, 1);
    assert.equal(buyers[0][1], 'Bán cho người tiêu dùng', 'khách lẻ không có MST nên để trống cột MST');
    assert.equal(buyers[0][0], '', 'MST khách trống');
  });
});

test('xuất Excel tôn trọng bộ lọc đang xem: khoảng ngày và tìm kiếm (dùng chung FTS5)', () => {
  withDb(db => {
    seed(db);
    const ranged = open(excelExport.buildWorkbook(db, { from: '2026-09-15', to: '2026-09-30' }).buffer);
    assert.equal(ranged.rows(SHEET.buy).length, 2, 'chỉ còn HĐ 21/09 (header + 1)');
    assert.equal(ranged.rows(SHEET.sell).length, 2, 'HĐ bán 23/09 nằm trong khoảng');
    assert.equal(ranged.rows(SHEET.productsBuy).length, 2, 'chỉ còn mặt hàng của HĐ 21/09');
    // Đối tác là DANH BẠ: KHÔNG lọc theo kỳ (khớp tab Đối tác), nên vẫn gộp ĐỦ 2 hoá đơn mua vào.
    assert.equal(ranged.rows(SHEET.suppliers).length, 2, 'header + 1 nhà cung cấp');
    assert.equal(ranged.rows(SHEET.suppliers)[1][2], 2, 'gộp cả 2 hoá đơn mua vào, không chỉ hoá đơn trong kỳ');
    assert.equal(ranged.rows(SHEET.buyers).length, 2, 'header + 1 khách hàng');

    // "cong ty" không dấu vẫn khớp "CÔNG TY…" ⇒ chứng minh đi qua FTS như tab Danh sách.
    const searched = open(excelExport.buildWorkbook(db, { q: 'cong ty' }).buffer);
    assert.equal(searched.rows(SHEET.buy).length, 3, 'cả 2 HĐ mua vào có tên "CÔNG TY…"');
    assert.equal(searched.rows(SHEET.sell).length, 1, 'không HĐ bán nào khớp ⇒ chỉ còn header');
    assert.equal(searched.rows(SHEET.productsBuy).length, 1, 'q lọc theo MÃ/TÊN HÀNG nên "Hàng một" không khớp');
  });
});

test('sheet đối tác là DANH BẠ: đủ danh sách dù kỳ đang chọn không có hoá đơn nào', () => {
  withDb(db => {
    seed(db);
    // Khoảng 01–05/09 không có hoá đơn nào, nhưng tab Đối tác vẫn hiện NCC/Khách ⇒ file phải có.
    const empty = excelExport.buildWorkbook(db, { from: '2026-09-01', to: '2026-09-05' }).counts;
    assert.equal(empty.buy, 0, 'hoá đơn mua vào theo kỳ vẫn lọc');
    assert.equal(empty.suppliers, 1, 'nhà cung cấp KHÔNG bị lọc theo kỳ');
    assert.equal(empty.buyers, 1, 'khách hàng KHÔNG bị lọc theo kỳ');

    const ranged = excelExport.buildWorkbook(db, { from: '2026-09-15', to: '2026-09-30' }).counts;
    assert.equal(ranged.suppliers, 1, 'vẫn 1 nhà cung cấp, không phụ thuộc kỳ');
  });
});

test('xuất riêng từng bảng: chỉ đúng sheet được chọn, tên file có tên bảng', () => {
  withDb(db => {
    seed(db);
    const sellOnly = excelExport.buildWorkbook(db, {}, ['sell']);
    assert.deepEqual(open(sellOnly.buffer).names, [SHEET.sell], 'chỉ 1 sheet');
    assert.equal(sellOnly.counts.sell, 1);
    assert.equal('buy' in sellOnly.counts, false, 'không dựng sheet không được chọn');
    assert.match(excelExport.fileName(MST, new Date(2026, 8, 25, 14, 5), ['sell']), /^kho-du-lieu-sell-/);

    const suppliersOnly = excelExport.buildWorkbook(db, {}, ['suppliers']);
    assert.deepEqual(open(suppliersOnly.buffer).names, [SHEET.suppliers]);
    assert.equal(suppliersOnly.counts.suppliers, 1, 'nhà cung cấp đủ danh sách');

    // Mã bảng lạ bị bỏ qua; danh sách rỗng ⇒ quay về xuất tất cả.
    assert.equal(open(excelExport.buildWorkbook(db, {}, ['khong-ton-tai']).buffer).names.length, 6);
    assert.equal(open(excelExport.buildWorkbook(db, {}, []).buffer).names.length, 6);
  });
});

test('xuất riêng 1 bảng vẫn áp đúng bộ lọc', () => {
  withDb(db => {
    seed(db);
    const sellInRange = excelExport.buildWorkbook(db, { from: '2026-09-20', to: '2026-09-30' }, ['sell']);
    assert.equal(sellInRange.counts.sell, 1);
    const sellOutOfRange = excelExport.buildWorkbook(db, { from: '2026-09-01', to: '2026-09-05' }, ['sell']);
    assert.equal(sellOutOfRange.counts.sell, 0, 'ngoài kỳ ⇒ không dòng nào');
  });
});

test('fileName: đúng MST và phần mở rộng .xlsx', () => {
  const name = excelExport.fileName(MST, new Date(2026, 8, 25, 14, 5));
  assert.equal(name, `kho-du-lieu-${MST}-20260925-1405.xlsx`);
});
