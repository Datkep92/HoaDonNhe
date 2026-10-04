'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AiProviders = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
  function parseBaseUrl(raw, type) {
    try {
      const url = new URL(String(raw || '').trim());
      if (url.username || url.password || url.search || url.hash) return null;
      if (type === 'local' && !LOOPBACK.test(url.hostname)) return null;
      if (url.protocol === 'https:' || (type === 'local' && url.protocol === 'http:' && LOOPBACK.test(url.hostname))) return url;
    } catch {}
    return null;
  }
  function normalizeProvider(input) {
    if (!input || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id || '') || ['support', '__proto__', 'constructor', 'prototype'].includes(input.id)) throw new Error('ID chế độ không hợp lệ.');
    const label = String(input.label || '').trim();
    if (!label || label.length > 80 || !['openai', 'local'].includes(input.type)) throw new Error('Tên hoặc loại AI không hợp lệ.');
    const value = { id: input.id, label, type: input.type };
    const url = parseBaseUrl(input.baseURL, input.type);
    if (!url) throw new Error('Địa chỉ API không hợp lệ: dùng HTTPS, hoặc localhost cho AI trên máy.');
    value.baseURL = url.href.replace(/\/$/, '');
    value.model = String(input.model || '').trim();
    if (!value.model || value.model.length > 200) throw new Error('Chưa nhập model hợp lệ.');
    return value;
  }
  function defaults() {
    return [{ id: 'agent', label: 'CNTaxTools', type: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'stealth/space-bunny-alpha' }];
  }
  return { LOOPBACK, parseBaseUrl, normalizeProvider, defaults };
});
