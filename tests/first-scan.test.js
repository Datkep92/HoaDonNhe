'use strict';
// ---------------------------------------------------------------------------
// QUÉT LẦN ĐẦU CHO MST — 10 ngày gần nhất, mua vào rồi bán ra.
//
// Kiểm hai nhóm:
//   A. Cửa sổ ngày + tham số gửi đi (logic thuần, src/first-scan.js)
//   B. Quyết định chạy/không chạy — đây là chỗ dễ sai nhất, vì yêu cầu có 2 vế ngược nhau:
//        "chỉ chạy MỘT lần"  nhưng  "đăng nhập thất bại thì lần sau VẪN chạy"
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const firstScan = require(path.join(root, 'src', 'first-scan'));
const vnDate = require(path.join(root, 'src', 'vn-date'));
const { validateParams } = require(path.join(root, 'src', 'core'));

const DAY = 86400000;
const at = iso => Date.parse(iso);

// ------------------------------------------------------------------ A. Cửa sổ ngày

test('cửa sổ = 10 NGÀY TRỌN, gồm cả hôm nay (hôm nay − 9 → hôm nay), theo giờ VN', () => {
  const window = firstScan.windowFor(vnDate.dayOf, at('2026-09-29T08:00:00+07:00'));
  assert.deepEqual(window, { from: '2026-09-20', to: '2026-09-29' });
  // Đếm lại cho chắc: 20,21,…,29 = 10 ngày.
  const days = Math.round((at('2026-09-29T00:00:00+07:00') - at('2026-09-20T00:00:00+07:00')) / DAY) + 1;
  assert.equal(days, 10);
});

test('nửa đêm giờ VN vẫn tính đúng ngày VN (không lệch sang hôm trước)', () => {
  // 00:30 ngày 30/09 giờ VN = 17:30 ngày 29/09 UTC. Cắt chuỗi UTC sẽ ra 29/09 — SAI một ngày.
  const window = firstScan.windowFor(vnDate.dayOf, at('2026-09-30T00:30:00+07:00'));
  assert.deepEqual(window, { from: '2026-09-21', to: '2026-09-30' });
});

test('cửa sổ qua mốc tháng và mốc năm', () => {
  assert.deepEqual(firstScan.windowFor(vnDate.dayOf, at('2026-01-03T09:00:00+07:00')), { from: '2025-12-25', to: '2026-01-03' });
  assert.deepEqual(firstScan.windowFor(vnDate.dayOf, at('2026-03-05T09:00:00+07:00')), { from: '2026-02-24', to: '2026-03-05' });
});

test('cửa sổ qua ngày 29/02 của năm nhuận', () => {
  assert.deepEqual(firstScan.windowFor(vnDate.dayOf, at('2024-03-09T09:00:00+07:00')), { from: '2024-02-29', to: '2024-03-09' });
});

test('windowFor không bao giờ trả null (dayOf trả null khi giá trị hỏng)', () => {
  const window = firstScan.windowFor(vnDate.dayOf, at('2026-09-29T08:00:00+07:00'));
  assert.ok(window.from && window.to, 'phải có đủ from và to');
  assert.match(window.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(window.to, /^\d{4}-\d{2}-\d{2}$/);
});

// ------------------------------------------------------------------ A. Tham số gửi đi

test('MUA VÀO chạy TRƯỚC, BÁN RA chạy SAU — không song song', () => {
  const requests = firstScan.requestsFor({ from: '2026-09-20', to: '2026-09-29' });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.direction), ['purchase', 'sold'], 'thứ tự phải là mua vào rồi bán ra');
});

test('mặc định tải XML; hai chiều dùng CHUNG một khoảng ngày', () => {
  const requests = firstScan.requestsFor({ from: '2026-09-20', to: '2026-09-29' });
  for (const request of requests) {
    assert.deepEqual(request.formats, ['xml'], 'mặc định chỉ XML');
    assert.equal(request.from, '2026-09-20');
    assert.equal(request.to, '2026-09-29');
    assert.equal(request.family, 'both', 'cả hai nhóm hóa đơn');
    assert.equal(request.status, '', 'tất cả trạng thái');
  }
});

test('tham số sinh ra PHẢI qua được validateParams thật của core (nếu không server sẽ ném lỗi)', () => {
  const requests = firstScan.requestsFor(firstScan.windowFor(vnDate.dayOf, at('2026-09-29T08:00:00+07:00')));
  for (const request of requests) {
    const validated = validateParams(request); // ném lỗi nếu sai ⇒ test đỏ ngay
    assert.equal(validated.direction, request.direction);
    assert.deepEqual(validated.formats, ['xml']);
  }
});

// ------------------------------------------------------------------ B. Quyết định chạy

const recordWith = state => ({ mst: '4500677693', firstScan: { state, at: '', from: '', to: '' } });
const env = extra => ({ output: 'D:\\HoaDon', busy: false, alreadyQueued: false, ...extra });

test('MST CŨ (không có ô nhớ firstScan) KHÔNG chạy — đây là cách loại 9 MST đang có sẵn', () => {
  assert.equal(firstScan.decide({ mst: '1' }, env()).run, false);
  assert.equal(firstScan.decide(null, env()).run, false);
  assert.equal(firstScan.isEligible({ mst: '1' }), false);
  assert.equal(firstScan.isEligible(recordWith(firstScan.STATE.PENDING)), true);
});

test('MST mới thêm: pending ⇒ CHẠY', () => {
  const decision = firstScan.decide(recordWith(firstScan.STATE.PENDING), env());
  assert.equal(decision.run, true);
  assert.equal(decision.reason, 'quét lần đầu');
});

test('đã done ⇒ KHÔNG bao giờ chạy lại (đúng "chỉ 1 lần cho mỗi MST")', () => {
  assert.equal(firstScan.decide(recordWith(firstScan.STATE.DONE), env()).run, false);
});

test('đang running ⇒ không chạy chồng (kể cả khi app bị tắt ngang lần trước)', () => {
  assert.equal(firstScan.decide(recordWith(firstScan.STATE.RUNNING), env()).run, false);
});

test('quét LỖI lần trước (failed) ⇒ cho chạy lại ở lần đăng nhập sau', () => {
  const decision = firstScan.decide(recordWith(firstScan.STATE.FAILED), env());
  assert.equal(decision.run, true);
  assert.equal(decision.reason, 'chạy lại sau lỗi');
});

// Thời gian "nguội" sau lỗi: checkLogin() chạy mỗi lần khách bấm vào dòng MST còn phiên sẵn, nên
// không chặn thì bấm lia lịa sẽ dội liên tiếp request vào cổng thuế.
const failedAt = iso => ({ mst: '4500677693', firstScan: { state: firstScan.STATE.FAILED, at: iso, from: '', to: '' } });

test('quét LỖI vừa xong ⇒ CHƯA thử lại (tránh bấm lia lịa)', () => {
  const record = failedAt('2026-09-29T08:00:00.000Z');
  assert.equal(firstScan.decide(record, env({ now: Date.parse('2026-09-29T08:10:00.000Z') })).run, false);
});

test('quét LỖI đã quá 30 phút ⇒ cho thử lại', () => {
  const record = failedAt('2026-09-29T08:00:00.000Z');
  assert.equal(firstScan.decide(record, env({ now: Date.parse('2026-09-29T08:31:00.000Z') })).run, true);
});

test('không truyền `now` ⇒ bỏ qua thời gian nguội (chỗ gọi cũ không bị chặn oan)', () => {
  assert.equal(firstScan.decide(failedAt('2026-09-29T08:00:00.000Z'), env()).run, true);
});

test('chưa có THƯ MỤC LƯU ⇒ không chạy (không có chỗ ghi file)', () => {
  assert.equal(firstScan.decide(recordWith(firstScan.STATE.PENDING), env({ output: '' })).run, false);
});
test('MST đang bận tác vụ khác ⇒ không chen vào', () => {
  assert.equal(firstScan.decide(recordWith(firstScan.STATE.PENDING), env({ busy: true })).run, false);
});

test('đã xếp hàng rồi ⇒ không xếp lần hai (đăng nhập vài lần liên tiếp)', () => {
  assert.equal(firstScan.decide(recordWith(firstScan.STATE.PENDING), env({ alreadyQueued: true })).run, false);
});

test('ô nhớ mới của MST vừa thêm bắt đầu ở trạng thái pending', () => {
  const record = firstScan.newRecord();
  assert.equal(record.state, firstScan.STATE.PENDING);
  assert.deepEqual(Object.keys(record).sort(), ['at', 'from', 'state', 'to']);
});

test('BỐN trạng thái đều có tên rõ ràng (đổi tên là phải sửa test này)', () => {
  assert.deepEqual(Object.values(firstScan.STATE).sort(), ['done', 'failed', 'pending', 'running']);
});

test('cửa sổ 10 ngày là hằng số dùng chung, không hard-code rải rác', () => {
  assert.equal(firstScan.WINDOW_DAYS, 10);
});
