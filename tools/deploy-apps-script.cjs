'use strict';
// ---------------------------------------------------------------------------
// DEPLOY GOOGLE APPS SCRIPT bằng credential clasp đã lưu sẵn trên máy.
//
// Vì sao không dùng `clasp push`:
//   Script này là CONTAINER-BOUND (dùng SpreadsheetApp.getActive()), và `clasp push`
//   đòi có appsscript.json — push sẽ GHI ĐÈ manifest, tức là đổi OAuth scopes của
//   script đang chạy production. Rủi ro lớn hơn nhiều so với vài phút tiện lợi.
//
// Cách làm ở đây:
//   1. Đọc toàn bộ nội dung script hiện tại (kèm manifest) và LƯU LẠI bản sao lưu.
//   2. So sánh Code.gs mới với bản đang chạy, in ra số dòng thêm/bớt.
//   3. PUT /content với ĐÚNG danh sách file cũ, chỉ thay thế nội dung Code.gs.
//      Manifest giữ nguyên byte-for-byte.
//   4. Tạo REVISION mới cho deployment đang chạy (createRevision) — GIỮ NGUYÊN
//      URL deployment. Dùng PUT /deployments sẽ sinh URL mới và làm hỏng GAS_URL.
//
// DÙNG
//   node tools/deploy-apps-script.cjs            # chỉ xem, không ghi
//   node tools/deploy-apps-script.cjs --apply    # thực sự deploy
//   node tools/deploy-apps-script.cjs --apply --yes
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const argOf = (flag, fallback = '') => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SCRIPT_ID = argOf('--script-id') || process.env.APPS_SCRIPT_ID || '';
const SOURCE = path.join(__dirname, '..', 'support-gateway', 'apps-script', 'Code.gs');
const CLASP_RC = path.join(os.homedir(), '.clasprc.json');

const APPLY = process.argv.includes('--apply');

function fail(message) { console.error('LỖI: ' + message); process.exit(1); }

// ---------------------------------------------------------------------------
// Token: lấy access_token mới từ refresh_token trong ~/.clasprc.json
// ---------------------------------------------------------------------------
function claspTokens() {
  if (!fs.existsSync(CLASP_RC)) fail(`Không thấy ${CLASP_RC}. Chạy: clasp login`);
  const raw = JSON.parse(fs.readFileSync(CLASP_RC, 'utf8'));
  const tokens = raw && raw.tokens && raw.tokens.default;
  if (!tokens || !tokens.refresh_token) fail('~/.clasprc.json không có refresh_token. Chạy: clasp login');
  return tokens;
}

let cachedToken = '';
async function accessToken() {
  if (cachedToken) return cachedToken;
  const t = claspTokens();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: t.client_id,
      client_secret: t.client_secret,
      refresh_token: t.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!data.access_token) fail('Không đổi được access token: ' + JSON.stringify(data).slice(0, 300));
  cachedToken = data.access_token;
  return cachedToken;
}

async function api(method, endpoint, body) {
  const token = await accessToken();
  const response = await fetch('https://script.googleapis.com/v1/' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { fail(`${method} ${endpoint} → HTTP ${response.status}, không phải JSON: ${text.slice(0, 300)}`); }
  if (!response.ok) {
    const message = data.error && data.error.message ? data.error.message : text.slice(0, 300);
    fail(`${method} ${endpoint} → HTTP ${response.status}: ${message}`);
  }
  return data;
}

const diff = (before, after) => {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  let changed = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed++;
  return { added: b.length - a.length, changed };
};

(async () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  console.log(`Nguồn     : ${path.relative(process.cwd(), SOURCE)} (${source.length} bytes, ${source.split('\n').length} dòng)`);
  if (!APPLY) console.log('\n(Chế độ xem — thêm --apply để deploy)');
  if (!SCRIPT_ID) {
    console.log('\nThiếu Script ID. Lấy ở: Google Sheet → Extensions → Apps Script');
    console.log('  → bấm tên project → "Project settings" → Script ID (dạng 1XU3Qx...)');
    console.log('  rồi chạy: node tools/deploy-apps-script.cjs --script-id <ID> [--apply]');
    process.exit(1);
  }
  console.log(`Script ID : ${SCRIPT_ID}`);

  const meta = await api('GET', `projects/${SCRIPT_ID}`);
  const content = await api('GET', `projects/${SCRIPT_ID}/content`);
  const files = content.files || [];

  const stamp = meta.updateTime ? new Date(meta.updateTime) : null;
  console.log(`\nScript trên Google: "${meta.title}"`);
  console.log(`  cập nhật cuối : ${stamp && !isNaN(stamp) ? stamp.toLocaleString('vi-VN') : '(không rõ)'}`);
  console.log(`  file hiện có  : ${files.map(f => f.name).join(', ')}`);

  // ---- Sao lưu trước khi đụng vào ----
  const backupName = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backup', 'apps-script');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `google-${backupName}`);
  fs.mkdirSync(backupPath, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(backupPath, file.name.replace(/[\\/]/g, '_') + (file.type === 'JSON' ? '.json' : '.gs')), String(file.source || ''));
  }
  console.log(`  đã sao lưu   : ${path.relative(process.cwd(), backupPath)} (${files.length} file)`);

  // ---- So sánh ----
  const live = files.find(f => f.name === 'Code.gs');
  if (!live) {
    console.log(`\n✗ Script này KHÔNG phải script CRM — không có file "Code.gs".`);
    console.log(`  Đang thấy: ${files.map(f => f.name).join(', ')}`);
    console.log('\n  Script CRM nằm ở MỘT TÀI KHOẢN GOOGLE KHÁC. Cách tìm:');
    console.log('  1. Mở Google Sheet đang làm CRM');
    console.log('  2. Extensions → Apps Script');
    console.log('  3. Trên thanh địa chỉ, bấm vào tên project (mũ tên xuống)');
    console.log('  4. "Project settings" → hiện Script ID (dạng 1XU3Qx... )');
    console.log('  5. Chạy lại: node tools/deploy-apps-script.cjs --script-id <ID>');
    console.log('  Hoặc: clasp login bằng đúng tài khoản sở hữu script đó.');
    process.exit(1);
  }
  if (String(live.source) === source) {
    console.log('\n✓ Code.gs trên Google ĐÃ GIỐNG hệt file trong repo. Không cần deploy.');
    return;
  }
  const d = diff(live.source, source);
  console.log(`\nKhác biệt: ${d.changed} dòng thay đổi (${d.added >= 0 ? '+' : ''}${d.added} dòng)`);

  if (!APPLY) {
    console.log('\nChạy lại với --apply để đưa lên Google.');
    return;
  }

  // ---- Ghi: thay ĐÚNG Code.gs, giữ nguyên mọi file còn lại (kể cả manifest) ----
  const payload = files.map(f => (f.name === 'Code.gs'
    ? { name: f.name, type: f.type, source }
    : { name: f.name, type: f.type, source: f.source }));
  await api('PUT', `projects/${SCRIPT_ID}/content`, { files: payload });
  console.log(`\n✓ Đã cập nhật nội dung script (${payload.length} file, manifest giữ nguyên).`);

  // ---- Tạo revision mới cho deployment đang chạy: GIỮ NGUYÊN URL ----
  const versionNumber = Date.now();
  const description = 'Ma may on dinh + khoa tao topic + /reset khong ket (CN Tax Tools)';
  await api('POST', `projects/${SCRIPT_ID}/deployments/${meta.deploymentId}/revisions`, {
    deploymentConfig: { scriptId: SCRIPT_ID, versionNumber },
  }).catch(error => {
    // createRevision đôi khi trả lỗi khi body phải là deploymentConfig; thử kiểu khác.
    return api('POST', `projects/${SCRIPT_ID}/deployments/${meta.deploymentId}/revisions`, { versionNumber });
  });

  console.log(`\n✓ Đã deploy.`);
  console.log(`  URL : https://script.google.com/macros/s/${meta.deploymentId}/exec`);
  console.log(`  (URL KHÔNG đổi — đây là revision mới của deployment cũ, không phải deployment mới.)`);
  console.log(`\nSao lưu nếu cần khôi phục: ${path.relative(process.cwd(), backupPath)}`);
})().catch(error => { console.error('LỖI: ' + (error && error.message ? error.message : String(error))); process.exit(1); });
