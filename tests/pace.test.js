const { test } = require('node:test');
const assert = require('node:assert/strict');
const pace = require('../src/pace');
const WAF = JSON.stringify({ status: 403, message: 'Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.' });

test('wait() giữ chỗ: hai lần gọi cổng liên tiếp vẫn cách nhau tối thiểu MIN_GAP', async t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  // Đo khoảng cách giữa các lần HOÀN TẤT: lần đầu có thể tới lượt ngay (0ms) là đúng, còn hai lần
  // sau phải cách nhau >= MIN_GAP vì mỗi lần wait() đã giữ chỗ một mốc riêng.
  await pace.wait();
  const first = Date.now();
  await pace.wait();
  const second = Date.now();
  await pace.wait();
  const third = Date.now();
  // Timer của Node có thể lệch ~1ms, nên cho sai số 15ms.
  assert.ok(second - first >= pace.MIN_GAP - 15, `lần 1→2 chỉ cách ${second - first}ms, phải >= ${pace.MIN_GAP}ms`);
  assert.ok(third - second >= pace.MIN_GAP - 15, `lần 2→3 chỉ cách ${third - second}ms, phải >= ${pace.MIN_GAP}ms`);
});
test('nhiều task chờ song song vẫn không bắn cùng lúc (không nhân tốc độ gửi)', async t => {
  t.after(() => pace.resetRest());
  pace.resetRest();
  // Đo theo TỪNG waiter, không sắp xếp lại thời điểm hoàn tất: mốc được giữ chỗ theo đúng thứ tự
  // gọi (giữ chỗ là code đồng bộ, không await chen vào), nên waiter thứ i phải chờ ít nhất
  // i * MIN_GAP kể từ lúc nó gọi. Máy tải nặng chỉ làm waiter thức MUỘN hơn (chờ dài hơn) chứ
  // không bao giờ thức sớm, nên phép đo này không đỏ oan; còn nếu mọi waiter cùng thức một lúc
  // (lỗi cũ mà test này sinh ra để bắt) thì waited[1] và waited[2] đều ~0 và test đỏ ngay.
  const waited = [];
  await Promise.all([0, 1, 2].map(async i => {
    const from = Date.now();
    await pace.wait();
    waited[i] = Date.now() - from;
  }));
  assert.equal(waited.length, 3);
  assert.ok(waited[0] >= 0, `waiter đầu chờ ${waited[0]}ms`);
  assert.ok(waited[1] >= pace.MIN_GAP - 15, `hai lần bắn đầu chỉ cách ${waited[1]}ms, phải >= ${pace.MIN_GAP}ms`);
  assert.ok(waited[2] >= 2 * pace.MIN_GAP - 15, `waiter thứ ba chỉ chờ ${waited[2]}ms, phải >= ${2 * pace.MIN_GAP}ms`);
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
