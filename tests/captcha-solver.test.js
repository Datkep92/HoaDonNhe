'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Solver dùng onnxruntime-node + sharp + model trong src/onnx. Thiếu gì thì bỏ qua test chạy thật.
let hasDeps = true;
try { require('onnxruntime-node'); require('sharp'); } catch { hasDeps = false; }
const modelReady = hasDeps && fs.existsSync(path.join(__dirname, '..', 'src', 'onnx', 'common.onnx'));

const solver = require('../src/captcha-solver');
const { makeTestPng } = require('../src/captcha-ocr');

test('toRawBase64 cắt prefix data-URL', () => {
  assert.strictEqual(solver.toRawBase64('data:image/png;base64,QUJD'), 'QUJD');
  assert.strictEqual(solver.toRawBase64('QUJD'), 'QUJD');
  assert.strictEqual(solver.toRawBase64(''), '');
  assert.strictEqual(solver.toRawBase64(undefined), '');
});

test('solve trả null cho đầu vào rỗng/lỗi thay vì ném', async () => {
  assert.strictEqual(await solver.solve(''), null);
  assert.strictEqual(await solver.solve('data:image/png;base64,'), null);
  assert.strictEqual(await solver.solve('khong-phai-base64!!!'), null);
});

test('solve nhận data-URL SVG trắng (không chữ → null)', { skip: !modelReady && 'thiếu model/deps' }, async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/></svg>';
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const text = await solver.solve(dataUrl);
  // Ảnh trắng không có chữ — pipeline chạy được và trả null thay vì ném lỗi
  assert.strictEqual(text, null);
});

test('solve đọc đúng chữ cái + chữ số trong ảnh SVG (pipeline CaptchaX)', { skip: !modelReady && 'thiếu model/deps' }, async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="15" y="30" font-size="26" font-family="DejaVu Sans Mono" fill="black">A7K2</text></svg>';
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const text = await solver.solve(dataUrl);
  assert.strictEqual(text, 'A7K2');
});

// ---- login-auto: chỉ test logic không gọi mạng ----
const loginAuto = require('../src/login-auto');

test('autoLogin từ chối thiếu username/mật khẩu', async () => {
  await assert.rejects(() => loginAuto.autoLogin({ username: '', password: '' }), /Thiếu tên đăng nhập/);
  await assert.rejects(() => loginAuto.autoLogin({ username: 'x' }), /Thiếu tên đăng nhập/);
});

test('MAX_ATTEMPTS nằm trong giới hạn hợp lý', () => {
  assert.ok(loginAuto.MAX_ATTEMPTS >= 3 && loginAuto.MAX_ATTEMPTS <= 10);
});

// ---- Chặn loại lỗi "gọi hàm không tồn tại" (đã xảy ra thật) ----
// Lỗi thật trên bản 1.0.5: login-auto.js gọi `captchaSolver.lastError()` trong khi module xuất
// `lastErrorMessage` ⇒ khi bộ giải CAPTCHA hỏng thì ném "captchaSolver.lastError is not a function"
// thay vì trả về lý do, và route /api/account/auto-login đổi thành HTTP 400 — người dùng chỉ thấy
// một câu vô nghĩa, còn nguyên nhân thật (ví dụ thiếu model OCR) thì bị che mất.
test('mọi lời gọi captchaSolver.<tên> đều trỏ tới hàm module THẬT SỰ xuất', () => {
  const exported = new Set(Object.keys(require('../src/captcha-solver')));
  // Bỏ CHÚ THÍCH trước khi quét: chú thích hay nhắc tên hàm bằng văn xuôi (ví dụ ghi lại chính lỗi
  // này) nên nếu quét thô sẽ báo oan. Chỉ soi mã đang chạy.
  const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wrong = [];
  for (const rel of ['src/login-auto.js', 'src/captcha-solver.js', 'src/server.js', 'src/tax-login.js']) {
    const file = path.join(__dirname, '..', rel);
    if (!fs.existsSync(file)) continue;
    for (const m of stripComments(fs.readFileSync(file, 'utf8')).matchAll(/captchaSolver\.(\w+)/g)) {
      if (!exported.has(m[1])) wrong.push(`${rel}: captchaSolver.${m[1]}`);
    }
  }
  assert.deepStrictEqual(wrong, [], `gọi hàm không tồn tại: ${wrong.join(', ')} — module xuất: ${[...exported].join(', ')}`);
});

test('autoLogin khi bộ giải CAPTCHA hỏng: TRẢ VỀ lý do, KHÔNG ném TypeError', async () => {
  // Không gọi mạng: bơm CAPTCHA giả, ép solver hỏng, và thay hàm báo lỗi của solver.
  // Thay `lastErrorMessage` là ĐÚNG thứ cần kiểm: nếu mã gọi một tên KHÔNG tồn tại
  // (lỗi thật của 1.0.5: `captchaSolver.lastError`) thì TypeError vẫn nổ và test này đỏ.
  const tct = require('../src/tct-api');
  const originalCaptcha = tct.captcha;
  const originalSolve = solver.solve;
  const originalLastError = solver.lastErrorMessage;
  tct.captcha = async () => ({ key: 'k', captcha: 'data:image/png;base64,QUJD' });
  solver.solve = async () => { throw Object.assign(new Error('Solver không đọc được CAPTCHA.'), { solver: true }); };
  solver.lastErrorMessage = () => 'Không thấy model OCR: /app/onnx/common.onnx';
  try {
    const result = await loginAuto.autoLogin({ username: 'u', password: 'p', maxAttempts: 1 });
    assert.strictEqual(result.ok, false, 'phải trả về ok:false chứ không ném ra ngoài');
    assert.strictEqual(typeof result.error, 'string');
    assert.match(result.error, /bộ giải CAPTCHA/, 'lý do của solver phải có trong thông báo cho người dùng');
    assert.match(result.solverError, /model OCR/, 'solverError phải chứa lý do thật');
  } finally {
    tct.captcha = originalCaptcha;
    solver.solve = originalSolve;
    solver.lastErrorMessage = originalLastError;
  }
});
