'use strict';
const FLAGS = Object.freeze({ ai_agent_enabled: true, generated_js_enabled: true, generated_python_enabled: false, command_execution_enabled: false, desktop_control_enabled: false, external_send_enabled: false, db_write_enabled: false, db_discovery_enabled: false });
function manifest(tool) {
  const requiredEntitlement = tool.name.startsWith('file.export') || tool.name === 'file.write_report' || tool.name === 'file.pdf_to_excel' ? 'AI_FILE_EXPORT' : /^(invoice|goods|data|db)\./.test(tool.name) ? 'AI_DB_READ' : 'AI_CHAT';
  const requiredPermissions = tool.permission === 'WRITE_FILE' ? ['FILE_CREATE'] : tool.permission === 'ACTION' ? ['APP_CONTROL'] : tool.name.startsWith('js.') ? ['CODE_EXECUTE_SAFE'] : tool.name.startsWith('web.') ? ['WEB_SEARCH'] : tool.name.startsWith('file.') || tool.name.startsWith('fs.') ? ['FILE_READ'] : tool.name.startsWith('db.') ? ['DB_READ'] : tool.name.startsWith('app.') || tool.name.startsWith('mst.') ? ['APP_READ'] : tool.permission === 'ANALYZE' ? ['DATA_ANALYZE'] : ['DATA_READ'];
  return { ...tool, version: 1, requiredEntitlement, requiredPermissions, riskClass: tool.permission === 'WRITE_FILE' ? 'CREATE_NEW' : tool.permission === 'ACTION' ? 'MODIFY_ORIGINAL' : 'READ_ONLY', sideEffect: tool.permission === 'WRITE_FILE' ? 'NEW_ARTIFACT' : tool.permission === 'ACTION' ? 'APPLICATION_STATE' : 'NONE', supportsDryRun: false, supportsCancel: true, timeoutMs: tool.timeout || 15000, outputSchema: { type: 'object' } };
}
function createAccessPolicy({ checkLicense, requestApproval, permissions }) {
  if (typeof checkLicense !== 'function') throw new Error('Thiếu authoritative License Gate cho AI.');
  async function license(capability = 'AI_CHAT') {
    const value = await checkLicense();
    // Existing service owns trial/offline grace; AI introduces neither cache nor grace.
    if (!value || !['active', 'trial', 'valid'].includes(String(value.status || value.state || '').toLowerCase())) throw Object.assign(new Error('Bản quyền không cho phép chạy AI.'), { code: 'LICENSE_DENIED' });
    if (Array.isArray(value?.entitlements) && !value.entitlements.includes(capability)) throw Object.assign(new Error('License không có quyền ' + capability + '.'), { code: 'ENTITLEMENT_DENIED' });
    return value;
  }
  return { flags: FLAGS, license,
    async authorize(tool, args, context) {
      await license(tool.requiredEntitlement);
      if (tool.name.startsWith('js.') && !FLAGS.generated_js_enabled || tool.name.startsWith('python.') || tool.name === 'cloud.shell') throw Object.assign(new Error('Capability chưa được bật theo policy local-first.'), { code: 'SECURITY_POLICY_DENIED' });
      const disabled = { DB_WRITE: !FLAGS.db_write_enabled, DB_DISCOVER: !FLAGS.db_discovery_enabled, COMMAND_EXECUTE: !FLAGS.command_execution_enabled, EXTERNAL_SEND: !FLAGS.external_send_enabled, EXTERNAL_UPLOAD: !FLAGS.external_send_enabled, DESKTOP_CONTROL: !FLAGS.desktop_control_enabled, SECRET_READ: true, SYSTEM_CHANGE: true, ADMIN_ELEVATION: true };
      if (!FLAGS.ai_agent_enabled || tool.requiredPermissions.some(permission => disabled[permission])) throw Object.assign(new Error('Capability chưa được phép theo security policy.'), { code: 'SECURITY_POLICY_DENIED' });
      if (!['READ_ONLY', 'CREATE_NEW'].includes(tool.riskClass) || context.forceOnce && tool.sideEffect !== 'NONE') {
        if (!requestApproval || !permissions) throw Object.assign(new Error('Hành động cần phê duyệt trước khi thực thi.'), { code: 'PERMISSION_REQUIRED' });
        const evidence = await requestApproval(tool, args, context);
        await license(tool.requiredEntitlement);
        return permissions.consume(evidence, tool, args, { ...context, ...context.revalidate?.() });
      }
    },
  };
}
module.exports = { manifest, createAccessPolicy, FLAGS };
