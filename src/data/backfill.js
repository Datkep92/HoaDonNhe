'use strict';
// ---------------------------------------------------------------------------
// PHASE 5 – BACKFILL (§29, §67, §83).
//
// Hai phần, tách khỏi cổng thuế để test được không cần mạng:
//   1) buildPlan(): đổi Năm / Quý / Tháng / Khoảng ngày thành MỘT khoảng ngày + danh sách chiều.
//      (Không tạo downloader riêng: khoảng ngày này được đưa vào ĐÚNG pipeline của Auto Sync —
//       Engine hiện có tự tách theo tháng và theo nhóm hóa đơn.)
//   2) createBackfillJob(): chạy nền, tuần tự theo chiều, có tiến độ, dừng được, cách ly lỗi.
// ---------------------------------------------------------------------------

const DIRECTION_LABEL = { BUY: 'Mua vào', SELL: 'Bán ra' };

const pad = value => String(value).padStart(2, '0');
const iso = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

function buildPlan(input = {}) {
  const mode = String(input.mode || 'month');
  const requested = Array.isArray(input.directions) ? input.directions : [];
  const directions = (requested.length ? requested : ['BUY', 'SELL']).filter(value => value === 'BUY' || value === 'SELL');
  if (!directions.length) throw new Error('Chọn ít nhất một chiều: Mua vào hoặc Bán ra.');

  const year = Number(input.year);
  const requireYear = () => {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Năm không hợp lệ (chọn 2000–2100).');
  };

  if (mode === 'year') {
    requireYear();
    return { from: iso(year, 1, 1), to: iso(year, 12, 31), directions, label: `Năm ${year}` };
  }
  if (mode === 'quarter') {
    requireYear();
    const quarter = Number(input.quarter);
    if (![1, 2, 3, 4].includes(quarter)) throw new Error('Quý phải là 1, 2, 3 hoặc 4.');
    const startMonth = quarter * 3 - 2;
    const endMonth = startMonth + 2;
    return { from: iso(year, startMonth, 1), to: iso(year, endMonth, daysInMonth(year, endMonth)), directions, label: `Quý ${quarter}/${year}` };
  }
  if (mode === 'month') {
    requireYear();
    const month = Number(input.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Tháng phải là 1–12.');
    return { from: iso(year, month, 1), to: iso(year, month, daysInMonth(year, month)), directions, label: `Tháng ${pad(month)}/${year}` };
  }
  if (mode === 'range') {
    const from = String(input.from || '').trim();
    const to = String(input.to || '').trim();
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
    if (!valid(from) || !valid(to)) throw new Error('Khoảng ngày không hợp lệ (cần dạng YYYY-MM-DD).');
    if (from > to) throw new Error('Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');
    return { from, to, directions, label: `${from} → ${to}` };
  }
  throw new Error(`Kiểu tải lịch sử không hợp lệ: ${mode}`);
}

const emptyTotals = () => ({ found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 });

function createBackfillJob({ runRange, log = () => {} }) {
  let job = {
    running: false, cancelled: false, ok: null, error: '',
    from: '', to: '', label: '', current: '', progress: null,
    steps: [], startedAt: null, finishedAt: null, totals: emptyTotals(),
  };

  function status() {
    return { ...job, totals: { ...job.totals }, steps: job.steps.slice() };
  }

  async function start({ plan }) {
    if (job.running) throw new Error('Đang tải lịch sử. Chờ lượt hiện tại xong hoặc bấm Dừng.');
    if (!plan || !plan.from || !plan.to) throw new Error('Thiếu khoảng ngày để tải lịch sử.');
    const directions = plan.directions && plan.directions.length ? plan.directions : ['BUY', 'SELL'];
    job = {
      running: true, cancelled: false, ok: null, error: '',
      from: plan.from, to: plan.to, label: plan.label || `${plan.from} → ${plan.to}`,
      current: '', progress: null, steps: [],
      startedAt: new Date().toISOString(), finishedAt: null, totals: emptyTotals(),
    };
    try {
      for (const direction of directions) {
        if (job.cancelled) break;
        job.current = direction;
        job.progress = { direction, message: `Bắt đầu ${DIRECTION_LABEL[direction]}…` };
        try {
          const result = await runRange({
            direction,
            from: plan.from,
            to: plan.to,
            onProgress: info => { job.progress = { direction, ...info }; },
            isCancelled: () => job.cancelled,
          });
          job.totals.found += result.found || 0;
          job.totals.downloaded += result.downloaded || 0;
          job.totals.skipped += result.skipped || 0;
          job.totals.imported += result.imported || 0;
          job.totals.errors += result.errors || 0;
          job.steps.push({ direction, ok: true, ...result });
          log(`Backfill ${DIRECTION_LABEL[direction]} ${plan.from} → ${plan.to}: tìm ${result.found || 0}, tải ${result.downloaded || 0}, nhập ${result.imported || 0}, lỗi ${result.errors || 0}`);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          // Một chiều lỗi (hoặc bị dừng) không làm chết chiều còn lại — mục 42/71.
          if (job.cancelled || (error && error.cancelled)) {
            job.steps.push({ direction, ok: false, cancelled: true, error: 'Đã dừng theo yêu cầu.' });
          } else {
            job.steps.push({ direction, ok: false, error: message });
            job.error = message;
          }
          log(`Backfill ${DIRECTION_LABEL[direction]} lỗi: ${message}`);
        }
      }
      job.ok = !job.error && !job.cancelled;
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      job.current = '';
      job.progress = null;
    }
    return status();
  }

  function cancel() {
    if (job.running) job.cancelled = true;
    return status();
  }

  return { start, status, cancel };
}

module.exports = { buildPlan, createBackfillJob, DIRECTION_LABEL };
