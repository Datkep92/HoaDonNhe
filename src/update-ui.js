'use strict';
// Hộp thoại SELF-UPDATE. Trạng thái lấy từ /api/state (giao diện đã poll sẵn) — module này
// không tự gọi GitHub và không tạo timer. App tải binary mới, xác minh SHA-256, rồi tự thay
// file chương trình và khởi động lại (không chạy Setup).
(() => {
  const $ = id => document.getElementById(id);
  let dismissed = false;   // "Để sau" -> không mở lại trong phiên này
  let busy = false;        // chặn bấm nhiều lần (không tạo nhiều lượt tải)
  let lastState = window.HD_LAST_STATE || null;

  const api = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body === undefined ? {} : body) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Không thực hiện được yêu cầu.');
    return result.value;
  };
  const showError = text => { $('update-error').hidden = !text; $('update-error').textContent = text || ''; };
  const megabytes = bytes => `${(Math.round(((bytes || 0) / 1048576) * 10) / 10)} MB`;

  function paint(update) {
    const latest = update.latest || update.version || '';
    if (latest) $('update-title').textContent = `Có phiên bản mới v${latest}`;
    $('update-current').textContent = update.current ? `v${update.current}` : '—';
    $('update-latest').textContent = latest ? `v${latest}` : '—';

    const stage = update.stage || 'idle';
    const running = stage === 'downloading' || stage === 'verifying' || stage === 'applying';
    $('update-progress').hidden = !running;
    if (running) {
      $('update-status').textContent = stage === 'verifying'
        ? 'Đang xác minh bản cập nhật…'
        : stage === 'applying'
          ? 'Đang cập nhật. Ứng dụng sẽ tự khởi động lại…'
          : 'Đang tải bản cập nhật…';
      const percent = typeof update.percent === 'number' ? update.percent : null;
      const bar = $('update-bar');
      if (stage === 'downloading' && percent !== null) bar.value = percent; else bar.removeAttribute('value');
      $('update-percent').textContent = stage === 'downloading' ? (percent === null ? megabytes(update.received) : `${percent}%`) : '';
    }

    const failed = stage === 'error';
    const blocked = update.canSelfUpdate === false;
    $('update-now').textContent = failed ? 'Thử lại' : 'Cập nhật ngay';
    $('update-now').disabled = busy || running || blocked;
    $('update-later').textContent = 'Để sau';
    $('update-close').disabled = running;
    $('update-note').hidden = !blocked;
    if (blocked) $('update-note').textContent = update.error || 'Không thể tự cập nhật từ thư mục này.';
    showError(failed ? `Không thể cập nhật.\nPhiên bản hiện tại vẫn được giữ nguyên.${update.error ? `\n(${update.error})` : ''}` : '');
  }

  function onState(state) {
    lastState = state || lastState;
    const update = (state && state.update) || null;
    if (!update) return;
    const dialog = $('update-dialog');
    if (update.updateAvailable && !dismissed) {
      if (!dialog.open) dialog.showModal();
    }
    if (dialog.open) paint(update);
  }

  window.addEventListener('hd:state', event => onState(event.detail));
  if (lastState) onState(lastState);

  $('update-close').onclick = () => { dismissed = true; $('update-dialog').close(); };
  $('update-later').onclick = () => {
    dismissed = true;
    $('update-dialog').close();
    api('/api/update/cancel').catch(() => {});
  };
  $('update-now').onclick = async () => {
    if (busy) return;
    busy = true;
    showError('');
    // Khoá nút và hiện trạng thái ngay, không phải chờ vòng poll 1,5 giây mới thấy phản hồi.
    if (lastState && lastState.update) paint(lastState.update);
    try { await api('/api/update/start'); }
    catch (error) { showError(`Không thể cập nhật.\nPhiên bản hiện tại vẫn được giữ nguyên.\n(${error.message})`); }
    finally { busy = false; onState(lastState); }
  };
})();
