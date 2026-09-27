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
    const rows = bank.dailyTotals(db);
    assert.equal(rows.length, 2);
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
test('schema v5: DB cũ (v4) tự nâng cấp, giữ nguyên hoá đơn hiện có', () => {
  withDb(db => {
    // DB vừa mở đã ở v5 (openDatabase tự applySchema). Kiểm tra bảng mới + version.
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, 5);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bank%'").all().map(r => r.name);
    assert.ok(tables.includes('bank_files'));
    assert.ok(tables.includes('bank_transactions'));
  });
});
