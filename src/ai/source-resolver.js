'use strict';
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const hasCode = (q, code) => code && new RegExp('(^|[^a-z0-9])' + String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])', 'i').test(q);
const namesOf = a => [a.label, a.company, ...(a.aliases || [])].filter(Boolean);
function catalog(context) {
  return (context.accounts || []).map(account => ({ ...account, sourceId: 'company-' + require('node:crypto').createHash('sha256').update(String(account.mst)).digest('hex').slice(0, 24) }));
}
function resolve(context, query) {
  const q = normalize(query);
  const sources = catalog(context);
  const exact = sources.filter(a => hasCode(q, a.mst) || namesOf(a).some(v => normalize(v) === q));
  const trimmed = q.replace(/\s+(?:thang|quy|nam)\s+\d.*$/, '').replace(/^(?:bao cao(?: so lieu)?(?: kinh doanh)?|doanh thu|du lieu kinh doanh)\s+/, '').replace(/\s+(?:la|ma)\s*$/, '').trim();
  const matches = exact.length ? exact : sources.filter(a => trimmed.length >= 3 && namesOf(a).some(v => normalize(v).includes(trimmed) || (normalize(v).length >= 3 && hasCode(q, normalize(v)))));
  return { sources: matches, ambiguous: matches.length > 1 };
}
function requestTarget(context, text) {
  const q = normalize(text);
  // Explicit company/code takes precedence over the currently selected UI account.
  const byCode = catalog(context).filter(a => hasCode(q, a.mst));
  if (byCode.length) return { sources: byCode, explicit: true };
  const named = q.match(/\bcua\s+(.+?)(?=[.,;!?]|$)/)?.[1]?.trim();
  if (named && !['toi', 'cong ty dang chon', 'doanh nghiep dang chon'].includes(named)) return { ...resolve(context, named), explicit: true, query: named };
  const reportName = q.match(/^(?:bao cao(?: so lieu)?(?: kinh doanh)?|doanh thu|du lieu kinh doanh)\s+(.+?)(?=\s+(?:thang|quy|nam)\b|[.,;!?]|$)/)?.[1];
  if (reportName && !/^(?:thang|quy|nam|cho toi|tong hop)\b/.test(reportName)) return { ...resolve(context, reportName), explicit: true, query: reportName };
  const names = catalog(context).filter(a => namesOf(a).some(v => normalize(v).length >= 3 && hasCode(q, normalize(v))));
  return { sources: names, explicit: names.length > 0 };
}
function clarification(target) {
  if (!target.sources.length) return 'Tôi chưa tìm thấy doanh nghiệp bạn nêu trong kho CNTaxTools. Bạn cho biết MST hoặc tên chính xác, hoặc đường dẫn/file kế toán local cần đọc nhé. Không cần đổi MST đang làm việc.';
  return 'Có nhiều nguồn phù hợp. Bạn muốn dùng nguồn nào?\n' + target.sources.map(a => '- ' + (a.company || a.label || a.mst) + ' (MST/mã: ' + a.mst + ')').join('\n');
}
function withAliases(app, dataDir, text, history = []) {
  const fs = require('node:fs'), path = require('node:path'), file = path.join(dataDir, 'agent', 'company-aliases.json');
  let aliases = {}; try { aliases = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  for (const message of [...history.filter(m => m.role === 'user').slice(-20).map(m => m.content), text]) {
  const statement = String(message || '').trim().match(/^(?:mst\s+)?(\d{10}(?:-?\d{3})?|\d{12})\s+(?:là|la)\s+(.+?)(?:\s+(?:mà|ma|nhé|nhe))?[.!?]*$/i);
  if (statement && app.context().accounts?.some(a => a.mst === statement[1])) {
    const label = statement[2].trim();
    if (label.length >= 3 && label.length <= 150) {
      aliases[statement[1]] = [...new Set([...(aliases[statement[1]] || []), label])].slice(-20);
      require('../core').atomicWrite(file, JSON.stringify(aliases));
    }
  }
  }
  return { ...app, context: () => { const c = app.context(); return { ...c, accounts: (c.accounts || []).map(a => ({ ...a, aliases: aliases[a.mst] || [] })) }; }, ...(app.forCompany ? { forCompany: mst => withAliases(app.forCompany(mst), dataDir) } : {}) };
}
module.exports = { normalize, catalog, resolve, requestTarget, clarification, withAliases };
