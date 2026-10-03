'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const bridge = require('../src/ai-bridge');
const providers = require('../src/ai-providers');
const { createAiService, licenseGate } = require('../src/ai-service');

test('bridge echoes messageId, permits only chat keys, never reads page or fingerprint', async () => {
  const values = new Map(); const store = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const request = { type: 'storageRequest', operation: 'set', key: 'savedChats-v1', messageId: 'req-1', value: ['hello'] };
  assert.equal((await bridge.buildResponse(request, store)).messageId, 'req-1');
  assert.deepEqual((await bridge.buildResponse({ ...request, operation: 'get' }, store)).value, ['hello']);
  for (const key of ['fp-v1', 'fpHash-v1', '__proto__', 'token']) {
    assert.equal((await bridge.buildResponse({ ...request, key }, store)).value, null);
    assert.equal(values.has(key), false);
  }
  for (const data of [JSON.stringify(request), { ...request, messageId: '' }, { ...request, type: 'pageContentRequest' }]) assert.equal(await bridge.buildResponse(data, store), null);
});
test('provider validation restricts embed domains, local hosts and key transport', () => {
  for (const url of ['javascript:alert(1)', 'file:///secret', 'http://evil.com', 'https://user:pass@api.example.com', 'https://api.example.com?key=secret']) assert.equal(providers.parseBaseUrl(url, 'openai'), null);
  assert.ok(providers.parseBaseUrl('http://localhost:11434/v1', 'local'));
  assert.equal(providers.parseBaseUrl('https://external.example/v1', 'local'), null);
  assert.equal(providers.isSafeEmbedUrl('https://deepseek-ai.easytool.dev.evil.com'), false);
  assert.equal(providers.isSafeEmbedUrl('https://127.0.0.1'), false);
  for (const p of providers.defaults()) assert.deepEqual(providers.normalizeProvider(p), p);
  assert.throws(() => providers.normalizeProvider({ id: '../../accounts', label: 'bad', type: 'web' }));
  assert.throws(() => providers.normalizeProvider({ ...providers.defaults()[0], id: '__proto__' }));
});
test('license cache coalesces requests, expires, invalidates on license change, retries failures', async () => {
  let calls = 0, time = 1, signature = 'trial', fail = false;
  const gate = licenseGate(async () => { calls++; if (fail) throw new Error('locked'); }, () => signature, () => time);
  await Promise.all(Array.from({ length: 14 }, () => gate())); assert.equal(calls, 1);
  await gate(); assert.equal(calls, 1);
  signature = 'active'; await gate(); assert.equal(calls, 2);
  time += 600001; await gate(); assert.equal(calls, 3);
  signature = 'locked'; fail = true; await assert.rejects(gate()); await assert.rejects(gate()); assert.equal(calls, 5);
});
test('AI service keeps keys secret, isolates storage, streams and persists chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-ai-'));
  const vault = new Map(); let seen;
  const secrets = { read: id => ({ token: vault.get(id) || '' }), write: (id, p) => vault.set(id, p.token), clear: id => vault.delete(id) };
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return new Response('data: {"choices":[{"delta":{"content":"Xin chào"}}]}\r\n\r\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const options = { dataDir: dir, secrets, checkLicense: async () => {}, licenseSignature: () => 'active', fetchImpl };
  let service = createAiService(options);
  async function run(route, body, method = 'POST') {
    const req = new EventEmitter(); req.method = method;
    const res = new EventEmitter(); res.output = ''; res.writeHead = () => { res.headersSent = true; }; res.write = s => { res.output += s; }; res.end = () => {};
    await service.handle(req, res, new URL(route, 'http://localhost'), async () => body, (_, status, result) => { res.status = status; res.result = result; });
    return res;
  }
  try {
    const p = { id: 'mine', label: 'My AI', type: 'openai', baseURL: 'https://api.example.com/v1', model: 'test' };
    const saved = await run('/api/ai/providers', { provider: p, apiKey: 'secret-key' });
    assert.equal(JSON.stringify(saved.result).includes('secret-key'), false);
    assert.equal(fs.readFileSync(path.join(dir, 'ai-providers.json'), 'utf8').includes('secret-key'), false);
    await assert.rejects(run('/api/ai/models', { provider: { ...p, baseURL: 'https://evil.example/v1' } }), /API key/);
    await run('/api/ai/storage', { providerId: 'web-deepseek-ai', key: 'savedChats-v1', value: ['chat'] });
    await run('/api/ai/storage', { providerId: 'web-deepseek-ai', key: 'token', value: 'secret' });
    assert.equal(fs.readFileSync(path.join(dir, 'ai-storage.json'), 'utf8').includes('secret'), false);
    const isolated = await run('/api/ai/storage?providerId=web-grok-ai&key=savedChats-v1', null, 'GET'); assert.equal(isolated.result.value, null);
    const result = await run('/api/ai/stream', { id: 'mine', text: 'hello' });
    assert.ok(result.output.includes('Xin chào')); assert.ok(result.output.includes('"done":true'));
    assert.equal(seen.options.headers.Authorization, 'Bearer secret-key'); assert.equal(seen.options.redirect, 'error');
    assert.deepEqual(JSON.parse(seen.options.body).messages, [{ role: 'user', content: 'hello' }]);
    service = createAiService(options);
    const loaded = await run('/api/ai/history?id=mine', null, 'GET'); assert.equal(loaded.result.value[1].content, 'Xin chào');
    await run('/api/ai/providers', { provider: { ...p, baseURL: 'https://different.example/v1' } }); assert.equal(vault.has('ai-mine'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('AI endpoints refuse license denial before reading request data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-ai-denied-'));
  try {
    const service = createAiService({ dataDir: dir, secrets: {}, checkLicense: async () => { throw new Error('locked'); }, licenseSignature: () => 'locked' });
    await assert.rejects(service.handle({ method: 'POST' }, {}, new URL('http://localhost/api/ai/storage'), () => { throw new Error('must not read'); }, () => {}), /locked/);
    assert.equal(fs.existsSync(path.join(dir, 'ai-storage.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
