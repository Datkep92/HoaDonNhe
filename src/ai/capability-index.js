'use strict';
// ---------------------------------------------------------------------------
// CAPABILITY INDEX + RESOLVER (DISCOVER / RANK / SUGGEST — KHÔNG EXECUTE).
//
// Index là VIEW CHỈ ĐỌC dẫn xuất 100% từ registry THẬT do createRegistry() tạo
// (mỗi tool đã đi qua access-policy.manifest()). Vì vậy entitlement/permission/
// riskClass/sideEffect luôn khớp Tool Registry — không có nguồn sự thật thứ hai.
//
// TUYỆT ĐỐI KHÔNG chứa: handler, connection, path nội bộ, license object,
// credential, token, secret, raw service object. `derive()` dùng WHITELIST khoá
// (không spread `tool`) nên handler không thể lọt ra.
//
// Module này KHÔNG execute, KHÔNG authorize, KHÔNG cache license. Mọi quyết định
// thi hành vẫn thuộc `router.execute()` → License → Security/Permission → handler.
// ---------------------------------------------------------------------------
const { normalize } = require('./context-manager');
const { FLAGS } = require('./access-policy');

const MAX_ALTERNATIVES = 3;
const HINT_LIMIT = 480;
const TASK_VERB = /\b(doc|liet ke|xem|tim|tinh|tong hop|xuat|tao|chuyen|doi chieu|kiem tra|phan tich|loc|sap xep|so sanh|thong ke|viet|xu ly|ap dung|tinh toan|chuyen doi|bien doi|read|list|export|convert|analyze|summarize|find|process|transform)\b/;

// Catalog production capabilities CHƯA có AI wrapper hợp lệ.
// CHỈ METADATA (tên + mô tả + nguồn). KHÔNG hàm, KHÔNG handler, KHÔNG route chạy được.
const NOT_EXPOSED_CATALOG = Object.freeze([
  { name: 'python.execute', source: 'src/ai/tool-registry.js', note: 'Code có nhưng bị chặn bởi FLAGS.generated_python_enabled = false.', flag: 'generated_python_enabled' },
  { name: 'cloud.shell', source: 'src/ai/tool-registry.js', note: 'Code có nhưng bị chặn bởi FLAGS.command_execution_enabled = false.', flag: 'command_execution_enabled' },
  { name: 'queries.overview', source: 'src/data/queries.js', route: '/api/db/overview', note: 'Tổng quan kho dữ liệu.' },
  { name: 'queries.debts', source: 'src/data/queries.js', route: '/api/db/debts', note: 'Công nợ.' },
  { name: 'queries.debtsDetail', source: 'src/data/queries.js', route: '/api/db/debts/detail', note: 'Chi tiết công nợ.' },
  { name: 'queries.goodsDetail', source: 'src/data/queries.js', route: '/api/db/goods/detail', note: 'Chi tiết hàng hóa.' },
  { name: 'queries.taxOverview', source: 'src/data/queries.js', route: '/api/db/tax', note: 'Tổng quan thuế.' },
  { name: 'queries.partners', source: 'src/data/queries.js', route: '/api/db/partners', note: 'Đối tác.' },
  { name: 'queries.partnerInvoices', source: 'src/data/queries.js', route: '/api/db/partners/invoices', note: 'Hóa đơn theo đối tác.' },
  { name: 'vatSummary.quarterSummary', source: 'src/data/vat-summary.js', route: '/api/db/vat/quarter', note: 'Tổng hợp GTGT theo quý.' },
  { name: 'bankStatement.previewRows', source: 'src/data/bank-statement.js', route: '/api/db/bank/preview', note: 'Chuẩn hoá sao kê ngân hàng.' },
  { name: 'bankStatement.listTransactions', source: 'src/data/bank-statement.js', route: '/api/db/bank/transactions', note: 'Giao dịch sao kê.' },
  { name: 'bankStatement.summary', source: 'src/data/bank-statement.js', route: '/api/db/bank/summary', note: 'Tổng hợp sao kê.' },
  { name: 'reconciliation.run', source: 'src/data/reconciliation.js', route: '/api/db/reconciliation/run', note: 'Đối chiếu sao kê với hóa đơn.' },
  { name: 'misaExport.build', source: 'src/data/misa-export.js', route: '/api/db/misa/export', note: 'Xuất MISA AMIS.' },
  { name: 'productMaster.lookupByName', source: 'src/data/product-master.js', note: 'Tra cứu danh mục hàng hoá.' },
  { name: 'excelExport.buildWorkbook', source: 'src/data/excel-export.js', route: '/api/db/export', note: 'Mẫu Excel production (header/width/sheet) — AI đang dùng writer đơn giản riêng.' },
  { name: 'taxRules.rulesFor', source: 'src/data/tax-rules.js', note: 'Quy tắc thuế theo năm/loại hình.' },
  { name: 'providerRegistry.resolve', source: 'src/data/provider-registry.js', route: '/api/db/provider/lookup', note: 'Phân giải nhà cung cấp phát hành.' },
  { name: 'originalPdf.attach', source: 'src/data/original-pdf.js', route: '/api/db/invoice-original/attach', note: 'Gắn PDF gốc.' },
  { name: 'invoiceA4.buildInvoiceA4', source: 'src/data/invoice-a4.js', route: '/api/db/invoice/html', note: 'Bản xem/in PDF A4.' },
  { name: 'identityCandidates.listCandidates', source: 'src/data/identity-candidates.js', route: '/api/db/identity-candidates', note: 'Ứng viên nhận dạng.' },
]);

// Chuỗi composition GỢI Ý (không tự chạy). Mỗi bước phải tồn tại trong index,
// nếu không sẽ bị loại và ghi vào `dropped`.
const CHAINS = Object.freeze({
  db: ['db.detect', 'db.list_tables', 'db.schema', 'db.query_readonly', 'data.create', 'file.export_excel'],
  invoice: ['invoice.search', 'data.analyze', 'file.export_excel'],
  attachment: ['file.read_attachment', 'data.analyze', 'file.export_excel'],
  filesystem: ['fs.list', 'fs.read', 'data.create', 'file.export_excel'],
});

// ── derive một capability entry từ tool ĐÃ MANIFEST (whitelist khoá) ────────
function derive(tool) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const name = String(tool.name || '');
  return Object.freeze({
    name,
    modelName: name.replace(/\./g, '__'),
    namespace: name.split('.')[0],
    description: String(tool.description || ''),
    exposed: true,
    status: 'AVAILABLE_EXPOSED',
    requiredEntitlement: tool.requiredEntitlement,
    requiredPermissions: Object.freeze([...(tool.requiredPermissions || [])]),
    riskClass: tool.riskClass,
    sideEffect: tool.sideEffect,
    timeout: tool.timeout ?? tool.timeoutMs ?? 15000,
    readOnly: tool.riskClass === 'READ_ONLY',
    writesFile: tool.permission === 'WRITE_FILE',
    isAction: tool.permission === 'ACTION',
    parameters: Object.freeze(Object.keys(properties)),
    requiredParameters: Object.freeze([...required]),
    consumesDataset: Object.prototype.hasOwnProperty.call(properties, 'datasetId') || Object.prototype.hasOwnProperty.call(properties, 'leftDatasetId'),
    requiresAttachment: required.includes('id') || required.includes('attachmentId'),
    requiresPath: required.includes('path'),
    requiresSql: required.includes('sql'),
  });
}

// ── signals ────────────────────────────────────────────────────────────────
function signalsOf(input) {
  const raw = String(input?.text || '');
  const text = normalize(raw);
  const list = Array.isArray(input?.attachments) ? input.attachments : [];
  const fileText = list.map(item => String(item?.filename || '') + ' ' + String(item?.ext || '')).join(' ');
  const hasAttachment = list.length > 0;
  const pdfAttachment = /pdf/i.test(fileText);
  const sheetAttachment = list.some(item => item?.sheets) || /\.(xlsx|xls|csv|json)\b/i.test(fileText);
  const dbPath = /\.(db|sqlite|sqlite3)\b/i.test(raw) || /\.(db|sqlite|sqlite3)\b/i.test(text);
  const codePath = /[a-z]:[\\/][^\s"'<>|]+\.(js|ts|mjs|cjs|json|md|txt|csv|xml|log|css|html|sql|py|bat|ps1|yml|yaml|ini|cfg|env)\b/i.test(raw);
  const anyPath = /[a-z]:[\\/]/i.test(raw);
  const exportIntent = /\b(excel|xlsx|bang tinh|csv|xuat|export|ra file|tao file|ket xuat)\b/.test(text);
  const convertIntent = /\b(chuyen|convert|doi|sang|thanh)\b/.test(text);
  const thisFileIntent = /\b(file nay|file dinh kem|tep nay|tai lieu nay|pdf nay|file toi dinh kem|cai nay|no)\b/.test(text);
  const context = input?.context || {};
  return {
    raw, text, list, hasAttachment, pdfAttachment, sheetAttachment,
    dbPath, codePath, anyPath, exportIntent, convertIntent, thisFileIntent,
    hasMst: !!context.hasMst,
    // "task-like" = có động từ tác vụ hoặc đường dẫn cụ thể. KHÔNG tính việc chỉ
    // đính kèm file, nếu không mọi lời chào kèm file đều bị gợi ý tool.
    taskLike: TASK_VERB.test(text) || anyPath,
  };
}

// ── rule table (deterministic, thứ tự = độ ưu tiên) ────────────────────────
const RULES = Object.freeze([
  { id: 'pdf-to-excel', when: s => s.pdfAttachment && s.exportIntent, tools: ['file.pdf_to_excel'], confidence: 0.97,
    reason: 'User requests conversion of attached PDF to Excel' },
  { id: 'pdf-convert', when: s => s.pdfAttachment && (s.convertIntent || s.thisFileIntent), tools: ['file.pdf_to_excel'], confidence: 0.93,
    reason: 'Attached PDF with a conversion request' },
  { id: 'db-to-excel', when: s => s.dbPath && s.exportIntent, chain: 'db', primary: 'db.detect', confidence: 0.96,
    reason: 'Database file with an export request' },
  { id: 'db-analyze', when: s => s.dbPath || /\b(sqlite|database|co so du lieu)\b/.test(s.text), tools: ['db.detect', 'db.list_tables', 'db.schema', 'db.query_readonly', 'db.sample'], confidence: 0.92,
    reason: 'Local database mentioned or supplied as a path' },
  { id: 'fs-read', when: s => s.codePath, tools: ['fs.read', 'fs.read_range', 'fs.exists', 'fs.stat'], confidence: 0.91,
    reason: 'Explicit local file path to read' },
  { id: 'fs-list', when: s => /\b(liet ke|danh sach|xem thu muc|noi dung thu muc|list file|list dir)\b/.test(s.text) || (s.anyPath && /\b(thu muc|folder|directory)\b/.test(s.text)), tools: ['fs.list', 'fs.stat', 'fs.exists'], confidence: 0.88,
    reason: 'Directory listing request' },
  { id: 'fs-any-path', when: s => s.anyPath, tools: ['fs.stat', 'fs.exists', 'fs.list', 'fs.read'], confidence: 0.8,
    reason: 'Explicit local path' },
  { id: 'attachment-to-excel', when: s => s.sheetAttachment && s.exportIntent, chain: 'attachment', primary: 'file.read_attachment', confidence: 0.9,
    reason: 'Attached table with an export request' },
  { id: 'attachment-analysis', when: s => s.hasAttachment && s.taskLike, tools: ['file.read_attachment'], confidence: 0.72,
    reason: 'Attachment present; read it before analysing' },
  { id: 'invoice-latest', when: s => /\b(hoa don)\b/.test(s.text) && /\b(gan nhat|moi nhat|latest)\b/.test(s.text), tools: ['invoice.latest', 'invoice.search'], confidence: 0.9,
    reason: 'Most recent invoice request' },
  { id: 'goods-summary', when: s => /\b(hang hoa|mat hang|san pham)\b/.test(s.text), tools: ['goods.query', 'invoice.search'], confidence: 0.84,
    reason: 'Goods/product aggregation request' },
  { id: 'invoice-search', when: s => /\b(hoa don|invoice)\b/.test(s.text), tools: ['invoice.search', 'data.query', 'invoice.summary'], confidence: 0.8,
    reason: 'Invoice data request' },
  { id: 'web-lookup', when: s => /\b(tra cuu|quy dinh|thong tu|nghi dinh|phap luat|luat thue|hieu luc)\b/.test(s.text), tools: ['web.search'], confidence: 0.75,
    reason: 'Legal/tax regulation lookup' },
  { id: 'app-state', when: s => /\b(trang thai|mst dang chon|tien do tai|dang tai)\b/.test(s.text), tools: ['app.get_state', 'mst.get_selected', 'invoice.download_status'], confidence: 0.7,
    reason: 'Application state request' },
]);

function createCapabilityIndex(registry, options = {}) {
  if (!Array.isArray(registry)) throw new Error('Capability Index cần registry THẬT từ createRegistry().');
  const entries = registry.map(derive);
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  // Catalog chỉ giữ mục CHƯA được expose — tránh biểu diễn trùng hai nguồn.
  const notExposed = NOT_EXPOSED_CATALOG.filter(item => !byName.has(item.name)).map(item => Object.freeze({
    ...item,
    exposed: false,
    status: 'AVAILABLE_NOT_EXPOSED',
    blockedByFlag: !!item.flag && FLAGS[item.flag] === false,
  }));

  const isExposed = name => byName.has(name);
  const keepExposed = names => names.filter(isExposed);
  const summaryOf = name => {
    const entry = byName.get(name);
    if (!entry) return null;
    return { name: entry.name, modelName: entry.modelName, description: entry.description };
  };

  function resolve(input = {}) {
    const s = signalsOf(input);
    const matches = [];
    for (const rule of RULES) {
      let tools = [];
      try { if (!rule.when(s)) continue; } catch { continue; }
      if (rule.chain) tools = keepExposed(CHAINS[rule.chain] || []);
      else tools = keepExposed(rule.tools || []);
      if (!tools.length) continue;
      matches.push({ rule, tools });
    }
    if (!matches.length) {
      return Object.freeze({
        status: 'CAPABILITY_GAP', primary: null, confidence: 0, reason: 'NO_MATCH',
        alternatives: Object.freeze([]), suggestedTools: Object.freeze([]),
        available: Object.freeze(entries.slice(0, 4).map(entry => entry.name)),
        missing: Object.freeze([gapSlot(s)]), taskLike: s.taskLike,
      });
    }
    const first = matches[0];
    const primaryName = first.rule.primary || first.tools[0];
    const alternatives = [];
    for (const match of matches.slice(1)) {
      const name = match.rule.primary || match.tools[0];
      if (name === primaryName || alternatives.some(item => item.name === name)) continue;
      alternatives.push({ name, confidence: match.rule.confidence, reason: match.rule.reason });
    }
    alternatives.sort((a, b) => b.confidence - a.confidence);
    const bounded = alternatives.slice(0, MAX_ALTERNATIVES).map(item => Object.freeze(item));
    if (first.rule.chain) {
      const dropped = (CHAINS[first.rule.chain] || []).filter(name => !isExposed(name));
      return Object.freeze({
        status: 'COMPOSITION', goal: first.rule.reason, primary: first.rule.primary || first.tools[0],
        confidence: first.rule.confidence, reason: first.rule.reason,
        suggestedTools: Object.freeze([...first.tools]), dropped: Object.freeze(dropped),
        alternatives: Object.freeze(bounded), available: Object.freeze([]), missing: Object.freeze([]),
        taskLike: s.taskLike, candidates: Object.freeze(first.tools.map(summaryOf).filter(Boolean)),
      });
    }
    const primary = first.rule.primary || first.tools[0];
    return Object.freeze({
      status: 'MATCH', primary, confidence: first.rule.confidence, reason: first.rule.reason,
      suggestedTools: Object.freeze([...first.tools]), dropped: Object.freeze([]),
      alternatives: Object.freeze(bounded), available: Object.freeze([]), missing: Object.freeze([]),
      taskLike: s.taskLike,
      primarySummary: summaryOf(primary),
      candidates: Object.freeze(first.tools.map(summaryOf).filter(Boolean)),
    });
  }

  function gapSlot(s) {
    if (s.pdfAttachment) return 'pdf_processing';
    if (s.dbPath) return 'database_processing';
    if (s.hasAttachment) return 'attachment_processing';
    if (s.anyPath) return 'filesystem_processing';
    return 'custom_processing_logic';
  }

  // Hint NGẮN, có trần ký tự. KHÔNG cấp quyền, KHÔNG thay thế License/Security.
  function hint(result) {
    if (!result || !result.status) return null;
    let text = null;
    if (result.status === 'MATCH' && result.primary && result.confidence >= 0.6) {
      const entry = byName.get(result.primary);
      // Không bao giờ quảng cáo capability không tồn tại trong index hiện tại.
      if (!entry) return null;
      const short = entry.description.split(/[.;—]/)[0].trim().slice(0, 110);
      text = 'Relevant capability: ' + result.primary + (short ? ' — ' + short : '');
    } else if (result.status === 'COMPOSITION' && result.suggestedTools?.length) {
      text = 'Suggested tools: ' + result.suggestedTools.join(' → ') + '.';
    } else if (result.status === 'CAPABILITY_GAP' && result.taskLike) {
      text = 'Chưa có capability chuyên biệt cho yêu cầu này; chỉ dùng tool đã công bố, không bịa tool mới.';
    }
    if (!text) return null;
    return text.length > HINT_LIMIT ? text.slice(0, HINT_LIMIT - 1) + '…' : text;
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    notExposed: Object.freeze(notExposed),
    isExposed,
    resolve,
    hint,
    stats: () => Object.freeze({
      exposed: entries.length,
      notExposed: notExposed.length,
      namespaces: Object.freeze([...new Set(entries.map(entry => entry.namespace))].sort()),
    }),
  });
}

module.exports = { createCapabilityIndex, MAX_ALTERNATIVES, HINT_LIMIT, NOT_EXPOSED_CATALOG, CHAINS };
