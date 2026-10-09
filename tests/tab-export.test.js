'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('each tab exports its own sheets and filters, without leaking invoice state', async () => {
  const source = fs.readFileSync('src/data-ui.js', 'utf8');
  const body = source.slice(source.indexOf('  async function exportExcel('), source.indexOf('  // ------------------------------------------------------------------ nhập XML'));
  const urls = [];
  const context = {
    URLSearchParams, exportBusy: false,
    app: { selected: '0312345678' },
    tabState: { list: { dir: 'SELL', state: '6' }, products: { dir: 'BUY' }, partners: { kind: 'supplier' } },
    activeFilters: () => ({ q: 'từ khóa', from: '2026-07-01', to: '2026-09-30' }),
    bankFilters: () => ({ q: 'chuyển tiền', from: '2026-07-01', to: '2026-09-30', account: '123', min: '100', max: '500', category: 'chi', status: 'pending', flow: 'out' }),
    fetch: async (url, options) => { urls.push({ params: new URL(url, 'http://localhost').searchParams, options }); return { ok: false, status: 400, json: async () => ({ error: 'test captured request' }) }; },
    isAbort: () => false, fail: () => {},
  };
  vm.createContext(context);
  vm.runInContext(body, context);
  for (const tab of ['list', 'products', 'partners', 'bank']) {
    const button = { textContent: 'Xuất Excel', setAttribute() {}, removeAttribute() {} };
    await context.exportExcel(tab, button);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Xuất Excel');
  }
  assert.equal(urls[0].params.get('parts'), 'sell');
  assert.equal(urls[0].params.get('state'), '6');
  assert.equal(urls[1].params.get('parts'), 'productsBuy');
  assert.equal(urls[1].params.has('state'), false);
  assert.equal(urls[2].params.get('parts'), 'suppliers');
  assert.equal(urls[2].params.has('q'), false);
  assert.equal(urls[2].params.has('state'), false);
  assert.equal(urls[3].params.get('parts'), 'bank');
  for (const [key, value] of Object.entries(context.bankFilters())) assert.equal(urls[3].params.get(key), value);
  for (const request of urls) assert.equal(request.options.headers['X-Feature-Mst'], '0312345678');
});
