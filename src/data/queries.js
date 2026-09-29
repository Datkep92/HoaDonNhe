'use strict';
// ---------------------------------------------------------------------------
// Truy vấn cho UI — PROJECT_ARCHITECTURE §15, §32, §33, §34, §37, §39.
//
// Mọi thứ đi qua SQLite: KHÔNG quét XML, KHÔNG nạp toàn bộ hoá đơn vào RAM/DOM.
// Danh sách luôn phân trang; tổng hợp hàng hoá làm bằng SQL (GROUP BY).
// ---------------------------------------------------------------------------

const { EXCLUDED } = require('./invoice-state');
const { rulesFor, findRule, years: taxYears } = require('./tax-rules');
// Đối chiếu phải được tính XONG TRƯỚC khi đọc trạng thái ở đây (nếu dữ liệu đổi thì tự chạy
// lại) — nếu không "phải thu" sẽ ra số 0 giả khi người dùng chưa từng bấm đối chiếu.
const { reconcile } = require('./reconciliation');
// Khoảng ngày của kỳ đang chọn (bộ chọn kỳ trên header) — dùng chung cho mọi câu lọc theo kỳ.
const { dateRange } = require('./sqlite');

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

// MỤC 19 — MỘT công thức cho MỌI khoảng ngày: doanh thu + số hoá đơn của chiều bán/mua, chỉ tính
// hoá đơn còn hiệu lực (cùng activeSql với dòng "Doanh thu bán ra" ở summary) ⇒ hai dòng KPI mới
// KHÔNG THỂ lệch số với dòng cũ. Nhận range rỗng cũng chạy được (toàn bộ dữ liệu).
function amountsOf(db, range) {
  const picked = dateRange(range);
  return db.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS sell_invoices,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy
    FROM invoices ${picked.where}`).get(...picked.params);
}

const DAY_MS = 86400000;
// Ngày "YYYY-MM-DD" → mốc ms (UTC) để trừ/ngày không lệch vì giờ hè; chuỗi sai dạng → null.
const dayMsOf = text => {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  return parts ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : null;
};
const isoOfMs = ms => new Date(ms).toISOString().slice(0, 10);
const dayNumberOf = ms => new Date(ms).getUTCDate();
// Kỳ TRƯỚC cho kỳ đang chọn, theo RANH LỊC (mục 19 — "So với kỳ trước"):
//   • trọn tháng (01 → ngày cuối tháng)     → đúng tháng liền trước
//   • trọn quý  (đầu quý → cuối quý)        → đúng quý liền trước
//   • trọn năm  (01/01 → 31/12)              → đúng năm liền trước
//   • còn lại (kỳ tuỳ ý)                     → dải CÙNG ĐỘ DÀI ngay trước đó
// Trả về { from, to } dạng ISO, hoặc null khi kỳ không hợp lệ.
function previousRangeOf(fromMs, toMs) {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const sameYear = to.getUTCFullYear() === year;
  // TRỌN NĂM: 01/01 → 31/12 cùng năm ⇒ năm trước.
  if (month === 0 && dayNumberOf(fromMs) === 1 && sameYear && to.getUTCMonth() === 11 && dayNumberOf(toMs) === 31) {
    return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
  // TRỌN QUÝ: đầu quý (tháng 0/3/6/9, ngày 1) → ngày cuối của tháng thứ 3 của quý.
  const quarterStart = month % 3 === 0;
  const endQuarterMonth = (month + 2) % 12;
  if (quarterStart && dayNumberOf(fromMs) === 1 && sameYear && to.getUTCMonth() === endQuarterMonth
      && dayNumberOf(toMs) === new Date(Date.UTC(year, month + 3, 0)).getUTCDate()) {
    const start = new Date(Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 9 : month - 3, 1));
    const end = new Date(Date.UTC(month === 0 ? year - 1 : year, month === 0 ? 12 : month, 0));
    return { from: isoOfMs(start.getTime()), to: isoOfMs(end.getTime()) };
  }
  // TRỌN THÁNG: 01 → ngày cuối cùng tháng ⇒ tháng liền trước.
  if (dayNumberOf(fromMs) === 1 && sameYear && to.getUTCMonth() === month && dayNumberOf(toMs) === lastDayOfMonth) {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return { from: isoOfMs(start.getTime()), to: isoOfMs(end.getTime()) };
  }
  // KỲ TUỲ Ý: dải cùng độ dài ngay trước kỳ này.
  const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
  const prevTo = fromMs - DAY_MS;
  return { from: isoOfMs(prevTo - (days - 1) * DAY_MS), to: isoOfMs(prevTo) };
}

function summary(db, range) {
  // KỲ ĐANG CHỌN (bộ chọn kỳ trên header): không truyền range thì chạy y hệt như cũ.
  const picked = dateRange(range);
  // Số lượng: đếm TẤT CẢ để người dùng vẫn thấy đủ, kèm `active`/`inactive` để giải thích vì sao
  // tổng tiền nhỏ hơn con số hoá đơn. Tiền: CHỈ cộng hoá đơn còn hiệu lực (4/5/6 không cộng).
  // Các cột *_amount ở dưới là TIỀN theo từng hình thức thanh toán, tách riêng chiều bán/mua —
  // đúng ví dụ của mục 20 ("Bán ra: Tiền mặt 320 triệu · Chuyển khoản 680 triệu ...").
  const totals = db.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN direction = 'BUY' THEN 1 ELSE 0 END), 0) AS buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' THEN 1 ELSE 0 END), 0) AS sell,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount,
      COALESCE(SUM(CASE WHEN ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS amount_sell,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS sell_active,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS buy_active,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax_buy,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tien_thue ELSE 0 END), 0) AS tax_sell,
      COALESCE(SUM(CASE WHEN payment_method = 'CASH' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS cash_invoices,
      COALESCE(SUM(CASE WHEN payment_method = 'TRANSFER' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS transfer_invoices,
      COALESCE(SUM(CASE WHEN payment_method = 'CASH_TRANSFER' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS ambiguous_invoices,
      COALESCE(SUM(CASE WHEN payment_method = 'UNKNOWN' AND ${activeSql()} THEN 1 ELSE 0 END), 0) AS unknown_invoices,
      COALESCE(SUM(CASE WHEN payment_method = 'CASH' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS cash_amount,
      COALESCE(SUM(CASE WHEN payment_method = 'TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS transfer_amount,
      COALESCE(SUM(CASE WHEN payment_method = 'CASH_TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS ambiguous_amount,
      COALESCE(SUM(CASE WHEN payment_method = 'UNKNOWN' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS unknown_amount,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'CASH' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell_cash_amount,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell_transfer_amount,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'CASH_TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell_ambiguous_amount,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'UNKNOWN' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell_unknown_amount,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'CASH' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy_cash_amount,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy_transfer_amount,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'CASH_TRANSFER' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy_ambiguous_amount,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'UNKNOWN' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy_unknown_amount,
      COALESCE(SUM(CASE WHEN ${inactiveSql()} THEN tong_tien ELSE 0 END), 0) AS amount_inactive,
      COALESCE(SUM(CASE WHEN ${inactiveSql()} THEN tien_thue ELSE 0 END), 0) AS tax_inactive,
      MIN(ngay_lap) AS from_date, MAX(ngay_lap) AS to_date
    FROM invoices ${picked.where}`).get(...picked.params);
  const items = db.prepare(`SELECT COUNT(*) AS c,
      COALESCE(SUM(CASE WHEN i.tien_thue IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_tax
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE ${activeSql('v')} ${picked.and}`).get(...picked.params);
  // MỤC 4 — TÁCH RÕ HAI CHIỀU: bán ra = tiền VÀO của khách hàng, mua vào = tiền RA cho nhà cung cấp.
  // Nhóm bằng SQL rồi dựng object ở JS — số liệu lấy từ dữ liệu, không suy đoán.
  const KIND_OF = { CASH: 'cash', TRANSFER: 'transfer', CASH_TRANSFER: 'ambiguous', UNKNOWN: 'unknown' };
  const blankSide = () => ({
    cash: { invoices: 0, amount: 0 }, transfer: { invoices: 0, amount: 0 },
    ambiguous: { invoices: 0, amount: 0 }, unknown: { invoices: 0, amount: 0 },
  });
  const sides = { sell: blankSide(), buy: blankSide() };
  const methodRows = db.prepare(`SELECT direction, payment_method, COUNT(*) AS invoices,
      COALESCE(SUM(tong_tien), 0) AS amount
    FROM invoices WHERE ${activeSql()} ${picked.and}
    GROUP BY direction, payment_method`).all(...picked.params);
  for (const row of methodRows) {
    const side = row.direction === 'SELL' ? sides.sell : row.direction === 'BUY' ? sides.buy : null;
    if (side) side[KIND_OF[row.payment_method] || 'unknown'] = {
      invoices: Number(row.invoices || 0), amount: Number(row.amount || 0),
    };
  }
  const files = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status = 'imported' THEN 1 ELSE 0 END), 0) AS imported,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicates
    FROM imported_files`).get();
  const last = db.prepare('SELECT import_time FROM imported_files ORDER BY id DESC LIMIT 1').get();
  // TÊN DOANH NGHIỆP (mục 18): lấy từ CHÍNH dữ liệu hoá đơn — hoá đơn bán thì mình là người bán,
  // hoá đơn mua thì mình là người mua; chọn tên xuất hiện NHIỀU NHẤT. Không có dữ liệu ⇒ để trống
  // để UI hiện "chưa rõ tên", KHÔNG bịa tên doanh nghiệp.
  const companyRow = db.prepare(`SELECT name, SUM(c) AS total FROM (
      SELECT NULLIF(TRIM(ten_ban), '') AS name, COUNT(*) AS c FROM invoices WHERE direction = 'SELL' GROUP BY name
      UNION ALL
      SELECT NULLIF(TRIM(ten_mua), '') AS name, COUNT(*) AS c FROM invoices WHERE direction = 'BUY' GROUP BY name
    ) WHERE name IS NOT NULL GROUP BY name ORDER BY total DESC, name LIMIT 1`).get();
  // ---- MỤC 19 — 2 DÒNG KPI THÊM: LŨY KẾ NĂM và SO VỚI KỲ TRƯỚC -----------------------------
  // LŨY KẾ NĂM: từ 01/01 của NĂM KỲ đến ngày CUỐI KỲ (chưa chọn kỳ ⇒ đến hôm nay). Năm lấy theo
  // kỳ đang chọn để số đi theo đúng kỳ người dùng đang xem; không có kỳ thì lấy năm hiện tại.
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const toIso = /^\d{4}-\d{2}-\d{2}$/.test(String(range && range.to)) ? String(range.to) : '';
  const fromIso = /^\d{4}-\d{2}-\d{2}$/.test(String(range && range.from)) ? String(range.from) : '';
  const year = (toIso || fromIso || todayIso).slice(0, 4);
  const ytdFrom = `${year}-01-01`;
  const ytdTo = toIso || todayIso;
  const ytd = amountsOf(db, { from: ytdFrom, to: ytdTo });
  // SO VỚI KỲ TRƯỚC: kỳ liền trước theo RANH LỊC (tháng/quý/năm) hoặc cùng độ dài với kỳ tuỳ
  // ý — xem previousRangeOf(). Chưa chọn kỳ (hoặc từ > to) ⇒ null: UI ghi rõ "chưa chọn kỳ" thay
  // vì bịa một con số so sánh (mục 35).
  const fromMs = dayMsOf(fromIso);
  const toMs = dayMsOf(toIso);
  let previousPeriod = null;
  if (fromMs !== null && toMs !== null && fromMs <= toMs) {
    const range = previousRangeOf(fromMs, toMs);
    const previous = amountsOf(db, range);
    previousPeriod = {
      from: range.from,
      to: range.to,
      invoices: previous.invoices,
      amountSell: previous.sell,
      amountBuy: previous.buy,
      // % đổi của DOANH THU BÁN RA so với kỳ liền trước. Kỳ trước = 0 đồng ⇒ không chia được
      // (0 ở đây nghĩa là "không có hoá đơn", mục 35) → null để UI hiện "Chưa có dữ liệu".
      changePercent: previous.sell > 0 ? (totals.amount_sell - previous.sell) / previous.sell * 100 : null,
    };
  }
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
    // Số hoá đơn còn hiệu lực của từng chiều — KPI "Số hoá đơn bán/mua" (mục 19).
    sellActive: totals.sell_active,
    buyActive: totals.buy_active,
    // Tên doanh nghiệp đọc từ dữ liệu (mục 18); chuỗi rỗng = chưa có dữ liệu để biết.
    company: companyRow && companyRow.name ? String(companyRow.name) : '',
    cashInvoices: totals.cash_invoices,
    transferInvoices: totals.transfer_invoices,
    ambiguousInvoices: totals.ambiguous_invoices,
    unknownInvoices: totals.unknown_invoices,
    cashAmount: totals.cash_amount,
    transferAmount: totals.transfer_amount,
    ambiguousAmount: totals.ambiguous_amount,
    unknownAmount: totals.unknown_amount,
    // Mục 20 — tiền theo hình thức thanh toán, tách chiều bán/mua. Không cộng dồn hai chiều
    // thành một con số chung để tránh hiểu nhầm.
    paymentAmounts: {
      sell: {
        cash: totals.sell_cash_amount, transfer: totals.sell_transfer_amount,
        ambiguous: totals.sell_ambiguous_amount, unknown: totals.sell_unknown_amount,
      },
      buy: {
        cash: totals.buy_cash_amount, transfer: totals.buy_transfer_amount,
        ambiguous: totals.buy_ambiguous_amount, unknown: totals.buy_unknown_amount,
      },
    },
    // MỤC 4 — hai thẻ "Bán ra — Khách hàng" / "Mua vào — Nhà cung cấp": số HĐ + tiền theo từng
    // hình thức thanh toán của TỪNG chiều (không gộp hai chiều thành một con số chung).
    paymentSides: sides,
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
    // MỤC 19 — LŨY KẾ NĂM: doanh thu bán/mua TÍCH LUỸ từ 01/01 đến ngày cuối kỳ (chỉ hoá đơn
    // còn hiệu lực, cùng công thức với dòng "Doanh thu bán ra" trên KPI).
    yearToDate: {
      year, from: ytdFrom, to: ytdTo,
      invoices: ytd.invoices, sellInvoices: ytd.sell_invoices,
      amountSell: ytd.sell, amountBuy: ytd.buy,
    },
    // MỤC 19 — SO VỚI KỲ TRƯỚC: null khi chưa chọn kỳ ⇒ UI hiện "chưa chọn kỳ" (mục 35).
    previousPeriod,
  };
}

// ---------------------------------------------------------------------------
// HÀNG HÓA — MỘT nguồn duy nhất dùng chung cho thẻ Hàng hóa (mục 24) và danh sách CHI TIẾT
// mở ra khi bấm cảnh báo / bấm mặt hàng (mục 27 + mục 6) ⇒ con số trên thẻ và danh sách bấm
// vào KHÔNG THỂ lệch nhau.

// Một lần GROUP BY theo TÊN hàng (bỏ dòng không có tên): số lượng + tiền theo từng chiều.
function goodsRowsOf(db, range) {
  const picked = dateRange(range, { alias: 'v' });
  return db.prepare(`SELECT i.ten_hang AS name,
      COALESCE(SUM(CASE WHEN v.direction = 'SELL' THEN i.so_luong ELSE 0 END), 0) AS sell_qty,
      COALESCE(SUM(CASE WHEN v.direction = 'BUY' THEN i.so_luong ELSE 0 END), 0) AS buy_qty,
      COALESCE(SUM(CASE WHEN v.direction = 'SELL' THEN i.thanh_tien ELSE 0 END), 0) AS sell_amount,
      COALESCE(SUM(CASE WHEN v.direction = 'BUY' THEN i.thanh_tien ELSE 0 END), 0) AS buy_amount,
      COUNT(DISTINCT CASE WHEN COALESCE(NULLIF(TRIM(i.ma_hang), ''), '') <> '' THEN TRIM(i.ma_hang) END) AS codes
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE ${activeSql('v')} AND COALESCE(NULLIF(TRIM(i.ten_hang), ''), '') <> '' ${picked.and}
    GROUP BY i.ten_hang`).all(...picked.params);
}

// Gắn cờ cho TỪNG tên hàng và đếm 4 cảnh báo chất lượng dữ liệu (mục 24).
// KHÔNG suy đoán tồn kho: chưa có tồn đầu kỳ/điều chỉnh nên chỉ báo "bán > mua" để người dùng
// tự kiểm tra, không tuyên bố còn/hết hàng.
function goodsAnalysis(goodsRows) {
  // Khóa so khớp tên: bỏ dấu tiếng Việt, khoảng trắng thừa, hoa/thường — chỉ dùng để GHÉP các tên
  // viết khác nhau mà THẬT SỰ là một mặt hàng; tên gốc vẫn giữ nguyên khi hiển thị.
  const foldName = text => String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
  const byKey = new Map();
  const badNames = new Set();
  let qtySell = 0, qtyBuy = 0, amountSell = 0, amountBuy = 0;
  let sellOverBuy = 0, missingBuy = 0, codeMismatch = 0;
  for (const row of goodsRows) {
    const name = String(row.name || '');
    const sellQty = Number(row.sell_qty || 0), buyQty = Number(row.buy_qty || 0);
    qtySell += sellQty; qtyBuy += buyQty;
    amountSell += Number(row.sell_amount || 0); amountBuy += Number(row.buy_amount || 0);
    if (sellQty > buyQty) sellOverBuy += 1;                       // "Bán > mua"
    if (sellQty > 0 && buyQty === 0) missingBuy += 1;             // "Thiếu dữ liệu mua"
    if (Number(row.codes || 0) > 1) codeMismatch += 1;            // "Mã hàng chưa khớp"
    if (name !== name.trim() || /\s{2,}/.test(name.trim())) badNames.add(name);
    const key = foldName(name);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(name);
  }
  // "Tên hàng chưa chuẩn hóa": tên có khoảng trắng thừa HOẶC nhiều tên khác nhau cùng một ý.
  for (const names of byKey.values()) {
    if (names.size < 2) continue;
    for (const name of names) badNames.add(name);
  }
  const goods = {
    // Tổng số mặt hàng = số TÊN hàng khác nhau còn hiệu lực.
    total: goodsRows.length,
    qtySell, qtyBuy, amountSell, amountBuy,
    sellOverBuy, missingBuy, codeMismatch,
    notNormalized: badNames.size,
  };
  const flags = goodsRows.map(row => ({
    row,
    sellOverBuy: Number(row.sell_qty || 0) > Number(row.buy_qty || 0),
    missingBuy: Number(row.sell_qty || 0) > 0 && Number(row.buy_qty || 0) === 0,
    codeMismatch: Number(row.codes || 0) > 1,
    notNormalized: badNames.has(String(row.name || '')),
  }));
  return { goods, badNames, flags };
}

// DANH SÁCH CHI TIẾT của một cảnh báo hàng hóa (mục 27) — lọc theo ĐÚNG công thức đã đếm trên thẻ.
const GOODS_FLAG = Object.freeze({
  sell_over_buy: 'sellOverBuy', missing_buy: 'missingBuy',
  code_mismatch: 'codeMismatch', not_normalized: 'notNormalized',
});
function goodsDetail(db, { kind = '', range } = {}) {
  const flag = GOODS_FLAG[String(kind || '')];
  const { flags } = goodsAnalysis(goodsRowsOf(db, range));
  const rows = (flag ? flags.filter(item => item[flag] === true) : [])
    .map(({ row }) => ({
      name: String(row.name || ''),
      sellQty: Number(row.sell_qty || 0), buyQty: Number(row.buy_qty || 0),
      sellAmount: Number(row.sell_amount || 0), buyAmount: Number(row.buy_amount || 0),
      codes: Number(row.codes || 0),
    }));
  return { kind: String(kind || ''), count: rows.length, rows };
}

// HÓA ĐƠN CHỨA một mặt hàng (bấm top hàng hóa trên thẻ Hàng hóa → danh sách để mở xem A4).
function productInvoices(db, { name = '', direction = '', range } = {}) {
  const picked = dateRange(range);
  const side = direction === 'BUY' ? 'BUY' : 'SELL';
  const rows = db.prepare(`SELECT DISTINCT v.id, v.invoice_key, v.direction, v.ngay_lap, v.khh_hd, v.so_hd,
      v.tong_tien, v.payment_method, v.reconciliation_status, COALESCE(v.review_status, '') AS review_status
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE i.ten_hang = ? AND v.direction = ? AND ${activeSql('v')} ${picked.and}
    ORDER BY v.ngay_lap DESC, v.id DESC LIMIT 200`).all(String(name || ''), side, ...picked.params);
  return {
    name: String(name || ''), direction: side,
    count: rows.length,
    amount: rows.reduce((sum, row) => sum + Number(row.tong_tien || 0), 0),
    rows,
  };
}

function overview(db, range) {
  // KỲ ĐANG CHỌN: biểu đồ 12 tháng, top hàng hoá và cảnh báo chất lượng đều theo kỳ; còn khi
  // không chọn kỳ thì giữ nguyên toàn bộ dữ liệu như trước.
  const picked = dateRange(range);
  const pickedV = dateRange(range, { alias: 'v' });
  // Năm vẽ biểu đồ: theo kỳ đang chọn (vd "Năm nay" ⇒ năm nay), không chọn thì lấy năm mới nhất.
  const wanted = /^\d{4}/.test(String((range && range.from) || '')) ? String(range.from).slice(0, 4) : '';
  const latest = db.prepare("SELECT MAX(substr(ngay_lap, 1, 4)) AS year FROM invoices WHERE ngay_lap GLOB '[0-9][0-9][0-9][0-9]-*'").get();
  const year = wanted || (latest && latest.year ? String(latest.year) : String(new Date().getFullYear()));
  const values = db.prepare(`SELECT CAST(substr(ngay_lap, 6, 2) AS INTEGER) AS month,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS sell,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND ${activeSql()} THEN tong_tien ELSE 0 END), 0) AS buy
    FROM invoices WHERE substr(ngay_lap, 1, 4) = ? ${picked.and} GROUP BY substr(ngay_lap, 6, 2)`).all(year, ...picked.params);
  const byMonth = new Map(values.map(row => [Number(row.month), row]));
  const months = Array.from({ length: 12 }, (_, index) => {
    const row = byMonth.get(index + 1) || {};
    return { month: index + 1, sell: Number(row.sell || 0), buy: Number(row.buy || 0) };
  });
  const topProducts = db.prepare(`SELECT i.ten_hang AS name, SUM(i.thanh_tien) AS amount, SUM(i.so_luong) AS quantity
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE v.direction = 'SELL' AND ${activeSql('v')} AND COALESCE(i.ten_hang, '') <> '' ${pickedV.and}
    GROUP BY i.ten_hang ORDER BY amount DESC LIMIT 5`).all(...pickedV.params);
  const topProductsBuy = db.prepare(`SELECT i.ten_hang AS name, SUM(i.thanh_tien) AS amount, SUM(i.so_luong) AS quantity
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE v.direction = 'BUY' AND ${activeSql('v')} AND COALESCE(i.ten_hang, '') <> '' ${pickedV.and}
    GROUP BY i.ten_hang ORDER BY amount DESC LIMIT 5`).all(...pickedV.params);
  // MỤC 24 – HÀNG HÓA: tổng hợp mua/bán + 4 cảnh báo chất lượng dữ liệu.
  // Một lần GROUP BY theo tên hàng rồi tự tính ở JS để thấy rõ từng con số là từ đâu ra.
  // HÀM goodsRowsOf/goodsAnalysis DÙNG CHUNG với danh sách chi tiết (mục 27) ⇒ con số trên thẻ
  // và danh sách bấm vào không thể lệch nhau.
  // KHÔNG suy đoán tồn kho: chưa có tồn đầu kỳ/điều chỉnh nên chỉ báo "bán > mua" để người dùng
  // tự kiểm tra, không tuyên bố còn/hết hàng.
  const goodsRows = goodsRowsOf(db, range);
  const { goods } = goodsAnalysis(goodsRows);
  return { year, months, topProducts, topProductsBuy, goods };
}

// ---------------------------------------------------------------------------
// CÔNG NỢ — MASTER TASK mục 25 (PHẢI THU / PHẢI TRẢ + top khách hàng, nhà cung cấp).
//
// "Còn nợ" nghĩa là CHƯA CÓ BẰNG CHỨNG ĐÃ CHUYỂN TIỀN — chỉ đọc kết quả ĐÃ LƯU của
// đối chiếu, không tự suy đoán lại ở đây:
//   • ĐÃ TRẢ   = hóa đơn tiền mặt (giao tại chỗ) HOẶC hóa đơn chuyển khoản ĐÃ khớp sao kê;
//   • CÒN NỢ   = hóa đơn chuyển khoản CHƯA tìm thấy dòng tiền vào/ra tương ứng;
//   • CHƯA RÕ  = hóa đơn không rõ hình thức thanh toán → tách thành một dòng riêng:
//                KHÔNG gộp vào phải thu (mục 5: không được tự đoán)
//                KHÔNG bỏ qua luôn (mục 35: không giấu số liệu thiếu).
// ---------------------------------------------------------------------------
function debts(db, range) {
  reconcile(db);
  // KỲ ĐANG CHỌN: công nợ cũng theo kỳ để khớp với các thẻ còn lại trên cùng màn hình.
  const picked = dateRange(range);
  const totals = db.prepare(`SELECT COUNT(*) AS active,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'TRANSFER'
        AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' THEN tong_tien ELSE 0 END), 0) AS receivable,
      COALESCE(SUM(CASE WHEN direction = 'SELL' AND payment_method = 'TRANSFER'
        AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' THEN 1 ELSE 0 END), 0) AS receivable_count,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'TRANSFER'
        AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' THEN tong_tien ELSE 0 END), 0) AS payable,
      COALESCE(SUM(CASE WHEN direction = 'BUY' AND payment_method = 'TRANSFER'
        AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' THEN 1 ELSE 0 END), 0) AS payable_count,
      COALESCE(SUM(CASE WHEN payment_method IN ('UNKNOWN', 'CASH_TRANSFER') THEN tong_tien ELSE 0 END), 0) AS unclear,
      COALESCE(SUM(CASE WHEN payment_method IN ('UNKNOWN', 'CASH_TRANSFER') THEN 1 ELSE 0 END), 0) AS unclear_count
    FROM invoices WHERE ${activeSql()} ${picked.and}`).get(...picked.params);
  const party = (nameColumn, mstColumn) => `SELECT
      COALESCE(NULLIF(TRIM(${nameColumn}), ''), NULLIF(TRIM(${mstColumn}), ''), 'Chưa rõ tên') AS name,
      SUM(tong_tien) AS amount, MAX(ngay_lap) AS last_date, COUNT(*) AS invoices
    FROM invoices
    WHERE direction = ? AND ${activeSql()} AND payment_method = 'TRANSFER'
      AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' ${picked.and}
    GROUP BY COALESCE(NULLIF(TRIM(${nameColumn}), ''), NULLIF(TRIM(${mstColumn}), ''), 'Chưa rõ tên')
    ORDER BY amount DESC, name LIMIT 5`;
  return {
    // Chưa có hóa đơn nào còn hiệu lực → UI hiện "Chưa có dữ liệu" (mục 35), không hiện số 0.
    empty: Number(totals.active || 0) === 0,
    receivable: Number(totals.receivable || 0),
    receivableCount: Number(totals.receivable_count || 0),
    payable: Number(totals.payable || 0),
    payableCount: Number(totals.payable_count || 0),
    unclear: Number(totals.unclear || 0),
    unclearCount: Number(totals.unclear_count || 0),
    customers: db.prepare(party('ten_mua', 'mst_mua')).all('SELL', ...picked.params),
    suppliers: db.prepare(party('ten_ban', 'mst_ban')).all('BUY', ...picked.params),
  };
}

// CHI TIẾT CÔNG NỢ THEO ĐỐI TÁC (mục 5): bấm khách hàng / nhà cung cấp ở thẻ CÔNG NỢ → danh
// sách hoá đơn CHÍNH đối tượng đó. Dùng đúng công thức nhóm của debts() (tên → MST → "Chưa rõ
// tên") nên chi tiết KHÔNG THỂ lệch với các con số trên thẻ; cùng kỳ nếu người dùng đang chọn.
function debtsDetail(db, { direction = '', name = '', range } = {}) {
  const side = direction === 'BUY' ? { name: 'ten_ban', mst: 'mst_ban' } : { name: 'ten_mua', mst: 'mst_mua' };
  const picked = dateRange(range);
  const label = `COALESCE(NULLIF(TRIM(${side.name}), ''), NULLIF(TRIM(${side.mst}), ''), 'Chưa rõ tên')`;
  const dir = direction === 'BUY' ? 'BUY' : 'SELL';
  const rows = db.prepare(`SELECT id, invoice_key, direction, ngay_lap, khh_hd, so_hd, tong_tien,
      payment_method, reconciliation_status, COALESCE(review_status, '') AS review_status, ${label} AS partner
    FROM invoices
    WHERE direction = ? AND ${activeSql()} AND payment_method = 'TRANSFER'
      AND reconciliation_status = 'TRANSFER_BANK_NOT_FOUND' AND ${label} = ? ${picked.and}
    ORDER BY ngay_lap DESC, id DESC LIMIT 200`).all(dir, String(name || ''), ...picked.params);
  return {
    direction: dir,
    name: String(name || ''),
    count: rows.length,
    amount: rows.reduce((sum, row) => sum + Number(row.tong_tien || 0), 0),
    rows,
  };
}

// ---------------------------------------------------------------------------
// THUẾ / NGƯỠNG — MASTER TASK mục 26: DOANH THU LŨY KẾ · THUẾ DỰ KIẾN ·
// TIẾN ĐỘ THEO NGƯỠNG ÁP DỤNG, và TUYỆT ĐỐI không gọi là "THUẾ PHẢI NỘP".
//
// • Thuế dự kiến = TỔNG TIỀN THUẾ ĐANG GHI TRÊN HÓA ĐƠN BÁN RA trong năm đã chọn.
//   Không nhân doanh thu với bất kỳ tỷ lệ nào để bịa ra con số (mục 35).
//   Hóa đơn nào không có tiền thuế thì không có gì để ước ⇒ taxAvailable = false.
// • Ngưỡng lấy từ tax-rules.js theo NĂM + LOẠI HÌNH KINH DOANH (versioned, mục 26),
//   còn nếu chưa chọn loại hình thì KHÔNG vẽ vạch ngưỡng nào.
// ---------------------------------------------------------------------------
function taxOverview(db, { year, businessType } = {}) {
  reconcile(db);
  const latest = db.prepare("SELECT MAX(substr(ngay_lap, 1, 4)) AS year FROM invoices WHERE ngay_lap GLOB '[0-9][0-9][0-9][0-9]-*'").get();
  const chosen = /^\d{4}$/.test(String(year || ''))
    ? String(year)
    : (latest && latest.year ? String(latest.year) : String(new Date().getFullYear()));
  const row = db.prepare(`SELECT COUNT(*) AS invoices,
      COALESCE(SUM(tong_tien), 0) AS revenue,
      COALESCE(SUM(tien_thue), 0) AS tax,
      MAX(ngay_lap) AS to_date
    FROM invoices WHERE direction = 'SELL' AND ${activeSql()} AND substr(ngay_lap, 1, 4) = ?`).get(chosen);
  const rule = findRule({ year: chosen, businessType });
  const revenue = Number(row.revenue || 0);
  const tax = Number(row.tax || 0);
  const invoiceCount = Number(row.invoices || 0);
  return {
    year: chosen,
    invoices: invoiceCount,
    revenue,
    toDate: row.to_date || '',
    tax,
    // Chỉ dùng được khi THẬT SỰ có số liệu: 0 đồng ở đây nghĩa là "hóa đơn chưa ghi tiền thuế",
    // chứ không phải "thuế = 0" ⇒ UI phải hiện "Chưa đủ dữ liệu" (mục 35).
    taxAvailable: invoiceCount > 0 && tax > 0,
    years: taxYears(),
    rules: rulesFor(chosen),
    rule: rule || null,
    // Không chọn loại hình ⇒ không có ngưỡng để đo.
    progress: rule && rule.threshold
      ? {
          threshold: Number(rule.threshold),
          percent: Number(rule.threshold) > 0 ? revenue / Number(rule.threshold) * 100 : 0,
          remaining: Math.max(0, Number(rule.threshold) - revenue),
          over: revenue >= Number(rule.threshold),
        }
      : null,
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
      mst_ban, ten_ban, mst_mua, ten_mua, tong_tien, tien_truoc_thue, tien_thue, tthai,
      payment_method_raw, payment_method, reconciliation_status, review_status, file_xml
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

module.exports = { summary, overview, debts, debtsDetail, goodsDetail, productInvoices, taxOverview, listInvoices, getInvoice, products, partners, filtersOf, ftsMatchOf, invoiceWhere, activeSql, inactiveSql, EXCLUDED_SQL };
