'use strict';
// Xuất Excel ĐÚNG theo file mẫu MISA "DANH SÁCH HÓA ĐƠN":
//   sheet tên "sheet 1", 2 dòng trống đầu, dòng 3 = tiêu đề, dòng 4 = "Từ ngày … đến ngày …",
//   dòng 5 trống, dòng 6 = header 19 cột, dữ liệu từ dòng 7.
// Kiểu dữ liệu theo mẫu: STT = số (định dạng ô text), Ngày lập = text dd/mm/yyyy,
// MST/số hóa đơn/ký hiệu = text, tiền = số, Tỷ giá = text "1.0", Tổng tiền phí để trống nếu không có.
// Dữ liệu lấy từ CHÍNH kết quả tra cứu (không gọi API chi tiết, không tải XML/PDF).
const XLSX = require('../resources/xlsx.cjs');
const vnDate = require('./vn-date');

const HEADERS = ['STT', 'Ký hiệu mẫu số', 'Ký hiệu hóa đơn', 'Số hóa đơn', 'Ngày lập', 'MST người bán/MST người xuất hàng', 'Tên người bán/Tên người xuất hàng', 'MST người mua/MST người nhận hàng', 'Tên người mua/Tên người nhận hàng', 'Địa chỉ người mua', 'Tổng tiền chưa thuế', 'Tổng tiền thuế', 'Tổng tiền chiết khấu thương mại', 'Tổng tiền phí', 'Tổng tiền thanh toán', 'Đơn vị tiền tệ', 'Tỷ giá', 'Trạng thái hóa đơn', 'Kết quả kiểm tra hóa đơn'];
const WIDTHS = [7.36, 11.27, 11.27, 11.27, 19.09, 30.82, 30.82, 30.82, 30.82, 30.82, 11.27, 11.27, 19.09, 19.09, 19.09, 11.27, 11.27, 19.09, 50.36];
const SHEET_NAME = 'sheet 1';
const TITLE = 'DANH SÁCH HÓA ĐƠN';
// "Trạng thái hóa đơn" (tthai) — đúng nhãn MISA dùng trong file mẫu
const INVOICE_STATE = { 1: 'Hóa đơn mới', 2: 'Hóa đơn thay thế', 3: 'Hóa đơn điều chỉnh', 4: 'Đã bị thay thế', 5: 'Đã bị điều chỉnh', 6: 'Đã bị hủy' };
// "Kết quả kiểm tra hóa đơn" (ttxly): 5/8 = hóa đơn có mã, 6 = hóa đơn không có mã
const CHECK_RESULT = { 5: 'Đã cấp mã hóa đơn', 8: 'Đã cấp mã hóa đơn', 6: 'Hóa đơn không có mã' };
const NOTES = [
  'Mọi cột đều lấy từ kết quả tra cứu; không gọi API chi tiết, không tải XML/PDF.',
  '`Tổng tiền phí` (tgtphi) trống trong kết quả tra cứu nên để trống — giống file mẫu.',
  '`Kết quả kiểm tra hóa đơn` suy ra từ `ttxly` (5/8 → Đã cấp mã hóa đơn, 6 → Hóa đơn không có mã).'
];

const text = value => (value === null || value === undefined ? '' : String(value));
const money = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const optionalMoney = value => (value === null || value === undefined || value === '' ? null : money(value));
const rate = value => (value === null || value === undefined || value === '' ? '' : Number(value).toFixed(1));
// Ngày lập của cổng thuế (`tdlap`) là một MỐC thời gian UTC, ví dụ "2026-08-30T17:00:00Z" chính là
// 00:00 ngày 31/08 giờ Việt Nam. Cắt thẳng 10 ký tự đầu sẽ lệch MỘT NGÀY (lỗi thật: tra
// 01/08–31/08 mà file ghi "Từ ngày 31/07 đến ngày 30/08"). Quy đổi nằm ở src/vn-date.js.
// `meta.from`/`meta.to` là ngày VN dạng YYYY-MM-DD nên đi qua đây cũng ra đúng như cũ.
const isoToDmy = value => vnDate.dmy(value);

// 1 dòng dữ liệu đúng 19 cột theo mẫu
function rowOf(item, index) {
  const i = item.invoice || {};
  return [
    index + 1,
    text(i.khmshdon),
    text(i.khhdon),
    text(i.shdon),
    isoToDmy(i.tdlap),
    text(i.nbmst),
    text(i.nbten),
    text(i.nmmst),
    text(i.nmten),
    text(i.nmdchi),
    money(i.tgtcthue),
    money(i.tgtthue),
    money(i.ttcktmai),
    optionalMoney(i.tgtphi),
    money(i.tgtttbso),
    text(i.dvtte),
    rate(i.tgia),
    INVOICE_STATE[i.tthai] || text(i.tthai),
    CHECK_RESULT[i.ttxly] || text(i.ttxly)
  ];
}
const rows = items => items.map(rowOf);
const columnNames = () => [...HEADERS];

function workbook(items, meta = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    [],
    [],
    [TITLE],
    [`Từ ngày ${isoToDmy(meta.from)} đến ngày ${isoToDmy(meta.to)}`],
    [],
    [...HEADERS],
    ...rows(items)
  ]);
  sheet['!cols'] = WIDTHS.map(wch => ({ wch }));
  // STT là số nhưng định dạng ô là text — giống đúng file mẫu.
  for (let index = 0; index < items.length; index += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 6 + index, c: 0 })];
    if (cell) cell.z = '@';
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, SHEET_NAME);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { workbook, rows, rowOf, columnNames, HEADERS, WIDTHS, SHEET_NAME, TITLE, NOTES, INVOICE_STATE, CHECK_RESULT, isoToDmy };
