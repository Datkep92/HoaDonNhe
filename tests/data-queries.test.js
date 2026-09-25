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

test('nâng cấp DB cũ lên v3: tạo bảng FTS và backfill dữ liệu đã có (không nhân đôi)', () => {
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

    // Mở lại ⇒ applySchema phải nâng lên v3 và backfill dữ liệu cũ vào FTS.
    db = openDatabase(dbFile);
    try {
      assert.equal(schemaVersion(db), 3, 'phải nâng lên schema v3');
      assert.equal(queries.listInvoices(db, { q: '00000001' }).total, 1, 'dữ liệu cũ vẫn truy vấn được');
      assert.equal(queries.listInvoices(db, { q: 'nha cung cap' }).total, 2, 'backfill: FTS tìm thấy 2 hoá đơn cũ');
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 2, 'index FTS có đúng 2 dòng');
      // Mở lại lần nữa (đã ở v3) ⇒ KHÔNG backfill lại, không nhân đôi index.
      const again = openDatabase(dbFile);
      try {
        assert.equal(schemaVersion(again), 3);
        assert.equal(again.prepare('SELECT COUNT(*) AS c FROM invoice_fts').get().c, 2, 'không backfill lần hai');
      } finally { closeDatabase(again); }
    } finally { closeDatabase(db); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
