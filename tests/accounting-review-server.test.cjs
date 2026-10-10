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
      await run(`document.getElementById('view-accounting').click()`);
      await until(`!!window.InvoiceReplacementUI && document.getElementById('ir-new-date').value`);
      assert.equal(await run(`!document.getElementById('pane-accounting').hidden && !!document.getElementById('ir-workbench') && document.querySelector('#pane-accounting .feature-workbench').hidden`), true);
      const XLSX = require('../resources/xlsx.cjs');
      function replacementFile(headers, rows) { const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([headers,...rows]),'Dữ liệu');return Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'})).toString('base64'); }
      const issued=replacementFile(['Ký hiệu','Số hóa đơn','Ngày hóa đơn','Tên hàng','Số lượng','Đơn giá','Thành tiền','Thuế suất','Tiền thuế GTGT','Tổng tiền TT','Trạng thái HĐ','Tên khách hàng','Hình thức TT'],[['1C26ABC','00000123','01/07/2026','Sữa',2,50000,100000,10,10000,110000,'Hoá đơn mới','Khách kiểm thử','TM/CK'],['1C26ABC','00000123','01/07/2026','Chưa đối chiếu',1,50000,50000,10,5000,55000,'Hoá đơn mới','Khách kiểm thử','TM/CK']]);
      const comparison=replacementFile(['Số hóa đơn','Ngày hóa đơn','Mặt hàng','Doanh số bán chưa có thuế GTGT','Thuế suất'],[['00000123','01/07/2026','Sữa',100000,8]]);
      await run(`document.querySelector('[data-ir-help="files"]').click()`);
      assert.equal(await run(`document.getElementById('ir-help-dialog').open && !document.getElementById('ir-help-image').hidden`),true);
      await run(`document.getElementById('ir-help-close').click();const transfer=new DataTransfer();for(const [name,b64] of ${JSON.stringify([['random-b.xlsx',comparison],['random-a.xlsx',issued]])})transfer.items.add(new File([Uint8Array.from(atob(b64),c=>c.charCodeAt(0))],name));document.getElementById('ir-files').files=transfer.files;document.getElementById('ir-files').dispatchEvent(new Event('change'));`);
      await until(`!document.getElementById('ir-results').hidden && !document.getElementById('ir-export').disabled`);
      assert.equal(await run(`document.getElementById('ir-stats').textContent.includes('1 hóa đơn lệch') && document.getElementById('ir-rows').textContent.includes('xác nhận giữ nguyên')`),true);
      await run(`document.querySelector('[data-detail]').click()`);
      await until(`document.getElementById('ir-detail-dialog').open`);
      assert.equal(await run(`document.getElementById('ir-detail-lines').textContent.includes('Chưa đối chiếu') && !document.getElementById('ir-keep-label').hidden`),true);
      await run(`document.getElementById('ir-confirm-keep').checked=true;document.getElementById('ir-detail-save').click()`);
      await until(`!document.getElementById('ir-detail-dialog').open && document.getElementById('ir-rows').textContent.includes('Đủ điều kiện xuất')`);
      await run(`document.getElementById('ir-select-page').checked=true;document.getElementById('ir-select-page').dispatchEvent(new Event('change'));`);
      assert.equal(await run(`document.querySelector('[data-select]').checked`),true);
      fs.mkdirSync(path.resolve(__dirname,'../artifacts'),{recursive:true});
      fs.writeFileSync(path.resolve(__dirname,'../artifacts/replacement-workbench.png'),Buffer.from((await client.Page.captureScreenshot()).data,'base64'));
      await run(`document.getElementById('ir-mapping').open=true;const el=document.querySelector('[data-field="number"]');el.dispatchEvent(new Event('change',{bubbles:true}));`);
      await until(`document.getElementById('ir-results').hidden`);
      await run(`document.getElementById('ir-process').click()`);
      await until(`!document.getElementById('ir-results').hidden && !document.getElementById('ir-process').disabled`);
      assert.equal(await run(`document.getElementById('ir-rows').textContent.includes('xác nhận giữ nguyên')`),true);
      await run(`document.getElementById('ir-files').dispatchEvent(new Event('change'));`);
      await until(`!document.getElementById('ir-stop').disabled`);
      await run(`document.getElementById('ir-stop').click()`);
      await until(`document.getElementById('ir-message').textContent.includes('Đã dừng') && document.getElementById('ir-results').hidden && document.getElementById('ir-stop').disabled`);
      await run(`document.getElementById('ir-files').dispatchEvent(new Event('change'));`);
      await until(`!document.getElementById('ir-results').hidden && !document.getElementById('ir-export').disabled`);
      assert.equal(await run(`document.getElementById('ir-rows').textContent.includes('xác nhận giữ nguyên')`),true);
      const width=await run(`({workbench:document.getElementById('ir-workbench').getBoundingClientRect().width,pane:document.getElementById('pane-accounting').getBoundingClientRect().width})`);assert.ok(Math.abs(width.workbench-width.pane)<2,'replacement workbench spans the available pane');
      await run(`document.getElementById('ir-mapping').open=true;const column=document.querySelector('[data-field="number"]');window.__replacementNumberColumn=column.value;column.value='';column.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('ir-process').click();`);
      await until(`document.getElementById('ir-message').textContent.includes('Thiếu cột bắt buộc') && !document.getElementById('ir-process').disabled`);
      await run(`const column2=document.querySelector('[data-field="number"]');column2.value=window.__replacementNumberColumn;column2.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('ir-process').click();`);
      await until(`!document.getElementById('ir-results').hidden && !document.getElementById('ir-process').disabled`);
      const schema=await call('/api/invoice-replacement/schema');assert.equal(schema.status,200);assert.ok(schema.value.roles.ledger);
      for(const route of ['/replacement-input-guide.svg','/replacement-mapping-guide.svg','/replacement-output-guide.svg'])assert.equal((await fetch(new URL(route,base),{headers:{Cookie:cookie}})).status,200);
      const upload=await call('/api/invoice-replacement/upload','POST',{files:[{name:'a.xlsx',dataBase64:issued},{name:'b.xlsx',dataBase64:comparison}]},'0402335623');assert.equal(upload.status,200);
      let replacement=upload.value;
      for(let i=0;i<100;i++){replacement=(await call('/api/invoice-replacement/progress?jobId='+upload.value.jobId)).value;if(replacement.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(replacement.state,'mapping');assert.ok(replacement.selections);
      const mapped=await call('/api/invoice-replacement/process','POST',{jobId:replacement.jobId,revision:replacement.revision,selections:replacement.selections,save:true});assert.equal(mapped.status,200);const revision=mapped.value.revision;assert.equal(revision,replacement.revision+1);
      assert.equal((await call('/api/invoice-replacement/confirm','POST',{jobId:replacement.jobId,revision:replacement.revision,invoiceId:'invoice-0',keep:true})).status,400);
      const current={jobId:replacement.jobId,revision};
      const blocked=await fetch(new URL('/api/invoice-replacement/export',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...current,ids:['invoice-0']})});assert.equal(blocked.status,400);assert.match((await blocked.json()).error,/xác nhận giữ nguyên/);
      assert.equal((await call('/api/invoice-replacement/confirm','POST',{...current,invoiceId:'invoice-0',keep:true})).status,200);
      const exported=await fetch(new URL('/api/invoice-replacement/export',base),{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({...current,ids:['invoice-0']})});assert.equal(exported.status,200);const exportedBook=XLSX.read(Buffer.from(await exported.arrayBuffer()),{type:'buffer'});assert.equal(exportedBook.Sheets[exportedBook.SheetNames[0]].M10.v,'00000123');
      const invalidated=await call('/api/invoice-replacement/invalidate','POST',current);assert.equal(invalidated.value.revision,revision+1);assert.equal((await call('/api/invoice-replacement/detail?'+new URLSearchParams({...current,invoiceId:'invoice-0'}))).status,400);
      assert.ok(fs.existsSync(path.join(runtime,'invoice-replacement-mappings.json')));
      const profiles=JSON.parse(fs.readFileSync(path.join(runtime,'invoice-replacement-mappings.json'),'utf8'));assert.ok(Object.values(profiles).every(c=>c.fingerprint&&c.fields.number!=null));
      const preview=await call('/api/invoice-replacement/preview','POST',{jobId:replacement.jobId,revision:revision+1,index:0,choice:{sheet:'Dữ liệu',start:0,depth:1,role:'issued'}});assert.equal(preview.status,200);assert.equal(preview.value.choice.fields.number,1);assert.equal(preview.value.saved.fields.number,1);
      assert.equal((await call('/api/invoice-replacement/stop','POST',{jobId:replacement.jobId,revision:revision+1})).value.state,'cancelled');
      const originalDb=require('../src/data/sqlite').openDatabase(path.join(dir,'data.db'));assert.equal(originalDb.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,1);require('../src/data/sqlite').closeDatabase(originalDb);
      for (const tab of ['dvt']) {
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
