'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { browserPath, TaxBrowser } = require('../src/browser');
const download = require('../src/provider-download');
const { findLookupCode } = require('../src/data/lookup-code');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncc-browser-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let chrome, client;
const solver = require('../src/captcha-solver');
const originalSolve = solver.solve;
let recognized = null, solveCalls = 0;
solver.solve = async data => { assert.ok(data.startsWith('data:image/png;base64,')); solveCalls++; return recognized; };
async function until(fn) {
  for (let n = 0; n < 200; n++) { const result = await fn().catch(() => null); if (result) return result; await wait(100); }
  throw new Error('Fixture did not become ready');
}
async function evaluate(expression) {
  const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
(async () => {
  const pdf = Buffer.from('%PDF-1.7\nfixture original invoice\n%%EOF');
  const captchaImage = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="white"/><text x="15" y="30" font-size="26">1234</text></svg>');
  const fixture = `<html><body><input id="key"><img id="CaptchaImage" src="${captchaImage}"><input name="captcha"><button type="submit" onclick="if(document.querySelector('[name=captcha]').value==='1234'){document.getElementById('result').innerHTML='<a href=/original.pdf>Tải PDF</a>'}">Tra cứu</button><div id="result"></div></body></html>`;
  chrome = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => Number(fs.readFileSync(path.join(temp, 'chrome/DevToolsActivePort'), 'utf8').split('\n')[0]));
  const target = await CDP.New({ port, url: 'about:blank' });
  client = await CDP({ port, target });
  await client.Page.enable();
  await client.Runtime.enable();
  const misaRequests = [];
  client.Fetch.requestPaused(async event => {
    if (event.request.url.includes('DownloadHandler.ashx')) misaRequests.push(event.request.url);
    const isPdf = event.request.url.endsWith('/original.pdf') || event.request.url.endsWith('/native-file') || event.request.url.includes('DownloadHandler.ashx');
    const misa = `<html><body><input id="txtCode"><button id="btnSearchInvoice" onclick="document.getElementById('pnResult').innerHTML='<iframe id=frmResult src=/tra-cuu/DownloadHandler.ashx?ext=KEEP_TOKEN&amp;Code='+document.getElementById('txtCode').value+'></iframe>'">Tra cứu</button><div id="pnResult"></div></body></html>`;
    const viettel = `<html><body><input name="lookup:supplierTaxCode"><input name="lookup:invoiceNo"><input name="lookup:issueDate_input"><input name="lookup:reservationCode"></body></html>`;
    await client.Fetch.fulfillRequest({ requestId: event.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: isPdf ? 'application/pdf' : 'text/html; charset=utf-8' }],
      body: (isPdf ? pdf : Buffer.from(event.request.url.includes('sinvoice.viettel.vn') ? viettel : event.request.url.includes('meinvoice.vn') ? misa : fixture)).toString('base64') });
  });
  await client.Fetch.enable({ patterns: [{ urlPattern: 'https://fixture.vn/*' }, { urlPattern: 'https://www.meinvoice.vn/*' }, { urlPattern: 'https://business.sinvoice.viettel.vn/*' }] });
  await client.Page.navigate({ url: 'https://fixture.vn/' });
  await until(() => evaluate("!!document.getElementById('key')"));
  const row = { invoice_key: 'fixture-key', provider_id: 'fpt', lookup_code: 'REALCODE', lookup_url: 'https://fixture.vn/', mst_ban: '123', khms_hd: '1', khh_hd: 'C26', so_hd: '001', direction: 'BUY' };
  const browser = { portalPort: port, openAuxPortal: async () => target.id };
  const missing = await download.start(browser, { ...row, lookup_code: '' }, temp);
  assert.equal(missing.needsCode, true);
  const started = await download.start(browser, row, temp);
  assert.equal(started.requiresUser, true);
  assert.equal(await evaluate("document.getElementById('key').value"), 'REALCODE');
  assert.equal(await evaluate("typeof window.__cnProviderHandler"), 'undefined', 'runner must not be accessible to provider scripts');
  assert.equal(await evaluate("!!document.getElementById('invoice-vault-captcha-assist')"), true);
  assert.equal((await download.scan(browser, started.session, row, temp)).pending, true);
  await assert.rejects(download.scan(browser, started.session, { ...row, invoice_key: 'other' }, temp), /hồ sơ khác/);
  assert.ok(solveCalls > 0, 'existing solver must be called with CAPTCHA pixels');
  assert.equal(await evaluate("document.querySelector('[data-cn-captcha] img').src.startsWith('data:image/png')"), true);
  await evaluate("const entry=document.querySelector('[data-cn-captcha] input');entry.value='1234';entry.dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('[name=captcha]').value"), '1234');
  await evaluate("document.getElementById('invoice-vault-captcha-continue').click()");
  await until(() => evaluate("!!document.querySelector('a[href*=pdf]')"));
  await wait(1000);
  const saved = await download.scan(browser, started.session, row, temp);
  assert.equal(saved.downloaded, true);
  assert.deepEqual(fs.readFileSync(path.join(temp, saved.relative)), pdf);
  await client.Page.navigate({ url: 'https://fixture.vn/' });
  await until(() => evaluate("!!document.getElementById('key')"));
  const secondRow = { ...row, invoice_key: 'second-fixture', so_hd: '002' };
  recognized = '1234';
  const second = await download.start(browser, secondRow, temp);
  assert.equal(await evaluate("document.querySelector('[data-cn-captcha] input').value"), '1234', 'OCR must fill the mirrored field');
  assert.equal(await evaluate("document.querySelector('[name=captcha]').value"), '1234', 'OCR must fill the provider field');
  const replacement = await download.start(browser, row, temp);
  await assert.rejects(download.scan(browser, second.session, secondRow, temp), /hết hạn/);
  console.log('PASS: replacing an unfinished download releases the old session');
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<a id=native href="data:application/pdf;base64,${pdf.toString('base64')}" download=native.pdf>PDF</a>');document.getElementById('native').click()`);
  let native;
  await until(async () => { native = await download.scan(browser, replacement.session, row, temp); return native.downloaded; });
  assert.deepEqual(fs.readFileSync(path.join(temp, native.relative)), pdf);
  await client.Page.navigate({ url: 'https://www.meinvoice.vn/tra-cuu/' });
  await until(() => evaluate("!!document.getElementById('txtCode')"));
  const xmlCode = findLookupCode('<HDon><DLHDon Id="MISA123456"></DLHDon></HDon>', 'misa');
  const misaRow = { ...row, invoice_key: 'misa-fixture', provider_id: 'misa', lookup_code: xmlCode, lookup_url: 'https://www.meinvoice.vn/tra-cuu/', so_hd: '003' };
  browser.evalInPortalTab = async (_id, expression) => client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const misaOpened = await TaxBrowser.prototype.openPortalAndFill.call(browser, misaRow.lookup_url, misaRow);
  assert.equal(misaOpened.ready, true);
  assert.equal(await evaluate("document.getElementById('txtCode').value"), xmlCode);
  await evaluate("document.getElementById('txtCode').remove();setTimeout(()=>document.body.insertAdjacentHTML('afterbegin','<input id=txtCode>'),100)");
  const misaStarted = await download.start(browser, misaRow, temp);
  assert.equal(await evaluate("document.getElementById('txtCode').value"), 'MISA123456');
  const misaSaved = await download.scan(browser, misaStarted.session, misaRow, temp);
  assert.equal(misaSaved.downloaded, true);
  assert.deepEqual(fs.readFileSync(path.join(temp, misaSaved.relative)), pdf);
  const nextMisa = { ...misaRow, invoice_key: 'misa-next', lookup_code: 'NEXT123456', so_hd: '004' };
  const nextStarted = await download.start(browser, nextMisa, temp);
  assert.equal(await evaluate("document.getElementById('txtCode').value"), nextMisa.lookup_code);
  assert.ok((await evaluate("document.getElementById('frmResult').getAttribute('src')")).includes(nextMisa.lookup_code));
  assert.equal((await download.scan(browser, nextStarted.session, nextMisa, temp)).downloaded, true);
  assert.ok(misaRequests.some(value => { const params = new URL(value).searchParams; return params.get('Type') === 'pdf' && params.get('ext') === 'KEEP_TOKEN' && params.get('Code') === 'MISA123456'; }));
  console.log('PASS: MISA specific runner autofills XML code and retrieves official PDF with provider token');
  await client.Page.navigate({ url: 'https://business.sinvoice.viettel.vn/tracuuhoadon.html' });
  await until(() => evaluate("!!document.querySelector('input[name$=supplierTaxCode]')"));
  browser.evalInPortalTab = async (_id, expression) => client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const opened = await TaxBrowser.prototype.openPortalAndFill.call(browser, 'https://business.sinvoice.viettel.vn/tracuuhoadon.html', {
    provider_id: 'viettel', mst_ban: '0100000001', khh_hd: 'C26AA', so_hd: '123', ngay_lap: '2026-10-03', lookup_code: '' });
  assert.equal(opened.ready, true);
  assert.equal(await evaluate("document.querySelector('input[name$=supplierTaxCode]').value"), '0100000001');
  assert.equal(await evaluate("document.querySelector('input[name$=invoiceNo]').value"), 'C26AA123');
  console.log('PASS: Viettel portal opens and fills known invoice fields without requiring a secret code');
  console.log('PASS: FPT fixture autofill -> manual CAPTCHA -> original PDF verified and saved; isolated runtime and wrong-invoice rejection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  solver.solve = originalSolve;
  if (client) { await client.Browser.close().catch(() => {}); await client.close().catch(() => {}); }
  if (chrome && chrome.exitCode === null) { await wait(1000); if (chrome.exitCode === null) chrome.kill(); }
  if (path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); }
    catch (error) { console.warn('Temporary Chrome profile still locked: ' + error.code); }
  }
});
