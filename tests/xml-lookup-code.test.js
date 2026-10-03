'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findLookupCode, recoverLookup } = require('../src/data/lookup-code');
const { parseInvoiceXml } = require('../src/data/xml-parser');
const { buildInvoiceKey } = require('../src/data/invoice-key');
const { openDatabase } = require('../src/data/sqlite');
const repository = require('../src/data/repository');
const scanner = require('../src/data/xml-scanner');
const xml = (extra = '', provider = '0101243150', id = 'MISA123456') => `<HDon><DLHDon Id="${id}"><TTChung><MSTTCGP>${provider}</MSTTCGP><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>1</SHDon><NLap>2026-10-01</NLap>${extra}</TTChung><NBan><MST>0900000001</MST></NBan><NMua><MST>0900000002</MST></NMua></DLHDon></HDon>`;
test('only MISA uses document IDs; BKAV requires the issued lookup code', () => {
  assert.equal(parseInvoiceXml(xml()).record.lookupCode, 'MISA123456');
  assert.equal(findLookupCode(xml(), 'bkav'), '');
  assert.equal(findLookupCode(xml('<MaTraCuu>Q1W4DYAM9</MaTraCuu>'), 'bkav'), 'Q1W4DYAM9');
  for (const provider of ['vnpt', 'fpt', 'viettel', '', 'unknown']) assert.equal(findLookupCode(xml(), provider), '');
  assert.equal(findLookupCode(xml('', '0101243150', 'bad id'), 'misa'), '');
});
test('explicit tags, Vietnamese labels, optional KDLieu and namespaces are recognized', () => {
  for (const key of ['MaTraCuu', 'Fkey', 'SearchKey', 'TransactionID', 'MTCuu', 'MaNhanHoaDon', 'SecretCode']) {
    assert.equal(findLookupCode(`<v:${key}>REAL_123</v:${key}>`), 'REAL_123');
  }
  assert.equal(findLookupCode('<x:TTin><x:DLieu><![CDATA[REAL-456]]></x:DLieu><x:TTruong>Mã tra cứu hóa đơn</x:TTruong></x:TTin>'), 'REAL-456');
  assert.equal(findLookupCode('<TTin><TTruong>Mã số bí mật</TTruong><DLieu>REAL987</DLieu></TTin>'), 'REAL987');
  assert.equal(findLookupCode('<InvoiceId>INTERNAL123</InvoiceId><RefID>PRIVATE123</RefID><SHDon>99999</SHDon><MCCQT>TAX123</MCCQT>'), '');
  assert.equal(findLookupCode('<DSCKS><Signature><TransactionID>SIGNATURE123</TransactionID></Signature></DSCKS>'), '');
});
test('URL query codes are read, host suffixes and payment links are not', () => {
  assert.equal(findLookupCode('<DLieu>https://portal.vn/?Code=REAL%2D123&amp;x=1</DLieu>'), 'REAL-123');
  assert.equal(findLookupCode('<DLieu>https://tenant.vnpt-invoice.com.vn;817501;</DLieu>'), '');
  assert.equal(findLookupCode('<DLieu>https://payoo.vn/?code=PAY123</DLieu>'), '');
});
test('known-provider old invoices are backfilled; manual codes and financial values stay intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xml-code-test-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    const file = path.join(dir, 'invoice.xml');
    fs.writeFileSync(file, xml());
    const parsed = parseInvoiceXml(xml()).record;
    repository.insertInvoice(db, { ...parsed, direction: 'BUY', fileXml: file });
    const key = buildInvoiceKey({ mstBan: parsed.mstBan, khmshDon: parsed.khmsHd, khhDon: parsed.khhHd, shDon: parsed.soHd });
    db.prepare('UPDATE invoices SET lookup_code = NULL, tong_tien = 12345 WHERE invoice_key = ?').run(key);
    const result = await scanner.backfillProviderLookup({ db, mstDir: dir });
    assert.equal(result.updated, 1);
    let row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
    assert.equal(row.lookup_code, 'MISA123456');
    assert.equal(row.tong_tien, 12345);
    db.prepare('UPDATE invoices SET lookup_code = ? WHERE invoice_key = ?').run('MANUAL123', key);
    assert.equal(recoverLookup(db, dir, db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key)).lookup_code, 'MANUAL123');
    db.prepare('UPDATE invoices SET lookup_code = NULL WHERE invoice_key = ?').run(key);
    row = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
    assert.equal(recoverLookup(db, dir, { ...row, invoice_key: 'other' }).lookup_code, null);
    assert.equal(recoverLookup(db, dir, row).lookup_code, 'MISA123456');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
