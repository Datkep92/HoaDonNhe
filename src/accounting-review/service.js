'use strict';
// Independent workpapers. The invoice DB is opened read-only, never migrated or updated here.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const JSZip = require('jszip');
const store = require('./store');
const { readXml, parseDeclaration } = require('./xml');
const { parseInvoiceXml } = require('../data/xml-parser');
const { buildInvoiceKey } = require('../data/invoice-key');
const queries = require('../data/queries');
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const MAX_XML = 8 * 1024 * 1024;
const MAX_PACKAGE = 250 * 1024 * 1024;
const locks = new Set();

function rangeOf(input = {}) {
  const from = String(input.from || ''), to = String(input.to || '');
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new Error('Chọn khoảng ngày hợp lệ để kiểm tra hồ sơ.');
  }
  if (from > to) throw new Error('Từ ngày phải trước Đến ngày.');
  return { from, to, key: from + '_' + to };
}
function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function fileInfo(dir, name) {
  if (!name) return { path: '', exists: false, reason: 'Chưa có đường dẫn chứng từ.' };
  const file = path.isAbsolute(name) ? path.resolve(name) : path.resolve(dir, name);
  if (!inside(dir, file)) return { path: '', exists: false, reason: 'Chứng từ nằm ngoài thư mục MST; không tự lấy dữ liệu của hồ sơ khác.' };
  try {
    const real = await fsp.realpath(file);
    const realRoot = await fsp.realpath(dir);
    if (!inside(realRoot, real)) return { path: '', exists: false, reason: 'Đường dẫn liên kết nằm ngoài thư mục MST.' };
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return { path: '', exists: false, reason: 'Đường dẫn không phải tệp.' };
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(real)) digest.update(chunk);
    return { path: file, relative: path.relative(dir, file).replace(/\\/g, '/'), exists: true, size: stat.size, hash: digest.digest('hex') };
  } catch (error) { return { path: file, exists: false, reason: error.code === 'ENOENT' ? 'Không tìm thấy tệp.' : 'Không đọc được tệp: ' + error.message }; }
}
function readSource(dir, range) {
  const file = path.join(dir, 'data.db');
  if (!fs.existsSync(file)) return { available: false, invoices: [], banks: [], bankFiles: [], reason: 'Chưa có kho hóa đơn. Tải và nhập XML vào Kho dữ liệu trước.' };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      available: true,
      invoices: db.prepare(`SELECT *, CASE WHEN ${queries.activeSql()} THEN 1 ELSE 0 END AS included FROM invoices WHERE ngay_lap>=? AND ngay_lap<=? ORDER BY invoice_key`).all(range.from, range.to),
      banks: db.prepare('SELECT * FROM bank_transactions WHERE tran_date>=? AND tran_date<=? ORDER BY id').all(range.from, range.to),
      bankFiles: db.prepare('SELECT * FROM bank_files ORDER BY id').all(),
    };
  } catch (error) { throw new Error('Không đọc được kho dữ liệu hiện tại: ' + error.message); }
  finally { db.close(); }
}
async function declarationFiles(dir) {
  const root = path.join(dir, 'To_khai');
  const out = [];
  async function walk(folder) {
    let entries;
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(xml|zip|pdf|xlsx?|docx?|csv)$/i.test(entry.name)) out.push(file);
    }
  }
  await walk(root);
  return out;
}
function issueFactory(issues) {
  return (id, title, reason, evidence = {}, kind = 'documents', severity = 'warning', target = {}) => {
    issues.push({ id, title, reason, evidence, kind, severity, target, fingerprint: hash({ title, reason, evidence }) });
  };
}
function downloads(db) { return db ? db.prepare('SELECT value FROM downloads ORDER BY id').all().map(row => JSON.parse(row.value)) : []; }
async function inventory(context, range, config, records = [], attachments = []) {
  const { dir, mst, identifiers = [mst] } = context;
  const source = readSource(dir, range);
  const coverage = {
    BUY: config.buyComplete && config.buyEvidence === hash(source.invoices.filter(row => row.direction === 'BUY')),
    SELL: config.sellComplete && config.sellEvidence === hash(source.invoices.filter(row => row.direction === 'SELL')),
  };
  const files = new Map(), declarations = [], issues = [], unsafeFiles = new Set();
  let invoiceXmlCount = 0, invoicePdfCount = 0;
  const add = issueFactory(issues);
  const info = async name => { if (!files.has(name)) files.set(name, await fileInfo(dir, name)); return files.get(name); };
  const totals = { BUY: { count: 0, excluded: 0, pretax: 0, tax: 0, unknown: 0 }, SELL: { count: 0, excluded: 0, pretax: 0, tax: 0, unknown: 0 } };
  if (!source.available) add('source:missing', 'Chưa có kho hóa đơn', source.reason, {}, 'coverage', 'blocking', { view: 'data-list' });
  for (const row of source.invoices) {
    const key = row.invoice_key;
    const evidence = { invoice: key, number: row.so_hd, date: row.ngay_lap, amount: row.tong_tien, state: row.tthai };
    const target = { invoice: key, view: 'data-list' };
    const xml = await info(row.file_xml);
    if (xml.exists) invoiceXmlCount++;
    if (!xml.exists) add('invoice:xml:' + key, 'Thiếu XML hóa đơn ' + row.so_hd, xml.reason, evidence, 'documents', 'blocking', target);
    let raw = null;
    if (xml.exists) {
      try {
        if (xml.size > MAX_XML) throw new Error('XML vượt giới hạn 8 MB.');
        const text = await fsp.readFile(xml.path, 'utf8');
        readXml(text);
        raw = parseInvoiceXml(text).record;
        if (!raw.mstBan || !raw.soHd) throw new Error('Tệp không có cấu trúc hóa đơn được hỗ trợ.');
        const rawKey = buildInvoiceKey({ mstBan: raw.mstBan, khmshDon: raw.khmsHd, khhDon: raw.khhHd, shDon: raw.soHd });
        if (rawKey !== key || raw.ngayLap !== row.ngay_lap) throw new Error('Danh tính/ngày lập XML không khớp hóa đơn trong kho.');
        if (raw.tienTruocThue !== row.tien_truoc_thue || raw.tienThue !== row.tien_thue || raw.tongTien !== row.tong_tien) {
          add('invoice:amount-source:' + key, 'Số liệu XML cần kiểm tra lại', 'Số tiền trong XML thiếu hoặc khác số đã nhập; không tự sửa dữ liệu gốc.', { ...evidence, xml: xml.hash, rawPretax: raw.tienTruocThue, rawTax: raw.tienThue, rawTotal: raw.tongTien, storedPretax: row.tien_truoc_thue, storedTax: row.tien_thue }, 'tax', 'blocking', target);
        }
      } catch (error) { add('invoice:invalid:' + key, 'XML không đọc được hoặc không khớp', error.message, { ...evidence, xml: xml.hash }, 'documents', 'blocking', target); raw = null; }
    }
    const pdf = row.original_pdf ? await info(row.original_pdf) : { exists: false, reason: 'Chưa lưu PDF gốc.' };
    if (pdf.exists) invoicePdfCount++;
    if (config.requirePdf && !pdf.exists) add('invoice:pdf:' + key, 'Thiếu PDF gốc hóa đơn ' + row.so_hd, pdf.reason, evidence, 'documents', 'warning', target);
    const side = totals[row.direction];
    if (!side) { add('invoice:direction:' + key, 'Chưa xác định chiều hóa đơn', 'Kiểm tra mã định danh của hồ sơ.', evidence, 'coverage', 'blocking', target); continue; }
    if (!row.included) {
      side.excluded++;
      add('invoice:excluded:' + key, 'Hóa đơn hủy/thay thế/điều chỉnh cần kiểm tra', 'Hóa đơn này bị loại khỏi số đối chiếu theo quy tắc hiện có. Kiểm tra chứng từ liên quan trước khi chốt.', evidence, 'documents', 'warning', target);
      continue;
    }
    side.count++;
    side.pretax += Number(row.tien_truoc_thue || 0); side.tax += Number(row.tien_thue || 0);
    if (!raw || raw.tienTruocThue == null || raw.tienThue == null || raw.tienTruocThue !== row.tien_truoc_thue || raw.tienThue !== row.tien_thue) side.unknown++;
    if (row.payment_method === 'TRANSFER') {
      if (!row.reconciliation_status) add('invoice:bank-unchecked:' + key, 'Chưa đối chiếu thanh toán', 'Chưa có kết quả đối chiếu đã lưu. Chạy đối chiếu ở tab Sao kê ngân hàng.', evidence, 'bank', 'warning', { ...target, view: 'bank' });
      else if (row.reconciliation_status !== 'TRANSFER_BANK_FOUND' || /AMOUNT_MISMATCH|PARTNER_MISMATCH|DATE_MISMATCH|NEEDS_REVIEW/.test(row.reconciliation_issues || '')) add('invoice:bank-review:' + key, 'Thanh toán cần kiểm tra', 'Kết quả đối chiếu hiện có chỉ là gợi ý, không tự xác nhận đã thanh toán.', { ...evidence, status: row.reconciliation_status, issues: row.reconciliation_issues }, 'bank', 'warning', { ...target, view: 'bank' });
    } else if (['UNKNOWN', 'CASH_TRANSFER'].includes(row.payment_method)) add('invoice:payment:' + key, 'Chưa rõ phương thức thanh toán', 'Xem chứng từ và ghi nhận kết luận, không tự suy ra từ sao kê.', { ...evidence, method: row.payment_method_raw }, 'bank', 'warning', target);
  }
  for (const side of ['BUY', 'SELL']) if (!coverage[side]) add('coverage:' + side, 'Chưa xác nhận đủ hóa đơn ' + (side === 'BUY' ? 'mua vào' : 'bán ra'), 'Số liệu đang có không chứng minh đã tải đủ hóa đơn cả kỳ, kể cả trường hợp không phát sinh. Khi kho thay đổi, cần xác nhận lại phạm vi.', { count: totals[side].count }, 'coverage', 'blocking', { view: 'download' });
  if (config.requireBank && !source.banks.length) add('bank:missing', 'Chưa có sao kê trong kỳ', 'Chưa đủ chứng từ ngân hàng theo phạm vi kiểm tra đã chọn.', {}, 'coverage', 'blocking', { view: 'bank' });
  for (const row of source.banks) if (!row.reconciliation_status || row.reconciliation_status === 'BANK_NO_INVOICE' || /MISMATCH|NEEDS_REVIEW/.test(row.reconciliation_issues || '')) add('bank:' + row.row_hash, 'Giao dịch ngân hàng cần phân loại', row.description || 'Chưa có kết quả đối chiếu; có thể là giao dịch không liên quan hóa đơn.', { date: row.tran_date, amount: row.amount, description: row.description, status: row.reconciliation_status, issues: row.reconciliation_issues }, 'bank', 'warning', { view: 'bank' });

  const parse = (text, file, entry = '') => {
    try {
      const parsed = parseDeclaration(text);
      if (!parsed) return;
      if (!identifiers.includes(parsed.mst)) { unsafeFiles.add(file.path); add('declaration:scope:' + hash(file.relative + entry), 'Tờ khai thuộc mã định danh khác', 'Không dùng hoặc đóng gói tệp này trong hồ sơ hiện tại, kể cả ZIP chứa nhiều MST.', { path: file.relative, mst: parsed.mst, hash: file.hash }, 'declarations', 'warning', { file: file.path }); return; }
      const record = records.find(record => (record.paths || []).includes(file.path));
      declarations.push({ ...parsed, id: hash(file.relative + '!' + entry + ':' + hash(text)), file: file.path, relative: file.relative, entry, hash: hash(text), portal: record?.portal || '', dossier: record?.maHoSo || '', portalStatus: record?.row?.trangThai || '', companions: record?.paths || [] });
    } catch (error) { add('declaration:invalid:' + hash(file.relative + entry), 'Tệp tờ khai chưa đọc được', error.message, { path: file.relative, entry, hash: file.hash }, 'declarations', 'warning', { file: file.path }); }
  };
  for (const file of await declarationFiles(dir)) {
    const meta = await info(file);
    if (!meta.exists) continue;
    if (/\.xml$/i.test(file)) {
      if (meta.size > MAX_XML) add('declaration:large:' + hash(meta.relative), 'XML tờ khai quá lớn', 'Giới hạn đọc 8 MB; giữ nguyên tệp.', { path: meta.relative }, 'declarations', 'warning', { file });
      else parse(await fsp.readFile(file, 'utf8'), meta);
    } else if (/\.zip$/i.test(file)) {
      try {
        if (meta.size > 32 * 1024 * 1024) throw new Error('ZIP vượt giới hạn đọc 32 MB.');
        const zip = await JSZip.loadAsync(await fsp.readFile(file));
        const xmls = Object.values(zip.files).filter(entry => !entry.dir && /\.xml$/i.test(entry.name));
        if (xmls.length > 100 || xmls.some(entry => entry._data.uncompressedSize > MAX_XML) || xmls.reduce((total, entry) => total + entry._data.uncompressedSize, 0) > 32 * 1024 * 1024) throw new Error('XML trong ZIP vượt giới hạn đọc.');
        for (const entry of xmls) parse(await entry.async('string'), meta, entry.name);
      } catch (error) { add('declaration:zip:' + hash(meta.relative), 'ZIP tờ khai chưa đọc được', error.message, { path: meta.relative, hash: meta.hash }, 'declarations', 'warning', { file }); }
    }
  }
  const candidates = declarations.filter(doc => doc.range.from === range.from && doc.range.to === range.to && /\b01\s*\/\s*GTGT\b/i.test(doc.name));
  const selected = config.selectedDeclaration ? candidates.find(doc => doc.id === config.selectedDeclaration) : candidates.length === 1 ? candidates[0] : null;
  const comparisons = [];
  if (config.requireVat) {
    if (!selected) add('vat:selection', candidates.length ? 'Chọn phiên bản tờ khai cần đối chiếu' : 'Chưa có XML 01/GTGT đúng kỳ', candidates.length ? 'Có nhiều phiên bản hoặc lựa chọn cũ đã thay đổi; không tự chọn tờ khai bổ sung mới nhất.' : 'Chọn một tháng/quý đầy đủ và tải tờ khai. Kỳ kê khai khác ngày nộp; không suy ra kỳ từ tên tệp.', { candidates: candidates.map(doc => doc.id) }, 'declarations', 'blocking', { view: 'tokhai' });
    else {
      const accepted = !/không\s+chấp nhận|từ chối/i.test(selected.portalStatus) && /chấp nhận/i.test(selected.portalStatus);
      if (!accepted && !(config.acceptedDeclaration === selected.id && config.acceptanceNote.trim())) add('vat:acceptance', 'Chưa xác nhận tờ khai được chấp nhận', 'Đã nhận/đã gửi không đồng nghĩa được chấp nhận. Mở hồ sơ và ghi nguồn thông báo đã kiểm tra.', { document: selected.id, portalStatus: selected.portalStatus }, 'declarations', 'blocking', { file: selected.file });
      if (!selected.supported) add('vat:unsupported', 'Chưa hỗ trợ cấu trúc XML tờ khai này', selected.reason || 'Chỉ đọc chỉ tiêu 23/24/34/35 trong CTieuTKhaiChinh của 01/GTGT.', { document: selected.id, version: selected.version }, 'tax', 'blocking', { file: selected.file });
      else {
        const mapping = [['ct23', 'Giá trị mua vào', 'BUY', 'pretax'], ['ct24', 'Thuế GTGT mua vào', 'BUY', 'tax'], ['ct34', 'Doanh thu bán ra', 'SELL', 'pretax'], ['ct35', 'Thuế GTGT bán ra', 'SELL', 'tax']];
        for (const [code, label, direction, metric] of mapping) {
          const side = totals[direction];
          const ready = source.available && coverage[direction] && !side.unknown;
          const adjustment = Number(config.adjustments[code] || 0);
          const value = side[metric] + adjustment;
          const diff = ready ? Math.round((selected.figures[code] - value) * 100) / 100 : null;
          comparisons.push({ code, label, direction, declared: selected.figures[code], invoices: side[metric], adjustment, compared: value, difference: diff, status: !ready ? 'insufficient' : Math.abs(diff) <= 1 ? 'matched' : 'difference', document: selected.id, count: side.count, excluded: side.excluded });
          if (!ready) add('vat:insufficient:' + code, 'Chưa đủ dữ liệu đối chiếu [' + code.slice(2) + ']', 'Cần xác nhận đủ kỳ và xử lý XML thiếu/khác số liệu. Không coi dữ liệu thiếu là 0.', { document: selected.id, totals: side }, 'tax', 'blocking', { view: 'data-list' });
          else if (Math.abs(diff) > 1) add('vat:difference:' + code, 'Chênh lệch ' + label, 'Chênh lệch cần giải trình; không tự kết luận kê khai sai hoặc xác định thuế được khấu trừ.', { document: selected.id, declared: selected.figures[code], invoices: side[metric], adjustment, difference: diff, invoiceKeys: source.invoices.filter(row => row.direction === direction && row.included).map(row => row.invoice_key) }, 'tax', 'warning', { file: selected.file, view: 'data-list', direction });
        }
      }
    }
  }
  const related = declarations.filter(doc => doc.range.from >= range.from && doc.range.to <= range.to);
  const packageFiles = new Set();
  for (const row of source.invoices) for (const name of [row.file_xml, row.original_pdf].filter(Boolean)) { const file = await info(name); if (file.exists) packageFiles.add(file.path); }
  for (const doc of related) {
    if (!unsafeFiles.has(doc.file)) packageFiles.add(doc.file);
    for (const companion of doc.companions) { const file = await info(companion); if (file.exists && !unsafeFiles.has(file.path)) packageFiles.add(file.path); }
  }
  const bankOriginals = [];
  for (const attachment of attachments) {
    const file = await info(attachment.path);
    if (file.exists && file.hash === attachment.sha256) { packageFiles.add(file.path); bankOriginals.push({ ...attachment, relative: file.relative }); }
    else add('bank:original:' + attachment.sha256, 'Sao kê gốc đã bổ sung bị thiếu/thay đổi', file.exists ? 'Tệp không còn khớp bản gốc đã bổ sung.' : file.reason, { file: attachment.fileName, sha256: attachment.sha256 }, 'documents', 'blocking');
  }
  return {
    mst, range, config, coverage, totals, declarations: candidates, selectedDeclaration: selected || null, comparisons, issues,
    sourceAvailable: source.available, bankCount: source.banks.length, invoiceCount: source.invoices.length,
    counts: { invoiceXml: invoiceXmlCount, invoicePdf: invoicePdfCount, declarations: related.length },
    bankOriginals,
    documents: [...files.values()], packageFiles: [...packageFiles].sort(),
    fingerprint: hash({ source, files: [...files.values()], declarations, records, attachments, config, range }),
    bankRows: source.banks, bankFiles: source.bankFiles.filter(file => source.banks.some(row => row.file_id === file.id)),
    notice: 'Đối chiếu số liệu tham khảo. Không tự xác định điều kiện khấu trừ, nghĩa vụ thuế hoặc tình trạng thanh toán. Gói xuất có dữ liệu ngân hàng đã nhập; chỉ có sao kê gốc nếu đã bổ sung tệp vào hồ sơ này.',
  };
}

function validatedSettings(input) {
  const config = { ...store.DEFAULTS };
  for (const key of ['buyComplete', 'sellComplete', 'requirePdf', 'requireBank', 'requireVat']) config[key] = input[key] === true;
  for (const key of ['selectedDeclaration', 'acceptedDeclaration']) config[key] = String(input[key] || '').slice(0, 64);
  for (const key of ['actor', 'acceptanceNote', 'adjustmentNote']) config[key] = String(input[key] || '').trim().slice(0, key === 'actor' ? 120 : 2000);
  config.adjustments = {};
  for (const code of ['ct23', 'ct24', 'ct34', 'ct35']) {
    const value = Number(input.adjustments?.[code] ?? 0);
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) throw new Error('Khoản điều chỉnh không hợp lệ.');
    config.adjustments[code] = value;
  }
  if (Object.values(config.adjustments).some(value => value !== 0) && !config.adjustmentNote) throw new Error('Nhập lý do và nguồn chứng từ cho khoản điều chỉnh.');
  if (config.acceptedDeclaration && (!config.acceptanceNote || !config.actor)) throw new Error('Ghi người kiểm tra và nguồn thông báo chấp nhận.');
  return config;
}
function currentSnapshot(db, key) {
  const snapshot = store.readRun(db, key);
  if (!snapshot) throw new Error('Chạy kiểm tra hồ sơ trước.');
  return snapshot;
}
function csv(rows, keys) {
  const cell = value => {
    const text = String(value ?? '').replace(/"/g, '""');
    return '"' + (typeof value === 'number' ? text : text.replace(/^[=+@-]/, "'$&")) + '"';
  };
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
}
async function withStore(context, create, fn) { const db = store.open(context.dir, create); try { return await fn(db); } finally { db?.close(); } }
function originals(db, key) { return db ? db.prepare('SELECT value FROM attachments WHERE period=? ORDER BY id').all(key).map(row => JSON.parse(row.value)) : []; }
async function inspect(context, range, config, db) { return inventory(context, range, config, downloads(db), originals(db, range.key)); }
async function snapshot(context, input) {
  const range = rangeOf(input);
  return withStore(context, false, async db => {
    const config = store.settings(db, range.key), value = store.readRun(db, range.key);
    if (!value) return { mst: context.mst, range, config, checked: false, issues: [], history: [] };
    const live = await inspect(context, range, config, db);
    const stale = live.fingerprint !== value.fingerprint;
    if (stale && value.lastClosed) value.lastClosed.current = false;
    return { ...value, config, checked: true, stale };
  });
}
async function check(context, input) {
  const range = rangeOf(input);
  return withStore(context, true, async db => {
    const config = store.settings(db, range.key);
    const value = { ...await inspect(context, range, config, db), checkedAt: new Date().toISOString() };
    store.saveRun(db, range.key, value, config.actor);
    return { ...store.readRun(db, range.key), checked: true, stale: false };
  });
}
async function configure(context, input) {
  const range = rangeOf(input), config = validatedSettings(input.config || {});
  const source = readSource(context.dir, range);
  config.buyEvidence = hash(source.invoices.filter(row => row.direction === 'BUY'));
  config.sellEvidence = hash(source.invoices.filter(row => row.direction === 'SELL'));
  return withStore(context, true, async db => {
    store.transaction(db, () => { db.prepare('INSERT OR REPLACE INTO settings(period,value) VALUES(?,?)').run(range.key, JSON.stringify(config)); store.event(db, range.key, '', 'settings', config.actor, config); });
    return { config };
  });
}
async function updateIssue(context, input) {
  const range = rangeOf(input);
  if (!['todo', 'inprogress', 'done', 'ignored'].includes(input.state)) throw new Error('Trạng thái xử lý không hợp lệ.');
  const note = String(input.note || '').trim().slice(0, 2000), actor = String(input.actor || '').trim().slice(0, 120), assignee = String(input.assignee || '').trim().slice(0, 120);
  if (!actor) throw new Error('Ghi người xử lý.');
  if (['done', 'ignored'].includes(input.state) && !note) throw new Error('Ghi kết luận/lý do trước khi đánh dấu đã xử lý hoặc không áp dụng.');
  return withStore(context, true, async db => {
    const value = currentSnapshot(db, range.key), config = store.settings(db, range.key);
    const live = await inspect(context, range, config, db);
    if (live.fingerprint !== value.fingerprint) throw new Error('Dữ liệu đã thay đổi. Chạy kiểm tra lại trước khi cập nhật kết luận.');
    const old = db.prepare('SELECT * FROM issues WHERE period=? AND id=? AND active=1').get(range.key, String(input.id));
    if (!old) throw new Error('Vấn đề không thuộc kỳ đang kiểm tra.');
    if (input.fingerprint !== old.fingerprint) throw new Error('Chứng cứ đã thay đổi; mở lại vấn đề.');
    const payload = JSON.parse(old.payload);
    if (payload.severity === 'blocking' && ['done', 'ignored'].includes(input.state)) throw new Error('Mục thiếu dữ liệu phải được bổ sung hoặc điều chỉnh phạm vi, không thể bỏ qua bằng ghi chú.');
    store.transaction(db, () => {
      db.prepare('UPDATE issues SET state=?,note=?,assignee=?,updated_at=? WHERE period=? AND id=?').run(input.state, note, assignee, new Date().toISOString(), range.key, input.id);
      store.event(db, range.key, input.id, 'review', actor, { before: old.state, state: input.state, note, assignee });
    });
    return { ...store.readRun(db, range.key), checked: true, stale: false };
  });
}
async function closePeriod(context, input) {
  const range = rangeOf(input), actor = String(input.actor || '').trim().slice(0, 120);
  if (!actor) throw new Error('Ghi người chốt hồ sơ.');
  return withStore(context, true, async db => {
    const value = currentSnapshot(db, range.key), config = store.settings(db, range.key);
    const live = await inspect(context, range, config, db);
    if (live.fingerprint !== value.fingerprint) throw new Error('Dữ liệu đã thay đổi. Kiểm tra lại trước khi chốt kỳ.');
    if (value.issues.some(issue => !['done', 'ignored'].includes(issue.state))) throw new Error('Còn việc chưa xử lý; không thể chốt kỳ.');
    if (!live.sourceAvailable || !live.coverage.BUY || !live.coverage.SELL) throw new Error('Chưa xác nhận đủ dữ liệu cả kỳ.');
    store.transaction(db, () => {
      db.prepare('INSERT INTO closures(period,snapshot,actor,created_at) VALUES(?,?,?,?)').run(range.key, JSON.stringify(value), actor, new Date().toISOString());
      store.event(db, range.key, '', 'closed', actor, { fingerprint: value.fingerprint });
    });
    return { ...store.readRun(db, range.key), checked: true, stale: false };
  });
}
async function registerDownload(context, job) {
  if (!job || job.running || !['complete', 'stopped'].includes(job.progress?.stage) || !Array.isArray(job.progress.files)) throw new Error('Chưa có lượt tải tờ khai hoàn tất để ghi nhận.');
  return withStore(context, true, async db => {
    const records = [];
    for (const file of job.progress.files.filter(file => file.success)) {
      const row = job.results.find(row => row.maHoSo === file.maHoSo);
      if (!row) throw new Error('Hồ sơ tải không khớp kết quả tra cứu.');
      const paths = [];
      for (const target of file.paths || [file.path]) { const info = await fileInfo(context.dir, target); if (info.exists) paths.push(info.path); }
      if (paths.length) records.push({ portal: job.portal, maHoSo: file.maHoSo, row, paths, warnings: file.warnings || [], downloadedAt: new Date().toISOString() });
    }
    store.transaction(db, () => { for (const record of records) db.prepare('INSERT OR REPLACE INTO downloads(id,value) VALUES(?,?)').run(record.portal + ':' + record.maHoSo, JSON.stringify(record)); });
    return { registered: records.length, failed: Number(job.progress.failed || 0), warnings: job.progress.files.flatMap(file => file.warnings || []) };
  });
}
async function exportPackage(context, input) {
  const range = rangeOf(input);
  return withStore(context, true, async db => {
    const value = currentSnapshot(db, range.key), config = store.settings(db, range.key);
    const live = await inspect(context, range, config, db);
    if (live.fingerprint !== value.fingerprint) throw new Error('Dữ liệu đã thay đổi. Chạy kiểm tra lại trước khi xuất hồ sơ.');
    const zip = new JSZip(), manifest = [];
    let size = 0;
    for (const file of live.packageFiles) {
      const meta = await fileInfo(context.dir, file);
      const expected = live.documents.find(doc => doc.path === file);
      if (!meta.exists || !expected || meta.hash !== expected.hash) throw new Error('Chứng từ thay đổi trong lúc đóng gói; chạy lại kiểm tra.');
      size += meta.size;
      if (size > MAX_PACKAGE) throw new Error('Hồ sơ vượt 250 MB; chọn kỳ nhỏ hơn để xuất.');
      const bytes = await fsp.readFile(meta.path);
      if (hash(bytes) !== meta.hash) throw new Error('Chứng từ thay đổi trong lúc đọc.');
      zip.file('Chung_tu/' + meta.relative, bytes);
      manifest.push({ path: 'Chung_tu/' + meta.relative, size: bytes.length, sha256: meta.hash });
    }
    const unresolved = value.issues.filter(issue => !['done', 'ignored'].includes(issue.state));
    zip.file('Danh_sach_can_xu_ly.csv', csv(value.issues.map(issue => ({ ...issue, evidence: JSON.stringify(issue.evidence) })), ['title', 'reason', 'state', 'assignee', 'note', 'evidence']));
    zip.file('Doi_chieu_to_khai.csv', csv(live.comparisons, ['code', 'label', 'declared', 'invoices', 'adjustment', 'compared', 'difference', 'status']));
    zip.file('Sao_ke_da_nhap.csv', csv(live.bankRows, ['tran_date', 'file_name', 'reference', 'description', 'credit', 'debit', 'amount', 'reconciliation_status']));
    zip.file('Lich_su_xu_ly.json', JSON.stringify(db.prepare('SELECT * FROM history WHERE period=? ORDER BY id').all(range.key), null, 2));
    zip.file('Ho_so_kiem_tra.json', JSON.stringify({ ...value, status: unresolved.length ? 'incomplete' : 'reviewed', unresolved: unresolved.length }, null, 2));
    zip.file('manifest.json', JSON.stringify({ mst: context.mst, range, checkedAt: value.checkedAt, exportedAt: new Date().toISOString(), fingerprint: value.fingerprint, unresolved: unresolved.length, files: manifest, bankOriginalsIncluded: live.bankOriginals.length > 0, bankOriginals: live.bankOriginals }, null, 2));
    zip.file('DOC_TOI.txt', `Hồ sơ MST ${context.mst}, ${range.from} → ${range.to}\n${unresolved.length ? 'CHƯA HOÀN TẤT: còn ' + unresolved.length + ' vấn đề.' : 'Đã xử lý các mục kiểm tra theo phạm vi đã chọn.'}\n${live.notice}\nGói này không tự gửi cho cơ quan thuế hoặc bên thứ ba.\n`);
    const dir = path.join(context.dir, 'Kiem_tra', 'Xuat_ho_so');
    await fsp.mkdir(dir, { recursive: true });
    if (!inside(await fsp.realpath(context.dir), await fsp.realpath(dir))) throw new Error('Thư mục xuất liên kết ra ngoài hồ sơ MST.');
    const file = path.join(dir, `Ho_so_${range.key}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.zip`);
    await fsp.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } }), { flag: 'wx' });
    store.event(db, range.key, '', 'exported', config.actor, { file: path.basename(file), unresolved: unresolved.length });
    return { path: file, files: manifest.length, unresolved: unresolved.length };
  });
}
async function attachBank(context, input) {
  const range = rangeOf(input);
  const name = path.basename(String(input.fileName || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180);
  if (!/\.(xlsx?|csv|pdf)$/i.test(name)) throw new Error('Chỉ bổ sung sao kê Excel, CSV hoặc PDF.');
  const actor = String(input.actor || '').trim().slice(0, 120), note = String(input.note || '').trim().slice(0, 2000);
  if (!actor || !note) throw new Error('Ghi người bổ sung và tài khoản/kỳ sao kê đã kiểm tra.');
  const encoded = String(input.dataBase64 || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 19 * 1024 * 1024) throw new Error('Dữ liệu sao kê không hợp lệ hoặc quá lớn.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > 13 * 1024 * 1024) throw new Error('Giới hạn tệp sao kê bổ sung là 13 MB.');
  if (/^\s*</.test(bytes.toString('utf8', 0, 100))) throw new Error('Tệp HTML/XML không phải sao kê được hỗ trợ.');
  if (/\.pdf$/i.test(name) && bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Tệp không có định dạng PDF.');
  const sha256 = hash(bytes), sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
  return withStore(context, true, async db => {
    const source = readSource(context.dir, range);
    const match = source.bankFiles.find(file => file.file_hash === sha1);
    const folder = path.join(context.dir, 'Kiem_tra', 'Sao_ke_goc', range.key);
    await fsp.mkdir(folder, { recursive: true });
    if (!inside(await fsp.realpath(context.dir), await fsp.realpath(folder))) throw new Error('Thư mục sao kê liên kết ra ngoài hồ sơ MST.');
    const target = path.join(folder, sha256.slice(0, 16) + '_' + name);
    if (!fs.existsSync(target)) await fsp.writeFile(target, bytes, { flag: 'wx' });
    const verified = await fileInfo(context.dir, target);
    if (!verified.exists || verified.hash !== sha256) throw new Error('Tệp lưu không khớp nội dung bổ sung.');
    const attachment = { path: target, fileName: name, sha256, actor, note, importedFileId: match?.id || null, verifiedImport: !!match, addedAt: new Date().toISOString() };
    store.transaction(db, () => {
      db.prepare('INSERT OR REPLACE INTO attachments(id,period,value) VALUES(?,?,?)').run(range.key + ':' + sha256, range.key, JSON.stringify(attachment));
      store.event(db, range.key, '', 'bank_original_added', actor, { fileName: name, sha256, note, verifiedImport: !!match });
    });
    return { ...attachment, message: match ? 'Đã lưu sao kê gốc, khớp checksum tệp ngân hàng đã nhập.' : 'Đã lưu tệp do bạn xác nhận. Chưa xác minh khớp dữ liệu ngân hàng đã nhập.' };
  });
}
async function handle(req, res, url, deps) {
  const context = deps.context(req);
  const action = url.pathname.slice('/api/review/'.length);
  const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await (action === 'attach-bank' && deps.readBankBody ? deps.readBankBody(req) : deps.readBody(req));
  const collection = require('./collect');
  if (req.method === 'GET' && action === 'progress') return deps.reply(res, 200, { ok: true, value: { ...collection.jobFor(context.mst).progress, running: collection.jobFor(context.mst).running } });
  if (req.method === 'POST' && action === 'stop') return deps.reply(res, 200, { ok: true, value: collection.stop(context.mst) });
  if (collection.jobFor(context.mst).running) throw new Error('Đang tải và kiểm tra hồ sơ. Đợi hoàn tất hoặc bấm Ngưng.');
  const key = context.dir;
  const mutating = req.method === 'POST';
  if (locks.has(key)) throw new Error('MST đang kiểm tra/đóng gói hồ sơ. Đợi hoàn tất.');
  locks.add(key);
  try {
    let value;
    if (mutating && action === 'collect') {
      rangeOf(input);
      value = collection.start(context, input, { ...deps.collection(context), downloadJob: deps.downloadJob, check, register: registerDownload });
    }
    else if (req.method === 'GET' && action === 'snapshot') value = await snapshot(context, input);
    else if (mutating && action === 'check') value = await check(context, input);
    else if (mutating && action === 'settings') value = await configure(context, input);
    else if (mutating && action === 'issue') value = await updateIssue(context, input);
    else if (mutating && action === 'close') value = await closePeriod(context, input);
    else if (mutating && action === 'export') value = await exportPackage(context, input);
    else if (mutating && action === 'attach-bank') value = await attachBank(context, input);
    else if (mutating && action === 'register-download') value = await registerDownload(context, deps.downloadJob(context.mst));
    else return deps.reply(res, 404, { ok: false, error: 'Không tìm thấy chức năng kiểm tra hồ sơ.' });
    return deps.reply(res, 200, { ok: true, value });
  } finally { locks.delete(key); }
}
module.exports = { handle, rangeOf, inside, inventory, snapshot, check, configure, updateIssue, closePeriod, exportPackage, registerDownload, attachBank, fileInfo, validatedSettings };
