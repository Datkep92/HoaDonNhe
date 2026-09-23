'use strict';
// ---------------------------------------------------------------------------
// Truy cập dữ liệu trên data.db — PROJECT_ARCHITECTURE §45 và §19.
//
// - Mỗi hoá đơn được ghi trong MỘT transaction: invoices + invoice_items + imported_files.
// - Chống trùng bằng invoice_key (UNIQUE): lần ghi thứ hai trả về inserted=false, KHÔNG
//   tạo record thứ hai (mục 19 lớp 4).
// - Lỗi dữ liệu (ví dụ một dòng hàng không phải số) bị chặn TRƯỚC khi mở transaction để
//   không để lại hoá đơn nửa chừng.
// ---------------------------------------------------------------------------

const { buildInvoiceKey } = require('./invoice-key');
const { withTransaction } = require('./sqlite');

function nowIso() {
  return new Date().toISOString();
}

function asNumber(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`Giá trị số không hợp lệ ở ${field}: ${text.slice(0, 40)}`);
  return number;
}

function normalizeRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('Thiếu bản ghi hoá đơn.');
  const direction = String(record.direction ?? '').trim().toUpperCase();
  if (direction !== 'BUY' && direction !== 'SELL') throw new Error('direction phải là BUY hoặc SELL.');
  const fileXml = String(record.fileXml ?? '').trim();
  if (!fileXml) throw new Error('Thiếu đường dẫn file XML (file_xml).');
  const invoiceKey = String(record.invoiceKey ?? '').trim() || buildInvoiceKey({
    mstBan: record.mstBan, khmshDon: record.khmsHd, khhDon: record.khhHd, shDon: record.soHd,
  });
  return { ...record, direction, fileXml, invoiceKey };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => ({
    stt: item.stt === undefined || item.stt === null ? index + 1 : asNumber(item.stt, `invoice_items.stt #${index + 1}`),
    maHang: item.maHang ?? null,
    tenHang: item.tenHang ?? null,
    donVi: item.donVi ?? null,
    soLuong: asNumber(item.soLuong, `invoice_items.so_luong #${index + 1}`),
    donGia: asNumber(item.donGia, `invoice_items.don_gia #${index + 1}`),
    chietKhau: asNumber(item.chietKhau, `invoice_items.chiet_khau #${index + 1}`),
    thanhTien: asNumber(item.thanhTien, `invoice_items.thanh_tien #${index + 1}`),
    thueSuat: item.thueSuat ?? null,
    tienThue: asNumber(item.tienThue, `invoice_items.tien_thue #${index + 1}`),
  }));
}

function findInvoiceByKey(db, invoiceKey) {
  const key = String(invoiceKey ?? '').trim();
  if (!key) return null;
  return db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key) || null;
}

// Ghi metadata của file XML đã xử lý — §10.
function recordImportedFile(db, entry = {}) {
  const filePath = String(entry.filePath ?? '').trim();
  if (!filePath) throw new Error('Thiếu file_path khi ghi imported_files.');
  const statement = db.prepare(`INSERT INTO imported_files
    (file_path, file_name, file_size, modified_time, file_hash, invoice_key, import_time, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = statement.run(
    filePath,
    entry.fileName ?? null,
    asNumber(entry.fileSize, 'imported_files.file_size'),
    entry.modifiedTime ?? null,
    entry.fileHash ?? null,
    entry.invoiceKey ?? null,
    entry.importTime || nowIso(),
    entry.status || 'imported',
    entry.errorMessage ?? null,
  );
  return Number(info.lastInsertRowid);
}

// Ghi một hoá đơn + dòng hàng + (tuỳ chọn) imported_files trong MỘT transaction — §45.
function insertInvoice(db, record) {
  const value = normalizeRecord(record);
  const items = normalizeItems(record.items);
  const stamp = nowIso();
  return withTransaction(db, () => {
    let info;
    try {
      info = db.prepare(`INSERT INTO invoices
        (invoice_key, direction, mst_ban, mst_mua, ten_ban, ten_mua, ngay_lap, khms_hd, khh_hd, so_hd,
         loai_hoa_don, tien_truoc_thue, tien_thue, tong_tien, file_xml, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.invoiceKey,
        value.direction,
        value.mstBan ?? null,
        value.mstMua ?? null,
        value.tenBan ?? null,
        value.tenMua ?? null,
        value.ngayLap ?? null,
        value.khmsHd ?? null,
        value.khhHd ?? null,
        value.soHd ?? null,
        value.loaiHoaDon ?? null,
        asNumber(value.tienTruocThue, 'invoices.tien_truoc_thue'),
        asNumber(value.tienThue, 'invoices.tien_thue'),
        asNumber(value.tongTien, 'invoices.tong_tien'),
        value.fileXml,
        stamp,
        stamp,
      );
    } catch (error) {
      if (String(error && error.message).includes('UNIQUE')) {
        const existing = findInvoiceByKey(db, value.invoiceKey);
        return { inserted: false, invoiceId: existing ? existing.id : null, itemsInserted: 0, reason: 'duplicate' };
      }
      throw error;
    }
    const invoiceId = Number(info.lastInsertRowid);
    const insertItem = db.prepare(`INSERT INTO invoice_items
      (invoice_id, stt, ma_hang, ten_hang, don_vi, so_luong, don_gia, chiet_khau, thanh_tien, thue_suat, tien_thue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of items) {
      insertItem.run(invoiceId, item.stt, item.maHang, item.tenHang, item.donVi, item.soLuong, item.donGia, item.chietKhau, item.thanhTien, item.thueSuat, item.tienThue);
    }
    if (record.importedFile) recordImportedFile(db, { ...record.importedFile, invoiceKey: record.importedFile.invoiceKey || value.invoiceKey });
    return { inserted: true, invoiceId, itemsInserted: items.length, invoiceKey: value.invoiceKey };
  });
}

function countInvoices(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c;
}

function countItems(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM invoice_items').get().c;
}

function itemsOfInvoice(db, invoiceId) {
  return db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY stt, id').all(invoiceId);
}

// Danh sách hoá đơn có phân trang — nền cho PHASE 3 (mục 33). Không dùng cho UI ở phase này.
function listInvoices(db, { limit = 50, offset = 0, direction = '' } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);
  if (direction) {
    return db.prepare('SELECT * FROM invoices WHERE direction = ? ORDER BY ngay_lap DESC, id DESC LIMIT ? OFFSET ?').all(direction, size, skip);
  }
  return db.prepare('SELECT * FROM invoices ORDER BY ngay_lap DESC, id DESC LIMIT ? OFFSET ?').all(size, skip);
}

function setSyncState(db, key, value) {
  db.prepare(`INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(String(key), typeof value === 'string' ? value : JSON.stringify(value ?? null), nowIso());
}

function getSyncState(db, key) {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(String(key));
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

module.exports = { insertInvoice, findInvoiceByKey, recordImportedFile, countInvoices, countItems, itemsOfInvoice, listInvoices, setSyncState, getSyncState, normalizeRecord, normalizeItems };
