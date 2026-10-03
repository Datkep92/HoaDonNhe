'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/data-ui.js'), 'utf8');
const code = source.slice(source.indexOf('async function loadVat()'), source.indexOf("$('vat-reload').onclick"));
function setup(periods, selected = '') {
  const elements = { 'vat-period': { value: selected, innerHTML: '' }, 'vat-body': {}, 'vat-deduction': { value: '0' }, 'vat-export': {} };
  const calls = [];
  const context = vm.createContext({ $: id => elements[id], vatPeriods: [], num: { format: String }, safeOverviewText: String,
    api: async url => { calls.push(url); return { periods }; }, renderVat: () => {}, fail: error => { throw error; } });
  vm.runInContext(code, context);
  return { context, elements, calls };
}
test('empty period selector fetches periods before selecting a quarter', async () => {
  const s = setup([{ year: 2026, quarter: 2, label: 'Q2', invoices: 3 }]);
  await s.context.loadVat();
  assert.equal(s.calls.length, 1);
  assert.ok(!s.calls[0].includes('year='));
  assert.ok(s.elements['vat-period'].innerHTML.includes('2026-2'));
});
test('reload preserves the selected quarter', async () => {
  const s = setup([{ year: 2026, quarter: 1, label: 'Q1', invoices: 1 }], '2026-1');
  await s.context.loadVat();
  assert.ok(s.calls[0].includes('year=2026&quarter=1'));
  assert.equal(s.elements['vat-period'].value, '2026-1');
});
test('empty database displays the empty state and disables export', async () => {
  const s = setup([]);
  await s.context.loadVat();
  assert.equal(s.calls.length, 1);
  assert.equal(s.elements['vat-export'].disabled, true);
});
