'use strict';
// ---------------------------------------------------------------------------
// Truy vấn cho UI — PROJECT_ARCHITECTURE §15, §32, §33, §34, §37, §39.
//
// Mọi thứ đi qua SQLite: KHÔNG quét XML, KHÔNG nạp toàn bộ hoá đơn vào RAM/DOM.
// Danh sách luôn phân trang; tổng hợp hàng hoá làm bằng SQL (GROUP BY).
// ---------------------------------------------------------------------------

function filtersOf({ q = '', direction = '', from = '', to = '' } = {}) {
  const where = [];
  const params = [];
  if (direction) { where.push('direction = ?'); params.push(direction); }
  if (from) { where.push('ngay_lap >= ?'); params.push(from); }
  if (to) { where.push('ngay_lap <= ?'); params.push(to); }
  const text = String(q || '').trim();
  if (text) {
    where.push('(so_hd LIKE ? OR khh_hd LIKE ? OR khms_hd LIKE ? OR mst_ban LIKE ? OR mst_mua LIKE ? OR ten_ban LIKE ? OR ten_mua LIKE ? OR invoice_key LIKE ?)');
    const like = `%${text}%`;
    params.push(like, like, like, like, like, like, like, like);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function summary(db) {
  const totals = db.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(CASE WHEN direction = 'BUY' THEN 1 ELSE 0 END), 0) AS buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END), 0) AS sell,
      COALESCE(SUM(tong_tien), 0) AS amount,
      COALESCE(SUM(tien_thue), 0) AS tax,
      COALESCE(SUM(CASE WHEN direction = 'BUY' THEN tong_tien ELSE 0 END), 0) AS amount_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' THEN tong_tien ELSE 0 END), 0) AS amount_sell,
      COALESCE(SUM(CASE WHEN direction = 'BUY' THEN tien_thue ELSE 0 END), 0) AS tax_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' THEN tien_thue ELSE 0 END), 0) AS tax_sell,
      MIN(ngay_lap) AS from_date, MAX(ngay_lap) AS to_date
    FROM invoices`).get();
  const items = db.prepare(`SELECT COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN tien_thue IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_tax
    FROM invoice_items`).get();
  const files = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicates
    FROM imported_files`).get();
  const last = db.prepare('SELECT import_time FROM imported_files ORDER BY id DESC LIMIT 1').get();
  return {
    invoices: totals.invoices,
    buy: totals.buy,
    sell: totals.sell,
    amount: totals.amount,
    tax: totals.tax,
    amountBuy: totals.amount_buy,
    amountSell: totals.amount_sell,
    taxBuy: totals.tax_buy,
    taxSell: totals.tax_sell,
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

function listInvoices(db, options = {}) {
  const size = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const { clause, params } = filtersOf(options);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM invoices ${clause}`).get(...params).c;
  const rows = db.prepare(`SELECT id, invoice_key, direction, ngay_lap, khms_hd, khh_hd, so_hd,
      mst_ban, ten_ban, mst_mua, ten_mua, tong_tien, tien_truoc_thue, tien_thue, file_xml
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
const partnerSql = {
  supplier: `SELECT mst_ban AS mst, ten_ban AS ten, COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE direction = 'BUY' GROUP BY mst_ban, ten_ban`,
  buyer: `SELECT mst_mua AS mst, ten_mua AS ten, COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE direction = 'SELL' GROUP BY mst_mua, ten_mua`,
};

function partners(db, { kind = 'buyer', limit = 100 } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  if (kind === 'supplier') return db.prepare(`${partnerSql.supplier} ORDER BY tong_tien DESC LIMIT ?`).all(size);
  if (kind === 'buyer') return db.prepare(`${partnerSql.buyer} ORDER BY tong_tien DESC LIMIT ?`).all(size);
  return db.prepare(`SELECT *, 'NCC' AS loai FROM (${partnerSql.supplier}) UNION ALL SELECT *, 'KH' AS loai FROM (${partnerSql.buyer}) ORDER BY tong_tien DESC LIMIT ?`).all(size);
}

module.exports = { summary, listInvoices, getInvoice, products, partners, filtersOf };
