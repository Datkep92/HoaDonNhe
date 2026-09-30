'use strict';
// ---------------------------------------------------------------------------
// ĐỐI CHIẾU SAO KÊ NGÂN HÀNG VỚI HÓA ĐƠN — MASTER TASK mục 7–14.
//
// NGUYÊN TẮC CỐT LÕI (không được phá):
//   • CASH        → KHÔNG đưa vào đối chiếu, ghi rõ CASH_NO_BANK_REQUIRED (đây KHÔNG phải lỗi).
//   • TRANSFER    → đưa vào đối chiếu sao kê.
//   • UNKNOWN     → KHÔNG được tự đoán là tiền mặt hay chuyển khoản → PAYMENT_METHOD_UNKNOWN.
//   • TM/CK       → mơ hồ → PAYMENT_METHOD_AMBIGUOUS, xử lý riêng.
//   • Engine chỉ PHÁT HIỆN / PHÂN LOẠI / GHI NHẬN — KHÔNG xóa, KHÔNG sửa dữ liệu gốc.
//
// MỤC 13: kết quả KHÔNG chỉ có MATCH / NOT_MATCH. Mỗi hóa đơn và mỗi giao dịch đều có
//   • reconciliation_status  — kết quả CHÍNH (1 giá trị)
//   • reconciliation_issues  — MẢNG vấn đề kèm theo (JSON), 1 dòng có thể NHIỀU vấn đề
//     Ví dụ: giao dịch A = TRANSFER_BANK_FOUND + AMOUNT_MISMATCH + NEEDS_REVIEW.
//   Trước bản này các giá trị còn lại chỉ là SỐ ĐẾM suy ra khi query ⇒ không truy được
//   "hóa đơn nào, giao dịch nào" → không làm được mục 27 (bấm vào cảnh báo để xem chi tiết).
//
// Đối chiếu CHỈ dựa trên dữ liệu đã import vào SQLite — KHÔNG đọc lại XML (mục 33).
//
// MỤC 12 (KIẾN TRÚC — 1 giao dịch ↔ N hóa đơn): thuật toán lượt này chạy theo mô hình
//   1 giao dịch ↔ 1 hóa đơn (giao dịch đã dùng được lấy khỏi pool). Đây là GIỚI HẠN (limitation)
//   của bản này, KHÔNG phải giả định bắt buộc của hệ thống:
//   • Bảng trung gian reconciliation_matches(invoice_id, bank_transaction_id, matched_amount,
//     score, …) đã là bảng N:M — mỗi hóa đơn/giao dịch có thể có NHIỀU dòng, matched_amount đã
//     là số tiền từng phần ⇒ muốn gộp 1→N / N→1 chỉ cần bỏ lệnh “loại khỏi pool” và cộng dồn
//     matched_amount, KHÔNG phải đổi schema.
//   • Chưa gộp được thì KHÔNG ép kết quả: giao dịch chưa gắn hóa đơn → BANK_NO_INVOICE,
//     hóa đơn chưa tìm thấy dòng tiền → TRANSFER_BANK_NOT_FOUND; cả hai đều hiện ở mục 27
//     để người dùng xem tay — KHÔNG tính bừa là đã khớp.
// ---------------------------------------------------------------------------

const { withTransaction, dateRange } = require('./sqlite');
const { fold, PAYMENT_METHODS } = require('./payment-method');

// Kết quả chính lưu trên invoices.reconciliation_status
const STATUS = Object.freeze({
  CASH_NO_BANK_REQUIRED: 'CASH_NO_BANK_REQUIRED',
  TRANSFER_BANK_FOUND: 'TRANSFER_BANK_FOUND',
  TRANSFER_BANK_NOT_FOUND: 'TRANSFER_BANK_NOT_FOUND',
  PAYMENT_METHOD_UNKNOWN: 'PAYMENT_METHOD_UNKNOWN',
  PAYMENT_METHOD_AMBIGUOUS: 'PAYMENT_METHOD_AMBIGUOUS',
});
// Kết quả chính lưu trên bank_transactions.reconciliation_status
const BANK_STATUS = Object.freeze({
  MATCH: 'MATCH',
  BANK_NO_INVOICE: 'BANK_NO_INVOICE',
});
// Vấn đề kèm theo (lưu mảng trong cột *_issues)
const ISSUES = Object.freeze({
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  DATE_MISMATCH: 'DATE_MISMATCH',
  PARTNER_MISMATCH: 'PARTNER_MISMATCH',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});
// Trạng thái "hoá đơn hủy" — không tham gia đối chiếu (giữ nguyên như bản trước).
const CANCELLED_STATES = ['4', '5', '6'];

const DAY_MS = 86400000;
// Ngày 'YYYY-MM-DD' → số ngày kể từ epoch (UTC). Tính MỘT LẦN cho mỗi giao dịch rồi tái
// dùng: bản cũ gọi dateDistance (và Date.parse 2 lần) cho TỪNG CẶP hoá đơn × giao dịch —
// 1.000 × 5.000 là 5 triệu cặp, mỗi cặp 2 lần Date.parse ⇒ phần lớn thời gian chạy nằm ở
// chỗ này chứ không phải ở phép so sánh tiền. Trả NaN cho ngày rỗng/rác để bị loại như trước.
function dayNumber(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return NaN;
  const ms = Date.parse(`${text.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : NaN;
}
const dateDistance = (a, b) => {
  const left = Date.parse(`${a || ''}T00:00:00Z`);
  const right = Date.parse(`${b || ''}T00:00:00Z`);
  return Number.isFinite(left) && Number.isFinite(right) ? Math.abs(left - right) / DAY_MS : Infinity;
};
const amountFor = (invoice, transaction) => invoice.direction === 'SELL' ? Number(transaction.credit || 0) : Number(transaction.debit || 0);
const partnerFor = invoice => invoice.direction === 'SELL' ? `${invoice.ten_mua || ''} ${invoice.mst_mua || ''}` : `${invoice.ten_ban || ''} ${invoice.mst_ban || ''}`;

// Vùng chứa nội dung đối chiếu của giao dịch (dùng lại cho nhiều hóa đơn ⇒ GỘP một lần duy nhất
// thay vì fold lại chuỗi mô tả cho MỖI cặp — số cặp = số hóa đơn × số giao dịch).
function haystackOf(transaction) {
  return fold(`${transaction.description || ''} ${transaction.detail || ''} ${transaction.counterparty_name || ''} ${transaction.counterparty_account || ''}`);
}

// Trả về null nếu không đủ điều kiện làm ứng viên. Khi có kết quả: { score, issues, ... }
// `haystack` truyền vào từ ngoài (xem haystackOf) để khỏi tính lại.
function candidateScore(invoice, transaction, haystack, days) {
  const expected = Number(invoice.tong_tien || 0);
  const paid = amountFor(invoice, transaction);
  if (!(expected > 0) || !(paid > 0)) return null;
  // `days` do rebuild() tính sẵn (xem dayNumber) — chỉ gọi dateDistance khi không có sẵn.
  const gap = days === undefined ? dateDistance(invoice.ngay_lap, transaction.tran_date || transaction.value_date) : days;
  if (!(gap <= 45)) return null;
  const amountDelta = Math.abs(expected - paid);
  const amountRatio = amountDelta / Math.max(expected, paid);
  if (amountRatio > 0.25) return null;
  const text = haystack === undefined ? haystackOf(transaction) : haystack;
  const partnerTokens = fold(partnerFor(invoice)).split(/\s+/).filter(token => token.length >= 4);
  const partnerHit = partnerTokens.some(token => text.includes(token));
  const exactAmount = amountDelta < 0.5;
  const issues = [];
  if (!exactAmount) issues.push(ISSUES.AMOUNT_MISMATCH);
  if (gap > 7) issues.push(ISSUES.DATE_MISMATCH);
  if (partnerTokens.length && !partnerHit) issues.push(ISSUES.PARTNER_MISMATCH);
  const score = (exactAmount ? 70 : Math.max(0, 50 - amountRatio * 200)) + Math.max(0, 20 - gap) + (partnerHit ? 10 : 0);
  return { score, issues, matchedAmount: Math.min(expected, paid), exactAmount, days: gap };
}

// Chạy lại TOÀN BỘ đối chiếu và LƯU kết quả cho TỪNG dòng (hóa đơn + giao dịch).
// Idempotent: gọi bao nhiêu lần cũng cho cùng kết quả.
function rebuild(db) {
  const invoices = db.prepare(`SELECT * FROM invoices WHERE COALESCE(tthai, '') NOT IN (?, ?, ?)
    ORDER BY ngay_lap, id`).all(...CANCELLED_STATES);
  const transactions = db.prepare('SELECT * FROM bank_transactions ORDER BY tran_date, id').all();
  const haystacks = new Map(transactions.map(transaction => [transaction.id, haystackOf(transaction)]));
  const stamp = new Date().toISOString();

  return withTransaction(db, () => {
    // Xóa sạch lần trước — mọi trạng thái được dựng lại từ đầu, không sót kết quả cũ.
    db.prepare('DELETE FROM reconciliation_matches').run();
    db.prepare('UPDATE invoices SET reconciliation_status = NULL, reconciliation_issues = NULL').run();
    db.prepare('UPDATE bank_transactions SET reconciliation_status = NULL, reconciliation_issues = NULL').run();

    const setInvoice = db.prepare('UPDATE invoices SET reconciliation_status = ?, reconciliation_issues = ? WHERE id = ?');
    const setTransaction = db.prepare('UPDATE bank_transactions SET reconciliation_status = ?, reconciliation_issues = ? WHERE id = ?');
    const insert = db.prepare(`INSERT INTO reconciliation_matches
      (invoice_id, bank_transaction_id, matched_amount, score, status, issues, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const setIssues = issues => JSON.stringify(issues || []);

    // Giao dịch CHƯA dùng vẫn còn trong pool; dùng xong thì đánh dấu đã dùng (mô hình 1:1 —
    // xem mục 12). Pool SẮP THEO NGÀY và tra bằng CỬA SỔ TRƯỢT, thay vì quét toàn bộ pool cho
    // từng hoá đơn: bản cũ là O(hoá đơn × giao dịch) — 1.000 × 5.000 mất hơn 20 giây và giữ
    // write-lock suốt thời gian đó. `used` thay cho `splice` (O(n) mỗi lần khớp) và giữ đúng
    // quy tắc "một giao dịch chỉ dùng cho một hoá đơn".
    const pool = transactions.map((transaction, index) => ({ transaction, index, day: dayNumber(transaction.tran_date || transaction.value_date) }));
    // Giao dịch không có ngày hợp lệ (NaN) XẾP CUỐI: cửa sổ trượt chỉ đi tới ngày hữu hạn
    // nên chúng không bao giờ lọt vào ứng viên — giữ đúng hành vi của `dateDistance` = Infinity.
    pool.sort((a, b) => {
      const fa = Number.isFinite(a.day) ? 0 : 1;
      const fb = Number.isFinite(b.day) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return fa ? (a.index - b.index) : (a.day - b.day) || (a.index - b.index);
    });
    const poolIndexById = new Map(pool.map((item, at) => [item.transaction.id, at]));
    const used = new Uint8Array(pool.length);
    let low = 0;         // cửa sổ trái
    let high = 0;        // cửa sổ phải (chưa bao gồm)
    const bankIssues = new Map();
    const reason = { matched: 0, cash: 0, missing: 0, unknown: 0, ambiguous: 0 };

    for (const invoice of invoices) {
      const method = invoice.payment_method || PAYMENT_METHODS.UNKNOWN;
      // CASH: KHÔNG đưa vào đối chiếu sao kê — đây là kết quả bình thường, không phải lỗi (mục 8).
      if (method === PAYMENT_METHODS.CASH) {
        setInvoice.run(STATUS.CASH_NO_BANK_REQUIRED, setIssues([]), invoice.id);
        reason.cash += 1;
        continue;
      }
      // UNKNOWN: tuyệt đối KHÔNG được tự biến thành CASH hay TRANSFER (mục 5).
      if (method === PAYMENT_METHODS.UNKNOWN) {
        setInvoice.run(STATUS.PAYMENT_METHOD_UNKNOWN, setIssues([ISSUES.NEEDS_REVIEW]), invoice.id);
        reason.unknown += 1;
        continue;
      }
      // TM/CK: mơ hồ → xử lý riêng, không ép vào một trong hai loại (mục 7).
      if (method === PAYMENT_METHODS.CASH_TRANSFER) {
        setInvoice.run(STATUS.PAYMENT_METHOD_AMBIGUOUS, setIssues([ISSUES.NEEDS_REVIEW]), invoice.id);
        reason.ambiguous += 1;
        continue;
      }
      // Giá trị lạ ngoài 4 loại chuẩn — coi như CHƯA XÁC ĐỊNH, không đoán.
      if (method !== PAYMENT_METHODS.TRANSFER) {
        setInvoice.run(STATUS.PAYMENT_METHOD_UNKNOWN, setIssues([ISSUES.NEEDS_REVIEW]), invoice.id);
        reason.unknown += 1;
        continue;
      }

      // Ứng viên = giao dịch chưa dùng, CÓ NGÀY hợp lệ và nằm trong ±45 ngày quanh ngày lập
      // hoá đơn. Hoá đơn không có ngày lập hợp lệ thì không có ứng viên nào (ngày rỗng trước đây
      // cho khoảng cách Infinity ⇒ cũng không khớp được, giữ nguyên kết quả).
      const invoiceDay = dayNumber(invoice.ngay_lap);
      let candidates = [];
      if (Number.isFinite(invoiceDay)) {
        // Mở rộng cửa sổ phải tới ngày lập + 45. Các mục ngày vô hạn nằm CUỐI pool nên
        // vòng lặp dừng trước chúng (điều kiện phải kiểm ngày hữu hạn, không dựa vào NaN).
        while (high < pool.length && Number.isFinite(pool[high].day) && pool[high].day <= invoiceDay + 45) high += 1;
        // Thu hẹp cửa sổ trái. Hoá đơn đi theo ngày tăng dần nên `low` chỉ tiến, không lùi.
        while (low < high && pool[low].day < invoiceDay - 45) low += 1;
        candidates = [];
        for (let i = low; i < high; i += 1) {
          if (used[i]) continue;
          const result = candidateScore(invoice, pool[i].transaction, haystacks.get(pool[i].transaction.id), Math.abs(pool[i].day - invoiceDay));
          if (result) candidates.push({ transaction: pool[i].transaction, result });
        }
        candidates.sort((a, b) => b.result.score - a.result.score);
      }
      const best = candidates[0];
      // Không có ứng viên đủ điểm → TRANSFER_BANK_NOT_FOUND + NEEDS_REVIEW (mục 9).
      // KHÔNG kết luận "hóa đơn sai": có thể khách trả bằng tài khoản khác, ngoài khoảng ngày,
      // trả công nợ, sao kê chưa đủ, một giao dịch trả nhiều hóa đơn…
      if (!best || best.result.score < 65) {
        setInvoice.run(STATUS.TRANSFER_BANK_NOT_FOUND, setIssues([ISSUES.NEEDS_REVIEW]), invoice.id);
        reason.missing += 1;
        continue;
      }
      const issues = [...best.result.issues];
      // Có lệch (tiền/ngày/đối tượng) thì thêm cờ cần kiểm tra: 1 dòng được NHIỀU vấn đề (mục 13).
      if (issues.length) issues.push(ISSUES.NEEDS_REVIEW);
      insert.run(invoice.id, best.transaction.id, best.result.matchedAmount, best.result.score,
        issues.length ? ISSUES.NEEDS_REVIEW : STATUS.TRANSFER_BANK_FOUND, setIssues(issues), stamp, stamp);
      setInvoice.run(STATUS.TRANSFER_BANK_FOUND, setIssues(issues), invoice.id);
      bankIssues.set(best.transaction.id, issues);
      // Đánh dấu đã dùng theo VỊ TRÍ trong pool (tra cảnh báo bảng tra, không quét lại pool).
      const at = poolIndexById.get(best.transaction.id);
      if (at !== undefined) used[at] = 1;
      reason.matched += 1;
    }

    // Chiều ngược lại (mục 10): sao kê chưa gắn với hóa đơn chuyển khoản → BANK_NO_INVOICE +
    // NEEDS_REVIEW. KHÔNG kết luận "THIẾU HÓA ĐƠN": có thể là trả nợ, ứng trước, vay, thu khác,
    // thanh toán nhiều hóa đơn, dữ liệu hóa đơn chưa tải, giao dịch không liên quan.
    for (const transaction of transactions) {
      if (bankIssues.has(transaction.id)) {
        setTransaction.run(BANK_STATUS.MATCH, setIssues(bankIssues.get(transaction.id)), transaction.id);
      } else {
        setTransaction.run(BANK_STATUS.BANK_NO_INVOICE, setIssues([ISSUES.NEEDS_REVIEW]), transaction.id);
      }
    }
    return { transferInvoices: reason.matched + reason.missing, transactions: transactions.length, matched: reason.matched, ...reason };
  });
}

// Đã chạy đối chiếu chưa / dữ liệu có đổi sau lần chạy trước không?
// Dùng để TỰ chạy lại sau khi import XML hoặc nhập sao kê (trước đây chỉ chạy khi bấm nút).
function stale(db) {
  const invoice = db.prepare(`SELECT COUNT(*) AS c FROM invoices
    WHERE reconciliation_status IS NULL AND COALESCE(tthai, '') NOT IN (?, ?, ?)`).get(...CANCELLED_STATES);
  if (Number(invoice.c || 0) > 0) return true;
  const bank = db.prepare('SELECT COUNT(*) AS c FROM bank_transactions WHERE reconciliation_status IS NULL').get();
  return Number(bank.c || 0) > 0;
}

// Gọi sau khi dữ liệu đổi. Giữ nguyên hành vi nếu không có gì mới (không tốn công so khớp).
// Bản cũ `catch { }` nuốt SẠCH lỗi: đối chiếu hỏng thì kho vẫn để trạng thái NULL và giao diện
// hiện con số 0 như thể đã chạy — người dùng tin nhầm. Nay ghi log và báo lại qua
// `onReconcileError` (server ghi ra nhật ký) thay vì im lặng; vẫn KHÔNG ném ra ngoài để một
// lỗi ở lớp phụ không làm hỏng cả lượt nhập.
let onReconcileError = null;
function setErrorReporter(fn) { onReconcileError = typeof fn === 'function' ? fn : null; }
function reportError(where, error) {
  if (!onReconcileError) return;
  try { onReconcileError(where, error); } catch { /* báo lỗi cũng lỗi thì không có gì để làm */ }
}
function reconcile(db) {
  try {
    if (stale(db)) return rebuild(db);
  } catch (error) {
    reportError('reconcile', error);
    return { error: String((error && error.message) || error) };
  }
  return null;
}

// Ép chạy lại — dùng cho chỗ DỮ LIỆU BỊ MẤT (xóa file sao kê, chuyển file sang MST khác),
// vì khi đó không còn dòng nào mang trạng thái NULL để stale() phát hiện.
function forceReconcile(db) {
  try { return rebuild(db); } catch (error) { reportError('forceReconcile', error); return null; }
}

function summary(db, range) {
  // Kỳ đang chọn (bộ chọn kỳ trên header): hoá đơn lọc theo NGÀY LẬP, sao kê lọc theo NGÀY GIAO
  // DỊCH — hai cột ngày khác nhau nên tính riêng.
  const picked = dateRange(range);
  const pickedBank = dateRange(range, { column: 'tran_date' });
  // KHÔNG tự ghi trong hàm ĐỌC này. Bản cũ gọi reconcile() ở đây, tức một route GET
  // (/api/db/reconciliation/summary, mở tab Tổng quan là gọi) có thể chạy trọn rebuild() —
  // với kho lớn là hàng chục giây trong một HTTP GET, và nắm write-lock của cả database.
  // Nay chỉ BÁO trạng thái `stale`; giao diện thấy thì gọi POST /api/db/reconciliation/run
  // (route có kiểm bản quyền) rồi tải lại. Nhờ vậy số liệu không bao giờ là con số 0 giả
  // do đối chiếu hỏng mà không ai biết (mục 35).
  const isStale = stale(db);
  // Nhóm theo payment_method GIỮ NGUYÊN như bản trước (đếm theo DỮ LIỆU hóa đơn, không phụ thuộc
  // việc đã chạy đối chiếu hay chưa) — nhóm theo reconciliation_status mới là kết quả đã lưu.
  // Thêm *_amount: GIÁ trị tiền mặt / chuyển khoản (mục 22) — cộng đúng các hoá đơn không huỷ.
  const invoice = db.prepare(`SELECT
      SUM(CASE WHEN payment_method = 'CASH' THEN 1 ELSE 0 END) cash_no_bank_required,
      SUM(CASE WHEN payment_method = 'TRANSFER' THEN 1 ELSE 0 END) transfer_total,
      SUM(CASE WHEN payment_method = 'UNKNOWN' THEN 1 ELSE 0 END) payment_unknown,
      SUM(CASE WHEN payment_method = 'CASH_TRANSFER' THEN 1 ELSE 0 END) payment_ambiguous,
      SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_FOUND}' THEN 1 ELSE 0 END) transfer_found,
      SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_FOUND}'
                 AND reconciliation_issues LIKE '%NEEDS_REVIEW%' THEN 1 ELSE 0 END) found_review,
      SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_NOT_FOUND}' THEN 1 ELSE 0 END) transfer_missing,
      SUM(CASE WHEN reconciliation_issues LIKE '%${ISSUES.AMOUNT_MISMATCH}%' THEN 1 ELSE 0 END) amount_mismatch,
      SUM(CASE WHEN reconciliation_issues LIKE '%${ISSUES.DATE_MISMATCH}%' THEN 1 ELSE 0 END) date_mismatch,
      SUM(CASE WHEN reconciliation_issues LIKE '%${ISSUES.PARTNER_MISMATCH}%' THEN 1 ELSE 0 END) partner_mismatch,
      SUM(CASE WHEN reconciliation_status IS NOT NULL THEN 1 ELSE 0 END) decided,
      COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN tong_tien ELSE 0 END), 0) AS cash_amount,
      COALESCE(SUM(CASE WHEN payment_method = 'TRANSFER' THEN tong_tien ELSE 0 END), 0) AS transfer_amount
    FROM invoices WHERE COALESCE(tthai, '') NOT IN (?, ?, ?) ${picked.and}`).get(...CANCELLED_STATES, ...picked.params);
  const bank = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN reconciliation_status = '${BANK_STATUS.MATCH}' THEN 1 ELSE 0 END) matched,
      SUM(CASE WHEN reconciliation_status = '${BANK_STATUS.BANK_NO_INVOICE}' THEN 1 ELSE 0 END) no_invoice,
      SUM(CASE WHEN reconciliation_status IS NOT NULL THEN 1 ELSE 0 END) decided
    FROM bank_transactions ${pickedBank.where}`).get(...pickedBank.params);
  // "ĐÃ CHẠY ĐỐI CHIẾU" là tính trạng TOÀN BỘ database (không theo kỳ): lọc theo kỳ mà đếm theo
  // trạng thái thì kỳ trống sẽ hiện "Chưa chạy đối chiếu" dù thực tế đã chạy (mục 35).
  const ranRow = db.prepare(`SELECT
      (SELECT COUNT(*) FROM invoices WHERE reconciliation_status IS NOT NULL) AS invoices,
      (SELECT COUNT(*) FROM bank_transactions WHERE reconciliation_status IS NOT NULL) AS bank`).get();
  const decided = Number(ranRow.invoices || 0) > 0 || Number(ranRow.bank || 0) > 0;
  // MỤC 4 — ĐỐI CHIẾU THEO TỪNG PHÍA: bán ra = khách chuyển tiền vào, mua vào = mình trả nhà cung
  // cấp. Chỉ hoá đơn CHUYỂN KHOẢN (tiền mặt không cần đối chiếu sao kê — mục 8).
  const sideRows = db.prepare(`SELECT direction,
      SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_FOUND}' THEN 1 ELSE 0 END) found,
      COALESCE(SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_FOUND}' THEN tong_tien ELSE 0 END), 0) found_amount,
      SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_NOT_FOUND}' THEN 1 ELSE 0 END) missing,
      COALESCE(SUM(CASE WHEN reconciliation_status = '${STATUS.TRANSFER_BANK_NOT_FOUND}' THEN tong_tien ELSE 0 END), 0) missing_amount
    FROM invoices WHERE payment_method = 'TRANSFER' AND COALESCE(tthai, '') NOT IN (?, ?, ?) ${picked.and}
    GROUP BY direction`).all(...CANCELLED_STATES, ...picked.params);
  const blankSide = () => ({ found: 0, foundAmount: 0, missing: 0, missingAmount: 0 });
  const byDirection = { SELL: blankSide(), BUY: blankSide() };
  for (const row of sideRows) {
    if (!byDirection[row.direction]) continue;
    byDirection[row.direction] = {
      found: Number(row.found || 0), foundAmount: Number(row.found_amount || 0),
      missing: Number(row.missing || 0), missingAmount: Number(row.missing_amount || 0),
    };
  }
  return {
    // Đã chạy đối chiếu chưa — UI phải hiện "Chưa đối chiếu" thay vì hiện số 0 như số thật (mục 35).
    ran: decided,
    // Còn dữ liệu chưa được đối chiếu không? Giao diện gọi POST /api/db/reconciliation/run
    // rồi tải lại — thay vì để hàm đọc này tự ghi (xem giải thích ở trên).
    stale: isStale,
    // Số hoá đơn tiền mặt lấy theo DỮ LIỆU (payment_method = 'CASH'), không đếm theo trạng thái đã
    // lưu: chưa chạy đối chiếu lần nào thì trạng thái còn NULL và sẽ hiện ra "0" giả (mục 35).
    cashNoBankRequired: Number(invoice.cash_no_bank_required || 0),
    // Mục 22 — giá trị tiền mặt / giá trị hoá đơn chuyển khoản (chỉ cộng hoá đơn không huỷ).
    cashAmount: Number(invoice.cash_amount || 0),
    transferAmount: Number(invoice.transfer_amount || 0),
    transferTotal: Number(invoice.transfer_total || 0),
    transferBankFound: Number(invoice.transfer_found || 0),
    transferNeedsReview: Number(invoice.found_review || 0),
    transferBankNotFound: Number(invoice.transfer_missing || 0),
    paymentMethodUnknown: Number(invoice.payment_unknown || 0),
    paymentMethodAmbiguous: Number(invoice.payment_ambiguous || 0),
    amountMismatch: Number(invoice.amount_mismatch || 0),
    dateMismatch: Number(invoice.date_mismatch || 0),
    partnerMismatch: Number(invoice.partner_mismatch || 0),
    bankTotal: Number(bank.total || 0),
    bankMatched: Number(bank.matched || 0),
    bankNoInvoice: Number(bank.no_invoice || 0),
    // MỤC 4 — đối chiếu tách theo chiều: bán ra (khách hàng) / mua vào (nhà cung cấp).
    byDirection,
  };
}

function list(db, { limit = 100 } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  return db.prepare(`SELECT r.*, i.invoice_key, i.direction, i.ngay_lap, i.so_hd, i.khh_hd,
      i.tong_tien, i.payment_method, b.tran_date, b.credit, b.debit, b.description, b.counterparty_name
    FROM reconciliation_matches r
    JOIN invoices i ON i.id = r.invoice_id
    JOIN bank_transactions b ON b.id = r.bank_transaction_id
    ORDER BY r.score DESC, r.id DESC LIMIT ?`).all(size).map(row => ({ ...row, issues: JSON.parse(row.issues || '[]') }));
}

// Danh sách CẦN KIỂM TRA (mục 27 — mỗi cảnh báo click vào là ra danh sách này):
// gộp hóa đơn chưa tìm thấy sao kê + giao dịch chưa gắn hóa đơn + hóa đơn khiếm khuyết.
// KHÔNG tính hóa đơn tiền mặt vào đây (mục 8).
function listPending(db, { limit = 200 } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 200));
  const invoices = db.prepare(`SELECT id, 'invoice' AS kind, invoice_key, direction, ngay_lap, so_hd, khh_hd,
      khms_hd, tong_tien, payment_method, reconciliation_status, reconciliation_issues,
      COALESCE(review_status, '') AS review_status,
      COALESCE(ten_mua, '') AS partner, '' AS tran_date, '' AS description, 0 AS credit, 0 AS debit
    FROM invoices
    WHERE reconciliation_status IN (?, ?, ?, ?)
    ORDER BY ngay_lap DESC, id DESC LIMIT ?`)
    .all(STATUS.TRANSFER_BANK_NOT_FOUND, STATUS.PAYMENT_METHOD_UNKNOWN, STATUS.PAYMENT_METHOD_AMBIGUOUS,
      STATUS.TRANSFER_BANK_FOUND, size)
    // TRANSFER_BANK_FOUND chỉ vào danh sách khi có vấn đề kèm theo (lệch tiền/ngày/đối tượng).
    .filter(row => row.reconciliation_status !== STATUS.TRANSFER_BANK_FOUND
      || (JSON.parse(row.reconciliation_issues || '[]').length > 0));
  // Chiều sao kê: giao dịch CHƯA CÓ hoá đơn (BANK_NO_INVOICE) **và** giao dịch đã khớp nhưng
  // còn vấn đề kèm (MATCH + issues). Bản cũ chỉ lấy BANK_NO_INVOICE nên một dòng lệch tiền /
  // lệch ngày bị bỏ sót khỏi danh sách "Cần kiểm tra" dù chiều hoá đơn có mặt (mục 27).
  const bank = db.prepare(`SELECT id, 'bank' AS kind, '' AS invoice_key, '' AS direction, '' AS ngay_lap,
      '' AS so_hd, '' AS khh_hd, '' AS khms_hd, COALESCE(amount, 0) AS tong_tien, '' AS payment_method,
      reconciliation_status, reconciliation_issues, '' AS review_status, COALESCE(counterparty_name, '') AS partner,
      tran_date, COALESCE(description, '') AS description, COALESCE(credit, 0) AS credit, COALESCE(debit, 0) AS debit
    FROM bank_transactions
    WHERE reconciliation_status = ? OR (reconciliation_status = ? AND COALESCE(reconciliation_issues, '') <> '[]')
    ORDER BY tran_date DESC, id DESC LIMIT ?`).all(BANK_STATUS.BANK_NO_INVOICE, BANK_STATUS.MATCH, size);
  const mapIssues = row => ({ ...row, issues: JSON.parse(row.reconciliation_issues || '[]') });
  return { invoices: invoices.map(mapIssues), bank: bank.map(mapIssues) };
}

module.exports = {
  STATUS, BANK_STATUS, ISSUES, CANCELLED_STATES,
  candidateScore, haystackOf, rebuild, stale, reconcile, forceReconcile, summary, list, listPending,
  dateDistance, amountFor, dayNumber, setErrorReporter,
};
