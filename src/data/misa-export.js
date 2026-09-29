'use strict';
// ---------------------------------------------------------------------------
// XUẤT FILE "MẪU BÁN HÀNG" ĐỂ NHẬP VÀO MISA AMIS ACCOUNTING (tab Hỗ trợ kế toán).
//
// MỤC ĐÍCH THẬT: người dùng đang NHẬP LẠI hoá đơn bán hàng vào hệ thống kế toán, nên file phải
// ĐÚNG THEO HOÁ ĐƠN và ĐÚNG CẤU TRÚC file mẫu — sai một cột là MISA nhập sai sổ.
//
// BA NGUYÊN TẮC:
//   1. SỐ LIỆU LẤY TỪ HOÁ ĐƠN (XML → data.db). Danh mục `Danhsach.xlsx` CHỈ để đối chiếu mã hàng,
//      KHÔNG phải nguồn số tiền/số lượng.
//   2. CẤU TRÚC LẤY TỪ CHÍNH FILE MẪU: đọc `src/template/mau-ban-hang.xls` lấy nguyên 8 hàng đầu
//      (tiêu đề + hướng dẫn + 3 ô gộp nhóm + tiêu đề 41 cột), ghi dữ liệu TỪ HÀNG 9. Không tự
//      dựng lại tiêu đề bằng tay — lệch một chữ là MISA không nhận.
//   3. KHÔNG XUẤT FILE THIẾU: kiểm hết ô bắt buộc và giá trị hợp lệ TRƯỚC khi ghi; có lỗi thì
//      KHÔNG xuất, trả về danh sách dòng lỗi để người dùng sửa. Đây là chốt bảo đảm "bắt buộc đúng".
//
// MỘT DÒNG = MỘT DÒNG HÀNG HOÁ. Các cột chứng từ (A→X) LẶP LẠI trên mọi dòng hàng của cùng một
// hoá đơn; Số chứng từ (I) và Mã khách hàng (O) được cấp MỘT LẦN cho mỗi hoá đơn / mỗi khách.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const XLSX = require('../../resources/xlsx.cjs');
const vnDate = require('../vn-date');
const productMaster = require('./product-master');

const TEMPLATE_FILE = path.join(__dirname, '..', 'template', 'mau-ban-hang.xls');
const HEADER_ROWS = 8;           // 1..8 = tiêu đề + hướng dẫn + ô gộp + tiêu đề cột
const DATA_FIRST_ROW = 9;         // dữ liệu bắt đầu từ hàng 9 (1-based)
const COUNTER_NAME = 'misa_pt';   // bộ đếm Số chứng từ, lưu trong data.db

// 41 cột ĐÚNG THỨ TỰ file mẫu. tests/misa-export.test.js so từng chuỗi này với tiêu đề đọc từ
// chính file mẫu — lệch một chữ là test đỏ, không thể âm thầm lệch cột.
const HEADERS = [
  'Hình thức bán hàng', 'Phương thức thanh toán', 'Kiêm phiếu xuất kho', 'Lập kèm hóa đơn',
  'Là hóa đơn từ máy tính tiền', 'Đã lập hóa đơn', 'Ngày hạch toán (*)', 'Ngày chứng từ (*)',
  'Số chứng từ (*)', 'Số phiếu xuất', 'Mẫu số HĐ', 'Ký hiệu HĐ', 'Số hóa đơn', 'Ngày hóa đơn',
  'Mã khách hàng', 'Tên khách hàng', 'Địa chỉ', 'Mã số thuế', 'Đơn vị giao đại lý', 'Người nộp',
  'Nộp vào TK', 'Diễn giải/Lý do nộp', 'Lý do xuất', 'Có phát sinh giảm 20% thuế GTGT',
  'Mã hàng (*)', 'Tên hàng', 'Là dòng ghi chú', 'Hàng khuyến mại', 'ĐVT', 'Số lượng', 'Đơn giá',
  'Thành tiền', 'Tỷ lệ CK (%)', 'Tiền chiết khấu', 'Nhóm ngành nghề', 'Mã kho', 'Đơn giá vốn',
  'Tiền vốn', 'Không cập nhật giá xuất', 'Mã tra cứu HĐĐT', 'Đường dẫn tra cứu HĐĐT',
];
// Chỉ số cột theo bảng chữ cái Excel (A=0 … AO=40) để chỗ dựng dòng đọc được, không dùng số trần.
const C = {
  hinhThuc: 0, phuongThuc: 1, kiemPhieu: 2, lapKemHD: 3, mayTinhTien: 4, daLapHD: 5,
  ngayHachToan: 6, ngayChungTu: 7, soChungTu: 8, soPhieuXuat: 9, mauSoHD: 10, kyHieuHD: 11,
  soHD: 12, ngayHoaDon: 13, maKhach: 14, tenKhach: 15, diaChi: 16, maSoThue: 17,
  giam20: 23, maHang: 24, tenHang: 25, laGhiChu: 26, khuyenMai: 27, dvt: 28,
  soLuong: 29, donGia: 30, thanhTien: 31, tyLeCK: 32, tienChietKhau: 33, nhomNganh: 34,
  maKho: 35, donGiaVon: 36, tienVon: 37, khongCapNhat: 38, maTraCuu: 39,
};

// GIÁ TRỊ HỢP LỆ — lấy đúng từ danh sách chọn (data validation) trong file mẫu. Ghi ra ngoài
// danh sách này thì MISA báo lỗi dòng đó.
const ALLOWED = {
  hinhThuc: ['Bán hàng hóa trong nước', 'Bán hàng đại lý bán đúng giá'],
  phuongThuc: ['Chưa thu tiền', 'Thu tiền ngay - Tiền mặt', 'Thu tiền ngay - Chuyển khoản'],
  coKhong: ['Có', 'Không'],
  daLap: ['Chưa lập', 'Đã lập'],
  coKhongThuong: ['Có', 'không'],       // cột AA của mẫu dùng chữ "không" VIẾT THƯỜNG
  khongCapNhat: ['Chọn', 'Không chọn'],
};
// Mặc định cho các cột MISA cần nhưng hoá đơn KHÔNG có (người dùng đã chốt).
const DEFAULT = {
  hinhThuc: 'Bán hàng hóa trong nước',
  kiemPhieu: 'Không',
  lapKemHD: 'Có',
  mayTinhTien: 'Không',
  daLapHD: 'Đã lập',
  laGhiChu: 'không',
};

// PHƯƠNG THỨC THANH TOÁN: hoá đơn có sẵn `HTTToan` (đã chuẩn hoá thành CASH/TRANSFER/... trong
// data.db) ⇒ lấy trên hoá đơn, KHÔNG tự đoán. Không rõ thì để "Chưa thu tiền".
const PAYMENT_LABEL = {
  CASH: 'Thu tiền ngay - Tiền mặt',
  TRANSFER: 'Thu tiền ngay - Chuyển khoản',
  UNKNOWN: 'Chưa thu tiền',
  AMBIGUOUS: 'Chưa thu tiền',
};

const dmy = value => vnDate.dmy(value);
const num = new Intl.NumberFormat('vi-VN');
const numberOrNull = value => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
const normalizeName = value => String(value ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

// ---- mẫu file ---------------------------------------------------------------
let templateCache = null;
function template() {
  if (templateCache) return templateCache;
  const book = XLSX.read(fs.readFileSync(TEMPLATE_FILE), { type: 'buffer' });
  const name = book.SheetNames[0];
  const sheet = book.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: null, raw: true });
  templateCache = {
    name,
    headerRows: rows.slice(0, HEADER_ROWS),
    templateHeaders: (rows[HEADER_ROWS - 1] || []).map(value => String(value ?? '').trim()),
    merges: sheet['!merges'] || [],
    cols: sheet['!cols'] || [],
  };
  return templateCache;
}

// ---- truy vấn hoá đơn BÁN RA -------------------------------------------------
// Chỉ hoá đơn BÁN RA (direction = 'SELL') và CÒN HIỆU LỰC: loại tthai 4/5/6 (đã bị thay thế /
// điều chỉnh / huỷ) — dùng CHUNG luật với mọi tab khác để số liệu không lệch.
// Thứ tự theo SỐ HOÁ ĐƠN để số chứng từ PT tăng dần đúng theo số hoá đơn (yêu cầu người dùng).
const ACTIVE = "COALESCE(v.tthai, '') NOT IN ('4', '5', '6')";
function invoiceLines(db, { from = '', to = '' } = {}) {
  const where = ["v.direction = 'SELL'", ACTIVE];
  const params = [];
  if (from) { where.push('v.ngay_lap >= ?'); params.push(from); }
  if (to) { where.push('v.ngay_lap <= ?'); params.push(to); }
  return db.prepare(`SELECT v.id, v.invoice_key, v.ngay_lap, v.khms_hd, v.khh_hd, v.so_hd, v.mst_mua, v.ten_mua,
      v.payment_method, v.tthai, v.file_xml,
      i.stt, i.ma_hang, i.ten_hang, i.don_vi, i.so_luong, i.don_gia, i.chiet_khau, i.thanh_tien, i.thue_suat
    FROM invoices v JOIN invoice_items i ON i.invoice_id = v.id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(v.so_hd, '') ASC, v.ngay_lap ASC, v.id ASC, i.stt ASC`).all(...params);
}

// ---- mã khách hàng: ỔN ĐỊNH theo TÊN khách --------------------------------
// Yêu cầu "mã KH tự random/quay vòng". Sinh ngẫu nhiên THEO TỪNG DÒNG là sai: cùng một khách sẽ
// ra nhiều mã ⇒ MISA tạo TRÙNG khách hàng, công nợ tách sai. Nên: cấp mã tăng dần theo TÊN khách
// (KH0001, KH0002…), khách đã gặp thì DÙNG LẠI đúng mã cũ, lưu trong data.db nên xuất lại vẫn
// ra mã đó.
function customerCodes(db, names, { persist = false } = {}) {
  const map = new Map();
  const get = db.prepare('SELECT ma_kh FROM customer_codes WHERE ten_chuan = ?');
  const maxRow = db.prepare("SELECT MAX(CAST(SUBSTR(ma_kh, 3) AS INTEGER)) AS n FROM customer_codes WHERE ma_kh LIKE 'KH%'").get();
  let next = (Number(maxRow && maxRow.n) || 0) + 1;
  const insert = persist
    ? db.prepare('INSERT OR IGNORE INTO customer_codes (ten_chuan, ma_kh, ten_goc, created_at) VALUES (?, ?, ?, ?)')
    : null;
  for (const name of names) {
    const key = normalizeName(name);
    if (!key || map.has(key)) continue;
    const found = get.get(key);
    if (found) { map.set(key, found.ma_kh); continue; }
    const code = `KH${String(next).padStart(4, '0')}`;
    next += 1;
    map.set(key, code);
    if (insert) insert.run(key, code, String(name || '').trim(), new Date().toISOString());
  }
  return map;
}

// ---- số chứng từ: PT0001 tăng dần -------------------------------------------
function counterValue(db) {
  const row = db.prepare('SELECT value FROM misa_counters WHERE name = ?').get(COUNTER_NAME);
  return Number(row && row.value) || 0;
}
function setCounter(db, value) {
  db.prepare(`INSERT INTO misa_counters (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(COUNTER_NAME, value, new Date().toISOString());
}
function voucher(prefix, number) {
  return `${prefix}${String(number).padStart(4, '0')}`;
}

// ---- MCCQT (Mã tra cứu HĐĐT) đọc từ XML gốc --------------------------------
// Trường này CÓ trên hoá đơn nhưng KHÔNG được lưu vào data.db (schema chỉ giữ đường dẫn file XML),
// nên phải đọc lại file. Đọc không được thì để trống — đây KHÔNG phải cột bắt buộc.
const mccqtCache = new Map();
function mccqtOf(fileXml) {
  const file = String(fileXml || '');
  if (!file) return '';
  if (mccqtCache.has(file)) return mccqtCache.get(file);
  let value = '';
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/<MCCQT>([\s\S]*?)<\/MCCQT>/);
    value = match ? match[1].trim() : '';
  } catch { value = ''; }
  mccqtCache.set(file, value);
  return value;
}

// Hàng hoá khuyến mại: đơn giá 0 (hoặc thành tiền 0) — hoá đơn ghi rõ nên suy được.
const isPromotion = (donGia, thanhTien) => (Number(donGia) === 0 && Number(thanhTien) > 0);

// Hoá đơn có phát sinh giảm 20% thuế GTGT: thuế suất 8% (thay vì 10%) — chính sách giảm 20%.
function reducedVat(thueSuat) {
  const text = String(thueSuat ?? '').replace(',', '.').replace('%', '').trim();
  const value = Number(text);
  return Number.isFinite(value) && value > 0 && value < 10;
}

// ---- DỰNG DỮ LIỆU + KIỂM LỖI ------------------------------------------------
// Trả về mọi thứ cần để xuất: dòng dữ liệu, cảnh báo, LỖI CHẶN XUẤT, và thống kê.
// `missingCode`: hoá đơn KHÔNG ghi Mã hàng thì làm gì —
//   'name'  (mặc định): tra mã theo TÊN trong danh mục; không thấy thì dùng TÊN hàng làm mã.
//   'block'           : coi là lỗi, KHÔNG xuất file (người dùng tự bổ sung mã trước).
function prepare(db, { from = '', to = '', prefix = 'PT', startNo = null, missingCode = 'name' } = {}) {
  const lines = invoiceLines(db, { from, to });
  const catalog = productMaster.lookupMap(db);
  const catalogReady = catalog.size > 0;
  // Tra mã theo TÊN — dùng khi hoá đơn không ghi mã hàng (dữ liệu thật: ~10% số dòng như vậy).
  const byName = productMaster.lookupByName(db);
  const policy = missingCode === 'block' ? 'block' : 'name';

  // Mã khách cấp theo TÊN, một lần cho mỗi tên.
  const names = [...new Set(lines.map(row => String(row.ten_mua || '').trim()).filter(Boolean))];
  const codes = customerCodes(db, names);

  // Số chứng từ: một số cho MỖI HOÁ ĐƠN (không phải mỗi dòng hàng).
  const first = Number.isFinite(Number(startNo)) && Number(startNo) > 0 ? Number(startNo) : counterValue(db) + 1;
  const voucherOf = new Map();
  let next = first;
  for (const row of lines) {
    if (voucherOf.has(row.id)) continue;
    voucherOf.set(row.id, voucher(prefix, next));
    next += 1;
  }

  const errors = [];
  const warnings = [];
  const unmatched = new Set();
  const rows = [];
  const seenInvoices = new Map();
  let codeFromName = 0;    // thiếu mã → lấy mã theo TÊN từ danh mục công ty
  let codeFallback = 0;    // thiếu mã → dùng luôn TÊN hàng làm mã
  let noteLines = 0;       // dòng ghi chú (không phải mặt hàng)

  for (const line of lines) {
    const row = new Array(HEADERS.length).fill(null);
    const amount = Number(line.thanh_tien);
    const quantity = numberOrNull(line.so_luong);
    const price = numberOrNull(line.don_gia);

    row[C.hinhThuc] = DEFAULT.hinhThuc;
    row[C.phuongThuc] = PAYMENT_LABEL[String(line.payment_method || 'UNKNOWN')] || PAYMENT_LABEL.UNKNOWN;
    row[C.kiemPhieu] = DEFAULT.kiemPhieu;
    row[C.lapKemHD] = DEFAULT.lapKemHD;
    row[C.mayTinhTien] = DEFAULT.mayTinhTien;
    row[C.daLapHD] = DEFAULT.daLapHD;
    row[C.ngayHachToan] = dmy(line.ngay_lap);
    row[C.ngayChungTu] = dmy(line.ngay_lap);
    row[C.soChungTu] = voucherOf.get(line.id) || '';
    row[C.soPhieuXuat] = null;
    row[C.mauSoHD] = line.khms_hd || '';
    row[C.kyHieuHD] = line.khh_hd || '';
    row[C.soHD] = line.so_hd || '';            // giữ nguyên dạng chuỗi để không mất số 0 đầu
    row[C.ngayHoaDon] = dmy(line.ngay_lap);
    row[C.maKhach] = codes.get(normalizeName(line.ten_mua)) || '';
    row[C.tenKhach] = String(line.ten_mua || '').trim().replace(/^[,\s]+/, '');
    row[C.diaChi] = null;                      // người dùng chốt: KHÔNG cần địa chỉ
    row[C.maSoThue] = line.mst_mua || '';
    row[C.giam20] = reducedVat(line.thue_suat) ? 'Có' : 'Không';
    // MÃ HÀNG — 3 TẦNG. Dữ liệu thật cho thấy ~10% dòng KHÔNG có mã hàng (hoá đơn bán lẻ để
    // trống cả cột), mà MISA lại BẮT BUỘC cột này. Thứ tự:
    //   1) hoá đơn có mã            → dùng mã của hoá đơn
    //   2) hoá đơn không có mã      → tra TÊN trong danh mục công ty để lấy ĐÚNG mã
    //   3) vẫn không ra mã          → dùng TÊN hàng làm mã (policy 'name'), hoặc CHẶN ('block')
    // DÒNG GHI CHÚ — hoá đơn thật có những dòng KHÔNG phải mặt hàng: không số lượng, không đơn
    // giá, không thành tiền. Ví dụ thật: "Đã giảm 44.267 đồng tương ứng 20% mức tỷ lệ % để tính
    // thuế GTGT theo Nghị quyết số 174/2024/QH15", "(Xuất thành 3 giỏ quà )", "Điều chỉnh thông
    // tin hóa đơn ... mã số thuế người mua từ ... thành ...".
    // MISA có sẵn cột AA "Là dòng ghi chú" cho ĐÚNG loại dòng này ⇒ KHÔNG được coi là lỗi, nếu
    // chặn thì không xuất được hoá đơn chỉ vì một câu ghi chú; và cũng KHÔNG được đẩy câu ghi chú
    // lên thành một mặt hàng.
    const isNote = quantity === null && price === null && (line.thanh_tien === null || Number(line.thanh_tien) === 0);
    if (isNote) noteLines += 1;

    const invoiceCode = String(line.ma_hang || '').trim();
    const tenHang = String(line.ten_hang || '').trim();
    if (invoiceCode) row[C.maHang] = invoiceCode;
    else if (tenHang && byName.map.has(productMaster.normalize(tenHang))) {
      row[C.maHang] = byName.map.get(productMaster.normalize(tenHang));
      codeFromName += 1;
    } else if (policy === 'name' && tenHang) {
      // Dòng ghi chú không phải mặt hàng nên KHÔNG tính vào thống kê "tự điền mã hàng".
      row[C.maHang] = tenHang;
      if (!isNote) codeFallback += 1;
    } else row[C.maHang] = '';
    row[C.tenHang] = tenHang;
    row[C.laGhiChu] = isNote ? 'Có' : DEFAULT.laGhiChu;
    row[C.khuyenMai] = isNote ? 'Không' : (isPromotion(line.don_gia, line.thanh_tien) ? 'Có' : 'Không');
    row[C.dvt] = String(line.don_vi || '').trim();
    row[C.soLuong] = isNote ? null : quantity;
    row[C.donGia] = isNote ? null : price;
    row[C.thanhTien] = isNote ? null : (Number.isFinite(amount) ? amount : null);   // SỐ, không ghi công thức
    row[C.tyLeCK] = null;                      // hoá đơn chỉ có SỐ TIỀN chiết khấu, không có %
    row[C.tienChietKhau] = isNote ? null : (Number(line.chiet_khau) ? Number(line.chiet_khau) : null);
    // Chi tiết giá vốn (AJ→AM), Nhóm ngành nghề (AI): người dùng chốt KHÔNG nhập ⇒ để trống.
    row[C.maTraCuu] = mccqtOf(line.file_xml);

    // ---- KIỂM LỖI: ô bắt buộc + giá trị phải thuộc danh sách hợp lệ ----
    // Nhãn lỗi nêu ĐỦ thông tin để TÌM RA hoá đơn: số HĐ, ký hiệu, ngày, khách, dòng. Trước đây chỉ
    // có "MST · HĐ 113 · dòng 6" — hoá đơn bán lẻ không có MST nên nhìn không biết là hoá đơn nào.
    const at = `HĐ ${line.so_hd || '?'} (${line.khh_hd || '?'} · ${dmy(line.ngay_lap) || '?'}) · `
      + `${line.mst_mua ? `MST ${line.mst_mua} · ` : ''}khách "${String(line.ten_mua || '').trim() || '?'}" · dòng ${line.stt || '?'}`;
    const required = [[C.ngayHachToan, 'Ngày hạch toán (*)'], [C.ngayChungTu, 'Ngày chứng từ (*)'],
      [C.soChungTu, 'Số chứng từ (*)']];
    for (const [index, label] of required) {
      if (row[index] === null || row[index] === '') errors.push(`${at}: thiếu ${label}`);
    }
    // Mã hàng tách riêng để nói rõ CÁCH SỬA — đây là lỗi hay gặp nhất với hoá đơn bán lẻ.
    if (!row[C.maHang]) {
      errors.push(tenHang
        ? `${at}: thiếu Mã hàng (*) — hàng "${tenHang}" chưa có mã. Bật “Dùng tên hàng làm mã hàng” ở cột lọc, hoặc nhập danh mục hàng hoá để tra mã theo tên.`
        : `${at}: thiếu CẢ Mã hàng lẫn Tên hàng (*) — phải bổ sung trong file XML gốc.`);
    }
    // Số lượng / Đơn giá / Thành tiền: dòng ghi chú thì TRỐNG là ĐÚNG quy ước của MISA ⇒ bỏ qua.
    if (!isNote) {
      if (quantity === null) errors.push(`${at}: Số lượng không đọc được (${line.so_luong})`);
      if (price === null) errors.push(`${at}: Đơn giá không đọc được (${line.don_gia})`);
      if (row[C.thanhTien] === null) errors.push(`${at}: Thành tiền không đọc được (${line.thanh_tien})`);
    }
    const checks = [[C.hinhThuc, ALLOWED.hinhThuc, 'Hình thức bán hàng'], [C.phuongThuc, ALLOWED.phuongThuc, 'Phương thức thanh toán'],
      [C.kiemPhieu, ALLOWED.coKhong, 'Kiêm phiếu xuất kho'], [C.lapKemHD, ALLOWED.coKhong, 'Lập kèm hóa đơn'],
      [C.mayTinhTien, ALLOWED.coKhong, 'Là hóa đơn từ máy tính tiền'], [C.daLapHD, ALLOWED.daLap, 'Đã lập hóa đơn'],
      [C.laGhiChu, ALLOWED.coKhongThuong, 'Là dòng ghi chú'], [C.khuyenMai, ALLOWED.coKhong, 'Hàng khuyến mại']];
    for (const [index, allowed, label] of checks) {
      if (!allowed.includes(row[index])) errors.push(`${at}: ${label} = "${row[index]}" không thuộc danh sách hợp lệ`);
    }
    if (!row[C.tenKhach]) warnings.push(`${at}: hoá đơn không có tên khách hàng`);
    if (!row[C.soHD]) warnings.push(`${at}: hoá đơn không có số hoá đơn`);

    // Đối chiếu mã hàng với danh mục công ty — CHỈ cảnh báo, không chặn (người dùng quyết định).
    // BỎ QUA dòng ghi chú: nội dung ghi chú không phải mã hàng, đưa vào chỉ tạo cảnh báo rác.
    if (catalogReady && !isNote && row[C.maHang]) {
      const key = productMaster.normalize(row[C.maHang]);
      if (!catalog.has(key)) unmatched.add(row[C.maHang]);
    }

    seenInvoices.set(line.id, (seenInvoices.get(line.id) || 0) + 1);
    rows.push(row);
  }

  if (!catalogReady) warnings.push('Chưa nhập danh mục hàng hoá (Danhsach.xlsx) — bỏ qua bước tra mã theo tên.');
  else if (unmatched.size) warnings.push(`${unmatched.size} mã hàng KHÔNG có trong danh mục công ty: ${[...unmatched].slice(0, 12).join(', ')}${unmatched.size > 12 ? ' …' : ''}`);
  // Nói RÕ đã xử lý bao nhiêu dòng thiếu mã — đây là thay đổi so với hoá đơn nên phải hiện ra.
  if (codeFromName) warnings.push(`${num.format(codeFromName)} dòng hoá đơn KHÔNG ghi mã hàng — đã lấy mã theo TÊN từ danh mục công ty.`);
  if (codeFallback) warnings.push(`${num.format(codeFallback)} dòng hoá đơn KHÔNG có mã hàng và danh mục cũng không có tên tương ứng — đã DÙNG TÊN HÀNG LÀM MÃ HÀNG (MISA sẽ tạo mặt hàng theo tên này).`);
  if (policy === 'block' && (codeFromName || codeFallback)) warnings.push('Đang bật chế độ CHẶN: dòng thiếu mã hàng sẽ báo lỗi thay vì tự điền.');
  // Dòng ghi chú: nói rõ vì đây là dòng KHÔNG phải mặt hàng, người dùng cần biết để đối chiếu.
  if (noteLines) warnings.push(`${num.format(noteLines)} dòng là DÒNG GHI CHÚ (không có số lượng/đơn giá/thành tiền) — đã đánh dấu cột “Là dòng ghi chú” = Có theo đúng quy ước của MISA, không tính là mặt hàng.`);

  return {
    rows, errors, warnings,
    stats: {
      invoices: seenInvoices.size,
      lines: rows.length,
      catalog: catalog.size,
      unmatched: unmatched.size,
      codeFromName,
      codeFallback,
      noteLines,
      firstVoucher: rows.length ? voucherOf.get(lines[0].id) : '',
      lastVoucher: rows.length ? voucherOf.get(lines[lines.length - 1].id) : '',
      nextVoucher: next,
      customers: codes.size,
    },
  };
}

// ---- GHI FILE ---------------------------------------------------------------
// Giữ NGUYÊN 8 hàng đầu của file mẫu (kể cả 3 ô gộp nhóm) rồi ghi dữ liệu từ hàng 9.
//
// VÌ SAO CÓ 2 ĐỊNH DẠNG:
// MISA GHÉP CỘT bằng chính các luật dataValidation (danh sách chọn) có trong file mẫu — mỗi luật
// ghi rõ `sqref` (cột nào) và `prompt` (trường nào, ví dụ sqref="R8" → "Nhập Mã số thuế khách
// hàng"). File thiếu các luật đó thì MISA báo:
//   "Không thể tiếp tục nhập dữ liệu nếu các cột bắt buộc chưa được ghép với cột tương ứng…"
// SheetJS bản community KHÔNG ghi được dataValidation vào .xls, nên đường .xls KHÔNG dùng được với
// MISA. Đường .xlsx ghi bằng SheetJS rồi TIÊM khối <dataValidations> của mẫu vào (xem injectDecor)
// — nhờ vậy MISA ghép được cột.
//
// CHỈ tiêm <dataValidations>, KHÔNG tiêm <cols> của mẫu: khối <cols> của mẫu trỏ tới các chỉ số
// style (`style="N"`) chỉ có trong styles.xml của MẪU, không có trong styles.xml do SheetJS ghi ⇒
// nhồi vào là FILE HỎNG (openpyxl từ chối mở: "IndexError ... bind_col_dimensions"). Độ rộng cột
// vẫn được giữ nguyên vì SheetJS tự ghi <cols> từ chính `!cols` đọc được của mẫu.
const TEMPLATE_DECOR = {
  dataValidations: path.join(__dirname, '..', 'template', 'mau-ban-hang-dv.xml'),
};
let decorCache = null;
function decor() {
  if (decorCache) return decorCache;
  let dataValidations = '';
  try { dataValidations = fs.readFileSync(TEMPLATE_DECOR.dataValidations, 'utf8'); } catch { dataValidations = ''; }
  decorCache = { dataValidations };
  return decorCache;
}

// Dựng sheet + ghi DB. ĐỒNG BỘ và là chỗ DUY NHẤT truy cập DB — nhờ vậy nơi gọi có thể chạy phần
// nén file (bất đồng bộ) SAU KHI đã đóng/trả kết nối, không giữ kết nối qua await.
function assemble(db, options = {}) {
  const { prefix = 'PT', startNo = null, persist = true } = options;
  const tpl = template();
  const result = prepare(db, { ...options, prefix, startNo });
  if (result.errors.length) {
    const error = new Error(`File chưa đúng: ${result.errors.length} lỗi cần sửa trước khi xuất.`);
    error.exportErrors = result.errors.slice(0, 50);
    error.exportWarnings = result.warnings;
    throw error;
  }
  const sheet = XLSX.utils.aoa_to_sheet([...tpl.headerRows, ...result.rows]);
  // Ô gộp của mẫu đều nằm trong 8 hàng đầu nên toạ độ còn nguyên giá trị.
  sheet['!merges'] = tpl.merges;
  if (tpl.cols && tpl.cols.length) sheet['!cols'] = tpl.cols;

  // Bộ đếm + mã khách chỉ ghi khi file ĐÃ dựng xong: lượt xuất lỗi không được tiêu mất số.
  if (persist && options.mst) {
    db.exec('BEGIN');
    try {
      setCounter(db, result.stats.nextVoucher - 1);
      customerCodes(db, [...new Set(result.rows.map(row => row[C.tenKhach]).filter(Boolean))], { persist: true });
      db.exec('COMMIT');
    } catch { db.exec('ROLLBACK'); }
  }
  return { sheet, sheetName: tpl.name, result, mst: options.mst || '', baseName: fileName(options.mst, options.from, options.to).replace(/\.xls$/, '') };
}

function bookOf(parts) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, parts.sheet, parts.sheetName);
  return book;
}

// .xls — giống đúng định dạng file mẫu nhưng KHÔNG mang được dataValidation (MISA không ghép cột).
function renderXls(parts) {
  return XLSX.write(bookOf(parts), { type: 'buffer', bookType: 'biff8' });
}

// Chèn khối <cols> + <dataValidations> của mẫu vào sheet .xlsx vừa ghi.
// Thứ tự phần tử trong XML bảng tính là BẮT BUỘC: <cols> trước <sheetData>; <mergeCells> trước
// <dataValidations> — chèn sai chỗ thì Excel/MISA coi file là hỏng.
async function injectDecor(buffer) {
  const block = decor();
  if (!block.dataValidations) return buffer;   // thiếu tài nguyên ⇒ trả file thô, không làm hỏng file
  const zip = await JSZip.loadAsync(buffer);
  const entry = 'xl/worksheets/sheet1.xml';
  const file = zip.file(entry);
  if (!file) return buffer;
  let xml = await file.async('string');
  if (!/<dataValidations/.test(xml)) {
    const at = /<\/mergeCells>/.test(xml)
      ? xml.indexOf('</mergeCells>') + '</mergeCells>'.length
      : xml.indexOf('</sheetData>') + '</sheetData>'.length;
    xml = xml.slice(0, at) + block.dataValidations + xml.slice(at);
  }
  zip.file(entry, xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// .xlsx — CÓ dataValidation ⇒ MISA ghép được cột. Đây là định dạng nên dùng.
async function renderXlsx(parts) {
  return injectDecor(XLSX.write(bookOf(parts), { type: 'buffer', bookType: 'xlsx' }));
}

// Giữ API cũ (đồng bộ) cho .xls — test và nơi gọi cũ dùng hàm này.
function buildWorkbook(db, options = {}) {
  const parts = assemble(db, options);
  return { buffer: renderXls(parts), fileName: `${parts.baseName}.xls`, ...parts.result };
}

async function buildXlsx(db, options = {}) {
  const parts = assemble(db, options);
  return { buffer: await renderXlsx(parts), fileName: `${parts.baseName}.xlsx`, ...parts.result };
}

function fileName(mst, from, to) {
  const clean = value => String(value || '').replace(/-/g, '');
  const span = from || to ? `_${clean(from)}-${clean(to)}` : '';
  return `Mau_ban_hang_${mst || 'MST'}${span}.xls`;
}

module.exports = {
  HEADERS, C, ALLOWED, DEFAULT, PAYMENT_LABEL, DATA_FIRST_ROW, HEADER_ROWS, TEMPLATE_FILE, TEMPLATE_DECOR,
  template, decor, prepare, assemble, renderXls, renderXlsx, injectDecor, buildWorkbook, buildXlsx, fileName,
  invoiceLines, customerCodes, counterValue, setCounter,
  voucher, reducedVat, isPromotion, mccqtOf, normalizeName,
};
