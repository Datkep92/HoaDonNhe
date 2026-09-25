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
const { readSyncState, defaultSyncState } = require('../src/data/mst-manager');

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
