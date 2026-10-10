import { createAiAdmin } from './ai-admin.js';
import { createSupportFlow } from './support-flow.js';
const text = new TextEncoder();
const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value instanceof ArrayBuffer ? value : text.encode(value)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json64 = value => b64(JSON.stringify(value));
const parse64 = value => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), c => c.charCodeAt(0))));
};
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

// Landing gọi từ domain khác (github.io) nên endpoint thông báo tải phải mở CORS.
// '*' là cố ý: dữ liệu vào chỉ là đường dẫn/nguồn, không phải bí mật của ai.
const cors = () => new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });

const buckets = new Map();
function limited(request, name, maximum) {
  const key = name + ':' + (request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Date.now();
  const value = buckets.get(key) || { count: 0, reset: now + 60000 };
  if (now >= value.reset) { value.count = 0; value.reset = now + 60000; }
  buckets.set(key, value);
  return ++value.count > maximum;
}

// Mã máy ổn định (bản mới) hoặc UUID cũ (app bản cũ đang chạy ngoài hiện trường).
// Nới regex thứ hai để app đã cài không bị chặn trong lúc chuyển đổi.
const ID_PATTERN = /^(?:DEV_[A-F0-9]{12,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ROOM_PATTERN = /^ROOM_WIN_[A-Z0-9]{8,40}$/;

function device(input) {
  const machineId = String(input.machineId || '').trim();
  const installationId = String(input.installationId || input.hardwareId || machineId || '');
  const chatRoomId = String(input.chatRoomId || '');
  // machineId sai dạng thì từ chối hẳn thay vì lọt qua bằng installationId — nếu lọt,
  // giá trị rác sẽ được Apps Script ghi vào cột khoá "Machine ID" và không bao giờ
  // trúng nữa.
  if (machineId && !ID_PATTERN.test(machineId)) throw Error('Invalid device identity.');
  if (!ID_PATTERN.test(installationId) || !ROOM_PATTERN.test(chatRoomId)) throw Error('Invalid device identity.');
  return { machineId, installationId, hardwareId: installationId, hardwareIdV2: String(input.hardwareIdV2 || ''), chatRoomId };
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
  const state=String(value.status||'Unactivated').toLowerCase();
  const access=value.billing && state!=='locked' && (value.billing.commercial===false || state==='expired') ? 'Active' : value.status || 'Unactivated';
  return { ...value, sessionToken: await session(env, { ...d, license: access }) };
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

const aiAdmin = createAiAdmin({
  telegram,
  panel: (env, thread, value) => firebase(env, '/aiAdmin/v2/panels/' + String(thread || 0), value ? 'PUT' : 'GET', value),
  legacy: env => gas(env, { action: 'ai_config', aiSheetId: env.AI_CONFIG_SHEET_ID || '' }),
  read: async env => {
    const response = await fetch(env.FIREBASE_DATABASE_URL.replace(/\/$/, '') + '/aiAdmin/v2/config.json', { headers: { Authorization: 'Bearer ' + await firebaseToken(env), 'X-Firebase-ETag': 'true' } });
    if (!response.ok) throw Error('Không đọc được kho cấu hình AI.');
    return { value: await response.json(), etag: response.headers.get('ETag') };
  },
  write: async (env, value, etag) => {
    if (!etag) throw Error('Firebase chưa trả ETag; không ghi đè cấu hình.');
    const response = await fetch(env.FIREBASE_DATABASE_URL.replace(/\/$/, '') + '/aiAdmin/v2/config.json', { method: 'PUT', headers: { Authorization: 'Bearer ' + await firebaseToken(env), 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(value) });
    if (response.status === 412) return false;
    if (!response.ok) throw Error('Không lưu được kho cấu hình AI.');
    return true;
  },
});

// Luồng realtime cho Support Chat. Gateway chuyển tiếp REST streaming của Firebase Realtime
// Database: Firebase CHỈ đẩy sự kiện khi dữ liệu thay đổi, nên EXE không phải hỏi lại định kỳ.
// Không có khoá Firebase nào đi xuống máy khách — chỉ có token phiên do Gateway tự ký.
// (Kết nối có thể bị edge thu hồi; phía EXE tự nối lại với backoff, không polling.)
const supportFlow = createSupportFlow({
  read: async (env,path) => {
    const r=await fetch(env.FIREBASE_DATABASE_URL.replace(/\/$/,'')+path+'.json',{headers:{Authorization:'Bearer '+await firebaseToken(env),'X-Firebase-ETag':'true'}});
    if(!r.ok)throw Error('Không đọc được phiên hỗ trợ.');
    return {value:await r.json(),etag:r.headers.get('ETag')};
  },
  write: async (env,path,value,etag) => {
    if(!etag)throw Error('Thiếu ETag phiên hỗ trợ.');
    const r=await fetch(env.FIREBASE_DATABASE_URL.replace(/\/$/,'')+path+'.json',{method:'PUT',headers:{Authorization:'Bearer '+await firebaseToken(env),'Content-Type':'application/json','If-Match':etag},body:JSON.stringify(value)});
    if(r.status===412)return false;if(!r.ok)throw Error('Không lưu được phiên hỗ trợ.');return true;
  },
  post: (env,path,value,method='POST')=>firebase(env,path,method,value),
  send: (env,room,text)=>sendToRoom(env,room,text.slice(0,4000)),
});
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

// Khoá tạo topic trong phạm vi một isolate. Worker xử lý nhiều request cùng lúc,
// và phổ biến nhất là "đăng ký lúc mở app" chạy song song với "khách gõ tin đầu
// tiên" — cả hai đều cần topic và cùng thấy meta rỗng.
const topicLocks = new Map();

async function topic(env, room) {
  if (topicLocks.has(room)) return topicLocks.get(room);
  const work = claimTopic_(env, room);
  topicLocks.set(room, work);
  try { return await work; } finally { topicLocks.delete(room); }
}

async function claimTopic_(env, room) {
  const metaPath = '/chats/' + encodeURIComponent(room) + '/meta';
  const meta = await firebase(env, metaPath);
  if (meta?.telegramThreadId) {
    // TỰ CHỮA CHỈ MỤC NGƯỢC: nếu /telegramTopics bị mất (admin xoá Firebase, hoặc xoá tay node đó)
    // mà /chats/<room>/meta còn thì ghi lại — không có nó, tin từ Telegram sẽ rơi im lặng.
    const map = await firebase(env, '/telegramTopics/' + meta.telegramThreadId);
    if (map?.chatRoomId !== room) {
      await firebase(env, '/telegramTopics/' + meta.telegramThreadId, 'PUT', { chatRoomId: room, createdAt: Date.now() });
    }
    return meta.telegramThreadId;
  }
  const created = await telegram(env, 'createForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, name: ('Support · ' + room).slice(0, 128) });
  await firebase(env, metaPath, 'PATCH', { telegramThreadId: created.message_thread_id, telegramTopicCreatedAt: Date.now() });

  // Khoá chỉ có tác dụng trong MỘT isolate; isolate khác vẫn có thể tạo topic
  // song song. Vì vậy ghi xong phải đọc lại: ai thắng thì người còn lại dọn topic
  // thừa của mình rồi dùng topic của người thắng. Không dọn thì topic mồ côi vẫn
  // còn trong /telegramTopics và mọi tin admin gõ vào đó vẫn chạy về app — tin
  // trùng vĩnh viễn, không tự hết.
  const after = await firebase(env, metaPath);
  if (after?.telegramThreadId && after.telegramThreadId !== created.message_thread_id) {
    console.log('Topic ' + created.message_thread_id + ' bị trùng cho ' + room + ' — bỏ, dùng topic ' + after.telegramThreadId);
    try { await telegram(env, 'deleteForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: created.message_thread_id }); }
    catch (error) { console.log('Không xoá được topic thừa: ' + (error && error.message ? error.message : String(error))); }
    await firebase(env, '/telegramTopics/' + after.telegramThreadId, 'PUT', { chatRoomId: room, createdAt: Date.now() });
    return after.telegramThreadId;
  }

  await firebase(env, '/telegramTopics/' + created.message_thread_id, 'PUT', { chatRoomId: room, createdAt: Date.now() });
  await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:created.message_thread_id,disable_notification:true,text:'QUẢN LÝ KHÁCH\nPhòng: '+room+'\nChọn thao tác bên dưới. Gõ /menu để mở lại bất kỳ lúc nào.',reply_markup:billingMenu_()}).catch(()=>{});
  return created.message_thread_id;
}

// Gửi tin vào topic của phòng. Topic đã bị XOÁ trên Telegram thì tự tạo lại rồi gửi lại MỘT lần —
// không có bước này, tin cứ gửi vào số topic chết và lỗi bị nuốt thành "pending_telegram" mãi mãi.
async function sendToRoom(env, room, text) {
  const metaPath = '/chats/' + encodeURIComponent(room) + '/meta';
  let thread = await topic(env, room);
  try {
    return await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text });
  } catch (error) {
    console.log('Telegram thread ' + thread + ' không gửi được, tạo lại topic: ' + (error && error.message ? error.message : String(error)));
    await firebase(env, metaPath, 'PATCH', { telegramThreadId: null });
    thread = await topic(env, room);
    return telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text });
  }
}

// Bỏ ký tự định dạng Markdown trong dữ liệu khách nhập để Telegram không trả 400.
function plain(value) { return String(value === undefined || value === null ? '' : value).replace(/[_*`\[\]]/g, ''); }

// Tin tải app dùng parse_mode HTML nên in đậm thật sự. HTML coi & < > là ký tự
// đặc biệt — dữ liệu lấy từ header của Cloudflare vẫn phải escape trước.
function html(value) { return String(value === undefined || value === null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Thiết bị + trình duyệt, đọc từ User-Agent. Chỉ giữ lại loại thiết bị và tên
// trình duyệt — không lưu chuỗi UA đầy đủ, không dựng fingerprint.
function deviceLabel(ua) {
  const s = String(ua || '');
  if (!s) return 'không rõ';
  const os = /Windows/i.test(s) ? 'Windows'
    : /Android/i.test(s) ? 'Android'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Mac OS X/i.test(s) ? 'macOS'
    : /CrOS/i.test(s) ? 'ChromeOS'
    : /Linux/i.test(s) ? 'Linux' : 'khác';
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /OPR\//i.test(s) ? 'Opera'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari' : 'trình duyệt khác';
  const kind = /Mobi|Android|iPhone|iPod/i.test(s) ? 'di động' : 'máy tính';
  return os + ' · ' + kind + ' · ' + browser;
}

// Giờ Việt Nam, định dạng ngày giờ người đọc được.
function clockVN() {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh', hour12: false,
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date()) + ' (GMT+7)';
}

// Topic riêng cho tin tải app. Ghi nhớ id trong Firebase để lần sau tái dùng.
// Nếu topic bị admin xoá, landingTopic() tự tạo lại — cùng cách topic() xử lý
// topic hỗ trợ.
const LANDING_TOPIC_PATH = '/landingDownload/telegramThreadId';
async function landingTopic(env) {
  const saved = await firebase(env, LANDING_TOPIC_PATH);
  if (saved) return Number(saved);
  const created = await telegram(env, 'createForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, name: '⬇️ Tải app từ landing' });
  await firebase(env, LANDING_TOPIC_PATH, 'PUT', created.message_thread_id);
  return created.message_thread_id;
}

// Landing báo mỗi lượt bấm nút tải. Cố ý KHÔNG cần phiên, KHÔNG đụng GAS — chỉ
// đẩy một tin Telegram.
//
// Quốc gia và thiết bị do Worker tự đọc từ header của Cloudflare chứ không phải
// từ dữ liệu trình duyệt gửi lên: trang chỉ gửi đường dẫn, không gửi IP, không
// gửi user-agent, không lưu cookie.
async function landingDownload(env, request) {
  const input = await request.json().catch(() => ({}));
  const page = html(input.page).slice(0, 160) || '/';
  const country = html(request.headers.get('CF-IPCountry') || '??').toUpperCase();

  const lines = [
    '⬇️ <b>CÓ NGƯỜI TẢI APP</b>',
    '🕐 ' + clockVN(),
    '📄 Trang: ' + page,
    '🌍 Quốc gia: ' + country,
    '💻 Thiết bị: ' + html(deviceLabel(request.headers.get('User-Agent'))),
  ];
  const message = { chat_id: env.TELEGRAM_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML' };

  // Topic hỏng (bị xoá, hoặc nhóm không bật diễn đàn) thì gửi thẳng vào chat chính
  // — mất topic thì không được mất tin. Đồng thời xoá id đã lưu, nếu không thì mọi
  // lượt sau cũng gửi vào topic chết.
  try {
    message.message_thread_id = await landingTopic(env);
    await telegram(env, 'sendMessage', message);
  } catch (error) {
    console.log('landing topic lỗi, gửi vào chat chính: ' + error.message);
    try { await firebase(env, LANDING_TOPIC_PATH, 'PUT', null); } catch { /* bỏ qua */ }
    delete message.message_thread_id;
    await telegram(env, 'sendMessage', message);
  }
  return new Response(JSON.stringify({ ok: true, value: { notified: true } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}

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
    // Ghi thông tin liên hệ trước, rồi để refreshTopicStatus_ dựng tên có chấm trạng
    // thái. Đặt tên tay ở đây sẽ XOÁ mất 🟢/⚪️ mỗi lần người dùng đổi tên hoặc SĐT.
    await firebase(env, metaPath, 'PATCH', { contactPhone: contact.phone || '', contactName: contact.name || '', contactPlan: contact.plan || '' });
    const lines = ['📇 *Thông tin đăng ký:* ' + plain(label)];
    if (contact.plan) lines.push('📦 Gói: *' + plain(contact.plan) + '*');
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: lines.join('\n') });
  }

  if (value?.registered === true) {
    const lines = ['⚡ *Thiết bị mới kết nối hệ thống*', '🆔 Mã máy: `' + plain(d.hardwareIdV2 || d.machineId || d.installationId) + '`'];
    if (contact.phone) lines.push('📞 SĐT: `' + plain(contact.phone) + '`');
    if (contact.name) lines.push('👤 Tên: `' + plain(contact.name) + '`');
    if (contact.plan) lines.push('📦 Gói: *' + plain(contact.plan) + '*');
    if (value.trialDays) lines.push('⏳ Dùng thử ' + Number(value.trialDays) + ' ngày');
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: lines.join('\n') });
  }
  return thread;
}

async function webhook(env, request, ctx) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return reply({ ok: false, error: 'Invalid webhook secret.' }, 403);
  const update = await request.json();
  const cancel=update.message;
  if(cancel?.message_thread_id&&/^\/cancel(?:@\w+)?$/i.test(String(cancel.text||'').trim())&&String(cancel.chat?.id)===String(env.TELEGRAM_CHAT_ID)){
    const pending=await firebase(env,adminMenuPath_(cancel.from?.id,cancel.message_thread_id));
    if(pending){
      const member=await telegram(env,'getChatMember',{chat_id:env.TELEGRAM_CHAT_ID,user_id:cancel.from?.id});
      if(['creator','administrator'].includes(member?.status)){await adminMenuMessage_(env,cancel,await firebase(env,'/telegramTopics/'+cancel.message_thread_id));return reply({ok:true});}
    }
  }
  if (env.AI_ADMIN_V2_ENABLED === '1' && await aiAdmin.handle(env, update, ctx, new URL(request.url).origin)) return reply({ ok: true });
  // NÚT BẤM của /ai: Telegram gửi callback_query, không có `message`. Xử lý
  // trước mọi thứ khác vì các nhánh dưới đều đòi có message.
  if (update.callback_query) {
    if (update.callback_query.from?.is_bot) return reply({ ok: true, ignored: true });
    if(String(update.callback_query.data||'').startsWith('billing:')) {
      try { await billingCallback_(env,update.callback_query); }
      catch(error) {
        const q=update.callback_query,reason=String(error.message||'Không xử lý được thao tác.');
        await telegram(env,'answerCallbackQuery',{callback_query_id:q.id,text:reason.slice(0,180),show_alert:true}).catch(()=>{});
        if(String(q.message?.chat?.id)===String(env.TELEGRAM_CHAT_ID)&&q.message?.message_thread_id){
          const member=await telegram(env,'getChatMember',{chat_id:env.TELEGRAM_CHAT_ID,user_id:q.from?.id});
          if(['creator','administrator'].includes(member?.status))await adminMenuSend_(env,q.message.message_thread_id,'⚠️ '+reason+'\nMở lại /menu hoặc chọn thao tác khác.');
        }
      }
    }
    else await aiCallback_(env, update.callback_query);
    return reply({ ok: true, value: { callback: String(update.callback_query.data || '') } });
  }
  const message = update.message;
  if (!message || message.from?.is_bot || !message.message_thread_id || !String(message.text || '').trim()) return reply({ ok: true, ignored: true });
  const map = await firebase(env, '/telegramTopics/' + message.message_thread_id);
  const text = String(message.text).trim().slice(0, 2000);
  const threadId = message.message_thread_id;
  if(String(message.chat?.id)!==String(env.TELEGRAM_CHAT_ID))return reply({ok:true,ignored:true});
  const member=await telegram(env,'getChatMember',{chat_id:env.TELEGRAM_CHAT_ID,user_id:message.from?.id});
  if(!['creator','administrator'].includes(member?.status))return reply({ok:true,ignored:true});
  if(await adminMenuMessage_(env,message,map))return reply({ok:true});
  if(/^\/billing(?:@\w+)?(?:\s|$)/i.test(text)) {
    await adminMenuMessage_(env,{...message,text:'/menu'},map);
    return reply({ok:true});
  }
  if(/^\/stop(?:@\w+)?(?:\s|$)/i.test(text)) {
    if(!map?.chatRoomId) {
      // Trước đây im lặng bỏ qua nên admin tưởng đã đóng hỗ trợ mà thực ra chưa: khách
      // nhắn tiếp vẫn bị đẩy sang admin. Phải nói rõ để admin biết gõ đúng topic.
      await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:threadId,text:'⚠️ Topic này chưa gắn với thiết bị nào nên KHÔNG đóng được phiên.\nHãy gõ /stop trong đúng topic của khách, hoặc gõ /link ROOM_WIN_… để gắn lại topic này.'});
      return reply({ok:true,value:{command:'/stop',unlinked:true}});
    }
    await supportFlow.owner(env,map.chatRoomId,'auto',String(message.from.id));
    await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:threadId,text:'✅ Đã đóng hỗ trợ. AI hoạt động lại.'});
    return reply({ok:true,value:{command:'/stop'}});
  }

  // Bot đang chờ admin nhập giá trị sau khi bấm nút (thêm key / tạo cấu hình):
  // tin này là GIÁ TRỊ, không phải lệnh — nuốt trước khi rơi xuống các nhánh
  // lệnh để tránh gõ nhầm "/ai ..." ra thành lệnh thật.
  if (text[0] !== '/' && await aiPrompt_(env, message, threadId)) return reply({ ok: true, value: { prompt: true } });

  // CẦU NỐI GẮN LẠI: dùng khi Firebase bị xoá (mapping mất) mà topic trên Telegram còn.
  // Gõ trong chính topic đó:  /link ROOM_WIN_XXXXXXXXXXXX
  // Ghi CẢ HAI chiều nên tin user → Telegram và Telegram → user chạy lại ngay.
  if (/^\/link(?:@\w+)?(\s|$)/i.test(text)) {
    const room = String(text.split(/\s+/)[1] || '').trim().toUpperCase();
    let answer;
    if (!/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(room)) {
      answer = '⚠️ Cú pháp: /link ROOM_WIN_XXXXXXXXXXXX';
    } else if (map?.chatRoomId && map.chatRoomId !== room) {
      answer = '⚠️ Topic này đang gắn với ' + map.chatRoomId + '. Không ghi đè tự động — kiểm tra lại cho đúng.';
    } else {
      await firebase(env, '/telegramTopics/' + threadId, 'PUT', { chatRoomId: room, createdAt: Date.now() });
      await firebase(env, '/chats/' + encodeURIComponent(room) + '/meta', 'PATCH', { telegramThreadId: threadId, telegramTopicCreatedAt: Date.now() });
      answer = '✅ Đã gắn topic này với ' + room + '. Hai chiều chạy lại ngay.';
    }
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: answer.slice(0, 4000) });
    return reply({ ok: true, value: { link: room } });
  }

  // /online — ai đang chạy app, ai đã tắt. Lệnh toàn cục, không gắn với phòng.
  if (/^\/online(?:@\w+)?(\s|$)/i.test(text)) {
    const answer = await onlineReport_(env);
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: answer });
    return reply({ ok: true, value: { command: '/online' } });
  }

  // /ai... — đặt TRƯỚC /check_SDT và trước nhánh lệnh theo phòng chat.
  if (/^\/ai(\s|$)/i.test(text)) return await aiCommand_(env, text, threadId);

  // /check_SDT — tra cứu theo số điện thoại. Lệnh toàn cục, không gắn với phòng:
  // "tra cứu" nghĩa là tìm khách, nên phải chạy được từ bất kỳ topic nào, kể cả
  // topic chưa gắn máy. Đặt TRƯỚC nhánh lệnh theo phòng để /check_SDT không bị
  // nuốt vào /check; hai lệnh này khác nhau (/check = máy này, /check_SDT = tìm khách).
  const phoneLookup = /^\/(?:check_sdt(?:@\w+)?\s+|check[_\s]+)(\+?[\d][\d\s.()-]{6,})$/i.exec(text);
  if (phoneLookup) {
    const phone = phoneLookup[1].trim();
    const answer = await phoneReport_(env, phone);
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: answer.slice(0, 4000) });
    return reply({ ok: true, value: { command: '/check_' + phone } });
  }

  // /who — trạng thái NGAY BÂY GIỜ của chính khách trong topic này, và sửa lại chấm
// 🟢/⚪️ trên tên topic. Cần lệnh này vì Gateway chỉ biết lúc khách "vừa gửi tín
// hiệu"; khách đóng app thì không có ai báo, nên chấm trên tên topic có thể cũ tới
// một cửa sổ ONLINE_WINDOW_MS. Gõ /who là admin hỏi đúng vào lúc cần.
if (/^\/who(?:@\w+)?(\s|$)/i.test(text) || /^\/trang-thai(\s|$)/i.test(text)) {
  const room = map?.chatRoomId || '';
  if (!room) {
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: '⚠️ Topic này chưa gắn với thiết bị nào trong Firebase — chưa biết trạng thái khách nào.' });
    return reply({ ok: true, value: { command: '/who' } });
  }
  const now = Date.now();
  const presence = (await firebase(env, '/devices/' + encodeURIComponent(room) + '/presence')) || {};
  const online = isOnlineAt(presence.lastSeen, now);
  const meta = (await firebase(env, '/chats/' + encodeURIComponent(room) + '/meta')) || {};
  await refreshTopicStatus_(env, room);
  const mins = Math.floor((now - Number(presence.lastSeen || 0)) / 60000);
  const when = !Number(presence.lastSeen) ? 'chưa từng mở app'
    : mins < 1 ? 'vừa xong' : mins < 60 ? mins + ' phút trước'
      : mins < 1440 ? Math.floor(mins / 60) + ' giờ trước' : Math.floor(mins / 1440) + ' ngày trước';
  const lines = [
    (online ? '🟢 ĐANG MỞ APP' : '⚪️ ĐÃ ĐÓNG APP'),
    '',
    '👤 ' + ([meta.contactPhone, meta.contactName].filter(Boolean).join(' - ') || 'chưa có tên/SĐT'),
    '🖥 Máy: ' + plain(presence.machineId || '—'),
    '📱 Phiên bản: ' + plain(presence.appVersion || '—'),
    '🕒 Nhận tín hiệu: ' + when,
    '',
    online
      ? 'App đang chạy (có thể đang ở chế độ nền trên thanh công cụ) — vẫn dùng được bình thường.'
      : 'Không có tín hiệu trong ' + Math.round(ONLINE_WINDOW_MS / 60000) + ' phút qua ⇒ app đang đóng.',
  ];
  await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: lines.join('\n') });
  return reply({ ok: true, value: { command: '/who', online, lastSeen: Number(presence.lastSeen || 0) } });
}

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
        const value = await gas(env, { action: 'admin_command', chatRoomId: room, command, text, actor: String(message.from?.id || '') });
        // /lock, /unlock, /reset đổi trạng thái ngay trên Sheet. Ghi bản ghi nhớ
        // phía Firebase để app hỏi nhẹ (/v1/ping) nhận ra ngay.
        await cacheLicense_(env, room, value);
        await billingRefresh_(env,value,command);
        answer = String(value?.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
        // Lệnh cấp key / gia hạn: đẩy thông tin sang phòng chat của khách để khách
        // thấy ngay trong app, không phải chờ admin trao tay. Lệnh khác (/check,
        // /lock...) vẫn chỉ trả lời trong topic — không spam khách.
        const notice = customerNotice_(command, value);
        if (notice) {
          try {
            // CẤP KEY / GIA HẠN KHÔNG chiếm phiên: admin chỉ gửi thông tin bản quyền sang
            // app của khách. Trước đây chỗ này gọi owner(room,'admin') nên vừa cấp key xong
            // là AI bị khoá, khách hỏi tiếp lại bị đẩy sang admin — trái đúng mong muốn.
            await firebase(env, '/chats/' + encodeURIComponent(room) + '/messages', 'POST', {
              sender: 'admin',
              text: notice,
              timestamp: Date.now(),
              source: 'telegram',
              telegramThreadId: message.message_thread_id,
              deliveryStatus: 'firebase',
            });
            answer += '\n\n✅ Đã gửi thông báo này sang app của khách.';
          } catch (error) {
            answer += '\n\n⚠️ Không gửi được sang app khách: ' + (error && error.message ? error.message : String(error));
          }
        }
      } catch (error) {
        answer = '⚠️ CRM báo lỗi: ' + (error.message || 'unknown');
      }
    }
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: message.message_thread_id, text: answer.slice(0, 4000) });
    return reply({ ok: true, value: { command } });
  }

  if (!map?.chatRoomId) {
    // KHÔNG im lặng nữa. Trước đây dòng này là `reply({ ok: true, ignored: true })` nên tin rơi mất
    // mà không để lại dấu vết nào — đúng hiện tượng "Telegram trả lời, app không nhận".
    await telegram(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId,
      text: '⚠️ Topic này chưa gắn với thiết bị nào (Firebase không có mapping).\n'
        + '• Khách mở app một lần là Gateway tự tạo topic + gắn mapping, hoặc\n'
        + '• Gõ `/link ROOM_WIN_…` trong topic này để gắn lại chính topic đang dùng.',
    });
    return reply({ ok: true, value: { unlinked: true } });
  }
  const value = { sender: 'admin', text, timestamp: (message.date || Math.floor(Date.now() / 1000)) * 1000, source: 'telegram', telegramMessageId: message.message_id, telegramThreadId: message.message_thread_id, deliveryStatus: 'firebase' };
  await supportFlow.owner(env,map.chatRoomId,'admin',String(message.from.id));
  const result = await firebase(env, '/chats/' + encodeURIComponent(map.chatRoomId) + '/messages', 'POST', value);
  return reply({ ok: true, value: { id: result.name } });
}

// ============================================================
// CẤU HÌNH AI DO ADMIN ĐẶT TỪ TELEGRAM
// ============================================================
// Admin gõ /ai... trong Telegram; Gateway chuyển action ai_admin xuống Apps Script,
// Apps Script ghi vào tab AI_PROFILES và trả kèm cấu hình đã lưu. Gateway giữ
// bản ghi nhớ để app dùng ngay ở lượt kế tiếp, không phải chờ hết hạn cache.
//
// Ai trả lời câu hỏi "key có hết quota không" là chính dịch vụ AI: HTTP 401/402/429
// hoặc thân lỗi có quota/limit/balance/credit/authorization. Mỗi key hết hạn mức bị
// loại khỏi vòng xoay một khoảng lâu (quota thường hồi theo giờ/ngày, không phải
// vài giây) — nếu chỉ thử lại ngay thì mọi lượt chat sau đều dồn vào key vừa hết
// hạn mức và đều fail, tức là bản quyền của khách bị giết vì nhà cung cấp AI.
const AI_CACHE_MS = 60000;
const AI_KEY_COOLDOWN_MS = 15 * 60 * 1000;
let aiCache = { value: null, at: 0 };
// key -> thời điểm hết thời gian nghỉ. Ghi nhớ trong bộ nhớ isolate; mất khi
// Cloudflare khởi động lại isolate thì tệ nhất là vài lượt chat thử lại key cũ —
// không mất tiền, không lộ dữ liệu.
const aiKeysDown = new Map();

// Trả về cấu hình AI đang dùng, có kiểm tra hình dạng dữ liệu vì nó đến từ Sheet
// do người ngoài sửa tay: URL phải là https, model phải là chuỗi, key phải là mảng
// chuỗi. Ô rác thì bỏ dòng đó chứ không ném lỗi cho cả bot.
function aiSanitize_(value) {
  const profiles = (value && Array.isArray(value.profiles) ? value.profiles : [])
    .map(p => ({
      alias: String(p && p.alias || ''),
      order: Number.isFinite(Number(p && p.order)) ? Number(p.order) : 999,
      baseURL: String(p && p.baseURL || '').replace(/\/+$/, ''),
      model: String(p && p.model || ''),
      keys: (p && Array.isArray(p.keys) ? p.keys : []).map(k => String(k)).filter(k => /^[\x21-\x7e]{8,200}$/.test(k)),
    }))
    .filter(p => /^https:\/\/[^\s/$.?#][^\s]*$/i.test(p.baseURL) && /^[A-Za-z0-9._:/|-]{1,120}$/.test(p.model) && p.keys.length)
    .slice(0, 20);
  const active = String(value && value.active || '');
  return { active: profiles.some(p => p.alias === active) ? active : (profiles[0] ? profiles[0].alias : ''), profiles };
}

// Chuỗi thử lần lượt khi một key hết hạn mức: hết key của model này thì sang
// model kế tiếp CÙNG URL, hết các model của URL đó thì mới sang URL tiếp theo.
// Gom theo URL trước rồi mới xếp theo Order — nếu chỉ xếp phẳng theo Order thì
// hai model cùng URL có thể bị ngắt bởi một URL khác chen giữa, mất đúng ý
// "cùng URL thì thay model trước, chết hẳn mới đổi URL".
function aiChain_(config) {
  const ordered = config.profiles.slice().sort((a, b) => a.order - b.order);
  const groups = [];
  const indexOf = new Map();
  for (const profile of ordered) {
    if (!indexOf.has(profile.baseURL)) {
      indexOf.set(profile.baseURL, groups.length);
      groups.push({ baseURL: profile.baseURL, profiles: [] });
    }
    groups[indexOf.get(profile.baseURL)].profiles.push(profile);
  }
  const active = ordered.find(p => p.alias === config.active);
  if (active) {
    const at = indexOf.get(active.baseURL);
    if (at > 0) groups.unshift(...groups.splice(at, 1));
  }
  const chain = [];
  for (const group of groups) {
    for (const profile of group.profiles) {
      for (const key of aiKeyOrder_(profile.keys)) chain.push({ profile, key });
    }
  }
  // Trần số lần thử: chuỗi dài vô hạn sẽ biến một lượt chat thành hàng chục
  // request ra ngoài. 12 lần là dư cho mọi cấu hình thực tế.
  return chain.slice(0, 12);
}

async function aiConfig_(env, force) {
  const now = Date.now();
  if (!force && aiCache.value && now - aiCache.at < AI_CACHE_MS) return aiCache.value;
  const value = aiSanitize_(await gas(env, { action: 'ai_config', aiSheetId: env.AI_CONFIG_SHEET_ID || '' }));
  aiCache = { value, at: Date.now() };
  return value;
}

// Sắp key ngẫu nhiên để tải phân bố đều, và đưa key đang nghỉ xuống cuối: nhờ vậy
// khi một key vừa hết hạn mức thì các key còn tốt vẫn được thử trước, chứ không
// phải đợi hết thời gian nghỉ của key chết.
function aiKeyOrder_(keys) {
  const now = Date.now();
  const ready = [], resting = [];
  for (const key of keys) (Number(aiKeysDown.get(key) || 0) > now ? resting : ready).push(key);
  for (let i = ready.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ready[i], ready[j]] = [ready[j], ready[i]];
  }
  return ready.concat(resting);
}

// /ai... — lệnh TOÀN CỤC của admin (cấu hình dùng chung cho mọi máy), nên nhánh gọi
// nó đặt ở webhook TRƯỚC nhánh lệnh gắn theo phòng chat: nếu để sau, "/ai add ..."
// sẽ bị đổi thành lệnh theo phòng và báo lỗi "topic chưa gắn thiết bị".
async function aiCommand_(env, text, threadId) {
  let answer;
  let keyboard = null;
  try {
    const value = await gas(env, { action: 'ai_admin', text, updatedBy: 'telegram', aiSheetId: env.AI_CONFIG_SHEET_ID || '' });
    // Lệnh của admin vừa đổi cấu hình thì dùng ngay, không chờ hết TTL cache —
    // nếu không, admin sửa xong phải đợi tới một phút mới thấy tác dụng.
    if (value && value.config) aiCache = { value: aiSanitize_(value.config), at: Date.now() };
    answer = String(value && value.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
    keyboard = aiMenu_();
  } catch (error) {
    answer = '⚠️ Không đổi được cấu hình AI: ' + (error && error.message ? error.message : String(error));
  }
  await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: answer.slice(0, 4000), ...(keyboard ? { reply_markup: keyboard } : {}) });
  return reply({ ok: true, value: { command: '/ai' } });
}

// ============================================================
// MENU NÚT BẤM CHO /ai
// ============================================================
// Yêu cầu của admin: thao tác bằng cách BẤM, chỉ gõ tay khi nhập giá trị mới.
// callback_data của Telegram chỉ chứa được 64 byte — nên trong đó chỉ để mã
// lệnh + tên cấu hình (tên đã giới hạn 40 ký tự), tuyệt đối không kèo key.
const AI_PROMPTS = new Map();   // topic -> bước đang chờ admin nhập giá trị

function aiMenu_() {
  return { inline_keyboard: [
    [{ text: '📋 Cấu hình', callback_data: 'ai:list' }, { text: '🔍 Kiểm tra key', callback_data: 'ai:check' }],
    [{ text: '🗝 Thêm key', callback_data: 'ai:keypick' }, { text: '➕ Thêm model', callback_data: 'ai:new' }],
    [{ text: '❓ Hướng dẫn', callback_data: 'ai:help' }, { text: '🔄 Làm mới', callback_data: 'ai:refresh' }],
  ] };
}

function aiProfilesKeyboard_(profiles, active) {
  const rows = profiles.map(p => [{ text: (p.alias === active ? '▶️ ' : '  ') + p.alias + ' · ' + p.model, callback_data: 'ai:prof:' + p.alias }]);
  rows.push([{ text: '⬅️ Menu', callback_data: 'ai:menu' }]);
  return { inline_keyboard: rows };
}

function aiProfileKeyboard_(alias) {
  return { inline_keyboard: [
    [{ text: '✅ Bật cấu hình này', callback_data: 'ai:use:' + alias }],
    [{ text: '🔑 Danh sách key', callback_data: 'ai:keys:' + alias }, { text: '🔍 Kiểm tra key', callback_data: 'ai:check1:' + alias }],
    [{ text: '🗝 Thêm key', callback_data: 'ai:addkey:' + alias }, { text: '🗑 Xoá cấu hình', callback_data: 'ai:del:' + alias }],
    [{ text: '⬅️ Danh sách', callback_data: 'ai:list' }],
  ] };
}

function aiMaskKey_(key) {
  const value = String(key || '');
  if (value.length < 10) return '***';
  return value.slice(0, 6) + '…' + value.slice(-4);
}

function aiKeysKeyboard_(profile) {
  const rows = profile.keys.map((key, index) => [{
    text: (aiKeysDown.has(key) ? '⚠️ ' : '') + (index + 1) + '. ' + aiMaskKey_(key),
    callback_data: 'ai:keydel:' + profile.alias + ':' + (index + 1),
  }]);
  rows.push([{ text: '🔍 Kiểm tra key', callback_data: 'ai:check1:' + profile.alias }]);
  rows.push([{ text: '🗝 Thêm key', callback_data: 'ai:addkey:' + profile.alias }, { text: '⬅️ Cấu hình', callback_data: 'ai:prof:' + profile.alias }]);
  return { inline_keyboard: rows };
}

// Chạy lệnh /ai của Apps Script rồi trả về câu trả lời (nút bấm gửi kèm sau).
// AI_CONFIG_SHEET_ID (secret) là Sheet cấu hình AI RIÊNG. Script Property của
// Apps Script không set được qua API, nên Gateway truyền ID xuống theo mỗi
// request; Apps Script tự tạo tab PROFILES nếu Sheet đó còn trống.
async function aiRun_(env, threadId, text) {
  try {
    const value = await gas(env, { action: 'ai_admin', text, updatedBy: 'telegram', aiSheetId: env.AI_CONFIG_SHEET_ID || '' });
    if (value && value.config) aiCache = { value: aiSanitize_(value.config), at: Date.now() };
    return String(value && value.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
  } catch (error) {
    return '⚠️ Lỗi: ' + (error && error.message ? error.message : String(error));
  }
}

// Gõ tay chỉ dùng cho giá trị mới: sau khi bấm nút, bot hỏi và nhận đúng MỘT
// tin nhắn kế tiếp trong topic đó làm giá trị.
async function aiAsk_(env, threadId, text, step) {
  const sent = await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text, force_reply: true, reply_markup: { force_reply: { input_field_placeholder: 'Nhập giá trị rồi gửi' } } });
  // Ghi lại id tin hỏi: chỉ nhận câu trả lời TRẢ LỜI ĐÚNG tin này. Nếu ai đó
  // đang chat trong cùng topic (topic của một máy khách) thì tin của họ phải tới
  // đúng khách, tuyệt đối không được nuốt nhầm làm "API key".
  AI_PROMPTS.set(threadId, { ...step, messageId: sent && sent.message_id || 0 });
}

// Kiểm tra key bằng request rẻ nhất của nhà cung cấp (GET /models): không tốn
// tiền chat và nhanh hơn, đủ để biết key còn dùng được hay không.
async function aiCheck_(env, alias) {
  const config = await aiConfig_(env);
  const profiles = alias ? config.profiles.filter(p => p.alias === alias) : config.profiles;
  if (!profiles.length) return '⚠️ Không có cấu hình "' + (alias || '') + '".';
  const lines = ['🔍 KIỂM TRA KEY'];
  for (const profile of profiles) {
    lines.push('');
    lines.push((profile.alias === config.active ? '▶️ ' : '  ') + profile.alias + ' · ' + profile.model);
    for (const key of profile.keys) {
      let verdict;
      try {
        const response = await fetch(profile.baseURL + '/models', { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + key } });
        if (response.ok) {
          let count = 0;
          try { const body = await response.json(); count = Array.isArray(body && body.data) ? body.data.length : 0; } catch { count = 0; }
          verdict = '✅ hoạt động' + (count ? ' (' + count + ' model)' : '');
          aiKeysDown.delete(key);
        } else {
          const detail = (await response.text().catch(() => '')).slice(0, 300);
          const quota = aiQuotaError_(response.status, detail);
          verdict = quota ? (response.status === 401 ? '❌ key không hợp lệ (401)' : '❌ hết hạn mức (' + response.status + ')') : '❌ lỗi ' + response.status;
          // Key đã hỏng thì loại khỏi vòng xoay luôn, khỏi để khách chat dò nhầm.
          if (quota) aiKeysDown.set(key, Date.now() + AI_KEY_COOLDOWN_MS);
        }
      } catch (error) {
        verdict = '❌ không gọi được: ' + (error && error.message ? error.message : String(error));
      }
      lines.push('   ' + aiMaskKey_(key) + ' — ' + verdict);
    }
  }
  return lines.join('\n');
}

// Xử lý một cú bấm nút. Trả về false nếu không phải nút của /ai để nhánh khác
// xử lý tiếp (nút của các lệnh cũ vẫn chạy y như cũ).
async function aiCallback_(env, callback) {
  const data = String(callback && callback.data || '');
  if (!data.startsWith('ai:')) return false;
  const threadId = callback.message && callback.message.message_thread_id;
  let acknowledged = false;
  const ack = async text => {
    if (acknowledged) return;
    acknowledged = true;
    try {
      await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text: text.slice(0, 200) } : {}) });
    } catch {
      // Telegram có thể hết hạn callback khi webhook bị giao chậm. Việc bỏ
      // vòng quay trên nút thất bại không được chặn thao tác và câu trả lời.
      console.log('AI callback acknowledgement unavailable');
    }
  };
  if (!threadId) { await ack('⚠️ Chỉ dùng được trong topic.'); return true; }
  // Xác nhận NGAY, trước khi đợi Apps Script khởi động/đọc Sheet.
  await ack();
  // Bỏ đúng tiền tố 'ai:' rồi mới tách phần còn lại — tác cả chuỗi sẽ cho
  // action = 'ai' và mọi nút rơi xuống nhánh cuối, tức bấm gì cũng im lặng.
  const [action, a, b] = data.slice(3).split(':');
  const send = async (text, keyboard) => telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: text.slice(0, 4000), ...(keyboard ? { reply_markup: keyboard } : {}) });
  if (action === 'menu') { await ack(); await send('🤖 QUẢN LÝ AI — chọn một việc:', aiMenu_()); return true; }
  if (action === 'list') {
    const config = await aiConfig_(env);
    await ack();
    await send('🤖 CẤU HÌNH AI — bấm một dòng để quản lý:', config.profiles.length ? aiProfilesKeyboard_(config.profiles, config.active) : aiMenu_());
    return true;
  }
  if (action === 'help') {
    await ack();
    await send('/ai add <tên> <url> <model>\n/ai url <tên> <url>\n/ai model <tên> <model>\n/ai use <tên>\n/ai del <tên>\n/ai key <tên> add <key>\n/ai key <tên> list\n/ai key <tên> del <số>\n/ai key <tên> check', aiMenu_());
    return true;
  }
  if (action === 'refresh') { await ack('Đã tải lại'); await aiConfig_(env, true); await send('🔄 Đã tải lại cấu hình từ Sheet.', aiMenu_()); return true; }
  if (action === 'prof') {
    const config = await aiConfig_(env);
    const profile = config.profiles.find(p => p.alias === a);
    await ack();
    await send(profile ? '🤖 ' + profile.alias + '\nURL: ' + profile.baseURL + '\nModel: ' + profile.model + '\nKey: ' + profile.keys.length + ' key' + (profile.alias === config.active ? '\n▶️ Đang dùng' : '') : '⚠️ Không còn cấu hình này.', aiProfileKeyboard_(a));
    return true;
  }
  if (action === 'keys') {
    const config = await aiConfig_(env);
    const profile = config.profiles.find(p => p.alias === a);
    await ack();
    await send(profile ? '🔑 KEY CỦA ' + profile.alias + ' (' + profile.keys.length + ')\nBấm một key để xoá.' : '⚠️ Không còn cấu hình này.', profile ? aiKeysKeyboard_(profile) : aiMenu_());
    return true;
  }
  if (action === 'use' || action === 'del' || action === 'keydel') {
    await ack();
    const text = action === 'use' ? '/ai use ' + a : action === 'del' ? '/ai del ' + a : '/ai key ' + a + ' del ' + b;
    await send(await aiRun_(env, threadId, text), aiMenu_());
    return true;
  }
  if (action === 'keypick') {
    const config = await aiConfig_(env);
    const rows = config.profiles.map(p => [{ text: p.alias + ' · ' + p.model, callback_data: 'ai:addkey:' + p.alias }]);
    rows.push([{ text: '⬅️ Menu', callback_data: 'ai:menu' }]);
    await ack();
    await send('🗝 Chọn cấu hình để thêm key:', { inline_keyboard: rows });
    return true;
  }
  if (action === 'addkey') {
    await ack();
    await aiAsk_(env, threadId, '🗝 Gõ API key cần thêm vào "' + a + '"\n(key đang chạy vẫn giữ nguyên, chỉ thêm thêm key)', { kind: 'addkey', alias: a });
    return true;
  }
  if (action === 'new') {
    await ack();
    await aiAsk_(env, threadId, '➕ Gõ tên cấu hình (chữ/số và . _ -, không khoảng trắng)', { kind: 'new', step: 'alias' });
    return true;
  }
  if (action === 'check') { await ack(); await send(await aiCheck_(env, ''), aiMenu_()); return true; }
  if (action === 'check1') { await ack(); await send(await aiCheck_(env, a), aiProfileKeyboard_(a)); return true; }
  return true;
}

// Tin nhắn trả lời đúng câu hỏi của bot: dùng làm giá trị cho bước đó rồi xoá
// trạng thái chờ, để tin nhắn sau không bị nuốt nhầm.
async function aiPrompt_(env, message, threadId) {
  const step = AI_PROMPTS.get(threadId);
  if (!step) return false;
  const reply = message && message.reply_to_message;
  if (!reply || reply.message_id !== step.messageId) return false;   // không phải trả lời cho bot
  AI_PROMPTS.delete(threadId);
  const value = String(message.text || '').trim().slice(0, 300);
  if (!value) { await aiAsk_(env, threadId, '⚠️ Chưa nhận được giá trị, thử lại nhé.', step); return true; }
  if (step.kind === 'addkey') {
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: await aiRun_(env, threadId, '/ai key ' + step.alias + ' add ' + value), reply_markup: aiMenu_() });
    return true;
  }
  if (step.kind === 'new') {
    if (step.step === 'alias') { await aiAsk_(env, threadId, '🌐 Gõ địa chỉ API (https://…)', { kind: 'new', step: 'url', alias: value }); return true; }
    if (step.step === 'url') { await aiAsk_(env, threadId, '🧠 Gõ tên model', { kind: 'new', step: 'model', alias: step.alias, url: value }); return true; }
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: await aiRun_(env, threadId, '/ai add ' + step.alias + ' ' + step.url + ' ' + value), reply_markup: aiMenu_() });
    return true;
  }
  return true;
}

// ============================================================
// PROXY AI — app không cầm API key
// ============================================================
// App gửi body OpenAI-compatible tới đây; Gateway đọc cấu hình do admin đặt ở
// Telegram (tab AI_PROFILES), tự chọn model và key rồi chuyển tiếp. Key nằm trên
// Gateway, không bao giờ đi xuống máy khách — đó là lý do của toàn bộ đường này.
//
// Bắt buộc trước khi gọi AI: token phiên hợp lệ (token đã ký, chỉ đúng máy đang
// gọi) và bản quyền còn dùng được. Thiếu hai bước này thì bất kỳ ai biết URL
// Gateway cũng dùng được key của bạn.
async function aiProxy_(env, request, ctx) {
  const value = await claims(env, request);
  const control=await supportFlow.state(env,value.chatRoomId);
  if(control.mode!=='auto')return Response.json({error:{code:'SUPPORT_ADMIN_ACTIVE',message:control.mode==='waiting'?'Đã chuyển tới admin. Admin sẽ liên hệ lại.':'Admin đang hỗ trợ. AI đã tạm dừng.'}},{status:409});
  if (/expired|locked/i.test(String(value.license || ''))) throw Error('Bản quyền không cho phép dùng AI.');
  const raw = await request.text();
  if (!raw || raw.length > 2 * 1024 * 1024) throw Error('Request AI quá lớn.');
  let body;
  try { body = JSON.parse(raw); } catch { throw Error('Body AI không phải JSON hợp lệ.'); }
  const cntaxBasic = body.metadata?.cntax_mode === 'basic';
  if (cntaxBasic && (body.stream !== false || body.tools?.length)) return Response.json({ error: { code: 'BASIC_PROTOCOL_INVALID' } }, { status: 400 });
  if (env.AI_ADMIN_V2_ENABLED === '1') {
    const conversation = String(body.metadata?.conversation_id || '').slice(0,80);
    const managed = await aiAdmin.proxy(env, body, String(value.installationId || value.machineId || '') + ':' + conversation,ctx,new URL(request.url).origin);
    if (managed) return managed;
  }
  const config = await aiConfig_(env);
  let chain = aiChain_(config);
  if (cntaxBasic) {
    const aliases = String(env.AI_BASIC_PROFILE_ALIASES || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
    const allowed = aliases.length ? aliases : [chain[0]?.profile.alias];
    chain = allowed.map(alias => chain.find(step => step.profile.alias === alias)).filter(Boolean);
  }
  if (!chain.length) throw Error('Chưa có cấu hình AI trên máy chủ. Admin gõ /ai trong Telegram.');
  let lastError = null;
  // Đi hết chuỗi dự phòng: hết key của model này thì thử model kế tiếp CÙNG URL,
  // rồi mới sang URL sau. Model của mỗi lần thử lấy từ chính profile đó, không
  // dùng cứng model của profile đầu — nếu dùng cứng thì "chuyển model dự phòng"
  // chỉ đổi tên mà vẫn gọi model đã chết.
  const basicStarted = Date.now();
  for (const step of chain) {
    const payload = JSON.stringify({ ...body, model: step.profile.model });
    let response;
    try { response = await fetch(step.profile.baseURL + '/chat/completions', { method: 'POST', redirect: 'manual', ...(cntaxBasic ? { signal: AbortSignal.timeout(Math.max(1, Math.min(25000, 85000 - (Date.now() - basicStarted)))) } : {}), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + step.key }, body: payload }); }
    catch (error) { if (!cntaxBasic) throw error; lastError = { status: 503, detail: 'Nguồn aichat không khả dụng.' }; continue; }
    if (response.ok) {
      // Chuyển thẳng stream của nhà cung cấp về app: app đọc SSE y hệt, nên logic
      // agent/model-provider cũ không phải đổi gì.
      return new Response(response.body, { status: 200, headers: { 'Content-Type': response.headers.get('Content-Type') || 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    }
    const detail = (await response.text().catch(() => '')).slice(0, 2000);
    lastError = { status: response.status, detail };
    // Lỗi KHÔNG phải hết hạn mức (model sai, body sai, 500) thì đổi key/model cũng
    // không giúp — trả luôn lỗi thật cho app, đừng quay key vô ích.
    if (!aiQuotaError_(response.status, detail) && !(cntaxBasic && response.status >= 500)) break;
    aiKeysDown.set(step.key, Date.now() + AI_KEY_COOLDOWN_MS);
    console.log('AI key het han muc, thu tiep: ' + step.profile.alias + ' / ' + response.status);
  }
  if (lastError) return new Response(lastError.detail || 'Máy chủ AI lỗi.', { status: lastError.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  throw Error('Không gọi được AI.');
}

function aiQuotaError_(status, detail) {
  if ([401, 402, 403, 429].includes(status)) return true;
  return /quota|insufficient|rate.?limit|too many|balance|credit|unauthor/i.test(String(detail || ''));
}

// Bản ghi nhớ phía Firebase cho phép hỏi NHẸ mà không đụng Apps Script.
// /v1/ping chỉ đọc chỗ này, nên việc kiểm tra định kỳ của app KHÔNG tốn quota
// Google Apps Script — chỉ khi có thay đổi thật (đăng ký, kích hoạt, lệnh admin)
// mới gọi xuống Sheet.
function licensePath(room) { return '/devices/' + encodeURIComponent(room) + '/license'; }

async function cacheLicense_(env, room, value) {
  const status = String(value && value.status || '').trim();
  if (!status) return;                       // không có trạng thái thì đừng ghi đè bản nhớ
  try {
    await firebase(env, licensePath(room), 'PUT', {
      status,
      expiryAt: value.expiryAt || '',
      trial: !!value.trial,
      billing: value.billing || null, entitlement: value.entitlement || null,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.log('Ghi bản nhớ bản quyền thất bại: ' + (error && error.message ? error.message : String(error)));
  }
}

// Ghi nhịp sống và TRẢ VỀ việc trạng thái có chuyển không.
// Vì sao phải trả về: tên topic Telegram có chấm 🟢/⚪️, và sửa tên topic là một lời
// gọi API — không được gọi mỗi nhịp (10 phút × mỗi khách sẽ là dội rate limit và
// topic nhấp nháy). Chỉ sửa khi trạng thái thật sự đổi.
//
// `wasOnline` đọc TỪ TÍNH ĐÃ TÍNH SẴN, không tự tính lại từ lastSeen: ngay sau lúc
// ghi, lastSeen luôn "vừa xong", nên nếu tính lại thì luôn ra online và không bao giờ
// nhận ra được lần chuyển sang offline.
async function presence_(env, room, input, wasOnline) {
  const at = Date.now();
  try {
    await firebase(env, '/devices/' + encodeURIComponent(room) + '/presence', 'PUT', {
      machineId: String(input.machineId || ''),
      appVersion: String(input.appVersion || '').slice(0, 32),
      lastSeen: at,
    });
  } catch { /* nhịp sống là thông tin phụ: hỏng thì không cần báo */ }
  if (wasOnline === undefined) return null;
  const online = wasOnline === false;      // chỉ có thể chuyển sang online khi vừa ghi nhịp
  return online ? 'online' : null;
}

// Đọc trạng thái hiện tại của một phòng. Dùng CHUNG một quy ước cửa sổ thời gian với
// Code.gs (ONLINE_WINDOW_MS) và với /online — ba nơi lệch nhau thì admin nhìn thấy
// mâu thuẫn ngay trong cùng một lúc.
// Bao lau online: may co gui tin hieu trong cua so nay thi tinh la ONLINE.
// App gui moi 10 phut (xem nhip song o src/server.js) nen 15 phut la du bien an toan:
// may ngu mot nhip, hoac mang chap cho, van khong bi bao offline oan.
// Cung mot quy uoc voi Code.gs (ONLINE_WINDOW_MS) - doi thi sua ca hai.
const ONLINE_WINDOW_MS = 15 * 60 * 1000;
function isOnlineAt(lastSeen, now = Date.now()) {
  const at = Number(lastSeen);
  return Number.isFinite(at) && at > 0 && (now - at) <= ONLINE_WINDOW_MS;
}

// Tên topic kèm chấm trạng thái — đây là thứ admin nhìn thấy ngay trong danh sách
// topic, không cần gõ lệnh gì.
function topicLabel(meta, online) {
  const base = [meta.contactPhone, meta.contactName].filter(Boolean).join(' - ');
  const text = (online ? '🟢 ' : '⚪️ ') + (base || 'khách chưa đăng ký tên');
  return text.slice(0, 128);              // Telegram chặn tên topic dài hơn 128 ký tự
}

// Sửa tên topic cho khớp trạng thái. Luôn tính từ `meta` + presence rồi so với
// `meta.topicName` đã áp dụng — nếu không có bước so này thì mỗi nhịp sống đều gọi
// editForumTopic, tốn rate limit và làm topic của khách nhấp nháy tên.
async function refreshTopicStatus_(env, room) {
  const metaPath = '/chats/' + encodeURIComponent(room) + '/meta';
  try {
    const meta = (await firebase(env, metaPath)) || {};
    const thread = meta.telegramThreadId;
    if (!thread) return null;
    const presence = (await firebase(env, '/devices/' + encodeURIComponent(room) + '/presence')) || {};
    const online = isOnlineAt(presence.lastSeen);
    const name = topicLabel(meta, online);
    if (meta.topicName === name) return name;
    await telegram(env, 'editForumTopic', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, name });
    await firebase(env, metaPath, 'PATCH', { topicName: name, onlineAt: online ? Date.now() : 0 });
    return name;
  } catch (error) {
    // Chấm trạng thái là phần trang trí: hỏng thì im lặng, không được làm hỏng luồng
    // nhắn tin hay bản quyền.
    console.log('Không cập nhật được chấm trạng thái topic ' + room + ': ' + (error && error.message ? error.message : error));
    return null;
  }
}

// Lúc mở app: MỘT lần gọi duy nhất lấy về bản quyền + thông báo + token phiên,
// thay vì app phải gọi /devices/register rồi /notices/current rồi /chats/status
// thành ba chuyến đi với ba chuyến về.
async function sync_(env, request, input) {
  const d = device(input);
  const info = contact(input);
  const license = await gas(env, { action: 'register_device', ...d, ...info });
  if(license.chatRoomId) d.chatRoomId=license.chatRoomId;
  await cacheLicense_(env, d.chatRoomId, license);
  // Đọc trạng thái cũ TRƯỚC khi ghi nhịp mới — để biết có phải sửa chấm topic hay không.
  const previous = (await firebase(env, '/devices/' + encodeURIComponent(d.chatRoomId) + '/presence')) || {};
  await presence_(env, d.chatRoomId, input, isOnlineAt(previous.lastSeen));
  try { await announce(env, d, info, license); }
  catch (error) { console.log('Telegram topic pending: ' + error.message); }
  await refreshTopicStatus_(env, d.chatRoomId);
  // Thông báo là thứ tuỳ chọn: lỗi thì trả null chứ không làm hỏng cả lần đồng bộ.
  let notice = null;
  try { notice = await gas(env, { action: 'get_notice', ...d }); } catch { notice = null; }
  return reply({ ok: true, value: { ...await sessionValue(env, d, license), chatRoomId: d.chatRoomId, notice, serverTime: Date.now() } });
}

// Hỏi nhẹ cho app chạy nền: chỉ đọc Firebase, KHÔNG gọi Apps Script nên không
// tốn quota. Trả về licenseCacheHit = false khi chưa có bản ghi nhớ — lúc đó
// app biết phải hỏi đường đầy đủ (/v1/sync) thay vì tin vào dữ liệu rỗng.
async function ping_(env, request, input) {
  const d = device(input);
  const cached = await firebase(env, licensePath(d.chatRoomId));
  // Nhịp sống 10 phút một lần: đây là thứ làm "app chạy nền vẫn tính là online".
  // Không đọc/ghi gì khác — nhịp này chỉ dùng để giữ mốc lastSeen mới.
  const previous = (await firebase(env, '/devices/' + encodeURIComponent(d.chatRoomId) + '/presence')) || {};
  const wasOnline = isOnlineAt(previous.lastSeen);
  await presence_(env, d.chatRoomId, input, wasOnline);
  if (!wasOnline) await refreshTopicStatus_(env, d.chatRoomId);
  return reply({ ok: true, value: {
    license: cached || null,
    licenseCacheHit: !!cached,
    chatRoomId: d.chatRoomId,
    serverTime: Date.now(),
  } });
}

// Tin nhắn gửi SANG APP của khách sau khi admin dùng lệnh quản trị.
// Chỉ /new (cấp key) và /extend (gia hạn) — hai việc khách cần biết ngay.
// Trả về '' nghĩa là không có gì để gửi.
//
// Ghi thẳng vào Firebase nên khách thấy trong app (SSE đẩy tới ngay), không
// phải qua Telegram — tránh trường hợp khách không vào nhóm Telegram.
function customerNotice_(command, value) {
  if (!value || !value.keyName) return '';
  const key = plain(value.keyName);
  const expiry = value.expiryAt ? adminDateVN_(value.expiryAt) : '';
  // Số máy được phép dùng key này. maxDevices = 0 nghĩa là CRM không báo (key cũ).
  const max = Number(value.entitlement?.devices||value.maxDevices) || 0;
  const slots = max > 0 ? '💻 Số máy tối đa: ' + max + (max > 1 ? ' máy' : ' máy') + ' (đã dùng ' + (Number(value.usedSlots) || 0) + ')' : '';
  if (/^\/(new|newplan|approve)\b/i.test(command)) {
    const lines = [
      '🎉 Chào mừng bạn! License Key của bạn đã được cấp:',
      '',
      '🔑 Mã key: ' + key,
    ];
    if (expiry) lines.push('⏳ Hạn dùng đến: ' + expiry);
    if (slots) lines.push(slots);
    lines.push('', 'Cách dùng: mở app → Cài đặt → Bản quyền & Đăng ký → dán mã key → Kích hoạt.');
    lines.push('Giữ mã này, không chia sẻ cho máy khác.');
    return lines.join('\n');
  }
  if (/^\/(extend|setplan)\b/i.test(command)) {
    const lines = [command==='/setplan'?'✅ Gói bản quyền của bạn đã được cập nhật.':'✅ Bản quyền của bạn đã được gia hạn.'];
    if (expiry) lines.push('⏳ Hạn mới: ' + expiry);
    if (slots) lines.push(slots);
    lines.push('Bạn không cần làm gì thêm. Mở lại app là dùng được ngay.');
    return lines.join('\n');
  }
  return '';
}

// Ngày kiểu Việt Nam, ngắn gọn cho tin nhắn khách.
function adminDateVN_(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || isNaN(d.getTime())) return '';
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

// BÁO CÁO ONLINE — gọi từ lệnh /online trong Telegram.
//
// "Online" = máy có gửi tín hiệu trong 15 phút. App gửi lúc mở và mỗi ~4h khi
// chạy nền, nên đây là con số gần đúng nhất mà không cần app polling liên tục.
// Cửa sổ 15 phút nằm trong hằng ONLINE_WINDOW_MS của Code.gs — hai bên cùng
// một quy ước, đổi thì sửa cả hai.

async function onlineReport_(env) {
  const now = Date.now();
  let list;
  try {
    list = await gas(env, { action: 'list_devices', now });
  } catch (error) {
    return '⚠️ Đọc danh sách thiết bị lỗi: ' + (error && error.message ? error.message : String(error));
  }
  const devices = (list && list.devices) || [];
  if (!devices.length) return '📭 Chưa có thiết bị nào đăng ký.';

  // Sắp xếp: đang online trước, rồi tới máy vừa hoạt động gần nhất.
  // Dùng CHUNG isOnlineAt với chấm trạng thái trên tên topic và với /who — cùng một
  // quy ước, không được mỗi chỗ tự tính riêng (lệch nhau là admin thấy mâu thuẫn).
  const rows = devices.map(d => ({ ...d, online: isOnlineAt(d.lastSeen, now) })).sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return Number(b.lastSeen) - Number(a.lastSeen);
  });

  const online = rows.filter(r => r.online);
  const offline = rows.filter(r => !r.online);
  const stamp = ts => {
    const t = Number(ts);
    if (!t) return 'chưa từng mở app';
    const mins = Math.floor((now - t) / 60000);
    if (mins < 1) return 'vừa xong';
    if (mins < 60) return mins + ' phút trước';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' giờ trước';
    return Math.floor(hours / 24) + ' ngày trước';
  };
  const line = r => {
    const who = [r.name, r.phone].filter(Boolean).join(' · ') || r.machineId || r.hardwareId || r.chatRoomId;
    const key = r.keyName ? ' · ' + r.keyName : '';
    const mark = r.online ? '🟢' : '⚪️';
    return mark + ' ' + who + ' — ' + r.status + (r.expiryAt ? ' (hạn ' + adminDateVN_(r.expiryAt) + ')' : '') + key + ' · ' + stamp(r.lastSeen);
  };

  const out = ['📊 ' + online.length + ' online / ' + rows.length + ' thiết bị'];
  if (online.length) out.push('', '🟢 ĐANG CHẠY', ...online.map(line));
  if (offline.length) out.push('', '⚪️ ĐÃ TẮT', ...offline.map(line));
  out.push('', 'Nút bấm trong app để khách tự xem: mở Hỗ trợ → nút /check.');
  return out.join('\n');
}

// KHÁCH TỰ /CHECK — bấm nút trong app, nhận ngay thông tin của máy mình.
// Gọi thẳng action admin_command của CRM (không vòng qua Telegram) nên nhanh,
// và không tốn lượt gọi webhook. Kết quả đẩy vào phòng chat để hiện trong app,
// đồng thời gửi bản rút gọn vào topic Telegram để admin có dấu vết.
// Chỉ cho phép lệnh ĐỌC (/check, /info) — lệnh đổi trạng thái phải để admin gõ
// trên Telegram, không để app tự kích hoạt trên máy khách.
const CUSTOMER_COMMANDS = ['/check', '/info'];

async function customerCommand_(env, request, input) {
  const d = device(input);
  // Không truyền lệnh thì mặc định /check — app có thể bỏ trống, không nên vì
  // thế mà báo lỗi.
  const command = String(input.command || '/check').trim().toLowerCase();
  if (!CUSTOMER_COMMANDS.includes(command)) {
    throw Error('Bạn chỉ có thể tự xem thông tin bằng /check trong app.');
  }
  // BẮT BUỘC khớp phiên. admin_command tra dòng theo chatRoomId, nên thiếu bước
  // này thì chỉ cần biết ROOM_WIN_... của máy khác là đọc được thông tin bản
  // quyền của người khác. Token do Gateway tự ký, app không tự làm được.
  const token = await claims(env, request);
  if (token.installationId !== d.installationId || token.chatRoomId !== d.chatRoomId) {
    throw Error('Support session does not match this device.');
  }
  const value = await gas(env, { action: 'admin_command', chatRoomId: d.chatRoomId, command, text: command });
  const detail = String(value?.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
  await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages', 'POST', {
    sender: 'admin',
    text: detail,
    timestamp: Date.now(),
    source: 'customer-check',
    deliveryStatus: 'firebase',
  });
  // Đồng bộ lên topic để admin thấy khách vừa tự kiểm tra.
  try {
    const thread = await topic(env, d.chatRoomId);
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: thread, text: '🔎 Khách tự kiểm tra:\n' + detail });
  } catch (error) {
    console.log('Không gửi được /check lên Telegram: ' + (error && error.message ? error.message : String(error)));
  }
  return reply({ ok: true, value: { detail } });
}

// BÁO CÁO THEO SỐ ĐIỆN THOẠI — gọi từ lệnh /check_SDT.
// Trả về mọi máy đăng ký với số đó và mọi key đã cấp cho các máy ấy. Một khách
// có thể đang giữ nhiều key cùng lúc (cấp bằng /new nhiều lần), nên liệt kê hết
// chứ không chỉ key đang dùng.
async function phoneReport_(env, phone) {
  let data;
  try {
    data = await gas(env, { action: 'find_by_phone', phone: String(phone || '') });
  } catch (error) {
    return '⚠️ Tra cứu lỗi: ' + (error && error.message ? error.message : String(error));
  }
  if (!data || !data.found) {
    return '🔍 Không tìm thấy ai dùng số ' + plain(String(phone || '')) + '.\n'
      + 'Gõ đúng số đã nhập trong app (SĐT ở Cài đặt → Bản quyền & Đăng ký).';
  }
  const now = Number(data.now) || Date.now();
  const devices = data.devices || [];
  const licenses = data.licenses || [];
  const stamp = ts => {
    const t = Number(ts);
    if (!t) return 'chưa từng mở app';
    const mins = Math.floor((now - t) / 60000);
    if (mins < 1) return 'vừa xong';
    if (mins < 60) return mins + ' phút trước';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' giờ trước';
    return Math.floor(hours / 24) + ' ngày trước';
  };

  const out = ['🔎 KẾT QUẢ: ' + plain(data.query || phone)];
  if (devices.length) {
    out.push('', '📱 MÁY ĐÃ ĐĂNG KÝ (' + devices.length + ')');
    for (const d of devices) {
      const who = [d.name, d.phone].filter(Boolean).join(' · ') || '(chưa nhập tên)';
      out.push('  ' + (d.online ? '🟢' : '⚪️') + ' ' + who);
      out.push('     Máy: ' + plain(d.machineId || d.hardwareId || '—') + ' · Phòng: ' + plain(d.chatRoomId || '—'));
      out.push('     Gói: ' + (d.plan || '—') + ' · Đang dùng key: ' + plain(d.keyName || 'chưa có')
        + ' · Hoạt động: ' + stamp(d.lastSeen));
    }
  }
  if (licenses.length) {
    out.push('', '🔑 KEY ĐÃ CẤP (' + licenses.length + ')');
    for (const l of licenses) {
      const mark = l.status === 'Expired' ? '🔴' : (l.status === 'Active' ? '🟢' : '⚪️');
      const expiry = l.expiryAt ? adminDateVN_(l.expiryAt) : 'không có hạn';
      out.push('  ' + mark + ' ' + plain(l.keyName) + ' · ' + l.status + ' · hạn ' + expiry);
      // Bindings chỉ lưu mã máy cũ (UUID) + phòng chat, không có DEV_...,
      // nên hiện phòng chat — thứ admin nhận ra ngay khi mở topic.
      const bound = (l.boundDevices || []).map(b => plain(b.chatRoomId || b.hardwareId || '')).filter(Boolean);
      out.push('     Máy: ' + l.usedSlots + '/' + l.maxDevices + (bound.length ? ' → ' + bound.join(', ') : ' (chưa gán máy nào)'));
      if (l.activatedAt) out.push('     Cấp lúc: ' + adminDateVN_(l.activatedAt));
    }
  }
  if (!licenses.length && devices.length) {
    out.push('', '🔑 Chưa cấp key nào cho số này (đang dùng thử).');
  }
  return out.join('\n');
}

export default {
  async scheduled(event,env,ctx) {
    ctx.waitUntil(aiAdmin.scheduled(env,ctx,'https://hoadon-support-gateway.linhnhaxac10.workers.dev'));
    ctx.waitUntil(billingMaintenance_(env).catch(error=>console.log('Billing maintenance failed: '+error.message)));
  },
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if(request.method==='GET'&&/^\/v1\/ai\/jobs\/[a-f0-9]{16}$/.test(url.pathname)) {
        const value=await claims(env,request);if(/expired|locked/i.test(String(value.license||'')))throw Error('Bản quyền không cho phép dùng AI.');
        const job=await aiAdmin.publicJob(env,url.pathname.split('/').at(-1));return job?reply({ok:true,value:job}):reply({ok:false,error:'Không có tác vụ.'},404);
      }
      if (request.method === 'GET' && url.pathname === '/v1/ai/config') {
        const value = await claims(env, request);
        if (/expired|locked/i.test(String(value.license || ''))) throw Error('Bản quyền không cho phép dùng AI.');
        return reply({ok:true,value:await aiAdmin.publicActive(env)});
      }
      if (request.method === 'GET' && url.pathname === '/healthz') return reply({ ok: true });
      if (env.AI_ADMIN_V2_ENABLED === '1' && request.method === 'POST' && url.pathname === '/internal/ai/check') return await aiAdmin.internal(env, request, ctx);
      // PHẢI `await` khi trả về promise bên trong `try`.
      // `try { return p } catch {}` KHÔNG bắt được lỗi của p: hàm async thoát ra
      // ngay, lỗi nổi lên thành unhandled rejection và Cloudflare trả 500 dạng
      // HTML — còn app chỉ biết JSON.parse thất bại và báo câu chữ vô nghĩa.
      if (request.method === 'POST' && url.pathname === '/v1/ai/chat/completions') return await aiProxy_(env, request,ctx);

      if (request.method === 'GET' && url.pathname === '/v1/chats/stream') return await chatStream(env, request, url);
      if (request.method === 'POST' && url.pathname === '/v1/telegram/webhook') return await webhook(env, request, ctx);

      // Trang landing nằm ở domain khác (github.io) nên phải trả CORS cho nó.
      // Route này nằm TRƯỚC nhánh 404 và trước khi parse body chung, vì nó không
      // cần device/session như các route kia.
      if (url.pathname === '/v1/landing/download') {
        if (request.method === 'OPTIONS') return cors();
        if (request.method !== 'POST') return reply({ ok: false, error: 'Not found.' }, 404);
        return await landingDownload(env, request);
      }

      // Đồng bộ lúc mở app và hỏi nhẹ cho app chạy nền. Khớp ĐÚNG ĐƯỜNG DẪN
      // (không so chuỗi chứa) để không lẫn với các route phía dưới.
      if(url.pathname === '/v1/billing' && request.method === 'POST') {
        if(limited(request,'billing',60))return reply({ok:false,error:'Too many requests.'},429);
        const input=await request.json(), d=device(input), token=await claims(env,request);
        if(token.installationId!==d.installationId||token.chatRoomId!==d.chatRoomId) throw Error('Support session does not match this device.');
        const permitted=['config','quote','order','orders','cancel','usage','mst_use','mst_select','quota_reserve','quota_commit','quota_release'];
        if(!permitted.includes(input.action)) throw Error('Unknown billing action.');
        let value;
        if(input.action==='config')value=await firebase(env,'/billing/config');
        if(!value){value=await gas(env,{...input,...d,action:'billing',billingAction:input.action});if(input.action==='config')await firebase(env,'/billing/config','PUT',value);}
        if(input.action==='order') {
          const thread=await topic(env,d.chatRoomId);
          await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:thread,text:'Yêu cầu mua gói '+value.id+'\n'+value.quote.planId+' · '+value.quote.devices+' máy · '+value.quote.term+'\nTổng: '+value.quote.total+'đ\nChọn bên dưới để xem và xác nhận sau khi nhận tiền.',reply_markup:{inline_keyboard:[[{text:'🧾 Xem / duyệt yêu cầu mua',callback_data:'billing:admin:orders'}]]}}).catch(()=>{});
        }
        return reply({ok:true,value});
      }
      if (url.pathname === '/v1/sync' || url.pathname === '/v1/ping' || url.pathname === '/v1/chats/check') {
        if (request.method !== 'POST') return reply({ ok: false, error: 'Not found.' }, 404);
        if (limited(request, url.pathname, 30)) return reply({ ok: false, error: 'Too many requests.' }, 429);
        const body = await request.json();
        if (url.pathname === '/v1/sync') return await sync_(env, request, body);
        if (url.pathname === '/v1/ping') return await ping_(env, request, body);
        return await customerCommand_(env, request, body);
      }

      if (request.method !== 'POST') return reply({ ok: false, error: 'Not found.' }, 404);

      const input = await request.json();      const path = url.pathname;
      const action = path.includes('notices') ? 'notice' : path.includes('activate') ? 'activate' : path.includes('messages') || path==='/v1/chats/ai-reply' ? 'message' : path==='/v1/chats/control'||path.includes('chats/status') ? 'chat' : path.includes('status') ? 'status' : path.includes('register') ? 'register' : '';
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
          // KHÔNG tự bịa trạng thái bản quyền khi CRM lỗi.
          // Trước đây chỗ này trả về {status:'Unactivated', expiryAt:''} — app ghi đè
          // thẳng vào đĩa, khách đang mua 1 năm biến thành "hết hạn" vĩnh viễn và
          // phải tự nhập lại key. Ném lỗi để app rơi vào CỬA SỔ OFFLINE GRACE giống
          // hệt đường /v1/licenses/status, tức là giữ nguyên thông tin đã lưu.
          // Lỗi vẫn hiện trong `wrangler tail` chứ không bị nuốt.
          const value = await gas(env, { action: 'register_device', ...d, ...info });
          try { await announce(env, d, info, value); }
          catch (error) { console.log('Telegram topic pending: ' + error.message); }
          await cacheLicense_(env, d.chatRoomId, value);
          await presence_(env, d.chatRoomId, input);
          return reply({ ok: true, value: await sessionValue(env, d, value) });
        }
        const value = await gas(env, { action: 'license_status', ...d });
        await cacheLicense_(env, d.chatRoomId, value);
        return reply({ ok: true, value: await sessionValue(env, d, value) });
      }
      if (action === 'activate') {
        const key = String(input.key || input.licenseKey || '').trim();
        if (key.length < 6 || key.length > 160) throw Error('Invalid license key.');
        await supportFlow.begin(env,d.chatRoomId,'Yêu cầu kích hoạt bản quyền từ EXE · key '+key.slice(0,4)+'…'+key.slice(-4),{wantsAdmin:true});

        // Lưới an toàn: máy có thể chưa có dòng trong Sheet (lần đầu mở app bị
        // mất mạng, hoặc dữ liệu cục bộ bị xoá). Gặp lỗi này thì đăng ký luôn
        // rồi thử lại, thay vì bắt khách phải tắt app rồi mở lại.
        let value;
        try {
          value = await gas(env, { action: 'verify_key', ...d, key, licenseKey: key });
        } catch (error) {
          if (!/Device must be registered/i.test(error && error.message ? error.message : String(error))) throw error;
          console.log('verify_key: máy chưa có trong Sheet, đăng ký rồi thử lại.');
          const info = contact(input);
          await gas(env, { action: 'register_device', ...d, ...info });
          value = await gas(env, { action: 'verify_key', ...d, key, licenseKey: key });
        }
        await cacheLicense_(env, d.chatRoomId, value);

        return reply({ ok: true, value: { ...value, sessionToken: await session(env, { ...d, license: value.status }) } });
      }

      const token = await claims(env, request);
      if (token.installationId !== d.installationId || token.chatRoomId !== d.chatRoomId) throw Error('Support session does not match this device.');
      if(path==='/v1/chats/control')return reply({ok:true,value:await supportFlow.state(env,d.chatRoomId)});
      if (action === 'chat') {
        const raw = await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages');
        return reply({ ok: true, value: { control:await supportFlow.state(env,d.chatRoomId),messages: Object.entries(raw || {}).map(([id, value]) => ({ id, ...value })).sort((a, b) => a.timestamp - b.timestamp).slice(-100) } });
      }
      if(path==='/v1/chats/ai-reply')return reply({ok:true,value:await supportFlow.complete(env,d.chatRoomId,String(input.turnId||''),Number(input.revision),input.text)});
      if(input.unified===true)return reply({ok:true,value:await supportFlow.begin(env,d.chatRoomId,String(input.text||'').trim().slice(0,16000),{companyId:String(input.companyId||'GLOBAL').slice(0,20),attachments:Array.isArray(input.attachments)?input.attachments.map(x=>String(x).slice(0,160)).slice(0,4):[],wantsAdmin:input.wantsAdmin===true})});

      const message = { sender: 'user', text: String(input.text || '').trim().slice(0, 2000), timestamp: Date.now(), source: 'desktop', deliveryStatus: 'pending_telegram' };
      if (!message.text) throw Error('Invalid message.');
      // Khách đang nhắn tin ⇒ app CHẮC CHẮN đang mở. Không ghi nhịp sống ở đây thì
      // khách chat suốt mà admin vẫn thấy "offline" — đúng lỗi người dùng báo.
      const previous = (await firebase(env, '/devices/' + encodeURIComponent(d.chatRoomId) + '/presence')) || {};
      const wasOnline = isOnlineAt(previous.lastSeen);
      await presence_(env, d.chatRoomId, input, wasOnline);
      if (!wasOnline) await refreshTopicStatus_(env, d.chatRoomId);
      const result = await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages', 'POST', message);
      try {
        const sent = await sendToRoom(env, d.chatRoomId, message.text);
        await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages/' + result.name, 'PATCH', { deliveryStatus: 'delivered', telegramMessageId: sent.message_id, telegramThreadId: sent.message_thread_id || 0 });
      } catch (error) { console.log('Telegram delivery pending: ' + error.message); }
      return reply({ ok: true, value: { id: result.name, ...message } });
    } catch (error) {
      return reply({ ok: false, error: error.message || 'Request failed.' }, 400);
    }
  }
};

function billingMenu_(){return adminMenuMarkup_('root');}
async function billingRegisterCommands_(env) {
 const scopes=[{type:'default'},{type:'all_group_chats'},{type:'chat_administrators',chat_id:env.TELEGRAM_CHAT_ID}];
 const added=adminMenuCommands_().map(x=>[x.command,x.description]);
 for(const scope of scopes)for(const language_code of ['', 'vi']) {
  const inherited=await telegram(env,'getMyCommands',{scope:{type:'default'},language_code});
  const current=await telegram(env,'getMyCommands',{scope,language_code});
  const obsolete=new Set(['info','usage','new','newplan','setplan','plans','orders','approve','reject','commerce','mst','replace_mst','reset_mst_changes','release','extend','reset','lock','unlock','link','ai_add','ai_use','ai_del','ai_url','ai_model','ai_key']);
  const commands=new Map([...inherited,...current].filter(x=>!obsolete.has(x.command)).map(x=>[x.command,x]));
  for(const [command,description] of added)commands.set(command,{command,description});
  if(commands.size>100)throw Error('Danh sách lệnh vượt giới hạn Telegram.');
  await telegram(env,'setMyCommands',{scope,language_code,commands:[...commands.values()]});
  const verified=await telegram(env,'getMyCommands',{scope,language_code});
  if(!added.every(([name])=>verified.some(x=>x.command===name))||verified.some(x=>obsolete.has(x.command)))throw Error('Telegram chưa xác nhận menu gọn.');
 }
}
async function billingMaintenance_(env) {
 const path='/adminMaintenance/billing20261010v3';
 if((await firebase(env,path))?.complete)return;
 const setup=await gas(env,{action:'billing_setup',expectedSheetId:'1AAgGBqZG4SVbTmgd9zvNpfjDwS07lSVxwyw_IIYoJVQ'});
 if(setup.commercial!==false)throw Error('Chế độ thương mại chưa ẩn.');
 await billingRegisterCommands_(env);
 await firebase(env,path,'PUT',{complete:true,at:Date.now(),revision:setup.revision,tables:setup.tables});
 console.log('Billing maintenance verified: commercial=false; Telegram commands registered; usage tables ready.');
}
// Each step carries only validated choices. No customer data is placed in callback_data.
function billingWizard_(data) {
 const p=String(data).split(':'),op=p[2],plan=p[3],days=p[4],devices=p[5];
 const plans=['MST10','MST20','MST30','MST50'],terms=['30','90','365'],machines=['1','2','3','5','10'];
 if(!['newplan','setplan'].includes(op))throw Error('Thao tác không hợp lệ.');
 const title=op==='newplan'?'Tạo key mới':'Đổi gói key hiện tại';
 const button=(text,suffix)=>({text,callback_data:'billing:wizard:'+op+suffix});
 const back=[{text:'Về menu',callback_data:'billing:menu'}];
 if(!plan)return {text:title+' — chọn số MST tối đa:',markup:{inline_keyboard:[plans.map(x=>button(x.slice(3)+' MST',':'+x)),back]}};
 if(!plans.includes(plan))throw Error('Gói không hợp lệ.');
 if(!days)return {text:title+' · '+plan+' — chọn thời hạn tính theo ngày:',markup:{inline_keyboard:[terms.map(x=>button(x+' ngày',':'+plan+':'+x)),[{text:'Nhập số ngày khác',callback_data:'billing:admin:custom:'+op+':'+plan}],back]}};
 if(!/^\d+$/.test(days)||Number(days)<1||Number(days)>3650)throw Error('Thời hạn không hợp lệ.');
 if(!devices)return {text:title+' · '+plan+' · '+days+' ngày — chọn số thiết bị:',markup:{inline_keyboard:[machines.map(x=>button(x+' máy',':'+plan+':'+days+':'+x)),[{text:'Nhập số máy khác',callback_data:'billing:admin:custom:'+op+':'+plan+':'+days}],back]}};
 if(!/^\d+$/.test(devices)||Number(devices)<1||Number(devices)>100)throw Error('Số máy không hợp lệ.');
 const command='/'+op+' '+plan+' '+days+' '+devices;
 if(p[6]==='confirm'&&p.length===7)return {command};
 if(p.length!==6)throw Error('Nút không hợp lệ.');
 return {text:title+'\nGói: '+plan+'\nThời hạn: '+days+' ngày từ hiện tại\nThiết bị: '+devices+'\n'+(op==='setplan'?'Thay quyền và ngày hết hạn của key hiện tại.':'Cấp thủ công; không xác nhận thanh toán tự động.')+'\nKiểm tra đúng Topic khách trước khi xác nhận.',markup:{inline_keyboard:[[button('Xác nhận',':'+plan+':'+days+':'+devices+':confirm')],back]}};
}
async function billingRefresh_(env,value,command){
 if(value.billing)await firebase(env,'/billing/config','PUT',{config:value.billing,release:value.release||null});
 for(const room of value.affectedRooms||[])await firebase(env,licensePath(room),'PUT',null);
}
async function billingCallback_(env,query){
 if(String(query.message?.chat?.id)!==String(env.TELEGRAM_CHAT_ID))throw Error('Invalid admin group.');
 const member=await telegram(env,'getChatMember',{chat_id:env.TELEGRAM_CHAT_ID,user_id:query.from?.id});
 if(!['creator','administrator'].includes(member?.status))throw Error('Admin only.');
 const thread=query.message?.message_thread_id,map=await firebase(env,'/telegramTopics/'+thread);
 if(String(query.data).startsWith('billing:admin:'))return adminMenuCallback_(env,query,map);
 if(!map?.chatRoomId)throw Error('Topic chưa gắn thiết bị.');
 const parts=String(query.data).split(':'),name=parts[1];
 let text,value,markup=billingMenu_(),command;
 if(name==='menu')text='Quản lý key trong Topic này.';
 else if(name==='wizard') {
   const step=billingWizard_(query.data);text=step.text;markup=step.markup||markup;command=step.command;
   if(command)return adminMenuReview_(env,query,map,command);
 }
 else if(name==='commerce'&&parts[3]!=='confirm') {
   if(!['on','off'].includes(parts[2]))throw Error('Thao tác không hợp lệ.');
   text=parts[2]==='on'?'Công khai chính sách key cho TOÀN BỘ người dùng? Bắt đầu khoảng sử dụng đầu 30 ngày theo cấu hình.':'Mở miễn phí TOÀN BỘ tính năng cho mọi người dùng? Khóa thiết bị của Admin vẫn giữ hiệu lực.';
   markup={inline_keyboard:[[{text:'Xác nhận',callback_data:'billing:commerce:'+parts[2]+':confirm'}],[{text:'Hủy / về menu',callback_data:'billing:menu'}]]};
 }
 else if(name==='help')text='/newplan MST10 30 1 — cấp gói 10 MST, 30 ngày, 1 máy\n/extend 30 — gia hạn thêm 30 ngày\n/setplan MST20 30 2 — đổi gói và đặt hạn 30 ngày từ hiện tại\n/replace_mst MST_cũ MST_mới\n/reset_mst_changes — đặt lại số lần đổi miễn phí\n/lock | /unlock — khóa / mở khóa\n/reset — gỡ liên kết máy\n/commerce on | off — công khai / miễn phí toàn hệ thống\n/orders — xem đơn; /approve MÃ paid — xác nhận đã nhận tiền; /reject MÃ — từ chối';
 else if(name==='release'&&parts[2]==='help')text='/release 1.2.3 Nội dung thay đổi — lưu bản nháp\n/release publish — công bố\n/release off — thu hồi';
 else if(!text&&!command) {
   const commands={plans:'/plans',orders:'/orders',check:'/check',mst:'/mst',usage:'/checkdulieu'};
   command=name==='commerce'?'/commerce '+parts[2]:name==='release'?'/release '+parts[2]:name==='approve'?'/approve '+parts[2]+' paid':commands[name];
 }
 if(command) {
   if(!['/check','/checkdulieu','/plans','/mst','/orders'].includes(command))return adminMenuReview_(env,query,map,command);
   value=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:command,actor:String(query.from.id),requestId:'TG-'+thread+'-'+query.message.message_id+'-'+String(query.data)});
   await cacheLicense_(env,map.chatRoomId,value);await billingRefresh_(env,value,command);text=value.reply;
 }
 await telegram(env,'answerCallbackQuery',{callback_query_id:query.id,text:'Đã xử lý'});
 await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:thread,text:String(text||'Không có dữ liệu').slice(0,4000),reply_markup:markup});
}

function adminMenuCommands_(){return [
 {command:'menu',description:'Quản lý khách trong Topic bằng nút bấm'},
 {command:'check',description:'Thông tin bản quyền của khách'},
 {command:'checkdulieu',description:'MST và thống kê sử dụng tháng / tổng'},
 {command:'billing',description:'Mở menu quản lý khách (tương đương /menu)'},
 {command:'online',description:'Danh sách thiết bị và tín hiệu gần nhất'},
 {command:'who',description:'Tín hiệu gần nhất của khách trong Topic'},
 {command:'check_sdt',description:'Tìm khách: /check_sdt 0987654321'},
 {command:'ai',description:'Quản lý AI bằng nút bấm'},
 {command:'stop',description:'Kết thúc hỗ trợ Admin, chuyển lại AI'},
 {command:'cancel',description:'Hủy bước nhập đang chờ'}
];}
function adminMenuMarkup_(page){
 const b=(text,action)=>({text,callback_data:'billing:admin:'+action});
 const back=[b('⬅ Menu khách','page:root')];
 const pages={
 root:[[b('👤 Thông tin / bản quyền','read:check'),b('📊 Dữ liệu sử dụng','read:usage')],
 [b('🔑 Key / gói / gia hạn','page:key'),b('🖥 Thiết bị / MST','page:device')],
 [b('🧾 Yêu cầu mua','orders'),b('💬 Hỗ trợ khách','page:support')],
 [b('🌐 Quản trị toàn hệ thống','page:system'),b('🔄 Làm mới','page:root')]],
 key:[[{text:'➕ Tạo key theo gói',callback_data:'billing:wizard:newplan'},{text:'✏ Đổi gói / số máy',callback_data:'billing:wizard:setplan'}],
 [b('⏳ Gia hạn thêm ngày','prompt:extend'),b('📦 Xem gói / giá','read:plans')],back],
 device:[[b('🗂 MST đăng ký theo key','read:mst'),b('🕒 Tín hiệu thiết bị','presence')],
 [b('🔒 Khóa thiết bị','prepare:lock'),b('🔓 Mở khóa','prepare:unlock')],
 [b('🔄 Gỡ liên kết key / máy','prepare:reset')],
 [b('✏ Thay MST đăng ký','prompt:replace_mst'),b('Đặt lại số lần đổi MST','prepare:reset_mst_changes')],back],
 support:[[b('👨‍💼 Nhận hỗ trợ trực tiếp','prepare:takeover'),b('🤖 Kết thúc / về AI','prepare:stop')],back],
 system:[[b('📡 Thiết bị online','online'),b('🔎 Tìm theo SĐT','prompt:phone')],
 [b('🤖 Cấu hình AI','ai')],
 [b('📢 Công khai thương mại','prepare:commerce_on'),b('🆓 Mở miễn phí','prepare:commerce_off')],
 [b('✍ Soạn nội dung cập nhật','prompt:release'),b('👁 Xem bản nháp','read:release')],
 [b('📤 Công bố bản nháp','prepare:release_publish')],
 [b('Thu hồi thông báo cập nhật','prepare:release_off')],back],
 unlinked:[[b('🔗 Gắn Topic với khách','prompt:link'),b('🔎 Tìm theo SĐT','prompt:phone')],[b('📡 Thiết bị online','online')]]
 };
 if(!pages[page])throw Error('Trang menu không hợp lệ.');
 return {inline_keyboard:pages[page]};
}
function adminMenuPath_(user,thread){return '/adminMenuSessions/'+user+'/'+thread;}
async function adminMenuSend_(env,thread,text,markup,messageId){
 const body={chat_id:env.TELEGRAM_CHAT_ID,text:String(text).slice(0,4000),reply_markup:markup||billingMenu_()};
 if(messageId)try{return await telegram(env,'editMessageText',{...body,message_id:messageId});}catch(e){if(/message is not modified/i.test(String(e.message)))return;}
 return telegram(env,'sendMessage',{...body,message_thread_id:thread});
}
async function adminMenuSave_(env,from,thread,room,value){
 const state={...value,room:room||'',actor:String(from),thread:Number(thread),token:crypto.randomUUID().replace(/-/g,'').slice(0,20),expires:Date.now()+10*60000};
 await firebase(env,adminMenuPath_(from,thread),'PUT',state);return state;
}
async function adminMenuState_(env,query,map,token){
 const thread=query.message.message_thread_id,s=await firebase(env,adminMenuPath_(query.from.id,thread));
 if(!s||s.actor!==String(query.from.id)||s.thread!==Number(thread)||s.room!==String(map?.chatRoomId||'')||s.expires<Date.now()||(token&&token!==s.token))throw Error('Thao tác đã hết hạn hoặc khách đã thay đổi. Mở lại /menu.');
 return s;
}
async function adminMenuReview_(env,query,map,command,detail){
 if(!map?.chatRoomId&&command.indexOf('/link ')!==0)throw Error('Topic chưa gắn khách. Mở /menu để liên kết.');
 let info=null;
 if(map?.chatRoomId)info=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:'/check'});
 if(info?.found===false)throw Error('Không tìm thấy khách. Kiểm tra liên kết Topic.');
 const descriptions={
 '/lock':'Khóa thiết bị này.','/unlock':'Mở khóa thiết bị này.','/reset':'Gỡ liên kết thiết bị khỏi key; giữ định danh phần cứng và dữ liệu.',
 '/reset_mst_changes':'Đặt lại số lần đổi MST miễn phí.',
 '/commerce on':'⚠️ CÔNG KHAI THƯƠNG MẠI cho TOÀN BỘ người dùng.',
 '/commerce off':'⚠️ MỞ MIỄN PHÍ cho TOÀN BỘ người dùng; vẫn giữ khóa thiết bị của Admin.',
 '/release publish':'⚠️ Công bố bản nháp cập nhật cho TOÀN BỘ người dùng. EXE phải được phát hành trên GitHub trước.',
 '/release off':'⚠️ Thu hồi thông báo cập nhật toàn hệ thống.',
 '/takeover':'Nhận hỗ trợ trực tiếp; AI tạm dừng trong phòng này.','/stop':'Kết thúc hỗ trợ trực tiếp; chuyển lại AI.'
 };
 let draft=null;
 if(command==='/release publish'){
   const preview=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:'/release_preview'});draft=preview.menuRelease;
   if(!draft)throw Error('Chưa có bản nháp cập nhật. Hãy soạn trước.');
 }
 const state=await adminMenuSave_(env,query.from.id,query.message.message_thread_id,map?.chatRoomId,{kind:'review',command,expectedKey:info?.keyName||'',...(draft?{expectedDraftAt:draft.at}:{})});
 const effect=command.startsWith('/setplan ')?'Đặt lại gói, số thiết bị và hạn từ hôm nay; không cộng thêm hạn cũ.':command.startsWith('/newplan ')?'Tạo key mới theo gói; không đánh dấu đã thanh toán.':command.startsWith('/approve ')?'Xác nhận đã nhận đủ tiền; duyệt yêu cầu mua.':command.startsWith('/reject ')?'Từ chối yêu cầu mua.':descriptions[command]||'Áp dụng thông tin đã nhập.';
 const args=command.split(/\s+/);let summary='';
 if(['/newplan','/setplan'].includes(args[0]))summary='Gói: '+args[1]+' · '+args[2]+' ngày · '+args[3]+' thiết bị';
 else if(args[0]==='/extend')summary='Cộng thêm '+args[1]+' ngày vào hạn còn hiệu lực; nếu hết hạn thì tính từ hôm nay.';
 else if(args[0]==='/replace_mst')summary='MST cũ: '+args[1]+'\nMST mới: '+args[2];
 else if(args[0]==='/link')summary='Phòng khách: '+args[1];
 else if(args[0]==='/release'&&/^\d/.test(args[1]||''))summary='Bản nháp v'+args[1]+'\n'+args.slice(2).join(' ');
 await adminMenuSend_(env,query.message.message_thread_id,'KIỂM TRA TRƯỚC KHI XÁC NHẬN\n'+(info?.reply||'Topic chưa gắn khách')+'\n\n'+effect+'\n'+summary+(detail?'\n'+detail:'')+(draft?'\n\nv'+draft.version+'\n'+String(draft.notes).slice(0,2400):'')+'\n\nXác nhận có hiệu lực trong 10 phút.',{inline_keyboard:[[{text:'✅ Xác nhận',callback_data:'billing:admin:confirm:'+state.token}],[{text:'Hủy / về menu',callback_data:'billing:admin:cancel:'+state.token}]]});
}
async function adminMenuPrompt_(env,query,map,op,prefix){
 const questions={extend:'Nhập số ngày muốn cộng thêm (1–3650).',replace_mst:'Nhập MST cũ và MST mới, ngăn cách bằng khoảng trắng.',phone:'Nhập số điện thoại của khách cần tìm.',link:'Nhập mã phòng ROOM_WIN_… của khách. Bot sẽ kiểm tra phòng trước khi gắn.',release:'Nhập phiên bản ở dòng đầu (ví dụ 1.1.8), nội dung cập nhật ở những dòng tiếp theo.',custom:prefix?.split(':').length===3?'Nhập số máy (1–100).':'Nhập số ngày (1–3650).'};
 if(!questions[op])throw Error('Bước nhập không hợp lệ.');
 if(!map?.chatRoomId&&!['link','phone'].includes(op))throw Error('Topic chưa gắn khách.');
 const label=String(query.from.first_name||'Admin');
 const sent=await telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:query.message.message_thread_id,text:label+': '+questions[op]+'\nTrả lời đúng tin này. /cancel để hủy.',entities:[{type:'text_mention',offset:0,length:label.length,user:{...query.from,first_name:label,is_bot:false}}],reply_markup:{force_reply:true,selective:true,input_field_placeholder:'Nhập giá trị'}});
 await adminMenuSave_(env,query.from.id,query.message.message_thread_id,map?.chatRoomId,{kind:'prompt',op,prefix:prefix||'',messageId:sent.message_id});
}
async function adminMenuMessage_(env,message,map){
 const text=String(message.text||'').trim(),thread=message.message_thread_id;
 if(/^\/check_sdt(?:@\w+)?$/i.test(text)){
   await adminMenuPrompt_(env,{from:message.from,message},map,'phone');return true;
 }
 if(/^\/(menu|start|help)(?:@\w+)?(?:\s|$)/i.test(text)){
   await telegram(env,'sendChatAction',{chat_id:env.TELEGRAM_CHAT_ID,message_thread_id:thread,action:'typing'}).catch(()=>{});
   await firebase(env,adminMenuPath_(message.from.id,thread),'DELETE');
   let title='QUẢN LÝ KHÁCH TRONG TOPIC';
   if(map?.chatRoomId){const info=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:'/check'});title+='\n\n'+info.reply;}
   else title+='\nChưa gắn thiết bị. Hãy liên kết đúng khách trước khi quản lý.';
   await adminMenuSend_(env,thread,title,adminMenuMarkup_(map?.chatRoomId?'root':'unlinked'));return true;
 }
 const path=adminMenuPath_(message.from.id,thread),state=await firebase(env,path);
 if(/^\/cancel(?:@\w+)?$/i.test(text)){
   await firebase(env,path,'DELETE');await adminMenuSend_(env,thread,'Đã hủy bước nhập.',adminMenuMarkup_(map?.chatRoomId?'root':'unlinked'));return true;
 }
 if(state?.kind!=='prompt'||state.messageId!==message.reply_to_message?.message_id)return false;
 try{
   if(state.room!==String(map?.chatRoomId||'')||state.actor!==String(message.from.id)||state.expires<Date.now())throw Error('Bước nhập đã hết hạn hoặc khách đã đổi. Mở lại /menu.');
   const q={from:message.from,message},op=state.op;let command;
   if(op==='custom'){
     const p=state.prefix.split(':'),max=p.length===3?100:3650;
     if(!/^\d+$/.test(text)||Number(text)<1||Number(text)>max)throw Error('Nhập số nguyên từ 1 đến '+max+'.');
     const step=billingWizard_('billing:wizard:'+state.prefix+':'+Number(text));
     await firebase(env,path,'DELETE');await adminMenuSend_(env,thread,step.text,step.markup);return true;
   }
   if(op==='extend'){if(!/^\d+$/.test(text)||Number(text)<1||Number(text)>3650)throw Error('Số ngày phải từ 1 đến 3650.');command='/extend '+Number(text);}
   else if(op==='replace_mst'){
     const parts=text.split(/\s+/).map(x=>x.replace(/-/g,''));if(parts.length!==2||!parts.every(x=>/^\d{10}(\d{3})?$/.test(x))||parts[0]===parts[1])throw Error('Cần hai MST hợp lệ, khác nhau.');command='/replace_mst '+parts.join(' ');
   } else if(op==='phone'){
     if(!/^\+?\d[\d\s.()-]{6,20}$/.test(text))throw Error('Số điện thoại không hợp lệ.');
     await adminMenuSend_(env,thread,await phoneReport_(env,text),adminMenuMarkup_(map?.chatRoomId?'root':'unlinked'));await firebase(env,path,'DELETE');return true;
   } else if(op==='link'){
     if(!/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(text))throw Error('Mã phòng không hợp lệ.');
     if(map?.chatRoomId&&map.chatRoomId!==text)throw Error('Topic đã gắn khách khác; không tự ghi đè.');
     const info=await gas(env,{action:'admin_command',chatRoomId:text,text:'/check'});if(info.found===false)throw Error('Phòng chưa tồn tại trong CRM.');command='/link '+text;
   } else if(op==='release'){
     const m=/^(\d+\.\d+\.\d+)\s+([\s\S]+)$/.exec(text);if(!m||!m[2].trim())throw Error('Cần phiên bản và nội dung cập nhật.');command='/release '+m[1]+' '+m[2].trim().slice(0,3000);
   }
   if(!command)throw Error('Thao tác không hợp lệ.');await adminMenuReview_(env,q,map,command);
 }catch(e){await adminMenuSend_(env,thread,String(e.message)+'\nTrả lời lại đúng tin yêu cầu, hoặc /cancel.');}
 return true;
}
async function adminMenuCallback_(env,query,map){
 const thread=query.message.message_thread_id;
 if(!thread)throw Error('Mở menu trong Topic của khách.');
 try{await telegram(env,'answerCallbackQuery',{callback_query_id:query.id});}catch{/* expired acknowledgment */}
 const p=String(query.data).split(':'),action=p[2],arg=p[3];
 const reads={check:'/check',usage:'/checkdulieu',plans:'/plans',mst:'/mst',release:'/release_preview'};
 if(action==='page'){
   await firebase(env,adminMenuPath_(query.from.id,thread),'DELETE');
   const page=map?.chatRoomId?arg:'unlinked';let title=page==='system'?'TOÀN HỆ THỐNG — thao tác áp dụng cho mọi khách':'QUẢN LÝ KHÁCH · '+String(map?.chatRoomId||'chưa liên kết');
   if(page==='root'&&map?.chatRoomId){const info=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:'/check'});title=info.reply;}
   return adminMenuSend_(env,thread,title,adminMenuMarkup_(page),query.message.message_id);
 }
 if(action==='prompt'||action==='custom')return adminMenuPrompt_(env,query,map,action==='custom'?'custom':arg,action==='custom'?p.slice(3).join(':'):'');
 if(action==='cancel'){await adminMenuState_(env,query,map,arg);await firebase(env,adminMenuPath_(query.from.id,thread),'DELETE');return adminMenuSend_(env,thread,'Đã hủy thao tác.',adminMenuMarkup_(map?.chatRoomId?'root':'unlinked'));}
 if(action==='online')return adminMenuSend_(env,thread,await onlineReport_(env),adminMenuMarkup_(map?.chatRoomId?'system':'unlinked'),query.message.message_id);
 if(action==='ai')return aiAdmin.handle(env,{message:{...query.message,from:query.from,text:'/ai'}},{waitUntil:()=>{}},'https://hoadon-support-gateway.linhnhaxac10.workers.dev');
 if(action==='prepare'){
   const commands={lock:'/lock',unlock:'/unlock',reset:'/reset',reset_mst_changes:'/reset_mst_changes',takeover:'/takeover',stop:'/stop',commerce_on:'/commerce on',commerce_off:'/commerce off',release_publish:'/release publish',release_off:'/release off'};
   if(!commands[arg])throw Error('Thao tác không hợp lệ.');return adminMenuReview_(env,query,map,commands[arg]);
 }
 if(action==='confirm'){
   const state=await adminMenuState_(env,query,map,arg);if(state.kind!=='review')throw Error('Không có thao tác đang chờ.');
   let text;
   if(state.command.startsWith('/link ')){
     const room=state.command.split(' ')[1],live=await firebase(env,'/telegramTopics/'+thread);
     if(live?.chatRoomId&&live.chatRoomId!==room)throw Error('Topic đã gắn khách khác.');
     const info=await gas(env,{action:'admin_command',chatRoomId:room,text:'/check'});if(info.found===false)throw Error('Phòng không còn trong CRM.');
     await firebase(env,'/telegramTopics/'+thread,'PUT',{chatRoomId:room,createdAt:Date.now()});
     await firebase(env,'/chats/'+encodeURIComponent(room)+'/meta','PATCH',{telegramThreadId:thread,telegramTopicCreatedAt:Date.now()});text='Đã gắn Topic với khách.\n'+info.reply;
   }else if(['/takeover','/stop'].includes(state.command)){
     await supportFlow.owner(env,state.room,state.command==='/stop'?'auto':'admin',String(query.from.id));text=state.command==='/stop'?'Đã kết thúc hỗ trợ; chuyển lại AI.':'Đã nhận hỗ trợ trực tiếp.';
   }else{
     const value=await gas(env,{action:'admin_command',chatRoomId:state.room,text:state.command,actor:String(query.from.id),expectedKey:state.expectedKey,...(state.expectedDraftAt!==undefined?{expectedDraftAt:state.expectedDraftAt}:{}),requestId:'MENU-'+state.token});
     await cacheLicense_(env,state.room,value);await billingRefresh_(env,value,state.command);text=value.reply;
     const notice=customerNotice_(state.command.split(' ')[0],value);
     if(notice)await firebase(env,'/chats/'+encodeURIComponent(state.room)+'/messages/MENU-'+state.token,'PUT',{sender:'admin',text:notice,timestamp:Date.now(),source:'telegram',telegramThreadId:thread,deliveryStatus:'firebase'});
   }
   await firebase(env,adminMenuPath_(query.from.id,thread),'DELETE');return adminMenuSend_(env,thread,text);
 }
 if(!map?.chatRoomId)throw Error('Topic chưa gắn khách.');
 if(action==='presence'){
   const s=await firebase(env,'/devices/'+encodeURIComponent(map.chatRoomId)+'/presence')||{},age=Date.now()-Number(s.lastSeen||0);
   return adminMenuSend_(env,thread,'TÍN HIỆU THIẾT BỊ\n'+(isOnlineAt(s.lastSeen,Date.now())?'🟢 Có tín hiệu gần đây':'⚪ Không có tín hiệu gần đây')+'\nPhiên bản: '+(s.appVersion||'—')+'\nNhận lần cuối: '+(s.lastSeen?Math.max(0,Math.floor(age/60000))+' phút trước':'chưa có')+'\nTrạng thái dựa trên tín hiệu; không xác nhận tiến trình đã tắt.',adminMenuMarkup_('device'),query.message.message_id);
 }
 if(action==='order'){
   const s=await adminMenuState_(env,query,map,arg),i=Number(p[4]),op=p[5];if(s.kind!=='orders'||!Number.isInteger(i)||!s.orders[i]||!['approve','reject'].includes(op))throw Error('Yêu cầu không hợp lệ.');
   const o=s.orders[i];return adminMenuReview_(env,query,map,'/'+op+' '+o.id+(op==='approve'?' paid':''),'Yêu cầu: '+o.id+'\nGói: '+o.planId+' · '+o.devices+' máy · '+o.term+'\nSố tiền: '+Number(o.total).toLocaleString('vi-VN')+'đ');
 }
 if(action==='read'||action==='orders'){
   const command=action==='orders'?'/orders':reads[arg];if(!command)throw Error('Mục không hợp lệ.');
   const value=await gas(env,{action:'admin_command',chatRoomId:map.chatRoomId,text:command});let markup=billingMenu_();
   if(action==='orders'&&value.menuOrders?.length){
     const state=await adminMenuSave_(env,query.from.id,thread,map.chatRoomId,{kind:'orders',orders:value.menuOrders});
     markup={inline_keyboard:state.orders.map((o,i)=>[{text:'✅ Nhận tiền · '+o.planId+' · '+Number(o.total).toLocaleString('vi-VN')+'đ',callback_data:'billing:admin:order:'+state.token+':'+i+':approve'},{text:'Từ chối #'+(i+1),callback_data:'billing:admin:order:'+state.token+':'+i+':reject'}]).concat([[{text:'⬅ Menu khách',callback_data:'billing:admin:page:root'}]])};
   }
   return adminMenuSend_(env,thread,value.reply,markup,query.message.message_id);
 }
 throw Error('Nút đã cũ. Mở lại /menu.');
}
