#!/usr/bin/env node
const baseUrl = (process.env.WORKER_URL || 'https://hoadon-support-gateway.linhnhaxac10.workers.dev').replace(/\/$/, '');
const body = {
  installationId: process.env.TEST_INSTALLATION_ID || '22222222-2222-4222-8222-222222222222',
  chatRoomId: process.env.TEST_CHAT_ROOM_ID || 'ROOM_WIN_REGTEST01'
};
const response = await fetch(baseUrl + '/v1/devices/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
console.log(response.status, await response.text());
if (!response.ok) process.exit(1);
