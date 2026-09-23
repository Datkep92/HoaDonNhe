'use strict';
// Hỗ trợ khách hàng: cập nhật tin nhắn theo CƠ CHẾ LẮNG NGHE (SSE từ server nội bộ, server nối
// Firebase qua Gateway). KHÔNG có setInterval hỏi máy chủ định kỳ: đóng panel hay mở panel đều
// không sinh request nền. Khi luồng realtime chưa sẵn sàng, UI chỉ đọc tin nhắn theo yêu cầu
// (mở panel / sau khi gửi) — không theo chu kỳ.
(() => {
  const $ = id => document.getElementById(id);
  // Phản hồi tức thì cho nút có gọi máy chủ (Gateway → Firebase/Telegram mất vài giây): khoá nút và
  // đổi nhãn ngay lúc bấm. Khi xong, mở khoá và chỉ trả lại nhãn cũ nếu nơi gọi chưa tự đặt nhãn mới.
  function busyButton(button, label) {
    const original = button.textContent;
    button.disabled = true; button.textContent = label;
    return () => { button.disabled = false; if (button.textContent === label) button.textContent = original; };
  }
  let isOpen = false;
  let lastSignature = '';
  // Thông báo tin mới: badge số tin chưa đọc trên nút 💬 Hỗ trợ + âm thanh (xem vendor/sound.js).
  let primed = false; // lần tải đầu coi như đã xem nên không kêu
  let seenAt = 0;     // mốc thời gian của tin hỗ trợ mới nhất đã biết
  let unread = 0;     // số tin hỗ trợ chưa đọc
  let realtime = false; // server báo đã nối được luồng Firebase chưa
  let stream = null;
  const call = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body === undefined ? {} : body) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Không thể xử lý yêu cầu hỗ trợ.');
    return result.value;
  };
  const format = stamp => new Date(stamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const licenseLabel = status => {
    const value = String(status || '').toLowerCase();
    if (value === 'active') return 'Đang hoạt động';
    if (value === 'trial') return 'Đang dùng thử';
    if (value === 'locked') return 'Bị khóa';
    if (value === 'expired') return 'Đã hết hạn';
    if (value === 'unactivated' || value === 'invalid') return 'Chưa kích hoạt';
    if (value === 'device_limit_exceeded') return 'Vượt số thiết bị';
    return 'Chờ xác thực trên máy chủ';
  };
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
  // Header (phòng chat + trạng thái bản quyền + chế độ) đọc từ ảnh chụp LOCAL — không gọi máy chủ.
  async function loadHeader() {
    try {
      const value = await call('/api/support/device');
      $('support-room').textContent = value.device.chatRoomId;
      $('support-license').textContent = licenseLabel(value.license && value.license.status);
      $('support-mode').textContent = value.mode === 'gateway' ? 'Đã kết nối máy chủ hỗ trợ (Sheet · Telegram)' : 'Chế độ local — chưa kết nối máy chủ hỗ trợ';
    } catch { /* giữ nguyên nội dung cũ */ }
  }
  function renderMessages(list) {
    const messages = Array.isArray(list) ? list : [];
    const signature = JSON.stringify(messages);
    if (signature === lastSignature) return;
    lastSignature = signature;
    announce(messages);
    const container = $('support-messages');
    container.replaceChildren();
    if (!messages.length) {
      const empty = document.createElement('p'); empty.className = 'support-empty'; empty.textContent = 'Gửi tin nhắn để bắt đầu trao đổi với bộ phận hỗ trợ.'; container.append(empty);
    }
    for (const message of messages) {
      const item = document.createElement('article'); item.className = `support-message ${message.sender}`;
      const text = document.createElement('div'); text.textContent = message.text;
      const meta = document.createElement('small'); meta.textContent = `${message.sender === 'admin' ? 'Hỗ trợ' : 'Bạn'} · ${format(message.timestamp)}`;
      item.append(text, meta); container.append(item);
    }
    container.scrollTop = container.scrollHeight;
  }
  // Chỉ dùng khi KHÔNG có luồng realtime (Gateway chưa deploy / mất mạng): đọc theo yêu cầu.
  async function loadMessages() { try { renderMessages((await call('/api/support/chat')).messages); } catch {} }
  function connect() {
    if (stream || typeof window.EventSource !== 'function') return;
    stream = new EventSource('/api/support/events');
    stream.onmessage = event => {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      if (value.type === 'mode') {
        const wasRealtime = realtime;
        realtime = !!value.realtime;
        if (wasRealtime && !realtime) void loadMessages(); // vừa mất luồng -> đồng bộ lại đúng 1 lần
      } else if (value.type === 'messages' && Array.isArray(value.messages)) {
        renderMessages(value.messages);
      }
    };
    // onerror: EventSource tự kết nối lại tới SERVER NỘI BỘ (127.0.0.1) — không tạo request cloud.
  }
  $('support-toggle').onclick = () => {
    isOpen = !isOpen;
    $('support-panel').hidden = !isOpen;
    $('support-toggle').setAttribute('aria-expanded', String(isOpen));
    if (isOpen) { unread = 0; paint(); if (!realtime) void loadMessages(); }
  };
  $('support-close').onclick = () => $('support-toggle').click();
  $('support-form').onsubmit = async event => {
    event.preventDefault(); const input = $('support-input'); const text = input.value.trim(); if (!text) return;
    const restore = busyButton($('support-send'), 'Đang gửi…');
    try {
      await call('/api/support/message', { text });
      input.value = '';
      // Có luồng realtime thì tin nhắn sẽ tự về; chưa có thì đọc lại đúng một lần.
      if (!realtime) await loadMessages();
    }
    catch (error) { $('support-error').textContent = error.message; }
    finally { restore(); }
  };
  $('support-license-form').onsubmit = async event => {
    event.preventDefault(); const key = $('support-key').value.trim(); if (!key) return;
    const restore = busyButton($('support-license-form').querySelector('button'), 'Đang kích hoạt…');
    try {
      const value = await call('/api/support/activate', { key });
      $('support-key').value = '';
      $('support-error').textContent = String(value.status || '').toLowerCase() === 'active' ? 'Kích hoạt thành công.' : 'Đã gửi key lên máy chủ. Trạng thái sẽ được cập nhật sau khi xác thực.';
      await loadHeader(); // trạng thái local vừa đổi sau khi kích hoạt
    }
    catch (error) { $('support-error').textContent = error.message; }
    finally { restore(); }
  };
  loadHeader();
  connect();
  paint();
})();
