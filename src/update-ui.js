'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('update-dialog');
  const running = new Set(['downloading', 'verifying', 'waiting', 'applying']);
  let lastState = window.HD_LAST_STATE || null, busy = false, localError = '';
  const edited = new Set(), clientId = 'update-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  let protectedForms = null, bankDraft = false;
  document.addEventListener?.('input', event => { const form = event.target.closest?.('form'); if(form) edited.add(form); });
  function dirtyWork() {
    return dirtyForms().length>0 || (bankDraft && !!$('bank-check-dialog')?.open);
  }
  function dirtyForms() { return [...(protectedForms||edited)].filter(form => form.getClientRects().length && [...form.querySelectorAll('input,textarea,select')].some(input => input.value !== input.defaultValue && input.value !== '')); }
  function reportWork() { return fetch('/api/update/work', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:clientId,dirty:dirtyWork(),forms:dirtyForms().map(form=>form.id)})}); }
  function paint(update) {
    const stage = update.stage || 'available', waiting = stage === 'waiting';
    $('update-title').textContent = `Cập nhật CN Tax Tools v${update.latest || update.version || ''}`;
    $('update-current').textContent = `v${update.current || ''}`;
    $('update-latest').textContent = `v${update.latest || update.version || ''}`;
    $('update-release-notes').textContent = update.notes || 'Bản cập nhật cải thiện ứng dụng. Vui lòng cập nhật để tiếp tục sử dụng.';
    $('update-whats-new').hidden = waiting;
    $('update-progress').hidden = !running.has(stage);
    const labels = { downloading: 'Đang tải bản cập nhật…', verifying: 'Đang xác minh bản cập nhật…', waiting: 'Đã tải xong. Hoàn tất hoặc lưu công việc đang làm để tiếp tục cập nhật.', applying: 'Đang cài đặt. Ứng dụng sẽ tự mở lại…' };
    $('update-status').textContent = (labels[stage] || '') + (waiting && update.blockers?.length ? '\n' + update.blockers.join('\n') : '');
    if (stage === 'downloading' && typeof update.percent === 'number') $('update-bar').value = update.percent;
    else $('update-bar').removeAttribute('value');
    $('update-percent').textContent = stage === 'downloading' ? `${update.percent ?? Math.round((update.received || 0) / 1048576)}${update.percent == null ? ' MB' : '%'}` : '';
    $('update-now').textContent = stage === 'error' || localError ? 'Thử lại' : 'Cập nhật';
    $('update-now').disabled = busy || running.has(stage) || update.canSelfUpdate === false;
    $('update-note').hidden = update.canSelfUpdate !== false;
    $('update-note').textContent = update.canSelfUpdate === false ? (update.error || 'Không thể ghi vào thư mục ứng dụng. Tải bộ cài mới tại liên kết bên dưới.') : '';
    $('update-manual').hidden = update.canSelfUpdate !== false;
    const error = localError || (stage === 'error' ? `Cập nhật chưa thành công. Dữ liệu và phiên bản cũ được giữ nguyên.\n${update.error || ''}` : '');
    $('update-error').hidden = !error; $('update-error').textContent = error;
    if (dialog.open && dialog.classList.contains('update-waiting') !== waiting) dialog.close();
    dialog.classList.toggle('update-waiting', waiting);
    if (!dialog.open) { if (waiting) dialog.show(); else dialog.showModal(); }
  }
  function onState(state) {
    lastState = state || lastState;
    if (lastState?.update?.updateAvailable) { if(!protectedForms){protectedForms=new Set(edited);bankDraft=!!$('bank-check-dialog')?.open;}paint(lastState.update);reportWork().catch(()=>{}); }
    else if (dialog.open && !busy) dialog.close();
  }
  async function startUpdate() {
    const update = lastState?.update;
    if (!update?.updateAvailable || busy || running.has(update.stage) || update.canSelfUpdate === false) return;
    busy = true; localError = ''; paint(update);
    try {
      await reportWork();
      const response = await fetch('/api/update/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: update.latest || update.version }) });
      const result = await response.json();
      if (!response.ok || !result.ok || result.value?.ok === false) throw new Error(result.error || result.value?.error || 'Không bắt đầu được cập nhật.');
      update.stage = 'downloading';
    } catch (error) { localError = `Cập nhật chưa thành công. Dữ liệu và phiên bản cũ được giữ nguyên.\n${error.message}`; }
    finally { busy = false; paint(update); }
  }
  $('update-now').onclick = startUpdate;
  dialog.addEventListener('cancel', event => event.preventDefault());
  window.addEventListener('keydown', event => { if(dialog.open && event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();} }, true);
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) startUpdate();
  });
  window.addEventListener('hd:state', event => onState(event.detail));
  if (lastState) onState(lastState);
})();
