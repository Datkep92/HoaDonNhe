'use strict';
// ---------------------------------------------------------------------------
// NGÀY VIỆT NAM — một chỗ duy nhất quy đổi ngày giờ về ngày VN (UTC+7).
//
// VÌ SAO CẦN: cổng thuế trả `tdlap` là một MỐC thời gian UTC, ví dụ
//   "2026-08-30T17:00:00Z"  =  00:00 ngày 31/08/2026 giờ Việt Nam
// Cắt 10 ký tự đầu của chuỗi UTC sẽ ra 30/08 — LỆCH MỘT NGÀY. Lỗi thật đã gặp:
// tra cứu 01/08/2026–31/08/2026 nhưng file Excel ghi "Từ ngày 31/07/2026 đến ngày 30/08/2026".
//
// Trước đây mỗi nơi tự xử một kiểu nên chỗ đúng chỗ thiếu (2 bản đúng, 2 bản thiếu) —
// đó chính là lý do lọt. Nay mọi đường đọc `tdlap`/`NLap` đều đi qua đây.
//
// QUY TẮC (không đoán bừa — mục 2.7):
//   • "YYYY-MM-DD"                      → đã là ngày VN, giữ nguyên (NLap của XML).
//   • có giờ nhưng KHÔNG kèm múi giờ    → chuỗi đã là giờ VN, lấy thẳng phần ngày.
//   • kèm múi giờ (Z hoặc ±HH:MM)       → là một MỐC thời gian, cộng 7 giờ ra ngày VN.
//   • đọc không được                    → null (nơi gọi tự quyết hiển thị gì).
//
// Việt Nam KHÔNG có giờ mùa hè nên cộng cố định 7 giờ là chính xác tuyệt đối.
// ---------------------------------------------------------------------------

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
// Kèm múi giờ: kết thúc bằng Z/z, hoặc ±HH:MM / ±HHMM.
const ZONED = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEADING_DAY = /^(\d{4}-\d{2}-\d{2})/;

// Ngày VN của một MỐC thời gian: Date, số mili-giây, hoặc chuỗi ISO có múi giờ.
function dayOf(value) {
  const ms = value instanceof Date ? value.getTime()
    : (typeof value === 'number' ? value : Date.parse(String(value ?? '')));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

// Ngày VN của một giá trị ngày/giờ trong dữ liệu (thường là `tdlap` của cổng thuế).
function isoDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (PLAIN_DAY.test(raw)) return raw;
  if (!ZONED.test(raw)) {
    const match = LEADING_DAY.exec(raw);
    return match ? match[1] : null;
  }
  return dayOf(raw);
}

// 'DD/MM/YYYY' cho Excel và ô hiển thị; '' khi không đọc được.
function dmy(value) {
  const day = isoDay(value);
  if (!day) return '';
  const [year, month, date] = day.split('-');
  return `${date}/${month}/${year}`;
}

module.exports = { VN_OFFSET_MS, dayOf, isoDay, dmy };
