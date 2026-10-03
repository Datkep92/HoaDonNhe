'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./core');
const providers = require('./ai-providers');
const bridge = require('./ai-bridge');

function licenseGate(check, signature, now = Date.now) {
  let expires = 0, stamp = '', pending = null;
  return async () => {
    if (expires > now() && stamp === signature()) return;
    if (!pending) pending = Promise.resolve().then(check).then(() => {
      stamp = signature(); expires = now() + 10 * 60 * 1000;
    }).finally(() => { pending = null; });
    await pending;
  };
}
function createAiService({ dataDir, secrets, checkLicense, licenseSignature, fetchImpl = fetch }) {
  const files = { providers: path.join(dataDir, 'ai-providers.json'), storage: path.join(dataDir, 'ai-storage.json'), history: path.join(dataDir, 'ai-history.json') };
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Không đọc được dữ liệu AI đã lưu.'); }
  }
  const config = read(files.providers, { active: 'support', providers: providers.defaults() });
  config.providers = config.providers.map(providers.normalizeProvider);
  let storage = read(files.storage, {}), history = read(files.history, {});
  const gate = licenseGate(checkLicense, licenseSignature);
  const keyId = id => 'ai-' + id;
  function publicConfig() { return { active: config.active, providers: config.providers.map(p => ({ ...p, hasKey: !!secrets.read(keyId(p.id), ['token']).token })) }; }
  function provider(id) { const p = config.providers.find(p => p.id === id); if (!p) throw new Error('Không tìm thấy chế độ AI.'); return p; }
  const save = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2));
  function endpoint(p, suffix) { return p.baseURL.replace(/\/$/, '') + suffix; }
  function headers(p) {
    const saved = config.providers.find(item => item.id === p.id);
    const token = saved?.baseURL === p.baseURL && saved?.type === p.type ? secrets.read(keyId(p.id), ['token']).token : '';
    if (p.type === 'openai' && !token) throw new Error('Chưa lưu API key cho chế độ này.');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  }
  async function request(p, suffix, options = {}) {
    const result = await fetchImpl(endpoint(p, suffix), { ...options, headers: headers(p), redirect: 'error', signal: options.signal || AbortSignal.timeout(30000) });
    if (!result.ok) { await result.body?.cancel(); throw new Error(`Máy chủ AI trả lỗi ${result.status}.`); }
    return result;
  }
  const activeStreams = new Set();
  async function handle(req, res, url, readBody, reply) {
    if (!url.pathname.startsWith('/api/ai/')) return false;
    await gate();
    const input = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    const send = value => reply(res, 200, { ok: true, value });
    if (url.pathname === '/api/ai/providers' && req.method === 'GET') send(publicConfig());
    else if (url.pathname === '/api/ai/providers' && req.method === 'POST') {
      if (input.action === 'active') {
        if (input.id !== 'support') provider(input.id);
        config.active = input.id;
      } else if (input.action === 'delete') {
        provider(input.id);
        if (activeStreams.has(input.id)) throw new Error('Dừng trả lời trước khi xoá chế độ.');
        config.providers = config.providers.filter(p => p.id !== input.id);
        secrets.clear(keyId(input.id)); delete history[input.id]; delete storage[input.id];
        save(files.history, history); save(files.storage, storage);
        if (config.active === input.id) config.active = 'support';
      } else {
        const p = providers.normalizeProvider(input.provider);
        if (activeStreams.has(p.id)) throw new Error('Dừng trả lời trước khi sửa chế độ.');
        if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(input.apiKey))) throw new Error('API key không hợp lệ.');
        const index = config.providers.findIndex(item => item.id === p.id);
        const previous = config.providers[index];
        if (previous && (previous.baseURL !== p.baseURL || previous.type !== p.type)) secrets.clear(keyId(p.id));
        if (input.apiKey) secrets.write(keyId(p.id), { token: input.apiKey });
        if (input.clearKey || p.type !== 'openai') secrets.clear(keyId(p.id));
        if (index < 0) config.providers.push(p); else config.providers[index] = p;
      }
      save(files.providers, config); send(publicConfig());
    } else if (url.pathname === '/api/ai/storage' && ['POST', 'GET'].includes(req.method)) {
      const p = provider(input.providerId);
      if (p.type !== 'web') throw new Error('Chế độ không dùng cầu nối web.');
      if (!bridge.isAllowedKey(input.key) || bridge.ALWAYS_NULL.includes(input.key)) send(null);
      else if (req.method === 'GET') send(storage[p.id]?.[input.key] ?? null);
      else {
        const next = { ...storage, [p.id]: { ...storage[p.id], [input.key]: input.value ?? null } };
        if (Buffer.byteLength(JSON.stringify(next)) > 10 * 1024 * 1024) throw new Error('Lịch sử web vượt giới hạn 10 MB.');
        save(files.storage, next); storage = next; send(null);
      }
    } else if (url.pathname === '/api/ai/history' && ['GET', 'POST'].includes(req.method)) {
      const p = provider(input.id);
      if (req.method === 'POST') {
        if (activeStreams.has(p.id)) throw new Error('Dừng trả lời trước khi xoá cuộc trò chuyện.');
        delete history[p.id]; save(files.history, history);
      }
      send(history[p.id] || []);
    } else if (url.pathname === '/api/ai/models' && req.method === 'POST') {
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(input.apiKey))) throw new Error('API key không hợp lệ.');
      const p = input.provider ? providers.normalizeProvider(input.provider) : provider(input.id);
      if (p.type === 'web') throw new Error('AI web không có danh sách model API.');
      // A draft key is used only for this request and is never returned to the browser.
      const result = await fetchImpl(endpoint(p, '/models'), {
        headers: input.apiKey ? { Authorization: 'Bearer ' + input.apiKey } : headers(p),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!result.ok) { await result.body?.cancel(); throw new Error(`Không lấy được model (${result.status}).`); }
      send((await result.json()).data?.map(item => String(item.id)) || []);
    } else if (url.pathname === '/api/ai/stream' && req.method === 'POST') {
      const p = provider(input.id);
      const text = String(input.text || '').trim();
      if (p.type === 'web' || !text || text.length > 16000) throw new Error('Tin nhắn AI không hợp lệ.');
      if (activeStreams.has(p.id)) throw new Error('AI đang trả lời một tin nhắn khác.');
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      const timer = setTimeout(abort, 180000);
      activeStreams.add(p.id);
      let answer = '';
      const messages = [...(history[p.id] || []).slice(-40), { role: 'user', content: text }];
      try {
        const upstream = await request(p, '/chat/completions', { method: 'POST', signal: controller.signal, body: JSON.stringify({ model: p.model, messages, stream: true }) });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const emit = value => { if (!res.destroyed) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
        let buffer = '', done = false;
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 1024 * 1024) throw new Error('Phản hồi AI không hợp lệ.');
          let boundary;
          while ((boundary = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, boundary).trim(); buffer = buffer.slice(boundary + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { done = true; break; }
            const value = JSON.parse(data);
            if (value.error) throw new Error('Máy chủ AI báo lỗi khi trả lời.');
            const delta = value.choices?.[0]?.delta?.content;
            if (typeof delta === 'string') {
              answer += delta;
              if (answer.length > 200000) throw new Error('Câu trả lời quá dài.');
              emit({ delta });
            }
          }
          if (done) break;
        }
        if (!answer) throw new Error('AI chưa trả về nội dung.');
        history[p.id] = [...messages, { role: 'assistant', content: answer }].slice(-40);
        save(files.history, history); emit({ done: true }); res.end();
      } catch (error) {
        if (!res.headersSent) throw error;
        if (!res.destroyed) { res.write('data: ' + JSON.stringify({ error: 'Không hoàn tất câu trả lời AI. Thử lại hoặc kiểm tra kết nối.' }) + '\n\n'); res.end(); }
      } finally {
        controller.abort(); clearTimeout(timer); res.off('close', abort); activeStreams.delete(p.id);
      }
    } else reply(res, 404, { ok: false, error: 'Không có chức năng AI này.' });
    return true;
  }
  return { handle };
}
module.exports = { createAiService, licenseGate };
