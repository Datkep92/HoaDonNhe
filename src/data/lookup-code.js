'use strict';
const CODE_KEYS = new Set(['matracuu', 'matracuuhoadon', 'matcuu', 'mtracuu', 'matc', 'mtcuu', 'mtchdon',
  'fkey', 'searchkey', 'searchinvoice', 'transactionid', 'lookupcode', 'secretcode', 'secureid',
  'referencecode', 'invoicecode', 'mnhdon', 'manhanhoadon', 'mhso', 'masohdon', 'masohd',
  'idtracuu', 'masobimat', 'mabimat', 'mabaomat', 'sobaomat', 'reservationcode', 'privatecode']);
const normal = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/gi, 'd').replace(/[^a-z0-9]/gi, '').toLowerCase();
const decode = value => String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&amp;/g, '&').trim();
const valid = value => /^[A-Z0-9_./-]{4,128}$/i.test(value);
function field(block, names) {
  return decode(block.match(new RegExp(`<(?:[\\w.-]+:)?(?:${names})\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?(?:${names})\\s*>`, 'i'))?.[1]);
}
function findLookupCode(xml, providerId = '') {
  const source = String(xml || '').replace(/<(?:[\w.-]+:)?(?:DSCKS|Signature)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?(?:DSCKS|Signature)\s*>/gi, '');
  for (const match of source.matchAll(/<(?:[\w.-]+:)?(?:TTin|Field)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:TTin|Field)\s*>/gi)) {
    const key = normal(field(match[1], 'TTruong|FieldName|Name|Key'));
    const value = field(match[1], 'DLieu|Value|GiaTri|Data');
    if (CODE_KEYS.has(key) && valid(value)) return value;
  }
  for (const match of source.matchAll(/<(?:[\w.-]+:)?([\w.-]+)\b[^>]*>\s*([^<>]+)\s*<\/(?:[\w.-]+:)?\1\s*>/g)) {
    const value = decode(match[2]);
    if (CODE_KEYS.has(normal(match[1])) && valid(value)) return value;
  }
  for (const match of decode(source).matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0]);
      if (/(^|\.)(payoo\.vn|w3\.org|hoadondientu\.gdt\.gov\.vn)$/i.test(url.hostname)) continue;
      for (const [key, value] of url.searchParams) {
        if ((CODE_KEYS.has(normal(key)) || normal(key) === 'code') && valid(value)) return value;
      }
    } catch { /* not a URL */ }
  }
  // MISA supports this identifier; BKAV's SMS/email code is not the XML document ID.
  if (providerId === 'misa') {
    const id = decode(source.match(/<(?:[\w.-]+:)?DLHDon\b[^>]*\bId\s*=\s*["']([^"']{6,128})["']/i)?.[1]);
    if (providerId === 'misa' ? /^[A-Z0-9_-]{6,64}$/i.test(id) : valid(id)) return id;
  }
  return '';
}
function recoverLookup(db, mstDir, row) {
  row = require('./provider-registry').resolveInvoice(row);
  if (!row.file_xml || (row.lookup_code && row.lookup_url)) return row;
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(mstDir), file = path.resolve(root, row.file_xml);
  if (!file.startsWith(root + path.sep)) return row;
  let parsed, source;
  try {
    if (fs.statSync(file).size > 20 * 1024 * 1024) return row;
    source = fs.readFileSync(file, 'utf8');
    parsed = require('./xml-parser').parseInvoiceXml(source).record;
    const key = require('./invoice-key').buildInvoiceKey({ mstBan: parsed.mstBan, khmshDon: parsed.khmsHd, khhDon: parsed.khhHd, shDon: parsed.soHd });
    if (key !== row.invoice_key) return row;
  } catch { return row; }
  const code = row.lookup_code || parsed.lookupCode || findLookupCode(source, row.provider_id || parsed.providerId || '');
  const url = row.lookup_url || parsed.lookupUrl;
  db.prepare(`UPDATE invoices SET lookup_code = COALESCE(NULLIF(lookup_code, ''), ?),
    lookup_url = COALESCE(NULLIF(lookup_url, ''), ?) WHERE invoice_key = ?`).run(code || null, url || null, row.invoice_key);
  return { ...row, lookup_code: code || null, lookup_url: url || null };
}
module.exports = { findLookupCode, recoverLookup };
