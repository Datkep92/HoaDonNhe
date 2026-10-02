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
  return { machineId, installationId, hardwareId: installationId, chatRoomId };
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
  const threadId = message.message_thread_id;

  // CẦU NỐI GẮN LẠI: dùng khi Firebase bị xoá (mapping mất) mà topic trên Telegram còn.
  // Gõ trong chính topic đó:  /link ROOM_WIN_XXXXXXXXXXXX
  // Ghi CẢ HAI chiều nên tin user → Telegram và Telegram → user chạy lại ngay.
  if (/^\/link(\s|$)/i.test(text)) {
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
  if (/^\/online(\s|$)/i.test(text)) {
    const answer = await onlineReport_(env);
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_thread_id: threadId, text: answer });
    return reply({ ok: true, value: { command: '/online' } });
  }

  // /check_SDT — tra cứu theo số điện thoại. Lệnh toàn cục, không gắn với phòng:
  // "tra cứu" nghĩa là tìm khách, nên phải chạy được từ bất kỳ topic nào, kể cả
  // topic chưa gắn máy. Đặt TRƯỚC nhánh lệnh theo phòng để /check_SDT không bị
  // nuốt vào /check; hai lệnh này khác nhau (/check = máy này, /check_SDT = tìm khách).
  const phoneLookup = /^\/check[_\s]+(\+?[\d][\d\s.()-]{6,})$/i.exec(text);
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
if (/^\/who(\s|$)/i.test(text) || /^\/trang-thai(\s|$)/i.test(text)) {
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
        const value = await gas(env, { action: 'admin_command', chatRoomId: room, command, text });
        // /lock, /unlock, /reset đổi trạng thái ngay trên Sheet. Ghi bản ghi nhớ
        // phía Firebase để app hỏi nhẹ (/v1/ping) nhận ra ngay.
        await cacheLicense_(env, room, value);
        answer = String(value?.reply || '').trim() || '⚠️ CRM không trả về nội dung.';
        // Lệnh cấp key / gia hạn: đẩy thông tin sang phòng chat của khách để khách
        // thấy ngay trong app, không phải chờ admin trao tay. Lệnh khác (/check,
        // /lock...) vẫn chỉ trả lời trong topic — không spam khách.
        const notice = customerNotice_(command, value);
        if (notice) {
          try {
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
  const result = await firebase(env, '/chats/' + encodeURIComponent(map.chatRoomId) + '/messages', 'POST', value);
  return reply({ ok: true, value: { id: result.name } });
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
  const max = Number(value.maxDevices) || 0;
  const slots = max > 0 ? '💻 Số máy tối đa: ' + max + (max > 1 ? ' máy' : ' máy') + ' (đã dùng ' + (Number(value.usedSlots) || 0) + ')' : '';
  if (/^\/new\b/i.test(command)) {
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
  if (/^\/extend\b/i.test(command)) {
    const lines = ['✅ Bản quyền của bạn đã được gia hạn.'];
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
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/healthz') return reply({ ok: true });
      // PHẢI `await` khi trả về promise bên trong `try`.
      // `try { return p } catch {}` KHÔNG bắt được lỗi của p: hàm async thoát ra
      // ngay, lỗi nổi lên thành unhandled rejection và Cloudflare trả 500 dạng
      // HTML — còn app chỉ biết JSON.parse thất bại và báo câu chữ vô nghĩa.
      if (request.method === 'GET' && url.pathname === '/v1/chats/stream') return await chatStream(env, request, url);
      if (request.method === 'POST' && url.pathname === '/v1/telegram/webhook') return await webhook(env, request);

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
      if (action === 'chat') {
        const raw = await firebase(env, '/chats/' + encodeURIComponent(d.chatRoomId) + '/messages');
        return reply({ ok: true, value: { messages: Object.entries(raw || {}).map(([id, value]) => ({ id, ...value })).sort((a, b) => a.timestamp - b.timestamp).slice(-100) } });
      }

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