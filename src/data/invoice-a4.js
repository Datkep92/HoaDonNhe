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

function toInvoiceShape(record, state) {
  const inv = {
    hdon: '01',
    khmshdon: record.khmsHd || '',
    khhdon: record.khhHd || '',
    shdon: record.soHd || '',
    tdlap: record.ngayLap || '',
    nbten: record.tenBan || '',
    nbmst: record.mstBan || '',
    // Khoá phải trùng tên invoice-html.js đọc (dòng ~173): nbmch / nbtch / nbdt.
    nbmch: record.maCh || '',
    nbtch: record.tenCh || '',
    nbdt: record.dtBan || '',
    nmten: record.tenMua || '',
    nmmst: record.mstMua || '',
    dvtte: record.dvtTe || '',
    tgia: record.tgIa || '',
    msttcgp: record.msttcgp || '',
    tgtcthue: record.tienTruocThue || 0,
    tgtthue: record.tienThue || 0,
    tgtttbso: record.tongTien || 0,
    // Trạng thái hoá đơn KHÔNG có trong XML — nguồn duy nhất là kết quả tra cứu. Bản trước
    // hard-code 1 ("Hóa đơn mới"): giá trị BỊA. Nay lấy từ tham số; không biết thì để null,
    // KHÔNG đoán là "mới".
    tthai: state ?? null,
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
    tgtttbchu: record.tongTienChu || '',
    // invoice-html.js đọc chữ ký số qua JSON trong `nbcks` (Subject hoặc X509SubjectName đều
    // được, signerCommonName tự bóc CN=). Rỗng ⇒ không vẽ khung "Signature Valid".
    nbcks: (record.cksSigningTime || record.cksX509SubjectName)
      ? JSON.stringify({
        SigningTime: record.cksSigningTime || '',
        Subject: record.cksX509SubjectName || '',
      })
      : '',
    hdhhdvu: items,
  };
  return { inv, detail };
}

// xmlText: nội dung 1 file XML hoá đơn. options.state = tthai (từ sổ trạng thái tra cứu) — KHÔNG
// có trong XML nên phải truyền vào; thiếu thì bỏ trống, không đoán.
function buildInvoiceA4(xmlText, options = {}) {
  const { record } = parseInvoiceXml(xmlText);
  const { inv, detail } = toInvoiceShape(record, options.state);
  return invoiceHtml(inv, detail);
}

// Tài liệu A4 nhúng vào iframe: thêm meta viewport + CSS để TỰ VỪA KHUNG XEM (thu nhỏ theo bề rộng),
// nền xám nhẹ để thấy rõ tờ giấy. Bộ dựng gốc vốn dành cho in/nên không có mấy phần này.
const FIT_STYLE = `<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="hd-fit">
  html, body { margin: 0; padding: 8px; background: #eef1f4; }
  body { -webkit-text-size-adjust: 100%; }
  .hd-state { max-width: 1150px; margin: 0 auto 8px; padding: 6px 10px; box-sizing: border-box; text-align: center;
    background: #fff6dc; border: 1px solid #e0b451; border-radius: 4px;
    font-family: "Times New Roman", Times, serif; font-size: 13px; font-weight: 700; color: #7a4a00; }
  .hd-state.hd-warn { background: #fde4e4; border-color: #d98b8b; color: #8a1f1f; }
  @media (max-width: 1160px) { body { zoom: .95; } }
  @media (max-width: 1020px) { body { zoom: .86; } }
  @media (max-width: 900px)  { body { zoom: .76; } }
  @media (max-width: 780px)  { body { zoom: .64; } }
  @media (max-width: 660px)  { body { zoom: .54; } }
  /* Khung xem RỘNG thì PHÓNG TO tờ hoá đơn — nếu không, nới hộp thoại chỉ thêm khoảng trắng:
     bề rộng tờ giấy là 210mm (~794px) và .main-page KHÔNG tự lớn lên (xem invoice-html.js).
     Ngưỡng tính theo BỀ RỘNG CỦA IFRAME (media query trong iframe đo chính nó), nên đúng cho cả
     hai hộp thoại xem trước dù chúng rộng khác nhau, và luôn đủ chỗ (794 x 1.3 = 1032 < 1161;
     794 x 1.6 = 1270 < 1440) nên không bị cắt vì overflow:hidden.
     CHỈ áp cho màn hình: bản In / Lưu PDF đi theo media "print" nên không bị phóng to lệch khổ. */
  @media screen and (min-width: 1161px) { body { zoom: 1.3; } }
  @media screen and (min-width: 1440px) { body { zoom: 1.6; } }
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

// Tờ A4 phải GIỐNG bản của cổng thuế, nên dòng trạng thái do ứng dụng thêm được đặt NGOÀI khối
// .main-page (không sửa vào bản sao) nhưng vẫn in ra PDF để người xem biết ngay hoá đơn này là bản
// thay thế / đã bị thay thế. Không biết trạng thái thì KHÔNG thêm gì.
const STATE_NOTE = { 1: 'Hóa đơn mới', 2: 'Hóa đơn thay thế', 3: 'Hóa đơn điều chỉnh', 4: 'Đã bị thay thế', 5: 'Đã bị điều chỉnh', 6: 'Đã bị hủy' };
function statusNote(state) {
  const text = STATE_NOTE[String(state ?? '')];
  if (!text) return '';
  const warn = ['4', '5', '6'].includes(String(state)) ? ' hd-warn' : '';
  return `<div class="hd-state${warn}">Trạng thái hoá đơn: ${text}</div>`;
}
function withStatusNote(html, state) {
  const note = statusNote(state);
  const source = String(html || '');
  if (!note) return source;
  const body = source.indexOf('<body');
  if (body < 0) return note + source;
  const end = source.indexOf('>', body);
  if (end < 0) return note + source;
  return `${source.slice(0, end + 1)}${note}${source.slice(end + 1)}`;
}

function buildInvoiceA4Document(xmlText, options = {}) {
  return withStatusNote(withFitStyle(buildInvoiceA4(xmlText, options)), options.state);
}

module.exports = { buildInvoiceA4, buildInvoiceA4Document, withFitStyle, withStatusNote, statusNote, toInvoiceShape };
