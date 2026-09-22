'use strict';

// Run this after the Gateway is deployed to a public HTTPS URL.
// Telegram chỉ cho một webhook, và sau khi Apps Script không còn xử lý Telegram thì
// webhook bắt buộc phải trỏ về Gateway — không bao giờ trỏ về /exec của Apps Script.
const https = require('node:https');
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const rawUrl = String(process.env.PUBLIC_GATEWAY_URL || process.env.GATEWAY_URL || '').replace(/\/$/, '');
if (!token) throw new Error('Cần TELEGRAM_BOT_TOKEN của bot (lấy từ BotFather).');
if (!/^https:\/\//.test(rawUrl)) throw new Error('Cần PUBLIC_GATEWAY_URL bắt đầu bằng https://');
if (rawUrl.endsWith('/exec')) throw new Error('Đừng trỏ webhook vào Apps Script /exec: Code.gs không xử lý Telegram.');
const targetUrl = rawUrl.endsWith('/v1/telegram/webhook') ? rawUrl : `${rawUrl}/v1/telegram/webhook`;
const payloadData = { url: targetUrl, allowed_updates: ['message'], drop_pending_updates: false };
if (secret) payloadData.secret_token = secret;
const payload = JSON.stringify(payloadData);
const request = https.request(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, response => { let out = ''; response.on('data', part => { out += part; }); response.on('end', () => { if (response.statusCode < 200 || response.statusCode > 299) process.exitCode = 1; console.log(out); }); });
request.on('error', error => { console.error(error.message); process.exitCode = 1; }); request.end(payload);
