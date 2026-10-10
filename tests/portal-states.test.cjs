'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine } = require('../src/core');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice } = require('../src/data/repository');
const { applyPortalStates } = require('../src/data/portal-states');
const { stateChanged, processFile } = require('../src/data/xml-scanner');
const { buildInvoiceKey } = require('../src/data/invoice-key');
const account = { mst: '0312345678', key: 'test' };
const inv = (n, tthai) => ({ nbmst: '0100000001', nmmst: account.mst, khmshdon: '1', khhdon: 'C26TAA', shdon: `000${n}`, tthai });
const key = i => buildInvoiceKey({ mstBan: i.nbmst, khmshDon: i.khmshdon, khhDon: i.khhdon, shDon: i.shdon });
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-states-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  t.after(() => { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const n of [1, 2, 3]) insertInvoice(db, { invoiceKey: key(inv(n)), direction: 'BUY', mstBan: '0100000001', mstMua: account.mst,
    khmsHd: '1', khhHd: 'C26TAA', soHd: `000${n}`, ngayLap: '2026-09-01', tthai: '1', tongTien: 110, fileXml: path.join(dir, `${n}.xml`), items: [] });
  return { db, dir };
}

test('only observed states update; missing/invalid values never reset data or amounts', t => {
  const { db } = setup(t);
  assert.equal(applyPortalStates(db, new Map([[key(inv(1)), '4'], [key(inv(2)), ''], [key(inv(3)), {}], ['missing', '6']])), 1);
  assert.deepEqual(db.prepare('SELECT tthai,tong_tien FROM invoices ORDER BY id').all().map(r => [r.tthai, r.tong_tien]), [['4', 110], ['1', 110], ['1', 110]]);
  assert.equal(applyPortalStates(db, new Map([[key(inv(1)), '4']])), 0);
  assert.equal(applyPortalStates(db, new Map([[key(inv(2)), '99']])), 1);
  assert.equal(stateChanged(db, { invoice_key: key(inv(1)) }, new Map()), false);
});

test('search applies states before download and independently of user status filter, including partial scans', async t => {
  const { db, dir } = setup(t);
  let calls = 0;
  const engine = new Engine({ store: path.join(dir, 'job.json'), identity: async () => account, emit: () => {},
    onStates: (_job, states) => applyPortalStates(db, states),
    request: async () => {
      if (++calls > 1) throw Error('network');
      return Buffer.from(JSON.stringify({ datas: [inv(1, '4'), inv(2, undefined)], state: 'next' }));
    }, excel: async () => Buffer.from('PK') });
  await engine.search({ direction: 'sold', family: 'query', from: '2026-09-01', to: '2026-09-30', status: '1', formats: ['xlsx'] }, dir);
  assert.equal(engine.job.state, 'partial');
  assert.deepEqual(db.prepare('SELECT tthai FROM invoices ORDER BY id').all().map(r => r.tthai), ['4', '1', '1']);
  assert.equal(engine.job.items.length, 0, 'filter excludes both rows, but observed state still updates');
});

test('successive directions update disjoint observed keys without discarding prior states', async t => {
  const { db } = setup(t);
  await Promise.all([Promise.resolve().then(() => applyPortalStates(db, new Map([[key(inv(1)), '4']]))),
    Promise.resolve().then(() => applyPortalStates(db, new Map([[key(inv(2)), '5']])))]);
  assert.deepEqual(db.prepare('SELECT tthai FROM invoices ORDER BY id').all().map(r => r.tthai), ['4', '5', '1']);
});
