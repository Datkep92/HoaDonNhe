'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { MstLookupController } = require('../src/mst-lookup');
test('MST stops repeated HTML or wrong JSON schema without marking an identifier missing', async () => {
  for (const payload of ['<h4>The application is unavailable</h4>', '{"error":"unavailable"}', '{"tinModel":null,"strMess":"Lỗi hệ thống"}']) {
    let calls = 0;
    const progress = [];
    const ctl = new MstLookupController({ browser: { fetchSameOrigin: async url => {
      if (url.includes('validcode')) return { status: 200, text: '{}' };
      calls++;
      return { status: 200, text: payload };
    } }, onProgress: p => progress.push(p) });
    await assert.rejects(ctl.search(['0101234567', '0101234568'], 'aB7c'), /HTML|cấu trúc/);
    assert.equal(calls, payload.startsWith('<') ? 2 : 1);
    assert.equal(progress.at(-1).rows[0].portalError, true);
  }
});
test('MST decodes dated office metadata and a single HTML row does not prevent the next lookup', async () => {
  const office = 'Q.Thanh Khê - KV TKH-LCHFChi cục Thuế Quận Thanh KhêF2019F06F30';
  const ctl = new MstLookupController({ browser: { fetchSameOrigin: async url => {
    if (url.includes('validcode')) return { status: 200, text: '{}' };
    const mst = new URL(url).searchParams.get('tin');
    if (mst === '058079001853') return { status: 200, text: '<h4>The application error</h4>' };
    return { status: 200, text: JSON.stringify({ tinModel: { tin: mst, norm_name: 'Fixture', statusName: 'NNT đang hoạt động', pay_taxo_name: office } }) };
  } } });
  const rows = await ctl.search(['0402335623', '058079001853', '0315058003'], 'aB7c');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cThue, 'Chi cục Thuế Quận Thanh Khê');
  assert.equal(rows[0].cThueRaw, office);
  assert.equal(rows[1].errorCode, 'PORTAL_HTML');
  assert.equal(rows[2].found, true);
});
test('MST keeps absent status unknown, rejects mismatched identifiers and retains tax office text', async () => {
  let model = { tin: '0101234567', norm_name: 'Fixture', pay_taxo_name: 'OFFICE F1' };
  const ctl = new MstLookupController({ browser: { fetchSameOrigin: async () => ({ status: 200, text: JSON.stringify({ tinModel: model }) }) } });
  const row = await ctl.queryOne('0101234567', 'ABCD');
  assert.equal(row.statusUnknown, true);
  assert.equal(row.cThue, 'OFFICE F1');
  model.tin = '0101234568';
  assert.equal((await ctl.queryOne('0101234567', 'ABCD')).portalError, true);
});
const { TokhaiController, parseDvcRows, safeFileName } = require('../src/tokhai');
const html = '<table><thead><tr><th>STT</th><th>Mã hồ sơ</th><th>Tờ khai</th><th>Kỳ tính thuế</th><th>Loại tờ khai</th><th>Lần bổ sung</th><th>Lần nộp</th><th>Ngày nộp</th><th>Trạng thái</th></tr></thead><tbody><tr><td>1</td><td>123456</td><td>01/GTGT</td><td>09/2026</td><td>Chính thức</td><td>0</td><td>1</td><td>01/10/2026</td><td>Đã nhận</td></tr></tbody></table>';

test('CDP unwraps values and reports script exceptions; authenticated fetch keeps image bytes', async () => {
  const file = path.resolve(__dirname, '../src/browser.js');
  const localRequire = createRequire(file);
  let response = { result: { value: { status: 200, base64: Buffer.from('image').toString('base64') } } };
  const context = { URL, __dirname: path.dirname(file), require: name => name === 'chrome-remote-interface' ? async () => ({ Runtime: { evaluate: async () => response }, close: async () => {} }) : localRequire(name), module: { exports: {} }, Buffer, setTimeout, clearTimeout, process, console };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  const browser = new context.module.exports.TaxBrowser(os.tmpdir());
  browser.port = 1234;
  browser.tabForOrigin = async () => 'tab';
  const result = await browser.fetchSameOrigin('https://example.org/Captcha.jpg');
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), 'image');
  response = { exceptionDetails: { text: 'script failed' } };
  await assert.rejects(browser.evalInTab('tab', 'bad()'), /script failed/);
});

test('MST portal creates a background target and keeps its Chrome window minimized', async () => {
  const { TaxBrowser } = require('../src/browser');
  const browser = new TaxBrowser(os.tmpdir());
  const targets = [], bounds = [];
  browser.client = {
    Target: { createTarget: async options => { targets.push(options); return { targetId: 'background-tab' }; } },
    Browser: { getWindowForTarget: async () => ({ windowId: 7 }), setWindowBounds: async options => bounds.push(options) },
  };
  browser.listTabs = async () => [];
  browser.evalInTab = async () => true;
  assert.equal(await browser.tabForOrigin('https://tracuuhoadon.gdt.gov.vn', true), 'background-tab');
  assert.equal(targets[0].background, true);
  assert.equal(targets[0].url, 'https://tracuuhoadon.gdt.gov.vn/');
  assert.ok(bounds.every(options => options.bounds.windowState === 'minimized'));
  browser.client = null;
});

test('MST valid response retains tax office and complete partial progress', async () => {
  const progress = [];
  const ctl = new MstLookupController({ browser: { fetchSameOrigin: async url => ({ status: 200, text: url.includes('validcode') ? '{}' : JSON.stringify({ tinModel: { tin: '0101234567', norm_name: 'TEST', pay_taxo_name: 'Tax office' } }) }) }, onProgress: p => progress.push(p) });
  const rows = await ctl.search(['0101234567'], 'ABCD');
  assert.equal(rows[0].found, true);
  assert.equal(rows[0].cThue, 'Tax office');
  assert.equal(progress.at(-1).rows.length, 1);
});

test('DVC parser maps data from headers and never treats header or STT as dossier ID', () => {
  const rows = parseDvcRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].maHoSo, '123456');
  assert.equal(rows[0].toKhai, '01/GTGT');
  assert.equal(rows[0].ngayNop, '01/10/2026');
});

test('DVC search validates its dedicated CAPTCHA, preserves case and parses partial table layout', async () => {
  const calls = [];
  const ctl = new TokhaiController({ browser: { fetchSameOrigin: async url => {
    calls.push(url);
    return { status: 200, ok: true, text: url.includes('/checkCaptcha') ? 'success' : html };
  } } });
  const result = await ctl.searchDvc('01/09/2026', '09/10/2026', 'aB7c');
  assert.match(calls[0], /\/tthc\/checkCaptcha\?captcha=aB7c/);
  assert.match(calls[1], /captcha=aB7c/);
  assert.equal(result.length, 1);
  const partial = '<table><tbody><tr>' + ['1', '', '123456', '', '01/GTGT', '09/2026', 'Chính thức', '0', '1', '', '01/10/2026', 'Đã nhận'].map(c => '<td>' + c + '</td>').join('') + '</tr></tbody></table>';
  assert.equal(parseDvcRows(partial)[0].maHoSo, '123456');
});

test('TDT login uses prepared session with corpUserLoginProc and requires confirmed success', async () => {
  let body;
  const ctl = new TokhaiController({ browser: { fetchSameOrigin: async (url, options) => {
    body = new URLSearchParams(options.body);
    return { ok: true, text: '<input name="dse_sessionId" value="logged-session"><input value="complete">corporateHomeProc' };
  } } });
  ctl.tdtLoginFields = { dse_sessionId: 'prepared-session', dse_pageId: '5' };
  assert.equal((await ctl.loginTdt('0101234567', 'fixture-password', 'aB7c')).ok, true);
  assert.equal(body.get('dse_operationName'), 'corpUserLoginProc');
  assert.equal(body.get('_verifyCode'), 'aB7c');
  assert.equal(ctl.sessionId, 'logged-session');
});

test('declaration date validation rejects calendar rollover and backwards range', () => {
  assert.throws(() => TokhaiController.splitRange('31/02/2026', '05/03/2026'), /không tồn tại/);
  assert.throws(() => TokhaiController.splitRange('02/10/2026', '01/10/2026'), /lớn hơn/);
  assert.equal(TokhaiController.splitRange('01/01/2025', '09/10/2026').length, 2);
});

test('TDT download controller sends cached session and filing date to reference flow', async () => {
  const ctl = new TokhaiController({ browser: { tabForOrigin: async () => 'tab', evalInTab: async (tab, expression) => {
    assert.match(expression, /live-session/);
    assert.match(expression, /downTkhai/);
    assert.match(expression, /01\/10\/2026/);
    return { success: true, files: [{ filename: 'ToKhai_123456.xml', data: Buffer.from('<?xml version="1.0"?><HSoThueDTu/>').toString('base64') }] };
  } } });
  ctl.currentPortal = 'tdt';
  ctl.sessionId = 'live-session';
  ctl.results = [{ maHoSo: '123456', ngayNop: '01/10/2026' }];
  assert.match((await ctl.downloadOne('123456'))[0].bytes.toString(), /HSoThueDTu/);
});

test('download counts only written valid files, rejects HTML and missing output directory', async () => {
  const ctl = new TokhaiController({ browser: {} });
  await assert.rejects(ctl.bulkDownload(['123456']), /thư mục/);
  assert.throws(() => safeFileName('a.zip', Buffer.from('<html><form>Login</form></html>')), /HTML/);
  assert.equal(safeFileName('a.zip', Buffer.from('<?xml version="1.0"?><HSoThueDTu/>')), 'a.xml');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tax-feature-test-'));
  try {
    ctl.downloadOne = async () => Buffer.from('<?xml version="1.0"?><HSoThueDTu/>');
    const result = await ctl.bulkDownload(['123456'], { outputDir: dir });
    assert.equal(result.succeeded, 1);
    assert.equal(result.files[0].success, true);
    assert.equal(fs.existsSync(result.files[0].path), true);
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^tax-feature-test-/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function ui(file, responses) {
  const nodes = new Map();
  const events = {};
  const make = () => ({ value: '', textContent: '', innerHTML: '', innerText: '', hidden: false, disabled: false, checked: true, dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, prepend(node) { this.children.unshift(node); }, appendChild(node) { this.children.push(node); } });
  const node = id => { if (!nodes.has(id)) nodes.set(id, make()); return nodes.get(id); };
  const errors = [];
  const requests = [];
  const context = {
    document: { getElementById: node, createElement: make, querySelectorAll: () => [], querySelector: () => make() },
    window: { addEventListener: (name, fn) => { events[name] = fn; }, noticeFail: msg => errors.push(msg) },
    setTimeout: fn => { fn(); }, console,
    fetch: async (url, options) => { requests.push({ url, options }); const data = responses(url, options); return { json: async () => data }; },
  };
  const filename = path.resolve(__dirname, '../src', file);
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace('})();', 'window.audit = {state, els, ' + (file.includes('mst-') ? 'startSearch, updateProgressUI, renderResults, pollProgress' : 'searchDeclarations, bulkDownload, downloadSingle, resetConnection') + '};})();');
  vm.runInNewContext(source, context);
  events['hd:state']({ detail: { selected: '0101234567' } });
  (file.includes('mst-') ? context.window.MstLookupUI : context.window.TokhaiUI).ensureInit();
  return { ...context.window.audit, node, errors, requests, events };
}

test('MST UI consumes started/progress/complete contract, shows results and enables export', async () => {
  const rows = [{ mst: '0101234567', found: true, ten: 'TEST', tThai: 'Đang hoạt động', cThue: 'CQT', dChi: 'HN' }];
  const app = ui('mst-lookup-ui.js', url => ({ ok: true, value: url.endsWith('/captcha') ? { dataUrl: 'image', solvedText: 'ABCD' } : url.endsWith('/search') ? { started: true, total: 1 } : { stage: 'complete', total: 1, done: 1, rows } }));
  app.els.mstInput.value = '0101234567';
  app.els.captchaInput.value = 'ABCD';
  await app.startSearch();
  assert.deepEqual(app.errors, []);
  assert.equal(app.state.results.length, 1);
  assert.equal(app.els.btnExportExcel.disabled, false);
  assert.equal(app.els.badgeActive.innerText, 1);
});

test('MST UI exits error progress instead of polling forever', async () => {
  const app = ui('mst-lookup-ui.js', url => ({ ok: true, value: url.endsWith('/captcha') ? { dataUrl: 'image', solvedText: 'ABCD' } : { stage: 'error', error: 'CAPTCHA expired' } }));
  app.state.isSearching = true;
  await assert.rejects(app.pollProgress(), /CAPTCHA expired/);
});

test('declaration UI waits for background search and download; counts actual files', async () => {
  let download = false;
  const app = ui('tokhai-ui.js', url => {
    if (url.endsWith('/download')) download = true;
    return { ok: true, value: url.endsWith('/captcha') ? { dataUrl: 'image', solvedText: 'ABCD' } : url.endsWith('/progress') ? download ? { stage: 'complete', succeeded: 1, failed: 0, files: [{ maHoSo: '123456', success: true }] } : { stage: 'complete', rows: parseDvcRows(html) } : { started: true } };
  });
  app.state.loggedIn = true;
  app.els.txtTuNgay.value = '01/09/2026';
  app.els.txtDenNgay.value = '09/10/2026';
  app.els.txtCaptcha.value = 'ABCD';
  await app.searchDeclarations();
  assert.equal(app.state.results[0].maHoSo, '123456');
  assert.equal(app.els.resultsEmpty.hidden, true);
  await app.bulkDownload();
  assert.deepEqual(app.errors, []);
  const btn = app.node('single');
  await app.downloadSingle('123456', btn);
  assert.equal(btn.innerHTML, '✓ Đã tải');
  app.events['hd:state']({ detail: { selected: '0301234567' } });
  assert.equal(app.state.loggedIn, false);
  assert.equal(app.state.results.length, 0);
});

test('feature routes isolate jobs by MST, preserve stopped state and reject wrong download scope', async () => {
  const filename = path.resolve(__dirname, '../src/server.js');
  const source = fs.readFileSync(filename, 'utf8');
  const body = source.slice(source.indexOf('const mstLookupJobs ='), source.indexOf('// DVC: đọc phiên'));
  class Lookup {
    constructor(deps) { this.deps = deps; }
    async search(list) { this.shouldStop = true; return list.map(mst => ({ mst, found: true })); }
  }
  class Declaration {
    constructor() {}
    static splitRange() { return []; }
    async searchDvc() { return [{ maHoSo: '123456' }]; }
    async bulkDownload(list) { return { succeeded: list.length, failed: 0, files: list.map(maHoSo => ({ maHoSo, success: true })), stopped: false }; }
  }
  const responses = [];
  const context = { mstBrowserPool: { get: async () => ({}) }, Map, Set, String, Array, Number, Date, path, browser: {}, dataDir: '', selected: '0101234567', accountFor: () => ({}), output: 'test-output', log() {}, mstFormat: {}, readBody: async req => req.body, reply: (res, status, data) => { responses.push(data); return data; }, require: name => name === './mst-lookup' ? { MstLookupController: Lookup } : { TokhaiController: Declaration } };
  vm.runInNewContext(body + '\nthis.audit={mstLookupRoute,tokhaiRoute,mstLookupJobs,tokhaiJobs,checkFeatureScope};', context);
  const api = context.audit;
  const route = (fn, mst, action, input) => fn({ method: input ? 'POST' : 'GET', body: input }, {}, { pathname: '/api/' + (fn === api.mstLookupRoute ? 'mst/lookup/' : 'tokhai/') + action }, mst);
  await route(api.mstLookupRoute, '0101234567', 'search', { mstList: ['0101234567'], captchaCode: 'ABCD' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.mstLookupJobs.get('0101234567').progress.stage, 'stopped');
  await route(api.mstLookupRoute, '0301234567', 'progress');
  assert.equal(Object.keys(responses.at(-1).value).length, 0);
  await route(api.tokhaiRoute, '0101234567', 'search', { tuNgay: '01/09/2026', denNgay: '09/10/2026', portal: 'dvc' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(route(api.tokhaiRoute, '0101234567', 'download', { maHoSoList: ['wrong'], portal: 'dvc' }), /không thuộc/);
  await assert.rejects(route(api.tokhaiRoute, '0101234567', 'download', { maHoSoList: ['123456'], portal: 'tdt' }), /khác cổng/);
  await route(api.tokhaiRoute, '0101234567', 'download', { maHoSoList: ['123456'], portal: 'dvc' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.tokhaiJobs.get('0101234567').progress.succeeded, 1);
  assert.throws(() => api.checkFeatureScope({ headers: { 'x-feature-mst': '0301234567' } }), /MST đã thay đổi/);
});
