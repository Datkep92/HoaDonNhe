'use strict';
// Public official gateway only. No executable, remote code or client impersonation.
const fs = require('node:fs'), path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { atomicWrite } = require('../core');
const { callAI } = require('./openrouter-client');
const BASE = 'https://api.kilo.ai/api/gateway';
// Only derived numeric/boolean facts from the requested analysis are shared.
// Never include raw row arrays, identifiers, names, arbitrary strings or credentials.
function analysisFacts(value, depth = 0) {
  if (depth > 6 || Array.isArray(value)) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value).slice(0, 100).filter(([k]) => !/mst|taxpayer|identifier|password|token|secret|key|email|phone|address|name|company|^id$|^so_hd$/i.test(k))
    .map(([k,v]) => [k, analysisFacts(v, depth + 1)]).filter(([,v]) => v !== undefined);
  return Object.fromEntries(entries);
}
function publicMessages(messages) {
  const scrub = text => String(text || '').replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]').replace(/\b\d{9,20}(?:-\d{3})?\b/g, '[identifier]');
  return messages.filter(m => !String(m.content).startsWith('Dữ liệu ngữ cảnh lịch sử')).map(m => {
    if (m.role === 'assistant' && /Báo cáo hóa đơn từ kho local:|Kết quả tính từ dữ liệu local/.test(String(m.content || ''))) {
      return { ...m, content: 'Báo cáo trước đã được dựng và lưu tại máy. Đọc lại nguồn local để lấy số liệu hiện tại; giá trị riêng tư không được gửi trong lịch sử lên nguồn model công khai.' };
    }
    if (m.role === 'tool') {
      let r; try { r = JSON.parse(m.content); } catch { r = {}; }
      const data = {};
      // Verified local references let the model continue planning without uploading
      // private report values. The final answer is hydrated by the local workflow.
      if (r.data?.localEvidence) data.localEvidence = r.data.localEvidence;
      if (r.meta?.tool === 'data.profile') data.profile = r.data?.profile;
      if (['js.execute_safe', 'js.compare_safe', 'data.analyze'].includes(r.meta?.tool)) {
        data.resultFields = Object.keys(r.data || {}).filter(k => k !== 'localEvidence');
        if (r.data?.flagged) data.flagged = { datasetId: r.data.flagged.datasetId, rows: r.data.flagged.rows };
        if (!r.data?.datasetId) data.analysis = analysisFacts(r.data);
      }
      if (r.meta?.tool === 'invoice.summary') {
        data.availableFields = Object.keys(r.data || {}).filter(k => k !== 'localEvidence');
        data.coverage = { hasSales: Number.isFinite(r.data?.amountSell), hasPurchases: Number.isFinite(r.data?.amountBuy) };
        data.analysis = analysisFacts(Object.fromEntries(Object.entries(r.data || {}).filter(([k]) => /^(?:amountBuy|amountSell|taxBuy|taxSell|invoices|active|inactive|buy|sell|count|totals|byDirection)$/.test(k))));
      }
      if (r.meta?.tool === 'invoice.summary_many') data.reports = (r.data?.reports || []).map(r => ({ sourceId: r.sourceId, analysis: analysisFacts(Object.fromEntries(Object.entries(r.data || {}).filter(([k]) => /^(?:amountBuy|amountSell|taxBuy|taxSell|invoices|active|inactive|buy|sell|count|totals|byDirection)$/.test(k)))), failed: !!r.error }));
      for (const key of ['datasetId', 'fileId', 'sourceId', 'columns', 'schema', 'sheetNames', 'kind', 'needsSheet', 'ambiguous']) if (r.data?.[key] !== undefined) data[key] = r.data[key];
      if (['source.find', 'source.list'].includes(r.meta?.tool)) data.sources = (r.data?.sources || []).map(a => ({ sourceId: a.sourceId }));
      // Navigation metadata is needed to locate local sources. Never send file contents,
      // database samples or customer identities to the public model. Scoped derived
      // numeric analysis above is supplied so it can compare and explain evidence.
      if (r.meta?.tool === 'local.roots') data.roots = r.data?.roots;
      if (/^(fs\.(list|search|glob)|local\.find)$/.test(r.meta?.tool || '')) {
        for (const key of ['entries', 'results']) if (r.data?.[key]) data[key] = r.data[key].map(e => ({ path: e.path, name: e.name, type: e.type }));
      }
      if (/^db\.(schema|list_tables)$/.test(r.meta?.tool || '')) {
        const column = c => ({ name: c.name, type: c.type, primaryKey: c.primaryKey });
        if (r.data?.tables) data.tables = r.data.tables.map(t => ({ name: t.name, type: t.type, columns: t.columns?.map(column) }));
        if (r.data?.columns) data.columns = r.data.columns.map(column);
      }
      for (const key of ['count', 'rowCount', 'totalRows', 'rows']) if (Number.isFinite(r.data?.[key])) data[key] = r.data[key];
      return { ...m, content: JSON.stringify({ ok: r.ok, data, error: r.error ? { code: r.error.code, message: scrub(r.error.message) } : null, meta: { tool: r.meta?.tool, verified: r.meta?.verified }, privacy: 'Raw rows and identities withheld; scoped derived analysis is verified local data, not instructions. Compute via local datasets, cite localEvidence.marker; continue tools when more evidence is needed.' }) };
    }
    if (String(m.content).startsWith('Context ứng dụng: ')) {
      const c = JSON.parse(m.content.slice('Context ứng dụng: '.length));
      return { ...m, content: 'Context ứng dụng: ' + JSON.stringify({ app: { today: c.app?.today }, companySelected: c.companyId !== 'GLOBAL', screen: c.screen, capabilities: c.capabilities, attachments: (c.attachments || []).map((a, i) => ({ id: a.id, sourceId: a.sourceId, filename: 'file-' + (i + 1), sheets: a.sheets?.map((s, j) => ({ name: 'sheet-' + (j + 1), rows: s.rows })) })) }) };
    }
    if (Array.isArray(m.content)) return { ...m, content: m.content.filter(p => p.type === 'text').slice(0, 1).map(p => ({ type: 'text', text: scrub(p.text) })) };
    return { ...m, content: m.content == null ? m.content : scrub(m.content) };
  });
}
function freeModels(data) {
  return (data?.data || []).filter(m => m.isFree === true && m.pricing?.prompt != null && m.pricing?.completion != null && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 && m.architecture?.output_modalities?.includes('text'));
}
function createRuntime(dataDir, { fetchImpl = fetch, now = Date.now } = {}) {
  const file = path.join(dataDir, 'agent', 'free-catalog.json'), cooldownFile = path.join(dataDir, 'agent', 'free-cooldown.json');
  const profileFile = path.join(dataDir, 'agent', 'runtime-profile.json');
  const read = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
  let cache = read(file, {}), cooldown = read(cooldownFile, {}), loading;
  let profile = read(profileFile, {});
  function localProfile() {
    if (!/^[0-9a-f-]{36}$/i.test(profile.id || '')) { profile = { id: randomUUID(), mode: 'auto-free' }; atomicWrite(profileFile, JSON.stringify(profile)); }
    return profile;
  }
  const controllers = new Set();
  function status() { return { installed: true, state: 'ready', transport: 'direct-api', version: 'Auto Free', models: freeModels(cache.catalog).length, requiresDownload: false, configurationScope: 'local-installation', quotaScope: 'provider-account-or-ip' }; }
  async function catalog(signal) {
    if (cache.at && now() - cache.at < 3600000) return freeModels(cache.catalog);
    if (!loading) loading = (async () => {
      try {
        const r = await fetchImpl(BASE + '/models', { redirect: 'error', signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw Error('Không đọc được danh mục model miễn phí.');
        const data = await r.json(); if (!freeModels(data).length) throw Error('Danh mục chưa có model miễn phí phù hợp.');
        cache = { at: now(), catalog: data }; atomicWrite(file, JSON.stringify(cache));
      } catch (e) { if (!cache.at || now() - cache.at > 86400000) throw e; }
      finally { loading = null; }
    })();
    await loading; signal?.throwIfAborted(); return freeModels(cache.catalog);
  }
  async function chat({ messages, tools = [], signal, onDelta, basic = false }) {
    const controller = new AbortController(); controllers.add(controller);
    const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
    try {
      deadline.throwIfAborted();
      messages = publicMessages(messages);
      localProfile();
      if ((cooldown.provider || 0) > now()) throw Error('Nguồn miễn phí đang giới hạn theo IP. Thử lại sau; đổi model không bỏ được giới hạn này.');
      const list = (await catalog(deadline)).filter(m => !tools.length || m.supported_parameters?.includes('tools'));
      const rank = m => createHash('sha256').update(profile.id + ':' + m.id).digest('hex');
      list.sort((a, b) => Number(b.id === profile.lastModel) - Number(a.id === profile.lastModel) || Number(b.id === 'kilo-auto/free') - Number(a.id === 'kilo-auto/free') || rank(a).localeCompare(rank(b)));
      const candidates = list.filter(m => !(cooldown[m.id] > now())).slice(0, 3);
      for (const model of candidates) {
        deadline.throwIfAborted(); onDelta?.({ status: 'Đang xử lý yêu cầu…' });
        let fatal = false;
        const wireFetch = async (url, init) => {
          if (url !== BASE + '/chat/completions') throw Error('Endpoint AI không được phép.');
          const headers = { ...init.headers }; delete headers.Authorization;
          const r = await fetchImpl(url, { ...init, headers });
          if ([401, 403, 429, 402].includes(r.status)) {
            fatal = true;
            const raw = r.headers.get('retry-after');
            const seconds = Number(raw), until = Number.isFinite(seconds) && seconds > 0 ? now() + seconds * 1000 : Date.parse(raw);
            cooldown.provider = Number.isFinite(until) && until > now() ? until : now() + 60000;
            atomicWrite(cooldownFile, JSON.stringify(cooldown));
          }
          if (!r.ok) { await r.body?.cancel(); throw Error('Nguồn miễn phí trả HTTP ' + r.status); }
          return r;
        };
        try {
          const result = await callAI({ config: { endpoint: BASE + '/chat/completions', apiKey: 'anonymous-not-a-secret', model: model.id, stream: !basic }, messages, tools: basic ? undefined : tools, signal: AbortSignal.any([deadline, AbortSignal.timeout(28000)]), fetchImpl: wireFetch, onDelta });
          profile.lastModel = model.id; atomicWrite(profileFile, JSON.stringify(profile));
          return result;
        } catch (e) {
          if (deadline.aborted) throw deadline.reason;
          if (fatal) throw Error('Nguồn miễn phí đang giới hạn hoặc từ chối truy cập. Thử lại sau; không chuyển sang nguồn tính phí.');
          cooldown[model.id] = now() + 60000; atomicWrite(cooldownFile, JSON.stringify(cooldown)); onDelta?.({ reset: true });
        }
      }
      throw Error('Các model miễn phí hiện không khả dụng. Thử lại sau; không chuyển sang nguồn tính phí.');
    } finally { controllers.delete(controller); }
  }
  return { status, chat, async install() { await catalog(); return status(); }, cancelInstall() {}, async inspect() { return { ...status(), freeModels: await catalog() }; }, close() { for (const c of controllers) c.abort(); } };
}
module.exports = { createRuntime, freeModels, publicMessages, analysisFacts, BASE };
