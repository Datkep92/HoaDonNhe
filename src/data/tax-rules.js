'use strict';
// ---------------------------------------------------------------------------
// NGƯỠNG THUẾ THEO QUY ĐỊNH — MASTER TASK mục 26.
//
// Mục 26 bắt buộc: "Các quy tắc thuế phải VERSIONED theo: năm · loại hình kinh doanh ·
// quy định áp dụng" và "Không hard-code một con số duy nhất vào giao diện".
// ⇒ Ngưỡng nằm Ở ĐÂY (dữ liệu kèm NĂM + VĂN BẢN dẫn chiếu), giao diện chỉ đọc giá trị
//   từ API rồi hiển thị kèm nguồn — không có con số nào bị ghi chết trong HTML/JS của UI.
//
// Nguyên tắc an toàn (mục 35):
//   • File này chỉ chứa NGƯỠNG DOANH THU để đo "tiến độ tới ngưỡng";
//   • KHÔNG nhân tỷ lệ nào với doanh thu để ra "thuế phải nộp" — số thuế dự kiến lấy từ
//     tiền thuế ĐANG GHI TRÊN HÓA ĐƠN (xem queries.taxOverview);
//   • status: 'reference' ⇒ tham khảo, phải đối chiếu văn bản hiện hành của năm áp dụng;
//   • Năm mới có khác quy định ⇒ thêm mục mới trong YEAR_OVERRIDES; KHÔNG sửa dòng cũ
//     (giữ nguyên lịch sử để con số cũ vẫn truy được).
// ---------------------------------------------------------------------------

// Các nhóm loại hình — ngưỡng bên dưới là NGƯỠNG MIỄN NỘP doanh thu/năm của hộ kinh doanh.
const BASE_TYPES = [
  {
    businessType: 'hkd_nong',
    label: 'Hộ kinh doanh nông, lâm, thủy sản, muối',
    threshold: 500000000,
    legalRef: 'Thông tư 92/2015/TT-BTC, Điều 4 — doanh thu ≤ 500.000.000 đồng/năm',
  },
  {
    businessType: 'hkd_khac',
    label: 'Hộ kinh doanh, kinh doanh khác',
    threshold: 300000000,
    legalRef: 'Thông tư 92/2015/TT-BTC, Điều 4 — doanh thu ≤ 300.000.000 đồng/năm',
  },
  {
    // Doanh nghiệp KHÔNG có ngưỡng doanh thu hộ kinh doanh: không được vẽ vạch ngưỡng ảo.
    businessType: 'doanh_nghiep',
    label: 'Doanh nghiệp / không áp ngưỡng doanh thu',
    threshold: null,
    legalRef: 'Không áp dụng ngưỡng doanh thu hộ kinh doanh — khai theo tờ khai thuế GTGT',
  },
];

// Năm có bộ quy tắc riêng. Năm 2026 trở đi: nếu quy định đổi thì thêm mục vào đây thay vì
// sửa năm cũ (mục 26: versioned theo năm).
const YEARS = [2025, 2026];

// Ghi đè theo NĂM: năm nào khác đi thì khai ở đây, các năm không có mục này lấy BASE_TYPES.
// Ví dụ: { 2026: { hkd_khac: { threshold: 400000000, legalRef: 'Văn bản XXX/2026' } } }
const YEAR_OVERRIDES = {};

function rulesFor(year) {
  const value = Number(year);
  const overrides = YEAR_OVERRIDES[value] || {};
  return BASE_TYPES.map(type => ({ ...type, ...(overrides[type.businessType] || {}) }))
    .map(type => ({
      ...type,
      year: value,
      id: `${type.businessType}-${value}`,
      // Ngưỡng ghi rõ đơn vị + chu kỳ để UI không phải tự suy diễn.
      thresholdLabel: type.threshold === null || type.threshold === undefined
        ? 'Không áp dụng'
        : `${Number(type.threshold).toLocaleString('vi-VN')} đồng/năm`,
      status: 'reference',
    }));
}

function findRule({ year, businessType } = {}) {
  if (!year || !businessType) return null;
  return rulesFor(year).find(rule => rule.businessType === String(businessType)) || null;
}

function years() {
  return [...YEARS].sort((a, b) => b - a);
}

function businessTypes() {
  return BASE_TYPES.map(type => ({ value: type.businessType, label: type.label }));
}

module.exports = { rulesFor, findRule, years, businessTypes, BASE_TYPES, YEARS };
