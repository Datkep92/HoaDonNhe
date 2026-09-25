'use strict';
// ---------------------------------------------------------------------------
// XML Parser — PROJECT_ARCHITECTURE §16 và §14.
//
// Đọc XML hoá đơn thành bản ghi chuẩn hoá. Không dùng tên file, không đoán dữ liệu
// thiếu (mục 2.7): trường nào XML không có thì để null, không tự tính, không tự suy.
//
// Vì sao regex thay vì thư viện XML: cấu trúc hoá đơn TCT rất ổn định và dự án đã
// có tiền lệ (src/invoice-html.js#extractXmlFields). Nhờ vậy EXE không phình thêm
// dependency. Các khối lồng nhau (TTKhac/TTin) chỉ được đọc ở mức cần thiết.
//
// Đặc điểm dữ liệu thật đã kiểm chứng (xem SOURCE_ANALYSIS.md §5):
//   - SHDon có số 0 đầu trong XML nhưng API trả không có ⇒ chuẩn hoá ở invoice-key.js
//   - NLap là ngày VN dạng YYYY-MM-DD; API trả tdlap dạng UTC ISO
//   - TThue (tiền thuế từng dòng) KHÔNG tồn tại trong 65/65 dòng hàng thật ⇒ để null
//   - NMua của hoá đơn bán ra có thể chỉ có HVTNMHang, KHÔNG có MST
// ---------------------------------------------------------------------------

const { buildInvoiceKey } = require('./invoice-key');
const vnDate = require('../vn-date');

const blockRe = tag => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);

function blockOf(xml, tag) {
  const match = String(xml ?? '').match(blockRe(tag));
  return match ? match[1] : '';
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

function textIn(container, tag) {
  if (!container) return '';
  const match = String(container).match(blockRe(tag));
  return match ? decodeEntities(match[1]).trim() : '';
}

function numberIn(container, tag, warnings, label) {
  if (!container) return null;
  const raw = textIn(container, tag);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    warnings.push(`${label}: giá trị không phải số (${raw.slice(0, 30)}) — để trống, không tự tính.`);
    return null;
  }
  return value;
}

// NLap của XML đã là ngày Việt Nam; tdlap của API là MỐC thời gian UTC. Quy đổi nằm ở MỘT chỗ
// dùng chung (src/vn-date.js) để mọi đường đọc ngày — kho dữ liệu, Excel, HTML/PDF — không lệch nhau.
const toVietnamDate = value => vnDate.isoDay(value);

// §14: NBan/MST == MST hiện tại → SELL; NMua/MST == MST hiện tại → BUY; còn lại → UNKNOWN.
// Không đoán. Hoá đơn bán ra cho người tiêu dùng không có MST người mua vẫn xác định được
// nhờ nhánh NBan (đã kiểm chứng trên XML thật).
function normalizeIdentifiers(currentMst) {
  const values = Array.isArray(currentMst) ? currentMst : [currentMst];
  return new Set(values.map(value => String(value ?? '').trim()).filter(Boolean));
}

function detectDirection({ mstBan, mstMua }, currentMst) {
  const identifiers = normalizeIdentifiers(currentMst);
  if (!identifiers.size) return 'UNKNOWN';
  if (identifiers.has(String(mstBan ?? '').trim())) return 'SELL';
  if (identifiers.has(String(mstMua ?? '').trim())) return 'BUY';
  return 'UNKNOWN';
}

const ITEM_FIELDS = [
  ['stt', 'STT'], ['maHang', 'MHHDVu'], ['tenHang', 'THHDVu'], ['donVi', 'DVTinh'],
];

// Đọc XML → bản ghi khớp cột của data.db (mục 8, 9, 16).
function parseInvoiceXml(xml) {
  const source = String(xml ?? '');
  if (!source.trim()) throw new Error('XML rỗng.');
  if (!/<(?:[A-Za-z0-9_-]+:)?HDon[\s>]/.test(source)) throw new Error('Không phải XML hoá đơn (thiếu thẻ HDon).');

  const warnings = [];
  const ttchung = blockOf(source, 'TTChung');
  const nban = blockOf(source, 'NBan');
  const nmua = blockOf(source, 'NMua');
  const ttoan = blockOf(source, 'TToan');

  const items = [...source.matchAll(/<HHDVu>([\s\S]*?)<\/HHDVu>/g)].map(match => {
    const body = match[1];
    const item = {};
    for (const [field, tag] of ITEM_FIELDS) item[field] = textIn(body, tag) || null;
    // TChat (tính chất dòng: 1 = hàng hoá…) — cần cho bản xem trước A4; KHÔNG lưu vào data.db.
    item.tchat = textIn(body, 'TChat') || null;
    item.stt = item.stt === null ? null : Number(item.stt);
    if (item.stt !== null && !Number.isFinite(item.stt)) { warnings.push('STT không phải số — để trống.'); item.stt = null; }
    item.soLuong = numberIn(body, 'SLuong', warnings, 'SLuong');
    item.donGia = numberIn(body, 'DGia', warnings, 'DGia');
    item.chietKhau = numberIn(body, 'STCKhau', warnings, 'STCKhau');
    item.thanhTien = numberIn(body, 'ThTien', warnings, 'ThTien');
    item.thueSuat = textIn(body, 'TSuat') || null;
    // TThue hầu như không có trong dữ liệu thật ⇒ null, KHÔNG tự tính từ ThTien × TSuat.
    item.tienThue = numberIn(body, 'TThue', warnings, 'TThue');
    return item;
  });

  const ngayLapRaw = textIn(ttchung, 'NLap');
  const record = {
    mstBan: textIn(nban, 'MST') || null,
    tenBan: textIn(nban, 'Ten') || null,
    // NMua của hoá đơn bán cho người tiêu dùng chỉ có HVTNMHang và không có MST.
    mstMua: textIn(nmua, 'MST') || null,
    tenMua: textIn(nmua, 'Ten') || textIn(nmua, 'HVTNMHang') || null,
    // Các trường dưới đây KHÔNG lưu vào data.db (schema mục 8 không có cột tương ứng) — chúng chỉ
    // phục vụ bản xem trước hoá đơn A4, đọc trực tiếp từ XML khi người dùng bấm xem.
    dchiBan: textIn(nban, 'DChi') || null,
    dchiMua: textIn(nmua, 'DChi') || null,
    httToan: textIn(ttchung, 'HTTToan') || null,
    dvtTe: textIn(ttchung, 'DVTTe') || null,
    tgIa: textIn(ttchung, 'TGia') || null,
    msttcgp: textIn(ttchung, 'MSTTCGP') || null,
    mccqt: textIn(source, 'MCCQT') || null,
    ngayLap: toVietnamDate(ngayLapRaw),
    khmsHd: textIn(ttchung, 'KHMSHDon') || null,
    khhHd: textIn(ttchung, 'KHHDon') || null,
    soHd: textIn(ttchung, 'SHDon') || null,
    loaiHoaDon: textIn(ttchung, 'THDon') || null,
    tienTruocThue: numberIn(ttoan, 'TgTCThue', warnings, 'TgTCThue') ?? numberIn(source, 'TgTCThue', warnings, 'TgTCThue'),
    tienThue: numberIn(ttoan, 'TgTThue', warnings, 'TgTThue') ?? numberIn(source, 'TgTThue', warnings, 'TgTThue'),
    tongTien: numberIn(ttoan, 'TgTTTBSo', warnings, 'TgTTTBSo') ?? numberIn(source, 'TgTTTBSo', warnings, 'TgTTTBSo'),
    items,
  };
  if (!record.ngayLap && ngayLapRaw) warnings.push(`NLap không đọc được ngày (${ngayLapRaw.slice(0, 30)}).`);
  return { record, warnings };
}

// Ghép bản ghi + hướng + khoá hoá đơn §13 để đưa vào repository.
// UNKNOWN thì NÉM LỖI có gắn cờ để scanner ghi log/error, không tự chọn hướng.
function buildImportRecord(xml, { currentMst, fileXml } = {}) {
  const { record, warnings } = parseInvoiceXml(xml);
  const direction = detectDirection(record, currentMst);
  if (direction === 'UNKNOWN') {
    const expected = [...normalizeIdentifiers(currentMst)].join(', ');
    throw Object.assign(new Error(`Không xác định được Mua vào/Bán ra: MST người bán (${record.mstBan || 'trống'}) và người mua (${record.mstMua || 'trống'}) đều không thuộc mã nhận diện của hồ sơ (${expected || 'trống'}).`), { unknownDirection: true });
  }
  const invoiceKey = buildInvoiceKey({ mstBan: record.mstBan, khmshDon: record.khmsHd, khhDon: record.khhHd, shDon: record.soHd });
  return { record: { ...record, direction, invoiceKey, fileXml }, warnings, direction };
}

module.exports = { parseInvoiceXml, buildImportRecord, detectDirection, normalizeIdentifiers, toVietnamDate };
