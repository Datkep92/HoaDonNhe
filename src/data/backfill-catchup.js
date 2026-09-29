'use strict';
// ---------------------------------------------------------------------------
// QUÉT BÙ LỊCH SỬ — lấp những NGÀY CÒN THIẾU trong toàn bộ thời gian thiết bị đã hoạt động.
//
// Thuần logic, KHÔNG gọi mạng: nhờ vậy test được mà không cần cổng thuế.
//   1) planCatchup(): từ mốc bắt đầu → hôm qua, đối chiếu SỔ ĐÃ QUÉT để tìm ngày còn thiếu,
//      gom thành các ĐOẠN LIỀN NHAU (mỗi đoạn tối đa `segmentDays` ngày).
//   2) createCatchupJob(): chạy MỘT đoạn mỗi lượt qua đúng pipeline backfill hiện có
//      (`runRange` = runBackfillRange trong server.js), rồi mới ghi sổ. Ngưng giữa chừng ⇒
//      KHÔNG ghi sổ ⇒ lượt sau tiếp đúng chỗ dừng.
//      NHIỀU MST chạy SONG SONG được (mỗi MST có data.db/sync.json/kho cookie riêng) — chốt
//      chạy-trùng chỉ áp cho CÙNG MỘT MST, không chặn MST khác.
//
// Quy tắc "ngày nào còn thiếu":
//   • chưa từng có trong sổ  ⇒ thiếu (đang lấp vòng đầu).
//   • ĐÃ quét nhưng nằm trong `revisitDays` ngày gần đây và đã quá `revisitAfterMs`
//     ⇒ coi là thiếu để quét LẠI (hoá đơn cũ có thể bị chỉnh/sửa sau đó).
// Nhờ quy tắc này mà quét xong một vòng thì tự động lặp lại vài tháng gần nhất, không cần
// thêm nhánh "vòng mới" riêng.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEGMENT_DAYS = 31;                 // mỗi lượt quét tối đa ~1 tháng
const DEFAULT_REVISIT_DAYS = 92;                 // quét lại ~3 tháng gần nhất
const DEFAULT_REVISIT_AFTER_MS = 7 * DAY_MS;     // mỗi ngày quét lại sau ~7 ngày
const LEDGER_VERSION = 1;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' → mốc UTC nửa đêm; null khi không hợp lệ. Dùng UTC cho cả phép tính ngày
// để không lệch ngày vì múi giờ máy (mọi so sánh đều là ngày VN đã chuẩn hoá).
function parseDay(day) {
  const match = DAY_RE.exec(String(day ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const ms = Date.UTC(year, month - 1, date);
  if (!Number.isFinite(ms)) return null;
  // Date.UTC tự CUỘN ngày không tồn tại sang ngày khác (31/02 → 03/03, tháng 13 → năm sau).
  // Đối chiếu lại ⇒ từ chối, tránh "ngày ma" làm mốc quét bù chạy lệch.
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== date) return null;
  return ms;
}

function dayString(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
}

function addDays(day, count) {
  const ms = parseDay(day);
  return ms === null ? '' : dayString(ms + Number(count) * DAY_MS);
}

// Sổ quét bù luôn có hình dạng cố định, dù đọc từ DB ra thứ gì.
function normalizeLedger(value) {
  const base = { version: LEDGER_VERSION, start: '', days: {}, lastRunAt: '', lastFrom: '', lastTo: '', passFinishedAt: '' };
  if (!value || typeof value !== 'object') return base;
  const days = {};
  const raw = value.days && typeof value.days === 'object' ? value.days : {};
  for (const [day, at] of Object.entries(raw)) {
    const ms = Number(at);
    if (parseDay(day) !== null && Number.isFinite(ms) && ms > 0) days[day] = ms;
  }
  return { ...base, ...value, days };
}

// Danh sách ngày còn thiếu + các đoạn liền nhau để chạy dần.
function planCatchup(options = {}) {
  const {
    start, end, scanned = {}, now = Date.now(),
    revisitDays = DEFAULT_REVISIT_DAYS,
    revisitAfterMs = DEFAULT_REVISIT_AFTER_MS,
    segmentDays = DEFAULT_SEGMENT_DAYS,
  } = options;
  const fromMs = parseDay(start);
  const toMs = parseDay(end);
  if (fromMs === null || toMs === null || fromMs > toMs) {
    return { days: [], segments: [], total: 0, scannedDays: 0, revisitFrom: '' };
  }
  const size = Math.max(1, Number(segmentDays) || DEFAULT_SEGMENT_DAYS);
  const revisitFrom = dayString(toMs - Math.max(0, (Number(revisitDays) || DEFAULT_REVISIT_DAYS) - 1) * DAY_MS);
  const lapseBefore = now - Math.max(0, Number(revisitAfterMs) || DEFAULT_REVISIT_AFTER_MS);

  const days = [];
  let scannedDays = 0;
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) {
    const day = dayString(ms);
    const at = Number(scanned[day]);
    if (!Number.isFinite(at) || at <= 0) { days.push(day); continue; }
    scannedDays += 1;
    if (day >= revisitFrom && at < lapseBefore) days.push(day);
  }

  const segments = [];
  let run = null;
  for (const day of days) {
    if (run && run.days.length < size && run.to === addDays(day, -1)) {
      run.to = day;
      run.days.push(day);
    } else {
      run = { from: day, to: day, days: [day] };
      segments.push(run);
    }
  }
  return { days, segments, total: days.length, scannedDays, revisitFrom };
}

const emptyTotals = () => ({ found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 });

// Chạy MỘT đoạn mỗi lượt. Tách khỏi server để test được bằng runRange giả.
function createCatchupJob(options = {}) {
  const {
    readLedger = () => null,
    writeLedger = () => {},
    runRange = async () => ({}),
    log = () => {},
    now = () => Date.now(),
    segmentDays = DEFAULT_SEGMENT_DAYS,
    revisitDays = DEFAULT_REVISIT_DAYS,
    revisitAfterMs = DEFAULT_REVISIT_AFTER_MS,
  } = options;

  // mst đang chạy → tiến độ của chính MST đó. Nhiều phần tử ⇒ nhiều MST chạy song song.
  const active = new Map();

  // Cập nhật tiến độ của MỘT MST (không đụng MST khác đang chạy song song).
  function setProgress(mst, patch) {
    const current = active.get(mst) || { mst, from: '', to: '', direction: '', message: '', total: 0, remaining: 0 };
    active.set(mst, { ...current, ...(patch || {}) });
  }

  async function runOne(mst, { start, end, isCancelled } = {}) {
    // Chỉ chặn khi CHÍNH MST này đang chạy — MST khác vẫn được chạy song song.
    if (active.has(mst)) return { ok: false, reason: 'đang chạy', done: false, remaining: 0 };
    setProgress(mst, {});
    try {
      const ledger = normalizeLedger(readLedger(mst));
      const plan = planCatchup({ start, end, scanned: ledger.days, now: now(), segmentDays, revisitDays, revisitAfterMs });
      if (!plan.segments.length) {
        log(`Quét bù MST ${mst}: không còn ngày thiếu (${plan.scannedDays} ngày đã có trong sổ).`);
        return { ok: true, done: true, cancelled: false, error: '', remaining: 0, segment: null, totals: emptyTotals(), total: 0 };
      }
      const segment = plan.segments[0];
      const remainingAfter = Math.max(0, plan.total - segment.days.length);
      // Ghi sổ xong mới coi là tiến được; lỗi/ngưng ⇒ vẫn còn nguyên plan.total ngày thiếu.
      const totals = emptyTotals();
      let cancelled = false;
      let failure = '';

      for (const direction of ['BUY', 'SELL']) {
        if (typeof isCancelled === 'function' && isCancelled()) { cancelled = true; break; }
        const label = direction === 'BUY' ? 'Mua vào' : 'Bán ra';
        setProgress(mst, { from: segment.from, to: segment.to, direction, message: `Quét bù ${segment.from} → ${segment.to} (${label})`, total: plan.total, remaining: plan.total });
        try {
          const result = await runRange({
            mst, direction, from: segment.from, to: segment.to,
            onProgress: info => setProgress(mst, {
              ...(info || {}),
              message: (info && info.message) || (active.get(mst) || {}).message,
            }),
            isCancelled,
          });
          for (const key of Object.keys(totals)) totals[key] += Number(result && result[key]) || 0;
        } catch (error) {
          if (error && error.cancelled) { cancelled = true; break; }
          failure = error && error.message ? error.message : String(error);
          log(`Quét bù MST ${mst} hướng ${label} lỗi: ${failure}`);
          // Một hướng lỗi KHÔNG chết hướng còn lại — giống Auto Sync.
        }
      }

      // Chỉ ghi sổ khi đoạn chạy TRỌN CẢ HAI HƯỚNG. Ngưng giữa chừng HOẶC một hướng lỗi ⇒ giữ
      // nguyên sổ để lượt sau làm lại đúng chỗ dừng. Nếu đánh dấu ngày đã quét dù lỗi thì ngày cũ
      // (ngoài cửa sổ quét lại) sẽ bị bỏ sót VĨNH VIỄN.
      if (!cancelled && !failure) {
        const at = now();
        const next = normalizeLedger(readLedger(mst));
        for (const day of segment.days) next.days[day] = at;
        next.start = start || next.start || '';
        next.lastFrom = segment.from;
        next.lastTo = segment.to;
        next.lastRunAt = new Date(at).toISOString();
        if (!remainingAfter) next.passFinishedAt = next.lastRunAt;
        writeLedger(mst, next);
      }

      return {
        // Huỷ cũng là "chưa xong": báo ok=false để nơi gọi KHÔNG ghi nhận nhầm là thành công.
        ok: !failure && !cancelled,
        done: !failure && !cancelled && remainingAfter === 0,
        cancelled, error: failure,
        remaining: (cancelled || failure) ? plan.total : remainingAfter,
        segment: { from: segment.from, to: segment.to, days: segment.days.length },
        total: plan.total, totals,
      };
    } finally {
      active.delete(mst);
    }
  }

  function status() {
    const progresses = [...active.values()].map(item => ({ ...item }));
    return {
      running: progresses.length > 0,
      msts: [...active.keys()],                 // danh sách MST đang quét bù (nhiều MST một lúc)
      progress: progresses[0] || null,          // giữ tương thích: tiến độ của lượt đầu tiên
      progresses,                               // tiến độ từng MST
    };
  }

  return { runOne, status, get running() { return active.size > 0; } };
}

// ---------------------------------------------------------------------------
// CỔNG "máy có thật sự rảnh không" — tách riêng khỏi server để TEST được từng điều kiện.
// Trả về LÝ DO chặn ('' = cho chạy). Thứ tự kiểm tra giữ nguyên như trước.
//
// `autoSyncRunning` là điều kiện TỪNG BỊ THIẾU: lượt Auto Sync BẤM TAY (nút ▶) vẫn tiếp tục
// chạy sau khi người dùng đóng cửa sổ app, nên nếu bỏ qua cờ này thì sau 10 giây "cửa sổ im"
// quét bù sẽ chạy CHỒNG lên đúng MST đó (hai lượt cùng ghi data.db, và cùng tranh cửa sổ Chrome).
function catchupGateReason(flags) {
  const f = flags || {};
  if (!f.output) return 'chưa chọn thư mục lưu';
  if (f.uiOpen) return 'cửa sổ app đang mở — nhường người dùng';
  if (f.manualBusy) return 'đang có việc thủ công';
  if (f.authBusy) return 'đang xử lý đăng nhập';
  if (f.autoSyncRunning) return 'đang chạy Auto Sync bấm tay';
  if (f.poolRunning) return 'đang chạy "Đồng bộ tất cả"';
  if (f.backgroundRunning) return 'đang chạy nền theo khung giờ';
  if (f.outputBusy) return 'thư mục lưu đang do bản app khác chạy nền';
  return '';
}

// Xếp hàng CÔNG BẰNG: MST LÂU CHƯA ĐƯỢC QUÉT nhất (hoặc chưa quét bao giờ) lên trước.
// Nếu cứ lấy theo thứ tự danh sách thì vài MST đứng đầu sẽ chiếm hết lượt và quét xong cả
// lịch sử của chúng, còn MST xếp sau thì ĐÓI — dù có nhiều luồng song song.
function orderLeastRecentlyRun(rows) {
  return rows.slice().sort((a, b) => String(a.lastRunAt || '').localeCompare(String(b.lastRunAt || '')));
}

// Chọn MST chạy NGAY ở nhịp này: lấp đầy số luồng còn trống, bỏ qua MST đang chạy.
// MST đã có token đi thẳng (song song được); MST CHƯA token phải qua cửa sổ Chrome DÙNG CHUNG
// nên chỉ cho chạy MỘT MÌNH — tránh hai MST tranh cùng một cửa sổ.
function pickCatchupTargets({ eligible = [], running = [], lanes = 1, hasToken = () => false } = {}) {
  const slots = lanes - running.length;
  if (slots <= 0) return [];
  const busy = new Set(running);
  const pool = orderLeastRecentlyRun(eligible.filter(target => !busy.has(target.mst)));
  if (!pool.length) return [];
  const withToken = pool.filter(target => hasToken(target.mst));
  const withoutToken = pool.filter(target => !hasToken(target.mst));
  const picks = withToken.slice(0, slots);
  const nonTokenRunning = running.filter(mst => !hasToken(mst)).length;
  if (picks.length < slots && nonTokenRunning === 0 && withoutToken.length) picks.push(withoutToken[0]);
  return picks;
}

// Khoá đệm/cooldown phải gắn THÊM thư mục lưu: sổ quét bù nằm trong thư mục đó, nên đổi thư mục
// mà giữ nguyên khoá theo MST là UI hiện số liệu của thư mục CŨ.
function catchupCacheKey(folder, mst) { return `${folder || ''}\u0000${mst}`; }

module.exports = {
  planCatchup, createCatchupJob, normalizeLedger,
  parseDay, dayString, addDays,
  catchupGateReason, orderLeastRecentlyRun, pickCatchupTargets, catchupCacheKey,
  DAY_MS, DEFAULT_SEGMENT_DAYS, DEFAULT_REVISIT_DAYS, DEFAULT_REVISIT_AFTER_MS, LEDGER_VERSION,
};
