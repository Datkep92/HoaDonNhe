(() => {
  if (globalThis.__cnCaptchaPanel) return;
  const inputSelector = "#Capcha, #captch, #CaptchaInputText, #ContentPlaceHolder1_txtCapcha, input[name*='captch' i], input[name*='capcha' i], input[formcontrolname='strCaptcha' i], input[placeholder*='xác thực' i], input[placeholder*='mã kiểm tra' i]";
  const outside = selector => [...document.querySelectorAll(selector)].find(el => !el.closest('#invoice-vault-captcha-assist, #invoice-vault-misa-assist') && el.getClientRects().length);
  const panelElement = () => document.getElementById('invoice-vault-captcha-assist') || document.getElementById('invoice-vault-misa-assist');
  const continueButton = () => document.getElementById('invoice-vault-captcha-continue') || document.getElementById('invoice-vault-misa-continue');
  const field = () => outside(inputSelector);
  const image = () => outside("img[alt*='captcha' i], img[id*='captcha' i], img[src*='captcha' i], img[id*='capcha' i], img[src*='capcha' i], canvas[id*='captcha' i]");
  const setValue = (el, value) => {
    if (!el) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  let source = null;
  let version = 0;
  function pixels(picture) {
    try {
      if (picture instanceof HTMLCanvasElement) return picture.toDataURL();
      if (!picture.complete || !picture.naturalWidth) return '';
      const canvas = document.createElement('canvas');
      canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
      canvas.getContext('2d').drawImage(picture, 0, 0);
      return canvas.toDataURL();
    } catch { return ''; }
  }
  function enhance() {
    const panel = panelElement();
    const original = field();
    const picture = image();
    if (!panel || !original || !picture) return;
    if (source !== picture) { source = picture; version++; picture.addEventListener('load', () => version++); }
    let group = panel.querySelector('[data-cn-captcha]');
    if (!group) {
      group = document.createElement('div');
      group.dataset.cnCaptcha = 'true';
      const preview = document.createElement('img');
      preview.alt = 'CAPTCHA';
      preview.style.cssText = 'display:block;max-width:100%;height:64px;object-fit:contain;margin:8px 0;background:white';
      const label = document.createElement('label');
      label.textContent = 'Mã CAPTCHA';
      const entry = document.createElement('input');
      entry.type = 'text'; entry.autocomplete = 'off'; entry.setAttribute('aria-label', 'Mã CAPTCHA');
      entry.style.cssText = 'width:100%;box-sizing:border-box;padding:9px;border:1px solid #9ca3af;border-radius:4px;margin:5px 0 10px;font:16px Arial';
      entry.addEventListener('input', () => setValue(field(), entry.value));
      entry.addEventListener('keydown', event => { if(event.key === 'Enter') { event.preventDefault(); continueButton()?.click(); } });
      group.append(preview, label, entry);
      panel.insertBefore(group, continueButton());
    }
    const preview = group.querySelector('img');
    // Reusing a remote CAPTCHA URL can generate another challenge. Copy pixels, never reload it.
    const data = pixels(picture);
    if (data && preview.src !== data) preview.src = data;
    const entry = group.querySelector('input');
    if (document.activeElement !== entry) entry.value = original.value;
  }
  globalThis.__cnCaptchaPanel = {
    enhance,
    challenge() {
      enhance();
      const original = field(), picture = image();
      if (!original || !picture) return null;
      const rect = picture.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.width > 1200 || rect.height > 600) return null;
      const data = pixels(picture);
      if (!data) {
        const panel = panelElement();
        if (panel) panel.style.visibility = 'hidden';
      }
      return { version, src: picture.currentSrc || picture.src || '', data, hasValue: !!original.value.trim(),
        clip: { x: Math.max(0, rect.left + scrollX), y: Math.max(0, rect.top + scrollY), width: rect.width, height: rect.height, scale: 1 } };
    },
    preview(message) {
      const panel = panelElement();
      if (panel) panel.style.visibility = '';
      const preview = panel?.querySelector('[data-cn-captcha] img');
      if (preview && message.data && version === message.version) preview.src = message.data;
      return {};
    },
    fill(message) {
      const original = field(), picture = image();
      if (!original || original.value.trim() || picture !== source || version !== message.version || (picture.currentSrc || picture.src || '') !== message.src) return { filled: false };
      setValue(original, message.text);
      enhance();
      return { filled: true };
    },
  };
  setInterval(enhance, 700);
})();
