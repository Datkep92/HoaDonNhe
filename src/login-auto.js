'use strict';
/**
 * Auto login hoàn toàn cho cổng hoá đơn điện tử (hoadondientu.gdt.gov.vn):
 *   1. Lấy CAPTCHA từ TCT (/api/captcha, trả SVG data-URL)
 *   2. Giải CAPTCHA bằng solver JS thuần (ddddocr-node) — không cần C# API
 *   3. Gửi /api/security-taxpayer/authenticate để nhận JWT
 *   4. Sai thì tự lấy CAPTCHA mới và thử lại (mặc định 5 lần)
 *
 * Dùng chung kho cookie theo MST (scope) của tct-api nên phiên WAF không lẫn giữa các MST.
 */
const tct = require('./tct-api');
const captchaSolver = require('./captcha-solver');

const PORTAL = 'https://hoadondientu.gdt.gov.vn';
const MAX_ATTEMPTS = 5;
// Nghỉ ngắn giữa các lần thử để không trông như flood (pace.js đã chặn nhịp request rồi).
const RETRY_DELAY_MS = 600;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thử đăng nhập 1 lượt: lấy CAPTCHA → giải → authenticate.
 * @returns {Promise<{ok: boolean, token?: string, error?: string, attempt: number}>}
 */
async function attemptOnce({ username, password, mst }) {
  const challenge = await tct.captcha(mst); // { key, captcha: 'data:image/svg+xml,...' }
  const text = await captchaSolver.solve(challenge.captcha, PORTAL);
  if (!text) throw Object.assign(new Error('Solver không đọc được CAPTCHA.'), { solver: true });

  const token = await tct.authenticate({ username, password, ckey: challenge.key, captcha: text.toUpperCase() }, mst);
  return { ok: true, token };
}

/**
 * Auto login với retry.
 * @param {{username: string, password: string, mst?: string, maxAttempts?: number}} input
 * @param {string} [scope] — MST dùng làm kho cookie riêng (đa MST chạy song song)
 * @returns {Promise<{ok: boolean, token?: string, attempts: number, error?: string, solverError?: string}>}
 */
async function autoLogin(input, scope = '') {
  const username = String(input.username || '').trim();
  const password = String(input.password || '');
  const mst = String(input.mst || scope || '');
  const maxAttempts = Math.max(1, Math.min(10, Number(input.maxAttempts) || MAX_ATTEMPTS));
  if (!username || !password) throw new Error('Thiếu tên đăng nhập hoặc mật khẩu.');

  let lastError = '';
  let solverBroken = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await attemptOnce({ username, password, mst });
      return { ok: true, token: result.token, attempts: attempt };
    } catch (err) {
      lastError = err.message || String(err);
      if (err.solver) solverBroken = true;
      // Sai tài khoản/mật khẩu hoặc bị chặn thì không thử lại — thử CAPTCHA mới cũng vô ích.
      if (/mật khẩu|tài khoản|không hợp lệ|khóa|blocked|403/i.test(lastError) && !/captcha/i.test(lastError)) break;
      if (attempt < maxAttempts) await sleep(RETRY_DELAY_MS);
    }
  }
  return { ok: false, attempts: maxAttempts, error: lastError, solverError: solverBroken ? captchaSolver.lastError() : '' };
}

module.exports = { autoLogin, attemptOnce, MAX_ATTEMPTS };
