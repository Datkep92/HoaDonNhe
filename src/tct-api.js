'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const pace = require('./pace');
const HOST = 'https://hoadondientu.gdt.gov.vn';
const END_POINT = '/tra-cuu/tra-cuu-hoa-don';
const DEFAULT_CHROME = '153.0.0.0';
// Cookies handed out by the portal (WAF session + captcha session) are kept and sent back the
// way a browser would, so a saved session can be reused on the next run.
//
// KHO COOKIE TÁCH THEO TỪNG MST (`jars` là Map<mst, Map<tên, giá trị>>).
// Vì sao: nhiều MST chạy Auto Sync cùng lúc thì mỗi MST có phiên WAF riêng; dùng chung một kho
// sẽ khiến MST này gửi cookie của MST kia (lẫn phiên) và ghi sai cookie vào file đã lưu.
// `''` là kho mặc định cho luồng không gắn MST (ví dụ lấy CAPTCHA khi chưa chọn MST).
const jars = new Map();
function jarOf(scope) {
  const key = String(scope || '');
  let jar = jars.get(key);
  if (!jar) { jar = new Map(); jars.set(key, jar); }
  return jar;
}
function storeCookies(list, scope = '') {
  const jar = jarOf(scope);
  for (const raw of list || []) {
    const pair = String(raw).split(';')[0]; const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim(); const value = pair.slice(index + 1).trim();
    if (name && value) jar.set(name, value); else if (name) jar.delete(name);
  }
}
function cookieHeader(scope = '') { return [...jarOf(scope)].map(([name, value]) => `${name}=${value}`).join('; '); }
function setCookies(value, scope = '') {
  const jar = jarOf(scope); jar.clear();
  storeCookies(String(value ?? '').split(';').map(x => x.trim()).filter(Boolean), scope);
}
function clearCookies(scope = '') { jarOf(scope).clear(); }
// The portal edge rejects Node traffic that does not look like a Chrome window: measured
// 2026-09-18, POST sent with only Accept (or only User-Agent, or only client hints) is answered
// with HTTP 403 "Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.", while the full
// set below is forwarded to the application (HTTP 400/401 instead of 403). The same set is used
// by VNIT's "đăng nhập thẳng", which logs in successfully against the same endpoints.
function chromeVersion() {
  const files = [process.env.LOCALAPPDATA].filter(Boolean).flatMap(base => [
    path.join(base, 'Google', 'Chrome', 'User Data', 'Last Version'),
    path.join(base, 'Microsoft', 'Edge', 'User Data', 'Last Version')
  ]);
  for (const file of files) { try { const value = fs.readFileSync(file, 'utf8').trim(); if (/^\d+\.\d+\.\d+/.test(value)) return value; } catch {} }
  return DEFAULT_CHROME;
}
const version = chromeVersion();
const major = version.split('.')[0];
function portalHeaders(extra = {}, scope = '') {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,en-US;q=0.7,en;q=0.6',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`,
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not_A Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    Origin: HOST,
    Referer: `${HOST}/`,
    'request-id': crypto.randomUUID(),
    Connection: 'keep-alive',
    ...(cookieHeader(scope) ? { Cookie: cookieHeader(scope) } : {}),
    ...extra
  };
}
function decodeBody(result) {
  const encoding = String(result.headers['content-encoding'] || '').toLowerCase();
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(result.body);
    if (encoding === 'br') return zlib.brotliDecompressSync(result.body);
    if (encoding === 'deflate') { try { return zlib.inflateSync(result.body); } catch { return zlib.inflateRawSync(result.body); } }
  } catch { return result.body; }
  return result.body;
}
// Nhịp + trạng thái tạm nghỉ nằm ở src/pace.js để dùng chung với đường tải qua trình duyệt.
function restRemaining() { return pace.restRemaining(); }
function resetRest() { pace.resetRest(); }
function noteRest(status, text, retryAfter) { return pace.note(status, text, retryAfter); }
async function call(pathname, { method = 'GET', body, headers, scope = '' } = {}) {
  await pace.wait();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = https.request(HOST + pathname, { method, timeout: 30000, headers: portalHeaders({ ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers }, scope) }, res => {
      const chunks = []; res.on('data', x => chunks.push(x));
      res.on('end', () => {
        const status = res.statusCode || 0; const body = decodeBody({ headers: res.headers, body: Buffer.concat(chunks) }); const text = body.toString('utf8');
        storeCookies(res.headers['set-cookie'], scope);
        noteRest(status, text, res.headers['retry-after']); pace.mark(); resolve({ status, body, text });
      });
    });
    request.on('timeout', () => request.destroy(new Error('TCT không phản hồi sau 30 giây.'))); request.on('error', reject); if (data) request.write(data); request.end();
  });
}
function parse(result) { try { return JSON.parse(result.text); } catch { return null; } }
async function captcha(scope = '') {
  const result = await call('/api/captcha', { scope }); const value = parse(result);
  if (result.status < 200 || result.status >= 300 || !value?.key || !value?.content) throw new Error(value?.message || 'Không lấy được CAPTCHA từ TCT.');
  return { key: value.key, captcha: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.content)}` };
}
async function authenticate(input, scope = '') {
  const result = await call('/api/security-taxpayer/authenticate', { method: 'POST', body: { username: input.username, password: input.password, ckey: input.ckey, cvalue: input.captcha }, scope }); const value = parse(result);
  if (result.status < 200 || result.status >= 300 || !value?.token) throw new Error(value?.message || value?.error || `TCT trả HTTP ${result.status}.`);
  return value.token;
}
async function request(token, route, action, scope = '') {
  const result = await call('/api' + route, { headers: { Authorization: `Bearer ${token}`, Action: encodeURIComponent(action), 'End-Point': END_POINT }, scope });
  if (result.status >= 200 && result.status < 300) return result.body;
  const value = parse(result);
  const rest = pace.blocked();
  throw Object.assign(new Error(rest || (result.status === 401 ? 'Phiên cổng thuế đã hết. Đăng nhập lại.' : (value?.message || `TCT trả HTTP ${result.status}.`))), { auth: result.status === 401 });
}
module.exports = { captcha, authenticate, request, portalHeaders, decodeBody, restRemaining, resetRest, noteRest, cookies: cookieHeader, storeCookies, setCookies, clearCookies };
