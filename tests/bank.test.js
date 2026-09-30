'use strict';
// ---------------------------------------------------------------------------
// Test SAO KÊ NGÂN HÀNG — tab con trong Kho dữ liệu.
// Che phủ: đọc file Excel + CSV, chuẩn hoá (ngày, số tiền), chống trùng (row_hash),
// import lại cùng file bị từ chối, xoá file, truy vấn phân trang/lọc, tổng hợp theo ngày,
// và sheet "Sao kê ngân hàng" trong xuất Excel. Chạy: npm test
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const XLSX = require('../resources/xlsx.cjs');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { SCHEMA_VERSION } = require('../src/data/schema');
const bank = require('../src/data/bank-statement');
const excelExport = require('../src/data/excel-export');

// ---------------------------------------------------------------- tiện ích
function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-bank-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  try { return fn(db); } finally { closeDatabase(db); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Dựng file sao kê Excel giả lập: 2 dòng tiêu đề trang trí + 1 dòng cột + dữ liệu.
function statementWorkbook(rows) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['NGÂN HÀNG VÍ DỤ', '', '', '', '', ''],
    ['Sao kê giao dịch cá nhân', '', '', '', '', ''],
    ['Ngày giao dịch', 'Nội dung', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư'],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

// ---------------------------------------------------------------- chuẩn hoá
// Bảng tiêu đề dùng chung cho test preview/importRows/move (giống cột ngân hàng VN).
const GRID_HEADER = ['Ngày giao dịch', 'Nội dung', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư'];

function rowsFromGrid(dataRows) {
  return [GRID_HEADER, ...dataRows];
}

test('BỘ CHỌN KỲ (mục 1): bank.summary lọc theo NGÀY GIAO DỊCH, không kỳ thì giữ nguyên', () => {
  withDb(db => {
    const now = new Date().toISOString();
    const add = (date, credit, debit) => {
      const file = db.prepare(`INSERT INTO bank_files
        (file_name, file_hash, rows_total, rows_imported, imported_at, status) VALUES (?, ?, 1, 1, ?, 'imported')`)
        .run('statement.xlsx', `hash-${date}-${Math.random()}`, now);
      db.prepare(`INSERT INTO bank_transactions
        (file_id, tran_date, description, counterparty_name, credit, debit, amount, row_hash, file_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(file.lastInsertRowid), date, 'Thanh toan hoa don', 'KHACH HANG', credit, debit, credit,
          `row-${date}-${Math.random()}`, 'statement.xlsx', now, now);
    };
    add('2026-08-05', 100000, 0);
    add('2026-09-05', 0, 40000);
    const all = bank.summary(db);
    assert.equal(all.transactions, 2, 'không truyền kỳ ⇒ toàn bộ giao dịch');
    assert.equal(all.moneyIn, 100000);
    assert.equal(all.moneyOut, 40000);
    const august = bank.summary(db, { from: '2026-08-01', to: '2026-08-31' });
    assert.equal(august.transactions, 1, 'chỉ giao dịch trong kỳ');
    assert.equal(august.moneyOut, 0, 'giao dịch tháng 9 không vào kỳ tháng 8');
    assert.equal(august.from, '2026-08-05', 'khoảng ngày lấy theo kỳ đang chọn');
    // Giá trị không phải ngày YYYY-MM-DD bị bỏ qua, không nối vào SQL.
    assert.equal(bank.summary(db, { from: 'not-a-date', to: '' }).transactions, 2);
  });
});

test('verifyRows + previewRows: số dư khớp → ok, lệch → warn, không đọc được dòng nào → error', () => {
  // Khớp: 1000 + vào 2000 = 3000; 3000 − ra 500 = 2500.
  const ok = bank.verifyRows([
    { tranDate: '2026-09-26', credit: null, debit: 1000, balance: 1000 },
    { tranDate: '2026-09-27', credit: 2000, debit: null, balance: 3000 },
    { tranDate: '2026-09-28', credit: null, debit: 500, balance: 2500 },
  ]);
  assert.equal(ok.level, 'ok');
  assert.equal(ok.stats.balanceBreaks, 0);

  // Lệch: số dư dòng sau không khớp phép cộng.
  const broken = bank.verifyRows([
    { tranDate: '2026-09-26', credit: null, debit: 1000, balance: 1000 },
    { tranDate: '2026-09-27', credit: 2000, debit: null, balance: 999999 },
  ]);
  assert.equal(broken.level, 'warn');
  assert.equal(broken.stats.balanceBreaks, 1);
  assert.ok(broken.issues.length > 0);

  // Thiếu hẳn số dư: chỉ kiểm tra mức nhẹ, vẫn 'ok' nếu đủ ngày + tiền.
  const noBalance = bank.verifyRows([
    { tranDate: '2026-09-26', credit: 1000, debit: null, balance: null },
    { tranDate: '2026-09-27', credit: null, debit: 250, balance: null },
  ]);
  assert.equal(noBalance.level, 'ok');
  assert.equal(noBalance.stats.balanceChecks, 0);

  // previewRows: bảng thô → chuẩn hoá + kiểm tra, KHÔNG đụng DB.
  const preview = bank.previewRows(rowsFromGrid([
    ['26/09/2026', 'CHUYEN TIEN', 'FT1', '2,000,000', '', '10,000,000'],
    ['27/09/2026', 'THANH TOAN', 'FT2', '', '500,000', '9,500,000'],
  ]));
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.verification.level, 'ok');
  assert.equal(preview.verification.stats.moneyIn, 2000000);
  assert.equal(preview.verification.stats.moneyOut, 500000);

  // Bảng thiếu cột tiền ⇒ lỗi rõ ràng (AI đọc sai cấu trúc chẳng hạn).
  assert.throws(() => bank.previewRows([['Ngày giao dịch', 'Nội dung'], ['26/09/2026', 'A']]), /cột tiền/);
});

// Header lệch cột kiểu Nam Á: ô gộp "Nội dung Phát sinh nợ" đẩy cột tiền dịch 1 vị trí so
// với dữ liệu — resolveMap phải tự hiệu chỉnh bằng số dư liên mạch (chọn cách gán khớp nhiều nhất).
test('resolveMap tự hiệu chỉnh cột tiền/số dư bị lệch bằng số dư liên mạch', () => {
  const grid = [
    ['STT', 'Ngày giao dịch', 'Ngày giá trị', 'Mã GD', 'Nội dung Phát sinh nợ', 'Phát sinh có', 'Số dư', ''],
    ['', '', '', '', '', 'Số dư đầu kỳ', '', '10,000,000'],
    ['1', '01/07/2026', '01/07/2026', 'FT1', 'A chuyen tien', '', '6,500,000', '16,500,000'],
    ['2', '02/07/2026', '02/07/2026', 'FT2', 'B chuyen tien', '', '80,000', '16,580,000'],
    ['3', '03/07/2026', '03/07/2026', 'FT3', 'C chuyen tien', '2,072,026', '', '14,507,974'],
    ['4', '04/07/2026', '04/07/2026', 'FT4', 'D chuyen tien', '1,072,026', '', '13,435,948'],
  ];
  const headerAt = bank.findHeaderRow(grid);
  assert.ok(headerAt >= 0);
  const map = bank.resolveMap(grid, headerAt);
  // Cột dữ liệu thật: nợ (ra) = 5, có (vào) = 6, số dư = 7.
  assert.equal(map.debit, 5);
  assert.equal(map.credit, 6);
  assert.equal(map.balance, 7);
  const preview = bank.previewRows(grid);
  assert.equal(preview.rows.length, 4);
  // Dòng "Số dư đầu kỳ" là TỔNG KẾT, không phải giao dịch ⇒ bỏ qua, không tính là lỗi.
  assert.equal(preview.verification.level, 'ok');
  assert.equal(preview.verification.stats.failed, 0);
  assert.equal(preview.verification.stats.moneyIn, 6_500_000 + 80_000);
  assert.equal(preview.verification.stats.moneyOut, 2_072_026 + 1_072_026);
  assert.equal(preview.verification.stats.balanceBreaks, 0);
});

// Sao kê in NHIỀU DÒNG/giao dịch (kiểu MB Bank): ngày + số CT + mô tả nằm dòng riêng,
// dòng tiền ở cuối nhóm; có ô ngày+tiền dính nhau ("03/04/2026 30.371.250") và tiền ra
// nằm cột header "TXN Date Debit". recomposeStatement phải gộp đúng + suy đúng hướng tiền.
test('recomposeStatement gộp sao kê nhiều dòng/giao dịch (kiểu MB) thành dòng chuẩn', () => {
  const grid = [
    ['STT', 'Ngày giao dịch/ Số tiền ghi nợ Số tiền ghi có', '', 'Số dư', ''],
    ['No', 'TXN Date Debit', 'Credit', 'Balance', ''],
    ['', '01/04/2026', '', '', 'MBVCB.136 HOANG CAO MINH chuyen'],
    ['', '5078 - 78262', '', '', 'HOANG CAO MINH toi #TKP#'],
    ['1', '', '485,000', '34.818.968', ''],
    ['', '02/04/2026', '', '', 'TKP# 5390 - 95493'],
    ['', 'Vo Thi Minh T', '', '', 'chuyen tien'],
    ['2', '', '629,000', '35.447.968', ''],
    ['3', '03/04/2026 30.371.250', '', '5.076.718', 'MBBIZ6060674982.HKD'],
    ['', '', '374,000', '5.450.718', '', 'LE MINH TRUONG chuyen'],
    ['', '04/04/2026', '', '', 'MBB.5136 WATER'],
    ['', '5023 - 78834', '', '', 'WATER 04/2026'],
    ['4', '1.363.768', '', '4.086.950', ''],
  ];
  const preview = bank.previewRows(grid);
  assert.equal(preview.rows.length, 5); // 4 giao dịch thường + 1 dòng mất ngày do ngắt trang (được cứu bằng chuỗi số dư)
  assert.equal(preview.verification.level, 'ok');
  assert.equal(preview.verification.stats.failed, 0);
  assert.equal(preview.verification.stats.moneyIn, 485_000 + 629_000 + 374_000);
  assert.equal(preview.verification.stats.moneyOut, 30_371_250 + 1_363_768);
  assert.equal(preview.verification.stats.balanceBreaks, 0);
});

test('importRows: nhập từ bảng đã preview (không có file gốc), chặn nhập lại cùng dữ liệu', () => {
  withDb(db => {
    const grid = rowsFromGrid([
      ['26/09/2026', 'CHUYEN TIEN', 'FT1', '2,000,000', '', '10,000,000'],
    ]);
    const first = bank.importRows(db, { fileName: 'ai-bang.json', fileHash: '', rows: grid });
    assert.equal(first.imported, 1);
    // Nhập lại cùng bảng (không fileHash) ⇒ chặn theo hash nội dung.
    assert.throws(() => bank.importRows(db, { fileName: 'ai-bang.json', fileHash: '', rows: grid }), /đã nhập trước đó/);
    // Có fileHash riêng thì hash nội dung bị bỏ qua (file gốc khác) — dòng trùng row_hash thành duplicate.
    const second = bank.importRows(db, { fileName: 'file-khac.pdf', fileHash: 'khac', rows: grid });
    assert.equal(second.imported, 0);
    assert.equal(second.duplicate, 1);
  });
});

test('luồng UI: previewRows → dựng lại grid (ngày ISO) → importRows KHÔNG làm mất Nội dung', () => {
  // Tái hiện đúng đường đi của nút "Nhập file": server /preview-rows trả về các dòng đã
  // chuẩn hoá (tranDate dạng ISO yyyy-mm-dd); UI gửi lại chính các dòng đó cho /import-rows,
  // ở đó server dựng lại grid rồi gọi importRows (chạy recomposeStatement LẦN HAI). Bản cũ
  // không nhận ISO là ngày ⇒ coi mọi dòng là "dòng chốt bị tách", gộp lại sai cột ⇒ Nội dung rỗng.
  withDb(db => {
    const grid = rowsFromGrid([
      ['26/09/2026', 'NGUYEN VAN A chuyen tien', 'FT1', '2,000,000', '', '10,000,000'],
      ['27/09/2026', 'Tra tien dien EVN', 'FT2', '', '500,000', '9,500,000'],
      ['28/09/2026', 'Rut tien mat', 'FT3', '', '1,000,000', '8,500,000'],
    ]);
    const preview = bank.previewRows(grid);
    assert.equal(preview.rows.length, 3);
    assert.ok(preview.rows.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.tranDate))); // ngày đã thành ISO
    // Dựng lại grid y như endpoint /api/db/bank/import-rows làm từ các dòng đã chuẩn hoá.
    const rebuilt = [[
      'Ngày giao dịch', 'Ngày hiệu lực', 'Nội dung', 'Chi tiết', 'Tên đối ứng', 'TK đối ứng',
      'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư', 'Loại tiền',
    ], ...preview.rows.map(r => [
      r.tranDate || '', r.valueDate || '', r.description || '', r.detail || '', r.counterpartyName || '',
      r.counterpartyAccount || '', r.reference || '',
      r.credit == null ? '' : String(r.credit), r.debit == null ? '' : String(r.debit),
      r.balance == null ? '' : String(r.balance), r.currency || 'VND',
    ])];
    const result = bank.importRows(db, { fileName: 'sao-ke.pdf', fileHash: '', rows: rebuilt });
    assert.equal(result.imported, 3);
    assert.equal(result.failed, 0);
    const empty = db.prepare("SELECT COUNT(*) c FROM bank_transactions WHERE description IS NULL OR TRIM(description)=''").get();
    assert.equal(empty.c, 0); // mọi dòng phải giữ được Nội dung
    const list = bank.listTransactions(db, { limit: 10 });
    const descs = list.rows.map(t => t.description).sort();
    assert.deepEqual(descs, ['NGUYEN VAN A chuyen tien', 'Rut tien mat', 'Tra tien dien EVN']);
  });
});

// ------------------------------------------------- chuẩn hoá lặp (idempotence)
// BẤT BIẾN: chạy pipeline chuẩn hoá HAI lần cho ra kết quả Y HỆT chạy MỘT lần.
// Đây chính là lỗi từng xảy ra: UI xem trước (/preview-rows) → server trả về các dòng
// ĐÃ chuẩn hoá (ngày ISO) → UI gửi lại cho /import-rows → server dựng lại grid rồi
// chạy recomposeStatement LẦN HAI. Bản cũ không nhận ISO là ngày nên tưởng mọi dòng
// là "dòng chốt bị tách", gộp sai cột và xoá sạch Nội dung. Bộ test này khoá bất biến
// trên nhiều định dạng sao kê để mọi lỗi gộp lặp tương tự bị chặn.

const IDEMPOTENT_CASES = [
  ['chuẩn 1 dòng = 1 giao dịch, ngày dd/mm/yyyy', rowsFromGrid([
    ['01/07/2026', 'NGUYEN THI KIM THOA chuyen tien', 'FT1', '2,000,000', '', '10,000,000'],
    ['02/07/2026', 'Rut tien mat tai ATM', 'FT2', '', '500,000', '9,500,000'],
    ['03/07/2026', 'Thanh toan hoa don dien EVN', 'FT3', '', '1,000,000', '8,500,000'],
  ]), 3],
  ['ngày đã ở dạng ISO yyyy-mm-dd trong file gốc', rowsFromGrid([
    ['2026-07-01', 'Chuyen khoan tien hang', 'FT1', '2,000,000', '', '10,000,000'],
    ['2026-07-02', 'Rut tien mat', 'FT2', '', '500,000', '9,500,000'],
    ['2026-07-03', 'Tra tien dien EVN', 'FT3', '', '1,000,000', '8,500,000'],
  ]), 3],
  ['có thêm cột Ngày hiệu lực', [
    ['Ngày giao dịch', 'Ngày hiệu lực', 'Nội dung', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư'],
    ['01/07/2026', '02/07/2026', 'Thu tien ABC', 'FT1', '2,000,000', '', '10,000,000'],
    ['02/07/2026', '03/07/2026', 'Rut tien mat', 'FT2', '', '500,000', '9,500,000'],
    ['03/07/2026', '04/07/2026', 'Tra tien dien', 'FT3', '', '1,000,000', '8,500,000'],
  ], 3],
  ['một cột "Số tiền" đơn, dương = vào / âm = ra', [
    ['Ngày giao dịch', 'Diễn giải', 'Mã giao dịch', 'Số tiền', 'Số dư'],
    ['01/07/2026', 'Thu tien ABC', 'FT1', '2,000,000', '10,000,000'],
    ['02/07/2026', 'Rut tien mat', 'FT2', '-500,000', '9,500,000'],
    ['03/07/2026', 'Tra tien dien', 'FT3', '-1,000,000', '8,500,000'],
  ], 3],
  ['header THIẾU tên cột Nội dung (phải tự dò cột chữ)', [
    ['Ngày giao dịch', 'Mã GD', '', 'Tiền vào', 'Tiền ra', 'Số dư'],
    ['01/07/2026', 'FT001', 'Nguyen Van A chuyen tien', '2,000,000', '', '10,000,000'],
    ['02/07/2026', 'FT002', 'Rut tien mat ATM', '', '500,000', '9,500,000'],
    ['03/07/2026', 'FT003', 'Thanh toan hoa don dien', '', '1,000,000', '8,500,000'],
  ], 3],
  ['sao kê nhiều dòng/giao dịch (kiểu MB) — đi qua đường GỘP DÒNG', [
    ['STT', 'Ngày giao dịch/ Số tiền ghi nợ Số tiền ghi có', '', 'Số dư', ''],
    ['No', 'TXN Date Debit', 'Credit', 'Balance', ''],
    ['', '01/04/2026', '', '', 'MBVCB.136 HOANG CAO MINH chuyen'],
    ['', '5078 - 78262', '', '', 'HOANG CAO MINH toi #TKP#'],
    ['1', '', '485,000', '34.818.968', ''],
    ['', '02/04/2026', '', '', 'TKP# 5390 - 95493'],
    ['', 'Vo Thi Minh T', '', '', 'chuyen tien'],
    ['2', '', '629,000', '35.447.968', ''],
    ['3', '03/04/2026 30.371.250', '', '5.076.718', 'MBBIZ6060674982.HKD'],
    ['', '', '374,000', '5.450.718', '', 'LE MINH TRUONG chuyen'],
    ['', '04/04/2026', '', '', 'MBB.5136 WATER'],
    ['', '5023 - 78834', '', '', 'WATER 04/2026'],
    ['4', '1.363.768', '', '4.086.950', ''],
  ], 5],
];

// Chạy đủ vòng lặp UI: grid thô → previewRows → dựng lại grid → previewRows lần 2.
function roundTrip(rows) {
  const first = bank.previewRows(rows);
  const second = bank.previewRows(bank.normalizedRowsToGrid(first.rows));
  return { first, second };
}

test('BẤT BIẾN — chuẩn hoá HAI lần cho kết quả y hệt MỘT lần (mọi định dạng)', () => {
  for (const [name, grid, expectRows] of IDEMPOTENT_CASES) {
    const { first, second } = roundTrip(grid);
    assert.equal(first.rows.length, expectRows, `${name}: số dòng vòng 1`);
    assert.deepEqual(second.rows, first.rows, `${name}: vòng 2 LỆCH vòng 1`);
    assert.deepEqual(second.verification, first.verification, `${name}: kết quả kiểm tra lệch`);
    assert.ok(first.rows.every(row => row.description), `${name}: có dòng mất Nội dung ngay vòng 1`);
    assert.ok(first.rows.every(row => row.tranDate), `${name}: có dòng mất ngày giao dịch`);
  }
});

test('BẤT BIẾN — nhập DB qua vòng 2 KHÔNG làm mất Nội dung (mọi định dạng)', () => {
  for (const [name, grid, expectRows] of IDEMPOTENT_CASES) {
    withDb(db => {
      const { second } = roundTrip(grid);
      const result = bank.importRows(db, {
        fileName: `${name}.pdf`, fileHash: '', rows: bank.normalizedRowsToGrid(second.rows),
      });
      assert.equal(result.imported, expectRows, `${name}: số dòng nhập`);
      assert.equal(result.failed, 0, `${name}: có dòng lỗi`);
      const empty = db.prepare("SELECT COUNT(*) c FROM bank_transactions WHERE description IS NULL OR TRIM(description)=''").get();
      assert.equal(empty.c, 0, `${name}: Nội dung rỗng sau khi nhập`);
    });
  }
});

test('BẤT BIẾN — grid đã chuẩn hoá (ngày ISO) là NO-OP qua recomposeStatement', () => {
  // Chốt đúng lỗi cũ: recomposeStatement phải NHẬN RA ngày ISO là ngày, nếu không nó
  // gộp lại các dòng đã-chuẩn-hoá và làm rỗng cột Nội dung.
  const normalized = [
    { tranDate: '2026-07-01', valueDate: null, description: 'Thu tien ABC', detail: '', counterpartyName: '', counterpartyAccount: '', reference: 'FT1', credit: 2_000_000, debit: null, balance: 10_000_000, currency: 'VND' },
    { tranDate: '2026-07-02', valueDate: null, description: 'Rut tien mat', detail: '', counterpartyName: '', counterpartyAccount: '', reference: 'FT2', credit: null, debit: 500_000, balance: 9_500_000, currency: 'VND' },
    { tranDate: '2026-07-03', valueDate: null, description: 'Tra tien dien', detail: '', counterpartyName: '', counterpartyAccount: '', reference: 'FT3', credit: null, debit: 1_000_000, balance: 8_500_000, currency: 'VND' },
  ];
  const grid = bank.normalizedRowsToGrid(normalized);
  assert.deepEqual(bank.recomposeStatement(grid), grid); // không gộp: giữ nguyên số cột + thứ tự
  const again = bank.previewRows(grid);
  assert.deepEqual(again.rows.map(r => r.description), ['Thu tien ABC', 'Rut tien mat', 'Tra tien dien']);
});

// ------------------------------------------------ bộ đọc thống nhất (mọi định dạng)
// "Đuôi file không nói lên định dạng": ngân hàng hay xuất .xls mà thực chất là HTML
// <table>, SpreadsheetML XML 2003, hoặc CSV đội lốt. Bộ đọc phải nhận diện theo NỘI DUNG
// và cho ra cùng một bảng chuẩn. Test khoá đúng hành vi đó.

const FORMAT_DATA = [
  ['01/07/2026', 'NGUYEN THI KIM THOA chuyen tien', 'FT1', '2,000,000', '', '10,000,000'],
  ['02/07/2026', 'Rut tien mat tai ATM', 'FT2', '', '500,000', '9,500,000'],
  ['03/07/2026', 'Thanh toan hoa don dien EVN', 'FT3', '', '1,000,000', '8,500,000'],
];
const FORMAT_HEADER = ['Ngày giao dịch', 'Nội dung', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư'];

function assertReadsAsStatement(buffer, fileName) {
  const grid = bank.parseWorkbookBuffer(buffer, fileName);
  const pv = bank.previewRows(grid);
  assert.equal(pv.rows.length, 3, `${fileName}: số giao dịch`);
  assert.equal(pv.verification.level, 'ok', `${fileName}: số dư phải khớp`);
  assert.ok(pv.rows.every(r => r.description), `${fileName}: thiếu Nội dung`);
  assert.deepEqual(pv.rows.map(r => r.tranDate), ['2026-07-01', '2026-07-02', '2026-07-03'], `${fileName}: ngày`);
}

test('bộ đọc thống nhất: HTML table, SpreadsheetML XML, CSV bọc nháy kép, Excel nhiều sheet', () => {
  const html = `<html><body><table>
    <tr><td colspan="6">NGÂN HÀNG VÍ DỤ</td></tr>
    <tr>${FORMAT_HEADER.map(h => `<td>${h}</td>`).join('')}</tr>
    ${FORMAT_DATA.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}
  </table></body></html>`;
  assertReadsAsStatement(Buffer.from(html, 'utf8'), 'sao-ke.xls');

  const cell = v => `<Cell><Data ss:Type="String">${v}</Data></Cell>`;
  const xmlRows = [FORMAT_HEADER, ...FORMAT_DATA].map(row => `<Row>${row.map(c => cell(c)).join('')}</Row>`).join('');
  const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Sheet1"><Table>${xmlRows}</Table></Worksheet></Workbook>`;
  assertReadsAsStatement(Buffer.from(xml, 'utf8'), 'sao-ke.xls');

  // CSV: ô Nội dung bọc nháy kép nên chứa được dấu phẩy — tách đúng thì mới không lệch cột.
  const csv = [FORMAT_HEADER.join(','),
    '"01/07/2026","Chuyen tien, phi 5,000d","FT1","2,000,000","","10,000,000"',
    '"02/07/2026","Rut tien mat","FT2","","500,000","9,500,000"',
    '"03/07/2026","Thanh toan hoa don","FT3","","1,000,000","8,500,000"'].join('\n');
  assertReadsAsStatement(Buffer.from('\ufeff' + csv, 'utf8'), 'sao-ke.csv');

  // Excel nhiều sheet: bìa trống + sheet dữ liệu ⇒ phải chọn đúng sheet DỮ LIỆU.
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Trang bìa'], ['Ngân hàng']]), 'Bia');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([FORMAT_HEADER, ...FORMAT_DATA]), 'SaoKe');
  assertReadsAsStatement(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'sao-ke.xlsx');
});

test('suy luận cột theo NỘI DUNG: file KHÔNG có dòng tiêu đề vẫn đọc đúng ngày/tiền/nội dung', () => {
  const pv = bank.previewRows(FORMAT_DATA.map(r => r));
  assert.equal(pv.rows.length, 3);
  assert.equal(pv.verification.level, 'ok');
  assert.deepEqual(pv.rows.map(r => r.tranDate), ['2026-07-01', '2026-07-02', '2026-07-03']);
  assert.ok(pv.rows.every(r => r.description), 'không dòng nào được mất Nội dung');
  assert.deepEqual(pv.rows.map(r => r.credit), [2_000_000, null, null]);
  assert.deepEqual(pv.rows.map(r => r.debit), [null, 500_000, 1_000_000]);
});

test('bỏ dòng "Số dư đầu kỳ/cuối kỳ" — không phải giao dịch, KHÔNG tính là dòng lỗi', () => {
  const grid = [['Số dư đầu kỳ/Opening balance', '', '', '', '', '8,500,000'],
    ...FORMAT_DATA.map(r => r), ['Số dư cuối kỳ/Closing balance', '', '', '', '', '8,500,000']];
  const pv = bank.previewRows(grid);
  assert.equal(pv.rows.length, 3, 'chỉ còn 3 giao dịch thật');
  assert.equal(pv.verification.stats.failed, 0, 'không đếm dòng tổng kết là lỗi');
  assert.equal(pv.verification.level, 'ok');
});

test('moveFileToMst: chép file + giao dịch sang DB đích rồi xoá ở DB nguồn', () => {
  withDb(sourceDb => {
    withDb(targetDb => {
      const grid = rowsFromGrid([
        ['26/09/2026', 'CHUYEN TIEN', 'FT1', '2,000,000', '', '10,000,000'],
        ['27/09/2026', 'THANH TOAN', 'FT2', '', '500,000', '9,500,000'],
      ]);
      const imported = bank.importRows(sourceDb, { fileName: 'sao-ke.pdf', fileHash: 'hash-x', rows: grid });
      const result = bank.moveFileToMst(sourceDb, targetDb, { fileId: imported.fileId, toMst: '0987654321' });
      assert.equal(result.moved, 2);
      assert.equal(result.duplicate, 0);
      // Nguồn hết sạch; đích đủ 2 giao dịch.
      assert.equal(bank.summary(sourceDb).transactions, 0);
      assert.equal(bank.summary(targetDb).transactions, 2);
      // Chuyển lần nữa thì báo file đích đã có.
      const again = bank.importRows(sourceDb, { fileName: 'sao-ke.pdf', fileHash: 'hash-x', rows: grid });
      assert.throws(() => bank.moveFileToMst(sourceDb, targetDb, { fileId: again.fileId, toMst: '0987654321' }), /đã có chính file này/);
    });
  });
});

test('parseMoney: các kiểu số tiền của ngân hàng Việt Nam', () => {
  assert.equal(bank.parseMoney('1,234,567'), 1234567);
  assert.equal(bank.parseMoney('1.234.567'), 1234567);
  assert.equal(bank.parseMoney('1.234.567,89'), 1234567.89);
  assert.equal(bank.parseMoney('1,234,567.89'), 1234567.89);
  assert.equal(bank.parseMoney('1 234 567đ'), 1234567);
  assert.equal(bank.parseMoney('-500,000'), -500000);
  assert.equal(bank.parseMoney(''), null);
  assert.equal(bank.parseMoney('---'), null);
  assert.equal(bank.parseMoney('KHONG CO TIEN'), null);
});

test('parseDate: dd/mm/yyyy, yyyy-mm-dd, d-m-yyyy 2 chữ số năm, Excel serial', () => {
  assert.equal(bank.parseDate('27/09/2026'), '2026-09-27');
  assert.equal(bank.parseDate('5/3/2026'), '2026-03-05');
  assert.equal(bank.parseDate('2026-09-27'), '2026-09-27');
  assert.equal(bank.parseDate('27-09-26'), '2026-09-27');
  assert.equal(bank.parseDate('46292'), '2026-09-27'); // Excel serial
  assert.equal(bank.parseDate(''), null);
});

test('findHeaderRow + mapColumns: bỏ qua dòng quảng cáo đầu file', () => {
  const rows = [
    ['NGÂN HÀNG ABC', '', ''],
    ['Sao kê tháng 9', '', ''],
    ['Ngày giao dịch', 'Diễn giải', 'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư'],
    ['27/09/2026', 'CHUYEN TIEN', 'FT2627', '1,000,000', '', '5,000,000'],
  ];
  const headerAt = bank.findHeaderRow(rows);
  assert.equal(headerAt, 2);
  const map = bank.mapColumns(rows[headerAt]);
  assert.equal(map.tranDate, 0);
  assert.equal(map.description, 1);
  assert.equal(map.reference, 2);
  assert.equal(map.credit, 3);
  assert.equal(map.debit, 4);
  assert.equal(map.balance, 5);
});

test('normalizeRow: số tiền âm trong cột Tiền vào dồn sang Tiền ra; thiếu ngày = lỗi', () => {
  const map = { tranDate: 0, description: 1, credit: 2, debit: 3 };
  const ok = bank.normalizeRow(['27/09/2026', 'NAP TIEN', '-500,000', ''], map);
  assert.equal(ok.row.credit, null);
  assert.equal(ok.row.debit, 500000);
  const bad = bank.normalizeRow(['', 'KHONG NGAY', '', ''], map);
  assert.ok(bad.error);
});

// ---------------------------------------------------------------- nhập SQLite
test('importWorkbook: nhập file Excel vào SQLite, thống kê đúng', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['26/09/2026', 'CHUYEN TIEN DEN - CONG TY A', 'FT2626A', '10,500,000', '', '20,500,000'],
      ['27/09/2026', 'THANH TOAN DIEN NUOC', 'FT2627B', '', '250,000', '20,250,000'],
      ['27/09/2026', 'RUT TIEN ATM', 'FT2627C', '', '2,000,000', '18,250,000'],
    ]);
    const result = bank.importWorkbook(db, { buffer, fileName: 'sao-ke-09.xlsx' });
    assert.equal(result.imported, 3);
    assert.equal(result.duplicate, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.minDate, '2026-09-26');
    assert.equal(result.maxDate, '2026-09-27');

    const summary = bank.summary(db);
    assert.equal(summary.transactions, 3);
    assert.equal(summary.moneyIn, 10500000);
    assert.equal(summary.moneyOut, 2250000);
    assert.equal(summary.files, 1);
  });
});

test('importWorkbook: CSV tự tách cột (dấu phẩy/phẩy chấm/tab)', () => {
  withDb(db => {
    const csv = [
      'Ngày giao dịch,Nội dung,Tiền vào,Tiền ra,Số dư',
      '26/09/2026,CHUYEN TIEN,1000000,,5000000',
      '27/09/2026,THANH TOAN,,200000,4800000',
    ].join('\n');
    const result = bank.importWorkbook(db, { buffer: Buffer.from(csv, 'utf8'), fileName: 'sao-ke.csv' });
    assert.equal(result.imported, 2);
    assert.equal(bank.summary(db).transactions, 2);
  });
});

test('chống trùng (§26): nhập lại CÙNG file bị từ chối; giao dịch trùng KHÔNG nhân đôi', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['26/09/2026', 'CHUYEN TIEN - CONG TY A', 'FT2626A', '10,500,000', '', '20,500,000'],
    ]);
    bank.importWorkbook(db, { buffer, fileName: 'sao-ke-09.xlsx' });
    assert.throws(() => bank.importWorkbook(db, { buffer, fileName: 'sao-ke-09.xlsx' }), /đã nhập trước đó/);

    // File KHÁC nhưng chứa cùng giao dịch (cùng ngày + tiền + nội dung + mã GD) → bỏ qua, không lỗi.
    const other = statementWorkbook([
      ['26/09/2026', 'CHUYEN TIEN - CONG TY A', 'FT2626A', '10,500,000', '', '20,500,000'],
      ['28/09/2026', 'GD MOI', 'FT2628X', '1,000', '', '20,501,000'],
    ]);
    const result = bank.importWorkbook(db, { buffer: other, fileName: 'sao-ke-09-copy.xlsx' });
    assert.equal(result.imported, 1);      // chỉ giao dịch mới
    assert.equal(result.duplicate, 1);     // giao dịch trùng bị bỏ
    assert.equal(bank.summary(db).transactions, 2);
  });
});

test('deleteFile: xoá file xoá luôn giao dịch của file đó', () => {
  withDb(db => {
    const buffer = statementWorkbook([['26/09/2026', 'GD', 'FT1', '1000', '', '1000']]);
    const result = bank.importWorkbook(db, { buffer, fileName: 'a.xlsx' });
    bank.deleteFile(db, result.fileId);
    assert.equal(bank.summary(db).files, 0);
    assert.equal(bank.summary(db).transactions, 0);
    assert.throws(() => bank.deleteFile(db, 9999), /Không tìm thấy/);
  });
});

// ---------------------------------------------------------------- truy vấn
test('listTransactions: phân trang + lọc chiều vào/ra + tìm kiếm', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['25/09/2026', 'TIEN BAN HANG - CONG TY B', 'FT25', '5,000,000', '', '15,000,000'],
      ['26/09/2026', 'CHUYEN TIEN DEN - CONG TY A', 'FT26', '10,500,000', '', '25,500,000'],
      ['27/09/2026', 'THANH TOAN DIEN NUOC', 'FT27', '', '250,000', '25,250,000'],
      ['28/09/2026', 'RUT TIEN ATM', 'FT28', '', '2,000,000', '23,250,000'],
    ]);
    bank.importWorkbook(db, { buffer, fileName: 'sao-ke.xlsx' });

    const all = bank.listTransactions(db, {});
    assert.equal(all.total, 4);
    assert.equal(all.rows[0].tran_date, '2026-09-28'); // mới nhất trước

    const page = bank.listTransactions(db, { limit: 2, offset: 2 });
    assert.equal(page.total, 4);
    assert.equal(page.rows.length, 2);

    const moneyIn = bank.listTransactions(db, { flow: 'in' });
    assert.equal(moneyIn.total, 2);

    const search = bank.listTransactions(db, { q: 'CONG TY A' });
    assert.equal(search.total, 1);
    assert.match(search.rows[0].description, /CONG TY A/);

    const byDate = bank.listTransactions(db, { from: '2026-09-27', to: '2026-09-28' });
    assert.equal(byDate.total, 2);

    // Khoảng tiền: áp lên số tiền giao dịch (tiền vào nếu có, không thì tiền ra).
    const big = bank.listTransactions(db, { min: '3000000' }); // chỉ 2 giao dịch tiền vào
    assert.equal(big.total, 2);
    assert.ok(big.rows.every(r => r.credit > 0));
    const under300k = bank.listTransactions(db, { max: '300000' }); // chỉ 250,000 tiền ra
    assert.equal(under300k.total, 1);
    assert.equal(under300k.rows[0].debit, 250000);
    const band = bank.listTransactions(db, { min: '100', max: '1000000' });
    assert.equal(band.total, 1);
  });
});

test('dailyTotals: gộp tiền vào/ra theo ngày', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['27/09/2026', 'A', 'FT27A', '1,000', '', '1,000'],
      ['27/09/2026', 'B', 'FT27B', '', '300', '700'],
      ['28/09/2026', 'C', 'FT28', '2,000', '', '2,700'],
    ]);
    bank.importWorkbook(db, { buffer, fileName: 's.xlsx' });
    // dailyTotals trả { rows, truncated, totalDays, firstDay, limit }: kèm cờ báo đã cắt bớt
    // để giao diện nói rõ thay vì vẽ thiếu trong im lặng.
    const daily = bank.dailyTotals(db);
    const rows = daily.rows;
    assert.equal(rows.length, 2);
    assert.equal(daily.truncated, false);
    assert.equal(daily.totalDays, 2);
    const day27 = rows.find(r => r.day === '2026-09-27');
    assert.equal(day27.transactions, 2);
    assert.equal(day27.money_in, 1000);
    assert.equal(day27.money_out, 300);
  });
});

// ---------------------------------------------------------------- xuất Excel
test('Xuất Excel: sheet "Sao kê ngân hàng" theo bộ lọc đang xem', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['26/09/2026', 'CHUYEN TIEN DEN', 'FT26', '10,500,000', '', '20,500,000'],
      ['27/09/2026', 'THANH TOAN', 'FT27', '', '250,000', '20,250,000'],
    ]);
    bank.importWorkbook(db, { buffer, fileName: 'sao-ke.xlsx' });

    const { buffer: xlsx, counts } = excelExport.buildWorkbook(db, {}, ['bank']);
    assert.equal(counts.bank, 2);
    const book = XLSX.read(xlsx, { type: 'buffer' });
    assert.deepEqual(book.SheetNames, ['Sao kê ngân hàng']);
    const rows = XLSX.utils.sheet_to_json(book.Sheets['Sao kê ngân hàng'], { header: 1 });
    assert.deepEqual(rows[0], excelExport.BANK_HEADERS);
    // Sắp MỚI NHẤT trước (giống màn hình): dòng đầu là 27/09 (tiền ra), sau là 26/09 (tiền vào).
    assert.equal(rows[1][1], '27/09/2026');   // ngày dd/mm/yyyy
    assert.equal(rows[2][1], '26/09/2026');
    assert.equal(rows[1][6], 250000);         // tiền ra giữ số để Excel cộng được
    assert.equal(rows[2][5], 10500000);       // tiền vào

    // Lọc theo from → chỉ còn giao dịch 27/09.
    const filtered = excelExport.buildWorkbook(db, { from: '2026-09-27' }, ['bank']);
    assert.equal(filtered.counts.bank, 1);
  });
});

// ---------------------------------------------------------------- schema
test('schema hiện hành: DB cũ tự nâng cấp, giữ nguyên dữ liệu', () => {
  withDb(db => {
    // openDatabase tự applySchema. Kiểm tra bảng mới + version hiện hành.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bank%'").all().map(r => r.name);
    assert.ok(tables.includes('bank_files'));
    assert.ok(tables.includes('bank_transactions'));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reconciliation_matches'").get());
  });
});

test('Phase 1: transaction categories, filters and opening/closing balances', () => {
  withDb(db => {
    const buffer = statementWorkbook([
      ['27/09/2026', 'KHACH HANG THANH TOAN', 'FT27', '1,000', '', '11,000'],
      ['28/09/2026', 'TRA NHA CUNG CAP', 'FT28', '', '300', '10,700'],
    ]);
    bank.importWorkbook(db, { buffer, fileName: 'phase-1.xlsx' });

    const before = bank.summary(db);
    assert.equal(before.openingBalance, 10000);
    assert.equal(before.closingBalance, 10700);
    assert.equal(before.uncategorized, 2);

    const transaction = bank.listTransactions(db, { flow: 'in' }).rows[0];
    bank.setCategory(db, { id: transaction.id, category: 'Khách hàng thanh toán' });
    assert.equal(bank.listTransactions(db, { category: 'Khách hàng thanh toán' }).total, 1);
    assert.equal(bank.listTransactions(db, { category: '__uncategorized__' }).total, 1);
    assert.equal(bank.summary(db).uncategorized, 1);

    bank.createCategory(db, { name: '  Chi phí quảng cáo  ', color: '#123abc' });
    const catalog = bank.categories(db);
    assert.ok(catalog.defaults.some(item => item.name === 'Thuế, phí'));
    assert.equal(catalog.custom.length, 1);
    assert.equal(catalog.custom[0].name, 'Chi phí quảng cáo');
    assert.equal(catalog.custom[0].color, '#123abc');

    bank.setCategory(db, { id: transaction.id, category: '' });
    assert.equal(bank.summary(db).uncategorized, 2);
  });
});
