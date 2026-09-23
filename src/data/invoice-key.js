'use strict';
// ---------------------------------------------------------------------------
// Khoá hoá đơn (Invoice Key) — PROJECT_ARCHITECTURE §13.
//
// KHÔNG dùng tên file làm định danh. KHÔNG dùng riêng SHDon.
// Cấu trúc: MST người bán | KHMSHDon | KHHDon | SHDon
//
// Vì sao phải chuẩn hoá số 0 ở đầu — bằng chứng từ 5 XML thật của dự án:
//   XML:  <SHDon>00075757</SHDon>
//   API:  shdon = "75757"
// Nếu không chuẩn hoá, khoá sinh từ XML sẽ KHÁC khoá sinh từ API, nên duplicate
// protection (mục 19) không nhận ra nhau và hoá đơn sẽ bị tải trùng.
// Chi tiết: SOURCE_ANALYSIS.md §5.2.
// ---------------------------------------------------------------------------

function text(value) {
  return String(value ?? '').trim();
}

// Chuẩn hoá số 0 ở đầu CHỈ áp dụng cho SHDon — đúng phạm vi có bằng chứng:
//   XML: <SHDon>00075757</SHDon>   API: shdon = "75757"
// KHÔNG áp dụng cho MST: MST Việt Nam thường bắt đầu bằng 0 (ví dụ 0100000001) nên bỏ số 0
// sẽ làm mất định danh và có thể gây trùng khoá giữa hai MST khác nhau.
function stripLeadingZeros(value) {
  const raw = text(value);
  if (!/^\d+$/.test(raw)) return raw;
  const stripped = raw.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

// input: { mstBan, khmshDon, khhDon, shDon }
function buildInvoiceKey(input) {
  if (!input || typeof input !== 'object') throw new Error('Thiếu dữ liệu để tạo khoá hoá đơn.');
  const parts = [
    text(input.mstBan),
    text(input.khmshDon),
    text(input.khhDon),
    stripLeadingZeros(input.shDon),
  ];
  if (parts.some(x => !x)) {
    throw new Error('Không đủ trường để tạo khoá hoá đơn (cần MST người bán, KHMSHDon, KHHDon, SHDon).');
  }
  return parts.join('|');
}

function parseInvoiceKey(key) {
  const parts = text(key).split('|');
  if (parts.length !== 4) return null;
  return { mstBan: parts[0], khmshDon: parts[1], khhDon: parts[2], shDon: parts[3] };
}

module.exports = { buildInvoiceKey, parseInvoiceKey, stripLeadingZeros };
