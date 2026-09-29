'use strict';
// ---------------------------------------------------------------------------
// Nhớ MST của phiên làm việc gần nhất qua các lần khởi động lại.
//   - Mỗi lần chọn một dòng, server ghi `accounts.selected` xuống du_lieu/accounts.json.
//   - Mở lại app: /api/state phải trả ĐÚNG MST đó để giao diện vào thẳng Tổng quan của khách
//     hàng ấy và tô sáng sẵn dòng tương ứng trong danh sách.
//   - Lựa chọn lưu có thể CŨ (MST đã bị xoá / không còn tồn tại): KHÔNG được mở vào hồ sơ "ma" —
//     phải rơi về MST dùng gần nhất còn hoạt động và ghi lại lựa chọn đã sửa.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function startServer(dataDir) {
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    cwd: path.join(__dirname, '..'),
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
  const url = new URL(JSON.parse(`${match[0]}}`).testUrl);
  return { child, url, stop: () => child.kill() };
}

function getJson(url, pathname) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: Number(url.port), path: pathname,
      headers: { Cookie: `hd_session=${url.searchParams.get('launch')}` },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    }).on('error', reject);
  });
}

const writeAccounts = (dataDir, value) => fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(value, null, 2));
const readAccounts = dataDir => JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-remember-'));

test('khôi phục đúng MST đang chọn khi mở lại app', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [
      { mst: '1111111111', name: 'A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 100, removedAt: '' },
      { mst: '2222222222', name: 'B', label: 'B', lastVerifiedAt: 0, lastUsedAt: 900, removedAt: '' },
    ],
    selected: '1111111111',
    output: '',
  });
  const server = await startServer(dataDir);
  try {
    const state = await getJson(server.url, '/api/state?items=0');
    assert.equal(state.ok, true);
    // Đúng MST ĐÃ LƯU, không phải MST dùng gần nhất: người dùng đang làm việc ở 1111111111.
    assert.equal(state.value.selected, '1111111111', 'phải mở lại đúng MST của phiên gần nhất');
    assert.ok(state.value.accounts.some(a => a.mst === '1111111111'), 'dòng MST phải có trong danh sách để tô sáng');
  } finally { server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('MST đã chọn đã bị xoá ⇒ mở lại MST dùng gần nhất còn hoạt động và ghi lại lựa chọn', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [
      { mst: '1111111111', name: 'A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 500, removedAt: '' },
      { mst: '2222222222', name: 'B', label: 'B', lastVerifiedAt: 0, lastUsedAt: 900, removedAt: '' },
      { mst: '3333333333', name: 'C', label: 'C', lastVerifiedAt: 0, lastUsedAt: 9999, removedAt: '2026-01-01T00:00:00.000Z' },
    ],
    selected: '3333333333',
    output: '',
  });
  const server = await startServer(dataDir);
  try {
    const state = await getJson(server.url, '/api/state?items=0');
    assert.equal(state.value.selected, '2222222222', 'không được mở vào MST đã xoá; phải rơi về MST dùng gần nhất');
    assert.ok(!(state.value.accounts || []).some(a => a.mst === '3333333333'), 'MST đã xoá không nằm trong danh sách hiển thị');
    assert.equal(readAccounts(dataDir).selected, '2222222222', 'lựa chọn đã sửa phải được ghi lại để lần sau khỏi tính lại');
  } finally { server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('MST đã chọn không còn tồn tại trong danh sách ⇒ rơi về MST dùng gần nhất', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, {
    accounts: [
      { mst: '1111111111', name: 'A', label: 'A', lastVerifiedAt: 0, lastUsedAt: 300, removedAt: '' },
      { mst: '2222222222', name: 'B', label: 'B', lastVerifiedAt: 0, lastUsedAt: 700, removedAt: '' },
    ],
    selected: '9999999999',
    output: '',
  });
  const server = await startServer(dataDir);
  try {
    const state = await getJson(server.url, '/api/state?items=0');
    assert.equal(state.value.selected, '2222222222');
  } finally { server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('danh sách rỗng ⇒ không có MST nào được chọn (không tự bịa MST)', async () => {
  const dataDir = tempDir();
  writeAccounts(dataDir, { accounts: [], selected: '1111111111', output: '' });
  const server = await startServer(dataDir);
  try {
    const state = await getJson(server.url, '/api/state?items=0');
    assert.equal(state.value.selected, '');
  } finally { server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
