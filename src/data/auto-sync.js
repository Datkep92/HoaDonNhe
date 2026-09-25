'use strict';
// ---------------------------------------------------------------------------
// AUTO SYNC — PROJECT_ARCHITECTURE §23–§28, §30, §42, §43, §59, §66.
//
// Đây là BỘ ĐIỀU PHỐI: nó quyết định chạy gì, theo thứ tự nào, ghi trạng thái vào sync.json,
// và đảm bảo các ràng buộc của tài liệu. Việc thật (tra cứu cổng thuế, tải XML, nhập SQLite)
// do `runDirection` bơm vào từ server.js — nhờ vậy phần điều phối test được mà không cần mạng.
//
// Ràng buộc bắt buộc:
//   - BUY xong mới tới SELL (mục 23/§66). TỪ 1.0.2 có ngoại lệ CÓ KIỂM SOÁT: hai hướng chạy
//     song song khi `parallel()` trả true — chỉ dùng cho CÙNG một MST (chung một phiên) vì kho
//     cookie của cổng thuế là dùng chung toàn tiến trình, hai MST khác nhau sẽ lẫn phiên.
//   - Auto Sync KHÔNG tự chạy: chỉ chạy khi người dùng bấm (`autoRun` mặc định false).
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

function createAutoSync({ runDirection, syncFile, manualBusy = () => false, parallel = () => false, autoRun = false, log = () => {}, now = () => Date.now() }) {
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

  // Ghi trạng thái KIỂU ĐỌC–SỬA–GHI ĐỒNG BỘ (không có await ở giữa) nên hai hướng chạy song song
  // không ghi đè lẫn nhau. Bản cũ đọc rồi ghi rời nhau (đọc → await → ghi) nên hướng này có thể
  // xoá mất kết quả vừa ghi của hướng kia.
  function patchState(key, patch) {
    const state = readState();
    state[key] = { ...state[key], ...patch };
    return writeState(state);
  }

  // MỘT hướng (Mua vào hoặc Bán ra). Không ném ra ngoài: hướng này lỗi không làm chết hướng kia.
  async function oneDirection({ key, code, label }, runOptions = {}) {
    const started = new Date().toISOString();
    patchState(key, { status: 'running', lastSync: started, lastError: null });
    try {
      const settings = readState().settings;
      // Lượt CHẠY NỀN truyền `days` riêng (khung giờ, mặc định 3 ngày) để quét bù hoá đơn mới.
      // Lấy MIN với cấu hình của MST: nền không bao giờ vượt quá điều người dùng đặt, và một hồ sơ
      // đặt `days: 365` cho việc dựng lại dữ liệu cũng không biến lượt nền thành chạy cả ngày.
      const configured = Math.max(1, Number(settings.days) || 7);
      const days = runOptions.days ? Math.min(configured, Math.max(1, Number(runOptions.days) || configured)) : configured;
      const result = await runDirection({ direction: code, days });
      patchState(key, {
        status: 'idle',
        lastSuccess: new Date().toISOString(),
        lastError: null,
        lastErrorTime: null,
        found: result.found || 0,
        downloaded: result.downloaded || 0,
        skipped: result.skipped || 0,
        imported: result.imported || 0,
        errors: result.errors || 0,
        // Lỗi TẢI của lượt này (sau khi đã thử lại một lượt) — khác `errors` là lỗi NHẬP XML.
        failed: result.failed || 0,
      });
      log(`Auto Sync ${label}: tìm ${result.found || 0}, tải ${result.downloaded || 0}, nhập ${result.imported || 0}, lỗi nhập ${result.errors || 0}, lỗi tải ${result.failed || 0}`);
      return { key, ok: true, result };
    } catch (directionError) {
      // "Ngưng theo yêu cầu" là trạng thái bình thường, KHÔNG phải lỗi — không ghi vào sync.json như lỗi.
      const stopped = !!(directionError && directionError.paused);
      const message = directionError && directionError.message ? directionError.message : String(directionError);
      patchState(key, stopped
        ? { status: 'idle', lastError: null, lastErrorTime: null }
        : { status: 'error', lastError: message, lastErrorTime: new Date().toISOString() });
      log(`Auto Sync ${label} ${stopped ? 'đã ngưng theo yêu cầu' : `lỗi: ${message}`}`);
      return { key, ok: false, stopped, error: message };
    }
  }

  // Chạy một lượt. Mặc định TUẦN TỰ Mua vào → Bán ra (§23/§66); `parallel()` trả true thì chạy
  // hai hướng cùng lúc. Song song CHỈ an toàn khi hai hướng dùng chung một phiên của CÙNG một MST
  // (xem chú thích ở server.js: kho cookie của cổng thuế là dùng chung toàn tiến trình).
  async function run(reason = 'manual', options = {}) {
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
    // Truyền xuống từng hướng: `days` riêng cho lượt chạy nền (xem oneDirection).
    const runOptions = options;
    const useParallel = typeof options.parallel === 'boolean' ? options.parallel : !!parallel();
    const detail = {};
    try {
      if (useParallel) {
        phase = 'Mua vào + Bán ra (song song)';
        for (const outcome of await Promise.all(DIRECTIONS.map(direction => oneDirection(direction, runOptions)))) {
          if (outcome.ok) detail[outcome.key] = { ok: true, ...outcome.result };
          else { detail[outcome.key] = { ok: false, stopped: outcome.stopped, error: outcome.error }; if (!outcome.stopped) error = outcome.error; }
        }
      } else {
        for (const direction of DIRECTIONS) {
          phase = `${direction.label} (${direction.code})`;
          const outcome = await oneDirection(direction, runOptions);
          if (outcome.ok) detail[outcome.key] = { ok: true, ...outcome.result };
          else { detail[outcome.key] = { ok: false, stopped: outcome.stopped, error: outcome.error }; if (!outcome.stopped) error = outcome.error; }
        }
      }
    } finally {
      running = false;
      phase = '';
      finishedAt = new Date().toISOString();
    }
    return { skipped: false, parallel: useParallel, detail };
  }

  // Bộ đếm nhịp cũ: kiểm tra mỗi 60 giây để TỰ chạy lại sau `intervalMinutes`.
  //
  // TỪ 1.0.2: TỰ CHẠY THEO NHỊP ĐÃ TẮT. Auto Sync chỉ chạy khi người dùng bấm nút trên dòng MST
  // và chỉ ngưng khi bấm ngưng — app mở lên không tự gọi cổng thuế. Vì vậy `autoRun` mặc định false
  // và hàm này KHÔNG tạo timer nào. Tham số `autoRun = true` chỉ còn để test hành vi cũ.
  function schedule() {
    if (!autoRun) return null;
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
