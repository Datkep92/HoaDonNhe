'use strict';
// ---------------------------------------------------------------------------
// Test NHANH hành vi "bị cổng thuế chặn" mà KHÔNG phải chờ đủ 10 phút thật.
// Dùng biến môi trường HOADON_NGHI_MS để hạ mức nghỉ xuống vài giây.
// Không gọi mạng, không cần cổng thuế. Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pace = require('../src/pace');

// Đúng chuỗi mà cổng thuế trả khi chặn vì hành vi không hợp lệ.
const WAF = JSON.stringify({ status: 403, message: 'Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.' });

function withRestEnv(t, value) {
  const old = process.env.HOADON_NGHI_MS;
  if (value === undefined) delete process.env.HOADON_NGHI_MS; else process.env.HOADON_NGHI_MS = String(value);
  t.after(() => {
    if (old === undefined) delete process.env.HOADON_NGHI_MS; else process.env.HOADON_NGHI_MS = old;
    pace.resetRest();
  });
  pace.resetRest();
}

test('HOADON_NGHI_MS thấp: chặn 403 chỉ nghỉ ngắn rồi tự mở lại (không cần chờ 10 phút)', async t => {
  withRestEnv(t, 1500); // 1,5 giây thay vì 10 phút

  const waited = pace.note(403, WAF);
  assert.equal(waited, 1500, 'nghỉ đúng mức cấu hình thấp');
  assert.ok(pace.restRemaining() > 0 && pace.restRemaining() <= 1500, 'còn trong thời gian nghỉ');
  assert.match(pace.blocked(), /tạm từ chối truy cập/);
  assert.throws(() => pace.guard(), /tạm từ chối truy cập/, 'đang nghỉ thì chặn gọi mới');

  // Chờ hết mức nghỉ thấp ⇒ phải đi lại được, KHÔNG phải đợi 10 phút thật.
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(pace.restRemaining(), 0, 'hết mức nghỉ thấp thì tự mở lại');
  assert.equal(pace.blocked(), '');
  assert.doesNotThrow(() => pace.guard());
  assert.equal(pace.note(200, '{}'), 0, 'response thành công cũng xoá nghỉ');
});

test('429 cũng bị trần theo mức nghỉ thấp, nhưng vẫn ưu tiên Retry-After của cổng', t => {
  withRestEnv(t, 1200);

  assert.equal(pace.note(429, '{}'), 1200, 'backoff 429 bị chặn trần theo HOADON_NGHI_MS');
  assert.match(pace.blocked(), /HTTP 429/);

  pace.resetRest();
  assert.equal(pace.note(429, '{}', '3'), 3000, 'Retry-After (giây) của cổng vẫn được tôn trọng');
});

test('không đặt HOADON_NGHI_MS: giữ nguyên 10 phút như trước (không đổi hành vi thật)', t => {
  withRestEnv(t, undefined);
  assert.equal(Math.round(pace.note(403, WAF) / 60000), 10, 'mặc định vẫn là 10 phút');
  assert.equal(pace.maxRest(), 10 * 60 * 1000);
});
