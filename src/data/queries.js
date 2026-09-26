'use strict';
// ---------------------------------------------------------------------------
// Truy vấn cho UI — PROJECT_ARCHITECTURE §15, §32, §33, §34, §37, §39.
//
// Mọi thứ đi qua SQLite: KHÔNG quét XML, KHÔNG nạp toàn bộ hoá đơn vào RAM/DOM.
// Danh sách luôn phân trang; tổng hợp hàng hoá làm bằng SQL (GROUP BY).
// ---------------------------------------------------------------------------

const { EXCLUDED } = require('./invoice-state');

// Mệnh đề "hoá đơn còn hiệu lực" — dùng CHUNG cho hàng hoá, đối tác và tổng tiền để các con số
// không lệch nhau giữa các tab.
//
// COALESCE là BẮT BUỘC: `tthai NOT IN ('4','5','6')` với tthai NULL cho ra NULL (không phải TRUE),
// nên MỌI hoá đơn CHƯA BIẾT trạng thái sẽ bị loại oan. `COALESCE(tthai,'')` biến NULL thành '' ⇒
// hoá đơn chưa biết trạng thái vẫn được tính (thiếu dữ liệu thì không kết luận là mất hiệu lực).
const EXCLUDED_SQL = EXCLUDED.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ');
const column = alias => `${alias ? `${alias}.` : ''}tthai`;
const activeSql = (alias = '') => `COALESCE(${column(alias)}, '') NOT IN (${EXCLUDED_SQL})`;
const inactiveSql = (alias = '') => `COALESCE(${column(alias)}, '') IN (${EXCLUDED_SQL})`;

function filtersOf({ q = '', direction = '', from = '', to = '', state = '' } = {}) {
  const where = [];
  const params = [];
  if (direction) { where.push('direction = ?'); params.push(direction); }
  if (from) { where.push('ngay_lap >= ?'); params.push(from); }
  if (to) { where.push('ngay_lap <= ?'); params.push(to); }
  // Lọc theo trạng thái hoá đơn: '' = tất cả · 'active' = còn hiệu lực · 'inactive' = không còn
  // hiệu lực · '1'..'6' = đúng một trạng thái.
  if (state === 'active') where.push(activeSql());
  else if (state === 'inactive') where.push(inactiveSql());
  else if (/^[1-6]$/.test(String(state))) { where.push('tthai = ?'); params.push(String(state)); }
  const text = String(q || '').trim();
  if (text) {
    where.push('(so_hd LIKE ? OR khh_hd LIKE ? OR khms_hd LIKE ? OR mst_ban LIKE ? OR mst_mua LIKE ? OR ten_ban LIKE ? OR ten_mua LIKE ? OR invoice_key LIKE ?)');
    const like = `%${text}%`;
    params.push(like, like, like, like, like, like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function summary(db) {
  // Số lượng: đếm TẤT CẢ để người dùng vẫn thấy đủ, kèm `active`/`inactive` để giải thích vì sao
  // tổng tiền nhỏ hơn con số hoá đơn. Tiền: CHỈ cộng hoá đơn còn hiệu lực (4/5/6 không cộng).
  const totals = db.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN direction = 'BUY' THEN 1 ELSE 0 END), 0) AS buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END), 0) AS sell,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount_sell,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax_sell,
      COALESCE(SUM(CASE WHEN ${inactiveSql()} THEN tong_tien ELSE 0 END), 0) AS amount_inactive,
      COALESCE(SUM(CASE WHEN ${inactiveSql()} THEN tien_thue ELSE 0 END), 0) AS tax_inactive,
      MIN(ngay_lap) AS from_date, MAX(ngay_lap) AS to_date
    FROM invoices`).get();
  const items = db.prepare(`SELECT COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN i.tien_thue IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_tax
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE ${activeSql('v')}`).get();
  const files = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicates
    FROM imported_files`).get();
  const last = db.prepare('SELECT import_time FROM imported_files ORDER BY id DESC LIMIT 1').get();
  return {
    invoices: totals.invoices,
    active: totals.active,
    inactive: totals.invoices - totals.active,
    buy: totals.buy,
    sell: totals.sell,
    amount: totals.amount,
    tax: totals.tax,
    amountBuy: totals.amount_buy,
    amountSell: totals.amount_sell,
    taxBuy: totals.tax_buy,
    taxSell: totals.tax_sell,
    amountInactive: totals.amount_inactive,
    taxInactive: totals.tax_inactive,
    items: items.c,
    // Độ phủ tiền thuế từng dòng: XML của một số nhà cung cấp KHÔNG có thẻ TThue (không tự tính bù).
    itemsWithTax: items.with_tax,
    from: totals.from_date,
    to: totals.to_date,
    filesImported: files.imported,
    filesError: files.errors,
    filesDuplicate: files.duplicates,
    lastImport: last ? last.import_time : null,
  };
}

// Làm sạch chuỗi người dùng gõ thành biểu thức MATCH an toàn cho FTS5: chỉ giữ chữ và số
// (mọi ký tự đặc biệt của FTS5 bị thay bằng khoảng trắng), mỗi token dùng dạng tiền tố "từ"*.
function ftsMatchOf(text) {
  const cleaned = String(text || '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0);
  if (!tokens.length) return '';
  return tokens.map(t => `"${t}"*`).join(' ');
}

// Dựng mệnh đề WHERE cho danh sách hoá đơn (dùng CHUNG cho phân trang và xuất Excel):
// bộ lọc cơ bản (chiều + khoảng ngày) + tìm kiếm chữ (FTS5 trước, LIKE dự phòng).
function invoiceWhere(db, options = {}) {
  const text = String(options.q || '').trim();
  // Bộ lọc cơ bản (chiều + khoảng ngày), KHÔNG gồm phần tìm kiếm chữ.
  const base = filtersOf({ ...options, q: '' });
  if (!text) return { clause: base.clause, params: base.params };

  // FTS5 trước (nhanh, có index, bỏ dấu tiếng Việt). Nếu FTS không khớp thì rơi xuống LIKE
  // để giữ nguyên hành vi cũ (bắt substring ở giữa, ví dụ "6423" trong "00006423").
  const match = ftsMatchOf(text);
  if (match) {
    const ftsClause = `${base.clause ? `${base.clause} AND` : 'WHERE'} id IN (SELECT rowid FROM invoice_fts WHERE invoice_fts MATCH ?)`;
    try {
      const ftsParams = [...base.params, match];
      if (db.prepare(`SELECT COUNT(*) AS c FROM invoices ${ftsClause}`).get(...ftsParams).c > 0) {
        return { clause: ftsClause, params: ftsParams };
      }
    } catch { /* DB chưa có bảng FTS (chưa qua applySchema) → dùng LIKE */ }
  }
  const like = `%${text}%`;
  const likeWhere = '(so_hd LIKE ? OR khh_hd LIKE ? OR khms_hd LIKE ? OR mst_ban LIKE ? OR mst_mua LIKE ? OR ten_ban LIKE ? OR ten_mua LIKE ? OR invoice_key LIKE ?)';
  return { clause: `${base.clause ? `${base.clause} AND ` : 'WHERE '}${likeWhere}`, params: [...base.params, like, like, like, like, like, like, like, like] };
}

function listInvoices(db, options = {}) {
  const size = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const { clause, params } = invoiceWhere(db, options);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM invoices ${clause}`).get(...params).c;
  const rows = db.prepare(`SELECT id, invoice_key, direction, ngay_lap, khms_hd, khh_hd, so_hd,
      mst_ban, ten_ban, mst_mua, ten_mua, tong_tien, tien_truoc_thue, tien_thue, tthai, file_xml
    FROM invoices ${clause}
    ORDER BY ngay_lap DESC, id DESC
    LIMIT ? OFFSET ?`).all(...params, size, offset);
  return { total, limit: size, offset, rows };
}

function getInvoice(db, invoiceKey) {
  const key = String(invoiceKey || '').trim();
  if (!key) throw new Error('Thiếu khoá hoá đơn.');
  const invoice = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get(key);
  if (!invoice) return null;
  const items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY stt, id').all(invoice.id);
  return { invoice, items };
}

// §37: tổng hợp hàng hoá bằng SQL; §38: chỉ gộp theo (mã hàng + tên hàng + ĐVT + thuế suất).
// Lưu ý: `q` ở đây lọc theo MÃ/TÊN HÀNG (HAVING), không lọc theo cột của hoá đơn.
function products(db, options = {}) {
  const size = Math.max(1, Math.min(500, Number(options.limit) || 100));
  const text = String(options.q || '').trim();
  const where = [];
  const params = [];
  if (options.direction) { where.push('v.direction = ?'); params.push(options.direction); }
  if (options.from) { where.push('v.ngay_lap >= ?'); params.push(options.from); }
  if (options.to) { where.push('v.ngay_lap <= ?'); params.push(options.to); }
  const having = text ? 'HAVING (i.ma_hang LIKE ? OR i.ten_hang LIKE ?)' : '';
  if (text) params.push(`%${text}%`, `%${text}%`);
  // Hoá đơn không còn hiệu lực KHÔNG cộng vào danh sách hàng hoá (vẫn nằm trong kho để xem/lọc).
  where.push(activeSql('v'));
  const rows = db.prepare(`SELECT i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat,
      SUM(i.so_luong) AS tong_so_luong, SUM(i.thanh_tien) AS tong_tien, SUM(i.tien_thue) AS tong_thue, COUNT(*) AS so_dong
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat
    ${having}
    ORDER BY tong_tien DESC
    LIMIT ?`).all(...params, size);
  return { rows, limit: size };
}

// §39: khách hàng (bán ra) và nhà cung cấp (mua vào) lấy trực tiếp từ invoices.
// kind = 'buyer' | 'supplier' | 'all' (all = cả hai, có cột `loai` để phân biệt).
// from/to (tuỳ chọn) = khoảng ngày đang xem, để tab Đối tác và file Excel khớp đúng bộ lọc.
function partners(db, { kind = 'buyer', limit = 100, from = '', to = '' } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  const range = [];
  const params = [];
  if (from) { range.push('ngay_lap >= ?'); params.push(from); }
  if (to) { range.push('ngay_lap <= ?'); params.push(to); }
  const more = range.length ? ` AND ${range.join(' AND ')}` : '';
  const supplier = `SELECT mst_ban AS mst, ten_ban AS ten, COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE direction = 'BUY' AND ${activeSql()}${more} GROUP BY mst_ban, ten_ban`;
  const buyer = `SELECT mst_mua AS mst, ten_mua AS ten, COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE direction = 'SELL' AND ${activeSql()}${more} GROUP BY mst_mua, ten_mua`;
  if (kind === 'supplier') return db.prepare(`${supplier} ORDER BY tong_tien DESC LIMIT ?`).all(...params, size);
  if (kind === 'buyer') return db.prepare(`${buyer} ORDER BY tong_tien DESC LIMIT ?`).all(...params, size);
  return db.prepare(`SELECT *, 'NCC' AS loai FROM (${supplier}) UNION ALL SELECT *, 'KH' AS loai FROM (${buyer}) ORDER BY tong_tien DESC LIMIT ?`).all(...params, ...params, size);
}

module.exports = { summary, listInvoices, getInvoice, products, partners, filtersOf, ftsMatchOf, invoiceWhere, activeSql, inactiveSql, EXCLUDED_SQL };
