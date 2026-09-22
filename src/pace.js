'use strict';
// Nhịp gọi cổng thuế: giữ khoảng cách tối thiểu giữa hai request và tự nghỉ khi cổng trả
// 429 (quá nhiều yêu cầu) hoặc 403 (bị chặn vì hành vi không hợp lệ).
// VNIT cũng làm đúng việc này ("NHIP" + "PHUT_NGHI_MIN/MAX" + chế độ an toàn) nên nó không bị
// cổng thuế chặn hàng loạt, còn bản này trước đây gọi liên tiếp không chờ.
// Chỉnh nhịp bằng biến môi trường: HOADON_NHIP_MS (mặc định 900ms), HOADON_NHIP_JITTER_MS (300ms).
const MIN_GAP = Math.max(0, Number(process.env.HOADON_NHIP_MS ?? 900) || 0);
const JITTER = Math.max(0, Number(process.env.HOADON_NHIP_JITTER_MS ?? 300) || 0);
const MAX_REST = 10 * 60 * 1000;
const BLOCKED = /phát hiện hành vi không hợp lệ/i;
let nextAt = 0;
let restUntil = 0;
let restReason = '';
let strikes = 0;

function restRemaining() { return Math.max(0, restUntil - Date.now()); }
function gapMs() { return Math.max(0, nextAt - Date.now()); }
function resetRest() { restUntil = 0; restReason = ''; strikes = 0; }
function blocked() {
  const left = restRemaining(); if (!left) return '';
  return `Cổng thuế đang tạm từ chối truy cập (${restReason}). Chờ khoảng ${Math.ceil(left / 60000)} phút rồi thử lại, bấm liên tục sẽ bị chặn lâu hơn.`;
}
function guard() { const message = blocked(); if (message) throw new Error(message); }
// Read the portal's answer: 429 rests with exponential backoff (or its own Retry-After),
// a 403 with the blocking message rests for 10 minutes, and any success clears the rest.
function note(status, text = '', retryAfter = '') {
  const bad = status === 429 || (status === 403 && BLOCKED.test(String(text)));
  if (!bad) { if (status >= 200 && status < 300) resetRest(); return 0; }
  const header = Number(String(retryAfter ?? '').trim());
  if (status === 429) strikes += 1;
  const fallback = status === 429 ? Math.min(20000 * 2 ** Math.max(0, strikes - 1), MAX_REST) : MAX_REST;
  const wait = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 30 * 60 * 1000) : fallback;
  restUntil = Date.now() + wait;
  restReason = status === 429 ? 'HTTP 429 – quá nhiều yêu cầu' : 'HTTP 403 – bị chặn vì hành vi không hợp lệ';
  return wait;
}
async function wait() {
  guard();
  const gap = gapMs();
  if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));
}
function mark() { nextAt = Date.now() + MIN_GAP + (JITTER ? Math.floor(Math.random() * JITTER) : 0); }
module.exports = { wait, mark, note, guard, blocked, restRemaining, resetRest, gapMs, MIN_GAP };
