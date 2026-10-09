'use strict';
// Runtime DOM regression using the real panes/scripts and local API fixtures.
// No taxpayer credentials, real portals or production server/data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { browserPath } = require('../src/browser');
const root = path.resolve(__dirname, '../src');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [{ maHoSo: '123456', toKhai: '01/GTGT', kyTinhThue: '09/2026', loaiToKhai: 'Chính thức', lanBoSung: '0', lanNop: '1', ngayNop: '01/10/2026', trangThai: 'Đã nhận' }];
let mode = '';
let stage = 0;
let searchedMsts = [];
let webOpened = 0, webHidden = 0, syncPolls = 0;
const errors = [];
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="30">ABCD</text></svg>');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let value = {};
    if (url.pathname === '/api/state') value = { selected: '0101234567' };
    else if (url.pathname === '/api/db/mst-partners') value = { mst: '0101234567', rows: url.searchParams.get('kind') === 'supplier' ? [{ mst: '0101234567', ten: 'Supplier <one>', so_hoa_don: 2 }, { mst: '0301234567', ten: 'Supplier two', so_hoa_don: 1 }] : [{ mst: '0201234567', ten: 'Buyer', so_hoa_don: 3 }] };
    else if (url.pathname.endsWith('/captcha')) value = { dataUrl: image, solvedText: 'ABCD' };
    else if (url.pathname.endsWith('/credentials')) value = { username: '', remembered: false };
    else if (url.pathname === '/api/tokhai/open') { webOpened++; value = { opened: true }; }
    else if (url.pathname === '/api/tokhai/hide') { webHidden++; value = { hidden: true }; }
    else if (url.pathname === '/api/sync-token') value = ++syncPolls < 3 ? { pending: true } : { mst: '0101234567', name: 'TEST', portal: 'dvc' };
    else if (url.pathname.endsWith('/login')) value = { mst: '0101234567', name: 'TEST', portal: 'dvc' };
    else if (url.pathname.endsWith('/search')) { mode = url.pathname.includes('/mst/') ? 'mst' : 'search'; if (mode === 'mst') { let body = ''; for await (const chunk of req) body += chunk; searchedMsts = JSON.parse(body).mstList; } stage = 0; value = { started: true, total: 1 }; }
    else if (url.pathname.endsWith('/download')) { mode = 'download'; stage = 0; value = { started: true, total: 1 }; }
    else if (url.pathname.endsWith('/stop')) { stage = -100; value = { stopped: true }; }
    else if (url.pathname.endsWith('/progress')) {
      if (stage < 0) value = { stage: 'stopped', rows: [] };
      else if (++stage === 1) value = { stage: 'start', total: 1, done: 0, message: 'Đang chạy' };
      else if (mode === 'mst') value = { stage: 'complete', total: 1, done: 1, rows: [{ mst: '0101234567', ten: 'TEST <script>', found: true, tThai: 'Đang hoạt động', cThue: 'CQT', dChi: 'HN' }] };
      else if (mode === 'search') value = { stage: 'complete', rows };
      else value = { stage: 'complete', succeeded: 1, failed: 0, files: [{ maHoSo: '123456', success: true, path: 'fixture.xml' }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, value }));
  }
  if (url.pathname === '/') {
    let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '');
    html = html.replace('</body>', `<script>window.noticeFail=message=>console.error(message);document.body.classList.add('app-ready');document.getElementById('boot-splash')?.remove();</script><script src="/mst-lookup-ui.js"></script><script src="/tokhai-ui.js"></script></body>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  let file = path.resolve(root, '.' + url.pathname);
  if (/\/(mst-lookup-ui|tokhai-ui)\.js$/.test(url.pathname)) {
    const min = file.replace(/\.js$/, '.min.js');
    if (fs.existsSync(min)) file = min;
  }
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
(async () => {
  const executable = browserPath();
  assert.ok(executable, 'Chrome/Edge is required for browser runtime check');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-features-browser-'));
  const portServer = http.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const processHandle = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1360,900', url], { windowsHide: true, stdio: 'ignore' });
  let client;
  try {
    for (let n = 0; n < 80; n++) {
      try { const tabs = await CDP.List({ port }); const tab = tabs.find(t => t.url.startsWith(url)); if (tab) { client = await CDP({ port, target: tab }); break; } } catch {}
      await sleep(250);
    }
    assert.ok(client, 'Headless Chrome connected');
    await client.Runtime.enable();
    client.Runtime.exceptionThrown(event => errors.push(event.exceptionDetails.text));
    client.Runtime.consoleAPICalled(event => { if (event.type === 'error') errors.push(event.args.map(a => a.value).join(' ')); });
    async function run(expression) {
      const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    async function until(expression) {
      for (let n = 0; n < 80; n++) { if (await run(expression)) return; await sleep(100); }
      throw new Error('Timed out: ' + expression + '\n' + JSON.stringify({ errors, dom: await run(`({log:document.getElementById('ttk-log-container').textContent,captcha:document.getElementById('ttk-login-captcha').value,search:document.getElementById('ttk-btn-search').disabled})`) }));
    }
    await until('!!window.MstLookupUI && !!window.TokhaiUI');
    const portal = await run(require('../tools/verify-portal-reference.cjs'));
    assert.equal(portal.login.dse_sessionId, 'fixture-session');
    assert.equal(portal.found.success, true);
    assert.equal(portal.found.rows.length, 2);
    assert.equal(portal.found.rows[0].maHoSo, '123456');
    assert.equal(portal.pagination, true);
    assert.equal(portal.searchDate, true);
    assert.equal(portal.tdt.success, true);
    assert.equal(portal.tdt.files.length, 2);
    assert.equal(portal.dvc.success, true);
    assert.ok(portal.dvc.hoSo);
    assert.equal(portal.dvc.thongBaos.length, 1);
    assert.equal(portal.dvc.taiLieus.length, 1);
    assert.equal(portal.notifications, true);
    assert.equal(portal.attachment, true);
    await run(`window.dispatchEvent(new CustomEvent('hd:state',{detail:{selected:'0101234567'}}));window.MstLookupUI.ensureInit();window.TokhaiUI.ensureInit();`);
    await until(`document.getElementById('mst-captcha-input').value === 'ABCD'`);
    await run(`document.body.classList.add('app-ready');document.getElementById('boot-splash')?.remove();document.getElementById('pane-overview').hidden=true;document.getElementById('pane-mstlookup').hidden=false;document.getElementById('mst-btn-suppliers').click();`);
    await until(`document.getElementById('mst-partner-body').children.length===2`);
    await until(`document.getElementById('mst-captcha-img').complete && document.getElementById('mst-captcha-img').naturalWidth > 0`);
    assert.equal(await run(`!document.getElementById('mst-captcha-img').hidden && getComputedStyle(document.getElementById('mst-captcha-img')).display !== 'none'`), true);
    assert.equal(await run(`document.getElementById('mst-partners').getBoundingClientRect().width > 450`), true);
    for (const width of [1360, 760, 580]) {
      await client.Emulation.setDeviceMetricsOverride({ width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert.equal(await run(`document.getElementById('pane-mstlookup').getBoundingClientRect().right <= innerWidth + 1 && document.getElementById('mst-partners').getBoundingClientRect().right <= document.getElementById('pane-mstlookup').getBoundingClientRect().right`), true, 'MST pane fits viewport ' + width);
    }
    await client.Emulation.setDeviceMetricsOverride({ width: 1360, height: 1000, deviceScaleFactor: 1, mobile: false });
    fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../artifacts/mst-lookup-layout.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
    assert.equal(await run(`document.getElementById('mst-partner-body').textContent.includes('Supplier <one>')`), true);
    await run(`document.getElementById('mst-partner-all').click();document.querySelector('[data-mst="0301234567"]').click();document.getElementById('mst-input').value='0101234567\\n0401234567';document.getElementById('mst-input').dispatchEvent(new Event('input'));`);
    assert.equal(await run(`document.getElementById('mst-partner-all').indeterminate`), true);
    assert.equal(await run(`document.getElementById('mst-count-badge').textContent.includes('2')`), true);
    assert.equal(await run(`document.querySelector('#mst-partners .table-scroll').getBoundingClientRect().height<=280`), true);
    await run(`document.getElementById('mst-btn-start').click();`);
    await until(`document.getElementById('mst-results-body').children.length === 1 && !document.getElementById('mst-btn-export-excel').disabled`);
    assert.equal(await run(`document.getElementById('mst-results-body').textContent.includes('TEST <script>')`), true);
    assert.deepEqual(searchedMsts, ['0101234567', '0401234567']);
    await run(`document.getElementById('mst-btn-buyers').click();`);
    await until(`document.getElementById('mst-partner-body').children.length===1`);
    assert.equal(await run(`document.getElementById('mst-partner-all').checked`), false);
    assert.equal(webOpened, 0, 'Initializing declaration tab must not open visible Chrome');
    await run(`window.TokhaiUI.ensureInit();`);
    await until(`true`);
    for (let n = 0; n < 20 && webHidden === 0; n++) await sleep(50);
    assert.equal(webHidden, 1, 'Re-entering declaration tab hides a previously opened Chrome window');
    await run(`document.getElementById('pane-mstlookup').hidden=true;document.getElementById('pane-tokhai').hidden=false;document.getElementById('ttk-btn-show-login').click();`);
    await until(`document.getElementById('ttk-captcha-img').naturalWidth > 0 && !document.getElementById('ttk-captcha-img').hidden`);
    assert.equal(await run(`getComputedStyle(document.getElementById('ttk-captcha-img')).display !== 'none'`), true, 'Declaration login CAPTCHA is visible');
    await run(`document.getElementById('ttk-btn-sync-token').click();`);
    await until(`document.getElementById('ttk-btn-sync-token').disabled`);
    assert.equal(await run(`document.getElementById('ttk-conn-dot').classList.contains('connected')`), false, 'Pending manual login must not mark session connected');
    await until(`document.getElementById('ttk-conn-dot').classList.contains('connected')`);
    await until(`!document.getElementById('ttk-btn-sync-token').disabled`);
    assert.equal(webOpened, 1);
    assert.equal(syncPolls, 3, 'Web sync waits for authentication automatically');
    assert.equal(webHidden, 2, 'Chrome is hidden after successful automatic sync');
    await run(`document.getElementById('ttk-txt-tu-ngay').value='01/09/2026';document.getElementById('ttk-txt-den-ngay').value='09/10/2026';document.getElementById('ttk-btn-search').click();`);
    await until(`document.getElementById('ttk-results-body').children.length === 1`);
    await run(`document.querySelector('.ttk-btn-download').click();`);
    await until(`document.querySelector('.ttk-btn-download').textContent.includes('Đã tải')`);
    await run(`document.querySelector('.ttk-hs-link').click();`);
    assert.equal(await run(`!!document.querySelector('dialog[open]')`), true);
    await run(`document.querySelector('dialog button').click();window.dispatchEvent(new CustomEvent('hd:state',{detail:{selected:'0301234567'}}));`);
    assert.equal(await run(`document.getElementById('ttk-results-body').children.length`), 0);
    assert.equal(await run(`document.getElementById('mst-partners').hidden && document.getElementById('mst-input').value===''`), true);
    assert.deepEqual(errors, []);
    console.log('PASS: real DOM CAPTCHA, MST result/export, declaration search/download/detail, account reset; Chrome headless hidden.');
  } finally {
    if (client) { try { await client.Browser.close(); } catch {} try { await client.close(); } catch {} }
    if (processHandle.exitCode === null) processHandle.kill();
    await sleep(750);
    server.close();
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.match(path.basename(profile), /^tax-features-browser-/);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); }
    catch (error) { console.log('Temporary Chrome profile could not be removed: ' + error.code); }
  }
})().catch(error => { console.error(error.stack); server.close(); process.exitCode = 1; });
