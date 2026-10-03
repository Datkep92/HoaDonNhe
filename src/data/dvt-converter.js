'use strict';
// ---------------------------------------------------------------------------
// Lõi chuyển đổi DVT (Đơn Vị Tính) - thuần, không phụ thuộc server, test được
// MÃ HÀNG = KHÓA CHÍNH LOGIC - BẮT BUỘC, KHÔNG ĐƯỢC ĐỔI
// ---------------------------------------------------------------------------

// KHÔNG import `normalizeTenHang` từ ./mst-format — module đó KHÔNG export hàm đó
// (chỉ có normalizeMst/isValidMst/baseMst/mstAliases). Bản đầu vừa import vừa khai
// bản định nghĩa cục bộ trùng tên ⇒ SyntaxError "Identifier 'normalizeTenHang' has
// already been declared" ⇒ CẢ FILE KHÔNG NẠP ĐƯỢC, tính năng DVT chết. `node --check`
// bắt được, nhưng lệnh build chỉ in cảnh báo Babel rồi vẫn xuất EXE — nên test cũng
// phải nạp thật file này (xem tests/dvt-converter.test.js).

/**
 * Chuẩn hoá tên hàng để fuzzy match: upper, trim, collapse spaces
 * @param {string} tenHang
 * @returns {string}
 */
function normalizeTenHang(tenHang) {
  if (!tenHang) return '';
  return String(tenHang).toUpperCase().trim().replace(/\s+/g, ' ');
}

/**
 * Load tất cả mapping của 1 MST từ db
 * @param {sqlite3.Database} db
 * @returns {Array<Object>} Danh sách mapping (chỉ active)
 */
function loadMappings(db) {
  const rows = db.prepare(`
    SELECT id, ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai
    FROM dvt_mapping
    WHERE trang_thai = 'active'
    ORDER BY ma_hang, dvt_goc
  `).all();
  return rows.map(r => ({
    id: r.id,
    maHang: r.ma_hang,
    tenHang: r.ten_hang,
    tenChuan: r.ten_chuan,
    dvtGoc: r.dvt_goc,
    dvtDich: r.dvt_dich,
    tyLe: Number(r.ty_le) || 1,
    ghiChu: r.ghi_chu,
    nguon: r.nguon,
    trangThai: r.trang_thai,
  }));
}

/**
 * Lookup mapping cho 1 item - ƯU TIÊN THEO MÃ HÀNG
 * @param {Array<Object>} mappings
 * @param {Object} params - { maHang, tenHang, dvtGoc }
 * @returns {Object|null} Mapping object hoặc null
 */
function findMapping(mappings, { maHang, tenHang, dvtGoc }) {
  // 1. Exact match: ma_hang + dvt_goc (ƯU TIÊN TUYỆT ĐỐI)
  if (maHang) {
    const exact = mappings.find(m => m.maHang === maHang && m.dvtGoc === dvtGoc);
    if (exact) return exact;
  }
  // 2. Fuzzy tên: ten_chuan + dvt_goc
  const tenChuan = normalizeTenHang(tenHang);
  const fuzzy = mappings.find(m => m.tenChuan === tenChuan && m.dvtGoc === dvtGoc);
  if (fuzzy) return fuzzy;
  // 3. Không có mapping
  return null;
}

/**
 * Áp dụng chuyển đổi DVT cho danh sách items (chỉ direction=SELL)
 * Items không có ma_hang: bỏ qua, log warning, không convert
 * @param {Array<Object>} items - Danh sách items từ invoice_items
 * @param {Array<Object>} mappings - Danh sách mapping từ loadMappings
 * @returns {Array<Object>} Items đã convert (clone, không mutate original)
 */
function applyConversion(items, mappings) {
  const converted = [];
  for (const item of items) {
    const maHang = item.ma_hang;
    const tenHang = item.ten_hang;
    const dvtGoc = item.don_vi;
    const soLuongGoc = Number(item.so_luong) || 0;
    const donGiaGoc = Number(item.don_gia) || 0;

    // Item không có mã hàng: bỏ qua, không convert
    if (!maHang) {
      converted.push({
        ...item,
        _dvtConverted: false,
        _dvtSkipReason: 'MISSING_MA_HANG',
      });
      continue;
    }

    const mapping = findMapping(mappings, {
      maHang,
      tenHang: item.ten_hang,
      dvtGoc,
    });

    if (!mapping) {
      // Không có mapping: giữ nguyên, log warning sẽ do caller xử lý
      converted.push({
        ...item,
        _dvtConverted: false,
        _dvtSkipReason: 'NO_MAPPING',
      });
      continue;
    }

    const tyLe = Number(mapping.tyLe) || 1;
    const soLuongMoi = soLuongGoc * mapping.tyLe;
    const donGiaMoi = mapping.tyLe > 0 ? donGiaGoc / mapping.tyLe : donGiaGoc;

    converted.push({
      ...item,
      don_vi: mapping.dvtDich,
      so_luong: soLuongMoi,
      don_gia: donGiaMoi,
      _dvtConverted: true,
      _dvtMappingId: mapping.id,
      _dvtTyLe: mapping.tyLe,
      _dvtGoc: mapping.dvtGoc,
      _dvtDich: mapping.dvtDich,
    });
  }
  return converted;
}

/**
 * Thêm/cập nhật mapping (ma_hang là required, không cho sửa ma_hang sau khi tạo)
 * @param {sqlite3.Database} db
 * @param {Object} input - { maHang, tenHang, dvtGoc, dvtDich, tyLe, ghiChu, nguon }
 * @returns {Object} Mapping đã tạo/cập nhật
 */
function upsertMapping(db, { maHang, tenHang, dvtGoc, dvtDich, tyLe: tyLeInput, ghiChu, nguon = 'manual' }) {
  if (!maHang) throw new Error('ma_hang là bắt buộc');
  if (!dvtGoc) throw new Error('dvt_goc là bắt buộc');
  if (!dvtDich) throw new Error('dvt_dich là bắt buộc');

  const tenChuan = normalizeTenHang(tenHang);
  const now = new Date().toISOString();
  // Tham số giải mã đã mang tên `tyLe`; khai `const tyLe` ở đây là KHAI TRÙNG trong cùng
  // phạm vi ⇒ SyntaxError ⇒ cả module không nạp được. Đổi tên tham số thành `tyLeInput`
  // để `tyLe` bên dưới là biến đã quy đổi số, mọi chỗ dùng `tyLe` giữ nguyên.
  const tyLe = Number(tyLeInput) || 1;

  // Check existing
  const existing = db.prepare(`
    SELECT id FROM dvt_mapping
    WHERE ma_hang = ? AND dvt_goc = ? AND dvt_dich = ?
  `).get(maHang, dvtGoc, dvtDich);

  if (existing) {
    // Update: chỉ cho sửa ten_hang, ten_chuan, ty_le, ghi_chu, nguon, trang_thai
    // KHÔNG cho sửa ma_hang, dvt_goc, dvt_dich (khóa chính)
    db.prepare(`
      UPDATE dvt_mapping
      SET ten_hang = ?, ten_chuan = ?, ty_le = ?, ghi_chu = ?, nguon = ?, updated_at = ?
      WHERE id = ?
    `).run(tenHang, normalizeTenHang(tenHang), tyLe, ghiChu || '', nguon, new Date().toISOString(), existing.id);
    return { ...existing, maHang, tenHang, tenChuan: normalizeTenHang(tenHang), dvtGoc, dvtDich, tyLe, ghiChu, nguon, updatedAt: new Date().toISOString() };
  } else {
    // Insert new
    const info = db.prepare(`
      INSERT INTO dvt_mapping (ma_hang, ten_hang, ten_chuan, dvt_goc, dvt_dich, ty_le, ghi_chu, nguon, trang_thai, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(maHang, tenHang, normalizeTenHang(tenHang), dvtGoc, dvtDich, tyLe, ghiChu || '', nguon, now, now);
    return {
      id: Number(info.lastInsertRowid),
      maHang, tenHang, tenChuan: normalizeTenHang(tenHang), dvtGoc, dvtDich, tyLe, ghiChu, nguon, trangThai: 'active', createdAt: now, updatedAt: now,
    };
  }
}

/**
 * Xóa mapping (soft delete - set trang_thai = 'inactive')
 * @param {sqlite3.Database} db
 * @param {number} id
 * @returns {boolean}
 */
function deleteMapping(db, id) {
  const info = db.prepare(`UPDATE dvt_mapping SET trang_thai = 'inactive', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  return info.changes > 0;
}

/**
 * Auto-learn mapping từ items CÓ ma_hang chưa có map
 * Items không có ma_hang: bỏ qua, log warning
 * @param {sqlite3.Database} db
 * @param {Array<Object>} items - Danh sách items từ invoice_items
 * @returns {Array<Object>} Danh sách mapping mới tạo
 */
function autoLearnMappings(db, items) {
  const mappings = loadMappings(db);
  const newMappings = [];

  for (const item of items) {
    const maHang = item.ma_hang;
    const dvtGoc = item.don_vi;
    const tenHang = item.ten_hang;

    if (!maHang) continue; // Bỏ qua item không có mã hàng

    const exists = mappings.find(m => m.maHang === maHang && m.dvtGoc === dvtGoc);
    if (!exists) {
      const mapping = upsertMapping(db, {
        maHang,
        tenHang: item.ten_hang,
        dvtGoc,
        dvtDich: dvtGoc, // Mặc định 1:1
        tyLe: 1,
        nguon: 'auto_learn',
      });
      newMappings.push(mapping);
      mappings.push({
        id: mapping.id,
        maHang,
        tenHang: item.ten_hang,
  // Dùng hàm CỤC BỘ ở trên. `require('./mst-format').normalizeTenHang` là undefined
  // (mst-format không export hàm đó) ⇒ ten_chuan ghi vào kho sẽ là chuỗi "undefined".
  tenChuan: normalizeTenHang(item.ten_hang),
        dvtGoc,
        dvtDich: dvtGoc,
        tyLe: 1,
        ghiChu: '',
        nguon: 'auto_learn',
        trangThai: 'active',
      });
    }
  }
  return newMappings;
}

/**
 * Ghi log conversion
 * @param {sqlite3.Database} db
 * @param {Object} logEntry - { invoiceId, itemStt, tenHangGoc, dvtGoc, soLuongGoc, dvtDich, tyLe, soLuongMoi, mappingId, loai }
 * @returns {number} lastInsertRowid
 */
function logConversion(db, { invoiceId, itemStt, tenHangGoc, dvtGoc, soLuongGoc, dvtDich, tyLe, soLuongMoi, mappingId, loai }) {
  const info = db.prepare(`
    INSERT INTO dvt_conversion_log
    (invoice_id, item_stt, ten_hang_goc, dvt_goc, so_luong_goc, dvt_dich, ty_le, so_luong_moi, mapping_id, loai, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    invoiceId, itemStt, tenHangGoc, dvtGoc, soLuongGoc, dvtDich, tyLe, soLuongMoi, mappingId || null, loai, new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

/**
 * Xuất mappings ra mảng sẵn sàng export Excel
 * @param {sqlite3.Database} db
 * @returns {Array<Object>}
 */
function exportMappings(db) {
  return db.prepare(`
    SELECT ma_hang as 'Mã hàng', ten_hang as 'Tên hàng', dvt_goc as 'DVT gốc', dvt_dich as 'DVT đích', ty_le as 'Tỷ lệ', ghi_chu as 'Ghi chú', nguon as 'Nguồn', trang_thai as 'Trạng thái'
    FROM dvt_mapping
    WHERE trang_thai = 'active'
    ORDER BY ma_hang, dvt_goc
  `).all();
}

/**
 * Import mappings từ Excel rows
 * @param {sqlite3.Database} db
 * @param {Array<Object>} rows - Mảng object từ Excel: { 'Mã hàng', 'Tên hàng', 'DVT gốc', 'DVT đích', 'Tỷ lệ', 'Ghi chú' }
 * @returns {Object} { success: number, errors: Array<string> }
 */
function importMappings(db, rows) {
  let success = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const maHang = String(row['Mã hàng'] || '').trim();
    const tenHang = String(row['Tên hàng'] || '').trim();
    const dvtGoc = String(row['DVT gốc'] || '').trim();
    const dvtDich = String(row['DVT đích'] || '').trim();
    const tyLe = Number(row['Tỷ lệ']) || 1;
    const ghiChu = String(row['Ghi chú'] || '').trim();

    if (!maHang) { errors.push(`Dòng ${i + 1}: thiếu mã hàng`); continue; }
    if (!dvtGoc) { errors.push(`Dòng ${i + 1}: thiếu DVT gốc`); continue; }
    if (!dvtDich) { errors.push(`Dòng ${i + 1}: thiếu DVT đích`); continue; }
    if (tyLe <= 0) { errors.push(`Dòng ${i + 1}: tỷ lệ phải > 0`); continue; }

    try {
      upsertMapping(db, { maHang, tenHang, dvtGoc, dvtDich, tyLe, ghiChu, nguon: 'import' });
      success++;
    } catch (e) {
      errors.push(`Dòng ${i + 1}: ${e.message}`);
    }
  }
  return { success, errors };
}

module.exports = {
  loadMappings,
  findMapping,
  applyConversion,
  upsertMapping,
  deleteMapping,
  autoLearnMappings,
  logConversion,
  exportMappings,
  importMappings,
  normalizeTenHang,
};



