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
    if (value === 'locked') return 'Đã bị khóa';
    if (value === 'expired') return 'Đã hết hạn';
    if (value === 'unactivated') return 'Chưa kích hoạt';
    return status || 'Trial';
  };
  const packageName = license => {
    const pkg = license?.packageType || license?.package || '';
    const status = String(license?.status || '').toLowerCase();
    if (status === 'active') return pkg || 'Bản quyền';
    if (status === 'locked') return 'Bị khóa';
    if (status === 'expired') return 'Hết hạn';
    return 'Trial';
  };
  const setMessage = (id, text) => { q(id).textContent = text || ''; };

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
    q('license-current-status').textContent = labelStatus(license.status);
    q('license-current-expiry').textContent = license.expiryAt || (status === 'active' ? 'Vĩnh viễn' : '—');
    q('license-current-key').textContent = license.keyName || license.key || '—';
    q('license-hardware-id').textContent = device.hardwareId || device.installationId || '—';
  }

  function renderLock(state) {
    lockState = state || lockState;
    q('lock-enabled-label').textContent = lockState.enabled ? 'Đã bật khóa PIN' : 'Chưa thiết lập mã PIN';
    q('lock-screen').hidden = !lockState.locked;
    if (lockState.locked) setTimeout(() => q('unlock-pin').focus(), 30);
  }

  async function refreshSettings() {
    try { renderLicense(await api('/api/support/status')); } catch {}
    try { renderLock(await api('/api/app-lock/status')); } catch {}
  }

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

  function openPayment(card) {
    const plan = card.dataset.plan || 'Plus';
    const price = card.dataset.price || '299.000đ';
    q('payment-title').textContent = `Đăng ký ${plan}`;
    q('payment-subtitle').textContent = `Số tiền thanh toán: ${price}`;
    q('payment-plan').textContent = plan;
    q('payment-price').textContent = price;
    q('payment-dialog').showModal();
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

  q('settings-open').onclick = () => openSettings('license');
  q('settings-close').onclick = () => q('settings-dialog').close();
  q('settings-tab-license').onclick = () => showPane('license');
  q('settings-tab-lock').onclick = () => showPane('lock');
  q('payment-close').onclick = () => q('payment-dialog').close();
  q('settings-license-form').onsubmit = activateLicense;
  q('pin-form').onsubmit = setPin;
  q('pin-reset-form').onsubmit = resetPin;
  q('app-lock-button').onclick = lockNow;
  q('unlock-form').onsubmit = unlock;
  document.querySelectorAll('.plan-card').forEach(card => card.querySelector('button').onclick = () => openPayment(card));
  ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(name => document.addEventListener(name, resetIdleTimer, { passive: true }));

  refreshSettings().then(resetIdleTimer);
  loadBroadcastNotice();
  setInterval(refreshSettings, 10000);
})();
