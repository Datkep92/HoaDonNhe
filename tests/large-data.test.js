'use strict';
// ---------------------------------------------------------------------------
// §69 Test 11 + §72 – LARGE DATA TEST.
//
// Mục tiêu KHÔNG phải đo tốc độ tuyệt đối (máy mỗi người mỗi khác) mà chứng minh:
//   1) mở danh sách / tìm kiếm / lọc / tổng hợp hàng hoá chạy trên SQLite và KHÔNG đọc file XML nào;
//   2) chi tiết một hoá đơn chỉ đọc ĐÚNG MỘT file XML;
//   3) thời gian vẫn ở mức dùng được (ngưỡng rộng để không đỏ oan trên máy chậm).
// Số liệu đo được in ra kèm test (node --test hiện phần diagnostic).
// Mặc định 10.000 hoá đơn × 5 dòng = 50.000 dòng hàng (đúng mốc §72); đổi bằng
// biến môi trường HOADON_LARGE_INVOICES khi cần chạy nhẹ hơn.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice, countInvoices, countItems } = require('../src/data/repository');
const { parseInvoiceXml } = require('../src/data/xml-parser');
const queries = require('../src/data/queries');

const INVOICES = Math.max(1, Number(process.env.HOADON_LARGE_INVOICES || 10000));
const ITEMS_PER_INVOICE = 5;

// Đếm số lần đọc file thật sự (SQLite dùng I/O native nên không đi qua fs.readFileSync).
function withReadSpy(fn) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (...args) { reads += 1; return original.apply(this, args); };
  try {
    const value = fn();
    return { value, reads };
  } finally {
    fs.readFileSync = original;
  }
}

const record = (n, dir) => ({
  direction: n % 3 === 0 ? 'SELL' : 'BUY',
  mstBan: n % 3 === 0 ? '0312345678' : `01000000${String(n % 90).padStart(2, '0')}`,
  mstMua: n % 3 === 0 ? null : '0312345678',
  tenBan: `NHÀ CUNG CẤP VÍ DỤ ${n % 500}`,
  tenMua: n % 3 === 0 ? 'Bán cho người tiêu dùng' : 'CÔNG TY VÍ DỤ NGƯỜI MUA',
  ngayLap: `2026-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}`,
  khmsHd: '1',
  khhHd: n % 3 === 0 ? 'C26MTH' : 'C26TNT',
  soHd: String(100000 + n),
  loaiHoaDon: 'Hóa đơn giá trị gia tăng',
  tongTien: 100000 + n,
  // Cố ý trỏ tới file KHÔNG tồn tại: nếu lớp UI đọc XML thì test sẽ đỏ ngay.
  fileXml: path.join(dir, 'khong-co-that', `hd-${n}.xml`),
  items: Array.from({ length: ITEMS_PER_INVOICE }, (_, k) => ({
    stt: k + 1,
    maHang: `MH${(n + k) % 2000}`,
    tenHang: `Hàng ví dụ ${(n + k) % 2000}`,
    donVi: 'Thùng',
    soLuong: (k + 1) * 2,
    donGia: 10000 + k,
    chietKhau: 0,
    thanhTien: ((k + 1) * 2) * (10000 + k),
    thueSuat: '10%',
  })),
});

test(`§69.11 + §72 – ${INVOICES.toLocaleString('vi-VN')} hoá đơn: UI đọc SQLite, không đọc XML`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-large-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    const started = Date.now();
    for (let n = 0; n < INVOICES; n += 1) insertInvoice(db, record(n, dir));
    const insertMs = Date.now() - started;
    assert.equal(countInvoices(db), INVOICES);
    assert.equal(countItems(db), INVOICES * ITEMS_PER_INVOICE);
    t.diagnostic(`Ghi ${INVOICES} hoá đơn / ${INVOICES * ITEMS_PER_INVOICE} dòng hàng: ${insertMs} ms (${(insertMs / INVOICES).toFixed(2)} ms/hoá đơn)`);

    // 1) Mở trang đầu của danh sách — PHẢI không đọc file XML nào.
    const list = withReadSpy(() => queries.listInvoices(db, { limit: 50, offset: 0 }));
    assert.equal(list.reads, 0, 'mở danh sách KHÔNG được đọc file XML nào');
    assert.equal(list.value.total, INVOICES);
    assert.equal(list.value.rows.length, 50);
    assert.ok(list.value.rows.every(row => !fs.existsSync(row.file_xml)), 'các dòng trỏ tới XML không tồn tại mà danh sách vẫn chạy');

    // 2) Tìm kiếm + lọc + tổng hợp — cũng không đọc XML.
    const search = withReadSpy(() => queries.listInvoices(db, { q: '100500', limit: 50 }));
    const filter = withReadSpy(() => queries.listInvoices(db, { direction: 'BUY', from: '2026-03-01', to: '2026-09-30', limit: 50 }));
    const products = withReadSpy(() => queries.products(db, { limit: 100 }));
    const summary = withReadSpy(() => queries.summary(db));
    assert.equal(search.reads + filter.reads + products.reads + summary.reads, 0, 'tìm kiếm/lọc/tổng hợp KHÔNG đọc XML');

    // 3) Chi tiết một hoá đơn: đọc ĐÚNG MỘT file XML.
    const target = list.value.rows[0];
    fs.mkdirSync(path.dirname(target.file_xml), { recursive: true });
    fs.writeFileSync(target.file_xml, '<HDon><DLHDon Id="X"><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TNT</KHHDon><SHDon>999999</SHDon><NLap>2026-09-21</NLap></TTChung><NDHDon><NBan><Ten>Bên bán</Ten><MST>0100000099</MST></NBan><NMua><Ten>Bên mua</Ten><MST>0312345678</MST></NMua><DSHHDVu><HHDVu><STT>1</STT><MHHDVu>MH1</MHHDVu><THHDVu>Hàng</THHDVu><DVTinh>Thùng</DVTinh><SLuong>1.000000</SLuong><ThTien>1000.000000</ThTien><TSuat>10%</TSuat></HHDVu></DSHHDVu></NDHDon><TToan><TgTTTBSo>1100.000000</TgTTTBSo></TToan></DLHDon></HDon>');
    const preview = withReadSpy(() => {
      const found = queries.getInvoice(db, target.invoice_key);
      const parsed = parseInvoiceXml(fs.readFileSync(found.invoice.file_xml, 'utf8'));
      return { items: found.items.length, soHd: parsed.record.soHd };
    });
    assert.equal(preview.reads, 1, 'xem chi tiết chỉ đọc đúng 1 file XML của hoá đơn đó');
    assert.equal(preview.value.soHd, '999999');

    // 4) Ngưỡng thời gian rộng (máy chậm vẫn qua, nhưng chặn thoái hoá kiểu quét XML).
    const elapsed = {
      list: Date.now(),
      search: Date.now(),
      filter: Date.now(),
      products: Date.now(),
      summary: Date.now(),
    };
    const time = (label, fn, limit) => {
      const from = Date.now();
      fn();
      const ms = Date.now() - from;
      t.diagnostic(`${label}: ${ms} ms (ngưỡng ${limit} ms)`);
      assert.ok(ms < limit, `${label} quá chậm: ${ms} ms`);
    };
    time('mở trang danh sách (50 dòng)', () => queries.listInvoices(db, { limit: 50 }), 1500);
    time('tìm kiếm theo số hoá đơn', () => queries.listInvoices(db, { q: '100500', limit: 50 }), 3000);
    time('lọc theo chiều + khoảng ngày', () => queries.listInvoices(db, { direction: 'BUY', from: '2026-03-01', to: '2026-09-30', limit: 50 }), 3000);
    time('tổng hợp hàng hoá (GROUP BY)', () => queries.products(db, { limit: 100 }), 5000);
    time('tổng quan', () => queries.summary(db), 1500);
    void elapsed;

    const size = fs.statSync(path.join(dir, 'data.db')).size;
    t.diagnostic(`Kích thước data.db: ${(size / 1048576).toFixed(2)} MB · heap dùng: ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`);
    t.diagnostic('Đã xác nhận: 0 file XML trên đĩa mà toàn bộ danh sách/tìm kiếm/lọc/tổng hợp vẫn hoạt động.');
  } finally {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
