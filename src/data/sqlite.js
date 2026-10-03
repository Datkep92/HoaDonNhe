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
const { SCHEMA_VERSION, TABLES, INDEXES, FTS5 } = require('./schema');

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

// Nâng schema theo bước: v0 (file mới) → v1 → v2 → v3 (FTS5) → v4 (cột tthai)
// → v5 (bảng sao kê) → v6 (cột payment_method) → v7 (cột kết quả đối soát)
// → v8 (đánh giá thủ công) → v10 (phân loại sao kê) → v12 (tra cứu NCC)
// → v13 (file PDF gốc của NCC).
//
// THỨ TỰ BẮT BUỘC: bảng → thêm cột còn thiếu → index → FTS.
// DB cũ đã có bảng `invoices` nhưng CHƯA có cột `tthai`; nếu tạo index trên cột đó TRƯỚC khi
// ALTER thì cả transaction nâng cấp ném "no such column: tthai" và app không mở được data.db.
function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
}

function ensureColumn(db, table, column, definition) {
  if (tableColumns(db, table).includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// Đường dẫn file của kết nối này ('' nếu là DB trong bộ nhớ) — dùng cho bước BACKUP ở dưới.
function databaseFile(db) {
  try {
    const row = db.prepare('PRAGMA database_list').get();
    return row && row.file ? String(row.file) : '';
  } catch { return ''; }
}

// MỤC 15 — BACKUP → MIGRATION → VALIDATION → TEST: trước khi nâng cấp schema phải có bản sao
// data.db. `VACUUM INTO` tạo snapshot NHẤT QUÁN đọc qua chính kết nối (bao gồm phần WAL) mà không
// cần đóng DB. DB mới tạo thì bỏ qua (chưa có gì để mất).
// Snapshot lỗi KHÔNG chặn mở app (migration của mình chỉ ADD COLUMN, không xoá gì) nhưng phải trả
// về cho người gọi biết để báo ra ngoài thay vì im lặng.
function backupBeforeMigration(db) {
  const file = databaseFile(db);
  if (!file || !tableNames(db).includes('invoices')) return null;
  const target = `${file}.bak`;
  try {
    if (fs.existsSync(target)) fs.rmSync(target);
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    return { file: target, size: fs.statSync(target).size };
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) };
  }
}

function applySchema(db) {
  const current = schemaVersion(db);
  if (current === SCHEMA_VERSION) return { changed: false, version: current };
  if (current > SCHEMA_VERSION) {
    throw new Error(`data.db đang ở schema ${current}, mới hơn bản app này hỗ trợ (${SCHEMA_VERSION}).`);
  }
  // BACKUP (mục 15) phải chạy TRƯỚC MIGRATION.
  const backup = backupBeforeMigration(db);
  withTransaction(db, () => {
    for (const sql of TABLES) db.exec(sql);
    if (current < 4) ensureColumn(db, 'invoices', 'tthai', 'TEXT');
    if (current < 6) {
      ensureColumn(db, 'invoices', 'payment_method_raw', 'TEXT');
      ensureColumn(db, 'invoices', 'payment_method', "TEXT NOT NULL DEFAULT 'UNKNOWN'");
    }
    // v7: cột kết quả đối chiếu. PHẢI chạy TRƯỚC khi tạo index (mục 4 ở dưới) — nếu index
    // ra trước thì SQLite báo "no such column" và app không mở được data.db.
    // Chỉ ALTER TABLE ADD COLUMN ⇒ dữ liệu hoá đơn/sao kê cũ giữ nguyên 100%.
    if (current < 7) {
      ensureColumn(db, 'invoices', 'reconciliation_status', 'TEXT');
      ensureColumn(db, 'invoices', 'reconciliation_issues', 'TEXT');
      ensureColumn(db, 'bank_transactions', 'reconciliation_status', 'TEXT');
      ensureColumn(db, 'bank_transactions', 'reconciliation_issues', 'TEXT');
    }
    // v8: cột phân loại THỦ CÔNG do người dùng bấm (mục 3) — chỉ ALTER TABLE ADD COLUMN,
    // dữ liệu hoá đơn cũ giữ nguyên 100% và backup đã chạy trước transaction này.
    if (current < 8) {
      ensureColumn(db, 'invoices', 'review_status', 'TEXT');
      ensureColumn(db, 'invoices', 'reviewed_at', 'TEXT');
    }
    // v10: phân loại giao dịch sao kê. Chỉ thêm cột/bảng, không sửa dữ liệu gốc.
    if (current < 10) {
      ensureColumn(db, 'bank_transactions', 'category', 'TEXT');
      ensureColumn(db, 'bank_transactions', 'category_source', 'TEXT');
      ensureColumn(db, 'bank_transactions', 'categorized_at', 'TEXT');
    }
    // v12: tra cứu nhà cung cấp (Mục 2) — cổng tra cứu + mã tra cứu để tải PDF GỐC.
    // Chỉ ALTER TABLE ADD COLUMN, dữ liệu hoá đơn cũ giữ nguyên; giá trị NULL cho tới
    // khi lượt nhập/quét lại đọc lại XML.
    if (current < 12) {
      ensureColumn(db, 'invoices', 'msttcgp', 'TEXT');
      ensureColumn(db, 'invoices', 'lookup_code', 'TEXT');
      ensureColumn(db, 'invoices', 'lookup_url', 'TEXT');
      ensureColumn(db, 'invoices', 'provider_id', 'TEXT');
      ensureColumn(db, 'invoices', 'provider_name', 'TEXT');
      ensureColumn(db, 'invoices', 'provider_level', 'TEXT');
    }
    // v13: file PDF GỐC của NCC (Mục 3). Đường dẫn tương đối so với thư mục MST.
    // Chỉ ALTER TABLE ADD COLUMN, dữ liệu hóa đơn cũ giữ nguyên.
    if (current < 13) {
      ensureColumn(db, 'invoices', 'original_pdf', 'TEXT');
    }
    // v14: XOÁ MÃ TRA CỨU BỊA. Bản cũ lấy số cổng `;817501;` trong URL làm mã tra cứu,
    // nên kho của khách có mã sai. Chỉ xoá khi mã ĐÚNG BẰNG đoạn cổng trong URL — mã tra
    // cứu thật (kiểu `pc5P7639…`) không bao giờ trùng với cổng nên giữ nguyên.
    // Chỉ UPDATE, không xoá dòng hóa đơn.
    if (current < 14) {
      db.exec(`
        UPDATE invoices SET lookup_code = NULL
        WHERE COALESCE(lookup_code, '') <> ''
          AND COALESCE(lookup_url, '') LIKE '%;' || lookup_code || ';%'
      `);
    }
    for (const sql of INDEXES) db.exec(sql);
    for (const sql of FTS5) db.exec(sql);
    // Backfill FTS cho DB tạo trước v3 (câu lệnh này chạy sau khi trigger đã tạo).
    // INSERT vào invoice_fts không kích trigger trên invoices nên KHÔNG bị ghi trùng;
    // chỉ chạy khi nâng cấp thật (< 3) để không nhân đôi index mỗi lần mở app.
    if (current < 3) backfillFts(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  // VALIDATION: trả kết quả BACKUP kèm theo để người gọi biết bản sao đã tạo hay bị lỗi.
  return { changed: true, version: SCHEMA_VERSION, backup };
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

// KHOẢNG NGÀY CỦA MỘT KỲ — bộ chọn kỳ trên header (Tháng này / Tháng trước / Quý này / Năm nay).
// Trả về fragment `WHERE …` hoặc `AND …` (tùy câu đã có WHERE) kèm tham số. Cột ngày mặc định là
// `ngay_lap` (hoá đơn); đổi sang `tran_date` khi lọc sao kê. Chỉ nhận ngày YYYY-MM-DD hợp lệ ⇒
// không bao giờ nối chuỗi tùy ý vào SQL. Không có from/to → chuỗi rỗng, câu lệnh chạy như cũ.
function dateRange(range, { alias = '', column = 'ngay_lap' } = {}) {
  const value = range || {};
  const col = `${alias ? `${alias}.` : ''}${column}`;
  const parts = [];
  const params = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value.from || ''))) { parts.push(`${col} >= ?`); params.push(String(value.from)); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value.to || ''))) { parts.push(`${col} <= ?`); params.push(String(value.to)); }
  const sql = parts.join(' AND ');
  return { where: sql ? `WHERE ${sql}` : '', and: sql ? `AND ${sql}` : '', params };
}

module.exports = { openDatabase, closeDatabase, withTransaction, applySchema, backupBeforeMigration, dateRange, schemaVersion, tableNames, tableColumns, ensureColumn, backfillFts, SCHEMA_VERSION };


