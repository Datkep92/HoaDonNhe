'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./core');
const providers = require('./ai-providers');
const { loadConfig } = require('./ai/config');
const { runAgent } = require('./ai/agent');
const { createAttachments } = require('./ai/attachments');
const { createAccessPolicy } = require('./ai/access-policy');
const { createSessionStore } = require('./ai/session-store');
const identity = require('./ai/identity');
const { buildContext, explicitMemory } = require('./ai/context-manager');
const { createPermissionEngine } = require('./ai/permission-engine');

function licenseGate(check, signature, now = Date.now) {
  // Compatibility export; authoritative service owns all caching/offline policy.
  // Every protected route/tool checks again, including revoke during a task.
  return () => Promise.resolve().then(check);
}
function createAiService({ dataDir, secrets, app, checkLicense, licenseSignature, fetchImpl = fetch }) {
  const files = { providers: path.join(dataDir, 'ai-providers.json'), history: path.join(dataDir, 'ai-history.json') };
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Không đọc được dữ liệu AI đã lưu.'); }
  }
  const config = read(files.providers, { active: 'support', providers: providers.defaults() });
  // Retire saved free web modes without losing API/local providers or their keys.
  const retired = config.providers.filter(p => p.type === 'web');
  config.providers = config.providers.filter(p => p.type !== 'web').map(providers.normalizeProvider);
  let renamed = false;
  for (const p of config.providers) if (p.id === 'agent' && p.label !== identity.agentName) { p.label = identity.agentName; renamed = true; }
  const missingAgent = !config.providers.some(p => p.id === 'agent');
  if (missingAgent) config.providers.unshift(...providers.defaults());
  if (!config.providers.some(p => p.id === config.active)) config.active = 'support';
  if (retired.length || missingAgent || renamed) atomicWrite(files.providers, JSON.stringify(config, null, 2));
  let history = read(files.history, {});
  const exportFile = path.join(dataDir, 'ai-export-files.json');
  const exported = read(exportFile, {});
  const environment = loadConfig(dataDir);
  const access = createAccessPolicy({ checkLicense });
  const gate = access.license;
  let store;
  const sessions = () => store || (store = createSessionStore(dataDir));
  function companyId() {
    const value = app?.context().currentUser?.selectedMst;
    if (value === '') return 'GLOBAL'; // Explicit no-company app state: knowledge/files workspace.
    if (!/^\d{10}(?:-?\d{3})?$/.test(value || '')) throw new Error('Không xác định được phạm vi công ty.');
    return value;
  }
  const sessionOf = p => sessions().resolve(p.id, companyId());
  let permissionStore;
  const permissionEngine = () => permissionStore || (permissionStore = createPermissionEngine(dataDir));
  const permissionContext = session => ({ sessionId: session.id, companyId: companyId(), workspace: path.resolve(dataDir), application: identity.productName, ...(app.permissionContext?.() || {}) });
  const keyId = id => 'ai-' + id;
  function publicConfig() { return { active: config.active, identity, flags: access.flags, legacyHistoryAvailable: Object.keys(history).length > 0, companyId: app ? companyId() : null, providers: config.providers.map(p => ({ ...p, hasKey: !!secrets.read(keyId(p.id), ['token']).token || (p.id === 'agent' && !!environment.apiKey) })) }; }
  function provider(id) { const p = config.providers.find(p => p.id === id); if (!p) throw new Error('Không tìm thấy chế độ AI.'); return p; }
  const save = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2));
  function endpoint(p, suffix) { return p.baseURL.replace(/\/$/, '') + suffix; }
  function headers(p) {
    const saved = config.providers.find(item => item.id === p.id);
    const token = saved?.baseURL === p.baseURL && saved?.type === p.type ? secrets.read(keyId(p.id), ['token']).token : '';
    if (p.type === 'openai' && !token) throw new Error('Chưa lưu API key cho chế độ này.');
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  }
  const activeStreams = new Set();
  const activeControllers = new Set(); let closing = false;
  const closeStores = () => { permissionStore?.close(); permissionStore = null; store?.close(); store = null; };
  const uploads = createAttachments(dataDir);
  async function handle(req, res, url, readBody, reply) {
    if (!url.pathname.startsWith('/api/ai/')) return false;
    if (closing) throw new Error('AI đang đóng; yêu cầu chưa bắt đầu sẽ không chạy.');
    await gate();
    if (url.pathname === '/api/ai/upload' && req.method === 'POST') {
      const p = provider(url.searchParams.get('id'));
      const requestedCompany = url.searchParams.get('companyId');
      if (requestedCompany && requestedCompany !== companyId()) throw new Error('MST đã đổi; gửi lại file trong công ty hiện tại.');
      const file = await uploads.upload(req, url.searchParams.get('filename'), p.id, companyId(), {
        role: url.searchParams.get('role') === 'derived' ? 'derived' : 'source',
        sourceId: url.searchParams.get('source') || undefined,
      });
      reply(res, 200, { ok: true, value: file }); return true;
    }
    const input = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
    const send = value => reply(res, 200, { ok: true, value });
    const scopedFile = id => {
      if (!/^[a-f0-9-]{36}$/.test(id || '') || !exported[id]) throw new Error('Không tìm thấy file AI.');
      if (exported[id].companyId !== companyId()) throw new Error('File không thuộc phạm vi công ty hiện tại; file cũ vẫn được giữ trong thư mục xuất.');
      return exported[id];
    };
    if (url.pathname === '/api/ai/approvals' && req.method === 'POST') {
      const p = provider(input.id), session = sessionOf(p);
      send(permissionEngine().decide(input, permissionContext(session)));
    } else if (url.pathname === '/api/ai/permissions' && ['GET', 'POST'].includes(req.method)) {
      const p = provider(input.id), session = sessionOf(p), context = permissionContext(session);
      if (req.method === 'POST') permissionEngine().revoke(input.approvalId, context);
      send(permissionEngine().list(context));
    } else if (url.pathname === '/api/ai/providers' && req.method === 'GET') send(publicConfig());
    else if (url.pathname === '/api/ai/providers' && req.method === 'POST') {
      if (input.action === 'active') {
        if (input.id !== 'support') provider(input.id);
        config.active = input.id;
      } else if (input.action === 'delete') {
        provider(input.id);
        if (input.id === 'agent') throw new Error('AI Agent là chế độ tích hợp; có thể sửa cấu hình hoặc xoá key.');
        if (activeStreams.has(input.id)) throw new Error('Dừng trả lời trước khi xoá chế độ.');
        config.providers = config.providers.filter(p => p.id !== input.id);
        secrets.clear(keyId(input.id)); delete history[input.id];
        save(files.history, history);
        if (config.active === input.id) config.active = 'support';
      } else {
        const p = providers.normalizeProvider(input.provider);
        if (p.id === 'agent') { p.label = identity.agentName; if (p.type !== 'openai') throw new Error('CNTaxTools dùng API tương thích OpenAI.'); }
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
    } else if (url.pathname === '/api/ai/history/legacy' && req.method === 'GET') {
      provider(input.id); send({ scope: 'UNKNOWN', readOnly: true, rows: (history[input.id] || []).slice(-80) });
    } else if (url.pathname === '/api/ai/history' && ['GET', 'POST'].includes(req.method)) {
      const p = provider(input.id);
      const session = sessionOf(p);
      if (req.method === 'POST') {
        if (activeStreams.has(p.id)) throw new Error('Dừng trả lời trước khi xoá cuộc trò chuyện.');
        sessions().clear(session);
        permissionStore?.clearSession(session.id);
      }
      send(sessions().history(session));
    } else if (url.pathname === '/api/ai/models' && req.method === 'POST') {
      if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(input.apiKey))) throw new Error('API key không hợp lệ.');
      const p = input.provider ? providers.normalizeProvider(input.provider) : provider(input.id);
      // A draft key is used only for this request and is never returned to the browser.
      const result = await fetchImpl(endpoint(p, '/models'), {
        headers: input.apiKey ? { Authorization: 'Bearer ' + input.apiKey } : headers(p),
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!result.ok) { await result.body?.cancel(); throw new Error(`Không lấy được model (${result.status}).`); }
      send((await result.json()).data?.map(item => String(item.id)) || []);
    } else if (url.pathname === '/api/ai/file/preview' && req.method === 'GET') {
      scopedFile(input.id);
      send(read(path.join(dataDir, 'ai-exports', input.id + '.json'), { total: 0, rows: [] }));
    } else if (url.pathname === '/api/ai/file/open' && req.method === 'POST') {
      if (!['file', 'folder'].includes(input.action)) throw new Error('Thao tác không hợp lệ.');
      const file = scopedFile(input.id);
      if (!['.xlsx', '.csv', '.txt', '.md'].includes(file.ext)) throw new Error('Định dạng file không hợp lệ.');
      const filePath = path.join(dataDir, 'ai-exports', input.id + file.ext);
      if (!fs.existsSync(filePath)) throw new Error('File xuất không còn tồn tại.');
      await app.openExport(input.action === 'folder' ? path.dirname(filePath) : filePath); send({ opened: true });
    } else if (url.pathname === '/api/ai/file' && req.method === 'GET') {
      const file = scopedFile(input.id);
      if (!file || !['.xlsx', '.csv', '.txt', '.md'].includes(file.ext)) throw new Error('Không tìm thấy file AI.');
      const filePath = path.join(dataDir, 'ai-exports', input.id + file.ext);
      const stat = fs.statSync(filePath);
      res.writeHead(200, { 'Content-Type': file.ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/plain; charset=utf-8', 'Content-Length': stat.size,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } else if (url.pathname === '/api/ai/stream' && req.method === 'POST') {
      const p = provider(input.id);
      if (input.companyId && input.companyId !== companyId()) throw new Error('MST đã đổi; tin nhắn chờ không được chuyển sang công ty khác.');
      const session = sessionOf(p), turnHistory = sessions().history(session, 80);
      const text = String(input.text || '').trim();
      if (!text || text.length > 16000) throw new Error('Tin nhắn AI không hợp lệ.');
      const ids = input.attachments || [];
      if (!Array.isArray(ids) || ids.length > 4 || !ids.every(id => typeof id === 'string')) throw new Error('Tối đa 4 file mỗi tin nhắn.');
      const currentAttachments = ids.map(id => uploads.load(id, p.id, session.companyId));
      const recentIds = [...new Set([...turnHistory.flatMap(row => (row.attachments || []).map(f => f.id)), ...ids])].slice(-4);
      const attachments = recentIds.map(id => uploads.load(id, p.id, session.companyId));
      if (attachments.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024) throw new Error('Tổng file trong ngữ cảnh vượt 24 MB. Mở Chat mới hoặc chọn file nhỏ hơn.');
      const options = { web: input.options?.web === true, python: input.options?.python === true };
      if (activeStreams.has(p.id)) throw new Error('AI đang trả lời một tin nhắn khác.');
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      const timer = setTimeout(abort, 180000);
      activeStreams.add(p.id);
      activeControllers.add(controller);
      const userMessage = { role: 'user', content: text, attachments: currentAttachments.map(uploads.publicRecord) };
      sessions().append(session, userMessage);
      const jobId = sessions().startJob(session);
      let completed = false; const turnFiles = [];
      try {
        const memory = explicitMemory(text);
        const memoryWrite = memory ? sessions().remember(session, memory) : null;
        const contextBundle = buildContext({ store: sessions(), session, text, dropLatestUser: true });
        contextBundle.memoryWrite = memoryWrite;
        const contextTools = {
          searchHistory: query => sessions().searchHistory(session, query, 5),
          memories: query => sessions().memories(session, query, 5).map(row => ({ ...row, content: row.content.slice(0, 1000) })),
          reference: name => { const value = sessions().references(session)[name]; if (!value) throw Object.assign(new Error('Chưa có tham chiếu này trong công ty hiện tại.'), { code: 'FILE_NOT_FOUND' }); return value; },
        };
        const token = secrets.read(keyId(p.id), ['token']).token;
        const useEnvironment = p.id === 'agent' && !token && !!environment.apiKey;
        const aiConfig = useEnvironment ? environment : { endpoint: endpoint(p, '/chat/completions'), model: p.model, apiKey: token || (p.type === 'local' ? 'ollama' : '') };
        if (!aiConfig.apiKey) throw new Error('Chưa cấu hình API key. Bấm Cấu hình để lưu key cho AI Agent.');
        if (!app) throw new Error('Dịch vụ ứng dụng chưa sẵn sàng cho AI Agent.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const emit = value => { if (!res.destroyed) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
        const screen = { currentPage: /^[a-z-]{1,40}$/.test(input.screen?.currentPage || '') ? input.screen.currentPage : 'unknown', filters: {} };
        for (const key of ['from', 'to', 'direction']) if (typeof input.screen?.filters?.[key] === 'string' && input.screen.filters[key].length <= 20) screen.filters[key] = input.screen.filters[key];
        let streamed = false;
        const answer = await runAgent({ config: aiConfig, history: turnHistory, text, screen, app, dataDir, files: exported, signal: controller.signal, fetchImpl, attachments, attachmentParts: uploads.parts(attachments), options, checkLicense, session, contextBundle, contextTools,
          // Cho tool PDF đọc được bytes GỐC của file đính kèm + lần về bản gốc khi gặp bản dẫn xuất (.pdf.txt).
          attachmentFiles: { bytes: record => uploads.bytes(record), source: record => uploads.sourceRecord(record) },
          permissionContext: () => permissionContext(session), permissions: { consume: (...args) => permissionEngine().consume(...args) },
          requestApproval: async (tool, args, context) => {
            sessions().updateJob(jobId, 'waiting_approval', tool.name);
            emit({ status: 'Đang chờ bạn phê duyệt…' });
            const evidence = await permissionEngine().request(tool, args, context, controller.signal, request => emit({ approval_required: request }));
            sessions().updateJob(jobId, 'running', tool.name); return evidence;
          },
          emit: value => {
            if (value.delta) streamed = true;
            if (value.reset) streamed = false;
            if (value.status) sessions().updateJob(jobId, 'running', value.status);
            if (value.file) { value.file.companyId = session.companyId; exported[value.file.fileId].companyId = session.companyId; exported[value.file.fileId].verified = true; save(exportFile, exported); turnFiles.push(value.file); }
            emit(value);
          } });
        controller.signal.throwIfAborted();
        sessions().append(session, { role: 'assistant', content: answer, files: turnFiles });
        emit(streamed ? { replace: answer } : { delta: answer });
        sessions().updateJob(jobId, 'completed'); completed = true; emit({ done: true, sessionId: session.id, companyId: session.companyId, selectedCompanyId: companyId(), jobId }); res.end();
      } catch (error) {
        sessions().append(session, { role: 'assistant', content: 'Không hoàn tất: ' + (controller.signal.aborted ? 'Tác vụ đã dừng.' : error.message), files: turnFiles });
        if (!res.headersSent) throw error;
        if (!res.destroyed) { res.write('data: ' + JSON.stringify({ reset: true, error: controller.signal.aborted ? 'Tác vụ AI đã dừng hoặc hết thời gian.' : error.message }) + '\n\n'); res.end(); }
      } finally {
        if (!completed) sessions().updateJob(jobId, controller.signal.aborted ? 'cancelled' : 'failed');
        controller.abort(); clearTimeout(timer); res.off('close', abort); activeStreams.delete(p.id);
        activeControllers.delete(controller); if (closing && !activeControllers.size) closeStores();
      }
    } else reply(res, 404, { ok: false, error: 'Không có chức năng AI này.' });
    return true;
  }
  return { handle, close() { closing = true; for (const controller of activeControllers) controller.abort(); permissionStore?.close(); if (!activeControllers.size) closeStores(); } };
}
module.exports = { createAiService, licenseGate };
