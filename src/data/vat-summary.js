'use strict';
// ---------------------------------------------------------------------------
// BẢNG TỔNG HỢP THEO QUÝ — Mục 4.2.
//
// Tính số liệu tổng hợp để kê khai thuế GTGT, KHÔNG cần biết trước mẫu tờ khai.
// Đây là phần làm được ngay; phần sinh file XML là Mục 4.3 (cần đọc mã mẫu từ tờ khai
// người dùng đã nộp).
//
// BA NGUYÊN TẮC bắt buộc:
//
// 1. LOẠI TRỪ TRẠNG THÁI dùng lại `queries.activeSql()` — hóa đơn 4/5/6 (đã bị thay
//    thế / điều chỉnh / hủy) không cộng vào bất kỳ chỉ tiêu nào. Nhưng số lượng bị loại
//    PHẢI ĐƯỢC TRẢ VỀ để người dùng thấy, không biến mất im lặng.
//
// 2. PHÂN BIỆT "KHÔNG CHỊU THUẾ" VỚI "CHƯA CÓ DỮ LIỆU". Đo thật trên kho của người
//    dùng: 72 hóa đơn bán ra của nhà thuốc đều KHÔNG có <TSuat> và không có
//    <TgTCThue>/<TgTThue> trong <TToan>; `TotalAmountWithoutVAT` BẰNG `TotalAmount`.
//    Đó là hoá đơn không chịu thuế GTGT — dữ liệu ĐÚNG. Nếu cứ hiện "0" thì người
//    dùng tưởng app hỏng. Vì vậy:
//      · `taxAvailable` = có ít nhất một dòng hàng ghi thuế suất và có tiền thuế > 0
//      · `nonTaxLines`  = số dòng hàng không ghi thuế suất (kèm lý do)
//      · `warnings`     = các ghi chú tiếng Việt nói thẳng vấn đề
//
// 3. KHẤU TRỪ không suy ra được từ hóa đơn ⇒ nhập tay ở UI. Không tự đặt số.
// ---------------------------------------------------------------------------

const queries = require('./queries');
const period = require('../period');

// Dòng hàng không ghi thuế suất không phải lúc nào cũng là "không chịu thuế": có thể
// chỉ là NCC ghi thiếu. Gộp vào một nhóm có nhãn riêng, KHÔNG tự gán vào 0%.
const NO_RATE = '(chưa ghi thuế suất)';

function round(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function periodRange(year, quarter) {
  const range = period.quarterRange(year, quarter);
  return { ...range, label: `Quý ${quarter}/${year}` };
}

// Tổng một chiều trong khoảng ngày, có tách số hoá đơn bị loại vì trạng thái.
function directionTotals(db, direction, range) {
  const row = db.prepare(`SELECT
      COUNT(*) AS total_count,
      SUM(CASE WHEN ${queries.activeSql()} THEN 1 ELSE 0 END) AS count,
      COALESCE(SUM(CASE WHEN ${queries.activeSql()} THEN tien_truoc_thue END), 0) AS pretax,
      COALESCE(SUM(CASE WHEN ${queries.activeSql()} THEN tien_thue END), 0) AS tax,
      COALESCE(SUM(CASE WHEN ${queries.activeSql()} THEN tong_tien END), 0) AS total,
      COALESCE(SUM(CASE WHEN ${queries.activeSql()} AND (tien_truoc_thue > 0 OR tien_thue > 0) THEN 1 ELSE 0 END), 0) AS withTax
    FROM invoices
    WHERE direction = ? AND ngay_lap >= ? AND ngay_lap <= ?`).get(direction, range.from, range.to);
  const excluded = Number(row.total_count || 0) - Number(row.count || 0);
  return {
    direction,
    count: Number(row.count || 0),
    excluded,
    // Tổng tiền thanh toán là con số LUÔN có (kể cả hoá đơn không chịu thuế), nên dùng
    // làm "mức doanh thu" khi tiền trước thuế bằng 0.
    total: round(row.total),
    pretax: round(row.pretax),
    tax: round(row.tax),
    withTax: Number(row.withTax || 0),
  };
}

// Doanh thu VÀ THUẾ theo từng mức thuế suất.
//
// KHÔNG được `SUM(v.tien_truoc_thue) GROUP BY i.thue_suat`: một hoá đơn có N dòng
// sẽ bị cộng N lần. Đã kiểm trên kho thật — cách đó ra 45.702.636 thay vì 18.132.988.
//
// Cách đúng: gom theo (hoá đơn, mức thuế) trước, rồi mới cộng lên.
//
//   · tiền trước thuế = SUM(invoice_items.thanh_tien) của các dòng ở mức suất đó.
//     Kiểm chứng trên 14/14 hoá đơn thật: tổng này BẰNG đúng invoices.tien_truoc_thue.
//   · tiền thuế dòng KHÔNG có trong XML (173/174 dòng null) ⇒ phải lấy từ tổng hoá đơn:
//       - hoá đơn CHỈ CÓ MỘT mức suất ⇒ 100% thuộc mức đó (chính xác)
//       - hoá đơn NHIỀU mức suất ⇒ chia theo tỷ trọng tiền hàng (ước lượng ⇒ phải báo)
//     Cách chia này đã đối chiếu với bảng kê chính thức `<TToan><THTTLTSuat>` trong XML:
//     cho ra ĐÚNG BẰNG (8% → 227.636, 5% → 0) cho hoá đơn nhiều mức suất đó.
function ratesOf(db, direction, range) {
  const rows = db.prepare(`SELECT v.id AS id,
      COALESCE(NULLIF(TRIM(i.thue_suat), ''), '') AS rate,
      COUNT(i.id) AS lines,
      COALESCE(SUM(i.thanh_tien), 0) AS line_pretax,
      v.tien_truoc_thue AS invoice_pretax,
      v.tien_thue AS invoice_tax
    FROM invoices v JOIN invoice_items i ON i.invoice_id = v.id
    WHERE v.direction = ? AND v.ngay_lap >= ? AND v.ngay_lap <= ? AND ${queries.activeSql('v')}
    GROUP BY v.id, rate ORDER BY v.id, rate`).all(direction, range.from, range.to);

  // Gom theo hoá đơn trước — bắt buộc để không cộng trùng.
  const byInvoice = new Map();
  for (const row of rows) {
    if (!byInvoice.has(row.id)) byInvoice.set(row.id, []);
    byInvoice.get(row.id).push(row);
  }

  const buckets = new Map();
  let mixedRateInvoices = 0;
  let mixedInvoiceKeys = [];
  let lineMismatch = 0;

  const bucket = rate => {
    const key = rate || NO_RATE;
    if (!buckets.has(key)) {
      buckets.set(key, { rate: key, invoices: 0, lines: 0, pretax: 0, tax: 0, noRate: !rate });
    }
    return buckets.get(key);
  };

  for (const [, group] of byInvoice) {
    const totalLine = group.reduce((sum, g) => sum + Number(g.line_pretax || 0), 0);
    const invoicePretax = Number(group[0].invoice_pretax || 0);
    const invoiceTax = round(group[0].invoice_tax);
    // Chỉ coi là LỆCH khi hoá đơn CÓ thuế ⇒ lệch đó thật sự làm sai phần chia.
    // Hoá đơn không chịu thuế thường có tổng dòng khác tổng hoá đơn (NCC ghi tiền
    // trước thuế = 0 vì không chịu thuế) — đó là quy ước của họ, KHÔNG phải lỗi dữ liệu,
    // và thuế bằng 0 nên không có gì để chia ⇒ không được cảnh báo nhầm.
    if (invoiceTax !== 0 && round(invoicePretax) !== round(totalLine)) lineMismatch += 1;
    const mixed = group.length > 1;
    if (mixed) {
      mixedRateInvoices += 1;
      if (mixedInvoiceKeys.length < 6) mixedInvoiceKeys.push(String(group[0].id));
    }

    for (const row of group) {
      const target = bucket(row.rate);
      target.invoices += 1;
      target.lines += Number(row.lines || 0);
      target.pretax += round(row.line_pretax);
    }
    // Chia thuế của hoá đơn cho các mức suất của nó.
    for (const row of group) {
      let share = 1;
      if (mixed) {
        share = totalLine > 0 ? Number(row.line_pretax || 0) / totalLine : 1 / group.length;
      }
      bucket(row.rate).tax += round(invoiceTax * share);
    }
  }

  const known = [...buckets.values()].filter(b => !b.noRate).sort((a, b) => String(a.rate).localeCompare(String(b.rate)));
  const missing = buckets.get(NO_RATE)
    ? { ...buckets.get(NO_RATE), invoices: buckets.get(NO_RATE).invoices }
    : { rate: NO_RATE, invoices: 0, lines: 0, pretax: 0, tax: 0, noRate: true };

  return {
    rates: known,
    missing,
    mixedRateInvoices,
    mixedInvoiceKeys,
    lineMismatch,
    totalLinePretax: round([...buckets.values()].reduce((sum, b) => sum + b.pretax, 0)),
    totalTax: round([...buckets.values()].reduce((sum, b) => sum + b.tax, 0)),
  };
}

// Thuế phải nộp = thuế bán ra − thuế mua vào được trừ − khấu trừ kỳ này.
// Âm ⇒ chuyển sang kỳ sau (theo logic ct40/ct41/ct43 của tờ khai 01/GTGT).
function computeFigures({ sell, buy, deduction = 0 }) {
  const deductibleInput = Math.max(0, round(deduction));
  const net = sell.tax - buy.tax - deductibleInput;
  return {
    outputTax: sell.tax,
    deductibleInput: buy.tax,
    deduction: deductibleInput,
    payable: net > 0 ? net : 0,
    carried: net < 0 ? -net : 0,
    hasDeduction: deductibleInput > 0,
  };
}

// Bảng tổng hợp MỘT quý. `deduction` là số khấu trừ người dùng nhập tay (đồng).
function quarterSummary(db, { year, quarter, deduction = 0 } = {}) {
  const y = Number(year);
  const q = Number(quarter);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new Error('Năm không hợp lệ.');
  if (!Number.isInteger(q) || q < 1 || q > 4) throw new Error('Quý không hợp lệ.');
  const range = periodRange(y, q);

  const buy = directionTotals(db, 'BUY', range);
  const sell = directionTotals(db, 'SELL', range);
  const buyRates = ratesOf(db, 'BUY', range);
  const sellRates = ratesOf(db, 'SELL', range);
  const figures = computeFigures({ sell, buy, deduction });

  const warnings = [];
  if (sell.count === 0 && buy.count === 0) {
    warnings.push(`Kho chưa có hóa đơn nào trong ${range.label} (${range.from} … ${range.to}).`);
  }
  // Bán ra có hóa đơn nhưng tổng tiền trước thuế và tiền thuế đều 0 trong khi tổng
  // thanh toán khác 0 ⇒ hoá đơn không chịu thuế (hoặc NCC chưa ghi thuế). Nói rõ.
  if (sell.count > 0 && sell.tax === 0 && sell.total > 0) {
    warnings.push('Hóa đơn bán ra trong kỳ không ghi tiền thuế — đây là hóa đơn không chịu thuế GTGT (ví dụ thuốc không chịu thuế), không phải số liệu bị thiếu.');
  }
  if (sell.count > 0 && sell.tax === 0 && sellRates.missing.lines === 0 && sellRates.rates.length === 0) {
    warnings.push('Không tìm thấy dòng hàng nào có thuế suất trong hóa đơn bán ra của kỳ này.');
  }
  if (buy.count > 0 && buy.tax === 0) {
    warnings.push('Hóa đơn mua vào trong kỳ không ghi tiền thuế — không có số thuế vào để khấu trừ.');
  }
  if (sell.excluded > 0 || buy.excluded > 0) {
    warnings.push(`Đã loại ${sell.excluded + buy.excluded} hóa đơn không còn hiệu lực (đã bị thay thế / đã bị điều chỉnh / đã bị hủy) — xem bộ lọc Trạng thái ở tab Danh sách.`);
  }
  // Nhiều mức thuế suất trong một hóa đơn ⇒ thuế phải CHIA, tức là ước lượng. Nói rõ,
  // không để người dùng tưởng con số là của riêng từng mức suất.
  for (const [name, group] of [['mua vào', buyRates], ['bán ra', sellRates]]) {
    if (group.mixedRateInvoices > 0) {
      warnings.push(`${group.mixedRateInvoices} hóa đơn ${name} có nhiều mức thuế suất; thuế của các hóa đơn đó được chia theo tỷ trọng tiền hàng từng dòng.`);
    }
    // Tổng tiền hàng dòng lệch tổng hóa đơn ⇒ số theo mức suất có thể không khớp tổng.
    if (group.lineMismatch > 0) {
      warnings.push(`${group.lineMismatch} hóa đơn ${name} có tổng tiền dòng hàng khác tổng tiền hóa đơn — thuế theo mức suất là con số ước lượng cho các hóa đơn này.`);
    }
  }
  if (!figures.hasDeduction && sell.tax > 0) {
    warnings.push('Chưa nhập số khấu trừ của kỳ (không suy ra được từ hóa đơn) — thuế phải nộp đang tính chưa có khấu trừ.');
  }
  if (figures.carried > 0) {
    warnings.push(`Thuế vào nhiều hơn thuế ra ${figures.carried.toLocaleString('vi-VN')} đồng — phần dư được chuyển sang kỳ sau.`);
  }

  return {
    year: y,
    quarter: q,
    label: range.label,
    range,
    buy,
    sell,
    buyRates,
    sellRates,
    figures,
    // Không có mức thuế suất nào và thuế = 0 ⇒ KHÔNG kết luận "thuế = 0", mà nói
    // là chưa đủ dữ liệu / không phát sinh. UI dùng cờ này để đổi nhãn hiển thị.
    taxAvailable: sell.tax > 0 || buy.tax > 0,
    sellHasTaxableItems: sellRates.rates.length > 0,
    // Tổng THUẾ theo mức thuế suất phải bằng tổng hóa đơn — luôn kiểm được.
    // Tổng TIỀN TRƯỚC THUẾ chỉ so được khi hóa đơn có ghi tiền trước thuế: hóa đơn
    // không chịu thuế ghi 0 ở tổng hóa đơn nhưng dòng hàng vẫn có tiền ⇒ so sẽ báo lệch giả.
    ratesMatchTotals: {
      buy: buyRates.totalTax === buy.tax && (buy.tax === 0 || buyRates.totalLinePretax === buy.pretax),
      sell: sellRates.totalTax === sell.tax && (sell.tax === 0 || sellRates.totalLinePretax === sell.pretax),
    },
    warnings,
  };
}

// Danh sách các quý CÓ dữ liệu, để UI đừng bắt người dùng gõ năm/quý khi không có gì.
function availablePeriods(db, limit = 24) {
  const rows = db.prepare(`SELECT substr(ngay_lap, 1, 4) AS year,
      (CAST(substr(ngay_lap, 6, 2) AS INTEGER) - 1) / 3 + 1 AS quarter,
      COUNT(*) AS invoices
    FROM invoices
    WHERE ngay_lap GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    GROUP BY year, quarter ORDER BY year DESC, quarter DESC`).all();
  return rows.slice(0, limit).map(row => ({
    year: Number(row.year),
    quarter: Number(row.quarter),
    label: `Quý ${Number(row.quarter)}/${Number(row.year)}`,
    invoices: Number(row.invoices || 0),
  }));
}

module.exports = { quarterSummary, availablePeriods, computeFigures, periodRange, NO_RATE };