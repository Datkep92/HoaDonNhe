'use strict';
// ---------------------------------------------------------------------------
// KHOÁ THEO THƯ MỤC LƯU — chặn hai bản app cùng chạy nền trên MỘT dữ liệu.
//
// VÌ SAO CẦN: chốt "một instance" hiện có (`du_lieu/app.pid.json`) chỉ theo TỪNG workspace.
// Nhưng nhiều bản app (bản gốc, bản copy, EXE đã cài) có thể cùng trỏ vào MỘT thư mục lưu —
// đã kiểm chứng thật: `release/du_lieu/accounts.json` và `du_lieu/accounts.json` cùng ghi
// `F:\web\New folder`. Khi đó hai bản sẽ cùng tra cứu/tải và cùng ghi `sync.json` + job file
// của CÙNG một MST. Khoá này đặt ở chính thư mục lưu nên nó nhìn thấy mọi bản.
//
// GIÀNH KHOÁ LÀ NGUYÊN TỬ: `fs.openSync(file, 'wx')` tạo-loại-trừ, chỉ một tiến trình thắng.
// Không dùng "đọc rồi ghi" vì hai bản chạy đúng lúc sẽ cùng đọc thấy trống rồi cùng ghi.
//
// KHOÁ CÓ NHỊP TIM: bản đang giữ ghi lại `heartbeatAt` mỗi nhịp lập lịch. Chỉ coi là "bản khác
// đang chạy" khi pid CÒN SỐNG **và** nhịp tim còn mới — nhờ vậy pid bị hệ điều hành tái dùng
// không khoá được thư mục mãi mãi.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const LOCK_NAME = '.hd-bg-lock.json';
// Không nhịp tim trong 3 phút ⇒ coi như bỏ khoá. Nhịp lập lịch 20 giây nên 3 phút là rất rộng.
const STALE_MS = 3 * 60 * 1000;

function lockFile(output) {
  const dir = String(output || '').trim();
  return dir ? path.join(dir, LOCK_NAME) : '';
}

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && Number.isInteger(Number(raw.pid)) && Number(raw.pid) > 0 ? raw : null;
  } catch { return null; }
}

// Tiến trình còn sống? EPERM = có thật nhưng không có quyền gửi tín hiệu ⇒ vẫn tính là sống.
function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; }
  catch (error) { return !!(error && error.code === 'EPERM'); }
}

function heartbeatFresh(lock) {
  const at = Date.parse((lock && (lock.heartbeatAt || lock.startedAt)) || '') || 0;
  return at > 0 && Date.now() - at < STALE_MS;
}

// Ai đang giữ khoá: 'none' (chưa có) · 'mine' · 'other' (bản KHÁC đang sống) · 'stale' (bỏ khoá).
function inspect(output, { pid = process.pid, workspace = '' } = {}) {
  const file = lockFile(output);
  if (!file) return { state: 'none', file: '', lock: null };
  const lock = readLock(file);
  if (!lock) return { state: 'none', file, lock: null };
  if (Number(lock.pid) === Number(pid) && String(lock.workspace || '') === String(workspace || '')) {
    return { state: 'mine', file, lock };
  }
  if (pidAlive(lock.pid) && heartbeatFresh(lock)) return { state: 'other', file, lock };
  return { state: 'stale', file, lock };
}

function payload(pid, workspace) {
  const now = new Date().toISOString();
  return JSON.stringify({ version: 1, pid, workspace, startedAt: now, heartbeatAt: now });
}

// Giành (hoặc giữ) khoá. Trả { ok, state, reason }.
function claim(output, { pid = process.pid, workspace = '' } = {}) {
  const file = lockFile(output);
  if (!file) return { ok: false, state: 'none', reason: 'chưa chọn thư mục lưu' };

  let existing = inspect(output, { pid, workspace });
  if (existing.state === 'other') {
    const who = existing.lock || {};
    return { ok: false, state: 'other', reason: `thư mục lưu đang do bản app khác chạy nền (pid ${who.pid})` };
  }
  if (existing.state === 'mine') {
    // Còn là chủ: chỉ ghi lại nhịp tim, không cần giành lại.
    try { fs.writeFileSync(file, payload(pid, workspace)); return { ok: true, state: 'mine' }; }
    catch (error) { return { ok: false, state: 'mine', reason: `không ghi được nhịp tim: ${error.message}` }; }
  }

  // 'none' hoặc 'stale' ⇒ giành bằng cách tạo-loại-trừ (nguyên tử).
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, payload(pid, workspace)); } finally { fs.closeSync(fd); }
    return { ok: true, state: 'claimed' };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, state: 'none', reason: 'thư mục lưu chưa tồn tại' };
    if (error.code !== 'EEXIST') return { ok: false, state: 'none', reason: `không giành được khoá: ${error.message}` };
  }

  // Có bản khác vừa giành trước mình trong lúc ta kiểm tra.
  existing = inspect(output, { pid, workspace });
  if (existing.state === 'other') return { ok: false, state: 'other', reason: `thư mục lưu đang do bản app khác chạy nền (pid ${existing.lock.pid})` };
  // Khoá cũ bỏ: xoá rồi giành lại MỘT lần.
  try { fs.rmSync(file, { force: true }); } catch { /* bỏ qua */ }
  try {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, payload(pid, workspace)); } finally { fs.closeSync(fd); }
    return { ok: true, state: 'claimed' };
  } catch (error) {
    return { ok: false, state: 'other', reason: `không giành được khoá: ${error.message}` };
  }
}

// Nhả khoá — CHỈ xoá khi khoá đúng là của mình, để không xoá khoá của bản khác.
function release(output, { pid = process.pid, workspace = '' } = {}) {
  const seen = inspect(output, { pid, workspace });
  if (seen.state !== 'mine') return false;
  try { fs.rmSync(seen.file, { force: true }); return true; } catch { return false; }
}

module.exports = { LOCK_NAME, STALE_MS, lockFile, pidAlive, inspect, claim, release };
