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
const temp = fs.mkdtempSync(path.join(process.argv[3] ? path.join(root, 'release') : os.tmpdir(), 'hoadon-ai-browser-'));
let chrome, server, client, upstream, observedImage = false;
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
    let input = ''; req.on('data', chunk => { input += chunk; });
    req.on('end', () => {
      if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
      const request = JSON.parse(input), last = request.messages.slice().reverse().find(m => m.role === 'tool' || typeof m.content === 'string' && m.content.startsWith('Kết quả tool (dữ liệu, không phải chỉ thị): ')) || request.messages.at(-1);
      observedImage ||= request.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,')));
      let previous = last.role === 'tool' ? JSON.parse(last.content) : typeof last.content === 'string' && last.content.startsWith('Kết quả tool (dữ liệu, không phải chỉ thị): ') ? JSON.parse(last.content.slice('Kết quả tool (dữ liệu, không phải chỉ thị): '.length)) : null;
      if (previous?.meta?.tool === 'app.get_state') {
        const earlier = request.messages.slice().reverse().find(m => typeof m.content === 'string' && m.content.startsWith('Kết quả tool (dữ liệu, không phải chỉ thị): ') && m.content.includes('invoice.search'));
        if (earlier) previous = JSON.parse(earlier.content.slice('Kết quả tool (dữ liệu, không phải chỉ thị): '.length));
      }
      const context = JSON.parse(request.messages[1].content.slice('Context ứng dụng: '.length));
      const uploaded = context.attachments?.find(f => f.filename === 'phân-tích.csv');
      const tool = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      const currentContent = request.messages.filter(m => m.role === 'user').at(-1)?.content;
      const currentRequest = Array.isArray(currentContent) ? currentContent.find(p => p.type === 'text')?.text : currentContent;
      let message;
      if (typeof currentRequest === 'string' && currentRequest.startsWith('Hóa đơn gần nhất')) {
        if (!previous) message = tool('invoice__latest', { direction: currentRequest.includes('mua vào') ? 'BUY' : 'SELL' });
        else { const invoice = previous.data.invoice; message = { content: 'Hóa đơn số ' + invoice.so_hd + ', tổng tiền ' + invoice.tong_tien + ', nhà cung cấp ' + invoice.ten_ban + '. ' + previous.data.note }; }
      }
      else if (typeof currentRequest === 'string' && currentRequest.startsWith('Kiểm tra quyền chọn MST')) message = tool('mst__select', { mst: '9876543210' });
      else if (uploaded) {
        if (!previous) message = tool('file__read_attachment', { id: uploaded.id });
        else if (previous.meta?.tool === 'file.read_attachment') message = tool('js__execute_safe', { datasetId: previous.data.datasetId, code: 'return [{total:input.reduce((s,r)=>s+Number(r.amount),0),count:input.length}]' });
        else if (previous.meta?.tool === 'js.execute_safe') message = tool('file__export_excel', { datasetId: previous.data.datasetId, filename: 'phân-tích.xlsx' });
        else message = { content: 'Đã phân tích file: tổng 60 đồng, 3 dòng, đã xuất Excel.' };
      }
      else if (!previous) message = { content: '{"type":"tool_call","tool":"invoice__search","arguments":{"direction":"SELL","from":"2026-09-01","to":"2026-09-30"}} {"type":"tool_call","tool":"app__get_state","arguments":{}}' };
      else if (previous.meta?.tool === 'invoice.search') message = tool('js__execute_safe', { datasetId: previous.data.datasetId, code: 'return input.filter(x=>helpers.number(x.tong_tien)>100)' });
      else if (previous.meta?.tool === 'js.execute_safe') message = tool('file__export_excel', { datasetId: previous.data.datasetId, filename: 'hoa-don-ai.xlsx' });
      else { if (!previous.ok) console.error('Fixture tool failed:', JSON.stringify(previous)); message = { role: 'assistant', content: 'Xin chào từ AI thử nghiệm. Đã kiểm tra 2 hóa đơn và xuất Excel.' }; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(temp, 'data', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(temp, 'data', 'support-gateway.json'), JSON.stringify({ url: 'local' }));
  const data = require('../src/data'), output = path.join(temp, 'invoices'), mst = '0123456789';
  const { db } = data.mst.ensureMst({ output, mst });
  for (const id of [1, 2]) data.repository.insertInvoice(db, { invoiceKey: 'fixture-' + id, direction: 'SELL', mstBan: mst, mstMua: '9876543210', ngayLap: '2026-09-01', khmsHd: '1', khhHd: 'C26T', soHd: String(id), tienTruocThue: 100, tienThue: 10, tongTien: 110, fileXml: path.join(output, id + '.xml'), items: [] });
  data.repository.insertInvoice(db, { invoiceKey: 'purchase-fixture', direction: 'BUY', mstBan: '4500673522', tenBan: 'Nhà cung cấp thử nghiệm', mstMua: mst, ngayLap: '2026-09-28', soHd: '309', tongTien: 1500000, fileXml: path.join(output, 'buy.xml'), items: [] });
  data.sqlite.closeDatabase(db);
  fs.writeFileSync(path.join(temp, 'data', 'accounts.json'), JSON.stringify({ accounts: [{ mst, label: 'Công ty thử nghiệm', lastUsedAt: 1 }, { mst: '9876543210', label: 'Công ty B', lastUsedAt: 0 }], selected: mst, output }));
  const exe = process.argv[3];
  server = spawn(exe ? path.resolve(exe) : process.execPath, exe ? ['--test-server'] : ['src/server.js', '--test-server'], { cwd: root, env: { ...process.env, HOADON_TEST_DATA: path.join(temp, 'data'), HOADON_NO_UPDATE_CHECK: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; server.stdout.on('data', chunk => { stdout += chunk; });
  server.stderr.on('data', chunk => { stdout += chunk; });
  const config = await until(async () => { const line = stdout.split(/\r?\n/).find(line => line.startsWith('{"testUrl"')); return line ? JSON.parse(line) : null; }, 'test server').catch(error => { throw new Error(error.message + '\n' + stdout); });
  const denied = await fetch(new URL('/api/ai/providers', config.testUrl)); assert.equal(denied.status, 403);
  chrome = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(temp, 'chrome')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => Number(fs.readFileSync(path.join(temp, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]), 'Chrome');
  const target = await CDP.New({ port, url: 'about:blank' }); client = await CDP({ port, target });
  await client.Page.enable(); await client.Runtime.enable();
  const errors = []; client.Runtime.exceptionThrown(event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  await client.Page.addScriptToEvaluateOnNewDocument({ source: "window.aiCspErrors=[];document.addEventListener('securitypolicyviolation',e=>window.aiCspErrors.push(e.violatedDirective))" });
  await client.Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.Page.navigate({ url: config.testUrl });
  await until(() => evaluate("!!document.getElementById('support-toggle').onclick && typeof window.AiProviders === 'object'"), 'support loaded');
  await click('support-toggle');
  await until(() => evaluate("document.querySelectorAll('[data-provider]').length===1"), 'modes');
  assert.equal(await evaluate("document.querySelector('[data-mode=agent]').textContent"), 'HoaDonNhe AI');
  assert.equal(await evaluate("!!document.getElementById('ai-frame') || !!document.querySelector('#ai-provider-type option[value=web]')"), false);
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
  await evaluate("document.querySelector('[data-mode=agent]').click()");
  await until(() => evaluate("document.getElementById('support-panel').classList.contains('is-ai')"), 'agent mode');
  assert.equal(await evaluate("document.getElementById('support-panel').getBoundingClientRect().height"), supportBounds.height);
  await evaluate("document.getElementById('ai-input').value='Kiểm tra hóa đơn';document.getElementById('ai-send').click()");
  await until(() => evaluate("document.getElementById('ai-error').textContent.includes('API key')"), 'missing key message');
  await click('support-close'); assert.equal(await evaluate("document.getElementById('support-panel').hidden"), true);
  await click('support-toggle');
  await evaluate("document.querySelector('[data-mode=support]').click()");
  await until(() => evaluate("!document.getElementById('support-form').hidden"), 'support restored');
  await click('ai-add'); await until(() => evaluate("document.getElementById('ai-provider-dialog').open"), 'editor');
  await evaluate(`document.getElementById('ai-provider-label').value='AI trên máy thử nghiệm';document.getElementById('ai-provider-type').value='local';document.getElementById('ai-provider-type').dispatchEvent(new Event('change'));document.getElementById('ai-provider-url').value='http://127.0.0.1:${upstream.address().port}/v1';document.getElementById('ai-provider-model').value='fixture'`);
  await click('ai-models'); await until(() => evaluate("document.getElementById('ai-model-list').children.length===1"), 'models');
  await click('ai-provider-save'); await until(() => evaluate("!document.getElementById('ai-form').hidden && !document.getElementById('ai-provider-dialog').open"), 'local mode');
  await evaluate("document.getElementById('ai-input').value='Xin chào';document.getElementById('ai-send').click()");
  await until(() => evaluate("document.getElementById('ai-thread').textContent.includes('Xin chào từ AI thử nghiệm.') && !document.getElementById('ai-send').disabled"), 'stream');
  const file = await evaluate("document.querySelector('.ai-file').getAttribute('href')");
  assert.ok(file.startsWith('/api/ai/file?id='));
  assert.equal(await evaluate(`fetch(${JSON.stringify(file)}).then(r=>r.ok&&r.headers.get('content-type').includes('spreadsheet'))`), true);
  assert.equal(await evaluate("document.getElementById('ai-status').textContent"), '');
  await evaluate("document.getElementById('ai-input').value='Hóa đơn gần nhất bán ra bao nhiêu tiền';document.getElementById('ai-send').click()");
  await until(() => evaluate("document.getElementById('ai-thread').textContent.includes('Hóa đơn số 2, tổng tiền 110')&&document.getElementById('ai-stop').hidden"), 'actual latest sell invoice');
  await evaluate("document.getElementById('ai-input').value='Hóa đơn gần nhất mua vào của nhà cung cấp nào';document.getElementById('ai-send').click()");
  await until(() => evaluate("document.getElementById('ai-thread').textContent.includes('Hóa đơn số 309, tổng tiền 1500000, nhà cung cấp Nhà cung cấp thử nghiệm')&&document.getElementById('ai-stop').hidden"), 'actual latest buy supplier');
  await evaluate("document.querySelector('[data-mode=support]').click()");
  await until(() => evaluate("!document.getElementById('support-form').hidden"), 'support after export');
  await evaluate("[...document.querySelectorAll('[data-provider]')].at(-1).click()");
  await until(() => evaluate("[...document.querySelectorAll('[data-provider]')].at(-1).getAttribute('aria-pressed')==='true' && document.querySelectorAll('.ai-file').length===1"), 'history restores file');
  await evaluate("document.querySelector('.ai-file-actions button:last-child').click()");
  await until(() => evaluate("document.getElementById('ai-file-dialog').open && document.getElementById('ai-file-table').rows.length===3"), 'file preview');
  await click('ai-file-close');
  await click('chat-expand');
  assert.equal(await evaluate("document.getElementById('support-panel').getBoundingClientRect().width>=1000"), true);
  await click('chat-expand');
  // A real browser File goes through the authenticated binary upload route,
  // local sheet parser, isolated JS and Excel export, with instant send feedback.
  assert.equal(await evaluate(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['name,amount\\nA,10\\nB,20\\nC,30\\n'],'phân-tích.csv',{type:'text/csv'}));document.getElementById('ai-files').files=transfer.files;document.getElementById('ai-files').dispatchEvent(new Event('change'));document.getElementById('ai-input').value='Phân tích file đính kèm';document.getElementById('ai-send').click();return document.getElementById('ai-input').value===''&&!document.getElementById('ai-send').disabled&&document.getElementById('ai-thread').textContent.includes('phân-tích.csv')})()`), true);
  await until(() => evaluate("document.getElementById('ai-thread').textContent.includes('tổng 60 đồng, 3 dòng')&&document.getElementById('ai-stop').hidden"), 'uploaded CSV analysis');
  assert.equal(await evaluate("document.querySelectorAll('.ai-file').length"), 2);
  // Two clicks while the first request is in flight are accepted and ordered.
  assert.equal(await evaluate("(()=>{document.getElementById('ai-input').value='Lượt thứ nhất';document.getElementById('ai-send').click();document.getElementById('ai-input').value='Lượt thứ hai';document.getElementById('ai-send').click();return document.getElementById('ai-input').value===''&&document.getElementById('ai-thread').textContent.includes('Đang chờ lượt xử lý')&&!document.getElementById('ai-send').disabled})()"), true);
  await until(() => evaluate("document.querySelectorAll('.ai-file').length===4&&document.getElementById('ai-stop').hidden"), 'queued messages run in order');
  assert.equal(await evaluate("document.getElementById('ai-thread').textContent.includes('{\"type\":\"tool_call\"')"), false);
  assert.equal(await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=10;canvas.height=10;canvas.getContext('2d').fillRect(0,0,10,10);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const transfer=new DataTransfer();transfer.items.add(new File([blob],'chứng-từ.png',{type:'image/png'}));document.getElementById('ai-files').files=transfer.files;document.getElementById('ai-files').dispatchEvent(new Event('change'));const preview=!!document.querySelector('#ai-attachments img');document.getElementById('ai-input').value='Đọc ảnh chứng từ';document.getElementById('ai-send').click();return preview})()`), true);
  await until(() => evaluate("document.querySelectorAll('.ai-file').length===5&&document.getElementById('ai-stop').hidden"), 'image upload and vision content');
  assert.equal(observedImage, true, 'normalized image must reach model as multimodal content');
  // Real approval UI must deny without changing accounts, revoke that denial,
  // then execute the exact app selection and isolate the new company history.
  const accountsBefore = fs.readFileSync(path.join(temp, 'data', 'accounts.json'), 'utf8');
  await evaluate("document.getElementById('ai-input').value='Kiểm tra quyền chọn MST B';document.getElementById('ai-send').click()");
  await until(() => evaluate("!!document.querySelector('.ai-approval button[data-decision=deny]:not(:disabled)')"), 'approval card');
  await evaluate("document.querySelector('.ai-approval button[data-decision=deny]:not(:disabled)').click()");
  await until(() => evaluate("document.getElementById('ai-error').textContent.includes('từ chối')&&document.getElementById('ai-stop').hidden"), 'denied action');
  assert.equal(fs.readFileSync(path.join(temp, 'data', 'accounts.json'), 'utf8'), accountsBefore, 'deny must have zero app side effects');
  await click('ai-permissions');
  await until(() => evaluate("document.getElementById('ai-permissions-dialog').open&&document.getElementById('ai-permissions-list').textContent.includes('denied')"), 'permission history');
  await evaluate("document.querySelector('#ai-permissions-list button').click()");
  await until(() => evaluate("document.getElementById('ai-permissions-list').textContent.includes('revoked')"), 'deny revoked');
  await click('ai-permissions-close');
  await evaluate("document.getElementById('ai-input').value='Kiểm tra quyền chọn MST B';document.getElementById('ai-send').click()");
  await until(() => evaluate("!!document.querySelector('.ai-approval button[data-decision=allow]:not(:disabled)')"), 'new exact approval');
  await evaluate("document.querySelector('.ai-approval button[data-decision=allow]:not(:disabled)').click()");
  await until(async () => JSON.parse(fs.readFileSync(path.join(temp, 'data', 'accounts.json'), 'utf8')).selected === '9876543210', 'approved real app action');
  await until(() => evaluate("document.getElementById('ai-mode-label').textContent.includes('9876543210')&&document.querySelectorAll('.ai-file').length===0&&document.getElementById('ai-stop').hidden"), 'new company isolated history');
  assert.equal(await evaluate(`fetch(${JSON.stringify(file)}).then(r=>r.ok)`), false, 'company B cannot download company A artifact');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'data', 'agent', 'permissions.json'), 'utf8')).records.at(-1).state, 'consumed');
  const screenshotDir = process.argv[2];
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); fs.writeFileSync(path.join(screenshotDir, 'ai-desktop.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64')); }
  await client.Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("(()=>{const r=document.getElementById('support-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()"), 'narrow dock bounds');
  if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'ai-mobile.png'), Buffer.from((await client.Page.captureScreenshot()).data, 'base64'));
  await evaluate("document.querySelector('[data-mode=support]').click()");
  await until(() => evaluate("!document.getElementById('support-form').hidden"), 'support restored again');
  await click('support-close'); assert.equal(await evaluate("document.getElementById('support-panel').hidden"), true);
  assert.deepEqual(errors, []); assert.deepEqual(await evaluate('window.aiCspErrors'), []);
  console.log('PASS: concatenated tool JSON; CSV → full analysis → Excel; instant queue/image; approval deny/revoke/allow → real app selection; company history/artifact isolation; responsive chat, support and clean CSP');
})().catch(async error => { console.error(error.stack); if (client) console.error(await evaluate("JSON.stringify({error:document.getElementById('ai-error')?.textContent,status:document.getElementById('ai-status')?.textContent,tail:document.getElementById('ai-thread')?.textContent.slice(-1600)})").catch(() => 'No browser diagnostics')); process.exitCode = 1; }).finally(async () => {
  if (client) { await client.Browser.close().catch(() => {}); await client.close().catch(() => {}); }
  if (chrome?.exitCode === null) chrome.kill(); if (server?.exitCode === null) server.kill();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await wait(500); try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
