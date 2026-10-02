#!/usr/bin/env node
// Kiểm tra endpoint thông báo tải app từ landing: POST /v1/landing/download
// Chạy SAU khi deploy Worker (`node deploy.mjs`) — sẽ bắn 1 tin thật vào
// Telegram nên chỉ dùng khi bạn muốn xác nhận tận dụng.
const baseUrl = (process.env.WORKER_URL || 'https://hoadon-support-gateway.linhnhaxac10.workers.dev').replace(/\/$/, '');

const response = await fetch(baseUrl + '/v1/landing/download', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=UTF-8' },   // giống hệt sendBeacon
  body: JSON.stringify({ page: '/#download' }),
});
const text = await response.text();
console.log('status :', response.status);
console.log('cors   :', response.headers.get('Access-Control-Allow-Origin') || '(thiếu — landing sẽ bị chặn)');
console.log('body   :', text.slice(0, 200));

if (response.status !== 200) { console.error('LỖI: endpoint chưa trả 200 — Worker có lẽ chưa deploy bản mới.'); process.exit(1); }
if (response.headers.get('Access-Control-Allow-Origin') !== '*') { console.error('LỖI: thiếu header CORS.'); process.exit(1); }
console.log('OK: đã gửi tin. Mở Telegram kiểm tra topic "Tải app từ landing".');
