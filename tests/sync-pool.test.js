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

// ---------------------------------------------------------------------------
// DỪNG THEO YÊU CẦU KHÔNG PHẢI LỖI — người dùng bấm "Ngưng" thì kết thúc là BÌNH THƯỜNG.
// Trước đây mọi lỗi (kể cả lỗi `paused`) đều vào `failed`, nên banner hiện "N MST lỗi" sau mỗi
// lần người dùng ngưng, dù không có gì hỏng.
// ---------------------------------------------------------------------------
test('người dùng bấm Ngưng ⇒ MST vào `stopped`, KHÔNG vào `failed`', async () => {
  const h = harness({ concurrency: 2, msts: ['A', 'B'] });
  await flush();
  // `pause` trong test chỉ ghi nhận; engine thật ném lỗi có cờ paused.
  h.fail('A', 'Đã ngưng theo yêu cầu.');
  await flush();
  const status = h.pool.status();
  assert.deepEqual(status.stopped, ['A'], 'MST bị dừng nằm ở mục stopped');
  assert.deepEqual(status.failed, [], 'KHÔNG báo lỗi cho người dùng tự ngưng');
  assert.ok(!status.done.includes('A') && !status.skipped.includes('A'), 'dừng thì không tính là đồng bộ xong');
  h.finish('B');
  await h.run.done;
});

test('lỗi CÓ cờ paused (engine bị pause) cũng tính là dừng, không phải lỗi', async () => {
  const started = [];
  const pending = new Map();
  const pool = createSyncPool({
    concurrency: 1,
    runOne: mst => { started.push(mst); return new Promise((resolve, reject) => pending.set(mst, { resolve, reject })); },
    pause: () => {},
    log: () => {},
  });
  const run = pool.start([{ mst: 'A' }]);
  await flush();
  // Engine thật ném Error kèm cờ `paused` (xem core.js → run()/pause()).
  const error = Object.assign(new Error('Đã tạm dừng. Có thể tải tiếp.'), { paused: true });
  pending.get('A').reject(error);
  await flush();
  const status = await run.done;
  assert.deepEqual(status.stopped, ['A'], 'cờ paused phải được nhận ra');
  assert.deepEqual(status.failed, [], 'cờ paused không được báo thành lỗi');
});

test('lỗi THẬT vẫn phải vào `failed` — không được nuốt mất', async () => {
  const h = harness({ concurrency: 1, msts: ['A'] });
  await flush();
  h.fail('A', 'hết phiên');
  await flush();
  const status = await h.run.done;
  assert.deepEqual(status.stopped, [], 'lỗi thật không được đánh dấu dừng');
  assert.deepEqual(status.failed, [{ mst: 'A', error: 'hết phiên' }], 'lỗi thật phải còn nguyên');
});

test('runDirection trả `stopped: true` (lượt tự nhường) cũng không tính là lỗi', async () => {
  const pool = createSyncPool({
    concurrency: 2,
    runOne: async mst => (mst === 'A' ? { stopped: true } : {}),
    log: () => {},
  });
  const run = pool.start([{ mst: 'A' }, { mst: 'B' }]);
  const status = await run.done;
  assert.deepEqual(status.stopped, ['A']);
  assert.deepEqual(status.failed, []);
  assert.deepEqual(status.done, ['B'], 'MST chạy trọn vẫn nằm ở done');
});

test('có việc ưu tiên cao hơn ⇒ bể KHÔNG mở luồng nào', async () => {
  // `shouldStop` dùng để nhường quét bù / khoá thư mục lưu của bản app khác (server.js).
  // Bể phải từ chối ngay lúc start, không phải mở 3 luồng rồi mới dừng giữa chừng.
  let blocked = true;
  const started = [];
  const pool = createSyncPool({
    concurrency: 3,
    runOne: async mst => { started.push(mst); return {}; },
    shouldStop: () => blocked,
    log: () => {},
  });
  const run = pool.start([{ mst: 'A' }, { mst: 'B' }, { mst: 'C' }]);
  assert.equal(run.started, false, 'phải từ chối ngay, không mở luồng');
  assert.equal(pool.running, false, 'không được để lại trạng thái đang chạy');
  assert.deepEqual(started, [], 'không MST nào được chạm vào');
  assert.match(run.reason, /ưu tiên/i);

  // Hết vật cản thì chạy bình thường.
  blocked = false;
  const run2 = pool.start([{ mst: 'A' }]);
  assert.equal(run2.started, true);
  await run2.done;
  assert.deepEqual(started, ['A']);
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

// ---------------------------------------------------------------------------
// TỔNG KẾT BỂ — trước đây bể xong là im lặng: người dùng không biết MST nào đồng bộ, MST nào lỗi,
// phải tự click từng dòng MST. Và bấm Ngưng (việc chính họ yêu cầu) lại hiện như lỗi.
// ---------------------------------------------------------------------------
test('giao diện báo tổng kết bể: xong / đã dừng / lỗi — và bấm Ngưng không bị báo là lỗi', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('function reportPoolOutcome()'), 'phải có hàm báo tổng kết bể');
  const start = renderer.indexOf('function reportPoolOutcome()');
  const body = renderer.slice(start, renderer.indexOf('\n}', start));
  // Đọc cả ba nhóm kết quả từ status() của bể.
  for (const key of ['done', 'failed', 'stopped']) {
    assert.ok(body.includes(`pool.${key}`), `phải đọc pool.${key} từ status()`);
  }
  // Chỉ báo MỘT lần cho mỗi kết quả (vòng poll 0,8s không được spam toast).
  assert.ok(renderer.includes('let lastPoolReport'), 'phải có chốt chống báo lặp');
  assert.ok(body.includes('lastPoolReport'), 'phải so chữ ký kết quả để không báo hai lần');
  assert.ok(body.includes("pool.running) return"), 'đang chạy thì chưa báo gì');
  // Cần nói rõ "đã dừng" khác "lỗi" — hai thứ khác nhau về nghĩa.
  assert.ok(body.includes('đã dừng') && body.includes('MST lỗi'), 'phải phân biệt dừng và lỗi');
  // Khởi động lại bẻ / ngưng thì phải xoá chốt, không thì lượt sau bị im lặng.
  assert.ok(renderer.includes('function resetPoolReport()'), 'phải có cách xoá chốt khi bể chạy lại');
  assert.ok(renderer.includes('resetPoolReport();'), 'phải gọi resetPoolReport() khi bắt đầu bể mới');
  assert.ok(renderer.includes("lastPoolReport = '';\n    return;"), 'bấm Ngưng cũng phải xoá chốt');
  // Hàm phải được gọi trong render() để bắt được lúc bể vừa xong. Cắt tới hàm khai báo kế tiếp
  // ở cấp cao nhất — `indexOf('\n}')` sẽ dừng ở dấu đóng của một hàm LỒNG BÊN TRONG render()
  // (sessionHint chẳng hạn) nên cắt thiếu.
  const renderStart = renderer.indexOf('function render(state)');
  const renderBody = renderer.slice(renderStart, renderer.indexOf('\nfunction ', renderStart));
  assert.ok(renderStart > -1 && renderBody.includes('const pool = state.pool'), 'cắt sai khối render()');
  assert.ok(renderBody.includes('reportPoolOutcome();'), 'render() phải gọi reportPoolOutcome()');
});
