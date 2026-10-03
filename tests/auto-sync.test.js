'use strict';
// ---------------------------------------------------------------------------
// Test PHASE 4 – AUTO SYNC (§23–§28, §30, §66) và móc shouldSkip của Engine (§19 lớp 1).
// Không gọi mạng: bộ điều phối nhận `runDirection` giả; Engine nhận `request` giả.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Engine } = require('../src/core');
const { createAutoSync } = require('../src/data/auto-sync');
const { readSyncState, writeSyncState, defaultSyncState } = require('../src/data/mst-manager');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-sync-')); }

const invoice = n => ({ shdon: String(n), nbmst: '0123456789', khhdon: 'C26TAA', khmshdon: '1', tthai: 1 });

function makeEngine(dir, { shouldSkip, counter } = {}) {
  const request = async route => {
    if (route.includes('/invoices/purchase')) {
      return Buffer.from(JSON.stringify({ datas: [invoice(1), invoice(2), invoice(3)], state: null, total: 3 }));
    }
    if (route.includes('export-xml')) {
      counter.downloads += 1;
      const number = new URLSearchParams(String(route).split('?')[1] || '').get('shdon') || '';
      return Buffer.from(`<HDon><DLHDon Id="X"><TTChung><SHDon>${number}</SHDon></TTChung></DLHDon></HDon>`);
    }
    throw new Error(`route lạ trong test: ${route}`);
  };
  return new Engine({
    store: path.join(dir, 'job.json'),
    identity: async () => ({ key: 'k', mst: '0123456789', label: 'MST test' }),
    request,
    emit: () => {},
    pdf: async () => Buffer.from('%PDF'),
    excel: async () => Buffer.from('PK'),
    shouldSkip,
  });
}

const params = { direction: 'purchase', family: 'query', from: '2026-09-01', to: '2026-09-30', status: '', formats: ['xml'] };

test('§66 (trọng yếu) – 3 hoá đơn API, 2 đã có trong SQLite ⇒ CHỈ tải 1', async () => {
  const dir = tempDir();
  try {
    const counter = { downloads: 0 };
    // Giả lập SQLite: hoá đơn số 1 và số 2 đã có.
    const engine = makeEngine(dir, { counter, shouldSkip: async inv => ['1', '2'].includes(String(inv.shdon)) });
    await engine.search(params, dir);
    await engine.resume(true);
    assert.equal(counter.downloads, 1, 'chỉ tải đúng hoá đơn chưa có');
    assert.equal(engine.job.stats.existed, 2, 'hai hoá đơn được tính là đã có sẵn');
    assert.equal(engine.job.stats.downloaded, 1);
    assert.equal(engine.job.stats.queued, 1, 'chỉ một hoá đơn vào hàng tải');
    assert.equal(engine.job.items.filter(x => x.state === 'skipped').length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('luồng thủ công KHÔNG truyền shouldSkip ⇒ tải đủ, hành vi không đổi (mục 12)', async () => {
  const dir = tempDir();
  try {
    const counter = { downloads: 0 };
    const engine = makeEngine(dir, { counter });
    await engine.search(params, dir);
    await engine.resume(true);
    assert.equal(counter.downloads, 3, 'không có móc thì vẫn tải như trước');
    assert.equal(engine.job.stats.downloaded, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shouldSkip lỗi thì KHÔNG chặn tải (an toàn trước, không bỏ sót hoá đơn)', async () => {
  const dir = tempDir();
  try {
    const counter = { downloads: 0 };
    const engine = makeEngine(dir, { counter, shouldSkip: async () => { throw new Error('SQLite tạm lỗi'); } });
    await engine.search(params, dir);
    await engine.resume(true);
    assert.equal(counter.downloads, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto Sync: Mua vào xong mới tới Bán ra, KHÔNG chạy song song', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const order = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction, days }) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(`${direction}:${days}`);
        await new Promise(resolve => setTimeout(resolve, 5));
        concurrent -= 1;
        return { found: 10, downloaded: 1, skipped: 9, imported: 1, errors: 0 };
      },
    });
    autoSync.configure({ days: 7 });
    const result = await autoSync.run('test');
    assert.deepEqual(order, ['BUY:7', 'SELL:7'], 'đúng thứ tự và dùng đúng số ngày cấu hình');
    assert.equal(maxConcurrent, 1, 'không bao giờ chạy song song');
    assert.equal(result.skipped, false);
    const state = readSyncState(syncFile);
    assert.equal(state.buy.status, 'idle');
    assert.ok(state.buy.lastSuccess);
    assert.equal(state.buy.downloaded, 1);
    assert.equal(state.sell.imported, 1);
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto Sync: một hướng lỗi không làm chết hướng còn lại (mục 42/71)', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction }) => {
        if (direction === 'BUY') throw new Error('Phiên cổng thuế đã hết');
        return { found: 4, downloaded: 0, skipped: 4, imported: 0, errors: 0 };
      },
    });
    await autoSync.run('test');
    const state = readSyncState(syncFile);
    assert.equal(state.buy.status, 'error');
    assert.match(state.buy.lastError, /Phiên cổng thuế đã hết/);
    assert.ok(state.buy.lastErrorTime);
    assert.ok(state.sell.lastSuccess, 'hướng còn lại vẫn chạy xong');
    assert.equal(state.sell.found, 4);
    assert.match(autoSync.status().error, /Phiên cổng thuế/);
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto Sync: không tranh cổng thuế với luồng thủ công, và không chạy chồng', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    let manualBusy = true;
    let calls = 0;
    const autoSync = createAutoSync({
      syncFile,
      manualBusy: () => manualBusy,
      runDirection: async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 };
      },
    });
    const deferred = await autoSync.run('schedule');
    assert.deepEqual(deferred, { skipped: true, reason: 'manual-busy' });
    assert.equal(calls, 0, 'luồng thủ công đang bận thì hoãn, không gọi cổng thuế');

    manualBusy = false;
    const first = autoSync.run('manual');
    await assert.rejects(autoSync.run('manual'), /đang chạy/i);
    await first;
    assert.equal(calls, 2, 'chạy đúng hai hướng');
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto Sync: cấu hình lưu vào sync.json và bị kẹp trong khoảng hợp lệ', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const autoSync = createAutoSync({ syncFile, runDirection: async () => ({}) });
    const settings = autoSync.configure({ enabled: true, days: 999, intervalMinutes: 1 });
    assert.equal(settings.enabled, true);
    assert.equal(settings.days, 365);
    assert.equal(settings.intervalMinutes, 5);
    const saved = readSyncState(syncFile).settings;
    assert.equal(saved.enabled, true);
    assert.equal(saved.days, 365);
    assert.equal(defaultSyncState().settings.enabled, true, 'mặc định BẬT để tự dò hoá đơn mới');
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto Sync: status() đủ dữ liệu cho UI, và an toàn khi chưa chọn MST/thư mục', async () => {
  const dir = tempDir();
  try {
    const autoSync = createAutoSync({ syncFile: () => '', runDirection: async () => ({}) });
    const empty = autoSync.status();
    assert.equal(empty.running, false);
    assert.equal(empty.settings.enabled, true, 'mặc định bật tự dò hoá đơn mới');
    assert.equal(empty.directions.buy.status, 'idle');
    autoSync.stop();

    const syncFile = path.join(dir, 'sync.json');
    const second = createAutoSync({ syncFile, runDirection: async () => ({ found: 2, downloaded: 1 }) });
    await second.run('manual');
    const status = second.status();
    assert.equal(status.running, false);
    assert.ok(status.finishedAt);
    assert.equal(status.directions.buy.found, 2);
    assert.equal(status.directions.sell.found, 2, 'cùng hàm chạy giả nên cả hai hướng đều báo 2');
    second.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// NHƯỜNG ĐÚNG LÚC — lỗ hổng thật: pause engine KHÔNG có tác dụng khi lượt đang ở KHE GIỮA hai
// hướng. Khi đó `autoSyncEngines` đã trống, nên người dùng mở lại cửa sổ (hoặc hết khung giờ)
// chỉ làm bộ lập lịch báo "đã nhường" còn Bán ra vẫn quét tiếp vào cổng thuế.
// ---------------------------------------------------------------------------
test('yieldNow() giữa hai hướng ⇒ KHÔNG chạy hướng còn lại', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const order = [];
    let release;
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction }) => {
        order.push(direction);
        if (direction === 'BUY') {
          // Ngay khi Mua vào xong (đúng khe giữa hai hướng) thì yêu cầu dừng.
          await new Promise(resolve => { release = resolve; });
        }
        return { found: 1, downloaded: 1, skipped: 0, imported: 1, errors: 0 };
      },
    });
    const running = autoSync.run('window');
    // Chờ Mua vào bắt đầu rồi yêu cầu nhường, rồi cho Mua vào kết thúc.
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(autoSync.yieldNow('người dùng mở lại cửa sổ'), true);
    release();
    const result = await running;
    assert.deepEqual(order, ['BUY'], 'Bán ra KHÔNG được chạy sau khi đã yêu cầu nhường');
    assert.equal(result.stopped, true, 'lượt phải báo là bị dừng, không phải xong');
    assert.equal(result.detail.sell.stopped, true);
    // Bán ra không được ghi 'running' vào sync.json — không đụng cổng thuế thì không có dấu vết.
    const state = readSyncState(syncFile);
    assert.equal(state.sell.lastSync, null, 'hướng bị bỏ qua không được đánh dấu đã thử');
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yieldNow() khi lượt đang BAY ⇒ hướng đó dừng và không chạy hướng sau', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const order = [];
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction }) => {
        order.push(direction);
        // Mô phỏng engine ném cờ paused khi bị nhường (như pause() của Engine).
        if (direction === 'BUY') throw Object.assign(new Error('Đã tạm dừng.'), { paused: true });
        return { found: 1, downloaded: 1, skipped: 0, imported: 1, errors: 0 };
      },
    });
    const running = autoSync.run('window');
    while (!order.length) await new Promise(resolve => setTimeout(resolve, 5));
    autoSync.yieldNow('hết khung giờ');
    const result = await running;
    assert.deepEqual(order, ['BUY'], 'Bán ra không được chạy sau khi BUY đã bị dừng');
    assert.equal(result.stopped, true);
    assert.match(result.detail.buy.error, /tạm dừng/i, 'lỗi paused KHÔNG được ghi là lỗi thật');
    const state = readSyncState(syncFile);
    // Cờ `paused` ⇒ đánh dấu 'idle' + XOÁ lastError. Dùng dừng là trạng thái bình thường, không
    // phải lỗi — nếu ghi 'error' thì banner MST hiện "Lỗi" đỏ sau mỗi lần người dùng mở lại
    // cửa sổ lúc đang đồng bộ nền, và bộ lập lịch tưởng MST hỏng thật.
    assert.equal(state.buy.status, 'idle', 'dừng theo yêu cầu phải để lại trạng thái nghỉ, không phải lỗi');
    assert.equal(state.buy.lastError, null, 'dừng thì không được để lại lastError');
    assert.equal(state.sell.lastSync, null);
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('yieldNow() khi KHÔNG có lượt chạy ⇒ không nổ, và lượt sau chạy lại bình thường', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const order = [];
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction }) => { order.push(direction); return { found: 1, downloaded: 1, imported: 1 }; },
    });
    assert.equal(autoSync.yieldNow('không có gì để dừng'), false, 'không có lượt thì không nhận yêu cầu dừng');
    assert.equal(autoSync.status().yieldReason, '', 'không lưu lý do khi không có lượt');
    await autoSync.run('manual');
    assert.deepEqual(order, ['BUY', 'SELL'], 'lượt sau phải chạy trọn cả hai hướng');
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hai hướng chạy SONG SONG (parallel) không mất lastSuccess của nhau', async () => {
  // patchState() là khối đồng bộ không có await nên không thể chen vào nhau; khối sau luôn đọc
  // lại nên thấy kết quả khối trước. Test này ghim hành vi đó — trước đây chỉ có test tuần tự.
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    let concurrent = 0, maxConcurrent = 0;
    const autoSync = createAutoSync({
      syncFile,
      parallel: () => true,
      runDirection: async ({ direction }) => {
        concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(resolve => setTimeout(resolve, 10));
        concurrent -= 1;
        // Trả về số khác nhau để phát hiện nếu một hướng ghi đè kết quả của hướng kia.
        return { found: direction === 'BUY' ? 11 : 22, downloaded: direction === 'BUY' ? 1 : 2, imported: 0, errors: 0 };
      },
    });
    const result = await autoSync.run('manual');
    assert.equal(maxConcurrent, 2, 'parallel phải chạy đồng thời cả hai hướng');
    assert.equal(result.parallel, true);
    const state = readSyncState(syncFile);
    assert.equal(state.buy.found, 11, 'Mua vào giữ được số riêng');
    assert.equal(state.sell.found, 22, 'Bán ra KHÔNG bị Mua vào ghi đè');
    assert.ok(state.buy.lastSuccess && state.sell.lastSuccess, 'cả hai hướng đều phải có lastSuccess');
    assert.equal(state.settings.days, 7, 'cấu hình không bị mất khi hai hướng cùng ghi');
    autoSync.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync.json ghi NGUYÊN TỬ và không để lại file tạm', () => {
  // Ghi thẳng có thể để lại JSON bị cắt cụt nếu mất điện giữa chừng; file hỏng thì
  // readSyncState trả về mặc định ⇒ MẤT toàn bộ lịch sử đồng bộ của MST.
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const state = defaultSyncState();
    state.buy.lastSuccess = '2026-09-25T10:00:00.000Z';
    writeSyncState(syncFile, state);
    assert.deepEqual(readSyncState(syncFile).buy.lastSuccess, '2026-09-25T10:00:00.000Z');
    // Ghi đè lần nữa: file cũ phải bị thay trọn vẹn, không cộng dồn hai lần ghi.
    const second = defaultSyncState();
    second.sell.lastSuccess = '2026-09-25T11:00:00.000Z';
    writeSyncState(syncFile, second);
    const read = readSyncState(syncFile);
    assert.equal(read.sell.lastSuccess, '2026-09-25T11:00:00.000Z');
    assert.equal(read.buy.lastSuccess, null, 'ghi đè phải sạch, không giữ dữ liệu lần trước');
    // Không sót file tạm trong thư mục MST (file tạm sẽ bị quét nhầm khi sao chép hồ sơ).
    const leftovers = fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `còn file tạm sót: ${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync.json HỎNG thì không được làm hỏng lượt sau — đọc trả mặc định nhưng ghi đè lại được', () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    fs.writeFileSync(syncFile, '{"buy":{"lastSuc');   // JSON cắt cụt
    const state = readSyncState(syncFile);
    assert.equal(state.buy.lastSuccess, null, 'file hỏng thì trả mặc định, không ném lỗi');
    state.buy.lastSuccess = '2026-09-25T10:00:00.000Z';
    writeSyncState(syncFile, state);
    assert.equal(readSyncState(syncFile).buy.lastSuccess, '2026-09-25T10:00:00.000Z', 'phải ghi đè được sau khi file hỏng');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
