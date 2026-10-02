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
import { readFileSync } from 'node:fs';
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

// Đọc `vars` trong wrangler.jsonc làm giá trị mặc định, để không phải copy tay 3
// biến mỗi lần deploy. Biến môi trường vẫn thắng (để deploy thử sang account khác).
// jsonc = JSON có comment, nên phải bỏ comment trước khi JSON.parse.
function wranglerVars() {
  try {
    const raw = readFileSync(join(here, 'wrangler.jsonc'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(raw).vars || {};
  } catch (error) {
    console.log(`(không đọc được wrangler.jsonc: ${error.message})`);
    return {};
  }
}
const DEFAULTS = wranglerVars();
const VARS = ['GAS_URL', 'FIREBASE_DATABASE_URL', 'TELEGRAM_CHAT_ID'];
const setting = name => process.env[name] || DEFAULTS[name] || '';

function fail(message) { console.error(`LỖI: ${message}`); process.exit(1); }

// Gọi thử Apps Script xem còn sống không. Chạy TRƯỚC khi upload: deploy một
// GAS_URL chết sẽ làm hỏng toàn bộ luồng bản quyền, mà lúc đó chỉ biết về sau
// khi khách báo lỗi.
//
// Phải THỬ LẠI nhiều lần: lần gọi đầu tiên sau khi vừa deploy, Apps Script còn
// khởi động lạnh và có thể mất 10–30 giây. Đây là lý do timeout một lần không
// đủ để kết luận URL chết — trước đây nó chặn nhầm một URL hoàn toàn tốt.
async function checkGas(url, attempts = 3) {
  let last = 'chưa thử';
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'license_status', gatewaySecret: 'deploy-preflight-probe' }),
        signal: AbortSignal.timeout(30000),
      });
      const text = (await response.text()).trim();
      if (!response.ok) return { ok: false, why: `HTTP ${response.status}` };
      // Script sống trả JSON. Nội dung cụ thể không quan trọng — chỉ cần biết nó
      // KHÔNG phải trang lỗi HTML của Google (dấu hiệu deployment không tồn tại).
      if (text.startsWith('{')) return { ok: true, why: i > 1 ? `phản hồi JSON (lần ${i})` : 'phản hồi JSON' };
      return { ok: false, why: 'trả HTML, không phải JSON — deployment có thể không tồn tại' };
    } catch (error) {
      last = error.message;
      if (i < attempts) {
        console.log(`  (lần ${i}/${attempts} chưa phản hồi: ${last} — thử lại)`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  return { ok: false, why: `${last} (đã thử ${attempts} lần)` };
}

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
  console.log(`src/${MODULE}: ${code.length} bytes · ${code.split('\n').length} dòng`);

  // ---- Chặn GAS_URL chết TRƯỚC khi đụng vào production ----
  // Rất đáng kiểm: URL hỏng sẽ làm mọi lệnh vào CRM chết, và lúc đó chỉ biết
  // về sau khi khách báo lỗi. Cũng chính vì thế phải hỏi bằng chính URL đó, chứ
  // đừng tin vào giá trị trong file — nó có thể đã cũ.
  const gasUrl = setting('GAS_URL');
  if (!gasUrl) {
    console.log('\n⚠ Thiếu GAS_URL: không có trong biến môi trường lẫn wrangler.jsonc.');
    console.log('  Lấy ở: Cloudflare → Worker hoadon-support-gateway → Settings → Variables.');
    console.log('  Deploy với GAS_URL hỏng sẽ làm hỏng toàn bộ luồng bản quyền.\n');
    fail('Thiếu GAS_URL.');
  }
  const gasProbe = await checkGas(gasUrl);
  if (!gasProbe.ok) {
    console.log(`\n⚠ GAS_URL KHÔNG phản hồi JSON: ${gasProbe.why}`);
    console.log(`  ${gasUrl}`);
    console.log('  Có thể deployment đã bị xoá/đổi. Sửa URL rồi chạy lại — không deploy lúc này.\n');
    fail('GAS_URL chưa sống.');
  }
  console.log(`GAS_URL: sống (${gasProbe.why})`);

  // Nhắc nhở trước khi deploy: các secret KHÔNG nằm trong mã nguồn nên deploy
  // xong mà thiếu thì app gặp lỗi khó hiểu ("Invalid support session").
  const absent = SECRETS.filter(name => !process.env[name]);
  if (absent.length) {
    console.log(`\n⚠ ${absent.length} secret CHƯA có trong môi trường: ${absent.join(', ',)}`);
    console.log('  Script sẽ KHÔNG ghi đè các secret đang chạy trên dashboard.');
    console.log('  Nếu worker trên dashboard đã có đủ secret thì bỏ qua cảnh báo này.');
    console.log('  Nếu chưa: dán vào Cloudflare → Worker → Settings → Variables and Secrets (mark là Secret).\n');
  } else {
    console.log(`secret sẽ được set luôn: ${SECRETS.join(', ')}`);
  }

  const account = await accountId();
  await confirmTarget(account);
  const bindings = VARS
    .filter(name => setting(name))
    .map(name => ({ type: 'plain_text', name, text: String(setting(name)) }));
  const missing = VARS.filter(name => !setting(name));
  if (missing.length) console.log(`(chưa có ${missing.join(', ')} — vẫn deploy, thêm sau bằng dashboard hoặc chạy lại script)`);
  else console.log(`vars: ${bindings.map(b => b.name).join(', ')} (lấy từ wrangler.jsonc nếu không có biến môi trường)`);

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
