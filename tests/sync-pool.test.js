'use strict';
// ---------------------------------------------------------------------------
// BỂ "ĐỒNG BỘ TẤT CẢ" — chạy song song nhiều MST, giữ LUÔN đủ số luồng.
// Yêu cầu người dùng: "cho 3 cái chạy, cái nào xong thì cái tiếp theo" — luôn có 3 luồng chạy.
// Không gọi mạng: `runOne` là hàm giả có thể kết thúc chủ động.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSyncPool } = require('../src/data/sync-pool');

const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ concurrency = 3, msts = [] } = {}) {
  const started = [];
  const pauses = [];
  const pending = new Map();
  const pool = createSyncPool({
    concurrency,
    runOne: mst => { started.push(mst); return new Promise((resolve, reject) => pending.set(mst, { resolve, reject })); },
    pause: mst => pauses.push(mst),
    log: () => {},
  });
  const run = pool.start(msts.map(mst => ({ mst })));
  const finish = mst => { const p = pending.get(mst); pending.delete(mst); p.resolve({}); };
  const fail = (mst, message) => { const p = pending.get(mst); pending.delete(mst); p.reject(new Error(message)); };
  return { pool, run, started, pauses, finish, fail, pending };
}

test('giữ LUÔN đủ 3 luồng: MST nào xong thì rút ngay MST kế tiếp', async () => {
  const h = harness({ concurrency: 3, msts: ['A', 'B', 'C', 'D', 'E'] });
  await flush();
  assert.deepEqual(h.started, ['A', 'B', 'C'], 'bắt đầu đúng 3 luồng');
  assert.equal(h.pool.status().active.length, 3);
  assert.deepEqual(h.pool.status().queued, ['D', 'E']);

  h.finish('A');
  await flush();
  assert.deepEqual(h.started, ['A', 'B', 'C', 'D'], 'A xong ⇒ D vào ngay, không để trống luồng');
  assert.equal(h.pool.status().active.length, 3, 'vẫn đủ 3 luồng');

  h.finish('B');
  await flush();
  assert.deepEqual(h.started, ['A', 'B', 'C', 'D', 'E'], 'B xong ⇒ E vào ngay');
  assert.equal(h.pool.status().active.length, 3);

  h.finish('C'); h.finish('D'); h.finish('E');
  const final = await h.run.done;
  assert.equal(final.running, false);
  assert.deepEqual(final.done.sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(final.failed.length, 0);
});

test('KHÔNG bao giờ vượt quá số luồng cho phép', async () => {
  const h = harness({ concurrency: 3, msts: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] });
  await flush();
  assert.equal(h.started.length, 3);
  h.finish('A'); await flush();
  assert.equal(h.pool.status().active.length, 3, 'luôn ≤ 3');
  h.finish('B'); await flush();
  assert.equal(h.pool.status().active.length, 3);
  assert.equal(h.pool.status().concurrency, 3);
  // Dọn sạch: phải kết thúc LẶP cho tới khi không còn MST treo — vì mỗi lần xong lại có MST mới
  // được rút lên (kết thúc theo một ảnh chụp cũ sẽ bỏ sót F/G và làm test treo).
  for (let i = 0; i < 20 && h.pending.size; i += 1) {
    for (const mst of [...h.pending.keys()]) h.finish(mst);
    await flush();
  }
  await h.run.done;
});

test('ít MST hơn số luồng thì chỉ mở đúng số đó', async () => {
  const h = harness({ concurrency: 3, msts: ['A', 'B'] });
  await flush();
  assert.deepEqual(h.started, ['A', 'B']);
  assert.equal(h.run.concurrency, 2, 'chỉ mở 2 luồng khi hàng đợi chỉ có 2');
  h.finish('A'); h.finish('B');
  const final = await h.run.done;
  assert.deepEqual(final.done.sort(), ['A', 'B']);
});

test('một MST lỗi KHÔNG làm chết các luồng khác', async () => {
  const h = harness({ concurrency: 2, msts: ['A', 'B', 'C'] });
  await flush();
  h.fail('A', 'hết phiên');
  await flush();
  assert.deepEqual(h.started, ['A', 'B', 'C'], 'C vẫn được rút lên dù A lỗi');
  h.finish('B'); h.finish('C');
  const final = await h.run.done;
  assert.deepEqual(final.failed, [{ mst: 'A', error: 'hết phiên' }]);
  assert.deepEqual(final.done.sort(), ['B', 'C']);
});

test('ngưng: thôi rút việc mới, pause các luồng đang chạy, xoá hàng đợi', async () => {
  const h = harness({ concurrency: 3, msts: ['A', 'B', 'C', 'D', 'E'] });
  await flush();
  assert.equal(h.pool.stop(), true);
  assert.deepEqual(h.pauses.sort(), ['A', 'B', 'C'], 'pause đúng các luồng đang chạy');
  assert.deepEqual(h.pool.status().queued, [], 'hàng đợi bị xoá');
  // Gọi ngưng lần hai khi các luồng còn đang dừng thì vẫn phải pause lại (idempotent) —
  // chỉ trả false khi KHÔNG còn gì để ngưng.
  assert.equal(h.pool.stop(), true, 'còn luồng đang dừng ⇒ vẫn có việc để ngưng');

  h.finish('A'); h.finish('B'); h.finish('C');
  const final = await h.run.done;
  assert.equal(h.started.length, 3, 'KHÔNG rút thêm MST nào sau khi ngưng');
  assert.equal(final.running, false);
  assert.equal(h.pool.stop(), false, 'đã sạch thì ngưng không làm gì nữa');
});

test('chạy trong lúc đang chạy thì báo lỗi; danh sách rỗng thì không mở luồng', async () => {
  const h = harness({ concurrency: 3, msts: ['A'] });
  await flush();
  assert.throws(() => h.pool.start([{ mst: 'B' }]), /đang chạy/);
  h.finish('A');
  await h.run.done;

  const empty = harness({ concurrency: 3, msts: [] });
  assert.equal(empty.run.started, false);
  assert.match(empty.run.reason, /không có MST nào/);
});

test('isActive cho biết MST nào đang trong bể (để lịch nền không tranh)', async () => {
  const h = harness({ concurrency: 2, msts: ['A', 'B'] });
  await flush();
  assert.equal(h.pool.isActive('A'), true);
  assert.equal(h.pool.isActive('Z'), false);
  h.finish('A');
  await flush();
  assert.equal(h.pool.isActive('A'), false, 'xong thì không còn tính là đang chạy');
  h.finish('B');
  await h.run.done;
});

test('server và giao diện đã nối đúng nút "Đồng bộ tất cả"', () => {
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const server = read('src/server.js');
  assert.ok(server.includes("'/api/db/autosync/run-all'"), 'thiếu endpoint chạy tất cả');
  assert.ok(server.includes("'/api/db/autosync/run-all/stop'"), 'thiếu endpoint ngưng tất cả');
  assert.ok(server.includes('concurrency: 3'), 'số luồng phải là 3');
  assert.ok(server.includes('runOne: mst => autoSyncFor(mst).run(\'pool\')'), 'mỗi MST chạy bằng Auto Sync riêng của nó');
  assert.ok(server.includes('if (syncPool.running) return true;'), 'lịch nền phải đứng ngoài khi bể đang chạy');
  assert.ok(server.includes('if (syncPool.isActive(mst)) continue;'), 'không chạy trùng MST đang trong bể');
  assert.ok(server.includes('pool: syncPool.status()'), 'phải gửi trạng thái bể ra giao diện');

  const html = read('src/index.html');
  assert.ok(html.includes('id="sync-all"'), 'thiếu nút Đồng bộ tất cả');
  const renderer = read('src/renderer.js');
  assert.ok(renderer.includes("'/api/db/autosync/run-all'"), 'nút chưa gọi endpoint chạy tất cả');
  assert.ok(renderer.includes('Đang đồng bộ ${lanes} luồng · Ngưng'), 'nút phải hiện số luồng đang chạy và cho ngưng');
});
