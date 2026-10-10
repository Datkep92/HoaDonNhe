'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const XLSX = require('../resources/xlsx.cjs');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');

test('real server/EXE exports all invoice states with filters and serves combined-direction UI', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-export-server-'));
  const runtime = path.join(root, 'runtime'), output = path.join(root, 'output'), mst = '0312345678';
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const mstDir = path.join(output, `MST-${mst}`); fs.mkdirSync(mstDir);
  const db = openDatabase(path.join(mstDir, 'data.db'));
  for (let i = 0; i < 210; i++) insertInvoice(db, { direction: 'BUY', mstBan: '0100000001', mstMua: mst, tenBan: 'Nhà cung cấp mẫu', tenMua: 'Khách mẫu',
    khmsHd: '1', khhHd: 'C26TAA', soHd: String(i + 1).padStart(8, '0'), ngayLap: '2026-09-01', tthai: String(i % 6 + 1),
    tienTruocThue: 100, tienThue: 10, tongTien: 110, fileXml: path.join(mstDir, `${i}.xml`), items: [] });
  closeDatabase(db);
  fs.writeFileSync(path.join(runtime, 'accounts.json'), JSON.stringify({ selected: mst, output, accounts: [{ mst, name: 'Kiểm thử' }] }));
  const exe = process.env.INVOICE_TEST_EXE;
  const child = spawn(exe || process.execPath, exe ? ['--test-server'] : ['src/server.js', '--test-server'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOADON_TEST_DATA: runtime, HOADON_NO_UPDATE_CHECK: '1' },
  });
  let text = '';
  child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
  t.after(async () => {
    if (child.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill(); await done; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let match;
  for (let i = 0; i < 600; i++) {
    match = text.match(/\{"testUrl":"([^"]+)"/); if (match || child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(match, 'isolated application starts: '+text.slice(-800));
  const base = new URL(match[1]);
  const request = route => new Promise((resolve, reject) => {
    const req = http.get(new URL(route, base), { headers: { Cookie: 'hd_session=' + base.searchParams.get('launch') } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(Error('request timeout')));
  });
  const page = await request('/'); assert.equal(page.status, 200);
  const select = page.body.toString().match(/<select id="direction">([\s\S]*?)<\/select>/);
  assert.match(select[1], /value="both">Mua vào \+ Bán ra/);
  const all = await request('/api/db/export?parts=buy,sell&from=2026-09-01&to=2026-09-30');
  assert.equal(all.status, 200);
  const book = XLSX.read(all.body, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['Hóa đơn mua vào', 'Hóa đơn bán ra']);
  const rows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 });
  assert.equal(rows.length, 211);
  const headers = rows.shift(), state = headers.indexOf('Trạng thái hóa đơn');
  assert.equal(state, headers.length - 1);
  assert.equal(rows[0][headers.indexOf('Số hóa đơn')], '00000001');
  assert.equal(rows.reduce((sum, row) => sum + row[headers.indexOf('Tổng tiền')], 0), 23100);
  assert.equal(new Set(rows.map(row => row[state])).size, 6);
  for (const filter of ['4', '5', '6']) {
    const result = await request(`/api/db/export?parts=buy&state=${filter}&from=2026-09-01&to=2026-09-30`);
    assert.equal(result.status, 200);
    const filtered = XLSX.read(result.body, { type: 'buffer' });
    assert.equal(XLSX.utils.sheet_to_json(filtered.Sheets['Hóa đơn mua vào'], { header: 1 }).length, 36);
  }
  const empty = await request('/api/db/export?parts=buy&from=2025-01-01&to=2025-12-31');
  assert.equal(empty.status, 200);
  const emptyBook = XLSX.read(empty.body, { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(emptyBook.Sheets['Hóa đơn mua vào'], { header: 1 }).length, 1);
});
