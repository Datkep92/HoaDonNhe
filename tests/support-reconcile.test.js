'use strict';
// ---------------------------------------------------------------------------
// CÔNG CỤ ĐỐI SOÁT — phần thuần (không gọi mạng) nên test trực tiếp được.
//
// Đây là "bảng kiểm" cho mục tiêu 1 máy = 1 mã = 1 phòng = 1 topic. Nếu không
// có test, một lần refactor sai là hỏng âm thầm mà lúc chạy thật mới biết.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../tools/support-reconcile.cjs');

const DAY = 86400000;
const now = 1_800_000_000_000;
const codes = (snapshot, at) => analyze(snapshot, at || now).problems.map(p => p.code);
const room = (thread, messages = {}) => ({ meta: thread ? { telegramThreadId: thread } : {}, messages });

test('dữ liệu sạch: mỗi phòng một topic, mapping hai chiều khớp', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10), ROOM_WIN_B: room(11) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' }, 11: { chatRoomId: 'ROOM_WIN_B' } },
    devices: { ROOM_WIN_A: { license: { status: 'Active' }, presence: { lastSeen: now - DAY } } },
  };
  const { summary, problems } = analyze(snapshot);
  assert.equal(summary.errors, 0, JSON.stringify(problems, null, 2));
  assert.deepEqual(summary.orphanTopics, []);
});

test('phòng có topic nhưng thiếu mapping ngược -> admin gõ sẽ rơi im lặng (LỖI)', () => {
  const snapshot = { rooms: { ROOM_WIN_A: room(10) }, topics: {}, devices: {} };
  assert.ok(codes(snapshot).includes('thieu-mapping'));
  assert.equal(analyze(snapshot).summary.errors, 1);
});

test('một phòng bị nhiều topic trỏ tới -> phải chỉ ra đúng topic thừa', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' }, 11: { chatRoomId: 'ROOM_WIN_A' }, 12: { chatRoomId: 'ROOM_WIN_A' } },
    devices: {},
  };
  const { problems, summary } = analyze(snapshot);
  assert.ok(problems.some(p => p.code === 'mot-phong-nhieu-topic'));
  // Topic đang dùng là 10; 11 và 12 mới là thừa.
  assert.deepEqual(summary.orphanTopics, [11, 12]);
});

test('topic trỏ sang phòng khác -> báo lệch, KHÔNG tự coi là topic thừa', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10), ROOM_WIN_B: room(20) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_B' }, 20: { chatRoomId: 'ROOM_WIN_B' } },
    devices: {},
  };
  const { problems, summary } = analyze(snapshot);
  assert.ok(problems.some(p => p.code === 'topic-tro-sai-phong'));
  // Topic 10 đang bị TRANH: ROOM_WIN_A trỏ vào nó. Xoá đi là cắt liên kết của
  // ROOM_WIN_A, nên phải sửa tay bằng /link chứ không đưa vào danh sách dọn.
  assert.deepEqual(summary.orphanTopics, []);
  assert.deepEqual(summary.contestedTopics, [10]);
});

test('chỉ dọn được topic thừa mà KHÔNG phòng nào đang trỏ tới', () => {
  // ROOM_WIN_A dùng topic 10 và 11 (bị trùng do lỗi cũ). Topic 11 không phòng
  // nào dùng -> dọn được. Nhưng nếu ROOM_WIN_B cũng trỏ 11 thì phải để nguyên.
  const clean = analyze({
    rooms: { ROOM_WIN_A: room(10), ROOM_WIN_B: room(20) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' }, 11: { chatRoomId: 'ROOM_WIN_A' }, 20: { chatRoomId: 'ROOM_WIN_B' } },
    devices: {},
  });
  assert.deepEqual(clean.summary.orphanTopics, [11]);

  const contested = analyze({
    rooms: { ROOM_WIN_A: room(10), ROOM_WIN_B: room(11) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' }, 11: { chatRoomId: 'ROOM_WIN_A' } },
    devices: {},
  });
  // Topic 11 là topic đang dùng của ROOM_WIN_B nên dù bị trùng cũng KHÔNG được
  // xoá tự động — xoá là cắt liên kết của B. Phải sửa tay bằng /link.
  assert.deepEqual(contested.summary.orphanTopics, []);
  assert.deepEqual(contested.summary.contestedTopics, [11],
    'chính topic bị tranh mới cần sửa tay, không phải topic kia');
});

test('topic trỏ về phòng không tồn tại -> cảnh báo', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' }, 11: { chatRoomId: 'ROOM_WIN_BI_XOA' } },
    devices: {},
  };
  assert.ok(codes(snapshot).includes('topic-tro-phong-khong-ton-tai'));
});

test('phòng có tin nhắn nhưng chưa đồng bộ lần nào -> cảnh báo, không phải lỗi', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10, { m1: 1, m2: 2 }) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' } },
    devices: {},
  };
  const { problems, summary } = analyze(snapshot);
  const found = problems.find(p => p.code === 'chua-co-ban-ghi-nho');
  assert.ok(found);
  assert.equal(found.level, 'warn');
  assert.equal(summary.errors, 0, 'thiếu bản ghi nhớ chỉ là cảnh báo, không phải lỗi dữ liệu');
});

test('phòng mới chưa có tin, chưa có topic, chưa có gì -> chỉ là thông tin', () => {
  const snapshot = { rooms: { ROOM_WIN_MOI: { meta: {}, messages: {} } }, topics: {}, devices: {} };
  const { problems, summary } = analyze(snapshot);
  assert.equal(problems.find(p => p.code === 'room-chua-co-topic').level, 'info');
  assert.equal(summary.errors + summary.warns, 0);
});

test('máy lâu không mở app thì báo, kèm phiên bản đang chạy', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' } },
    devices: { ROOM_WIN_A: { license: { status: 'Active' }, presence: { lastSeen: now - 45 * DAY, appVersion: '1.0.5' } } },
  };
  const found = analyze(snapshot, now).problems.find(p => p.code === 'khong-mo-app-lau');
  assert.ok(found);
  assert.match(found.title, /45 ngày/);
  assert.match(found.detail, /1\.0\.5/);
});

test('máy vừa mở app thì không báo gì về presence', () => {
  const snapshot = {
    rooms: { ROOM_WIN_A: room(10) },
    topics: { 10: { chatRoomId: 'ROOM_WIN_A' } },
    devices: { ROOM_WIN_A: { license: { status: 'Active' }, presence: { lastSeen: now - 3600000, appVersion: '1.1.0' } } },
  };
  assert.ok(!codes(snapshot, now).includes('khong-mo-app-lau'));
  assert.ok(!codes(snapshot, now).includes('chua-co-presence'));
});

test('Firebase rỗng hoặc null thì không nổ, không báo nhầm', () => {
  for (const snapshot of [{}, { rooms: null, topics: null, devices: null }, { rooms: {}, topics: {}, devices: {} }]) {
    const { problems, summary } = analyze(snapshot);
    assert.equal(summary.errors, 0);
    assert.equal(problems.length, 0);
  }
});
