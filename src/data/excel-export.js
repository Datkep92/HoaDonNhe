'use strict';
// ---------------------------------------------------------------------------
// Xuất Excel "Kho dữ liệu" — MỘT workbook, MỘT nút dùng chung cho cả 3 tab.
// Mỗi chiều / mỗi loại đối tác nằm RIÊNG một sheet:
//   • Hóa đơn mua vào  | Hóa đơn bán ra
//   • Hàng hóa mua vào | Hàng hóa bán ra
//   • Nhà cung cấp     | Khách hàng
//
// Hóa đơn + hàng hóa theo ĐÚNG bộ lọc đang xem (q + khoảng ngày).
// RIÊNG 2 sheet đối tác (Nhà cung cấp / Khách hàng) là DANH BẠ: luôn đủ danh sách, không lọc theo kỳ
// — khớp đúng tab "Đối tác" trên màn hình. Xuất được TẤT CẢ hoặc RIÊNG từng bảng (tham số `parts`).
// Nguồn dữ liệu là data.db (SQLite) — KHÔNG quét XML, KHÔNG gọi mạng.
// ---------------------------------------------------------------------------

const XLSX = require('../../resources/xlsx.cjs');
const queries = require('./queries');
const vnDate = require('../vn-date');

const SHEET = {
  buy: 'Hóa đơn mua vào',
  sell: 'Hóa đơn bán ra',
  productsBuy: 'Hàng hóa mua vào',
  productsSell: 'Hàng hóa bán ra',
  suppliers: 'Nhà cung cấp',
  buyers: 'Khách hàng',
};

const INVOICE_HEADERS = ['STT', 'Ngày lập', 'Ký hiệu', 'Số hóa đơn', 'MST người bán', 'Tên người bán', 'MST người mua', 'Tên người mua', 'Tiền trước thuế', 'Tiền thuế', 'Tổng tiền'];
const INVOICE_WIDTHS = [6, 12, 16, 14, 16, 38, 16, 38, 16, 14, 16];
const PRODUCT_HEADERS = ['Mã hàng', 'Tên hàng', 'ĐVT', 'Thuế suất', 'Số lượng', 'Thành tiền', 'Tiền thuế'];
const PRODUCT_WIDTHS = [18, 46, 10, 10, 14, 18, 14];
const PARTNER_HEADERS = ['MST', 'Tên', 'Số hóa đơn', 'Tổng tiền', 'Tiền thuế'];
const PARTNER_WIDTHS = [16, 48, 12, 18, 14];

// dd/mm/yyyy — dùng CHUNG bộ quy đổi ngày (src/vn-date.js) với mọi đường đọc ngày khác.
// `ngay_lap` trong data.db đã là ngày VN nên ở đây chỉ còn định dạng, không cộng thêm giờ.
const dmy = value => vnDate.dmy(value);
// Tiền: giữ số (Excel cộng được), giá trị thiếu ⇒ để trống thay vì 0 để không sai lệch tổng.
const money = value => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

function addSheet(book, name, headers, rows, widths) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = widths.map(wch => ({ wch }));
  if (rows.length) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
  XLSX.utils.book_append_sheet(book, sheet, name);
  return rows.length;
}

// Khoảng ngày — dùng chung cho mọi sheet.
function rangeConditions(filters, column = 'ngay_lap') {
  const where = [];
  const params = [];
  if (filters.from) { where.push(`${column} >= ?`); params.push(filters.from); }
  if (filters.to) { where.push(`${column} <= ?`); params.push(filters.to); }
  return { where, params };
}

// Danh sách hoá đơn MỘT chiều — dùng CHUNG mệnh đề WHERE với tab Danh sách (kể cả tìm kiếm FTS5).
function invoiceRows(db, direction, filters) {
  const { clause, params } = queries.invoiceWhere(db, { ...filters, direction });
  const rows = db.prepare(`SELECT ngay_lap, khms_hd, khh_hd, so_hd, mst_ban, ten_ban, mst_mua, ten_mua,
      tien_truoc_thue, tien_thue, tong_tien
    FROM invoices ${clause}
    ORDER BY ngay_lap ASC, id ASC`).all(...params);
  return rows.map((row, index) => [
    index + 1,
    dmy(row.ngay_lap),
    [row.khms_hd, row.khh_hd].filter(Boolean).join(' '),
    row.so_hd || '',
    row.mst_ban || '',
    row.ten_ban || '',
    row.mst_mua || '',
    row.ten_mua || '',
    money(row.tien_truoc_thue),
    money(row.tien_thue),
    money(row.tong_tien),
  ]);
}

// Hàng hóa MỘT chiều: gộp theo (mã + tên + ĐVT + thuế suất) — giống hệt tab Hàng hóa.
function productRows(db, direction, filters) {
  const range = rangeConditions(filters, 'v.ngay_lap');
  const where = ['v.direction = ?', ...range.where];
  const params = [direction, ...range.params];
  const text = String(filters.q || '').trim();
  const having = text ? 'HAVING (i.ma_hang LIKE ? OR i.ten_hang LIKE ?)' : '';
  if (text) params.push(`%${text}%`, `%${text}%`);
  const rows = db.prepare(`SELECT i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat,
      SUM(i.so_luong) AS tong_so_luong, SUM(i.thanh_tien) AS tong_tien, SUM(i.tien_thue) AS tong_thue
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE ${where.join(' AND ')}
    GROUP BY i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat
    ${having}
    ORDER BY tong_tien DESC`).all(...params);
  return rows.map(row => [
    row.ma_hang || '',
    row.ten_hang || '',
    row.don_vi || '',
    row.thue_suat || '',
    Number(row.tong_so_luong) || 0,
    money(row.tong_tien),
    money(row.tong_thue),
  ]);
}

// Đối tác MỘT loại: kind = 'supplier' (nhà cung cấp, hoá đơn mua vào) | 'buyer' (khách hàng, bán ra).
// KHÔNG lọc theo kỳ: tab "Đối tác" trên màn hình là DANH BẠ đối tác (tổng hợp mọi hoá đơn đã nhập),
// nên sheet đối tác cũng phải đủ danh sách. Nếu lọc theo kỳ, kỳ không có hoá đơn mua vào sẽ cho
// sheet Nhà cung cấp rỗng trong khi màn hình vẫn hiện — đúng lỗi người dùng đã gặp 2 lần.
const PARTNER_KIND = { supplier: { direction: 'BUY', mst: 'mst_ban', ten: 'ten_ban' }, buyer: { direction: 'SELL', mst: 'mst_mua', ten: 'ten_mua' } };
function partnerRows(db, kind) {
  const spec = PARTNER_KIND[kind];
  const rows = db.prepare(`SELECT ${spec.mst} AS mst, ${spec.ten} AS ten,
      COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE direction = ?
    GROUP BY ${spec.mst}, ${spec.ten}
    ORDER BY tong_tien DESC`).all(spec.direction);
  return rows.map(row => [
    row.mst || '',
    row.ten || '',
    Number(row.so_hoa_don) || 0,
    money(row.tong_tien),
    money(row.tong_thue),
  ]);
}

// parts: danh sách bảng muốn xuất (thiếu ⇒ xuất TẤT CẢ). Dùng cho "xuất tất cả" và "xuất riêng lẻ".
const PARTS = ['buy', 'sell', 'productsBuy', 'productsSell', 'suppliers', 'buyers'];

// MỌI sheet đều theo ĐÚNG bộ lọc đang xem (q + khoảng ngày), kể cả 2 sheet đối tác.
function buildWorkbook(db, filters = {}, parts) {
  // Danh sách bảng hợp lệ; rỗng hoặc toàn mã lạ ⇒ xuất TẤT CẢ (không bao giờ ra workbook trắng).
  const requested = Array.isArray(parts) ? parts.filter(part => PARTS.includes(part)) : [];
  const wanted = new Set(requested.length ? requested : PARTS);
  const book = XLSX.utils.book_new();
  const counts = {};
  if (wanted.has('buy')) counts.buy = addSheet(book, SHEET.buy, INVOICE_HEADERS, invoiceRows(db, 'BUY', filters), INVOICE_WIDTHS);
  if (wanted.has('sell')) counts.sell = addSheet(book, SHEET.sell, INVOICE_HEADERS, invoiceRows(db, 'SELL', filters), INVOICE_WIDTHS);
  if (wanted.has('productsBuy')) counts.productsBuy = addSheet(book, SHEET.productsBuy, PRODUCT_HEADERS, productRows(db, 'BUY', filters), PRODUCT_WIDTHS);
  if (wanted.has('productsSell')) counts.productsSell = addSheet(book, SHEET.productsSell, PRODUCT_HEADERS, productRows(db, 'SELL', filters), PRODUCT_WIDTHS);
  if (wanted.has('suppliers')) counts.suppliers = addSheet(book, SHEET.suppliers, PARTNER_HEADERS, partnerRows(db, 'supplier'), PARTNER_WIDTHS);
  if (wanted.has('buyers')) counts.buyers = addSheet(book, SHEET.buyers, PARTNER_HEADERS, partnerRows(db, 'buyer'), PARTNER_WIDTHS);
  return { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), counts, parts: [...wanted] };
}

// Tên file tải về: kho-du-lieu-<MST>-<YYYYMMDD-HHMM>.xlsx
// Xuất riêng 1 bảng thì chèn tên bảng vào tên file cho dễ nhận biết.
function fileName(mst, now = new Date(), parts) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const one = Array.isArray(parts) && parts.length === 1 && PARTS.includes(parts[0]) ? `${parts[0]}-` : '';
  return `kho-du-lieu-${one}${mst || 'MST'}-${stamp}.xlsx`;
}

module.exports = { buildWorkbook, fileName, SHEET, PARTS, INVOICE_HEADERS, PRODUCT_HEADERS, PARTNER_HEADERS, INVOICE_WIDTHS, PRODUCT_WIDTHS, PARTNER_WIDTHS, invoiceRows, productRows, partnerRows };
