'use strict';

// Stateless Phase 2 Gateway.  Deploy this service behind HTTPS (Cloud Run,
// Render, Fly.io, etc.).  It is deliberately dependency-free for auditing.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const config = {
  port: Number(process.env.PORT || 8080),
  gasUrl: process.env.GAS_URL || '',
  gasSecret: process.env.GAS_SHARED_SECRET || '',
  tokenSecret: process.env.TOKEN_SECRET || '',
  firebaseUrl: String(process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, ''),
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
};
for (const key of ['gasUrl', 'gasSecret', 'tokenSecret']) {
  if (!config[key] || (key !== 'gasUrl' && config[key].length < 32)) throw new Error(`Missing or unsafe ${key}. Set it in the deployment environment.`);
}

const buckets = new Map();
function limit(req, name, maximum, windowMs) {
  const address = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = `${name}:${address}`; const now = Date.now();
  const value = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now >= value.reset) { value.count = 0; value.reset = now + windowMs; }
  if (++value.count > maximum) return false;
  buckets.set(key, value); return true;
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 16384) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON.')); } }); req.on('error', reject);
  });
}
function validDevice(input) {
  const installationId = String(input.installationId || input.hardwareId || ''); const chatRoomId = String(input.chatRoomId || '');
  if (!/^[0-9a-f-]{36}$/i.test(installationId)) throw new Error('Invalid installation ID.');
  if (!/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(chatRoomId)) throw new Error('Invalid chat room ID.');
  return { installationId, chatRoomId };
}
function isExpired(expiryAt) {
  if (!expiryAt) return false;
  const raw = String(expiryAt).slice(0, 10) + 'T23:59:59';
  const val = new Date(raw);
  return Number.isFinite(val.getTime()) && val.getTime() < Date.now();
}
function normalizeGasResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (String(result.status || '').toLowerCase() === 'active' && isExpired(result.expiryAt)) {
    return { ...result, status: 'Expired' };
  }
  return result;
}
async function callGas(payload) {
  const data = JSON.stringify({ ...payload, gatewaySecret: config.gasSecret });
  if (typeof fetch === 'function') {
    const res = await fetch(config.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('CRM returned non-JSON response.'); }
    if (!parsed.ok) throw new Error(parsed.error || 'CRM rejected request.');
    return parsed.value;
  }
  const target = new URL(config.gasUrl); const request = target.protocol === 'https:' ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 15000 }, response => {
      let output = ''; response.setEncoding('utf8'); response.on('data', chunk => { output += chunk; }); response.on('end', () => {
        try { const parsed = JSON.parse(output); if (!parsed.ok) throw new Error(parsed.error || 'CRM rejected request.'); resolve(parsed.value); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CRM timeout.'))); req.on('error', reject); req.end(data);
  });
}
function token(claims) {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encoded({ alg: 'HS256', typ: 'JWT' }); const payload = encoded({ ...claims, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 });
  const signature = crypto.createHmac('sha256', config.tokenSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
function verifyToken(value) {
  const parts = String(value || '').replace(/^Bearer\s+/i, '').split('.'); if (parts.length !== 3) throw new Error('Missing support session.');
  const expected = crypto.createHmac('sha256', config.tokenSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) throw new Error('Invalid support session.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) throw new Error('Support session expired.'); return claims;
}
let firebaseToken = { value: '', expiresAt: 0 };
function postForm(url, value) { const data = new URLSearchParams(value).toString(); return new Promise((resolve, reject) => { const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, res => { let out = ''; res.on('data', x => { out += x; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('Invalid OAuth response.')); } }); }); req.on('error', reject); req.end(data); }); }
async function firebaseAccessToken() {
  if (!config.firebaseUrl || !config.firebaseServiceAccount) throw new Error('Firebase chưa được cấu hình trên Gateway.');
  if (firebaseToken.expiresAt > Date.now() + 60_000) return firebaseToken.value;
  const service = JSON.parse(config.firebaseServiceAccount), encode = x => Buffer.from(JSON.stringify(x)).toString('base64url'); const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: 'RS256', typ: 'JWT' }); const claims = encode({ iss: service.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: service.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const assertion = `${head}.${claims}.${crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).end().sign(service.private_key, 'base64url')}`;
  const result = await postForm(service.token_uri || 'https://oauth2.googleapis.com/token', { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }); if (!result.access_token) throw new Error('Firebase OAuth failed.');
  firebaseToken = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 }; return firebaseToken.value;
}
async function firebase(path, method, value) {
  const accessToken = await firebaseAccessToken(); const target = new URL(`${config.firebaseUrl}${path}.json`); const data = value === undefined ? '' : JSON.stringify(value);
  return new Promise((resolve, reject) => { const req = https.request(target, { method, headers: { Authorization: `Bearer ${accessToken}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => { let out = ''; res.setEncoding('utf8'); res.on('data', x => { out += x; }); res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('Firebase request failed.')); try { resolve(JSON.parse(out || 'null')); } catch { reject(new Error('Invalid Firebase response.')); } }); }); req.on('error', reject); if (data) req.end(data); else req.end(); });
}
async function chatStatus(input, claims) { const device = validDevice(input); if (claims.installationId !== device.installationId || claims.chatRoomId !== device.chatRoomId) throw new Error('Support session does not match this device.'); const raw = await firebase(`/chats/${encodeURIComponent(device.chatRoomId)}/messages`, 'GET'); return { messages: Object.entries(raw || {}).map(([id, value]) => ({ id, ...value })).sort((a, b) => a.timestamp - b.timestamp).slice(-100) }; }
function telegram(method, payload) {
  if (!config.telegramToken || !config.telegramChatId) throw new Error('Telegram chưa được cấu hình trên Gateway.');
  const data = JSON.stringify(payload); const target = new URL(`https://api.telegram.org/bot${config.telegramToken}/${method}`);
  return new Promise((resolve, reject) => { const req = https.request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => { let out = ''; res.setEncoding('utf8'); res.on('data', x => { out += x; }); res.on('end', () => { try { const result = JSON.parse(out); if (!result.ok) throw new Error(result.description || 'Telegram request failed.'); resolve(result.result); } catch (error) { reject(error); } }); }); req.on('error', reject); req.end(data); });
}
const topicLocks = new Map();
async function topicFor(room) {
  if (topicLocks.has(room)) return topicLocks.get(room);
  const work = (async () => {
    const existing = await firebase(`/chats/${encodeURIComponent(room)}/meta`, 'GET'); if (existing?.telegramThreadId) return existing.telegramThreadId;
    const topic = await telegram('createForumTopic', { chat_id: config.telegramChatId, name: `Support · ${room}`.slice(0, 128) });
    await firebase(`/chats/${encodeURIComponent(room)}/meta`, 'PATCH', { telegramThreadId: topic.message_thread_id, telegramTopicCreatedAt: Date.now() });
    await firebase(`/telegramTopics/${topic.message_thread_id}`, 'PUT', { chatRoomId: room, createdAt: Date.now() }); return topic.message_thread_id;
  })();
  topicLocks.set(room, work); try { return await work; } finally { topicLocks.delete(room); }
}
async function forwardToTelegram(room, message) {
  const threadId = await topicFor(room); const sent = await telegram('sendMessage', { chat_id: config.telegramChatId, message_thread_id: threadId, text: message.text });
  await firebase(`/chats/${encodeURIComponent(room)}/messages/${encodeURIComponent(message.id)}`, 'PATCH', { deliveryStatus: 'delivered', telegramMessageId: sent.message_id, telegramThreadId: threadId });
}
function normalizeGasResult(result) {
  if (!result || typeof result !== 'object') return result;
  const st = String(result.status || '').toLowerCase();
  if (st === 'locked') return { ...result, status: 'Locked' };
  if (st === 'active' && isExpired(result.expiryAt)) {
    return { ...result, status: 'Expired' };
  }
  return result;
}

async function telegramWebhook(req, res) {
  if (config.telegramWebhookSecret && !sameSecret(req.headers['x-telegram-bot-api-secret-token'], config.telegramWebhookSecret)) {
    return json(res, 403, { ok: false, error: 'Invalid webhook secret.' });
  }
  const update = await body(req);
  // Forward to Google Apps Script so admin commands (/new, /check, /extend, /reset, /lock, /unlock) are executed
  try {
    if (update.message) await callGas(update);
  } catch (error) {
    console.error(`GAS telegram handler error: ${error.message}`);
  }
  // If Firebase is configured, also handle chat sync
  if (config.firebaseUrl && config.firebaseServiceAccount) {
    try {
      const message = update.message;
      if (message && !message.from?.is_bot && message.message_thread_id && String(message.text || '').trim()) {
        const mapping = await firebase(`/telegramTopics/${message.message_thread_id}`, 'GET');
        if (mapping?.chatRoomId) {
          const value = { sender: 'admin', text: String(message.text).trim().slice(0, 2000), timestamp: message.date ? message.date * 1000 : Date.now(), source: 'telegram', telegramMessageId: message.message_id, telegramThreadId: message.message_thread_id, deliveryStatus: 'firebase' };
          await firebase(`/chats/${encodeURIComponent(mapping.chatRoomId)}/messages`, 'POST', value);
        }
      }
    } catch (e) {}
  }
  return json(res, 200, { ok: true });
}
async function route(req, res) {
  if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/v1/telegram/webhook') return telegramWebhook(req, res);
  if (req.method !== 'POST' || !['/v1/devices/register', '/v1/licenses/activate', '/v1/licenses/status', '/v1/chats/status', '/v1/chats/messages'].includes(req.url)) return json(res, 404, { ok: false, error: 'Not found.' });
  const action = req.url.includes('activate') ? 'activate' : req.url.includes('messages') ? 'message' : req.url.includes('chats/status') ? 'chat_status' : req.url.includes('status') ? 'status' : 'register';
  if (!limit(req, action, action === 'activate' ? 8 : 60, 60_000)) return json(res, 429, { ok: false, error: 'Too many requests. Try again later.' });
  try {
    const input = await body(req); const device = validDevice(input);
    if (action === 'chat_status') return json(res, 200, { ok: true, value: await chatStatus(input, verifyToken(req.headers.authorization)) });
    if (action === 'message') { const claims = verifyToken(req.headers.authorization); if (claims.installationId !== device.installationId || claims.chatRoomId !== device.chatRoomId) throw new Error('Support session does not match this device.'); const text = String(input.text || '').trim(); if (!text || text.length > 2000) throw new Error('Invalid message.'); const value = { sender: 'user', text, timestamp: Date.now(), source: 'desktop', deliveryStatus: 'pending_telegram' }; const result = await firebase(`/chats/${encodeURIComponent(device.chatRoomId)}/messages`, 'POST', value); const message = { id: result.name, ...value }; try { await forwardToTelegram(device.chatRoomId, message); } catch (error) { console.error(`Telegram delivery pending for ${device.chatRoomId}: ${error.message}`); } return json(res, 200, { ok: true, value: message }); }
    if (action === 'activate') {
      const key = String(input.key || input.licenseKey || '').trim();
      if (key.length < 6 || key.length > 160) throw new Error('Invalid license key.');
      let gasResult;
      try {
        gasResult = await callGas({ action: 'verify_key', ...device, key });
      } catch (err) {
        if (/Device must be registered/i.test(err.message)) {
          await callGas({ action: 'register_device', ...device });
          gasResult = await callGas({ action: 'verify_key', ...device, key });
        } else {
          throw err;
        }
      }
      const result = normalizeGasResult(gasResult);
      return json(res, 200, {
        ok: true,
        value: {
          ...result,
          keyName: key,
          sessionToken: token({ installationId: device.installationId, chatRoomId: device.chatRoomId, license: result.status })
        }
      });
    }
    const rawResult = await callGas({ action: action === 'register' ? 'register_device' : 'license_status', ...device });
    const result = normalizeGasResult(rawResult);
    return json(res, 200, { ok: true, value: { ...result, sessionToken: token({ installationId: device.installationId, chatRoomId: device.chatRoomId, license: result.status }) } });
  } catch (error) { return json(res, 400, { ok: false, error: error.message || 'Request failed.' }); }
}
http.createServer((req, res) => route(req, res).catch(error => json(res, 500, { ok: false, error: error.message || 'Internal error.' }))).listen(config.port, '0.0.0.0', () => console.log(`support gateway listening on ${config.port}`));
