'use strict';
// ---------------------------------------------------------------------------
// DANH MỤC HÀNG HOÁ CỦA CÔNG TY (nhập từ file Excel `Danhsach.xlsx`) + TRA CỨU MÃ HÀNG.
//
// VAI TRÒ: CHỈ để ĐỐI CHIẾU. Mọi số liệu xuất ra file MISA (số lượng, đơn giá, thành tiền…)
// đều lấy từ HOÁ ĐƠN. Danh mục này dùng để biết **mã hàng trên hoá đơn có tồn tại trong danh
// mục của công ty hay không** — mã lạ thì khi up lên MISA sẽ bị tạo hàng mới hoặc báo lỗi, nên
// phải cảnh báo TRƯỚC khi xuất.
//
// File nguồn (mẫu MISA, sheet 1) có 2 hàng tiêu đề trang trí rồi mới tới dòng tiêu đề thật:
//   hàng 1-2 : ô gộp tiêu đề
//   hàng 3   : STT | Mã | Kho ngầm định | Tên | Đơn vị tính chính | Đơn giá mua gần nhất
//   hàng 4+  : dữ liệu
// Vì vậy KHÔNG cứng theo số hàng: tự dò dòng tiêu đề và tự tìm cột theo TÊN tiêu đề (file mẫu
// có thể đổi thứ tự cột giữa các phiên bản).
// ---------------------------------------------------------------------------

const XLSX = require('../../resources/xlsx.cjs');

// Chuẩn hoá để KHỚP: gộp mọi khoảng trắng THỪA thành một dấu cách, bỏ đầu/cuối, viết HOA.
// CỐ Ý KHÔNG xoá hết khoảng trắng: trong danh mục thật, "AMBI SAP 180G" và "AMBI SAP180G" là HAI
// mặt hàng khác nhau — xoá trắng khoảng trắng sẽ gộp chúng làm một và che mất cảnh báo lệch mã.
// Hàm này chỉ dùng để TRA, KHÔNG sửa giá trị ghi ra file MISA.
const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

// Dòng tiêu đề = hàng có NHIỀU ô có dữ liệu nhất trong 15 hàng đầu (hàng 1-2 là ô gộp trang trí
// nên chỉ có 1 ô). Trả về chỉ số 0-based, hoặc -1 nếu không thấy.
function findHeaderRow(rows) {
  let best = -1;
  let bestCount = 0;
  const limit = Math.min(rows.length, 15);
  for (let index = 0; index < limit; index += 1) {
    const count = (rows[index] || []).filter(cell => String(cell ?? '').trim()).length;
    if (count > bestCount) { bestCount = count; best = index; }
  }
  // Ngưỡng tối thiểu là 2 ô (không phải 3): danh mục tối giản chỉ có "Mã" + "Tên" vẫn phải nhập
  // được — file có ĐÚNG cột hay không do phần tìm cột bên dưới kiểm tra.
  return bestCount >= 2 ? best : -1;
}

// Tìm chỉ số cột theo TÊN tiêu đề. `test` nhận chuỗi đã chuẩn hoá (bỏ dấu) — xem strip().
function columnOf(header, test) {
  for (let index = 0; index < header.length; index += 1) {
    const text = strip(header[index]);
    if (text && test(text)) return index;
  }
  return -1;
}

// Bỏ dấu tiếng Việt + viết thường để so tên cột ("Đơn vị tính chính" → "don vi tinh chinh").
function strip(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function readSheet(buffer) {
  const book = XLSX.read(buffer, { type: 'buffer' });
  const name = book.SheetNames[0];
  if (!name) throw new Error('File Excel không có sheet nào.');
  return XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, blankrows: true, defval: null, raw: true });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[.\s]/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

// Nhập (hoặc nhập lại) danh mục: THAY TOÀN BỘ, vì file Danhsach là danh mục đầy đủ của công ty.
// Giữ lại hàng cũ không còn trong file mới sẽ khiến bước đối chiếu báo "mã hợp lệ" cho mặt hàng
// đã bị xoá khỏi danh mục — sai âm thầm.
function importWorkbook(db, { buffer } = {}) {
  const rows = readSheet(buffer);
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) throw new Error('Không tìm thấy dòng tiêu đề trong file danh mục (cần có các cột Mã / Tên).');
  const header = rows[headerIndex] || [];
  const columns = {
    ma: columnOf(header, text => text === 'ma' || text.startsWith('ma ')),
    ten: columnOf(header, text => text === 'ten' || text.startsWith('ten ')),
    dvt: columnOf(header, text => text.includes('don vi tinh')),
    kho: columnOf(header, text => text.includes('kho')),
    gia: columnOf(header, text => text.includes('gia')),
  };
  if (columns.ma < 0 || columns.ten < 0) {
    throw new Error('File danh mục thiếu cột "Mã" hoặc "Tên". Kiểm tra lại sheet đầu tiên.');
  }

  const at = (row, index) => (index >= 0 ? row[index] : null);
  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  const seen = new Set();

  const insert = db.prepare(`INSERT INTO product_master (ma_hang, ma_chuan, ten_chuan, dvt, kho, don_gia_mua, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM product_master').run();
    for (let index = headerIndex + 1; index < rows.length; index += 1) {
      const row = rows[index] || [];
      const ma = String(at(row, columns.ma) ?? '').trim();
      const ten = String(at(row, columns.ten) ?? '').trim();
      if (!ma) { skipped += 1; continue; }
      const key = normalize(ma);
      if (!key) { skipped += 1; continue; }
      // Mã trùng trong file: giữ dòng ĐẦU (dòng sau là bản sao/ghi chú) — không ghi đè lặng lẽ.
      if (seen.has(key)) { skipped += 1; continue; }
      seen.add(key);
      insert.run(ma, key, ten || ma, String(at(row, columns.dvt) ?? '').trim(), String(at(row, columns.kho) ?? '').trim(),
        numberOrNull(at(row, columns.gia)), now);
      imported += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { imported, skipped, rows: rows.length - headerIndex - 1, headerRow: headerIndex + 1, columns };
}

// Bảng tra mã đã chuẩn hoá → dòng danh mục. Dùng cho bước đối chiếu khi xuất file MISA.
function lookupMap(db) {
  const map = new Map();
  for (const row of db.prepare('SELECT ma_hang, ma_chuan, ten_chuan, dvt, kho, don_gia_mua FROM product_master').all()) {
    map.set(row.ma_chuan || normalize(row.ma_hang), row);
  }
  return map;
}

// Bảng tra TÊN hàng (chuẩn hoá) → MÃ hàng. Dùng khi HOÁ ĐƠN KHÔNG GHI MÃ HÀNG: tra tên trong
// danh mục công ty để lấy đúng mã, thay vì bịa ra một mã mới.
//
// Tên TRÙNG nhiều mã thì BỎ RA khỏi bảng tra: không thể biết mã nào đúng, đoán bừa sẽ gắn hàng
// sai vào sổ. Những tên đó đếm vào `ambiguous` để cảnh báo.
function lookupByName(db) {
  const map = new Map();
  const ambiguous = new Set();
  const rows = db.prepare("SELECT ma_hang, ten_chuan FROM product_master WHERE COALESCE(TRIM(ten_chuan), '') <> ''").all();
  for (const row of rows) {
    const key = normalize(row.ten_chuan);
    if (!key) continue;
    if (map.has(key) && map.get(key) !== row.ma_hang) { ambiguous.add(key); continue; }
    map.set(key, row.ma_hang);
  }
  for (const key of ambiguous) map.delete(key);
  return { map, ambiguous };
}

function summary(db) {
  const row = db.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS updated_at FROM product_master').get() || {};
  return { count: Number(row.count) || 0, updatedAt: row.updated_at || '' };
}

module.exports = { importWorkbook, lookupMap, lookupByName, summary, normalize, strip, findHeaderRow, numberOrNull };
