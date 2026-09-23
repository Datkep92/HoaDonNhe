'use strict';
// ---------------------------------------------------------------------------
// Test PHASE 5 – BACKFILL (§29/§67/§83).
// Phần kế hoạch kỳ (Năm/Quý/Tháng/Khoảng ngày) và bộ chạy job test được hoàn toàn không cần mạng.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlan, createBackfillJob } = require('../src/data/backfill');

test('buildPlan: theo tháng (xử lý đúng tháng 2 năm nhuận)', () => {
  assert.deepEqual(buildPlan({ mode: 'month', year: 2024, month: 2, directions: ['BUY'] }), {
    from: '2024-02-01', to: '2024-02-29', directions: ['BUY'], label: 'Tháng 02/2024',
  });
  assert.equal(buildPlan({ mode: 'month', year: 2025, month: 2 }).to, '2025-02-28');
  assert.equal(buildPlan({ mode: 'month', year: 2026, month: 9 }).from, '2026-09-01');
  assert.equal(buildPlan({ mode: 'month', year: 2026, month: 9 }).to, '2026-09-30');
});

test('buildPlan: theo quý và cả năm', () => {
  assert.deepEqual(buildPlan({ mode: 'quarter', year: 2025, quarter: 1 }).from, '2025-01-01');
  assert.deepEqual(buildPlan({ mode: 'quarter', year: 2025, quarter: 1 }).to, '2025-03-31');
  assert.equal(buildPlan({ mode: 'quarter', year: 2025, quarter: 4 }).from, '2025-10-01');
  assert.equal(buildPlan({ mode: 'quarter', year: 2025, quarter: 4 }).to, '2025-12-31');
  assert.deepEqual(buildPlan({ mode: 'year', year: 2026 }).from, '2026-01-01');
  assert.equal(buildPlan({ mode: 'year', year: 2026 }).to, '2026-12-31');
  assert.equal(buildPlan({ mode: 'year', year: 2026 }).label, 'Năm 2026');
});

test('buildPlan: khoảng ngày tự chọn', () => {
  const plan = buildPlan({ mode: 'range', from: '2026-01-01', to: '2026-09-23' });
  assert.equal(plan.from, '2026-01-01');
  assert.equal(plan.to, '2026-09-23');
  assert.deepEqual(plan.directions, ['BUY', 'SELL'], 'mặc định chạy cả hai chiều');
  assert.equal(plan.label, '2026-01-01 → 2026-09-23');
});

test('buildPlan: từ chối dữ liệu sai rõ ràng (không đoán)', () => {
  assert.throws(() => buildPlan({ mode: 'month', year: 1999, month: 1 }), /Năm không hợp lệ/);
  assert.throws(() => buildPlan({ mode: 'month', year: 2026, month: 13 }), /Tháng phải là 1–12/);
  assert.throws(() => buildPlan({ mode: 'quarter', year: 2026, quarter: 5 }), /Quý phải là 1, 2, 3 hoặc 4/);
  assert.throws(() => buildPlan({ mode: 'range', from: '2026-09-23', to: '2026-01-01' }), /Ngày bắt đầu phải trước/);
  assert.throws(() => buildPlan({ mode: 'range', from: '23/09/2026', to: '2026-09-30' }), /Khoảng ngày không hợp lệ/);
  assert.throws(() => buildPlan({ mode: 'khong-co', year: 2026 }), /Kiểu tải lịch sử không hợp lệ/);
  assert.throws(() => buildPlan({ mode: 'month', year: 2026, month: 1, directions: ['KHONG'] }), /Chọn ít nhất một chiều/);
});

test('job backfill: chạy tuần tự theo chiều, cộng dồn số liệu, ghi bước', async () => {
  const order = [];
  const job = createBackfillJob({
    runRange: async ({ direction, from, to, onProgress }) => {
      order.push(`${direction}:${from}→${to}`);
      onProgress({ message: `đang xử lý ${direction}`, total: 4, done: 2 });
      return { found: 10, downloaded: 3, skipped: 7, imported: 3, errors: 0 };
    },
  });
  const plan = buildPlan({ mode: 'month', year: 2026, month: 9 });
  const finished = await job.start({ plan });
  assert.deepEqual(order, ['BUY:2026-09-01→2026-09-30', 'SELL:2026-09-01→2026-09-30']);
  assert.equal(finished.running, false);
  assert.equal(finished.ok, true);
  assert.equal(finished.totals.found, 20, 'cộng dồn cả hai chiều');
  assert.equal(finished.totals.downloaded, 6);
  assert.equal(finished.totals.imported, 6);
  assert.equal(finished.steps.length, 2);
  assert.ok(finished.startedAt && finished.finishedAt);
  assert.equal(job.status().running, false);
});

test('job backfill: một chiều lỗi không làm chết chiều còn lại (mục 42/71)', async () => {
  const job = createBackfillJob({
    runRange: async ({ direction }) => {
      if (direction === 'BUY') throw new Error('Phiên cổng thuế đã hết');
      return { found: 2, downloaded: 0, skipped: 2, imported: 0, errors: 0 };
    },
  });
  const finished = await job.start({ plan: buildPlan({ mode: 'year', year: 2026 }) });
  assert.equal(finished.ok, false);
  assert.match(finished.error, /Phiên cổng thuế đã hết/);
  assert.equal(finished.steps[0].ok, false);
  assert.equal(finished.steps[1].ok, true, 'chiều Bán ra vẫn chạy');
  assert.equal(finished.totals.found, 2);
});

test('job backfill: dừng giữa đường thì không chạy chiều tiếp theo', async () => {
  let job = null;
  job = createBackfillJob({
    runRange: async ({ direction }) => {
      if (direction === 'BUY') job.cancel(); // người dùng bấm Dừng trong lúc đang chạy
      return { found: 1, downloaded: 0, skipped: 1, imported: 0, errors: 0 };
    },
  });
  const finished = await job.start({ plan: buildPlan({ mode: 'range', from: '2026-01-01', to: '2026-09-30' }) });
  assert.equal(finished.cancelled, true);
  assert.equal(finished.steps.length, 1, 'không chạy chiều Bán ra sau khi đã dừng');
  assert.equal(finished.ok, false);
});

test('job backfill: không cho chạy chồng; status() đủ dữ liệu cho UI', async () => {
  const job = createBackfillJob({
    runRange: async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return { found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 };
    },
  });
  const before = job.status();
  assert.equal(before.running, false);
  assert.equal(before.finishedAt, null);
  assert.deepEqual(before.totals, { found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 });

  const running = job.start({ plan: buildPlan({ mode: 'month', year: 2026, month: 9 }) });
  await assert.rejects(job.start({ plan: buildPlan({ mode: 'month', year: 2026, month: 10 }) }), /Đang tải lịch sử/);
  await running;
  assert.equal(job.status().running, false);

  await assert.rejects(job.start({ plan: {} }), /Thiếu khoảng ngày/);
});
