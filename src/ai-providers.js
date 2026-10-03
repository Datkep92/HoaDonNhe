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
  function isSafeEmbedUrl(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password && /^[a-z0-9-]+\.easytool\.dev$/i.test(url.hostname);
    } catch { return false; }
  }
  function normalizeProvider(input) {
    if (!input || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.id || '') || ['support', '__proto__', 'constructor', 'prototype'].includes(input.id)) throw new Error('ID chế độ không hợp lệ.');
    const label = String(input.label || '').trim();
    if (!label || label.length > 80 || !['web', 'openai', 'local'].includes(input.type)) throw new Error('Tên hoặc loại AI không hợp lệ.');
    const value = { id: input.id, label, type: input.type };
    if (input.type === 'web') {
      if (!isSafeEmbedUrl(input.embedUrl)) throw new Error('AI web cần địa chỉ HTTPS thuộc easytool.dev.');
      value.embedUrl = new URL(input.embedUrl).href;
    } else {
      const url = parseBaseUrl(input.baseURL, input.type);
      if (!url) throw new Error('Địa chỉ API không hợp lệ: dùng HTTPS, hoặc localhost cho AI trên máy.');
      value.baseURL = url.href.replace(/\/$/, '');
      value.model = String(input.model || '').trim();
      if (!value.model || value.model.length > 200) throw new Error('Chưa nhập model hợp lệ.');
    }
    return value;
  }
  function defaults() {
    return ['deepseek-ai', 'grok-ai', 'perplexity-ai'].map(name => ({ id: 'web-' + name, label: name.replace('-ai', '').replace(/^./, c => c.toUpperCase()) + ' web', type: 'web', embedUrl: `https://${name}.easytool.dev/en/new-chat?ref=app&sidepanel=true` }));
  }
  return { LOOPBACK, parseBaseUrl, isSafeEmbedUrl, normalizeProvider, defaults };
});
