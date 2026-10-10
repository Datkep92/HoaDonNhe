'use strict';
// Real EXE + official model, synthetic local data only. No customer warehouse.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { randomUUID } = require('node:crypto');
const data = require('../src/data');
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cntax-workspace-exe-'));
  const dir = path.join(root, 'data'), output = path.join(root, 'invoices'); fs.mkdirSync(dir, { recursive: true });
  const first = '0123456789', requested = '4500101451';
  for (const mst of [first, requested]) {
    const { db } = data.mst.ensureMst({ output, mst });
    data.repository.insertInvoice(db, { invoiceKey: 'synthetic-' + mst, direction: 'SELL', mstBan: mst, tenBan: mst === requested ? '' : 'Công ty A', mstMua: 'TEST-BUYER', ngayLap: '2026-10-01', soHd: '00001', tthai: '1', tienTruocThue: 1000000, tienThue: 234567, tongTien: mst === requested ? 1234567 : 1100000, fileXml: path.join(root, mst + '.xml'), items: [] });
    data.sqlite.closeDatabase(db);
  }
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ mst: first, label: 'Công ty A', lastUsedAt: 1 }, { mst: requested, label: requested, lastUsedAt: 0 }], selected: first, output }));
  const sessions = require('../src/ai/session-store').createSessionStore(dir);
  sessions.append(sessions.resolve('agent', first), { role: 'user', content: '4500101451 là Kim Hường mà' }); sessions.close();
  fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: 'local' }));
  const child = spawn(path.resolve(process.argv[2]), ['--test-server'], { windowsHide: true, env: { ...process.env, HOADON_TEST_DATA: dir, HOADON_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', b => text += b); child.stderr.on('data', b => text += b);
  try {
    let match;
    for (let i = 0; i < 200; i++) { match = text.match(/\{"testUrl":"([^"]+)"/); if (match) break; if (child.exitCode !== null) throw Error('EXE exited before ready'); await new Promise(r => setTimeout(r, 100)); }
    if (!match) throw Error('EXE startup timeout');
    const launch = new URL(match[1]), headers = { Cookie: 'hd_session=' + launch.searchParams.get('launch'), 'Content-Type': 'application/json' };
    const response = await fetch(new URL('/api/ai/stream', launch), { method: 'POST', headers, signal: AbortSignal.timeout(110000), body: JSON.stringify({ id: 'agent', mode: 'agent', companyId: first, requestId: randomUUID(), text: 'báo cáo kinh doanh kim hường thang 10' }) });
    const body = await response.text();
    if (!response.ok) throw Error('AI request HTTP ' + response.status + ': ' + (JSON.parse(body).error || 'failed'));
    const events = body.split(/\r?\n/).filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    const failures = events.filter(e => e.error); if (failures.length) throw Error('Agent failed: ' + failures.map(e => e.error).join('; '));
    const answer = events.findLast(e => e.replace)?.replace || events.filter(e => e.delta).map(e => e.delta).join('');
    assert.match(answer, /Kim Hường/); assert.match(answer, /1\.234\.567/); assert.doesNotMatch(answer, /1\.100\.000/);
    const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')); assert.equal(accounts.selected, first);
    const result = { ok: true, packed: true, syntheticData: true, currentCompanyUnchanged: true, requestedCompanyMatched: true, expectedAmountMatched: true, modelNameInStatus: events.some(e => /Đang dùng model/.test(e.status || '')) };
    fs.writeFileSync(path.resolve('artifacts/workspace-ai-exe-live.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => { child.once('exit', r); setTimeout(r, 2000); }); }
    await new Promise(r => setTimeout(r, 300)); fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
