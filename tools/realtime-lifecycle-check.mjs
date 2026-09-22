// Kiểm tra THỦ CÔNG vòng đời kết nối SSE của server thật (không nằm trong `npm test` vì chạy ~50 giây):
//   node tools/realtime-lifecycle-check.mjs
//   Phase A — upstream đóng luồng sau 4s -> phải nối lại, backoff tăng dần 5s/10s/20s, KHÔNG trùng kết nối, KHÔNG polling.
//   Phase B — upstream trả 404 cho route stream -> fallback (realtime=false), KHÔNG polling status.
// Chỉ giả lập phía upstream; logic được kiểm là của app.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = path.join(import.meta.dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const state = { connections: 0, concurrent: 0, maxConcurrent: 0, statusCalls: 0, streamMode: 'drop' };

const mock = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/devices/register') {
    req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, value: { status: 'Trial', registered: true, sessionToken: 'session-control' } }));
  }
  if (req.method === 'POST' && req.url === '/v1/chats/status') {
    state.statusCalls += 1; req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, value: { messages: [] } }));
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/chats/stream')) {
    if (state.streamMode === 'notfound') { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'Not found.' })); }
    state.connections += 1; state.concurrent += 1; state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: put\ndata: {"path":"/","data":{}}\n\n');
    const timer = setTimeout(() => { try { res.end(); } catch { /* đã đóng */ } }, 4000);
    res.on('close', () => { clearTimeout(timer); state.concurrent -= 1; });
    return undefined;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: false, error: 'Not found.' }));
});

async function runPhase(label, streamMode, seconds) {
  state.connections = 0; state.concurrent = 0; state.maxConcurrent = 0; state.statusCalls = 0; state.streamMode = streamMode;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-life-'));
  fs.writeFileSync(path.join(work, 'support.json'), JSON.stringify({
    version: 1,
    device: { installationId: '11111111-2222-3333-4444-555555555555', chatRoomId: 'ROOM_WIN_CONTROL01', hardwareHash: 'A'.repeat(64), firstInstallAt: Date.now(), registeredAt: Date.now(), phone: '', name: '', plan: '' },
    license: { status: 'Trial', key: '', keyName: '', expiryAt: '', sessionToken: 'session-control', checkedAt: Date.now(), updatedAt: Date.now() },
    messages: [],
  }));
  fs.writeFileSync(path.join(work, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${mock.address().port}` }));

  const child = spawn(process.execPath, ['src/server.js', '--test-server'], { cwd: root, env: { ...process.env, HOADON_TEST_DATA: work, HOADON_NO_UPDATE_CHECK: '1' } });
  let out = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });

  let match = null;
  for (let i = 0; i < 200 && !match; i += 1) { match = out.match(/\{"testUrl":"[^"]+"/); if (!match) await sleep(100); }
  if (!match) throw new Error(`server không khởi động: ${out}`);
  const url = new URL(JSON.parse(`${match[0]}}`).testUrl);
  const headers = { Cookie: `hd_session=${url.searchParams.get('launch')}` };
  const seen = [];
  const sse = http.get({ host: '127.0.0.1', port: Number(url.port), path: '/api/support/events', headers }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => { for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { seen.push(JSON.parse(line.slice(6))); } catch { /* bỏ */ } } });
  });
  sse.on('error', () => {});

  await sleep(seconds * 1000);
  const realtimeOn = seen.some(e => e.type === 'mode' && e.realtime);
  child.kill();
  await sleep(700);
  const logFile = path.join(work, 'nhat-ky.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const delays = [...log.matchAll(/thử lại sau (\d+)s/g)].map(m => m[1]);

  console.log(`\n=== ${label} (${seconds}s) ===`);
  console.log(`  kết nối stream: ${state.connections} · song song tối đa: ${state.maxConcurrent} (1 = không trùng)`);
  console.log(`  realtime bật: ${realtimeOn ? 'CÓ' : 'KHÔNG'}`);
  console.log(`  gọi /v1/chats/status (polling?): ${state.statusCalls} (0 = không polling)`);
  console.log(`  backoff ghi trong log: [${delays.join(', ')}]`);
  return { state: { ...state }, realtimeOn, delays, connections: state.connections };
}

(async () => {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const a = await runPhase('Phase A — upstream đóng luồng sau 4 giây', 'drop', 38);
  const b = await runPhase('Phase B — route stream trả 404 (fallback)', 'notfound', 13);

  const growing = a.delays.length >= 2 && Number(a.delays[1]) > Number(a.delays[0]);
  console.log('\n--- KẾT LUẬN D ---');
  console.log(`  reconnect: ${a.connections > 1 ? 'PASS' : 'FAIL'} (${a.connections} kết nối)`);
  console.log(`  backoff tăng dần: ${growing ? 'PASS' : 'FAIL'}`);
  console.log(`  không tạo kết nối trùng: ${a.state.maxConcurrent === 1 ? 'PASS (tối đa 1)' : 'FAIL'}`);
  console.log(`  không quay lại polling: ${a.state.statusCalls === 0 && b.state.statusCalls === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  fallback khi thiếu route: ${b.realtimeOn === false && b.connections === 0 ? 'PASS' : 'FAIL'}`);
  mock.close();
  process.exit(0);
})().catch(error => { console.error(`FAIL: ${error.message}`); process.exit(1); });
