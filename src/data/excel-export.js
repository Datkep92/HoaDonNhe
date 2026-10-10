'use strict';
// ---------------------------------------------------------------------------
// Xuất Excel "Kho dữ liệu" — MỘT workbook, MỘT nút dùng chung cho cả 3 tab.
// Mỗi chiều / mỗi loại đối tác nằm RIÊNG một sheet:
//   • Hóa đơn mua vào  | Hóa đơn bán ra
//   • Hàng hóa mua vào | Hàng hóa bán ra
//   • Nhà cung cấp     | Khách hàng
//
// Hóa đơn + hàng hóa theo ĐÚNG bộ lọc đang xem (q + khoảng ngày).
// RIÊNG 2 sheet đối tác (Nhà cung cấp / Khách hàng) là DANH BẠ: luôn đủ danh sách, không lọc theo kỳ
// — khớp đúng tab "Đối tác" trên màn hình. Xuất được TẤT CẢ hoặc RIÊNG từng bảng (tham số `parts`).
// Nguồn dữ liệu là data.db (SQLite) — KHÔNG quét XML, KHÔNG gọi mạng.
// ---------------------------------------------------------------------------

const XLSX = require('../../resources/xlsx.cjs');
const queries = require('./queries');
const providerRegistry = require('./provider-registry');
// Làm sạch URL cổng tra cứu (bỏ phần `;cổng;` dính vào tên miền của VNPT). Cùng hàm với
// lúc nhập XML và lúc mở cổng, để một URL luôn có đúng một dạng.
const { cleanPortalUrl } = require('./original-pdf');
const vnDate = require('../vn-date');
const bankStatement = require('./bank-statement');
const invoiceState = require('./invoice-state');

const SHEET = {
  buy: 'Hóa đơn mua vào',
  sell: 'Hóa đơn bán ra',
  productsBuy: 'Hàng hóa mua vào',
  productsSell: 'Hàng hóa bán ra',
  suppliers: 'Nhà cung cấp',
  buyers: 'Khách hàng',
  bank: 'Sao kê ngân hàng',
};

const INVOICE_HEADERS = ['STT', 'Ngày lập', 'Ký hiệu', 'Số hóa đơn', 'MST người bán', 'Tên người bán', 'MST người mua', 'Tên người mua', 'Tiền trước thuế', 'Tiền thuế', 'Tổng tiền', 'Cổng tra cứu NCC', 'Trạng thái hóa đơn'];
const INVOICE_WIDTHS = [6, 12, 16, 14, 16, 38, 16, 38, 16, 14, 16, 52, 28];
// Sheet tra cứu NCC: ĐÃ BỎ theo yêu cầu người dùng — tải Excel ra rồi lại phải tự mở
// cổng để xem là vô ích. Việc đó nay nằm ngay ở cột "PDF gốc" của tab Danh sách: bấm là
// xem trong app. Cột link tra cứu trong sheet hóa đơn vẫn giữ để đưa cho kế toán.
const LOOKUP_HEADERS = null;
const LOOKUP_WIDTHS = null;
const PRODUCT_HEADERS = ['Mã hàng', 'Tên hàng', 'ĐVT', 'Thuế suất', 'Số lượng', 'Thành tiền', 'Tiền thuế'];
const PRODUCT_WIDTHS = [18, 46, 10, 10, 14, 18, 14];
const PARTNER_HEADERS = ['MST', 'Tên', 'Số hóa đơn', 'Tổng tiền', 'Tiền thuế'];
const PARTNER_WIDTHS = [16, 48, 12, 18, 14];
const BANK_HEADERS = ['STT', 'Ngày giao dịch', 'Nội dung', 'Đối ứng', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư', 'File nguồn'];
const BANK_WIDTHS = [6, 14, 44, 30, 20, 16, 16, 16, 24];

// dd/mm/yyyy — dùng CHUNG bộ quy đổi ngày (src/vn-date.js) với mọi đường đọc ngày khác.
// `ngay_lap` trong data.db đã là ngày VN nên ở đây chỉ còn định dạng, không cộng thêm giờ.
const dmy = value => vnDate.dmy(value);
// Tiền: giữ số (Excel cộng được), giá trị thiếu ⇒ để trống thay vì 0 để không sai lệch tổng.
const money = value => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));

// linkColumn: chỉ số cột (0-based) cần làm hyperlink — cột cổng tra cứu NCC. Ô chứa
// URL thật thì gắn link bấm được; ô rỗng thì để trống, không gắn gì. Điều kiện kiểm
// theo tên cột có chứa "Cổng tra cứu" (hai sheet gọi tên khác nhau) để không gắn nhầm
// vào cột chứa chữ thường.
function addSheet(book, name, headers, rows, widths, linkColumn = -1) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  sheet['!cols'] = widths.map(wch => ({ wch }));
  if (rows.length) sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }) };
  const linkable = linkColumn >= 0 && /cổng tra cứu/i.test(String(headers[linkColumn] || ''));
  if (linkable) {
    for (let r = 0; r < rows.length; r += 1) {
      const url = String((rows[r][linkColumn] || '')).trim();
      const cell = sheet[XLSX.utils.encode_cell({ r: r + 1, c: linkColumn })];
      if (!url || !/^https?:\/\//i.test(url) || !cell) continue;
      cell.l = { Target: url, Tooltip: 'Mở cổng tra cứu của nhà cung cấp' };
    }
  }
  XLSX.utils.book_append_sheet(book, sheet, name);
  return rows.length;
}

// Khoảng ngày — dùng chung cho mọi sheet.
function rangeConditions(filters, column = 'ngay_lap') {
  const where = [];
  const params = [];
  if (filters.from) { where.push(`${column} >= ?`); params.push(filters.from); }
  if (filters.to) { where.push(`${column} <= ?`); params.push(filters.to); }
  return { where, params };
}

// Bộ lọc TRẠNG THÁI của tab Danh sách, dùng CHUNG cho mọi sheet.
// MẶC ĐỊNH (không chọn gì) = chỉ hoá đơn còn hiệu lực — giống mọi con số khác của app.
// Chọn "không hiệu lực" hoặc một mã tthai cụ thể thì theo ĐÚNG lựa chọn đó.
// Vì sao phải là MỘT hàm: trước đây sheet hàng hoá cứng `activeSql` còn sheet đối tác lại
// `activeSql AND inactiveSql` (luôn rỗng) ⇒ chọn "không hiệu lực" ra file trắng, không theo bộ lọc.
// `state` chỉ nhận 'active' / 'inactive' / '1'..'6' (đã chặn bằng regex) nên nối thẳng SQL là an toàn.
function stateClause(filters, alias = '') {
  const state = String((filters && filters.state) || '');
  const prefix = alias ? `${alias}.` : '';
  if (state === 'inactive') return queries.inactiveSql(alias);
  if (/^[1-6]$/.test(state)) return `${prefix}tthai = '${state}'`;
  return queries.activeSql(alias);
}

// Danh sách hoá đơn MỘT chiều — dùng CHUNG mệnh đề WHERE với tab Danh sách (kể cả tìm kiếm FTS5).
// Cột cuối là cổng tra cứu của nhà cung cấp (Mục 2) để người dùng mở tra PDF GỐC.
// Rỗng khi XML không có và bảng tra không biết cổng — KHÔNG bịa URL.
function invoiceRows(db, direction, filters) {
  const { clause, params } = queries.invoiceWhere(db, { ...filters, direction });
  const rows = db.prepare(`SELECT ngay_lap, khms_hd, khh_hd, so_hd, mst_ban, ten_ban, mst_mua, ten_mua,
      tien_truoc_thue, tien_thue, tong_tien, lookup_url, tthai
    FROM invoices ${clause}
    ORDER BY ngay_lap ASC, id ASC`).all(...params);
  return rows.map((row, index) => [
    index + 1,
    dmy(row.ngay_lap),
    [row.khms_hd, row.khh_hd].filter(Boolean).join(' '),
    row.so_hd || '',
    row.mst_ban || '',
    row.ten_ban || '',
    row.mst_mua || '',
    row.ten_mua || '',
    money(row.tien_truoc_thue),
    money(row.tien_thue),
    money(row.tong_tien),
    // Làm sạch lúc xuất: dữ liệu nhập trước khi có `cleanPortalUrl` còn lưu URL kiểu
    // `…vnpt-invoice.com.vn;817501;`. Người dùng đưa link đó cho kế toán thì bị hỏng.
    // Ô trống nghĩa là "chưa biết cổng" — nói thẳng còn hơn đưa link không mở được.
    cleanPortalUrl(row.lookup_url) || '',
    invoiceState.displayLabel(row.tthai),
  ]);
}

// Hàng hóa MỘT chiều: gộp theo (mã + tên + ĐVT + thuế suất) — giống hệt tab Hàng hóa.
// Hoá đơn không còn hiệu lực (4/5/6) KHÔNG được cộng — dùng CHUNG mệnh đề với queries.js để số
// trên màn hình và số trong file Excel không bao giờ lệch nhau.
function productRows(db, direction, filters) {
  const range = rangeConditions(filters, 'v.ngay_lap');
  const where = ['v.direction = ?', ...range.where, stateClause(filters, 'v')];
  const params = [direction, ...range.params];
  const text = String(filters.q || '').trim();
  const having = text ? 'HAVING (i.ma_hang LIKE ? OR i.ten_hang LIKE ?)' : '';
  if (text) params.push(`%${text}%`, `%${text}%`);
  const rows = db.prepare(`SELECT i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat,
      SUM(i.so_luong) AS tong_so_luong, SUM(i.thanh_tien) AS tong_tien, SUM(i.tien_thue) AS tong_thue
    FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id
    WHERE ${where.join(' AND ')}
    GROUP BY i.ma_hang, i.ten_hang, i.don_vi, i.thue_suat
    ${having}
    ORDER BY tong_tien DESC`).all(...params);
  return rows.map(row => [
    row.ma_hang || '',
    row.ten_hang || '',
    row.don_vi || '',
    row.thue_suat || '',
    Number(row.tong_so_luong) || 0,
    money(row.tong_tien),
    money(row.tong_thue),
  ]);
}

// Đối tác MỘT loại: kind = 'supplier' (nhà cung cấp, hoá đơn mua vào) | 'buyer' (khách hàng, bán ra).
// KHÔNG lọc theo kỳ: tab "Đối tác" trên màn hình là DANH BẠ đối tác (tổng hợp mọi hoá đơn đã nhập),
// nên sheet đối tác cũng phải đủ danh sách. Nếu lọc theo kỳ, kỳ không có hoá đơn mua vào sẽ cho
// sheet Nhà cung cấp rỗng trong khi màn hình vẫn hiện — đúng lỗi người dùng đã gặp 2 lần.
const PARTNER_KIND = { supplier: { direction: 'BUY', mst: 'mst_ban', ten: 'ten_ban' }, buyer: { direction: 'SELL', mst: 'mst_mua', ten: 'ten_mua' } };
function partnerRows(db, kind, filters = {}) {
  const spec = PARTNER_KIND[kind];
  // Trước đây bỏ qua khoảng ngày với lý do "danh bạ đối tác phải đủ". Nay bộ lọc đã THỐNG
  // NHẤT cho toàn app: nếu màn hình lọc theo kỳ mà sheet xuất ra không lọc thì file ra sai
  // so với màn hình — đúng cái lệch mà comment cũ muốn tránh. Muốn xem toàn bộ thì chọn kỳ
  // "Tất cả thời gian" (from/to rỗng) — khi đó hành vi y hệt bản cũ.
  const range = rangeConditions(filters);
  const where = ['direction = ?', ...range.where, stateClause(filters)];
  const rows = db.prepare(`SELECT ${spec.mst} AS mst, ${spec.ten} AS ten,
      COUNT(*) AS so_hoa_don, SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
    FROM invoices WHERE ${where.join(' AND ')}
    GROUP BY ${spec.mst}, ${spec.ten}
    ORDER BY tong_tien DESC`).all(spec.direction, ...range.params);
  return rows.map(row => [
    row.mst || '',
    row.ten || '',
    Number(row.so_hoa_don) || 0,
    money(row.tong_tien),
    money(row.tong_thue),
  ]);
}

// Sao kê ngân hàng MỘT sheet: giao dịch đã chuẩn hoá trong data.db, theo cùng bộ lọc đang xem.
function bankRows(db, filters) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const batch = bankStatement.listTransactions(db, { ...filters, limit: 200, offset });
    rows.push(...batch.rows);
    offset += batch.rows.length;
    if (offset >= batch.total || !batch.rows.length) break;
  }
  return rows.map((row, index) => [
    index + 1,
    dmy(row.tran_date),
    row.description || '',
    row.counterparty_name || '',
    row.reference || '',
    money(row.credit),
    money(row.debit),
    money(row.balance),
    row.file_name || '',
  ]);
}

// parts: danh sách bảng muốn xuất (thiếu ⇒ xuất TẤT CẢ). Dùng cho "xuất tất cả" và "xuất riêng lẻ".
// KHÔNG có 'lookup': người dùng bỏ sheet tra cứu NCC vì phải mở Excel ra xem thì vô ích —
// việc đó nay nằm ngay trong cột "PDF gốc" của tab Danh sách. Cột link tra cứu trong
// sheet hóa đơn vẫn giữ, vì người dùng vẫn có thể đưa link đó cho kế toán.
const PARTS = ['buy', 'sell', 'productsBuy', 'productsSell', 'suppliers', 'buyers', 'bank'];

// MỌI sheet đều theo ĐÚNG bộ lọc đang xem (q + khoảng ngày + TRẠNG THÁI + CHIỀU), kể cả 2 sheet
// đối tác. Riêng danh bạ đối tác không lọc theo kỳ (xem partnerRows).
function buildWorkbook(db, filters = {}, parts) {
  // Danh sách bảng hợp lệ; rỗng hoặc toàn mã lạ ⇒ xuất TẤT CẢ (không bao giờ ra workbook trắng).
  const requested = Array.isArray(parts) ? parts.filter(part => PARTS.includes(part)) : [];
  const wanted = new Set(requested.length ? requested : PARTS);
  // CHIỀU đang chọn ở tab Danh sách: "Tất cả / Mua vào / Bán ra". Khi xuất TẤT CẢ thì tôn trọng
  // chiều đó (chọn "Bán ra" mà file vẫn có sheet mua vào là không theo bộ lọc). Người dùng chọn
  // tay một bảng từ menu "Xuất Excel" thì tôn trọng đúng lựa chọn đó, không cắt thêm.
  const direction = String(filters.direction || '').toUpperCase();
  if (!requested.length && (direction === 'BUY' || direction === 'SELL')) {
    // 'lookup' chỉ có ý nghĩa ở chiều mua vào (hoá đơn bán ra không có NCC bên ngoài).
    const drop = direction === 'BUY'
      ? ['sell', 'productsSell', 'buyers', 'lookup']
      : ['buy', 'productsBuy', 'suppliers', 'lookup'];
    for (const part of drop) wanted.delete(part);
  }
  const book = XLSX.utils.book_new();
  const counts = {};
  if (wanted.has('buy')) counts.buy = addSheet(book, SHEET.buy, INVOICE_HEADERS, invoiceRows(db, 'BUY', filters), INVOICE_WIDTHS, INVOICE_HEADERS.indexOf('Cổng tra cứu NCC'));
  if (wanted.has('sell')) counts.sell = addSheet(book, SHEET.sell, INVOICE_HEADERS, invoiceRows(db, 'SELL', filters), INVOICE_WIDTHS, INVOICE_HEADERS.indexOf('Cổng tra cứu NCC'));
  if (wanted.has('productsBuy')) counts.productsBuy = addSheet(book, SHEET.productsBuy, PRODUCT_HEADERS, productRows(db, 'BUY', filters), PRODUCT_WIDTHS);
  if (wanted.has('productsSell')) counts.productsSell = addSheet(book, SHEET.productsSell, PRODUCT_HEADERS, productRows(db, 'SELL', filters), PRODUCT_WIDTHS);
  if (wanted.has('suppliers')) counts.suppliers = addSheet(book, SHEET.suppliers, PARTNER_HEADERS, partnerRows(db, 'supplier', filters), PARTNER_WIDTHS);
  if (wanted.has('buyers')) counts.buyers = addSheet(book, SHEET.buyers, PARTNER_HEADERS, partnerRows(db, 'buyer', filters), PARTNER_WIDTHS);
  if (wanted.has('bank')) counts.bank = addSheet(book, SHEET.bank, BANK_HEADERS, bankRows(db, filters), BANK_WIDTHS);
  return { buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), counts, parts: [...wanted] };
}

// Tên file tải về: kho-du-lieu-<MST>-<YYYYMMDD-HHMM>.xlsx
// Xuất riêng 1 bảng thì chèn tên bảng vào tên file cho dễ nhận biết.
function fileName(mst, now = new Date(), parts) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    + `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const one = Array.isArray(parts) && parts.length === 1 && PARTS.includes(parts[0]) ? `${parts[0]}-` : '';
  return `kho-du-lieu-${one}${mst || 'MST'}-${stamp}.xlsx`;
}

// Tên sheet trong Excel không được chứa : \ / ? * [ ]. Nhãn kỳ có dạng "Quý 1/2026"
// nên phải thay dấu gạch chéo trước khi đưa vào tên sheet (giữ dấu gạch chéo ở tiêu đề
// trong ô bên trong sheet).
function sheetNameOf(value, fallback) {
  const cleaned = String(value == null ? '' : value).replace(/[\\/:*?[\]]/g, '-').trim();
  return (cleaned || fallback || 'Sheet').slice(0, 31);
}

// ---------------------------------------------------------------------------
// TỔNG HỢP QUÝ RA EXCEL (Mục 4.2) — file RIÊNG, không thêm vào workbook của kho.
//
// Vì sao tách riêng: đây là bảng kê để đối chiếu với tờ khai, mỗi kỳ một file, có
// đầy đủ chỉ tiêu và ghi chú giải thích. Trộn vào workbook tổng hợp sẽ làm loãng.
//
// Cột "Ghi chú" ghi rõ mỗi con số lấy từ đâu; cảnh báo ước lượng đưa vào sheet "Ghi chú"
// chứ không giấu trong ô số.
// ---------------------------------------------------------------------------
const VAT_FIGURE_HEADERS = ['Chỉ tiêu', 'Số tiền (đồng)', 'Ghi chú'];
const VAT_FIGURE_WIDTHS = [44, 20, 62];
const VAT_RATE_HEADERS = ['Mức thuế suất', 'Số hóa đơn', 'Tiền trước thuế', 'Tiền thuế'];
const VAT_RATE_WIDTHS = [22, 14, 20, 18];

function vatQuarterWorkbook(value, dir = '') {
  const f = value.figures;
  const figures = [
    ['Doanh thu bán ra (tổng tiền thanh toán)', value.sell.total, `${value.sell.count} hóa đơn — tổng tiền thanh toán trên hóa đơn`],
    ['Trong đó: tiền trước thuế', value.sell.pretax, 'invoices.tien_truoc_thue'],
    ['Trong đó: tiền thuế', value.sell.tax, 'invoices.tien_thue'],
    ['Giá trị hóa đơn mua vào (trước thuế)', value.buy.pretax, `${value.buy.count} hóa đơn`],
    ['Tiền thuế mua vào được khấu trừ', f.deductibleInput, 'invoices.tien_thue chiều mua vào'],
    ['Khấu trừ của kỳ', f.deduction, 'SỐ NHẬP TAY — không suy ra được từ hóa đơn'],
    ['Thuế phải nộp trong kỳ', f.payable, 'thuế bán ra − thuế mua vào − khấu trừ'],
    ['Thuế chuyển sang kỳ sau', f.carried, 'khi thuế vào nhiều hơn thuế ra'],
  ];
  const book = XLSX.utils.book_new();

  addSheet(book, sheetNameOf(`Tổng hợp ${value.label}`, 'Tổng hợp'),
    VAT_FIGURE_HEADERS,
    figures.map(([label, amount, note]) => [label, money(amount), note]),
    VAT_FIGURE_WIDTHS);

  const rateRows = (group) => [
    ...group.rates.map(r => [`Thuế suất ${r.rate}`, r.invoices, money(r.pretax), money(r.tax)]),
    ...(group.missing.lines ? [[group.missing.rate, group.missing.invoices, money(group.missing.pretax), money(group.missing.tax)]] : []),
    ['Tổng', '', money(group.totalLinePretax), money(group.totalTax)],
  ];
  addSheet(book, 'Bán ra theo thuế suất', VAT_RATE_HEADERS, rateRows(value.sellRates), VAT_RATE_WIDTHS);
  addSheet(book, 'Mua vào theo thuế suất', VAT_RATE_HEADERS, rateRows(value.buyRates), VAT_RATE_WIDTHS);

  const notes = [
    [`Kỳ tính thuế`, `${value.label} (${value.range.from} … ${value.range.to})`],
    ['Phương pháp tính thuế', 'Chưa xác định — app chưa sinh tờ khai (phần này mới chỉ tính số liệu).'],
    ['Hóa đơn loại trừ', `tthai 4/5/6 (đã bị thay thế / đã bị điều chỉnh / đã bị hủy): mua vào ${value.buy.excluded}, bán ra ${value.sell.excluded} hóa đơn bị loại.`],
    ['Tổng thuế theo mức thuế suất', `mua vào ${value.ratesMatchTotals.buy ? 'khớp' : 'LỆCH'} tổng hóa đơn · bán ra ${value.ratesMatchTotals.sell ? 'khớp' : 'LỆCH'} tổng hóa đơn`],
    ...(value.warnings || []).map(text => ['Ghi chú', text]),
  ];
  addSheet(book, 'Ghi chú', ['Mục', 'Nội dung'], notes, [30, 96]);

  const stamp = `${value.year}${String(value.quarter).padStart(2, '0')}`;
  return {
    filename: `tong-hop-quy-${stamp}.xlsx`,
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }),
    dir,
  };
}

module.exports = { buildWorkbook, fileName, SHEET, PARTS, INVOICE_HEADERS, PRODUCT_HEADERS, PARTNER_HEADERS, BANK_HEADERS, INVOICE_WIDTHS, PRODUCT_WIDTHS, PARTNER_WIDTHS, BANK_WIDTHS, invoiceRows, productRows, partnerRows, vatQuarterWorkbook };
