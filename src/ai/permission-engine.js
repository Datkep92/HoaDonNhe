'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { atomicWrite } = require('../core');
const { redact } = require('./data-minimizer');
const SCOPES = Object.freeze(['once', 'session', 'workspace', 'company', 'application', 'device', 'always', 'deny']);
const failure = (message, code = 'PERMISSION_DENIED') => Object.assign(new Error(message), { code });
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function binding(tool, args, context) {
  return createHash('sha256').update(canonical({ tool: tool.name, version: tool.version, capability: tool.requiredPermissions, risk: tool.riskClass, args, companyId: context.companyId, workspace: context.workspace, application: context.application, deviceId: context.deviceId || '', fingerprint: context.fingerprint || '' })).digest('hex');
}
function impact(tool, args, context) {
  if (tool.name === 'mst.select') return 'Chuyển MST đang chọn từ ' + context.companyId + ' sang ' + args.mst + '. Không sửa hóa đơn.';
  if (tool.name === 'account.refresh') return 'Kiểm tra và khôi phục phiên đăng nhập cổng thuế của MST ' + context.companyId + ' bằng cơ chế ứng dụng.';
  if (tool.name === 'invoice.download') return 'Bắt đầu tải nền hóa đơn ' + (args.direction === 'SELL' ? 'bán ra' : 'mua vào') + ' của MST ' + context.companyId + ', từ ' + args.from + ' đến ' + args.to + '. Tạo file trong thư mục lưu hiện tại; chưa xác định số hóa đơn.';
  return tool.description + ' · ' + context.companyId;
}
function createPermissionEngine(dataDir, { now = Date.now, expiryMs = 120000 } = {}) {
  const filename = path.join(dataDir, 'agent', 'permissions.json');
  let saved = { version: 1, records: [] };
  if (fs.existsSync(filename)) {
    saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.records)) throw failure('Metadata quyền chưa tương thích; giữ nguyên và cập nhật ứng dụng.', 'PERMISSION_SCHEMA_UNKNOWN');
  }
  for (const record of saved.records) if (record.state === 'pending' || record.scope === 'once' && record.state === 'approved') record.state = 'interrupted';
  const pending = new Map(), tickets = new Map();
  const persist = () => { fs.mkdirSync(path.dirname(filename), { recursive: true }); atomicWrite(filename, JSON.stringify(saved, null, 2)); };
  if (fs.existsSync(filename)) persist();
  function validContext(context) {
    if (!context.sessionId || !context.companyId || !context.workspace || !context.application) throw failure('Thiếu phạm vi hành động để phê duyệt.');
  }
  function applies(record, context, actionHash) {
    if (record.actionHash !== actionHash || record.companyId !== context.companyId || record.workspace !== context.workspace || record.application !== context.application || (record.deviceId || '') !== (context.deviceId || '')) return false;
    if (record.scope === 'session' && record.sessionId !== context.sessionId) return false;
    return record.state === 'approved' || record.state === 'denied';
  }
  function evidence(record, tool, args, context) {
    const ticket = randomUUID(); tickets.set(ticket, { recordId: record.approvalId, actionHash: binding(tool, args, context), sessionId: context.sessionId, companyId: context.companyId, expiresAt: record.scope === 'once' ? Math.min(now() + expiryMs, Date.parse(record.expiresAt)) : now() + expiryMs });
    return { ticket, approvalId: record.approvalId };
  }
  async function request(tool, args, context, signal, emit) {
    validContext(context); signal.throwIfAborted();
    const actionHash = binding(tool, args, context);
    const reusable = saved.records.slice().reverse().find(record => record.scope !== 'once' && applies(record, context, actionHash));
    if (reusable) { if (reusable.state === 'denied') throw failure('Bạn đã từ chối đúng hành động này. Thu hồi quy tắc từ chối trong Quyền AI nếu muốn đổi.'); return evidence(reusable, tool, args, context); }
    const record = { approvalId: randomUUID(), capability: tool.requiredPermissions[0], scope: 'once', tool: tool.name, version: tool.version,
      actionHash, companyId: context.companyId, sessionId: context.sessionId, workspace: context.workspace, application: context.application, deviceId: context.deviceId || '',
      target: args.mst || context.companyId, impactSummary: impact(tool, args, context), arguments: redact(args), expiresAt: new Date(now() + expiryMs).toISOString(), state: 'pending', createdAt: new Date(now()).toISOString() };
    saved.records.push(record); persist();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => { if (!pending.delete(record.approvalId)) return; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error) { record.state = signal.aborted ? 'cancelled' : record.state === 'pending' ? 'expired' : record.state; persist(); reject(error); } else resolve(value); };
      const abort = () => finish(failure('Tác vụ đã dừng; phê duyệt chưa dùng bị hủy.', 'USER_CANCELLED'));
      pending.set(record.approvalId, { record, context, tool, args: JSON.parse(JSON.stringify(args)), finish });
      timer = setTimeout(() => finish(failure('Phê duyệt hết thời gian.', 'APPROVAL_EXPIRED')), expiryMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { emit({ ...record, allowedScopes: SCOPES.filter(scope => !['device', 'always'].includes(scope) || !!context.deviceId) }); }
      catch (error) { finish(error); }
    });
  }
  function decide({ approvalId, actionHash, decision, scope = 'once' }, context) {
    validContext(context);
    const waiting = pending.get(approvalId), record = waiting?.record;
    if (!record || record.state !== 'pending' || Date.parse(record.expiresAt) <= now()) throw failure('Phê duyệt không còn chờ hoặc đã hết hạn.', 'APPROVAL_EXPIRED');
    if (record.actionHash !== actionHash || context.sessionId !== record.sessionId || context.companyId !== record.companyId || binding(waiting.tool, waiting.args, context) !== actionHash) throw failure('Hành động/phạm vi đã thay đổi; không dùng phê duyệt cũ.', 'APPROVAL_MISMATCH');
    if (!SCOPES.includes(scope) || !['allow', 'deny'].includes(decision) || ['device', 'always'].includes(scope) && !context.deviceId) throw failure('Phạm vi phê duyệt không hợp lệ.');
    record.scope = decision === 'deny' ? 'deny' : scope;
    record.state = decision === 'deny' || scope === 'deny' ? 'denied' : 'approved'; persist();
    if (record.state === 'denied') waiting.finish(failure('Bạn đã từ chối; không thực hiện hành động.'));
    else waiting.finish(null, evidence(record, waiting.tool, waiting.args, context));
    return { approvalId, state: record.state, scope: record.scope };
  }
  function consume(value, tool, args, context) {
    const ticket = tickets.get(value?.ticket); tickets.delete(value?.ticket);
    const record = saved.records.find(r => r.approvalId === ticket?.recordId);
    if (!ticket || !record || record.state !== 'approved' || ticket.expiresAt <= now() || ticket.actionHash !== binding(tool, args, context) || ticket.sessionId !== context.sessionId || ticket.companyId !== context.companyId) throw failure('Thiếu phê duyệt hợp lệ cho đúng hành động.', 'APPROVAL_MISMATCH');
    if (record.scope === 'once') { record.state = 'consumed'; persist(); }
    return { approvalId: record.approvalId, actionHash: ticket.actionHash, scope: record.scope };
  }
  return { request, decide, consume,
    list(context) { validContext(context); return saved.records.filter(r => r.companyId === context.companyId && r.workspace === context.workspace && r.application === context.application && (['approved', 'denied', 'pending'].includes(r.state) || saved.records.indexOf(r) >= saved.records.length - 100)).map(r => ({ ...r })); },
    clearSession(sessionId) { for (const record of saved.records) if (record.sessionId === sessionId && ['once', 'session'].includes(record.scope) && ['approved', 'pending'].includes(record.state)) { record.state = 'revoked'; pending.get(record.approvalId)?.finish(failure('Cuộc trò chuyện đã kết thúc.')); } persist(); },
    revoke(id, context) { const record = saved.records.find(r => r.approvalId === id); if (!record || !this.list(context).some(r => r.approvalId === id)) throw failure('Quyền không thuộc phạm vi hiện tại.'); record.state = 'revoked'; persist(); pending.get(id)?.finish(failure('Phê duyệt đã bị thu hồi.')); },
    close() { for (const waiting of [...pending.values()]) { waiting.record.state = 'interrupted'; waiting.finish(failure('Ứng dụng đóng; không thực hiện lại hành động.', 'USER_CANCELLED')); } tickets.clear(); },
  };
}
module.exports = { createPermissionEngine, binding, SCOPES };
