'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManualDownloadEngine, validateManualParams } = require('../src/manual-download');
const { validateParams, sameDownloadParams } = require('../src/core');
const account = { key: 'test', mst: '0312345678' };
const params = { from: '2026-09-01', to: '2026-09-30', family: 'query', direction: 'both', status: '', formats: ['xlsx'] };
const invoice = n => ({ nbmst: '0100000001', nmmst: account.mst, khmshdon: '1', khhdon: 'C26TAA', shdon: `000${n}`, tthai: 1 });
function fixture(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-both-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { store: path.join(dir, 'job.json'), identity: async () => account, request, emit: () => {}, excel: async () => Buffer.from('PK'), pdf: async () => Buffer.from('%PDF') };
  return { dir, options, engine: new ManualDownloadEngine(options) };
}
const response = datas => Buffer.from(JSON.stringify({ datas }));

test('combined validation never permits /invoices/both in a native Engine', () => {
  assert.equal(validateManualParams(params).direction, 'both');
  assert.throws(() => validateParams(params));
  assert.throws(() => validateManualParams({ ...params, to: '2026-01-01' }));
  assert.equal(sameDownloadParams({ params }, { ...params, direction: 'sold' }), false);
});

test('two directions run sequentially, preserve per-direction jobs and aggregate progress', async t => {
  const calls = [];
  const { dir, engine } = fixture(t, async route => {
    calls.push(route); assert.ok(!route.includes('/invoices/both'));
    if (route.includes('/purchase') && route.includes('ttxly==5')) return response([invoice(1)]);
    if (route.includes('/sold')) { assert.equal(engine.children.get('purchase').job.state, 'completed'); return response([invoice(2)]); }
    return response([]);
  });
  await engine.stream(params, dir);
  assert.equal(engine.job.state, 'completed'); assert.equal(engine.snapshot().done, 2);
  assert.deepEqual(engine.snapshot().directions.map(x => x.done), [1, 1]);
  assert.equal(calls.length, 4);
  assert.deepEqual(engine.job.items.map(x => x.invoice.direction), ['purchase', 'sold']);
  assert.equal(engine.job.output, dir);
  assert.equal(JSON.parse(fs.readFileSync(engine.store)).params.direction, 'both');
});

test('pause blocked purchase, restart and resume only unfinished directions', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  let blocked = true, sold = 0;
  const { dir, options, engine } = fixture(t, async route => {
    if (route.includes('/purchase') && blocked) { started(); return new Promise(() => {}); }
    if (route.includes('/sold')) sold++;
    return response([]);
  });
  const run = engine.stream(params, dir); await ready; engine.pause(); await run;
  assert.equal(engine.job.state, 'paused'); assert.equal(sold, 0);
  blocked = false;
  const reopened = new ManualDownloadEngine(options);
  await reopened.resume(true);
  assert.equal(reopened.job.state, 'completed'); assert.equal(sold, 1);
  assert.equal(reopened.job.id, engine.job.id);
  await reopened.resume(true); assert.equal(sold, 1, 'completed direction is never run again');
});

test('pause during sold and reload does not rerun completed purchase', async t => {
  let release; const ready = new Promise(resolve => { release = resolve; });
  let block = true, purchase = 0;
  const { dir, options, engine } = fixture(t, async route => {
    if (route.includes('/purchase')) purchase++;
    if (route.includes('/sold') && block) { release(); return new Promise(() => {}); }
    return response([]);
  });
  const run = engine.stream(params, dir); await ready; engine.pause(); await run;
  assert.equal(purchase, 3); block = false;
  const reopened = new ManualDownloadEngine(options); await reopened.resume(true);
  assert.equal(purchase, 3); assert.equal(reopened.job.state, 'completed');
});

test('partial purchase does not block sold; expired session does', async t => {
  let sold = 0, auth = false;
  const { dir, engine } = fixture(t, async route => {
    if (route.includes('/purchase')) throw Object.assign(new Error('network'), auth ? { auth: true } : {});
    sold++; return response([]);
  });
  await engine.stream(params, dir); assert.equal(sold, 1); assert.equal(engine.job.state, 'partial');
  auth = true; sold = 0; await engine.stream(params, dir);
  assert.equal(engine.job.state, 'auth_required'); assert.equal(sold, 0);
});

test('changing account pauses combined job before starting next direction', async t => {
  let current = account, sold = 0;
  const { dir, options } = fixture(t, async route => {
    if (route.includes('/purchase') && route.includes('ttxly==8')) current = { key: 'other', mst: '0999999999' };
    if (route.includes('/sold')) sold++;
    return response([]);
  });
  options.identity = async () => current;
  const engine = new ManualDownloadEngine(options); await engine.stream(params, dir);
  assert.equal(engine.job.state, 'auth_required'); assert.equal(sold, 0);
});

test('legacy single-direction job reload remains a single native job', async t => {
  const { dir, options, engine } = fixture(t, async () => response([]));
  await engine.stream({ ...params, direction: 'sold' }, dir);
  const reopened = new ManualDownloadEngine(options);
  assert.equal(reopened.job.combined, undefined); assert.equal(reopened.job.params.direction, 'sold');
});

test('combined XML lands in both folders; next batch skips existing XML and updates statuses', async t => {
  let exports = 0, status = 1;
  const observed = [];
  const { dir, options } = fixture(t, async route => {
    if (route.includes('export-xml')) {
      exports++;
      const n = new URL('http://local' + route).searchParams.get('shdon');
      return Buffer.from(`<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>${n}</SHDon><NLap>2026-09-01</NLap></TTChung><NDHDon><NBan><MST>0100000001</MST></NBan><NMua><MST>${account.mst}</MST></NMua></NDHDon></DLHDon></HDon>`);
    }
    if (route.includes('/sold')) return response([{ ...invoice(2), tthai: status }]);
    return response(route.includes('ttxly==5') ? [{ ...invoice(1), tthai: status }] : []);
  });
  options.onStates = (_job, states) => observed.push(...states.values());
  const engine = new ManualDownloadEngine(options), xmlParams = { ...params, formats: ['xml'] };
  await engine.stream(xmlParams, dir);
  assert.equal(engine.job.state, 'completed'); assert.equal(exports, 2);
  assert.ok(engine.job.items[0].files[0].includes('Mua_vao')); assert.ok(engine.job.items[1].files[0].includes('Ban_ra'));
  assert.ok(engine.job.items.every(item => fs.existsSync(item.files[0])));
  status = 4; await engine.stream(xmlParams, dir);
  assert.equal(engine.job.state, 'completed'); assert.equal(exports, 2);
  assert.equal(engine.snapshot().done, 2); assert.equal(engine.job.stats.skipped, 2);
  assert.deepEqual(observed, ['1', '1', '4', '4']);
});

test('invalid XML in purchase preserves failure and still downloads sold XML', async t => {
  const { dir, engine } = fixture(t, async route => {
    if (route.includes('export-xml')) {
      const n = new URL('http://local' + route).searchParams.get('shdon');
      return n === '0001' ? Buffer.from('<h4>not XML</h4>') : Buffer.from(`<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>${n}</SHDon></TTChung><NDHDon><NBan><MST>0100000001</MST></NBan></NDHDon></DLHDon></HDon>`);
    }
    if (route.includes('/sold')) return response([invoice(2)]);
    return response(route.includes('ttxly==5') ? [invoice(1)] : []);
  });
  await engine.stream({ ...params, formats: ['xml'] }, dir);
  assert.equal(engine.job.state, 'partial');
  assert.deepEqual(engine.job.items.map(item => item.state), ['failed', 'done']);
});

test('pause from portal rate limit prevents next direction', async t => {
  let sold = 0;
  const { dir, engine } = fixture(t, async route => {
    if (route.includes('/sold')) sold++;
    throw Object.assign(Error('HTTP 429'), { paused: true });
  });
  await engine.stream(params, dir);
  assert.equal(engine.job.state, 'paused'); assert.equal(sold, 0);
});
