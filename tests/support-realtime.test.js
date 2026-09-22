'use strict';
// Sau khi tách luồng: License CHỈ kiểm tra khi được gọi (không polling), Chat LẮNG NGHE thay đổi
// qua SSE (Firebase push) thay vì hỏi lại định kỳ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SupportStore, parseSseFrame, applyStreamEvent, sortedMessages } = require('../src/support');

const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const source = file => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');

// Đọc HTTP thường: trả về ngay khi hết phản hồi.
const getOnce = (port, pathname, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
    let body = ''; res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject);
});

// Đọc SSE: trả về ngay khi có frame đầu tiên (kết nối vẫn đang mở).
const getStream = (port, pathname, headers) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, res => {
    let body = ''; res.setEncoding('utf8');
    res.on('data', chunk => {
      body += chunk;
      if (body.includes('\n\n')) { req.destroy(); resolve({ status: res.statusCode, body }); }
    });
  });
  req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
});

test('gộp sự kiện Firebase: put toàn bộ, put một bản ghi, patch nông', () => {
  const state = new Map();
  applyStreamEvent(state, 'put', { path: '/', data: { a: { text: 'x', timestamp: 2 }, b: { text: 'y', timestamp: 1 } } });
  assert.deepEqual(sortedMessages(state).map(m => m.id), ['b', 'a']);

  applyStreamEvent(state, 'put', { path: '/c', data: { text: 'z', timestamp: 3 } });
  assert.equal(state.size, 3);

  applyStreamEvent(state, 'patch', { path: '/a', data: { deliveryStatus: 'delivered' } });
  assert.equal(state.get('a').text, 'x');
  assert.equal(state.get('a').deliveryStatus, 'delivered');

  applyStreamEvent(state, 'put', { path: '/b', data: null });
  assert.equal(state.has('b'), false);

  assert.equal(applyStreamEvent(state, 'keep-alive', { path: '/', data: null }), false);
  assert.deepEqual(sortedMessages(state).map(m => m.text), ['x', 'z']);
});

test('giữ đúng 100 tin nhắn cuối theo thứ tự thời gian', () => {
  const state = new Map();
  for (let i = 0; i < 130; i += 1) state.set(`m${i}`, { text: String(i), timestamp: i });
  const list = sortedMessages(state);
  assert.equal(list.length, 100);
  assert.equal(list[0].text, '30');
  assert.equal(list[99].text, '129');
});

test('parseSseFrame đọc event/data và bỏ qua comment', () => {
  assert.deepEqual(parseSseFrame('event: put\ndata: {"path":"/"}'), { name: 'put', data: '{"path":"/"}' });
  assert.deepEqual(parseSseFrame(': keep-alive'), { name: '', data: '' });
});

test('License và Chat độc lập: mỗi hàm chỉ gọi đúng endpoint của mình', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/licenses/status') return res.end(JSON.stringify({ ok: true, value: { status: 'Active', expiryAt: '2099-01-01', sessionToken: 'session' } }));
      if (req.url === '/v1/chats/status') return res.end(JSON.stringify({ ok: true, value: { messages: [{ id: '1', sender: 'admin', text: 'hi', timestamp: 1 }] } }));
      return res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const dir = tempDir('hd-independence-');
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
    const store = new SupportStore(dir);

    seen.length = 0;
    const license = await store.checkLicense();
    assert.equal(license.license.status, 'Active');
    assert.deepEqual(seen, ['/v1/licenses/status'], 'checkLicense không được kéo theo request chat');

    seen.length = 0;
    const chat = await store.messages();
    assert.equal(chat.messages.length, 1);
    assert.deepEqual(seen, ['/v1/chats/status'], 'messages không được kéo theo request License');
  } finally {
    server.close();
  }
});

test('watchMessages nhận thay đổi qua SSE mà không hỏi lại định kỳ', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization || '' });
    if (!req.url.startsWith('/v1/chats/stream')) { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: put\ndata: {"path":"/","data":{"a":{"sender":"admin","text":"hi","timestamp":1}}}\n\n');
    res.write('event: patch\ndata: {"path":"/b","data":{"sender":"user","text":"yo","timestamp":2}}\n\n');
    res.write('event: patch\ndata: {"path":"/b","data":{"deliveryStatus":"delivered"}}\n\n');
    return res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const dir = tempDir('hd-stream-');
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
    const store = new SupportStore(dir);
    store.data.license.sessionToken = 'session';
    store.save();

    const snapshots = [];
    let opened = 0;
    const result = await store.watchMessages(list => snapshots.push(list.map(message => message.id)), { onOpen: () => { opened += 1; } });

    assert.equal(result.ok, true);
    assert.equal(opened, 1);
    assert.deepEqual(snapshots, [['a'], ['a', 'b'], ['a', 'b']]);
    assert.equal(requests.length, 1, 'chỉ mở đúng một kết nối, không hỏi lặp');
    assert.match(requests[0].url, /^\/v1\/chats\/stream\?installationId=.+&chatRoomId=/);
    assert.match(requests[0].auth, /^Bearer /);
  } finally {
    server.close();
  }
});

test('server thật: /api/support/events mở được, /api/support/status đã bị bỏ', async () => {
  const { spawn } = require('node:child_process');
  const dataDir = tempDir('hd-server-sse-');
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    cwd: path.join(__dirname, '..'),
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  try {
    let match = null;
    for (let i = 0; i < 200 && !match; i += 1) {
      match = out.match(/\{"testUrl":"[^"]+"/);
      if (!match) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(match, `server không khởi động: ${out}`);
    const url = new URL(JSON.parse(`${match[0]}}`).testUrl);
    const port = Number(url.port);
    const headers = { Cookie: `hd_session=${url.searchParams.get('launch')}` };

    const stream = await getStream(port, '/api/support/events', headers);
    assert.equal(stream.status, 200);
    assert.match(stream.body, /"type":"mode"/);
    assert.match(stream.body, /"realtime":false/); // môi trường test không có Gateway nên không nối luồng

    const legacy = await getOnce(port, '/api/support/status', headers);
    assert.equal(legacy.status, 404, 'endpoint /api/support/status phải đã được bỏ');

    const device = await getOnce(port, '/api/support/device', headers);
    assert.equal(device.status, 200);
    assert.equal(JSON.parse(device.body).ok, true);
  } finally {
    child.kill();
  }
});

test('không còn polling License/Chat ở giao diện và server', () => {
  // Bỏ comment trước khi soi: chỉ quan tâm CODE, không quan tâm câu giải thích.
  const code = text => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const widget = code(source('chat-widget.js'));
  const settings = code(source('app-settings.js'));
  const server = code(source('server.js'));
  assert.equal(/setInterval\s*\(/.test(widget), false, 'chat-widget.js không được có setInterval (polling chat)');
  assert.equal(/setInterval\s*\(/.test(settings), false, 'app-settings.js không được có setInterval (polling License)');
  assert.equal(/\/api\/support\/status/.test(widget + settings), false, 'giao diện không được gọi /api/support/status');
  assert.equal(/\/api\/support\/status/.test(server), false, 'server không được còn endpoint /api/support/status');
  assert.equal(/support\.status\(\)/.test(server), false, 'server không được gọi support.status() (kéo License theo Chat)');
});
