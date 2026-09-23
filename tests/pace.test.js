const { test } = require('node:test');
const assert = require('node:assert/strict');
const pace = require('../src/pace');
const WAF = JSON.stringify({ status: 403, message: 'Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.' });

test('two portal calls are spaced by a minimum gap', async t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  const startedAt = Date.now();
  pace.mark();
  assert.ok(pace.gapMs() > 0, 'the next call must wait before firing again');
  await pace.wait();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= pace.MIN_GAP, `chỉ chờ ${elapsed}ms, phải >= ${pace.MIN_GAP}ms`);
  // Timer của Node có thể lệch ~1ms so với đồng hồ tường, nên chỉ đòi hết khoảng cách
  // trong sai số nhỏ — assert gapMs() === 0 tuyệt đối từng làm CI đỏ oan.
  assert.ok(pace.gapMs() <= 2, `vẫn còn phải chờ ${pace.gapMs()}ms`);
});
test('429 rests with exponential backoff and honours the portal Retry-After', t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  assert.equal(Math.round(pace.note(429, '{}') / 1000), 20);
  assert.match(pace.blocked(), /HTTP 429/);
  assert.equal(Math.round(pace.note(429, '{}', '3') / 1000), 3);
  pace.resetRest();
  assert.equal(pace.blocked(), '');
  assert.equal(pace.note(200, '{}'), 0);
});
test('the behaviour block (403) always rests ten minutes', t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  assert.equal(Math.round(pace.note(403, WAF) / 60000), 10);
  assert.throws(() => pace.guard(), /tạm từ chối truy cập/);
  pace.resetRest();
  assert.doesNotThrow(() => pace.guard());
});
test('a normal answer clears the rest and a plain 404 does not pause anything', t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  pace.note(404, 'not found');
  assert.equal(pace.restRemaining(), 0);
  pace.note(403, 'forbidden');
  assert.equal(pace.restRemaining(), 0, 'a 403 without the blocking message is not a portal block');
});
