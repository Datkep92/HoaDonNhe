'use strict';
function validate(value, schema, field = 'arguments') {
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || 1000)) throw new Error(field + ' phải là danh sách hợp lệ.');
    for (const item of value) validate(item, schema.items, field + '[]');
  } else if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(field + ' phải là object.');
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error('Thiếu ' + key + '.');
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error('Tham số không được cấp: ' + key);
      validate(value[key], schema.properties[key], key);
    }
  } else {
    if (typeof value !== schema.type || (schema.type === 'number' && !Number.isFinite(value))) throw new Error(field + ' sai kiểu dữ liệu.');
    if (schema.type === 'string' && (value.length > (schema.maxLength || 500) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new Error(field + ' không hợp lệ.');
    if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$' && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(field + ' không phải ngày hợp lệ.');
    if (schema.type === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(field + ' ngoài giới hạn.');
    if (schema.enum && !schema.enum.includes(value)) throw new Error(field + ' không hợp lệ.');
  }
}
const PERMISSIONS = new Set(['READ', 'ANALYZE', 'WRITE_FILE', 'ACTION']);
function createToolRouter(registry, { signal, audit, status, authorize, sessionId, companyId, execution }) {
  if (typeof authorize !== 'function') throw new Error('Tool Router cần License/Security/Permission enforcement.');
  const failures = new Map(); let total = 0;
  return {
    schemas: registry.map(tool => ({ type: 'function', function: { name: tool.name.replace(/\./g, '__'), description: tool.description, parameters: tool.inputSchema } })),
    async execute(name, raw) {
      signal.throwIfAborted();
      const tool = registry.find(item => item.name === name || item.name.replace(/\./g, '__') === name);
      const started = Date.now(); let ok = false, errorCode, approval;
      try {
        if (!tool || !PERMISSIONS.has(tool.permission)) throw new Error('Tool không được cấp quyền.');
        if (++total > 256) throw new Error('Tác vụ vượt giới hạn số tool.');
        const args = typeof raw === 'string' ? JSON.parse(raw) : raw;
        validate(args, tool.inputSchema);
        const durableKey = execution?.store.toolKey(tool.name, args);
        const prior = durableKey && execution.store.tool(execution.record, durableKey);
        if (prior?.state === 'completed') return prior.result;
        if (prior?.state === 'unknown') throw Object.assign(Error('Thao tác có thể đã chạy trước khi ứng dụng ngắt. Kiểm tra kết quả trước khi gửi yêu cầu mới; không tự thực thi lại.'), { code: 'EXECUTION_UNCERTAIN' });
        approval = await authorize(tool, args, { sessionId, companyId });
        if (tool.permission === 'ACTION' && typeof tool.verify !== 'function') throw Object.assign(new Error('Hành động chưa có bộ kiểm tra kết quả tin cậy.'), { code: 'VERIFIER_MISSING' });
        const key = tool.name + JSON.stringify(args);
        if ((failures.get(key) || 0) >= 3) throw new Error('Tool đã lỗi quá số lần thử lại.');
        status(tool.status || 'Đang xử lý yêu cầu…');
        try {
          if (execution && tool.sideEffect !== 'NONE') execution.store.startTool(execution.record, durableKey);
          const toolSignal = AbortSignal.any([signal, AbortSignal.timeout(tool.timeout || 15000)]);
          const data = await tool.handler(args, toolSignal);
          if (tool.verify && !await tool.verify(data, args, { sessionId, companyId })) throw Object.assign(new Error('Không xác minh được kết quả hành động; kiểm tra trạng thái ứng dụng, không tự thử lại.'), { code: 'VERIFICATION_FAILED' });
          toolSignal.throwIfAborted();
          signal.throwIfAborted(); ok = true;
          const result = { ok: true, data, error: null, meta: { tool: tool.name, verified: true, duration: Date.now() - started, durationMs: Date.now() - started, rows: data?.rows, artifactIds: data?.fileId ? [data.fileId] : [], companyId } };
          if (execution && tool.sideEffect !== 'NONE') execution.store.completeTool(execution.record, durableKey, result);
          return result;
        } catch (error) { failures.set(key, (failures.get(key) || 0) + 1); throw error; }
      } catch (error) {
        signal.throwIfAborted(); errorCode = error.code || 'TOOL_ERROR';
        return { ok: false, data: null, error: { code: errorCode, message: String(error.message).slice(0, 500), retryable: tool?.permission !== 'ACTION' && !/DENIED|PERMISSION_REQUIRED/.test(errorCode) }, meta: { verified: false, companyId, sideEffect: tool?.sideEffect || 'NONE', durationMs: Date.now() - started } };
      } finally { audit({ tool: tool?.name || 'unknown', permission: tool?.permission, capability: tool?.requiredPermissions?.[0], version: tool?.version, companyId, approvalId: approval?.approvalId, actionHash: approval?.actionHash, ok, errorCode, duration: Date.now() - started }); }
    },
  };
}
module.exports = { createToolRouter, validate };
