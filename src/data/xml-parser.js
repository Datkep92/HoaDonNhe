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
const providerRegistry = require('./provider-registry');
const { normalizePaymentMethod } = require('./payment-method');
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

// TÓM Mã ĐỊNH DANH CHƯA NHẬN DIỆN trong hoá đơn UNKNOWN (mục 14 mở rộng):
// Bối cảnh thật: hồ sơ MST gốc 4500487170 nhưng người bán lập hoá đơn cho người mua bằng
// CCCD 058168004258 (cùng một người, khác loại mã). detectDirection() từ chối đúng nguyên
// tắc "không đoán", nhưng phải GHI LẠI mã lạ để UI hỏi người dùng gán (CCCD/MST bổ sung)
// thay vì chỉ ném một câu lỗi. Trả về tối đa 2 mã (một bên NBan, một bên NMua).
function unknownParties({ record }, currentMst) {
  const identifiers = normalizeIdentifiers(currentMst);
  const parties = [];
  if (record.mstBan && !identifiers.has(String(record.mstBan).trim())) {
    parties.push({ code: String(record.mstBan).trim(), ten: record.tenBan || '', side: 'ban' });
  }
  if (record.mstMua && !identifiers.has(String(record.mstMua).trim())) {
    parties.push({ code: String(record.mstMua).trim(), ten: record.tenMua || '', side: 'mua' });
  }
  return parties.slice(0, 2);
}

const ITEM_FIELDS = [
  ['stt', 'STT'], ['maHang', 'MHHDVu'], ['tenHang', 'THHDVu'], ['donVi', 'DVTinh'],
];

// ---------------------------------------------------------------------------
// MÃ TRA CỨU + CỔNG TRA CỨU CỦA NHÀ CUNG CẤP (Mục 2)
//
// <TTChung> chứa <TTKhac>, trong đó mỗi <TTin> là bộ ba <TTruong>/<KDLieu>/<DLieu>.
// Đây là nơi nhà cung cấp giấy mã tra cứu để người mua tải PDF GỐC (bản có chữ ký số
// của NCC) từ cổng của họ — thứ mà bản in từ dữ liệu cổng thuế không có.
//
// Đặc điểm đo được trên 86 XML thật: khối này có ~120 khoá khác nhau, phần lớn là dữ liệu
// nghiệp vụ (Amount, TotalAmountInWordsVN, RefID…). Vì vậy KHÔNG tin tên khoá:
//   - `PortalLink` (4/86) là cổng tra cứu thật;
//   - `Extra1` (17/86) CHỈ 3 giá trị là URL, 14 giá trị còn lại là chuỗi thường;
//   - `ZUEQRURL` (3/86) trỏ payoo.vn — cổng THANH TOÁN, không phải cổng tra cứu.
// Do đó: lấy mọi cặp khoá/giá trị, rồi CHỈ nhận giá trị là URL http(s) hợp lệ và loại
// host không phải cổng tra cứu. Không tìm được thì trả null — không dựng, không đoán.
// ---------------------------------------------------------------------------

// Host KHÔNG phải cổng tra cứu hóa đơn: cổng thanh toán, không gian tên XML,
// hạ tầng ký số. Có thật trong dữ liệu thật (payoo.vn, w3.org).
const NON_LOOKUP_HOST = /(^|\.)(payoo\.vn|w3\.org|schema\.org|xmlsoap\.org|verisign\.com)$/i;

// Khoá chứa mã tra cứu, xếp theo độ tin cậy. Đều có thật trong kho người dùng.
const LOOKUP_CODE_KEYS = ['MaTraCuu', 'Fkey', 'SearchKey'];

function isLookupUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^https?:\/\//i.test(text)) return false;
  let host;
  try { host = new URL(text).hostname; } catch { return false; }
  return Boolean(host) && !NON_LOOKUP_HOST.test(host);
}

// KHÔNG BỊA MÃ TRA CỨU TỪ SỐ CỔNG TRONG URL.
//
// Bản đầu lấy `;817501;` trong `https://…vnpt-invoice.com.vn;817501;` rồi coi `817501` là
// mã tra cứu. Dữ liệu thật của khách bác bỏ điều đó: ba hoá đơn liên tiếp 11922/11923/11924
// có "mã" 817501/817502/817503 — đó là CỔNG, không phải mã. Mã tra cứu thật của VNPT trông
// như `pc5P7639265106584137312289813`, dài và không liên quan đến cổng.
//
// Bịa dữ liệu ở đây nguy hiểm hơn vẻ ngoài: có mã thì app tưởng đã đủ điều kiện tải PDF,
// bấm nút sẽ hỏi đúng cái mà người dùng không có, và cột "Tra cứu NCC" báo vàng cho một
// hoá đơn thực ra chưa có gì để tra.
//
// Nên: không có khoá mã trong <TTKhac> thì coi như KHÔNG có mã. Người dùng tự nhập —
// đúng như bản tham chiếu 1.4.20_0 cũng hỏi, và vì mã nằm trên hoá đơn giấy nên không
// có cách nào suy ra.
function codeFromUrl() {
  return '';
}

// Mọi cặp <TTruong> → <DLieu> trong <TTKhac>. Một khoá có thể lặp (nhiều khối
// TTTKhac trong một tờ) nên giữ mảng giá trị theo thứ tự xuất hiện.
function readTTKhac(ttchung) {
  const pairs = [];
  const source = String(ttchung || '');
  for (const block of source.matchAll(/<TTKhac>([\s\S]*?)<\/TTKhac>/g)) {
    for (const item of block[1].matchAll(/<TTruong>([\s\S]*?)<\/TTruong>\s*<KDLieu>[^<]*<\/KDLieu>\s*<DLieu>([\s\S]*?)<\/DLieu>/g)) {
      const key = decodeEntities(item[1]).trim();
      if (key) pairs.push([key, decodeEntities(item[2]).trim()]);
    }
  }
  return pairs;
}

// Trả { url, code, hasUrl } — hasUrl cho biết XML CÓ cổng tra cứu thật hay không, để
// phân biệt "chưa biết" với "biết rồi nhưng không có URL".
function extractLookup(ttchung) {
  const pairs = readTTKhac(ttchung);
  let url = '';
  for (const [, value] of pairs) {
    if (isLookupUrl(value)) { url = value; break; }
  }
  let code = '';
  for (const key of LOOKUP_CODE_KEYS) {
    for (const [k, value] of pairs) {
      if (k.toLowerCase() === key.toLowerCase() && value) { code = value; break; }
    }
    if (code) break;
  }
  if (!code) code = codeFromUrl(url);
  return { url, code, hasUrl: Boolean(url) };
}

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
  const dscks = blockOf(source, 'DSCKS');

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
  const lookup = extractLookup(ttchung);
  const solution = providerRegistry.resolve(textIn(ttchung, 'MSTTCGP'));
  // Tách ra trước vì lookupUrl cần MST người bán (cổng VNPT là tenant riêng theo
  // từng người bán) mà bản ghi chưa dựng xong.
  const mstBan = textIn(nban, 'MST') || null;
  // LÀM SẠCH URL ngay tại nguồn. XML của VNPT ghi cổng dạng `https://host;817501;` — dấu
  // `;…` dính vào TÊN MIỀN nên URI đó không mở được, và nó cũng không khớp kiểm tra
  // tên miền `.vn$`. Nếu lưu nguyên xi thì cột "Cổng tra cứu NCC" trong Excel và mọi
  // kiểm tra tên miền về sau đều dính rác. cleanPortalUrl() trả '' nếu URL không dùng
  // được ⇒ lưu null, thành "chưa biết" còn hơn lưu một URL bị hỏng.
  const rawLookupUrl = lookup.url
    || providerRegistry.sellerPortal(mstBan)
    || (solution ? solution.portalUrl : '')
    || '';
  const cleaned = require('./original-pdf').cleanPortalUrl(rawLookupUrl);
  const lookupUrl = cleaned || null;
  const record = {
    mstBan,
    tenBan: textIn(nban, 'Ten') || null,
    // NMua của hoá đơn bán cho người tiêu dùng chỉ có HVTNMHang và không có MST.
    mstMua: textIn(nmua, 'MST') || null,
    tenMua: textIn(nmua, 'Ten') || textIn(nmua, 'HVTNMHang') || null,
    // Các trường dưới đây KHÔNG lưu vào data.db (schema mục 8 không có cột tương ứng) — chúng chỉ
    // phục vụ bản xem trước hoá đơn A4, đọc trực tiếp từ XML khi người dùng bấm xem.
    dchiBan: textIn(nban, 'DChi') || null,
    dchiMua: textIn(nmua, 'DChi') || null,
    // Cửa hàng / điện thoại người bán — XML có sẵn (MCHang, TCHang, SDThoai) nhưng trước đây
    // không đọc, nên bản xem trước A4 thiếu 3 dòng này trong khi bản tải PDF (dựng từ detail
    // của cổng) có ⇒ người dùng xem một đằng, nhận một nằng.
    maCh: textIn(nban, 'MCHang') || null,
    tenCh: textIn(nban, 'TCHang') || textIn(nban, 'TDDKDoanh') || null,
    dtBan: textIn(nban, 'SDThoai') || null,
    // "Tổng tiền bằng chữ": TTCKTMai trong XML là con số (thường 0), chữ nằm ở TgTTTBChu.
    tongTienChu: textIn(ttoan, 'TgTTTBChu') || null,
    // Chữ ký số: DSCKS chứa SigningTime và X509SubjectName (dạng DN, có CN=...).
    cksSigningTime: textIn(dscks, 'SigningTime') || null,
    cksX509SubjectName: textIn(dscks, 'X509SubjectName') || null,
    httToan: textIn(ttchung, 'HTTToan') || null,
    paymentMethodRaw: textIn(ttchung, 'HTTToan') || null,
    paymentMethod: normalizePaymentMethod(textIn(ttchung, 'HTTToan')),
    dvtTe: textIn(ttchung, 'DVTTe') || null,
    tgIa: textIn(ttchung, 'TGia') || null,
    msttcgp: textIn(ttchung, 'MSTTCGP') || null,
    // Mã tra cứu / cổng tra cứu của NCC (Mục 2). Ưu tiên URL học từ XML; XML không có
    // thì mới dùng cổng mặc định theo nhà cung cấp — và CHỈ khi nhà cung cấp đó thật sự
    // có một cổng dùng chung (VNPT/Viettel mỗi khách một tenant nên cố tình để trống).
    lookupCode: lookup.code || null,
    // Thứ tự ưu tiên: URL thật trong XML → cổng riêng của người bán (VNPT mỗi khách
    // một tenant) → cổng chung của nhà cung cấp. Cả ba đều không có thì để null.
    lookupUrl,
    providerId: solution ? solution.id : null,
    providerName: solution ? solution.name : null,
    providerLevel: solution ? solution.level : null,
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
    // unknownParties gắn KÈM lỗi để scanner ghi ma-chua-xac-dinh.json — người dùng gán mã
    // (vd CCCD 058168004258 của cùng người MST 4500487170) rồi lượt quét sau tự nhập lại.
    throw Object.assign(new Error(`Không xác định được Mua vào/Bán ra: MST người bán (${record.mstBan || 'trống'}) và người mua (${record.mstMua || 'trống'}) đều không thuộc mã nhận diện của hồ sơ (${expected || 'trống'}).`), { unknownDirection: true, unknownParties: unknownParties({ record }, currentMst) });
  }
  const invoiceKey = buildInvoiceKey({ mstBan: record.mstBan, khmshDon: record.khmsHd, khhDon: record.khhHd, shDon: record.soHd });
  return { record: { ...record, direction, invoiceKey, fileXml }, warnings, direction };
}

module.exports = { parseInvoiceXml, buildImportRecord, detectDirection, unknownParties, normalizeIdentifiers, toVietnamDate, readTTKhac, extractLookup, isLookupUrl };


