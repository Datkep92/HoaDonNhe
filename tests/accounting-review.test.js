'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const JSZip = require('jszip');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');
const { buildImportRecord } = require('../src/data/xml-parser');
const service = require('../src/accounting-review/service');
const store = require('../src/accounting-review/store');
const { parseDeclaration, readXml } = require('../src/accounting-review/xml');
const MST = '0315058003', OTHER = '0402335623';
const RANGE = { from: '2026-07-01', to: '2026-09-30' };
const invoiceXml = ({ sell = false, number = '1', amount = 100, tax = 10, missingTax = false } = {}) => `<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>${number}</SHDon><NLap>2026-08-01</NLap><HTTToan>Tiền mặt</HTTToan></TTChung><NDHDon><NBan><MST>${sell ? MST : OTHER}</MST><Ten>Người bán</Ten></NBan><NMua><MST>${sell ? OTHER : MST}</MST><Ten>Người mua</Ten></NMua><TToan><TgTCThue>${amount}</TgTCThue>${missingTax ? '' : '<TgTThue>' + tax + '</TgTThue>'}<TgTTTBSo>${amount + tax}</TgTTTBSo></TToan></NDHDon></DLHDon></HDon>`;
const declarationXml = ({ mst = MST, amendment = 0, buy = 100, buyTax = 10, sell = 200, sellTax = 20, namespace = false, omitted = '' } = {}) => {
  const xml = `<HSoThueDTu><HSoKhaiThue><TTinChung><TTinTKhaiThue><TKhaiThue><maTKhai>842</maTKhai><tenTKhai>Tờ khai thuế GTGT 01/GTGT (TT80/2021)</tenTKhai><pbanTKhaiXML>2.8</pbanTKhaiXML><loaiTKhai>${amendment ? 'B' : 'C'}</loaiTKhai><soLan>${amendment}</soLan><KyKKhaiThue><kieuKy>Q</kieuKy><kyKKhai>3/2026</kyKKhai></KyKKhaiThue><ngayLapTKhai>15/10/2026</ngayLapTKhai></TKhaiThue><NNT><mst>${mst}</mst></NNT></TTinTKhaiThue></TTinChung><CTieuTKhaiChinh>${[['ct23', buy], ['ct24', buyTax], ['ct34', sell], ['ct35', sellTax]].filter(([key]) => key !== omitted).map(([key, value]) => `<${key}>${value}</${key}>`).join('')}</CTieuTKhaiChinh></HSoKhaiThue></HSoThueDTu>`;
  return namespace ? xml.replace(/<(\/?)([\w]+)/g, '<$1t:$2') : xml;
};
async function fixture(fn, withSource = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounting-review-'));
  const dir = path.join(root, 'MST-' + MST);
  fs.mkdirSync(dir, { recursive: true });
  let db;
  if (withSource) { db = openDatabase(path.join(dir, 'data.db')); closeDatabase(db); }
  function addInvoice(options = {}) {
    const xml = invoiceXml(options);
    const file = path.join(dir, options.sell ? 'Ban_ra' : 'Mua_vao', (options.number || '1') + '.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, xml);
    const source = openDatabase(path.join(dir, 'data.db'));
    try { insertInvoice(source, buildImportRecord(xml, { currentMst: MST, fileXml: file }).record); } finally { closeDatabase(source); }
    return file;
  }
  function addDeclaration(name = 'tk.xml', options = {}) {
    const file = path.join(dir, 'To_khai', '123456', name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, declarationXml(options)); return file;
  }
  const context = { dir, mst: MST, identifiers: [MST] };
  try { await fn({ root, dir, context, addInvoice, addDeclaration }); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^accounting-review-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const completeConfig = over => ({ ...store.DEFAULTS, buyComplete: true, sellComplete: true, actor: 'Kế toán', ...over });

test('strict declaration XML handles namespaces, keeps missing amounts null and rejects malformed/ambiguous XML', () => {
  const parsed = parseDeclaration(declarationXml({ namespace: true }));
  assert.equal(parsed.supported, true); assert.deepEqual(parsed.range.from, RANGE.from);
  assert.equal(parseDeclaration(declarationXml({ omitted: 'ct24' })).figures.ct24, null);
  assert.equal(parseDeclaration(declarationXml({ omitted: 'ct24' })).supported, false);
  assert.throws(() => readXml('<a><b></a>'), /khớp/);
  assert.throws(() => readXml('<!DOCTYPE a><a/>'), /DTD/);
  assert.throws(() => parseDeclaration(declarationXml().replace('<mst>', '<mst>x</mst><mst>')), /trùng/);
  assert.equal(parseDeclaration('<ThongBao><TrangThai>Đã nhận</TrangThai></ThongBao>'), null);
  assert.throws(() => service.rangeOf({ from: '2026-02-31', to: '2026-03-31' }), /hợp lệ/);
});
test('unchecked/missing source is distinct from zero issues; blockers cannot be dismissed or closed', async () => fixture(async ({ dir, context }) => {
  const initial = await service.snapshot(context, RANGE);
  assert.equal(initial.checked, false); assert.equal(fs.existsSync(path.join(dir, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(dir, 'Kiem_tra')), false);
  const checked = await service.check(context, RANGE);
  assert.equal(checked.sourceAvailable, false);
  const missing = checked.issues.find(issue => issue.id === 'source:missing');
  await assert.rejects(service.updateIssue(context, { ...RANGE, id: missing.id, fingerprint: missing.fingerprint, state: 'ignored', actor: 'KT', note: 'Bỏ qua' }), /không thể bỏ qua/);
  await assert.rejects(service.closePeriod(context, { ...RANGE, actor: 'KT' }), /chưa xử lý/);
}, false));
test('correct VAT comparison uses raw XML and matching period; main DB bytes remain unchanged', async () => fixture(async ({ dir, context, addInvoice, addDeclaration }) => {
  addInvoice(); addInvoice({ sell: true, amount: 200, tax: 20 }); addDeclaration();
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'data.db'))).digest('hex');
  await service.configure(context, { ...RANGE, config: completeConfig() });
  let checked = await service.check(context, RANGE);
  assert.equal(checked.comparisons.length, 4); assert.ok(checked.comparisons.every(row => row.status === 'matched'));
  assert.ok(checked.issues.some(issue => issue.id === 'vat:acceptance'));
  await service.configure(context, { ...RANGE, config: completeConfig({ selectedDeclaration: checked.selectedDeclaration.id, acceptedDeclaration: checked.selectedDeclaration.id, acceptanceNote: 'Thông báo 01, đã kiểm tra tệp đính kèm' }) });
  checked = await service.check(context, RANGE);
  assert.equal(checked.issues.length, 0);
  const closed = await service.closePeriod(context, { ...RANGE, actor: 'KT' }); assert.ok(closed.lastClosed);
  const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'data.db'))).digest('hex');
  assert.equal(after, before);
}));
test('multiple declarations require explicit selection, foreign taxpayer is excluded, absent VAT cannot become zero', async () => fixture(async ({ context, addInvoice, addDeclaration }) => {
  addInvoice({ missingTax: true }); addInvoice({ sell: true, amount: 200, tax: 20 });
  addDeclaration(); addDeclaration('bs.xml', { amendment: 1 }); addDeclaration('other.xml', { mst: OTHER });
  await service.configure(context, { ...RANGE, config: completeConfig() });
  let checked = await service.check(context, RANGE);
  assert.equal(checked.declarations.length, 2); assert.equal(checked.selectedDeclaration, null);
  assert.ok(checked.issues.some(issue => issue.id === 'vat:selection'));
  assert.ok(checked.issues.some(issue => issue.id.startsWith('declaration:scope:')));
  await service.configure(context, { ...RANGE, config: completeConfig({ selectedDeclaration: checked.declarations[0].id }) });
  checked = await service.check(context, RANGE);
  assert.equal(checked.comparisons.find(row => row.code === 'ct24').status, 'insufficient');
}));
test('review notes survive reruns and changed evidence reopens the same issue', async () => fixture(async ({ context, addInvoice, addDeclaration }) => {
  addInvoice(); addInvoice({ sell: true, amount: 200, tax: 20 }); const file = addDeclaration('tk.xml', { sell: 250 });
  await service.configure(context, { ...RANGE, config: completeConfig() });
  let checked = await service.check(context, RANGE);
  const issue = checked.issues.find(issue => issue.id === 'vat:difference:ct34');
  assert.ok(issue);
  await service.updateIssue(context, { ...RANGE, id: issue.id, fingerprint: issue.fingerprint, state: 'done', actor: 'KT', assignee: 'Lan', note: 'Đã kiểm tra chênh lệch theo chứng từ A' });
  checked = await service.check(context, RANGE);
  assert.equal(checked.issues.find(row => row.id === issue.id).state, 'done');
  fs.writeFileSync(file, declarationXml({ sell: 260 }));
  assert.equal((await service.snapshot(context, RANGE)).stale, true);
  await assert.rejects(service.closePeriod(context, { ...RANGE, actor: 'KT' }), /thay đổi/);
  checked = await service.check(context, RANGE);
  const reopened = checked.issues.find(row => row.id === issue.id);
  assert.equal(reopened.state, 'todo'); assert.equal(reopened.note, 'Đã kiểm tra chênh lệch theo chứng từ A');
  assert.ok(checked.history.some(row => row.action === 'evidence_changed'));
}));
test('package contains original scoped documents, companions and honest manifest; blocked period exports as incomplete', async () => fixture(async ({ root, context, addInvoice, addDeclaration }) => {
  addInvoice(); addInvoice({ sell: true, amount: 200, tax: 20 }); const file = addDeclaration();
  const notice = path.join(path.dirname(file), 'tb.xml'); fs.writeFileSync(notice, '<ThongBao><TrangThai>Chấp nhận</TrangThai></ThongBao>');
  const outside = path.join(root, 'other-account.xml'); fs.writeFileSync(outside, 'DO NOT INCLUDE');
  await service.registerDownload(context, { running: false, portal: 'dvc', results: [{ maHoSo: '123456', trangThai: 'Đã nhận' }], progress: { stage: 'complete', files: [{ maHoSo: '123456', success: true, paths: [file, notice, outside] }] } });
  await service.configure(context, { ...RANGE, config: completeConfig() });
  const checked = await service.check(context, RANGE);
  assert.ok(checked.issues.some(issue => issue.id === 'vat:acceptance'));
  const exported = await service.exportPackage(context, RANGE);
  const zip = await JSZip.loadAsync(fs.readFileSync(exported.path));
  assert.equal(exported.files, 4); assert.equal(exported.unresolved, 1);
  assert.ok(zip.file('Chung_tu/To_khai/123456/tb.xml'));
  assert.equal(await zip.file('Chung_tu/To_khai/123456/tk.xml').async('string'), fs.readFileSync(file, 'utf8'));
  assert.ok(!Object.keys(zip.files).some(name => name.includes('other-account') || name.endsWith('.db')));
  assert.equal(JSON.parse(await zip.file('manifest.json').async('string')).bankOriginalsIncluded, false);
  assert.match(await zip.file('DOC_TOI.txt').async('string'), /CHƯA HOÀN TẤT/);
  assert.equal((await service.fileInfo(context.dir, outside)).exists, false);
}));
test('adjustments require explanation and affect comparison only, without modifying raw amounts', async () => fixture(async ({ context, addInvoice, addDeclaration }) => {
  addInvoice(); addInvoice({ sell: true, amount: 200, tax: 20 }); addDeclaration('tk.xml', { sell: 250 });
  const config = completeConfig({ adjustments: { ct23: 0, ct24: 0, ct34: 50, ct35: 0 } });
  await assert.rejects(service.configure(context, { ...RANGE, config }), /lý do/);
  await service.configure(context, { ...RANGE, config: { ...config, adjustmentNote: 'Điều chỉnh theo bảng kê A' } });
  const checked = await service.check(context, RANGE);
  const row = checked.comparisons.find(row => row.code === 'ct34');
  assert.equal(row.invoices, 200); assert.equal(row.adjustment, 50); assert.equal(row.status, 'matched');
}));
test('new invoices invalidate coverage confirmation and reopen the period; records are isolated by MST', async () => fixture(async ({ root, context, addInvoice }) => {
  addInvoice();
  await service.configure(context, { ...RANGE, config: completeConfig({ requireVat: false }) });
  let checked = await service.check(context, RANGE);
  assert.equal(checked.issues.length, 0);
  let closed = await service.closePeriod(context, { ...RANGE, actor: 'KT' });
  assert.equal(closed.lastClosed.current, true);
  addInvoice({ number: '2' });
  const stale = await service.snapshot(context, RANGE);
  assert.equal(stale.stale, true); assert.equal(stale.lastClosed.current, false);
  checked = await service.check(context, RANGE);
  assert.equal(checked.coverage.BUY, false); assert.equal(checked.coverage.SELL, true);
  assert.ok(checked.issues.some(issue => issue.id === 'coverage:BUY'));
  const other = { mst: OTHER, dir: path.join(root, 'MST-' + OTHER), identifiers: [OTHER] };
  const independent = await service.snapshot(other, RANGE);
  assert.equal(independent.checked, false); assert.equal(independent.config.actor, '');
  assert.equal(independent.lastClosed, undefined);
}));
test('ZIP containing another taxpayer is excluded from the exported documents', async () => fixture(async ({ context, addInvoice, addDeclaration }) => {
  addInvoice(); const file = addDeclaration(); fs.unlinkSync(file);
  const zipFile = file.replace(/\.xml$/, '.zip');
  const archive = new JSZip(); archive.file('own.xml', declarationXml()); archive.file('other.xml', declarationXml({ mst: OTHER }));
  fs.writeFileSync(zipFile, await archive.generateAsync({ type: 'nodebuffer' }));
  await service.configure(context, { ...RANGE, config: completeConfig() });
  const checked = await service.check(context, RANGE);
  assert.ok(checked.issues.some(issue => issue.id.startsWith('declaration:scope:')));
  const result = await service.exportPackage(context, RANGE);
  const zip = await JSZip.loadAsync(fs.readFileSync(result.path));
  assert.ok(!Object.keys(zip.files).some(name => name.endsWith('tk.zip')));
}));
test('bank originals are copied independently, linked by checksum and exported without importing more transactions', async () => fixture(async ({ dir, context, addInvoice }) => {
  addInvoice();
  const bytes = Buffer.from('Ngày,Nợ,Có\n2026-08-01,100,0\n');
  const source = openDatabase(path.join(dir, 'data.db'));
  source.prepare('INSERT INTO bank_files(file_name,file_hash) VALUES(?,?)').run('bank.csv', crypto.createHash('sha1').update(bytes).digest('hex'));
  closeDatabase(source);
  const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'data.db'))).digest('hex');
  await assert.rejects(service.attachBank(context, { ...RANGE, fileName: 'bank.csv', dataBase64: bytes.toString('base64') }), /Ghi người/);
  const added = await service.attachBank(context, { ...RANGE, actor: 'Lan', note: 'Ngân hàng A, tài khoản 001, quý 3', fileName: 'bank.csv', dataBase64: bytes.toString('base64') });
  assert.equal(added.verifiedImport, true); assert.deepEqual(fs.readFileSync(added.path), bytes);
  await service.configure(context, { ...RANGE, config: completeConfig({ requireVat: false }) });
  const checked = await service.check(context, RANGE);
  assert.equal(checked.bankCount, 0); assert.equal(checked.bankOriginals.length, 1);
  const exported = await service.exportPackage(context, RANGE);
  const zip = await JSZip.loadAsync(fs.readFileSync(exported.path));
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  assert.equal(manifest.bankOriginalsIncluded, true); assert.equal(manifest.bankOriginals[0].verifiedImport, true);
  assert.deepEqual(await zip.file(manifest.files.find(file => file.path.endsWith('_bank.csv')).path).async('nodebuffer'), bytes);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'data.db'))).digest('hex'), before);
}));
test('automatic collection respects the existing portal lock, preserves manual captcha case and runs comparison after download', async () => {
  const file = path.resolve(__dirname, '../src/accounting-review/collect.js');
  let imageCalls = 0, queried = '', compared = 0, registered = 0;
  class Controller {
    async loadCaptcha() { imageCalls++; return { dataUrl: 'data:image/png;base64,fixture', solvedText: '' }; }
    async searchDvc(from, to, captcha) { queried = captcha; return [{ maHoSo: '123456' }]; }
    async bulkDownload() { return { total: 1, succeeded: 1, failed: 0, files: [{ maHoSo: '123456', success: true, paths: ['fixture.xml'] }] }; }
  }
  Controller.splitRange = () => [];
  const context = { module: { exports: {} }, require: name => name === '../tokhai' ? { TokhaiController: Controller } : require(name) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const collect = context.module.exports;
  const legacy = { running: false }, scope = { mst: MST, dir: 'fixture', identifiers: [MST] };
  const deps = { browser: {}, downloadJob: () => legacy, ensureBrowser: async () => {}, isCurrent: () => true, session: async () => ({ ok: true, mst: MST }), check: async () => { compared++; return { checked: true }; }, register: async () => { registered++; return { warnings: [] }; } };
  const input = { ...RANGE, portal: 'dvc', submittedFrom: '01/07/2026', submittedTo: '31/10/2026' };
  collect.start(scope, input, deps); await collect.jobFor(MST).promise;
  assert.equal(collect.jobFor(MST).progress.stage, 'captcha'); assert.equal(legacy.running, false);
  collect.start(scope, { ...input, captcha: 'aB7c' }, deps); await collect.jobFor(MST).promise;
  assert.equal(imageCalls, 1); assert.equal(queried, 'aB7c'); assert.equal(registered, 1); assert.equal(compared, 1);
  assert.equal(collect.jobFor(MST).progress.stage, 'complete'); assert.equal(legacy.running, false);
  legacy.running = true; assert.throws(() => collect.start(scope, input, deps), /lượt tải/);
});
