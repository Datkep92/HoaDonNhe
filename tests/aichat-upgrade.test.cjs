'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID, createHash } = require('node:crypto');
const { basicChat, attachmentParts } = require('../src/ai/basic-chat');
const { createExecutionStore } = require('../src/ai/execution-store');
const { createToolRouter } = require('../src/ai/tool-router');
const { createAccessPolicy, manifest } = require('../src/ai/access-policy');
const { createPermissionEngine } = require('../src/ai/permission-engine');
const { createAiService } = require('../src/ai-service');
const { runAgent } = require('../src/ai/agent');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cntax-upgrade-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const signal = () => new AbortController().signal;
const relay = { baseURL: 'https://gateway.test/v1/ai/chat/completions', token: 'fixture-token' };
const answer = text => Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
test('basic sends one ordinary request without tools, discovery or accounting context', async () => {
  let calls = 0;
  const result = await basicChat({ relay, sessionId: 's', history: [], text: 'hướng dẫn', signal: signal(), fetchImpl: async (url, init) => {
    calls++; assert.equal(url, relay.baseURL); assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); assert.equal(body.stream, false); assert.equal(body.tools, undefined); assert.equal(body.metadata.cntax_mode, 'basic'); assert.equal(body.messages.at(-1).content, 'hướng dẫn');
    assert.doesNotMatch(init.body, /Dùng JSON protocol|Context ứng dụng/); return answer('Hướng dẫn.');
  } }); assert.equal(result.answer, 'Hướng dẫn.'); assert.equal(calls, 1);
});
test('basic bounds context, rejects quota/tool responses/truncation and unavailable configuration', async () => {
  const args = { relay, history: Array.from({ length: 30 }, () => ({ role: 'assistant', content: 'x'.repeat(10000) })), text: 'q', signal: signal() };
  await basicChat({ ...args, fetchImpl: async (_, init) => { const body = JSON.parse(init.body); assert.equal(body.messages.length, 14); assert.equal(body.messages[1].content.length, 6000); return answer('ok'); } });
  for (const status of [429, 402, 503]) await assert.rejects(basicChat({ ...args, fetchImpl: async () => new Response('', { status }) }), /hạn mức|khả dụng/);
  await assert.rejects(basicChat({ ...args, relay: null }), /Chưa kết nối/);
  await assert.rejects(basicChat({ ...args, fetchImpl: async () => Response.json({ choices: [{ message: { content: 'tool', tool_calls: [{}] } }] }) }), /không phù hợp/);
  await assert.rejects(basicChat({ ...args, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }) }), /bị cắt/);
});
test('basic attachment table preserves columns, refuses silent truncation and respects cancellation', async () => {
  const parts = await attachmentParts({}, [{ filename: 'table', sheets: [{ name: 'sheet2', rows: [{ MST: '0012345678', amount: 5 }] }] }], signal());
  assert.match(parts[0].text, /0012345678/); assert.match(parts[0].text, /sheet2/);
  await assert.rejects(attachmentParts({}, [{ filename: 'large', text: 'x'.repeat(90001) }], signal()), /vượt ngữ cảnh/);
  const c = new AbortController(); c.abort(); await assert.rejects(attachmentParts({}, [{ text: 'x' }], c.signal));
});
function serviceFixture(t, options = {}) {
  const dataDir = options.dataDir || temp(t); let selected = '0123456789', calls = 0;
  const args = { dataDir, secrets: { read: () => ({}), write() {}, clear() {} }, app: { context: () => ({ currentUser: { selectedMst: selected } }) }, checkLicense: async () => ({ status: 'Active' }), agentGateway: () => relay,
    fetchImpl: async (url) => { if(url.endsWith('/models')) return Response.json({data:[{id:'kilo-auto/free',isFree:true,pricing:{prompt:'0',completion:'0'},architecture:{output_modalities:['text']},supported_parameters:['tools']}]}); calls++; return answer('aichat trả lời'); }, ...options };
  const service = createAiService(args); t.after(() => service.close());
  async function request(route, input) { const res = new EventEmitter(); res.chunks = []; res.writeHead = () => { res.headersSent = true; }; res.write = s => res.chunks.push(s); res.end = s => { if (s) res.chunks.push(s); }; const reply = (_, status, value) => { res.value = value; }; await service.handle({ method: input ? 'POST' : 'GET' }, res, new URL(route, 'http://localhost'), async () => input, reply); return res; }
  return { service, args, request, calls: () => calls, select: mst => { selected = mst; } };
}
test('basic sessions persist across restart, replay request without model call, scope and id conflict blocked', async t => {
  const f = serviceFixture(t), id = randomUUID(), input = { id: 'basic', mode: 'basic', requestId: id, companyId: '0123456789', text: 'hello' };
  assert.match((await f.request('/api/ai/stream', input)).chunks.join(''), /aichat trả lời/);
  await f.request('/api/ai/stream', input); assert.equal(f.calls(), 1);
  await assert.rejects(f.request('/api/ai/stream', { ...input, text: 'other' }), /Request ID/);
  f.service.close(); const second = serviceFixture(t, { ...f.args });
  const rows = (await second.request('/api/ai/history?id=basic')).value.value; assert.equal(rows.length, 2);
  await second.request('/api/ai/stream', input); assert.equal(second.calls(), 0);
  f.select('9876543210'); assert.equal((await second.request('/api/ai/history?id=basic')).value.value.length, 0);
  await assert.rejects(second.request('/api/ai/stream', input), /MST đã đổi/);
  second.service.close();
});
test('features preserve legacy history; integrated Agent needs no installation; basic id cannot enter legacy Agent', async t => {
  const f = serviceFixture(t), config = (await f.request('/api/ai/providers')).value.value;
  assert.deepEqual(config.features, { legacy: false, basic: true, agent: true }); assert.equal(config.runtime.installed, true);
  assert.equal(config.runtime.requiresDownload, false);
  await assert.rejects(f.request('/api/ai/stream', { id: 'basic', text: 'q' }), /chỉ hỗ trợ/);
  f.service.close(); fs.writeFileSync(path.join(f.args.dataDir, 'ai-features.json'), JSON.stringify({ legacy: true, basic: false }));
  const reopened = serviceFixture(t, { ...f.args }); assert.equal((await reopened.request('/api/ai/providers')).value.value.features.legacy, true);
  await assert.rejects(reopened.request('/api/ai/stream', { mode: 'basic', text: 'q' }), /bị tắt/);
});
test('license denied before reading body; no provider/model request occurs', async t => {
  const f = serviceFixture(t, { checkLicense: async () => ({ status: 'Locked' }) });
  await assert.rejects(f.request('/api/ai/stream', { mode: 'basic', text: 'q' }), /Bản quyền/); assert.equal(f.calls(), 0);
});
test('business writes ask once per action; cached permissions cannot bypass a new confirmation', async t => {
  const engine = createPermissionEngine(temp(t)); const context = { sessionId: 's', companyId: '0123456789', workspace: 'w', application: 'app', forceOnce: true };
  const tool = manifest({ name: 'file.export_excel', permission: 'WRITE_FILE', description: 'export' }); let emits = 0;
  const request = engine.request(tool, {}, context, signal(), req => { emits++; assert.deepEqual(req.allowedScopes, ['once', 'deny']); assert.throws(() => engine.decide({ ...req, decision: 'allow', scope: 'always' }, context)); engine.decide({ ...req, decision: 'allow', scope: 'once' }, context); });
  engine.consume(await request, tool, {}, context);
  const again = engine.request(tool, {}, context, signal(), req => { emits++; engine.decide({ ...req, decision: 'deny' }, context); });
  await assert.rejects(again, /từ chối/); assert.equal(emits, 2); engine.close();
});
test('durable tool ledger reuses verified writes and blocks ambiguous crash result across restart', async t => {
  const directory = temp(t); let count = 0;
  let store = createExecutionStore(directory); const id = randomUUID(), record = store.begin(id, 's', { text: 'export' });
  const tool = manifest({ name: 'file.export', permission: 'WRITE_FILE', inputSchema: { type: 'object', properties: {} }, handler: () => ({ fileId: String(++count) }) });
  const router = execution => createToolRouter([tool], { signal: signal(), authorize: async () => {}, status() {}, audit() {}, execution });
  const first = await router({ store, record }).execute('file.export', '{}'); assert.equal(first.ok, true);
  store = createExecutionStore(directory); const next = store.begin(id, 's', { text: 'export' });
  assert.deepEqual(await router({ store, record: next }).execute('file.export', '{}'), JSON.parse(JSON.stringify(first))); assert.equal(count, 1);
  const other = store.begin(randomUUID(), 's', { text: 'export2' }); store.startTool(other, store.toolKey('file.export', {}));
  const result = await router({ store, record: other }).execute('file.export', '{}'); assert.equal(result.error.code, 'EXECUTION_UNCERTAIN'); assert.equal(count, 1);
});
test('Agent resumes saved dataset checkpoint without re-running successful tool', async t => {
  const dir = temp(t), store = createExecutionStore(dir), record = store.begin(randomUUID(), 's', { text: 'q' }); let reads = 0;
  const app = { context: () => ({ currentUser: { selectedMst: '0123456789' } }), search: () => { reads++; return [{ amount: 10 }]; } };
  const args = { config: { endpoint: 'http://127.0.0.1/unused', apiKey: 'fixture', model: 'f', chatTransport: async () => ({ calls: [{ id: 'a', function: { name: 'invoice__search', arguments: '{}' } }], message: { content: '' } }) }, text: 'q', history: [], screen: {}, app, dataDir: dir, files: {}, emit() {}, signal: signal(), checkLicense: async () => ({ status: 'Active' }), session: { id: 's', companyId: '0123456789' }, execution: { store, record } };
  args.config.chatTransport = async () => { if (reads) throw Error('quota fixture'); return { calls: [{ id: 'a', function: { name: 'invoice__search', arguments: '{}' } }], message: { content: '' } }; };
  await assert.rejects(runAgent(args), /quota fixture/); assert.equal(reads, 1); assert.equal(record.checkpoint.datasets.length, 1);
  args.config.chatTransport = async () => ({ final: 'ok' }); assert.equal(await runAgent(args), 'ok'); assert.equal(reads, 1);
});
