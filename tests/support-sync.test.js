'use strict';
// ---------------------------------------------------------------------------
// TÍN HIỆU KHÁCH ↔ MÁY CHỦ — mở app đồng bộ một lần, app chạy nền chỉ hỏi khi
// thật sự có dấu hiệu cần hỏi.
//
// Trước đây app mở lên gọi /devices/register rồi /notices/current (hai lần vào
// Apps Script), và bộ kiểm tra bản quyền bị gọi từ 22 chỗi trong server.js.
// Ở đây gom về một chuyến, và phần nền chỉ hỏi khi needsServerCheck() có lý do.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SupportStore } = require('../src/support');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const MACHINE = 'DEV_MAYTHUTEST0001';

test('source app can opt into the release gateway while tests and explicit local stay offline', () => {
  const dir = tempDir('hd-gateway-default-');
  try {
    assert.equal(new SupportStore(dir, { machineId: MACHINE }).gatewayUrl(), '');
    const store = new SupportStore(dir, { machineId: MACHINE, useDefaultGateway: true });
    assert.equal(store.gatewayUrl(), 'https://hoadon-support-gateway.linhnhaxac10.workers.dev');
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: 'local' }));
    assert.equal(store.gatewayUrl(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('human handoff registers a missing token before sending and shares concurrent registration', async () => {
  await withStore(url => url === '/v1/devices/register' ? { sessionToken: 'fixture-support-session' } : { aiAllowed: false, control: { mode: 'waiting', revision: 1 } }, async (store, seen) => {
    store.data.device.registeredAt = Date.now(); // Local registration alone is not a remote session.
    await Promise.all([store.beginUnified('Admin', 'GLOBAL', [], true), store.beginUnified('Hỗ trợ', 'GLOBAL', [], true)]);
    assert.equal(seen.filter(row => row.url === '/v1/devices/register').length, 1);
    assert.equal(seen.filter(row => row.url === '/v1/chats/messages').length, 2);
    assert.ok(seen.filter(row => row.url === '/v1/chats/messages').every(row => row.input.wantsAdmin));
  });
});

// Gateway giả: ghi lại mọi request và trả về tuỳ từng đường dẫn.
function fakeGateway(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}');
      seen.push({ url: req.url, input });
      const value = handler ? handler(req.url, input) : {};
      if (value === null) return res.writeHead(500).end('{"ok":false,"error":"CRM down"}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

async function withStore(handler, fn) {
  const { server, seen, port } = await fakeGateway(handler);
  const dir = tempDir('hd-sync-');
  fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
  try { return await fn(new SupportStore(dir, { machineId: MACHINE }), seen); }
  finally { server.close(); }
}

test('mở app: MỘT chuyến /v1/sync lấy cả bản quyền + thông báo + token phiên', async () => {
  await withStore((url) => {
    if (url !== '/v1/sync') return {};
    return { status: 'Active', expiryAt: '2099-12-31', keyName: 'KEY-1', trial: false, sessionToken: 'tok-1', notice: { text: 'Bảo trì lúc 2h sáng', updatedAt: 111 } };
  }, async (store, seen) => {
    const result = await store.sync('mo-app');

    assert.equal(seen.length, 1, 'phải đúng MỘT chuyến, không phải hai chuyến');
    assert.equal(seen[0].url, '/v1/sync');
    assert.equal(result.license.status, 'Active');
    assert.equal(result.license.expiryAt, '2099-12-31');
    assert.equal(result.notice.text, 'Bảo trì lúc 2h sáng');
    assert.equal(store.data.license.sessionToken, 'tok-1');
    assert.equal(store.data.device.registeredAt > 0, true);
    // Mã máy ổn định + phiên bản app phải đi kèm để Gateway ghi nhận diện và
    // bản ghi nhớ "ai đang dùng phiên bản nào".
    assert.equal(seen[0].input.machineId, MACHINE);
    assert.ok(seen[0].input.appVersion);
  });
});

test('hỏi nhẹ: bản ghi nhớ có sẵn thì chỉ đụng /v1/ping, KHÔNG gọi Apps Script', async () => {
  await withStore((url) => {
    if (url === '/v1/ping') return { license: { status: 'Locked', expiryAt: '2099-01-01', trial: false }, licenseCacheHit: true, serverTime: 1 };
    return {};
  }, async (store, seen) => {
    const result = await store.ping('nen');

    assert.deepEqual(seen.map(x => x.url), ['/v1/ping']);
    assert.equal(result.deep, false);
    // Admin vừa /lock trên Telegram thì app nhận ra ngay ở lần hỏi nhẹ kế tiếp.
    assert.equal(store.publicLicense().status, 'Locked');
    await assert.rejects(() => store.enforceLicense(), /đã bị khóa/);
  });
});

test('hỏi nhẹ: chưa có bản ghi nhớ thì tự hỏi đường đầy đủ một lần', async () => {
  await withStore((url) => {
    if (url === '/v1/ping') return { license: null, licenseCacheHit: false, serverTime: 1 };
    if (url === '/v1/sync') return { status: 'Trial', expiryAt: '', trial: true, trialDays: 30, sessionToken: 'tok-2', notice: null };
    return {};
  }, async (store, seen) => {
    const result = await store.ping('nen');

    assert.deepEqual(seen.map(x => x.url), ['/v1/ping', '/v1/sync']);
    assert.equal(result.deep, true);
    assert.equal(store.publicLicense().status, 'Trial');
  });
});

test('CRM lỗi lúc mở app thì giữ nguyên thông tin đã lưu, không mất bản quyền', async () => {
  await withStore(() => null, async (store) => {
    store.data.device.firstInstallAt = Date.now() - 400 * DAY;
    store.data.license = { status: 'Active', key: 'KEY-CU', keyName: 'KEY-CU', expiryAt: '2099-01-01', updatedAt: Date.now(), checkedAt: Date.now() };
    store.save();

    await assert.rejects(() => store.sync('mo-app'));
    assert.equal(store.data.license.status, 'Active');
    assert.equal(store.data.license.expiryAt, '2099-01-01');
    await assert.doesNotReject(() => store.enforceLicense());
  });
});

// ---------------------------------------------------------------------------
// needsServerCheck — quyết định có gọi mạng hay không. Đây là phần tiết kiệm
// nhiều nhất: mọi nhịp mà không có dấu hiệu thì KHÔNG gọi gì cả.
// ---------------------------------------------------------------------------
test('needsServerCheck: không có dấu hiệu gì thì KHÔNG hỏi mạng', async () => {
  await withStore(() => ({}), async (store) => {
    store.data.license = { status: 'Active', key: 'K', expiryAt: '2099-01-01', updatedAt: Date.now(), checkedAt: Date.now() };
    store.save();
    assert.equal(store.needsServerCheck(), '', 'key còn dài, vừa hỏi xong thì im');

    store.data.license.status = 'Trial';
    store.data.license.checkedAt = Date.now() - HOUR;
    store.data.license.expiryAt = '';
    store.save();
    assert.equal(store.needsServerCheck(), '', 'đang dùng thử, hạn dài, vừa hỏi xong thì im');
  });
});

test('needsServerCheck: key sắp hết hạn thì hỏi (để biết có được gia hạn không)', async () => {
  await withStore(() => ({}), async (store) => {
    const soon = new Date(Date.now() + 5 * DAY);
    const ymd = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    store.data.license = { status: 'Active', key: 'K', expiryAt: ymd, updatedAt: Date.now(), checkedAt: Date.now() };
    store.save();
    assert.equal(store.needsServerCheck(), 'key-sap-het-han');
  });
});

test('needsServerCheck: chưa hỏi lần nào, hoặc hỏi lâu rồi, hoặc mã máy bị lệch', async () => {
  await withStore(() => ({}), async (store) => {
    store.data.license = { status: 'Active', key: 'K', expiryAt: '2099-01-01', updatedAt: Date.now() };
    store.save();
    assert.equal(store.needsServerCheck(), 'chua-hoi-lan-nao', 'chưa từng hỏi được thì phải hỏi');

    store.data.license.checkedAt = Date.now() - 5 * HOUR;
    store.save();
    assert.equal(store.needsServerCheck(), 'da-lau-chua-hoi', 'quá 4 giờ thì hỏi nhẹ một lần');

    store.data.license.checkedAt = Date.now();
    store.save();
    store.data.device.syncMismatch = true;
    store.save();
    assert.equal(store.needsServerCheck(), 'may-id-lech', 'mã máy lệch thì phải hỏi ngay');
  });
});

test('needsServerCheck: không có Gateway thì không hỏi (chạy local mock)', async () => {
  const store = new SupportStore(tempDir('hd-local-'));
  assert.equal(store.needsServerCheck(), '');
});

test('sync() phát hiện máy chủ đang ghi máy này vào dòng KHÁC và báo lệch', async () => {
  await withStore((url) => url === '/v1/sync'
    ? { status: 'Active', expiryAt: '2099-01-01', machineId: 'DEV_MAYKHAC00000002', sessionToken: 't', notice: null }
    : {}, async (store) => {
    await store.sync('mo-app');
    assert.equal(store.data.device.syncMismatch, true);
    assert.equal(store.needsServerCheck(), 'may-id-lech');
  });
});

test('saveLicense không bao giờ xoá hạn đã biết bằng giá trị rỗng', async () => {
  await withStore(() => ({}), async (store) => {
    store.saveLicense({ status: 'Active', expiryAt: '2099-12-31' });
    assert.equal(store.data.license.expiryAt, '2099-12-31');

    store.saveLicense({ status: '', expiryAt: '' });
    assert.equal(store.data.license.expiryAt, '2099-12-31', 'không được xoá hạn đã biết');
    assert.equal(store.data.license.status, 'Active', 'không được hạ cấp trạng thái vì máy chủ trả rỗng');

    // Đổi sang một ngày khác thì vẫn phải nhận — đó là thay đổi thật.
    store.saveLicense({ status: 'Active', expiryAt: '2030-01-01' });
    assert.equal(store.data.license.expiryAt, '2030-01-01');
  });
});
