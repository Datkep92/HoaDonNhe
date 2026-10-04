'use strict';
const SECRET_FIELD = /^(?:password|pass|pwd|token|access_token|refresh_token|sessionToken|cookies|api[_-]?key|secret|licenseKey|license_key|authorization|credential)$/i;
function redact(value, secretValues = [], depth = 0) {
  if (depth > 32) return '[Nested data omitted]';
  if (typeof value === 'string') {
    for (const secret of secretValues) if (typeof secret === 'string' && secret.length >= 16) value = value.split(secret).join('[REDACTED]');
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').replace(/(["']?(?:password|api[_-]?key|access_token|refresh_token|license[_-]?key|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1"[REDACTED]"');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secretValues, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, v]) => [key, redact(v, secretValues, depth + 1)]));
  return value;
}
function minimizeMessages(messages, config) {
  const safe = messages.map(message => redact(message, [config.apiKey]));
  let characters = 0;
  for (const message of safe) {
    if (typeof message.content === 'string') characters += message.content.length;
    else for (const part of message.content || []) if (part.type === 'text') characters += part.text.length;
  }
  if (characters > 384000) throw new Error('Ngữ cảnh AI vượt ngân sách; thu hẹp yêu cầu hoặc mở Chat mới.');
  return safe;
}
module.exports = { redact, minimizeMessages };
