'use strict';
// Kiểm tra THỦ CÔNG độ trễ phản hồi khi bấm nút (không nằm trong `npm test` vì cần Chrome thật):
//   node tools/click-feedback-check.cjs
//
// Cách chạy: dựng server thật (--test-server, dữ liệu tạm), mở Chrome headless, rồi CHẶN các request
// tới Gateway ngay trong trình duyệt (CDP Fetch) — request bị treo, không bao giờ tới máy chủ, nên
// không có cuộc gọi cloud/Telegram nào. Trong lúc request còn treo, script bấm nút và đọc trạng thái
// nút NGAY TRONG CÙNG một biểu thức, nên số đo là phản hồi tức thì, không phụ thuộc timing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { browserPath } = require('../src/browser');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-click-feedback-'));
let chrome, server, client;

async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn().catch(() => null); if (value) return value; await wait(100); }
  throw new Error('Timeout: ' + label);
}
async function evaluate(connection, expression) {
  const reply = await connection.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}
async function newPage(port, url) {
  const target = await CDP.New({ port, url });
  const connection = await CDP({ port, target });
  await until(() => evaluate(connection, 'document.readyState === "complete"'), 'page ready');
  return connection;
}
// Đọc trạng thái nút NGAY sau cú bấm trong cùng biểu thức: click() chạy handler đồng bộ tới `await`
// đầu tiên, nên nếu UI phản hồi tức thì giá trị đọc được phải đã đổi.
const buttonState = selector => `(() => { const b = document.querySelector(${JSON.stringify(selector)}); return { disabled: b.disabled, label: b.textContent }; })()`;
const clickAndRead = selector => `(() => { const b = document.querySelector(${JSON.stringify(selector)}); b.click(); return { disabled: b.disabled, label: b.textContent }; })()`;

(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '../src/server.js'), '--test-server'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOADON_TEST_DATA: path.join(temp, 'data') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  server.stdout.on('data', b => { stdout += b; });
  server.stderr.on('data', b => { stderr += b; });
  const config = await until(async () => {
    const line = stdout.split(/\r?\n/).find(x => x.startsWith('{'));
    return line ? JSON.parse(line) : null;
  }, 'test server: ' + stderr);

  chrome = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => Number(fs.readFileSync(path.join(temp, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]), 'Chrome debug port');
  client = await newPage(port, config.testUrl);
  await until(() => evaluate(client, 'typeof window.busyButton === "function"'), 'renderer loaded');
  // Để các request lúc tải trang (license/notice) đi hết trước, rồi mới bật chặn.
  await wait(1200);

  // Treo request trong trình duyệt: mô phỏng máy chủ chậm mà không gọi mạng thật.
  const held = new Map(); // requestId -> url
  client.Fetch.requestPaused(event => { held.set(event.requestId, event.request.url); });
  await client.Fetch.enable({
    patterns: [
      { urlPattern: '*/api/support/message' },
      { urlPattern: '*/api/support/activate' },
      { urlPattern: '*/api/support/license' },
    ],
  });
  const releaseFor = async (suffix, body) => {
    // Event requestPaused về qua socket CDP nên có thể tới sau một nhịp; chờ có giới hạn.
    const entry = await until(async () => [...held.entries()].find(([, url]) => new URL(url).pathname.endsWith(suffix)), 'request chờ cho ' + suffix, 5000);
    held.delete(entry[0]);
    await client.Fetch.fulfillRequest({
      requestId: entry[0], responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    });
  };

  // 1. Nút "Gửi" trong khung hỗ trợ.
  await evaluate(client, "document.getElementById('support-input').value = 'tin nhắn kiểm tra'; 1");
  const send = await evaluate(client, clickAndRead('#support-send'));
  assert.equal(send.disabled, true, 'nút Gửi phải bị khoá ngay khi bấm');
  assert.equal(send.label, 'Đang gửi…', 'nút Gửi phải đổi nhãn ngay khi bấm');
  await until(async () => held.size >= 1, 'request gửi bị treo trong trình duyệt');
  console.log('PASS: bấm "Gửi" -> khoá nút + nhãn "Đang gửi…" ngay lập tức (request chưa được trả lời)');
  await releaseFor('/api/support/message', { ok: true, value: { id: 'test-message', sender: 'user', text: 'tin nhắn kiểm tra', timestamp: Date.now() } });
  await until(async () => (await evaluate(client, buttonState('#support-send'))).disabled === false, 'nút Gửi mở lại');
  const sendAfter = await evaluate(client, buttonState('#support-send'));
  assert.equal(sendAfter.label, 'Gửi');
  assert.equal(await evaluate(client, "document.getElementById('support-input').value"), '');
  console.log('PASS: trả lời xong -> nút Gửi trở lại nhãn "Gửi", ô nhập đã xoá như cũ');

  // 2. Nút "Kích hoạt" trong khung hỗ trợ.
  await evaluate(client, "document.getElementById('support-key').value = 'KEY-TEST-0001'; 1");
  const activate = await evaluate(client, clickAndRead('#support-license-form button'));
  assert.equal(activate.disabled, true, 'nút Kích hoạt phải bị khoá ngay khi bấm');
  assert.equal(activate.label, 'Đang kích hoạt…', 'nút Kích hoạt phải đổi nhãn ngay khi bấm');
  console.log('PASS: bấm "Kích hoạt" (khung hỗ trợ) -> khoá nút + nhãn "Đang kích hoạt…" ngay lập tức');
  await releaseFor('/api/support/activate', { ok: true, value: { status: 'Active', keyName: 'KEY-TEST-0001' } });
  await until(async () => (await evaluate(client, buttonState('#support-license-form button'))).disabled === false, 'nút Kích hoạt mở lại');
  assert.equal((await evaluate(client, buttonState('#support-license-form button'))).label, 'Kích hoạt');
  console.log('PASS: trả lời xong -> nút Kích hoạt mở lại, nhãn về "Kích hoạt"');

  // 3. Nút "Kích hoạt" trong hộp thoại Cài đặt.
  await evaluate(client, "document.getElementById('settings-open').click(); 1");
  await until(() => evaluate(client, "document.getElementById('settings-dialog').open"), 'settings dialog open');
  await releaseFor('/api/support/license', { ok: true, value: { license: { status: 'Active' }, device: {} } });
  await evaluate(client, "document.getElementById('settings-license-key').value = 'KEY-TEST-0002'; 1");
  const settingsActivate = await evaluate(client, clickAndRead('#settings-license-form button'));
  assert.equal(settingsActivate.disabled, true, 'nút Kích hoạt trong Cài đặt phải bị khoá ngay khi bấm');
  assert.equal(settingsActivate.label, 'Đang kích hoạt…', 'nút Kích hoạt trong Cài đặt phải đổi nhãn ngay khi bấm');
  console.log('PASS: bấm "Kích hoạt" (hộp thoại Cài đặt) -> khoá nút + nhãn "Đang kích hoạt…" ngay lập tức');
  await releaseFor('/api/support/activate', { ok: true, value: { status: 'Active', keyName: 'KEY-TEST-0002' } });
  // Sau khi kích hoạt, handler gọi tiếp refreshSettings() -> license; phải trả lời nốt thì nút mới mở lại.
  await releaseFor('/api/support/license', { ok: true, value: { license: { status: 'Active' }, device: {} } });
  await until(async () => (await evaluate(client, buttonState('#settings-license-form button'))).disabled === false, 'nút trong Cài đặt mở lại');
  assert.equal((await evaluate(client, buttonState('#settings-license-form button'))).label, 'Kích hoạt');
  console.log('PASS: trả lời xong -> nút trong Cài đặt mở lại, nhãn về "Kích hoạt"');

  console.log(JSON.stringify({ ok: true, requestConTreo: held.size }));
})().catch(error => {
  console.error('FAIL: ' + error.message);
  process.exitCode = 1;
}).finally(async () => {
  if (client) { await client.Browser.close().catch(() => {}); await client.close().catch(() => {}); }
  if (chrome) chrome.kill();
  if (server) server.kill();
  await wait(500);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { console.log('Thư mục tạm còn lại: ' + temp); }
});
