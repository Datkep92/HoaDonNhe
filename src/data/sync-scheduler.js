'use strict';
// ---------------------------------------------------------------------------
// BỘ LẬP LỊCH CHẠY NỀN — quyết định "lúc này có được chạy hay không", không tự gọi mạng.
//
// HAI CỔNG PHẢI CÙNG MỞ (một cổng chưa đủ):
//   1. TRONG KHUNG GIỜ  — mặc định 08:00–18:00 giờ VN (xem sync-window.js).
//   2. CỬA SỔ APP ĐÃ ĐÓNG — người dùng thu cửa sổ xuống khay, tức không còn nhìn màn hình.
// Trong giờ làm việc mà cửa sổ VẪN mở thì nền KHÔNG chạy: người dùng là ưu tiên số 1, và
// đóng cửa sổ là tín hiệu chính xác hơn mọi suy đoán theo đồng hồ.
//
// TUẦN TỰ: mỗi lúc chỉ MỘT MST. Cửa sổ mở lại, hết khung, hoặc có việc thủ công ⇒ pause NGAY
// MST đang chạy (engine ghi `state:'paused'` + cursor, nên lượt sau tiếp đúng chỗ).
//
// Hàng đợi KHÔNG cần file riêng: `sync.json` của từng MST đã lưu `lastSync`/`status`, còn job
// file đã lưu cursor dừng. Bộ lập lịch chỉ hỏi `dueMsts()` mỗi nhịp — ít tầng hơn, ít cách hỏng hơn.
// ---------------------------------------------------------------------------

const { vnClock, activeWindow, windowKey, minutesUntilNext, normalizeWindows } = require('./sync-window');

// ---------------------------------------------------------------------------
// "ĐÃ ĐỒNG BỘ ĐỦ TRONG NGÀY" — thước đo cho cả UI lẫn bộ lập lịch.
//
// Đồng bộ = đã tải được dữ liệu mới nhất và phần còn thiếu. Dấu hiệu chọn là `lastSuccess`
// của TỪNG hướng, vì nó CHỈ được ghi khi hướng đó chạy XONG — lượt bị ngưng/nhường người dùng
// không ghi. Nhờ vậy "vừa thử chạy" không bị tính nhầm thành "đã đồng bộ".
//
// Một ngày chỉ cần đủ MỘT lần: cả hai hướng xong trong ngày VN hiện tại ⇒ bỏ qua tới hết ngày,
// không còn vòng lặp sync lại mỗi `intervalMinutes`.
// ---------------------------------------------------------------------------
function dailySyncState(syncState, clock = vnClock(new Date())) {
  const dayOf = value => { const ms = Date.parse(value || ''); return ms ? vnClock(new Date(ms)).day : ''; };
  const missing = [];
  let at = '';
  for (const [key, label] of [['buy', 'mua vào'], ['sell', 'bán ra']]) {
    const side = (syncState && syncState[key]) || {};
    if (dayOf(side.lastSuccess) !== clock.day) missing.push(label);
    else if (side.lastSuccess > at) at = side.lastSuccess;
  }
  return { synced: missing.length === 0, missing, at };
}

function createSyncScheduler(options = {}) {
  const {
    windows = [],
    dueMsts = () => [],
    runOne = async () => ({}),
    pauseOne = () => {},
    uiClosed = () => true,
    manualBusy = () => false,
    outputBusy = () => false,
    heartbeat = () => {},
    log = () => {},
    now = () => Date.now(),
    tickMs = 20000,
  } = options;

  let timer = null;
  let current = null;          // { mst, days, yielded }
  let stopped = false;
  let state = { phase: 'idle', mst: '', reason: '', at: '' };

  const set = patch => { state = { ...state, ...patch, at: new Date(now()).toISOString() }; };

  // Một cổng chưa mở là chưa được chạy. Trả cả LÝ DO để UI nói được vì sao đang chờ.
  function gate() {
    const clock = vnClock(new Date(now()));
    const list = normalizeWindows(windows);
    const window = activeWindow(list, clock);
    if (!window) return { ok: false, reason: `ngoài khung giờ (${list.map(w => w.from + '–' + (w.to || '…')).join(', ')})`, window: null, clock, list };
    if (!uiClosed()) return { ok: false, reason: 'cửa sổ app đang mở — nhường người dùng', window, clock, list };
    if (manualBusy()) return { ok: false, reason: 'đang có việc thủ công', window, clock, list };
    // Cổng thứ ba: thư mục lưu đang do MỘT BẢN APP KHÁC chạy nền (xem src/data/output-lock.js).
    if (outputBusy()) return { ok: false, reason: 'thư mục lưu đang do bản app khác chạy nền', window, clock, list };
    return { ok: true, reason: '', window, clock, list };
  }

  // Ngưng MST đang chạy. Đánh dấu `yielded` để kết quả trả về được ghi là "nhường", không phải "xong".
  function yieldNow(reason) {
    if (!current) return false;
    current.yielded = true;
    set({ phase: 'yielding', mst: current.mst, reason });
    try { pauseOne(current.mst); } catch { /* ngưng không được thì nhịp sau thử lại */ }
    log(`Chạy nền nhường (${reason}) — MST ${current.mst}.`);
    return true;
  }

  function start(mst, days) {
    const entry = { mst, days, yielded: false };
    current = entry;
    set({ phase: 'running', mst, reason: '' });
    log(`Chạy nền bắt đầu MST ${mst} (${days} ngày gần nhất).`);
    Promise.resolve()
      .then(() => runOne(mst, { days }))
      .then(result => {
        if (entry.yielded) { set({ phase: 'yielded', mst, reason: 'đã nhường người dùng' }); return; }
        const skipped = result && result.skipped;
        set({ phase: skipped ? 'skipped' : 'done', mst, reason: skipped ? 'bỏ qua (đang bận)' : 'xong' });
      })
      .catch(error => {
        const message = error && error.message ? error.message : String(error);
        // MST không có phiên sẵn KHÔNG phải lỗi ồn ào: dueMsts() đã lọc, nhưng vẫn chặn ở đây.
        set({ phase: 'error', mst, reason: message });
        log(`Chạy nền MST ${mst} lỗi: ${message}`);
      })
      .finally(() => { if (current === entry) current = null; });
  }

  async function tick() {
    if (stopped) return;
    // Ghi lại nhịp tim của khoá thư mục lưu (nếu chính mình đang giữ). Rẻ, không gọi mạng —
    // nhờ nó mà bản khác biết mình còn sống, và pid bị tái dùng không khoá được thư mục mãi.
    try { heartbeat(); } catch { /* nhịp sau thử lại */ }
    if (current) {
      const g = gate();
      if (!g.ok) yieldNow(g.reason);
      return;
    }
    const g = gate();
    if (!g.ok) { set({ phase: 'waiting', mst: '', reason: g.reason }); return; }
    let queue = [];
    try { queue = dueMsts() || []; }
    catch (error) { set({ phase: 'error', mst: '', reason: `không lấy được danh sách: ${error.message}` }); return; }
    // Xếp LÂU CHƯA ĐỒNG BỘ NHẤT lên trước — bảo đảm nằm ở ĐÂY, không phụ thuộc nơi gọi,
    // để không dòng nào bị bỏ đói dù dueMsts() trả thứ tự nào.
    queue = [...queue].sort((a, b) => (Number(a && a.lastSync) || 0) - (Number(b && b.lastSync) || 0));
    if (!queue.length) { set({ phase: 'idle', mst: '', reason: 'không MST nào tới hạn' }); return; }
    start(queue[0].mst, g.window.days);
  }

  function startTimer() {
    if (timer || stopped) return timer;
    timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    yieldNow('dừng bộ lập lịch');
  }

  // Trạng thái cho UI (chỉ đọc, không gọi cổng thuế).
  function status() {
    const g = gate();
    return {
      enabled: true,
      phase: state.phase,
      mst: state.mst,
      reason: state.reason,
      at: state.at,
      running: !!current,
      inWindow: !!g.window,
      windowId: g.window ? g.window.id : '',
      windowKey: windowKey(g.window, g.clock),
      windows: g.list.map(w => ({ id: w.id, from: w.from, to: w.to, days: w.days })),
      nextInMinutes: minutesUntilNext(g.list, g.clock),
    };
  }

  return { tick, startTimer, stop, status, gate, get running() { return !!current; } };
}

module.exports = { createSyncScheduler, dailySyncState };
