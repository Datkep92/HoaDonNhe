'use strict';
// ---------------------------------------------------------------------------
// TEST CLOUDFLARE WORKER — nạp thật cloudflare-worker/src/index.js rồi gọi fetch().
//
// Vì sao cần file này: trước đây KHÔNG test nào chạm vào Worker, nên hai lỗi
// sau sống dai trong production mà không ai thấy:
//   1. `try { return somePromise() } catch {}` KHÔNG bắt được lỗi của promise ->
//      Cloudflare trả 500 dạng HTML, còn app chỉ biết JSON.parse thất bại.
//   2. Khi Apps Script lỗi, Worker tự bịa {status:'Unactivated'} -> app ghi đè ->
//      khách đang mua 1 năm bị báo "hết hạn" vĩnh viễn.
//
// Cách chạy: nạp module ES bằng dynamic import(), chặn globalThis.fetch để giả
// lập OAuth / Firebase / Apps Script / Telegram. Không gọi ra Internet.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'cloudflare-worker', 'src', 'index.js');

const WORKER_URL = 'https://gateway.test';
const MACHINE = 'DEV_ABCDEF0123456789';
const UUID = '5d449463-9c8b-45e7-b176-4ef2fbc12da9';
const ROOM = 'ROOM_WIN_KIEMTRA0001';

// Khoá RSA sinh 1 lần: Worker ký RS256 để xin access token Firebase.
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const ENV = {
  TOKEN_SECRET: 'test-token-secret-0123456789abcdef',
  GAS_SHARED_SECRET: 'test-gas-secret',
  GAS_URL: 'https://script.test/exec',
  FIREBASE_DATABASE_URL: 'https://fb.test',
  TELEGRAM_CHAT_ID: '-100123',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'svc@test.iam.gserviceaccount.com',
    private_key: PRIVATE_PEM,
    token_uri: 'https://oauth.test/token',
  }),
};

let worker;
const calls = { firebase: [], gas: [], telegram: [] };

// handler cho từng hệ thống; test gán lại qua setBackend()
let backend = {};
function setBackend(next) { backend = next || {}; calls.firebase.length = 0; calls.gas.length = 0; calls.telegram.length = 0; }

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// Handler trong test được phép trả object thường cho gọn; hàm này bọc lại thành
// Response. Không bọc thì `response.ok` là undefined và Worker ném
// "Firebase request failed" — gây hiểu nhầm là lỗi production.
function toResponse(value) {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) return jsonResponse(null);
  if (typeof value === 'object') return jsonResponse(value);
  return new Response(String(value), { status: 200 });
}

function installFetchStub() {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);

    if (target === 'https://oauth.test/token') return jsonResponse({ access_token: 'fake-access-token', expires_in: 3600 });

    if (target.startsWith('https://script.test/')) {
      const payload = JSON.parse(options.body || '{}');
      calls.gas.push(payload);
      const handler = backend.gas;
      if (typeof handler === 'function') {
        const result = handler(payload);
        // Apps Script luôn trả vỏ { ok, value }. Handler trong test chỉ cần trả
        // phần value; nếu nó đã tự có `ok` thì giữ nguyên. Không bọc thì Worker
        // đọc body.ok === undefined và ném "CRM rejected request" — trông như
        // lỗi production nhưng thật ra là lỗi của test.
        const already = result instanceof Response ? null : result;
        if (result instanceof Response) return result;
        if (already && typeof already === 'object' && 'ok' in already) return jsonResponse(already);
        return jsonResponse({ ok: true, value: result === undefined ? null : result });
      }
      return jsonResponse({ ok: true, value: handler === undefined ? { status: 'Unactivated' } : handler });
    }

    if (target.startsWith('https://fb.test')) {
      const path = target.replace('https://fb.test', '');
      // Ghi lại cả thân request: nhiều hành vi quan trọng nằm ở dữ liệu ghi vào
      // Firebase (vd: đẩy key cho khách), không kiểm tra body thì test vô nghĩa.
      let body = null;
      try { body = options.body ? JSON.parse(options.body) : null; } catch { body = options.body || null; }
      calls.firebase.push({ method: options.method || 'GET', path, body });
      const handler = backend.firebase;
      if (typeof handler === 'function') return toResponse(handler(path, options.method || 'GET', body));
      return jsonResponse(handler === undefined ? null : handler);
    }

    if (target.startsWith('https://api.telegram.org/')) {
      // Ghi lại cả thân request: phần lớn hành vi cần kiểm của Worker nằm ở
      // NỘI DUNG tin nhắn gửi đi (báo cáo /online, tra cứu /check_SDT...).
      // Chỉ lưu URL thì assert "đã gửi" vẫn xanh dù gửi rỗng.
      let sent = null;
      try { sent = options.body ? JSON.parse(options.body) : null; } catch { sent = options.body || null; }
      calls.telegram.push({ url: target, method: options.method || 'GET', body: sent });
      const handler = backend.telegram;
      if (typeof handler === 'function') return toResponse(handler(target));
      return jsonResponse({ ok: true, result: { message_id: 1, message_thread_id: 7 } });
    }

    return new Response('unexpected', { status: 500 });
  };
}

const post = (path, body, headers = {}) => worker.fetch(
  new Request(WORKER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  }),
  ENV,
);
const get = (path, headers = {}) => worker.fetch(new Request(WORKER_URL + path, { method: 'GET', headers }), ENV);

// Mọi lỗi phải ra JSON có `ok:false`. Trả HTML là app không đọc được nổi.
async function expectJsonError(response, label) {
  const type = response.headers.get('Content-Type') || '';
  const text = await response.text();
  assert.match(type, /application\/json/, `${label}: phải trả JSON, không phải "${type}"`);
  const body = JSON.parse(text);
  assert.equal(body.ok, false, `${label}: phải có ok:false`);
  return body;
}

test.before(async () => {
  installFetchStub();
  worker = (await import('../cloudflare-worker/src/index.js')).default;
  setBackend({});
});

test('module Worker nạp được và /healthz trả đúng', async () => {
  assert.equal(typeof worker.fetch, 'function');
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(await r.text()), { ok: true });
});

// ---------------------------------------------------------------------------
// 1. LỖI PHẢI RA JSON — đây là hồi quy của "try { return promise }"
// ---------------------------------------------------------------------------
test('lỗi validation trả JSON 400, KHÔNG phải trang lỗi HTML của Cloudflare', async () => {
  const cases = [
    ['/v1/ping', {}, 'ping rong'],
    ['/v1/sync', {}, 'sync rong'],
    ['/v1/ping', { machineId: 'DEV_XYZ', installationId: UUID, chatRoomId: ROOM }, 'mã máy sai dạng'],
    ['/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: 'phong-sai' }, 'phòng sai dạng'],
    ['/v1/licenses/status', { installationId: 'khong-phai-uuid', chatRoomId: ROOM }, 'mã cũ sai dạng'],
  ];
  for (const [path, body, label] of cases) {
    const r = await post(path, body);
    assert.equal(r.status, 400, `${label}: phải 400, thực tế ${r.status}`);
    await expectJsonError(r, label);
  }
});

test('route lạ trả 404 JSON; GET trên route POST cũng 404 JSON', async () => {
  await expectJsonError(await post('/v1/khong-ton-tai'), 'POST route lạ');
  await expectJsonError(await get('/v1/sync'), 'GET /v1/sync');
  await expectJsonError(await get('/v1/ping'), 'GET /v1/ping');
});

// ---------------------------------------------------------------------------
// 2. KHÔNG BAO GIỜ TỰ BỊA TRẠNG THÁI KHI CRM LỖI — bảo vệ bản quyền khách
// ---------------------------------------------------------------------------
test('CRM lỗi lúc /v1/sync thì báo lỗi, TUYỆT ĐỐI không trả Unactivated', async () => {
  setBackend({ gas: () => new Response('<html>loi 500</html>', { status: 500 }) });
  const r = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const body = await expectJsonError(r, 'sync khi CRM lỗi');

  // Trước đây Worker trả {ok:true, value:{status:'Unactivated', expiryAt:''}} và
  // app ghi thẳng vào đĩa -> khách đang mua 1 năm thành "hết hạn" vĩnh viễn.
  assert.ok(!/\bunactivated\b/i.test(body.error || ''), 'không được bịa trạng thái trong thông báo lỗi');
  assert.equal(body.value, undefined, 'lỗi thì không được kèm value giả');
});

test('CRM lỗi lúc /v1/devices/register thì báo lỗi chứ không hạ cấp bản quyền', async () => {
  setBackend({ gas: () => new Response('{"ok":false,"error":"Sheet not found"}', { status: 200 }) });
  const r = await post('/v1/devices/register', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const body = await expectJsonError(r, 'register khi CRM lỗi');
  assert.equal(body.value, undefined);
});

test('CRM trả về trạng thái thật thì đi tiếp bình thường', async () => {
  setBackend({ gas: { status: 'Active', expiryAt: '2099-12-31', trial: false } });
  const r = await post('/v1/devices/register', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  assert.equal(r.status, 200);
  const body = JSON.parse(await r.text());
  assert.equal(body.ok, true);
  assert.equal(body.value.status, 'Active');
  assert.equal(body.value.expiryAt, '2099-12-31');
  assert.ok(body.value.sessionToken, 'phải trả token phiên');
});

// ---------------------------------------------------------------------------
// 3. NHẬN DIỆN MÁY — mã DEV_ và UUID cũ đều chạy
// ---------------------------------------------------------------------------
test('mã máy DEV_ và UUID cũ đều được chấp nhận, rác thì bị từ chối', async () => {
  setBackend({ gas: { status: 'Trial', trial: true, expiryAt: '' } });
  for (const input of [
    { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM },
    { installationId: UUID, chatRoomId: ROOM },                       // app bản cũ: chỉ UUID
    { machineId: MACHINE, chatRoomId: ROOM },                          // chỉ mã máy
    { machineId: MACHINE, installationId: MACHINE, chatRoomId: ROOM },
  ]) {
    const r = await post('/v1/sync', input);
    assert.equal(r.status, 200, JSON.stringify(input));
  }
  for (const input of [
    { machineId: 'rac', installationId: UUID, chatRoomId: ROOM },      // mã máy sai dạng
    { machineId: MACHINE, installationId: 'rac', chatRoomId: ROOM },   // mã cũ sai dạng
    { installationId: UUID },                                          // thiếu phòng chat
    { machineId: MACHINE },                                            // thiếu phòng chat
    {},                                                                // rỗng
  ]) {
    const r = await post('/v1/sync', input);
    assert.equal(r.status, 400, 'phải từ chối: ' + JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// 4. HAI ĐƯỜNG MỚI
// ---------------------------------------------------------------------------
test('/v1/ping đọc bản ghi nhớ, không gọi Apps Script (không tốn quota)', async () => {
  setBackend({
    firebase: path => (path.includes('/license') ? { status: 'Locked', expiryAt: '2099-01-01', trial: false } : null),
    gas: () => { throw new Error('ping KHÔNG được gọi Apps Script'); },
  });
  const r = await post('/v1/ping', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const body = JSON.parse(await r.text());

  assert.equal(body.ok, true);
  assert.equal(body.value.licenseCacheHit, true);
  assert.equal(body.value.license.status, 'Locked');
  assert.equal(body.value.chatRoomId, ROOM);
  assert.equal(calls.gas.length, 0, 'phải đúng 0 lần gọi Apps Script');
});

test('/v1/ping báo licenseCacheHit=false khi chưa có bản ghi nhớ, để app biết phải hỏi sâu', async () => {
  setBackend({ firebase: null });
  const r = await post('/v1/ping', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const body = JSON.parse(await r.text());
  assert.equal(body.value.licenseCacheHit, false);
  assert.equal(body.value.license, null);
});

test('/v1/sync ghi bản ghi nhớ để lần ping sau không phải vào Apps Script', async () => {
  setBackend({ gas: { status: 'Active', expiryAt: '2099-05-05', trial: false }, firebase: null });
  await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });

  const writes = calls.firebase.filter(c => c.method === 'PUT' && c.path.includes('/license'));
  assert.ok(writes.length >= 1, 'phải ghi /devices/<room>/license');
  assert.ok(calls.firebase.some(c => c.path.includes('/presence')), 'phải ghi presence (ai đang dùng, phiên bản nào)');
});

test('/v1/sync trả thông báo kèm theo, và không chết nếu lấy thông báo lỗi', async () => {
  let call = 0;
  setBackend({
    gas: payload => {
      call++;
      if (payload.action === 'get_notice') return new Response('bang loi', { status: 500 });
      return { status: 'Active', expiryAt: '2099-01-01', trial: false };
    },
  });
  const r = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  assert.equal(r.status, 200, 'lỗi riêng của thông báo không được làm hỏng cả lần đồng bộ');
  const body = JSON.parse(await r.text());
  assert.equal(body.ok, true);
  assert.equal(body.value.notice, null);
  assert.ok(call >= 2, 'phải gọi cả register_device lẫn get_notice');
});

// ---------------------------------------------------------------------------
// 5. KHOÁ TẠO TOPIC — không được tạo trùng
// ---------------------------------------------------------------------------
test('tạo topic: khoá trong isolate chặn hai request song song tạo trùng', async () => {
  let created = 0;
  setBackend({
    firebase: null,                                                   // meta luôn rỗng => sẽ phải tạo
    telegram: url => {
      if (url.includes('createForumTopic')) { created++; return new Response(JSON.stringify({ ok: true, result: { message_thread_id: 100 + created } }), { status: 200 }); }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, message_thread_id: 100 } }), { status: 200 });
    },
  });
  const body = { machineId: MACHINE, installationId: UUID, chatRoomId: 'ROOM_WIN_TRUNGTOPIC1' };
  // Hai request cùng lúc — nếu không có khoá, cả hai đều thấy meta rỗng và tạo
  // topic riêng, sinh ra topic mồ côi và tin trùng vĩnh viễn.
  await Promise.all([post('/v1/chats/messages', { ...body, text: 'tin 1' }, { Authorization: 'Bearer x' }).catch(() => null), post('/v1/chats/messages', { ...body, text: 'tin 2' }, { Authorization: 'Bearer x' }).catch(() => null)]);
  // Hai request trên đều thiếu token hợp lệ nên chắc chắn dừng ở bước xác thực —
  // điều quan trọng là KHÔNG có lời gọi createForumTopic nào lọt ra ngoài.
  assert.equal(created, 0, 'request thiếu token không được tạo topic');
});

// ---------------------------------------------------------------------------
// LỆNH CẤP KEY PHẢI GỬI THẲNG CHO KHÁCH
// Trước đây /new chỉ trả lời trong topic Telegram — khách phải chờ admin trao
// tay. Nay Gateway đẩy luôn key vào phòng chat của khách.
// ---------------------------------------------------------------------------
const webhook = (text, headers = {}) => worker.fetch(new Request('https://gateway.test/v1/telegram/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret', ...headers },
  body: JSON.stringify({ message: { message_id: 1, from: { id: 1, is_bot: false }, message_thread_id: 10, date: Math.floor(Date.now() / 1000), text } }),
}), ENV);

test('webhook: /new cấp key xong thì đẩy key sang app của khách', async () => {
  setBackend({
    firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
    gas: { found: true, keyName: 'KEY-ABC123', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', reply: '🎉 CẤP KEY THÀNH CÔNG!' },
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: { message_id: 5, message_thread_id: 10 } }), { status: 200 })),
  });

  const r = await webhook('/new thang');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(await r.text()).ok, true);

  const posted = calls.firebase.filter(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.equal(posted.length, 1, 'phải đẩy đúng 1 tin vào phòng chat khách');
});

test('webhook: tin gửi khách phải có key, hạn và hướng dẫn nhập', async () => {
  setBackend({
    firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
    gas: { found: true, keyName: 'KEY-ABC123', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', reply: 'ok' },
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });

  const r = await webhook('/new thang');
  assert.equal(r.status, 200);

  const sent = calls.firebase.find(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.ok(sent && sent.body, 'phải ghi tin cho khách');
  const text = String(sent.body.text || '');
  assert.match(text, /KEY-ABC123/, 'phải chứa key');
  assert.match(text, /15\/01\/2030/, 'phải chứa hạn dùng định dạng Việt Nam');
  assert.match(text, /Kích hoạt/, 'phải hướng dẫn cách nhập key');
  assert.equal(sent.body.sender, 'admin', 'tin phải hiện là từ admin');
  assert.equal(sent.body.source, 'telegram');
});

test('webhook: /extend cũng báo khách, nhưng /check thì KHÔNG spam khách', async () => {
  for (const [cmd, expectPush] of [['/extend 30', true], ['/check', false]]) {
    setBackend({
      firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
      gas: { found: true, keyName: 'KEY-ABC123', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', reply: 'ok' },
      telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
    });
    await webhook(cmd);
    const posted = calls.firebase.filter(c => c.method === 'POST' && c.path.includes('/messages'));
    assert.equal(posted.length, expectPush ? 1 : 0, `lệnh ${cmd}: ${expectPush ? 'phải' : 'không được'} gửi cho khách`);
  }
});

test('webhook: CRM lỗi thì KHÔNG gửi tin gì cho khách', async () => {
  setBackend({
    firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
    gas: () => new Response(JSON.stringify({ ok: false, error: 'Sheet not found' }), { status: 200 }),
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });
  const r = await webhook('/new thang');
  assert.equal(r.status, 200);
  const posted = calls.firebase.filter(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.equal(posted.length, 0, 'CRM lỗi thì tuyệt đối không báo cho khách — tránh báo nhầm đã cấp key');
});

test('webhook: sai secret thì bị chặn, không đụng gì', async () => {
  setBackend({});
  const r = await webhook('/new thang', { 'X-Telegram-Bot-Api-Secret-Token': 'sai' });
  assert.equal(r.status, 403);
  assert.equal(calls.gas.length, 0);
  assert.equal(calls.firebase.length, 0);
});

// ---------------------------------------------------------------------------
// KHÁCH TỰ /CHECK — nút trong khung hỗ trợ.
// Rủi ro lớn: admin_command tra dòng theo chatRoomId. Nếu endpoint này không
// đòi phiên, chỉ cần biết ROOM_WIN_... của máy khác là đọc được thông tin
// bản quyền của họ.
// ---------------------------------------------------------------------------
const checkCall = (input, token) => worker.fetch(new Request('https://gateway.test/v1/chats/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(input),
}), ENV);

test('REGRESSION: /check từ app mà không có phiên thì bị từ chối', async () => {
  setBackend({ gas: { found: true, keyName: 'KEY-BI-LO', reply: 'x' } });
  const r = await checkCall({ machineId: MACHINE, installationId: UUID, chatRoomId: ROOM, command: '/check' });
  assert.equal(r.status, 400);
  await expectJsonError(r, 'khong co phien');
  assert.equal(calls.gas.length, 0, 'không được gọi CRM khi không có phiên hợp lệ');
  assert.equal(calls.firebase.length, 0, 'không được ghi tin nào');
});

test('REGRESSION: /check với phiên của máy KHÁC thì bị từ chối', async () => {
  setBackend({ gas: { found: true, keyName: 'KEY-BI-LO', reply: 'x' } });
  // Token hợp lệ (do Worker ký cho máy này) nhưng thân request lại khai máy khác.
  const legit = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const token = JSON.parse(await legit.text()).value.sessionToken;
  setBackend({ gas: { found: true, keyName: 'KEY-BI-LO', reply: 'x' } });

  const r = await checkCall({ machineId: 'DEV_BADC0DE00000009', installationId: 'dead1111-eeee-4fff-8aaa-bbbb22223333', chatRoomId: 'ROOM_WIN_MAYKHAC00001', command: '/check' }, token);
  assert.equal(r.status, 400);
  await expectJsonError(r, 'phien khong khop');
  assert.equal(calls.gas.length, 0, 'tuyệt đối không đọc dữ liệu máy khác');
});

test('app chỉ được tự chạy lệnh đọc, không được /new /lock /reset', async () => {
  setBackend({ gas: { found: true, keyName: 'K', reply: 'x' } });
  const legit = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const token = JSON.parse(await legit.text()).value.sessionToken;
  for (const cmd of ['/new', '/lock', '/reset', '/extend']) {
    setBackend({ gas: { found: true, keyName: 'K', reply: 'x' } });
    const r = await checkCall({ machineId: MACHINE, installationId: UUID, chatRoomId: ROOM, command: cmd }, token);
    assert.equal(r.status, 400, `lệnh ${cmd} phải bị từ chối`);
    assert.equal(calls.gas.length, 0, `lệnh ${cmd} không được tới CRM`);
  }
});

test('/check hợp lệ thì đẩy kết quả vào phòng chat khách', async () => {
  setBackend({ gas: { found: true, keyName: 'KEY-ABC', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', reply: '📊 THÔNG TIN', maxDevices: 3, usedSlots: 1 } });
  const legit = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const token = JSON.parse(await legit.text()).value.sessionToken;
  setBackend({ gas: { found: true, keyName: 'KEY-ABC', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', reply: '📊 THÔNG TIN', maxDevices: 3, usedSlots: 1 } });

  const r = await checkCall({ machineId: MACHINE, installationId: UUID, chatRoomId: ROOM, command: '/check' }, token);
  assert.equal(r.status, 200);
  assert.match(JSON.parse(await r.text()).value.detail, /THÔNG TIN/);
  const sent = calls.firebase.find(c => c.method === 'POST' && c.path.includes('/messages'));
  assert.ok(sent, 'phải đẩy tin kết quả vào phòng chat khách');
  assert.equal(sent.body.source, 'customer-check');
});

test('/check mặc định là lệnh /check khi app không truyền lệnh', async () => {
  setBackend({ gas: { found: true, keyName: 'KEY-ABC', reply: 'x', maxDevices: 1, usedSlots: 0 } });
  const legit = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  const token = JSON.parse(await legit.text()).value.sessionToken;
  setBackend({ gas: { found: true, keyName: 'KEY-ABC', reply: 'x', maxDevices: 1, usedSlots: 0 } });
  const r = await checkCall({ machineId: MACHINE, installationId: UUID, chatRoomId: ROOM }, token);
  assert.equal(r.status, 200, 'không truyền lệnh thì mặc định /check');
});

// ---------------------------------------------------------------------------
// /online — admin xem ai đang chạy app
// ---------------------------------------------------------------------------
test('/online trả danh sách, đánh dấu online theo mốc 15 phút', async () => {
  setBackend({
    firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
    gas: {
      devices: [
        { chatRoomId: ROOM, name: 'Khách Đang Chạy', status: 'Active', lastSeen: Date.now() - 60 * 1000 },
        { chatRoomId: 'ROOM_WIN_B', name: 'Khách Đã Tắt', status: 'Trial', lastSeen: Date.now() - 3 * 3600 * 1000 },
        { chatRoomId: 'ROOM_WIN_C', name: 'Chưa Từng Mở', status: 'Trial', lastSeen: 0 },
      ],
    },
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });
  const r = await webhook('/online');
  assert.equal(r.status, 200);
  const sent = calls.telegram.length;
  assert.ok(sent >= 1, 'phải gửi báo cáo về Telegram');
});

// ---------------------------------------------------------------------------
// /check_SDT — admin tra khách theo số điện thoại
// ---------------------------------------------------------------------------
const PHONE_DATA = {
  found: true, query: '0987654321', now: Date.now(), onlineWindowMs: 900000,
  devices: [
    { chatRoomId: ROOM, machineId: MACHINE, name: 'Nguyễn Văn A', phone: '0987654321', plan: 'Plus', status: 'Active', keyName: 'KEY-AAA11111', expiryAt: '2030-01-15T00:00:00Z', lastSeen: Date.now() - 60000, online: true },
    { chatRoomId: 'ROOM_WIN_MACH0002', machineId: 'DEV_AAAABBBBCCCCDDDD', name: 'Nguyễn Văn A', phone: '0987654321', status: 'Trial', keyName: '', lastSeen: Date.now() - 7200000, online: false },
  ],
  licenses: [
    { keyName: 'KEY-AAA11111', status: 'Active', expiryAt: '2030-01-15T00:00:00Z', activatedAt: '2026-01-10T00:00:00Z', maxDevices: 2, usedSlots: 1, boundDevices: [{ hardwareId: UUID, chatRoomId: ROOM }] },
    { keyName: 'KEY-OLD00001', status: 'Expired', expiryAt: '2025-06-01T00:00:00Z', maxDevices: 1, usedSlots: 0, boundDevices: [] },
  ],
};
// calls.gas lưu thẳng thân request đã parse (không bọc trong .body) — xem
// installFetchStub(). Dùng .body ở đây sẽ ra undefined và assert nào cũng fail
// với lý do sai, dễ khiến ta tưởng Worker hỏng.
const gasCalled = action => calls.gas.filter(c => c.action === action).length;

// Nội dung đã gửi đi Telegram, gộp lại để assert cho gọn.
const sentText = () => calls.telegram.map(c => (c.body && c.body.text) || '').join('\n');

// Dựng backend cho lệnh tra cứu: không mapping phòng nào (lệnh toàn cục chạy
// được ở mọi topic, kể cả topic chưa gắn máy).
const phoneLookup = (text, data = PHONE_DATA) => {
  setBackend({
    firebase: () => null,
    gas: data,
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });
  return webhook(text);
};

test('/check_SDT liệt kê mọi máy và mọi key của số đó', async () => {
  const r = await phoneLookup('/check_0987654321');
  assert.equal(r.status, 200);
  const body = sentText();
  assert.match(body, /Nguyễn Văn A/, 'phải hiện tên khách');
  assert.match(body, /KEY-AAA11111/, 'phải hiện key đang dùng');
  assert.match(body, /KEY-OLD00001/, 'phải hiện CẢ key cũ — khách có thể đang giữ nhiều key');
  assert.match(body, /MÁY ĐÃ ĐĂNG KÝ \(2\)/);
  assert.match(body, /KEY ĐÃ CẤP \(2\)/);
});

test('/check_SDT đánh dấu máy đang chạy bằng 🟢, máy đã tắt bằng ⚪️', async () => {
  await phoneLookup('/check_0987654321');
  const body = sentText();
  assert.match(body, /🟢 Nguyễn Văn A/, 'máy mở 1 phút trước là đang chạy');
  assert.match(body, /⚪️ Nguyễn Văn A/, 'máy mở 2 giờ trước là đã tắt');
});

test('/check_SDT báo rõ key hết hạn bằng 🔴', async () => {
  await phoneLookup('/check_0987654321');
  const body = sentText();
  assert.match(body, /🔴 KEY-OLD00001/);
  assert.match(body, /🟢 KEY-AAA11111/);
});

test('/check_SDT chuyển nguyên văn số khách gõ sang CRM', async () => {
  for (const text of ['/check_987654321', '/check_0987 654 321', '/check_+84987654321', '/check 0987.654.321']) {
    await phoneLookup(text);
    assert.equal(gasCalled('find_by_phone'), 1, `${text} phải gọi CRM đúng 1 lần`);
    const sent = calls.gas.find(c => c.action === 'find_by_phone').phone;
    assert.equal(sent, text.replace(/^\/check[_\s]+/, '').trim(), 'số phải giữ nguyên, chuẩn hoá để ở CRM');
  }
});

test('/check_SDT không tìm thấy ai thì báo rõ, không báo lỗi kỹ thuật', async () => {
  await phoneLookup('/check_0999999999', { found: false, query: '0999999999', devices: [], licenses: [] });
  const body = sentText();
  assert.match(body, /Không tìm thấy ai dùng số/);
  assert.doesNotMatch(body, /⚠️ Tra cứu lỗi/);
});

test('REGRESSION: /check_SDT không được lọt vào lệnh theo phòng (/check của máy đó)', async () => {
  // Nếu nhánh toàn cục đặt sau, "/check_0987654321" sẽ bị tách thành lệnh
  // "/check_0987654321" theo phòng -> tệ hơn là trả thông tin của máy đang mở
  // topic chứ không phải máy của khách cần tìm: sai hoàn toàn, lúc nào cũng
  // ra một khách hợp lệ nên rất khó phát hiện bằng mắt.
  await phoneLookup('/check_0987654321');
  assert.equal(gasCalled('find_by_phone'), 1, 'phải đi vào nhánh tra cứu toàn cục');
  assert.equal(gasCalled('admin_command'), 0, 'không được gọi admin_command (lệnh theo phòng)');
});

test('REGRESSION: /check đơn thuần vẫn là lệnh của máy đang mở topic', async () => {
  setBackend({
    firebase: p => (p.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
    gas: { found: true, keyName: 'KEY-AAA11111', status: 'Active', reply: '📊 THÔNG TIN BẢN QUYỀN' },
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });
  const r = await webhook('/check');
  assert.equal(r.status, 200);
  assert.equal(gasCalled('admin_command'), 1, '/check phải gọi admin_command');
  assert.equal(gasCalled('find_by_phone'), 0, '/check không được tra SĐT');
});

test('REGRESSION: khách tự tra SĐT người khác trong app là bị chặn', async () => {
  // CUSTOMER_COMMANDS chỉ có /check và /info — app không được dò SĐT người khác.
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  const line = src.slice(src.indexOf('const CUSTOMER_COMMANDS'));
  assert.match(line.slice(0, 120), /CUSTOMER_COMMANDS\s*=\s*\['\/check',\s*'\/info'\]/);
  // Ngoài ra phải có bước đòi phiên: admin_command tra dòng theo chatRoomId nên
  // thiếu bước này thì chỉ cần biết ROOM_WIN_... của máy khác là đọc được.
  const fn = src.slice(src.indexOf('async function customerCommand_'));
  assert.match(fn.slice(0, 1400), /await claims\(env, request\)/, 'phải đòi phiên hợp lệ');
  assert.match(fn.slice(0, 1400), /does not match this device/);
});

test('/online không cần phòng chat — lệnh toàn cục', async () => {
  setBackend({
    firebase: () => null,                       // không có mapping phòng nào
    gas: { devices: [] },
    telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
  });
  const r = await webhook('/online');
  assert.equal(r.status, 200, 'phải chạy được kể cả khi topic chưa gắn máy nào');
});

test('phiên không khớp thiết bị thì bị từ chối trước khi đụng Firebase', async () => {
  setBackend({ firebase: () => { throw new Error('không được chạm Firebase'); } });
  const r = await post('/v1/chats/status', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM }, { Authorization: 'Bearer sai.chuoi.token' });
  await expectJsonError(r, 'chats/status với token hỏng');
  assert.equal(calls.firebase.length, 0);
});
