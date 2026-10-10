// Telegram AI administration. The store is encrypted and updated with Firebase ETags.
import { classify, configurationId, compatible, requiredCapabilities, healthResult, deepCheck, chatCheck, resolveCall } from './ai-routing.js';
const enc = new TextEncoder();
const id = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);
const mask = x => x.length > 10 ? x.slice(0, 4) + '…' + x.slice(-4) : '***';
const label = n => n.label || n.name;
const button = (text, action) => ({ text: text.slice(0, 60), callback_data: 'a2:' + action });
const validName = x => typeof x === 'string' && x.trim().length > 0 && x.length <= 80 && !/[\r\n]/.test(x);
function validURL(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(u.hostname)) throw Error('URL phải là HTTPS công khai, không chứa mật khẩu/query.');
  return u.href.replace(/\/+$/, '');
}
const DEFAULT_ENDPOINTS = { chat: '/chat/completions', models: '/models', key: '/key' };
export function endpoint(u, kind) {
  const path = u.endpoints?.[kind] || DEFAULT_ENDPOINTS[kind];
  if (!path || /[\s?#]/.test(path)) throw Error('Endpoint không hợp lệ.');
  const base = u.url.replace(/\/(?:chat\/completions|responses|models|key)\/?$/, '');
  const relative=path.replace(/^\/+/, '').replace(/^(?:v1\/)/, /\/v1$/.test(base)?'':'v1/');
  const full = /^https:\/\//i.test(path) ? path : base + '/' + relative;
  const url = new URL(validURL(full));
  if (url.origin !== new URL(u.url).origin) throw Error('Endpoint phải cùng máy chủ với URL.');
  return url.href.replace(/\/+$/, '');
}
const b64 = b => {
  const chunks=[];
  for(let i=0;i<b.length;i+=8192)chunks.push(String.fromCharCode(...b.subarray(i,i+8192)));
  return btoa(chunks.join(''));
};
const un64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function seal(value, secret) {
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('hoadonnhe-ai-admin-v2:' + secret)), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { version: 2, iv: b64(iv), data: b64(new Uint8Array(data)) };
}
export async function unseal(value, secret) {
  if (!value) return null;
  if (value.version !== 2) throw Error('Phiên bản kho cấu hình chưa được hỗ trợ.');
  const key = await crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('hoadonnhe-ai-admin-v2:' + secret)), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(value.iv) }, key, un64(value.data))));
}
export function migrate(legacy) {
  const value = { version: 2, revision: 0, urls: [], activeModel: '', prompts: {}, jobs: {}, audit: [] };
  for (const p of legacy?.profiles || []) {
    let u = value.urls.find(u => u.url === p.baseURL);
    if (!u) { u = { id: id(), name: new URL(p.baseURL).hostname, url: p.baseURL, enabled: true, models: [] }; value.urls.push(u); }
    const m = { id: id(), name: p.model, alias: p.alias, enabled: true, keys: (p.keys || []).map((secret, i) => ({ id: id(), name: 'Key ' + (i + 1), secret, enabled: true, health: {} })) };
    u.models.push(m);
    if (p.alias === legacy.active) value.activeModel = m.id;
  }
  return value;
}
function locate(c, nodeId) {
  for (const u of c.urls) {
    if (u.id === nodeId) return { node: u, u, list: c.urls, type: 'url' };
    for (const m of u.models) {
      if (m.id === nodeId) return { node: m, u, m, list: u.models, type: 'model' };
      for (const k of m.keys) if (k.id === nodeId) return { node: k, u, m, k, list: m.keys, type: 'key' };
    }
  }
  throw Error('Mục này đã bị xoá. Mở lại /ai.');
}
function allKeys(c) { return c.urls.flatMap(u => u.models.flatMap(m => m.keys.map(k => ({ u, m, k })))); }
function state(k) {
  if (!k.enabled) return '⏸ tắt';
  if(k.testLease?.until>Date.now()||k.health?.status==='checking')return '🔵 đang kiểm tra';
  if (!k.health?.checkedAt) return '⚪ chưa kiểm tra';
  const h = k.route?.checkedAt?k.route:k.health;
  if(h.status==='ok'&&!k.route?.confirmed)return '🟡 key hợp lệ · cấu hình chưa xác minh';
  return (h.status === 'ok' ? '🟢 ' : h.status === 'auth' ? '🔴 ' : h.status === 'quota' ? '🟠 ' : '🟡 ') + h.label;
}
// ── Bảng điều khiển theo URL ────────────────────────────────────────────────
// Một URL là MỘT bảng: danh sách model + danh sách API + nút test toàn bộ.
// Che mọi giá trị key khỏi văn bản trước khi lưu hoặc gửi ra ngoài.
function redactSecret(text, c) {
  let out = String(text || '');
  for (const x of allKeys(c)) if (x.k.secret && x.k.secret.length >= 8) out = out.split(x.k.secret).join('[key ẩn]');
  return out;
}
export function apiName(secret) { return secret.length > 14 ? secret.slice(0, 10) + '…' + secret.slice(-4) : secret; }
// Gom API của một URL theo GIÁ TRỊ key: một API dùng chung cho 7 model chỉ hiện MỘT dòng.
export function urlApis(u) {
  const groups = new Map();
  for (const m of u.models) for (const k of m.keys) {
    let g = groups.get(k.secret);
    if (!g) { g = { secret: k.secret, name: k.name, keys: [], models: [] }; groups.set(k.secret, g); }
    g.keys.push(k);
    if (!g.models.includes(m.name)) g.models.push(m.name);
  }
  return [...groups.values()];
}
function urlState(u) {
  const keys = u.models.flatMap(m => m.keys);
  if (!keys.length) return '⚪ chưa có API';
  if (keys.some(k => k.route?.status === 'ok' && k.route?.confirmed)) return '🟢';
  if (keys.some(k => k.health?.status === 'ok')) return '🟡';
  return keys.some(k => k.health?.checkedAt || k.route?.checkedAt) ? state(keys.find(k => k.health?.checkedAt || k.route?.checkedAt)).split(' ')[0] : '⚪ chưa kiểm tra';
}
// Thêm MỘT API cho cả URL: mọi model dùng chung key đó — đúng cách Telegram gọi AI.
export function attachApi(u, secret) {
  const name = apiName(secret);
  let added = 0;
  for (const m of u.models) {
    if (m.keys.some(k => k.secret === secret) || m.keys.length >= 30) continue;
    m.keys.push({ id: id(), name, secret, enabled: true, health: {} });
    added++;
  }
  return added;
}
// Xoá một API khỏi MỌI model của URL (theo giá trị key, không chỉ một bản ghi).
export function detachApi(u, keyId) {
  const target = u.models.flatMap(m => m.keys).find(k => k.id === keyId);
  if (!target) throw Error('Không tìm thấy API.');
  let removed = 0;
  for (const m of u.models) { const before = m.keys.length; m.keys = m.keys.filter(k => k.secret !== target.secret); removed += before - m.keys.length; }
  return { name: target.name, secret: target.secret, removed };
}
export function candidates(c, now = Date.now()) {
  const urls = c.urls.filter(u => u.enabled && (u.retryAt || 0) <= now);
  const activeURL = urls.find(u => u.models.some(m => m.id === c.activeModel));
  if (activeURL) urls.unshift(...urls.splice(urls.indexOf(activeURL), 1));
  return urls.flatMap(u => {
    const models = u.models.filter(m => m.enabled);
    const active = models.find(m => m.id === c.activeModel);
    if (active) models.unshift(...models.splice(models.indexOf(active), 1));
    return models.filter(m => (m.retryAt || 0) <= now).flatMap(m => m.keys.filter(k => k.enabled && (k.health?.retryAt || 0) <= now && (k.route?.retryAt||0)<=now).map(k => ({ u, m, k })));
  });
}
function failure(status, detail) {
  const result=classify(status,detail);
  if (status === 401 || status === 403) return {...result, status: 'auth', label: 'key hết hạn/không có quyền' };
  if (status === 402 || status === 429 || /quota|credit|balance|insufficient|rate.limit/i.test(detail)) return {...result, status: 'quota', label: 'hết quota/giới hạn' };
  return {...result, status: 'error', label: 'HTTP ' + status };
}
export function createAiAdmin(deps) {
  async function jobSignature(env, jobId, token) {
    const key = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode('ai-check:' + jobId + ':' + token))));
  }
  async function read(env) { const r = await deps.read(env); return { ...r, value: await unseal(r.value, env.TOKEN_SECRET) }; }
  async function update(env, fn, actor = 'system') {
    for (let attempt = 0; attempt < 24; attempt++) {
      const r = await read(env);
      const c = r.value || migrate(await deps.legacy(env));
      const result = await fn(c);
      if (result?.skip) return { c, result };
      for(const j of Object.values(c.jobs||{}))if(j.kind==='routing'&&j.epoch!==(c.configEpoch||0))j.status='superseded';
      const finished=Object.values(c.jobs||{}).filter(j=>['complete','ready','superseded'].includes(j.status)).sort((a,b)=>b.startedAt-a.startedAt);
      const keep=new Set(finished.slice(0,100).filter(j=>Date.now()-j.startedAt<86400000).map(j=>j.id));
      c.jobs=Object.fromEntries(Object.entries(c.jobs||{}).filter(([key,j])=>!['complete','ready','superseded'].includes(j.status)||keep.has(key)));
      c.revision++; c.updatedAt = Date.now();
      c.audit = [...(c.audit || []), { at: c.updatedAt, actor: String(actor), operation: result?.operation || 'update' }].slice(-100);
      if (await deps.write(env, await seal(c, env.TOKEN_SECRET), r.etag)) return { c, result };
      await new Promise(resolve=>setTimeout(resolve,5+Math.floor(Math.random()*20)));
    }
    throw Error('Có người đang sửa đồng thời. Thử lại.');
  }
  async function config(env) { return (await read(env)).value; }
  async function ensure(env) { return (await config(env)) || (await update(env, () => ({ operation: 'migrate' }))).c; }
  async function authorized(env, from, chat) {
    if (!from || from.is_bot || String(chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return false;
    const member = await deps.telegram(env, 'getChatMember', { chat_id: env.TELEGRAM_CHAT_ID, user_id: from.id });
    return ['creator', 'administrator'].includes(member?.status);
  }
  const localPanels = new Map();
  const panel = async (env, thread, value) => {
    if (deps.panel) return deps.panel(env, thread, value);
    const key = env.TELEGRAM_CHAT_ID + ':' + thread;
    if (value) localPanels.set(key, value);
    return localPanels.get(key);
  };
  async function send(env, thread, text, rows) {
    const payload = { chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 3900), link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: rows || [[button('⬅ Quay lại', 'view:root')]] } };
    const current = await panel(env, thread);
    if (current?.messageId) {
      try { return await deps.telegram(env, 'editMessageText', { ...payload, message_id: current.messageId }); }
      catch (error) {
        if (/message is not modified/i.test(error.message)) return { message_id: current.messageId };
        if (!/message to edit not found|message can't be edited|message_id_invalid/i.test(error.message)) throw error;
      }
    }
    const sent = await deps.telegram(env, 'sendMessage', { ...payload, ...(thread ? { message_thread_id: thread } : {}) });
    if (sent?.message_id) await panel(env, thread, { messageId: sent.message_id });
    return sent;
  }
  async function show(env, thread, target = 'root', page = 0, expanded = false, notice = '') {
    const c = await ensure(env);
    if(env.AI_ROUTER_V3_ENABLED==='1'&&thread&&c.adminThread!==thread)await update(env,c=>{c.adminThread=thread;return {operation:'admin-panel'};});
    const usedModel=c.currentConfig?.id?.split('.')[1]||c.activeModel;
    let title, rows, children;
    if (target === 'root') {
      title = '🤖 AI · ' + c.urls.length + ' URL · ' + c.urls.reduce((n, u) => n + u.models.length, 0) + ' model · ' + allKeys(c).length + ' key';
      if (expanded) for (const u of c.urls) {
        title += '\n' + (u.enabled ? '🌐 ' : '⏸ ') + u.name + '\n';
        for (const m of u.models) {
          title += '  ├ ' + (m.id === usedModel ? '▶ ' : '') + label(m) + '\n';
          for (const k of m.keys) title += '  │  └ ' + k.name + ' ' + mask(k.secret) + ' · ' + state(k) + '\n';
        }
      }
      children = c.urls; rows = [[button('➕ Cấu hình · 3 dòng','configure')],[button('➕ URL', 'newurl'), button('🌳 Xem cây', 'tree')], [button('🔍 Check + fallback', 'check:all'), button('🩺 Deep test…', 'deep:all')], [button('🕒 Nhật ký', 'audit'),button('ℹ Trợ giúp','help')],[button('💬 Hỏi AI','chat')]];
      const jobs = Object.values(c.jobs || {}).filter(j => j.status === 'running' || j.status === 'interrupted');
      for (const j of jobs.slice(-2)) rows.push([button('▶ Tiếp tục check ' + j.cursor + '/' + j.items.length, 'resume:' + j.id)]);
    } else {
      const l = locate(c, target), n = l.node;
      title = (l.type === 'url' ? '🌐 ' : l.type === 'model' ? '🧠 ' : '🔑 ') + label(n) + '\nURL: ' + l.u.url;
      if (l.m) title += '\nModel: ' + l.m.name;
      if (l.k) title += '\n' + mask(n.secret) + ' · ' + state(n);
      if(l.k&&n.route?.checkedAt)title+='\nCheck: '+new Date(n.route.checkedAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})+(n.route.retryAt>Date.now()?'\nTự thử lại: '+new Date(n.route.retryAt).toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'}):'')+'\nProtocol: '+(n.route.protocol||'chưa xác minh')+(n.route.detail?'\n⚠ Nhà cung cấp báo: '+redactSecret(n.route.detail,c):'');
      rows = [[button('✏ Đổi tên', 'edit:name:' + target), button(n.enabled ? '⏸ Tắt' : '▶ Bật', 'toggle:' + target)]];
      if (l.type === 'url') {
        // MỘT URL = MỘT BẢNG: model ở trên, API ở dưới, mỗi dòng có nút xoá riêng.
        const apis = urlApis(n);
        title = (n.enabled ? '🌐 ' : '⏸ ') + label(n) + '\n' + n.url + '\n\nMODEL · ' + n.models.length + '        API · ' + apis.length + '        ' + urlState(n);
        rows = [];
        for (const m of n.models.slice(0, 8)) {
          const dot = (m.keys.length ? state(m.keys[0]) : '⚪ chưa có API').split(' ')[0];
          rows.push([button('🧠 ' + label(m) + (m.enabled ? '' : ' ⏸') + '  ' + dot + '  ' + m.keys.length + ' API', 'view:' + m.id), button('🗑', 'rmmodel:' + m.id)]);
        }
        if (n.models.length > 8) rows.push([button('… còn ' + (n.models.length - 8) + ' model nữa', 'view:' + n.id)]);
        for (const g of apis.slice(0, 4)) {
          const dot = (g.keys.length ? state(g.keys[0]) : '⚪').split(' ')[0];
          rows.push([button('🔑 ' + apiName(g.secret) + '  ' + dot + '  dùng cho ' + g.keys.length + ' model', 'view:' + g.keys[0].id), button('🗑', 'rmapi:' + g.keys[0].id)]);
        }
        if (apis.length > 4) rows.push([button('… còn ' + (apis.length - 4) + ' API nữa', 'view:' + n.id)]);
        if (!n.models.length) rows.push([button('⚠ Chưa có model — thêm model trước', 'newmodel:' + n.id)]);
        rows.push([button('➕ Model', 'newmodel:' + n.id), button('📋 Dán nhiều model', 'bulk:' + n.id)]);
        rows.push([button('➕ API (áp cho mọi model)', 'addapi:' + n.id), button('🔗 Endpoint', 'endpoints:' + n.id)]);
        if (n.models.length) rows.push([button('🩺 Test URL · ' + n.models.length + ' model × ' + apis.length + ' API', 'check:' + n.id)]);
        rows.push([button('✏ Đổi URL', 'edit:url:' + n.id), button('🗑 Xoá URL', 'delete:' + n.id)]);
        rows.push([button('⬅ Danh sách URL', 'view:root'), button('🔄 Làm mới', 'view:' + n.id)]);
        if (title.length > 3800) title = title.slice(0, 3700) + '\n…';
        return send(env, thread, (notice ? notice + '\n' : '') + title, rows);
      }
      if (l.type === 'model') { rows.push([button('✏ Sửa model', 'edit:model:' + target), button('➕ Key', 'newkey:' + target)]); rows.push([button('▶ Ưu tiên model này', 'active:' + target),{text:'📋 Model',copy_text:{text:l.m.name}}]); children = n.keys; }
      if (l.type === 'key') { rows.push([button('✏ Thay key', 'edit:secret:' + target), button('ℹ Trạng thái', 'info:' + target)]); rows.push([button('🧪 Test model…', 'test:' + target),button('🩺 Deep test…','deep:'+target)]); rows.push([button('📋 Key riêng','copykey:'+target),button('📋 Cấu hình riêng','copyconfig:'+target)]); }
      rows.push([button('🔍 Kiểm tra', 'check:' + target)]);
      rows.push([button('⬆ Ưu tiên lên', 'up:' + target), button('⬇ Ưu tiên xuống', 'down:' + target)]);
      rows.push([button('🗑 Xoá…', 'delete:' + target), button('⬅ Quay lại', 'view:' + (l.type === 'url' ? 'root' : l.type === 'model' ? l.u.id : l.m.id))]);
    }
    const list = children || [], pages = Math.max(1, Math.ceil(list.length / 8));
    page = Math.min(Math.max(0, page), pages - 1);
    rows.push(...list.slice(page * 8, page * 8 + 8).map(n => [button((n.enabled ? '' : '⏸ ') + label(n) + (n.secret ? ' ' + mask(n.secret) + ' ' + state(n).split(' ')[0] : n.models ? ' · ' + n.models.length + ' model · ' + urlApis(n).length + ' API  ' + urlState(n) : ' · ' + n.keys.length + ' key'), 'view:' + n.id)]));
    if (pages > 1) rows.push([button('◀', 'page:' + target + ':' + Math.max(0, page - 1)), button((page + 1) + '/' + pages + ' ▶', 'page:' + target + ':' + Math.min(pages - 1, page + 1))]);
    rows.push([button('🌳 Cây / Làm mới', 'view:root')]);
    if (title.length > 3800) title = title.slice(0, 3700) + '\n… Mở từng URL để xem đầy đủ.';
    return send(env, thread, (notice ? notice + '\n' : '') + title, rows);
  }
  async function ask(env, from, thread, step, text) {
    const sent = await deps.telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, ...(thread ? { message_thread_id: thread } : {}), text, reply_markup: { force_reply: true, input_field_placeholder: 'Trả lời tin này; /cancel để huỷ' } });
    await update(env, c => { c.prompts[from.id] = { ...step, thread, message: sent.message_id, expires: Date.now() + 600000 }; return { operation: 'prompt' }; }, from.id);
    if (step.message) try { await deps.telegram(env, 'deleteMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_id: step.message }); } catch { /* cleanup is best effort */ }
    if (step.inputMessage) try { await deps.telegram(env, 'deleteMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_id: step.inputMessage }); } catch { /* cleanup is best effort */ }
  }
  async function applyValue(env, from, thread, value, prompt, ctx, origin) {
    if(prompt.kind==='chat') {
      if(!value||value.length>4000)throw Error('Câu hỏi tối đa 4000 ký tự.');
      await deps.telegram(env,'sendChatAction',{chat_id:env.TELEGRAM_CHAT_ID,...(thread?{message_thread_id:thread}:{}),action:'typing'});
      await update(env,c=>{delete c.prompts[from.id];return {operation:'chat-start'};},from.id);
      ctx.waitUntil(telegramChat(env,from,thread,value));return;
    }
    if (prompt.kind === 'newurl' && !prompt.name) {
      if (!validName(value)) throw Error('Tên từ 1–80 ký tự.');
      return ask(env, from, thread, { ...prompt, name: value }, '🌐 Nhập URL API HTTPS (ví dụ https://openrouter.ai/api/v1).');
    }
    if (prompt.kind === 'newkey' && !prompt.name) {
      if (!validName(value)) throw Error('Tên key từ 1–80 ký tự.');
      return ask(env, from, thread, { ...prompt, name: value }, '🔑 Dán API key. Tin chứa key sẽ được xoá sau khi lưu.');
    }
    // Ghi chú dựng sẵn TRƯỚC khi gọi update: biến `notice` bên dưới khai báo sau, dùng trong
    // callback sẽ lỗi "cannot access before initialization".
    let apiNotice = '';
    const result = await update(env, c => {
      const current = c.prompts[from.id];
      if (!current || current.message !== prompt.message || current.expires < Date.now()) throw Error('Phiên nhập đã hết hạn/đã xử lý.');
      let selected;
      if(prompt.kind==='configure') {
        const lines=value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        if(lines.length!==3)throw Error('Nhập đúng 3 dòng: URL, model, API key.');
        const url=validURL(lines[0].replace(/^URL\s*:\s*/i,'')),model=lines[1].replace(/^MODEL\s*:\s*/i,''),secret=lines[2].replace(/^(?:API KEY|API|KEY)\s*:\s*/i,'');
        if(!/^[A-Za-z0-9._:/|-]{1,120}$/.test(model)||!/^[\x21-\x7e]{8,200}$/.test(secret))throw Error('Model hoặc key không đúng định dạng.');
        let u=c.urls.find(u=>u.url===url);
        if(!u){if(c.urls.length>=20)throw Error('Tối đa 20 URL.');u={id:id(),name:new URL(url).hostname,url,enabled:true,models:[]};c.urls.push(u);}
        let m=u.models.find(m=>m.name===model);
        if(!m){if(u.models.length>=30)throw Error('Tối đa 30 model/URL.');m={id:id(),name:model,enabled:true,keys:[]};u.models.push(m);}
        let k=m.keys.find(k=>k.secret===secret);
        if(!k){if(m.keys.length>=30||allKeys(c).length>=500)throw Error('Vượt giới hạn key.');k={id:id(),name:'Key '+(m.keys.length+1),secret,enabled:true,health:{}};m.keys.push(k);}
        u.enabled=m.enabled=k.enabled=true;u.retryAt=m.retryAt=0;k.health={};k.route={};selected=k.id;
      } else if (prompt.kind === 'newurl') {
        const url = validURL(value);
        if (c.urls.some(u => u.url === url)) throw Error('URL đã có; mở URL đó để thêm model.');
        if (c.urls.length >= 20) throw Error('Tối đa 20 URL.');
        const u = { id: id(), name: prompt.name, url, enabled: true, models: [] }; c.urls.push(u); selected = u.id;
      } else {
        const l = locate(c, prompt.target), n = l.node; selected = n.id;
        if (prompt.kind === 'bulk') {
          const names=[...new Set(value.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean))];
          if(!names.length||names.some(x=>!/^[A-Za-z0-9._:/|-]{1,120}$/.test(x)))throw Error('Danh sách model không hợp lệ.');
          const added=names.filter(name=>!n.models.some(m=>m.name===name));
          if(n.models.length+added.length>30)throw Error('Tối đa 30 model/URL.');
          const secrets=[...new Set(n.models.flatMap(m=>m.keys.filter(k=>k.enabled).map(k=>k.secret)))].slice(0,30);
          if(allKeys(c).length+secrets.length*added.length>500)throw Error('Tối đa 500 key.');
          for(const name of added)n.models.push({id:id(),name,enabled:true,keys:secrets.map((secret,i)=>({id:id(),name:'Key '+(i+1),secret,enabled:true,health:{}}))});
          selected=n.id;
        } else if (prompt.kind === 'newmodel') {
          if (!/^[A-Za-z0-9._:/|-]{1,120}$/.test(value)) throw Error('Tên model không hợp lệ.');
          if (n.models.some(m => m.name === value)) throw Error('Model này đã có.');
          if (n.models.length >= 30) throw Error('Tối đa 30 model/URL.');
          const shared=[...new Set(n.models.flatMap(m=>m.keys.filter(k=>k.enabled).map(k=>k.secret)))].slice(0,30);
          if(allKeys(c).length+shared.length>500)throw Error('Tối đa 500 key.');
          const m = { id: id(), name: value, enabled: true, keys: shared.map((secret,i)=>({id:id(),name:'Key '+(i+1),secret,enabled:true,health:{}})) }; n.models.push(m); selected = m.id;
        } else if (prompt.kind === 'newkey') {
          if (!/^[\x21-\x7e]{8,200}$/.test(value)) throw Error('Key 8–200 ký tự, không chứa khoảng trắng.');
          if (n.keys.some(k => k.secret === value)) throw Error('Key này đã có trong model.');
          if (n.keys.length >= 30) throw Error('Tối đa 30 key/model.');
          if (allKeys(c).length >= 500) throw Error('Tối đa 500 key trong kho.');
          const k = { id: id(), name: prompt.name, secret: value, enabled: true, health: {} }; n.keys.push(k); selected = k.id;
        } else if (prompt.kind === 'addapi') {
          // Một API cho cả URL: áp cùng key vào MỌI model, đúng cách Telegram gọi AI.
          if (l.type !== 'url') throw Error('Chọn URL.');
          if (!/^[\x21-\x7e]{8,200}$/.test(value)) throw Error('Key 8–200 ký tự, không chứa khoảng trắng.');
          if (urlApis(n).some(g => g.secret === value)) throw Error('API này đã có trong URL.');
          if (allKeys(c).length + n.models.length > 500) throw Error('Tối đa 500 key trong kho.');
          const attached = attachApi(n, value);
          if (!attached) throw Error('Không áp được API cho model nào (mỗi model tối đa 30 API).');
          selected = n.id;
          apiNotice = '🔑 Đã áp API cho ' + attached + '/' + n.models.length + ' model của URL này.';
        } else if (prompt.field === 'url') {
          const url = validURL(value);
          if (c.urls.some(u => u.id !== n.id && u.url === url)) throw Error('URL này đã có.');
          n.url = url;
          n.retryAt = 0;
          if (n.endpoints) for (const kind of Object.keys(n.endpoints)) if (/^https:/i.test(n.endpoints[kind])) delete n.endpoints[kind];
          for (const m of n.models) { m.retryAt = 0; for (const k of m.keys) { k.health = {}; k.route = {}; } }
        } else if (prompt.field?.startsWith('ep_')) {
          if (l.type !== 'url') throw Error('Chọn URL.');
          const kind = prompt.field.slice(3);
          if (!Object.hasOwn(DEFAULT_ENDPOINTS, kind)) throw Error('Endpoint không hợp lệ.');
          const path = value === '-' ? DEFAULT_ENDPOINTS[kind] : value;
          const candidate = { ...n, endpoints: { ...(n.endpoints || {}), [kind]: path } };
          endpoint(candidate, kind);
          n.endpoints = candidate.endpoints;
          n.retryAt = 0;
          for (const m of n.models) { m.retryAt = 0; for (const k of m.keys) { k.health = {}; k.route = {}; } }
        } else if (prompt.field === 'secret') {
          if (!/^[\x21-\x7e]{8,200}$/.test(value)) throw Error('Key không hợp lệ.');
          if (l.m.keys.some(k => k.id !== n.id && k.secret === value)) throw Error('Key này đã có.');
          n.secret = value; n.health = {}; n.route = {};
        } else if (prompt.field === 'model') {
          if (!/^[A-Za-z0-9._:/|-]{1,120}$/.test(value)) throw Error('Model không hợp lệ.');
          if (l.u.models.some(m => m.id !== n.id && m.name === value)) throw Error('Model đã có.');
          n.name = value; n.retryAt = 0; for (const k of n.keys) { k.health = {}; k.route = {}; }
        } else { if (!validName(value)) throw Error('Tên không hợp lệ.'); if (l.type === 'model') n.label = value; else n.name = value; }
      }
      delete c.prompts[from.id];
      c.adminThread=thread;
      if(prompt.field!=='name')c.configEpoch=(c.configEpoch||0)+1;
      return { selected, operation: prompt.kind + (prompt.field ? ':' + prompt.field : '') };
    }, from.id);
    let notice = apiNotice;
    for (const message of [prompt.message, prompt.inputMessage]) try { await deps.telegram(env, 'deleteMessage', { chat_id: env.TELEGRAM_CHAT_ID, message_id: message }); }
    catch {
      // The caller supplies the exact input message ID; no secret is echoed.
      if (message === prompt.inputMessage && (prompt.kind === 'newkey' || prompt.kind==='configure' || prompt.field === 'secret')) notice = '⚠ Bạn xoá tin chứa key giúp mình.';
    }
    if(prompt.kind==='bulk'||(prompt.kind==='newmodel'&&locate(result.c,result.result.selected).m.keys.length))return startCheck(env,from,thread,result.result.selected,ctx,origin,true,env.AI_ROUTER_V3_ENABLED==='1');
    if(env.AI_ROUTER_V3_ENABLED==='1'&&prompt.field!=='name'&&allKeys(result.c).some(x=>[x.u.id,x.m.id,x.k.id].includes(result.result.selected)))return startCheck(env,from,thread,result.result.selected,ctx,origin,true,true);
    return show(env, thread, result.result.selected, 0, false, notice);
  }
  async function inspect(env, item, testModel = false) {
    let result;
    try {
      const openRouter = new URL(item.u.url).hostname === 'openrouter.ai';
      const response = await fetch(endpoint(item.u, testModel ? 'chat' : openRouter ? 'key' : 'models'), {
        // Workers accepts manual/follow only. Never follow a redirect with a provider key.
        method: testModel ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { Authorization: 'Bearer ' + item.k.secret, 'Content-Type': 'application/json' },
        ...(testModel ? { body: JSON.stringify({ model: item.m.name, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }) } : {}),
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        if(openRouter&&!testModel&&(!data.data||typeof data.data!=='object'))return {...classify(415,'invalid response protocol'),checkedAt:Date.now()};
        const balance = openRouter ? data?.data?.limit_remaining : undefined;
        const expiry = data?.data?.expires_at ? Date.parse(data.data.expires_at) : NaN;
        result = Number.isFinite(expiry) && expiry <= Date.now()
          ? { status: 'auth', label: 'key đã hết hạn', retryAt: Date.now() + 86400000 }
          : Number.isFinite(balance) && balance <= 0 && !data?.data?.is_free_tier
          ? { status: 'quota', label: 'hết hạn mức key', retryAt: Date.now() + 900000 }
          : { status: testModel || openRouter ? 'ok' : 'unknown', label: testModel ? 'gọi model thành công' : openRouter ? 'key hợp lệ' + (Number.isFinite(balance) ? ' · hạn mức key còn ' + balance + ' USD' : ' · chưa xác minh số dư tài khoản') : 'đọc được model-list · chưa xác minh key/quota', retryAt: 0 };
      } else if (!testModel && response.status === 404) result = { status: 'unknown', label: 'không có API kiểm tra key · cần test model', retryAt: 0 };
      else result = failure(response.status, await response.text());
    } catch(error) { result = classify(0,'',error); }
    return { ...result, checkedAt: Date.now() };
  }
  async function startCheck(env, from, thread, target, ctx, origin, deep=false, automatic=false) {
    const c = await ensure(env);
    const items = allKeys(c).filter(x => target === 'all' || [x.u.id, x.m.id, x.k.id].includes(target)).map(x => x.k.id);
    if (!items.length) return send(env, thread, 'Chưa có key để kiểm tra.');
    const job = { id: id(), actor: from.id, thread, items, deep, automatic, cursor: 0, status: 'running', startedAt: Date.now(), token: id() + id() };
    await update(env, c => { c.jobs = Object.fromEntries(Object.entries(c.jobs || {}).filter(([, j]) => Date.now() - j.startedAt < 86400000)); if(!automatic&&Object.values(c.jobs).some(j => !j.kind&&j.status === 'running' && Date.now() - (j.leaseUntil || j.startedAt) < 60000)) throw Error('Đang kiểm tra key; chờ hoàn tất.'); c.jobs[job.id] = job; return { operation: 'check-start' }; }, from.id);
    await send(env, thread, '🔍 Đang check ' + items.length + ' key…', [[button('🌳 Bảng quản lý', 'view:root')]]);
    ctx.waitUntil(runCheck(env, job.id, job.token, origin));
  }
  async function runCheck(env, jobId, token, origin) {
    if((await config(env))?.jobs?.[jobId]?.kind==='routing')return runRouting(env,jobId,origin);
    let lease;
    const locked = await update(env, c => {
      const j = c.jobs[jobId];
      if (!j || j.token !== token || j.status === 'complete' || j.leaseUntil > Date.now()) return { skip: true, operation: 'check-skip' };
      lease = id(); j.lease = lease; j.leaseUntil = Date.now() + 45000; j.status = 'running'; return { operation: 'check-batch' };
    });
    if (locked.result.skip) return;
    const j = locked.c.jobs[jobId];
    const results = [];
    for (const keyId of j.items.slice(j.cursor, j.cursor + (j.deep?1:3))) {
      if(j.deep){const claim=await update(env,c=>{const x=locate(c,keyId);if(x.k.testLease?.until>Date.now())return {skip:true};x.k.testLease={id:lease,until:Date.now()+30000};return {operation:'check-key-lease'};});if(claim.result.skip){await update(env,c=>{if(c.jobs[jobId].lease===lease){c.jobs[jobId].leaseUntil=0;c.jobs[jobId].status='interrupted';}return {operation:'check-key-busy'};});return;}}
      try { const x = locate(locked.c, keyId); results.push({ id: keyId, secret: x.k.secret, url: x.u.url, model: x.m.name, endpoint: endpoint(x.u, j.deep?'chat':new URL(x.u.url).hostname === 'openrouter.ai' ? 'key' : 'models'), health: j.automatic?await chatCheck(x,endpoint):j.deep?await deepCheck(x,endpoint):await inspect(env, x) }); } catch { results.push({ id: keyId }); }
    }
    if(j.deep)for(const r of results)if(r.health)try{await recordRoute(env,locate(locked.c,r.id),r.health,r.health.status==='ok'?'':false,lease);}catch{/* Changed/deleted configuration is discarded. */}
    const saved = await update(env, c => {
      const job = c.jobs[jobId]; if (job.lease !== lease) return { skip: true, operation: 'check-stale' };
      for (const r of results) try { const x = locate(c, r.id); if (r.health && x.k.secret === r.secret && x.u.url === r.url && x.m.name === r.model && endpoint(x.u, j.deep?'chat':new URL(x.u.url).hostname === 'openrouter.ai' ? 'key' : 'models') === r.endpoint) x.k.health=j.deep?{...x.k.route}:r.health; } catch { /* deleted/edited while checking */ }
      job.cursor += results.length; job.leaseUntil = 0;
      job.status = job.cursor >= job.items.length ? 'complete' : 'running';
      return { operation: 'check-progress' };
    });
    if (saved.result.skip) return;
    const job = saved.c.jobs[jobId];
    if (job.status === 'complete') {
      const checked=allKeys(saved.c).filter(x=>job.items.includes(x.k.id));
      const models=[...new Set(checked.map(x=>x.m.id))];
      const pass=models.filter(m=>checked.some(x=>x.m.id===m&&x.k.route?.confirmed&&x.k.route.status==='ok')).length;
      await show(env, job.thread, 'root', 0, true, j.deep?'🩺 '+models.length+' model · '+pass+' PASS · '+(models.length-pass)+' FAIL/chưa xác minh':'✅ Đã check ' + job.items.length + ' key');
    }
    else {
      try {
        const response = await fetch(origin + '/internal/ai/check', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AI-Job-Signature': await jobSignature(env, jobId, token) }, body: JSON.stringify({ jobId, token }), signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw Error('continuation');
      } catch { await update(env, c => { c.jobs[jobId].status = 'interrupted'; return { operation: 'check-interrupted' }; }); await send(env, job.thread, '🔄 Tự tiếp tục kiểm tra khi kết nối phục hồi.'); }
    }
  }
  async function internal(env, request, ctx) {
    const raw = await request.text(); if (raw.length > 1024) return new Response('', { status: 403 });
    let body; try { body = JSON.parse(raw); } catch { return new Response('', { status: 403 }); }
    if (!/^[a-f0-9]{16}$/.test(body.jobId || '') || !/^[a-f0-9]{32}$/.test(body.token || '') || request.headers.get('X-AI-Job-Signature') !== await jobSignature(env, body.jobId, body.token)) return new Response('', { status: 403 });
    const c = await config(env); const j = c?.jobs?.[body.jobId];
    if (!j || j.token !== body.token || Date.now() - j.startedAt > 86400000) return new Response('', { status: 403 });
    ctx.waitUntil(runCheck(env, j.id, j.token, new URL(request.url).origin));
    return Response.json({ ok: true });
  }
  async function handle(env, updateMessage, ctx, origin) {
    const cb = updateMessage.callback_query, msg = updateMessage.message;
    const data = String(cb?.data || ''); const command = String(msg?.text || '').trim();
    const from = cb?.from || msg?.from, chat = cb?.message?.chat || msg?.chat;
    const thread = cb?.message?.message_thread_id || msg?.message_thread_id || 0;
    const prompt = !cb && msg?.reply_to_message ? (await config(env))?.prompts?.[from?.id] : null;
    const relevant = data.startsWith('a2:') || data.startsWith('ai:') || /^\/ai(?:@\w+)?(?:\s|$)/i.test(command) || command === '/cancel' || (prompt && prompt.message === msg.reply_to_message.message_id);
    if (!relevant) return false;
    if (!(await authorized(env, from, chat))) {
      if (cb) await deps.telegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Chỉ quản trị viên nhóm được quản lý AI.', show_alert: true });
      return true;
    }
    if (cb && /^(help|info)(:|$)/.test(data.slice(3))) {
      let text;
      try {
        if (data === 'a2:help') text = 'Dán URL/model/key bằng 3 dòng. Tự nhận diện, test và chuyển key → model → URL. Probe ngắn có thể tính phí. Xem cây để biết từng cấu hình đang hoạt động/lỗi.';
        else { const l = locate(await ensure(env), data.slice(8)); text = label(l.node) + '\n' + (l.k ? mask(l.k.secret) + '\n' + state(l.k) : '') + '\nModel: ' + l.m?.name; }
      } catch (error) { text = error.message; }
      try { await deps.telegram(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: text.slice(0, 200), show_alert: true }); } catch { /* expired popup */ }
      return true;
    }
    if (cb?.message?.message_id) await panel(env, thread, { messageId: cb.message.message_id });
    if (cb) try { await deps.telegram(env, 'answerCallbackQuery', { callback_query_id: cb.id }); } catch { /* expired acknowledgment does not block action */ }
    try {
      if (!cb) {
        if (command === '/cancel') { await update(env, c => { delete c.prompts[from.id]; return { operation: 'cancel' }; }, from.id); await show(env, thread); }
        else if (prompt && prompt.message === msg.reply_to_message?.message_id) {
          if (prompt.expires < Date.now() || prompt.thread !== thread) throw Error('Phiên nhập hết hạn. Mở lại /ai.');
          await applyValue(env, from, thread, command, { ...prompt, inputMessage: msg.message_id },ctx,origin);
        } else { await show(env, thread); }
        return true;
      }
      if (data.startsWith('ai:')) { await show(env, thread); return true; }
      const [action, a, b] = data.slice(3).split(':');
      if (action === 'view' || action === 'page') await show(env, thread, a, Number(b) || 0);
      else if (action === 'tree') await show(env, thread, 'root', 0, true);
      else if (action === 'endpoints') {
        const l = locate(await ensure(env), a); if(l.type !== 'url')throw Error('Chọn URL.');
        await send(env, thread, '🔗 ' + label(l.u) + '\nChat: ' + endpoint(l.u, 'chat') + '\nModels: ' + endpoint(l.u, 'models') + '\nKey: ' + endpoint(l.u, 'key'), [
          [button('✏ Chat', 'edit:ep_chat:' + a), button('✏ Models', 'edit:ep_models:' + a), button('✏ Key', 'edit:ep_key:' + a)],
          [button('⬅ Quay lại', 'view:' + a)],
        ]);
      }
      else if (action === 'audit') { const c = await ensure(env); await send(env, thread, '🕒 GẦN ĐÂY\n' + (c.failoverHistory||[]).slice(-5).reverse().map(e=>new Date(e.at).toLocaleTimeString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})+' · '+(e.from||'mới')+' → '+e.to+' · '+e.errorClass+' · rev '+e.revision).concat(c.audit.slice(-3).reverse().map(e => new Date(e.at).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) + ' · ' + e.operation)).join('\n'), [[button('⬅ Quay lại', 'view:root')]]); }
      else if(action==='chat')await ask(env,from,thread,{kind:'chat'},'💬 Nhập câu hỏi cho AI.');
      else if(action==='configure')await ask(env,from,thread,{kind:'configure'},'Dán 3 dòng: URL, model, API key. Tự nhận diện và test; probe ngắn có thể tính phí. Tin nhập sẽ được xoá.');
      else if (action === 'newurl') await ask(env, from, thread, { kind: 'newurl' }, '🌐 Nhập tên URL/nhà cung cấp.');
      else if (action === 'newmodel') await ask(env, from, thread, { kind: 'newmodel', target: a }, '🧠 Nhập mã model. Nếu URL có key, tự test; có thể tính phí.');
      else if (action === 'addapi') {
        const l = locate(await ensure(env), a);
        if (l.type !== 'url') throw Error('Chọn URL.');
        if (!l.node.models.length) throw Error('URL chưa có model. Thêm model trước.');
        await ask(env, from, thread, { kind: 'addapi', target: a }, '🔑 Dán API key. Key sẽ được áp cho TẤT CẢ ' + l.node.models.length + ' model của URL này.');
      }
      else if (action === 'rmmodel' || action === 'rmapi') {
        const c = await ensure(env), l = locate(c, a);
        const what = action === 'rmmodel'
          ? 'model ' + label(l.node) + ' (' + l.node.keys.length + ' API)'
          : 'API ' + apiName(l.k.secret) + ' khỏi ' + urlApis(l.u).find(g => g.secret === l.k.secret).keys.length + ' model';
        await update(env, c => { c.prompts[from.id] = { kind: action, target: a, revision: c.revision + 1, expires: Date.now() + 120000 }; return { operation: action + '-confirm' }; }, from.id);
        await send(env, thread, '🗑 Xoá ' + what + '?\nURL: ' + l.u.url, [[button('🗑 Xác nhận xoá', 'do' + action + ':' + a), button('Huỷ', 'view:' + l.u.id)]]);
      }
      else if (action === 'dormmodel' || action === 'dormapi') {
        const real = action === 'dormmodel' ? 'rmmodel' : 'rmapi';
        let notice = '', backTo = 'root';
        await update(env, c => {
          const p = c.prompts[from.id];
          if (!p || p.kind !== real || p.target !== a || p.expires < Date.now() || p.revision !== c.revision) throw Error('Cấu hình đã thay đổi hoặc xác nhận hết hạn. Bấm xoá lại.');
          const l = locate(c, a);
          backTo = l.u.id;
          if (real === 'rmmodel') {
            if (l.type !== 'model') throw Error('Chỉ xoá được model ở đây.');
            const idx = l.u.models.findIndex(m => m.id === a);
            notice = '🗑 Đã xoá model ' + label(l.u.models[idx]) + '.';
            l.u.models.splice(idx, 1);
            if (!c.urls.some(u => u.models.some(m => m.id === c.activeModel))) c.activeModel = '';
          } else {
            const delta = detachApi(l.u, a);
            notice = '🗑 Đã xoá API ' + apiName(delta.secret) + ' khỏi ' + delta.removed + ' model.';
          }
          delete c.prompts[from.id];
          c.configEpoch = (c.configEpoch || 0) + 1;
          return { operation: action };
        }, from.id);
        await show(env, thread, backTo, 0, false, notice);
      }
      else if (action === 'bulk') await ask(env,from,thread,{kind:'bulk',target:a},'🧠 Dán model, mỗi dòng một mã. Dùng key của URL này để test; có thể tính phí.');
      else if (action === 'copykey' || action === 'copyconfig') {
        const l=locate(await ensure(env),a);if(!l.k)throw Error('Chọn key.');
        const text=action==='copykey'?l.k.secret:'URL: '+l.u.url+'\nMODEL: '+l.m.name+'\nAPI KEY: '+l.k.secret+'\nPROTOCOL: '+(l.k.route?.protocol||'chat');
        try {await deps.telegram(env,'sendMessage',{chat_id:from.id,text,...(text.length<=512?{reply_markup:{inline_keyboard:[[{text:'📋 Copy',copy_text:{text}}]]}}:{})});await send(env,thread,'✅ Đã gửi vào chat riêng với bot.');}
        catch {const me=await deps.telegram(env,'getMe',{});await send(env,thread,'Mở bot riêng, bấm Start rồi thử lại.',[[{text:'Mở bot',url:'https://t.me/'+me.username}],[button('⬅ Quay lại','view:'+a)]]);}
      }
      else if (action === 'newkey') await ask(env, from, thread, { kind: 'newkey', target: a }, '🔑 Nhập tên để nhận biết key (không phải giá trị key).');
      else if (action === 'edit') await ask(env, from, thread, { kind: 'edit', field: a, target: b }, a.startsWith('ep_') ? '🔗 Nhập đường dẫn hoặc URL endpoint cùng máy chủ. Gõ - để dùng mặc định.' : '✏ Nhập ' + ({ name: 'tên mới', url: 'URL HTTPS mới', model: 'mã model mới', secret: 'API key mới' }[a] || 'giá trị mới') + '.');
      else if (action === 'delete') {
        const c = await ensure(env); const l = locate(c, a);
        const count = l.type === 'url' ? l.node.models.reduce((n, m) => n + m.keys.length, 0) : l.type === 'model' ? l.node.keys.length : 1;
        await update(env, c => { c.prompts[from.id] = { kind: 'delete', target: a, revision: c.revision + 1, expires: Date.now() + 120000 }; return { operation: 'delete-confirm' }; }, from.id);
        await send(env, thread, '🗑 Xoá ' + l.node.name + ' và các mục con (' + count + ' key)?', [[button('🗑 Xác nhận xoá', 'confirm:' + a), button('Huỷ', 'view:' + a)]]);
      } else if (action === 'confirm' || action === 'toggle' || action === 'active' || action === 'up' || action === 'down') {
        await update(env, c => {
          const l = locate(c, a), n = l.node;
          if (action === 'confirm') {
            const p = c.prompts[from.id]; if (!p || p.kind !== 'delete' || p.target !== a || p.expires < Date.now() || p.revision !== c.revision) throw Error('Cấu hình đã thay đổi hoặc xác nhận hết hạn. Bấm Xoá lại.');
            l.list.splice(l.list.indexOf(n), 1); delete c.prompts[from.id];
            if (!c.urls.some(u => u.models.some(m => m.id === c.activeModel))) c.activeModel = '';
          } else if (action === 'toggle') { n.enabled = !n.enabled; if(n.enabled) { n.retryAt = 0; if(l.k)n.health.retryAt = 0; } }
          else if (action === 'active') { if (l.type !== 'model') throw Error('Chọn model.'); c.activeModel = n.id;c.routingPreference=n.id;c.sticky={}; n.enabled = true; n.retryAt = 0; l.u.enabled = true; l.u.retryAt = 0; }
          else { const i = l.list.indexOf(n), next = Math.max(0, Math.min(l.list.length - 1, i + (action === 'up' ? -1 : 1))); l.list.splice(i, 1); l.list.splice(next, 0, n); }
          c.configEpoch=(c.configEpoch||0)+1;
          return { operation: action };
        }, from.id);
        await show(env, thread, action === 'confirm' ? 'root' : a);
      } else if (action === 'check') await startCheck(env, from, thread, a, ctx, origin,env.AI_ROUTER_V3_ENABLED==='1');
      else if(action==='deep') {
        await update(env,c=>{c.prompts[from.id]={kind:'deep',target:a,revision:c.revision+1,expires:Date.now()+120000};return {operation:'deep-confirm'};},from.id);
        await send(env,thread,'🩺 Test chat, stream và tools. Có thể tính phí.',[[button('Chạy deep test','deepgo:'+a),button('Huỷ','view:root')]]);
      } else if(action==='deepgo') {
        await update(env,c=>{const p=c.prompts[from.id];if(!p||p.kind!=='deep'||p.target!==a||p.expires<Date.now()||p.revision!==c.revision)throw Error('Xác nhận hết hạn hoặc cấu hình đã đổi.');delete c.prompts[from.id];return {operation:'deep-run'};},from.id);
        await startCheck(env,from,thread,a,ctx,origin,true);
      }
      else if (action === 'test') {
        const c = await ensure(env); const l = locate(c, a); if (l.type !== 'key') throw Error('Chọn key.');
        await update(env, c => { c.prompts[from.id] = { kind: 'test', target: a, revision: c.revision + 1, expires: Date.now() + 120000 }; return { operation: 'test-confirm' }; }, from.id);
        await send(env, thread, '🧪 Test ' + l.m.name + '? Có thể tính phí.', [[button('🧪 Chạy test', 'testgo:' + a), button('Huỷ', 'view:' + a)]]);
      } else if (action === 'testgo') {
        const saved = await update(env, c => { const p = c.prompts[from.id]; if (!p || p.kind !== 'test' || p.target !== a || p.expires < Date.now() || p.revision !== c.revision) throw Error('Xác nhận đã hết hạn hoặc cấu hình đã đổi.'); delete c.prompts[from.id]; return { operation: 'test-run' }; }, from.id);
        const l = locate(saved.c, a), health = await inspect(env, l, true);
        await update(env, c => { const current = locate(c, a); if(current.k.secret === l.k.secret && current.u.url === l.u.url && current.m.name === l.m.name && endpoint(current.u,'chat') === endpoint(l.u,'chat'))current.k.health = health; return { operation: 'test-result' }; }, from.id);
        await show(env, thread, a);
      }
      else if (action === 'resume') { const c = await ensure(env), j = c.jobs[a]; if (!j || j.status === 'complete') throw Error('Không có tác vụ để tiếp tục.'); ctx.waitUntil(runCheck(env, j.id, j.token, origin)); await send(env, thread, '▶ Tiếp tục kiểm tra.'); }
      else throw Error('Nút không còn hợp lệ. Mở lại /ai.');
    } catch (error) { await send(env, thread, '⚠ ' + error.message, [[button('🌳 Mở cây', 'view:root')]]); }
    return true;
  }
  async function publicActive(env) {
    const c=await config(env);
    const current=c?.currentConfig, x=current&&allKeys(c).find(x=>configurationId(x)===current.id);
    return {revision:c?.activeRevision||0,active:x?{id:current.id,provider:x.u.name,model:x.m.name,protocol:x.k.route?.protocol||'chat',capabilities:x.k.route?.capabilities||{}}:null};
  }
  async function registerVerifiedModel(env,urlId,name,keyId,proof) {
    if(proof.status!=='ok'||proof.capabilities?.chat!==true||proof.resolved?.model!==name)throw Error('Model chưa được kiểm tra thành công.');
    const saved=await update(env,c=>{
      const source=locate(c,keyId);if(source.u.id!==urlId||proof.resolved.baseUrl!==source.u.url)throw Error('Cấu hình đã thay đổi.');
      let m=source.u.models.find(m=>m.name===name);
      if(!m){if(source.u.models.length>=30)throw Error('Tối đa 30 model/URL.');m={id:id(),name,enabled:true,keys:[]};source.u.models.push(m);}
      let k=m.keys.find(k=>k.secret===source.k.secret);
      if(!k){if(allKeys(c).length>=500)throw Error('Tối đa 500 key.');k={id:id(),name:source.k.name,secret:source.k.secret,enabled:true,health:{}};m.keys.push(k);}
      k.route=healthResult(k.route,proof);k.route.fingerprint=endpoint(source.u,'chat')+'|'+name;k.health={...k.route};
      return {operation:'verified-model',selected:k.id};
    });
    return saved.result.selected;
  }
  async function telegramChat(env,from,thread,text) {
    const conversation='telegram:'+thread+':'+from.id;
    const typing=setInterval(()=>{deps.telegram(env,'sendChatAction',{chat_id:env.TELEGRAM_CHAT_ID,...(thread?{message_thread_id:thread}:{}),action:'typing'}).catch(()=>{});},4000);
    try {
      const c=await config(env),history=c.telegramHistory?.[conversation]||[];
      const response=await proxy(env,{messages:[{role:'system',content:'Bạn hỗ trợ thuế doanh nghiệp và kế toán. Trả lời ngắn, rõ; nói rõ khi chưa có nguồn xác minh. Không tự khẳng định dữ liệu hóa đơn trong ứng dụng nếu không được cung cấp.'},...history,{role:'user',content:text}],stream:false,max_tokens:1024},conversation);
      if(!response?.ok)throw Error('AI đang tạm gián đoạn. Thử lại sau.');
      const data=await response.json();let answer=String(data.choices?.[0]?.message?.content||'AI chưa trả nội dung.');
      for(const x of allKeys(c))answer=answer.split(x.k.secret).join('[key ẩn]');
      await update(env,c=>{c.telegramHistory||={};c.telegramHistory[conversation]=[...history,{role:'user',content:text},{role:'assistant',content:answer.slice(0,4000)}].slice(-12);c.telegramHistory=Object.fromEntries(Object.entries(c.telegramHistory).slice(-100));return {operation:'telegram-chat'};},from.id);
      await deps.telegram(env,'sendMessage',{chat_id:env.TELEGRAM_CHAT_ID,...(thread?{message_thread_id:thread}:{}),text:answer.slice(0,3900),reply_markup:{inline_keyboard:[[button('💬 Hỏi tiếp','chat')]]}});
    }catch{await send(env,thread,'AI đang tạm gián đoạn. Thử lại sau.');}
    finally{clearInterval(typing);}
  }
  const enabledKeys=c=>allKeys(c).filter(x=>x.u.enabled&&x.m.enabled&&x.k.enabled);
  const basicChat=required=>!required.stream&&!required.tools&&!required.vision&&!required.structured;
  // `tools` không tính vào điều kiện phải kiểm tra lại (xem ghi chú ở compatible): model chat tốt
  // vẫn phục vụ được, app tự lo phần gọi tool bằng JSON protocol.
  const needsTest=(x,required)=>x.k.route?.fingerprint!==endpoint(x.u,'chat')+'|'+x.m.name||x.k.route?.circuit==='OPEN'||Object.entries(required).some(([k,v])=>v&&k!=='tools'&&x.k.route?.capabilities?.[k]!==true);
  async function enqueueRouting(env,required,thread=0) {
    return (await update(env,c=>{
      const signature=JSON.stringify(required)+':'+(c.configEpoch||0);
      const previous=Object.values(c.jobs||{}).find(j=>j.kind==='routing'&&j.signature===signature&&['running','interrupted','waiting','ready','exhausted'].includes(j.status)&&(j.status!=='ready'||enabledKeys(c).some(x=>configurationId(x)===j.readyId&&x.k.route?.status==='ok'&&compatible(x.k.route,required)&&(x.k.route.retryAt||0)<=Date.now())));
      if(previous)return {skip:true,jobId:previous.id};
      const job={id:id(),kind:'routing',required,signature,epoch:c.configEpoch||0,thread,items:enabledKeys(c).map(x=>x.k.id),cursor:0,status:'running',startedAt:Date.now(),token:id()+id(),errors:{}};
      c.jobs||={};c.jobs=Object.fromEntries(Object.entries(c.jobs).filter(([,j])=>Date.now()-j.startedAt<86400000||j.status==='running'||j.status==='waiting'));c.jobs[job.id]=job;return {operation:'routing-enqueue',jobId:job.id};
    })).result.jobId;
  }
  async function publicJob(env,jobId) {
    const c=await config(env),j=c?.jobs?.[jobId];if(!j||j.kind!=='routing')return null;
    const ready=['running','interrupted','waiting'].includes(j.status)&&enabledKeys(c).some(x=>x.k.route?.status==='ok'&&(x.k.route.retryAt||0)<=Date.now()&&(x.k.health?.retryAt||0)<=Date.now()&&!needsTest(x,j.required)&&compatible(x.k.route,j.required));
    return {jobId:j.id,status:ready?'ready':j.status,processed:j.cursor,total:j.items.length,retryAt:j.retryAt||0,retryAfter:3,errors:j.errors||{},reasons:j.reasons||{},revision:c.activeRevision||0};
  }
  async function continueJob(env,j,origin) {
    if(!origin||!['running','interrupted'].includes(j.status))return;
    try {const r=await fetch(origin+'/internal/ai/check',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','X-AI-Job-Signature':await jobSignature(env,j.id,j.token)},body:JSON.stringify({jobId:j.id,token:j.token}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('continuation');}
    catch {await update(env,c=>{const current=c.jobs[j.id];if(current?.status==='running')current.status='interrupted';return {operation:'routing-continuation-wait'};});}
  }
  async function runRouting(env,jobId,origin='') {
    const lease=id();
    const locked=await update(env,c=>{
      const j=c.jobs?.[jobId];if(!j||j.kind!=='routing'||['ready','exhausted','superseded'].includes(j.status)||j.leaseUntil>Date.now()||j.retryAt>Date.now())return {skip:true};
      if(j.epoch!==(c.configEpoch||0)){j.status='superseded';return {operation:'routing-superseded'};}
      j.lease=lease;j.leaseUntil=Date.now()+35000;j.status='running';return {operation:'routing-batch'};
    });
    if(locked.result.skip)return;
    const j=locked.c.jobs[jobId];if(j.status==='superseded')return;
    // MỘT cấu hình mỗi lượt. Đã thử chạy 3 cái song song: vượt hạn mức thời gian của Worker,
    // bị ngắt giữa chừng nên khoá thử nghiệm bị treo và vòng quét ĐỨNG YÊN ở 0/9. Tuần tự thì
    // chậm hơn nhưng TIẾN ĐỀU và không bao giờ kẹt — quan trọng hơn tốc độ.
    const keyId=j.items[j.cursor];let checked,chosen='',busy=false;
    if(keyId)try {
      const x=locate(locked.c,keyId);
      if(x.u.enabled&&x.m.enabled&&x.k.enabled&&(x.k.route?.retryAt||0)<=Date.now()&&(x.k.health?.retryAt||0)<=Date.now()) {
        if(!needsTest(x,j.required)&&compatible(x.k.route,j.required)&&x.k.route.status==='ok')chosen=configurationId(x);
        else {
          const claim=await update(env,c=>{const y=locate(c,keyId);if(y.k.testLease?.until>Date.now())return {skip:true};y.k.testLease={id:lease,until:Date.now()+30000};return {operation:'routing-key-lease'};});
          busy=claim.result.skip;
          if(!busy){checked=basicChat(j.required)?await chatCheck(x,endpoint):await deepCheck(x,endpoint,{tools:j.required.tools,vision:j.required.vision,structured:j.required.structured});await recordRoute(env,x,checked,checked.status==='ok'&&compatible(checked,j.required)?'':false,lease);if(checked.status==='ok'&&!Object.entries(j.required).some(([k,v])=>v&&checked.capabilities?.[k]!==true))chosen=configurationId(x);}
        }
      }
    }catch{/* Edits/deletions are handled by epoch and snapshot validation. */}
    const saved=await update(env,c=>{
      const current=c.jobs[jobId];if(current.lease!==lease)return {skip:true};current.leaseUntil=0;
      if(current.epoch!==(c.configEpoch||0)){current.status='superseded';return {operation:'routing-superseded'};}
      if(busy){current.status='waiting';current.retryAt=Date.now()+3000;return {operation:'routing-lease-wait'};}
      current.cursor++;
      if(checked?.errorClass){
        current.errors[checked.errorClass]=(current.errors[checked.errorClass]||0)+1;
        // Lưu NGUYÊN VĂN thông báo của nhà cung cấp (đã che key) để biết chính xác vì sao hỏng,
        // thay vì chỉ thấy nhóm lỗi chung chung.
        if(checked.detail)current.reasons={...(current.reasons||{}),[checked.errorClass]:redactSecret(String(checked.detail).slice(0,240),c)};
      }
      if(chosen){current.status='ready';current.readyId=chosen;current.retryAt=0;}
      else if(current.cursor>=current.items.length){
        const pool=enabledKeys(c),permanent=pool.length===0||pool.every(x=>['INVALID_KEY','EXPIRED_KEY','AUTH_ERROR','QUOTA_EXCEEDED','MODEL_NOT_FOUND','PROTOCOL_UNSUPPORTED','CAPABILITY_MISMATCH','FREE_TIER_LOCKED'].includes(x.k.route?.lastError)||x.k.route?.status==='ok'&&!compatible(x.k.route,current.required));
        current.errors={};for(const x of pool){const reason=x.k.route?.lastError||(x.k.route?.status==='ok'&&!compatible(x.k.route,current.required)?'CAPABILITY_MISMATCH':'UNVERIFIED');current.errors[reason]=(current.errors[reason]||0)+1;}
        const times=pool.map(x=>Math.max(x.k.route?.retryAt||0,x.k.health?.retryAt||0)).filter(t=>t>Date.now());
        current.status=permanent?'exhausted':'waiting';current.retryAt=times.length?Math.min(...times):Date.now()+(permanent?300000:30000);current.cursor=current.items.length;
      }
      return {operation:'routing-progress'};
    });
    if(saved.result.skip)return;
    const next=saved.c.jobs[jobId];
    if(next.thread&&['ready','exhausted'].includes(next.status))await show(env,next.thread,'root',0,true,next.status==='ready'?'✅ Đã tự chọn cấu hình hoạt động.':'⚠ Hiện không có cấu hình phù hợp; tự kiểm tra lại khi đến hạn.');
    await continueJob(env,next,origin);
  }
  async function scheduled(env,ctx,origin='') {
    if(env.AI_ROUTER_V3_ENABLED!=='1')return;
    const c=await ensure(env);
    await notifyPanel(env);
    // One provider check per invocation; durable cursors cover the entire registry.
    const manual=Object.values(c.jobs||{}).find(j=>!j.kind&&['running','interrupted'].includes(j.status)&&!(j.leaseUntil>Date.now()));
    if(manual){await runCheck(env,manual.id,manual.token,origin);return;}
    await update(env,c=>{let changed=false;for(const j of Object.values(c.jobs||{}))if(j.kind==='routing'&&['waiting','exhausted'].includes(j.status)&&(j.retryAt||0)<=Date.now()){j.status='running';j.cursor=j.cursor>=j.items.length?0:j.cursor;j.retryAt=0;j.errors={};changed=true;}return changed?{operation:'routing-recovery'}:{skip:true};});
    const latest=await config(env);let job=Object.values(latest.jobs||{}).find(j=>j.kind==='routing'&&['running','interrupted'].includes(j.status)&&!(j.leaseUntil>Date.now()));
    if(!job) {
      const recover=enabledKeys(latest).filter(x=>(!x.k.route?.checkedAt||x.k.route?.circuit==='OPEN')&&(x.k.route?.retryAt||0)<=Date.now()&&(x.k.health?.retryAt||0)<=Date.now()).sort((a,b)=>(a.k.route?.checkedAt||0)-(b.k.route?.checkedAt||0))[0];
      if(recover){const next={id:id(),actor:'system',thread:latest.adminThread||0,items:[recover.k.id],deep:true,automatic:true,cursor:0,status:'running',startedAt:Date.now(),token:id()+id()};await update(env,c=>{c.jobs[next.id]=next;return {operation:'automatic-recovery'};});await runCheck(env,next.id,next.token,origin);return;}
    }
    if(job)await runRouting(env,job.id,origin);
  }
  async function routerProxy(env, body, conversation='',ctx=null,origin='') {
    let c=await config(env);if(!c)return null;
    const cntaxBasic = body.metadata?.cntax_mode === 'basic';
    if (cntaxBasic && (body.stream !== false || body.tools?.length)) return Response.json({ error: { code: 'BASIC_PROTOCOL_INVALID' } }, { status: 400 });
    const required=requiredCapabilities(body), sticky=conversation&&c.sticky?.[conversation];
    // Cấu hình đã xác minh ĐỦ khả năng đi trước, nhưng KHÔNG loại phần còn lại khỏi chuỗi:
    // bản ghi khả năng có thể đã cũ, và vòng lặp dưới tự kiểm tra lại rồi mới dùng. Trước đây
    // lọc cứng nên chuỗi rỗng ngay ⇒ trả 503 "đang tự tìm cấu hình" và khách phải đợi hàng phút,
    // trong khi Telegram chỉ cần chat thuần nên vẫn được phục vụ tức thì.
    const all=candidates(c);
    const compatibleChain=all.filter(x=>compatible(x.k.route,required));
    let chain=compatibleChain.length===all.length?all:[...compatibleChain,...all.filter(x=>!compatible(x.k.route,required))];
    const preferred=sticky?.id||(!c.routingPreference?c.currentConfig?.id:'');
    // Preserve manual URL/model priority; use health score to choose keys within a model.
    chain=chain.map((x,i)=>({...x,priority:i})).sort((a,b)=>a.m.id===b.m.id?(b.k.route?.healthScore||70)-(a.k.route?.healthScore||70)||a.priority-b.priority:a.priority-b.priority);
    const rank=x=>2*Number(configurationId(x)===preferred)+Number(!c.routingPreference&&configurationId(x)===c.lastKnownGood?.id);
    chain.sort((a,b)=>rank(b)-rank(a));
    if (cntaxBasic) {
      const allowed = String(env.AI_BASIC_CONFIG_IDS || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
      // One-time admin allowlist. Without it only the saved primary is allowed.
      const primary = c.currentConfig?.id || (chain[0] && configurationId(chain[0]));
      const ids = allowed.length ? allowed : [primary];
      chain = ids.map(id => chain.find(x => configurationId(x) === id)).filter(Boolean);
    }
    let attempts=0,discoveries=0,lastError='UNKNOWN_ERROR';const visited=new Set(),unusableKeys=new Set();const routingStarted=Date.now();
    for(const x of chain) {
      const configId=configurationId(x);if(visited.has(configId)||unusableKeys.has(x.u.id+':'+x.k.secret)||++attempts>(cntaxBasic?3:8))continue;visited.add(configId);
      let chatLease='';
      if(!cntaxBasic && needsTest(x,required)) {
        // Reserve capacity for Firebase/OAuth and a successful response on the free Worker limit.
        if(++discoveries>3)continue;
        const lease=id();
        const claim=await update(env,c=>{const y=locate(c,x.k.id);if(y.k.testLease?.until>Date.now())return {skip:true};y.k.testLease={id:lease,until:Date.now()+30000};return {operation:'resolver-lease'};});
        if(claim.result?.skip){lastError='HEALTH_CHECK_IN_PROGRESS';continue;}
        // Basic chat validates the actual user request; no preliminary stream/tool probes.
        if(basicChat(required))chatLease=lease;
        else {
        let checked;
        try{checked=await deepCheck(x,endpoint,{tools:required.tools,vision:required.vision,structured:required.structured});}catch(e){checked=classify(0,'',e);}
        await recordRoute(env,x,checked,false,lease);
        x.k.route=healthResult(x.k.route,checked);
        if(checked.status!=='ok'||!compatible(checked,required)){lastError=checked.errorClass||'CAPABILITY_MISMATCH';if(checked.failureScope==='credential'||['INVALID_KEY','EXPIRED_KEY'].includes(lastError))unusableKeys.add(x.u.id+':'+x.k.secret);if(lastError==='PROTOCOL_UNSUPPORTED'||Date.now()-routingStarted>20000)break;continue;}
        }
      }
      let result,failedAttempts=0;const requestStarted=Date.now();
      x.onStreamFailure=async error=>{await recordRoute(env,x,{...error,streamFailure:true});if(ctx)ctx.waitUntil(notifyPanel(env));};
      x.onStreamComplete=async()=>{await update(env,c=>{const y=locate(c,x.k.id);if(!y.k.route?.streamFailures||(y.k.route.lastFailure||0)>requestStarted)return {skip:true};y.k.route.streamFailures=0;y.k.health={...y.k.route};return {operation:'stream-complete'};});};
      for(let retry=0;retry<(cntaxBasic?1:2);retry++) {
        result=await resolveCall(x,body,endpoint,cntaxBasic?Math.max(1,Math.min(25000,85000-(Date.now()-routingStarted))):15000);
        if(!result.response)failedAttempts++;
        if(result.response||!['TIMEOUT','NETWORK_ERROR','PROVIDER_ERROR'].includes(result.error.errorClass))break;
      }
      if(!result.response){lastError=result.error.errorClass;await recordRoute(env,x,{...result.error,failureEvents:failedAttempts},false,chatLease);if(result.error.failureScope==='credential'||['INVALID_KEY','EXPIRED_KEY'].includes(lastError))unusableKeys.add(x.u.id+':'+x.k.secret);continue;}
      const published=await recordRoute(env,x,{status:'ok',label:'gọi model thành công',resolved:result.resolved,protocol:result.resolved.protocol,capabilities:{...x.k.route?.capabilities,chat:true},latency:result.latency,confirmed:true,requestStarted},conversation,chatLease);
      if(ctx)ctx.waitUntil(notifyPanel(env));
      const headers=new Headers(result.response.headers);
      headers.set('X-AI-Revision',String(published.c.activeRevision||0));headers.set('X-AI-Model',x.m.name);headers.set('Cache-Control','no-store');
      return new Response(result.response.body,{status:200,headers});
    }
    if (cntaxBasic) return Response.json({ error: { code: 'AI_BASIC_EXHAUSTED', message: 'Nguồn aichat được phép đã hết hạn mức hoặc không khả dụng.' } }, { status: 503 });
    const jobId=await enqueueRouting(env,required,c.adminThread||0);
    if(ctx)ctx.waitUntil(runRouting(env,jobId,origin));
    const job=await publicJob(env,jobId);
    if(ctx)ctx.waitUntil(notifyPanel(env));
    const code=job.status==='exhausted'?'AI_CONFIG_EXHAUSTED':lastError==='HEALTH_CHECK_IN_PROGRESS'?'HEALTH_CHECK_IN_PROGRESS':'AI_ROUTING_PENDING';
    return Response.json({error:{message:code==='AI_CONFIG_EXHAUSTED'?'Toàn bộ cấu hình đã kiểm tra hiện không dùng được.':'Đang tự tìm cấu hình phù hợp.',code},...job},{status:503,headers:{'Retry-After':'3'}});
  }
  async function recordRoute(env,x,result,conversation=false,lease='') {
    return update(env,c=>{
      const y=locate(c,x.k.id);
      if(y.k.secret!==x.k.secret||y.m.name!==x.m.name||endpoint(y.u,'chat')!==endpoint(x.u,'chat'))return {skip:true};
      if(result.status!=='ok'&&y.k.route?.lastError===result.errorClass&&y.k.route?.retryAt>Date.now())return {skip:true};
      if(result.status==='ok'&&result.requestStarted&&(y.k.route?.lastFailure||0)>result.requestStarted)return {skip:true};
      if(lease&&y.k.testLease?.id!==lease)return {skip:true};
      if(lease)delete y.k.testLease;
      const streamFailures=result.streamFailure?(y.k.route?.streamFailures||0)+1:y.k.route?.streamFailures||0;
      y.k.route=healthResult(y.k.route,result.streamFailure?{...result,failureEvents:streamFailures}:result);
      y.k.route.streamFailures=streamFailures;
      y.k.route.cooldownUntil=y.k.route.retryAt;
      Object.assign(y.k.route,{provider:y.u.name,baseUrl:y.u.url,model:y.m.name,keyReference:y.k.id,configurationId:configurationId(y),priority:{url:c.urls.indexOf(y.u),model:y.u.models.indexOf(y.m),key:y.m.keys.indexOf(y.k)}});
      y.k.route.fingerprint=result.status==='ok'?endpoint(x.u,'chat')+'|'+x.m.name:y.k.route.fingerprint;
      y.k.health={...y.k.health,...y.k.route};
      c.panelDirtyAt=Date.now();
      if(result.failureScope==='credential'||['INVALID_KEY','EXPIRED_KEY'].includes(result.errorClass))for(const z of allKeys(c))if(z.u.id===y.u.id&&z.k.id!==y.k.id&&z.k.secret===y.k.secret){z.k.route=healthResult(z.k.route,result);z.k.health={...z.k.health,...z.k.route};}
      if(result.confirmed&&result.status==='ok'&&conversation!==false) {
        const next={id:configurationId(y),at:Date.now()};
        c.lastKnownGood ||= c.currentConfig || next;
        const current=c.currentConfig&&allKeys(c).find(z=>configurationId(z)===c.currentConfig.id);
        const ready=current&&current.u.enabled&&current.m.enabled&&current.k.enabled&&(current.k.route?.retryAt||0)<=Date.now()&&current.k.route?.status==='ok';
        if(c.currentConfig?.id!==next.id&&(!ready||c.routingPreference===y.m.id)) {
          const previous=c.currentConfig;
          if(previous)c.lastKnownGood=previous;
          c.currentConfig=next;c.activeRevision=(c.activeRevision||0)+1;
          const prior=previous&&allKeys(c).find(z=>configurationId(z)===previous.id);
          c.failoverHistory=[...(c.failoverHistory||[]),{at:next.at,from:previous?.id||'',to:next.id,reason:previous?'failover':'verified',errorClass:prior?.k.route?.lastError||'',revision:c.activeRevision}].slice(-50);
        }
        if(c.routingPreference===y.m.id)delete c.routingPreference;
        if(conversation){c.sticky||={};c.sticky[conversation]={id:next.id,at:Date.now()};c.sticky=Object.fromEntries(Object.entries(c.sticky).sort((a,b)=>b[1].at-a[1].at).slice(0,500));}
      }
      return {operation:result.status==='ok'?'route-success':'route-failure'};
    });
  }
  async function notifyPanel(env) {
    let dirty=0;
    try {
      const claimed=await update(env,c=>{if(!c.adminThread||!c.panelDirtyAt||c.panelDirtyAt<=(c.panelSyncedAt||0)||Date.now()-(c.panelNotifyAt||0)<5000)return {skip:true};c.panelNotifyAt=Date.now();c.panelSyncedAt=c.panelDirtyAt;return {operation:'panel-refresh'};});
      if(!claimed.result.skip){dirty=claimed.c.panelSyncedAt;await show(env,claimed.c.adminThread,'root',0,true);}
    }catch{if(dirty)try{await update(env,c=>{if(c.panelSyncedAt===dirty)c.panelSyncedAt=0;return {operation:'panel-retry'};});}catch{/* Scheduler retries notification, never blocks chat. */}}
  }
  async function proxy(env, body, conversation='',ctx=null,origin='') {
    if(env.AI_ROUTER_V3_ENABLED==='1')return routerProxy(env,body,conversation,ctx,origin);
    const c = await config(env); if (!c) return null;
    const chain = candidates(c);
    if (!chain.length) return new Response('Không có key khả dụng. Mở /ai để kiểm tra hoặc bật key.', { status: 503 });
    const updates = []; let last, attempts = 0; const skipModels = new Set(), skipURLs = new Set(), badKeys = new Set();
    for (const x of chain) {
      if (skipModels.has(x.m.id) || skipURLs.has(x.u.id) || badKeys.has(x.u.id + ':' + x.k.secret) || badKeys.has(x.m.id + ':' + x.k.secret)) continue;
      if (++attempts > 40) break;
      let response, detail;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          response = await fetch(endpoint(x.u, 'chat'), { method: 'POST', redirect: 'manual', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + x.k.secret }, body: JSON.stringify({ ...body, model: x.m.name }) });
        } finally { clearTimeout(timer); }
        if (response.ok) {
          updates.push({ ...x, health: { status: 'ok', label: 'gọi model thành công', checkedAt: Date.now(), retryAt: 0 } });
          await saveHealth(env, updates);
          return new Response(response.body, { status: 200, headers: { 'Content-Type': response.headers.get('Content-Type') || 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
        }
        detail = await response.text(); last = response.status;
      } catch { skipURLs.add(x.u.id); updates.push({ ...x, urlRetryAt: Date.now() + 30000 }); last = 502; continue; }
      if ([401, 402, 403, 429].includes(response.status) || /quota|credit|balance|insufficient|rate.limit/i.test(detail)) {
        const health = { ...failure(response.status, detail), checkedAt: Date.now() };
        const global = [401, 402].includes(response.status);
        updates.push({ ...x, health, global });
        // A shared credential failing at this URL is skipped in all its models.
        badKeys.add((global ? x.u.id : x.m.id) + ':' + x.k.secret);
      } else if (response.status === 404 || /model.*(?:not found|unavailable|disabled|not supported)|(?:does not|doesn't) support.*(?:tool|image|vision)/i.test(detail)) { skipModels.add(x.m.id); updates.push({ ...x, modelRetryAt: Date.now() + 300000 }); }
      else if (response.status >= 500) { skipURLs.add(x.u.id); updates.push({ ...x, urlRetryAt: Date.now() + 30000 }); }
      else { if (updates.length) await saveHealth(env, updates); return new Response('Nhà cung cấp từ chối dữ liệu yêu cầu (HTTP ' + response.status + ').', { status: response.status }); }
    }
    if (updates.length) await saveHealth(env, updates);
    return new Response('Đã thử các key/model/URL khả dụng; nhà cung cấp đều từ chối hoặc không kết nối được. HTTP cuối: ' + last, { status: last >= 400 ? last : 503 });
  }
  async function saveHealth(env, updates) {
    try { await update(env, c => {
      for (const x of updates) for (const y of allKeys(c)) {
        if (endpoint(y.u, 'chat') !== endpoint(x.u, 'chat')) continue;
        if (x.modelRetryAt && y.m.id === x.m.id && y.m.name === x.m.name) y.m.retryAt = x.modelRetryAt;
        if (x.urlRetryAt && y.u.id === x.u.id && y.u.url === x.u.url) y.u.retryAt = x.urlRetryAt;
        if (x.health && y.u.url === x.u.url && y.k.secret === x.k.secret && (x.global || y.m.id === x.m.id)) y.k.health = x.health;
      }
      return { operation: 'failover-health' };
    }); } catch { console.log('AI health persistence unavailable'); }
  }
  return { handle, internal, proxy, config, ensure, show, inspect, runCheck, publicActive, recordRoute, registerVerifiedModel, scheduled, runRouting, publicJob, enqueueRouting };
}
