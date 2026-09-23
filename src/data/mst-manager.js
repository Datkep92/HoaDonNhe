'use strict';
// ---------------------------------------------------------------------------
// MST Manager — PROJECT_ARCHITECTURE §4, §5, §6, §28.
//
// 1 MST = 1 vùng dữ liệu: <thư mục lưu>/MST-<MST>/
//   ├── Mua_vao/     (XML mua vào — do luồng thủ công tải về)
//   ├── Ban_ra/      (XML bán ra)
//   ├── data.db      (index/truy vấn)
//   └── sync.json    (trạng thái Auto Sync)
//
// Tên thư mục XML giữ nguyên như luồng thủ công đang dùng (Mua_vao/Ban_ra) để KHÔNG phá
// hành vi hiện có (mục 12/§86.13). Đây là điểm đã báo trong SOURCE_ANALYSIS.md (C1/C7).
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./sqlite');

const XML_FOLDERS = ['Mua_vao', 'Ban_ra'];
const SYNC_VERSION = 1;

// Dùng lại đúng hàm đặt tên an toàn của luồng thủ công (src/core.js) thay vì viết bản thứ hai
// (mục 76: extract dùng chung, không nhân bản). require() muộn để tầng dữ liệu không phụ thuộc
// cứng vào engine khi chỉ cần đọc đường dẫn.
function mstFolderName(mst) {
  const { safeName } = require('../core');
  return `MST-${safeName(String(mst ?? '').trim())}`;
}

function mstDirectory(output, mst) {
  const base = String(output ?? '').trim();
  if (!base) throw new Error('Chưa có thư mục lưu dữ liệu.');
  if (!path.isAbsolute(base)) throw new Error('Thư mục lưu phải là đường dẫn đầy đủ.');
  const value = String(mst ?? '').trim();
  if (!value) throw new Error('Chưa chọn MST.');
  return path.join(base, mstFolderName(value));
}

// §28 — sync.json chỉ là trạng thái/cấu hình, KHÔNG thay SQLite.
function defaultSyncState() {
  const empty = () => ({ lastSync: null, lastSuccess: null, status: 'idle', lastError: null, lastErrorTime: null, found: 0, downloaded: 0, skipped: 0, imported: 0, errors: 0 });
  return {
    version: SYNC_VERSION,
    // Cấu hình Auto Sync nằm cùng file (mục 28 cho phép mở rộng).
    // Mặc định BẬT để tự dò hoá đơn mới trong nền (mục 30); người dùng vẫn tắt được trong tab Kho dữ liệu.
    settings: { enabled: true, days: 7, intervalMinutes: 30 },
    buy: empty(),
    sell: empty(),
  };
}

function readSyncState(file) {
  if (!fs.existsSync(file)) return defaultSyncState();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = defaultSyncState();
    return {
      version: value.version || SYNC_VERSION,
      settings: { ...base.settings, ...(value.settings || {}) },
      buy: { ...base.buy, ...(value.buy || {}) },
      sell: { ...base.sell, ...(value.sell || {}) },
    };
  } catch {
    // File hỏng: trả về trạng thái mặc định, KHÔNG tự ghi đè (để còn dấu vết kiểm tra).
    return defaultSyncState();
  }
}

function writeSyncState(file, state) {
  const base = defaultSyncState();
  const value = {
    version: (state && state.version) || SYNC_VERSION,
    settings: { ...base.settings, ...((state && state.settings) || {}) },
    buy: { ...base.buy, ...((state && state.buy) || {}) },
    sell: { ...base.sell, ...((state && state.sell) || {}) },
  };
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}

// Tạo (nếu thiếu) vùng dữ liệu của MST rồi mở data.db.
function ensureMst({ output, mst }) {
  const dir = mstDirectory(output, mst);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of XML_FOLDERS) fs.mkdirSync(path.join(dir, name), { recursive: true });
  const dbFile = path.join(dir, 'data.db');
  const syncFile = path.join(dir, 'sync.json');
  if (!fs.existsSync(syncFile)) writeSyncState(syncFile, defaultSyncState());
  const db = openDatabase(dbFile);
  return { dir, dbFile, syncFile, db };
}

module.exports = { ensureMst, mstDirectory, mstFolderName, defaultSyncState, readSyncState, writeSyncState, XML_FOLDERS };
