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

// Bản sao tham khảo của Worker trong src/. Không có gì require() nó — nó tồn tại
// để đọc offline. Nhưng chính vì không ai dùng nên nó đã trôi lệch hàng trăm dòng
// và còn mang logic cũ (nuốt lỗi GAS trong im lặng). Test này chặn việc trôi đó.
const WORKER_PATH = path.join(__dirname, '..', 'cloudflare-worker', 'src', 'index.js');
const WORKER_MIRROR = path.join(__dirname, '..', 'src', 'index.js.txt');

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

// Mã máy ổn định (bản mới) và mã cũ (UUID ngẫu nhiên của app bản cũ).
const MACHINE = 'DEV_E478B4594B5F8BC6';
const MACHINE_ROOM = 'ROOM_WIN_E478B4594B5F';

const days = count => new Date(Date.now() + count * 86400000);

function makeSheet(name, header, rows) {
  const values = [header.slice(), ...rows.map(row => row.slice())];
  return {
    getName: () => name,
    // setupAiConfigSheet() đổi tên tab mặc định của Sheet mới tạo.
    setName: value => { name = value; },
    getLastRow: () => values.length - 1,
    getDataRange: () => ({ getValues: () => values.map(row => row.slice()) }),
    getRange: (row, col, rows_, cols) => ({
      setValue: value => {
        while (values.length < row) values.push([]);
        const target = values[row - 1];
        while (target.length < col) target.push('');
        target[col - 1] = value;
      },
      // ensureColumns_() dùng setValues để viết lại hàng tiêu đề.
      setValues: block => {
        for (let r = 0; r < block.length; r++) {
          while (values.length < row + r) values.push([]);
          const target = values[row + r - 1];
          for (let c = 0; c < block[r].length; c++) target[c + col - 1] = block[r][c];
        }
      },
    }),
    appendRow: row => values.push(row.slice()),
    deleteRow: row => { values.splice(row - 1, 1); },
    __values: values,
  };
}

// Vị trí cột theo TÊN, không cứng chỉ số — cột do ensureColumns_() tự thêm vào
// cuối nên thứ tự thay đổi theo Sheet nào thiếu cột nào.
function colOf(sheet, name) {
  return sheet.__values[0].indexOf(name);
}
function cellAt(sheet, rowNumber, name) {
  const index = colOf(sheet, name);
  return index < 0 ? '' : String(sheet.__values[rowNumber - 1][index] || '');
}

function load(sheets, options = {}) {
  const byName = new Map(sheets.map(sheet => [sheet.getName(), sheet]));
  let uuid = 0;
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: name => {
          if (name === 'GATEWAY_SHARED_SECRET') return options.secret === undefined ? SECRET : options.secret;
          // Sheet cấu hình AI RIÊNG: script gọi openById() chứ không đụng Sheet CRM.
          if (name === 'AI_CONFIG_SPREADSHEET_ID') return options.aiSheetId || null;
          return null;
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; }, getContent() { return this.text; } }),
    },
    SpreadsheetApp: {
      // Sheet AI riêng: mở bằng ID. Sai ID phải ném lỗi (không được rơi về Sheet
      // CRM âm thầm — lúc đó admin tưởng đã lưu vào Sheet mới mà thực ra ghi
      // nhầm chỗ, và key của bot nằm trong Sheet CRM).
      openById: id => {
        const found = options.aiSheets && options.aiSheets.get(id);
        if (!found) throw new Error('Requested entity was not found.');
        return { getSheetByName: name => found.get(name) || null };
      },
      getActive: () => ({
        getSheetByName: name => byName.get(name) || null,
        // ensureTabs_() cần hai hàm này để dựng cấu trúc Sheet khi thiếu.
        insertSheet: name => {
          const created = makeSheet(name, [], []);
          byName.set(name, created);
          return created;
        },
        getSheets: () => [...byName.values()],
        deleteSheet: sheet => {
          for (const [key, value] of byName) if (value === sheet) byName.delete(key);
        },
      }),
    },
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
  // Một số hàm (ví dụ tạo Sheet) chạy trong môi trường thật với API riêng; test
  // ghi đè đúng phần đó thay vì để hàm gọi nhầm sang Sheet CRM của test.
  for (const [name, value] of Object.entries(options.extraSandbox || {})) sandbox[name] = value;
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

test('bản sao src/index.js.txt phải giống Cloudflare Worker thật', () => {
  assert.equal(
    fs.readFileSync(WORKER_PATH, 'utf8'),
    fs.readFileSync(WORKER_MIRROR, 'utf8'),
    'src/index.js.txt đã lệch với cloudflare-worker/src/index.js — chạy: Copy-Item cloudflare-worker/src/index.js src/index.js.txt'
  );
});

test('Worker không được nuốt im lặng lỗi CRM (đã từng làm khách mất bản quyền)', () => {
  const worker = fs.readFileSync(WORKER_PATH, 'utf8');
  // Đường đăng ký KHÔNG được tự bịa trạng thái bản quyền khi Apps Script lỗi:
  // app ghi thẳng vào đĩa nên khách đang mua biến thành "hết hạn" vĩnh viễn.
  assert.ok(
    !/status:\s*'Unactivated',\s*registered:\s*false/.test(worker),
    'Worker vẫn tự trả Unactivated khi CRM lỗi — app sẽ ghi đè mất bản quyền đang mua.'
  );
  // Và phải còn đường hỏi nhẹ /v1/ping để app chạy nền không tốn quota Apps Script.
  assert.ok(worker.includes('/v1/ping'), 'thiếu /v1/ping cho kiểm tra nền');
  assert.ok(worker.includes('/v1/sync'), 'thiếu /v1/sync cho lúc mở app');
  // Mã máy ổn định phải được chấp nhận, nếu không app mới bị từ chối toàn bộ.
  assert.ok(worker.includes('DEV_'), 'Worker chưa chấp nhận mã máy dạng DEV_');
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

// ---------------------------------------------------------------------------
// KHÔNG ĐƯỢC KHỚP DÒNG THEO HARDWARE HASH
//
// Sự cố thật: hash cũ băm từ (tên máy | tài khoản | card mạng) nên không đổi
// theo bản cài. Một client gửi installationId LẠ kèm hash của máy khác đã khớp
// đúng dòng thiết bị đó và nhận luôn license của người kia. Test dưới đây chặn
// đúng đường khoá lỏng đó.
// ---------------------------------------------------------------------------

test('REGRESSION: UUID lạ + hash của máy khác KHÔNG được nhận license người khác', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-40)]])]);
  // Dòng của nạn nhân đã có cả Machine ID (khách đã từng mở app bản mới).
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });

  // Kẻ lạ: UUID hoàn toàn mới + đúng hash của máy nạn nhân.
  const attacker = 'aaaa1111-bbbb-4ccc-8ddd-eeee2222ffff';
  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', installationId: attacker, chatRoomId: 'ROOM_WIN_KETHAI000001', hardwareHash: DEVICE.hardwareHash, machineId: 'DEV_BADC0DE00000001' });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, true, 'phải tạo dòng MỚI, không được nhận dòng của người khác');
  assert.equal(res.value.status, 'Trial', 'không được nhận license Active của máy khác');
  assert.notEqual(res.value.hardwareId, DEVICE.installationId);
  assert.equal(devices.__values[1][0], DEVICE.installationId, 'cột Hardware ID của nạn nhân không được ghi đè');
  assert.equal(devices.__values.length, 3, 'phải có đúng 2 dòng: nạn nhân + kẻ lạ');
});

test('khách lên từ app bản cũ: UUID khớp dòng cũ thì giữ nguyên license, không ghi đè cột nào', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-40)]]);
  const ctx = load([devices, licenses]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, false);
  assert.equal(res.value.status, 'Active', 'khách đang mua không được mất key');
  assert.equal(devices.__values.length, 2, 'không thêm dòng');
  assert.equal(devices.__values[1][0], DEVICE.installationId, 'giữ UUID cũ trong cột Hardware ID');
  assert.equal(licenses.__values[1][3], DEVICE.installationId, 'không đụng liên kết bản quyền');
  assert.equal(cellAt(devices, 2, 'Machine ID'), MACHINE, 'ghi bổ sung mã máy ổn định');
});

test('tab Bindings thiếu cột Chat Room ID vẫn chạy được', () => {
  const noRoomColumn = makeSheet('Bindings', ['License Key', 'Hardware ID', 'Activated At'], [[KEY, DEVICE.installationId, days(-20)]]);
  const ctx = load([
    makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-20), days(-20), DEVICE.hardwareHash]]),
    makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-20)]]),
    noRoomColumn,
  ]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, 'Active');
});

test('license_status: thiết bị chưa có trong Sheet trả value (không mất trường value)', () => {
  const ctx = standardCtx();
  const res = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, 'Unactivated');
});

// ---------------------------------------------------------------------------
// TỰ DỰNG CẤU TRÚC SHEET — dựng CRM mới thì Google Sheet trống, không có tab
// nào. Nếu bắt người tạo tay 4 tab + 25 tiêu đề thì dễ sai, mà hỏng lúc đó
// chỉ lộ ra khi khách đăng ký.
// ---------------------------------------------------------------------------

test('Sheet trống hoàn toàn: tự tạo đủ 5 tab và ghi tiêu đề cột', () => {
  const ctx = load([makeSheet('Sheet1', ['cột rác'], [])]);   // Sheet mới tạo có 1 tab rác
  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, hardwareHash: '' });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, true);
  const tabs = ctx.SpreadsheetApp.getActive().getSheets().map(s => s.getName()).sort();
  // AI_PROFILES nằm trong danh sách vì /ai là lệnh TOÀN CỤC của admin: thiếu tab
  // này thì mọi lệnh /ai đều fail, mà lúc đó CRM đã chạy ổn.
  assert.deepEqual(tabs, ['AI_PROFILES', 'Bindings', 'Devices', 'Licenses', 'Settings'], 'phải tự tạo đủ tab và dọn tab rác');
});

test('tab vừa tạo phải có đủ cột bắt buộc, không thiếu ô nào', () => {
  const ctx = load([makeSheet('Sheet1', ['cột rác'], [])]);
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, hardwareHash: '' });

  const header = name => ctx.SpreadsheetApp.getActive().getSheetByName(name).__values[0];
  for (const name of ['Hardware ID', 'Machine ID', 'Chat Room ID', 'License Key', 'Status', 'Expiry Date', 'First Install Time', 'Last Seen Time', 'Hardware Hash', 'Phone', 'Name', 'Plan', 'Telegram Topic ID']) {
    assert.ok(header('Devices').includes(name), 'Devices thiếu cột ' + name);
  }
  for (const name of ['License Key', 'Status', 'Expiry Date', 'Hardware ID', 'Chat Room ID', 'Activated At', 'Max Devices']) {
    assert.ok(header('Licenses').includes(name), 'Licenses thiếu cột ' + name);
  }
  for (const name of ['License Key', 'Hardware ID', 'Chat Room ID', 'Activated At']) {
    assert.ok(header('Bindings').includes(name), 'Bindings thiếu cột ' + name);
  }
  for (const name of ['Key', 'Value', 'Updated At']) {
    assert.ok(header('Settings').includes(name), 'Settings thiếu cột ' + name);
  }
});

test('Sheet ĐÃ có đủ tab thì không đụng vào dữ liệu đang chạy', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const before = JSON.stringify(devices.__values);
  const ctx = standardCtx();
  // standardCtx đã có Devices + Licenses; thêm Bindings + Settings cho đủ.
  ctx.SpreadsheetApp.getActive().insertSheet('Bindings');
  ctx.SpreadsheetApp.getActive().insertSheet('Settings');
  post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE, machineId: MACHINE });

  assert.equal(JSON.stringify(devices.__values), before, 'dữ liệu tab đang chạy không được đổi');
  assert.equal(devices.__values.length, 2, 'không được thêm dòng');
});

test('Script không gắn với Sheet nào thì báo rõ, không im lặng', () => {
  const byName = new Map();
  const ctx = load([makeSheet('Devices', DEVICE_HEADERS, [])]);
  // getActive() trả null = script bị tạo tách rời thay vì từ trong Google Sheet.
  ctx.SpreadsheetApp.getActive = () => null;
  const res = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(res.ok, false);
  assert.match(res.error, /chưa gắn với Google Sheet/i, 'phải chỉ ra cách sửa');
});

test('bỏ tab rác "Sheet1" nhưng GIU tab rác có tên lạ (tránh xoá nhầm dữ liệu)', () => {
  const ctx = load([makeSheet('Sheet1', ['cột rác'], [])]);
  const spare = ctx.SpreadsheetApp.getActive().insertSheet('Dữ liệu cũ của tôi');
  spare.__values.push(['dòng dữ liệu thật']);
  post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  const names = ctx.SpreadsheetApp.getActive().getSheets().map(s => s.getName());
  assert.ok(names.includes('Dữ liệu cũ của tôi'), 'KHÔNG được xoá tab có tên lạ');
});

// ---------------------------------------------------------------------------
// MÃ MÁY ỔN ĐỊNH — mục tiêu: 1 máy = 1 dòng Sheet = 1 phòng chat, và khách cài
// lại app KHÔNG mất key, KHÔNG reset được dùng thử.
// ---------------------------------------------------------------------------

test('Sheet thiếu cột Machine ID thì tự thêm, và ghi mã máy ổn định vào', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, []);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [])]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, hardwareHash: '' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, true);
  assert.ok(colOf(devices, 'Machine ID') >= 0, 'phải tự thêm cột Machine ID');
  assert.equal(cellAt(devices, 2, 'Machine ID'), MACHINE);
  assert.equal(cellAt(devices, 2, 'Chat Room ID'), MACHINE_ROOM);
});

test('khách lên từ bản cũ (UUID, cột Machine ID trống) được ghi ngược mã máy ổn định', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-40)]])]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.registered, false, 'phải ra đúng dòng cũ, không tạo dòng mới');
  assert.equal(res.value.status, 'Active', 'phải giữ nguyên bản quyền đang mua');
  assert.equal(devices.__values.length, 2, 'không được thêm dòng');
  assert.equal(cellAt(devices, 2, 'Machine ID'), MACHINE, 'phải ghi mã máy ổn định để lần sau khớp bằng nó');
});

test('KHÁCH CÀI LẠI APP: mất hết dữ liệu cục bộ, chỉ còn mã máy -> vẫn ra đúng dòng cũ', () => {
  // Dòng đã có mã máy ổn định, First Install Time cách đây 40 ngày, key còn hạn.
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const ctx = load([
    devices,
    makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-40)]]),
  ]);
  // Cho lần đầu tiên ghi mã máy (khách lên từ bản cũ).
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });
  assert.equal(devices.__values.length, 2);

  // Lần sau: app cài lại, KHÔNG còn installationId cũ, chỉ có mã máy ổn định,
  // và phòng chat được suy ra lại từ mã máy (không có phòng cũ).
  const again = post(ctx, { gatewaySecret: SECRET, action: 'register_device', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, hardwareHash: '' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.registered, false, 'phải khớp bằng Machine ID chứ không tạo máy mới');
  assert.equal(devices.__values.length, 2, 'KHÔNG được sinh dòng thứ hai cho cùng một máy');
  assert.equal(again.value.status, 'Active', 'khách đang trả tiền không được mất key');
});

test('khách cài lại app KHÔNG reset được dùng thử (First Install Time của máy chủ là chuẩn)', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-40), days(-40), DEVICE.hardwareHash]]);
  const ctx = load([devices, makeSheet('Licenses', LICENSE_HEADERS, [])]);
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });

  const reinstall = post(ctx, { gatewaySecret: SECRET, action: 'register_device', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, hardwareHash: '' });
  assert.equal(reinstall.ok, true, JSON.stringify(reinstall));
  assert.equal(devices.__values.length, 2);
  assert.equal(reinstall.value.status, 'Expired', '40 ngày rồi thì hết thử — không được tính lại từ hôm nay');
  assert.equal(devices.__values.length, 2, 'KHÔNG được sinh dòng mới');
});

test('/reset trả lại suất máy nhưng máy vẫn phải kích hoạt lại được NGAY (regression)', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), DEVICE.installationId, DEVICE.chatRoomId, days(-40)]]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, DEVICE.installationId, DEVICE.chatRoomId, days(-40)]]);
  const ctx = load([devices, licenses, bindings]);
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });

  // Admin gõ /reset trong Telegram.
  const reset = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/reset' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert.equal(cellAt(devices, 2, 'Hardware ID'), DEVICE.installationId, 'KHÔNG được xoá Hardware ID — mất khoá tìm dòng');
  assert.equal(cellAt(devices, 2, 'Machine ID'), MACHINE, 'KHÔNG được xoá Machine ID');
  assert.equal(bindings.__values.length, 1, 'phải trả lại suất máy cho key');

  // Khách bấm kích hoạt lại ngay, không cần tắt app.
  const again = post(ctx, { gatewaySecret: SECRET, action: 'verify_key', ...DEVICE, machineId: MACHINE, key: KEY });
  assert.equal(again.ok, true, 'phải kích hoạt lại được ngay: ' + JSON.stringify(again));
  assert.equal(again.value.status, 'Active');
});

test('verify_key nhận ra máy bằng mã máy ổn định khi Hardware ID bị xoá (dữ liệu cũ)', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, [[KEY, 'Active', days(90), '', '', days(-1)]]);
  const ctx = load([devices, licenses]);
  post(ctx, { gatewaySecret: SECRET, action: 'register_device', ...DEVICE, machineId: MACHINE });

  // Trạng thái do /reset phiên bản CŨ để lại: Hardware ID trống, chỉ còn Machine ID.
  devices.__values[1][colOf(devices, 'Hardware ID')] = '';
  devices.__values[1][colOf(devices, 'Status')] = 'Unactivated';

  const res = post(ctx, { gatewaySecret: SECRET, action: 'verify_key', machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM, key: KEY });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.status, 'Active', 'phải kích hoạt được bằng mã máy ổn định');
});

// ---------------------------------------------------------------------------
// SỐ MÁY — thông tin khách cần để biết key dùng được cho mấy máy
// ---------------------------------------------------------------------------
test('/check hiện số máy đã dùng / tổng, và /new trả về số slot', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash]]);
  const licenses = makeSheet('Licenses', [...LICENSE_HEADERS.slice(0, 6), 'Max Devices'], [[KEY, 'Active', days(90), '', '', days(-40), '3']]);
  const bindings = makeSheet('Bindings', BINDING_HEADERS, [[KEY, DEVICE.installationId, DEVICE.chatRoomId, days(-40)]]);
  const ctx = load([devices, licenses, bindings]);

  const res = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/check' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.match(res.value.reply, /Số máy: 1\/3/, 'phải hiện đã dùng 1 trong tổng 3');
  assert.match(res.value.reply, /còn 2 slot/);
  assert.equal(res.value.maxDevices, 3);
  assert.equal(res.value.usedSlots, 1);
});

test('/check không hiện số máy khi máy chưa có key (đang dùng thử)', () => {
  const ctx = standardCtx([], [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/check' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.doesNotMatch(res.value.reply, /Số máy/, 'chưa có key thì số máy không có ý nghĩa, đừng hiện');
});

test('/new trả về số slot và hiện 0/N', () => {
  // Phải có dòng thiết bị, nếu không /new không tìm thấy phòng chat này.
  const ctx = standardCtx([], [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Trial', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'admin_command', chatRoomId: DEVICE.chatRoomId, text: '/new thang 3' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.maxDevices, 3);
  assert.equal(res.value.usedSlots, 0);
  assert.match(res.value.reply, /0\/3 slot/);
  assert.ok(res.value.keyName, 'phải trả key mới');
});

test('list_devices: trả về đủ thông tin và đánh dấu online theo cửa sổ 15 phút', () => {
  const now = Date.now();
  const ctx = standardCtx([], [
    [DEVICE.installationId, DEVICE.chatRoomId, KEY, 'Active', days(90), days(-40), days(-40), DEVICE.hardwareHash],
    ['99999999-8888-4777-8666-555555555555', 'ROOM_WIN_OFFLINE01', '', 'Unactivated', '', days(-2), days(-2), ''],
  ]);
  const res = post(ctx, { gatewaySecret: SECRET, action: 'list_devices', now });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.devices.length, 2);
  assert.equal(res.value.onlineWindowMs, 15 * 60 * 1000);

  const fresh = res.value.devices.find(d => d.machineId || d.hardwareId === DEVICE.installationId);
  assert.equal(fresh.chatRoomId, DEVICE.chatRoomId);
  assert.equal(fresh.status, 'Active');
  assert.equal(fresh.keyName, KEY);
  // Dòng vừa sửa => online; dòng cũ => offline.
  const offline = res.value.devices.find(d => d.chatRoomId === 'ROOM_WIN_OFFLINE01');
  assert.equal(offline.online, false, 'máy không mở 2 ngày thì offline');
});

// ---------------------------------------------------------------------------
// /check_SDT — tra cứu theo số điện thoại
// ---------------------------------------------------------------------------
const PHONE_HEADERS = [...DEVICE_HEADERS, 'Machine ID', 'Phone', 'Name', 'Plan'];
const PHONE_DEVICES = [
  ['11111111-2222-4333-8444-555555555555', 'ROOM_WIN_TEST0001', 'KEY-TEST0001', 'Active', days(90), days(-40), days(-40), 'A'.repeat(64), MACHINE, '0987654321', 'Nguyễn Văn A', 'Plus'],
  ['22222222-3333-4444-8555-666666666666', 'ROOM_WIN_TEST0002', 'KEY-OLD00001', 'Active', days(-10), days(-90), days(-90), 'B'.repeat(64), 'DEV_AAAABBBBCCCCDDDD', '0987654321', 'Nguyễn Văn A', 'Basic'],
  ['33333333-4444-4555-8666-777777777777', 'ROOM_WIN_KHAC0001', 'KEY-KHAC0001', 'Active', days(30), days(-30), days(-30), 'C'.repeat(64), 'DEV_1111222233334444', '0900000000', 'Khách Khác', ''],
];
const PHONE_LICENSES = [
  ['KEY-TEST0001', 'Active', days(90), '', 'ROOM_WIN_TEST0001', days(-40), '2'],
  ['KEY-OLD00001', 'Active', days(-10), '', 'ROOM_WIN_TEST0002', days(-90), '1'],
  ['KEY-KHAC0001', 'Active', days(30), '', 'ROOM_WIN_KHAC0001', days(-30), '1'],
];

const phoneCtx = (devices = PHONE_DEVICES, licenses = PHONE_LICENSES) => load([
  makeSheet('Devices', PHONE_HEADERS, devices),
  makeSheet('Licenses', [...LICENSE_HEADERS, 'Max Devices'], licenses),
  makeSheet('Bindings', BINDING_HEADERS, [
    ['KEY-TEST0001', '11111111-2222-4333-8444-555555555555', 'ROOM_WIN_TEST0001', days(-40)],
  ]),
]);

test('find_by_phone trả mọi máy và mọi key của số đó', () => {
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.found, true);
  assert.equal(res.value.devices.length, 2, 'cùng một SĐT đăng ký trên 2 máy');
  assert.equal(res.value.licenses.length, 2, 'mỗi máy một key, phải thấy cả hai');
  const keys = res.value.licenses.map(l => l.keyName).sort();
  assert.deepEqual(keys, ['KEY-OLD00001', 'KEY-TEST0001']);
});

test('find_by_phone không lẫn máy của khách khác', () => {
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  const rooms = res.value.devices.map(d => d.chatRoomId);
  assert.ok(!rooms.includes('ROOM_WIN_KHAC0001'), 'không được lẫn máy của SĐT khác');
  const keys = res.value.licenses.map(l => l.keyName);
  assert.ok(!keys.includes('KEY-KHAC0001'), 'không được lẫn key của SĐT khác');
});

test('find_by_phone chuẩn hoá SĐT: bỏ 0 đầu, mã 84, dấu cách và dấu chấm', () => {
  for (const variant of ['987654321', '+84 987 654 321', '84987654321', '0987 654 321', '0987.654.321']) {
    const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: variant });
    assert.equal(res.ok, true, variant);
    assert.equal(res.value.devices.length, 2, `SĐT "${variant}" phải ra 2 máy`);
  }
});

test('find_by_phone: key hết hạn phải hiện Expired, không phải Active', () => {
  // KEY-OLD00001 có hạn trong quá khứ nhưng cột Status vẫn ghi "Active".
  // Nếu chỉ đọc cột Status thì admin bị dẫn sai.
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  const old = res.value.licenses.find(l => l.keyName === 'KEY-OLD00001');
  assert.equal(old.status, 'Expired');
  const cur = res.value.licenses.find(l => l.keyName === 'KEY-TEST0001');
  assert.equal(cur.status, 'Active');
});

test('find_by_phone: kèm số máy đã gán theo từng key', () => {
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  const cur = res.value.licenses.find(l => l.keyName === 'KEY-TEST0001');
  assert.equal(cur.maxDevices, 2);
  assert.equal(cur.usedSlots, 1);
  assert.equal(cur.boundDevices.length, 1);
  assert.equal(cur.boundDevices[0].chatRoomId, 'ROOM_WIN_TEST0001');
});

test('find_by_phone: SĐT không có ai thì trả found=false, không phải lỗi', () => {
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0999999999' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.found, false);
  assert.deepEqual(res.value.devices, []);
  assert.deepEqual(res.value.licenses, []);
});

test('find_by_phone: SĐT rác / rỗng thì không ném lỗi mà trả found=false', () => {
  for (const bad of ['', '   ', 'khong-co-so']) {
    const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: bad });
    assert.equal(res.ok, true, `SĐT "${bad}" không được làm hỏng lệnh`);
    assert.equal(res.value.found, false);
  }
});

test('find_by_phone đánh dấu online theo Last Seen Time', () => {
  const fresh = PHONE_DEVICES.map(r => r.slice());
  fresh[0][6] = new Date(Date.now() - 60 * 1000);   // vừa mở app
  fresh[1][6] = new Date(Date.now() - 5 * 3600000);  // 5 giờ trước
  const res = post(phoneCtx(fresh), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  const on = res.value.devices.filter(d => d.online).map(d => d.chatRoomId);
  assert.deepEqual(on, ['ROOM_WIN_TEST0001']);
});

test('find_by_phone là lệnh toàn cục — không được đòi mã máy', () => {
  const res = post(phoneCtx(), { gatewaySecret: SECRET, action: 'find_by_phone', phone: '0987654321' });
  assert.equal(res.ok, true, 'thiếu installationId vẫn phải chạy được');
});

test('REGRESSION: find_by_phone bị chặn nếu không có secret của Gateway', () => {
  // Tra cứu theo SĐT lộ thông tin của khách, nên chỉ Gateway gọi được. Nếu lọt
  // ra ngoài thì bất kỳ ai biết SĐT của khách cũng tra được key của họ.
  const ctx = phoneCtx();
  for (const payload of [
    { action: 'find_by_phone', phone: '0987654321' },
    { action: 'find_by_phone', phone: '0987654321', gatewaySecret: 'sai-secret' },
    { action: 'find_by_phone', phone: '0987654321', gatewaySecret: '' },
  ]) {
    const res = post(ctx, payload);
    assert.equal(res.ok, false, JSON.stringify(payload));
    assert.match(res.error, /Unauthorized/i, 'phải từ chối, không được trả dữ liệu');
  }
  assert.equal(post(ctx, { gatewaySecret: SECRET, action: 'list_devices' }).ok, true, 'secret đúng thì chạy');
});

test('REGRESSION: list_devices cũng bị chặn nếu không có secret', () => {
  const res = post(phoneCtx(), { action: 'list_devices' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Unauthorized/i);
});

test('list_devices: không lọc theo máy — đây là lệnh toàn cục của admin', () => {
  const ctx = standardCtx();
  const res = post(ctx, { gatewaySecret: SECRET, action: 'list_devices' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(Array.isArray(res.value.devices));
});

test('mã máy DEV_ và UUID cũ đều hợp lệ; rác thì bị từ chối', () => {
  const ctx = standardCtx();
  const withGate = body => ({ gatewaySecret: SECRET, action: 'license_status', ...body });
  assert.equal(post(ctx, withGate({ machineId: MACHINE, installationId: MACHINE, chatRoomId: MACHINE_ROOM })).ok, true);
  assert.equal(post(ctx, withGate({ ...DEVICE })).ok, true, 'app bản cũ gửi UUID vẫn phải chạy');
  assert.equal(post(ctx, withGate({ machineId: 'DEV_XYZ', installationId: MACHINE, chatRoomId: MACHINE_ROOM })).ok, false);
  assert.equal(post(ctx, withGate({ machineId: MACHINE, installationId: MACHINE, chatRoomId: 'phong-sai-dinh-dang' })).ok, false);
  assert.equal(post(ctx, withGate({ chatRoomId: MACHINE_ROOM })).ok, false, 'không có mã máy nào thì phải từ chối');
});

test('license_status: dùng thử luôn tính từ First Install Time của máy chủ', () => {
  const ctx = standardCtx([], [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-1), days(-1), DEVICE.hardwareHash]]);
  const trial = post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE });
  assert.equal(trial.ok, true, JSON.stringify(trial));
  assert.equal(trial.value.status, 'Trial');
  assert.equal(trial.value.trial, true);

  const expired = load([
    makeSheet('Devices', DEVICE_HEADERS, [[DEVICE.installationId, DEVICE.chatRoomId, '', 'Unactivated', '', days(-31), days(-31), DEVICE.hardwareHash]]),
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

// ---------------------------------------------------------------------------
// CẤU HÌNH AI QUA TELEGRAM (/ai) — admin đổi url/model/API key không cần sửa code.
// Ranh giới quan trọng nhất: chỉ Gateway (đã qua khoá gatewaySecret) được đọc key;
// app không bao giờ nhận key qua bất kỳ action nào.
// ---------------------------------------------------------------------------
const AI_HEADERS = ['Alias', 'Active', 'Base URL', 'Model', 'API Keys', 'Order', 'Updated At', 'Updated By'];
const AI_URL = 'https://openrouter.ai/api/v1';
const AI_MODEL = 'stealth/space-bunny-alpha';
const KEY_ONE = 'sk-or-test-key-0000000001';
const KEY_TWO = 'sk-or-test-key-0000000002';

// Phải nhận CHÍNH sheet AI để test đọc lại được dữ liệu đã ghi (makeSheet giữ
// mảng values bên trong; dựng sheet riêng ở đây sẽ khiến assert đọc sai bản).
function aiCtx(rows = [], ai = makeSheet('AI_PROFILES', AI_HEADERS, rows)) {
  const ctx = load([
    makeSheet('Devices', DEVICE_HEADERS, []),
    makeSheet('Licenses', LICENSE_HEADERS, []),
    ai,
  ]);
  return { ctx, ai };
}

// Bối cảnh có Sheet AI RIÊNG (Script Property trỏ tới) — đúng cách cấu hình
// được khuyến nghị: key nằm ngoài Sheet CRM.
function aiSheetCtx(rows = []) {
  const ai = makeSheet('PROFILES', [], rows);
  const crm = makeSheet('AI_PROFILES', AI_HEADERS, []);
  const ctx = load([
    makeSheet('Devices', DEVICE_HEADERS, []),
    makeSheet('Licenses', LICENSE_HEADERS, []),
    crm,
  ], { aiSheetId: 'sheet-ai-rieng', aiSheets: new Map([['sheet-ai-rieng', new Map([['PROFILES', ai]])]]) });
  return { ctx, ai, crm };
}
const aiAdmin = (ctx, text) => post(ctx, { gatewaySecret: SECRET, action: 'ai_admin', text, updatedBy: 'telegram' });

test('/ai add tạo cấu hình và /ai key add thêm nhiều key để xoay vòng', () => {
  const { ctx, ai } = aiCtx();
  const added = aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(ai.__values.length, 2, 'phải thêm đúng một dòng cấu hình');
  assert.equal(cellAt(ai, 2, 'Alias'), 'chinh');
  assert.equal(cellAt(ai, 2, 'Base URL'), AI_URL);
  assert.equal(cellAt(ai, 2, 'Model'), AI_MODEL);
  assert.equal(cellAt(ai, 2, 'Updated By'), 'telegram');

  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_TWO);
  assert.equal(cellAt(ai, 2, 'API Keys').split('\n').length, 2, 'phải lưu được nhiều key trong một ô');

  // Gateway đọc cấu hình: đủ url + model + 2 key, và key trả VỀ TOÀN BỘ (Gateway
  // cần để gọi AI; app thì không bao giờ gọi action này).
  const config = post(ctx, { gatewaySecret: SECRET, action: 'ai_config' });
  assert.equal(config.ok, true);
  assert.equal(config.value.active, 'chinh', 'chưa /ai use thì lấy dòng dùng được đầu tiên');
  assert.deepEqual(config.value.profiles[0].keys, [KEY_ONE, KEY_TWO]);
});

test('/ai use bật đúng một cấu hình; /ai del xoá và báo lại danh sách', () => {
  const { ctx, ai } = aiCtx();
  aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  aiAdmin(ctx, '/ai add duphong https://api.du-phong.example/v1 ' + AI_MODEL);
  aiAdmin(ctx, '/ai key duphong add ' + KEY_TWO);

  const used = aiAdmin(ctx, '/ai use duphong');
  assert.equal(used.ok, true);
  assert.equal(post(ctx, { gatewaySecret: SECRET, action: 'ai_config' }).value.active, 'duphong');
  // Chỉ một dòng được bật: bật lại 'chinh' thì 'duphong' phải tắt.
  aiAdmin(ctx, '/ai use chinh');
  const marked = ai.__values.slice(1).filter(row => /^(yes|1|true)$/i.test(String(row[1] || '').trim()));
  assert.equal(marked.length, 1, 'chỉ được có đúng một cấu hình bật');

  const deleted = aiAdmin(ctx, '/ai del duphong');
  assert.equal(deleted.ok, true);
  assert.equal(ai.__values.filter(row => String(row[0] || '').trim() === 'duphong').length, 0, 'phải xoá hẳn dòng');
});

test('/ai url và /ai model chỉ sửa đúng một phần, giữ nguyên key đang chạy', () => {
  const { ctx, ai } = aiCtx();
  aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_TWO);

  aiAdmin(ctx, '/ai url chinh https://api.moi.example/v1');
  aiAdmin(ctx, '/ai model chinh ten/model-moi');
  assert.equal(cellAt(ai, 2, 'Base URL'), 'https://api.moi.example/v1');
  assert.equal(cellAt(ai, 2, 'Model'), 'ten/model-moi');
  assert.equal(cellAt(ai, 2, 'API Keys').split('\n').length, 2, 'đổi url/model không được mất key');
});

test('/ai key del xoá đúng thứ tự; key sai dạng thì từ chối', () => {
  const { ctx, ai } = aiCtx();
  aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_TWO);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE); // trùng: phải báo chứ không nhân bản

  assert.equal(cellAt(ai, 2, 'API Keys').split('\n').length, 2, 'key trùng không được thêm lần hai');
  const bad = aiAdmin(ctx, '/ai key chinh add co khoang trong');
  assert.equal(bad.ok, true);
  assert.match(bad.value.reply, /không hợp lệ/i, 'key có dấu cách phải bị từ chối');
  assert.equal(cellAt(ai, 2, 'API Keys').split('\n').length, 2, 'key hỏng không được ghi vào Sheet');

  aiAdmin(ctx, '/ai key chinh del 1');
  assert.equal(cellAt(ai, 2, 'API Keys').split('\n')[0], KEY_TWO, 'xoá key thứ nhất phải còn lại key thứ hai');
  const out = aiAdmin(ctx, '/ai key chinh del 9');
  assert.match(out.value.reply, /không hợp lệ/i);
});

test('URL không phải https thì từ chối — Gateway chạy ở Cloudflare nên localhost vô nghĩa', () => {
  const { ctx, ai } = aiCtx();
  for (const url of ['http://openrouter.ai/api/v1', 'localhost:11434/v1', 'ftp://x.example/v1']) {
    const res = aiAdmin(ctx, '/ai add chinh ' + url + ' ' + AI_MODEL);
    assert.equal(res.ok, true);
    assert.match(res.value.reply, /https/i, url + ': phải bị từ chối');
  }
  assert.equal(ai.__values.length, 1, 'không cấu hình hỏng nào được ghi vào Sheet');
});

test('ai_admin / ai_config là lệnh TOÀN CỤC: không đòi mã máy, nhưng vẫn phải có secret', () => {
  const { ctx } = aiCtx();
  assert.equal(post(ctx, { gatewaySecret: 'sai', action: 'ai_admin', text: '/ai' }).ok, false);
  assert.equal(post(ctx, { gatewaySecret: 'sai', action: 'ai_config' }).ok, false, 'sai secret thì không được đọc key');
  const res = post(ctx, { gatewaySecret: SECRET, action: 'ai_admin', text: '/ai' });
  assert.equal(res.ok, true);
  assert.ok(res.value.config, 'phải trả kèm cấu hình để Gateway dùng ngay');
  assert.equal(res.value.reply.includes(KEY_ONE), false, 'reply trong Telegram không được lộ key');
});

test('bảng xem /ai hiện trạng thái và che giữa key, không in key thật', () => {
  const { ctx, ai } = aiCtx();
  aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  const view = aiAdmin(ctx, '/ai');
  assert.match(view.value.reply, /1 key/);
  const listed = aiAdmin(ctx, '/ai key chinh list');
  assert.equal(listed.value.reply.includes(KEY_ONE), false, 'danh sách key phải che giữa');
  assert.match(listed.value.reply, /\.\.\./, 'phải có dấu hiệu đã che');
});

// Sheet cấu hình AI RIÊNG: lệnh /ai phải ghi vào đó, tuyệt đối không đụng tab
// AI_PROFILES của Sheet CRM — nếu rò sang Sheet CRM thì khi chia sẻ Sheet đó cho
// kế toán, API key của bot cũng bị lộ theo.
test('có Script Property thì cấu hình AI nằm ở Sheet riêng, không ghi vào Sheet CRM', () => {
  const { ctx, ai, crm } = aiSheetCtx();
  assert.equal(aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL).ok, true);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);

  assert.equal(cellAt(ai, 2, 'Alias'), 'chinh', 'phải ghi vào Sheet AI riêng');
  assert.equal(cellAt(ai, 2, 'API Keys'), KEY_ONE);
  assert.equal(crm.__values.length, 1, 'Sheet CRM không được thêm dòng AI nào');

  // Sheet AI tạo tay có thể thiếu cột: script phải tự thêm, không chết.
  assert.ok(ai.__values[0].includes('Order'), 'phải tự thêm cột Order');
  assert.ok(ai.__values[0].includes('Alias'));
});

// Mock phải nhớ trạng thái thật: sau khi insertSheet/đổi tên thì getSheetByName
// phải trả về tab đó. Mock "vô trạng thái" sẽ khiến script tạo trùng tab — lỗi
// chỉ có ở test, ở Sheets thật thì không.
test('Sheet riêng không có tab nào thì tự tạo tab PROFILES, không ghi nhầm về Sheet CRM', () => {
  const created = [];
  let current = null;
  const doc = {
    getSheetByName: () => current,
    getSheets: () => (current ? [current] : []),
    insertSheet: name => { current = makeSheet(name, [], []); created.push(current); return current; },
  };
  const crm = makeSheet('AI_PROFILES', AI_HEADERS, []);
  const ctx = load([makeSheet('Devices', DEVICE_HEADERS, []), makeSheet('Licenses', LICENSE_HEADERS, []), crm], {
    aiSheetId: 'sheet-sai',
    aiSheets: new Map([['sheet-sai', new Map()]]),
    extraSandbox: { SpreadsheetApp: {
      openById: () => doc,
      getActive: () => ({ getSheetByName: name => (name === 'AI_PROFILES' ? crm : null) }),
    } },
  });
  const res = aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(created.length, 1, 'phải tự tạo đúng một tab, không tạo trùng');
  assert.equal(created[0].getName(), 'PROFILES');
  assert.equal(cellAt(created[0], 2, 'Alias'), 'chinh');
  assert.equal(crm.__values.length, 1, 'Sheet CRM không được ghi dòng AI nào');
});

test('cột Order quyết định thứ tự dự phòng, dòng mới luôn nằm cuối', () => {
  const { ctx, ai } = aiCtx([
    ['chinh', 'Yes', AI_URL, AI_MODEL, KEY_ONE, 10, '', ''],
    ['duphong', '', AI_URL, AI_MODEL, KEY_TWO, 20, '', ''],
  ]);
  const before = post(ctx, { gatewaySecret: SECRET, action: 'ai_config' }).value.profiles.map(p => p.alias);
  assert.deepEqual(before, ['chinh', 'duphong']);
  assert.deepEqual(post(ctx, { gatewaySecret: SECRET, action: 'ai_config' }).value.profiles.map(p => p.order), [10, 20]);

  aiAdmin(ctx, '/ai add third https://api.third.example/v1 model-3');
  const after = post(ctx, { gatewaySecret: SECRET, action: 'ai_config' }).value.profiles;
  assert.deepEqual(after.map(p => p.alias), ['chinh', 'duphong', 'third'], 'dòng mới phải nằm cuối chuỗi');
  assert.equal(Number(cellAt(ai, 4, 'Order')), 30);
});

test('/ai key <tên> check chỉ hướng dẫn bấm nút, không tự gọi ra Internet', () => {
  const { ctx, ai } = aiCtx();
  aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  aiAdmin(ctx, '/ai key chinh add ' + KEY_ONE);
  const res = aiAdmin(ctx, '/ai key chinh check');
  assert.equal(res.ok, true);
  assert.match(res.value.reply, /nút/i, 'phải hướng dẫn dùng nút Kiểm tra key');
  assert.equal(cellAt(ai, 2, 'API Keys'), KEY_ONE, 'lệnh check không được đụng vào key');
});

test('hai action AI không tạo tab CRM — chạy được cả khi script chưa gắn Sheet bản quyền', () => {
  // Ngữ cảnh chỉ có Sheet cấu hình AI, KHÔNG có Devices/Licenses: đúng tình huống
  // sau khi admin tách sang Sheet riêng mà script chưa gắn vào Sheet CRM.
  const ai = makeSheet('PROFILES', [], []);
  const ctx = load([ai], { aiSheetId: 'sheet-ai-rieng', aiSheets: new Map([['sheet-ai-rieng', new Map([['PROFILES', ai]])]]) });
  assert.equal(aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL).ok, true, '/ai phải chạy được không cần Sheet CRM');
  assert.equal(post(ctx, { gatewaySecret: SECRET, action: 'ai_config' }).ok, true, 'ai_config phải chạy được không cần Sheet CRM');
  // Lệnh bản quyền thì vẫn tự dựng tab CRM (cơ chế tự phục hồi sẵn có), chứ
  // không liên quan gì tới việc tách Sheet cấu hình AI ra riêng.
  assert.equal(post(ctx, { gatewaySecret: SECRET, action: 'license_status', ...DEVICE }).ok, true, 'lệnh CRM vẫn tự tạo tab thiếu');
});

test('sai secret thì kể cả /ai cũng không được đụng vào Sheet cấu hình', () => {
  const { ctx, ai } = aiCtx();
  const res = post(ctx, { gatewaySecret: 'sai', action: 'ai_admin', text: '/ai add chinh ' + AI_URL + ' ' + AI_MODEL });
  assert.equal(res.ok, false);
  assert.equal(ai.__values.length, 1, 'không được ghi gì khi thiếu secret');
});

test('setupAiConfigSheet tạo Sheet riêng, đặt Script Property và ghi đủ tiêu đề', () => {
  // SpreadsheetApp.create() chỉ có trong môi trường thật; ở đây giả lập để kiểm
  // logic: tạo đúng 1 tab tên PROFILES, ghi tiêu đề, và trỏ property.
  const created = [];
  const properties = {};
  const doc = {
    __sheets: [makeSheet('Sheet1', [], [])],
    getSheets() { return this.__sheets; },
    deleteSheet(sheet) { this.__sheets = this.__sheets.filter(item => item !== sheet); },
    getId() { return 'sheet-id-moi'; },
    getUrl() { return 'https://docs.google.com/spreadsheets/d/sheet-id-moi/edit'; },
  };
  const ctx = load([], { extraSandbox: {
    SpreadsheetApp: {
      create: name => { created.push(name); return doc; },
      getActive: () => null,
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: key => (key === 'GATEWAY_SHARED_SECRET' ? SECRET : properties[key] || null), setProperty: (key, value) => { properties[key] = value; } }),
    },
  } });

  const result = ctx.setupAiConfigSheet();
  assert.equal(result.created, true);
  assert.equal(created.length, 1, 'phải tạo đúng một Sheet');
  assert.equal(doc.__sheets.length, 1, 'chỉ được còn một tab');
  assert.equal(doc.__sheets[0].getName(), 'PROFILES', 'tab phải tên đúng PROFILES');
  assert.deepEqual(doc.__sheets[0].__values[0], ['Alias', 'Active', 'Base URL', 'Model', 'API Keys', 'Order', 'Updated At', 'Updated By']);
  assert.equal(properties.AI_CONFIG_SPREADSHEET_ID, 'sheet-id-moi', 'phải tự trỏ Script Property vào Sheet mới');
  assert.match(result.url, /sheet-id-moi/);

  // Chạy lần hai không được tạo thêm Sheet (tránh rác trong Drive khi bấm nhầm Run).
  const again = ctx.setupAiConfigSheet();
  assert.equal(again.created, false);
  assert.equal(created.length, 1, 'lần sau phải bỏ qua, không tạo Sheet thứ hai');
});

// Gateway không set được Script Property nên phải truyền ID Sheet theo request,
// và script phải TỰ tạo/đổi tên tab PROFILES — nếu chỉ báo lỗi thì admin phải
// tự tạo tab bằng tay trước khi dùng được /ai.
test('Sheet riêng còn trống thì tự đổi tên tab thành PROFILES và ghi tiêu đề', () => {
  const blank = makeSheet('Sheet1', [], []);
  const doc = {
    getSheetByName: name => (name === blank.getName() ? blank : null),
    getSheets: () => [blank],
    insertSheet: () => { throw new Error('không được tạo tab mới khi đã có tab rỗng'); },
  };
  const ctx = load([], { aiSheetId: 'sheet-moi', aiSheets: new Map([['sheet-moi', new Map([['PROFILES', null]])]]), extraSandbox: { SpreadsheetApp: {
    openById: id => (id === 'sheet-moi' ? doc : null),
    getActive: () => null,
  } } });

  const res = aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(blank.getName(), 'PROFILES', 'phải đổi tên tab rỗng thành PROFILES');
  assert.equal(blank.__values[0][0], 'Alias', 'phải ghi hàng tiêu đề');
  assert.equal(cellAt(blank, 2, 'Alias'), 'chinh');
});

// Không trỏ Sheet riêng thì vẫn phải chạy được: tự tạo tab AI_PROFILES trong
// Sheet CRM thay vì báo lỗi buộc admin phải tự tạo bằng tay.
test('không có Sheet riêng thì tự tạo tab AI_PROFILES trong Sheet CRM', () => {
  const devices = makeSheet('Devices', DEVICE_HEADERS, []);
  const licenses = makeSheet('Licenses', LICENSE_HEADERS, []);
  const ctx = load([devices, licenses]);
  const res = aiAdmin(ctx, '/ai add chinh ' + AI_URL + ' ' + AI_MODEL);
  assert.equal(res.ok, true, JSON.stringify(res));
  const created = ctx.SpreadsheetApp.getActive().getSheets().find(s => s.getName() === 'AI_PROFILES');
  assert.ok(created, 'phải tự tạo tab AI_PROFILES');
  assert.equal(cellAt(created, 2, 'Alias'), 'chinh');
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
