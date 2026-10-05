'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const providers = require('../src/ai-providers');
const { createAiService, licenseGate } = require('../src/ai-service');
const { runAgent } = require('../src/ai/agent');
const { createDatasetStore } = require('../src/ai/dataset-store');
const { executeSafeJs } = require('../src/ai/safe-js');
const { createRegistry } = require('../src/ai/tool-registry');
const { createToolRouter } = require('../src/ai/tool-router');
const { callAI } = require('../src/ai/openrouter-client');
const XLSX = require('../resources/xlsx.cjs');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-ai-'));
  const vault = new Map(); let mst = '0123456789';
  const rows = [1, 2].map(id => ({ id, invoice_key: 'k' + id, direction: 'SELL', mst_ban: mst, khh_hd: 'C26T', so_hd: '12', ngay_lap: '2026-09-01', tong_tien: 110, tien_truoc_thue: 100, tien_thue: 10 }));
  return { dir, rows, vault, secrets: { read: id => ({ token: vault.get(id) || '' }), write: (id, p) => vault.set(id, p.token), clear: id => vault.delete(id) },
    app: { context: () => ({ currentUser: { selectedMst: mst }, app: { today: '2026-10-04' } }), search: () => rows, read: () => ({ invoice: rows[0], items: [] }), summary: () => ({ sell: 220 }), select: value => { mst = value; return { selectedMst: mst }; }, download: () => ({ started: true }), downloadStatus: () => ({ busy: true }), refresh: () => ({ authenticated: true }) },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
const response = content => new Response(JSON.stringify({ choices: [{ message: content }] }), { headers: { 'Content-Type': 'application/json' } });
const tool = (name, args) => response({ role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
test('providers reject retired web modes, external local URLs, credential URLs and invalid model configuration', () => {
  for (const url of ['javascript:alert(1)', 'file:///secret', 'http://evil.com', 'https://user:pass@api.example.com', 'https://api.example.com?key=secret']) assert.equal(providers.parseBaseUrl(url, 'openai'), null);
  assert.ok(providers.parseBaseUrl('http://localhost:11434/v1', 'local'));
  assert.equal(providers.parseBaseUrl('https://external.example/v1', 'local'), null);
  assert.deepEqual(providers.normalizeProvider(providers.defaults()[0]), providers.defaults()[0]);
  assert.throws(() => providers.normalizeProvider({ id: 'old', label: 'web', type: 'web', embedUrl: 'https://deepseek-ai.easytool.dev' }));
  assert.throws(() => providers.normalizeProvider({ ...providers.defaults()[0], id: '__proto__' }));
});
test('AI never caches authoritative license or ignores revoke during a task', async () => {
  let calls = 0, time = 1, signature = 'trial', fail = false;
  const gate = licenseGate(async () => { calls++; if (fail) throw new Error('locked'); }, () => signature, () => time);
  await Promise.all(Array.from({ length: 14 }, () => gate())); assert.equal(calls, 14);
  signature = 'active'; await gate(); assert.equal(calls, 15);
  time += 600001; await gate(); assert.equal(calls, 16);
  signature = 'locked'; fail = true; await assert.rejects(gate()); await assert.rejects(gate()); assert.equal(calls, 18);
});
test('migrates saved web modes without losing configured API providers, history or keys', async () => {
  const f = fixture();
  try {
    const own = { ...providers.defaults()[0], id: 'own', label: 'Own' };
    f.vault.set('ai-own', 'secret-key');
    fs.writeFileSync(path.join(f.dir, 'ai-providers.json'), JSON.stringify({ active: 'web-old', providers: [{ id: 'web-old', label: 'Web', type: 'web' }, own] }));
    const service = createAiService({ dataDir: f.dir, secrets: f.secrets, checkLicense: async () => ({ status: 'Active' }), licenseSignature: () => 'active' });
    let result;
    await service.handle({ method: 'GET' }, {}, new URL('http://localhost/api/ai/providers'), null, (_, status, value) => { result = value.value; });
    assert.equal(result.active, 'support'); assert.deepEqual(result.providers.map(p => p.id), ['agent', 'own']);
    assert.equal(result.providers[1].hasKey, true); assert.equal(JSON.stringify(result).includes('secret-key'), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ai-providers.json'), 'utf8').includes('web-old'), false);
    await assert.rejects(service.handle({ method: 'POST' }, {}, new URL('http://localhost/api/ai/providers'), async () => ({ provider: { id: 'x', label: 'x', type: 'web' } }), () => {}));
  } finally { f.cleanup(); }
});
test('Agent searches, finds duplicates, exports verified Excel and answers using actual results', async () => {
  const f = fixture(); const events = [], files = {}; let calls = 0;
  try {
    const fetchImpl = async (url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.redirect, 'error'); assert.equal(request.messages.some(m => m.content?.includes('test-key')), false);
      calls++;
      const last = request.messages.at(-1);
      if (calls === 1) return tool('invoice__search', { from: '2026-09-01', to: '2026-09-30', direction: 'SELL' });
      const result = JSON.parse(last.content); assert.equal(result.ok, true);
      if (calls === 2) return tool('invoice__find_duplicates', { datasetId: result.data.datasetId });
      if (calls === 3) { assert.equal(result.data.groups, 1); return tool('file__export_excel', { datasetId: result.data.datasetId, filename: 'hoa_don_trung.xlsx' }); }
      assert.equal(result.data.rows, 2); return response({ content: 'Phát hiện 2 hóa đơn nghi trùng trong 1 nhóm. Đã xuất Excel.' });
    };
    const result = await runAgent({ checkLicense: async () => ({ status: 'Active' }), config: { endpoint: 'https://example.com/v1/chat/completions', model: 'fixture', apiKey: 'test-key' }, history: [], text: 'Tìm hóa đơn trùng và xuất Excel', screen: {}, app: f.app, dataDir: f.dir, files, emit: value => events.push(value), signal: new AbortController().signal, fetchImpl });
    assert.equal(calls, 4); assert.ok(result.includes('2 hóa đơn'));
    const file = events.find(event => event.file).file;
    const workbook = XLSX.read(fs.readFileSync(path.join(f.dir, 'ai-exports', file.fileId + '.xlsx')), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    assert.equal(rows.length, 2); assert.equal(rows[0].duplicate_group, 1);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ai-audit.jsonl'), 'utf8').includes('test-key'), false);
  } finally { f.cleanup(); }
});
test('router rejects fabricated tools, extra args, traversal, foreign datasets and limits repeat failures', async () => {
  const f = fixture();
  try {
    const datasets = createDatasetStore(), value = datasets.put(f.rows, '0123456789');
    const router = createToolRouter(createRegistry({ app: f.app, datasets, dataDir: f.dir, emit: () => {}, files: {} }), { authorize: require('../src/ai/access-policy').createAccessPolicy({ checkLicense: async () => ({ status: 'Active' }) }).authorize, signal: new AbortController().signal, audit: () => {}, status: () => {} });
    for (const [name, args] of [['shell', {}], ['invoice.search', { sql: 'DROP TABLE invoices' }], ['invoice.search', { from: 'bad' }], ['file.export_excel', { datasetId: value.datasetId, filename: '../outside.xlsx' }], ['js.execute_safe', { datasetId: 'other', code: 'return input' }]]) assert.equal((await router.execute(name, JSON.stringify(args))).ok, false);
    await f.app.select('9999999999');
    assert.equal((await router.execute('data.analyze', { datasetId: value.datasetId })).ok, false);
    for (let i = 0; i < 4; i++) assert.equal((await router.execute('invoice.read', { key: 'x', secret: true })).ok, false);
    assert.equal(fs.existsSync(path.join(f.dir, 'ai-exports')), false);
  } finally { f.cleanup(); }
});
test('QuickJS isolates Node APIs, constructor escapes, infinite loops, large outputs and cancellation', async () => {
  assert.deepEqual(await executeSafeJs('return input.filter(x=>helpers.number(x.total)>10)', [{ total: 20 }, { total: 5 }]), [{ total: 20 }]);
  const missing = await executeSafeJs('return [typeof process,typeof require,typeof fetch,typeof Buffer,typeof global,typeof module]', []);
  assert.deepEqual(missing, Array(6).fill('undefined'));
  await assert.rejects(executeSafeJs('return input.constructor.constructor("return process")()', []));
  await assert.rejects(executeSafeJs('while(true){}', []));
  await assert.rejects(executeSafeJs('return "x".repeat(100000000)', []));
  const controller = new AbortController(); controller.abort(); await assert.rejects(executeSafeJs('return 1', [], controller.signal));
});
test('structured JSON fallback and task step limit work without native tool support', async () => {
  const f = fixture(); let calls = 0;
  try {
    const turn = await callAI({ config: { endpoint: 'https://example.com', apiKey: 'test-key', model: 'fixture' }, messages: [], tools: [], signal: new AbortController().signal,
      fetchImpl: async (_, options) => { calls++; if (calls === 1) return new Response('tool calling not supported', { status: 400 }); assert.equal(JSON.parse(options.body).tools, undefined); return response({ content: '{"type":"tool_call","tool":"mst.get_selected","arguments":{}}' }); } });
    assert.equal(turn.calls[0].function.name, 'mst.get_selected');
    await assert.rejects(runAgent({ checkLicense: async () => ({ status: 'Active' }), config: { endpoint: 'https://example.com', apiKey: 'test-key', model: 'fixture' }, history: [], text: 'x', screen: {}, app: f.app, dataDir: f.dir, files: {}, emit: () => {}, signal: new AbortController().signal, fetchImpl: async () => tool('mst__get_selected', {}) }), /12 lượt/);
  } finally { f.cleanup(); }
});
// Chế độ 'agent' ưu tiên đường qua Gateway (app KHÔNG cầm API key). Test này
// khẳng định đúng thứ tự ưu tiên: có Gateway thì gọi Gateway, không có thì rơi
// về key trên máy như cũ — và token phiên của Gateway không bao giờ ghi ra đĩa.
test('AUTO uses Gateway; MANUAL retains local API even when Gateway is available', async () => {
  const f = fixture(); let service;
  const base = { dataDir: f.dir, secrets: f.secrets, app: f.app, checkLicense: async () => ({ status: 'Active' }), licenseSignature: () => 'active' };
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url: String(url), authorization: String(options.headers.Authorization || '') }); return response({ content: 'Xin chào từ AI.' }); };
  async function run(target, body) {
    const req = new EventEmitter(); req.method = 'POST';
    const res = new EventEmitter(); res.output = ''; res.writeHead = () => { res.headersSent = true; }; res.write = s => { res.output += s; }; res.end = () => {};
    await service.handle(req, res, new URL(target, 'http://localhost'), async () => body, (_, status, result) => { res.status = status; res.result = result; });
    return res;
  }
  const relay = { baseURL: 'https://gateway.test/v1/ai/chat/completions', token: 'token-phien-cua-gateway' };
  try {
    // 1. Có Gateway và chưa có key cục bộ: phải gọi Gateway bằng token phiên.
    service = createAiService({ ...base, fetchImpl, agentGateway: () => relay });
    await run('/api/ai/stream', { id: 'agent', text: 'Hỏi thử' });
    assert.equal(seen.at(-1).url, relay.baseURL, 'phải gọi qua Gateway, không gọi thẳng OpenRouter');
    assert.equal(seen.at(-1).authorization, 'Bearer ' + relay.token);
    // Token phiên phải chỉ nằm trong RAM: không ghi vào cấu hình, không ghi vào đĩa.
    const stored = fs.existsSync(path.join(f.dir, 'ai-providers.json')) ? fs.readFileSync(path.join(f.dir, 'ai-providers.json'), 'utf8') : '';
    assert.equal(stored.includes('token-phien-cua-gateway'), false, 'token phiên không được ghi xuống đĩa');
    service.close();

    // AUTO never silently replaces the central configuration with a local key.
    seen.length = 0;
    f.secrets.write('ai-agent', { token: 'khoa-cuc-bo' });
    service = createAiService({ ...base, fetchImpl, agentGateway: () => null });
    await assert.rejects(run('/api/ai/stream',{id:'agent',text:'Hỏi thử'}),/Cloudflare/);
    await run('/api/ai/providers',{provider:{...providers.defaults()[0],routingMode:'manual'}});
    service.close();service=createAiService({...base,fetchImpl,agentGateway:()=>relay});
    await run('/api/ai/stream', { id: 'agent', text: 'Hỏi thử' });
    assert.equal(seen.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(seen.at(-1).authorization, 'Bearer khoa-cuc-bo');
  } finally { service?.close(); f.cleanup(); }
});
test('service protects keys and license, persists conversation, rejects old web storage route', async () => {
  const f = fixture(); let service;
  const options = { dataDir: f.dir, secrets: f.secrets, app: f.app, checkLicense: async () => ({ status: 'Active' }), licenseSignature: () => 'active', fetchImpl: async () => response({ content: 'Xin chào từ AI.' }) };
  async function run(route, body, method = 'POST') {
    const req = new EventEmitter(); req.method = method;
    const res = new EventEmitter(); res.output = ''; res.writeHead = () => { res.headersSent = true; }; res.write = s => { res.output += s; }; res.end = () => {};
    await service.handle(req, res, new URL(route, 'http://localhost'), async () => body, (_, status, result) => { res.status = status; res.result = result; }); return res;
  }
  try {
    service = createAiService(options);
    const saved = await run('/api/ai/providers', { provider: {...providers.defaults()[0],routingMode:'manual'}, apiKey: 'secret-key' });
    assert.equal(JSON.stringify(saved.result).includes('secret-key'), false);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ai-providers.json'), 'utf8').includes('secret-key'), false);
    await assert.rejects(run('/api/ai/models', { provider: { ...providers.defaults()[0], baseURL: 'https://different.example/v1' } }), /API key/);
    assert.equal((await run('/api/ai/storage', { key: 'token', value: 'secret' })).status, 404);
    const result = await run('/api/ai/stream', { id: 'agent', text: 'Hướng dẫn sử dụng' }); assert.ok(result.output.includes('"done":true'));
    service.close(); service = createAiService(options);
    assert.equal((await run('/api/ai/history?id=agent', null, 'GET')).result.value[1].content, 'Xin chào từ AI.');
    const denied = createAiService({ ...options, checkLicense: async () => { throw new Error('locked'); } });
    await assert.rejects(denied.handle({ method: 'POST' }, {}, new URL('http://localhost/api/ai/stream'), () => { throw new Error('must not read'); }, () => {}), /locked/);
  } finally { service?.close(); f.cleanup(); }
});
test('AUTO refreshes central metadata and receives a changed revision/model without restart or exposing the key',async()=>{
  const f=fixture();const relay={baseURL:'https://gateway.test/v1/ai/chat/completions',configURL:'https://gateway.test/v1/ai/config',token:'session-token'};let upstreamRevision=31;const seen=[];
  const service=createAiService({dataDir:f.dir,secrets:f.secrets,app:f.app,checkLicense:async()=>({status:'Active'}),agentGateway:()=>relay,fetchImpl:async(url,o)=>{seen.push({url,body:o.body&&JSON.parse(o.body)});assert.equal(o.headers.Authorization,'Bearer session-token');if(url===relay.configURL)return Response.json({ok:true,value:{revision:31,active:{model:'model-A'}}});const r=response({content:'OK'});r.headers.set('X-AI-Revision',String(upstreamRevision));r.headers.set('X-AI-Model',upstreamRevision===31?'model-A':'model-B');return r;}});
  const run=async(route,body,method='POST')=>{const req=new EventEmitter();req.method=method;const res=new EventEmitter();res.output='';res.writeHead=()=>{};res.write=s=>res.output+=s;res.end=()=>{};await service.handle(req,res,new URL(route,'http://localhost'),async()=>body,(_,status,result)=>{res.result=result});return res;};
  try{const initial=await run('/api/ai/providers',null,'GET');assert.equal(initial.result.value.cloudConfig.revision,31);upstreamRevision=32;const turn=await run('/api/ai/stream',{id:'agent',text:'Hi'});assert.match(turn.output,/"configRevision":32/);assert.match(turn.output,/"cloudModel":"model-B"/);assert.ok(seen.at(-1).body.metadata.conversation_id);const refreshed=await run('/api/ai/providers',null,'GET');assert.equal(refreshed.result.value.cloudConfig.revision,32);assert.equal(JSON.stringify(refreshed.result).includes(relay.token),false);}finally{service.close();f.cleanup();}
});
