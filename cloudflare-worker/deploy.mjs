#!/usr/bin/env node
// Deploy this Worker (src/index.js) through the Cloudflare API — no browser, no wrangler.
// Requires Node 18+ (global fetch/FormData/Blob). Nothing is written into the repo.
//
// PowerShell usage:
//   $env:CLOUDFLARE_API_TOKEN = (Get-Content "$env:TEMP\cf-token.txt" -Raw).Trim()
//   $env:GAS_URL = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec'
//   $env:FIREBASE_DATABASE_URL = 'https://<PROJECT>-default-rtdb.firebaseio.com'
//   $env:TELEGRAM_CHAT_ID = '-1001234567890'
//   node deploy.mjs
//
// Token needs one permission only: Account -> Workers Scripts -> Edit.
// Optional: set CLOUDFLARE_ACCOUNT_ID to skip the account lookup.
//
// Secrets are NOT required here. If (and only if) you set these env vars the script also
// pushes them as Worker secrets, otherwise add them by hand in the dashboard:
//   GAS_SHARED_SECRET, TOKEN_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON,
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
//
// After a successful upload the script calls <worker>/healthz and expects {"ok":true}.
// Override the probe URL with WORKER_URL.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT_NAME = process.env.WORKER_NAME || 'hoadon-support-gateway';
const COMPATIBILITY_DATE = process.env.COMPATIBILITY_DATE || '2026-09-19';
const MODULE = 'index.js';
const SECRETS = ['GAS_SHARED_SECRET', 'TOKEN_SECRET', 'FIREBASE_SERVICE_ACCOUNT_JSON', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'];

const here = dirname(fileURLToPath(import.meta.url));
const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
if (!token) fail('Thiếu CLOUDFLARE_API_TOKEN. Tạo token quyền "Account → Workers Scripts → Edit" rồi đặt biến môi trường.');

function fail(message) { console.error(`LỖI: ${message}`); process.exit(1); }

async function api(path, options = {}, soft = false) {
  const response = await fetch(`${API}${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 400) }; }
  if (!response.ok || body.success === false) {
    const errors = (body.errors || []).map(x => `${x.code} ${x.message}`).join(' | ') || text.slice(0, 300);
    const message = `${options.method || 'GET'} ${path} → HTTP ${response.status}: ${errors}`;
    if (soft) throw new Error(message);   // "soft" = trả lỗi cho nơi gọi tự xử, không thoát chương trình
    fail(message);
  }
  return body;
}

async function accountId() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID.trim();
  try {
    const { result } = await api('/accounts', {}, true);
    if (result?.length) {
      if (result.length > 1) console.log(`Token thấy ${result.length} account, dùng account đầu tiên: ${result[0].name} (${result[0].id})`);
      return result[0].id;
    }
  } catch { /* token chỉ có Workers Scripts:Edit nên có thể không đọc được /accounts */ }
  fail('Không xác định được account id. Đặt thêm CLOUDFLARE_ACCOUNT_ID (id trong URL dashboard) rồi chạy lại.');
}

// Chỉ đọc: xác nhận account đích đã có Worker này, tránh vô tình tạo Worker mới ở nhầm account.
async function confirmTarget(account) {
  try {
    const { result } = await api(`/accounts/${account}/workers/scripts`, {}, true);
    const names = (result || []).map(x => x.id || x.name).filter(Boolean);
    if (names.includes(SCRIPT_NAME)) { console.log(`Account ${account} đang có Worker "${SCRIPT_NAME}" — ghi đè bản hiện tại.`); return; }
    if (process.env.ALLOW_CREATE === '1') { console.log(`Chưa có Worker "${SCRIPT_NAME}"; ALLOW_CREATE=1 nên vẫn tạo mới.`); return; }
    fail(`Account ${account} chưa có Worker "${SCRIPT_NAME}". Worker đang có: ${names.join(', ') || '(không có)'}. Kiểm tra lại CLOUDFLARE_ACCOUNT_ID, hoặc đặt ALLOW_CREATE=1 nếu thật sự muốn tạo mới.`);
  } catch (error) {
    console.log(`(không đọc được danh sách Worker: ${error.message} — tiếp tục upload)`);
  }
}

async function main() {
  const code = await readFile(join(here, 'src', MODULE), 'utf8');
  if (!code.includes('export default')) fail('src/index.js không phải ES module Worker (thiếu "export default").');
  const account = await accountId();
  await confirmTarget(account);
  const bindings = ['GAS_URL', 'FIREBASE_DATABASE_URL', 'TELEGRAM_CHAT_ID']
    .filter(name => process.env[name])
    .map(name => ({ type: 'plain_text', name, text: String(process.env[name]) }));
  const missing = ['GAS_URL', 'FIREBASE_DATABASE_URL', 'TELEGRAM_CHAT_ID'].filter(name => !process.env[name]);
  if (missing.length) console.log(`(chưa có ${missing.join(', ')} — vẫn deploy, thêm sau bằng dashboard hoặc chạy lại script)`);

  const metadata = { main_module: MODULE, compatibility_date: COMPATIBILITY_DATE, ...(bindings.length ? { bindings } : {}) };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata');
  form.append(MODULE, new Blob([code], { type: 'application/javascript+module' }), MODULE);
  const uploaded = await api(`/accounts/${account}/workers/scripts/${SCRIPT_NAME}`, { method: 'PUT', body: form });
  console.log(`Đã upload ${MODULE} (${code.length} bytes) → ${SCRIPT_NAME} · version ${uploaded.result?.id || '?'}`);

  const pushed = [];
  for (const name of SECRETS) {
    const value = process.env[name];
    if (!value) continue;
    await api(`/accounts/${account}/workers/scripts/${SCRIPT_NAME}/secrets`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, text: String(value), type: 'secret_text' })
    });
    pushed.push(name);
  }
  console.log(pushed.length ? `Đã set secret: ${pushed.join(', ')}` : 'Không set secret nào (tự dán vào dashboard: Settings → Variables and Secrets).');

  const url = (process.env.WORKER_URL || `https://${SCRIPT_NAME}.linhnhaxac10.workers.dev`).replace(/\/$/, '');
  const health = await fetch(`${url}/healthz`);
  const body = (await health.text()).trim();
  console.log(`GET ${url}/healthz → HTTP ${health.status} · ${body.slice(0, 120)}`);
  if (body !== '{"ok":true}') console.log('CẢNH BÁO: /healthz chưa trả {"ok":true} — worker có thể vẫn là bản cũ (đợi vài giây rồi thử lại) hoặc account dùng subdomain workers.dev khác.');
  else console.log('OK: gateway đã chạy. Bước tiếp: dán 5 secret (nếu chưa), đăng ký webhook Telegram, rồi trỏ du_lieu/support-gateway.json vào URL này.');
}

main().catch(error => fail(error.message));
