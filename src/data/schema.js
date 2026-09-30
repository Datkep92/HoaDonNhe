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
// v7 thêm 4 cột KẾT QUẢ ĐỐI CHIẾU (mục 13 của MASTER TASK) — mỗi hoá đơn và mỗi giao dịch
//   đều CÓ DÒNG TRẠNG THÁI RIÊNG, kể cả khi CHƯA khớp (TRANSFER_BANK_NOT_FOUND, BANK_NO_INVOICE…):
//   invoices.reconciliation_status    — kết quả chính của hoá đơn (xem reconciliation.STATUS)
//   invoices.reconciliation_issues    — MẢNG vấn đề kèm theo (JSON): 1 dòng có thể nhiều vấn đề
//   bank_transactions.reconciliation_status / .reconciliation_issues — chiều ngược lại (sao kê)
//   Trước v7 các giá trị này chỉ là SỐ ĐẾM suy ra khi query ⇒ không truy ngược được hoá đơn nào.
// v8 thêm 2 cột PHÂN LOẠI THỦ CÔNG (mục 3 của yêu cầu 2026-09) — người dùng TỰ đánh dấu hoá đơn:
//   invoices.review_status  — mã trạng thái người dùng bấm (REVIEW_ACTIONS trong repository.js):
//                             checked / processed / missing_docs / complete_docs / error /
//                             cash_manual / transfer_manual
//   invoices.reviewed_at    — thời điểm bấm (ISO), để thấy hoá đơn nào đã được ai đó soát rồi
//   MÁY KHÔNG BAO GIỜ tự gán: cash_manual/transfer_manual chỉ ghi khi người dùng xác nhận
//   "chưa khớp sao kê ⇒ tạm ghi tiền mặt" hoặc "khớp sao kê ⇒ chuyển khoản" (XML HTTToan ghi
//   TM/CK nên không tự phân loại được — mục 3 của yêu cầu).
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 10;

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
    payment_method_raw TEXT,
    payment_method TEXT NOT NULL DEFAULT 'UNKNOWN',
    reconciliation_status TEXT,
    reconciliation_issues TEXT,
    category TEXT,
    category_source TEXT,
    categorized_at TEXT,
    review_status TEXT,
    reviewed_at TEXT,
    tien_truoc_thue REAL DEFAULT 0,
    tien_thue REAL DEFAULT 0,
    tong_tien REAL DEFAULT 0,
    file_xml TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS bank_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT DEFAULT '#64748b',
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
    reconciliation_status TEXT,
    reconciliation_issues TEXT,
    created_at TEXT,
    updated_at TEXT,
    FOREIGN KEY(file_id) REFERENCES bank_files(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS reconciliation_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    bank_transaction_id INTEGER NOT NULL,
    matched_amount REAL,
    score REAL,
    status TEXT NOT NULL,
    issues TEXT,
    created_at TEXT,
    updated_at TEXT,
    UNIQUE(invoice_id, bank_transaction_id),
    FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
    FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id) ON DELETE CASCADE
  )`,
  // ---- v9: HỖ TRỢ KẾ TOÁN — xuất file "Mẫu bán hàng" để nhập vào MISA AMIS -------
  // product_master : danh mục hàng hoá nhập từ file Excel `Danhsach.xlsx` của công ty
  //   (sheet 1, tiêu đề ở hàng 3: STT | Mã | Kho ngầm định | Tên | Đơn vị tính chính |
  //    Đơn giá mua gần nhất). Dùng để ĐỐI CHIẾU mã hàng trên hoá đơn: mã nào không có
  //   trong danh mục thì cảnh báo trước khi up lên MISA (nhập vào sẽ tạo hàng mới hoặc lỗi).
  //   `ma_chuan` = mã đã chuẩn hoá (gộp khoảng trắng THỪA thành một dấu cách, viết hoa) để khớp
  //   được cả khi hoá đơn ghi "ambi  sap 180g" còn danh mục ghi "AMBI SAP 180G".
  //   Cố ý KHÔNG xoá hết khoảng trắng: "AMBI SAP 180G" và "AMBI SAP180G" là hai mặt hàng khác nhau.
  //   KHÔNG phải nguồn số liệu: mọi số tiền/số lượng lấy từ HOÁ ĐƠN.
  `CREATE TABLE IF NOT EXISTS product_master (
    ma_hang TEXT PRIMARY KEY,
    ma_chuan TEXT,
    ten_chuan TEXT,
    dvt TEXT,
    kho TEXT,
    don_gia_mua REAL,
    updated_at TEXT
  )`,
  // customer_codes : mã khách hàng MISA cấp TỰ ĐỘNG nhưng phải ỔN ĐỊNH theo TÊN khách.
  //   Cùng một khách ra hai mã khác nhau ⇒ MISA tạo TRÙNG khách hàng và công nợ bị tách sai.
  //   `ten_chuan` = tên khách đã chuẩn hoá (viết hoa, gộp khoảng trắng) làm khoá.
  `CREATE TABLE IF NOT EXISTS customer_codes (
    ten_chuan TEXT PRIMARY KEY,
    ma_kh TEXT NOT NULL UNIQUE,
    ten_goc TEXT,
    created_at TEXT
  )`,
  // misa_counters : bộ đếm dùng chung (hiện dùng cho số chứng từ "PT0001" tăng dần).
  //   Lưu trong data.db để xuất nhiều lần KHÔNG sinh lại từ PT0001 ⇒ không trùng chứng từ
  //   đã nhập vào MISA ở lượt trước.
  `CREATE TABLE IF NOT EXISTS misa_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0,
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
  'CREATE INDEX IF NOT EXISTS idx_invoice_direction_date ON invoices(direction, ngay_lap DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_symbol_number ON invoices(khh_hd, so_hd)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_updated ON invoices(updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_state ON invoices(tthai)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_payment_method ON invoices(payment_method)',
  'CREATE INDEX IF NOT EXISTS idx_invoice_recon_status ON invoices(reconciliation_status)',
  'CREATE INDEX IF NOT EXISTS idx_bank_recon_status ON bank_transactions(reconciliation_status)',
  'CREATE INDEX IF NOT EXISTS idx_item_code ON invoice_items(ma_hang)',
  'CREATE INDEX IF NOT EXISTS idx_item_invoice ON invoice_items(invoice_id)',
  'CREATE INDEX IF NOT EXISTS idx_imported_file_path ON imported_files(file_path)',
  'CREATE INDEX IF NOT EXISTS idx_imported_invoice_key ON imported_files(invoice_key)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_date ON bank_transactions(tran_date)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_file ON bank_transactions(file_id)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_amount ON bank_transactions(amount)',
  'CREATE INDEX IF NOT EXISTS idx_bank_tran_category ON bank_transactions(category)',
  'CREATE INDEX IF NOT EXISTS idx_bank_file_hash ON bank_files(file_hash)',
  'CREATE INDEX IF NOT EXISTS idx_reconciliation_invoice ON reconciliation_matches(invoice_id)',
  'CREATE INDEX IF NOT EXISTS idx_reconciliation_bank ON reconciliation_matches(bank_transaction_id)',
  // v9 — tra mã hàng theo mã đã chuẩn hoá (đối chiếu hoá đơn ↔ danh mục công ty).
  'CREATE INDEX IF NOT EXISTS idx_product_master_chuan ON product_master(ma_chuan)',
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
