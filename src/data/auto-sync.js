'use strict';
// ---------------------------------------------------------------------------
// AUTO SYNC — PROJECT_ARCHITECTURE §23–§28, §30, §42, §43, §59, §66.
//
// Đây là BỘ ĐIỀU PHỐI: nó quyết định chạy gì, theo thứ tự nào, ghi trạng thái vào sync.json,
// và đảm bảo các ràng buộc của tài liệu. Việc thật (tra cứu cổng thuế, tải XML, nhập SQLite)
// do `runDirection` bơm vào từ server.js — nhờ vậy phần điều phối test được mà không cần mạng.
//
// Ràng buộc bắt buộc:
//   - BUY xong mới tới SELL, KHÔNG BAO GIỜ chạy song song (mục 23/§66).
//   - Không khoá UI: chạy nền, tiến độ đọc qua status() (mục 26).
//   - Nhường người dùng: nếu luồng thủ công đang bận thì hoãn lượt, không tranh cổng thuế.
//   - Một hướng lỗi KHÔNG làm chết hướng còn lại (mục 42/71).
//   - Chạy lại không nhân bản: việc chống trùng do SQLite + XML lo (mục 19).
// ---------------------------------------------------------------------------

const { readSyncState, writeSyncState, defaultSyncState } = require('./mst-manager');

const DIRECTIONS = [
  { key: 'buy', code: 'BUY', label: 'Mua vào' },
  { key: 'sell', code: 'SELL', label: 'Bán ra' },
];

function createAutoSync({ runDirection, syncFile, manualBusy = () => false, log = () => {}, now = () => Date.now() }) {
  let running = false;
  let startedAt = null;
  let finishedAt = null;
  let phase = '';
  let error = '';
  let lastReason = '';
  let timer = null;
  let currentRun = null;

  // syncFile có thể là chuỗi hoặc hàm (MST/thư mục lưu đổi theo người dùng).
  const fileOf = () => (typeof syncFile === 'function' ? String(syncFile() || '') : String(syncFile || ''));
  const readState = () => { const file = fileOf(); return file ? readSyncState(file) : defaultSyncState(); };
  const writeState = state => { const file = fileOf(); return file ? writeSyncState(file, state) : state; };

  function status() {
    const state = readState();
    return {
      running,
      phase,
      startedAt,
      finishedAt,
      lastReason,
      error,
      settings: state.settings,
      directions: {
        buy: state.buy,
        sell: state.sell,
      },
    };
  }

  function configure(patch = {}) {
    const state = readState();
    const settings = { ...state.settings };
    if (patch.enabled !== undefined) settings.enabled = !!patch.enabled;
    if (patch.days !== undefined) settings.days = Math.max(1, Math.min(365, Number(patch.days) || 7));
    if (patch.intervalMinutes !== undefined) settings.intervalMinutes = Math.max(5, Math.min(1440, Number(patch.intervalMinutes) || 60));
    state.settings = settings;
    writeState(state);
    schedule();
    return settings;
  }

  // Chạy một lượt: TUẦN TỰ theo đúng thứ tự Mua vào → Bán ra.
  async function run(reason = 'manual') {
    if (running) throw new Error('Auto Sync đang chạy.');
    if (manualBusy()) {
      lastReason = reason;
      return { skipped: true, reason: 'manual-busy' };
    }
    running = true;
    startedAt = new Date().toISOString();
    finishedAt = null;
    error = '';
    lastReason = reason;
    const detail = {};
    try {
      for (const { key, code, label } of DIRECTIONS) {
        phase = `${label} (${code})`;
        const state = readState();
        state[key] = { ...state[key], status: 'running', lastSync: new Date().toISOString(), lastError: null };
        writeState(state);
        try {
          const settings = readState().settings;
          const result = await runDirection({ direction: code, days: settings.days });
          const after = readState();
          after[key] = {
            ...after[key],
            status: 'idle',
            lastSuccess: new Date().toISOString(),
            lastError: null,
            lastErrorTime: null,
            found: result.found || 0,
            downloaded: result.downloaded || 0,
            skipped: result.skipped || 0,
            imported: result.imported || 0,
            errors: result.errors || 0,
          };
          writeState(after);
          detail[key] = { ok: true, ...result };
          log(`Auto Sync ${label}: tìm ${result.found || 0}, tải ${result.downloaded || 0}, nhập ${result.imported || 0}, lỗi ${result.errors || 0}`);
        } catch (directionError) {
          // Một hướng lỗi không làm chết hướng còn lại (mục 42/71).
          const message = directionError && directionError.message ? directionError.message : String(directionError);
          const after = readState();
          after[key] = { ...after[key], status: 'error', lastError: message, lastErrorTime: new Date().toISOString() };
          writeState(after);
          detail[key] = { ok: false, error: message };
          error = message;
          log(`Auto Sync ${label} lỗi: ${message}`);
        }
      }
    } finally {
      running = false;
      phase = '';
      finishedAt = new Date().toISOString();
    }
    return { skipped: false, detail };
  }

  // Bộ đếm nhịp: kiểm tra mỗi 60 giây để đổi cấu hình không cần khởi động lại app.
  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    timer = setInterval(() => {
      const { settings, buy, sell } = readState();
      if (!settings.enabled || running || manualBusy()) return;
      const last = Math.max(
        Date.parse(buy.lastSuccess || '') || 0,
        Date.parse(sell.lastSuccess || '') || 0,
        Date.parse(buy.lastSync || '') || 0,
        Date.parse(sell.lastSync || '') || 0,
      );
      if (now() - last < settings.intervalMinutes * 60 * 1000) return;
      run('schedule').catch(() => { /* lỗi đã ghi vào sync.json */ });
    }, 60 * 1000);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { status, configure, run, schedule, stop, get running() { return running; } };
}

module.exports = { createAutoSync, DIRECTIONS };
