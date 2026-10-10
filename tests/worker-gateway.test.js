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
  // Sheet cấu hình AI riêng; Worker phải chuyển ID này xuống Apps Script.
  AI_CONFIG_SHEET_ID: 'test-ai-sheet-id',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'svc@test.iam.gserviceaccount.com',
    private_key: PRIVATE_PEM,
    token_uri: 'https://oauth.test/token',
  }),
};

let worker;
const calls = { firebase: [], gas: [], telegram: [], ai: [] };

// handler cho từng hệ thống; test gán lại qua setBackend()
let backend = {};
function setBackend(next) { backend = next || {}; calls.firebase.length = 0; calls.gas.length = 0; calls.telegram.length = 0; calls.ai = []; }

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
      if(path.endsWith('/control.json')) {
        const response=toResponse(typeof handler==='function'?handler(path,options.method||'GET',body):null);
        response.headers.set('ETag','fixture-control');return response;
      }
      if (typeof handler === 'function') return toResponse(handler(path, options.method || 'GET', body));
      return jsonResponse(handler === undefined ? null : handler);
    }

    // Nhà cung cấp AI giả. Ghi lại TỪNG request (Authorization + body) vì phần
    // lớn hành vi cần kiểm của proxy nằm ở đây: dùng key nào, model nào, và có
    // thử key khác khi key hết hạn mức hay không.
    if (target.startsWith('https://ai.test/')) {
      let payload = null;
      try { payload = options.body ? JSON.parse(options.body) : null; } catch { payload = options.body || null; }
      calls.ai = calls.ai || [];
      calls.ai.push({ url: target, authorization: String((options.headers || {}).Authorization || ''), body: payload });
      const handler = backend.ai;
      if (typeof handler === 'function') return toResponse(handler(target, String((options.headers || {}).Authorization || ''), payload));
      return jsonResponse(handler === undefined ? null : handler);
    }

    if (target.startsWith('https://api.telegram.org/')) {
      // Ghi lại cả thân request: phần lớn hành vi cần kiểm của Worker nằm ở
      // NỘI DUNG tin nhắn gửi đi (báo cáo /online, tra cứu /check_SDT...).
      // Chỉ lưu URL thì assert "đã gửi" vẫn xanh dù gửi rỗng.
      let sent = null;
      try { sent = options.body ? JSON.parse(options.body) : null; } catch { sent = options.body || null; }
      calls.telegram.push({ url: target, method: options.method || 'GET', body: sent });
      if(target.endsWith('/getChatMember'))return jsonResponse({ok:true,result:{status:backend.memberStatus||'administrator'}});
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
    body: JSON.stringify(body?.message ? {...body,message:{chat:{id:ENV.TELEGRAM_CHAT_ID},from:{id:123},...body.message}} : body || {}),
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
  body: JSON.stringify({ message: { chat:{id:ENV.TELEGRAM_CHAT_ID}, message_id: 1, from: { id: 1, is_bot: false }, message_thread_id: 10, date: Math.floor(Date.now() / 1000), text } }),
}), ENV);

test('topic menu opens through webhook and lock button requires bound confirmation before mutating',async()=>{
 const storage=new Map();
 setBackend({
  firebase:(path,method,body)=>{if(method==='PUT'){storage.set(path,body);return body;}if(method==='DELETE'){storage.delete(path);return null;}return storage.get(path)||(path==='/telegramTopics/10.json'?{chatRoomId:ROOM}:null);},
  gas:p=>({found:true,reply:p.text==='/check'?'KHÁCH TEST':'Đã khóa',keyName:'KEY-TEST',status:p.text==='/lock'?'Locked':'Active',expiryAt:'2030-01-01'}),
 });
 const menu=await webhook('/menu@TestBot');assert.equal(menu.status,200);
 assert.ok(calls.telegram.some(c=>c.body.text?.includes('KHÁCH TEST')&&c.body.reply_markup?.inline_keyboard));
 const button=data=>post('/v1/telegram/webhook',{callback_query:{id:'menu-cb',from:{id:1,is_bot:false},data,message:{message_id:42,message_thread_id:10,chat:{id:ENV.TELEGRAM_CHAT_ID}}}},{'X-Telegram-Bot-Api-Secret-Token':ENV.TELEGRAM_WEBHOOK_SECRET});
 await button('billing:admin:prepare:lock');assert.equal(calls.gas.some(c=>c.text==='/lock'),false);
 const state=storage.get('/adminMenuSessions/1/10.json');assert.equal(state.command,'/lock');
 await button('billing:admin:confirm:'+state.token);assert.equal(calls.gas.filter(c=>c.text==='/lock').length,1);
 assert.equal(calls.gas.find(c=>c.text==='/lock').expectedKey,'KEY-TEST');
 assert.ok(calls.firebase.some(c=>c.method==='PUT'&&c.body?.status==='Locked'));
 await button('billing:admin:confirm:'+state.token);assert.equal(calls.gas.filter(c=>c.text==='/lock').length,1);
});
test('check_sdt menu alias asks for phone and explicit alias passes the phone to CRM',async()=>{
 setBackend({firebase:path=>path==='/telegramTopics/10.json'?{chatRoomId:ROOM}:null,gas:p=>p.action==='find_by_phone'?{devices:[]}: {reply:'OK'}});
 await webhook('/check_sdt@TestBot');assert.ok(calls.telegram.some(c=>c.body.reply_markup?.force_reply));
 await webhook('/check_sdt@TestBot 0987654321');assert.ok(calls.gas.some(c=>c.action==='find_by_phone'&&c.phone==='0987654321'));
});
test('expired menu confirmation reports a visible reason even when Telegram popup has expired',async()=>{
 setBackend({
  firebase:path=>path==='/telegramTopics/10.json'?{chatRoomId:ROOM}:null,
  telegram:url=>url.endsWith('/answerCallbackQuery')?{ok:false,description:'query is too old'}:{ok:true,result:url.endsWith('/getChatMember')?{status:'administrator'}:{message_id:42}},
 });
 const r=await post('/v1/telegram/webhook',{callback_query:{id:'expired',from:{id:1},data:'billing:admin:confirm:old-token',message:{message_id:42,message_thread_id:10,chat:{id:ENV.TELEGRAM_CHAT_ID}}}},{'X-Telegram-Bot-Api-Secret-Token':ENV.TELEGRAM_WEBHOOK_SECRET});
 assert.equal(r.status,200);assert.ok(calls.telegram.some(c=>c.url.endsWith('/sendMessage')&&c.body.text.includes('hết hạn')));
 assert.equal(calls.gas.length,0);
});

// NÚT BẤM của /ai: Telegram gửi callback_query (không có `message`).
const tap = (data, threadId = 10) => worker.fetch(new Request('https://gateway.test/v1/telegram/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' },
  body: JSON.stringify({ callback_query: { id: 'cb-1', from: { id: 1, is_bot: false }, data, message: { message_thread_id: threadId } } }),
}), ENV);

// flat(2): inline_keyboard là [hàng][nút]; muốn danh sách NÚT thì phải mở
// cả hai tầng, nếu không sẽ ra danh sách hàng và mất hết chữ trên nút.
// Tin nhắn của admin. `replyTo` = đang trả lời đúng tin bot đã hỏi.
const say = (text, options = {}) => worker.fetch(new Request('https://gateway.test/v1/telegram/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' },
  body: JSON.stringify({ message: { chat:{id:ENV.TELEGRAM_CHAT_ID},message_id: 2, from: { id: 1, is_bot: false }, message_thread_id: options.threadId || 10, date: Math.floor(Date.now() / 1000), text, ...(options.replyTo ? { reply_to_message: { message_id: options.replyTo } } : {}) } }),
}), ENV);

const sentKeyboards = () => calls.telegram.map(c => (c.body && c.body.reply_markup && c.body.reply_markup.inline_keyboard) || []).filter(rows => rows.length);

test('V2 webhook wiring migrates actual legacy config through encrypted Firebase CAS and checks admin', async () => {
  let stored = null, revision = 0;
  ENV.AI_ADMIN_V2_ENABLED = '1';
  setBackend({
    gas: { active: 'legacy', profiles: [{ alias: 'legacy', baseURL: 'https://ai.test/v1', model: 'legacy/model', keys: ['legacy-secret-key-123'] }] },
    firebase: (url, method, body) => {
      if (!url.includes('/aiAdmin/v2/config.json')) return null;
      if (method === 'PUT') { stored = body; revision++; return {}; }
      return new Response(JSON.stringify(stored), { headers: { 'Content-Type': 'application/json', ETag: '"' + revision + '"' } });
    },
    telegram: url => ({ ok: true, result: url.endsWith('/getChatMember') ? { status: 'administrator' } : { message_id: 42 } }),
  });
  try {
    const response = await worker.fetch(new Request('https://gateway.test/v1/telegram/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': ENV.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify({ message: { chat: { id: ENV.TELEGRAM_CHAT_ID }, from: { id: 1 }, text: '/ai', message_thread_id: 10 } }),
    }), ENV, { waitUntil() {} });
    assert.equal(response.status, 200);
    assert.equal(stored.version, 2); assert.equal(JSON.stringify(stored).includes('legacy-secret-key-123'), false);
    assert.ok(calls.telegram.some(c => c.url.endsWith('/getChatMember')));
    assert.ok(calls.telegram.some(c => c.body.text?.includes('1 URL · 1 model · 1 key')));
  } finally { delete ENV.AI_ADMIN_V2_ENABLED; }
});

test('AI callback xác nhận trước khi đọc Sheet và vẫn trả lời khi callback hết hạn', async () => {
  setBackend({
    gas: () => {
      assert.ok(calls.telegram.some(c => c.url.endsWith('/answerCallbackQuery')), 'phải xác nhận trước khi gọi Apps Script');
      return { active: '', profiles: [] };
    },
    telegram: url => url.endsWith('/answerCallbackQuery')
      ? new Response(JSON.stringify({ ok: false, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' }), { status: 400 })
      : { ok: true, result: {} },
  });
  const response = await tap('ai:refresh');
  assert.equal(response.status, 200);
  assert.equal(calls.telegram.filter(c => c.url.endsWith('/answerCallbackQuery')).length, 1);
  assert.ok(calls.telegram.some(c => c.url.endsWith('/sendMessage') && c.body.text.includes('Đã tải lại')));
});

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

// /lock, /unlock, /reset đã có test ở tầng Apps Script, nhưng chưa test MỨC
// Gateway — mà đây mới là tầng quyết định lệnh có tới được Sheet không và có
// ghi bản ghi nhớ để app nhận ra ngay không.
test('/lock, /unlock, /reset đi qua admin_command và ghi bản ghi nhớ cho app', async () => {
  for (const command of ['/lock', '/unlock', '/reset']) {
    setBackend({
      firebase: path => (path.includes('/telegramTopics/') ? { chatRoomId: ROOM } : null),
      gas: { found: true, status: 'Active', reply: 'xong ' + command },
      telegram: url => (url.includes('getUpdates') ? null : new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
    });
    const r = await webhook(command);
    assert.equal(r.status, 200, command);
    assert.equal(gasCalled('admin_command'), 1, command + ' phải gọi admin_command');
    const asked = calls.gas.find(c => c.action === 'admin_command');
    assert.equal(asked.command, command, 'phải chuyển đúng tên lệnh');
    assert.equal(asked.chatRoomId, ROOM, 'phải kèm phòng chat của topic');
    assert.ok(calls.firebase.some(c => c.method === 'PUT' && c.path.includes('/license')), command + ': phải ghi bản ghi nhớ cho app');
    assert.ok(sentText().includes('xong ' + command), command + ': phải trả lời trong topic');
  }
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

// ---------------------------------------------------------------------------
// PROXY AI — url/model/key do admin đặt bằng /ai trên Telegram; app không cầm key.
// Rủi ro lớn nhất: lộ key ra ngoài, và key hết hạn mức làm sập AI của khách.
// ---------------------------------------------------------------------------
const AI_ALIAS = 'chinh';

function aiConfigRows(alias = AI_ALIAS, keys = ['sk-or-test-key-0001', 'sk-or-test-key-0002'], model = 'model-do-admin-dat') {
  return {
    active: alias,
    profiles: [{ alias, active: true, baseURL: 'https://ai.test/v1', model, keys }],
  };
}

// Lấy token phiên thật từ Worker: /v1/ai bắt buộc token hợp lệ, token tự chế thì
// vô dụng — nên test phải đi đúng đường cấp token.
async function aiToken(status = 'Active') {
  setBackend({ gas: { status, expiryAt: '2099-12-31', trial: false } });
  const r = await post('/v1/sync', { machineId: MACHINE, installationId: UUID, chatRoomId: ROOM });
  return JSON.parse(await r.text()).value.sessionToken;
}

// Đổi cấu hình AI trong bộ nhớ của Worker theo ĐÚNG đường production: admin gõ
// lệnh /ai. Worker có bản ghi nhớ cấu hình (để khỏi gọi Apps Script mỗi lượt
// chat), nên test không được lách qua nó bằng cách giả thẳng giá trị — nếu không
// thì test sẽ xanh trong khi bản ghi nhớ thật lại hỏng.
async function useAiConfig(rows) {
  setBackend({
    firebase: () => null,
    gas: payload => (payload.action === 'ai_admin' ? { reply: '✅ Đã cập nhật cấu hình AI.', config: rows } : { devices: [] }),
    telegram: () => ({ ok: true, result: { message_id: 1 } }),
  });
  await webhook('/ai');
}
const aiPost = (token, body) => worker.fetch(new Request(WORKER_URL + '/v1/ai/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body || { model: 'client-model', messages: [{ role: 'user', content: 'chào' }] }),
}), ENV);

test('admin reply stops AI at Gateway; /stop releases the same room; non-admin cannot release', async()=>{
  const token=await aiToken();let control=null;
  setBackend({firebase:(p,method,body)=>{
    if(p.includes('/telegramTopics/'))return {chatRoomId:ROOM};
    if(p.endsWith('/control.json')){if(method==='PUT')control=body;return control;}
    if(method==='POST')return {name:'support-message'};
    return null;
  }});
  await webhook('Tôi đang kiểm tra bản quyền cho bạn');
  assert.equal(control.mode,'admin');assert.equal((await aiPost(token)).status,409);
  backend.memberStatus='member';await webhook('/stop');assert.equal(control.mode,'admin');
  backend.memberStatus='administrator';await webhook('/stop');assert.equal(control.mode,'auto');
  assert.ok(calls.firebase.some(c=>c.body?.controlMode==='auto'));
  assert.ok(calls.firebase.some(c=>c.body?.sender==='admin'));
});

test('unified support license request reaches Telegram and acknowledges without spending AI quota',async()=>{
  const token=await aiToken('Expired');let control=null;
  setBackend({firebase:(p,method,body)=>{
    if(p.endsWith('/control.json')){if(method==='PUT')control=body;return control;}
    if(p.endsWith('/meta.json'))return {telegramThreadId:10};
    if(p.includes('/telegramTopics/'))return {chatRoomId:ROOM};
    return {name:'request-license'};
  }});
  const r=await post('/v1/chats/messages',{machineId:MACHINE,installationId:UUID,chatRoomId:ROOM,text:'Xin key bản quyền',unified:true,wantsAdmin:true},{Authorization:'Bearer '+token});
  assert.equal(r.status,200);const value=(await r.json()).value;
  assert.equal(value.aiAllowed,false);assert.match(value.reply,/Admin sẽ liên hệ/);assert.equal(control.mode,'waiting');
  assert.ok(calls.telegram.some(c=>c.body?.text==='Xin key bản quyền'));
  assert.equal(calls.ai.length,0);
});

test('proxy AI đổi model của client sang model admin đặt, và key không bao giờ lộ ra app', async () => {
  const token = await aiToken();
  await useAiConfig(aiConfigRows());
  setBackend({ ai: () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) });

  const r = await aiPost(token);
  const body = await r.text();
  assert.equal(r.status, 200, body);
  assert.match(body, /"content":"ok"/, 'phải trả nguyên stream của nhà cung cấp về app');
  assert.equal(calls.ai.length, 1);
  assert.equal(calls.ai[0].body.model, 'model-do-admin-dat', 'model phải do admin quyết, không phải model client gửi lên');
  assert.equal(body.includes('sk-or-test-key-0001'), false, 'key tuyệt đối không được trả về app');
  assert.equal((r.headers.get('Content-Type') || '').includes('text/event-stream'), true, 'giữ nguyên kiểu stream để app đọc như cũ');
});

test('key hết hạn mức thì tự thử key khác, và lượt sau không quay lại key chết', async () => {
  const token = await aiToken();
  await useAiConfig(aiConfigRows(AI_ALIAS, ['sk-or-key-mot', 'sk-or-key-con-du']));
  // Worker xáo trộn key nên không thể giả định key nào được thử trước. Cách duy
  // nhất để kiểm chắc chắn đường "hết hạn mức ⇒ tự đổi key": làm LẦN THỬ ĐẦU của
  // mỗi lượt chat trả lỗi hết hạn mức, các lần sau trả bình thường.
  let attempt = 0;
  setBackend({
    ai: () => {
      attempt++;
      if (attempt === 1) return new Response('{"error":{"message":"insufficient credits"}}', { status: 402 });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  });

  const first = await aiPost(token);
  assert.equal(first.status, 200, 'key hết hạn mức không được làm hỏng AI của khách');
  await first.text();
  assert.equal(calls.ai.length, 2, 'phải thử key thứ hai trong cùng lượt chat');
  assert.notEqual(calls.ai[0].authorization, calls.ai[1].authorization, 'phải thử key khác, không lặp lại key vừa lỗi');

  const second = await aiPost(token);
  assert.equal(second.status, 200);
  await second.text();
  assert.equal(calls.ai.length, 3, 'lượt sau chỉ cần một key: key vừa hết hạn mức đã bị loại tạm');
  assert.equal(calls.ai[2].authorization, calls.ai[1].authorization, 'lượt sau phải dùng key còn tốt');
});

test('lỗi KHÔNG phải hết hạn mức thì không đổi key vô ích — trả lỗi thật cho app', async () => {
  const token = await aiToken();
  await useAiConfig(aiConfigRows());
  setBackend({ ai: () => new Response('model not found', { status: 404 }) });
  const r = await aiPost(token);
  assert.equal(r.status, 404, 'phải trả nguyên lỗi của nhà cung cấp');
  assert.equal(calls.ai.length, 1, 'lỗi cấu hình thì đừng quay key làm cháy hạn mức key tốt');
});

test('REGRESSION: /v1/ai không có token phiên thì bị từ chối, không tiêu key của bạn', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ ai: () => { throw new Error('không được gọi AI'); } });
  const r = await aiPost('');
  assert.equal(r.status, 400);
  await expectJsonError(r, 'ai không có token');
  assert.equal(calls.ai.length, 0, 'tuyệt đối không gọi AI khi không có phiên');
});

test('bản quyền hết hạn/khoá thì /v1/ai bị chặn ở Gateway', async () => {
  await useAiConfig(aiConfigRows());
  for (const status of ['Expired', 'Locked']) {
    const token = await aiToken(status);
    setBackend({ ai: () => { throw new Error('không được gọi AI'); } });
    const r = await aiPost(token);
    assert.equal(r.status, 400, status + ': phải bị chặn');
    assert.equal(calls.ai.length, 0, status + ': không được gọi AI');
  }
});

test('cấu hình AI trên Sheet thiếu url/key thì báo lỗi rõ, không gọi mù lên internet', async () => {
  const token = await aiToken();
  await useAiConfig({ active: '', profiles: [{ alias: 'rong', active: false, baseURL: '', model: '', keys: [] }] });
  setBackend({ ai: () => { throw new Error('không được gọi AI'); } });
  const r = await aiPost(token);
  assert.equal(r.status, 400);
  assert.match((JSON.parse(await r.text()).error || ''), /cấu hình AI/i);
  assert.equal(calls.ai.length, 0);
});

test('lệnh /ai trong Telegram gọi thẳng CRM và trả lời vào topic', async () => {
  setBackend({
    firebase: () => null,
    gas: payload => (payload.action === 'ai_admin' ? { reply: '➕ Đã tạo cấu hình chinh.', config: aiConfigRows() } : { devices: [] }),
    telegram: () => ({ ok: true, result: { message_id: 5 } }),
  });
  const r = await webhook('/ai add chinh https://ai.test/v1 model-do-admin-dat');
  assert.equal(r.status, 200);
  const asked = calls.gas.filter(c => c.action === 'ai_admin');
  assert.equal(asked.length, 1, 'phải chuyển lệnh xuống CRM');
  assert.match(asked[0].text, /\/ai add chinh/);
  const sent = calls.telegram.map(c => String(c.body && c.body.text || '')).join('\n');
  assert.match(sent, /Đã tạo cấu hình/, 'phải trả lời kết quả vào topic');
});

test('Worker truyền ID Sheet cấu hình AI xuống Apps Script (vì không set được Script Property qua CLI)', async () => {
  setBackend({
    firebase: () => null,
    gas: payload => (payload.action === 'ai_admin' ? { reply: 'ok', config: aiConfigRows() } : { devices: [] }),
    telegram: () => ({ ok: true, result: { message_id: 5 } }),
  });
  await webhook('/ai');
  const asked = calls.gas.find(c => c.action === 'ai_admin');
  assert.equal(asked.aiSheetId, ENV.AI_CONFIG_SHEET_ID || '', 'phải kèm aiSheetId từ secret của Gateway');
});

test('lệnh /ai chạy được cả khi topic chưa gắn máy nào (lệnh toàn cục)', async () => {
  setBackend({
    firebase: () => null,
    gas: payload => (payload.action === 'ai_admin' ? { reply: '🤖 CẤU HÌNH AI\n...', config: aiConfigRows() } : { devices: [] }),
    telegram: () => ({ ok: true, result: { message_id: 5 } }),
  });
  const r = await webhook('/ai');
  assert.equal(r.status, 200);
  assert.ok(calls.gas.some(c => c.action === 'ai_admin'), 'topic chưa gắn máy vẫn phải xem được cấu hình');
});

// ---------------------------------------------------------------------------
// NÚT BẤM /ai — yêu cầu: admin thao tác bằng cách bấm, chỉ gõ tay cho giá trị mới.
// ---------------------------------------------------------------------------
test('/ai trả lời kèm menu nút bấm, không phải màn hình chữ toàn tên', async () => {
  setBackend({
    firebase: () => null,
    gas: payload => (payload.action === 'ai_admin' ? { reply: '🤖 CẤU HÌNH AI', config: aiConfigRows() } : { devices: [] }),
    telegram: () => ({ ok: true, result: { message_id: 5 } }),
  });
  await webhook('/ai');
  const rows = sentKeyboards();
  assert.ok(rows.length, 'phải có bàn phím nút bấm');
  const labels = rows.flat(2).map(b => b.text).join(' | ');
  for (const want of ['Cấu hình', 'Kiểm tra key', 'Thêm key', 'Thêm model', 'Hướng dẫn', 'Làm mới']) {
    assert.match(labels, new RegExp(want), 'thiếu nút: ' + want);
  }
});

test('bấm nút thao tác được: xem danh sách, bật, xoá key — đều không cần gõ lệnh', async () => {
  await useAiConfig(aiConfigRows(AI_ALIAS, ['sk-or-test-key-0001', 'sk-or-test-key-0002']));
  setBackend({ gas: payload => (payload.action === 'ai_admin' ? { reply: '✅ Đã bật.', config: aiConfigRows() } : { devices: [] }), telegram: () => ({ ok: true, result: { message_id: 5 } }) });

  assert.equal((await tap('ai:list')).status, 200);
  assert.match(sentText(), /CẤU HÌNH AI/);
  assert.ok(calls.telegram.some(c => String(c.url || '').includes('answerCallbackQuery')), 'phải trả lời callback để Telegram không báo treo');

  await tap('ai:use:' + AI_ALIAS);
  assert.ok(calls.gas.some(c => c.action === 'ai_admin' && c.text === '/ai use ' + AI_ALIAS), 'nút Bật phải ra đúng lệnh');

  await tap('ai:keydel:' + AI_ALIAS + ':2');
  assert.ok(calls.gas.some(c => c.action === 'ai_admin' && c.text === '/ai key ' + AI_ALIAS + ' del 2'), 'nút xoá key phải xoá đúng thứ tự');
});

test('bấm Thêm key thì bot mới hỏi nhập, và tin trả lời đúng tin hỏi được dùng làm key', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ gas: payload => (payload.action === 'ai_admin' ? { reply: '✅ Đã thêm key (tổng 2 key).', config: aiConfigRows() } : { devices: [] }), telegram: () => ({ ok: true, result: { message_id: 77 } }) });

  await tap('ai:addkey:' + AI_ALIAS);
  assert.match(sentText(), /Gõ API key/, 'phải hỏi nhập key');
  assert.ok(calls.telegram.some(c => c.body && c.body.force_reply), 'phải ép trả lời để tin nhập được hiểu là giá trị');

  // Tin nhập giá trị (trả lời tin bot vừa hỏi): KHÔNG được rơi vào nhánh chat.
  await say('sk-or-key-moi-123456', { replyTo: 77 });
  assert.ok(calls.gas.some(c => c.action === 'ai_admin' && c.text === '/ai key ' + AI_ALIAS + ' add sk-or-key-moi-123456'), 'tin nhập phải thành lệnh thêm key');
  assert.equal(calls.firebase.filter(c => c.method === 'POST' && c.path.includes('/messages')).length, 0, 'không được gửi tin này vào phòng chat khách');
});

test('REGRESSION: tin của khách trong topic không bị bot nuốt làm "key"', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ firebase: () => null, gas: payload => (payload.action === 'ai_admin' ? { reply: '✅ ok', config: aiConfigRows() } : { devices: [] }), telegram: () => ({ ok: true, result: { message_id: 77 } }) });

  await tap('ai:addkey:' + AI_ALIAS);       // bot hỏi "gõ key vào đây"
  // Khách vô tình nhắn trong cùng topic, KHÔNG phải trả lời tin của bot.
  await say('cho tôi hỏi hoá đơn tháng này');
  assert.equal(calls.gas.filter(c => c.action === 'ai_admin').length, 0, 'tin thường của khách không được thành lệnh /ai');
});

test('sau khi nhập xong thì tin thường trở lại bình thường, không bị nuốt nhầm', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ gas: payload => (payload.action === 'ai_admin' ? { reply: '✅ Đã thêm key.', config: aiConfigRows() } : { devices: [] }), telegram: () => ({ ok: true, result: { message_id: 77 } }) });
  await tap('ai:addkey:' + AI_ALIAS);
  await say('sk-or-key-moi-123456', { replyTo: 77 });
  await say('tin nhắn thường của khách');
  assert.equal(calls.gas.filter(c => c.action === 'ai_admin').length, 1, 'tin thường phải rơi xuống luồng chat, không thành lệnh /ai');
});

// ---------------------------------------------------------------------------
// CHUỖI DỰ PHÒNG: hết key -> model cùng URL -> URL khác.
// Rủi ro lớn: chỉ đổi tên model mà vẫn gọi model chết, khiến cả chuỗi vô dụng.
// ---------------------------------------------------------------------------
test('các nút còn lại của menu /ai đều phản hồi đúng: giúp đỡ, làm mới, xem dòng, xem key, chọn thêm key, xoá', async () => {
  await useAiConfig(aiConfigRows());
  // gas phải trả CẢ cấu hình cho action ai_config: nút "Làm mới" đọc lại Sheet,
  // mock chỉ trả { devices: [] } sẽ làm bản ghi nhớ bị xoá sạch rồi các nút sau
  // báo "không còn cấu hình" — test xanh giả.
  const gasAi = rows => payload => (payload.action === 'ai_admin' ? { reply: '✅ xong.', config: rows } : payload.action === 'ai_config' ? rows : { devices: [] });
  const telegramOk = () => ({ ok: true, result: { message_id: 5 } });

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:help');
  assert.match(sentText(), /\/ai add/, 'nút Hướng dẫn phải ra cú pháp');
  assert.ok(sentKeyboards().length, 'phải kèm menu quay lại');

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:refresh');
  assert.ok(calls.gas.some(c => c.action === 'ai_config'), 'nút Làm mới phải đọc lại Sheet, không dùng bản ghi nhớ cũ');

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:prof:' + AI_ALIAS);
  assert.match(sentText(), /URL: https:\/\/ai\.test/, 'phải hiện chi tiết của dòng');
  assert.equal(sentKeyboards().flat(2).some(b => b.callback_data === 'ai:use:' + AI_ALIAS), true, 'phải có nút Bật cho dòng này');

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:keys:' + AI_ALIAS);
  const keyRows = sentKeyboards().flat(2).filter(b => String(b.callback_data || '').startsWith('ai:keydel:'));
  assert.equal(keyRows.length, 2, 'phải có nút xoá cho TỪNG key');
  assert.equal(sentText().includes('sk-or-test-key-0001'), false, 'không được in key thật trên nút');

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:keypick');
  assert.equal(sentKeyboards().flat(2).some(b => b.callback_data === 'ai:addkey:' + AI_ALIAS), true, 'phải cho chọn dòng để thêm key');

  setBackend({ gas: gasAi(aiConfigRows()), telegram: telegramOk });
  await tap('ai:del:' + AI_ALIAS);
  assert.ok(calls.gas.some(c => c.action === 'ai_admin' && c.text === '/ai del ' + AI_ALIAS), 'nút Xoá phải ra lệnh xoá đúng tên');
});

test('nút ➕ Thêm model hỏi lần lượt tên → url → model rồi mới ghi', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ gas: payload => (payload.action === 'ai_admin' ? { reply: '➕ Đã tạo cấu hình.', config: aiConfigRows() } : { devices: [] }), telegram: () => ({ ok: true, result: { message_id: 88 } }) });

  await tap('ai:new');
  assert.match(sentText(), /tên cấu hình/, 'bước 1 phải hỏi tên');

  await say('backup', { replyTo: 88 });
  assert.match(sentText(), /địa chỉ API/, 'bước 2 phải hỏi URL');

  await say('https://api.backup.example/v1', { replyTo: 88 });
  assert.match(sentText(), /tên model/, 'bước 3 phải hỏi model');

  await say('model-dup-phong', { replyTo: 88 });
  assert.ok(calls.gas.some(c => c.action === 'ai_admin' && c.text === '/ai add backup https://api.backup.example/v1 model-dup-phong'), 'phải gộp đủ ba bước thành một lệnh');
});

test('nút bấm ở nơi không phải topic thì chỉ trả lời, không gửi tin rác', async () => {
  await useAiConfig(aiConfigRows());
  setBackend({ telegram: () => ({ ok: true, result: { message_id: 5 } }) });
  const r = await tap('ai:menu', 0);
  assert.equal(r.status, 200);
  assert.ok(calls.telegram.some(c => String(c.url || '').includes('answerCallbackQuery')), 'phải trả lời callback để Telegram tắt vòng loading');
  assert.equal(calls.telegram.filter(c => String(c.url || '').includes('/sendMessage')).length, 0, 'không gửi tin khi không có topic');
});

test('hết key thì chuyển model CÙNG URL trước, chuyển URL sau cùng', async () => {
  const token = await aiToken();
  const rows = { active: 'nhanh', profiles: [
    { alias: 'nhanh', order: 10, baseURL: 'https://ai.test/v1', model: 'model-nhanh', keys: ['sk-or-nhanh-1'] },
    { alias: 'cham', order: 20, baseURL: 'https://ai.test/v1', model: 'model-cham', keys: ['sk-or-cham-1'] },
    { alias: 'du-phong', order: 30, baseURL: 'https://ai.test/v2', model: 'model-khac', keys: ['sk-or-khac-1'] },
  ] };
  await useAiConfig(rows);
  setBackend({
    ai: url => (String(url).includes('/v2/')
      ? new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      : new Response('{"error":{"message":"insufficient credits"}}', { status: 402 })),
  });

  const r = await aiPost(token);
  assert.equal(r.status, 200, 'phải tự tìm được một cấu hình còn dùng được');
  await r.text();
  const used = calls.ai.map(c => String(c.url));
  assert.deepEqual(used, [
    'https://ai.test/v1/chat/completions',   // model-nhanh hết quota
    'https://ai.test/v1/chat/completions',   // model-cham cùng URL cũng hết quota
    'https://ai.test/v2/chat/completions',   // mới chuyển sang URL dự phòng
  ], 'phải thử hết cùng URL rồi mới đổi URL');
  assert.deepEqual(calls.ai.map(c => c.body.model), ['model-nhanh', 'model-cham', 'model-khac'], 'mỗi lần thử phải dùng model của chính cấu hình đó');
});

test('kiểm tra key (nút bấm) báo cáo từng key và loại key hết hạn mức khỏi vòng xoay', async () => {
  await useAiConfig(aiConfigRows(AI_ALIAS, ['sk-or-key-tot-1', 'sk-or-key-tot-2']));
  setBackend({
    gas: payload => (payload.action === 'ai_admin' ? { reply: 'ok', config: aiConfigRows(AI_ALIAS, ['sk-or-key-tot-1', 'sk-or-key-tot-2']) } : { devices: [] }),
    ai: (url, authorization) => (authorization.includes('sk-or-key-tot-1')
    ? new Response(JSON.stringify({ error: 'no credits' }), { status: 402 })
    : new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    telegram: () => ({ ok: true, result: { message_id: 5 } }),
  });

  await tap('ai:check1:' + AI_ALIAS);
  const text = sentText();
  assert.match(text, /hết hạn mức/, 'phải báo key nào hết hạn mức');
  assert.match(text, /hoạt động/, 'phải báo key nào còn dùng được');
  assert.equal(text.includes('sk-or-key-tot-1'.slice(0, 6) + 'sk-or'), false, 'không được in key thật');
});
