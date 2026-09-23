'use strict';
// ---------------------------------------------------------------------------
// Test cho Google Apps Script: support-gateway/apps-script/Code.gs
//
// Vì sao có file này: mọi action của GAS phải trả `{ ok: true, value: ... }` cho
// Gateway. Một hàm quên `return` — hoặc dùng một biến không tồn tại — làm câu trả
// lời mất hẳn trường `value`, và phía app chỉ thấy lỗi rất mơ hồ (đã từng xảy ra:
// `get_notice` trả về không có `value`, và `rebindDevice_` dùng biến `roomId` không
// tồn tại nên `register_device` chết âm thầm khi Sheet có tab Bindings).
//
// Test chạy GAS thật trong sandbox Node với SpreadsheetApp/ContentService giả, nên
// nó bắt được cả hai loại lỗi trên trước khi deploy.
// ---------------------------------------------------------------------------
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GAS_PATH = path.join(__dirname, '..', 'support-gateway', 'apps-script', 'Code.gs');
const MIRROR_PATH = path.join(__dirname, '..', 'src', 'code.gs.txt');
const SOURCE = fs.readFileSync(GAS_PATH, 'utf8');
const SECRET = 'gateway-secret-for-tests';

const DEVICE_HEADERS = ['Hardware ID', 'Chat Room ID', 'License Key', 'Status', 'Expiry Date', 'First Install Time', 'Last Seen Time', 'Hardware Hash'];
const LICENSE_HEADERS = ['License Key', 'Status', 'Expiry Date', 'Hardware ID', 'Chat Room ID', 'Activated At'];
const BINDING_HEADERS = ['License Key', 'Hardware ID', 'Chat Room ID', 'Activated At'];

const DEVICE = {
  installationId: '11111111-2222-4333-8444-555555555555',
  chatRoomId: 'ROOM_WIN_TEST0001',
  hardwareHash: 'A'.repeat(64),
};
const OLD_INSTALL = '99999999-8888-4777-8666-555555555555';
const OLD_ROOM = 'ROOM_WIN_OLD00001';
const KEY = 'KEY-TEST0001';
const ROOM = 'ROOM_WIN_CHAT0001';

const days = count => new Date(Date.now() + count * 86400000);

function makeSheet(name, header, rows) {
  const values = [header.slice(), ...rows.map(row => row.slice())];
  return {
    getName: () => name,
    getDataRange: () => ({ getValues: () => values.map(row => row.slice()) }),
    getRange: (row, col) => ({
      setValue: value => {
        while (values.length < row) values.push([]);
        const target = values[row - 1];
        while (target.length < col) target.push('');
        target[col - 1] = value;
      },
    }),
    appendRow: row => values.push(row.slice()),
    deleteRow: row => { values.splice(row - 1, 1); },
    __values: values,
  };
}

function load(sheets, options = {}) {
  const byName = new Map(sheets.map(sheet => [sheet.getName(), sheet]));
  let uuid = 0;
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => (name === 'GATEWAY_SHARED_SECRET' ? (options.secret === undefined ? SECRET : options.secret) : null),
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }),
    },
    SpreadsheetApp: { getActive: () => ({ getSheetByName: name => byName.get(name) || null }) },
    Utilities: {
      getUuid: () => {
        uuid += 1;
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, '0')}`;
      },
      formatDate: value => {
        const date = new Date(value);
        return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

function post(ctx, body) {
  const output = ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  return JSON.parse(output.getContent());
}

function withDevice(requests, overrides = {}) {
  return requests.map(request => ({ gatewaySecret: SECRET, ...overrides, ...request }));
}

function standardCtx(extraSheets = [], devices = [], options = {}) {
  return load([
    makeSheet('Devices', DEVICE_HEADERS, devices),
    makeSheet('Licenses', LICENSE_HEADERS, []),
    ...extraSheets,
  ], options);
}

test('bản Code.gs trong support-gateway và bản sao src/code.gs.txt phải giống nhau', () => {
  assert.equal(SOURCE, fs.readFileSync(MIRROR_PATH, 'utf8'));
});

test('sai gatewaySecret hoặc action lạ đều bị từ chối', () => {
  const ctx = standardCtx();
  const wrongSecret = post(ctx, { gatewaySecret: 'sai', action: 'license_status', ...DEVICE });
  assert.equal(wrongSecret.ok, false);
  const unknown = post(ctx, { gatewaySecret: SECRET, action: 'khong_ton_tai', ...DEVICE });
  assert.equal(unknown.ok, false);
});

test('register_device: máy mới được ghi vào Sheet và trả đủ value', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, []);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [])]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, phone: '', name: '', plan: '' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, true);
  assert.equal(res.value.status, 'Trial');
  assert.equal(res.value.chatRoomId, DEVICE.chatRoomId);
  assert.equal(devices.__values.length, 2);
  assert.equal(devices.__values[1][0], DEVICE.installationId);
});

test('register_device: rebind theo Hardware Hash khi Sheet CÓ tab Bindings (regression: biến roomId không tồn tại)', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[OLD_INSTALL, OLD_ROOM, KEY, 'Active', days(90), days(-20), days(-20), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), OLD_INSTALL, OLD_ROOM, days(-20)]]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, OLD_INSTALL, '', days(-20)]]);
  const ctx = load([devices, licenses, bindings]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, false);
  assert.equal(res.value.status, 'Active', 'rebind phải giữ nguyên liên kết bản quyền của máy');
  assert.equal(devices.__values[1][0], DEVICE.installationId);
  assert.equal(licenses.__values[1][3], DEVICE.installationId);
  assert.equal(bindings.__values[1][1], DEVICE.installationId);
  assert.equal(bindings.__values[1][2], DEVICE.chatRoomId, 'ô phòng chat trống thì điền phòng mới');
});

test('register_device: rebind KHÔNG ghi đè phòng chat đã có, và chịu được tab Bindings thiếu cột', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[OLD_INSTALL, OLD_ROOM, KEY, 'Active', days(90), days(-20), days(-20), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), OLD_INSTALL, OLD_ROOM, days(-20)]]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, OLD_INSTALL, 'ROOM_WIN_KEEP0001', days(-20)]]);
  const ctx = load([devices, licenses, bindings]);

  const kept = post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.equal(bindings.__values[1][2], 'ROOM_WIN_KEEP0001');
  assert.equal(bindings.__values[1][1], DEVICE.installationId);

  const noRoomColumn = makeSheet('Bindings', ['License Key', 'Hardware ID', 'Activated At'], [[KEY, DEVICE.installationId, days(-20)]]);
  const ctx2 = load([
    makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-20), days(-20), DEVICE.hardwareHash]]),
    makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-20)]]),
    noRoomColumn,
  ]);
  const missingColumn = post(ctx2, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(missingColumn.ok, true, JSON.stringify(missingColumn));
  assert.equal(missingColumn.value.status, 'Active');
});

test('license_status: thiết bị chưa có trong Sheet trả value (không mất trường value)', () => {
  const ctx = standardCtx();
  const res = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, 'Unactivated');
});

test('license_status: dùng thử luôn tính từ First Install Time của máy chủ', () => {
  const ctx = standardCtx([], [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const trial = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(trial.ok, true, JSON.stringify(trial));
  assert.equal(trial.value.status, 'Trial');
  assert.equal(trial.value.trial, true);

  const expired = load([
    makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-10), days(-10), DEVICE.hardwareHash]]),
    makeSheet('Licenses', LICENSE_HEADERS, []),
  ]);
  const after = post(expired, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(after.value.status, 'Expired');
});

test('verify_key: kích hoạt key hợp lệ, và key không tồn tại thì báo lỗi rõ ràng', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), '', '', days(-1)]]);
  const ctx = load([devices, licenses]);

  const activated = post(ctx, { gatewaySecret: SECRET, action: 'verify_key', ...DEVICE, key: KEY });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(activated.value.status, 'Active');
  assert.equal(activated.value.keyName, KEY);
  assert.equal(devices.__values[1][2], KEY);
  assert.equal(devices.__values[1][3], 'Active');
  assert.equal(licenses.__values[1][3], DEVICE.installationId);

  const wrong = post(ctx, { gatewaySecret: SECRET, action: 'verify_key', ...DEVICE, key: 'KEY-KHONG-CO' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /does not exist/);
});

test('verify_key: key hết slot máy trả device_limit_exceeded kèm value', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', [...LICENSE_HEADERS, 'Max Devices'], [[KEY, 'Active', days(90), OLD_INSTALL, OLD_ROOM, days(-5), 1]]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, OLD_INSTALL, OLD_ROOM, days(-5)]]);
  const ctx = load([devices, licenses, bindings]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'verify_key', ...DEVICE, key: KEY });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, 'device_limit_exceeded');
  assert.equal(res.value.limit, 1);
});

test('get_notice: chưa cấu hình tab Settings thì trả value = null, không mất trường value', () => {
  const ctx = standardCtx();
  const res = post(ctx, { gatewaySecret: SECRET, action: 'get_notice', ...DEVICE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Object.prototype.hasOwnProperty.call(res, 'value'), 'phải có trường value (kể cả null)');
  assert.equal(res.value, null);
});

test('get_notice: có dòng Notice trong tab Settings thì trả nội dung', () => {
  const settings = makeSheet('Settings', ['Key', 'Value'], [['Notice', 'Bảo trì lúc 22h tối nay']]);
  const ctx = standardCtx([settings]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'get_notice', ...DEVICE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.text, 'Bảo trì lúc 22h tối nay');
  assert.ok(res.value.updatedAt > 0);

  const blank = makeSheet('Settings', ['Key', 'Value'], [['Notice', '   ']]);
  const empty = post(standardCtx([blank]), { gatewaySecret: SECRET, action: 'get_notice', ...DEVICE });
  assert.equal(empty.value, null);
});

test('admin_command: /check, lệnh lạ và phòng chat không có thiết bị đều trả value', () => {
  const devices = makeSheet('Devices', [...DEVICE_HEADERS, 'Phone', 'Name', 'Plan'], [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(30), days(-3), days(-3), DEVICE.hardwareHash, '0900000000', 'Khách A', '1 năm']]);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(30), DEVICE.installationId, DEVICE.chatRoomId, days(-3)]])]);

  const check = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/check' });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.value.found, true);
  assert.match(check.value.reply, /THÔNG TIN BẢN QUYỀN/);
  assert.match(check.value.reply, /Khách A/);

  const unknown = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/xyz' });
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.match(unknown.value.reply, /Không hiểu lệnh/);

  const missing = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: 'ROOM_WIN_KHONGCO1', text: '/check' });
  assert.equal(missing.ok, true, JSON.stringify(missing));
  assert.equal(missing.value.found, false);
});

test('admin_command: /extend cập nhật cả Devices và Licenses; /lock rồi /unlock đổi đúng trạng thái', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(10), days(-3), days(-3), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(10), DEVICE.installationId, DEVICE.chatRoomId, days(-3)]]);
  const ctx = load([devices, licenses]);

  const extended = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/extend 30' });
  assert.equal(extended.ok, true, JSON.stringify(extended));
  const deviceExpiry = devices.__values[1][4];
  const licenseExpiry = licenses.__values[1][2];
  assert.ok(new Date(deviceExpiry).getTime() > days(10).getTime() - 1000);
  assert.equal(new Date(licenseExpiry).getTime(), new Date(deviceExpiry).getTime(), 'hai sheet phải khớp hạn');

  const locked = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/lock' });
  assert.equal(devices.__values[1][3], 'Locked');
  assert.match(locked.value.reply, /khóa/i);
  const lockedStatus = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(lockedStatus.value.status, 'Locked');

  post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/unlock' });
  assert.equal(devices.__values[1][3], 'Active');
});

test('mọi action thành công đều phải có trường value (không hàm nào quên return)', () => {
  const settings = makeSheet('Settings', ['Key', 'Value'], [['Notice', 'Thông báo test']]);
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(30), days(-3), days(-3), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(30), DEVICE.installationId, DEVICE.chatRoomId, days(-3)]]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, DEVICE.installationId, DEVICE.chatRoomId, days(-3)]]);
  const ctx = load([devices, licenses, bindings, settings]);

  const other = '22222222-3333-4444-8555-666666666666';
  const requests = withDevice([
    { action: 'license_status', ...DEVICE },
    { action: 'get_notice', ...DEVICE },
    { action: 'register_device', installationId: other, chatRoomId: DEVICE.chatRoomId, hardwareHash: 'B'.repeat(64) },
    { action: 'verify_key', ...DEVICE, key: KEY },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/check' },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/new thang 2' },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/extend 5' },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/lock' },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/unlock' },
    { action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/reset' },
  ]);

  for (const request of requests) {
    const res = post(ctx, request);
    assert.equal(res.ok, true, `${request.action} thất bại: ${JSON.stringify(res)}`);
    assert.ok(Object.prototype.hasOwnProperty.call(res, 'value'), `${request.action} thiếu trường value`);
    assert.notEqual(res.value, undefined, `${request.action} trả value = undefined`);
  }
});
