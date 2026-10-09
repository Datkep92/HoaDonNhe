'use strict';
// A deliberately small, strict reader. No DTD, network entities or inferred amounts.
const period = require('../period');
function entities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, key) => {
    if (key[0] === '#') return String.fromCodePoint(key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1)));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[key];
  });
}
function readXml(xml) {
  const text = String(xml).replace(/^\uFEFF/, '');
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('XML vượt giới hạn 8 MB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML có DTD/entity không được hỗ trợ.');
  const root = { name: '#', children: [], text: '' };
  const stack = [root];
  const tokens = text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g) || [];
  if (tokens.join('') !== text) throw new Error('XML không hợp lệ.');
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('<![CDATA[')) { stack.at(-1).text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (stack.length < 2 || stack.at(-1).qualified !== name) throw new Error('XML có thẻ đóng không khớp.');
      stack.pop();
    } else if (token.startsWith('<')) {
      const match = token.match(/^<([\w:.-]+)(?:\s[^<>]*)?\/?\s*>$/);
      if (!match) throw new Error('XML có thẻ không hợp lệ.');
      const node = { qualified: match[1], name: match[1].split(':').at(-1), children: [], text: '' };
      stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
      if (stack.length > 128) throw new Error('XML lồng quá nhiều cấp.');
    } else {
      if (stack.length === 1 && token.trim()) throw new Error('XML có văn bản ngoài thẻ gốc.');
      if (/&(?!(?:#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);)/i.test(token)) throw new Error('XML có entity không hợp lệ.');
      stack.at(-1).text += entities(token);
    }
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error('XML chưa đóng đủ thẻ hoặc có nhiều gốc.');
  return root.children[0];
}
const nodes = (root, name) => [root, ...root.children.flatMap(child => nodes(child, '*'))].filter(node => name === '*' || node.name === name);
function one(root, name, required = true) {
  const found = nodes(root, name);
  if (found.length > 1 || (required && found.length !== 1)) throw new Error(`XML thiếu hoặc trùng thẻ ${name}.`);
  return found[0] || null;
}
function field(root, name, required = true) { return one(root, name, required)?.text.trim() || ''; }
function declarationRange(kind, value) {
  if (kind === 'Y' && /^\d{4}$/.test(value)) return period.rangeFor('year', Number(value));
  const match = /^(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match || !['M', 'Q'].includes(kind)) throw new Error('Chỉ đối chiếu tờ khai theo tháng/quý có kỳ rõ ràng.');
  return period.rangeFor(kind === 'Q' ? 'quarter' : 'month', Number(match[2]), Number(match[1]));
}
function parseDeclaration(xml) {
  const root = readXml(xml);
  const forms = nodes(root, 'HSoKhaiThue');
  if (!forms.length) return null; // Notification/attachment, not a declaration.
  if (forms.length !== 1) throw new Error('XML có nhiều hồ sơ khai thuế.');
  const form = forms[0];
  const common = one(form, 'TTinChung');
  const tax = one(common, 'TKhaiThue');
  const taxpayer = one(common, 'NNT');
  const declaration = {
    mst: field(taxpayer, 'mst'), name: field(tax, 'tenTKhai'), code: field(tax, 'maTKhai', false),
    version: field(tax, 'pbanTKhaiXML', false), type: field(tax, 'loaiTKhai'), amendment: field(tax, 'soLan'),
    periodKind: field(tax, 'kieuKy'), period: field(tax, 'kyKKhai'), date: field(tax, 'ngayLapTKhai', false),
    supported: false, figures: {},
  };
  if (!/^\d+$/.test(declaration.amendment) || !['C', 'B'].includes(declaration.type)) throw new Error('Loại/lần bổ sung tờ khai không rõ.');
  declaration.range = declarationRange(declaration.periodKind, declaration.period);
  if (!/\b01\s*\/\s*GTGT\b/i.test(declaration.name)) return declaration;
  if (!['M', 'Q'].includes(declaration.periodKind)) { declaration.reason = 'Chỉ đối chiếu 01/GTGT theo tháng/quý.'; return declaration; }
  const body = one(form, 'CTieuTKhaiChinh', false);
  if (!body) { declaration.reason = 'Thiếu CTieuTKhaiChinh; không cộng tờ khai bổ sung với tờ khai chính thức.'; return declaration; }
  for (const code of ['ct23', 'ct24', 'ct34', 'ct35']) {
    const value = field(body, code, false);
    declaration.figures[code] = /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  declaration.supported = Object.values(declaration.figures).every(value => value !== null);
  if (!declaration.supported) declaration.reason = 'Thiếu chỉ tiêu 23/24/34/35 hoặc giá trị không phải số; không tự điền 0.';
  return declaration;
}
module.exports = { readXml, parseDeclaration, declarationRange };
