'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let isOpen = false;
  let lastSignature = '';
  // Thông báo tin mới: badge số tin chưa đọc trên nút 💬 Hỗ trợ + âm thanh (xem vendor/sound.js).
  let primed = false; // lần tải đầu coi như đã xem nên không kêu
  let seenAt = 0;     // mốc thời gian của tin hỗ trợ mới nhất đã biết
  let unread = 0;     // số tin hỗ trợ chưa đọc
  const call = async (url, body) => {
    const response = await fetch(url, { method: url === '/api/support/status' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Không thể xử lý yêu cầu hỗ trợ.');
    return result.value;
  };
  const format = stamp => new Date(stamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  function paint() {
    const badge = $('support-badge');
    if (!badge) return;
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    $('support-toggle').title = unread ? `${unread} tin nhắn mới từ bộ phận hỗ trợ` : 'Hỗ trợ khách hàng';
  }
  function announce(messages) {
    const fromSupport = (messages || []).filter(message => message.sender === 'admin');
    const newest = fromSupport.reduce((max, message) => Math.max(max, Number(message.timestamp) || 0), 0);
    if (!primed) { primed = true; seenAt = newest; return; }
    if (newest <= seenAt) return;
    const fresh = fromSupport.filter(message => (Number(message.timestamp) || 0) > seenAt).length;
    seenAt = newest;
    if (isOpen) { unread = 0; paint(); return; } // đang mở panel thì coi như đã đọc
    unread += fresh;
    paint();
    try { window.HDSound?.play?.(); } catch {}
  }
  function render(state) {
    $('support-room').textContent = state.device.chatRoomId;
    const status = String(state.license.status || '').toLowerCase();
    $('support-license').textContent = status === 'active' ? 'Đang hoạt động' : status === 'trial' ? 'Đang dùng thử' : status === 'locked' ? 'Bị khóa' : status === 'expired' ? 'Đã hết hạn' : status === 'unactivated' || status === 'invalid' ? 'Chưa kích hoạt' : status === 'device_limit_exceeded' ? 'Vượt số thiết bị' : 'Chờ xác thực trên máy chủ';
    $('support-mode').textContent = state.device.mode === 'gateway' ? 'Đã kết nối máy chủ hỗ trợ (Sheet · Telegram)' : 'Chế độ local — chưa kết nối máy chủ hỗ trợ';
    const signature = JSON.stringify(state.messages);
    if (signature === lastSignature) return;
    lastSignature = signature;
    announce(state.messages);
    const list = $('support-messages'); list.replaceChildren();
    if (!state.messages.length) {
      const empty = document.createElement('p'); empty.className = 'support-empty'; empty.textContent = 'Gửi tin nhắn để bắt đầu trao đổi với bộ phận hỗ trợ.'; list.append(empty);
    }
    for (const message of state.messages) {
      const item = document.createElement('article'); item.className = `support-message ${message.sender}`;
      const text = document.createElement('div'); text.textContent = message.text;
      const meta = document.createElement('small'); meta.textContent = `${message.sender === 'admin' ? 'Hỗ trợ' : 'Bạn'} · ${format(message.timestamp)}`;
      item.append(text, meta); list.append(item);
    }
    list.scrollTop = list.scrollHeight;
  }
  async function refresh() { try { render(await call('/api/support/status')); } catch {} }
  $('support-toggle').onclick = () => { isOpen = !isOpen; $('support-panel').hidden = !isOpen; $('support-toggle').setAttribute('aria-expanded', String(isOpen)); if (isOpen) { unread = 0; paint(); refresh(); } };
  $('support-close').onclick = () => $('support-toggle').click();
  $('support-form').onsubmit = async event => {
    event.preventDefault(); const input = $('support-input'); const text = input.value.trim(); if (!text) return;
    $('support-send').disabled = true;
    try { await call('/api/support/message', { text }); input.value = ''; await refresh(); }
    catch (error) { $('support-error').textContent = error.message; }
    finally { $('support-send').disabled = false; }
  };
  $('support-license-form').onsubmit = async event => {
    event.preventDefault(); const key = $('support-key').value.trim(); if (!key) return;
    try {
      const value = await call('/api/support/activate', { key });
      $('support-key').value = '';
      $('support-error').textContent = String(value.status || '').toLowerCase() === 'active' ? 'Kích hoạt thành công.' : 'Đã gửi key lên máy chủ. Trạng thái sẽ được cập nhật sau khi xác thực.';
      await refresh();
    }
    catch (error) { $('support-error').textContent = error.message; }
  };
  call('/api/support/register', {}).then(refresh).catch(error => { $('support-error').textContent = error.message; });
  setInterval(() => { if (isOpen) refresh(); }, 2000);
  // Panel đóng vẫn hỏi máy chủ để báo tin mới từ hỗ trợ (badge + âm thanh).
  setInterval(() => { if (!isOpen) refresh(); }, 3000);
  paint();
})();
