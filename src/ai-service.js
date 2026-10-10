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
const { readFeatures } = require('./ai/features');
const { basicChat, attachmentParts } = require('./ai/basic-chat');
const { createRuntime } = require('./ai/free-runtime');
const { createExecutionStore } = require('./ai/execution-store');
const { randomUUID } = require('node:crypto');

function licenseGate(check, signature, now = Date.now) {
  // Compatibility export; authoritative service owns all caching/offline policy.
  // Every protected route/tool checks again, including revoke during a task.
  return () => Promise.resolve().then(check);
}
// agentGateway() trả về null khi không có Gateway/token phiên — cấu hình AI quay
// về key trên máy như trước. Nhận qua tham số để test không phải dựng Gateway giả.
function createAiService({ dataDir, secrets, app, checkLicense, licenseSignature, fetchImpl = fetch, agentGateway = () => null, supportFlow=null }) {
  const features = readFeatures(dataDir);
  const basicProvider = { id: 'basic', label: 'AI Chat miễn phí', type: 'openai', baseURL: '', model: 'auto-free' };
  const runtime = createRuntime(dataDir, { fetchImpl });
  let executionStore;
  const executions = () => executionStore || (executionStore = createExecutionStore(dataDir));
  const files = { providers: path.join(dataDir, 'ai-providers.json'), history: path.join(dataDir, 'ai-history.json') };
  function read(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Không đọc được dữ liệu AI đã lưu.'); }
  }
  const config = read(files.providers, { active: 'support', providers: providers.defaults() });
  // Retire saved free web modes without losing API/local providers or their keys.
  const retired = config.providers.filter(p => p.type === 'web');
  config.providers = config.providers.filter(p => p.type !== 'web').map(providers.normalizeProvider);
  for(const p of config.providers)if(p.id==='agent'&&!p.routingMode)p.routingMode=secrets.read('ai-agent',['token']).token?'manual':'auto';
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
    if (typeof value !== 'string' || !require('./mst-format').isValidMst(value)) throw new Error('Không xác định được phạm vi công ty.');
    return value;
  }
  const sessionOf = p => sessions().resolve(p.id, companyId());
  let permissionStore;
  const permissionEngine = () => permissionStore || (permissionStore = createPermissionEngine(dataDir));
  const permissionContext = session => ({ sessionId: session.id, companyId: companyId(), workspace: path.resolve(dataDir), application: identity.productName, ...(app.permissionContext?.() || {}) });
  const keyId = id => 'ai-' + id;
  let cloudConfig=null,cloudAt=0,cloudRefresh;
  async function refreshCloud() {
    const p=config.providers.find(p=>p.id==='agent');if(p?.routingMode!=='auto'&&!supportFlow)return;
    const relay=agentGateway();if(!relay?.configURL||Date.now()-cloudAt<15000)return;
    if(cloudRefresh)return cloudRefresh;
    cloudRefresh=(async()=>{try{const r=await fetchImpl(relay.configURL,{headers:{Authorization:'Bearer '+relay.token},signal:AbortSignal.timeout(5000),redirect:'error'});if(r.ok){const j=await r.json();if(j.ok){cloudConfig=j.value;cloudAt=Date.now();}}}catch{/* The relay resolves every turn even if metadata refresh is unavailable. */}finally{cloudRefresh=null;}})();
    return cloudRefresh;
  }
  function publicConfig() { return { active: config.active, features, runtime: runtime.status(), cloudConfig, identity, flags: access.flags, legacyHistoryAvailable: Object.keys(history).length > 0, companyId: app ? companyId() : null, providers: [...(features.basic ? [basicProvider] : []), ...config.providers.map(p => ({ ...p,...(p.id==='agent'&&supportFlow?{routingMode:'auto'}:{}),...(p.id==='agent'&&(p.routingMode==='auto'||supportFlow)&&cloudConfig?.active?{cloudModel:cloudConfig.active.model,configRevision:cloudConfig.revision}:{}),hasKey: !!secrets.read(keyId(p.id), ['token']).token || (p.id === 'agent' && !!environment.apiKey) }))] }; }
  function provider(id) { if (id === 'basic' && features.basic) return basicProvider; const p = config.providers.find(p => p.id === id); if (!p) throw new Error('Không tìm thấy chế độ AI.'); return p; }
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
  async function streamBasic(input, res) {
    if (!features.basic) throw Error('AI Chat đã bị tắt bởi Admin.');
    await gate();
    const text = String(input.text || '').trim();
    if (!text || text.length > 16000) throw Error('Tin nhắn không hợp lệ.');
    if (input.companyId && input.companyId !== companyId()) throw Error('MST đã đổi. Gửi lại trong công ty hiện tại.');
    const session = sessionOf(basicProvider), ids = input.attachments || [];
    if (!Array.isArray(ids) || ids.length > 4) throw Error('Tối đa 4 file.');
    const records = ids.map(id => uploads.load(id, 'basic', session.companyId));
    if (records.reduce((n, f) => n + f.size, 0) > 24 * 1024 * 1024) throw Error('Tổng file vượt 24 MB.');
    if (activeStreams.has('basic')) throw Error('AI Chat đang trả lời một tin nhắn khác.');
    const record = executions().begin(input.requestId || randomUUID(), session.id, { mode: 'basic', text, ids });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
    const emit = value => { if (!res.destroyed) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
    if (record.state === 'completed') { emit({ delta: record.answer }); emit({ done: true, requestId: record.id }); res.end(); return true; }
    const controller = new AbortController(), abort = () => controller.abort();
    activeStreams.add('basic'); activeControllers.add(controller); res.on('close', abort);
    const history = sessions().history(session, 80);
    if (!record.userSaved) { sessions().append(session, { role: 'user', content: text, attachments: records.map(uploads.publicRecord) }); record.userSaved = true; executions().finish(record, 'running'); }
    try {
      emit({ status: 'AI Chat đang đọc yêu cầu…' });
      const result = await basicChat({ relay: agentGateway(), sessionId: session.id, history, text,
        parts: await attachmentParts(uploads, records, controller.signal), signal: controller.signal, fetchImpl, transport: runtime.chat });
      await gate(); controller.signal.throwIfAborted();
      if (companyId() !== session.companyId) throw Error('MST đã đổi trong khi xử lý.');
      executions().finish(record, 'completed', result.answer);
      sessions().append(session, { role: 'assistant', content: result.answer });
      emit({ delta: result.answer }); emit({ done: true, requestId: record.id, sessionId: session.id, companyId: session.companyId, cloudModel: result.model });
    } catch (error) { executions().finish(record, controller.signal.aborted ? 'cancelled' : 'failed'); emit({ error: controller.signal.aborted ? 'Đã dừng AI Chat.' : error.message }); }
    finally { res.off('close', abort); controller.abort(); activeStreams.delete('basic'); activeControllers.delete(controller); res.end(); if (closing && !activeControllers.size) closeStores(); }
    return true;
  }
  async function handle(req, res, url, readBody, reply) {
    if (!url.pathname.startsWith('/api/ai/')) return false;
    if (closing) throw new Error('AI đang đóng; yêu cầu chưa bắt đầu sẽ không chạy.');
    if (url.pathname === '/api/ai/requests' && req.method === 'GET') {
      await gate(); const p = provider(url.searchParams.get('id')); reply(res, 200, { ok: true, value: executions().list(sessionOf(p).id) }); return true;
    }
    if (url.pathname === '/api/ai/runtime' && req.method === 'GET') { await gate(); reply(res, 200, { ok: true, value: runtime.status() }); return true; }
    if (url.pathname === '/api/ai/runtime' && req.method === 'POST') {
      await gate(); if (!features.agent) throw Error('Agent đã bị tắt bởi Admin.');
      const input = await readBody(req);
      if (input.action === 'install') { void runtime.install().catch(() => {}); }
      else if (input.action === 'cancel') runtime.cancelInstall();
      else throw Error('Thao tác thành phần không hợp lệ.');
      reply(res, 200, { ok: true, value: runtime.status() }); return true;
    }
    if (url.pathname === '/api/ai/stream' && req.method === 'POST') {
      if (!supportFlow) await gate();
      req.unifiedBody = await readBody(req);
      if (req.unifiedBody.mode === 'basic') return streamBasic(req.unifiedBody, res);
      if (req.unifiedBody.mode === 'agent') {
        if (!features.agent || !runtime.status().installed) throw Error('Agent đã bị tắt bởi Admin.');
        if (!/^[a-f0-9-]{36}$/.test(req.unifiedBody.requestId || '')) throw Error('Thiếu request ID của Agent.');
        req.unifiedBody.unified = false;
      } else if (req.unifiedBody.mode) throw Error('Chế độ chat không hợp lệ.');
    }
    // Human support remains accessible when the license has expired.
    if(url.pathname==='/api/ai/stream'&&req.method==='POST'&&supportFlow) {
      const input=req.unifiedBody || await readBody(req);
      if(input.unified===true) {
        input.id='agent';
        const text=String(input.text||'').trim();if(!text||text.length>16000)throw Error('Tin nhắn không hợp lệ.');
        if(input.companyId&&input.companyId!==companyId())throw Error('MST đã đổi. Gửi lại trong công ty hiện tại.');
        const session=sessionOf(provider('agent'));
        const ids=input.attachments||[];if(!Array.isArray(ids)||ids.length>4)throw Error('Tối đa 4 file.');
        const names=ids.map(id=>uploads.load(id,'agent',session.companyId).filename);
        const handoff=await supportFlow.beginUnified(text,session.companyId,names,input.supportChoice==='admin');
        input.supportTurn=handoff;
        req.unifiedBody=input;
        if(!handoff.aiAllowed) {
          sessions().append(session,{role:'user',content:text});
          const answer=handoff.reply||'Đã gửi tin nhắn tới admin.';
          sessions().append(session,{role:'assistant',content:answer});
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
          res.end('data: '+JSON.stringify({delta:answer})+'\n\ndata: '+JSON.stringify({done:true,handoff:true,control:handoff.control})+'\n\n');return true;
        }
        try{await gate();}catch {
          // Bản quyền không cho dùng AI ⇒ không thể để người dùng "chọn tiếp tục với AI" (AI bị
          // chặn), nên chuyển thẳng sang admin. Phải nêu wantsAdmin rõ ràng: trước đây nhánh này
          // sống nhờ regex đoán từ khoá trong Gateway, bỏ regex là reply rỗng.
          const value=await supportFlow.beginUnified('Cần admin hỗ trợ bản quyền để dùng AI. '+text,session.companyId,names,true);
          const answer=value.reply||'Đã chuyển yêu cầu tới admin. Admin sẽ liên hệ lại với bạn.';
          res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});res.end('data: '+JSON.stringify({delta:answer})+'\n\ndata: '+JSON.stringify({done:true,handoff:true,control:value.control})+'\n\n');return true;
        }
      }else req.unifiedBody=input;
    }
    if(!(supportFlow&&url.pathname==='/api/ai/providers'&&req.method==='GET'))await gate();
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
    const input = req.method === 'POST' ? req.unifiedBody||await readBody(req) : Object.fromEntries(url.searchParams);
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
    } else if (url.pathname === '/api/ai/providers' && req.method === 'GET') {await refreshCloud();send(publicConfig());}
    else if (url.pathname === '/api/ai/providers' && req.method === 'POST') {
      if (input.action === 'active') {
        if (input.id !== 'support') provider(input.id);
        if (input.id !== 'basic') config.active = input.id;
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
        if (p.id === 'basic') throw Error('AI Chat được cấu hình trên máy chủ.');
        if (p.id === 'agent') { p.label = identity.agentName; if (p.type !== 'openai') throw new Error('CNTaxTools dùng API tương thích OpenAI.'); }
        if (activeStreams.has(p.id)) throw new Error('Dừng trả lời trước khi sửa chế độ.');
        if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(input.apiKey))) throw new Error('API key không hợp lệ.');
        const index = config.providers.findIndex(item => item.id === p.id);
        const previous = config.providers[index];
        if(p.id==='agent'&&!p.routingMode)p.routingMode=input.apiKey?'manual':previous?.routingMode||'auto';
        if (previous && (previous.baseURL !== p.baseURL || previous.type !== p.type)) secrets.clear(keyId(p.id));
        if (input.apiKey) secrets.write(keyId(p.id), { token: input.apiKey });
        if (input.clearKey || p.type !== 'openai') secrets.clear(keyId(p.id));
        if (index < 0) config.providers.push(p); else config.providers[index] = p;
      }
      save(files.providers, config); send(publicConfig());
    } else if (url.pathname === '/api/ai/history/legacy' && req.method === 'GET') {
      provider(input.id); send({ scope: 'UNKNOWN', readOnly: true, rows: (history[input.id] || []).slice(-80) });
    } else if (url.pathname === '/api/ai/history' && ['GET', 'POST'].includes(req.method)) {
      const saved = provider(input.id),p=input.unified===true?{...saved,routingMode:'auto'}:saved;
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
      const savedProvider=provider(input.id),p=input.unified===true?{...savedProvider,routingMode:'auto'}:savedProvider;
      if (p.id === 'basic') throw Error('AI Chat chỉ hỗ trợ chế độ basic.');
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
      const execution = input.mode === 'agent' ? { store: executions(), record: executions().begin(input.requestId, session.id, { mode: 'agent', text, ids, options: input.options || {}, screen: input.screen || {} }) } : null;
      if (execution?.record.state === 'completed') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.end('data: ' + JSON.stringify({ delta: execution.record.answer }) + '\n\ndata: ' + JSON.stringify({ done: true, requestId: input.requestId }) + '\n\n'); return true;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      // AUTO may wait for durable recovery; cancellation/disconnection still aborts immediately.
      const timer = p.id==='agent'&&p.routingMode==='auto'?null:setTimeout(abort,180000);
      activeStreams.add(p.id);
      activeControllers.add(controller);
      const userMessage = { role: 'user', content: text, attachments: currentAttachments.map(uploads.publicRecord) };
      if (!execution?.record.userSaved) {
        sessions().append(session, userMessage);
        if (execution) { execution.record.userSaved = true; execution.store.finish(execution.record, 'running'); }
      }
      const jobId = sessions().startJob(session);
      let completed = false; const turnFiles = execution?.record.files || [];
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
        const token = (input.mode === 'agent' && secrets.readStrict ? secrets.readStrict(keyId(p.id), ['token']) : secrets.read(keyId(p.id), ['token'])).token;
        // Ưu tiên đường qua Gateway cho chế độ 'agent': Gateway giữ url/model/key và
        // xoay key khi hết hạn mức, nên key không nằm trên máy khách và admin đổi
        // cấu hình được bằng lệnh Telegram mà không phải sửa máy từng máy. Chỉ khi
        // không có Gateway (chạy local-mock / mất mạng) mới rơi về key trên máy.
        const runtimeMode = input.mode === 'agent' && p.id === 'agent' && p.routingMode === 'auto';
        const relay = !runtimeMode && p.id === 'agent' && p.routingMode==='auto' ? agentGateway() : null;
        const useEnvironment = input.mode !== 'agent' && !relay && p.id === 'agent' && !token && !!environment.apiKey;
        const aiConfig = runtimeMode ? { endpoint: 'http://127.0.0.1/disabled-cloud', model: 'Auto Free', apiKey: 'runtime-local', publicFree: true, chatTransport: runtime.chat } : relay
          // Shared AUTO uses basic chat; local JSON tools do not require native tool/stream discovery.
          ? { endpoint: relay.baseURL, model: p.model, apiKey: relay.token, viaGateway: true,
              stream: false,
              nativeTools: false }
          : useEnvironment ? environment : { endpoint: endpoint(p, '/chat/completions'), model: p.model, apiKey: token || (p.type === 'local' ? 'ollama' : '') };
        if(p.id==='agent'&&p.routingMode==='auto'&&!relay&&!runtimeMode)throw new Error('Chưa kết nối Cloudflare. Kiểm tra đăng ký/bản quyền hoặc chọn MANUAL.');
        if(relay){aiConfig.conversationId=session.id;aiConfig.onGatewayConfig=value=>{cloudConfig={revision:value.revision,active:{...(cloudConfig?.active||{}),model:value.model}};cloudAt=Date.now();};}
        if (!aiConfig.apiKey) throw new Error('Chưa cấu hình API key. Bấm Cấu hình để lưu key cho AI Agent.');
        if (!app) throw new Error('Dịch vụ ứng dụng chưa sẵn sàng cho AI Agent.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const emit = value => { if (!res.destroyed) res.write('data: ' + JSON.stringify(value) + '\n\n'); };
        const screen = { currentPage: /^[a-z-]{1,40}$/.test(input.screen?.currentPage || '') ? input.screen.currentPage : 'unknown', filters: {} };
        for (const key of ['from', 'to', 'direction']) if (typeof input.screen?.filters?.[key] === 'string' && input.screen.filters[key].length <= 20) screen.filters[key] = input.screen.filters[key];
        let streamed = false;
        const turnLicense=async()=>{const license=await checkLicense();if(input.supportTurn)await supportFlow.aiAllowed();controller.signal.throwIfAborted();return license;};
        const answer = await runAgent({ config: aiConfig, history: turnHistory, text, screen, app, dataDir, files: exported, signal: controller.signal, fetchImpl, attachments, attachmentParts: uploads.parts(attachments), options, checkLicense:turnLicense, session, contextBundle, contextTools, execution,
          // Cho tool PDF đọc được bytes GỐC của file đính kèm + lần về bản gốc khi gặp bản dẫn xuất (.pdf.txt).
          attachmentFiles: { bytes: record => uploads.bytes(record), source: record => uploads.sourceRecord(record) },
          permissionContext: () => ({ ...permissionContext(session), ...(execution ? { forceOnce: true } : {}) }), permissions: { consume: (...args) => permissionEngine().consume(...args) },
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
            if (value.file) { value.file.companyId = session.companyId; exported[value.file.fileId].companyId = session.companyId; exported[value.file.fileId].verified = true; save(exportFile, exported); turnFiles.push(value.file); if (execution) { execution.record.files = turnFiles; execution.store.finish(execution.record, 'running'); } }
            emit(value);
          } });
        controller.signal.throwIfAborted();
        if(input.supportTurn){const posted=await supportFlow.completeUnified(input.supportTurn.id,input.supportTurn.control.revision,answer);if(!posted?.accepted)throw Error('Admin đã tiếp quản. AI tạm dừng.');}
        sessions().append(session, { role: 'assistant', content: answer, files: turnFiles });
        if (execution) execution.store.finish(execution.record, 'completed', answer);
        emit(streamed ? { replace: answer } : { delta: answer });
        sessions().updateJob(jobId, 'completed'); completed = true; emit({ done: true, ...(relay?{configRevision:cloudConfig?.revision,cloudModel:cloudConfig?.active?.model}:{}),sessionId: session.id, companyId: session.companyId, selectedCompanyId: companyId(), jobId }); res.end();
      } catch (error) {
        if (execution) execution.store.finish(execution.record, controller.signal.aborted ? 'cancelled' : error.code === 'AGENT_CONTINUATION_REQUIRED' ? 'paused' : 'failed');
        sessions().append(session, { role: 'assistant', content: 'Không hoàn tất: ' + (controller.signal.aborted ? 'Tác vụ đã dừng.' : error.message), files: turnFiles });
        if (!res.headersSent) throw error;
        if (!res.destroyed) { res.write('data: ' + JSON.stringify({ error: controller.signal.aborted ? 'Tác vụ AI đã dừng hoặc admin đã tiếp quản.' : error.message, code: error.code, resumable: !!execution?.record.checkpoint, requestId: execution?.record.id }) + '\n\n'); res.end(); }
      } finally {
        if (!completed) sessions().updateJob(jobId, controller.signal.aborted ? 'cancelled' : 'failed');
        controller.abort(); clearTimeout(timer); res.off('close', abort); activeStreams.delete(p.id);
        activeControllers.delete(controller); if (closing && !activeControllers.size) closeStores();
      }
    } else reply(res, 404, { ok: false, error: 'Không có chức năng AI này.' });
    return true;
  }
  return { handle, pauseForAdmin() { for(const controller of activeControllers)controller.abort(); }, close() { closing = true; runtime.close(); for (const controller of activeControllers) controller.abort(); permissionStore?.close(); if (!activeControllers.size) closeStores(); } };
}
module.exports = { createAiService, licenseGate };
