'use strict';
// ---------------------------------------------------------------------------
// MÃ MÁY ỔN ĐỊNH — 1 máy = 1 mã = 1 phòng chat, cài lại vẫn giữ nguyên.
// Mục tiêu chống lại tình huống khách cài lại app / bật VPN / đổi tên máy rồi
// bị coi như máy mới (mất key, mất phòng chat, reset dùng thử).
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const machine = require('../src/machine-id');

test('installationId LUÔN là UUID, không bao giờ là mã máy DEV_', () => {
  // Apps Script BẢN CŨ (đang chạy production) chỉ chấp nhận /^[0-9a-f-]{36}$/i.
  // Nếu installationId mang dạng DEV_ thì khách MỚI không đăng ký được, trong
  // khi khách cũ (giữ UUID) vẫn chạy — lỗi rất khó phát hiện vì chỉ khách mới gặp.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { SupportStore } = require('../src/support');

  const store = new SupportStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-mid-')));
  const { machineId, installationId } = store.data.device;

  assert.match(installationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'installationId phải là UUID để Apps Script cũ chấp nhận');
  assert.ok(!installationId.startsWith('DEV_'), 'không được đưa mã máy vào installationId');
  assert.match(machineId, /^DEV_[A-F0-9]{12,32}$/i, 'mã máy ổn định đi ở trường riêng');
  assert.notEqual(installationId, machineId, 'hai định danh phải khác nhau');

  // Payload gửi lên phải mang CẢ HAI.
  const sent = store.publicDevice();
  assert.equal(sent.installationId, installationId);
  assert.equal(sent.machineId, machineId);
  assert.match(sent.chatRoomId, /^ROOM_WIN_[A-Z0-9]{8,40}$/);
});

test('cài lại app: mã máy giữ nguyên, installationId đổi (đúng thiết kế)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { SupportStore } = require('../src/support');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-reinstall-'));
  const first = new SupportStore(dir, { machineId: 'DEV_ABCDEF0123456789' });
  const beforeMachine = first.data.device.machineId;
  const beforeRoom = first.data.device.chatRoomId;
  const beforeInstall = first.data.device.installationId;

  fs.rmSync(path.join(dir, 'support.json'));                       // = cài lại app
  const second = new SupportStore(dir, { machineId: 'DEV_ABCDEF0123456789' });

  assert.equal(second.data.device.machineId, beforeMachine, 'mã máy phải giữ nguyên');
  assert.equal(second.data.device.chatRoomId, beforeRoom, 'phòng chat phải giữ nguyên');
  assert.notEqual(second.data.device.installationId, beforeInstall, 'installationId là mỗi lần cài nên đổi là đúng');
  assert.match(second.data.device.installationId, /^[0-9a-f-]{36}$/i);
});

test('mã máy và phòng chat đúng định dạng mà Worker / Apps Script chấp nhận', () => {
  const id = machine.deviceId();
  assert.ok(id, 'phải sinh được mã máy trên mọi máy kể cả khi không đọc được registry');
  assert.match(id, /^DEV_[A-F0-9]{12,32}$/i, 'mã máy phải là DEV_ + hex, an toàn trong URL và tên cột Sheet');

  const room = machine.roomFor(id);
  assert.match(room, /^ROOM_WIN_[A-Z0-9]{8,40}$/, 'phải khớp regex /^ROOM_WIN_[A-Z0-9]{8,40}$/ ở Worker và Code.gs');
});

test('tính ra luôn giống nhau — không có yếu tố ngẫu nhiên nào', () => {
  const first = machine.deviceId();
  const room = machine.roomFor(first);
  // Bỏ khoá module để ép tính lại từ đầu, giống như lần mở app kế tiếp.
  for (let i = 0; i < 5; i++) {
    delete require.cache[require.resolve('../src/machine-id')];
    const again = require('../src/machine-id');
    assert.equal(again.deviceId(), first, 'mã máy phải bất biến giữa các lần chạy');
    assert.equal(again.roomFor(again.deviceId()), room, 'phòng chat phải bất biến');
  }
});

test('roomFor bỏ đúng tiền tố DEV_, không lẫn chữ D/E của tiền tố vào kết quả', () => {
  // Nếu quên bỏ tiền tố, 'D' và 'E' trong "DEV" sẽ lọt vào hex và phòng sinh ra
  // không còn là phần đuôi của mã máy — mất tính quyết định 1 máy = 1 phòng.
  assert.equal(machine.roomFor('DEV_0123456789ABCDEF'), 'ROOM_WIN_0123456789AB');
  assert.equal(machine.roomFor('aabbccddeeff0011'), 'ROOM_WIN_AABBCCDDEEFF');
});

test('roomFor giữ nguyên phòng đã có, kể cả bản cũ dài ngắn khác nhau', () => {
  // Không được âm thầm trả rỗng rồi làm mất phòng cũ của khách.
  assert.equal(machine.roomFor('ROOM_WIN_ABC123'), 'ROOM_WIN_ABC123');
  assert.equal(machine.roomFor('ROOM_WIN_TESTROOM01'), 'ROOM_WIN_TESTROOM01');
  assert.equal(machine.roomFor('room_win_lower_case'), 'ROOM_WIN_LOWER_CASE');
});

test('roomFor luôn TẤT ĐỊNH, kể cả khi mã không phải hex — không được rơi về random', () => {
  // Đây là lỗi thật đã gặp: mã máy không đủ ký tự hex thì roomFor trả rỗng,
  // và create() rơi về UUID ngẫu nhiên => cài lại app là ra phòng chat khác,
  // mất topic cũ — đúng thứ cải đặt này sinh ra để chặn.
  const nonHex = 'DEV_KHACCHAIHTHU0001';
  const first = machine.roomFor(nonHex);
  assert.match(first, /^ROOM_WIN_[A-Z0-9]{8,40}$/);
  for (let i = 0; i < 4; i++) {
    delete require.cache[require.resolve('../src/machine-id')];
    assert.equal(require('../src/machine-id').roomFor(nonHex), first, 'phải luôn ra cùng một phòng');
  }
  // Mã kiểu UUID cũ cũng phải tất định.
  const fromUuid = machine.roomFor('11111111-2222-4333-8444-555555555555');
  assert.match(fromUuid, /^ROOM_WIN_[A-Z0-9]{8,40}$/);
});

test('roomFor trả về rỗng khi không có gì để băm', () => {
  assert.equal(machine.roomFor(''), '');
  assert.equal(machine.roomFor(null), '');
});

test('nguồn định danh được báo cáo để biết mã máy đang bám vào gì', () => {
  // 'registry' là ổn định; 'fallback' nghĩa là máy này không đọc được registry và
  // mã máy yếu hơn — cần biết để điều tra khi khách báo lạ.
  assert.ok(['registry', 'fallback'].includes(machine.kind()), 'kind phải là registry hoặc fallback');
  assert.ok(machine.fingerprint().length > 0, 'luôn phải có chuỗi đặc trưng máy');
});

test('không dùng những thứ khách tự đổi được (tên máy, tài khoản, card mạng)', () => {
  // Tên máy, tài khoản Windows và địa chỉ card mạng đều đổi trong vài giây và
  // từng làm khách mất key. Mã máy mới KHÔNG được dựa vào chúng.
  const os = require('node:os');
  const fp = machine.fingerprint().toLowerCase();
  const username = (() => { try { return String(os.userInfo().username).toLowerCase(); } catch { return ''; } })();
  const hostname = String(os.hostname()).toLowerCase();
  if (username.length >= 3) assert.ok(!fp.includes(username), 'không được lẫn tên tài khoản vào mã máy');
  if (hostname.length >= 3) assert.ok(!fp.includes(hostname), 'không được lẫn tên máy vào mã máy');
});
