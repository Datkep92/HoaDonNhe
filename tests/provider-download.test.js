'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const download = require('../src/provider-download');
const fill = require('../src/data/portal-fill');

test('reference runner is identical to supplied 1.4.20 source', t => {
  const original = path.join(__dirname, '../1.4.20_0/providers/generic-runner.js');
  if (!fs.existsSync(original)) { t.skip('Nguồn extension 1.4.20 bên ngoài không có trong checkout; không thể kiểm chứng tính đồng nhất.'); return; }
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../src/provider-reference/generic-runner.js')),
    fs.readFileSync(original));
});
test('portal fill generated script parses without duplicated filled declaration', () => {
  new vm.Script(fill.FILL_SCRIPT(fill.planFor('fpt', { mst_ban: '123', lookup_code: 'REAL' })));
});
test('invoice mapping uses real fields and does not fabricate lookup codes', () => {
  const mapped = download.messageFor({ invoice_key: 'k', provider_id: 'vnpt', so_hd: '001', lookup_url: 'https://seller.vn;817503;', lookup_code: '' });
  assert.equal(mapped.lookupCode, '');
  assert.equal(mapped.lookupUrl, 'https://seller.vn');
  assert.equal(mapped.number, '001');
  assert.equal(mapped.invoiceKey, 'k');
});
test('verified original PDF stored in invoice direction, rejecting HTML and digest mismatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'original-pdf-test-'));
  try {
    const bytes = Buffer.from('%PDF-1.7\noriginal invoice\n%%EOF');
    const row = { mst_ban: '123', khms_hd: '1', khh_hd: 'C26', so_hd: '001', direction: 'BUY' };
    const result = { downloadDataUrl: `data:application/pdf;base64,${bytes.toString('base64')}`, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const relative = download.savePdf(dir, row, result);
    assert.ok(relative.startsWith(path.join('Mua_vao', 'pdf-goc')));
    assert.deepEqual(fs.readFileSync(path.join(dir, relative)), bytes);
    assert.throws(() => download.savePdf(dir, row, { ...result, sha256: 'bad' }), /khớp/);
    assert.throws(() => download.savePdf(dir, row, { ...result, downloadDataUrl: 'data:text/html;base64,SGk=' }), /PDF/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
