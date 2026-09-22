const text = new TextEncoder();
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value instanceof ArrayBuffer ? value : text.encode(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = value => b64(JSON.stringify(value));
const parse64 = value => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0))));
};
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

const buckets = new Map();
function limited(request, name, maximum) {
  const key = name + ':' + (request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Date.now();
  const value = buckets.get(key) || { count: 0, reset: now + 60000 };
  if (now >= value.reset) { value.count = 0; value.reset = now + 60000; }
  buckets.set(key, value);
  return ++value.count > maximum;
}

function device(input) {
  const installationId = String(input.installationId || input.hardwareId || '');
  const chatRoomId = String(input.chatRoomId || '');
  if (!/^[0-9a-f-]{36}$/i.test(installationId) || !/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(chatRoomId)) throw Error('Invalid device identity.');
  return { installationId, hardwareId: installationId, chatRoomId };
}

// Thông tin đăng ký (gói + Họ tên + SĐT) và dấu vân tay phần cứng phải đi kèm lúc đăng
// ký thì CRM mới lưu đủ cột và Gateway mới đổi được tên Topic Telegram (Bước 4).
function contact(input) {
  const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim();
  const phone = clean(input.phone).slice(0, 40);
  const name = clean(input.name).slice(0, 80);
  const plan = clean(input.plan).slice(0, 40);
  const hardwareHash = clean(input.hardwareHash).toUpperCase();
  const value = {};
  if (phone) value.phone = phone;
  if (name) value.name = name;
  if (plan) value.plan = plan;
  if (/^[0-9A-F]{16,64}$/.test(hardwareHash)) value.hardwareHash = hardwareHash;
  return value;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', text.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, text.encode(value)));
}

async function session(env, claims) {
  const header = json64({ alg: 'HS256', typ: 'JWT' });
  const payload = json64({ ...claims, exp: Math.floor(Date.now() / 1000) + 86400 });
  const signed = header + '.' + payload;
  return signed + '.' + await hmac(env.TOKEN_SECRET, signed);
}

async function claims(env, request) {
  const parts = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').split('.');
  const signed = parts[0] + '.' + parts[1];
  if (parts.length !== 3 || parts[2] !== await hmac(env.TOKEN_SECRET, signed)) throw Error('Invalid support session.');
  const value = parse64(parts[1]);
  if (value.exp < Math.floor(Date.now() / 1000)) throw Error('Support session expired.');
  return value;
}

async function gas(env, payload) {
  const response = await fetch(env.GAS_URL, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ ...payload, gatewaySecret: env.GAS_SHARED_SECRET }) 
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw Error('CRM did not return JSON.'); }
  if (!body.ok) throw Error(body.error || 'CRM rejected request.');
  return body.value;
}

async function sessionValue(env, d, value) {
  return { ...value, sessionToken: await session(env, { ...d, license: value.status || 'Unactivated' }) };
}

let googleToken = { value: '', expiry: 0 };
function pem(value) { return Uint8Array.from(atob(value.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, '')), c => c.charCodeAt(0)); }
async function firebaseToken(env) {
  if (googleToken.expiry > Date.now() + 60000) return googleToken.value;
  const service = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = json64({ alg: 'RS256', typ: 'JWT' });
  const payload = json64({ iss: service.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: service.token_uri, iat: now, exp: now + 3600 });
  const signed = header + '.' + payload;
  const key = await crypto.subtle.importKey('pkcs8', pem(service.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assertion = signed + '.' + b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, text.encode(signed)));
  const response = await fetch(service.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const data = await response.json();
  if (!data.access_token) throw Error('Firebase OAuth failed.');
  googleToken = { value: data.access_token, expiry: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return googleToken.value;
}

async function firebase(env, path, method = 'GET', value) {
  const accessToken = await firebaseToken(env);
  const options = { method, headers: { Authorization: 'Bearer ' + accessToken } };
  if (value !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(value); }
  const response = await fetch(env.FIREBASE_DATABASE_URL.replace(/\/$/, '') + path + '.json', options);
  if (!response.ok) throw Error('Firebase request failed.');
  return response.json();
}

// Luồng realtime cho Support Chat. Gateway chuyển tiếp REST streaming của Firebase Realtime
// Database: Firebase CHỈ đẩy sự kiện khi dữ liệu thay đổi, nên EXE không phải hỏi lại định kỳ.
// Không có khoá Firebase nào đi xuống máy khách — chỉ có token phiên do Gateway tự ký.
// (Kết nối có thể bị edge thu hồi; phía EXE tự nối lại với backoff, không polling.)
async function chatStream(env, request, url) {
  let token;
  try { token = await claims(env, request); }
  catch (error) { return reply({ ok: false, error: error.message || 'Invalid support session.' }, 401); }

  const installationId = String(url.searchParams.get('installationId') || '');
  const chatRoomId = String(url.searchParams.get('chatRoomId') || '');
  if (token.installationId !== installationId || token.chatRoomId !== chatRoomId) {
    return reply({ ok: false, error: 'Support session does not match this device.' }, 403);
  }

  const accessToken = await firebaseToken(env);
  const target = env.FIREBASE_DATABASE_URL.replace(/\/$/, '') + '/chats/' + encodeURIComponent(chatRoomId) + '/messages.json';
  const upstream = await fetch(target + '?access_token=' + encodeURIComponent(accessToken), {
    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', Authorization: 'Bearer ' + accessToken },
  });
  if (!upstream.ok || !upstream.body) return reply({ ok: false, error: 'Firebase stream unavailable (' + upstream.status + ').' }, 502);

  // Chuyển nguyên các frame SSE của Firebase (event: put / patch / keep-alive / cancel) cho client.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function telegram(env, method, value) {
  const response = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!data.ok) throw Error(data.description || 'Telegram request failed.');
  return data.result;
}

async function topic(env, room) {
  const meta = await firebase(env, '/chats/' + encodeURIComponent(room) + '/meta');
  if (meta?.telegramThreadId) return meta.telegramThreadId;
  const created = await telegram(env, 'createForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, name: ('Support · ' + room).slice(0, 128) });
  await firebase(env, '/chats/' + encodeURIComponent(room) + '/meta', 'PATCH', { telegramThreadId: created.message_thread_id, telegramTopicCreatedAt: Date.now() });
  await firebase(env, '/telegramTopics/' + created.message_thread_id, 'PUT', { chatRoomId: room, createdAt: Date.now() });
  return created.message_thread_id;
}

// Bỏ ký tự định dạng Markdown trong dữ liệu khách nhập để Telegram không trả 400.
function plain(value) { return String(value === undefined || value === null ? '' : value).replace(/[_*`\[\]]/g, ''); }

// Gateway là nơi duy nhất tạo/quản lý Topic. Mở Topic ngay khi máy đăng ký lần đầu
// (việc trước đây Code.gs làm) và đổi tên Topic thành "SĐT - Họ tên" khi khách điền
// thông tin ở bước mua key. Lỗi Telegram/Firebase ở đây không làm hỏng luồng đăng ký.
async function announce(env, d, contact, value) {
  const metaPath = '/chats/' + encodeURIComponent(d.chatRoomId) + '/meta';
  const meta = (await firebase(env, metaPath)) || {};
  const thread = meta.telegramThreadId || await topic(env, d.chatRoomId);
  if (!thread) return null;

  const label = [contact.phone, contact.name].filter(Boolean).join(' - ');
  const changed = (contact.phone || '') !== (meta.contactPhone || '') || (contact.name || '') !== (meta.contactName || '') || (contact.plan || '') !== (meta.contactPlan || '');
  if (label && changed) {
    await telegram(env, 'editForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, name: label.slice(0, 128) });
    await firebase(env, metaPath, 'PATCH', { contactPhone: contact.phone || '', contactName: contact.name || '', contactPlan: contact.plan || '' });
    const lines = ['📇 *Thông tin đăng ký:* ' + plain(label)];
    if (contact.plan) lines.push('📦 Gói: *' + plain(contact.plan) + '*');
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: lines.join('\n') });
  }

  if (value?.registered === true) {
    const lines = ['⚡ *Thiết bị mới kết nối hệ thống*', '🆔 Mã máy: `' + plain(d.installationId) + '`'];
    if (contact.phone) lines.push('📞 SĐT: `' + plain(contact.phone) + '`');
    if (contact.name) lines.push('👤 Tên: `' + plain(contact.name) + '`');
    if (contact.plan) lines.push('📦 Gói: *' + plain(contact.plan) + '*');
    if (value.trialDays) lines.push('⏳ Dùng thử ' + Number(value.trialDays) + ' ngày');
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: lines.join('\n') });
  }
  return thread;
}

async function webhook(env, request) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return reply({ ok: false, error: 'Invalid webhook secret.' }, 403);
  const update = await request.json();
  const message = update.message;
  if (!message || message.from?.is_bot || !message.message_thread_id || !String(message.text || '').trim()) return reply({ ok: true, ignored: true });
  const map = await firebase(env, '/telegramTopics/' + message.message_thread_id);
  const text = String(message.text).trim().slice(0, 2000);

  // Lệnh quản trị: Gateway nhận từ Telegram rồi chuyển sang CRM bằng action admin_command
  // (Apps Script không tự gửi tin Telegram), và lệnh không lọt vào chat của khách.
  if (text.startsWith('/')) {
    const command = text.split(/\s+/)[0];
    const room = map?.chatRoomId || '';
    let answer;
    if (!room) {
      answer = '⚠️ Topic này chưa gắn với thiết bị nào (không có mapping trong Firebase).\nKhách chưa mở app, hoặc Topic được tạo ngoài Gateway.';
    } else {
      try {
        const value = await gas(env, { action: 'admin_command', chatRoomId: room, command, text });
        answer = String(value?.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
      } catch (error) {
        answer = '⚠️ CRM báo lỗi: ' + (error.message || 'unknown');
      }
    }
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: message.message_thread_id, text: answer.slice(0, 4000) });
    return reply({ ok: true, value: { command } });
  }

  if (!map?.chatRoomId) return reply({ ok: true, ignored: true });
  const value = { sender: 'admin', text, timestamp: (message.date || Math.floor(Date.now() / 1000)) * 1000, source: 'telegram', telegramMessageId: message.message_id, telegramThreadId: message.message_thread_id, deliveryStatus: 'firebase' };
  const result = await firebase(env, '/chats/' + encodeURIComponent(map.chatRoomId) + '/messages', 'POST', value);
  return reply({ ok: true, value: { id: result.name } });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz') return reply({ ok: true });
      if (request.method === 'GET' && url.pathname === '/v1/chats/stream') return chatStream(env, request, url);
      if (request.method === 'POST' && url.pathname === '/v1/telegram/webhook') return webhook(env, request);
      if (request.method !== 'POST') return reply({ ok: false, error: 'Not found.' }, 404);

      const input = await request.json();      const path = url.pathname;
      const action = path.includes('notices') ? 'notice' : path.includes('activate') ? 'activate' : path.includes('messages') ? 'message' : path.includes('chats/status') ? 'chat' : path.includes('status') ? 'status' : path.includes('register') ? 'register' : '';
      if (!action) return reply({ ok: false, error: 'Not found.' }, 404);
      if (limited(request, action, action === 'activate' ? 8 : 60)) return reply({ ok: false, error: 'Too many requests.' }, 429);

      const d = device(input);
      if (action === 'notice') {
        try { return reply({ ok: true, value: await gas(env, { action: 'get_notice', ...d }) }); }
        catch { return reply({ ok: true, value: null }); }
      }
      if (action === 'register' || action === 'status') {
        if (action === 'register') {
          const info = contact(input);
          let value;
          try { value = await gas(env, { action: 'register_device', ...d, ...info }); }
          catch (error) {
            // KHÔNG im lặng: lỗi GAS ở đây từng bị nuốt hoàn toàn nên phía khách "không thấy dữ liệu"
            // mà không có dấu vết nào ở đâu. Log để thấy được bằng `wrangler tail`.
            console.log('register_device GAS error: ' + (error && error.message ? error.message : String(error)));
            value = { status: 'Unactivated', registered: false, expiryAt: '' };
          }
          try { await announce(env, d, info, value); }
          catch (error) { console.log('Telegram topic pending: ' + error.message); }
          return reply({ ok: true, value: await sessionValue(env, d, value) });
        }
        const value = await gas(env, { action: 'license_status', ...d });
        return reply({ ok: true, value: await sessionValue(env, d, value) });
      }
      if (action === 'activate') {
        const key = String(input.key || input.licenseKey || '').trim();
        if (key.length < 6 || key.length > 160) throw Error('Invalid license key.');
        
        // Gọi trực tiếp action verify_key cho khớp với Google Apps Script phía trên
        const value = await gas(env, { action: 'verify_key', ...d, key, licenseKey: key });
        
        return reply({ ok: true, value: { ...value, sessionToken: await session(env, { ...d, license: value.status }) } });
      }

      const token = await claims(env, request);
      if (token.installationId !== d.installationId || token.chatRoomId !== d.chatRoomId) throw Error('Support session does not match this device.');
      if (action === 'chat') {
        const raw = await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages');
        return reply({ ok: true, value: { messages: Object.entries(raw || {}).map(([id, value]) => ({ id, ...value })).sort((a, b) => a.timestamp - b.timestamp).slice(-100) } });
      }

      const message = { sender: 'user', text: String(input.text || '').trim().slice(0, 2000), timestamp: Date.now(), source: 'desktop', deliveryStatus: 'pending_telegram' };
      if (!message.text) throw Error('Invalid message.');
      const result = await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages', 'POST', message);
      try {
        const thread = await topic(env, d.chatRoomId);
        const sent = await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: message.text });
        await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages/' + result.name, 'PATCH', { deliveryStatus: 'delivered', telegramMessageId: sent.message_id, telegramThreadId: thread });
      } catch (error) { console.log('Telegram delivery pending: ' + error.message); }
      return reply({ ok: true, value: { id: result.name, ...message } });
    } catch (error) {
      return reply({ ok: false, error: error.message || 'Request failed.' }, 400);
    }
  }
};