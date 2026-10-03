'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { browserPath } = require('../src/browser');
const root = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-ai-browser-'));
let chrome, server, client, upstream;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = await fn().catch(() => null); if (result) return result; await wait(100); }
  throw new Error('Timeout: ' + label);
}
async function evaluate(expression) {
  const value = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result.value;
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
(async () => {
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end('data: {"choices":[{"delta":{"content":"Xin chào từ AI thử nghiệm."}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(temp, 'data'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'data', 'support-gateway.json'), JSON.stringify({ url: 'local' }));
  const exe = process.argv[3];
  server = spawn(exe ? path.resolve(exe) : process.execPath, exe ? ['--test-server'] : ['src/server.js', '--test-server'], { cwd: root, env: { ...process.env, HOADON_TEST_DATA: path.join(temp, 'data'), HOADON_NO_UPDATE_CHECK: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', chunk => { stdout += chunk; });
  server.stderr.on('data', chunk => { stdout += chunk; });
  const config = await until(async () => { const line = stdout.split(/\r?\n/).find(line => line.startsWith('{"testUrl"')); return line ? JSON.parse(line) : null; }, 'test server');
  const denied = await fetch(new URL('/api/ai/providers', config.testUrl)); assert.equal(denied.status, 403);
  chrome = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => Number(fs.readFileSync(path.join(temp, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]), 'Chrome');
  const target = await CDP.New({ port, url: 'about:blank' }); client = await CDP({ port, target });
  await client.Page.enable(); await client.Runtime.enable();
  const errors = []; client.Runtime.exceptionThrown(event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  await client.Page.addScriptToEvaluateOnNewDocument({ source: "window.aiCspErrors=[];window.aiFixtureReplies=[];addEventListener('message',e=>{if(e.data?.type==='fixture-results')window.aiFixtureReplies=e.data.replies});document.addEventListener('securitypolicyviolation',e=>window.aiCspErrors.push(e.violatedDirective))" });
  let iframeRequests = 0;
  client.Fetch.requestPaused(async event => {
    iframeRequests++;
    const fixture = `<html><body><h2>AI web thử nghiệm</h2><script>
      window.replies=[];addEventListener('message',e=>{if(e.data.type==='storageResponse'){replies.push(e.data);parent.postMessage({type:'fixture-results',replies},'*')}});
      for(const key of ['savedChats-v1','fpHash-v1','token'])parent.postMessage({type:'storageRequest',operation:'get',key,messageId:key},'*');
      parent.postMessage({type:'pageContentRequest',messageId:'page'},'*');
    </script></body></html>`;
    await client.Fetch.fulfillRequest({ requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(fixture).toString('base64') });
  });
  await client.Fetch.enable({ patterns: [{ urlPattern: 'https://*.easytool.dev/*' }] });
  await client.Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.Page.navigate({ url: config.testUrl });
  await until(() => evaluate("!!document.getElementById('support-toggle').onclick && typeof window.AiBridge === 'object'"), 'support loaded');
  await click('support-toggle');
  await until(() => evaluate("document.querySelectorAll('[data-provider]').length===3"), 'modes');
  assert.equal(await evaluate("document.body.classList.contains('chat-open')"), true);
  const supportBounds = await evaluate("(()=>{const r=document.getElementById('support-panel').getBoundingClientRect();return {height:r.height,top:r.top,right:r.right,width:r.width}})()");
  assert.equal(supportBounds.height, 900); assert.equal(supportBounds.top, 0); assert.equal(supportBounds.right, await evaluate('document.documentElement.clientWidth'));
  const initialHandle = await evaluate("(()=>{const r=document.getElementById('chat-resize').getBoundingClientRect();return {x:r.left+3,y:160}})()");
  await until(() => evaluate(`document.elementFromPoint(${initialHandle.x},${initialHandle.y})===document.getElementById('chat-resize')`), 'resize handle accessible');
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: initialHandle.x, y: initialHandle.y, button: 'left', clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: initialHandle.x - 100, y: initialHandle.y, button: 'left', buttons: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: initialHandle.x - 100, y: initialHandle.y, button: 'left', clickCount: 1 });
  assert.equal(await evaluate("Number(document.getElementById('chat-resize').getAttribute('aria-valuenow'))>420 && !document.body.classList.contains('chat-resizing')"), true);
  assert.equal(await evaluate("document.querySelector('main').getBoundingClientRect().right<=document.getElementById('support-panel').getBoundingClientRect().left+1"), true, 'main must not sit underneath chat');
  await click('chat-minimize'); await until(() => evaluate("!document.body.classList.contains('chat-open')"), 'minimized');
  await click('support-toggle'); await until(() => evaluate("document.body.classList.contains('chat-open')"), 'restored dock');
  await evaluate("document.querySelector('[data-mode=web-deepseek-ai]').click()");
  await until(() => evaluate("document.getElementById('support-panel').classList.contains('is-ai')"), 'web mode');
  assert.equal(await evaluate("document.getElementById('support-panel').getBoundingClientRect().height"), supportBounds.height);
  await until(async () => iframeRequests > 0, 'web frame');
  await until(() => evaluate('window.aiFixtureReplies.length===3'), 'bridge replies');
  const replies = await evaluate('window.aiFixtureReplies');
  assert.deepEqual(replies.map(row => row.messageId).sort(), ['fpHash-v1', 'savedChats-v1', 'token']);
  assert.ok(replies.every(row => row.value === null));
  await click('support-close'); assert.equal(await evaluate("document.getElementById('support-panel').hidden"), true);
  await click('support-toggle'); assert.equal(iframeRequests, 1, 'closing panel must retain frame');
  await evaluate("document.querySelector('[data-mode=support]').click()");
  await until(() => evaluate("!document.getElementById('support-form').hidden"), 'support restored');
  await click('ai-add'); await until(() => evaluate("document.getElementById('ai-provider-dialog').open"), 'editor');
  await evaluate(`document.getElementById('ai-provider-label').value='AI trên máy thử nghiệm';document.getElementById('ai-provider-type').value='local';document.getElementById('ai-provider-type').dispatchEvent(new Event('change'));document.getElementById('ai-provider-url').value='http://127.0.0.1:${upstream.address().port}/v1';document.getElementById('ai-provider-model').value='fixture'`);
  await click('ai-models'); await until(() => evaluate("document.getElementById('ai-model-list').children.length===1"), 'models');
  await click('ai-provider-save'); await until(() => evaluate("!document.getElementById('ai-form').hidden && !document.getElementById('ai-provider-dialog').open"), 'local mode');
  await evaluate("document.getElementById('ai-input').value='Xin chào';document.getElementById('ai-send').click()");
  await until(() => evaluate("document.getElementById('ai-thread').textContent.includes('Xin chào từ AI thử nghiệm.') && !document.getElementById('ai-send').disabled"), 'stream');
  const screenshotDir = process.argv[2];
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); fs.writeFileSync(path.join(screenshotDir, 'ai-desktop.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64')); }
  await client.Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("(()=>{const r=document.getElementById('support-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), 'narrow dock bounds');
  if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'ai-mobile.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
  await evaluate("document.querySelector('[data-mode=support]').click()");
  await until(() => evaluate("!document.getElementById('support-form').hidden"), 'support restored again');
  await click('support-close'); assert.equal(await evaluate("document.getElementById('support-panel').hidden"), true);
  assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.aiCspErrors'), []);
  console.log('PASS: authenticated AI routes, web bridge, retained iframe, provider editor, models, real local SSE, shared right dock, drag resizing, minimize/restore, unobscured main, narrow window and clean console');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (client) { await client.Browser.close().catch(() => {}); await client.close().catch(() => {}); }
  if (chrome?.exitCode === null) chrome.kill(); if (server?.exitCode === null) server.kill();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await wait(500); try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
