'use strict';
// ---------------------------------------------------------------------------
// TÔ SÁNG MST PHIÊN GẦN NHẤT NGAY KHUNG HÌNH ĐẦU — ảnh chụp do MÁY CHỦ phát.
//
// Vì sao không chỉ dựa vào localStorage: server mở cổng NGẪU NHIÊN mỗi lần chạy
// (`server.listen(0, ...)`), nên origin đổi `http://127.0.0.1:51234` → `…:51877` sau mỗi lần mở
// app. localStorage khoá theo ORIGIN ⇒ cache ở đó KHÔNG BAO GIỜ đọc lại được giữa hai lần mở app.
// Cache phải đến từ chính máy chủ (nơi giữ du_lieu/accounts.json) qua `/boot-cache.js`, nạp TRƯỚC
// renderer.js để sidebar + dòng đang làm việc có mặt ngay khung hình đầu, không chờ /api/state.
//
// Test này khoá BỐN mặt: (1) đường /boot-cache.js trả JS hợp CSP, đúng MST đang chọn; (2) ảnh
// chụp KHÔNG chứa bí mật; (3) thứ tự nạp script trong index.html; (4) renderer ưu tiên ảnh chụp
// của máy chủ rồi mới tới localStorage, và vẫn hoà giải bằng /api/state.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    cwd: root,
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  let match = null;
  for (let i = 0; i < 300 && !match; i += 1) {
    match = out.match(/\{"testUrl":"[^"]+"/);
    if (!match) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!match) { child.kill(); throw new Error(`server không khởi động: ${out}`); }
  return { child, url: new URL(JSON.parse(`${match[0]}}`).testUrl), stop: () => child.kill() };
}

function getText(url, pathname) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: Number(url.port), path: pathname,
      headers: { Cookie: `hd_session=${url.searchParams.get('launch')}` },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    }).on('error', reject);
  });
}

// Chạy file JS thật của máy chủ trong một `window` giả — kiểm HÀNH VI, không chỉ so chuỗi.
function runBootCache(script) {
  const window = {};
  new Function('window', script)(window);
  return window.HD_BOOT_CACHE;
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-bootcache-'));
const writeAccounts = (dataDir, value) => fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(value, null, 2));

test('/boot-cache.js: ảnh chụp khung hình đầu có đúng MST đang chọn và danh sách MST', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [
      { mst: '1111111111', name: 'Hộ A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 900, removedAt: '' },
      { mst: '2222222222', name: 'Hộ B', label: 'B', lastVerifiedAt: 0, lastUsedAt: 100, removedAt: '' },
      { mst: '3333333333', name: 'Đã xoá', label: 'C', lastVerifiedAt: 0, lastUsedAt: 999, removedAt: '2026-01-01' },
    ],
    selected: '1111111111',
    output: '',
  });
  const server = await startServer(dataDir);
  try {
    const cache = await getText(server.url, '/boot-cache.js');
    assert.equal(cache.status, 200, 'phải trả 200 — cache hỏng không được chặn cả giao diện');
    assert.match(String(cache.text).slice(0, 60), /^window\.HD_BOOT_CACHE=/, 'phải là JS gán biến toàn cục cho trang');
    const snapshot = runBootCache(cache.text);
    assert.equal(snapshot.selected, '1111111111', 'tô sáng sẵn MST của phiên làm việc gần nhất');
    assert.deepEqual(snapshot.accounts.map(a => a.mst), ['1111111111', '2222222222'], 'bỏ hồ sơ đã xoá (removedAt)');
    assert.equal(snapshot.accounts[0].name, 'Hộ A');

    const state = JSON.parse((await getText(server.url, '/api/state?items=0')).text).value;
    assert.equal(snapshot.selected, state.selected, 'khung hình đầu phải tô sáng ĐÚNG dòng mà /api/state sẽ chọn');
    assert.deepEqual(snapshot.accounts.map(a => a.mst), state.accounts.map(a => a.mst),
      'thứ tự danh sách phải trùng /api/state, nếu không dòng sẽ nhảy chỗ khi dữ liệu thật về');
  } finally { server.stop(); }
});

test('/boot-cache.js: `selected` luôn nằm TRONG danh sách gửi đi (không có hồ sơ "ma")', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [{ mst: '1111111111', name: 'Hộ A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 100, removedAt: '' }],
    selected: '9999999999', // MST đã biến mất khỏi danh sách
    output: '',
  });
  const server = await startServer(dataDir);
  try {
    const snapshot = runBootCache((await getText(server.url, '/boot-cache.js')).text);
    const msts = snapshot.accounts.map(a => a.mst);
    assert.ok(msts.includes(snapshot.selected) || snapshot.selected === '',
      'selected trỏ ra ngoài danh sách ⇒ sidebar không tô sáng dòng nào, đúng cái "vô tri" cần tránh');
    assert.equal(snapshot.selected, '1111111111', 'phải rơi về MST còn hoạt động');
  } finally { server.stop(); }
});

test('/boot-cache.js: KHÔNG chứa token / cookie / mật khẩu / đường dẫn hồ sơ', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [{ mst: '1111111111', name: 'Hộ A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 100, removedAt: '' }],
    selected: '1111111111',
    output: '/du/lieu/that',
    token: 'mat-khau-that',
  });
  fs.mkdirSync(path.join(dataDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'secrets', '1111111111.json'), JSON.stringify({ password: 'mat-khau-that', token: 'jwt-that', cookies: 'session=abc' }));
  const server = await startServer(dataDir);
  try {
    const { text } = await getText(server.url, '/boot-cache.js');
    for (const secret of ['mat-khau-that', 'jwt-that', 'session=abc', 'password', 'token', 'cookies', 'profileDir', '/du/lieu/that']) {
      assert.ok(!text.includes(secret), `ảnh chụp khung hình đầu không được chứa ${secret}`);
    }
    const keys = Object.keys(runBootCache(text).accounts[0]).sort();
    assert.deepEqual(keys, ['identifiers', 'label', 'mst', 'name', 'remembered', 'session'],
      'chỉ giữ trường để VẼ dòng MST');
  } finally { server.stop(); }
});

test('index.html: nạp boot-cache.js TRƯỚC renderer.js (và hợp CSP script-src \'self\')', () => {
  const bootAt = indexHtml.indexOf('<script src="boot-cache.js"></script>');
  const rendererAt = indexHtml.indexOf('<script src="renderer.js"></script>');
  assert.ok(bootAt > -1, 'index.html phải nạp ảnh chụp MST của máy chủ');
  assert.ok(rendererAt > bootAt, 'phải nạp TRƯỚC renderer.js, nếu không khung hình đầu vẫn trống');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/.test(indexHtml),
    'CSP là script-src \'self\' — không được nhúng script inline (ảnh chụp phải đi qua file .js cùng origin)');
});

test('renderer: ưu tiên ảnh chụp của máy chủ, localStorage chỉ là đường dự phòng', () => {
  const pick = renderer.indexOf('function firstPaintMstList()');
  assert.ok(pick > -1, 'renderer.js phải có một chỗ chọn nguồn cache cho khung hình đầu');
  const body = renderer.slice(pick, pick + 700);
  assert.ok(body.includes('window.HD_BOOT_CACHE'), 'phải đọc ảnh chụp do máy chủ phát');
  assert.ok(body.indexOf('window.HD_BOOT_CACHE') < body.indexOf('readMstCache()'),
    'ảnh chụp máy chủ phải được ƯU TIÊN: localStorage mất hiệu lực khi cổng đổi mỗi lần mở app');
  assert.ok(renderer.includes('const cachedMstList = firstPaintMstList();'),
    'chỗ khởi động phải dùng nguồn đã chọn (không gọi thẳng readMstCache)');
  const hydration = renderer.indexOf('const cachedMstList = firstPaintMstList();');
  const firstRender = renderer.indexOf('render(current);\nrefresh();');
  assert.ok(hydration > -1 && firstRender > hydration, 'cache phải được nạp TRƯỚC nhịp /api/state đầu tiên');
  assert.ok(renderer.includes("if (cachedMstList) current = { ...current, accounts: cachedMstList.accounts, selected: cachedMstList.selected || '' };"),
    'cache phải đổ vào `current` để sidebar có dòng và tô sáng sẵn MST đang chọn');
  assert.ok(renderer.slice(renderer.indexOf('async function refresh()'), renderer.indexOf('async function refresh()') + 900).includes('writeMstCache(state);'),
    'ảnh chụp chỉ là nhịp đầu — dữ liệu thật về vẫn phải ghi đè');
});
