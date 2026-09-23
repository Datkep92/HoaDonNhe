'use strict';
// ---------------------------------------------------------------------------
// Bản xem trước hoá đơn khổ A4 (chuẩn Tổng cục Thuế) — PROJECT_ARCHITECTURE §35.
//
// TÁI DÙNG bộ dựng sẵn có của dự án (src/invoice-html.js) thay vì viết bản thứ hai (mục 76):
// bộ đó đã dựng đúng như trang tra cứu của cổng thuế và đã tự escape HTML (dòng esc()).
// Ở đây chỉ làm một việc: đổi bản ghi hoá đơn (đọc từ XML) sang dạng trường mà bộ dựng đó
// mong đợi. Tên trường lấy đúng theo invoice-html.js đang đọc — không suy đoán.
//
// Vì chỉ có XML (không gọi API chi tiết — mục 48/50), một số thứ thuộc API detail sẽ trống:
// chuỗi QR (`qrcode`) và bảng thuế suất chi tiết. Bộ dựng đã xử lý phần thiếu bằng cách bỏ trống.
// ---------------------------------------------------------------------------

const { invoiceHtml } = require('../invoice-html');
const { parseInvoiceXml } = require('./xml-parser');

function toInvoiceShape(record) {
  const inv = {
    hdon: '01',
    khmshdon: record.khmsHd || '',
    khhdon: record.khhHd || '',
    shdon: record.soHd || '',
    tdlap: record.ngayLap || '',
    nbten: record.tenBan || '',
    nbmst: record.mstBan || '',
    nmten: record.tenMua || '',
    nmmst: record.mstMua || '',
    dvtte: record.dvtTe || '',
    tgia: record.tgIa || '',
    msttcgp: record.msttcgp || '',
    tgtcthue: record.tienTruocThue || 0,
    tgtthue: record.tienThue || 0,
    tgtttbso: record.tongTien || 0,
    tthai: 1,
  };
  const items = (record.items || []).map(item => ({
    tchat: item.tchat,
    mhhdvu: item.maHang || '',
    ten: item.tenHang || '',
    dvtinh: item.donVi || '',
    sluong: item.soLuong,
    dgia: item.donGia,
    stckhau: item.chietKhau,
    ltsuat: item.thueSuat || '',
    thtien: item.thanhTien,
  }));
  const detail = {
    ...inv,
    nbdchi: record.dchiBan || '',
    nmdchi: record.dchiMua || '',
    thtttoan: record.httToan || '',
    // MCCQT và NLap: bộ dựng ưu tiên hai khoá `_xml*` này khi dựng HTML (xem withXmlFields).
    _xmlMccqt: record.mccqt || null,
    _xmlNlap: record.ngayLap || null,
    hdhhdvu: items,
  };
  return { inv, detail };
}

// xmlText: nội dung 1 file XML hoá đơn. Trả về chuỗi HTML của tờ A4.
function buildInvoiceA4(xmlText) {
  const { record } = parseInvoiceXml(xmlText);
  const { inv, detail } = toInvoiceShape(record);
  return invoiceHtml(inv, detail);
}

// Tài liệu A4 nhúng vào iframe: thêm meta viewport + CSS để TỰ VỪA KHUNG XEM (thu nhỏ theo bề rộng),
// nền xám nhẹ để thấy rõ tờ giấy. Bộ dựng gốc vốn dành cho in/nên không có mấy phần này.
const FIT_STYLE = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="hd-fit">
  html, body { margin: 0; padding: 8px; background: #eef1f4; }
  body { -webkit-text-size-adjust: 100%; }
  @media (max-width: 1160px) { body { zoom: .95; } }
  @media (max-width: 1020px) { body { zoom: .86; } }
  @media (max-width: 900px)  { body { zoom: .76; } }
  @media (max-width: 780px)  { body { zoom: .64; } }
  @media (max-width: 660px)  { body { zoom: .54; } }
</style>`;

function withFitStyle(html) {
  const source = String(html || '');
  const head = source.indexOf('<head>');
  if (head >= 0) return `${source.slice(0, head + 6)}${FIT_STYLE}${source.slice(head + 6)}`;
  const htmlTag = source.indexOf('<html');
  if (htmlTag >= 0) {
    const end = source.indexOf('>', htmlTag);
    return `${source.slice(0, end + 1)}<head>${FIT_STYLE}</head>${source.slice(end + 1)}`;
  }
  return `${FIT_STYLE}${source}`;
}

function buildInvoiceA4Document(xmlText) {
  return withFitStyle(buildInvoiceA4(xmlText));
}

module.exports = { buildInvoiceA4, buildInvoiceA4Document, withFitStyle, toInvoiceShape };
