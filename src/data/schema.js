'use strict';
// ---------------------------------------------------------------------------
// Schema SQLite của tầng dữ liệu — PROJECT_ARCHITECTURE §7–§12.
//
// 1 MST = 1 data.db. XML vẫn là nguồn gốc (source of truth); các bảng ở đây chỉ
// là index / lớp truy vấn, KHÔNG thay thế XML và KHÔNG lưu nội dung XML.
// Đổi schema ⇒ tăng SCHEMA_VERSION (tầng sqlite.js sẽ tự nâng cấp theo bước).
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_key TEXT NOT NULL UNIQUE,
    direction TEXT NOT NULL,
    mst_ban TEXT,
    mst_mua TEXT,
    ten_ban TEXT,
    ten_mua TEXT,
    ngay_lap TEXT,
    khms_hd TEXT,
    khh_hd TEXT,
    so_hd TEXT,
    loai_hoa_don TEXT,
    tien_truoc_thue REAL DEFAULT 0,
    tien_thue REAL DEFAULT 0,
    tong_tien REAL DEFAULT 0,
    file_xml TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    stt INTEGER,
    ma_hang TEXT,
    ten_hang TEXT,
    don_vi TEXT,
    so_luong REAL,
    don_gia REAL,
    chiet_khau REAL,
    thanh_tien REAL,
    thue_suat TEXT,
    tien_thue REAL,
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS imported_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    modified_time TEXT,
    file_hash TEXT,
    invoice_key TEXT,
    import_time TEXT,
    status TEXT,
    error_message TEXT
  )`,
  // sync_state là bảng khoá/giá trị: tài liệu §11 chỉ yêu cầu "lưu trạng thái đồng bộ",
  // không cố định cột, nên dùng key/value để không phải đổi schema mỗi lần thêm trường.
  `CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  )`,
];

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_key ON invoices(invoice_key)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(ngay_lap)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_direction ON invoices(direction)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_sell_mst ON invoices(mst_ban)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_buy_mst ON invoices(mst_mua)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoices(so_hd)',
  'CREATE INDEX IF NOT EXISTS idx_item_code ON invoice_items(ma_hang)',
  'CREATE INDEX IF NOT EXISTS idx_item_invoice ON invoice_items(invoice_id)',
  'CREATE INDEX IF NOT EXISTS idx_imported_file_path ON imported_files(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_imported_invoice_key ON imported_files(invoice_key)',
];

const DDL = [...TABLES, ...INDEXES];

module.exports = { SCHEMA_VERSION, TABLES, INDEXES, DDL };
