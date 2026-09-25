'use strict';
// ---------------------------------------------------------------------------
// BỂ CHẠY SONG SONG THEO MST — cho nút "Đồng bộ tất cả".
//
// VÌ SAO SONG SONG ĐƯỢC: mỗi MST dùng một profile Chrome riêng và kho cookie cổng thuế đã tách
// theo MST (src/tct-api.js `jars`), nên hai MST chạy cùng lúc KHÔNG lẫn phiên của nhau.
//
// BỂ GIỮ LUÔN ĐỦ LUỒNG: mỗi luồng chạy xong một MST thì tự rút MST kế tiếp từ hàng đợi. Nhờ vậy
// không có lúc nào chỉ còn 1–2 luồng chạy trong khi hàng đợi vẫn còn việc.
//
// KHÁC bộ lập lịch theo khung giờ (sync-scheduler.js): bể này do NGƯỜI DÙNG bấm nên chạy NGAY —
// không phụ thuộc giờ làm việc và không cần cửa sổ app đóng. Bấm ngưng thì thôi rút việc mới và
// pause các luồng đang chạy.
// ---------------------------------------------------------------------------

function createSyncPool(options = {}) {
  const {
    concurrency = 3,
    runOne = async () => ({}),
    pause = () => {},
    shouldStop = () => false,
    log = () => {},
    now = () => Date.now(),
  } = options;

  const limit = Math.max(1, Number(concurrency) || 3);
  let active = new Map();   // mst → { startedAt }
  let queue = [];
  let finished = [];        // { mst, ok, skipped, error }
  let running = false;
  let startedAt = null;
  let finishedAt = null;

  const isActive = mst => active.has(String(mst));

  function status() {
    return {
      running,
      concurrency: limit,
      active: [...active.entries()].map(([mst, info]) => ({ mst, startedAt: info.startedAt })),
      queued: queue.map(item => item.mst),
      done: finished.filter(x => x.ok && !x.skipped).map(x => x.mst),
      skipped: finished.filter(x => x.ok && x.skipped).map(x => x.mst),
      failed: finished.filter(x => !x.ok).map(x => ({ mst: x.mst, error: x.error })),
      startedAt: startedAt || '',
      finishedAt: finishedAt || '',
    };
  }

  // Một luồng: rút liên tục cho tới khi hàng đợi hết hoặc bị ngưng.
  async function worker() {
    for (;;) {
      if (!running || shouldStop()) return;
      const next = queue.shift();
      if (!next) return;
      active.set(next.mst, { startedAt: new Date(now()).toISOString() });
      log(`Bể: chạy MST ${next.mst} · ${active.size}/${limit} luồng · còn ${queue.length} chờ.`);
      let entry;
      try {
        const value = await runOne(next.mst, next);
        entry = { mst: next.mst, ok: true, skipped: !!(value && value.skipped) };
      } catch (error) {
        entry = { mst: next.mst, ok: false, error: error && error.message ? error.message : String(error) };
        log(`Bể: MST ${next.mst} lỗi — ${entry.error}`);
      } finally {
        active.delete(next.mst);
      }
      finished.push(entry);
    }
  }

  // entries: [{ mst, ... }]. Trả { started, queued, concurrency, done } — `done` để test chờ.
  function start(entries) {
    if (running) throw new Error('Đồng bộ tất cả đang chạy.');
    queue = (Array.isArray(entries) ? entries : []).filter(item => item && item.mst).slice();
    finished = [];
    startedAt = null;
    finishedAt = null;
    if (!queue.length) return { started: false, reason: 'không có MST nào để chạy', done: Promise.resolve() };

    running = true;
    startedAt = new Date(now()).toISOString();
    const lanes = Math.min(limit, queue.length);
    log(`Bể: bắt đầu ${queue.length} MST với ${lanes} luồng song song.`);
    const done = Promise.all(Array.from({ length: lanes }, () => worker())).then(() => {
      running = false;
      finishedAt = new Date(now()).toISOString();
      log(`Bể: xong — ${finished.filter(x => x.ok && !x.skipped).length} MST đồng bộ, ${finished.filter(x => !x.ok).length} lỗi.`);
      return status();
    });
    return { started: true, queued: queue.length, concurrency: lanes, done };
  }

  function stop(reason = 'người dùng ngưng') {
    if (!running && !active.size) return false;
    running = false;
    queue = [];
    for (const mst of [...active.keys()]) { try { pause(mst); } catch { /* luồng đó tự kết thúc */ } }
    log(`Bể: ngưng (${reason}) — đang dừng ${active.size} luồng.`);
    return true;
  }

  return { start, stop, status, isActive, get running() { return running; }, get concurrency() { return limit; } };
}

module.exports = { createSyncPool };
