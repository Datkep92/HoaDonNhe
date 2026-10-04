'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAccessPolicy, manifest, FLAGS } = require('../src/ai/access-policy');
const { createToolRouter } = require('../src/ai/tool-router');
const { createSessionStore } = require('../src/ai/session-store');
const { callAI, parseProtocol } = require('../src/ai/openrouter-client');
const { runAgent } = require('../src/ai/agent');
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-master-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('packaging smoke exercises AI and exits naturally without outbound fetch', t => {
  const dir = temporary(t), hook = path.join(dir, 'deny-network.cjs');
  fs.writeFileSync(hook, "global.fetch = () => { console.error('UNEXPECTED_OUTBOUND_FETCH'); throw new Error('Network forbidden in local smoke'); };\n");
  const result = require('node:child_process').spawnSync(process.execPath, ['--require', hook, 'src/server.js', '--test-server', '--smoke-test'], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOADON_TEST_DATA: dir, HOADON_NO_UPDATE_CHECK: '1' }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /"aiRuntime":true/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_OUTBOUND_FETCH|Assertion failed/);
});
test('authoritative license is required, deny stops executor, grants do not override entitlements', async () => {
  assert.throws(() => createAccessPolicy({}), /License Gate/);
  assert.throws(() => createToolRouter([], { signal: new AbortController().signal }), /enforcement/);
  let executions = 0, approvals = 0, state = { status: 'Active', entitlements: ['AI_DB_READ'] }, checks = 0;
  const access = createAccessPolicy({ checkLicense: async () => { checks++; return state; }, requestApproval: async () => { approvals++; } });
  const tool = manifest({ name: 'invoice.search', permission: 'READ', inputSchema: { type: 'object', properties: {}, required: [] }, handler: () => { executions++; return []; } });
  const router = createToolRouter([tool], { authorize: access.authorize, sessionId: 'session', companyId: '0123456789', signal: new AbortController().signal, status() {}, audit() {} });
  assert.equal((await router.execute('invoice.search', '{}')).ok, true);
  for (const status of ['Expired', 'Locked', 'revoked', 'wrong_device', 'device_limit_exceeded', 'UNKNOWN']) { state = { status }; const result = await router.execute('invoice.search', '{}'); assert.equal(result.error.code, 'LICENSE_DENIED'); }
  state = { status: 'Active', entitlements: [] }; assert.equal((await router.execute('invoice.search', '{}')).error.code, 'ENTITLEMENT_DENIED');
  assert.equal(executions, 1); assert.equal(approvals, 0); assert.equal(checks, 8);
  await assert.rejects(createAccessPolicy({ checkLicense: async () => null }).license(), /Bản quyền/);
  assert.equal(FLAGS.generated_python_enabled, false); assert.equal(FLAGS.command_execution_enabled, false);
});
test('license revoke between tools stops agent; model cannot choose an alternate bypass', async t => {
  let calls = 0, searches = 0, revoked = false;
  const app = { context: () => ({ currentUser: { selectedMst: '0123456789' } }), search: () => { searches++; revoked = true; return [{ tong_tien: 1 }]; } };
  const tool = { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'invoice__search', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'app__get_state', arguments: '{}' } }] };
  await assert.rejects(runAgent({ config: { apiKey: 'fixture', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' }, text: 'read', history: [], app, dataDir: temporary(t), files: {}, screen: {}, emit() {}, signal: new AbortController().signal,
    checkLicense: async () => ({ status: revoked ? 'Locked' : 'Active' }), fetchImpl: async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: tool }] })); },
  }), /Bản quyền/);
  assert.equal(searches, 1); assert.equal(calls, 1);
});
test('scoped sessions survive restart, preserve unknown legacy history and do not replay jobs', t => {
  const dir = temporary(t), original = JSON.stringify({ agent: [{ role: 'assistant', content: 'legacy company unknown' }] }); fs.writeFileSync(path.join(dir, 'ai-history.json'), original);
  let store = createSessionStore(dir);
  const a = store.resolve('agent', '0123456789'), b = store.resolve('agent', '9876543210'), global = store.resolve('agent', 'GLOBAL');
  assert.throws(() => store.resolve('agent', undefined), /phạm vi/);
  store.append(a, { role: 'user', content: 'Rule A' }); store.append(b, { role: 'user', content: 'Rule B' });
  assert.equal(store.history(a)[0].content, 'Rule A'); assert.equal(store.history(b)[0].content, 'Rule B'); assert.deepEqual(store.history(global), []);
  const job = store.startJob(a); store.close(); store = createSessionStore(dir);
  assert.equal(store.history(store.resolve('agent', '0123456789'))[0].content, 'Rule A'); assert.equal(store.getJob(job).status, 'interrupted');
  assert.equal(fs.readFileSync(path.join(dir, 'ai-history.json'), 'utf8'), original); assert.equal(fs.readFileSync(path.join(dir, 'agent', 'legacy-history.unscoped.json'), 'utf8'), original);
  store.close();
});
test('provider SSE streams Vietnamese text and assembles tool chunks without protocol leakage', async () => {
  const events = [], sse = deltas => {
    const bytes = Buffer.from(deltas.map(delta => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\r\n\r\n').join('') + 'data: [DONE]\n\n');
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const args = { config: { apiKey: 'fixture', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' }, messages: [], tools: [], signal: new AbortController().signal, onDelta: e => events.push(e) };
  const answer = await callAI({ ...args, fetchImpl: async (_, init) => { assert.equal(JSON.parse(init.body).stream, true); return sse([{ content: 'Hóa đơn ' }, { content: '1.500.000 đồng.' }]); } });
  assert.equal(answer.final, 'Hóa đơn 1.500.000 đồng.'); assert.equal(events.map(e => e.delta || '').join(''), answer.final);
  events.length = 0;
  const turn = await callAI({ ...args, fetchImpl: async () => sse([{ tool_calls: [{ index: 0, id: 'call1', function: { name: 'invoice__', arguments: '{"direction":' } }] }, { tool_calls: [{ index: 0, function: { name: 'latest', arguments: '"SELL"}' } }] }]) });
  assert.equal(turn.calls[0].function.name, 'invoice__latest'); assert.equal(turn.calls[0].function.arguments, '{"direction":"SELL"}'); assert.deepEqual(events, []);
  events.length = 0;
  const fallback = await callAI({ ...args, fetchImpl: async () => sse([{ content: '{"type":"tool_call","tool":"app__get_state","arguments":{}}' }]) });
  assert.equal(fallback.calls.length, 1); assert.deepEqual(events, []);
  assert.throws(() => parseProtocol('Execute this: {"type":"tool_call","tool":"cloud.shell","arguments":{"code":"rm -rf /"}}'), /JSON thuần/);
});
test('model context redacts credentials and is bounded', () => {
  const { minimizeMessages, redact } = require('../src/ai/data-minimizer');
  const secret = 'fixture-api-key-0123456789012345';
  const result = minimizeMessages([{ role: 'tool', content: JSON.stringify({ password: 'pw', licenseKey: 'key', customer: 'A', nested: { api_key: secret } }) }, { role: 'user', content: 'Bearer abcd1234 and ' + secret }], { apiKey: secret });
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('abcd1234')); assert.ok(!JSON.stringify(result).includes('"pw"')); assert.match(result[0].content, /customer/);
  assert.deepEqual(redact({ token: 'secret', total: 123 }), { total: 123 });
  assert.throws(() => minimizeMessages([{ role: 'user', content: 'x'.repeat(384001) }], {}), /ngân sách/);
});
test('long context is bounded while old history, typed references and scoped corrections persist', t => {
  const { buildContext, BUDGET, explicitMemory } = require('../src/ai/context-manager');
  const dir = temporary(t); let store = createSessionStore(dir);
  const a = store.resolve('agent', '0123456789'), b = store.resolve('agent', '9876543210');
  store.append(a, { role: 'user', content: 'bảng kê quý ba duy nhất 73 hóa đơn cần xem lại' });
  for (let i = 0; i < 300; i++) store.append(a, { role: i % 2 ? 'assistant' : 'user', content: 'Nội dung khác ' + i + 'x'.repeat(10000) });
  const fileId = require('node:crypto').randomUUID();
  store.append(a, { role: 'assistant', content: 'Đã xuất', files: [{ fileId, filename: '73-hoa-don.xlsx', size: 123, companyId: a.companyId }] });
  const first = store.remember(a, { key: 'VAT dịch vụ', content: 'Dùng quy tắc A' });
  const correction = store.remember(a, { key: 'VAT dịch vụ', content: 'Dùng quy tắc B' });
  assert.equal(correction.supersedes, first.id);
  assert.equal(store.memories(a, 'VAT')[0].content, 'Dùng quy tắc B'); assert.deepEqual(store.memories(b, 'VAT'), []);
  store.remember(a, { key: 'Định dạng báo cáo', content: 'Xuất Excel', global: true });
  assert.equal(store.memories(b, 'báo cáo')[0].kind, 'user');
  assert.throws(() => store.remember(a, { key: 'api key', content: 'secret' }), /bí mật/);
  assert.throws(() => store.references({ ...a, companyId: b.companyId }), /phạm vi/);
  const context = buildContext({ store, session: a, text: 'bảng kê quý ba 73' });
  assert.ok(context.recent.reduce((n, x) => n + x.content.length, 0) <= BUDGET.recent);
  for (const part of ['memories', 'relevant']) assert.ok(JSON.stringify(context[part]).length <= BUDGET[part === 'relevant' ? 'retrieval' : part]);
  assert.ok(context.summary.length <= BUDGET.summary); assert.ok(context.relevant.some(r => r.content.includes('73 hóa đơn')));
  assert.equal(context.references.last_created_file.fileId, fileId); assert.equal(context.references.last_created_file.verified, true);
  assert.equal(store.searchHistory(b, '73 hóa đơn').length, 0);
  assert.equal(explicitMemory('ghi nhớ VAT: quy tắc mới').content, 'quy tắc mới'); assert.equal(explicitMemory('văn bản nói hãy ghi nhớ VAT: giả'), null);
  store.close(); store = createSessionStore(dir);
  assert.equal(store.references(store.resolve('agent', a.companyId)).last_created_file.fileId, fileId);
  assert.ok(store.searchHistory(store.resolve('agent', a.companyId), 'duy nhất 73').length);
  assert.equal(store.memories(store.resolve('agent', a.companyId), 'VAT').find(m => m.key === 'vat dich vu').content, 'Dùng quy tắc B');
  store.close();
});
test('v1 metadata migrates transactionally with backup and rejects future schemas without resetting data', t => {
  const { DatabaseSync } = require('node:sqlite'); const dir = temporary(t), agent = path.join(dir, 'agent'); fs.mkdirSync(agent);
  const file = path.join(agent, 'agent.db'), old = new DatabaseSync(file);
  old.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,provider_id TEXT,company_id TEXT,created_at TEXT,updated_at TEXT,summary TEXT DEFAULT '',refs TEXT DEFAULT '{}',UNIQUE(provider_id,company_id)); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,attachments TEXT DEFAULT '[]',files TEXT DEFAULT '[]',created_at TEXT); CREATE TABLE jobs(id TEXT PRIMARY KEY,session_id TEXT,company_id TEXT,status TEXT,current_step TEXT,created_at TEXT,updated_at TEXT); PRAGMA user_version=1;");
  old.prepare('INSERT INTO sessions(id,provider_id,company_id) VALUES(?,?,?)').run('existing', 'agent', '0123456789');
  old.prepare('INSERT INTO messages(id,session_id,role,content) VALUES(?,?,?,?)').run('m', 'existing', 'user', 'Dữ liệu lịch sử quý ba'); old.close();
  const store = createSessionStore(dir); const session = store.resolve('agent', '0123456789');
  assert.equal(session.id, 'existing'); assert.equal(store.searchHistory(session, 'quý ba')[0].content, 'Dữ liệu lịch sử quý ba'); store.close();
  const backup = new DatabaseSync(path.join(agent, fs.readdirSync(agent).find(n => n.startsWith('agent-v1-'))), { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 1); assert.equal(backup.prepare('SELECT count(*) AS n FROM messages').get().n, 1); backup.close();
  const future = new DatabaseSync(file); future.exec('PRAGMA user_version=99'); future.close();
  assert.throws(() => createSessionStore(dir), /mới hơn/);
  const preserved = new DatabaseSync(file, { readOnly: true }); assert.equal(preserved.prepare('SELECT count(*) AS n FROM messages').get().n, 1); preserved.close();
});
test('context compacts completed native tool groups without losing current request or latest result', () => {
  const { fitToolContext } = require('../src/ai/context-manager');
  const messages = [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'Xuất đúng bảng vừa tính' }];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'assistant', tool_calls: [{ id: 'call-' + i }] });
    messages.push({ role: 'tool', tool_call_id: 'call-' + i, content: JSON.stringify({ ok: true, data: { datasetId: 'ds-' + i, rows: 73, text: 'x'.repeat(20000) }, meta: { tool: 'data.query', companyId: '0123456789' } }) });
  }
  fitToolContext(messages, 30000);
  assert.ok(JSON.stringify(messages).length < 31000); assert.equal(messages[1].content, 'Xuất đúng bảng vừa tính');
  assert.equal(messages.at(-1).tool_call_id, 'call-4'); assert.match(messages.at(-1).content, /ds-4/);
  assert.ok(messages.some(m => m.role === 'system' && m.content.includes('ds-0')));
  for (let i = 0; i < messages.length; i++) if (messages[i].tool_calls) assert.equal(messages[i + 1].role, 'tool');
});
test('approval binds exact action/version/company/source and consumes once without replay', async t => {
  const { createPermissionEngine } = require('../src/ai/permission-engine');
  const engine = createPermissionEngine(temporary(t)); t.after(() => engine.close());
  const tool = manifest({ name: 'account.refresh', permission: 'ACTION', description: 'Refresh', inputSchema: { type: 'object', properties: {}, required: [] } });
  const context = { sessionId: 's', companyId: '0123456789', workspace: 'fixture', application: 'HoaDonNhe', deviceId: 'device', fingerprint: 'v1' };
  const signal = new AbortController().signal; let request;
  let pending = engine.request(tool, {}, context, signal, value => { request = value; });
  assert.throws(() => engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow' }, { ...context, companyId: '9876543210' }), /thay đổi/);
  assert.throws(() => engine.decide({ approvalId: request.approvalId, actionHash: 'fake', decision: 'allow' }, context), /thay đổi/);
  engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow' }, context);
  const evidence = await pending;
  assert.throws(() => engine.consume(evidence, tool, { changed: true }, context), /đúng hành động/);
  pending = engine.request(tool, {}, context, signal, value => { request = value; });
  engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow' }, context);
  const valid = await pending;
  assert.equal(engine.consume(valid, tool, {}, context).scope, 'once');
  assert.throws(() => engine.consume(valid, tool, {}, context), /đúng hành động/);
  pending = engine.request(tool, {}, context, signal, value => { request = value; });
  engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow', scope: 'company' }, context);
  const company = await pending;
  assert.throws(() => engine.consume(company, { ...tool, version: 2 }, {}, context), /đúng hành động/);
  const next = await engine.request(tool, {}, context, signal, () => { throw Error('same exact company action should reuse grant'); });
  assert.equal(engine.consume(next, tool, {}, context).scope, 'company');
  const controller = new AbortController();
  const changed = engine.request(tool, {}, { ...context, fingerprint: 'v2' }, controller.signal, value => { request = value; });
  controller.abort(); await assert.rejects(changed, /dừng/);
  assert.throws(() => engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow' }, context), /không còn/);
});
test('deny/revoke/expiry/restart fail closed and always allow cannot override license', async t => {
  const { createPermissionEngine } = require('../src/ai/permission-engine');
  const dir = temporary(t); let engine = createPermissionEngine(dir);
  const tool = manifest({ name: 'account.refresh', permission: 'ACTION', description: 'Refresh', inputSchema: { type: 'object', properties: {}, required: [] } });
  const context = { sessionId: 's', companyId: '0123456789', workspace: 'fixture', application: 'HoaDonNhe', deviceId: 'device', fingerprint: 'v1' };
  const signal = new AbortController().signal; let request;
  let wait = engine.request(tool, {}, context, signal, value => { request = value; });
  engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'deny' }, context);
  await assert.rejects(wait, /từ chối/); await assert.rejects(engine.request(tool, {}, context, signal, () => {}), /từ chối/);
  engine.revoke(request.approvalId, context);
  let state = 'Active', executions = 0;
  const access = createAccessPolicy({ checkLicense: async () => ({ status: state }), permissions: engine,
    requestApproval: (...args) => engine.request(...args, signal, value => { request = value; }) });
  const router = createToolRouter([{ ...tool, handler: () => { executions++; return {}; } }], { authorize: (a, b) => access.authorize(a, b, context), signal, audit() {}, status() {} });
  wait = router.execute('account.refresh', '{}');
  await new Promise(resolve => setImmediate(resolve));
  engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow', scope: 'always' }, context); state = 'Locked';
  assert.equal((await wait).error.code, 'LICENSE_DENIED'); assert.equal(executions, 0);
  engine.close(); engine = createPermissionEngine(dir);
  const restored = await engine.request(tool, {}, context, signal, () => { throw Error('grant persists'); });
  assert.ok(engine.consume(restored, tool, {}, context).approvalId);
  engine.revoke(request.approvalId, context);
  const pending = engine.request(tool, {}, context, signal, value => { request = value; }); engine.close();
  await assert.rejects(pending, /đóng/);
  engine = createPermissionEngine(dir); assert.equal(engine.list(context).at(-1).state, 'interrupted'); engine.close();
  const expiry = createPermissionEngine(temporary(t), { expiryMs: 5 });
  await assert.rejects(expiry.request(tool, {}, context, signal, () => {}), /hết thời gian/); expiry.close();
  const blocked = createAccessPolicy({ checkLicense: async () => ({ status: 'Active' }), permissions: {}, requestApproval: () => { throw Error('must not ask for disabled executor'); } });
  await assert.rejects(blocked.authorize({ ...tool, requiredPermissions: ['EXTERNAL_SEND'] }, {}, context), /security policy/);
});
test('failed app verification is terminal: agent never repeats a consequential action', async t => {
  const { createPermissionEngine } = require('../src/ai/permission-engine'); const dir = temporary(t), engine = createPermissionEngine(dir); t.after(() => engine.close());
  let requests = 0, effects = 0; const signal = new AbortController().signal;
  const app = { context: () => ({ currentUser: { selectedMst: '0123456789' } }), refresh: async () => { effects++; return { authenticated: false, mst: '0123456789' }; } };
  const permissionContext = () => ({ workspace: dir, application: 'HoaDonNhe', deviceId: 'fixture' });
  await assert.rejects(runAgent({ config: { apiKey: 'fixture', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' }, history: [], text: 'refresh', app, dataDir: dir, files: {}, emit() {}, signal, checkLicense: async () => ({ status: 'Active' }), permissionContext, permissions: engine,
    requestApproval: (tool, args, context) => engine.request(tool, args, context, signal, request => engine.decide({ approvalId: request.approvalId, actionHash: request.actionHash, decision: 'allow' }, context)),
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', type: 'function', function: { name: 'account__refresh', arguments: '{}' } }] } }] })); },
  }), /Không xác minh/);
  assert.equal(effects, 1); assert.equal(requests, 1);
});
test('invoice item export uses full source dataset and refuses truncated preview fallback', async t => {
  const { createRegistry } = require('../src/ai/tool-registry'), { createDatasetStore } = require('../src/ai/dataset-store');
  const datasets = createDatasetStore(), full = Array.from({ length: 600 }, (_, i) => ({ amount: i + 1 }));
  const app = { context: () => ({ currentUser: { selectedMst: '0123456789' } }), read: () => ({ items: full.slice(0, 500), truncated: true }), items: () => full };
  const tools = createRegistry({ app, datasets, dataDir: temporary(t), emit() {}, files: {} });
  const result = await tools.find(tool => tool.name === 'invoice.get_items').handler({ key: 'fixture' });
  assert.equal(result.rows, 600); assert.equal(datasets.get(result.datasetId, '0123456789').length, 600);
  delete app.items;
  await assert.rejects(createRegistry({ app, datasets, dataDir: temporary(t), emit() {}, files: {} }).find(tool => tool.name === 'invoice.get_items').handler({ key: 'fixture' }), /xem trước/);
});
