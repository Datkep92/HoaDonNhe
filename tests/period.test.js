const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rangeFor, quarterOf } = require('../src/period');
const { dates } = require('../src/core');

test('chọn năm + quý ra đúng khoảng ngày của quý', () => {
  assert.deepEqual(rangeFor('quarter', 2025, 1), { from: '2025-01-01', to: '2025-03-31', label: 'Quý 1/2025' });
  assert.deepEqual(rangeFor('quarter', 2025, 2), { from: '2025-04-01', to: '2025-06-30', label: 'Quý 2/2025' });
  assert.deepEqual(rangeFor('quarter', 2026, 3), { from: '2026-07-01', to: '2026-09-30', label: 'Quý 3/2026' });
  assert.deepEqual(rangeFor('quarter', 2026, 4), { from: '2026-10-01', to: '2026-12-31', label: 'Quý 4/2026' });
});
test('chọn năm + tháng ra đúng số ngày của tháng', () => {
  assert.deepEqual(rangeFor('month', 2025, 2), { from: '2025-02-01', to: '2025-02-28', label: 'Tháng 2/2025' });
  assert.deepEqual(rangeFor('month', 2024, 2), { from: '2024-02-01', to: '2024-02-29', label: 'Tháng 2/2024' });
  assert.deepEqual(rangeFor('month', 2026, 9), { from: '2026-09-01', to: '2026-09-30', label: 'Tháng 9/2026' });
});
test('cả năm lấy từ 01/01 đến 31/12', () => {
  assert.deepEqual(rangeFor('year', 2025, 1), { from: '2025-01-01', to: '2025-12-31', label: 'Năm 2025' });
});
test('khoảng ngày sinh ra được engine chấp nhận', () => {
  for (const [mode, year, unit] of [['month', 2024, 2], ['quarter', 2025, 1], ['quarter', 2026, 4], ['year', 2025, 1]]) {
    const range = rangeFor(mode, year, unit);
    assert.doesNotThrow(() => dates(range.from, range.to));
    assert(range.from <= range.to);
  }
});
test('tháng/quý/năm sai bị từ chối', () => {
  assert.throws(() => rangeFor('month', 2025, 13), /Tháng không hợp lệ/);
  assert.throws(() => rangeFor('month', 2025, 0), /Tháng không hợp lệ/);
  assert.throws(() => rangeFor('quarter', 2025, 5), /Quý không hợp lệ/);
  assert.throws(() => rangeFor('month', 1999, 1), /Năm không hợp lệ/);
});
test('quý của một tháng', () => {
  assert.deepEqual([1, 3, 4, 6, 7, 9, 10, 12].map(quarterOf), [1, 1, 2, 2, 3, 3, 4, 4]);
});
