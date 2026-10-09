'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const http = require('node:http');
const CDP = require('chrome-remote-interface');
const { browserPath } = require('../src/browser');
// Other tests replace global fetch in the shared-process runner.
const fetch = globalThis.fetch.bind(globalThis);
test('real server exposes independent review API, preserves legacy routes and rejects another MST scope', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-server-'));
  const runtime = path.join(root, 'runtime'), output = path.join(root, 'output');
  const mst = '0315058003', dir = path.join(output, 'MST-' + mst);
  fs.mkdirSync(runtime, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
  const db = openDatabase(path.join(dir, 'data.db'));
  require('../src/data/repository').insertInvoice(db, { direction: 'SELL', mstBan: mst, mstMua: '0101234567', tenBan: 'Fixture', tenMua: 'Khách hàng kiểm thử', ngayLap: '2026-09-21', khmsHd: '1', khhHd: 'C26TAA', soHd: '123', tongTien: 110000, tienTruocThue: 100000, tienThue: 10000, fileXml: 'fixture.xml', items: [{ stt: 1, maHang: 'MH1', tenHang: 'Kiểm thử', donVi: 'Cái', soLuong: 1, donGia: 100000, thanhTien: 100000, tienThue: 10000, thueSuat: '10%' }] });
  closeDatabase(db);
  fs.writeFileSync(path.join(runtime, 'accounts.json'), JSON.stringify({ accounts: [{ mst, name: 'Fixture' }], selected: mst, output }));
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOADON_TEST_DATA: runtime, HOADON_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let text = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', data => { text += data; }); child.stderr.on('data', data => { text += data; });
  try {
    let match;
    for (let i = 0; i < 150; i++) { match = text.match(/\{"testUrl":"[^"]+"/); if (match || child.exitCode !== null) break; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.ok(match, 'test server starts');
    const base = new URL(JSON.parse(match[0] + '}').testUrl);
    const cookie = 'hd_session=' + base.searchParams.get('launch');
    async function call(route, method = 'GET', body, scope = mst) {
      const response = await fetch(new URL(route, base), { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Feature-Mst': scope }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, value: await response.json() };
    }
    const range = { from: '2026-07-01', to: '2026-09-30' };
    const initial = await call('/api/review/snapshot?' + new URLSearchParams(range));
    assert.equal(initial.status, 200); assert.equal(initial.value.value.checked, false);
    const wrong = await call('/api/review/check', 'POST', range, '0402335623');
    assert.equal(wrong.status, 400); assert.equal(wrong.value.ok, false);
    const checked = await call('/api/review/check', 'POST', range);
    assert.equal(checked.status, 200); assert.equal(checked.value.value.mst, mst); assert.ok(checked.value.value.issues.length);
    assert.ok(fs.existsSync(path.join(dir, 'Kiem_tra', 'ho_so.db')));
    assert.equal((await call('/api/db/overview?' + new URLSearchParams(range))).status, 200);
    assert.equal((await call('/api/review/progress')).value.value.stage, 'idle');
    for (const route of ['/accounting-review-ui.js', '/accounting-review-ui.css']) {
      const response = await fetch(new URL(route, base), { headers: { Cookie: cookie } });
      assert.equal(response.status, 200); assert.ok((await response.text()).length > 1000);
    }
    // Exercise the real renderer/data-ui adapters together, including the old overview.
    const executable = browserPath();
    assert.ok(executable, 'Chrome is available for full app integration');
    const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
    const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(root, 'browser')}`, `--remote-debugging-port=${port}`, '--window-size=1360,1000', base.href], { windowsHide: true, stdio: 'ignore' });
    let client;
    try {
      for (let i = 0; i < 100; i++) { try { const tab = (await CDP.List({ port })).find(tab => tab.url.startsWith(base.origin)); if (tab) { client = await CDP({ port, target: tab }); break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
      assert.ok(client);
      const errors = []; await client.Runtime.enable(); client.Runtime.exceptionThrown(event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
      async function run(expression) { const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
      async function until(expression) { for (let i = 0; i < 150; i++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Full app integration timed out: ' + expression + '; ' + JSON.stringify(errors)); }
      await until(`!!window.HD_DATA_VIEW && !!window.AccountingReviewUI && !document.getElementById('review-check').disabled`);
      await run(`document.getElementById('app-range-mode').value='quarter';document.getElementById('app-range-year').value='2026';document.getElementById('app-range-quarter').value='3';document.getElementById('app-range-mode').dispatchEvent(new Event('change'));`);
      await until(`document.getElementById('review-scope').textContent.includes('2026-07-01') && !document.getElementById('review-check').disabled`);
      assert.deepEqual(await run(`window.HD_DATA_VIEW.range()`), { from: '2026-07-01', to: '2026-09-30' });
      await run(`document.getElementById('review-check').click()`);
      await until(`document.getElementById('review-status').textContent.includes('Kiểm tra lúc') && !document.getElementById('review-check').disabled`);
      await run(`document.querySelector('.review-legacy').open=true;document.getElementById('view-data-list').click()`);
      assert.equal(await run(`!document.getElementById('pane-data').hidden && document.getElementById('pane-overview').hidden`), true);
      await run(`document.getElementById('view-overview').click()`);
      await until(`!document.getElementById('pane-overview').hidden && !document.getElementById('review-check').disabled`);
      assert.equal(await run(`document.getElementById('view-title').textContent`), 'Hồ sơ kế toán');
      await run(`document.getElementById('view-bank').click()`);
      assert.equal(await run(`document.querySelector('.bank-table-card').compareDocumentPosition(document.querySelector('.bank-visual-grid')) & Node.DOCUMENT_POSITION_FOLLOWING`), 4);
      for (const tab of ['accounting', 'dvt']) {
        await run(`document.getElementById('view-${tab}').click()`);
        assert.equal(await run(`document.querySelector('#pane-${tab} .feature-planned').textContent.includes('Đang xây dựng') && document.querySelector('#pane-${tab} .feature-workbench').hidden`), true);
      }
      await run(`document.getElementById('view-data-vat').click()`);
      await until(`!document.getElementById('vat-export-pdf').disabled`);
      await run(`document.getElementById('vat-export-pdf').click()`);
      await until(`document.getElementById('vat-pdf-frame').contentDocument?.querySelector('.vat-table') && document.getElementById('vat-pdf-frame').contentDocument.styleSheets.length > 0`);
      assert.equal(await run(`document.getElementById('vat-pdf-dialog').open`), true);
      assert.equal(await run(`document.getElementById('vat-pdf-frame').contentDocument.body.textContent.includes('${mst}')`), true);
      assert.equal(await run(`document.getElementById('vat-pdf-frame').contentDocument.body.textContent.includes('Thuế phải nộp')`), true);
      await run(`window.__pdfPrintCalled=false;document.getElementById('vat-pdf-frame').contentWindow.print=()=>{window.__pdfPrintCalled=true};document.getElementById('vat-pdf-print').click()`);
      assert.equal(await run('window.__pdfPrintCalled'), true);
      fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
      fs.writeFileSync(path.resolve(__dirname, '../artifacts/vat-pdf-preview.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
      assert.deepEqual(errors, []);
    } finally {
      if (client) { try { await client.Browser.close(); } catch {} try { await client.close(); } catch {} }
      if (chrome.exitCode === null) { const stopped = once(chrome, 'exit'); chrome.kill(); await stopped; }
    }
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^review-server-/);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
      t.diagnostic('Temporary Chrome profile remains locked during cleanup: ' + error.code);
    }
  }
});
