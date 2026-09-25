'use strict';

// Executed only in the selected tax-page context. Selectors and the visible-form
// strategy are ported from the original extension's login.js.
async function taxLoginAction(options) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const form = () => [...document.querySelectorAll('form')].find(f => visible(f.querySelector('#username')) && visible(f.querySelector('#password')));
  const image = f => [...(f || document).querySelectorAll('img[alt="captcha"], img[src*="captcha"], img')].find(img => visible(img) && (img.alt?.toLowerCase() === 'captcha' || img.closest('form') === f));
  const pageError = () => [...document.querySelectorAll('.ant-form-item-explain-error,.ant-form-explain,.ant-message-error,.ant-notification-notice-description')].filter(visible).map(el => el.textContent.trim()).filter(Boolean).join(' · ').slice(0, 500);
  // Không để Chrome/Edge hiện bong bóng "Lưu mật khẩu?" cho form đăng nhập của cổng thuế.
  // autocomplete="off" trên cả form lẫn từng ô; data-lpignore/data-1p-ignore cho trình quản lý mật khẩu bên thứ ba.
  // Chỉ thêm thuộc tính — KHÔNG đổi name/id/value nên việc gửi form của cổng thuế giữ nguyên.
  const quietPasswordManager = f => {
    if (!f) return false;
    f.setAttribute('autocomplete', 'off');
    for (const el of f.querySelectorAll('input')) {
      el.setAttribute('autocomplete', 'off');
      if (String(el.type).toLowerCase() === 'password') { el.setAttribute('data-lpignore', 'true'); el.setAttribute('data-1p-ignore', 'true'); }
    }
    return true;
  };
  const token = () => { try { return window.__NEXT_REDUX_STORE__?.getState?.().authReducer?.jwt || ''; } catch { return ''; } };
  const authenticated = () => {
    try { const value = token(); const part = value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); const p = JSON.parse(atob(part)); return !p.exp || p.exp * 1000 > Date.now(); } catch { return false; }
  };
  const closeWelcomePopup = () => {
    const popups = [...document.querySelectorAll('.ant-modal-wrap,.ant-modal,.ant-modal-root,[role="dialog"]')]
      .filter(el => visible(el) && !el.querySelector('#password'));
    for (const popup of popups) {
      const close = [...popup.querySelectorAll('.ant-modal-close,[aria-label*="close" i],[title*="đóng" i],button')]
        .find(el => /^(×|x|đóng|close)$/i.test((el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()));
      close?.click();
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    return popups.length;
  };
  const clickLoginHeader = () => {
    const oldHeader = document.evaluate('//*[@id="__next"]/section/header/div[1]/div/div[7]/span', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    const header = visible(oldHeader) && /đăng nhậ/i.test(oldHeader.textContent) ? oldHeader
      : [...document.querySelectorAll('header button,header a,header span,button,a')].find(el => visible(el) && /^đăng nhập$/i.test(el.textContent.trim()));
    header?.click();
    return !!header;
  };
  const snapshot = async () => {
    if (authenticated()) return { authenticated: true, ready: false, captcha: '', error: '' };
    const f = form(); const img = image(f);
    let captcha = '';
    if (img?.src && img.complete && img.naturalWidth) {
      try { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; canvas.getContext('2d').drawImage(img, 0, 0); captcha = canvas.toDataURL('image/png'); }
      catch { if (/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(img.src)) captcha = img.src; }
    }
    return { authenticated: false, ready: !!f && !!captcha, captcha, error: pageError() };
  };
  if (options.mode === 'submit') {
    const f = form();
    if (!f) throw new Error('Form cổng thuế chưa sẵn sàng. Bấm Lấy CAPTCHA lại.');
    quietPasswordManager(f);
    const cap = [...f.querySelectorAll('#cvalue,input[name="cvalue"]')].find(visible);
    const fields = [[f.querySelector('#username'), options.username], [f.querySelector('#password'), options.password], [cap, options.captcha]];
    if (fields.some(([el]) => !el)) throw new Error('Không tìm thấy đủ ô tài khoản, mật khẩu và CAPTCHA trên cổng thuế.');
    const img = image(f);
    // The browser's displayed challenge is fingerprinted without exporting any cookie.
    const current = await snapshot();
    if (options.expectedCaptcha && options.expectedCaptcha !== current.captcha) throw new Error('CAPTCHA đã thay đổi. Bấm Đổi CAPTCHA và nhập lại mã.');
    for (const [el, value] of fields) {
      el.focus();
      const old = el.value;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      if (el._valueTracker) el._valueTracker.setValue(old);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await wait(150);
    const button = [...f.querySelectorAll('button')].filter(visible).find(b => /đăng nhậ|login/i.test(b.textContent)) || f.querySelector('button[type="submit"]');
    if (!button || button.disabled) throw new Error('Nút Đăng nhập trên cổng thuế chưa sẵn sàng.');
    const oldError = pageError(); const oldImage = img?.src;
    button.click();
    for (let n = 0; n < 60; n++) {
      await wait(250);
      if (authenticated()) return { authenticated: true, ready: false, captcha: '', error: '' };
      const error = pageError();
      if (error && (error !== oldError || n > 8)) return { ...(await snapshot()), error };
      if (n > 4 && image(form())?.src !== oldImage) return { ...(await snapshot()), error: error || 'Đăng nhập chưa thành công. Nhập CAPTCHA mới để thử lại.' };
    }
    return { ...(await snapshot()), error: 'Chưa nhận được xác nhận đăng nhập. Kiểm tra tài khoản, mật khẩu và CAPTCHA hoặc mở trang thuế.' };
  }
  if (options.mode === 'refresh') {
    const img = image(form());
    if (img) {
      const old = img.src; img.click();
      for (let n = 0; n < 20; n++) { await wait(200); if (image(form())?.src !== old && image(form())?.complete) break; }
    }
  }
  let clickedAt = 0, popupClosed = false;
  // TCT sometimes needs longer than 25 seconds before rendering the welcome popup.
  for (let n = 0; n < (options.mode === 'status' ? 1 : 240); n++) {
    const state = await snapshot();
    if (state.authenticated || state.ready) { quietPasswordManager(form()); return state; }
    if (!form() && Date.now() - clickedAt > 1000) {
      // The TCT home page shows a welcome layer over its header. Always dismiss it
      // before clicking Đăng nhập, then repeat once in case its animation blocks the first click.
      if (!popupClosed) { closeWelcomePopup(); popupClosed = true; await wait(450); }
      clickLoginHeader();
      clickedAt = Date.now();
    }
    await wait(250);
  }
  return { ...(await snapshot()), error: 'Chưa lấy được CAPTCHA từ cổng thuế. Bấm Lấy CAPTCHA lại hoặc Mở trang thuế để kiểm tra.' };
}
module.exports = { taxLoginAction };
