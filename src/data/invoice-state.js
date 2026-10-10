'use strict';
// ---------------------------------------------------------------------------
// Trạng thái hoá đơn (tthai) — MỘT chỗ dùng chung cho kho dữ liệu, Excel và giao diện.
//
// Vì sao phải có: XML KHÔNG mang `tthai`. Nguồn duy nhất biết trạng thái là kết quả tra cứu,
// nên engine ghi MST-<mst>/trang-thai-hoa-don.json (đủ cả 6 trạng thái), bộ nhập đọc rồi lưu
// vào cột invoices.tthai. Nhãn và danh sách loại trừ đều lấy từ file này — không chép lại.
// ---------------------------------------------------------------------------

// Đúng nhãn MISA dùng trong file mẫu "DANH SÁCH HÓA ĐƠN".
const LABELS = {
  1: 'Hóa đơn mới',
  2: 'Hóa đơn thay thế',
  3: 'Hóa đơn điều chỉnh',
  4: 'Đã bị thay thế',
  5: 'Đã bị điều chỉnh',
  6: 'Đã bị hủy',
};

// Hoá đơn KHÔNG còn hiệu lực ⇒ KHÔNG cộng vào danh sách hàng hoá và tổng tiền:
//   4 đã bị thay thế · 5 đã bị điều chỉnh · 6 đã bị hủy
// Vẫn GIỮ trong kho (không xoá như bản trước) để người dùng xem và lọc được theo trạng thái.
// 2 (thay thế) và 3 (điều chỉnh) là bản ĐANG có hiệu lực nên vẫn được cộng.
const EXCLUDED = ['4', '5', '6'];

function label(value) {
  if (value === null || value === undefined || value === '') return '';
  return LABELS[Number(value)] || String(value);
}

function displayLabel(value) {
  const code = String(value ?? '').trim();
  return !code ? 'Chưa xác định' : LABELS[code] || `Chưa xác định (mã ${code})`;
}

// Trạng thái chưa biết (null) KHÔNG bị coi là loại trừ — thiếu dữ liệu thì để nguyên, không đoán.
function isExcluded(value) {
  if (value === null || value === undefined || value === '') return false;
  return EXCLUDED.includes(String(value));
}

module.exports = { LABELS, EXCLUDED, label, displayLabel, isExcluded };
