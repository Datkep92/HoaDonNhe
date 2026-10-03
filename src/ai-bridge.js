'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AiBridge = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const ALLOWED_KEYS = Object.freeze(['storageMetadata-v1', 'aiModelName-v1', 'colorScheme-v1', 'savedChats-v1', 'personalizedPrompt-v1', 'fp-v1', 'fpHash-v1']);
  const ALWAYS_NULL = Object.freeze(['fp-v1', 'fpHash-v1']);
  function isHandled(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data) && data.type === 'storageRequest'
      && ['get', 'set'].includes(data.operation) && typeof data.key === 'string' && !!data.key
      && typeof data.messageId === 'string' && !!data.messageId;
  }
  function isAllowedKey(key) { return ALLOWED_KEYS.includes(key); }
  async function buildResponse(data, store) {
    if (!isHandled(data)) return null;
    let value = null;
    if (isAllowedKey(data.key) && !ALWAYS_NULL.includes(data.key)) {
      if (data.operation === 'get') value = (await store.get(data.key)) ?? null;
      else await store.set(data.key, data.value);
    }
    return { type: 'storageResponse', operation: data.operation, key: data.key, messageId: data.messageId, value };
  }
  return { ALLOWED_KEYS, ALWAYS_NULL, isHandled, isAllowedKey, buildResponse };
});
