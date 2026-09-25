'use strict';
// ---------------------------------------------------------------------------
// KHOÁ THEO THƯ MỤC LƯU — chặn hai bản app cùng chạy nền trên MỘT dữ liệu.
//
// Ca thật đã gặp: nhiều bản app (bản gốc / bản copy / EXE đã cài) cùng trỏ vào một thư mục lưu,
// nên chốt "một instance" theo workspace không nhìn thấy nhau. Khoá đặt trong chính thư mục lưu
// thì nhìn thấy mọi bản.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lock = require('../src/data/output-lock');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-lock-'));
const withDir = fn => { const dir = tempDir(); try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
const writeLock = (dir, payload) => fs.writeFileSync(path.join(dir, lock.LOCK_NAME), JSON.stringify(payload));

test('giành khoá khi chưa ai giữ: tạo file trong thư mục lưu với pid + workspace', () => {
  withDir(dir => {
    const result = lock.claim(dir, { pid: 111, workspace: 'C:\\ws-a' });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'claimed');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf8'));
    assert.equal(saved.pid, 111);
    assert.equal(saved.workspace, 'C:\\ws-a');
    assert.ok(saved.heartbeatAt, 'phải có nhịp tim để bản khác biết còn sống');
  });
});

test('giữ lại khoá của chính mình thì chỉ cập nhật nhịp tim, không giành lại', () => {
  withDir(dir => {
    lock.claim(dir, { pid: 111, workspace: 'C:\\ws-a' });
    const first = JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf8')).heartbeatAt;
    const again = lock.claim(dir, { pid: 111, workspace: 'C:\\ws-a' });
    assert.equal(again.ok, true);
    assert.equal(again.state, 'mine');
    const second = JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf8')).heartbeatAt;
    assert.ok(second >= first, 'nhịp tim phải được ghi lại');
  });
});

test('BẢN KHÁC đang sống và nhịp tim còn mới ⇒ KHÔNG giành được, và không xoá khoá của họ', () => {
  withDir(dir => {
    // pid = pid tiến trình này (chắc chắn còn sống), nhưng workspace KHÁC ⇒ là bản app khác.
    writeLock(dir, { pid: process.pid, workspace: 'C:\\ws-khac', heartbeatAt: new Date().toISOString() });
    const seen = lock.inspect(dir, { pid: process.pid, workspace: 'C:\\ws-toi' });
    assert.equal(seen.state, 'other');

    const result = lock.claim(dir, { pid: process.pid, workspace: 'C:\\ws-toi' });
    assert.equal(result.ok, false, 'không được chạy nền khi bản khác đang giữ');
    assert.match(result.reason, /bản app khác/);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf8'));
    assert.equal(kept.workspace, 'C:\\ws-khac', 'không được ghi đè khoá của bản khác');
    assert.equal(lock.release(dir, { pid: process.pid, workspace: 'C:\\ws-toi' }), false, 'không được xoá khoá của bản khác');
  });
});

test('khoá cũ NHỊP TIM ĐÃ CŨ ⇒ giành lại được (không kẹt vĩnh viễn vì pid tái dùng)', () => {
  withDir(dir => {
    const old = new Date(Date.now() - lock.STALE_MS - 60000).toISOString();
    writeLock(dir, { pid: process.pid, workspace: 'C:\\ws-khac', heartbeatAt: old });
    assert.equal(lock.inspect(dir, { pid: process.pid, workspace: 'C:\\ws-toi' }).state, 'stale');
    const result = lock.claim(dir, { pid: process.pid, workspace: 'C:\\ws-toi' });
    assert.equal(result.ok, true, 'khoá bỏ thì phải giành lại được');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, lock.LOCK_NAME), 'utf8')).workspace, 'C:\\ws-toi');
  });
});

test('file khoá hỏng/thiếu ⇒ coi như chưa có, vẫn giành được', () => {
  withDir(dir => {
    fs.writeFileSync(path.join(dir, lock.LOCK_NAME), '{ hong json');
    assert.equal(lock.inspect(dir, { pid: 1, workspace: 'a' }).state, 'none');
    assert.equal(lock.claim(dir, { pid: 111, workspace: 'a' }).ok, true);
  });
  withDir(dir => {
    fs.writeFileSync(path.join(dir, lock.LOCK_NAME), JSON.stringify({ workspace: 'a' }));
    assert.equal(lock.inspect(dir, { pid: 1, workspace: 'a' }).state, 'none', 'thiếu pid ⇒ không phải khoá hợp lệ');
  });
});

test('nhả khoá: chỉ xoá khi đúng là khoá của mình', () => {
  withDir(dir => {
    lock.claim(dir, { pid: 111, workspace: 'C:\\ws-a' });
    assert.equal(lock.release(dir, { pid: 111, workspace: 'C:\\ws-b' }), false, 'khác workspace ⇒ không phải của mình');
    assert.ok(fs.existsSync(path.join(dir, lock.LOCK_NAME)));
    assert.equal(lock.release(dir, { pid: 111, workspace: 'C:\\ws-a' }), true);
    assert.ok(!fs.existsSync(path.join(dir, lock.LOCK_NAME)));
  });
});

test('chưa chọn thư mục lưu / thư mục chưa tồn tại ⇒ không giành được, không tự tạo thư mục', () => {
  assert.equal(lock.claim('', { pid: 1, workspace: 'a' }).ok, false);
  assert.match(lock.claim('', { pid: 1, workspace: 'a' }).reason, /chưa chọn thư mục lưu/);
  const missing = path.join(os.tmpdir(), `hoadon-khong-co-${Date.now()}`);
  const result = lock.claim(missing, { pid: 1, workspace: 'a' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /chưa tồn tại/);
  assert.ok(!fs.existsSync(missing), 'không được tự tạo thư mục lưu của người dùng');
});

test('pidAlive: pid của chính mình là sống, pid 0/âm là chết', () => {
  assert.equal(lock.pidAlive(process.pid), true);
  assert.equal(lock.pidAlive(0), false);
  assert.equal(lock.pidAlive(-5), false);
  assert.equal(lock.pidAlive('khong-phai-so'), false);
});

test('bộ lập lịch có cổng thứ ba cho khoá thư mục lưu, và server nối đúng', () => {
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'sync-scheduler.js'), 'utf8');
  assert.ok(scheduler.includes("reason: 'thư mục lưu đang do bản app khác chạy nền'"), 'thiếu cổng chặn theo khoá thư mục lưu');
  assert.ok(scheduler.includes('heartbeat()'), 'mỗi nhịp phải ghi lại nhịp tim của khoá');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('outputBusy,'), 'phải nối cổng outputBusy');
  assert.ok(server.includes('heartbeat: touchOutputLock,'), 'phải nối nhịp tim');
  assert.ok(server.includes('outputLock.release(output'), 'khi thoát phải nhả khoá');
});
