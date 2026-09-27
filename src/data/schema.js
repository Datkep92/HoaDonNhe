'use strict';
// ---------------------------------------------------------------------------
// Schema SQLite của tầng dữ liệu — PROJECT_ARCHITECTURE §7–§12.
//
// 1 MST = 1 data.db. XML vẫn là nguồn gốc (source of truth); các bảng ở đây chỉ
// là index / lớp truy vấn, KHÔNG thay thế XML và KHÔNG lưu nội dung XML.
// Đổi schema ⇒ tăng SCHEMA_VERSION (tầng sqlite.js sẽ tự nâng cấp theo bước).
// v4 thêm cột `invoices.tthai` (trạng thái hoá đơn) — DB cũ phải ALTER TABLE, xem sqlite.js.
// v5 thêm 2 bảng SAO KÊ NGÂN HÀNG (tab "Sao kê ngân hàng" trong Kho dữ liệu):
//   bank_files       — metadata file sao kê đã nhập (tên, hash, ngân hàng, số TK, thống kê)
//   bank_transactions— giao dịch đã CHUẨN HÓA (ngày ISO, số tiền tách Tiền vào/Tiền ra, hash chống trùng)
// Cả hai nằm trong data.db của từng MST ⇒ dữ liệu sao kê cũng tách theo MST như hoá đơn (§46).
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 5;

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
    tthai TEXT,
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
  // ---- v5: SAO KÊ NGÂN HÀNG ------------------------------------------------
  // Mỗi file sao kê (Excel/CSV) nhập vào = 1 dòng bank_files; mỗi giao dịch chuẩn hoá = 1 dòng
  // bank_transactions. Chống trùng bằng row_hash (SHA-1 của ngày+tiền+nội dung+mã GD) UNIQUE:
  // nhập lại cùng file, hoặc file khác chứa trùng giao dịch, KHÔNG tạo dòng thứ hai (§26).
  `CREATE TABLE IF NOT EXISTS bank_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    file_hash TEXT,
    bank TEXT,
    account TEXT,
    period_from TEXT,
    period_to TEXT,
    rows_total INTEGER DEFAULT 0,
    rows_imported INTEGER DEFAULT 0,
    rows_duplicate INTEGER DEFAULT 0,
    rows_error INTEGER DEFAULT 0,
    imported_at TEXT,
    status TEXT,
    error_message TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bank_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    tran_date TEXT,
    value_date TEXT,
    description TEXT,
    detail TEXT,
    counterparty_name TEXT,
    counterparty_account TEXT,
    reference TEXT,
    credit REAL,
    debit REAL,
    amount REAL,
    balance REAL,
    currency TEXT DEFAULT 'VND',
    row_hash TEXT NOT NULL UNIQUE,
    file_name TEXT,
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY(file_id) REFERENCES bank_files(id) ON DELETE CASCADE
  )`,
];

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_key ON invoices(invoice_key)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(ngay_lap)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_direction ON invoices(direction)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_sell_mst ON invoices(mst_ban)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_buy_mst ON invoices(mst_mua)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoices(so_hd)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_direction_date ON invoices(direction, ngay_lap DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_symbol_number ON invoices(khh_hd, so_hd)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_updated ON invoices(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_state ON invoices(tthai)',
  'CREATE INDEX IF NOT EXISTS idx_item_code ON invoice_items(ma_hang)',
  'CREATE INDEX IF NOT EXISTS idx_item_invoice ON invoice_items(invoice_id)',
  'CREATE INDEX IF NOT EXISTS idx_imported_file_path ON imported_files(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_imported_invoice_key ON imported_files(invoice_key)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_date ON bank_transactions(tran_date)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_file ON bank_transactions(file_id)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_amount ON bank_transactions(amount)',
  'CREATE INDEX IF NOT EXISTS idx_bank_file_hash ON bank_files(file_hash)',
];

// FTS5 (external content) cho tìm kiếm nhanh ở tab "Kho dữ liệu" (mục §34).
// - content='invoices', content_rowid='id': index đọc nội dung thẳng từ bảng invoices
//   (KHÔNG lưu bản sao nội dung), nhưng UPDATE/DELETE vẫn đúng vì trigger cung cấp giá trị CŨ.
// - KHÔNG dùng content='' (contentless): lệnh 'delete' chỉ có rowid KHÔNG xoá được token cũ,
//   nên sau khi sửa/xoá hoá đơn index còn sót từ khoá cũ ⇒ tìm kiếm ra kết quả "ma".
//   (contentless_delete=1 thì SQLite lại từ chối cú pháp 'delete' kiểu này.)
// - unicode61 remove_diacritics 2 : không phân biệt hoa/thường VÀ bỏ dấu tiếng Việt đầy đủ
//                ("cong ty" khớp "CÔNG TY", "nguoi" khớp "NGƯỜI", "tnhh" khớp "TNHH").
//                Số 2 là bắt buộc: mặc định (1) chỉ bỏ dấu khối Latin-1 nên "nguoi" KHÔNG khớp "NGƯỜI".
// - Trigger đồng bộ nội dung từ bảng invoices; mọi đường ghi qua repository đều chạy trigger.
const FTS5 = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS invoice_fts USING fts5(
    ten_ban, ten_mua, so_hd, khh_hd, khms_hd,
    content='invoices',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  )`,
  `CREATE TRIGGER IF NOT EXISTS trg_invoice_fts_ai AFTER INSERT ON invoices BEGIN
    INSERT INTO invoice_fts(rowid, ten_ban, ten_mua, so_hd, khh_hd, khms_hd)
    VALUES (new.id, new.ten_ban, new.ten_mua, new.so_hd, new.khh_hd, new.khms_hd);
  END`,
  `CREATE TRIGGER IF NOT EXISTS trg_invoice_fts_au AFTER UPDATE ON invoices BEGIN
    INSERT INTO invoice_fts(invoice_fts, rowid, ten_ban, ten_mua, so_hd, khh_hd, khms_hd)
    VALUES ('delete', old.id, old.ten_ban, old.ten_mua, old.so_hd, old.khh_hd, old.khms_hd);
    INSERT INTO invoice_fts(rowid, ten_ban, ten_mua, so_hd, khh_hd, khms_hd)
    VALUES (new.id, new.ten_ban, new.ten_mua, new.so_hd, new.khh_hd, new.khms_hd);
  END`,
  `CREATE TRIGGER IF NOT EXISTS trg_invoice_fts_ad AFTER DELETE ON invoices BEGIN
    INSERT INTO invoice_fts(invoice_fts, rowid, ten_ban, ten_mua, so_hd, khh_hd, khms_hd)
    VALUES ('delete', old.id, old.ten_ban, old.ten_mua, old.so_hd, old.khh_hd, old.khms_hd);
  END`,
];

const DDL = [...TABLES, ...INDEXES, ...FTS5];

module.exports = { SCHEMA_VERSION, TABLES, INDEXES, FTS5, DDL };
