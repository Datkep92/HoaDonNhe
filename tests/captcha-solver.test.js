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
