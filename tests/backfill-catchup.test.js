'use strict';
// Quét bù lịch sử (src/data/backfill-catchup.js) — phần THUẦN logic, không mạng, không SQLite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const {
  planCatchup, createCatchupJob, normalizeLedger, addDays, DAY_MS,
  catchupGateReason, orderLeastRecentlyRun, pickCatchupTargets, catchupCacheKey,
} = require('../src/data/backfill-catchup');
const dataLayer = require('../src/data');
const { openDatabase, closeDatabase, applySchema } = require('../src/data/sqlite');
const { setSyncState } = require('../src/data/repository');

const NOW = Date.UTC(2026, 8, 28); // 2026-09-28

test('planCatchup: chưa quét gì thì mọi ngày đều thiếu, gom đoạn theo segmentDays', () => {
  const plan = planCatchup({ start: '2026-09-01', end: '2026-09-28', scanned: {}, now: NOW, segmentDays: 10 });
  assert.equal(plan.total, 28);
  assert.equal(plan.segments.length, 3);
  assert.equal(plan.segments[0].from, '2026-09-01');
  assert.equal(plan.segments[0].to, '2026-09-10');
  assert.equal(plan.segments[0].days.length, 10);
  assert.equal(plan.segments[2].days.length, 8);
  assert.equal(plan.segments[2].to, '2026-09-28');
});

test('planCatchup: ngày đã quét gần đây bị loại, ngày chưa quét vẫn thiếu', () => {
  const plan = planCatchup({
    start: '2026-09-01', end: '2026-09-10', now: NOW, segmentDays: 31,
    scanned: {
      '2026-09-02': NOW - DAY_MS,
      '2026-09-03': NOW - DAY_MS,
    },
  });
  assert.deepEqual(plan.days, [
    '2026-09-01', '2026-09-04', '2026-09-05', '2026-09-06', '2026-09-07',
    '2026-09-08', '2026-09-09', '2026-09-10',
  ]);
  assert.deepEqual(plan.segments.map(s => `${s.from}→${s.to}`), ['2026-09-01→2026-09-01', '2026-09-04→2026-09-10']);
});

test('planCatchup: ngày trong cửa sổ quét lại mà đã cũ thì quét lại; ngày quá cũ thì thôi', () => {
  const plan = planCatchup({
    start: '2026-01-01', end: '2026-09-28', now: NOW,
    revisitDays: 92, revisitAfterMs: 7 * DAY_MS, segmentDays: 31,
    scanned: {
      '2026-09-20': NOW - 2 * DAY_MS,   // trong 92 ngày, mới quét 2 ngày trước ⇒ bỏ qua
      '2026-09-01': NOW - 40 * DAY_MS,  // trong 92 ngày, đã 40 ngày ⇒ quét lại
      '2026-03-01': NOW - 40 * DAY_MS,  // NGOÀI 92 ngày gần đây ⇒ không quét lại
    },
  });
  // 01/01 → 28/09 = 271 ngày, trừ 20/09 (mới quét) và 01/03 (ngoài cửa sổ) ⇒ 269.
  assert.equal(plan.total, 269);
  assert.ok(plan.days.includes('2026-09-01'));
  assert.ok(!plan.days.includes('2026-03-01'));
  assert.ok(!plan.days.includes('2026-09-20'));
  assert.equal(plan.scannedDays, 3);
});

test('planCatchup: khoảng ngày không hợp lệ ⇒ rỗng, không ném lỗi', () => {
  for (const input of [{}, { start: '', end: '2026-09-28' }, { start: '2026-10-01', end: '2026-09-01' }]) {
    const plan = planCatchup({ ...input, now: NOW });
    assert.deepEqual(plan.days, []);
    assert.deepEqual(plan.segments, []);
  }
});

test('addDays: qua mốc tháng/năm đúng', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
});

test('normalizeLedger: bỏ ngày/giá trị hỏng', () => {
  const ledger = normalizeLedger({ days: { '2026-09-01': NOW, 'xấu': NOW, '2026-09-02': 'abc', '2026-09-03': -5 } });
  assert.deepEqual(Object.keys(ledger.days), ['2026-09-01']);
  assert.ok(ledger.days['2026-09-01'] > 0);
  assert.deepEqual(normalizeLedger(null).days, {});
});

// ---------------------------------------------------------------------------
// Job: mỗi lượt MỘT đoạn, có sổ, ngưng giữa chừng thì không ghi sổ.
// ---------------------------------------------------------------------------
function makeJob({ start = '2026-09-01', end = '2026-09-05', runRange, segmentDays = 31 } = {}) {
  const ledgers = new Map();
  const calls = [];
  const job = createCatchupJob({
    readLedger: mst => ledgers.get(mst) || null,
    writeLedger: (mst, ledger) => ledgers.set(mst, ledger),
    runRange: runRange || (async range => { calls.push(range); return { found: 1, downloaded: 1, imported: 1 }; }),
    now: () => NOW,
    segmentDays,
    log: () => {},
  });
  return { job, ledgers, calls, start, end };
}

test('job: lượt đầu quét đoạn đầu rồi ghi sổ; lượt sau tiếp đoạn kế', async () => {
  const { job, ledgers, calls, start, end } = makeJob({ end: '2026-09-05', segmentDays: 2 });
  const first = await job.runOne('4500101451', { start, end });
  assert.equal(first.done, false);
  assert.deepEqual(first.segment, { from: '2026-09-01', to: '2026-09-02', days: 2 });
  assert.equal(first.remaining, 3);
  // Cả hai hướng đều chạy, đúng MST và đúng khoảng.
  assert.deepEqual(calls.map(c => c.direction), ['BUY', 'SELL']);
  assert.ok(calls.every(c => c.mst === '4500101451' && c.from === '2026-09-01' && c.to === '2026-09-02'));

  const ledger = ledgers.get('4500101451');
  assert.deepEqual(Object.keys(ledger.days).sort(), ['2026-09-01', '2026-09-02']);
  assert.equal(ledger.lastFrom, '2026-09-01');
  assert.equal(ledger.start, '2026-09-01');

  const second = await job.runOne('4500101451', { start, end });
  assert.deepEqual(second.segment, { from: '2026-09-03', to: '2026-09-04', days: 2 });
  assert.equal(second.remaining, 1);

  const third = await job.runOne('4500101451', { start, end });
  assert.deepEqual(third.segment, { from: '2026-09-05', to: '2026-09-05', days: 1 });
  assert.equal(third.remaining, 0);
  assert.equal(third.done, true); // đoạn cuối: hết ngày thiếu ⇒ báo xong
  assert.ok(ledgers.get('4500101451').passFinishedAt);

  const fourth = await job.runOne('4500101451', { start, end });
  assert.equal(fourth.done, true);
  assert.equal(fourth.segment, null);
});

test('job: bị ngưng giữa chừng ⇒ KHÔNG ghi sổ, lượt sau làm lại đúng đoạn đó', async () => {
  let cancel = false;
  const { job, ledgers, calls, start, end } = makeJob({
    end: '2026-09-04', segmentDays: 2,
    runRange: async range => {
      calls.push(range);
      cancel = true; // người dùng mở cửa sổ ngay sau hướng Mua vào
      return { imported: 1 };
    },
  });
  const result = await job.runOne('4500101451', { start, end, isCancelled: () => cancel });
  assert.equal(result.cancelled, true);
  assert.equal(calls.length, 1); // hướng Bán ra không chạy
  assert.equal(ledgers.get('4500101451'), undefined);
  assert.equal(result.remaining, 4);
});

test('job: một hướng lỗi không chết hướng còn lại và KHÔNG ghi sổ (để lượt sau làm lại)', async () => {
  const { job, ledgers, calls, start, end } = makeJob({
    end: '2026-09-02', segmentDays: 2,
    runRange: async range => {
      calls.push(range);
      if (range.direction === 'BUY') throw new Error('cổng thuế bận');
      return { imported: 2 };
    },
  });
  const result = await job.runOne('4500101451', { start, end });
  assert.equal(result.ok, false);
  assert.equal(result.done, false);
  assert.equal(result.error, 'cổng thuế bận');
  assert.equal(result.remaining, 2); // chưa ghi sổ ⇒ vẫn còn nguyên ngày thiếu
  assert.deepEqual(calls.map(c => c.direction), ['BUY', 'SELL']);
  assert.equal(ledgers.get('4500101451'), undefined);
});

test('job: runRange bị huỷ (lỗi có cờ cancelled) ⇒ coi như ngưng, không ghi sổ, ok=false', async () => {
  const { job, ledgers, start, end } = makeJob({
    end: '2026-09-02',
    runRange: async () => { throw Object.assign(new Error('đã ngưng'), { cancelled: true }); },
  });
  const result = await job.runOne('4500101451', { start, end });
  assert.equal(result.cancelled, true);
  assert.equal(result.ok, false); // huỷ KHÔNG được báo là thành công
  assert.equal(result.done, false);
  assert.equal(ledgers.get('4500101451'), undefined);
});

test('parseDay: từ chối ngày không tồn tại (không tự cuộn sang ngày khác)', () => {
  const { parseDay } = require('../src/data/backfill-catchup');
  for (const bad of ['2026-02-31', '2026-04-31', '2026-13-05', '2026-00-10', '2026-09-31']) {
    assert.equal(parseDay(bad), null, `phải từ chối ${bad}`);
  }
  assert.ok(parseDay('2026-02-28') > 0);
  assert.ok(parseDay('2024-02-29') > 0); // năm nhuận
  assert.equal(parseDay('2026-02-29'), null);
});

test('server thật: /api/db/autosync/status có mục catchup (quét bù đã được nối)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-catchup-'));
  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    cwd: path.join(__dirname, '..'),
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  try {
    let match = null;
    for (let i = 0; i < 300 && !match; i += 1) {
      match = out.match(/\{"testUrl":"[^"]+"/);
      if (!match) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(match, `server không khởi động: ${out}`);
    const url = new URL(JSON.parse(`${match[0]}}`).testUrl);
    const body = await new Promise((resolve, reject) => {
      http.get({
        host: '127.0.0.1', port: Number(url.port), path: '/api/db/autosync/status',
        headers: { Cookie: `hd_session=${url.searchParams.get('launch')}` },
      }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text })); })
        .on('error', reject);
    });
    assert.equal(body.status, 200);
    const value = JSON.parse(body.text).value;
    assert.ok(value.catchup, 'thiếu mục catchup trong trạng thái Auto Sync');
    assert.equal(value.catchup.enabled, true);
    assert.equal(value.catchup.running, false);
    assert.equal(typeof value.catchup.reason, 'string');
    // Số luồng quét bù nằm trong 2–5 (ngẫu nhiên mỗi nhịp) và danh sách MST đang chạy là mảng.
    assert.ok(value.catchup.lanes >= 2 && value.catchup.lanes <= 5, `lanes ngoài 2–5: ${value.catchup.lanes}`);
    assert.ok(Array.isArray(value.catchup.msts));
    assert.ok(Array.isArray(value.catchup.active));
  } finally {
    child.kill();
  }
});

test('job: nhiều MST chạy SONG SONG được, nhưng cùng một MST thì bị chặn', async () => {
  const ledgers = new Map();
  let releaseA;
  const gateA = new Promise(resolve => { releaseA = resolve; });
  const job = createCatchupJob({
    readLedger: mst => ledgers.get(mst) || null,
    writeLedger: (mst, ledger) => ledgers.set(mst, ledger),
    runRange: async range => {
      if (range.mst === 'A') await gateA; // giữ MST A đang chạy để thử chồng lấn
      return { imported: 1 };
    },
    now: () => NOW,
    log: () => {},
  });

  const runA = job.runOne('A', { start: '2026-09-01', end: '2026-09-01' });
  assert.deepEqual(job.status().msts, ['A']);

  // CÙNG một MST ⇒ chặn ngay, không chạy trùng.
  const duplicate = await job.runOne('A', { start: '2026-09-01', end: '2026-09-01' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'đang chạy');

  // MST KHÁC ⇒ chạy được trong lúc A còn đang chạy.
  const runB = job.runOne('B', { start: '2026-09-01', end: '2026-09-01' });
  assert.deepEqual(job.status().msts.slice().sort(), ['A', 'B']);
  assert.equal(job.status().progresses.length, 2); // tiến độ tách riêng từng MST

  releaseA();
  const [a, b] = await Promise.all([runA, runB]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(job.status().running, false);
  assert.deepEqual(job.status().msts, []);
  assert.ok(ledgers.get('A').days['2026-09-01']);
  assert.ok(ledgers.get('B').days['2026-09-01']);
});

// ---------------------------------------------------------------------------
// LỖI 1: quét bù chạy CHỒNG lên lượt Auto Sync BẤM TAY (nút ▶) vẫn đang chạy nền sau khi
// người dùng đóng cửa sổ. Trước đây cổng chỉ biết "Đồng bộ tất cả" và lịch khung giờ.
// ---------------------------------------------------------------------------
test('cổng quét bù: lượt Auto Sync bấm tay đang chạy ⇒ CHẶN (không chạy chồng)', () => {
  const idle = { output: 'D:\\HoaDon', uiOpen: false };
  assert.equal(catchupGateReason(idle), '', 'máy rảnh thì phải cho chạy');
  assert.equal(catchupGateReason({ ...idle, autoSyncRunning: true }), 'đang chạy Auto Sync bấm tay');
  // Các cổng cũ vẫn nguyên.
  assert.equal(catchupGateReason({ ...idle, uiOpen: true }), 'cửa sổ app đang mở — nhường người dùng');
  assert.equal(catchupGateReason({ ...idle, manualBusy: true }), 'đang có việc thủ công');
  assert.equal(catchupGateReason({ ...idle, authBusy: true }), 'đang xử lý đăng nhập');
  assert.equal(catchupGateReason({ ...idle, poolRunning: true }), 'đang chạy "Đồng bộ tất cả"');
  assert.equal(catchupGateReason({ ...idle, backgroundRunning: true }), 'đang chạy nền theo khung giờ');
  assert.equal(catchupGateReason({ ...idle, outputBusy: true }), 'thư mục lưu đang do bản app khác chạy nền');
  assert.equal(catchupGateReason({ output: '' }), 'chưa chọn thư mục lưu');
});

// ---------------------------------------------------------------------------
// LỖI 2: MST xếp sau bị ĐÓI — cứ lấy theo thứ tự danh sách thì vài MST đầu chiếm hết lượt
// cho tới khi chúng quét xong toàn bộ lịch sử.
// ---------------------------------------------------------------------------
test('xếp hàng: MST LÂU CHƯA QUÉT nhất lên trước (không đói MST xếp sau)', () => {
  const rows = [
    { mst: 'A', lastRunAt: '2026-09-27T00:00:00.000Z' }, // vừa quét hôm qua
    { mst: 'B', lastRunAt: '2026-08-01T00:00:00.000Z' }, // lâu nhất
    { mst: 'C', lastRunAt: '' },                          // chưa quét bao giờ
  ];
  assert.deepEqual(orderLeastRecentlyRun(rows).map(row => row.mst), ['C', 'B', 'A']);
  // Không sửa mảng gốc (nơi gọi còn dùng lại).
  assert.deepEqual(rows.map(row => row.mst), ['A', 'B', 'C']);
});

test('chọn lượt: MST lâu chưa quét được ưu tiên, MST đang chạy bị bỏ qua', () => {
  const target = (mst, lastRunAt) => ({ mst, lastRunAt });
  const eligible = [target('A', '2026-09-27T00:00:00.000Z'), target('B', ''), target('C', '2026-09-01T00:00:00.000Z')];
  const hasToken = mst => mst !== 'C'; // C chưa token ⇒ phải đi một mình
  const picks = pickCatchupTargets({ eligible, running: [], lanes: 2, hasToken });
  assert.deepEqual(picks.map(row => row.mst), ['B', 'A']);
  // A đang chạy, còn ĐÚNG 1 chỗ ⇒ lấy B (chưa quét bao giờ) — C chưa token nên chờ lượt.
  const next = pickCatchupTargets({ eligible, running: ['A'], lanes: 2, hasToken });
  assert.deepEqual(next.map(row => row.mst), ['B']);
  // Còn 2 chỗ ⇒ C (chưa token) được thêm vào và đi MỘT MÌNH.
  const wider = pickCatchupTargets({ eligible, running: ['A'], lanes: 3, hasToken });
  assert.deepEqual(wider.map(row => row.mst), ['B', 'C']);
  // Hết chỗ ⇒ không chọn thêm.
  assert.deepEqual(pickCatchupTargets({ eligible, running: ['A', 'B'], lanes: 2, hasToken }), []);
  // Đã có một MST chưa token đang chạy ⇒ KHÔNG thêm MST chưa token thứ hai
  // (hai MST cùng mở chung một cửa sổ Chrome).
  const onlyNonToken = pickCatchupTargets({ eligible: [target('X', ''), target('Y', '')], running: ['Y'], lanes: 3, hasToken: () => false });
  assert.deepEqual(onlyNonToken.map(row => row.mst), []);
});

// ---------------------------------------------------------------------------
// LỖI 3: đệm/cooldown quét bù khoá theo MST ⇒ đổi "Thư mục lưu" vẫn hiện số liệu cũ.
// ---------------------------------------------------------------------------
test('khoá đệm quét bù gắn thêm thư mục lưu (đổi thư mục là không dính số liệu cũ)', () => {
  assert.equal(catchupCacheKey('D:\\HoaDon', '4500101451'), catchupCacheKey('D:\\HoaDon', '4500101451'));
  assert.notEqual(catchupCacheKey('D:\\HoaDon', '4500101451'), catchupCacheKey('E:\\SaoKe', '4500101451'));
  assert.notEqual(catchupCacheKey('', '4500101451'), catchupCacheKey('D:\\HoaDon', '4500101451'));
});

test('server thật: đổi "Thư mục lưu" thì dòng MST KHÔNG còn hiện "quét bù tới ngày cũ"', async () => {
  const MST = '4500101451';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-catchup-folder-'));
  const folderA = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-folder-a-'));
  const folderB = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-folder-b-'));
  // Thư mục A đã có SỔ quét bù (tới 31/08) — đây là thứ trước đây bị "dính" sang thư mục B.
  const mstDirA = dataLayer.mst.mstDirectory(folderA, MST);
  fs.mkdirSync(mstDirA, { recursive: true });
  const db = openDatabase(path.join(mstDirA, 'data.db'));
  try {
    applySchema(db);
    setSyncState(db, 'catchup.scan', { version: 1, days: { '2026-08-30': NOW, '2026-08-31': NOW } });
  } finally { closeDatabase(db); }
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    accounts: [{ mst: MST, name: 'Khách A' }], selected: MST, output: folderA, firstRunAt: '2026-01-01T00:00:00.000Z',
  }));

  const child = spawn(process.execPath, ['src/server.js', '--test-server'], {
    env: { ...process.env, HOADON_TEST_DATA: dataDir, HOADON_NO_UPDATE_CHECK: '1' },
    cwd: path.join(__dirname, '..'),
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { out += chunk; });
  try {
    let match = null;
    for (let i = 0; i < 300 && !match; i += 1) {
      match = out.match(/\{"testUrl":"[^"]+"/);
      if (!match) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(match, `server không khởi động: ${out}`);
    const url = new URL(JSON.parse(`${match[0]}}`).testUrl);
    const cookie = `hd_session=${url.searchParams.get('launch')}`;
    const call = (method, route, payload) => new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : '';
      const req = http.request({
        host: '127.0.0.1', port: Number(url.port), path: route, method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve(JSON.parse(text))); });
      req.on('error', reject);
      req.end(body);
    });

    const before = await call('GET', '/api/state');
    assert.equal(before.value.output, folderA);
    assert.equal(before.value.accounts[0].catchup.scannedTo, '2026-08-31');

    await call('POST', '/api/folder', { path: folderB });
    const after = await call('GET', '/api/state');
    assert.equal(after.value.output, folderB);
    assert.equal(after.value.accounts[0].catchup.scannedTo, '', 'vẫn hiện sổ quét bù của thư mục CŨ');
    assert.equal(after.value.accounts[0].catchup.scannedDays, 0);
  } finally {
    child.kill();
  }
});

test('job: sổ đã đủ (và không tới hạn quét lại) ⇒ done ngay, không gọi cổng thuế', async () => {
  const ledger = { version: 1, days: { '2026-09-01': NOW - 2 * DAY_MS, '2026-09-02': NOW - 2 * DAY_MS } };
  const job = createCatchupJob({
    readLedger: () => ledger,
    writeLedger: () => { throw new Error('không được ghi sổ'); },
    runRange: async () => { throw new Error('không được gọi cổng thuế'); },
    log: () => {},
    now: () => NOW,
  });
  const result = await job.runOne('4500101451', { start: '2026-09-01', end: '2026-09-02' });
  assert.equal(result.done, true);
  assert.equal(result.segment, null);
  assert.equal(result.remaining, 0);
});
