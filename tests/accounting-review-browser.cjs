'use strict';
// Real DOM + actual review service/SQLite/ZIP; isolated profile and fixture data only.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const JSZip = require('jszip');
const { browserPath } = require('../src/browser');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');
const { buildImportRecord } = require('../src/data/xml-parser');
const service = require('../src/accounting-review/service');
const source = path.resolve(__dirname, '../src');
const MST = '0315058003';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-browser-'));
const dir = path.join(root, 'MST-' + MST);
const profile = path.join(root, 'chrome');
fs.mkdirSync(dir, { recursive: true });
for (const sell of [false, true]) {
  const file = path.join(dir, sell ? 'Ban_ra' : 'Mua_vao', '1.xml');
  const amount = sell ? 200 : 100;
  const xml = `<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>1</SHDon><NLap>2026-08-01</NLap><HTTToan>Tiền mặt</HTTToan></TTChung><NDHDon><NBan><MST>${sell ? MST : '0402335623'}</MST></NBan><NMua><MST>${sell ? '0402335623' : MST}</MST></NMua><TToan><TgTCThue>${amount}</TgTCThue><TgTThue>${amount / 10}</TgTThue><TgTTTBSo>${amount * 1.1}</TgTTTBSo></TToan></NDHDon></DLHDon></HDon>`;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, xml);
  const db = openDatabase(path.join(dir, 'data.db'));
  try { insertInvoice(db, buildImportRecord(xml, { currentMst: MST, fileXml: file }).record); } finally { closeDatabase(db); }
}
const declaration = path.join(dir, 'To_khai', '123456', 'tk.xml');
fs.mkdirSync(path.dirname(declaration), { recursive: true });
fs.writeFileSync(declaration, `<HSoThueDTu><HSoKhaiThue><TTinChung><TKhaiThue><maTKhai>842</maTKhai><tenTKhai>01/GTGT</tenTKhai><pbanTKhaiXML>2.8</pbanTKhaiXML><loaiTKhai>C</loaiTKhai><soLan>0</soLan><KyKKhaiThue><kieuKy>Q</kieuKy><kyKKhai>3/2026</kyKKhai></KyKKhaiThue><ngayLapTKhai>15/10/2026</ngayLapTKhai></TKhaiThue><NNT><mst>${MST}</mst></NNT></TTinChung><CTieuTKhaiChinh><ct23>100</ct23><ct24>10</ct24><ct34>250</ct34><ct35>20</ct35></CTieuTKhaiChinh></HSoKhaiThue></HSoThueDTu>`);
let selected = MST, exported = '';
const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const readBody = async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/state') return reply(res, 200, { ok: true, value: { selected, output: root } });
  if (url.pathname === '/review-test-init.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end("document.body.classList.add('app-ready');document.getElementById('boot-splash')?.remove();window.HD_DATA_VIEW={range:()=>({from:'2026-07-01',to:'2026-09-30'}),show:()=>{}};");
  }
  if (url.pathname.startsWith('/api/review/')) {
    try {
      const wrappedReply = (response, status, body) => { if (url.pathname.endsWith('/export') && body.ok) exported = body.value.path; reply(response, status, body); };
      return await service.handle(req, res, url, { reply: wrappedReply, readBody,
        context: request => { assert.equal(request.headers['x-feature-mst'], selected); return { mst: selected, dir: path.join(root, 'MST-' + selected), identifiers: [selected] }; },
        downloadJob: () => ({ running: false, progress: {} }),
      });
    } catch (error) { return reply(res, 400, { ok: false, error: error.message }); }
  }
  if (url.pathname === '/') {
    let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '');
    html = html.replace('</body>', `<script src="/review-test-init.js"></script><script src="/accounting-review-ui.js"></script></body>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  let file = path.resolve(source, '.' + url.pathname);
  if (/accounting-review-ui\.(js|css)$/.test(file)) { const min = file.replace(/\.(js|css)$/, '.min.$1'); if (fs.existsSync(min)) file = min; }
  if (!file.startsWith(source + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': /\.js$/.test(file) ? 'text/javascript' : /\.css$/.test(file) ? 'text/css' : 'application/octet-stream' }); res.end(fs.readFileSync(file));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const portServer = http.createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve)); const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const executable = browserPath(); assert.ok(executable);
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1360,1000', url], { windowsHide: true, stdio: 'ignore' });
  let client;
  try {
    for (let i = 0; i < 80; i++) { try { const tab = (await CDP.List({ port })).find(tab => tab.url.startsWith(url)); if (tab) { client = await CDP({ port, target: tab }); break; } } catch {} await sleep(150); }
    assert.ok(client);
    const errors = []; await client.Runtime.enable(); client.Runtime.exceptionThrown(event => errors.push(event.exceptionDetails.text));
    async function run(expression) { const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
    async function until(expression) { for (let i = 0; i < 120; i++) { if (await run(expression)) return; await sleep(100); } throw new Error('Timed out: ' + expression + '\n' + JSON.stringify(await run(`({status:document.getElementById('review-status').textContent,scope:document.getElementById('review-scope').textContent,range:window.HD_DATA_VIEW?.range?.(),ui:!!window.AccountingReviewUI,disabled:document.getElementById('review-check').disabled})`)) + '\n' + JSON.stringify(errors)); }
    await until(`!!window.AccountingReviewUI && !document.getElementById('review-check').disabled`);
    assert.match(await run(`document.getElementById('review-status').textContent`), /Chưa kiểm tra/);
    await run(`document.getElementById('review-check').click()`);
    await until(`document.getElementById('review-comparisons').children.length===4 && !document.getElementById('review-check').disabled`);
    assert.match(await run(`document.getElementById('review-comparisons').textContent`), /Chưa đủ dữ liệu/);
    await run(`document.getElementById('review-settings').open=true;document.getElementById('review-buy-complete').checked=true;document.getElementById('review-sell-complete').checked=true;document.getElementById('review-actor').value='Lan';document.getElementById('review-accepted').checked=true;document.getElementById('review-acceptance-note').value='Thông báo 01 đã kiểm tra';document.getElementById('review-save-settings').click();`);
    await until(`document.getElementById('review-issues').children.length===1 && !document.getElementById('review-check').disabled`);
    assert.match(await run(`document.getElementById('review-comparisons').textContent`), /Cần giải trình/);
    await run(`document.querySelector('[data-review-issue]').click();document.getElementById('review-issue-state').value='done';document.getElementById('review-issue-assignee').value='Lan';document.getElementById('review-issue-note').value='Đã kiểm tra chứng từ A';document.querySelector('#review-issue-form button[type=submit]').click();`);
    await until(`!document.getElementById('review-dialog').open && !document.getElementById('review-close-period').disabled`);
    await run(`document.getElementById('review-check').click()`);
    await until(`!document.getElementById('review-check').disabled`);
    assert.equal(await run(`document.getElementById('review-issues').children.length`), 0);
    const bankOriginal = path.join(root, 'bank-original.csv'); fs.writeFileSync(bankOriginal, 'Ngày,Nợ,Có\n2026-08-01,100,0\n');
    await run(`document.getElementById('review-bank-note').value='Ngân hàng A, tài khoản 001, quý 3';`);
    const documentNode = await client.DOM.getDocument();
    const fileInput = await client.DOM.querySelector({ nodeId: documentNode.root.nodeId, selector: '#review-bank-file' });
    await client.DOM.setFileInputFiles({ nodeId: fileInput.nodeId, files: [bankOriginal] });
    await until(`document.getElementById('review-bank-originals').textContent.includes('bank-original.csv') && !document.getElementById('review-export').disabled`);
    await run(`document.getElementById('review-export').click()`);
    await until(`document.getElementById('review-status').textContent.includes('Đã lưu') && !document.getElementById('review-export').disabled`);
    assert.ok(fs.existsSync(exported));
    const zip = await JSZip.loadAsync(fs.readFileSync(exported)); const manifest = JSON.parse(await zip.file('manifest.json').async('string')); assert.equal(manifest.unresolved, 0); assert.equal(manifest.bankOriginalsIncluded, true); assert.equal(manifest.bankOriginals[0].verifiedImport, false);
    await run(`document.getElementById('review-close-period').click()`);
    await until(`document.getElementById('review-status').textContent.includes('Đã chốt kỳ')`);
    for (const width of [1360, 760, 580]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.ok(await run(`document.getElementById('review-workspace').getBoundingClientRect().right<=window.innerWidth+1`), 'review panel stays inside viewport at ' + width);
    }
    await client.Emulation.setDeviceMetricsOverride({ width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false });
    const artifact = path.resolve(__dirname, '../artifacts/accounting-review-overview.png'); fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, Buffer.from((await client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false })).data, 'base64'));
    fs.writeFileSync(declaration, fs.readFileSync(declaration, 'utf8').replace('<ct34>250</ct34>', '<ct34>260</ct34>'));
    await run(`document.getElementById('review-refresh').click()`);
    await until(`document.getElementById('review-status').textContent.includes('đã thay đổi')`);
    assert.equal(await run(`document.getElementById('review-export').disabled && document.getElementById('review-close-period').disabled`), true);
    selected = '0101234567';
    await run(`window.dispatchEvent(new CustomEvent('hd:state',{detail:{selected:'0101234567',output:${JSON.stringify(root)}}}));`);
    await until(`document.getElementById('review-status').textContent.includes('Chưa kiểm tra')`);
    assert.equal(await run(`document.getElementById('review-comparisons').children.length`), 0);
    assert.equal(await run(`document.getElementById('review-declaration').value`), '');
    assert.deepEqual(errors, []);
    console.log('PASS: actual SQLite/ZIP + Chrome DOM: coverage, VAT comparison, review persistence, export, closing, stale evidence, MST isolation and responsive layout.');
  } finally {
    if (client) { try { await client.Browser.close(); } catch {} try { await client.close(); } catch {} }
    if (child.exitCode === null) child.kill(); await sleep(750);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  server.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^review-browser-/);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch (error) { console.log('Temporary fixture cleanup: ' + error.code); }
});
