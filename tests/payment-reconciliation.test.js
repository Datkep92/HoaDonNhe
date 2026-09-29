'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { insertInvoice, upsertInvoice, setReview } = require('../src/data/repository');
const { normalizePaymentMethod } = require('../src/data/payment-method');
const reconciliation = require('../src/data/reconciliation');
const queries = require('../src/data/queries');

test('chuẩn hóa phương thức thanh toán không suy đoán', () => {
  assert.equal(normalizePaymentMethod('Tiền mặt'), 'CASH');
  assert.equal(normalizePaymentMethod('Chuyển khoản'), 'TRANSFER');
  assert.equal(normalizePaymentMethod('TM/CK'), 'CASH_TRANSFER');
  assert.equal(normalizePaymentMethod(''), 'UNKNOWN');
  assert.equal(normalizePaymentMethod('Bù trừ công nợ'), 'UNKNOWN');
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-payment-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  return { db, close() { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function invoice(over = {}) {
  return { direction: 'SELL', mstBan: '0312345678', mstMua: '0109999999', tenMua: 'Công ty Minh An',
    ngayLap: '2026-09-10', khmsHd: '1', khhHd: 'C26TAA', soHd: '00000100', tongTien: 1000000,
    fileXml: 'C:/invoice.xml', paymentMethodRaw: 'Chuyển khoản', items: [], ...over };
}

function bank(db, over = {}) {
  const now = new Date().toISOString();
  const file = db.prepare(`INSERT INTO bank_files
    (file_name, file_hash, rows_total, rows_imported, imported_at, status) VALUES (?, ?, 1, 1, ?, 'imported')`)
    .run('statement.xlsx', `hash-${Math.random()}`, now);
  const credit = over.credit ?? 1000000;
  db.prepare(`INSERT INTO bank_transactions
    (file_id, tran_date, description, counterparty_name, credit, debit, amount, row_hash, file_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Number(file.lastInsertRowid), over.tranDate || '2026-09-11',
      over.description || 'Thanh toan hoa don', over.partner || 'CONG TY MINH AN', credit, over.debit ?? 0,
      credit, `row-${Math.random()}`, 'statement.xlsx', now, now);
}

test('CASH không đối chiếu; TRANSFER khớp bank; UNKNOWN giữ nguyên', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '100', paymentMethodRaw: 'Tiền mặt' }));
    insertInvoice(f.db, invoice({ soHd: '101', paymentMethodRaw: 'Chuyển khoản' }));
    insertInvoice(f.db, invoice({ soHd: '102', paymentMethodRaw: null }));
    bank(f.db);
    assert.equal(reconciliation.rebuild(f.db).matched, 1);
    const value = reconciliation.summary(f.db);
    assert.equal(value.cashNoBankRequired, 1);
    // MỤC 21/22 — giá trị đi kèm con số: tiền mặt và hoá đơn chuyển khoản.
    assert.equal(value.cashAmount, 1000000, 'giá trị tiền mặt = tổng hoá đơn tiền mặt');
    assert.equal(value.transferAmount, 1000000, 'giá trị hoá đơn chuyển khoản');
    assert.equal(value.transferBankFound, 1);
    assert.equal(value.transferBankNotFound, 0);
    assert.equal(value.paymentMethodUnknown, 1);
  } finally { f.close(); }
});

test('BỘ CHỌN KỲ (mục 1): đối chiếu lọc theo kỳ; "đã chạy" vẫn là TOÀN BỘ database', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '300', ngayLap: '2026-08-05', paymentMethodRaw: 'Tiền mặt' }));
    insertInvoice(f.db, invoice({ soHd: '301', ngayLap: '2026-09-10' }));
    bank(f.db, { tranDate: '2026-09-11' });
    reconciliation.rebuild(f.db);
    const all = reconciliation.summary(f.db);
    assert.equal(all.cashNoBankRequired, 1, 'hoá đơn tiền mặt 05/08');
    assert.equal(all.transferBankFound, 1, 'hoá đơn CK 10/09 khớp sao kê 11/09');
    // Kỳ tháng 8: chỉ hoá đơn tiền mặt của tháng 8 (hoá đơn lọc theo NGÀY LẬP).
    const august = reconciliation.summary(f.db, { from: '2026-08-01', to: '2026-08-31' });
    assert.equal(august.cashNoBankRequired, 1, 'tiền mặt theo NGÀY LẬP trong kỳ');
    assert.equal(august.transferBankFound, 0, 'hoá đơn tháng 9 không vào kỳ tháng 8');
    assert.equal(august.bankTotal, 0, 'sao kê lọc theo NGÀY GIAO DỊCH — giao dịch 11/09 không vào kỳ 8');
    // Kỳ trống: số liệu = 0 nhưng TRẠNG THÁI "đã chạy đối chiếu" không được mất (mục 35).
    const blank = reconciliation.summary(f.db, { from: '2027-01-01', to: '2027-01-31' });
    assert.equal(blank.cashNoBankRequired, 0);
    assert.equal(blank.bankTotal, 0);
    assert.equal(blank.ran, true, 'kỳ trống không được hiện "Chưa chạy đối chiếu"');
  } finally { f.close(); }
});

test('MỤC 3 — phân loại THỦ CÔNG: chỉ ghi đúng giá trị người dùng bấm, không mất dữ liệu XML', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '600' }));                    // XML ghi "Chuyển khoản"
    const id = f.db.prepare('SELECT id FROM invoices').get().id;
    // Bấm "chưa khớp sao kê → tạm ghi tiền mặt".
    const cash = setReview(f.db, { id, action: 'cash_manual' });
    assert.equal(cash.paymentMethod, 'CASH');
    assert.equal(cash.changedMethod, true);
    let stored = f.db.prepare('SELECT payment_method, payment_method_raw, review_status, reviewed_at FROM invoices WHERE id = ?').get(id);
    assert.equal(stored.payment_method, 'CASH');
    assert.equal(stored.payment_method_raw, 'Chuyển khoản', 'payment_method_raw (giá trị gốc từ XML) phải giữ nguyên');
    assert.equal(stored.review_status, 'cash_manual');
    assert.ok(stored.reviewed_at, 'phải ghi thời điểm bấm');
    // Đổi sang "khớp sao kê → chuyển khoản".
    setReview(f.db, { id, action: 'transfer_manual' });
    assert.equal(f.db.prepare('SELECT payment_method FROM invoices WHERE id = ?').get(id).payment_method, 'TRANSFER');
    // Phân loại thuần (không đụng phương thức thanh toán) → payment_method không đổi.
    const plain = setReview(f.db, { id, action: 'missing_docs' });
    assert.equal(plain.changedMethod, false);
    stored = f.db.prepare('SELECT payment_method, review_status FROM invoices WHERE id = ?').get(id);
    assert.equal(stored.payment_method, 'TRANSFER');
    assert.equal(stored.review_status, 'missing_docs');
    // Trạng thái lạ → từ chối, KHÔNG ghi gì.
    assert.throws(() => setReview(f.db, { id, action: 'hack' }), /không hợp lệ/);
    // Nhập lại XML (UPSERT) KHÔNG xoá mất phân loại người dùng đã bấm.
    upsertInvoice(f.db, invoice({ soHd: '600', tongTien: 1000000 }));
    assert.equal(f.db.prepare('SELECT review_status FROM invoices WHERE id = ?').get(id).review_status, 'missing_docs',
      're-import không xoá mất review_status');
  } finally { f.close(); }
});

test('MỤC 5 — debtsDetail: bấm đối tượng ở thẻ Công nợ → đúng các hoá đơn của đối tượng đó', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '500' }));                                   // khách A
    insertInvoice(f.db, invoice({ soHd: '501' }));                                   // khách A lần nữa
    insertInvoice(f.db, invoice({ soHd: '502', tenMua: 'Khách lẻ B' }));             // khách B
    insertInvoice(f.db, invoice({ soHd: '503', direction: 'BUY', ngayLap: '2026-09-12',
      tongTien: 400000, tenBan: 'Nhà cung cấp C' }));                                // nhà cung cấp
    reconciliation.rebuild(f.db);
    const debts = queries.debts(f.db);
    const customers = new Map(debts.customers.map(row => [row.name, row]));
    const suppliers = new Map(debts.suppliers.map(row => [row.name, row]));
    assert.ok(customers.has('Công ty Minh An') && customers.has('Khách lẻ B'));
    assert.ok(suppliers.has('Nhà cung cấp C'));
    // MỖI dòng trên thẻ bấm vào đều ra đúng bằng chứng hoá đơn của CHÍNH đối tượng đó.
    for (const [name, party] of customers) {
      const detail = queries.debtsDetail(f.db, { direction: 'SELL', name });
      assert.equal(detail.count, party.invoices, `số hoá đơn chi tiết của "${name}" phải khớp thẻ`);
      assert.equal(detail.amount, party.amount, `số tiền chi tiết của "${name}" phải khớp thẻ`);
      assert.ok(detail.rows.every(row => row.invoice_key && row.ngay_lap), 'mỗi dòng phải có ngày + khoá hoá đơn để mở xem A4');
    }
    for (const [name, party] of suppliers) {
      const detail = queries.debtsDetail(f.db, { direction: 'BUY', name });
      assert.equal(detail.count, party.invoices);
      assert.equal(detail.amount, party.amount);
    }
    assert.equal(queries.debtsDetail(f.db, { direction: 'SELL', name: 'Công ty Minh An' }).count, 2);
    assert.equal(queries.debtsDetail(f.db, { direction: 'BUY', name: 'Nhà cung cấp C' }).rows[0].tong_tien, 400000);
    // KHÔNG được gộp hai chiều: nhà cung cấp không hiện ra khi hỏi khách hàng.
    assert.equal(queries.debtsDetail(f.db, { direction: 'SELL', name: 'Nhà cung cấp C' }).count, 0);
  } finally { f.close(); }
});

test('MỤC 4 — byDirection: đối chiếu tách khách hàng (bán ra) / nhà cung cấp (mua vào)', () => {
  // Chưa có sao kê: cả hai chiều đều CHƯA KHỚP, nhưng phải tách nhau ra từng chiều.
  const a = fixture();
  try {
    insertInvoice(a.db, invoice({ soHd: '400' }));                                   // SELL 1.000.000
    insertInvoice(a.db, invoice({ soHd: '401', direction: 'BUY', ngayLap: '2026-09-12', tongTien: 500000 }));
    reconciliation.rebuild(a.db);
    const sides = reconciliation.summary(a.db).byDirection;
    assert.equal(sides.SELL.missing, 1);
    assert.equal(sides.SELL.missingAmount, 1000000);
    assert.equal(sides.BUY.missing, 1, 'chiều mua có hoá đơn CK chưa khớp phải tách riêng');
    assert.equal(sides.BUY.missingAmount, 500000);
    assert.equal(sides.SELL.found, 0);
  } finally { a.close(); }
  // Đã có sao kê: khách chuyển tiền vào → chỉ chiều BÁN RA mới khớp được.
  const b = fixture();
  try {
    insertInvoice(b.db, invoice({ soHd: '410' }));
    bank(b.db);
    reconciliation.rebuild(b.db);
    const sides = reconciliation.summary(b.db).byDirection;
    assert.equal(sides.SELL.found, 1, 'khách hàng chuyển tiền vào ⇒ khớp sao kê');
    assert.equal(sides.SELL.foundAmount, 1000000);
    assert.equal(sides.BUY.found + sides.BUY.missing, 0, 'không có hoá đơn mua ⇒ chiều mua trống');
  } finally { b.close(); }
});

test('TRANSFER thiếu bank và bank thiếu invoice đều được báo riêng', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '200', tongTien: 2000000 }));
    bank(f.db, { credit: 5000000, partner: 'KHAC HANG KHAC' });
    reconciliation.rebuild(f.db);
    const value = reconciliation.summary(f.db);
    assert.equal(value.transferBankNotFound, 1);
    assert.equal(value.bankNoInvoice, 1);
  } finally { f.close(); }
});

test('cùng số hóa đơn nhưng khác mẫu, ký hiệu hoặc MST không trùng', () => {
  const f = fixture();
  try {
    assert.equal(insertInvoice(f.db, invoice({ soHd: '100', khmsHd: '25' })).inserted, true);
    assert.equal(insertInvoice(f.db, invoice({ soHd: '100', khmsHd: '26' })).inserted, true);
    assert.equal(insertInvoice(f.db, invoice({ soHd: '100', khmsHd: '25', khhHd: 'C26TBB' })).inserted, true);
    assert.equal(insertInvoice(f.db, invoice({ soHd: '100', khmsHd: '25', mstBan: '0311111111' })).inserted, true);
    assert.equal(insertInvoice(f.db, invoice({ soHd: '000100', khmsHd: '25' })).inserted, false);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// MỤC 13 + MỤC 31: kết quả đối chiếu phải LẠI TỪNG DÒNG (không phải chỉ số đếm).
// ---------------------------------------------------------------------------

const statusOf = (db, soHd) => {
  const row = db.prepare('SELECT reconciliation_status, reconciliation_issues FROM invoices WHERE so_hd = ?').get(soHd);
  return row ? { status: row.reconciliation_status, issues: JSON.parse(row.reconciliation_issues || '[]') } : null;
};
const bankStatusOf = db => {
  const row = db.prepare('SELECT reconciliation_status, reconciliation_issues FROM bank_transactions ORDER BY id').all();
  return row.map(r => ({ status: r.reconciliation_status, issues: JSON.parse(r.reconciliation_issues || '[]') }));
};

test('Case 1+2: CASH ghi CASH_NO_BANK_REQUIRED và KHÔNG chiếm giao dịch; TRANSFER khớp ghi TRANSFER_BANK_FOUND', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '301', paymentMethodRaw: 'Tiền mặt' }));
    insertInvoice(f.db, invoice({ soHd: '302', paymentMethodRaw: 'Chuyển khoản' }));
    bank(f.db); // đúng 1 giao dịch, cùng số tiền với cả hai
    reconciliation.rebuild(f.db);

    const cash = statusOf(f.db, '301');
    assert.equal(cash.status, 'CASH_NO_BANK_REQUIRED');
    assert.deepEqual(cash.issues, [], 'tiền mặt là kết quả bình thường, KHÔNG phải lỗi');

    const transfer = statusOf(f.db, '302');
    assert.equal(transfer.status, 'TRANSFER_BANK_FOUND');
    assert.deepEqual(transfer.issues, []);

    // Giao dịch ngân hàng đã gắn với hóa đơn → chiều ngược lại cũng có trạng thái.
    assert.deepEqual(bankStatusOf(f.db).map(x => x.status), ['MATCH']);
    // Hóa đơn tiền mặt KHÔNG được đưa vào bảng đối chiếu.
    assert.equal(f.db.prepare('SELECT COUNT(*) c FROM reconciliation_matches').get().c, 1);
  } finally { f.close(); }
});

test('Case 3: TRANSFER không có sao kê → TRANSFER_BANK_NOT_FOUND + NEEDS_REVIEW', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '401', tongTien: 7000000 }));
    reconciliation.rebuild(f.db);
    const row = statusOf(f.db, '401');
    assert.equal(row.status, 'TRANSFER_BANK_NOT_FOUND');
    assert.deepEqual(row.issues, ['NEEDS_REVIEW'], 'phải đánh dấu cần kiểm tra, KHÔNG kết luận hóa đơn sai');
    const value = reconciliation.summary(f.db);
    assert.equal(value.transferBankNotFound, 1);
    assert.equal(value.ran, true);
  } finally { f.close(); }
});

test('Case 4: sao kê không có hóa đơn → BANK_NO_INVOICE + NEEDS_REVIEW', () => {
  const f = fixture();
  try {
    bank(f.db, { credit: 30000000 });
    reconciliation.rebuild(f.db);
    assert.deepEqual(bankStatusOf(f.db), [{ status: 'BANK_NO_INVOICE', issues: ['NEEDS_REVIEW'] }]);
    assert.equal(reconciliation.summary(f.db).bankNoInvoice, 1);
  } finally { f.close(); }
});

test('Case 5: khớp nhưng khác số tiền → AMOUNT_MISMATCH + NEEDS_REVIEW trên CẢ hai chiều', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '501', tongTien: 10000000 }));
    bank(f.db, { credit: 9500000 }); // lệch 5% ⇒ vẫn ứng viên, nhưng KHÔNG được coi là khớp tuyệt đối
    reconciliation.rebuild(f.db);

    const row = statusOf(f.db, '501');
    assert.equal(row.status, 'TRANSFER_BANK_FOUND');
    assert.deepEqual(row.issues, ['AMOUNT_MISMATCH', 'NEEDS_REVIEW'], 'một dòng phải nhận được NHIỀU vấn đề');
    assert.deepEqual(bankStatusOf(f.db), [{ status: 'MATCH', issues: ['AMOUNT_MISMATCH', 'NEEDS_REVIEW'] }]);
    const value = reconciliation.summary(f.db);
    assert.equal(value.amountMismatch, 1);
    assert.equal(value.transferNeedsReview, 1);
  } finally { f.close(); }
});

test('Case 6: khớp tiền nhưng khác đối tượng → PARTNER_MISMATCH + NEEDS_REVIEW', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '601', tongTien: 1000000 }));
    // tiền đúng, nhưng nội dung không chứa bất kỳ token nào của khách hàng (Công ty Minh An / MST)
    bank(f.db, { partner: 'TY TNHH SAI KHAC', description: 'Chuyen tien dich vu' });
    reconciliation.rebuild(f.db);
    const row = statusOf(f.db, '601');
    assert.equal(row.status, 'TRANSFER_BANK_FOUND');
    assert.deepEqual(row.issues, ['PARTNER_MISMATCH', 'NEEDS_REVIEW']);
    assert.equal(reconciliation.summary(f.db).partnerMismatch, 1);
  } finally { f.close(); }
});

test('Case 7: thiếu phương thức thanh toán → PAYMENT_METHOD_UNKNOWN + NEEDS_REVIEW, KHÔNG tự đoán', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '701', paymentMethodRaw: null }));
    insertInvoice(f.db, invoice({ soHd: '702', paymentMethodRaw: 'TM/CK' }));
    reconciliation.rebuild(f.db);
    assert.deepEqual(statusOf(f.db, '701'), { status: 'PAYMENT_METHOD_UNKNOWN', issues: ['NEEDS_REVIEW'] });
    assert.deepEqual(statusOf(f.db, '702'), { status: 'PAYMENT_METHOD_AMBIGUOUS', issues: ['NEEDS_REVIEW'] });
    const value = reconciliation.summary(f.db);
    assert.equal(value.paymentMethodUnknown, 1);
    assert.equal(value.paymentMethodAmbiguous, 1);
    // Hai hóa đơn này KHÔNG được đưa vào tập đối chiếu sao kê.
    assert.equal(f.db.prepare('SELECT COUNT(*) c FROM reconciliation_matches').get().c, 0);
  } finally { f.close(); }
});

test('tự chạy lại khi dữ liệu đổi: stale() đúng trước, hết stale sau khi rebuild', () => {
  const f = fixture();
  try {
    assert.equal(reconciliation.stale(f.db), false, 'DB rỗng thì không có gì cũ');
    insertInvoice(f.db, invoice({ soHd: '801' }));
    assert.equal(reconciliation.stale(f.db), true, 'hóa đơn mới chưa có trạng thái');
    reconciliation.rebuild(f.db);
    assert.equal(reconciliation.stale(f.db), false);
    bank(f.db);
    assert.equal(reconciliation.stale(f.db), true, 'giao dịch mới làm kết quả cũ');
    reconciliation.reconcile(f.db);
    assert.equal(reconciliation.stale(f.db), false);
    // Nhập thêm hóa đơn CASH → chỉ cần tính lại, không mất kết quả cũ của hóa đơn TRANSFER.
    insertInvoice(f.db, invoice({ soHd: '802', paymentMethodRaw: 'Tiền mặt' }));
    reconciliation.reconcile(f.db);
    assert.equal(statusOf(f.db, '801').status, 'TRANSFER_BANK_FOUND');
    assert.equal(statusOf(f.db, '802').status, 'CASH_NO_BANK_REQUIRED');
  } finally { f.close(); }
});

test('danh sách cần kiểm tra trả đủ hóa đơn chưa khớp và giao dịch chưa gắn (mục 27)', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '901', tongTien: 5000000, paymentMethodRaw: 'Chuyển khoản' }));
    insertInvoice(f.db, invoice({ soHd: '902', paymentMethodRaw: 'Tiền mặt' }));
    insertInvoice(f.db, invoice({ soHd: '903', paymentMethodRaw: null }));
    bank(f.db, { credit: 8000000 });
    reconciliation.rebuild(f.db);

    const pending = reconciliation.listPending(f.db);
    assert.equal(pending.invoices.filter(r => r.so_hd === '901').length, 1, 'hóa đơn CK thiếu sao kê phải có mặt');
    assert.equal(pending.invoices.filter(r => r.so_hd === '903').length, 1, 'hóa đơn thiếu phương thức phải có mặt');
    assert.equal(pending.invoices.filter(r => r.so_hd === '902').length, 0, 'tiền mặt KHÔNG được đưa vào danh sách cần kiểm tra');
    assert.equal(pending.bank.length, 1, 'giao dịch chưa gắn hóa đơn phải có mặt');
    assert.equal(pending.invoices[0].issues.includes('NEEDS_REVIEW'), true);
  } finally { f.close(); }
});

// MỤC 11/13 — đối chiếu không chỉ nhìn số tiền: ngày lệch quá 7 ngày vẫn khớp (tiền + đối tượng
// đúng) nhưng PHẢI được ghi nhận là DATE_MISMATCH kèm cờ cần kiểm tra.
test('ngày lệch quá 7 ngày: vẫn tìm thấy giao dịch nhưng phải ghi DATE_MISMATCH (mục 11/13)', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '905' }));      // ngày lập 2026-09-10
    bank(f.db, { tranDate: '2026-09-20' });             // lệch 10 ngày
    reconciliation.rebuild(f.db);
    const row = statusOf(f.db, '905');
    assert.equal(row.status, 'TRANSFER_BANK_FOUND', 'tiền + đối tượng khớp ⇒ vẫn tìm thấy giao dịch');
    assert.ok(row.issues.includes('DATE_MISMATCH'), 'lệch >7 ngày phải được ghi nhận');
    assert.ok(row.issues.includes('NEEDS_REVIEW'), 'kèm cờ cần kiểm tra (mục 13)');
    assert.ok(!row.issues.includes('AMOUNT_MISMATCH'), 'tiền khớp tuyệt đối nên không có cờ lệch tiền');
    assert.equal(reconciliation.summary(f.db).dateMismatch, 1, 'số liệu thống kê phải khớp danh sách');
  } finally { f.close(); }
});

// MỤC 12 — GIỚI HẠN của bản này: thuật toán chưa gộp 1 giao dịch cho N hóa đơn (hoặc ngược lại).
// Không được ÉP khớp: cả hai phía phải rơi vào trạng thái "chưa tìm thấy" để người duyệt xem tay.
test('MỤC 12 — 1 giao dịch trả NHIỀU hóa đơn: chưa gộp được ⇒ không ép khớp, báo cả hai phía', () => {
  const f = fixture();
  try {
    insertInvoice(f.db, invoice({ soHd: '910', tongTien: 300000 }));
    insertInvoice(f.db, invoice({ soHd: '911', tongTien: 300000 }));
    insertInvoice(f.db, invoice({ soHd: '912', tongTien: 300000 }));
    bank(f.db, { credit: 900000 });                      // một dòng sao kê = TỔNG cả ba hóa đơn
    reconciliation.rebuild(f.db);
    const value = reconciliation.summary(f.db);
    assert.equal(value.transferBankFound, 0, 'KHÔNG được tự gộp 1 giao dịch cho 3 hóa đơn');
    assert.equal(value.transferBankNotFound, 3, 'cả 3 hóa đơn → CHƯA TÌM THẤY, chờ người duyệt');
    assert.equal(value.bankNoInvoice, 1, 'giao dịch chưa gắn hóa đơn nào → BANK_NO_INVOICE');
    const pending = reconciliation.listPending(f.db);
    assert.equal(pending.invoices.length, 3, 'mục 27 phải liệt kê đủ 3 hóa đơn');
    assert.equal(pending.bank.length, 1, 'mục 27 phải liệt kê giao dịch chưa gắn');
  } finally { f.close(); }
});
