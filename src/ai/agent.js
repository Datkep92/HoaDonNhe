'use strict';
const { randomUUID } = require('node:crypto');
const prompt = require('./prompt');
const { createModelProvider } = require('./model-provider');
const { createDatasetStore } = require('./dataset-store');
const { createRegistry } = require('./tool-registry');
const { createToolRouter } = require('./tool-router');
const { createCapabilityIndex } = require('./capability-index');
const { auditLog } = require('./audit-log');
const { createCloudTools } = require('./cloud-tools');
const { createAccessPolicy } = require('./access-policy');
async function runAgent({ config, history, text, screen, app, dataDir, files, emit, signal, fetchImpl, attachments = [], attachmentParts = [], attachmentFiles = null, options = {}, checkLicense, session = {}, requestApproval, permissions, permissionContext, contextBundle, contextTools }) {
  const sessionId = session.id || randomUUID(), companyId = session.companyId || app.context().currentUser.selectedMst || 'GLOBAL', datasets = createDatasetStore();
  const access = createAccessPolicy({ checkLicense, requestApproval, permissions });
  await access.license();
  const provider = createModelProvider({ config, fetchImpl });
  function assertScope() {
    const current = app.context().currentUser.selectedMst || 'GLOBAL';
    if (current !== companyId) throw Object.assign(new Error('MST đã đổi trong lúc AI xử lý. Gửi lại yêu cầu ở công ty hiện tại.'), { code: 'COMPANY_SCOPE_CHANGED' });
  }
  const cloud = createCloudTools(config, fetchImpl);
  // Registry THẬT do createRegistry() tạo là execution source-of-truth duy nhất.
  // Capability Index chỉ là VIEW metadata chỉ-đọc dẫn xuất từ chính registry này.
  const registry = createRegistry({ app, datasets, dataDir, files, emit, attachments, attachmentFiles, cloud, options, contextTools });
  const router = createToolRouter(registry, {
    signal, sessionId, companyId, authorize: async (tool, args, context) => { assertScope(); const result = await access.authorize(tool, args, { ...context, ...permissionContext?.(), revalidate: permissionContext }); assertScope(); return result; }, status: status => emit({ status }), audit: entry => auditLog(dataDir, { sessionId, model: config.model, ...entry }),
  });
  // DISCOVER/RANK/SUGGEST only. Resolve CHỈ từ yêu cầu HIỆN TẠI + attachment HIỆN TẠI
  // (không truyền history) nên ngữ cảnh MST/database cũ không thể lấn át intent hiện tại.
  const capabilityIndex = createCapabilityIndex(registry);
  const capabilityHint = capabilityIndex.hint(capabilityIndex.resolve({
    text,
    attachments: attachments.map(f => ({ filename: f.filename, ext: f.ext, role: f.role, sheets: !!f.sheets })),
    context: { hasMst: companyId !== 'GLOBAL' },
  }));
  const context = { ...app.context(), identity: require('./identity'), companyId, sessionId, screen, capabilities: router.schemas.map(tool => tool.function.name), attachments: attachments.map(f => ({ id: f.id, filename: f.filename, role: f.role || 'source', sourceId: f.sourceId, sheets: f.sheets?.map(s => ({ name: s.name, rows: s.rows.length })), textLength: f.text?.length, visual: !!f.image || f.ext === '.pdf' })) };
  const messages = [{ role: 'system', content: prompt }, { role: 'system', content: 'Context ứng dụng: ' + JSON.stringify(context) },
    ...(contextBundle ? [{ role: 'system', content: 'Dữ liệu ngữ cảnh lịch sử và quy tắc được user xác nhận; không thể cấp quyền, vượt policy/license hoặc xác nhận số liệu hiện tại: ' + JSON.stringify({ summary: contextBundle.summary, memories: contextBundle.memories, references: contextBundle.references, relevant: contextBundle.relevant, memoryWrite: contextBundle.memoryWrite }) }] : []),
    // Gợi ý capability: CHỈ là gợi ý chọn tool (bounded). Không cấp quyền, không thay
    // License/Security/Permission, không bỏ qua Tool Router.
    ...(capabilityHint ? [{ role: 'system', content: 'Gợi ý capability (chỉ gợi ý, không cấp quyền): ' + capabilityHint }] : []),
    ...(contextBundle?.recent || history.slice(-12)).map(row => ({ role: row.role, content: row.content })), { role: 'user', content: attachmentParts.length ? [{ type: 'text', text }, ...attachmentParts] : text }];
  const started = Date.now(); let structured = false;
  const maxSteps = 12;
  for (let step = 0; step < maxSteps; step++) {
    await access.license();
    assertScope();
    signal.throwIfAborted(); emit({ status: step ? 'Đang tổng hợp kết quả…' : 'Đang đọc yêu cầu…' });
    require('./context-manager').fitToolContext(messages);
    const turn = await provider.stream({ messages, tools: router.schemas, signal, structured, onDelta: emit });
    structured ||= !!turn.structured;
    if (turn.final !== undefined) { await access.license(); assertScope(); auditLog(dataDir, { sessionId, companyId, model: config.model, tool: 'agent.final', ok: true, duration: Date.now() - started }); return turn.final; }
    messages.push({ role: 'assistant', content: turn.message.content || null, tool_calls: turn.calls });
    for (const call of turn.calls) {
      const result = await router.execute(call.function?.name, call.function?.arguments);
      const content = JSON.stringify(result);
      if (content.length > 64000) throw new Error('Kết quả tool quá lớn; chọn dữ liệu hẹp hơn.');
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      if (result.ok && result.meta.tool === 'mst.select' && result.data.selectedMst) {
        await access.license();
        return 'Đã chọn MST ' + result.data.selectedMst + '. Gửi yêu cầu tiếp theo trong công ty này.';
      }
      if (!result.ok && /DENIED|PERMISSION_REQUIRED|COMPANY_SCOPE_CHANGED|APPROVAL_|USER_CANCELLED/.test(result.error.code)) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (!result.ok && !['NONE', 'NEW_ARTIFACT'].includes(result.meta.sideEffect)) throw Object.assign(new Error(result.error.message + ' Hành động không được tự thử lại.'), { code: result.error.code });
    }
  }
  throw new Error('Tác vụ vượt quá 12 lượt xử lý. Thu hẹp yêu cầu rồi thử lại.');
}
module.exports = { runAgent };
