'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('support-panel');
  const resizeHandle = $('chat-resize');
  let chatWidth = 600, dragFrame = 0, dragX = null;
  try { chatWidth = Math.max(520, Number(localStorage.getItem('hd-chat-width')) || 600); } catch {}
  function widthLimits() {
    const sidebar = innerWidth <= 760 ? 0 : innerWidth <= 860 ? 200 : innerWidth <= 1100 ? 214 : 250;
    const max = Math.max(230, Math.min(1000, innerWidth - sidebar - (innerWidth <= 760 ? 24 : 260)));
    return { min: Math.min(280, max), max };
  }
  function setChatWidth(value, persist = false) {
    const { min, max } = widthLimits();
    const width = Math.round(Math.max(min, Math.min(max, value)));
    document.documentElement.style.setProperty('--chat-width', width + 'px');
    resizeHandle.setAttribute('aria-valuemin', String(min)); resizeHandle.setAttribute('aria-valuemax', String(max)); resizeHandle.setAttribute('aria-valuenow', String(width));
    if (persist) { chatWidth = width; try { localStorage.setItem('hd-chat-width', String(width)); } catch {} }
  }
  function syncDock() { document.body.classList.toggle('chat-open', !panel.hidden); setChatWidth(chatWidth); }
  function finishResize(event) {
    if (dragX === null) return;
    cancelAnimationFrame(dragFrame); dragFrame = 0; setChatWidth(document.documentElement.clientWidth - dragX, true); dragX = null;
    document.body.classList.remove('chat-resizing');
    if (event && resizeHandle.hasPointerCapture(event.pointerId)) resizeHandle.releasePointerCapture(event.pointerId);
  }
  resizeHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); dragX = event.clientX;
    resizeHandle.setPointerCapture(event.pointerId); document.body.classList.add('chat-resizing');
  });
  resizeHandle.addEventListener('pointermove', event => {
    if (dragX === null) return;
    dragX = event.clientX;
    if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (dragX !== null) setChatWidth(document.documentElement.clientWidth - dragX); });
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) resizeHandle.addEventListener(name, finishResize);
  resizeHandle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const { min, max } = widthLimits();
    const current = Number(resizeHandle.getAttribute('aria-valuenow'));
    setChatWidth(event.key === 'Home' ? min : event.key === 'End' ? max : current + (event.key === 'ArrowLeft' ? 24 : -24), true);
  });
  $('chat-minimize').addEventListener('click', () => $('support-toggle').click());
  $('chat-expand').addEventListener('click', () => {
    const expanded = document.body.classList.toggle('chat-expanded');
    $('chat-expand').setAttribute('aria-pressed', String(expanded));
    $('chat-expand').title = expanded ? 'Thu về khung bên phải' : 'Mở rộng chat';
  });
  $('support-close').addEventListener('click', () => queueMicrotask(syncDock));
  window.addEventListener('resize', syncDock);
  window.addEventListener('blur', () => finishResize());
  syncDock();
  let config = null, active = null, loading = null, editing = null, stream = null;
  let pendingFiles = []; const queue = [];
  for (const id of ['ai-web', 'ai-python']) {
    try { const value = localStorage.getItem(id); if (value !== null) $(id).checked = value === 'true'; } catch {}
    $(id).addEventListener('change', () => { try { localStorage.setItem(id, String($(id).checked)); } catch {} });
  }
  function renderText(container, content) {
    container.replaceChildren();
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
    let start = 0, match;
    while ((match = pattern.exec(content))) {
      container.append(document.createTextNode(content.slice(start, match.index)));
      const link = document.createElement('a'); link.className = 'ai-source'; link.href = match[2] || match[3]; link.textContent = match[1] || match[3]; link.target = '_blank'; link.rel = 'noopener noreferrer'; container.append(link); start = pattern.lastIndex;
    }
    container.append(document.createTextNode(content.slice(start)));
  }
  function attachmentNames(container, files) {
    for (const file of files || []) { const label = document.createElement('span'); label.className = 'ai-attached-name'; label.textContent = '📎 ' + (file.filename || file.name); container.append(label); }
  }
  function clearPending() { pendingFiles.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); }); pendingFiles = []; $('ai-attachments').replaceChildren(); }
  function drawPending() {
    $('ai-attachments').replaceChildren();
    for (const item of pendingFiles) {
      const chip = document.createElement('span'); chip.className = 'ai-attachment';
      if (item.preview) { const img = document.createElement('img'); img.src = item.preview; img.alt = ''; chip.append(img); }
      const name = document.createElement('span'); name.textContent = item.file.name + ' · ' + (item.file.size / 1048576).toFixed(2) + ' MB'; chip.append(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Bỏ ' + item.file.name);
      remove.addEventListener('click', () => { pendingFiles = pendingFiles.filter(f => f !== item); if (item.preview) URL.revokeObjectURL(item.preview); drawPending(); }); chip.append(remove); $('ai-attachments').append(chip);
    }
  }
  function addFiles(files) {
    error('');
    for (const file of files) {
      if (pendingFiles.length >= 4) { error('Tối đa 4 file mỗi tin nhắn.'); break; }
      if (!file.size || file.size > 12 * 1048576) { error('Mỗi file không quá 12 MB và phải có dữ liệu.'); continue; }
      if (!/\.(xlsx|xls|csv|pdf|docx|txt|md|json|xml|png|jpe?g|webp)$/i.test(file.name)) { error('Định dạng file chưa hỗ trợ.'); continue; }
      pendingFiles.push({ file, preview: /^image\/(png|jpeg|webp)$/.test(file.type) ? URL.createObjectURL(file) : null });
    }
    drawPending();
  }
  $('ai-attach').addEventListener('click', () => $('ai-files').click());
  $('ai-files').addEventListener('change', () => { addFiles($('ai-files').files); $('ai-files').value = ''; });
  $('ai-input').addEventListener('paste', event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); addFiles(files); } });
  $('ai-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('ai-form').requestSubmit(); } });
  $('ai-workspace').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  $('ai-workspace').addEventListener('drop', event => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
  function cancelQueue() { for (const turn of queue.splice(0)) turn.output.textContent = 'Đã hủy tin nhắn chờ.'; }
  const supportParts = ['.support-context', '#support-messages', '.support-quick', '#support-form', '.support-license', '#support-error', '#support-mode'];
  const initialHidden = new Map(supportParts.map(selector => { const el = panel.querySelector(selector); return [el, el.hidden]; }));
  async function call(url, body) {
    const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Không xử lý được yêu cầu AI.');
    return result.value;
  }
  function error(message) { $('ai-error').textContent = message || ''; $('ai-error').hidden = !message; }
  function drawModes() {
    const nav = $('chat-modes');
    nav.querySelectorAll('[data-provider]').forEach(el => el.remove());
    for (const p of config.providers) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.mode = p.id; button.dataset.provider = p.id;
      button.textContent = p.label; button.title = p.label;if(p.id==='agent')button.hidden=true; nav.insertBefore(button, $('ai-add'));
    }
    markMode();
  }
  function markMode() { $('chat-modes').querySelectorAll('[data-mode]').forEach(button => {const id=button.dataset.mode==='support'?'agent':button.dataset.mode;button.setAttribute('aria-pressed',String(id===(active?.id||'agent')));}); }
  // Vẽ giao diện cho một chế độ. Tách riêng khỏi selectMode() để bấm nút đổi
  // giao diện ngay, còn phần hỏi máy chủ chạy sau; khi phần sau lỗi thì gọi lại
  // hàm này với chế độ cũ để quay về đúng trạng thái trước đó.
  function applyMode(next) {
    active = next;
    const cloudAvailable = !!active && /^https:\/\/openrouter\.ai\/api\/v1\/?$/.test(active.baseURL);
    $('ai-web').disabled = !cloudAvailable;
    $('ai-python').disabled = !config?.flags?.generated_python_enabled;
    if ($('ai-python').disabled) $('ai-python').checked = false;
    panel.classList.toggle('is-ai', !!active);
    for (const [el, hidden] of initialHidden) el.hidden = active ? true : hidden;
    panel.querySelector('.support-license').hidden=false;
    $('support-error').hidden=false;
    $('ai-mode-label').hidden = !active;
    $('ai-mode-label').textContent = active ? active.label + ' · ' + (config.companyId === 'GLOBAL' ? 'Tài liệu chung' : 'MST ' + config.companyId) : '';
    $('ai-workspace').hidden = !active;
    $('ai-thread').hidden = !active; $('ai-form').hidden = !active;
    markMode();
  }
  async function loadConfig() {
    if (!loading) loading = call('/api/ai/providers').then(value => { config = value; $('ai-legacy').hidden = !value.legacyHistoryAvailable; drawModes(); }).finally(() => { loading = null; });
    return loading;
  }
  setInterval(async()=>{
    if(panel.hidden||active?.id!=='agent'||supportMode!=='auto')return;
    try{const value=await call('/api/ai/providers'),p=value.providers.find(p=>p.id===active.id);if(p?.cloudModel){active.cloudModel=p.cloudModel;active.configRevision=p.configRevision;$('ai-mode-label').textContent=active.label+' · AUTO · '+p.cloudModel+' · rev '+p.configRevision;}}catch{/* Reconnect on the next tick; chat routing remains server-side. */}
  },15000);
  function message(role, content) {
    const el = document.createElement('article'); el.className = 'ai-message ' + role;
    const author = document.createElement('small'); author.textContent = role === 'user' ? 'Bạn' : role==='admin'?'Admin':role==='system'?'Hỗ trợ':(active?.label || 'AI');
    const text = document.createElement('div'); renderText(text, content);
    el.append(author, text); $('ai-thread').append(el); $('ai-thread').scrollTop = $('ai-thread').scrollHeight;
    return text;
  }
  function attachFile(container, file) {
    if (!/^[a-f0-9-]{36}$/.test(file.fileId || '')) return;
    const link = document.createElement('a'); link.className = 'ai-file';
    link.href = '/api/ai/file?id=' + encodeURIComponent(file.fileId);
    link.download = file.filename; link.textContent = '↓ ' + file.filename + ' · ' + (file.rows || 0) + ' dòng';
    container.append(link);
    const actions = document.createElement('div'); actions.className = 'ai-file-actions';
    for (const [action, label] of [['file', 'Mở file'], ['folder', 'Mở thư mục'], ['preview', 'Xem dữ liệu']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          if (action !== 'preview') await call('/api/ai/file/open', { id: file.fileId, action });
          else {
            const value = await call('/api/ai/file/preview?id=' + encodeURIComponent(file.fileId));
            $('ai-file-title').textContent = file.filename;
            $('ai-file-count').textContent = value.total + ' dòng · Hiển thị tối đa 50 dòng đầu';
            const table = $('ai-file-table'); table.replaceChildren();
            const keys = Object.keys(value.rows[0] || {}), heading = document.createElement('tr');
            for (const key of keys) { const th = document.createElement('th'); th.textContent = key; heading.append(th); }
            table.append(heading);
            for (const row of value.rows) {
              const tr = document.createElement('tr');
              for (const key of keys) { const td = document.createElement('td'); td.textContent = typeof row[key] === 'object' ? JSON.stringify(row[key]) : String(row[key] ?? ''); tr.append(td); }
              table.append(tr);
            }
            $('ai-file-dialog').showModal();
          }
        } catch (e) { error(e.message); }
        finally { button.disabled = false; }
      });
      actions.append(button);
    }
    container.append(actions);
  }
  $('ai-file-close').addEventListener('click', () => $('ai-file-dialog').close());
  function approvalCard(container, request, provider) {
    const card = document.createElement('section'); card.className = 'ai-approval'; card.dataset.approvalId = request.approvalId;
    const heading = document.createElement('strong'); heading.textContent = 'Cần bạn phê duyệt';
    const description = document.createElement('p'); description.textContent = request.impactSummary;
    const target = document.createElement('small'); target.textContent = 'MST: ' + request.companyId + ' · Thao tác: ' + request.tool;
    const params = document.createElement('pre'); params.textContent = JSON.stringify(request.arguments, null, 2);
    const scope = document.createElement('select'); scope.setAttribute('aria-label', 'Phạm vi cho đúng hành động này');
    const labels = { once: 'Chỉ lần này', session: 'Cuộc trò chuyện này', company: 'Công ty này', workspace: 'Vùng làm việc này', application: 'Ứng dụng này', device: 'Máy này', always: 'Luôn cho đúng hành động này' };
    for (const value of request.allowedScopes || ['once']) if (labels[value]) { const option = document.createElement('option'); option.value = value; option.textContent = labels[value]; scope.append(option); }
    const allow = document.createElement('button'); allow.type = 'button'; allow.textContent = 'Cho phép'; allow.dataset.decision = 'allow';
    const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = 'Từ chối'; deny.dataset.decision = 'deny';
    const state = document.createElement('p'); state.className = 'ai-approval-state';
    const disable = () => { allow.disabled = true; deny.disabled = true; scope.disabled = true; };
    for (const [button, decision] of [[allow, 'allow'], [deny, 'deny']]) button.addEventListener('click', async () => {
      if (active !== provider) { disable(); state.textContent = 'Cuộc trò chuyện đã đổi; quyền này không còn dùng được.'; return; }
      disable();
      try { await call('/api/ai/approvals', { id: provider.id, approvalId: request.approvalId, actionHash: request.actionHash, decision, scope: scope.value }); state.textContent = decision === 'allow' ? 'Đã phê duyệt đúng hành động. Đang kiểm tra lại bản quyền và phạm vi…' : 'Đã từ chối. Không thực hiện hành động.'; }
      catch (e) { state.textContent = e.message; error(e.message); }
    });
    card.append(heading, description, target, params, scope, allow, deny, state); container.append(card);
    $('ai-thread').scrollTop = $('ai-thread').scrollHeight;
  }
  // NGƯỜI DÙNG tự chọn: tiếp tục với AI hay đợi admin/support. Không tự động đẩy sang admin
  // theo từ khoá — câu hỏi về bản quyền/key vẫn được hỏi ý trước, và chọn AI thì AI trả lời.
  function supportOfferCard(container, request, choose) {
    const card = document.createElement('section'); card.className = 'ai-approval';
    const heading = document.createElement('strong'); heading.textContent = 'Bạn muốn tiếp tục thế nào?';
    const description = document.createElement('p'); description.textContent = request.reason;
    const toAi = document.createElement('button'); toAi.type = 'button'; toAi.className = 'primary'; toAi.textContent = 'Tiếp tục với AI';
    const toAdmin = document.createElement('button'); toAdmin.type = 'button'; toAdmin.textContent = 'Đợi gặp admin/support';
    const state = document.createElement('p'); state.className = 'ai-approval-state';
    const disable = () => { toAi.disabled = true; toAdmin.disabled = true; };
    toAi.addEventListener('click', () => { disable(); state.textContent = 'Đang tiếp tục với AI…'; choose('ai'); });
    toAdmin.addEventListener('click', () => { disable(); state.textContent = 'Đang chuyển tới admin/support…'; choose('admin'); });
    card.append(heading, description, toAi, toAdmin, state); container.append(card);
    $('ai-thread').scrollTop = $('ai-thread').scrollHeight;
  }
  async function drawPermissions() {
    if (!active) return;
    const provider = active, records = await call('/api/ai/permissions?id=' + encodeURIComponent(provider.id));
    const list = $('ai-permissions-list'); list.replaceChildren();
    if (!records.length) list.textContent = 'Chưa có quyền hoặc lần phê duyệt nào.';
    for (const record of records.slice().reverse()) {
      const row = document.createElement('section'); row.className = 'ai-approval';
      const description = document.createElement('p'); description.textContent = record.impactSummary;
      const state = document.createElement('small'); state.textContent = record.state + ' · ' + record.scope + ' · ' + record.createdAt;
      row.append(description, state);
      if (['approved', 'denied', 'pending'].includes(record.state)) {
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.textContent = 'Thu hồi';
        revoke.addEventListener('click', async () => { revoke.disabled = true; try { await call('/api/ai/permissions', { id: provider.id, approvalId: record.approvalId }); await drawPermissions(); } catch (e) { error(e.message); } }); row.append(revoke);
      }
      list.append(row);
    }
  }
  $('ai-permissions').addEventListener('click', async () => { try { await drawPermissions(); $('ai-permissions-dialog').showModal(); } catch (e) { error(e.message); } });
  $('ai-permissions-close').addEventListener('click', () => $('ai-permissions-dialog').close());
  $('ai-legacy').addEventListener('click', async () => {
    if (!active) return;
    try {
      const result = await call('/api/ai/history/legacy?id=' + encodeURIComponent(active.id));
      $('ai-legacy-text').textContent = result.rows.map(row => (row.role === 'user' ? 'Bạn: ' : 'AI: ') + row.content + '\n' + (row.files || []).map(file => 'File được giữ: ' + file.filename).join('\n')).join('\n\n');
      $('ai-legacy-dialog').showModal();
    } catch (e) { error(e.message); }
  });
  $('ai-legacy-close').addEventListener('click', () => $('ai-legacy-dialog').close());
  function screenContext() {
    const page = [...document.querySelectorAll('.workspace[id^="pane-"]')].find(el => !el.hidden)?.id.replace('pane-', '') || 'unknown';
    return { currentPage: page, filters: { from: $('data-from')?.value || $('from')?.value || '', to: $('data-to')?.value || $('to')?.value || '', direction: $('direction')?.value || '' } };
  }
  async function drawHistory() {
    const id = active.id;
    const [rows,supportRows]=await Promise.all([call('/api/ai/history?id='+encodeURIComponent(id)),id==='agent'?call('/api/support/chat',{}).then(v=>v.messages||[]).catch(()=>[]):Promise.resolve([])]);
    if (active?.id !== id || stream || queue.length) return;
    const combined=rows.map(row=>({...row,stamp:Date.parse(row.createdAt)||0}));
    seenSupport.clear();for(const row of supportRows){seenSupport.add(row.id);if(['admin','system'].includes(row.sender))combined.push({role:row.sender,content:row.text,stamp:row.timestamp});}
    $('ai-thread').replaceChildren();combined.sort((a,b)=>a.stamp-b.stamp).forEach(row=>{const text=message(row.role,row.content);attachmentNames(text.parentElement,row.attachments);for(const file of row.files||[])attachFile(text.parentElement,file);});
    if(id==='agent')integrateSupport(supportRows);
    requestAnimationFrame(()=>{$('ai-thread').scrollTop=$('ai-thread').scrollHeight;});
  }
  const seenSupport=new Set();let supportMode='auto';
  function integrateSupport(messages) {
    const controls=(messages||[]).filter(m=>m.controlMode).sort((a,b)=>(a.controlRevision||0)-(b.controlRevision||0));
    supportMode=controls.at(-1)?.controlMode||'auto';
    if(active?.id!=='agent')return;
    if(supportMode!=='auto'){if(supportMode==='admin')stream?.abort();$('ai-mode-label').textContent=supportMode==='admin'?'Admin đang hỗ trợ · AI tạm dừng':'Đang chờ admin liên hệ';}
    else $('ai-mode-label').textContent='Hỗ trợ chung · AI đang hoạt động';
    for(const row of messages||[]) {
      if(row.source==='handoff'&&!seenSupport.has(row.id)){seenSupport.add(row.id);if(!stream&&!$('ai-thread').textContent.includes(row.text))message('assistant',row.text);continue;}
      if(!['admin','system'].includes(row.sender)||seenSupport.has(row.id))continue;
      seenSupport.add(row.id);message(row.sender,row.text);
    }
  }
  async function loadSupportHistory(){try{integrateSupport((await call('/api/support/chat',{})).messages);}catch{/* Chat can reconnect through support events. */}}
  window.addEventListener('hd:support-messages',event=>integrateSupport(event.detail));
  let switchToken = 0, persistActive = Promise.resolve();
  // Gửi các lần ghi "chế độ đang chọn" theo đúng thứ tự bấm: xếp hàng trên một
  // chuỗi promise để lần bấm sau luôn ghi đè lần bấm trước trên máy chủ.
  function queueActive(id) {
    persistActive = persistActive.catch(() => {}).then(() => call('/api/ai/providers', { action: 'active', id }));
    return persistActive;
  }
  async function selectMode(id) {
    if(id==='support')id='agent';
    // Mỗi lần bấm sinh một token. Kết quả tải về của lần bị bấm đè sau sẽ bị bỏ
    // qua (token cũ) nên không ghi đè giao diện của chế độ mới hơn.
    const token = ++switchToken;
    // Rất hiếm: nút chế độ AI chỉ tồn tại sau khi cấu hình đã tải. Nếu chưa có thì
    // phải hỏi trước, không có cách nào vẽ giao diện tức thì trong trường hợp này.
    if (id !== 'support' && !config) { try { await loadConfig(); } catch (e) { error(e.message); return; } }
    const next = id === 'support' ? null : config.providers.find(p => p.id === id);
    if (id !== 'support' && !next) { error('Chế độ AI không còn tồn tại.'); return; }
    const previous = active;
    stream?.abort(); cancelQueue(); clearPending(); $('ai-status').textContent = ''; error('');
    applyMode(next);
    try {
      if (id !== 'support') config = await queueActive(id);
      if (token !== switchToken) return;
      if (active) { $('ai-status').textContent = 'Đang tải lịch sử chat…'; await drawHistory(); }
    } catch (e) {
      // Lỗi của lần bấm đã bị bấm đè thì bỏ qua: chế độ mới hơn đang chạy nên không
      // báo lỗi của việc cũ, cũng không kéo giao diện về lùi.
      if (token === switchToken) { error(e.message); applyMode(previous); }
    } finally {
      if (token === switchToken && !stream) $('ai-status').textContent = '';
    }
  }
  window.addEventListener('hd:state', event => {
    if (!config || !active || !Object.hasOwn(event.detail || {}, 'selected')) return;
    const companyId = event.detail.selected || 'GLOBAL';
    if (config.companyId === companyId) return;
    stream?.abort(); cancelQueue(); clearPending(); config.companyId = companyId;
    $('ai-mode-label').textContent = active.label + ' · ' + (companyId === 'GLOBAL' ? 'Tài liệu chung' : 'MST ' + companyId);
    void drawHistory().catch(e => error(e.message));
  });
  $('chat-modes').addEventListener('click', event => {
    const button = event.target.closest('[data-mode]'); if (button) void selectMode(button.dataset.mode);
  });
  $('support-toggle').addEventListener('click', () => queueMicrotask(() => {
    syncDock();
    if (!panel.hidden && !config) loadConfig().then(()=>selectMode('support')).catch(e => error(e.message));
    else if(!panel.hidden&&!active)void selectMode('support');
    else if(!panel.hidden&&active&&!stream&&!queue.length)void drawHistory().catch(e=>error(e.message));
  }));
  function draft() {
    const type = $('ai-provider-type').value;
    const auto=editing==='agent'&&$('ai-routing-mode').value==='auto';
    const saved=config.providers.find(p=>p.id===editing)||window.AiProviders.defaults()[0];
    return { id: editing || 'ai-' + crypto.randomUUID(), label: $('ai-provider-label').value, type,
      baseURL: auto?saved.baseURL:$('ai-provider-url').value, model: auto?saved.model:$('ai-provider-model').value || 'default',routingMode:editing==='agent'?$('ai-routing-mode').value:'manual' };
  }
  function fields() {
    const type = $('ai-provider-type').value;
    const auto=editing==='agent'&&$('ai-routing-mode').value==='auto';
    $('ai-routing-label').hidden=editing!=='agent';
    $('ai-key-label').hidden = auto||type !== 'openai';
    $('ai-provider-url').closest('label').hidden=auto;
    $('ai-provider-api').hidden=auto;
    $('ai-provider-model').required = !auto;$('ai-provider-url').required=!auto;
  }
  async function openEditor(p) {
    try {
      await loadConfig(); editing = p?.id || null;
      $('ai-provider-form').reset();
      $('ai-provider-label').value = p?.label || '';
      $('ai-provider-type').value = p?.type || 'openai';
      $('ai-routing-mode').value=p?.routingMode||'manual';
      $('ai-provider-url').value = p?.baseURL || 'https://openrouter.ai/api/v1';
      $('ai-provider-model').value = p?.model || 'stealth/space-bunny-alpha';
      $('ai-provider-key').placeholder = p?.hasKey ? 'Đã lưu key; để trống để giữ lại' : '';
      $('ai-model-list').replaceChildren(); $('ai-provider-error').textContent = '';
      $('ai-provider-delete').hidden = !p || p.id === 'agent';
      $('ai-provider-type').disabled = p?.id === 'agent'; fields();
      $('ai-provider-dialog').showModal(); $('ai-provider-label').focus();
    } catch (e) { error(e.message); }
  }
  $('ai-add').addEventListener('click', () => void openEditor());
  $('ai-edit').addEventListener('click', () => { if (active) void openEditor(active); });
  for (const id of ['ai-provider-close', 'ai-provider-cancel']) $(id).addEventListener('click', () => $('ai-provider-dialog').close());
  $('ai-provider-dialog').addEventListener('close', () => { $('ai-provider-key').value = ''; });
  $('ai-provider-type').addEventListener('change', () => {
    fields(); const type = $('ai-provider-type').value;
    $('ai-provider-url').value = type === 'local' ? 'http://localhost:11434/v1' : 'https://openrouter.ai/api/v1';
    $('ai-provider-model').value = type === 'local' ? 'qwen2.5' : 'stealth/space-bunny-alpha';
    $('ai-provider-key').value = ''; $('ai-model-list').replaceChildren();
  });
  $('ai-routing-mode').addEventListener('change',fields);
  async function editorAction(button, work) {
    button.disabled = true; $('ai-provider-error').textContent = '';
    try { await work(); } catch (e) { $('ai-provider-error').textContent = e.message; } finally { button.disabled = false; }
  }
  $('ai-models').addEventListener('click', () => editorAction($('ai-models'), async () => {
    const models = await call('/api/ai/models', { provider: draft(), apiKey: $('ai-provider-key').value });
    $('ai-model-list').replaceChildren(...models.map(id => { const el = document.createElement('option'); el.value = id; return el; }));
    if (models.length && !$('ai-provider-model').value) $('ai-provider-model').value = models[0];
    if (!models.length) throw new Error('Máy chủ chưa có model nào.');
  }));
  $('ai-provider-form').addEventListener('submit', event => {
    event.preventDefault();
    void editorAction($('ai-provider-save'), async () => {
      const p = draft(); window.AiProviders.normalizeProvider(p);
      config = await call('/api/ai/providers', { provider: p, apiKey: p.routingMode==='auto'?undefined:$('ai-provider-key').value, clearKey: p.routingMode==='auto'?false:$('ai-clear-key').checked });
      drawModes(); $('ai-provider-dialog').close(); await selectMode(p.id);
    });
  });
  $('ai-provider-delete').addEventListener('click', () => editorAction($('ai-provider-delete'), async () => {
    if (!await window.askConfirm({ title: 'Xoá chế độ AI', text: 'Xoá chế độ AI và lịch sử trò chuyện của chế độ này?', ok: 'Xoá', tone: 'warn' })) return;
    config = await call('/api/ai/providers', { action: 'delete', id: editing });
    drawModes(); $('ai-provider-dialog').close(); if (active?.id === editing) await selectMode('support');
  }));
  $('ai-retry').addEventListener('click', () => { if (active) void selectMode(active.id); else loadConfig().catch(e => error(e.message)); });
  $('ai-new').addEventListener('click', async () => {
    if (!active || stream || !await window.askConfirm({ title: 'Chat mới', text: 'Xoá lịch sử cuộc trò chuyện này?', ok: 'Xoá', tone: 'warn' })) return;
    try { await call('/api/ai/history', { id: active.id }); await drawHistory(); error(''); } catch (e) { error(e.message); }
  });
  $('ai-stop').addEventListener('click', () => { cancelQueue(); stream?.abort(); });
  // Chỉ hỏi khi đang dùng chat tích hợp (có phiên hỗ trợ) và phiên đang do AI quản lý.
  const SUPPORT_INTENT = /(?:admin|quản trị|nhân viên|hỗ trợ viên|người thật|gặp người|nói chuyện với người|liên hệ người|bản quyền|license|licence|kích hoạt|gia hạn|mã key|license key|\bkey\b|khóa ứng dụng)/iu;
  function needsSupportChoice(text) {
    return active?.id === 'agent' && supportMode === 'auto' && SUPPORT_INTENT.test(String(text));
  }
  $('ai-form').addEventListener('submit', event => {
    event.preventDefault(); const text = $('ai-input').value.trim() || (pendingFiles.length ? 'Phân tích các file đính kèm giúp tôi.' : ''); if (!text || !active) return;
    if (queue.length >= 5) { error('Đã có 5 tin nhắn chờ. Chờ AI trả lời hoặc bấm Dừng.'); return; }
    const selected = pendingFiles.map(item => item.file);
    $('ai-input').value = ''; clearPending(); error('');
    const user = message('user', text); attachmentNames(user.parentElement, selected);
    const output = message('assistant', stream ? 'Đã nhận. Đang chờ lượt xử lý…' : 'Đã nhận. Đang xử lý…');
    const item = { p: active, companyId: config.companyId, text, selected, output, screen: screenContext(), options: { web: !$('ai-web').disabled && $('ai-web').checked, python: !$('ai-python').disabled && $('ai-python').checked } };
    $('ai-input').focus();
    // Câu hỏi về bản quyền/key, hoặc muốn gặp người thật: hỏi ý TRƯỚC khi gửi. Chọn AI thì
    // AI trả lời; chọn đợi admin thì mới chuyển phiên (AI tạm dừng tới khi admin /stop).
    if (needsSupportChoice(text)) {
      output.removeAttribute('aria-busy');
      output.textContent = 'Bạn muốn tiếp tục với AI hay đợi admin/support?';
      supportOfferCard(output.parentElement, { reason: 'Câu này liên quan bản quyền/key, hoặc bạn muốn gặp người trực tiếp.' }, choice => {
        item.supportChoice = choice;
        queue.push(item); void drainQueue();
      });
      return;
    }
    queue.push(item); void drainQueue();
  });
  async function drainQueue() {
    if (stream || !queue.length) return;
    const { p, companyId, text, selected, output, screen, options, supportChoice } = queue.shift();
    if (active !== p) { output.textContent = 'Đã hủy tin nhắn chờ.'; void drainQueue(); return; }
    const controller = new AbortController(); stream = controller;
    $('ai-send').textContent = 'Gửi tiếp'; $('ai-stop').hidden = false;
    let completed = false,workingFrame=0,workingText='AI đang xử lý',answer='';
    output.setAttribute('aria-busy','true');
    const working=setInterval(()=>{if(output.getAttribute('aria-busy')==='true')output.textContent=workingText+'.'.repeat(1+(workingFrame++%3));},500);
    try {
      const attachments = [];
      for (const file of selected) {
        $('ai-status').textContent = 'Đang gửi file: ' + file.name;
        // Gửi NGUYÊN file gốc (kể cả PDF). Máy chủ tự trích chữ / dựng bảng khi cần
        // (file.read_attachment, file.pdf_to_excel) nên KHÔNG tạo bản .pdf.txt dẫn xuất
        // và KHÔNG nhét nội dung PDF vào ngữ cảnh model.
        const uploaded = await fetch('/api/ai/upload?id=' + encodeURIComponent(p.id) + '&companyId=' + encodeURIComponent(companyId) + '&role=source&filename=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal });
        const result = await uploaded.json(); if (!result.ok) throw new Error(result.error || 'Không gửi được file.'); attachments.push(result.value.id);
      }
      output.textContent = 'Đang xử lý yêu cầu…';
      const response = await fetch('/api/ai/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, unified:p.id==='agent', companyId, text, screen, attachments, options, ...(supportChoice?{supportChoice}:{}) }), signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Không kết nối được AI.');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));
          if(data.routing){workingText='Đang tự tìm cấu hình AI';$('ai-status').textContent=workingText+' · '+(data.routing.processed||0)+'/'+(data.routing.total||'?');}
          if (data.reset) { answer = '';output.setAttribute('aria-busy','true');output.textContent = 'Đang xử lý…'; }
          if (typeof data.replace === 'string') { output.setAttribute('aria-busy','false');answer = data.replace; renderText(output, answer); }
          if (data.error) throw new Error(data.error);
          if (data.status && active === p) {$('ai-status').textContent=data.status;workingText=data.status.replace(/[…\s.]+$/,'');}
          if (data.file) attachFile(output.parentElement, data.file);
          if (data.approval_required) approvalCard(output.parentElement, data.approval_required, p);
          if (data.delta) { output.setAttribute('aria-busy','false');answer += data.delta; renderText(output, answer); $('ai-thread').scrollTop = $('ai-thread').scrollHeight; }
          if (data.done) {completed = true;if(p.routingMode==='auto'&&data.cloudModel){p.cloudModel=data.cloudModel;p.configRevision=data.configRevision;$('ai-mode-label').textContent=p.label+' · AUTO · '+p.cloudModel+' · rev '+p.configRevision;}}
        }
      }
      if (!completed) throw new Error('Kết nối bị ngắt trước khi AI trả lời xong.');
    } catch (e) { if (active === p) { const notice=e.name==='AbortError'?'Đã dừng trả lời.':(answer?'Phản hồi dang dở: ':'')+e.message;if(answer){renderText(output,answer);const note=document.createElement('p');note.textContent=notice;output.append(note);}else output.textContent=notice;error(e.name==='AbortError'?'Đã dừng trả lời.':e.message); } }
    finally {
      clearInterval(working);output.setAttribute('aria-busy','false');
      output.parentElement.querySelectorAll('.ai-approval button,.ai-approval select').forEach(el => { el.disabled = true; });
      if (!completed) controller.abort();
      if (stream === controller) { stream = null; $('ai-send').textContent = 'Gửi'; $('ai-stop').hidden = true; }
      if (active === p) $('ai-status').textContent = '';
      void drainQueue();
    }
  }
  // The widget may be opened before this deferred script has finished loading.
  if(!panel.hidden)loadConfig().then(()=>selectMode('support')).catch(e=>error(e.message));
})();
