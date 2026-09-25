'use strict';
// ---------------------------------------------------------------------------
// Mở / tạo data.db cho một MST — PROJECT_ARCHITECTURE §10, §45, §47.
//
// Dùng node:sqlite (module built-in của Node 22+) nên KHÔNG cần native addon và
// EXE vẫn là một file duy nhất. Xem SOURCE_ANALYSIS.md §4 để biết vì sao chọn
// đường này thay vì better-sqlite3.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_VERSION, DDL } = require('./schema');

function withTransaction(db, fn) {
  // Scanner có thể gom nhiều file trong một transaction lớn. Repository vẫn gọi helper này cho
  // từng hóa đơn; nếu đã ở trong transaction thì dùng transaction ngoài, tránh BEGIN lồng nhau.
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction đã đóng */ }
    throw error;
  }
}

function schemaVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row && row.user_version) || 0;
}

// Nâng schema theo bước: v0 (file mới) → v1 → v2 → v3.
// v3 thêm bảng FTS5 `invoice_fts`; với DB cũ phải đổ dữ liệu invoices đã có vào index.
function applySchema(db) {
  const current = schemaVersion(db);
  if (current === SCHEMA_VERSION) return { changed: false, version: current };
  if (current > SCHEMA_VERSION) {
    throw new Error(`data.db đang ở schema ${current}, mới hơn bản app này hỗ trợ (${SCHEMA_VERSION}).`);
  }
  withTransaction(db, () => {
    for (const sql of DDL) db.exec(sql);
    // Backfill FTS cho DB tạo trước v3 (câu lệnh này chạy sau khi trigger đã tạo).
    // INSERT vào invoice_fts không kích trigger trên invoices nên KHÔNG bị ghi trùng;
    // chỉ chạy khi nâng cấp thật (< 3) để không nhân đôi index mỗi lần mở app.
    if (current < 3) backfillFts(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  return { changed: true, version: SCHEMA_VERSION };
}

// Đổ toàn bộ hoá đơn hiện có vào index FTS5 (dùng cho nâng cấp schema).
// Bảng FTS dùng content='invoices' nên 'rebuild' dựng lại index từ chính bảng invoices.
function backfillFts(db) {
  db.exec(`INSERT INTO invoice_fts(invoice_fts) VALUES('rebuild')`);
}

// Mở (và tạo nếu chưa có) data.db. Lỗi thì đóng kết nối trước khi ném ra ngoài.
function openDatabase(file) {
  const value = String(file ?? '').trim();
  if (!value) throw new Error('Thiếu đường dẫn data.db.');
  fs.mkdirSync(path.dirname(value), { recursive: true });
  const db = new DatabaseSync(value);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_size = -20000');
    db.exec('PRAGMA mmap_size = 134217728');
    applySchema(db);
  } catch (error) {
    try { db.close(); } catch { /* đã đóng */ }
    throw error;
  }
  return db;
}

function closeDatabase(db) {
  if (!db) return;
  try { db.close(); } catch { /* đã đóng */ }
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
}

module.exports = { openDatabase, closeDatabase, withTransaction, applySchema, schemaVersion, tableNames, backfillFts, SCHEMA_VERSION };
