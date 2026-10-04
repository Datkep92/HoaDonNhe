'use strict';
const fs = require('node:fs');
const path = require('node:path');
function auditLog(dataDir, entry) {
  const file = path.join(dataDir, 'ai-audit.jsonl');
  // Do not record model arguments, code, invoice text, user text, tokens, or raw errors.
  const value = { time: new Date().toISOString(), sessionId: entry.sessionId, model: entry.model,
    companyId: entry.companyId, tool: entry.tool, version: entry.version, capability: entry.capability, permission: entry.permission, approvalId: entry.approvalId, actionHash: entry.actionHash, ok: entry.ok, duration: entry.duration, errorCode: entry.errorCode };
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8');
  } catch { /* audit failure must not leak credentials through exception output */ }
}
module.exports = { auditLog };
