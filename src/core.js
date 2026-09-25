'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const invoiceExport = require('./invoice-excel');
// Khoá hoá đơn của TẦNG DỮ LIỆU (MST người bán | KHMSHDon | KHHDon | SHDon, đã bỏ số 0 đầu).
// Danh sách "hoá đơn bị thay thế" phải dùng ĐÚNG định dạng này để bộ nhập so khớp được.
const { buildInvoiceKey } = require('./data/invoice-key');

function safeName(value) {
  let result = String(value ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  if (!result || /^\.+$/.test(result)) result = '_';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(result)) result = '_' + result;
  return result;
}
// Ghi file kiểu "ghi tạm rồi đổi tên". Trên Windows, rename có thể bị EPERM khi file đích đang bị
// khoá (OneDrive/antivirus đang quét) — nếu rename không được thì ghi đè tại chỗ rồi xoá file tạm.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.part';
  fs.writeFileSync(temp, data);
  try { fs.renameSync(temp, file); return; } catch { /* thử đường lui bên dưới */ }
  try { fs.copyFileSync(temp, file); fs.unlinkSync(temp); return; } catch { /* ghi thẳng */ }
  fs.writeFileSync(file, data); try { fs.unlinkSync(temp); } catch {}
}
// Hoá đơn cổng thuế báo "Đã bị thay thế" (tthai = 4) KHÔNG thuộc kho dữ liệu. XML không mang
// trạng thái, nên engine ghi lại danh sách khoá vào <thư mục lưu>/MST-<mst>/hoa-don-bi-thay-the.json
// để bộ nhập (xml-scanner) bỏ qua và dọn những bản đã nhập trước đó.
const SUPERSEDED_FILE = 'hoa-don-bi-thay-the.json';
const SUPERSEDED_STATE = '4';
function supersededFile(output, mst) {
  return path.join(String(output || ''), `MST-${safeName(mst)}`, SUPERSEDED_FILE);
}
// Gộp khoá mới vào danh sách đã có rồi ghi lại (đọc–gộp–ghi để nhiều lượt không xoá lẫn nhau).
function rememberSuperseded(job, keys) {
  const file = supersededFile(job.output, job.account && (job.account.mst || job.account.label));
  let existing = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    existing = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.keys) ? raw.keys : []);
  } catch { /* chưa có file */ }
  const merged = [...new Set([...existing.map(String), ...keys].filter(Boolean))];
  try { atomicWrite(file, JSON.stringify({ updatedAt: new Date().toISOString(), keys: merged })); } catch { /* không ghi được thì lần sau thử lại */ }
  return merged.length;
}
function dates(from, to) {
  const valid = x => /^\d{4}-\d{2}-\d{2}$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0, 10) === x;
  if (!valid(from) || !valid(to) || from > to) throw new Error('Khoảng ngày không hợp lệ.');
  const ranges = [];
  let start = from;
  while (start <= to) {
    const date = new Date(start + 'T00:00:00Z');
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const last = end < to ? end : to;
    ranges.push([start, last]);
    const next = new Date(last + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    start = next.toISOString().slice(0, 10);
  }
  return ranges;
}
function searchExpression(from, to, variant) {
  const vn = x => x.split('-').reverse().join('/');
  return `tdlap=ge=${vn(from)}T00:00:00;tdlap=le=${vn(to)}T23:59:59${variant ? ';ttxly==' + variant : ''}`;
}
function invoiceKey(inv) {
  return [inv.family, inv.direction, inv.nbmst, inv.khmshdon, inv.khhdon, inv.shdon].map(x => String(x ?? '')).join('|');
}
function validateParams(p) {
  if (!p || !['purchase', 'sold'].includes(p.direction)) throw new Error('Chọn loại mua vào/bán ra.');
  dates(p.from, p.to);
  if (!['query', 'sco-query', 'both'].includes(p.family)) throw new Error('Loại hóa đơn không hợp lệ.');
  if (!Array.isArray(p.formats) || !p.formats.length || p.formats.some(x => !['xml', 'zip', 'html', 'pdf', 'xlsx'].includes(x))) throw new Error('Chọn định dạng xuất.');
  if (!/^(|[1-6])$/.test(String(p.status || ''))) throw new Error('Trạng thái không hợp lệ.');
  return { from: p.from, to: p.to, direction: p.direction, family: p.family, status: String(p.status || ''), formats: [...new Set(p.formats)] };
}
function tasksFor(p) {
  const tasks = [];
  for (const family of p.family === 'both' ? ['query', 'sco-query'] : [p.family])
    for (const [from, to] of dates(p.from, p.to))
      for (const variant of p.direction === 'purchase' ? [5, 6, 8] : [null])
        tasks.push({ family, from, to, variant, cursor: '', count: 0, done: false, seen: [] });
  return tasks;
}
// HTML hóa đơn: dùng bộ dựng giống trang tra cứu của cổng thuế (port từ luồng API của dự án
// extension) để file .html và .pdf khớp bản chuẩn — xem src/invoice-html.js.
const { invoiceHtml, withXmlFields } = require('./invoice-html');
// Chặn an toàn: nếu cổng trả cursor MỚI mãi không dừng thì dừng task đó lại thay vì lặp vô hạn.
// 400 trang × 50 dòng = 20.000 hóa đơn/tháng, cao hơn mọi tháng thực tế đã gặp.
const MAX_PAGES_PER_TASK = 400;
// Chỉ TÁI SỬ DỤNG danh sách đã tra cứu khi: lượt trước đã tra cứu XONG và sẵn sàng tải
// (`phase='download'`, `state='ready'`) VÀ mọi điều kiện tra cứu trùng khớp (từ ngày, đến ngày,
// chiều mua/bán, nhóm/family, định dạng, trạng thái). Khác một điều kiện bất kỳ ⇒ phải chạy
// lượt cuốn chiếu mới, tránh tải nhầm danh sách của lượt khác.
function canReuseSearch(job, requested) {
  const comparable = value => JSON.stringify({ ...value, formats: [...(value.formats || [])].sort() });
  return !!job && job.phase === 'download' && job.state === 'ready' && comparable(job.params) === comparable(requested);
}
function classifyDownloadError(error) {
  const message = String(error?.message || error || 'Lỗi không xác định.');
  if (error?.auth || /hết phiên|đăng nhập/i.test(message)) return { type: 'auth', retryable: true, message };
  if (/429|quá nhiều yêu cầu|tạm từ chối|bị chặn/i.test(message)) return { type: 'rate_limited', retryable: true, message };
  if (/timeout|không phản hồi|timed?\s*out/i.test(message)) return { type: 'timeout', retryable: true, message };
  if (/XML|ZIP|gói tải/i.test(message)) return { type: 'invalid_xml', retryable: false, message };
  if (/ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) return { type: 'network', retryable: true, message };
  return { type: 'portal', retryable: true, message };
}

function xmlTag(xml, name) {
  const match = String(xml || '').match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([^<]*)<\\/(?:[\\w.-]+:)?${name}>`, 'i'));
  return match ? match[1].trim() : '';
}

function validateInvoiceXml(xml, invoice) {
  const actual = { number: xmlTag(xml, 'SHDon'), symbol: xmlTag(xml, 'KHHDon'), form: xmlTag(xml, 'KHMSHDon') };
  const expected = { number: String(invoice.shdon ?? '').trim(), symbol: String(invoice.khhdon ?? '').trim(), form: String(invoice.khmshdon ?? '').trim() };
  const comparable = (key, value) => key === 'number' ? (String(value).replace(/^0+(?=\d)/, '') || '0') : String(value).trim().toUpperCase();
  for (const key of Object.keys(expected)) {
    if (actual[key] && expected[key] && comparable(key, actual[key]) !== comparable(key, expected[key])) {
      throw new Error(`XML không khớp hóa đơn: ${key} nhận "${actual[key]}", cần "${expected[key]}".`);
    }
  }
  return { ...actual, verified: !!(actual.number || actual.symbol || actual.form) };
}
class Engine {
  constructor({ store, request, identity, emit, pdf, excel, shouldSkip }) {
    Object.assign(this, { store, request, identity, emit, pdf, excel, shouldSkip });
    this.busy = false; this.cancelled = false; this.job = null;
    // Lượt chạy bị NGẮT (app bị tắt/crash giữa đường) để lại đúng `searching`/`downloading` trên đĩa;
    // còn khi người dùng bấm "Tạm dừng" thì app đã ghi hẳn `paused`. Ghi nhớ để lát nữa tự chạy tiếp.
    this.interrupted = false;
    if (fs.existsSync(store)) {
      this.job = JSON.parse(fs.readFileSync(store, 'utf8'));
      if (['searching', 'downloading'].includes(this.job.state)) { this.job.state = 'paused'; this.interrupted = true; }
    }
  }
  // Tự chạy tiếp lượt bị ngắt — chỉ gọi khi app vừa mở lại và đã có phiên đăng nhập. Chạy lại `scan()`
  // (bỏ qua task đã xong, tiếp từ cursor) hoặc `download()` tuỳ theo phase. Không làm gì nếu không có
  // gì bị ngắt, hoặc nếu lần trước người dùng chủ động bấm "Tạm dừng" (trên đĩa là `paused`).
  async autoResume() {
    if (!this.interrupted || this.busy || !this.job) return null;
    this.interrupted = false;
    return this.job.phase === 'search' ? this.resume() : this.resume(true);
  }
  save() { if (this.job) atomicWrite(this.store, JSON.stringify(this.job)); this.emit(this.snapshot()); }
  snapshot() {
    if (!this.job) return { state: 'idle', busy: this.busy, items: [], message: 'Đăng nhập để bắt đầu.' };
    const j = this.job;
    const visible = j.mode === 'stream' ? j.items.filter(item => item.state === 'done') : j.items;
    return { state: j.state, busy: this.busy, mode: j.mode || 'search', message: j.message, params: j.params, output: j.output, account: j.account, stats: j.stats || null, total: j.items.length, done: j.items.filter(x => x.state === 'done' || x.state === 'skipped').length, failed: j.items.filter(x => x.state === 'failed').length, items: visible.slice(0, 1000).map(({ invoice: i, state, error, errorType, retryable, warning, files }) => ({ number: i.shdon, symbol: i.khhdon, seller: i.nbmst, name: i.nbten, date: i.tdlap, amount: i.tgtttbso, files: (files || []).slice(0, 3), state, error, errorType, retryable, warning })) };
  }
  pause() { this.cancelled = true; }
  check() { if (this.cancelled) throw Object.assign(new Error('Đã tạm dừng. Có thể tải tiếp.'), { paused: true }); }
  async checkAccount() {
    this.check();
    const account = await this.identity();
    if (!account || account.key !== this.job.account.key) throw Object.assign(new Error('Cần đăng nhập đúng tài khoản của lượt tải.'), { auth: true });
  }
  async run(fn) {
    if (this.busy) throw new Error('Đang có tác vụ chạy.');
    this.busy = true; this.cancelled = false;
    try { await fn(); }
    catch (e) { if (this.job) { this.job.state = e.paused ? 'paused' : e.auth ? 'auth_required' : 'failed'; this.job.message = e.message; } else throw e; }
    finally { this.busy = false; this.save(); }
    return this.snapshot();
  }
  async search(params, output) {
    params = validateParams(params);
    const account = await this.identity();
    if (!account) throw new Error('Hãy đăng nhập cổng thuế trước.');
    if (!output || !path.isAbsolute(output)) throw new Error('Chọn thư mục lưu hóa đơn.');
    return this.run(async () => {
      this.job = { version: 1, id: crypto.randomUUID(), account, output, params, tasks: tasksFor(params), items: [], phase: 'search', state: 'searching', message: 'Đang tra cứu...' };
      this.save(); await this.scan();
    });
  }
  async stream(params, output) {
    params = validateParams(params);
    const account = await this.identity();
    if (!account) throw new Error('Hãy đăng nhập cổng thuế trước.');
    if (!output || !path.isAbsolute(output)) throw new Error('Chọn thư mục lưu hóa đơn.');
    return this.run(async () => {
      this.job = {
        version: 1, id: crypto.randomUUID(), mode: 'stream', account, output, params,
        tasks: tasksFor(params), items: [], phase: 'search', state: 'searching',
        stats: { total: 0, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 },
        message: 'Đang tra cứu và tải cuốn chiếu...',
      };
      this.save(); await this.scan();
    });
  }
  async scan() {
    const j = this.job; j.state = 'searching';
    const keys = new Set(j.items.map(x => invoiceKey(x.invoice)));
    // GIAI ĐOẠN 1 — chạy song song vài task để che độ trễ cổng thuế. Nhịp gửi KHÔNG tăng:
    // pace.wait() đặt chỗ trước khi bắn nên dù nhiều task cùng bay, request vẫn cách nhau >= MIN_GAP.
    const concurrency = j.mode === 'stream' ? 1 : Math.max(1, Math.min(4, Number(process.env.HOADON_SCAN_CONCURRENCY) || 2));
    const startIndex = j.items.length; // item cũ giữ nguyên chỗ; chỉ sắp lại phần thêm trong lượt này
    const order = new Map();           // invoiceKey -> [thứ tự task, thứ tự trong task]
    const queue = j.tasks.map((task, index) => ({ task, index })).filter(x => !x.task.done);
    const runTask = async ({ task, index }) => {
      // Chạy lại task còn dở: xoá chẩn đoán của lần trước để retry thành công không còn báo lỗi cũ.
      // cursor/count/pages/seen giữ nguyên nên vẫn tiếp đúng chỗ đã dừng.
      task.error = ''; task.warning = '';
      let seq = 0;
      const superseded = new Set();
      let supersededSaved = 0;
      // GỐI ĐẦU (chỉ ở "Tải ngay"): lấy trước TRANG KẾ trong lúc đang tải trang hiện tại, để không còn
      // khoảng nghỉ giữa hai trang. Nhịp cổng vẫn xếp hàng tuần tự ⇒ KHÔNG tăng áp lực lên cổng thuế.
      const queryFor = cursor => `/${task.family}/invoices/${j.params.direction}?sort=tdlap:desc&size=50&search=${searchExpression(task.from, task.to, task.variant)}${cursor ? '&state=' + encodeURIComponent(cursor) : ''}`;
      let prefetched = null;
      try {
        while (!task.done) {
          await this.checkAccount();
          const action = `Tìm kiếm (hóa đơn ${task.family === 'sco-query' ? 'máy tính tiền ' : ''}${j.params.direction === 'sold' ? 'bán ra' : 'mua vào'})`;
          let response;
          if (prefetched) { response = await prefetched; prefetched = null; } else response = await this.request(queryFor(task.cursor), action, () => this.check());
          this.check();
          const data = JSON.parse(response.toString('utf8'));
          if (!data || typeof data !== 'object' || !Array.isArray(data.datas)) throw new Error('API trả danh sách không hợp lệ; giữ tiến độ để thử lại.');
          const before = j.items.length;
          for (const invoice of data.datas) {
            const inv = { ...invoice, family: task.family, direction: j.params.direction };
            const key = invoiceKey(inv);
            const state = String(inv.tthai ?? '');
            // tthai = 4 ("Đã bị thay thế") không thuộc kho dữ liệu: CHỈ lấy khi người dùng chọn
            // đúng trạng thái này; còn lại ghi khoá lại để bộ nhập bỏ qua và dọn bản đã có.
            const blocked = state === SUPERSEDED_STATE && j.params.status !== SUPERSEDED_STATE;
            if (blocked) {
              // Ghi khoá theo đúng định dạng tầng dữ liệu; thiếu trường thì bỏ qua, KHÔNG làm hỏng lượt tìm.
              try { superseded.add(buildInvoiceKey({ mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon })); }
              catch { /* cổng trả thiếu trường ⇒ không ghi được khoá */ }
            }
            if (!keys.has(key) && !blocked && (!j.params.status || state === j.params.status)) { keys.add(key); j.items.push({ invoice: inv, state: 'queued', files: [] }); order.set(key, [index, seq]); seq += 1; }
          }
          if (superseded.size > supersededSaved) { rememberSuperseded(j, superseded); supersededSaved = superseded.size; }
          const count = task.count + data.datas.length;
          const cursor = data.state === undefined || data.state === null ? '' : String(data.state);
          // Cổng thuế trả `total` KHÔNG nhất quán (đo thực tế: 295 vs 287 cho cùng một tháng;
          // 1377/1332 trong khi chỉ có 1368 bản ghi), nên KHÔNG dùng `total` để quyết định còn trang.
          // Cursor mới là dấu hiệu thật: còn cursor -> còn trang; hết cursor -> hết dữ liệu của task.
          if (cursor && (cursor === task.cursor || task.seen.includes(cursor))) throw new Error(`Cổng trả lại cursor đã dùng cho ${task.from} → ${task.to}; giữ tiến độ để thử lại.`);
          if (cursor && data.datas.length === 0) throw new Error(`Cổng trả trang rỗng nhưng vẫn còn cursor cho ${task.from} → ${task.to}; giữ tiến độ để thử lại.`);
          if (cursor && (task.pages || 0) >= MAX_PAGES_PER_TASK) throw new Error(`Quá nhiều trang cho ${task.from} → ${task.to} (đã ${task.pages} trang); giữ tiến độ để thử lại.`);
          task.count = count;
          task.pages = (task.pages || 0) + 1;
          task.added = (task.added || 0) + (j.items.length - before);
          const total = Number(data.total);
          if (Number.isFinite(total)) { task.total = total; task.totals = [...new Set([...(task.totals || []), total])].slice(-10); }
          if (task.cursor) task.seen.push(task.cursor);
          task.cursor = cursor; task.done = !cursor;
          // Hết cursor nghĩa là cổng không còn dữ liệu để đưa. Nếu số nhận được khác `total` thì
          // ghi lại cảnh báo (kèm số liệu trong chính task) để còn kiểm tra lại, không hứa "đã đủ".
          if (task.done && Number.isFinite(total) && count !== total) task.warning = `Cổng báo tổng ${total} nhưng nhận được ${count} bản ghi (API trả tổng không nhất quán).`;
          j.message = `Đã tìm ${j.items.length} hóa đơn · ${task.from} → ${task.to}`;
          this.save();
          if (j.mode === 'stream' && j.items.length > before) {
            j.phase = 'search';
            // Gối đầu TRANG KẾ (dùng cursor vừa nhận) chạy song song với việc tải trang hiện tại.
            // Không còn trang nữa thì không lấy thừa request nào.
            if (!task.done) {
              j.stats = j.stats || {};
              const pending = this.request(queryFor(task.cursor), action, () => this.check());
              pending.catch(() => {}); // lỗi thật được ném ra ở vòng lặp sau, tránh unhandledRejection
              prefetched = pending;
              j.stats.prefetched = (j.stats.prefetched || 0) + 1;
            }
            await this.download({ incremental: true, finalize: false });
            j.phase = 'search'; j.state = 'searching';
            j.message = `Đã tìm ${j.items.length} · tải thành công ${j.stats.downloaded} · đang tra cứu tiếp${j.stats.prefetched ? ` · gối đầu ${j.stats.prefetched} trang` : ''}`;
            this.save();
          }
        }
      } catch (error) {
        // Tạm dừng / cần đăng nhập vẫn phải dừng cả lượt như trước.
        if (error && (error.paused || error.auth)) throw error;
        // Một tháng lỗi KHÔNG được làm chết các tháng còn lại: ghi lỗi vào task rồi đi tiếp.
        task.done = false;
        task.error = error && error.message ? error.message : String(error);
        j.message = `Tháng ${task.from} → ${task.to} gặp lỗi: ${task.error}`;
        this.save();
      }
    };
    let next = 0;
    // Giành index TRƯỚC khi await (tăng đồng bộ) — nếu tăng sau await thì hai worker sẽ cùng lấy
    // một task và bỏ qua task khác.
    const worker = async () => { for (;;) { const i = next; next += 1; if (i >= queue.length) return; await runTask(queue[i]); } };
    // allSettled: một task ném lỗi (tạm dừng / hết phiên) cũng không để worker khác treo lơ lửng.
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
    const fatal = settled.find(r => r.status === 'rejected');
    if (fatal) throw fatal.reason;
    // Sắp lại item thêm trong lượt này theo thứ tự task => items/Excel giống hệt khi chạy tuần tự.
    const tail = j.items.slice(startIndex);
    if (tail.length > 1) {
      const slotOf = invoice => order.get(invoiceKey(invoice.invoice)) || [Number.MAX_SAFE_INTEGER, 0];
      tail.sort((a, b) => { const x = slotOf(a); const y = slotOf(b); return x[0] - y[0] || x[1] - y[1]; });
      j.items = j.items.slice(0, startIndex).concat(tail);
    }
    const unfinished = j.tasks.filter(t => !t.done);
    if (j.mode === 'stream') {
      if (unfinished.length) {
        j.phase = 'search'; j.state = 'partial';
        j.message = `Tải cuốn chiếu tạm dừng: đã tìm ${j.items.length}, tải thành công ${j.stats.downloaded}. Còn ${unfinished.length} khoảng chưa hoàn tất.`;
        this.save();
      } else {
        j.phase = 'download';
        await this.download({ incremental: true, finalize: true });
      }
      return;
    }
    j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 };
    // Còn task dở thì GIỮ phase 'search' để nút "Tải tiếp" vào lại scan(); scan() bỏ qua task đã done
    // nên chỉ chạy tiếp đúng tháng còn thiếu, từ cursor đã lưu — không quét lại tháng đã hoàn tất.
    j.phase = unfinished.length ? 'search' : 'download';
    // 'partial' (không phải 'ready') vì giao diện chỉ bật nút "Tải tiếp" ở các trạng thái này.
    j.state = unfinished.length ? 'partial' : 'ready';
    const failed = j.tasks.filter(t => t.error);
    const warned = j.tasks.filter(t => t.warning);
    const notes = [];
    if (failed.length) notes.push(`${failed.length} tháng lỗi (${failed.map(t => t.from.slice(0, 7)).join(', ')})`);
    if (warned.length) notes.push(`${warned.length} tháng cổng báo tổng không nhất quán (${warned.map(t => t.from.slice(0, 7)).join(', ')})`);
    j.message = (unfinished.length
      ? `Tra cứu chưa xong: ${j.items.length} hóa đơn đã lấy. Còn ${unfinished.length} tháng chưa hoàn tất (${unfinished.map(t => t.from.slice(0, 7)).join(', ')}). Bấm "Tải tiếp" để chạy nốt từ chỗ đã dừng.`
      : `Tra cứu xong theo cursor: ${j.items.length} hóa đơn.`)
      + (notes.length ? ` CHƯA XÁC NHẬN ĐỦ: ${notes.join('; ')} — xem chi tiết trong file job (mục tasks).` : '')
      + (unfinished.length ? '' : ' Bấm Tải hóa đơn.');
    this.save();
  }
  async resume(download = false) {
    if (!this.job) throw new Error('Chưa có lượt tải để tiếp tục.');
    return this.run(async () => {
      await this.checkAccount();
      if (this.job.phase === 'search') await this.scan();
      else if (this.job.mode === 'stream') await this.download({ incremental: true, finalize: true });
      else if (download || this.job.phase === 'download') await this.download();
    });
  }
  // Quét thư mục đích để nhận diện file đã có: file hóa đơn nằm trong <MST>/<Mua_vao|Ban_ra>/<xml|pdf|html|zip>/,
  // nhưng vẫn nhận cả file nằm ngay trong <Mua_vao|Ban_ra>/ (bản trước ghi phẳng) để không tải lại.
  scanFolder(root, direction) {
    const folder = path.join(root, direction);
    const found = new Map();
    try {
      for (const name of fs.readdirSync(folder)) {
        const file = path.join(folder, name);
        try { if (fs.statSync(file).isFile()) found.set(name.toLowerCase(), file); } catch {}
      }
    } catch {}
    for (const kind of ['xml', 'zip', 'html', 'pdf']) {
      const sub = path.join(folder, kind);
      try { for (const name of fs.readdirSync(sub)) { const key = name.toLowerCase(); if (!found.has(key)) found.set(key, path.join(sub, name)); } } catch {}
    }
    return found;
  }
  // File đã có cho từng định dạng của 1 hóa đơn (dựa đúng quy tắc đặt tên hiện tại: base + đuôi;
  // XML có thể là base.xml hoặc base_1.xml… khi gói tải chứa nhiều XML).
  presentFiles(onDisk, base, formats) {
    const present = { xml: '', zip: '', html: '', pdf: '' };
    const size = file => { try { return file && fs.statSync(file).size > 0 ? file : ''; } catch { return ''; } };
    const find = name => onDisk.get(name.toLowerCase()) || '';
    if (formats.some(x => x === 'xml' || x === 'zip')) {
      present.zip = size(find(`${base}.zip`));
      present.xml = size(find(`${base}.xml`));
      if (!present.xml) for (const [name, file] of onDisk) {
        if (name.startsWith(`${base}_`.toLowerCase()) && name.endsWith('.xml')) { present.xml = size(file); if (present.xml) break; }
      }
    }
    if (formats.includes('html')) present.html = size(find(`${base}.html`));
    if (formats.includes('pdf')) present.pdf = size(find(`${base}.pdf`));
    return present;
  }
  async download({ incremental = false, finalize = true } = {}) {
    const j = this.job; j.state = 'downloading';
    // Cây thư mục: <thư mục lưu>/MST-<số MST>/<Mua_vao|Ban_ra>/tên file — chỉ 2 thư mục con
    // (mua vào / bán ra), KHÔNG chia thêm thư mục theo xml/pdf/html/zip.
    const root = path.join(j.output, `MST-${safeName(j.account.mst || j.account.label)}`);
    const jobDirection = j.params.direction === 'sold' ? 'Ban_ra' : 'Mua_vao';
    // Bước 1 – quét thư mục đích trước khi tải (1 lần), rồi đối chiếu từng hóa đơn.
    if (!incremental || this.downloadCacheJob !== j.id || !this.downloadFiles) {
      this.downloadCacheJob = j.id;
      this.downloadFiles = this.scanFolder(root, jobDirection);
    }
    const onDisk = this.downloadFiles;
    if (!incremental || !j.stats) j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 };
    else j.stats.total = j.items.length;
    const recount = () => {
      const count = state => j.items.filter(item => item.state === state).length;
      const skipped = count('skipped');
      Object.assign(j.stats, {
        total: j.items.length,
        existed: skipped,
        queued: j.items.filter(item => ['running', 'done', 'failed'].includes(item.state)).length,
        downloaded: count('done'),
        skipped,
        failed: count('failed'),
      });
    };
    recount();
    this.save();
    const pendingItems = j.items.filter(item => !incremental || ['queued', 'failed'].includes(item.state));
    const processItem = async item => {
      await this.checkAccount();
      const inv = item.invoice;
      const suffix = crypto.createHash('sha256').update(invoiceKey(inv)).digest('hex').slice(0, 10);
      const base = `${safeName(inv.nbmst)}_${safeName(inv.khmshdon)}_${safeName(inv.khhdon)}_${safeName(inv.shdon)}_${suffix}`;
      const direction = inv.direction === 'sold' ? 'Ban_ra' : 'Mua_vao';
      // Móc tuỳ chọn — chỉ Auto Sync truyền vào: hoá đơn đã có trong SQLite thì bỏ qua NGAY, không
      // request tới cổng thuế (PROJECT_ARCHITECTURE mục 19 lớp 1, §86.7 “SQLite là duplicate index chính”).
      // Luồng thủ công KHÔNG truyền shouldSkip nên hành vi tải giữ nguyên hoàn toàn (mục 12).
      if (typeof this.shouldSkip === 'function') {
        let known = false;
        try { known = !!(await this.shouldSkip(inv)); } catch { known = false; }
        if (known) {
          item.state = 'skipped'; item.error = '';
          recount();
          j.message = `${j.stats.existed}/${j.items.length} hóa đơn đã có trong dữ liệu · đã tải ${j.stats.downloaded} · lỗi ${j.stats.failed}`;
          this.save(); return;
        }
      }
      // Bước 2+3 – file đã tồn tại thì bỏ qua ngay trước khi tải: không request, không ghi đè, không đổi tên.
      const perFile = j.params.formats.filter(x => ['xml', 'zip', 'html', 'pdf'].includes(x));
      if (perFile.length) {
        const present = this.presentFiles(onDisk, base, j.params.formats);
        if (perFile.every(kind => present[kind])) {
          item.state = 'skipped'; item.error = '';
          for (const file of Object.values(present)) if (file && !item.files.includes(file)) item.files.push(file);
          recount();
          j.message = `${j.stats.existed}/${j.items.length} hóa đơn đã có sẵn · đã tải ${j.stats.downloaded} · lỗi ${j.stats.failed}`;
          this.save(); return;
        }
      }
      const query = new URLSearchParams(Object.fromEntries(['nbmst', 'khhdon', 'shdon', 'khmshdon'].map(k => [k, String(inv[k] ?? '')]))).toString();
      item.state = 'running'; item.error = ''; recount(); this.save();
      // File hóa đơn nằm trong <Mua_vao|Ban_ra>/<xml|pdf|html|zip>/; tên file giữ MST người bán, mẫu số,
      // ký hiệu, số hóa đơn và hậu tố chống trùng nên không lẫn nhau. File đã có thì không ghi lại.
      const write = (kind, ext, bytes) => {
        const file = path.join(root, direction, kind, base + ext);
        try { if (fs.existsSync(file) && fs.statSync(file).size > 0) { if (!item.files.includes(file)) item.files.push(file); return; } } catch {}
        atomicWrite(file, bytes); onDisk.set(path.basename(file).toLowerCase(), file); if (!item.files.includes(file)) item.files.push(file);
      };
      // XML gốc của hóa đơn này (chỉ có khi lượt tải chọn xml/zip) — cũng là nguồn MCCQT/NLap cho
      // HTML/PDF, đúng như luồng API của dự án extension.
      let sourceXml = '';
      try {
        if (j.params.formats.some(x => ['xml', 'zip'].includes(x))) {
          const bytes = await this.request(`/${inv.family}/invoices/export-xml?${query}`, 'Tải XML', () => this.check());
          this.check();
          let zip;
          if (bytes[0] === 0x50 && bytes[1] === 0x4b) zip = await JSZip.loadAsync(bytes);
          else { if (!/^\s*(?:\uFEFF)?\s*<\?xml|^\s*<(?:[\w-]+:)?HDon[\s>]/i.test(bytes.toString('utf8'))) throw new Error('API không trả XML hợp lệ.'); zip = new JSZip(); zip.file('invoice.xml', bytes); }
          const entries = Object.values(zip.files).filter(x => !x.dir && /\.xml$/i.test(x.name));
          if (!entries.length) throw new Error('Gói tải không có XML.');
          sourceXml = await entries[0].async('string');
          item.xmlIdentity = validateInvoiceXml(sourceXml, inv);
          item.warning = item.xmlIdentity.verified ? '' : 'XML không công bố bộ nhận diện để đối chiếu; file vẫn được lưu.';
          if (j.params.formats.includes('xml')) {
            for (let n = 0; n < entries.length; n++) {
              const xml = await entries[n].async('nodebuffer');
              if (!xml.length || !xml.toString('utf8').trimStart().startsWith('<')) throw new Error('XML rỗng hoặc không hợp lệ.');
              write('xml', entries.length === 1 ? '.xml' : `_${n + 1}.xml`, xml);
            }
          }
          if (j.params.formats.includes('zip')) write('zip', '.zip', bytes[0] === 0x50 ? bytes : await zip.generateAsync({ type: 'nodebuffer' }));
        }
        if (j.params.formats.some(x => ['html', 'pdf'].includes(x))) {
          const detail = JSON.parse((await this.request(`/${inv.family}/invoices/detail?${query}`, 'Xem chi tiết', () => this.check())).toString('utf8'));
          this.check();
          const html = invoiceHtml(inv, withXmlFields(detail, sourceXml));
          if (j.params.formats.includes('html')) write('html', '.html', html);
          if (j.params.formats.includes('pdf')) write('pdf', '.pdf', await this.pdf(html));
        }
        item.state = 'done'; item.errorType = ''; item.retryable = false; recount();
      } catch (e) {
        const failure = classifyDownloadError(e);
        item.state = 'failed'; item.error = failure.message; item.errorType = failure.type; item.retryable = failure.retryable; recount();
        if (failure.type === 'rate_limited') { this.downloadConcurrency = 1; e.paused = true; }
        if (e.auth || e.paused) throw e;
      }
      j.message = `Đã xử lý ${j.items.filter(x => ['done', 'failed'].includes(x.state)).length}/${j.items.length}`;
      this.save();
    };
    // Hai worker giúp che độ trễ phản hồi của cổng. Mọi request vẫn đi qua pace.wait(), vì vậy
    // thời điểm bắt đầu request luôn cách nhau theo nhịp an toàn chung và không tạo burst.
    const concurrency = Math.max(1, Math.min(3, Number(process.env.HOADON_DOWNLOAD_CONCURRENCY) || 2));
    this.downloadConcurrency = concurrency;
    let nextItem = 0;
    const worker = async workerIndex => {
      for (;;) {
        if (workerIndex >= this.downloadConcurrency) return;
        const index = nextItem; nextItem += 1;
        if (index >= pendingItems.length) return;
        await processItem(pendingItems[index]);
      }
    };
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, pendingItems.length) }, (_, index) => worker(index)));
    const fatal = settled.find(result => result.status === 'rejected');
    if (fatal) throw fatal.reason;
    this.check();
    if (!finalize) {
      j.state = 'searching';
      j.message = `Đã tìm ${j.items.length} · tải thành công ${j.stats.downloaded} · đang tra cứu tiếp`;
      this.save();
      return;
    }
    if (j.params.formats.includes('xlsx')) {
      // Bảng tổng hợp nằm luôn trong thư mục nhánh 2 (Mua_vao/Ban_ra), không tạo thư mục riêng.
      const file = path.join(root, jobDirection, `HD-EXCEL-${j.params.from}-${j.params.to}-${j.id.slice(0, 8)}.xlsx`);
      if (!(fs.existsSync(file) && fs.statSync(file).size > 0)) atomicWrite(file, await this.excel(j.items));
    }
    atomicWrite(path.join(root, `bao-cao-${j.id}.json`), JSON.stringify({ params: j.params, items: j.items.map(x => ({ key: invoiceKey(x.invoice), state: x.state, error: x.error || '', files: x.files })) }, null, 2));
    const errors = j.items.filter(x => x.state === 'failed').length;
    j.state = errors ? 'partial' : 'completed';
    j.message = `Hoàn tất: ${j.items.length - errors} hóa đơn (tải mới ${j.stats.downloaded}, đã có sẵn ${j.stats.skipped}, lỗi ${errors}).`;
  }
  // Xuất 01 file Excel ĐÚNG theo mẫu MISA, từ chính kết quả tra cứu (không gọi API chi tiết, không tải XML/PDF).
  async exportList() {
    const j = this.job;
    if (!j) throw new Error('Chưa có lượt tra cứu nào. Bấm “Tra cứu hóa đơn” trước.');
    if (!j.items.length) throw new Error('Lượt tra cứu này không có hóa đơn nào để xuất Excel.');
    const root = path.join(j.output, `MST-${safeName(j.account.mst || j.account.label)}`);
    const sold = j.params.direction === 'sold';
    const stamp = iso => { const [y, m, d] = String(iso).split('-'); return `${d}-${m}-${y}`; }; // 14-09-2026
    // Tên file theo yêu cầu: "<từ ngày> - <đến ngày> - <Mua vào|Bán ra>.xlsx", lưu ở thư mục nhánh 2
    // (Mua_vao/Ban_ra) — KHÔNG nằm trong thư mục xml/pdf/html.
    const file = path.join(root, sold ? 'Ban_ra' : 'Mua_vao', `${stamp(j.params.from)} - ${stamp(j.params.to)} - ${sold ? 'Bán ra' : 'Mua vào'}.xlsx`);
    atomicWrite(file, invoiceExport.workbook(j.items, { mst: j.account.mst || j.account.label, from: j.params.from, to: j.params.to, direction: j.params.direction }));
    return { file, rows: j.items.length, columns: invoiceExport.columnNames().length };
  }
}
module.exports = { Engine, safeName, atomicWrite, dates, invoiceKey, tasksFor, searchExpression, validateParams, invoiceHtml, canReuseSearch, classifyDownloadError, validateInvoiceXml };
