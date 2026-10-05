'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createCapabilityIndex, HINT_LIMIT, MAX_ALTERNATIVES } = require('../src/ai/capability-index');
const { createRegistry } = require('../src/ai/tool-registry');
const { createToolRouter } = require('../src/ai/tool-router');
const { createAccessPolicy, manifest, FLAGS } = require('../src/ai/access-policy');
const { runAgent } = require('../src/ai/agent');

function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-capability-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function appStub(extra = {}) {
  return Object.assign({
    context: () => ({ currentUser: { selectedMst: 'GLOBAL' } }), search: async () => [], goods: async () => [],
    latest: async () => ({}), read: async () => ({}), items: async () => [], summary: async () => ({}),
    select: async () => ({}), refresh: async () => true, download: async () => ({}), downloadStatus: () => ({}),
  }, extra);
}
function registryFor(t, options = {}) {
  const datasets = { get: () => [], put: rows => ({ datasetId: 'ds_fixture', rows: rows.length, samples: [] }) };
  return createRegistry(Object.assign({ app: appStub(), datasets, dataDir: temporary(t), files: {}, emit() {}, attachments: [] }, options));
}
function indexFor(t, options = {}) { return createCapabilityIndex(registryFor(t, options)); }
function walk(value, visit, trail = '$') {
  visit(value, trail);
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, visit, trail + '.' + key);
}

// ── T1 — index count == registry runtime count (KHÔNG hardcode 40/36) ───────
test('T1 capability index mirrors the actual runtime registry, never a hardcoded count', t => {
  const minimal = registryFor(t);
  const rich = registryFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} }, cloud: { search: async () => {}, execute: async () => {} }, options: { web: true } });
  const minIndex = createCapabilityIndex(minimal), richIndex = createCapabilityIndex(rich);
  assert.equal(minIndex.entries.length, minimal.length, 'index phải khớp registry tối thiểu');
  assert.equal(richIndex.entries.length, rich.length, 'index phải khớp registry đầy đủ');
  assert.ok(rich.length > minimal.length, 'registry là conditional nên hai cấu hình phải khác số lượng');
  assert.deepEqual(minIndex.entries.map(e => e.name).sort(), minimal.map(tool => tool.name).sort());
  assert.deepEqual(richIndex.entries.map(e => e.name).sort(), rich.map(tool => tool.name).sort());
  assert.throws(() => createCapabilityIndex(null), /registry THẬT/);
});

// ── T2 — metadata khớp tool đã manifest ────────────────────────────────────
test('T2 capability metadata is derived from the manifested tool, not re-declared', t => {
  const registry = registryFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} }, cloud: { search: async () => {}, execute: async () => {} }, options: { web: true } });
  const index = createCapabilityIndex(registry);
  for (const tool of registry) {
    const entry = index.entries.find(item => item.name === tool.name);
    assert.ok(entry, 'thiếu entry cho ' + tool.name);
    assert.equal(entry.modelName, tool.name.replace(/\./g, '__'));
    assert.equal(entry.namespace, tool.name.split('.')[0]);
    assert.equal(entry.requiredEntitlement, tool.requiredEntitlement);
    assert.deepEqual([...entry.requiredPermissions], [...tool.requiredPermissions]);
    assert.equal(entry.riskClass, tool.riskClass);
    assert.equal(entry.sideEffect, tool.sideEffect);
    assert.equal(entry.timeout, tool.timeout ?? tool.timeoutMs ?? 15000);
    assert.deepEqual([...entry.requiredParameters], [...(tool.inputSchema.required || [])]);
  }
  // Spot-check độc lập với manifest() trên tool thô.
  const fsList = index.entries.find(e => e.name === 'fs.list');
  const expected = manifest({ name: 'fs.list', permission: 'READ', inputSchema: { type: 'object', properties: {}, required: [] }, handler() {} });
  assert.equal(fsList.requiredEntitlement, expected.requiredEntitlement);
  assert.deepEqual([...fsList.requiredPermissions], [...expected.requiredPermissions]);
  assert.equal(fsList.riskClass, expected.riskClass);
  assert.equal(fsList.sideEffect, expected.sideEffect);
});

// ── T3 — deep scan: không handler/license/secret/token/connection ──────────
test('T3 capability index deep scan contains no handler, license, secret, token or connection', t => {
  const index = indexFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} }, cloud: { search: async () => {}, execute: async () => {} }, options: { web: true } });
  const BANNED_KEY = /^(handler|license|licensekey|secret|token|access_?token|refresh_?token|connection|conn|credentials?|password|pass|pwd|api_?key|authorization|cookies|sessiontoken|client|db|database|sqlite|service)$/i;
  const banned = [];
  for (const entry of index.entries) {
    walk(entry, (value, trail) => {
      if (typeof value === 'function') banned.push('function@' + trail);
      if (Buffer.isBuffer(value)) banned.push('buffer@' + trail);
      if (value === null || typeof value !== 'object') return;
      for (const key of Object.keys(value)) if (BANNED_KEY.test(key)) banned.push(key + '@' + trail);
    }, entry.name);
    assert.ok(!Object.hasOwn(entry, 'handler'), 'entry không được có handler: ' + entry.name);
    assert.ok(!Object.hasOwn(entry, 'connection'));
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.requiredPermissions.every(item => typeof item === 'string'));
  }
  assert.deepEqual(banned, []);
  // Catalog AVAILABLE_NOT_EXPOSED cũng chỉ metadata, phải tuần tự hoá được.
  for (const entry of index.notExposed) {
    walk(entry, (value, trail) => { assert.notEqual(typeof value, 'function', 'catalog chứa function tại ' + trail); }, entry.name);
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(index.entries)));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(index.notExposed)));
});

// ── T4/T5 — PDF → Excel (kể cả khi có ngữ cảnh MST cũ) ─────────────────────
test('T4/T5 attached PDF resolves to file.pdf_to_excel and beats stale MST context', t => {
  const index = indexFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} } });
  const pdf = [{ filename: 'sk.pdf', ext: '.pdf', role: 'source', sheets: false }];
  const explicit = index.resolve({ text: 'chuyển PDF này sang Excel', attachments: pdf });
  assert.equal(explicit.status, 'MATCH');
  assert.equal(explicit.primary, 'file.pdf_to_excel');
  assert.ok(explicit.confidence >= 0.9);
  assert.ok(index.isExposed(explicit.primary));

  // Ngữ cảnh MST/database cũ CHỈ có thể đến từ history — resolver không nhận history.
  const stale = index.resolve({ text: 'chuyển file này sang Excel', attachments: pdf, context: { hasMst: true, selectedMst: '4500101451' } });
  assert.equal(stale.status, 'MATCH');
  assert.equal(stale.primary, 'file.pdf_to_excel', 'explicit attachment intent phải thắng context cũ');
  assert.ok(!/^(invoice|goods|data|db)\./.test(String(stale.primary)));
  assert.deepEqual(stale.alternatives.filter(item => item.name === stale.primary), []);
});

// ── T6 — filesystem ────────────────────────────────────────────────────────
test('T6 explicit source file path resolves to fs.read', t => {
  const index = indexFor(t);
  const result = index.resolve({ text: 'đọc file C:\\Users\\cana2\\proj\\src\\abc.js giúp tôi' });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.primary, 'fs.read');
  assert.ok(result.suggestedTools.includes('fs.read'));
  assert.ok(result.suggestedTools.every(name => index.isExposed(name)));
});

// ── T7 — DB → Excel là COMPOSITION, không có tool tưởng tượng ──────────────
test('T7 database to Excel resolves to a COMPOSITION chain, never a fictional db.top5 tool', t => {
  const index = indexFor(t);
  const result = index.resolve({ text: 'F:\\CN-invoice\\MST-8021214462-001\\data.db xuất cho tôi 5 hàng hóa bán chạy nhất ra Excel' });
  assert.equal(result.status, 'COMPOSITION');
  assert.ok(result.suggestedTools.includes('db.detect'));
  assert.ok(result.suggestedTools.includes('db.query_readonly'));
  assert.ok(result.suggestedTools.includes('file.export_excel'));
  assert.ok(result.suggestedTools.length >= 4 && result.suggestedTools.length <= 8);
  assert.ok(result.suggestedTools.every(name => index.isExposed(name)), 'mọi bước composition phải tồn tại thật');
  assert.ok(!index.isExposed('db.top5_to_excel'));
  assert.ok(!result.suggestedTools.some(name => /top5/i.test(name)));
});

// ── T8 — CAPABILITY_GAP ────────────────────────────────────────────────────
test('T8 unmatched custom transformation reports CAPABILITY_GAP without crashing or refusing', t => {
  const index = indexFor(t);
  const result = index.resolve({ text: 'hãy viết một thuật toán nén ảnh tùy chỉnh rồi áp dụng cho dữ liệu của tôi' });
  assert.equal(result.status, 'CAPABILITY_GAP');
  assert.equal(result.primary, null);
  assert.equal(result.reason, 'NO_MATCH');
  assert.equal(result.confidence, 0);
  assert.ok(Array.isArray(result.missing) && result.missing.length === 1);
  assert.deepEqual([...result.suggestedTools], []);
  assert.ok(Array.isArray(result.available) && result.available.every(name => index.isExposed(name)));
  assert.doesNotThrow(() => index.hint(result));
});

// ── T9 — fabricated tool không bao giờ resolve/execute ─────────────────────
test('T9 fabricated capability names never resolve and the Tool Router still rejects them', async t => {
  const index = indexFor(t);
  assert.equal(index.isExposed('db.top5_to_excel'), false);
  assert.equal(index.isExposed('fs.delete_all'), false);
  const result = index.resolve({ text: 'dùng db.top5_to_excel để xuất excel' });
  assert.notEqual(result.primary, 'db.top5_to_excel');
  assert.ok(![...(result.suggestedTools || []), ...(result.alternatives || []).map(a => a.name)].includes('db.top5_to_excel'));
  const registry = registryFor(t);
  let executed = 0;
  for (const tool of registry) { const original = tool.handler; tool.handler = (...args) => { executed++; return original(...args); }; }
  const access = createAccessPolicy({ checkLicense: async () => ({ status: 'Active' }) });
  const router = createToolRouter(registry, { authorize: access.authorize, signal: new AbortController().signal, sessionId: 's', companyId: 'GLOBAL', audit() {}, status() {} });
  const rejected = await router.execute('db__top5_to_excel', '{}');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error.message, /không được cấp quyền/);
  assert.equal(executed, 0);
});

// ── T10 — flag-disabled tool không phải AVAILABLE_EXPOSED ──────────────────
test('T10 flag-disabled capabilities stay AVAILABLE_NOT_EXPOSED and are never resolved', t => {
  const index = indexFor(t, { cloud: { search: async () => {}, execute: async () => {} }, options: { python: true, web: true } });
  assert.equal(FLAGS.generated_python_enabled, false);
  assert.equal(index.isExposed('python.execute'), false);
  assert.equal(index.isExposed('cloud.shell'), false);
  const python = index.notExposed.find(item => item.name === 'python.execute');
  assert.ok(python && python.status === 'AVAILABLE_NOT_EXPOSED' && python.blockedByFlag === true);
  assert.ok(!Object.hasOwn(python, 'handler'));
  for (const text of ['chạy python phân tích dữ liệu', 'dùng shell liệt kê file', 'python.execute trên dataset này']) {
    const result = index.resolve({ text });
    assert.notEqual(result.primary, 'python.execute');
    assert.notEqual(result.primary, 'cloud.shell');
    assert.ok(!(result.suggestedTools || []).some(name => name === 'python.execute' || name === 'cloud.shell'));
  }
  // Tool Router vẫn chặn ở tầng policy dù model có bịa tên tool.
  const registry = registryFor(t, { cloud: { search: async () => {}, execute: async () => {} }, options: { python: true } });
  const access = createAccessPolicy({ checkLicense: async () => ({ status: 'Active' }) });
  const router = createToolRouter(registry, { authorize: access.authorize, signal: new AbortController().signal, sessionId: 's', companyId: 'GLOBAL', audit() {}, status() {} });
  assert.equal(router.schemas.some(schema => schema.function.name === 'python__execute'), false);
});

// ── T11 — hint bounded ─────────────────────────────────────────────────────
test('T11 capability hint stays bounded and never dumps the registry', t => {
  const index = indexFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} }, cloud: { search: async () => {}, execute: async () => {} }, options: { web: true } });
  const inputs = [
    { text: 'chuyển PDF này sang Excel', attachments: [{ filename: 'sk.pdf', ext: '.pdf' }] },
    { text: 'F:\\x\\data.db xuất 5 hàng bán chạy nhất ra Excel' },
    { text: 'đọc file C:\\a\\b.js' },
    { text: 'liệt kê file trong thư mục D:\\du-an' },
    { text: 'hóa đơn gần nhất bao nhiêu tiền' },
    { text: 'xin chào' },
    { text: 'hãy viết thuật toán nén ảnh tùy chỉnh' },
  ];
  for (const input of inputs) {
    const hint = index.hint(index.resolve(input));
    if (hint === null) continue;
    assert.ok(hint.length <= HINT_LIMIT, 'hint vượt trần: ' + hint.length);
    assert.ok(hint.length < 500, 'hint case thường phải < 500 ký tự: ' + hint.length);
    for (const entry of index.entries) assert.ok(!hint.includes(entry.description), 'hint không được nhúng cả description');
  }
  assert.equal(index.hint(null), null);
  assert.equal(index.hint({ status: 'MATCH', primary: 'khong.ton.tai', confidence: 0.9 }), null, 'không hint cho capability không tồn tại');
});

// ── T12 — resolver KHÔNG execute, KHÔNG authorize ──────────────────────────
test('T12 capability resolver never invokes a handler, the router or authorization', t => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'capability-index.js'), 'utf8');
  // Bỏ comment trước khi soi mã: tài liệu được phép NHẮC tới router.execute().
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.doesNotMatch(source, /require\(['"]\.\/tool-router['"]\)/, 'capability-index không được phụ thuộc tool-router');
  assert.doesNotMatch(source, /\.handler\s*\(/, 'capability-index không được gọi handler');
  assert.doesNotMatch(source, /\.execute\s*\(/, 'capability-index không được gọi execute');
  assert.doesNotMatch(source, /\.authorize\s*\(/, 'capability-index không được authorize');

  const registry = registryFor(t, { contextTools: { searchHistory: () => [], memories: () => [], reference: () => {} }, cloud: { search: async () => {}, execute: async () => {} }, options: { web: true } });
  let calls = 0;
  for (const tool of registry) { const original = tool.handler; tool.handler = (...args) => { calls++; return original(...args); }; }
  const index = createCapabilityIndex(registry);
  const inputs = ['chuyển PDF này sang Excel', 'F:\\x\\data.db xuất excel', 'đọc file C:\\a\\b.js', 'hóa đơn gần nhất', 'xin chào', ''];
  for (const text of inputs) { index.resolve({ text, attachments: [{ filename: 'sk.pdf', ext: '.pdf' }] }); index.hint(index.resolve({ text })); }
  assert.equal(calls, 0, 'resolver tuyệt đối không được chạy handler');
});

// ── T13 — expired license vẫn bị Tool Router chặn ──────────────────────────
test('T13 expired or invalid license still blocks execution exactly as before', async () => {
  let executions = 0, state = { status: 'Active' };
  const access = createAccessPolicy({ checkLicense: async () => state });
  const tool = manifest({ name: 'fs.list', permission: 'READ', inputSchema: { type: 'object', properties: {}, required: [] }, handler: () => { executions++; return { entries: [] }; } });
  const router = createToolRouter([tool], { authorize: access.authorize, signal: new AbortController().signal, sessionId: 's', companyId: 'GLOBAL', audit() {}, status() {} });
  assert.equal((await router.execute('fs.list', '{}')).ok, true);
  for (const status of ['Expired', 'Locked', 'revoked', 'device_limit_exceeded', 'UNKNOWN']) {
    state = { status };
    const result = await router.execute('fs.list', '{}');
    assert.equal(result.error.code, 'LICENSE_DENIED', 'status ' + status + ' phải bị chặn');
  }
  assert.equal(executions, 1, 'license chặn thì handler không được chạy');
});

// ── T14 — revoke giữa task vẫn dừng agent (regression, kèm hint) ────────────
test('T14 license revoked mid task still stops the agent even when a capability hint is present', async t => {
  let calls = 0, searches = 0, revoked = false;
  const app = { context: () => ({ currentUser: { selectedMst: '0123456789' } }), search: () => { searches++; revoked = true; return [{ tong_tien: 1 }]; } };
  const tool = { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'invoice__search', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'app__get_state', arguments: '{}' } }] };
  const attachments = [{ id: 'file-fixture', filename: 'sk.pdf', ext: '.pdf', provider: 'agent', companyId: '0123456789', role: 'source' }];
  await assert.rejects(runAgent({
    config: { apiKey: 'fixture', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' },
    text: 'chuyển PDF này sang Excel', history: [], app, dataDir: temporary(t), files: {}, attachments, screen: {}, emit() {}, signal: new AbortController().signal,
    checkLicense: async () => ({ status: revoked ? 'Locked' : 'Active' }),
    fetchImpl: async (_url, init) => { calls++; if (calls === 1) assert.ok(JSON.parse(init.body).messages.some(m => typeof m.content === 'string' && m.content.includes('Gợi ý capability'))); return new Response(JSON.stringify({ choices: [{ message: tool }] })); },
  }), /Bản quyền/);
  assert.equal(searches, 1);
  assert.equal(calls, 1);
});

// ── Hint được nối vào agent nhưng KHÔNG đổi execution ──────────────────────
test('capability hint is injected into the model context yet execution stays on the existing router', async t => {
  const dir = temporary(t);
  const seen = { tools: null, hints: [], toolRounds: 0 };
  const app = appStub();
  let round = 0;
  const answer = await runAgent({
    config: { apiKey: 'fixture', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' },
    history: [], text: 'liệt kê file trong thư mục D:\\du-an', screen: {}, app, dataDir: dir, files: {}, emit() {}, signal: new AbortController().signal,
    attachments: [], checkLicense: async () => ({ status: 'Active' }),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (!seen.tools) { seen.tools = body.tools.map(item => item.function.name); for (const message of body.messages) if (typeof message.content === 'string' && message.content.includes('Gợi ý capability')) seen.hints.push(message.content); }
      round += 1;
      if (round === 1) {
        seen.toolRounds += 1;
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs__list', arguments: JSON.stringify({ path: 'D:\\du-an' }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      // Kết quả tool phải quay về model qua đúng kênh cũ.
      const toolMessage = body.messages.find(message => message.role === 'tool');
      assert.ok(toolMessage, 'model phải nhận được kết quả tool qua Tool Router');
      const parsed = JSON.parse(toolMessage.content);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.error.code, 'NOT_FOUND');
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Đã kiểm tra.' } }] }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(answer, 'Đã kiểm tra.');
  assert.ok(seen.hints.length >= 1, 'phải có hint capability cho yêu cầu liệt kê thư mục');
  assert.ok(seen.hints.every(text => text.length < 600));
  assert.equal(seen.toolRounds, 1);
  assert.ok(seen.tools.length > 0 && seen.tools.every(name => !/^capability/.test(name)), 'tool list vẫn là registry thật');
});
