'use strict';
// ---------------------------------------------------------------------------
// DỰNG CRM MỚI: Google Sheet trống + Apps Script gắn vào đó + web app deploy.
//
// Tự động hoá toàn bộ, không cần tạo tab/tiêu đề cột bằng tay:
//   1. Tạo Google Sheet trống            (Drive API)
//   2. Tạo Apps Script gắn vào Sheet đó  (Apps Script API, parentId)
//   3. Đẩy Code.gs + appsscript.json lên
//   4. Deploy thành Web App -> in ra URL /exec
//   5. In bước còn lại: dán GAS_SHARED_SECRET vào Script Properties
//      (Apps Script không có REST API để ghi Script Property, nên phải làm tay)
//
// Tab + tiêu đề cột KHÔNG cần tạo ở bước này: Code.gs tự dựng ở request đầu
// tiên (ensureTabs_). Xem support-gateway/apps-script/Code.gs.
//
// DÙNG
//   node tools/provision-crm.cjs                 # kiểm tra điều kiện, không tạo
//   node tools/provision-crm.cjs --title "CRM CN Tax Tools"   # tạo thật
//   node tools/provision-crm.cjs --title "..." --sheet-id <id>  # bỏ qua bước tạo Sheet
//
// Cần: clasp đã đăng nhập ĐÚNG tài khoản, và tài khoản đó đã bật Apps Script API
// tại https://script.google.com/home/usersettings
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const CODE_GS = path.join(__dirname, '..', 'support-gateway', 'apps-script', 'Code.gs');
const CLASP_RC = path.join(os.homedir(), '.clasprc.json');

const arg = (flag, fallback = '') => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes('--apply');
const TITLE = arg('--title', 'CRM CN Tax Tools');
const EXISTING_SHEET = arg('--sheet-id', '');

const APPS_SCRIPT_MANIFEST = JSON.stringify({
  timeZone: 'Asia/Ho_Chi_Minh',
  runtimeVersion: 'V8',
  exceptionLogging: 'STACKDRIVER',
  oauthScopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.external_request',
  ],
}, null, 2);

function fail(message) { console.error('LỖI: ' + message); process.exit(1); }

let TOKEN = '';
async function token() {
  if (TOKEN) return TOKEN;
  if (!fs.existsSync(CLASP_RC)) fail(`Không thấy ${CLASP_RC}. Chạy: clasp login`);
  const raw = JSON.parse(fs.readFileSync(CLASP_RC, 'utf8'));
  const t = raw && raw.tokens && raw.tokens.default;
  if (!t || !t.refresh_token) fail('~/.clasprc.json không có refresh_token. Chạy: clasp login');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  });
  const d = await r.json();
  if (!d.access_token) fail('Không đổi được access token: ' + JSON.stringify(d).slice(0, 200));
  TOKEN = d.access_token;
  return TOKEN;
}

async function api(url, options = {}) {
  const t = await token();
  const r = await fetch(url, { ...options, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  return { status: r.status, ok: r.ok, data };
}

async function createSheet(title) {
  const r = await api('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.spreadsheet' }),
  });
  if (!r.ok) fail(`Tạo Google Sheet thất bại (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data.id;
}

async function createBoundScript(sheetId, title) {
  const r = await api('https://script.googleapis.com/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ title, parentId: sheetId }),
  });
  if (!r.ok) {
    const message = (r.data.error && r.data.error.message) || JSON.stringify(r.data).slice(0, 250);
    if (/has not enabled the Apps Script API/i.test(message)) {
      fail('Tài khoản chưa bật Apps Script API.\n' +
        '  1. Mở https://script.google.com/home/usersettings\n' +
        '  2. Bật "Apps Script API"\n' +
        '  3. Nếu vừa bật, chờ vài phút rồi chạy lại.\n' +
        '  (Đây là cài đặt của tài khoản, KHÔNG phải thiếu quyền.)');
    }
    fail(`Tạo Apps Script thất bại (HTTP ${r.status}): ${message}`);
  }
  return r.data.scriptId;
}

async function pushCode(scriptId) {
  const code = fs.readFileSync(CODE_GS, 'utf8');
  const r = await api(`https://script.googleapis.com/v1/projects/${scriptId}/content`, {
    method: 'PUT',
    body: JSON.stringify({
      files: [
        { name: 'appsscript', type: 'JSON', source: APPS_SCRIPT_MANIFEST },
        { name: 'Code.gs', type: 'SERVER_JS', source: code },
      ],
    }),
  });
  if (!r.ok) fail(`Đẩy Code.gs thất bại (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  return code.length;
}

async function deployWebApp(scriptId) {
  const r = await api(`https://script.googleapis.com/v1/projects/${scriptId}/deployments`, {
    method: 'POST',
    // Thân request là DeploymentConfig PHẰNG, không có vỏ "deploymentConfig".
    // Gửi có vỏ thì API trả 400: Unknown name "deploymentConfig".
    body: JSON.stringify({
      scriptId,
      versionNumber: 1,
      manifestFileName: 'appsscript',
      description: 'CRM CN Tax Tools — do tools/provision-crm.cjs tao',
    }),
  });
  if (!r.ok) fail(`Deploy web app thất bại (HTTP ${r.status}): ${JSON.stringify(r.data).slice(0, 300)}`);
  const id = r.data.deploymentId || (r.data.deploymentConfig && r.data.deploymentConfig.deploymentId);
  return `https://script.google.com/macros/s/${id}/exec`;
}

(async () => {
  console.log('=== Dựng CRM mới ===\n');

  // ---- Kiểm tra điều kiện trước ----
  await token();
  const whoami = await api('https://www.googleapis.com/oauth2/v2/userinfo');
  if (!whoami.ok) fail('Token không đọc được thông tin người dùng. Chạy lại clasp login.');
  console.log(`Tài khoản đang đăng nhập: ${whoami.data.email}`);
  if (!APPLY) {
    console.log(`\nBật Apps Script API cho tài khoản này tại:`);
    console.log(`  https://script.google.com/home/usersettings\n`);
    console.log(`Cần dựng:\n  Sheet : ${EXISTING_SHEET || '(tạo mới) ' + TITLE}\n  Script: ${TITLE}\n`);
    console.log('Chạy lại với --apply để tạo thật.');
    return;
  }

  // ---- 1. Sheet ----
  let sheetId = EXISTING_SHEET;
  if (sheetId) {
    console.log(`1. Dùng lại Sheet có sẵn: ${sheetId}`);
  } else {
    sheetId = await createSheet(TITLE);
    console.log(`1. Đã tạo Google Sheet: ${sheetId}`);
    console.log(`   Mở: https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  }

  // ---- 2. Script gắn vào Sheet ----
  const scriptId = await createBoundScript(sheetId, TITLE);
  console.log(`2. Đã tạo Apps Script gắn vào Sheet: ${scriptId}`);
  console.log(`   Mở: https://script.google.com/d/${scriptId}/edit`);

  // ---- 3. Code ----
  const bytes = await pushCode(scriptId);
  console.log(`3. Đã đẩy Code.gs (${bytes} bytes)`);

  // ---- 4. Deploy web app ----
  const gasUrl = await deployWebApp(scriptId);
  console.log(`4. Đã deploy Web App\n   URL: ${gasUrl}`);

  // ---- 5. Còn lại: phải làm tay ----
  const secret = crypto.randomBytes(24).toString('hex');
  console.log(`\n${'='.repeat(64)}`);
  console.log('CÒN 1 VIỆC PHẢI LÀM TAY (Apps Script không có API ghi Script Property):');
  console.log(`${'='.repeat(64)}\n`);
  console.log('  1. Mở  https://script.google.com/d/' + scriptId + '/edit');
  console.log('  2. Bấm ⚙ Project Settings → Script Properties → Add property');
  console.log('       Name : GATEWAY_SHARED_SECRET');
  console.log('       Value: <dán dòng dưới>');
  console.log('  3. Lưu.\n');
  console.log('  Secret cần dùng (lưu lại, chỉ hiện 1 lần):');
  console.log('  ' + '-'.repeat(48));
  console.log('  ' + secret);
  console.log('  ' + '-'.repeat(48) + '\n');
  console.log('  4. Đưa cùng secret đó cho Cloudflare Worker (secret GAS_SHARED_SECRET):');
  console.log('     cd cloudflare-worker');
  console.log(`     $env:GAS_SHARED_SECRET = '${secret}'`);
  console.log(`     $env:GAS_URL = '${gasUrl}'`);
  console.log('     node deploy.mjs');
  console.log('\n  5. Tab + tiêu đề cột KHÔNG cần tạo tay — request đầu tiên sẽ tự dựng.');
  console.log('\n  Kiểm tra sau khi xong:');
  console.log(`     curl -X POST '${gasUrl}' -H 'Content-Type: application/json' \\`);
  console.log(`       -d '{"gatewaySecret":"${secret}","action":"get_notice"}'`);
  console.log('     Trả {"ok":true,...} là chạy được.');
  fs.writeFileSync(path.join(__dirname, '..', '.crm-new.json'), JSON.stringify({ sheetId, scriptId, gasUrl, gatewaySecret: secret }, null, 2));
  console.log('\n  Đã lưu thông tin ở .crm-new.json (đã gitignore — xoá sau khi dùng xong).');
})().catch(error => { console.error('LỖI: ' + (error && error.message ? error.message : String(error))); process.exit(1); });
