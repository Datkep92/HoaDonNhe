#!/usr/bin/env node
const baseUrl = (process.env.WORKER_URL || 'https://hoadon-support-gateway.linhnhaxac10.workers.dev').replace(/\/$/, '');
const installationId = process.env.TEST_INSTALLATION_ID || '11111111-1111-4111-8111-111111111111';
const chatRoomId = process.env.TEST_CHAT_ROOM_ID || 'ROOM_WIN_SMOKETEST01';

async function post(path, body, token) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: JSON.stringify({ installationId, chatRoomId, ...body })
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = { raw: text }; }
  return { status: response.status, value };
}

const status = await post('/v1/licenses/status', {});
console.log('license status:', JSON.stringify({ status: status.status, ok: status.value.ok, license: status.value.value?.status }));
if (!status.value.ok || !status.value.value?.sessionToken) process.exit(1);

const token = status.value.value.sessionToken;
const message = await post('/v1/messages', { text: 'Smoke test tu Cloudflare gateway.' }, token);
console.log('message:', JSON.stringify({ status: message.status, ok: message.value.ok, deliveryStatus: message.value.value?.deliveryStatus, id: message.value.value?.id }));
if (!message.value.ok) process.exit(1);

const chat = await post('/v1/chats/status', {}, token);
const messages = chat.value.value?.messages || [];
const last = messages[messages.length - 1] || {};
console.log('chat:', JSON.stringify({ status: chat.status, ok: chat.value.ok, count: messages.length, lastDeliveryStatus: last.deliveryStatus, telegramThreadId: last.telegramThreadId }));
if (!chat.value.ok) process.exit(1);
