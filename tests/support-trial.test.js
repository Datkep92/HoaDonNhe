'use strict';
// Bước 2/3/5 của luồng bản quyền: dùng thử ngầm, trạng thái hiệu lực, giới hạn số máy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SupportStore, formatExpiry } = require('../src/support');

const TRIAL_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;
const tempDir = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('Bước 2: máy mới được dùng thử 3 ngày mà không cần key', async () => {
  const store = new SupportStore(tempDir('hd-trial-'));
  const license = store.publicLicense();
  assert.equal(license.status, 'Trial');
  assert.equal(license.trial, true);
  assert.equal(license.expiryAt, formatExpiry(new Date(store.data.device.firstInstallAt + TRIAL_DAYS * DAY)));
  const enforced = await store.enforceLicense();
  assert.equal(enforced.status, 'Trial');
});

test('Bước 2: hết hạn dùng thử thì yêu cầu nhập key', async () => {
  const store = new SupportStore(tempDir('hd-trial-over-'));
  store.data.device.firstInstallAt = Date.now() - (TRIAL_DAYS + 1) * DAY;
  store.save();
  assert.equal(store.publicLicense().status, 'Expired');
  await assert.rejects(() => store.enforceLicense(), new RegExp(`${TRIAL_DAYS} ngày dùng thử`));
});

test('Bước 3: trạng thái do máy chủ trả về được giữ nguyên', async () => {
  const store = new SupportStore(tempDir('hd-server-status-'));
  store.saveLicense({ status: 'Trial', expiryAt: '2099-01-01' });
  assert.equal(store.publicLicense().status, 'Trial');
  assert.equal(store.publicLicense().expiryAt, '2099-01-01');

  // /lock thắng cả hạn dùng thử và hạn key
  store.saveLicense({ status: 'Locked', expiryAt: '2000-01-01' });
  store.data.device.firstInstallAt = Date.now() - (TRIAL_DAYS + 1) * DAY;
  assert.equal(store.publicLicense().status, 'Locked');
  await assert.rejects(() => store.enforceLicense(), /đã bị khóa/);
});

test('Bước 4/5: đăng ký gửi Hardware Hash và key hết slot không được kích hoạt', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}');
      seen.push({ url: req.url, input });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/v1/devices/register') return res.end(JSON.stringify({ ok: true, value: { status: 'Trial', expiryAt: '2099-01-01', registered: true, sessionToken: 'session' } }));
      if (req.url === '/v1/licenses/status') return res.end(JSON.stringify({ ok: true, value: { status: 'Trial', expiryAt: '2099-01-01', sessionToken: 'session' } }));
      if (req.url === '/v1/licenses/activate') return res.end(JSON.stringify({ ok: true, value: { status: 'device_limit_exceeded', expiryAt: '2099-01-01', keyName: 'VIP-KEY-1', limit: 1 } }));
      return res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const dir = tempDir('hd-limit-');
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
    const store = new SupportStore(dir);

    await assert.rejects(() => store.activate('VIP-KEY-1'), /giới hạn số thiết bị/);
    assert.equal(store.data.license.key || '', '');
    assert.equal(store.publicLicense().status, 'Trial');

    const register = seen.find(entry => entry.url === '/v1/devices/register');
    assert.ok(register, 'phải gọi đăng ký trước khi kích hoạt');
    assert.match(register.input.hardwareHash, /^[0-9A-F]{64}$/);
    assert.equal(register.input.chatRoomId, store.data.device.chatRoomId);
  } finally {
    server.close();
  }
});

test('mã phòng của app không bị thay bằng id Topic Telegram', () => {
  const store = new SupportStore(tempDir('hd-room-'));
  const room = store.data.device.chatRoomId;
  store.saveLicense({ status: 'Active', expiryAt: '2099-01-01', chatRoomId: '123456' });
  assert.equal(store.data.device.chatRoomId, room);
  store.saveLicense({ status: 'Active', expiryAt: '2099-01-01', chatRoomId: 'ROOM_WIN_TESTROOM01' });
  assert.equal(store.data.device.chatRoomId, 'ROOM_WIN_TESTROOM01');
});

test('Bước 4: khách gửi Họ tên + SĐT khi bấm mua key', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ url: req.url, input: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: { status: 'Trial', expiryAt: '2099-01-01', sessionToken: 'session' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const dir = tempDir('hd-info-');
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
    const store = new SupportStore(dir);

    await assert.rejects(() => store.updateInfo('0912345678', 'A'), /Họ tên/);
    await assert.rejects(() => store.updateInfo('0912', 'Nguyễn Văn A'), /Số điện thoại/);
    assert.equal(store.data.device.phone || '', '');
    assert.equal(store.data.device.name || '', '');

    const saved = await store.updateInfo('0912 345 678', 'Nguyễn Văn A', 'Pro');
    assert.equal(saved.phone, '0912345678');
    assert.equal(saved.name, 'Nguyễn Văn A');
    assert.equal(saved.plan, 'Pro');
    assert.equal(store.data.device.phone, '0912345678');
    assert.equal(store.data.device.name, 'Nguyễn Văn A');
    assert.equal(store.data.device.plan, 'Pro');

    const register = seen.find(entry => entry.url === '/v1/devices/register');
    assert.ok(register, 'phải gửi thông tin liên hệ lên Gateway');
    assert.equal(register.input.phone, '0912345678');
    assert.equal(register.input.name, 'Nguyễn Văn A');
    assert.equal(register.input.plan, 'Pro');
  } finally {
    server.close();
  }
});

test('Offline grace: trong 3 ngày vẫn chạy, quá 3 ngày thì chặn', async () => {
  const dir = tempDir('hd-offline-');
  // Cổng chết: mọi request tới Gateway thất bại ngay (mô phỏng mất mạng).
  fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
  const store = new SupportStore(dir);

  store.saveLicense({ status: 'Active', expiryAt: '2099-01-01', keyName: 'KEY-OFFLINE' });

  // Kiểm tra thành công cách đây 1 ngày -> còn trong cửa sổ grace.
  store.data.license.checkedAt = Date.now() - DAY;
  store.save();
  const allowed = await store.enforceLicense();
  assert.equal(allowed.status, 'Active');
  assert.equal(allowed.offline, true);
  assert.ok(allowed.graceEndsAt > Date.now());

  // Kiểm tra cuối cách đây 5 ngày -> quá grace -> chặn kèm câu nói rõ lý do.
  store.data.license.checkedAt = Date.now() - 5 * DAY;
  store.save();
  await assert.rejects(() => store.enforceLicense(), /quá 3 ngày kể từ lần kiểm tra cuối/);

  // Trạng thái xấu đã biết thì chặn ngay, không grace.
  store.data.license.status = 'Locked';
  store.data.license.checkedAt = Date.now();
  store.save();
  await assert.rejects(() => store.enforceLicense(), /đã bị khóa/);

  // Hết hạn cục bộ cũng chặn ngay, không grace.
  store.data.license.status = 'Active';
  store.data.license.expiryAt = '2000-01-01';
  store.data.license.checkedAt = Date.now();
  store.save();
  await assert.rejects(() => store.enforceLicense(), /License Key đã hết hạn/);
});

test('Mất mạng khi cài mới: vẫn dùng thử theo đồng hồ cục bộ', async () => {
  const dir = tempDir('hd-offline-trial-');
  fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: 'http://127.0.0.1:1' }));
  const store = new SupportStore(dir);

  // Chưa từng kiểm tra được máy chủ nhưng vẫn phải chạy trong 3 ngày dùng thử.
  const trial = await store.enforceLicense();
  assert.equal(trial.status, 'Trial');
  assert.equal(trial.offline, true);

  // Quá hạn dùng thử cục bộ -> chặn bằng đúng câu dùng thử, không phải câu mất mạng.
  store.data.device.firstInstallAt = Date.now() - 5 * DAY;
  store.save();
  await assert.rejects(() => store.enforceLicense(), /3 ngày dùng thử/);
});
