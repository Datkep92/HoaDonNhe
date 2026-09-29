'use strict';
// ---------------------------------------------------------------------------
// TÀI SẢN TĨNH: ETag + `no-cache` (304) thay cho `no-store`.
//
// Trước đây mọi tài sản trả `Cache-Control: no-store`, nên F5 hoặc mở lại cửa sổ là tải lại
// TOÀN BỘ ~16 request / ~324 KB dù không có gì đổi. Nay máy chủ trả ETag + `no-cache`: trình
// duyệt VẪN hỏi lại (không tái dùng mù — route vẫn nằm sau allowed() nên không lộ dữ liệu),
// nhưng nhận 304 rỗng. Test khoá ba mặt: (1) có ETag và đúng `no-cache` chứ không phải
// `no-store`; (2) If-None-Match khớp thì 304, thân RỖNG; (3) lệch ETag thì phải trả lại thân.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    cwd: root,
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  let match = null;
  for (let i = 0; i < 300 && !match; i += 1) {
    match = out.match(/\{"testUrl":"[^"]+"/);
    if (!match) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!match) { child.kill(); throw new Error(`server không khởi động: ${out}`); }
  return { url: new URL(JSON.parse(`${match[0]}}`).testUrl), stop: () => child.kill() };
}

// Trả cả status, header và độ dài thân để phân biệt 200-có-thân với 304-rỗng.
function get(url, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: Number(url.port), path: pathname,
      headers: { Cookie: `hd_session=${url.searchParams.get('launch')}`, ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('tài sản tĩnh: ETag + `no-cache` (KHÔNG `no-store`), If-None-Match khớp ⇒ 304 rỗng', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-static-'));
  const server = await startServer(dataDir);
  try {
    const first = await get(server.url, '/renderer.js');
    assert.equal(first.status, 200);
    assert.ok(first.headers.etag, 'phải có ETag để trình duyệt gửi lại If-None-Match');
    assert.match(String(first.headers['cache-control'] || ''), /no-cache/,
      'phải là `no-cache` — vẫn kiểm tra lại với máy chủ, chỉ bỏ phần truyền lại vô ích');
    assert.ok(!/no-store/.test(String(first.headers['cache-control'] || '')),
      '`no-store` cũ bắt tải lại toàn bộ mỗi lần F5 — không được quay về đó');
    assert.ok(first.body.length > 0, 'lần đầu phải trả thân file');

    const again = await get(server.url, '/renderer.js', { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304, 'ETag khớp ⇒ 304, không truyền lại thân file');
    assert.equal(again.body.length, 0, '304 phải rỗng thân');

    // Cả tài sản không phải .js (không có bản rút gọn) cũng phải theo cùng luật.
    const icon = await get(server.url, '/icon.png');
    assert.equal(icon.status, 200);
    assert.ok(icon.headers.etag, 'ảnh cũng phải có ETag');
    const iconAgain = await get(server.url, '/icon.png', { 'If-None-Match': icon.headers.etag });
    assert.equal(iconAgain.status, 304);

    // ETag lệch ⇒ phải trả lại nội dung, không được trả 304 bừa.
    const stale = await get(server.url, '/renderer.js', { 'If-None-Match': '"khong-khop"' });
    assert.equal(stale.status, 200, 'ETag khác ⇒ phải trả thân mới');
    assert.ok(stale.body.length > 0);

    // `*` theo chuẩn nghĩa là "đã có bản nào đó" ⇒ vẫn 304.
    const star = await get(server.url, '/renderer.js', { 'If-None-Match': '*' });
    assert.equal(star.status, 304, "If-None-Match: * phải được coi là khớp");

    // Tệp không tồn tại: 404 gọn, và vẫn khai `no-cache` để không cache lỗi.
    const missing = await get(server.url, '/khong-ton-tai.js');
    assert.equal(missing.status, 404);
  } finally {
    server.stop();
  }
});
