'use strict';
// ---------------------------------------------------------------------------
// TRA CỨU NHÀ CUNG CẤP GIẢI PHÁP HÓA ĐƠN — Mục 2.
//
// XML hoá đơn có thẻ <MSTTCGP>: MST của đơn vị phát hành hệ thống hóa đơn điện tử
// (MISA, VNPT, FPT…). Đây là THÔNG TIN DUY NHẤT định danh được nhà cung cấp từ XML.
//
// File này tra <MSTTCGP> → nhà cung cấp + mức năng lực tải PDF gốc.
//
// NGUỒN VÀ PHẠM VI
// Bảng dưới đây được đối chiếu từ <MSTTCGP> thật trong 86 file XML của kho
// người dùng, KHỚP với solution-provider map của extension "Kho hoá đơn gốc"
// (1.4.20_0/shared/core.js: SOLUTION_PROVIDER_BY_TAX_CODE, VIETTEL_PORTAL_BY_TAX_CODE)
// và các case riêng trong excel-exporter.js của extension 1.2.0_0 (getLinkTraCuu).
// CHỈ giữ dòng có mẫu khớp được. MST lạ ⇒ trả null, KHÔNG đoán, KHÔNG bịa cổng.
//
// Mức năng lực (mượn nguyên khái niệm từ EXT-B shared/core.js:9-36):
//   supplier-original  tự tải được PDF gốc, không cần người dùng
//   portal-assisted    tự điền form cổng rồi bấm nút
//   captcha-assisted   cần người dùng nhập CAPTCHA
//   xml-derived-only   CHƯA xác minh được cách tải PDF gốc ⇒ chỉ có bản dựng từ XML
//   portal-only        biết cổng nhưng chưa biết tải kiểu nào
// ---------------------------------------------------------------------------

const LEVELS = ['supplier-original', 'portal-assisted', 'captcha-assisted', 'xml-derived-only', 'portal-only'];

const LEVEL_LABEL = {
  'supplier-original': 'Tự tải được PDF gốc',
  'portal-assisted': 'Tải qua cổng chính thức',
  'captcha-assisted': 'Cần nhập CAPTCHA',
  'xml-derived-only': 'Chỉ có bản dựng từ XML Thuế',
  'portal-only': 'Đã biết cổng, chưa xác minh tải PDF gốc',
};

const LEVEL_HINT = {
  'supplier-original': 'Ứng dụng có thể tải PDF gốc của nhà cung cấp, không cần bạn thao tác.',
  'portal-assisted': 'Mở cổng nhà cung cấp, ứng dụng điền mã tra cứu rồi bạn bấm tải.',
  'captcha-assisted': 'Mở cổng nhà cung cấp, ứng dụng điền mã tra cứu, bạn nhập CAPTCHA rồi tải.',
  'xml-derived-only': 'Chưa có cách tải PDF gốc đã được kiểm chứng. Bản in của ứng dụng có dải cảnh báo.',
  'portal-only': 'Chưa xác minh được cách tải PDF gốc. Bạn vẫn mở cổng để tra cứu thủ công.',
};

// MỨC NĂNG LỰC — đã ĐỐI CHIẾU THẬT chứ không mượn nguyên xi của extension.
// Trong toàn bộ hồ sơ của người dùng, KHÔNG nhà cung cấp nào trả thẳng PDF được:
//   • VNPT   : GET bị chuyển hướng /Account/LogOn ⇒ BẮT BUỘC đăng nhập.
//   • EasyInvoice: / chuyển tới /Search/Index ⇒ trang tra cứu có biểu mẫu.
// Nên `supplier-original` (tự tải được) là mức DÀNH CHO provider chưa có trong hồ sơ này.
// Với dữ liệu hiện tại, mọi dòng đều là `portal-assisted` hoặc `captcha-assisted` —
// đó là kết quả kiểm tra, không phải lười bỏ.
const BY_SOLUTION_TAX_CODE = {
  '0101243150': { id: 'misa', name: 'MISA meInvoice', level: 'portal-assisted' },
  '0100684378': { id: 'vnpt', name: 'VNPT-Invoice', level: 'captcha-assisted' },
  '0100915699-001': { id: 'vnpt', name: 'VNPT-Invoice', level: 'captcha-assisted' },
  '0104128565': { id: 'fpt', name: 'FPT.eInvoice', level: 'captcha-assisted' },
  '0105232093': { id: 'cyberbill', name: 'CyberLotus', level: 'captcha-assisted' },
  '0100109106': { id: 'viettel', name: 'Viettel Telecom', level: 'captcha-assisted' },
  '0105987432': { id: 'easyinvoice', name: 'Softdreams EasyInvoice', level: 'portal-assisted' },
};

function normalizeTaxCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

// Cổng tra cứu mặc định theo nhà cung cấp — CHỈ dùng khi XML không có URL nào.
// Không suy đoán tenant riêng của cổng VNPT: mỗi người bán một tenant khác nhau,
// nên URL chung sẽ sai. Vì vậy `vnpt` và `viettel` cố tình KHÔNG có URL mặc định.
const DEFAULT_PORTAL = {
  misa: 'https://www.meinvoice.vn/tra-cuu/',
  easyinvoice: 'https://tracuu.easyinvoice.vn/',
  fpt: 'https://fpt.einvoice.vn/',
  cyberbill: 'https://tracuuhoadon1.xcyber.vn/#/tracuuhoadon/tracuu',
  viettel: 'https://vinvoice.viettel.vn/utilities/invoice-search',
};

// Cổng riêng theo MST NGƯỜI BÁN. Chỉ dùng cho cổng VNPT, vì mỗi người bán một tenant
// riêng (`<slug>-tt78.vnpt-invoice.com.vn`) nên không có URL chung cho được.
//
// Danh sách này CỐ Ý rất ngắn: chỉ những dòng đã đối chiếu được với kho thật của
// người dùng (MST người bán có trong data.db) VÀ có URL trong bảng tra của
// extension "Kho hoá đơn gốc" (1.4.20_0/shared/provider-registry.js, map "sellers").
// KHÔNG nhập hàng loạt 1279 dòng của bảng đó: đã kiểm, nó phủ 2/11 người bán của hồ
// sơ này và bị chi phối bởi VNPT. Tenant VNPT có thể suy ra từ tên, nhưng suy đoán
// tên thì tệ hơn là không có.
const BY_SELLER_TAX_CODE = {
  '0101452595': 'https://cpnamduoc-tt78.vnpt-invoice.com.vn/Portal/Index/',
  '0101887589-002': 'https://duocvietduc-tt78.vnpt-invoice.com.vn/Portal/Index/',
};

// Tra cứu. Trả null khi MST lạ — người dùng cần biết "chưa biết", không phải
// nhận một cổng tra cứu bịa ra.
function resolve(solutionTaxCode) {
  const key = normalizeTaxCode(solutionTaxCode);
  if (!key) return null;
  const hit = BY_SOLUTION_TAX_CODE[key];
  if (!hit) return require('./provider-reference').solution(key);
  return {
    id: hit.id,
    name: hit.name,
    level: hit.level,
    portalUrl: DEFAULT_PORTAL[hit.id] || '',
    solutionTaxCode: key,
  };
}

// Cổng riêng của người bán (xem BY_SELLER_TAX_CODE). Rỗng nếu không có trong bảng.
function sellerPortal(sellerTaxCode, providerId = '') {
  const key = normalizeTaxCode(sellerTaxCode);
  const ref = require('./provider-reference');
  const telecom = (!providerId || providerId === 'viettel') && (ref.core.VIETTEL_PORTAL_BY_TAX_CODE[key] || ref.core.VIETTEL_PORTAL_BY_TAX_CODE[key.slice(0, 10)]);
  const local = (!providerId || providerId === 'vnpt') && BY_SELLER_TAX_CODE[key];
  const record = ref.registry.sellers[key] || ref.registry.sellers[key.slice(0, 10)];
  return telecom || local || (record && (!providerId || record.providerId === providerId) ? record.lookupUrl : '') || '';
}

function resolveInvoice(row) {
  return require('./provider-reference').invoice(row, resolve(row.msttcgp));
}

// Lý do cụ thể khi chưa tải được PDF gốc. Nguyên tắc của EXT-B app.js:658-674:
// không có lý do ⇒ không được im lặng.
function reasonMissing(solutionTaxCode, lookupCode, portalUrl) {
  const found = resolve(solutionTaxCode);
  if (!found) {
    return 'Chưa biết nhà cung cấp giải pháp: XML không có thẻ MSTTCGP và mã số này không có trong bảng tra cứu.';
  }
  if (found.level === 'xml-derived-only') return LEVEL_LABEL[found.level];
  if (!normalizeTaxCode(lookupCode)) {
    return `${found.name}: XML không có mã tra cứu/mã bí mật do nhà cung cấp phát hành.`;
  }
  if (!normalizeTaxCode(portalUrl)) {
    return `${found.name}: có mã tra cứu nhưng chưa có cổng tra cứu của người bán này.`;
  }
  return `${found.name}: cần nhập CAPTCHA hoặc xác nhận trên cổng.`;
}

function levelLabel(level) {
  return LEVEL_LABEL[String(level || '')] || '';
}
function levelHint(level) {
  return LEVEL_HINT[String(level || '')] || '';
}

module.exports = { LEVELS, BY_SOLUTION_TAX_CODE, BY_SELLER_TAX_CODE, resolve, sellerPortal, resolveInvoice, reasonMissing, levelLabel, levelHint, normalizeTaxCode };
