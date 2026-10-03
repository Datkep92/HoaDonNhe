'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const invoiceExport = require('./invoice-excel');
// Khoá hoá đơn của TẦNG DỮ LIỆU (MST người bán | KHMSHDon | KHHDon | SHDon, đã bỏ số 0 đầu).
// Danh sách "hoá đơn bị thay thế" phải dùng ĐÚNG định dạng này để bộ nhập so khớp được.
const { buildInvoiceKey } = require('./data/invoice-key');
const invoiceState = require('./data/invoice-state');

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
// Hạn chót cho một promise CÓ THỂ không bao giờ settle (ví dụ worker thread chết giữa chừng).
// Vì sao cần: `run()` chỉ nhả `busy` ở finally, nên chỉ cần MỘT await con treo là lượt tải kẹt
// `busy = true` mãi — nút cứ ở "Ngưng tải", người dùng phải bấm tay mới thoát. Một bước PHỤ
// (bảng tổng hợp Excel) không được phép giữ cả lượt tải như vậy.
function withDeadline(promise, ms, label) {
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // nuôi bản sao: hết hạn trước thì không sinh unhandledRejection
  let timer = null;
  return Promise.race([
    guarded,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: quá ${Math.round(ms / 1000)} giây không xong — bỏ qua.`)), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
// Trạng thái hoá đơn (tthai) CHỈ có ở kết quả tra cứu — XML không mang. Engine ghi lại
// <thư mục lưu>/MST-<mst>/trang-thai-hoa-don.json (ĐỦ cả 6 trạng thái) để bộ nhập đọc và lưu
// vào cột invoices.tthai; nhờ đó kho lọc được theo trạng thái.
//
// KHÔNG xoá hoá đơn khỏi kho ở đây: hoá đơn bị thay thế/điều chỉnh/huỷ vẫn được tải về, vẫn nằm
// trong kho và vẫn xem được — chỉ KHÔNG cộng vào danh sách hàng hoá và tổng tiền
// (danh sách loại trừ nằm ở src/data/invoice-state.js, KHÔNG chép lại ở đây).
const STATE_FILE = 'trang-thai-hoa-don.json';
// File của bản cũ (chỉ chứa khoá hoá đơn "Đã bị thay thế"): vẫn ĐỌC để không mất dấu, KHÔNG ghi nữa.
const LEGACY_SUPERSEDED_FILE = 'hoa-don-bi-thay-the.json';
function stateFile(output, mst) {
  return path.join(String(output || ''), `MST-${safeName(mst)}`, STATE_FILE);
}
function legacySupersededFile(output, mst) {
  return path.join(String(output || ''), `MST-${safeName(mst)}`, LEGACY_SUPERSEDED_FILE);
}
// Đọc trạng thái đã ghi: { states: { "khoá hoá đơn": "1".."6" } }. File hỏng/thiếu ⇒ rỗng.
function readStates(file) {
  return readStateFile(file).states;
}
// Đọc cả hai khối của sổ trạng thái: `states` (tthai) và `parties` (hai đầu mã + chiều đã tra).
// File hỏng/thiếu ⇒ hai khối rỗng. Khối `parties` là MỚI nên file cũ chỉ có `states` vẫn đọc được.
function readStateFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const source = raw && typeof raw === 'object' ? raw : {};
    const states = {};
    for (const [key, value] of Object.entries(source.states && typeof source.states === 'object' ? source.states : {})) {
      const state = String(value ?? '').trim();
      if (key && /^[1-6]$/.test(state)) states[String(key)] = state;
    }
    const parties = {};
    for (const [key, value] of Object.entries(source.parties && typeof source.parties === 'object' ? source.parties : {})) {
      if (!key || !value || typeof value !== 'object') continue;
      // Chỉ giữ đúng 4 trường, ép chuỗi: file này do engine ghi nhưng cũng có thể do tay người dùng sửa.
      const row = {};
      for (const field of ['nbmst', 'nmmst', 'nbten', 'nmten']) {
        const text = String(value[field] ?? '').trim();
        if (text) row[field] = text;
      }
      const direction = String(value.direction ?? '').trim();
      if (direction === 'sold' || direction === 'purchase') row.direction = direction;
      // Cần ít nhất chiều đã tra + một đầu mã, thì mới đối chiếu được.
      if (row.direction && (row.nbmst || row.nmmst)) parties[String(key)] = row;
    }
    return { states, parties };
  } catch { return { states: {}, parties: {} }; }
}
// File cũ: mảng khoá trần hoặc { keys: [...] } ⇒ mọi khoá là '4'. Chỉ dùng khi file mới chưa có khoá đó.
function readLegacySuperseded(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keys = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.keys) ? raw.keys : []);
    return keys.map(String).filter(Boolean);
  } catch { return []; }
}
// Ghi trạng thái KIỂU ĐỌC–GỘP–GHI ĐỒNG BỘ (không có await ở giữa): lượt này không xoá dấu của
// lượt trước, và hai lượt chạy song song không ghi đè lẫn nhau.
// Bản ghi mỗi hoá đơn trong sổ trạng thái. `tthai` là phần CŨ (bản chuỗi trong `states`); `parties`
// là phần MỚI, ghi ở khối riêng `parties` để không phá bản đọc cũ (src/data/xml-scanner.js).
//
// Vì sao cần `parties`: CỔNG THUẾ đã lọc sẵn theo MST đang đăng nhập — tra "bán ra" thì mọi hồ sơ
// trả về đều có hồ sơ làm NGƯỜI BÁN, tra "mua vào" thì là NGƯỜI MUA. Nhưng XML tải về lại ghi MST
// người bán/mua ở cả hai phía, và mã ghi trong XML có thể KHÁC MST hồ sơ (một chủ có nhiều mã:
// MST + CCCD, MST chi nhánh…). Nếu chỉ dựa vào khớp mã thì hoá đơn đó thành UNKNOWN và không
// vào kho. Ghi lại cả hai đầu mã + chiều đã tra, bộ nhập mới có căn cứ để đối chiếu thay vì đoán.
function rememberStates(job, states, parties) {
  const mst = job.account && (job.account.mst || job.account.label);
  const file = stateFile(job.output, mst);
  const previous = readStateFile(file);
  const merged = previous.states;
  for (const key of readLegacySuperseded(legacySupersededFile(job.output, mst))) {
    if (!merged[key]) merged[key] = '4';
  }
  for (const [key, value] of states) merged[String(key)] = String(value);
  const mergedParties = previous.parties;
  if (parties) for (const [key, value] of parties) mergedParties[String(key)] = value;
  try { atomicWrite(file, JSON.stringify({ updatedAt: new Date().toISOString(), states: merged, parties: mergedParties }, null, 1)); }
  catch { /* không ghi được thì lần sau thử lại */ }
  return Object.keys(merged).length;
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
// Tên công ty/HKD của một MST lấy từ KẾT QUẢ TRA CỨU đang có trong bộ nhớ (engine.job.items).
// Có NGAY sau khi tra cứu — không phải đợi tải XML rồi nhập vào kho mới hiện tên.
// Thứ tự tra giống hệt câu SQL trong server#companyNameFor: người BÁN trước, rồi người MUA.
// (Tra mua vào thì MST mình là người mua, tra bán ra thì là người bán — cần cả hai chiều.)
function companyNameFromItems(items, mst) {
  const key = String(mst ?? '').trim();
  if (!key || !Array.isArray(items)) return '';
  const pick = (mstField, nameField) => {
    for (const item of items) {
      const invoice = (item && item.invoice) || item || {};
      if (String(invoice[mstField] ?? '').trim() !== key) continue;
      const name = String(invoice[nameField] ?? '').trim();
      if (name) return name;
    }
    return '';
  };
  return pick('nbmst', 'nbten') || pick('nmmst', 'nmten');
}
// Một dòng của bảng kết quả tra cứu. Gồm cả NGƯỜI MUA và NGÀY LẬP — trước đây ngày có trong dữ
// liệu nhưng giao diện không vẽ, còn người mua thì thiếu hẳn.
function itemRow({ invoice: i, state, error, errorType, retryable, warning, files }) {
  return {
    number: i.shdon, symbol: i.khhdon, form: i.khmshdon, family: i.family,
    seller: i.nbmst, name: i.nbten,
    buyer: i.nmmst, buyerName: i.nmten,
    date: i.tdlap, amount: i.tgtttbso,
    tthai: i.tthai == null || i.tthai === '' ? '' : String(i.tthai),
    stateLabel: invoiceState.label(i.tthai),
    files: (files || []).slice(0, 3), state, error, errorType, retryable, warning,
  };
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
const { withProvenanceNote } = require('./data/invoice-a4');
// Quy tắc "PDF này có rỗng không" dùng CHUNG với browser.js để chỗ sinh PDF và chỗ
// ghi đĩa không lệch nhau — lệch một chỗ thì bản sửa tự-chữa biến mất.
const { isBlankPdf } = require('./browser');
// Chặn an toàn: nếu cổng trả cursor MỚI mãi không dừng thì dừng task đó lại thay vì lặp vô hạn.
// 400 trang × 50 dòng = 20.000 hóa đơn/tháng, cao hơn mọi tháng thực tế đã gặp.
const MAX_PAGES_PER_TASK = 400;
// Hạn chót cho bước dựng bảng tổng hợp Excel ở cuối lượt tải (xem withDeadline).
// Đọc LÚC GỌI (không phải hằng số nạp một lần) để test còn ép được giá trị nhỏ.
const excelDeadlineMs = () => { const value = Number(process.env.HOADON_EXCEL_TIMEOUT_MS); return Number.isFinite(value) && value > 0 ? value : 90000; };
// Chỉ TÁI SỬ DỤNG danh sách đã tra cứu khi: lượt trước đã tra cứu XONG và sẵn sàng tải
// (`phase='download'`, `state='ready'`) VÀ mọi điều kiện tra cứu trùng khớp (từ ngày, đến ngày,
// chiều mua/bán, nhóm/family, định dạng, trạng thái). Khác một điều kiện bất kỳ ⇒ phải chạy
// lượt cuốn chiếu mới, tránh tải nhầm danh sách của lượt khác.
const comparableParams = value => JSON.stringify({ ...value, formats: [...(value.formats || [])].sort() });
// Hai bộ điều kiện tra cứu có trùng nhau không. Tách riêng (thay vì chỉ nằm trong canReuseSearch) vì
// server.js dùng nó để QUYẾT ĐỊNH có chạy tiếp lượt cũ hay không: lượt còn dở mà người dùng đã
// đổi khoảng ngày thì "Tải tiếp" phải chạy lượt MỚI theo khoảng ngày đang chọn, tuyệt đối không
// lặp lại khoảng ngày cũ — cùng một luật so sánh cho cả hai nơi.
function sameDownloadParams(job, requested) {
  return !!job && !!job.params && !!requested && comparableParams(job.params) === comparableParams(requested);
}
function canReuseSearch(job, requested) {
  return !!job && job.phase === 'download' && job.state === 'ready' && comparableParams(job.params) === comparableParams(requested);
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

// ---------------------------------------------------------------------------
// TỰ THỬ LẠI — không bắt người dùng bấm "Tải tiếp" (luồng tải thủ công của nút Tải hóa đơn)
// ---------------------------------------------------------------------------
// Vì sao CHỈ một số loại lỗi được tự thử lại:
//   · timeout / network / portal — lỗi TẠM THỜI của riêng hoá đơn đó (mạng chập, cổng bận
//     vài giây). Thử lại sau vài giây là hợp lý và gần như luôn thành công.
//   · invalid_xml — file hỏng, thử lại y hệt cũng hỏng ⇒ không lãng phí request.
//   · auth — phải đăng nhập lại, thử lại vô ích (server tự mở form đăng nhập).
//   · rate_limited — CỔNG đang giới hạn nhịp: cả lượt đều bị chặn, phải nghỉ dài chứ thử
//     từng hoá đơn là dội thêm request vào cổng. Lượt này dừng như cũ; phần "tự chạy tiếp"
//     sau khi nghỉ do server lo (xem AUTO_RESUME_* trong server.js).
const RETRYABLE_DOWNLOAD_TYPES = new Set(['timeout', 'network', 'portal']);
// Đọc LÚC GỌI (không phải hằng số nạp một lần) để test còn ép được giá trị nhỏ — như các
// biến môi trường khác trong core.js (xem excelDeadlineMs).
function downloadRetryConfig() {
  const num = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : fallback; };
  return {
    maxRetries: Math.floor(num('HOADON_DOWNLOAD_MAX_RETRIES', 3)),
    baseDelayMs: num('HOADON_DOWNLOAD_RETRY_BASE_MS', 5000),
    maxDelayMs: num('HOADON_DOWNLOAD_RETRY_MAX_MS', 60000),
  };
}
// Lượt đang dở thì nút Tải hóa đơn hiện "Tải tiếp" thay vì "Tải hóa đơn" — dùng chung một
// danh sách để giao diện (renderer.js) và server.js không tự chế mỗi bên một danh sách khác nhau.
const RESUMABLE_STATES = new Set(['paused', 'failed', 'partial', 'auth_required']);
function isResumableJob(job) {
  return !!job && !!job.params && !!job.output && RESUMABLE_STATES.has(String(job.state || ''));
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
  constructor({ store, request, identity, emit, pdf, excel, shouldSkip, autoRetry = false, log }) {
    Object.assign(this, { store, request, identity, emit, pdf, excel, shouldSkip });
    // autoRetry: TỰ thử lại hoá đơn lỗi TẠM THỜI ngay trong lượt chạy (không bắt người dùng
    // bấm "Tải tiếp"). CHỈ bật cho luồng thủ công của nút Tải hóa đơn — Auto Sync và
    // retryFailed() giữ hành vi cũ (tự quyết định lúc nào thử lượt) để test và lịch nền
    // không đổi. `log` tuỳ chọn: ghi dòng thử lại ra nhật ký / tin nhắn trạng thái.
    this.autoRetry = !!autoRetry;
    this.log = typeof log === 'function' ? log : () => {};
    // Each run owns its cancellation signal; late results cannot resume an old run.
    for (const name of ['request', 'identity', 'pdf', 'excel', 'shouldSkip']) {
      const operation = this[name];
      if (typeof operation !== 'function') continue;
      this[name] = (...args) => {
        const signal = this.runController?.signal;
        if (!signal) return operation(...args);
        if (signal.aborted) return Promise.reject(signal.reason);
        if (name === 'request') {
          args[2] = () => { if (signal.aborted) throw signal.reason; };
          args[2].signal = signal;
        }
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => {
            if (signal.aborted) throw signal.reason;
            return operation(...args);
          }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
      };
    }
    this.busy = false; this.cancelled = false; this.job = null;
    // Đếm số lần nội dung job đổi (save() hoặc gán job mới): UI so số này thay vì stringify toàn bộ
    // snapshot (tới 1.000 dòng) mỗi nhịp poll 1,5 giây.
    this.jobRevision = 0;
    // Trạng thái gom nhịp ghi job (xem save()/flush()): mốc lần ghi đĩa gần nhất + bộ hẹn đang chờ.
    this.saveTimer = null; this.lastDiskSave = 0;
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
  // ---- Ghi job ra đĩa CÓ GOM NHỊP (throttle: tối đa ~2 lần ghi/giây) ----
  // Trong lúc tải, save() được gọi tối thiểu 2 lần cho MỖI hoá đơn (đổi state trước + sau khi tải),
  // mỗi lần stringify toàn bộ job (tới 1.000 dòng ≈ vài trăm KB) + ghi đĩa nguyên tử ⇒ lượt 1.000
  // hoá đơn = hơn 2.000 lần ghi, là nguồn giật chính của tiến trình khi đang tải. Throttle 500ms:
  // gọi dồn thì chỉ lần ĐẦU trong cửa sổ được ghi ra đĩa, lần sau ghi lại sau 500ms — không trì hoãn
  // vô hạn như debounce thuần. Nội dung TRONG RAM và jobRevision (UI đọc qua /api/state) vẫn tăng
  // NGAY như cũ nên tiến độ UI không chậm lại — chỉ phần ghi đĩa được gom.
  // An toàn resume: file cũ trên đĩa là checkpoint; crash mất tối đa 500ms tiến độ, lượt dở vẫn tiếp
  // đúng nhờ shouldSkip + đối chiếu file đã có — không trùng lặp, chỉ tốn lại vài request.
  static SAVE_DEBOUNCE_MS = 500;
  // Ghi ra đĩa NGAY, bỏ qua throttle (dùng cho checkpoint chủ đích).
  flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this.lastDiskSave = Date.now(); if (this.job) atomicWrite(this.store, JSON.stringify(this.job)); }
  save() {
    this.jobRevision += 1;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    // Ngoài lượt chạy (busy = false): save() là ghi checkpoint CỐ Ý từ bên ngoài → ghi đĩa NGAY
    // (giữ đúng hợp đồng cũ cho mọi caller ngoài vòng run(); test core.test.js dựa vào điều này).
    if (!this.busy) { this.lastDiskSave = Date.now(); if (this.job) atomicWrite(this.store, JSON.stringify(this.job)); this.emit(this.snapshot()); return; }
    const since = Date.now() - this.lastDiskSave;
    if (since >= Engine.SAVE_DEBOUNCE_MS) {
      this.lastDiskSave = Date.now();
      if (this.job) atomicWrite(this.store, JSON.stringify(this.job));
    } else if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, Engine.SAVE_DEBOUNCE_MS - since);
      if (this.saveTimer.unref) this.saveTimer.unref();
    }
    this.emit(this.snapshot());
  }
  // "Tải ngay" gom cả `done` VÀ `skipped`: hoá đơn đã có sẵn trên đĩa / đã có trong kho cũng là
  // xong. Nếu chỉ tính `done` thì chạy lại một kỳ đã tải đủ sẽ cho bảng TRỐNG dù tìm thấy đủ hoá
  // đơn — người dùng tưởng lượt chạy không làm gì.
  visibleItems() {
    const j = this.job;
    if (!j) return [];
    return j.mode === 'stream' ? j.items.filter(item => item.state === 'done' || item.state === 'skipped') : j.items;
  }
  // Danh sách cho bảng kết quả tra cứu. Giao diện dùng MỘT lần gọi (offset 0, limit 1000) và cuộn
  // như bản cũ — KHÔNG còn nút sang trang; offset/limit giữ lại để cắt bớt khi lượt chạy quá dài.
  // newestFirst: MỚI NHẤT TRƯỚC để hoá đơn vừa tải xong nằm ngay đầu bảng, không phải cuộn xuống.
  itemsPage({ offset = 0, limit = 100, newestFirst = true } = {}) {
    const rows = this.visibleItems();
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    const skip = Math.max(0, Number(offset) || 0);
    const ordered = newestFirst ? [...rows].reverse() : rows;
    return { total: ordered.length, offset: skip, limit: size, rows: ordered.slice(skip, skip + size).map(itemRow) };
  }
  snapshot() {
    if (!this.job) return { state: 'idle', busy: this.busy, items: [], message: 'Đăng nhập để bắt đầu.' };
    const j = this.job;
    const visible = this.visibleItems();
    return { state: j.state, busy: this.busy, mode: j.mode || 'search', message: j.message, params: j.params, output: j.output, account: j.account, stats: j.stats || null, total: j.items.length, done: j.items.filter(x => x.state === 'done' || x.state === 'skipped').length, failed: j.items.filter(x => x.state === 'failed').length, items: visible.slice(0, 1000).map(itemRow) };
  }
  pause() {
    this.cancelled = true;
    this.runController?.abort(Object.assign(new Error('Đã tạm dừng. Có thể tải tiếp.'), { paused: true }));
  }
  check() { if (this.cancelled) throw Object.assign(new Error('Đã tạm dừng. Có thể tải tiếp.'), { paused: true }); }
  async checkAccount() {
    this.check();
    const account = await this.identity();
    if (!account || account.key !== this.job.account.key) throw Object.assign(new Error('Cần đăng nhập đúng tài khoản của lượt tải.'), { auth: true });
  }
  async run(fn) {
    if (this.busy) throw new Error('Đang có tác vụ chạy.');
    this.busy = true; this.cancelled = false;
    this.runController = new AbortController();
    try { await fn(); }
    catch (e) { if (this.job) { this.job.state = e.paused ? 'paused' : e.auth ? 'auth_required' : 'failed'; this.job.message = e.message; } else throw e; }
    // Kết thúc lượt (xong / tạm dừng / lỗi): busy=false rồi save() ⇒ ghi đĩa NGAY (xem save()),
    // đây là checkpoint mà resume/cân đối trạng thái phụ thuộc file job.
    finally { this.busy = false; this.runController = null; this.save(); }
    return this.snapshot();
  }
  async search(params, output) {
    params = validateParams(params);
    const account = await this.identity();
    // Gắn cờ auth: lỗi này là "phiên không dùng được", KHÔNG phải người dùng sai. Nếu để là lỗi
    // thường thì run() ghi state='failed' ⇒ server.js không kích hoạt tự đăng nhập nền ⇒ bấm nút
    // lại là 400 y hệt, mãi (đúng lỗi đã gặp: token còn trong directTokens nhưng identity()
    // không dựng được account). Cờ auth để lượt thành 'auth_required' và tự đăng nhập nền chạy.
    if (!account) throw Object.assign(new Error('Hãy đăng nhập cổng thuế trước.'), { auth: true });
    if (!output || !path.isAbsolute(output)) throw new Error('Chọn thư mục lưu hóa đơn.');
    return this.run(async () => {
      this.job = { version: 1, id: crypto.randomUUID(), account, output, params, tasks: tasksFor(params), items: [], phase: 'search', state: 'searching', message: 'Đang tra cứu...' };
      this.save(); await this.scan();
    });
  }
  async stream(params, output) {
    params = validateParams(params);
    const account = await this.identity();
    if (!account) throw Object.assign(new Error('Hãy đăng nhập cổng thuế trước.'), { auth: true });
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
      const states = new Map(); // khoá hoá đơn → tthai: ghi ra MST-<mst>/trang-thai-hoa-don.json
      // khoá hoá đơn → { nbmst, nmmst, nbten, nmten, direction }: hai đầu mã + CHIỀU ĐÃ TRA.
      // Đây là căn cứ để bộ nhập biết hồ sơ này lấy về theo chiều nào, khi mã ghi trong XML khác
      // MST hồ sơ (một chủ có nhiều mã). Xem xml-parser.js detectDirection().
      const parties = new Map();
      let statesSaved = 0;
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
            // Ghi lại trạng thái cho MỌI hoá đơn cổng trả về (đủ 1..6), khoá theo ĐÚNG định dạng
            // tầng dữ liệu để bộ nhập so khớp được. Thiếu trường ⇒ bỏ qua, không làm hỏng lượt tìm.
            if (/^[1-6]$/.test(state)) {
              try { states.set(buildInvoiceKey({ mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon }), state); }
              catch { /* cổng trả thiếu trường ⇒ không ghi được khoá */ }
            }
            // Ghi hai đầu mã + chiều đã tra cho MỌI hồ sơ cổng trả về (không phụ thuộc tthai có hợp lệ
            // hay không): đây là dữ liệu đối chiếu, thiếu nó thì lượt nhập không có căn cứ.
            try {
              const partyKey = buildInvoiceKey({ mstBan: inv.nbmst, khmshDon: inv.khmshdon, khhDon: inv.khhdon, shDon: inv.shdon });
              const row = { direction: j.params.direction === 'purchase' ? 'purchase' : 'sold' };
              if (inv.nbmst) row.nbmst = String(inv.nbmst).trim();
              if (inv.nmmst) row.nmmst = String(inv.nmmst).trim();
              if (inv.nbten) row.nbten = String(inv.nbten).trim();
              if (inv.nmten) row.nmten = String(inv.nmten).trim();
              if (row.nbmst || row.nmmst) parties.set(partyKey, row);
            } catch { /* cổng trả thiếu trường ⇒ không ghi được khoá */ }
            // KHÔNG chặn theo trạng thái: hoá đơn bị thay thế/điều chỉnh/huỷ vẫn được tải về và vào
            // kho. Chỉ lọc khi người dùng chủ động chọn đúng một trạng thái ở ô "Trạng thái hóa đơn".
            if (!keys.has(key) && (!j.params.status || state === j.params.status)) { keys.add(key); j.items.push({ invoice: inv, state: 'queued', files: [] }); order.set(key, [index, seq]); seq += 1; }
          }
          if (states.size > statesSaved) { rememberStates(j, states, parties); statesSaved = states.size; }
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
            // Ngắt mạch vừa bấm: trang mới KHÔNG tải được cái nào ⇒ dừng cả lượt ngay (không tra
            // cứu tiếp, không sang tháng kế) — nếu không message lại ghi đè thành “đang tra cứu tiếp”
            // và vòng lặp cứ chạy mãi trong khi thực tế không có gì tải về được nữa.
            if (j.state === 'partial') { circuitStopped = true; return; }
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
    // Cờ NGẮT MẠCH của riêng lượt scan này (KHÔNG đọc state trên job — job tải lại từ đĩa cho
    // lượt “Tải tiếp” vốn đã mang 'partial', đọc state là làm chết luôn lượt tiếp). Đặt khi trang
    // mới không tải được cái nào ⇒ các tháng còn lại trong hàng chờ không chạy nữa.
    let circuitStopped = false;
    const worker = async () => { for (;;) { if (circuitStopped) return; const i = next; next += 1; if (i >= queue.length) return; await runTask(queue[i]); } };
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
      // Ngắt mạch vừa dừng lượt: GIỮ NGUYÊN thông báo riêng của breaker (đã nói rõ lý do + hướng
      // “Bấm Tải tiếp”), không ghi đè bằng thông báo “tạm dừng – còn X khoảng chưa hoàn tất”.
      if (circuitStopped) { this.save(); return; }
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
      // Không còn dòng "Bấm Tải hóa đơn": từ 1.1.2 lượt thủ công chạy thẳng stream (quét + tải
      // cùng lúc) nên khi quét xong thì đã tải luôn. Lượt search() thuần chỉ còn trong Auto Sync
      // / quét lần đầu, nơi bước tải do chính lịch gọi tiếp — nhắc "bấm nút" ở đó là sai.
      + (unfinished.length ? '' : '');
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
  // Thử lại CHỈ những hoá đơn còn lỗi. `incremental: true` ⇒ pending = queued + failed, nên KHÔNG
  // tải lại những cái đã xong. Dùng ngay sau một lượt tải còn lỗi, để lỗi tạm thời (mạng chập,
  // cổng thuế bận) không bị bỏ quên tới lượt sau — với luật "một ngày một lần" thì lượt sau là mai.
  async retryFailed() {
    if (!this.job) throw new Error('Chưa có lượt tải để thử lại.');
    return this.run(async () => {
      await this.checkAccount();
      if (this.job.phase === 'search') await this.scan();
      else await this.download({ incremental: true, finalize: true });
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
    if (!incremental || !j.stats) j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0, retrying: 0 };
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
        // Hoá đơn đang CHỜ thử lại: không tính vào failed (chưa hỏng hẳn) và không tính vào
        // queued (đang nghỉ) — hiện riêng để giao diện nói rõ "đang thử lại" thay vì im lặng.
        retrying: count('retrying'),
      });
    };
    recount();
    this.save();
    const pendingItems = j.items.filter(item => !incremental || ['queued', 'failed'].includes(item.state));
    // MỘT LẦN THỬ cho một hoá đơn. Tách riêng khỏi vòng tự thử lại (processItem bên dưới) để
    // phần "gọi cổng + ghi đĩa" giữ nguyên một khối, không bị rẽ nhánh lồng vào nhau.
    const attemptItem = async item => {
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
        this.check();
        const file = path.join(root, direction, kind, base + ext);
        // File PDF RỖNG coi như CHƯA CÓ, để tải lại ghi đè được.
        //
        // Vì sao phải vậy: bản pdf() trước đây in nhầm tab about:blank nên để lại file
        // 850 byte RỖNG mà app vẫn báo "Đã có sẵn – bỏ qua" vì size > 0. Người dùng
        // thử tải lại bao nhiêu lần cũng không bao giờ được bản PDF đúng, trừ khi tự
        // xoá file tay. Nay tải lại là tự sửa luôn.
        try {
          if (fs.existsSync(file)) {
            const existing = fs.readFileSync(file);
            const blank = kind === 'pdf' && isBlankPdf(existing);
            if (existing.length > 0 && !blank) { if (!item.files.includes(file)) item.files.push(file); return; }
          }
        } catch {}
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
          // 1) DETAIL TRƯỚC. Chiếm 64/66 trường mà HTML cần, và bắt buộc phải có.
          const detail = JSON.parse((await this.request(`/${inv.family}/invoices/detail?${query}`, 'Xem chi tiết', () => this.check())).toString('utf8'));
          this.check();
          // 2) XML gốc CHỈ là nguồn DỰ PHÒNG cho MCCQT/NLap — hai trường duy nhất
          //    ngoài phần còn lại.
          //
          //    Vì sao không gọi vô điều kiện: detail.mhdon và detail.tdlap đã có sẵn đúng
          //    hai giá trị đó (invoice-html.js: d._xmlMccqt || d.mhdon). Gọi export-xml luôn
          //    là THỪA một lời gọi lên CỔNG THUẾ — cổng có giới hạn nhịp, mỗi hóa đơn
          //    phí một lượt là tăng rủi ro bị chặn.
          //    Đa số hóa đơn: 2 lời gọi rút còn 1. Hóa đơn thiếu mã thì mới lấy XML.
          //    Nhánh xml/zip phía trên đã tải sẵn thì dùng lại, không tải lần hai.
          if (!sourceXml && !(detail && detail.mhdon && detail.tdlap)) {
            try {
              const bytes = await this.request(`/${inv.family}/invoices/export-xml?${query}`, 'Tải XML gốc để in PDF', () => this.check());
              this.check();
              let zip;
              if (bytes[0] === 0x50 && bytes[1] === 0x4b) zip = await JSZip.loadAsync(bytes);
              else { zip = new JSZip(); zip.file('invoice.xml', bytes); }
              const entry = Object.values(zip.files).filter(x => !x.dir && /\.xml$/i.test(x.name))[0];
              if (entry) sourceXml = await entry.async('string');
            } catch (error) {
              // Tín hiệu DỪNG phải ném ra ngoài để lượt tải dừng đúng cơ chế. Nuốt mất
              // nó thì nghẽn dây chuyền đang chạy không dừng — mỗi lượt đều phải ghi đè.
              if (error && error.paused) throw error;
              // Hết XML thì vẫn in được PDF bằng dữ liệu detail; chỉ mất MCCQT/NLap.
              // KHÔNG ném lỗi ra — mất một dòng thông tin còn hơn làm hỏng cả lượt tải.
              item.warning = 'Không lấy được XML gốc nên hóa đơn in thiếu mã tra cứu (MCCQT).';
            }
          }
          // Dải cảnh báo nguồn gốc: bản A4 này DỰNG LẠI từ JSON cổng thuế, không có chữ ký số
          // của nhà cung cấp. In ra đính kèm hồ sơ dễ bị hiểu nhầm là bản gốc nên phải có dải
          // cảnh báo ở mọi trang. Sau này tải được PDF gốc NCC thì đổi 'portal' → 'supplier'.
          const html = withProvenanceNote(invoiceHtml(inv, withXmlFields(detail, sourceXml)), 'portal');
          if (j.params.formats.includes('html')) write('html', '.html', html);
          if (j.params.formats.includes('pdf')) write('pdf', '.pdf', await this.pdf(html));
        }
        item.state = 'done'; item.errorType = ''; item.retryable = false; item.attempt = 0; recount();
      } catch (e) {
        if (e.paused) { item.state = 'queued'; item.error = ''; recount(); throw e; }
        const failure = classifyDownloadError(e);
        item.state = 'failed'; item.error = failure.message; item.errorType = failure.type; item.retryable = failure.retryable; recount();
        if (failure.type === 'rate_limited') { this.downloadConcurrency = 1; e.paused = true; }
        if (e.auth || e.paused) throw e;
        // Tự thử lại (chỉ khi engine bật autoRetry): ném ra để vòng bọc ở dưới bắt và thử lại
        // sau khi nghỉ. Các lượt KHÔNG bật (Auto Sync, retryFailed, test) nuốt lỗi như cũ —
        // hành vi của chúng không đổi một chút nào.
        if (this.autoRetry && RETRYABLE_DOWNLOAD_TYPES.has(failure.type)) throw Object.assign(e, { retryFailure: failure });
      }
      j.message = `Đã xử lý ${j.items.filter(x => ['done', 'failed'].includes(x.state)).length}/${j.items.length}`;
      this.save();
    };
    // Vòng TỰ THỬ LẠI cho một hoá đơn: nghỉ luỹ tiến rồi thử lại tối đa `maxRetries` lần.
    // Chỉ bọc khi engine bật autoRetry — còn lại gọi thẳng attemptItem (hành vi cũ).
    // Nghỉ phải ngắt được: nếu lượt đang chạy thì bấm Ngưng là dừng NGAY, không chờ hết thời gian
    // nghỉ rồi mới đáp ứng (lỗi thật: 60 giây nghỉ mà bấm Ngưng phải chờ 60 giây).
    const sleepInterruptible = ms => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const signal = this.runController && this.runController.signal;
      function cleanup() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
      function onAbort() { cleanup(); reject(signal.reason); }
      if (!signal) return;
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const processItem = async item => {
      // attempt = số lần đã thử (1 = lần đầu). Số lần thử lại TỐI ĐA = maxRetries - 1.
      if (!this.autoRetry) return attemptItem(item);
      const config = downloadRetryConfig();
      for (let attempt = 1; ; attempt += 1) {
        try { return await attemptItem(item); }
        catch (e) {
          // Hết lượt thử, hoặc lỗi không thuộc loại tự thử ⇒ giữ item ở 'failed' và NUỐT lỗi
          // (giống hệt attemptItem khi không bật autoRetry) để phần còn lại của lượt chạy tiếp.
          if (attempt >= config.maxRetries) { recount(); this.save(); return; }
          const failure = e.retryFailure || classifyDownloadError(e);
          const delay = Math.min(config.baseDelayMs * 3 ** (attempt - 1), config.maxDelayMs);
          item.state = 'retrying'; item.attempt = attempt; item.error = failure.message; item.errorType = failure.type;
          j.message = `Cổng thuế bận hoặc mạng chập — thử lại sau ${Math.round(delay / 1000)} giây (lần ${attempt}/${config.maxRetries - 1})…`;
          this.log(`Tự thử lại hoá đơn ${(item.invoice || {}).shdon || ''} lần ${attempt}/${config.maxRetries - 1} sau ${delay}ms: ${failure.message}`);
          this.save();
          try { await sleepInterruptible(delay); }
          catch (pause) { item.state = 'queued'; item.error = ''; item.attempt = 0; recount(); this.save(); throw pause; }
          // Về 'queued' để attemptItem chạy lại đúng từ đầu (nó tự bỏ qua file đã có sẵn).
          item.state = 'queued'; item.error = ''; item.attempt = attempt;
          this.save();
        }
      }
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
      // NGẮT MẠCH (circuit breaker) cho chế độ cuốn chiếu — CHỈ khi cổng thật sự TỪ CHỐI.
      //
      // "Đã có sẵn" KHÔNG phải lỗi và KHÔNG được ngắt: chạy lại một kỳ đã tải đủ là chuyện thường,
      // ngắt ở đó sẽ khoá lượt ở 'partial' và bắt người dùng bấm "Tải tiếp" mãi mà không bao giờ
      // xong (bấm lại ra đúng kết quả cũ), đồng thời bỏ luôn các trang cũ hơn chưa tới vì vòng lặp
      // đã thoát. Đo thật: kỳ đã tải đủ ⇒ 'partial' + "Bấm Tải tiếp" dù không còn gì để tải.
      //
      // Vì sao vẫn cần ngắt khi có lỗi thật: nếu KHÔNG ngắt, vòng scan() chạy tiếp qua các
      // trang/tháng kế tiếp, message đứng ở “đang tra cứu tiếp” và giao diện trông như kẹt
      // “Đang tải” hàng phút dù dữ liệu không về thêm — người dùng phải bấm Ngưng thủ công.
      const fresh = pendingItems;
      const freshDone = fresh.filter(x => x.state === 'done').length;
      const freshFailed = fresh.filter(x => x.state === 'failed').length;
      if (fresh.length && !freshDone && freshFailed) {
        j.state = 'partial';
        j.message = `Tạm dừng tải cuốn chiếu: ${j.stats.downloaded}/${j.items.length} đã tải — cổng thuế từ chối ${freshFailed} hóa đơn của trang vừa quét (lỗi tạm thời — đã giữ tiến độ). Bấm “Tải tiếp” để thử lại từ chỗ đã dừng.`;
        this.save();
        return;
      }
      j.state = 'searching';
      j.message = `Đã tìm ${j.items.length} · tải thành công ${j.stats.downloaded} · đang tra cứu tiếp`;
      this.save();
      return;
    }
    if (j.params.formats.includes('xlsx')) {
      // Bảng tổng hợp nằm luôn trong thư mục nhánh 2 (Mua_vao/Ban_ra), không tạo thư mục riêng.
      const file = path.join(root, jobDirection, `HD-EXCEL-${j.params.from}-${j.params.to}-${j.id.slice(0, 8)}.xlsx`);
      if (!(fs.existsSync(file) && fs.statSync(file).size > 0)) {
        // Bảng tổng hợp là bước PHỤ. Bọc hạn chót để nó không thể giữ `busy` của cả lượt tải
        // (worker dựng Excel treo ⇒ trước đây lượt chạy kẹt vĩnh viễn ở state 'downloading').
        try {
          const bytes = await withDeadline(this.excel(j.items), excelDeadlineMs(), 'Dựng bảng tổng hợp Excel');
          this.check(); atomicWrite(file, bytes);
        } catch (error) {
          j.excelError = error && error.message ? error.message : String(error);
        }
      }
    }
    this.check();
    atomicWrite(path.join(root, `bao-cao-${j.id}.json`), JSON.stringify({ params: j.params, items: j.items.map(x => ({ key: invoiceKey(x.invoice), state: x.state, error: x.error || '', files: x.files })) }, null, 2));
    const errors = j.items.filter(x => x.state === 'failed').length;
    j.state = errors ? 'partial' : 'completed';
    // Bước phụ (Excel) hỏng thì BÁO RA, không im lặng: hoá đơn đã tải xong nhưng bảng tổng hợp thiếu.
    j.message = `Hoàn tất: ${j.items.length - errors} hóa đơn (tải mới ${j.stats.downloaded}, đã có sẵn ${j.stats.skipped}, lỗi ${errors}).`
      + (j.excelError ? ` Không dựng được bảng tổng hợp Excel: ${j.excelError}` : '');
  }
  // Xuất 01 file Excel ĐÚNG theo mẫu MISA, từ chính kết quả tra cứu (không gọi API chi tiết, không tải XML/PDF).
  async exportList() {
    const j = this.job;
    if (!j) throw new Error('Chưa có lượt tải nào. Bấm “Tải hóa đơn” trước.');
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
module.exports = { Engine, itemRow, companyNameFromItems, safeName, atomicWrite, dates, invoiceKey, tasksFor, searchExpression, validateParams, invoiceHtml, canReuseSearch, sameDownloadParams, classifyDownloadError, validateInvoiceXml, isResumableJob, readStateFile, RETRYABLE_DOWNLOAD_TYPES };
