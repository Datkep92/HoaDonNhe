'use strict';
// ---------------------------------------------------------------------------
// Tự kiểm tra tầng dữ liệu NGAY TRONG EXE đã đóng gói:
//     CN-Tax-Tools.exe --data-core-check
//
// Mục đích: chứng minh node:sqlite + schema + repository chạy được trong bản đóng gói
// (không phải chỉ trong môi trường dev). Chỉ làm việc trong thư mục tạm của hệ điều hành,
// KHÔNG ghi gì vào du_lieu của người dùng và KHÔNG gọi mạng.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, closeDatabase, tableNames, schemaVersion } = require('./sqlite');
const { insertInvoice, countInvoices, countItems, findInvoiceByKey } = require('./repository');

function runSelfCheck() {
  const result = {
    packed: !!process.pkg,
    node: process.version,
    abi: process.versions.modules,
    ok: false,
  };
  const dir = path.join(os.tmpdir(), 'hoadon-data-core-check');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const dbFile = path.join(dir, 'data.db');
    const db = openDatabase(dbFile);
    try {
      result.schema_version = schemaVersion(db);
      result.tables = tableNames(db);

      const record = {
        direction: 'BUY',
        mstBan: '4500222022',
        mstMua: '4500677693',
        tenBan: 'CÔNG TY TNHH THƯƠNG MẠI DỊCH VỤ TRÚC NGUYÊN',
        tenMua: 'CÔNG TY TNHH THƯƠNG MẠI DỊCH VỤ HƯNG THỊNH PHÁT NT',
        ngayLap: '2026-09-21',
        khmsHd: '1',
        khhHd: 'C26TNT',
        soHd: '00075757',
        loaiHoaDon: 'Hóa đơn giá trị gia tăng',
        tienTruocThue: 16960296,
        tienThue: 1356824,
        tongTien: 18317120,
        fileXml: path.join(dir, 'Mua_vao', '4500222022_1_C26TNT_75757_43102b5029.xml'),
        items: [
          { stt: 1, maHang: '1ORC01024', tenHang: 'DẦU THỰC VẬT HẢO HẠNG 880ML', donVi: 'Chai', soLuong: 120, donGia: 31867.28, chietKhau: 0, thanhTien: 3824074, thueSuat: '8%', tienThue: null },
        ],
      };

      const first = insertInvoice(db, record);
      const again = insertInvoice(db, record);
      result.inserted = first.inserted === true;
      result.duplicate_blocked = again.inserted === false && again.reason === 'duplicate';
      result.invoice_key = first.invoiceKey || (findInvoiceByKey(db, '4500222022|1|C26TNT|75757') || {}).invoice_key || '';
      result.invoices = countInvoices(db);
      result.items = countItems(db);
      result.ok = result.inserted && result.duplicate_blocked && result.invoices === 1 && result.items === 1;
    } finally {
      closeDatabase(db);
    }
  } catch (error) {
    result.error = String(error && error.message);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* không xoá được thì bỏ qua */ }
  }
  return result;
}

module.exports = { runSelfCheck };
