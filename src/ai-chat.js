'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const panel = $('support-panel'), frame = $('ai-frame');
  const resizeHandle = $('chat-resize');
  let chatWidth = 420, dragFrame = 0, dragX = null;
  try { chatWidth = Number(localStorage.getItem('hd-chat-width')) || 420; } catch {}
  function widthLimits() {
    const sidebar = innerWidth <= 760 ? 0 : innerWidth <= 860 ? 200 : innerWidth <= 1100 ? 214 : 250;
    const max = Math.max(230, Math.min(800, innerWidth - sidebar - (innerWidth <= 760 ? 140 : 320)));
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
  $('support-close').addEventListener('click', () => queueMicrotask(syncDock));
  window.addEventListener('resize', syncDock);
  window.addEventListener('blur', () => finishResize());
  syncDock();
  let config = null, active = null, loading = null, switching = false, editing = null, stream = null, frameTimer = null, frameReady = false;
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
      button.textContent = p.label; button.title = p.label; nav.insertBefore(button, $('ai-add'));
    }
    markMode();
  }
  function markMode() { $('chat-modes').querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === (active?.id || 'support')))); }
  async function loadConfig() {
    if (!loading) loading = call('/api/ai/providers').then(value => { config = value; drawModes(); }).finally(() => { loading = null; });
    return loading;
  }
  function message(role, content) {
    const el = document.createElement('article'); el.className = 'ai-message ' + role;
    const author = document.createElement('small'); author.textContent = role === 'user' ? 'Bạn' : (active?.label || 'AI');
    const text = document.createElement('div'); text.textContent = content;
    el.append(author, text); $('ai-thread').append(el); $('ai-thread').scrollTop = $('ai-thread').scrollHeight;
    return text;
  }
  async function drawHistory() {
    const id = active.id;
    const rows = await call('/api/ai/history?id=' + encodeURIComponent(id));
    if (active?.id !== id) return;
    $('ai-thread').replaceChildren(); rows.forEach(row => message(row.role, row.content));
  }
  function loadFrame() {
    clearTimeout(frameTimer); frameReady = false;
    frame.src = active.embedUrl;
    frameTimer = setTimeout(() => {
      if (!frameReady && active?.type === 'web') error('Chưa xác nhận được kết nối AI web. Bạn có thể thử lại hoặc chọn chế độ khác.');
    }, 15000);
  }
  async function selectMode(id) {
    if (switching) return;
    switching = true;
    try {
      if (id !== 'support') {
        await loadConfig();
        await call('/api/ai/providers', { action: 'active', id });
      }
      const next = id === 'support' ? null : config.providers.find(p => p.id === id);
      if (id !== 'support' && !next) throw new Error('Chế độ AI không còn tồn tại.');
      stream?.abort(); clearTimeout(frameTimer); active = next;
      panel.classList.toggle('is-ai', !!active);
      for (const [el, hidden] of initialHidden) el.hidden = active ? true : hidden;
      $('ai-mode-label').hidden = !active; $('ai-mode-label').textContent = active ? 'AI: ' + active.label : '';
      $('ai-workspace').hidden = !active;
      $('ai-frame-host').hidden = active?.type !== 'web';
      $('ai-thread').hidden = !active || active.type === 'web'; $('ai-form').hidden = $('ai-thread').hidden;
      $('ai-new').hidden = active?.type === 'web'; markMode(); error('');
      if (active?.type === 'web') loadFrame();
      else { frame.src = 'about:blank'; if (active) await drawHistory(); }
    } catch (e) { error(e.message); }
    finally { switching = false; }
  }
  $('chat-modes').addEventListener('click', event => {
    const button = event.target.closest('[data-mode]'); if (button) void selectMode(button.dataset.mode);
  });
  $('support-toggle').addEventListener('click', () => queueMicrotask(() => {
    syncDock();
    if (!panel.hidden && !config) loadConfig().catch(e => error(e.message));
  }));
  window.addEventListener('message', async event => {
    const p = active;
    if (p?.type !== 'web' || event.source !== frame.contentWindow || event.origin !== new URL(p.embedUrl).origin || !window.AiBridge.isHandled(event.data)) return;
    frameReady = true; clearTimeout(frameTimer); error('');
    try {
      const reply = await window.AiBridge.buildResponse(event.data, {
        get: key => call('/api/ai/storage?providerId=' + encodeURIComponent(p.id) + '&key=' + encodeURIComponent(key)),
        set: (key, value) => call('/api/ai/storage', { providerId: p.id, key, value }),
      });
      if (active === p) event.source.postMessage(reply, event.origin);
    } catch (e) {
      error(e.message);
      if (active === p) event.source.postMessage({ type: 'storageResponse', operation: event.data.operation, key: event.data.key, messageId: event.data.messageId, value: null }, event.origin);
    }
  });
  function draft() {
    const type = $('ai-provider-type').value;
    return { id: editing || 'ai-' + crypto.randomUUID(), label: $('ai-provider-label').value, type,
      ...(type === 'web' ? { embedUrl: $('ai-provider-url').value } : { baseURL: $('ai-provider-url').value, model: $('ai-provider-model').value || 'default' }) };
  }
  function fields() {
    const type = $('ai-provider-type').value;
    $('ai-provider-api').hidden = type === 'web'; $('ai-key-label').hidden = type !== 'openai';
    $('ai-provider-model').required = type !== 'web';
  }
  async function openEditor(p) {
    try {
      await loadConfig(); editing = p?.id || null;
      $('ai-provider-form').reset();
      $('ai-provider-label').value = p?.label || '';
      $('ai-provider-type').value = p?.type || 'web';
      $('ai-provider-url').value = p?.embedUrl || p?.baseURL || 'https://deepseek-ai.easytool.dev/en/new-chat?ref=app&sidepanel=true';
      $('ai-provider-model').value = p?.model || '';
      $('ai-provider-key').placeholder = p?.hasKey ? 'Đã lưu key; để trống để giữ lại' : '';
      $('ai-model-list').replaceChildren(); $('ai-provider-error').textContent = '';
      $('ai-provider-delete').hidden = !p; fields();
      $('ai-provider-dialog').showModal(); $('ai-provider-label').focus();
    } catch (e) { error(e.message); }
  }
  $('ai-add').addEventListener('click', () => void openEditor());
  $('ai-edit').addEventListener('click', () => { if (active) void openEditor(active); });
  for (const id of ['ai-provider-close', 'ai-provider-cancel']) $(id).addEventListener('click', () => $('ai-provider-dialog').close());
  $('ai-provider-dialog').addEventListener('close', () => { $('ai-provider-key').value = ''; });
  $('ai-provider-type').addEventListener('change', () => {
    fields(); const type = $('ai-provider-type').value;
    $('ai-provider-url').value = type === 'web' ? 'https://deepseek-ai.easytool.dev/en/new-chat?ref=app&sidepanel=true' : type === 'local' ? 'http://localhost:11434/v1' : 'https://api.deepseek.com';
    $('ai-provider-model').value = type === 'local' ? 'qwen2.5' : 'deepseek-chat';
    $('ai-provider-key').value = ''; $('ai-model-list').replaceChildren();
  });
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
      config = await call('/api/ai/providers', { provider: p, apiKey: $('ai-provider-key').value, clearKey: $('ai-clear-key').checked });
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
  $('ai-stop').addEventListener('click', () => stream?.abort());
  $('ai-form').addEventListener('submit', async event => {
    event.preventDefault(); const text = $('ai-input').value.trim(); if (!text || !active || stream) return;
    const p = active, controller = new AbortController(); stream = controller;
    $('ai-send').disabled = true; $('ai-stop').hidden = false; error('');
    message('user', text); const output = message('assistant', '');
    let completed = false;
    try {
      const response = await fetch('/api/ai/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, text }), signal: controller.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Không kết nối được AI.');
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6)); if (data.error) throw new Error(data.error);
          if (data.delta) { output.textContent += data.delta; $('ai-thread').scrollTop = $('ai-thread').scrollHeight; }
          if (data.done) completed = true;
        }
      }
      if (!completed) throw new Error('Kết nối bị ngắt trước khi AI trả lời xong.');
      $('ai-input').value = '';
    } catch (e) { if (active === p) error(e.name === 'AbortError' ? 'Đã dừng trả lời.' : e.message); }
    finally {
      if (!completed) controller.abort();
      if (stream === controller) { stream = null; $('ai-send').disabled = false; $('ai-stop').hidden = true; }
    }
  });
})();
