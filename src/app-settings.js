'use strict';
(() => {
  const q = id => document.getElementById(id);
  const api = async (url, body) => {
    const response = await fetch(url, {
      method: url.endsWith('/status') || url.endsWith('/notice') ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error || 'Yêu cầu không thành công.');
    return result.value;
  };
  const labelStatus = status => {
    const value = String(status || '').toLowerCase();
    if (value === 'active') return 'Đang hoạt động';
    if (value === 'trial') return 'Đang dùng thử';
    if (value === 'locked') return 'Đã bị khóa';
    if (value === 'expired') return 'Đã hết hạn';
    if (value === 'unactivated' || value === 'invalid') return 'Chưa kích hoạt';
    if (value === 'device_limit_exceeded') return 'Vượt số thiết bị';
    return status || 'Trial';
  };
  const packageName = license => {
    const pkg = license?.packageType || license?.package || '';
    const status = String(license?.status || '').toLowerCase();
    if (status === 'active') return pkg || 'Bản quyền';
    if (status === 'trial') return 'Trial';
    if (status === 'locked') return 'Bị khóa';
    if (status === 'expired') return 'Hết hạn';
    if (status === 'device_limit_exceeded') return 'Vượt số thiết bị';
    return 'Trial';
  };
  const setMessage = (id, text) => { q(id).textContent = text || ''; };
  // Bước 4: khách điền Họ tên + SĐT khi bấm mua key, gửi về CRM để admin nhận diện máy.
  const setPaymentMessage = (text, ok) => { setMessage('payment-message', text); q('payment-message').classList.toggle('ok', !!ok); };
  const phoneDigits = value => String(value || '').replace(/[\s.\-()]/g, '');

  let supportState = null;
  let lockState = { enabled: false, locked: false };
  let idleTimer = null;
  const IDLE_MS = 15 * 60 * 1000;

  function renderLicense(state) {
    supportState = state || supportState;
    const license = supportState?.license || {};
    const device = supportState?.device || {};
    const pkg = packageName(license);
    const status = String(license.status || '').toLowerCase();
    q('main-license-badge').textContent = pkg;
    q('license-current-package').textContent = pkg;
    q('side-license-state').textContent = pkg;
    q('license-current-status').textContent = labelStatus(license.status);
    q('license-current-expiry').textContent = license.expiryAt || (status === 'active' ? 'Vĩnh viễn' : '—');
    q('license-current-key').textContent = license.keyName || license.key || '—';
    q('license-current-name').textContent = device.name || '—';
    q('license-current-phone').textContent = device.phone || '—';
    q('license-hardware-id').textContent = device.hardwareId || device.installationId || '—';
    q('unlock-hardware-id').textContent = device.hardwareId || device.installationId || '—';
    // Khóa bản quyền do admin bật (/lock): overlay tự hiện/ẩn theo vòng refresh 10 giây.
    q('license-lock').hidden = status !== 'locked';

    // Hết hạn (dùng thử hoặc key): overlay riêng, câu chữ tuỳ máy đã từng có key chưa.
    const hasKey = String(license.keyName || license.key || '').trim();
    q('license-expired').hidden = status !== 'expired';

    if (status === 'expired') {
      q('license-expired-title').textContent = hasKey ? 'License Key đã hết hạn' : 'Trial đã hết hạn';
      q('license-expired-text').textContent = hasKey
        ? 'Gia hạn key hiện tại hoặc nhập key mới để tiếp tục sử dụng.'
        : 'Gửi thông tin để được cấp License Key, hoặc nhập key nếu bạn đã có.';

      // Gói/key + hạn cũ. Gói chỉ hiện khi CRM trả packageType (hiện chưa trả),
      // nên luôn có Key + hạn để khách đọc cho hỗ trợ.
      const plan = String(license.packageType || '').trim();
      const key = String(license.keyName || license.key || '').trim();
      const facts = [];
      if (plan) facts.push('Gói ' + plan);
      facts.push(key ? 'Key ' + key : 'Chưa có key');
      facts.push('hạn ' + (license.expiryAt || '—'));
      q('license-expired-meta').textContent = facts.join(' · ');
    }
  }

  function renderLock(state) {
    lockState = state || lockState;
    q('lock-enabled-label').textContent = lockState.enabled ? 'Đã bật khóa PIN' : 'Chưa thiết lập mã PIN';
    q('lock-screen').hidden = !lockState.locked;
    if (lockState.locked) setTimeout(() => q('unlock-pin').focus(), 30);
  }

  // License và khoá PIN CHỈ được kiểm tra khi có yêu cầu (mở Cài đặt, mở app, mạng trở lại,
  // sau khi kích hoạt…). KHÔNG còn timer polling: trước đây hàm này chạy mỗi 10 giây và kéo
  // theo request kiểm tra License lên máy chủ liên tục.
  async function refreshLicense() { try { renderLicense(await api('/api/support/license')); } catch {} }
  async function refreshLockStatus() { try { renderLock(await api('/api/app-lock/status')); } catch {} }
  async function refreshSettings() { await refreshLicense(); await refreshLockStatus(); }

  function showPane(name) {
    const license = name === 'license';
    q('settings-license').hidden = !license;
    q('settings-lock').hidden = license;
    q('settings-tab-license').classList.toggle('active', license);
    q('settings-tab-lock').classList.toggle('active', !license);
  }

  function openSettings(tab = 'license') {
    showPane(tab);
    setMessage('settings-license-message', '');
    setMessage('pin-message', '');
    q('settings-dialog').showModal();
    void refreshSettings();
  }

  // Thẻ gói nằm ngay trong dialog đăng ký (#payment-plans) — DOM là nguồn duy nhất,
  // không nhân bản sang chỗ khác. Chọn gói = đánh dấu đúng thẻ đó.
  const planCards = Array.from(document.querySelectorAll('#payment-plans .plan-card'));
  let currentPlan = planCards[0]?.dataset.plan || 'Plus';

  function selectPlan(name) {
    const card =
      planCards.find(item => item.dataset.plan === name) || planCards[0];

    if (!card) return;

    currentPlan = card.dataset.plan;

    for (const item of planCards) {
      const active = item === card;
      item.classList.toggle('active', active);
      item.querySelector('button').setAttribute('aria-checked', String(active));
    }

    q('payment-title').textContent = 'Đăng ký ' + currentPlan;
    q('payment-subtitle').textContent = card.dataset.price || '';
  }

  // "Giao diện thông tin đăng ký": chọn gói + QR + Họ tên/SĐT của khách.
  function openPayment(name) {
    selectPlan(name || currentPlan);
    q('payment-name').value = supportState?.device?.name || '';
    q('payment-phone').value = supportState?.device?.phone || '';
    setPaymentMessage('');
    q('payment-dialog').showModal();
    // Làm mới rồi điền lại nếu lần mở này chưa có sẵn thông tin đã gửi trước đó.
    void refreshSettings().then(() => {
      if (!q('payment-name').value) q('payment-name').value = supportState?.device?.name || '';
      if (!q('payment-phone').value) q('payment-phone').value = supportState?.device?.phone || '';
    }).catch(() => {});
  }

  async function savePurchaseInfo(event) {
    event.preventDefault();
    const name = q('payment-name').value.trim();
    const phone = phoneDigits(q('payment-phone').value);
    if (name.length < 2) { setPaymentMessage('Nhập họ tên khách hàng (ít nhất 2 ký tự).'); q('payment-name').focus(); return; }
    if (!/^\+?\d{9,15}$/.test(phone)) { setPaymentMessage('Số điện thoại chưa đúng — nhập 9 đến 15 chữ số, ví dụ 0912345678.'); q('payment-phone').focus(); return; }
    const button = q('payment-info-form').querySelector('button');
    button.disabled = true;
    try {
      await api('/api/support/info', { name, phone, plan: currentPlan });
      q('payment-phone').value = phone;
      setPaymentMessage(`Đã gửi thông tin đăng ký gói ${currentPlan}. Bộ phận hỗ trợ sẽ liên hệ qua SĐT này để cấp License Key.`, true);
      await refreshSettings();
    } catch (error) { setPaymentMessage(error.message); }
    finally { button.disabled = false; }
  }

  async function activateLicense(event) {
    event.preventDefault();
    const key = q('settings-license-key').value.trim();
    if (!key) { setMessage('settings-license-message', 'Nhập License Key trước khi kích hoạt.'); return; }
    q('settings-license-form').querySelector('button').disabled = true;
    try {
      const value = await api('/api/support/activate', { key });
      setMessage('settings-license-message', String(value.status || '').toLowerCase() === 'active' ? 'Kích hoạt thành công.' : 'Đã gửi key lên máy chủ. Trạng thái sẽ cập nhật sau khi xác thực.');
      q('settings-license-key').value = '';
      await refreshSettings();
    } catch (error) { setMessage('settings-license-message', error.message); }
    finally { q('settings-license-form').querySelector('button').disabled = false; }
  }

  async function setPin(event) {
    event.preventDefault();
    const pin = q('pin-new').value.trim();
    try {
      renderLock(await api('/api/app-lock/set-pin', { pin }));
      q('pin-new').value = '';
      setMessage('pin-message', 'Đã lưu mã PIN trên máy này.');
      resetIdleTimer();
    } catch (error) { setMessage('pin-message', error.message); }
  }

  async function resetPin(event) {
    event.preventDefault();
    try {
      renderLock(await api('/api/app-lock/reset', { licenseKey: q('pin-reset-license').value.trim(), pin: q('pin-reset-new').value.trim() }));
      q('pin-reset-license').value = '';
      q('pin-reset-new').value = '';
      setMessage('pin-message', 'Đã đặt lại mã PIN.');
      resetIdleTimer();
    } catch (error) { setMessage('pin-message', error.message); }
  }

  async function lockNow() {
    if (!lockState.enabled) { openSettings('lock'); setMessage('pin-message', 'Thiết lập mã PIN 4 số trước khi dùng khóa giao diện.'); return; }
    try { renderLock(await api('/api/app-lock/lock', {})); } catch (error) { openSettings('lock'); setMessage('pin-message', error.message); }
  }

  async function unlock(event) {
    event.preventDefault();
    try {
      renderLock(await api('/api/app-lock/unlock', { pin: q('unlock-pin').value.trim() }));
      q('unlock-pin').value = '';
      q('unlock-error').textContent = '';
      resetIdleTimer();
    } catch (error) { q('unlock-error').textContent = error.message; q('unlock-pin').select(); }
  }

  // Quên PIN ở màn hình khoá: mã khôi phục chính là License Key đã kích hoạt trên máy này,
  // dùng lại đúng endpoint /api/app-lock/reset (không thêm luật mới nào).
  async function recoverPin(event) {
    event.preventDefault();
    const licenseKey = q('unlock-recovery-key').value.trim();
    const pin = q('unlock-recovery-pin').value.trim();
    setMessage('unlock-recovery-error', '');
    if (!licenseKey) { setMessage('unlock-recovery-error', 'Nhập mã khôi phục (License Key đã kích hoạt trên máy này).'); q('unlock-recovery-key').focus(); return; }
    const button = q('unlock-recovery-form').querySelector('button');
    button.disabled = true;
    try {
      renderLock(await api('/api/app-lock/reset', { licenseKey, pin }));
      q('unlock-recovery-key').value = ''; q('unlock-recovery-pin').value = ''; q('unlock-pin').value = '';
      setMessage('unlock-recovery-error', '');
      resetIdleTimer();
    } catch (error) { setMessage('unlock-recovery-error', error.message); }
    finally { button.disabled = false; }
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!lockState.enabled || lockState.locked) return;
    idleTimer = setTimeout(lockNow, IDLE_MS);
  }

  async function loadBroadcastNotice() {
    try {
      const value = await api('/api/support/notice');
      const text = typeof value === 'string' ? value : (value?.text || value?.message || '');
      if (String(text || '').trim() && window.notice) window.notice(String(text).trim());
    } catch {}
  }

  q('open-plans').onclick = () => openPayment();
  q('settings-open').onclick = () => openSettings('license');
  q('settings-close').onclick = () => q('settings-dialog').close();
  q('settings-tab-license').onclick = () => showPane('license');
  q('settings-tab-lock').onclick = () => showPane('lock');
  q('payment-close').onclick = () => q('payment-dialog').close();
  q('payment-info-form').onsubmit = savePurchaseInfo;
  q('settings-license-form').onsubmit = activateLicense;
  q('pin-form').onsubmit = setPin;
  q('pin-reset-form').onsubmit = resetPin;
  q('app-lock-button').onclick = lockNow;
  q('license-lock-recheck').onclick = () => { void refreshSettings(); };
  q('license-expired-buy').onclick = () => openPayment();
  q('license-expired-key').onclick = () => openSettings('license');
  q('unlock-form').onsubmit = unlock;
  q('unlock-recovery-form').onsubmit = recoverPin;
  // Mạng trở lại: đồng bộ trạng thái ngay, không phải chờ vòng poll 10 giây.
  window.addEventListener('online', () => { void refreshSettings(); });
  planCards.forEach(card => card.querySelector('button').onclick = () => selectPlan(card.dataset.plan));
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(name => document.addEventListener(name, resetIdleTimer, { passive: true }));

  refreshSettings().then(resetIdleTimer);
  loadBroadcastNotice();
})();
