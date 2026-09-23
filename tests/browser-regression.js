'use strict';
// Real-Chrome regression tests for the local UI and the login DOM adapter.
// Uses an empty temporary profile and a synthetic login fixture, never a tax account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { browserPath } = require('../src/browser');
const { taxLoginAction } = require('../src/tax-login');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-login-regression-'));
let chrome, server, client, fixtureClient;
async function until(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn().catch(() => null); if (value) return value; await wait(100); } throw new Error('Timeout: ' + label); }
async function evaluate(connection, expression) { const reply = await connection.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text); return reply.result.value; }
async function newPage(port, url) { const target = await CDP.New({ port, url }); const connection = await CDP({ port, target }); await until(() => evaluate(connection, 'document.readyState === "complete"'), 'page ready'); return connection; }
function get(url, headers = {}) { return new Promise((resolve, reject) => { http.get(url, { headers }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); }).on('error', reject); }); }
(async () => {
  const exe = process.argv[2];
  server = spawn(exe ? path.resolve(exe) : process.execPath, exe ? ['--test-server'] : [path.join(__dirname, '../src/server.js'), '--test-server'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HOADON_TEST_DATA: path.join(temp, 'data') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let serverError = ''; server.stdout.on('data', b => { stdout += b; }); server.stderr.on('data', b => { serverError += b; });
  const config = await until(async () => { const line = stdout.split(/\r?\n/).find(x => x.startsWith('{')); return line ? JSON.parse(line) : null; }, 'test server: ' + serverError);
  const origin = new URL(config.testUrl).origin;
  assert.equal(await get(origin + '/api/state'), 403, 'API must reject requests without application session');
  chrome = spawn(browserPath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(temp, 'chrome')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const port = await until(async () => Number(fs.readFileSync(path.join(temp, 'chrome', 'DevToolsActivePort'), 'utf8').split('\n')[0]), 'Chrome debug port');
  client = await newPage(port, config.testUrl);
  await until(() => evaluate(client, 'typeof openLogin === "function"'), 'renderer loaded');
  await evaluate(client, "window.cspErrors=[];document.addEventListener('securitypolicyviolation',e=>window.cspErrors.push(e.violatedDirective))");
  assert.equal((await evaluate(client, "call('/api/state')")).state, 'idle');
  assert.deepEqual(await evaluate(client, 'window.cspErrors'), [], 'browser fetch must pass CSP');
  console.log('PASS: real Chrome fetch under production CSP + authenticated local session');
  const cookies = await client.Network.getCookies({ urls: [origin] });
  const cookie = cookies.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  assert.equal(await get(origin + '/api/state', { Cookie: cookie, Origin: 'https://untrusted.example' }), 403);
  // Nút mở form đăng nhập (#account-login) chỉ chạy khi đã chọn MST; test này kiểm trạng thái
  // BAN ĐẦU của form (chỉ MST, chưa hiện ô mật khẩu) nên gọi thẳng đúng hàm mà nút đó gọi.
  await evaluate(client, "openLogin('')");
  assert(await evaluate(client, "document.getElementById('login-dialog').open && document.getElementById('login-mst').getClientRects().length>0 && document.getElementById('login-credentials').hidden"));
  console.log('PASS: login starts with MST only and keeps credentials hidden until CAPTCHA is ready');
  const png = await evaluate(client, "(()=>{let c=document.createElement('canvas');c.width=160;c.height=50;let x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,160,50);x.fillStyle='black';x.font='26px sans-serif';x.fillText('TEST',16,34);return c.toDataURL()})()");
  let submits = 0, prepares = 0, shows = 0;
  client.Fetch.requestPaused(async event => {
    const route = new URL(event.request.url).pathname;
    if (route.endsWith('/login')) prepares++;
    if (route.endsWith('/show')) { shows++; assert.equal(JSON.parse(event.request.postData).mst, '0000000000'); }
    let value = { mst: '0000000000', ready: true, authenticated: false, captcha: png, loginId: 'test-challenge', error: '' };
    if (route.endsWith('/submit')) {
      const input = JSON.parse(event.request.postData);
      assert.equal(input.username, 'test-user'); assert.equal(input.password, 'dummy-not-a-secret'); assert.equal(input.captcha, 'TEST');
      submits++;
      value = submits === 1 ? { ...value, loginId: 'test-retry', error: 'Sai mật khẩu (dữ liệu thử nghiệm).' } : { authenticated: true, account: { mst: '0000000000' } };
    }
    await client.Fetch.fulfillRequest({ requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ ok: true, value })).toString('base64') });
  });
  await client.Fetch.enable({ patterns: [{ urlPattern: '*/api/account/login' }, { urlPattern: '*/api/account/submit' }, { urlPattern: '*/api/account/captcha' }, { urlPattern: '*/api/account/show' }] });
  await evaluate(client, "document.getElementById('login-mst').value='0000000000';loginBusy(true);document.getElementById('login-show-page').click()");
  await until(async () => shows === 1, 'manual browser button works while CAPTCHA is pending');
  assert.equal(prepares, 0, 'manual browser button must not wait for CAPTCHA');
  await evaluate(client, 'loginBusy(false)');
  console.log('PASS: manual tax window opens independently of CAPTCHA');
  await evaluate(client, "document.getElementById('login-mst').value='0000000000';document.getElementById('login-prepare').click()");
  await until(() => evaluate(client, "!document.getElementById('login-submit').disabled && !document.getElementById('login-credentials').hidden && document.getElementById('login-captcha-image').naturalWidth>0"), 'CAPTCHA rendered');
  const screenshot = await client.Page.captureScreenshot({ format: 'png' });
  fs.writeFileSync(path.join(__dirname, '../login-regression.png'), Buffer.from(screenshot.data, 'base64'));
  await evaluate(client, "document.getElementById('login-user').value='test-user';document.getElementById('login-password').value='dummy-not-a-secret';document.getElementById('login-captcha').value='TEST';document.getElementById('login-submit').click()");
  await until(() => evaluate(client, "!document.getElementById('login-error').hidden && document.getElementById('login-error').textContent.includes('Sai mật khẩu')"), 'server login error');
  assert(await evaluate(client, "document.getElementById('login-dialog').open"));
  await evaluate(client, "document.getElementById('login-captcha').value='TEST';document.getElementById('login-submit').click()");
  await until(() => evaluate(client, "!document.getElementById('login-dialog').open && document.getElementById('login-password').value === ''"), 'login success');
  console.log('PASS: CAPTCHA image, form submission, inline failure, retry and password clearing');
  await client.Fetch.disable();

  // A synthetic tax DOM checks the actual adapter from login.js, including duplicate hidden forms.
  const fixture = '<html><body><header><button id="open">Đăng nhập</button></header><form style="display:none"><input id="username"><input id="password"><input id="cvalue"></form><form id="live" hidden><input id="username"><input id="password" type="password"><img alt="captcha" src="' + png + '"><input id="cvalue"><button type="button">Đăng nhập</button><div class="ant-message-error" hidden></div></form></body></html>';
  fixtureClient = await newPage(port, 'data:text/html;charset=utf-8,' + encodeURIComponent(fixture));
  const fakeToken = 'test.' + Buffer.from(JSON.stringify({ mst: '0000000000', username: 'test-user', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url') + '.test';
  await evaluate(fixtureClient, `window.__NEXT_REDUX_STORE__={getState:()=>({authReducer:{jwt:window.testToken||''}})};document.getElementById('open').onclick=()=>document.getElementById('live').hidden=false;document.querySelector('#live button').onclick=()=>{const f=document.getElementById('live');if(f.querySelector('#username').value==='test-user'&&f.querySelector('#password').value==='dummy-not-a-secret'&&f.querySelector('#cvalue').value==='TEST')window.testToken=${JSON.stringify(fakeToken)}}`);
  const state = await evaluate(fixtureClient, `(${taxLoginAction.toString()})({mode:'open'})`);
  assert.equal(state.ready, true);
  const result = await evaluate(fixtureClient, `(${taxLoginAction.toString()})(${JSON.stringify({ mode: 'submit', username: 'test-user', password: 'dummy-not-a-secret', captcha: 'TEST', expectedCaptcha: state.captcha })})`);
  assert.equal(result.authenticated, true);
  assert.equal(await evaluate(fixtureClient, "document.querySelector('form').querySelector('#username').value"), '');
  console.log('PASS: original visible-form selectors, header login, controlled inputs and JWT confirmation');
  console.log(JSON.stringify({ ok: true, packaged: !!config.packed, realAccountUsed: false }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (fixtureClient) await fixtureClient.close().catch(() => {});
  if (client) { await client.Browser.close().catch(() => {}); await client.close().catch(() => {}); }
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (server && server.exitCode === null) server.kill();
  await wait(1000);
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch { console.log('Temporary browser files still closing: ' + temp); }
});
