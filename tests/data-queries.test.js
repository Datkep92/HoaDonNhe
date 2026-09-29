'use strict';
// ---------------------------------------------------------------------------
// Test PHASE 3 – tầng truy vấn cho UI (mục 33/34/37/39) và job nhập chạy nền (mục 26/52).
// Không gọi mạng, không cần cổng thuế. Chạy: npm test
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { openDatabase, closeDatabase, schemaVersion } = require('../src/data/sqlite');
const { SCHEMA_VERSION } = require('../src/data/schema');
const { insertInvoice, upsertInvoice } = require('../src/data/repository');
const queries = require('../src/data/queries');
const importJob = require('../src/data/import-job');

const MST = '0312345678';
const OTHER = '0100000001';

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-queries-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    return fn(db, dir);
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  soHd: '00075757',
  loaiHoaDon: 'Hóa đơn giá trị gia tăng',
  tongTien: 22000,
  fileXml: 'C:/x/a.xml',
  items: [
    { stt: 1, maHang: 'MH1', tenHang: 'Hàng một', donVi: 'Chai', soLuong: 10, donGia: 1000, chietKhau: 0, thanhTien: 10000, thueSuat: '10%' },
    { stt: 2, maHang: 'MH1', tenHang: 'Hàng một', donVi: 'Chai', soLuong: 5, donGia: 1000, chietKhau: 0, thanhTien: 5000, thueSuat: '10%' },
  ],
  ...over,
});

function seed(db) {
  insertInvoice(db, sample({ soHd: '00000001', ngayLap: '2026-09-01', tongTien: 1000 }));
  insertInvoice(db, sample({ soHd: '00000002', ngayLap: '2026-09-10', tongTien: 2000, items: [] }));
  insertInvoice(db, sample({
    direction: 'SELL', soHd: '00006423', khhHd: 'C26MTH', ngayLap: '2026-09-23', mstBan: MST, mstMua: null,
    tenMua: 'Bán cho người tiêu dùng', tongTien: 5208000,
    items: [{ stt: 1, maHang: 'MH2', tenHang: 'Hàng hai', donVi: 'Két', soLuong: 1, donGia: 5208000, chietKhau: 0, thanhTien: 5208000, thueSuat: '10%' }],
  }));
}

test('MỤC 27 + MỤC 6 — chi tiết hàng hóa và hoá đơn theo mặt hàng: dùng chung công thức với thẻ', () => {
  withDb(db => {
    seed(db);
    // Thêm 1 tên viết lỗi khoảng trắng (gộp cùng "Hàng một") và 1 tên hàng chỉ có ở chiều bán.
    insertInvoice(db, sample({
      direction: 'SELL', soHd: '00006500', khhHd: 'C26MTH', ngayLap: '2026-09-25',
      mstBan: MST, mstMua: null, tenMua: 'Khách lẻ', tongTien: 3000,
      items: [
        { stt: 1, maHang: 'MH3', tenHang: 'Hàng  một', donVi: 'Chai', soLuong: 2, donGia: 1000, chietKhau: 0, thanhTien: 2000, thueSuat: '10%' },
        { stt: 2, maHang: 'MH4', tenHang: 'Hàng ba', donVi: 'Cái', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%' },
      ],
    }));
    const goods = queries.overview(db).goods;
    // MỤC 27 — danh sách bấm vào PHẢI đúng bằng con số đang hiển thị trên thẻ (một nguồn dữ liệu).
    for (const [kind, expected] of [
      ['sell_over_buy', goods.sellOverBuy], ['missing_buy', goods.missingBuy],
      ['code_mismatch', goods.codeMismatch], ['not_normalized', goods.notNormalized],
    ]) {
      assert.equal(queries.goodsDetail(db, { kind }).count, expected,
        `danh sách "${kind}" phải khớp con số trên thẻ`);
    }
    assert.equal(goods.sellOverBuy, 3, '3 tên hàng bán nhiều hơn mua');
    assert.equal(goods.notNormalized, 2, '"Hàng  một" và "Hàng một" cùng một ý → 2 tên chưa chuẩn');
    const bad = queries.goodsDetail(db, { kind: 'not_normalized' }).rows.map(row => row.name);
    assert.ok(bad.includes('Hàng  một') && bad.includes('Hàng một'), 'phải liệt kê đúng tên gốc, không sửa tên');
    // MỤC 6 — bấm một dòng top hàng hóa → danh sách hoá đơn CHỨA mặt hàng đó (mở xem A4 được).
    const buyH1 = queries.productInvoices(db, { name: 'Hàng một', direction: 'BUY' });
    assert.equal(buyH1.count, 1, 'chỉ hoá đơn 00000001 có "Hàng một" ở chiều mua');
    assert.equal(buyH1.amount, 1000);
    assert.equal(buyH1.rows[0].invoice_key, '0100000001|1|C26TNT|1');
    assert.equal(queries.productInvoices(db, { name: 'Hàng hai', direction: 'BUY' }).count, 0,
      'không trộn hai chiều: "Hàng hai" chỉ có ở chiều bán');
    assert.equal(queries.productInvoices(db, { name: 'Hàng hai', direction: 'SELL' }).count, 1);
    // Cùng kỳ với thẻ khi người dùng đang chọn kỳ.
    assert.equal(queries.productInvoices(db, { name: 'Hàng một', direction: 'BUY', range: { from: '2026-10-01', to: '2026-10-31' } }).count, 0);
    // Popup hoá đơn đọc thẳng từ /api/db/invoices ⇒ mỗi dòng phải kèm kết quả đối chiếu + phân loại.
    const listed = queries.listInvoices(db, { limit: 10 });
    assert.ok(listed.rows.length > 0 && listed.rows.every(row => 'review_status' in row && 'reconciliation_status' in row),
      'danh sách hoá đơn phải trả đủ cột cho popup xem/phân loại');
  });
});

test('MỤC 4 — paymentSides: số HĐ + tiền theo từng hình thức của TỪNG chiều bán/mua', () => {
  withDb(db => {
    seed(db);
    insertInvoice(db, sample({ direction: 'SELL', soHd: '00006499', khhHd: 'C26MTH', ngayLap: '2026-09-24',
      mstBan: MST, mstMua: null, tenMua: 'Khách lẻ', tongTien: 7000, items: [], paymentMethodRaw: 'Tiền mặt' }));
    const sides = queries.summary(db).paymentSides;
    assert.equal(sides.sell.cash.invoices, 1, 'bán ra tiền mặt');
    assert.equal(sides.sell.cash.amount, 7000);
    assert.equal(sides.buy.cash.invoices, 0, 'chiều mua không có hoá đơn tiền mặt');
    assert.equal(sides.buy.unknown.invoices, 2, '2 hoá đơn mua chưa có hình thức thanh toán');
    assert.equal(sides.buy.unknown.amount, 3000);
    assert.equal(sides.sell.unknown.invoices, 1, 'hoá đơn bán chưa có hình thức thanh toán');
    // Kỳ chọn lọc thì số liệu của cả hai chiều cũng theo kỳ (01–05/09 chỉ có hoá đơn 01/09).
    const early = queries.summary(db, { from: '2026-09-01', to: '2026-09-05' });
    assert.equal(early.paymentSides.buy.unknown.invoices, 1, 'kỳ 01–05/09 chỉ có 1 hoá đơn mua');
    assert.equal(early.paymentSides.sell.cash.invoices, 0, 'hoá đơn tiền mặt 24/09 không vào kỳ đó');
  });
});

test('BỘ CHỌN KỲ (mục 1): summary/overview/debts lọc theo from–to, không truyền thì giữ nguyên', () => {
  withDb(db => {
    seed(db);
    // Không truyền kỳ → chạy y hệt như trước (không hành vi ẩn).
    assert.equal(queries.summary(db).invoices, 3);
    const early = queries.summary(db, { from: '2026-09-01', to: '2026-09-10' });
    assert.equal(early.invoices, 2, 'kỳ 01–10/09 chỉ có 2 hóa đơn BUY');
    assert.equal(early.sell, 0);
    assert.equal(early.from, '2026-09-01', 'khoảng ngày của header lấy theo kỳ đang chọn');
    // Kỳ không có hóa đơn → 0 (UI tự hiện "Không có hóa đơn trong kỳ", mục 35).
    const empty = queries.summary(db, { from: '2027-01-01', to: '2027-01-31' });
    assert.equal(empty.invoices, 0);
    assert.ok(!empty.from, 'kỳ trống không có khoảng ngày để hiện');
    // GIÁ TRỊ KHÔNG PHẢI NGÀY hợp lệ bị BỎ QUA (không nối chuỗi tuỳ ý vào SQL).
    assert.equal(queries.summary(db, { from: "' OR 1=1 --", to: '' }).invoices, 3, 'tham số sai dạng bị bỏ qua');
    // Overview: top hàng mua chỉ có trong kỳ chứa 2 hóa đơn BUY.
    assert.equal(queries.overview(db).topProductsBuy.length, 1);
    assert.equal(queries.overview(db, { from: '2026-09-23', to: '2026-09-30' }).topProductsBuy.length, 0,
      'lọc kỳ chỉ chứa bán ra ⇒ không còn hàng mua');
    assert.equal(queries.overview(db, { from: '2026-09-23', to: '2026-09-30' }).topProducts.length, 1);
    // Công nợ: cùng dữ liệu, kỳ trống ⇒ coi như chưa có hóa đơn nào.
    assert.equal(queries.debts(db).empty, false);
    assert.equal(queries.debts(db, { from: '2027-01-01', to: '2027-01-31' }).empty, true);
  });
});

// MỤC 19 — 2 dòng KPI thêm: LŨY KẾ NĂM và SO VỚI KỲ TRƯỚC, cả hai đều tính ở SERVER từ SQLite.
test('MỤC 19 — summary: lũy kế năm và % so với kỳ liền trước cùng độ dài', () => {
  withDb(db => {
    seed(db);
    // Kỳ 01–30/09/2026: bán 5.208.000 (hoá đơn 23/09), mua 3.000 (2 hoá đơn BUY).
    const current = queries.summary(db, { from: '2026-09-01', to: '2026-09-30' });
    // LŨY KẾ NĂM — từ 01/01/2026 đến ngày CUỐI KỲ (30/09/2026), không dừng ở ngày bắt đầu kỳ.
    assert.equal(current.yearToDate.year, '2026');
    assert.equal(current.yearToDate.from, '2026-01-01', 'lũy kế năm bắt đầu từ 01/01');
    assert.equal(current.yearToDate.to, '2026-09-30', 'lũy kế năm kéo đến ngày cuối kỳ đang chọn');
    assert.equal(current.yearToDate.amountSell, 5208000, 'lũy kế tính tổng bán ra cả năm');
    assert.equal(current.yearToDate.sellInvoices, 1);
    // SO VỚI KỲ TRƯỚC — trọn tháng ⇒ đúng tháng liền trước (01–31/08), không trừ theo ngày.
    assert.equal(current.previousPeriod.from, '2026-08-01');
    assert.equal(current.previousPeriod.to, '2026-08-31');
    assert.equal(current.previousPeriod.invoices, 0, 'kỳ trước không có hoá đơn trong ví dụ này');
    assert.equal(current.previousPeriod.changePercent, null,
      'kỳ trước = 0 đồng ⇒ không chia được % (0 nghĩa là chưa có dữ liệu, mục 35)');
    // Thêm hoá đơn bán ở kỳ trước ⇒ % đổi = (5.208.000 - 4.000.000) / 4.000.000 = +30,2%.
    insertInvoice(db, sample({
      direction: 'SELL', soHd: '00006501', khhHd: 'C26MTH', ngayLap: '2026-08-15', mstBan: MST, mstMua: null,
      tenMua: 'Khách kỳ trước', tongTien: 4000000, items: [],
    }));
    const withPrevious = queries.summary(db, { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(withPrevious.previousPeriod.amountSell, 4000000);
    assert.ok(Math.abs(withPrevious.previousPeriod.changePercent - 30.2) < 0.01,
      `% đúng = (5208000-4000000)/4000000, got ${withPrevious.previousPeriod.changePercent}`);
    // Trọn quý (01/07–30/09) ⇒ kỳ trước là QUÝ II đầy đủ (01/04–30/06), không dải 31 ngày.
    const quarter = queries.summary(db, { from: '2026-07-01', to: '2026-09-30' });
    assert.equal(quarter.previousPeriod.from, '2026-04-01');
    assert.equal(quarter.previousPeriod.to, '2026-06-30');
    // Kỳ tuỳ ý (không trọn tháng) ⇒ dải cùng độ dài ngay trước đó.
    const odd = queries.summary(db, { from: '2026-09-10', to: '2026-09-19' });
    assert.equal(odd.previousPeriod.from, '2026-08-31');
    assert.equal(odd.previousPeriod.to, '2026-09-09');
    // CHƯA CHỌN KỲ ⇒ previousPeriod = null (UI ghi "Chưa chọn kỳ", không bịa số — mục 35).
    assert.equal(queries.summary(db).previousPeriod, null);
    // Kỳ sai dạng (không phải ngày) ⇒ không tính so sánh, nhưng lũy kế năm vẫn có.
    const broken = queries.summary(db, { from: "' OR 1=1 --", to: '2026-09-30' });
    assert.equal(broken.previousPeriod, null);
    assert.equal(broken.yearToDate.year, '2026');
    // Lũy kế chỉ tính hoá đơn CÒN HIỆU LỰC (cùng activeSql với dòng "Doanh thu bán ra").
    assert.equal(current.yearToDate.amountSell, current.amountSell,
      'lũy kế năm ≥ doanh thu kỳ và dùng chung công thức với dòng KPI đầu');
  });
});

test('summary: đếm theo chiều, tổng tiền, số dòng hàng', () => {
  withDb(db => {
    seed(db);
    const value = queries.summary(db);
    assert.equal(value.invoices, 3);
    assert.equal(value.buy, 2);
    assert.equal(value.sell, 1);
    assert.equal(value.items, 3);
    assert.equal(value.amount, 1000 + 2000 + 5208000);
    assert.equal(value.from, '2026-09-01');
    assert.equal(value.to, '2026-09-23');
  });
});

// MỤC 18 + MỤC 20 — tên doanh nghiệp đọc từ dữ liệu, và TIỀN theo từng hình thức thanh toán
// tách riêng chiều bán/mua (không cộng chung hai chiều).
test('summary: tên doanh nghiệp + tiền theo hình thức thanh toán tách theo chiều (mục 18/20)', () => {
  withDb(db => {
    insertInvoice(db, sample({ soHd: '00000001', ngayLap: '2026-09-01', tongTien: 1000, tenMua: 'CÔNG TY A', httToan: 'TM', items: [] }));
    insertInvoice(db, sample({ soHd: '00000002', ngayLap: '2026-09-10', tongTien: 2000, tenMua: 'CÔNG TY A', httToan: 'CK', items: [] }));
    insertInvoice(db, sample({
      direction: 'SELL', soHd: '00006423', khhHd: 'C26MTH', ngayLap: '2026-09-23', mstBan: MST, mstMua: null,
      tenBan: 'CÔNG TY A', tenMua: 'Khách lẻ', tongTien: 5208000, httToan: 'TM',
      items: [{ stt: 1, maHang: 'MH2', tenHang: 'Hàng hai', donVi: 'Két', soLuong: 1, donGia: 5208000, chietKhau: 0, thanhTien: 5208000, thueSuat: '10%' }],
    }));
    const value = queries.summary(db);
    // Mục 18: tên lấy tên xuất hiện nhiều nhất trong các hoá đơn của chính kho này.
    assert.equal(value.company, 'CÔNG TY A', 'tên doanh nghiệp phải lấy từ dữ liệu hoá đơn');
    // Mục 20: đếm và tiền đều theo đúng hình thức thanh toán ghi trong XML.
    assert.equal(value.cashInvoices, 2);
    assert.equal(value.transferInvoices, 1);
    assert.equal(value.ambiguousInvoices, 0);
    assert.equal(value.unknownInvoices, 0);
    assert.equal(value.paymentAmounts.buy.cash, 1000, 'mua vào tiền mặt');
    assert.equal(value.paymentAmounts.buy.transfer, 2000, 'mua vào chuyển khoản');
    assert.equal(value.paymentAmounts.sell.cash, 5208000, 'bán ra tiền mặt');
    assert.equal(value.paymentAmounts.sell.transfer, 0, 'không có bán ra chuyển khoản');
    assert.equal(value.amount, value.paymentAmounts.buy.cash + value.paymentAmounts.buy.transfer + value.paymentAmounts.sell.cash,
      'tổng tiền = tổng tiền theo từng hình thức thanh toán');
  });
});

test('overview: cảnh báo hàng hóa (mục 24) — bán > mua, thiếu dữ liệu mua, tên/mã chưa chuẩn', () => {
  withDb(db => {
    insertInvoice(db, sample({
      direction: 'SELL', soHd: '00000010', khhHd: 'C26MTH', mstBan: MST, mstMua: null, tenMua: 'Khách lẻ',
      ngayLap: '2026-09-05', tongTien: 10000, httToan: 'TM',
      items: [
        { stt: 1, maHang: 'MH1', tenHang: 'Bánh đa', donVi: 'Cái', soLuong: 1, donGia: 1000, chietKhau: 0, thanhTien: 1000, thueSuat: '10%' },
        { stt: 2, maHang: 'MH2', tenHang: 'Bánh đa', donVi: 'Cái', soLuong: 2, donGia: 1000, chietKhau: 0, thanhTien: 2000, thueSuat: '10%' },
        { stt: 3, maHang: 'MH3', tenHang: 'bánh đa', donVi: 'Cái', soLuong: 3, donGia: 1000, chietKhau: 0, thanhTien: 3000, thueSuat: '10%' },
        { stt: 4, maHang: 'MH4', tenHang: 'Bánh mì', donVi: 'Cái', soLuong: 5, donGia: 800, chietKhau: 0, thanhTien: 4000, thueSuat: '10%' },
      ],
    }));
    insertInvoice(db, sample({
      soHd: '00000011', ngayLap: '2026-09-06', tongTien: 5000, httToan: 'CK',
      items: [{ stt: 1, maHang: 'MH1', tenHang: 'Bánh đa', donVi: 'Cái', soLuong: 20, donGia: 250, chietKhau: 0, thanhTien: 5000, thueSuat: '10%' }],
    }));
    const value = queries.overview(db);
    // Tổng hợp mua/bán (mục 24).
    assert.equal(value.goods.total, 3, '3 tên hàng khác nhau');
    assert.equal(value.goods.qtySell, 11, 'tổng số lượng bán');
    assert.equal(value.goods.qtyBuy, 20, 'tổng số lượng mua');
    assert.equal(value.goods.amountSell, 10000);
    assert.equal(value.goods.amountBuy, 5000);
    // 4 cảnh báo của mục 24.
    assert.equal(value.goods.notNormalized, 2, '"Bánh đa" và "bánh đa" cùng một ý nhưng viết khác nhau');
    assert.equal(value.goods.codeMismatch, 1, 'tên "Bánh đa" gắn 2 mã hàng khác nhau');
    assert.equal(value.goods.sellOverBuy, 2, 'chỉ "bánh đa" và "Bánh mì" bán nhiều hơn đã mua');
    assert.equal(value.goods.missingBuy, 2, 'chỉ 2 tên hàng không có dòng mua');
    assert.equal(value.topProductsBuy[0].name, 'Bánh đa', 'top mua lấy từ chiều BUY');
  });
});

test('overview: đủ 12 tháng và top hàng hóa từ SQLite', () => {
  withDb(db => {
    seed(db);
    const value = queries.overview(db);
    assert.equal(value.year, '2026');
    assert.equal(value.months.length, 12);
    assert.equal(value.months.find(row => row.month === 9).sell, 5208000);
    assert.equal(value.months.find(row => row.month === 9).buy, 3000);
    assert.equal(value.topProducts[0].name, 'Hàng hai');
  });
});

test('listInvoices: phân trang, lọc theo chiều, tìm kiếm (mục 33/34)', () => {
  withDb(db => {
    seed(db);
    const firstPage = queries.listInvoices(db, { limit: 2, offset: 0 });
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.rows.length, 2);
    assert.equal(firstPage.rows[0].ngay_lap, '2026-09-23', 'mới nhất trước');
    const secondPage = queries.listInvoices(db, { limit: 2, offset: 2 });
    assert.equal(secondPage.rows.length, 1);
    assert.equal(queries.listInvoices(db, { direction: 'SELL' }).total, 1);
    assert.equal(queries.listInvoices(db, { direction: 'BUY' }).total, 2);
    assert.equal(queries.listInvoices(db, { q: '6423' }).total, 1, 'tìm theo số hoá đơn');
    assert.equal(queries.listInvoices(db, { q: 'C26MTH' }).total, 1, 'tìm theo ký hiệu');
    assert.equal(queries.listInvoices(db, { q: 'người tiêu dùng' }).total, 1, 'tìm theo tên người mua');
    assert.equal(queries.listInvoices(db, { from: '2026-09-10', to: '2026-09-22' }).total, 1);
    assert.equal(queries.listInvoices(db, { q: 'không-tồn-tại' }).total, 0);
  });
});

test('getInvoice: trả hoá đơn + dòng hàng theo khoá; khoá lạ trả null', () => {
  withDb(db => {
    seed(db);
    const found = queries.getInvoice(db, `${MST}|1|C26MTH|6423`);
    assert.ok(found);
    assert.equal(found.invoice.direction, 'SELL');
    assert.equal(found.items.length, 1);
    assert.equal(found.items[0].ma_hang, 'MH2');
    assert.equal(queries.getInvoice(db, 'khong|co|that|999'), null);
    assert.throws(() => queries.getInvoice(db, ''), /Thiếu khoá/);
  });
});

test('products: gộp theo mã hàng + tên hàng + ĐVT bằng SQL (mục 37/38)', () => {
  withDb(db => {
    seed(db);
    const value = queries.products(db, { limit: 50 });
    const hangMot = value.rows.find(r => r.ma_hang === 'MH1');
    assert.ok(hangMot, 'phải có MH1');
    assert.equal(hangMot.tong_so_luong, 15, 'hoá đơn 1 có 2 dòng MH1 (10 + 5); hoá đơn 2 không có dòng hàng');
    assert.equal(hangMot.so_dong, 2);
    assert.equal(value.rows.find(r => r.ma_hang === 'MH2').tong_so_luong, 1);
    const sellOnly = queries.products(db, { direction: 'SELL' });
    assert.deepEqual(sellOnly.rows.map(r => r.ma_hang), ['MH2']);
    assert.equal(queries.products(db, { q: 'Hàng hai' }).rows.length, 1);
  });
});

test('partners: khách hàng (bán ra) và nhà cung cấp (mua vào) — mục 39', () => {
  withDb(db => {
    seed(db);
    const buyers = queries.partners(db, { kind: 'buyer' });
    assert.equal(buyers.length, 1);
    assert.equal(buyers[0].ten, 'Bán cho người tiêu dùng');
    const suppliers = queries.partners(db, { kind: 'supplier' });
    assert.equal(suppliers.length, 1);
    assert.equal(suppliers[0].mst, OTHER);
    assert.equal(suppliers[0].so_hoa_don, 2, 'chỉ tính hoá đơn mua vào (direction = BUY)');
  });
});

// XML tối thiểu, sinh tại chỗ (không dùng dữ liệu thật của người dùng).
const xml = (shDon, seller, buyer) => `<HDon><DLHDon Id="X"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn GTGT</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TNT</KHHDon><SHDon>${shDon}</SHDon><NLap>2026-09-21</NLap></TTChung><NDHDon><NBan><Ten>Bên bán ví dụ</Ten><MST>${seller}</MST></NBan><NMua><Ten>Bên mua ví dụ</Ten><MST>${buyer}</MST></NMua><DSHHDVu><HHDVu><STT>1</STT><MHHDVu>MH1</MHHDVu><THHDVu>Hàng ví dụ</THHDVu><DVTinh>Chai</DVTinh><SLuong>2.000000</SLuong><DGia>1000.000000</DGia><ThTien>2000.000000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu></NDHDon><TToan><TgTCThue>2000.000000</TgTCThue><TgTThue>200.000000</TgTThue><TgTTTBSo>2200.000000</TgTTTBSo></TToan></DLHDon></HDon>`;

test('importJob: chạy nền, có tiến độ, chống chạy chồng, chạy lại thì bỏ qua (mục 26/52)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-job-'));
  try {
    const dir = path.join(root, `MST-${MST}`);
    for (const folder of ['Mua_vao', 'Ban_ra']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), xml('00000001', OTHER, MST));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'b.xml'), xml('00000002', OTHER, MST));

    const first = importJob.start({ output: root, mst: MST });
    const second = importJob.start({ output: root, mst: MST });
    await assert.rejects(second, /Đang nhập dữ liệu/, 'không cho hai lượt nhập chạy chồng');
    const started = await first;

    assert.equal(started.running, false);
    assert.equal(started.ok, true);
    assert.equal(started.total, 2, 'đếm trước tổng số file để UI có thanh tiến độ');
    assert.equal(started.imported, 2);
    assert.equal(started.itemsTotal, 2);
    assert.ok(started.startedAt && started.finishedAt);
    assert.ok(Array.isArray(started.recent) && started.recent.length === 2);

    const status = importJob.status();
    assert.equal(status.imported, 2);

    const again = await importJob.start({ output: root, mst: MST });
    assert.equal(again.imported, 0);
    assert.equal(again.skipped, 2, 'chạy lại chỉ bỏ qua, không nhân bản');

    withDbLike(dir, db => {
      assert.equal(queries.summary(db).invoices, 2);
      assert.equal(queries.summary(db).items, 2);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withDbLike(dir, fn) {
  const db = openDatabase(path.join(dir, 'data.db'));
  try { return fn(db); } finally { closeDatabase(db); }
}

test('summary: cộng đúng tiền thuế và tổng tiền theo từng chiều (cho thống kê ở đầu tab)', () => {
  withDb(db => {
    insertInvoice(db, sample({ soHd: '00000090', tienTruocThue: 1000000, tienThue: 100000, tongTien: 1100000, items: [] }));
    insertInvoice(db, sample({ soHd: '00000091', direction: 'SELL', mstBan: MST, mstMua: null, tienTruocThue: 2500000, tienThue: 250000, tongTien: 2750000, items: [] }));
    const value = queries.summary(db);
    assert.equal(value.invoices, 2);
    assert.equal(value.tax, 350000);
    assert.equal(value.taxBuy, 100000);
    assert.equal(value.taxSell, 250000);
    assert.equal(value.amountBuy, 1100000);
    assert.equal(value.amountSell, 2750000);
  });
});

test('products: gộp theo cả thuế suất; tiền thuế là null khi XML không có TThue', () => {
  withDb(db => {
    insertInvoice(db, sample({
      soHd: '00000095',
      items: [
        { stt: 1, maHang: 'MH9', tenHang: 'Hàng chín', donVi: 'Thùng', soLuong: 1, donGia: 100, chietKhau: 0, thanhTien: 100, thueSuat: '8%' },
        { stt: 2, maHang: 'MH9', tenHang: 'Hàng chín', donVi: 'Thùng', soLuong: 1, donGia: 100, chietKhau: 0, thanhTien: 100, thueSuat: '10%' },
      ],
    }));
    const rows = queries.products(db, { limit: 10 }).rows;
    assert.equal(rows.length, 2, 'hai thuế suất khác nhau ⇒ hai dòng, không tự gộp');
    assert.deepEqual(rows.map(row => row.thue_suat).sort(), ['10%', '8%']);
    assert.ok(rows.every(row => row.tong_thue === null), 'không có TThue ⇒ null, KHÔNG tự tính');
  });
});

test('partners: kind=all trả cả nhà cung cấp lẫn khách hàng, có cột loai', () => {
  withDb(db => {
    seed(db);
    const all = queries.partners(db, { kind: 'all' });
    assert.equal(all.length, 2);
    assert.deepEqual(all.map(row => row.loai).sort(), ['KH', 'NCC']);
    assert.ok(all.every(row => 'tong_thue' in row));
    assert.equal(queries.partners(db, { kind: 'supplier' }).length, 1);
    assert.equal(queries.partners(db, { kind: 'buyer' }).length, 1);
  });
});

test('listInvoices: FTS5 tìm nhanh theo tên/ký hiệu, bỏ dấu tiếng Việt; fallback LIKE khi FTS trượt', () => {
  withDb(db => {
    seed(db);
    // FTS-primary: chỉ khớp theo TOKEN (không phải substring) và bỏ dấu đầy đủ.
    // 'cong ty' không có dấu mà vẫn ra 2 ⇒ chứng minh đi qua FTS (LIKE sẽ trả 0 vì dữ liệu có dấu).
    assert.equal(queries.listInvoices(db, { q: 'cong ty' }).total, 2, 'FTS bỏ dấu đầy đủ (CÔNG TY)');
    assert.equal(queries.listInvoices(db, { q: 'nguoi' }).total, 3, 'FTS bỏ dấu đầy đủ (NGƯỜI/người)');
    assert.equal(queries.listInvoices(db, { q: 'nha cung cap' }).total, 3, 'FTS nhiều token, không dấu');
    assert.equal(queries.listInvoices(db, { q: 'C26MTH' }).total, 1, 'FTS theo ký hiệu hoá đơn');
    assert.equal(queries.listInvoices(db, { q: 'người tiêu dùng' }).total, 1, 'FTS nhiều token theo tên người mua');
    // LIKE fallback: '6423' nằm GIỮA mã '00006423' nên FTS (tiền tố) trượt ⇒ LIKE bắt substring.
    assert.equal(queries.listInvoices(db, { q: '6423' }).total, 1, 'fallback LIKE bắt substring giữa số hoá đơn');
    // Kết hợp FTS với lọc chiều — phần cơ bản phải được AND đúng.
    assert.equal(queries.listInvoices(db, { q: 'C26MTH', direction: 'BUY' }).total, 0);
    assert.equal(queries.listInvoices(db, { q: 'C26MTH', direction: 'SELL' }).total, 1);
    // Không có kết quả thì trả rỗng, không ném lỗi.
    assert.equal(queries.listInvoices(db, { q: 'không-tồn-tại-xyz' }).total, 0);
  });
});

test('ftsMatchOf: chuỗi toàn ký tự đặc biệt ⇒ rỗng (không ném lỗi MATCH)', () => {
  assert.equal(queries.ftsMatchOf(''), '');
  assert.equal(queries.ftsMatchOf('   '), '');
  assert.equal(queries.ftsMatchOf('*** -- "" ():'), '', 'toàn ký tự đặc biệt ⇒ không có token');
  assert.equal(queries.ftsMatchOf('C26MTH'), '"C26MTH"*');
  assert.equal(queries.ftsMatchOf('bán cho'), '"bán"* "cho"*');
  assert.equal(queries.ftsMatchOf('  a   b '), '"a"* "b"*');
  assert.equal(queries.ftsMatchOf('không-tồn-tại'), '"không"* "tồn"* "tại"*', 'dấu gạch ngang tách token');
});

test('FTS5 external content: nhập lại/xoá hoá đơn thì index theo kịp, KHÔNG còn từ khoá cũ (chống kết quả "ma")', () => {
  withDb(db => {
    insertInvoice(db, sample({ soHd: '00000001', tenBan: 'CÔNG TY AN KHANG' }));
    assert.equal(queries.listInvoices(db, { q: 'an khang' }).total, 1, 'index có từ khoá ban đầu');

    // Đường cập nhật THẬT của app (nhập lại XML đã thay đổi) phải làm index theo kịp.
    upsertInvoice(db, sample({ soHd: '00000001', tenBan: 'CÔNG TY HOÀNG GIA' }));
    assert.equal(queries.listInvoices(db, { q: 'an khang' }).total, 0, 'từ khoá CŨ không còn khớp sau khi sửa');
    assert.equal(queries.listInvoices(db, { q: 'hoang gia' }).total, 1, 'từ khoá MỚI khớp ngay');

    // Xoá hoá đơn ⇒ index sạch.
    db.prepare('DELETE FROM invoices WHERE so_hd = ?').run('00000001');
    assert.equal(queries.listInvoices(db, { q: 'hoang gia' }).total, 0, 'đã xoá thì không còn khớp');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 0, 'index rỗng sau khi xoá');
  });
});

test('nâng cấp DB cũ lên schema hiện hành: tạo bảng FTS và backfill dữ liệu đã có (không nhân đôi)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-migrate-'));
  try {
    const dbFile = path.join(dir, 'data.db');
    // Tạo DB rồi hạ về trạng thái "DB cũ": có dữ liệu invoices, KHÔNG có bảng FTS/trigger.
    let db = openDatabase(dbFile);
    insertInvoice(db, sample({ soHd: '00000001' }));
    insertInvoice(db, sample({ soHd: '00000002' }));
    closeDatabase(db);

    const raw = new DatabaseSync(dbFile);
    try {
      raw.exec('DROP TRIGGER IF EXISTS trg_invoice_fts_ai');
      raw.exec('DROP TRIGGER IF EXISTS trg_invoice_fts_au');
      raw.exec('DROP TRIGGER IF EXISTS trg_invoice_fts_ad');
      raw.exec('DROP TABLE IF EXISTS invoice_fts');
      raw.exec('PRAGMA user_version = 2');
    } finally { raw.close(); }

    // Mở lại ⇒ applySchema phải nâng lên schema hiện hành và backfill dữ liệu cũ vào FTS.
    db = openDatabase(dbFile);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION, 'phải nâng lên schema hiện hành');
      assert.equal(queries.listInvoices(db, { q: '00000001' }).total, 1, 'dữ liệu cũ vẫn truy vấn được');
      assert.equal(queries.listInvoices(db, { q: 'nha cung cap' }).total, 2, 'backfill: FTS tìm thấy 2 hoá đơn cũ');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 2, 'index FTS có đúng 2 dòng');
      // Mở lại lần nữa (đã ở schema hiện hành) ⇒ KHÔNG backfill lại, không nhân đôi index.
      const again = openDatabase(dbFile);
      try {
        assert.equal(schemaVersion(again), SCHEMA_VERSION);
        assert.equal(again.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 2, 'không backfill lần hai');
      } finally { closeDatabase(again); }
    } finally { closeDatabase(db); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nâng cấp DB v3 lên v4: tự thêm cột tthai, GIỮ dữ liệu cũ, không tự điền trạng thái', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-migrate-state-'));
  try {
    const dbFile = path.join(dir, 'data.db');
    const raw = new DatabaseSync(dbFile);
    try {
      // Đúng hình dạng bảng `invoices` của v3 — CHƯA có cột tthai.
      raw.exec(`CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_key TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
        mst_ban TEXT, mst_mua TEXT, ten_ban TEXT, ten_mua TEXT, ngay_lap TEXT, khms_hd TEXT, khh_hd TEXT,
        so_hd TEXT, loai_hoa_don TEXT, tien_truoc_thue REAL DEFAULT 0, tien_thue REAL DEFAULT 0,
        tong_tien REAL DEFAULT 0, file_xml TEXT NOT NULL, created_at TEXT, updated_at TEXT)`);
      raw.exec("INSERT INTO invoices (invoice_key, direction, file_xml, tong_tien, tien_thue) VALUES ('k|1|A|1','BUY','x.xml',100,10)");
      raw.exec('PRAGMA user_version = 3');
    } finally { raw.close(); }

    // Cột tthai phải được thêm TRƯỚC index idx_invoice_state — nếu không, CREATE INDEX trên cột
    // chưa có sẽ làm cả transaction nâng cấp ném lỗi và app không mở được data.db.
    const db = openDatabase(dbFile);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION, 'phải nâng lên schema hiện hành');
      // MỤC 15 — BACKUP → MIGRATION: trước khi ALTER phải đã có bản sao data.db, và bản sao
      // phải chứa đúng dữ liệu TRƯỚC khi nâng cấp (không phải bản đã đổi).
      const backupFile = `${dbFile}.bak`;
      assert.ok(fs.existsSync(backupFile), 'phải có bản sao data.db trước khi nâng cấp schema');
      const snapshot = new DatabaseSync(backupFile);
      try {
        assert.equal(snapshot.prepare('SELECT tong_tien FROM invoices WHERE invoice_key = ?').get('k|1|A|1').tong_tien, 100,
          'bản sao phải chứa dữ liệu trước migration');
        assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_fts'").get(), undefined,
          'bản sao là ảnh chụp TRƯỚC migration (chưa có bảng mới)');
      } finally { snapshot.close(); }
      assert.ok(db.prepare('PRAGMA table_info(invoices)').all().map(row => row.name).includes('tthai'), 'cột tthai phải được thêm vào DB cũ');
      const row = db.prepare('SELECT tong_tien, tthai FROM invoices WHERE invoice_key = ?').get('k|1|A|1');
      assert.equal(row.tong_tien, 100, 'dữ liệu cũ còn nguyên');
      assert.equal(row.tthai, null, 'hoá đơn cũ chưa biết trạng thái ⇒ null, KHÔNG tự điền 1');
    } finally { closeDatabase(db); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nâng cấp DB v7 lên v8: thêm 2 cột phân loại thủ công, GIỮ dữ liệu cũ, KHÔNG tự điền trạng thái', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-migrate-review-'));
  try {
    const dbFile = path.join(dir, 'data.db');
    const raw = new DatabaseSync(dbFile);
    try {
      // Đúng hình dạng bảng `invoices` của v7 — CHƯA có review_status / reviewed_at.
      raw.exec(`CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_key TEXT NOT NULL UNIQUE, direction TEXT NOT NULL,
        mst_ban TEXT, mst_mua TEXT, ten_ban TEXT, ten_mua TEXT, ngay_lap TEXT, khms_hd TEXT, khh_hd TEXT,
        so_hd TEXT, loai_hoa_don TEXT, tthai TEXT, payment_method_raw TEXT,
        payment_method TEXT NOT NULL DEFAULT 'UNKNOWN', reconciliation_status TEXT, reconciliation_issues TEXT,
        tien_truoc_thue REAL DEFAULT 0, tien_thue REAL DEFAULT 0, tong_tien REAL DEFAULT 0,
        file_xml TEXT NOT NULL, created_at TEXT, updated_at TEXT)`);
      raw.exec(`INSERT INTO invoices (invoice_key, direction, file_xml, tong_tien, payment_method, reconciliation_status)
        VALUES ('k|1|A|1', 'BUY', 'x.xml', 100, 'CASH', 'CASH_NO_BANK_REQUIRED')`);
      raw.exec('PRAGMA user_version = 7');
    } finally { raw.close(); }

    const db = openDatabase(dbFile);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION, 'phải nâng lên schema hiện hành');
      assert.ok(fs.existsSync(`${dbFile}.bak`), 'phải có bản sao data.db TRƯỚC khi ALTER (mục 15)');
      const cols = db.prepare('PRAGMA table_info(invoices)').all().map(row => row.name);
      assert.ok(cols.includes('review_status') && cols.includes('reviewed_at'), 'phải thêm 2 cột phân loại');
      const row = db.prepare(`SELECT tong_tien, payment_method, reconciliation_status, review_status, reviewed_at
        FROM invoices WHERE invoice_key = ?`).get('k|1|A|1');
      assert.equal(row.tong_tien, 100, 'dữ liệu cũ còn nguyên');
      assert.equal(row.payment_method, 'CASH');
      assert.equal(row.reconciliation_status, 'CASH_NO_BANK_REQUIRED');
      assert.equal(row.review_status, null, 'KHÔNG tự điền — chỉ khi người dùng bấm mới có');
      assert.equal(row.reviewed_at, null);
    } finally { closeDatabase(db); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// MỤC 25 – CÔNG NỢ · MỤC 26 – THUẾ / NGƯỠNG (hai khối thiếu của tab Tổng quan).
// ---------------------------------------------------------------------------

test('debts: PHẢI THU / PHẢI TRẢ lấy từ kết quả đối chiếu ĐÃ LƯU, "chưa rõ" tách riêng', () => {
  withDb(db => {
    // Chưa có hoá đơn nào ⇒ phải báo "Chưa có dữ liệu", KHÔNG phải là số 0 (mục 35).
    assert.equal(queries.debts(db).empty, true);

    insertInvoice(db, sample({ direction: 'SELL', soHd: '00000101', ngayLap: '2026-09-05', mstBan: MST, mstMua: OTHER, tenMua: 'KHÁCH HÀNG A', tongTien: 5000000, paymentMethodRaw: 'Chuyển khoản', items: [] }));
    insertInvoice(db, sample({ direction: 'SELL', soHd: '00000102', ngayLap: '2026-09-12', mstBan: MST, mstMua: OTHER, tenMua: 'KHÁCH HÀNG A', tongTien: 7000000, paymentMethodRaw: 'Chuyển khoản', items: [] }));
    insertInvoice(db, sample({ direction: 'SELL', soHd: '00000103', ngayLap: '2026-09-15', mstBan: MST, mstMua: OTHER, tenMua: 'KHÁCH HÀNG B', tongTien: 1000000, paymentMethodRaw: 'Chuyển khoản', items: [] }));
    insertInvoice(db, sample({ soHd: '00000104', ngayLap: '2026-09-18', tenBan: 'NHÀ CUNG CẤP B', tongTien: 3000000, paymentMethodRaw: 'Chuyển khoản', items: [] }));
    // Hoá đơn không rõ hình thức thanh toán: không gộp vào phải thu (mục 5),
    // cũng không bỏ qua mất (mục 35).
    insertInvoice(db, sample({ direction: 'SELL', soHd: '00000105', ngayLap: '2026-09-19', mstBan: MST, mstMua: OTHER, tenMua: 'KHÁCH HÀNG C', tongTien: 400000, paymentMethodRaw: null, items: [] }));

    const value = queries.debts(db);
    assert.equal(value.empty, false);
    assert.equal(value.receivable, 5000000 + 7000000 + 1000000, 'phải thu = hoá đơn CK chưa thấy tiền về');
    assert.equal(value.receivableCount, 3);
    assert.equal(value.payable, 3000000, 'phải trả = hoá đơn mua vào CK chưa thấy đã trả');
    assert.equal(value.payableCount, 1);
    assert.equal(value.unclear, 400000, 'khoản chưa rõ hình thức đứng riêng');
    assert.equal(value.unclearCount, 1);
    assert.equal(value.customers.length, 2, 'gộp theo khách hàng, KHÔNG tính khoản chưa rõ');
    assert.equal(value.customers[0].name, 'KHÁCH HÀNG A');
    assert.equal(value.customers[0].amount, 5000000 + 7000000, 'cộng dồn theo đối tác');
    assert.equal(value.customers[0].last_date, '2026-09-12', 'ngày gần nhất của đối tác');
    assert.equal(value.suppliers.length, 1);
    assert.equal(value.suppliers[0].name, 'NHÀ CUNG CẤP B');
    assert.equal(value.suppliers[0].amount, 3000000);
    assert.equal(value.suppliers[0].last_date, '2026-09-18');
  });
});

test('taxOverview: doanh thu lũy kế, thuế dự kiến từ hoá đơn, ngưỡng theo NĂM + LOẠI HÌNH (mục 26)', () => {
  withDb(db => {
    seed(db); // hoá đơn bán ra 5.208.000 nhưng KHÔNG ghi tiền thuế
    const plain = queries.taxOverview(db, { year: '2026', businessType: '' });
    assert.equal(plain.year, '2026');
    assert.equal(plain.revenue, 5208000, 'doanh thu lũy kế = tổng hoá đơn bán ra còn hiệu lực của năm');
    assert.equal(plain.taxAvailable, false, 'chưa có tiền thuế ⇒ phải báo Chưa đủ dữ liệu, KHÔNG hiện 0 đồng');
    assert.equal(plain.rule, null, 'chưa chọn loại hình ⇒ không có ngưỡng');
    assert.equal(plain.progress, null, 'không vẽ vạch ngưỡng khi chưa chọn');
    assert.equal(plain.rules.length, 3);
    assert.deepEqual(plain.years, [2026, 2025], 'danh sách năm áp dụng giảm dần');
    assert.ok(plain.rules.every(rule => rule.year === 2026 && rule.id.endsWith('-2026')), 'mỗi quy tắc phải gắn NĂM (versioned)');
    assert.ok(plain.rules.every(rule => rule.legalRef && rule.status === 'reference'), 'phải dẫn chiếu văn bản + đánh dấu tham khảo');

    insertInvoice(db, sample({ direction: 'SELL', soHd: '00000110', mstBan: MST, mstMua: null, tenMua: 'KH', ngayLap: '2026-09-24', tongTien: 4792000, tienTruocThue: 4792000, tienThue: 479200, items: [] }));
    const withTax = queries.taxOverview(db, { year: '2026', businessType: 'hkd_nong' });
    assert.equal(withTax.revenue, 5208000 + 4792000);
    assert.equal(withTax.tax, 479200, 'thuế dự kiến = tiền thuế ĐANG GHI trên hoá đơn bán ra, không nhân tỷ lệ nào');
    assert.equal(withTax.taxAvailable, true);
    assert.equal(withTax.rule.businessType, 'hkd_nong');
    assert.equal(withTax.rule.threshold, 500000000);
    assert.ok(withTax.progress.threshold === 500000000 && withTax.progress.percent < 100 && withTax.progress.remaining > 0);

    // Doanh nghiệp không có ngưỡng doanh thu hộ kinh doanh ⇒ không được vẽ ngưỡng ảo.
    const company = queries.taxOverview(db, { year: '2026', businessType: 'doanh_nghiep' });
    assert.equal(company.rule.threshold, null);
    assert.equal(company.progress, null);

    // Năm khác ⇒ bộ quy tắc RIÊNG, không dùng lại con số của năm khác (mục 26).
    const older = queries.taxOverview(db, { year: '2025', businessType: 'hkd_nong' });
    assert.equal(older.rule.year, 2025);
    assert.ok(older.rule.id !== withTax.rule.id, 'mỗi năm một bản quy tắc');
    assert.equal(older.revenue, 0, 'năm 2025 chưa có hoá đơn ⇒ doanh thu 0 của CHÍNH năm đó');
    assert.equal(older.taxAvailable, false);
  });
});
