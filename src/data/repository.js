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
const { normalizePaymentMethod } = require('./payment-method');

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

function normalizeState(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
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
  // tthai đến từ kết quả tra cứu (XML không mang). Không có thì để null — KHÔNG suy đoán là '1'.
  const paymentMethodRaw = normalizeState(record.paymentMethodRaw ?? record.httToan);
  return { ...record, direction, fileXml, invoiceKey, tthai: normalizeState(record.tthai),
    paymentMethodRaw, paymentMethod: normalizePaymentMethod(paymentMethodRaw) };
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
         loai_hoa_don, tthai, payment_method_raw, payment_method, tien_truoc_thue, tien_thue, tong_tien, file_xml,
         msttcgp, lookup_code, lookup_url, provider_id, provider_name, provider_level, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        value.tthai ?? null,
        value.paymentMethodRaw,
        value.paymentMethod,
        asNumber(value.tienTruocThue, 'invoices.tien_truoc_thue'),
        asNumber(value.tienThue, 'invoices.tien_thue'),
        asNumber(value.tongTien, 'invoices.tong_tien'),
        value.fileXml,
        value.msttcgp ?? null,
        value.lookupCode ?? null,
        value.lookupUrl ?? null,
        value.providerId ?? null,
        value.providerName ?? null,
        value.providerLevel ?? null,
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

// XML cùng đường dẫn đã thay đổi: cập nhật lại hóa đơn và thay toàn bộ dòng hàng
// trong một transaction. File khác có cùng invoice_key vẫn do scanner xử lý là bản trùng.
function upsertInvoice(db, record) {
  const value = normalizeRecord(record);
  const items = normalizeItems(record.items);
  const stamp = nowIso();
  const existing = findInvoiceByKey(db, value.invoiceKey);
  if (!existing) return insertInvoice(db, record);
  return withTransaction(db, () => {
    db.prepare(`UPDATE invoices SET
      direction = ?, mst_ban = ?, mst_mua = ?, ten_ban = ?, ten_mua = ?, ngay_lap = ?,
      khms_hd = ?, khh_hd = ?, so_hd = ?, loai_hoa_don = ?, tthai = ?, payment_method_raw = ?, payment_method = ?, tien_truoc_thue = ?,
      tien_thue = ?, tong_tien = ?, file_xml = ?,
      msttcgp = ?, lookup_code = ?, lookup_url = ?, provider_id = ?, provider_name = ?, provider_level = ?,
      updated_at = ? WHERE id = ?`).run(
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
      value.tthai ?? null,
      value.paymentMethodRaw,
      value.paymentMethod,
      asNumber(value.tienTruocThue, 'invoices.tien_truoc_thue'),
      asNumber(value.tienThue, 'invoices.tien_thue'),
      asNumber(value.tongTien, 'invoices.tong_tien'),
      value.fileXml,
      value.msttcgp ?? null,
      value.lookupCode ?? null,
      value.lookupUrl ?? null,
      value.providerId ?? null,
      value.providerName ?? null,
      value.providerLevel ?? null,
      stamp,
      existing.id,
    );
    db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(existing.id);
    const insertItem = db.prepare(`INSERT INTO invoice_items
      (invoice_id, stt, ma_hang, ten_hang, don_vi, so_luong, don_gia, chiet_khau, thanh_tien, thue_suat, tien_thue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of items) {
      insertItem.run(existing.id, item.stt, item.maHang, item.tenHang, item.donVi, item.soLuong, item.donGia, item.chietKhau, item.thanhTien, item.thueSuat, item.tienThue);
    }
    if (record.importedFile) recordImportedFile(db, { ...record.importedFile, invoiceKey: record.importedFile.invoiceKey || value.invoiceKey });
    return { inserted: false, updated: true, invoiceId: existing.id, itemsInserted: items.length, invoiceKey: value.invoiceKey };
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

// ---------------------------------------------------------------------------
// PHÂN LOẠI THỦ CÔNG (mục 3 của yêu cầu 2026-09) — CHỈ ghi giá trị NGƯỜI DÙNG bấm:
//   checked / processed / missing_docs / complete_docs / error  → mức độ đã soát
//   cash_manual / transfer_manual                               → ghi nhận TM / CK cho hoá đơn
// Hai mục cash/transfer còn đổi CỘT payment_method: XML ghi "TM/CK" nên MÁY KHÔNG tự phân loại
// được — người dùng tự xác nhận "khớp sao kê ⇒ CK, chưa khớp ⇒ TM" (mục 3).
// payment_method_raw GIỮ NGUYÊN: đó là giá trị gốc từ XML, không bao giờ bị ghi đè (mục 5).
// ---------------------------------------------------------------------------
const REVIEW_ACTIONS = Object.freeze({
  checked: { status: 'checked' },
  processed: { status: 'processed' },
  missing_docs: { status: 'missing_docs' },
  complete_docs: { status: 'complete_docs' },
  error: { status: 'error' },
  cash_manual: { status: 'cash_manual', paymentMethod: 'CASH' },
  transfer_manual: { status: 'transfer_manual', paymentMethod: 'TRANSFER' },
});

function setReview(db, { id, action }) {
  const rule = REVIEW_ACTIONS[String(action || '')];
  if (!rule) throw new Error('Trạng thái phân loại không hợp lệ.');
  const invoiceId = Number(id);
  if (!Number.isFinite(invoiceId)) throw new Error('Thiếu mã hoá đơn.');
  const stamped = nowIso();
  return withTransaction(db, () => {
    const before = db.prepare('SELECT id, payment_method FROM invoices WHERE id = ?').get(invoiceId);
    if (!before) throw new Error('Không tìm thấy hoá đơn này trong kho dữ liệu.');
    if (rule.paymentMethod) {
      db.prepare('UPDATE invoices SET payment_method = ?, review_status = ?, reviewed_at = ? WHERE id = ?')
        .run(rule.paymentMethod, rule.status, stamped, invoiceId);
    } else {
      db.prepare('UPDATE invoices SET review_status = ?, reviewed_at = ? WHERE id = ?')
        .run(rule.status, stamped, invoiceId);
    }
    const changedMethod = !!rule.paymentMethod && before.payment_method !== rule.paymentMethod;
    return {
      id: invoiceId,
      status: rule.status,
      paymentMethod: rule.paymentMethod || before.payment_method,
      changedMethod,
    };
  });
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

module.exports = { insertInvoice, upsertInvoice, findInvoiceByKey, recordImportedFile, countInvoices, countItems, itemsOfInvoice, listInvoices, setReview, REVIEW_ACTIONS, setSyncState, getSyncState, normalizeRecord, normalizeItems };
