'use strict';
// ---------------------------------------------------------------------------
// TRẠNG THÁI ONLINE/OFFLINE TRONG TELEGRAM
//
// Quy ước nghiệp vụ (do người dùng quy định):
//   • app CHẠY NỀN trên thanh công cụ  ⇒ vẫn tính là ONLINE
//   • app KHÔNG MỞ                    ⇒ OFFLINE
//
// Ba nơi độc lập cùng quyết định "online" — lệch nhau là admin thấy mâu thuẫn ngay
// trong cùng một lúc:
//   1. src/server.js   — nhịp sống 10 phút (giữ lastSeen mới)
//   2. Worker          — isOnlineAt() + chấm 🟢/⚪️ trên tên topic
//   3. Code.gs         — list_devices / /online
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = path.join(__dirname, '..', 'cloudflare-worker', 'src', 'index.js');
const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const GAS = path.join(__dirname, '..', 'support-gateway', 'apps-script', 'Code.gs');

const workerSrc = fs.readFileSync(WORKER, 'utf8');
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const gasSrc = fs.readFileSync(GAS, 'utf8');

// Lấy đúng THÂN một hàm: từ tên hàm tới hàm kế tiếp. Cắt theo số ký tự thì dễ lấy
// nhầm hàm kế bên — ở đây hàm kế bên (startSupportChecks) CỐ Ý có needsServerCheck(),
// nên test sẽ báo động giả rất dễ gặp.
function bodyOf(src, name) {
  const at = src.indexOf(name);
  assert.ok(at > 0, 'không tìm thấy ' + name);
  const tail = src.slice(at);
  const end = tail.indexOf('\nfunction ');
  return end > 0 ? tail.slice(0, end) : tail.slice(0, 3000);
}

// ---------------------------------------------------------------------------
// 1. NHỊP SỐNG — thứ làm "chạy nền vẫn tính online" đúng
// ---------------------------------------------------------------------------
test('REGRESSION: app phải gửi nhịp sống đều khi chạy nền, không phụ thuộc cần hỏi bản quyền', () => {
  // Trước đây nhịp 4 giờ chỉ gọi /v1/ping KHI needsServerCheck() có lý do.
  // Key còn hạn + mã máy khớp ⇒ 4 giờ im lặng ⇒ Gateway báo offline sau 15 phút,
  // dù app vẫn đang chạy. Đúng lỗi người dùng báo.
  const fn = bodyOf(serverSrc, 'function startPresenceHeartbeat');
  assert.match(fn, /support\.ping\('nhip-song'\)/,
    'nhịp sống phải gửi vô điều kiện, không kiểm tra needsServerCheck()');
  assert.doesNotMatch(fn, /needsServerCheck/,
    'nhịp sống KHÔNG được phụ thuộc needsServerCheck()');
});

test('nhịp sống ngắn hơn cửa sổ online của Gateway, nếu không sẽ báo offline oan', () => {
  // Cửa sổ: ONLINE_WINDOW_MS = 15 * 60 * 1000 ⇒ 15 phút. Nhịp: base = 10 * 60 * 1000.
  const beat = Number(/const base = (\d+) \* 60 \* 1000/.exec(serverSrc)[1]);
  const win = Number(/ONLINE_WINDOW_MS\s*=\s*(\d+) \* 60 \* 1000/.exec(workerSrc)[1]);
  assert.ok(beat > 0 && win > 0, 'phải tìm thấy cả nhịp sống và cửa sổ online');
  assert.ok(beat < win, `nhịp ${beat} phút >= cửa sổ ${win} phút ⇒ máy ngủ một lượt là bị báo offline oan`);
  assert.ok(beat <= 15, `nhịp ${beat} phút là quá dày, tốn mạng vô ích`);
  // Hệ số an toàn: cửa sổ phải dư được ít nhất một nhịp trễ.
  assert.ok(win / beat >= 1.5, `cửa sổ ${win} phút trên nhịp ${beat} phút — thiếu biên an toàn`);
});

test('nhịp sống rải pha theo mã máy, không dồn tất cả về một giây', () => {
  const fn = bodyOf(serverSrc, 'function nextPresenceDelay');
  assert.match(fn, /machineId/, 'phải rải pha theo mã máy');
  assert.match(fn, /readUInt32BE/, 'dùng seed mã máy làm pha ngẫu nhiên ổn định');
});

test('nhịp sống chạy cùng lúc với nhịp kiểm tra bản quyền và không giữ tiến trình', () => {
  const start = bodyOf(serverSrc, 'function startSupportChecks');
  assert.match(start, /startPresenceHeartbeat\(\)/, 'phải khởi động nhịp sống');
  const fn = bodyOf(serverSrc, 'function startPresenceHeartbeat');
  assert.match(fn, /unref/, 'timer phải unref, nếu không app không thoát được');
});

// ---------------------------------------------------------------------------
// 2. NHẮN TIN = HOẠT ĐỘNG
// ---------------------------------------------------------------------------
test('REGRESSION: khách nhắn tin thì phải được tính là online', () => {
  // Đúng câu người dùng phản ánh: "khi chat với khách sẽ bị mất biểu tượng online".
  // Mốc neo: dòng gán deliveryStatus 'pending_telegram' — chỉ có ở nhánh khách gửi tin.
  // Mốc neo: câu chặn 'Invalid message.' — CHỈ có ở nhánh khách gửi tin.
  // Nhìn TỪ đây đi xuôi: khối ghi nhịp sống nằm SAU câu này, không phải trước.
  const at = workerSrc.indexOf("throw Error('Invalid message.')");
  assert.ok(at > 0, 'không tìm thấy nhánh gửi tin nhắn của khách');
  const after = workerSrc.slice(at, at + 900);
  assert.match(after, /presence_\(/, 'gửi tin nhắn phải ghi nhịp sống');
  assert.match(after, /isOnlineAt\(/, 'phải biết trạng thái cũ để quyết định có sửa topic không');
  assert.match(after, /sendToRoom|firebase\(/, 'phải kiểm tra đúng nhánh này chứ không phải nhánh khác');
});

test('chỉ presence_ được GHI lastSeen, các chỗ khác chỉ đọc', () => {
  // Nếu chỗ nào tự ghi lastSeen thì hai nơi sẽ tự quyết định trạng thái khác nhau.
  // Đếm TRONG THÂN presence_ thay vì cả file: file còn có nhiều chỗ ĐỌC lastSeen
  // (trả về cho app, sắp xếp báo cáo…) — đọc thì không sao, ghi mới là đáng ngờ.
  const fn = bodyOf(workerSrc, 'async function presence_');
  const writes = [...fn.matchAll(/lastSeen:/g)];
  assert.equal(writes.length, 1, `presence_ phải ghi lastSeen đúng một chỗ (thấy ${writes.length})`);
  assert.match(fn, /PUT/, 'ghi bằng PUT để không sinh dữ liệu rác trong Firebase');
});

// ---------------------------------------------------------------------------
// 3. CHẤM TRẠNG THÁI TRÊN TÊN TOPIC
// ---------------------------------------------------------------------------
test('tên topic có chấm trạng thái để admin thấy ngay trong danh sách topic', () => {
  const fn = bodyOf(workerSrc, 'function topicLabel');
  assert.match(fn, /🟢/, 'trạng thái online');
  assert.match(fn, /⚪️/, 'trạng thái offline');
  assert.match(fn, /slice\(0, 128\)/, 'Telegram chặn tên topic dài quá 128 ký tự');
});

test('REGRESSION: đổi tên/SĐT không được xoá mất chấm trạng thái', () => {
  // Trước đây announce() tự đặt tên topic bằng "SĐT - Tên". Mỗi lần khách đổi SĐT là
  // chấm 🟢/⚪️ bị xoá, admin lại tưởng app đã tắt.
  const fn = bodyOf(workerSrc, 'async function announce');
  assert.doesNotMatch(fn, /editForumTopic/,
    'announce() không được tự đặt tên topic nữa — tên do hàm trạng thái dựng');
  assert.match(fn, /contactPhone/, 'vẫn phải lưu thông tin liên hệ');
});

test('chỉ sửa tên topic khi trạng thái đổi, không sửa mỗi nhịp sống', () => {
  // Mỗi khách nhịp 10 phút: sửa vô điều kiện sẽ tốn rate limit và nhấp nháy tên topic.
  const fn = bodyOf(workerSrc, 'async function refreshTopicStatus_');
  assert.match(fn, /meta\.topicName === name/, 'phải so với tên đã áp dụng rồi mới sửa');
  assert.match(fn, /editForumTopic/);
  assert.match(fn, /topicName/, 'phải nhớ tên đã áp dụng để lần sau so');
});

test('REGRESSION: chấm trạng thái hỏng không được làm hỏng luồng nhắn tin / bản quyền', () => {
  const fn = bodyOf(workerSrc, 'async function refreshTopicStatus_');
  assert.match(fn, /catch[\s\S]*console\.log/, 'phải nuốt lỗi và ghi log');
  assert.match(fn, /trang trí/, 'phải nói rõ đây là phần trang trí');
});

test('sửa tên topic chỉ chạy khi trạng thái vừa chuyển sang online, không chạy mọi nhịp', () => {
  // ping_ chạy mỗi 10 phút cho MỌI khách. Gọi refreshTopicStatus_ ở mỗi nhịp thì
  // vẫn là 1 lời gọi Telegram mỗi 10 phút mỗi khách — đúng thứ cần tránh.
  const fn = bodyOf(workerSrc, 'async function ping_');
  assert.match(fn, /if \(!wasOnline\) await refreshTopicStatus_/, 'chỉ sửa khi chuyển sang online');
});

// ---------------------------------------------------------------------------
// 4. MỘT QUY ƯỚC THỜI GIAN DUY NHẤT
// ---------------------------------------------------------------------------
test('Worker và Apps Script dùng CÙNG một cửa sổ online', () => {
  const worker = /ONLINE_WINDOW_MS\s*=\s*(\d+) \* 60 \* 1000/.exec(workerSrc);
  const gas = /ONLINE_WINDOW_MS\s*=\s*(\d+) \* 60 \* 1000/.exec(gasSrc);
  assert.ok(worker && gas, 'phải có hằng ở cả hai');
  assert.equal(worker[1], gas[1],
    `Worker ${worker[1]} phút ≠ Apps Script ${gas[1]} phút ⇒ /online và chấm topic mâu thuẫn`);
});

test('/online và /who dùng CHUNG isOnlineAt, không tự tính riêng', () => {
  assert.match(bodyOf(workerSrc, 'async function onlineReport_'), /isOnlineAt\(/, '/online phải dùng hàm chung');
  const at = workerSrc.indexOf('/^\\/who(\\s|$)/i.test(text)');
  assert.ok(at > 0, 'phải có lệnh /who');
  assert.match(workerSrc.slice(at, at + 2000), /isOnlineAt\(/, '/who phải dùng hàm chung');
});

test('offline nghĩa là KHÔNG có tín hiệu trong cửa sổ, không phải "không phải online"', () => {
  const fn = bodyOf(workerSrc, 'function isOnlineAt');
  assert.match(fn, /at > 0/, 'chưa từng mở app thì không tính online');
  assert.match(fn, /<= ONLINE_WINDOW_MS/, 'ngoài cửa sổ thì offline');
});

// ---------------------------------------------------------------------------
// 5. LỆNH /who
// ---------------------------------------------------------------------------
test('có lệnh /who hỏi trạng thái tại chỗ và sửa lại chấm trên topic', () => {
  const at = workerSrc.indexOf('/^\\/who(\\s|$)/i.test(text)');
  assert.ok(at > 0, 'phải có lệnh /who');
  const body = workerSrc.slice(at, at + 2200);
  assert.match(body, /refreshTopicStatus_/, 'phải sửa lại chấm trên tên topic');
  assert.match(body, /🟢 ĐANG MỞ APP/);
  assert.match(body, /⚪️ ĐÃ ĐÓNG APP/);
  assert.match(body, /chế độ nền/, 'phải nói rõ app chạy nền vẫn dùng được');
});

test('/who nói rõ app đã đóng, không để admin hiểu là app lỗi', () => {
  const at = workerSrc.indexOf('/^\\/who(\\s|$)/i.test(text)');
  assert.match(workerSrc.slice(at, at + 2400), /app đang đóng/, 'nhánh offline phải nói thẳng là app đóng');
});

test('/who hoạt động kể cả khi topic chưa gắn thiết bị', () => {
  const at = workerSrc.indexOf('/^\\/who(\\s|$)/i.test(text)');
  assert.match(workerSrc.slice(at, at + 2400), /chưa gắn với thiết bị nào/, 'topic lạc phải báo rõ, không ném lỗi');
});

test('/who phải chạy TRƯỚC nhánh lệnh theo phòng, không bị nuốt vào admin_command', () => {
  const who = workerSrc.indexOf('/^\\/who(\\s|$)/i.test(text)');
  const admin = workerSrc.indexOf("action: 'admin_command', chatRoomId: room");
  assert.ok(who > 0 && admin > 0);
  assert.ok(who < admin, '/who phải đứng trước, nếu không sẽ rơi vào lệnh theo phòng');
});