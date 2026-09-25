'use strict';
// ---------------------------------------------------------------------------
// KHUNG GIỜ CHẠY NỀN — chỉ tính thời gian. Không chạm mạng, không đọc/ghi file.
//
// VÌ SAO TÍNH THEO GIỜ VN MÀ KHÔNG DÙNG GIỜ MÁY: khung "12:00–13:30" là giờ Việt Nam. Nếu lấy
// giờ máy rồi quy qua toISOString() thì đúng họ lỗi đã gặp với `tdlap` (lệch một ngày trong
// khoảng 00:00–07:00 giờ VN). Ở đây luôn cộng thẳng +7 giờ vào MỐC thời gian rồi đọc giờ UTC,
// nên kết quả KHÔNG phụ thuộc máy đang đặt múi giờ nào. VN không có giờ mùa hè ⇒ +7 chính xác.
// ---------------------------------------------------------------------------

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTES_PER_DAY = 24 * 60;

// Khung mặc định: TRONG GIỜ LÀM VIỆC. `to: null` = mở (chạy tới khi xong hết trong khung).
// `days` = số ngày gần nhất mà lượt nền tra cứu — cố ý NHỎ, vì đây là quét bù hoá đơn mới,
// không phải dựng lại dữ liệu (một số hồ sơ đặt `days: 365` cho việc khác).
//
// LƯU Ý: khung giờ CHỈ là một trong hai cổng. Cổng còn lại là "cửa sổ app đã đóng" —
// xem sync-scheduler.js. Chỉ trong giờ làm việc mà cửa sổ còn mở thì nền VẪN không chạy.
const DEFAULT_WINDOWS = [
  { id: 'gio-lam-viec', from: '08:00', to: '18:00', days: 3 },
];

// 'HH:MM' → số phút từ nửa đêm. Không hợp lệ ⇒ null (không đoán bừa).
function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

// Giờ VN của một MỐC thời gian → { day, minutes }. `minutes` = số phút từ nửa đêm giờ VN.
function vnClock(now = new Date()) {
  const shifted = new Date(now.getTime() + VN_OFFSET_MS);
  return {
    day: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

// Chuẩn hoá cấu hình khung: bỏ khung sai, giữ nguyên thứ tự người dùng đặt.
function normalizeWindows(list) {
  const source = Array.isArray(list) && list.length ? list : DEFAULT_WINDOWS;
  const out = [];
  for (const item of source) {
    const from = parseTime(item && item.from);
    const rawTo = item && item.to;
    const to = rawTo === null || rawTo === '' ? null : parseTime(rawTo);
    if (from === null) continue;
    if (rawTo !== null && rawTo !== '' && to === null) continue;
    if (to !== null && to === from) continue;
    out.push({
      id: String((item && item.id) || `${from}-${to}`),
      from: String(item.from).trim(),
      to: to === null ? null : String(rawTo).trim(),
      days: Math.max(1, Math.min(365, Number(item && item.days) || 3)),
    });
  }
  return out;
}

// Khung đang chứa thời điểm này, hoặc null. Hỗ trợ khung vắt qua nửa đêm (to < from).
function activeWindow(windows, clock) {
  for (const item of normalizeWindows(windows)) {
    const from = parseTime(item.from);
    const to = parseTime(item.to);
    if (to === null) { if (clock.minutes >= from) return item; continue; }
    if (to > from) { if (clock.minutes >= from && clock.minutes < to) return item; continue; }
    if (clock.minutes >= from || clock.minutes < to) return item;
  }
  return null;
}

// Khoá định danh một khung TRONG NGÀY: khung trưa và khung tối cùng ngày là hai lượt khác nhau.
function windowKey(window, clock) { return window ? `${clock.day}#${window.id}` : ''; }

// Số phút tới khung kế tiếp (0 nếu đang trong khung). Dùng để log/hiện trạng thái.
function minutesUntilNext(windows, clock) {
  const list = normalizeWindows(windows);
  if (activeWindow(list, clock)) return 0;
  let best = null;
  for (const item of list) {
    const from = parseTime(item.from);
    const delta = (from - clock.minutes + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    if (best === null || delta < best) best = delta;
  }
  return best === null ? null : best;
}

module.exports = {
  VN_OFFSET_MS, MINUTES_PER_DAY, DEFAULT_WINDOWS,
  parseTime, vnClock, normalizeWindows, activeWindow, windowKey, minutesUntilNext,
};
