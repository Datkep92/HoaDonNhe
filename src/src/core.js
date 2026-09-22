'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const invoiceExport = require('./invoice-excel');

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
class Engine {
  constructor({ store, request, identity, emit, pdf, excel }) {
    Object.assign(this, { store, request, identity, emit, pdf, excel });
    this.busy = false; this.cancelled = false; this.job = null;
    if (fs.existsSync(store)) {
      this.job = JSON.parse(fs.readFileSync(store, 'utf8'));
      if (['searching', 'downloading'].includes(this.job.state)) this.job.state = 'paused';
    }
  }
  save() { if (this.job) atomicWrite(this.store, JSON.stringify(this.job)); this.emit(this.snapshot()); }
  snapshot() {
    if (!this.job) return { state: 'idle', busy: this.busy, items: [], message: 'Đăng nhập để bắt đầu.' };
    const j = this.job;
    return { state: j.state, busy: this.busy, message: j.message, params: j.params, output: j.output, account: j.account, stats: j.stats || null, total: j.items.length, done: j.items.filter(x => x.state === 'done' || x.state === 'skipped').length, failed: j.items.filter(x => x.state === 'failed').length, items: j.items.slice(0, 1000).map(({ invoice: i, state, error, files }) => ({ number: i.shdon, symbol: i.khhdon, seller: i.nbmst, name: i.nbten, date: i.tdlap, amount: i.tgtttbso, files: (files || []).slice(0, 3), state, error })) };
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
  async scan() {
    const j = this.job; j.state = 'searching';
    const keys = new Set(j.items.map(x => invoiceKey(x.invoice)));
    for (const task of j.tasks) {
      while (!task.done) {
        await this.checkAccount();
        const query = `/${task.family}/invoices/${j.params.direction}?sort=tdlap:desc&size=50&search=${searchExpression(task.from, task.to, task.variant)}${task.cursor ? '&state=' + encodeURIComponent(task.cursor) : ''}`;
        const action = `Tìm kiếm (hóa đơn ${task.family === 'sco-query' ? 'máy tính tiền ' : ''}${j.params.direction === 'sold' ? 'bán ra' : 'mua vào'})`;
        const response = await this.request(query, action, () => this.check());
        this.check();
        const data = JSON.parse(response.toString('utf8'));
        if (!Array.isArray(data.datas)) throw new Error('API trả danh sách không hợp lệ; giữ tiến độ để thử lại.');
        for (const invoice of data.datas) {
          const inv = { ...invoice, family: task.family, direction: j.params.direction };
          const key = invoiceKey(inv);
          if (!keys.has(key) && (!j.params.status || String(inv.tthai) === j.params.status)) { keys.add(key); j.items.push({ invoice: inv, state: 'queued', files: [] }); }
        }
        const count = task.count + data.datas.length;
        const more = count < Number(data.total) || (data.datas.length === 50 && !!data.state);
        if (more && (!data.state || task.seen.includes(data.state) || data.state === task.cursor || !data.datas.length)) throw new Error('Phân trang không tiến triển; chưa thể xác nhận đủ hóa đơn.');
        task.count = count;
        if (task.cursor) task.seen.push(task.cursor);
        task.cursor = more ? data.state : ''; task.done = !more;
        j.message = `Đã tìm ${j.items.length} hóa đơn · ${task.from} → ${task.to}`;
        this.save();
      }
    }
    j.phase = 'download'; j.state = 'ready';
    j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 };
    j.message = `Tra cứu xong: ${j.items.length} hóa đơn. Bấm Tải hóa đơn.`; this.save();
  }
  async resume(download = false) {
    if (!this.job) throw new Error('Chưa có lượt tải để tiếp tục.');
    return this.run(async () => {
      await this.checkAccount();
      if (this.job.phase === 'search') await this.scan();
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
  async download() {
    const j = this.job; j.state = 'downloading';
    // Cây thư mục: <thư mục lưu>/MST-<số MST>/<Mua_vao|Ban_ra>/tên file — chỉ 2 thư mục con
    // (mua vào / bán ra), KHÔNG chia thêm thư mục theo xml/pdf/html/zip.
    const root = path.join(j.output, `MST-${safeName(j.account.mst || j.account.label)}`);
    const jobDirection = j.params.direction === 'sold' ? 'Ban_ra' : 'Mua_vao';
    // Bước 1 – quét thư mục đích trước khi tải (1 lần), rồi đối chiếu từng hóa đơn.
    const onDisk = this.scanFolder(root, jobDirection);
    j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 };
    this.save();
    for (const item of j.items) {
      await this.checkAccount();
      const inv = item.invoice;
      const suffix = crypto.createHash('sha256').update(invoiceKey(inv)).digest('hex').slice(0, 10);
      const base = `${safeName(inv.nbmst)}_${safeName(inv.khmshdon)}_${safeName(inv.khhdon)}_${safeName(inv.shdon)}_${suffix}`;
      const direction = inv.direction === 'sold' ? 'Ban_ra' : 'Mua_vao';
      // Bước 2+3 – file đã tồn tại thì bỏ qua ngay trước khi tải: không request, không ghi đè, không đổi tên.
      const perFile = j.params.formats.filter(x => ['xml', 'zip', 'html', 'pdf'].includes(x));
      if (perFile.length) {
        const present = this.presentFiles(onDisk, base, j.params.formats);
        if (perFile.every(kind => present[kind])) {
          item.state = 'skipped'; item.error = '';
          for (const file of Object.values(present)) if (file && !item.files.includes(file)) item.files.push(file);
          j.stats.existed += 1; j.stats.skipped += 1;
          j.message = `${j.stats.existed}/${j.items.length} hóa đơn đã có sẵn · đã tải ${j.stats.downloaded} · lỗi ${j.stats.failed}`;
          this.save(); continue;
        }
      }
      j.stats.queued += 1;
      const query = new URLSearchParams(Object.fromEntries(['nbmst', 'khhdon', 'shdon', 'khmshdon'].map(k => [k, String(inv[k] ?? '')]))).toString();
      item.state = 'running'; item.error = ''; this.save();
      // File hóa đơn nằm trong <Mua_vao|Ban_ra>/<xml|pdf|html|zip>/; tên file giữ MST người bán, mẫu số,
      // ký hiệu, số hóa đơn và hậu tố chống trùng nên không lẫn nhau. File đã có thì không ghi lại.
      const write = (kind, ext, bytes) => {
        const file = path.join(root, direction, kind, base + ext);
        try { if (fs.existsSync(file) && fs.statSync(file).size > 0) { if (!item.files.includes(file)) item.files.push(file); return; } } catch {}
        atomicWrite(file, bytes); if (!item.files.includes(file)) item.files.push(file);
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
        item.state = 'done'; j.stats.downloaded += 1;
      } catch (e) {
        item.state = 'failed'; item.error = e.message; j.stats.failed += 1;
        if (e.auth || e.paused) throw e;
      }
      j.message = `Đã xử lý ${j.items.filter(x => ['done', 'failed'].includes(x.state)).length}/${j.items.length}`;
      this.save();
    }
    this.check();
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
module.exports = { Engine, safeName, atomicWrite, dates, invoiceKey, tasksFor, searchExpression, validateParams, invoiceHtml };
