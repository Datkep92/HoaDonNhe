'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const { parseProtocol } = require('../src/ai/openrouter-client');
const { createAttachments } = require('../src/ai/attachments');
const { createCloudTools } = require('../src/ai/cloud-tools');
const { createRegistry } = require('../src/ai/tool-registry');
const { createDatasetStore } = require('../src/ai/dataset-store');
const { runAgent } = require('../src/ai/agent');
const XLSX = require('../resources/xlsx.cjs');
const JSZip = require('jszip');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-files-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const response = message => new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
test('actual reported concatenated tool JSON executes both tools, including escaped braces and fences', async t => {
  const wire = '{"type":"tool_call","tool":"data__query","arguments":{"direction":"SELL"}}  {"type":"tool_call","tool":"app__get_state","arguments":{}}';
  assert.equal(parseProtocol(wire).calls.length, 2);
  assert.equal(parseProtocol('```json\n[{"type":"tool_call","tool":"web.search","arguments":{"query":"a \\\"}\\\" b"}}]\n```').calls.length, 1);
  assert.equal(parseProtocol('{"type":"tool_calls","calls":[{"function":{"name":"app__get_state","arguments":"{}"}}]}').calls.length, 1);
  assert.throws(() => parseProtocol('{"type":"tool_call","tool":'), /chưa hợp lệ/);
  assert.equal(parseProtocol('{"type":"final","message":"Kết quả"}').final, 'Kết quả');
  const seen = []; let n = 0;
  const answer = await runAgent({ checkLicense: async () => ({ status: 'Active' }), config: { apiKey: 'fixture', endpoint: 'http://localhost/v1/chat/completions', model: 'fixture' }, history: [], text: 'hoá đơn bán ra gần nhất bao nhiêu tiền', screen: {}, dataDir: temp(t), files: {}, signal: new AbortController().signal, emit() {},
    app: { context: () => { seen.push('state'); return { currentUser: { selectedMst: '' } }; }, search: () => { seen.push('search'); return [{ tong_tien: 1500000 }]; } },
    fetchImpl: async (_, init) => { const body = JSON.parse(init.body); if (n++) { assert.ok(body.messages.some(m => m.content?.includes('1500000'))); return response({ content: '1.500.000 đồng.' }); } return response({ content: wire }); },
  });
  assert.equal(answer, '1.500.000 đồng.'); assert.ok(seen.includes('search')); assert.ok(seen.filter(s => s === 'state').length >= 2);
});
test('uploads preserve all sheets, JSON rows, DOCX text and reject traversal, excess rows and wrong scope', async t => {
  const dir = temp(t), uploads = createAttachments(dir);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ name: 'A', value: 10 }, { name: 'B', value: 20 }]), 'Tháng 9');
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ value: 100 }]), 'Tháng 10');
  const file = await uploads.upload(Readable.from([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), 'kế toán.xlsx', 'agent');
  assert.equal(file.sheets.length, 2); assert.equal(uploads.load(file.id, 'agent').sheets[0].rows[1].value, 20);
  assert.throws(() => uploads.load(file.id, 'other'), /khác/);
  await assert.rejects(uploads.upload(Readable.from([Buffer.from('[]')]), '../x.json', 'agent'), /Tên file/);
  const json = await uploads.upload(Readable.from([Buffer.from('[{"value":42}]')]), 'x.json', 'agent');
  assert.equal(uploads.load(json.id, 'agent').sheets[0].rows[0].value, 42);
  const zip = new JSZip(); zip.file('word/document.xml', '<w:document><w:p><w:t>Báo cáo &amp; thuế</w:t></w:p></w:document>');
  const word = await uploads.upload(Readable.from([await zip.generateAsync({ type: 'nodebuffer' })]), 'report.docx', 'agent');
  assert.match(uploads.load(word.id, 'agent').text, /Báo cáo & thuế/);
  await assert.rejects(uploads.upload(Readable.from([Buffer.from('not pdf')]), 'x.pdf', 'agent'), /PDF/);
  const png = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const image = await uploads.upload(Readable.from([png]), 'ảnh.png', 'agent');
  assert.equal(image.kind, 'image'); assert.match(uploads.parts([uploads.load(image.id, 'agent')])[1].image_url.url, /^data:image\/png;base64,/);
  await assert.rejects(uploads.upload(Readable.from([Buffer.from('not image')]), 'x.png', 'agent'));
  const huge = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(huge, XLSX.utils.json_to_sheet(Array.from({ length: 21000 }, (_, i) => ({ i }))), 'Huge');
  await assert.rejects(uploads.upload(Readable.from([XLSX.write(huge, { type: 'buffer', bookType: 'xlsx' })]), 'large.xlsx', 'agent'), /20.000/);
});
test('external uploaded table works with no MST: full dataset JS -> export and report', async t => {
  const dir = temp(t), datasets = createDatasetStore(), files = {}, emitted = [];
  const registry = createRegistry({ app: { context: () => ({ currentUser: { selectedMst: '' } }) }, datasets, dataDir: dir, files, emit: e => emitted.push(e), attachments: [{ id: 'file-fixture', filename: 'bảng.csv', sheets: [{ name: 'Sheet1', rows: Array.from({ length: 10 }, (_, i) => ({ amount: i + 1 })) }] }] });
  const read = registry.find(t => t.name === 'file.read_attachment').handler({ id: 'file-fixture' });
  assert.equal(read.rows, 10);
  const sum = await registry.find(t => t.name === 'js.execute_safe').handler({ datasetId: read.datasetId, code: 'return input.reduce((s,r)=>s+r.amount,0)' }, new AbortController().signal);
  assert.equal(sum, 55);
  const out = registry.find(t => t.name === 'file.export_excel').handler({ datasetId: read.datasetId, filename: 'bảng-mới.xlsx' }); assert.equal(out.rows, 10);
  const report = registry.find(t => t.name === 'file.write_report').handler({ content: 'Tổng tiền 55', filename: 'báo-cáo.md' });
  assert.equal(fs.readFileSync(path.join(dir, 'ai-exports', report.fileId + '.md'), 'utf8'), 'Tổng tiền 55'); assert.equal(emitted.length, 2);
});
test('cloud Python checks real shell output, disables internet, does not execute on host', async () => {
  const config = { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'fixture', model: 'fixture' };
  let request;
  const cloud = createCloudTools(config, async (url, init) => { request = JSON.parse(init.body); assert.equal(url, 'https://openrouter.ai/api/v1/responses'); return new Response(JSON.stringify({ output: [{ type: 'openrouter:shell', output: [{ stdout: 'HD_RESULT:{"sum":3}\n', stderr: '', outcome: { type: 'exit', exit_code: 0 } }] }] })); });
  const value = await cloud.execute('python', 'return {"sum": sum(r["n"] for r in input)}', [{ n: 1 }, { n: 2 }], new AbortController().signal);
  assert.equal(value.sum, 3); assert.equal(request.tools[0].parameters.environment.network_policy.type, 'disabled');
  assert.match(request.input, /python3/); assert.ok(!request.input.includes('fixture'));
  const noRun = createCloudTools(config, async () => new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] })));
  await assert.rejects(noRun.execute('python', 'return 1', [], new AbortController().signal), /chưa xác nhận/);
  assert.equal(createCloudTools({ ...config, endpoint: 'http://localhost/v1/chat/completions' }), null);
});
test('web search requests real server search with limits and requires sources', async () => {
  const config = { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'fixture', model: 'fixture' };
  const cloud = createCloudTools(config, async (_, init) => { assert.equal(JSON.parse(init.body).tools[0].type, 'openrouter:web_search'); return response({ content: 'Văn bản gốc', annotations: [{ type: 'url_citation', url_citation: { url: 'https://mof.gov.vn/doc', title: 'Văn bản' } }] }); });
  assert.equal((await cloud.search('thuế doanh nghiệp', new AbortController().signal)).sources[0].url, 'https://mof.gov.vn/doc');
  const missing = createCloudTools(config, async () => response({ content: 'Nhớ rằng thuế là 20%' })); await assert.rejects(missing.search('x', new AbortController().signal), /thiếu nguồn/);
});
