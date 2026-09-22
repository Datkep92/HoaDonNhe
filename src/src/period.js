'use strict';
// Tính khoảng ngày cho phần "chọn nhanh" ở giao diện (năm + tháng / quý / cả năm).
// Dùng chung cho giao diện (src/period.js được nạp bằng <script>) và cho test.
// Ví dụ: Quý 1 năm 2025 -> 2025-01-01 … 2025-03-31.
function pad(value) { return String(value).padStart(2, '0'); }
function lastDay(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function monthRange(year, month) {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Tháng không hợp lệ.');
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` };
}
function quarterRange(year, quarter) {
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) throw new Error('Quý không hợp lệ.');
  const first = monthRange(year, (quarter - 1) * 3 + 1);
  const last = monthRange(year, quarter * 3);
  return { from: first.from, to: last.to };
}
function yearRange(year) { return { from: `${year}-01-01`, to: `${year}-12-31` }; }

// mode: 'month' | 'quarter' | 'year'; unit: số tháng (1-12) hoặc số quý (1-4).
function rangeFor(mode, year, unit) {
  const value = Number(year);
  if (!Number.isInteger(value) || value < 2000 || value > 2100) throw new Error('Năm không hợp lệ.');
  if (mode === 'quarter') { const range = quarterRange(value, Number(unit)); return { ...range, label: `Quý ${Number(unit)}/${value}` }; }
  if (mode === 'year') return { ...yearRange(value), label: `Năm ${value}` };
  const range = monthRange(value, Number(unit));
  return { ...range, label: `Tháng ${Number(unit)}/${value}` };
}
// Quý chứa tháng đã cho (dùng để đồng bộ ô Quý theo Từ ngày hiện tại).
function quarterOf(month) { return Math.floor((Number(month) - 1) / 3) + 1; }

const api = { rangeFor, monthRange, quarterRange, yearRange, quarterOf };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.Period = api;
