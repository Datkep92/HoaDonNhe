'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { requestTarget, resolve, catalog, withAliases } = require('../src/ai/source-resolver');
const { runAgent } = require('../src/ai/agent');
const { createRegistry } = require('../src/ai/tool-registry');
const { createDatasetStore } = require('../src/ai/dataset-store');
const { publicMessages } = require('../src/ai/free-runtime');
const { createRuntime } = require('../src/ai/free-runtime');
const XLSX = require('../resources/xlsx.cjs');
const context = { currentUser: { selectedMst: '0123456789' }, app: { today: '2026-10-10' }, accounts: [{ mst: '0123456789', label: 'Công ty A' }, { mst: '058079001853', label: 'Kim Hường' }] };
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-workspace-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
test('company named in request overrides UI selection; opaque IDs remain stable after reorder', () => {
  assert.equal(requestTarget(context, 'dữ liệu kinh doanh tháng 10 của kim huong. báo cáo cho tôi').sources[0].mst, '058079001853');
  assert.equal(catalog(context)[0].sourceId, catalog({ accounts: context.accounts.slice().reverse() })[1].sourceId);
  assert.equal(resolve({ accounts: [{ mst: 'A', label: 'Kim Hường' }, { mst: 'B', label: 'Kim Hường' }] }, 'kim huong').ambiguous, true);
});
test('actual user correction identifies embedded MST and restores company alias from user history', t => {
  const c = { currentUser: { selectedMst: '4500101451' }, accounts: [{ mst: '4500101451', label: '4500101451' }] };
  assert.equal(resolve(c, '4500101451 là kim hường mà').sources[0].mst, '4500101451');
  const d = temp(t), app = withAliases({ context: () => c }, d, 'báo cáo kinh doanh kim hường thang 10', [{ role: 'user', content: '4500101451 là kim hường mà' }]);
  assert.equal(requestTarget(app.context(), 'báo cáo kinh doanh kim hường thang 10').sources[0].mst, '4500101451');
  assert.deepEqual(app.context().accounts[0].aliases, ['kim hường']);
  assert.equal(withAliases({ context: () => c }, d).context().accounts[0].aliases[0], 'kim hường');
  assert.equal(c.accounts[0].label, '4500101451');
});
test('Agent reports from requested company without mutating UI selection', async t => {
  let actual, network = 0;
  const app = { context: () => context, forCompany: mst => ({ context: () => ({ ...context, readCompanyId: mst }), summary: () => { actual = mst; return { sourceMst: mst, company: 'Kim Hường', amountSell: 1234567 }; } }) };
  const answer = await runAgent({ app, dataDir: temp(t), files: {}, history: [], text: 'báo cáo kinh doanh tháng 10 của kim huong.', config: { publicFree: true, endpoint: 'https://example.test/v1/chat/completions', model: 'test', apiKey: 'test' }, signal: new AbortController().signal, emit() {}, checkLicense: async () => ({ status: 'active' }), fetchImpl: async () => { network++; if (network > 1) return Response.json({ choices: [{ message: { content: 'Đã kiểm tra nguồn. [[local:E1]]' } }] }); return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'call', type: 'function', function: { name: 'invoice__summary', arguments: '{"from":"2026-10-01","to":"2026-10-31"}' } }] } }] })); } });
  assert.equal(actual, '058079001853'); assert.equal(context.currentUser.selectedMst, '0123456789'); assert.equal(network, 2); assert.match(answer, /1\.234\.567/);
});
test('ambiguous company asks user before network or reading finance', async t => {
  const answer = await runAgent({ app: { context: () => ({ ...context, accounts: [{ mst: 'A', label: 'Kim Hường' }, { mst: 'B', label: 'Kim Hường' }] }) }, dataDir: temp(t), history: [], text: 'báo cáo của kim huong.', config: {}, checkLicense: async () => ({ status: 'active' }), fetchImpl: () => { throw Error('Must not run'); } });
  assert.match(answer, /nhiều nguồn/); assert.match(answer, /MST\/mã: B/);
});
test('a failed name heuristic does not reject request before the model can reason and clarify', async t => {
  let calls = 0;
  const answer = await runAgent({ app: { context: () => context }, dataDir: temp(t), files: {}, history: [], text: 'báo cáo của doanh nghiệp chưa có tên.', config: { endpoint: 'https://example.test/v1/chat/completions', model: 'test', apiKey: 'test' }, emit() {}, signal: new AbortController().signal, checkLicense: async () => ({ status: 'active' }), fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: 'Bạn muốn dùng kho hóa đơn hay file kế toán local?' } }] }); } });
  assert.equal(calls, 1); assert.match(answer, /file kế toán local/);
});
test('unresolved requested company cannot silently use selected-company numbers', async t => {
  let wrongReads = 0;
  const app = { context: () => context, summary: () => { wrongReads++; return {}; }, forCompany: mst => ({ summary: () => ({ sourceMst: mst }) }) };
  const registry = createRegistry({ app, datasets: createDatasetStore(), dataDir: temp(t), files: {}, emit() {}, options: { requireSource: true } });
  const tool = registry.find(x => x.name === 'invoice.summary');
  assert.throws(() => tool.handler({}), e => e.code === 'TARGET_UNRESOLVED'); assert.equal(wrongReads, 0);
  assert.equal(tool.handler({ sourceId: catalog(context)[1].sourceId }).sourceMst, '058079001853');
});
test('reading another company cannot cause a download on the UI company', async t => {
  let writes = 0, approvals = 0;
  await assert.rejects(runAgent({ app: { context: () => ({ ...context, readCompanyId: '058079001853' }), download: () => { writes++; } }, dataDir: temp(t), files: {}, history: [], text: 'Tải hóa đơn tháng 10', config: { endpoint: 'https://example.test/v1/chat/completions', model: 'test', apiKey: 'test' }, emit() {}, signal: new AbortController().signal, checkLicense: async () => ({ status: 'active' }), requestApproval: () => { approvals++; }, fetchImpl: async () => Response.json({ choices: [{ message: { tool_calls: [{ id: 'call', type: 'function', function: { name: 'invoice__download', arguments: '{"from":"2026-10-01","to":"2026-10-31","direction":"SELL"}' } }] } }] }) }), /Nguồn đang đọc khác MST/);
  assert.equal(writes, 0); assert.equal(approvals, 0);
});
test('cross-company sourceId read and local Excel work without selecting an MST', async t => {
  const d = temp(t), datasets = createDatasetStore(); let readMst;
  const app = { context: () => ({ ...context, currentUser: { selectedMst: '' } }), forCompany: mst => ({ search: () => { readMst = mst; return [{ so_hd: '00001', tong_tien: 100 }]; } }) };
  const registry = createRegistry({ app, datasets, dataDir: d, emit() {}, files: {} });
  const query = registry.find(x => x.name === 'invoice.search');
  const value = await query.handler({ sourceId: catalog(context)[1].sourceId }); assert.equal(readMst, '058079001853'); assert.equal(datasets.get(value.datasetId, '')[0].so_hd, '00001');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Ma: '001', Tien: 456 }]), 'Ban hang'); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Ma: '002' }]), 'Mua hang');
  const file = path.join(d, 'ke-toan.xlsx'); fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const tool = registry.find(x => x.name === 'file.read_local'); assert.equal(tool.handler({ path: file }).needsSheet, true);
  const rows = tool.handler({ path: file, sheet: 'Ban hang' }); assert.equal(datasets.get(rows.datasetId, '')[0].Ma, '001');
  assert.throws(() => tool.handler({ path: path.join(d, '.env') }), /phép/);
});
test('public model can navigate metadata/schema but receives no local values or company IDs', () => {
  const rows = publicMessages([
    { role: 'tool', content: JSON.stringify({ ok: true, meta: { tool: 'local.find' }, data: { results: [{ path: 'C:/Data/book.xlsx', name: 'book.xlsx', type: 'file' }] } }) },
    { role: 'tool', content: JSON.stringify({ ok: true, meta: { tool: 'source.find' }, data: { sources: catalog(context) } }) },
    { role: 'tool', content: JSON.stringify({ ok: true, meta: { tool: 'file.read_local' }, data: { datasetId: 'ds_1', schema: ['Ma', 'Tien'], samples: [{ Tien: 9876543 }] } }) }
  ]);
  const raw = JSON.stringify(rows); assert.match(raw, /book.xlsx/); assert.match(raw, /Tien/); assert.doesNotMatch(raw, /9876543|058079001853|Kim Hường/);
});
test('previous locally rendered financial report stays in local history and is redacted on public model wire', () => {
  const original = { role: 'assistant', content: 'Báo cáo hóa đơn từ kho local: Kim Hường\nTổng: 1.234.567 đồng.' };
  assert.doesNotMatch(publicMessages([original])[0].content, /Kim Hường|1\.234\.567/);
  assert.match(original.content, /1\.234\.567/);
});
test('local reporting uses actual dataset values, not model guesses', t => {
  const datasets = createDatasetStore(), value = datasets.put([{ Tong: 1234567 }], '0123456789');
  const registry = createRegistry({ app: { context: () => context }, datasets, dataDir: temp(t), files: {}, emit() {} });
  assert.match(registry.find(x => x.name === 'data.report').handler({ datasetId: value.datasetId }).reportText, /1234567/);
});
test('multi-company summary separates sources and preserves results when one source cannot be read', async t => {
  const app = { context: () => context, forCompany: mst => ({ summary: () => { if (mst === '0123456789') throw Error('Chưa có kho'); return { sourceMst: mst, company: 'Kim Hường', amountSell: 1234567 }; } }) };
  const registry = createRegistry({ app, datasets: createDatasetStore(), dataDir: temp(t), files: {}, emit() {} });
  const value = await registry.find(x => x.name === 'invoice.summary_many').handler({ sourceIds: catalog(context).map(a => a.sourceId), from: '2026-10-01', to: '2026-10-31' });
  assert.equal(value.reports.length, 2); assert.equal(value.reports[0].error, 'Chưa có kho'); assert.equal(value.reports[1].data.amountSell, 1234567); assert.equal(context.currentUser.selectedMst, '0123456789');
});
test('device profiles are independent, persist after restart, and never pretend to create a provider key', async t => {
  const a = temp(t), b = temp(t), statuses = [];
  const fetchImpl = async url => url.endsWith('/models') ? Response.json({ data: [{ id: 'model-hidden', isFree: true, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } }] }) : Response.json({ choices: [{ message: { content: 'OK' } }] });
  for (const dir of [a, b]) await createRuntime(dir, { fetchImpl }).chat({ basic: true, messages: [], onDelta: e => statuses.push(e.status) });
  const profile = d => JSON.parse(fs.readFileSync(path.join(d, 'agent', 'runtime-profile.json')));
  assert.notEqual(profile(a).id, profile(b).id); const previous = profile(a).id;
  await createRuntime(a, { fetchImpl }).chat({ basic: true, messages: [] }); assert.equal(profile(a).id, previous);
  assert.equal(profile(a).apiKey, undefined); assert.doesNotMatch(statuses.join(' '), /model-hidden/);
  assert.equal(createRuntime(a, { fetchImpl }).status().quotaScope, 'provider-account-or-ip');
});
