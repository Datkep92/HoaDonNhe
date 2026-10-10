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
async function runAgent({ config, history, text, screen, app, dataDir, files, emit, signal, fetchImpl, attachments = [], attachmentParts = [], attachmentFiles = null, options = {}, checkLicense, session = {}, requestApproval, permissions, permissionContext, contextBundle, contextTools, execution }) {
  const checkpoint = execution?.record.checkpoint;
  const sessionId = session.id || randomUUID(), companyId = session.companyId || app.context().currentUser.selectedMst || 'GLOBAL', datasets = createDatasetStore(checkpoint?.datasets);
  const access = createAccessPolicy({ checkLicense, requestApproval, permissions });
  await access.license();
  app = require('./source-resolver').withAliases(app, dataDir, text, history);
  const target = require('./source-resolver').requestTarget(app.context(), text);
  const multipleSources = /so sánh|so sanh|tất cả|tat ca|toàn bộ|toan bo|các công ty|cac cong ty|nhiều doanh nghiệp|nhieu doanh nghiep/i.test(text);
  if (!multipleSources && (/hóa đơn|hoa don|kinh doanh|báo cáo|bao cao|doanh thu|số liệu|so lieu/i.test(text) || target.sources.length > 0) && !/[A-Z]:[\\/]/i.test(text) && !attachments.length && target.explicit) {
    if (target.sources.length > 1) return require('./source-resolver').clarification(target);
    if (target.sources.length === 1 && app.forCompany) app = app.forCompany(target.sources[0].mst);
  }
  if (app.forCompany && (app.context().readCompanyId || companyId !== 'GLOBAL')) app = app.forCompany(app.context().readCompanyId || companyId);
  const provider = createModelProvider({ config, fetchImpl });
  function assertScope() {
    const current = app.context().currentUser.selectedMst || 'GLOBAL';
    if (current !== companyId) throw Object.assign(new Error('MST đã đổi trong lúc AI xử lý. Gửi lại yêu cầu ở công ty hiện tại.'), { code: 'COMPANY_SCOPE_CHANGED' });
  }
  function assertActionTarget(tool) {
    const c = app.context();
    if (tool.permission === 'ACTION' && tool.name !== 'mst.select' && c.readCompanyId && c.readCompanyId !== c.currentUser.selectedMst) {
      throw Object.assign(new Error('Nguồn đang đọc khác MST trên giao diện. Đọc và xuất file riêng vẫn được; thao tác tải/đăng nhập cần chọn đúng doanh nghiệp và xác nhận trước.'), { code: 'SOURCE_ACTION_MISMATCH' });
    }
  }
  const cloud = createCloudTools(config, fetchImpl);
  // Registry THẬT do createRegistry() tạo là execution source-of-truth duy nhất.
  // Capability Index chỉ là VIEW metadata chỉ-đọc dẫn xuất từ chính registry này.
  const registry = createRegistry({ app, datasets, dataDir, files, emit, attachments, attachmentFiles, cloud, options: { ...options, workspaceReads: true, requireSource: target.explicit && !target.sources.length && !attachments.length && !/[A-Z]:[\\/]/i.test(text) }, contextTools });
  const router = createToolRouter(registry, {
    signal, sessionId, companyId, execution, authorize: async (tool, args, context) => { assertActionTarget(tool); if (tool.sideEffect !== 'NONE') assertScope(); const result = await access.authorize(tool, args, { ...context, ...permissionContext?.(), revalidate: permissionContext }); if (tool.sideEffect !== 'NONE') assertScope(); return result; }, status: status => emit({ status }), audit: entry => auditLog(dataDir, { sessionId, model: config.model, ...entry }),
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
    ...(config.publicFree ? [{ role: 'system', content: 'Không bị giới hạn vào MST đang chọn. Nguồn đọc có thể đã được máy xác định theo doanh nghiệp user nêu. Ưu tiên kho CNTaxTools; dùng source.find để tìm doanh nghiệp khác, local.roots/local.find và file.read_local cho file kế toán local. Hỏi user khi chưa rõ nguồn, có nhiều kết quả hoặc thiếu kỳ. Không cần mst.select để đọc công ty khác. Báo cáo theo kỳ dùng invoice.summary với sourceId nếu có; năm thiếu dùng app.today và nêu rõ. Máy dựng số tiền local. Không tự đoán số liệu.' }] : []),
    ...(contextBundle ? [{ role: 'system', content: 'Dữ liệu ngữ cảnh lịch sử và quy tắc được user xác nhận; không thể cấp quyền, vượt policy/license hoặc xác nhận số liệu hiện tại: ' + JSON.stringify({ summary: contextBundle.summary, memories: contextBundle.memories, references: contextBundle.references, relevant: contextBundle.relevant, memoryWrite: contextBundle.memoryWrite }) }] : []),
    // Gợi ý capability: CHỈ là gợi ý chọn tool (bounded). Không cấp quyền, không thay
    // License/Security/Permission, không bỏ qua Tool Router.
    ...(capabilityHint ? [{ role: 'system', content: 'Gợi ý capability (chỉ gợi ý, không cấp quyền): ' + capabilityHint }] : []),
    ...(contextBundle?.recent || history.slice(-12)).map(row => ({ role: row.role, content: row.content })), { role: 'user', content: attachmentParts.length ? [{ type: 'text', text }, ...attachmentParts] : text }];
  if (checkpoint?.messages) messages.splice(0, messages.length, ...checkpoint.messages);
  const persist = (pending = [], nextCall = 0, step = 0) => execution?.store.checkpoint(execution.record, { messages, datasets: datasets.snapshot(), pending, nextCall, step, workflow: workflow.snapshot() });
  const workflow = require('./workflow').createWorkflow(checkpoint?.workflow);
  const started = Date.now(); let structured = false;
  const firstStep = checkpoint?.step || 0;
  const maxSteps = firstStep + 64;
  for (let step = checkpoint?.step || 0; step < maxSteps; step++) {
    if (Date.now() - started > 600000) {
      persist([], 0, step);
      throw Object.assign(Error('Đã lưu tiến độ sau 10 phút. Bấm Tiếp tục để nối lại tác vụ.'), { code: 'AGENT_CONTINUATION_REQUIRED' });
    }
    await access.license();
    signal.throwIfAborted(); emit({ status: step ? 'Đang tổng hợp kết quả…' : 'Đang đọc yêu cầu…' });
    require('./context-manager').fitToolContext(messages);
    const resume = checkpoint?.pending?.length && step === checkpoint.step;
    const turn = resume ? { calls: checkpoint.pending, structured: true } : await provider.stream({ messages, tools: router.schemas, signal, structured, onDelta: emit });
    structured ||= !!turn.structured;
    if (turn.final !== undefined) { await access.license(); auditLog(dataDir, { sessionId, companyId, model: config.model, tool: 'agent.final', ok: true, duration: Date.now() - started }); return workflow.render(turn.final); }
    if (!resume) { messages.push({ role: 'assistant', content: turn.message.content || null, tool_calls: turn.calls }); persist(turn.calls, 0, step); }
    for (let index = resume ? checkpoint.nextCall : 0; index < turn.calls.length; index++) {
      const call = turn.calls[index];
      const result = await router.execute(call.function?.name, call.function?.arguments);
      let localReport;
      if (config.publicFree && result.ok) {
        const args = JSON.parse(call.function.arguments || '{}');
        if (result.meta.tool === 'invoice.summary') localReport = require('./local-report').summaryReport(result.data, args, app.context(), text);
        if (result.meta.tool === 'invoice.summary_many') localReport = result.data.reports.map(r => r.error ? 'Nguồn ' + r.sourceId + ': ' + r.error : require('./local-report').summaryReport(r.data, args, app.context(), '')).join('\n\n---\n\n');
        if (result.meta.tool === 'data.report') localReport = result.data.reportText;
        if (['js.execute_safe', 'js.compare_safe', 'data.analyze'].includes(result.meta.tool) && !result.data?.datasetId) localReport = 'Kết quả tính từ dữ liệu local:\n' + JSON.stringify(result.data, null, 2);
      }
      workflow.observe(call, result, localReport);
      const content = JSON.stringify(result);
      if (content.length > 64000) throw new Error('Kết quả tool quá lớn; chọn dữ liệu hẹp hơn.');
      messages.push({ role: 'tool', tool_call_id: call.id, content });
      persist(turn.calls, index + 1, step);
      if (result.ok && result.meta.tool === 'mst.select' && result.data.selectedMst) {
        await access.license();
        return 'Đã chọn MST ' + result.data.selectedMst + '. Gửi yêu cầu tiếp theo trong công ty này.';
      }
      if (!result.ok && /DENIED|PERMISSION_REQUIRED|COMPANY_SCOPE_CHANGED|APPROVAL_|USER_CANCELLED|EXECUTION_UNCERTAIN/.test(result.error.code)) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (!result.ok && !['NONE', 'NEW_ARTIFACT'].includes(result.meta.sideEffect)) throw Object.assign(new Error(result.error.message + ' Hành động không được tự thử lại.'), { code: result.error.code });
    }
    persist([], 0, step + 1);
  }
  persist([], 0, maxSteps);
  throw Object.assign(new Error('Đã lưu tiến độ tác vụ dài. Bấm Tiếp tục để xử lý phần còn lại; các thao tác đã thành công sẽ không chạy lại.'), { code: 'AGENT_CONTINUATION_REQUIRED' });
}
module.exports = { runAgent };
