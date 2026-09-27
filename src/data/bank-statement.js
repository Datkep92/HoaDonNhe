'use strict';
// ---------------------------------------------------------------------------
// SAO KÊ NGÂN HÀNG — tab con trong "Kho dữ liệu" (tài liệu "tạo tab chuẩn hoá
// sao kê ngân hàng và lưu dữ liệu SQLite.md", rút gọn về phần JS làm được chắc chắn):
//
//   File Excel/CSV → đọc thô → CHUẨN HÓA (JS) → VALIDATE (JS) → SQLITE
//
// Nguyên tắc giữ đúng tài liệu (§16, §24, §26, §50):
//   • JS chuẩn hoá ngày + số tiền, KHÔNG dùng AI cho việc máy làm được chắc chắn.
//   • SQLite là kho dữ liệu chuẩn cuối; dữ liệu gắn với MST đang chọn (1 MST = 1 data.db).
//   • Chống trùng bằng row_hash UNIQUE: nhập lại cùng file không sinh giao dịch thứ hai.
//   • KHÔNG đụng pipeline hoá đơn hiện có — module mới, tái dùng đúng chỗ có sẵn:
//       - đọc Excel: resources/xlsx.cjs (cùng nguồn với excel-export.js)
//       - ngày:      src/vn-date.js
//       - SQLite:    src/data/sqlite.js (withTransaction, bảng khai trong schema.js v5)
// ---------------------------------------------------------------------------

const XLSX = require('../../resources/xlsx.cjs');
const crypto = require('node:crypto');
const vnDate = require('../vn-date');

// ---------------------------------------------------------------------------
// ĐỌC FILE THÔ → bảng chuỗi (mảng mảng). Excel đọc bằng SheetJS; CSV tự tách cột
// (dấu phẩy/chấm phẩy/tab tự nhận) để hỗ trợ file ngân hàng xuất CSV.
// ---------------------------------------------------------------------------

function detectDelimiter(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': (head.match(/,/g) || []).length, ';': (head.match(/;/g) || []).length, '\t': (head.match(/\t/g) || []).length };
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
}

function parseCsv(text) {
  const delimiter = detectDelimiter(text);
  return String(text || '').split(/\r?\n/).filter(line => line.trim() !== '')
    .map(line => line.split(delimiter).map(cell => cell.trim()));
}

function sheetToRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    .map(row => row.map(cell => (cell === null || cell === undefined ? '' : String(cell).trim())));
}

// Bảng chuỗi thô (mảng mảng) — bỏ dòng trống toàn rỗng.
function cleanRows(rows) {
  return rows.filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
}

// ---------------------------------------------------------------------------
// CHUẨN HÓA
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  tranDate: ['ngày giao dịch', 'ngay giao dich', 'ngày gd', 'ngày', 'transaction date', 'posting date', 'ngày ghi sổ', 'ngày hợp lệ'],
  valueDate: ['ngày hiệu lực', 'ngày giá trị', 'value date'],
  description: ['nội dung', 'diễn giải', 'mô tả', 'description', 'nội dung giao dịch', 'chi tiết giao dịch'],
  detail: ['chi tiết', 'thông tin bổ sung', 'detail', 'mô tả thêm'],
  counterpartyName: ['tên người chuyển', 'đối tác', 'tên đối ứng', 'counterparty', 'tên đơn vị', 'người chuyển/nhận'],
  counterpartyAccount: ['số tài khoản đối tác', 'tk đối ứng', 'tài khoản đối ứng', 'số tk đối tác'],
  reference: ['mã giao dịch', 'số tham chiếu', 'số chứng từ', 'reference', 'mã tham chiếu'],
  credit: ['tiền vào', 'số tiền vào', 'tiền có', 'credit', 'doanh số tăng', 'giá trị tăng', 'tăng'],
  debit: ['tiền ra', 'số tiền ra', 'tiền nợ', 'debit', 'doanh số giảm', 'giá trị giảm', 'giảm'],
  amount: ['số tiền', 'giá trị', 'amount', 'số tiền giao dịch'],
  balance: ['số dư', 'tồn', 'balance', 'số dư cuối kỳ'],
  currency: ['loại tiền', 'tiền tệ', 'currency'],
};

function normalizeHeaderCell(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.:=]+$/g, '')
    .trim();
}

// Tìm dòng tiêu đề: dòng có >= 2 ô khớp danh sách tên cột quen thuộc.
function findHeaderRow(rows) {
  let best = { index: -1, hits: 0 };
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    let hits = 0;
    for (const cell of rows[index]) {
      const text = normalizeHeaderCell(cell);
      if (!text) continue;
      for (const aliases of Object.values(HEADER_ALIASES)) {
        if (aliases.some(alias => text === alias || text.includes(alias))) { hits += 1; break; }
      }
    }
    if (hits > best.hits) best = { index, hits };
    if (hits >= 3) break;
  }
  return best.hits >= 2 ? best.index : -1;
}

function mapColumns(headerRow) {
  const map = {};
  for (let index = 0; index < headerRow.length; index += 1) {
    const text = normalizeHeaderCell(headerRow[index]);
    if (!text) continue;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.some(alias => text === alias || text.includes(alias))) map[field] = index;
    }
  }
  return map;
}

// "1,234,567.89" | "1.234.567,89" | "1 234 567" | "1.234.567đ" | "-500,000" → số.
function parseMoney(raw) {
  let text = String(raw ?? '').trim();
  if (!text || /^[-–—.]+$/.test(text)) return null;
  text = text.replace(/[^\d.,\-]/g, '');
  if (!text || !/\d/.test(text)) return null;
  const negative = /^\s*-/.test(String(raw ?? ''));
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Cả hai dấu: dấu đứng SAU là dấu thập phân.
    text = lastComma > lastDot
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Chỉ dấu phẩy: "1,234,567" (nhóm) hay "1234,56" (thập phân)?
    const decimals = text.length - lastComma - 1;
    text = (decimals === 3 && /^\d{1,3}(,\d{3})+$/.test(text.replace(/^-/, ''))) ? text.replace(/,/g, '') : text.replace(/,/g, '.');
  } else if (lastDot > -1) {
    const decimals = text.length - lastDot - 1;
    text = (decimals === 3 && /^\d{1,3}(\.\d{3})+$/.test(text.replace(/^-/, ''))) ? text.replace(/\./g, '') : text;
  }
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  return negative ? -Math.abs(number) : number;
}

// Chuỗi ngày linh hoạt (d/m/yyyy, yyyy-mm-dd, d-m-yyyy, Excel serial…) → 'YYYY-MM-DD'.
function parseDate(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return vnDate.isoDay(text);
  const match = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (match) {
    let [, day, month, year] = match;
    if (year.length === 2) year = `20${year}`;
    if (Number(day) > 12 && Number(month) <= 12) return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const serial = Number(text);
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  return vnDate.isoDay(text);
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Mã chống trùng (§26): ngày + tiền vào + tiền ra + nội dung + mã GD. Cùng một giao dịch
// xuất lại từ ngân hàng (kể cả tên file khác) vẫn khớp hash ⇒ không nhân đôi.
function rowHashOf(row) {
  const parts = [row.tranDate, row.credit ?? '', row.debit ?? '', row.description, row.reference];
  return crypto.createHash('sha1').update(parts.join('|'), 'utf8').digest('hex');
}

// Chuẩn hoá + kiểm tra MỘT dòng. Trả về { row } hoặc { error }.
function normalizeRow(raw, map) {
  const pick = field => (map[field] === undefined ? '' : raw[map[field]]);
  const row = {
    tranDate: parseDate(pick('tranDate')),
    valueDate: parseDate(pick('valueDate')),
    description: cleanText(pick('description')),
    detail: cleanText(pick('detail')),
    counterpartyName: cleanText(pick('counterpartyName')),
    counterpartyAccount: cleanText(pick('counterpartyAccount')),
    reference: cleanText(pick('reference')),
    credit: parseMoney(pick('credit')),
    debit: parseMoney(pick('debit')),
    balance: parseMoney(pick('balance')),
    currency: cleanText(pick('currency')) || 'VND',
  };
  // Cột "Số tiền" duy nhất: dương = tiền vào, âm = tiền ra (nhiều ngân hàng xuất kiểu này).
  const amount = parseMoney(pick('amount'));
  if (row.credit === null && row.debit === null && amount !== null) {
    if (amount >= 0) row.credit = amount; else row.debit = -amount;
  }
  // Âm trong cột Tiền vào / dương trong cột Tiền ra: đưa về đúng phía.
  if (row.credit !== null && row.credit < 0) { row.debit = -row.credit; row.credit = null; }
  if (row.debit !== null && row.debit < 0) { row.credit = -row.debit; row.debit = null; }
  row.amount = (row.credit || 0) - (row.debit || 0);

  if (!row.tranDate) return { error: 'Thiếu hoặc sai ngày giao dịch' };
  if (row.credit === null && row.debit === null) return { error: 'Thiếu số tiền (không đọc được Tiền vào/Tiền ra)' };
  return { row };
}

// ---------------------------------------------------------------------------
// NHẬP FILE → SQLITE
// ---------------------------------------------------------------------------

function fileHashOf(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

// Hash cho dữ liệu KHÔNG PHẢI FILE (PDF chữ ghép bảng, AI trả về bảng): chỉ hash
// nội dung bảng đã chuẩn hoá — user nhập lại cùng dữ liệu vẫn bị chặn trùng.
function rowsHashOf(rows) {
  return crypto.createHash('sha1').update(JSON.stringify(rows), 'utf8').digest('hex');
}

// Đọc buffer thành chuỗi CSV đúng bảng mã: Excel xuất CSV theo UTF-8 có BOM hoặc UTF-16LE —
// đoán sai thì tiếng Việt thành chữ lộn xộn (mojibake) và không tìm thấy dòng tiêu đề.
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.toString('utf8').replace(/^\uFEFF/, '');
  // Không BOM: utf8 (chuẩn phổ biến); ký tự thay thế '' ⇒ file là utf16 không BOM thì thử lại.
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  const utf16 = buffer.toString('utf16le');
  return utf16.includes('\uFFFD') ? utf8 : utf16;
}

// Ghi metadata file + toàn bộ giao dịch trong MỘT transaction. Trùng row_hash ⇒ bỏ qua (§26).
// fileHash: hash FILE gốc (Excel/CSV). Với bảng từ PDF/AI (không có file gốc) truyền rỗng —
// khi đó hash NỘI DUNG bảng thay thế: nhập lại cùng dữ liệu vẫn bị chặn trùng.
function importRows(db, { fileName, fileHash = '', rows }) {
  const cleaned = cleanRows(rows);
  if (!cleaned.length) throw new Error('File không có dòng dữ liệu nào.');

  const hash = fileHash || rowsHashOf(cleaned);
  const existing = db.prepare('SELECT id, file_name FROM bank_files WHERE file_hash = ?').get(hash);
  if (existing) throw new Error(`Dữ liệu này đã nhập trước đó (${existing.file_name}). Không nhập lại cùng một file.`);

  const headerAt = findHeaderRow(cleaned);
  if (headerAt === -1) throw new Error('Không tìm thấy dòng tiêu đề (cần cột Ngày giao dịch, Tiền vào/Tiền ra…).');
  const map = mapColumns(cleaned[headerAt]);
  if (map.tranDate === undefined) throw new Error('Thiếu cột ngày giao dịch trong file.');
  if (map.credit === undefined && map.debit === undefined && map.amount === undefined) {
    throw new Error('Thiếu cột tiền: cần "Tiền vào"/"Tiền ra" hoặc "Số tiền".');
  }

  const dataRows = cleaned.slice(headerAt + 1);
  let imported = 0;
  let duplicate = 0;
  let failed = 0;
  let minDate = null;
  let maxDate = null;
  let creditSum = 0;
  let debitSum = 0;
  const insertTran = db.prepare(`INSERT INTO bank_transactions
    (file_id, tran_date, value_date, description, detail, counterparty_name, counterparty_account,
     reference, credit, debit, amount, balance, currency, row_hash, file_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const stamp = new Date().toISOString();

  const run = () => {
    const info = db.prepare(`INSERT INTO bank_files
      (file_name, file_hash, bank, account, period_from, period_to, rows_total, rows_imported, rows_duplicate, rows_error, imported_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fileName, hash, null, null, null, null, dataRows.length, 0, 0, 0, stamp, 'importing');
    const fileId = Number(info.lastInsertRowid);
    for (const raw of dataRows) {
      const result = normalizeRow(raw, map);
      if (result.error) { failed += 1; continue; }
      const row = result.row;
      try {
        insertTran.run(fileId, row.tranDate, row.valueDate, row.description, row.detail, row.counterpartyName,
          row.counterpartyAccount, row.reference, row.credit, row.debit, row.amount, row.balance, row.currency,
          rowHashOf(row), fileName, stamp, stamp);
        imported += 1;
        if (!minDate || row.tranDate < minDate) minDate = row.tranDate;
        if (!maxDate || row.tranDate > maxDate) maxDate = row.tranDate;
        if (row.credit) creditSum += row.credit;
        if (row.debit) debitSum += row.debit;
      } catch {
        duplicate += 1; // UNIQUE(row_hash): giao dịch đã có từ file khác/lần nhập trước
      }
    }
    db.prepare(`UPDATE bank_files SET rows_imported = ?, rows_duplicate = ?, rows_error = ?,
        period_from = ?, period_to = ? WHERE id = ?`)
      .run(imported, duplicate, failed, minDate, maxDate, fileId);
    db.prepare(`UPDATE bank_files SET status = 'imported' WHERE id = ?`).run(fileId);
    return { fileId, imported, duplicate, failed, total: dataRows.length, minDate, maxDate, creditTotal: creditSum, debitTotal: debitSum };
  };

  // withTransaction của sqlite.js: đã ở trong transaction thì dùng lại, chưa thì tự mở.
  const { withTransaction } = require('./sqlite');
  return withTransaction(db, run);
}

// Đọc buffer Excel/CSV thành bảng chuỗi thô (dùng chung cho import + preview).
function parseWorkbookBuffer(buffer, fileName) {
  try {
    if (/\.csv$/i.test(String(fileName || ''))) throw new Error('csv-path'); // CSV tự đọc để giữ bảng mã đúng
    const book = XLSX.read(buffer, { type: 'buffer' });
    return book.SheetNames.flatMap(name => sheetToRows(book.Sheets[name]));
  } catch (error) {
    if (error.message === 'csv-path') return parseCsv(decodeText(buffer));
    // Buffer không phải Excel hợp lệ (PDF/ảnh gửi nhầm) ⇒ thử đọc như CSV, hỏng thì báo rõ.
    const csv = parseCsv(decodeText(buffer));
    if (csv.length) return csv;
    throw new Error('File không đọc được: chỉ nhận Excel (.xlsx/.xls), CSV, PDF hoặc ảnh PNG/JPG.');
  }
}

// Nhập FILE Excel/CSV — giữ NGUYÊN hành vi cũ (hash file, chặn nhập lại cùng file).
function importWorkbook(db, { buffer, fileName }) {
  const fileHash = fileHashOf(buffer);
  const existing = db.prepare('SELECT id, file_name FROM bank_files WHERE file_hash = ?').get(fileHash);
  if (existing) throw new Error(`File này đã nhập trước đó (${existing.file_name}). Không nhập lại cùng một file.`);
  return importRows(db, { fileName, fileHash, rows: parseWorkbookBuffer(buffer, fileName) });
}

// ---------------------------------------------------------------------------
// KIỂM TRA TRƯỚC KHI LƯU (preview) — không ghi gì vào DB.
// rows: bảng chuỗi thô từ mọi nguồn (Excel/CSV/PDF chữ/AI) → chuẩn hoá + soi lỗi:
//   • từng dòng: đủ ngày + đủ tiền (normalizeRow);
//   • SỐ DƯ LIÊN MẠCH: dòng sau = dòng trước + tiền vào − tiền ra (lệch ≤ 0.5);
//   • TỔNG CUỐI: số dư cuối − số dư đầu khớp tổng (vào − ra).
// level: 'ok' (khớp) | 'warn' (lệch số dư — user quyết định) | 'error' (không lưu được).
// ---------------------------------------------------------------------------
const BALANCE_TOLERANCE = 0.5;
const fmt = value => Number(value || 0).toLocaleString('vi-VN', { maximumFractionDigits: 2 });

function verifyRows(rows) {
  const issues = [];
  let breaks = 0;
  let checked = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.balance == null || cur.balance == null) continue;
    checked += 1;
    const expected = prev.balance + (cur.credit || 0) - (cur.debit || 0);
    if (Math.abs(expected - cur.balance) > BALANCE_TOLERANCE) {
      breaks += 1;
      if (issues.length < 10) issues.push(`Dòng ${i + 1}: số dư đọc được ${fmt(cur.balance)} nhưng tính ra phải là ${fmt(expected)} (dòng trước ${fmt(prev.balance)} + vào ${fmt(cur.credit)} − ra ${fmt(cur.debit)}).`);
    }
  }
  const first = rows.find(r => r.balance != null);
  const last = [...rows].reverse().find(r => r.balance != null);
  const moneyIn = rows.reduce((s, r) => s + (r.credit || 0), 0);
  const moneyOut = rows.reduce((s, r) => s + (r.debit || 0), 0);
  if (first && last && first !== last) {
    const expectedEnd = first.balance + moneyIn - moneyOut;
    if (Math.abs(expectedEnd - last.balance) > BALANCE_TOLERANCE) {
      issues.push(`Số dư cuối kỳ đọc được ${fmt(last.balance)} nhưng tổng kết lại là ${fmt(expectedEnd)} (dư đầu ${fmt(first.balance)} + tổng vào ${fmt(moneyIn)} − tổng ra ${fmt(moneyOut)}).`);
    }
  }
  const level = rows.length === 0 ? 'error' : (breaks > 0 ? 'warn' : 'ok');
  return {
    level,
    issues: issues.slice(0, 10),
    stats: { rows: rows.length, moneyIn, moneyOut, balanceChecks: checked, balanceBreaks: breaks },
  };
}

// Chuẩn hoá bảng thô KHÔNG ghi DB — trả normalized rows (theo thứ tự file) + kết quả kiểm tra.
function previewRows(rows) {
  const cleaned = cleanRows(rows);
  if (!cleaned.length) throw new Error('File không có dòng dữ liệu nào.');
  const headerAt = findHeaderRow(cleaned);
  if (headerAt === -1) throw new Error('Không tìm thấy dòng tiêu đề (cần cột Ngày giao dịch, Tiền vào/Tiền ra…).');
  const map = mapColumns(cleaned[headerAt]);
  if (map.tranDate === undefined) throw new Error('Thiếu cột ngày giao dịch trong file.');
  if (map.credit === undefined && map.debit === undefined && map.amount === undefined) {
    throw new Error('Thiếu cột tiền: cần "Tiền vào"/"Tiền ra" hoặc "Số tiền".');
  }
  const normalized = [];
  let failed = 0;
  let firstError = '';
  for (const raw of cleaned.slice(headerAt + 1)) {
    const result = normalizeRow(raw, map);
    if (result.error) { failed += 1; if (!firstError) firstError = result.error; continue; }
    normalized.push(result.row);
  }
  const verification = verifyRows(normalized);
  verification.stats.failed = failed;
  if (failed) verification.issues.push(`Có ${failed} dòng không đọc được (lỗi đầu tiên: ${firstError}).`);
  if (verification.level === 'ok') verification.level = failed && !normalized.length ? 'error' : (failed ? 'warn' : 'ok');
  return {
    rows: normalized.map(row => ({
      tranDate: row.tranDate, valueDate: row.valueDate, description: row.description, detail: row.detail,
      counterpartyName: row.counterpartyName, counterpartyAccount: row.counterpartyAccount,
      reference: row.reference, credit: row.credit, debit: row.debit, amount: row.amount,
      balance: row.balance, currency: row.currency,
    })),
    verification,
  };
}

// CHUYỂN FILE SANG MST KHÁC: chép file + giao dịch sang data.db của MST đích rồi xoá ở MST cũ.
// Trùng file_hash / row_hash ở MST đích ⇒ dòng đó tính là duplicate (không nhân đôi).
function moveFileToMst(sourceDb, targetDb, { fileId, toMst }) {
  const id = Number(fileId);
  const file = sourceDb.prepare('SELECT * FROM bank_files WHERE id = ?').get(id);
  if (!file) throw new Error('Không tìm thấy file sao kê để chuyển.');
  const dupFile = targetDb.prepare('SELECT id FROM bank_files WHERE file_hash = ?').get(file.file_hash);
  if (dupFile) throw new Error('MST đích đã có chính file này rồi.');
  const transactions = sourceDb.prepare('SELECT tran_date, value_date, description, detail, counterparty_name, counterparty_account, reference, credit, debit, amount, balance, currency, row_hash FROM bank_transactions WHERE file_id = ? ORDER BY id').all(id);
  const stamp = new Date().toISOString();
  const { withTransaction } = require('./sqlite');
  const run = target => {
    const info = target.prepare(`INSERT INTO bank_files
      (file_name, file_hash, bank, account, period_from, period_to, rows_total, rows_imported, rows_duplicate, rows_error, imported_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'imported')`)
      .run(file.file_name, file.file_hash, file.bank, file.account, file.period_from, file.period_to, file.rows_total, stamp);
    const newId = Number(info.lastInsertRowid);
    let moved = 0;
    let duplicate = 0;
    const insert = target.prepare(`INSERT INTO bank_transactions
      (file_id, tran_date, value_date, description, detail, counterparty_name, counterparty_account,
       reference, credit, debit, amount, balance, currency, row_hash, file_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const t of transactions) {
      try {
        insert.run(newId, t.tran_date, t.value_date, t.description, t.detail, t.counterparty_name,
          t.counterparty_account, t.reference, t.credit, t.debit, t.amount, t.balance, t.currency,
          t.row_hash, file.file_name, stamp, stamp);
        moved += 1;
      } catch { duplicate += 1; }
    }
    target.prepare('UPDATE bank_files SET rows_imported = ?, rows_duplicate = ? WHERE id = ?').run(moved, duplicate, newId);
    return { moved, duplicate, toMst };
  };
  const result = withTransaction(targetDb, () => run(targetDb));
  sourceDb.prepare('DELETE FROM bank_transactions WHERE file_id = ?').run(id);
  sourceDb.prepare('DELETE FROM bank_files WHERE id = ?').run(id);
  return result;
}

// Xoá một file sao kê ⇒ xoá luôn giao dịch của file đó (ON DELETE CASCADE).
function deleteFile(db, fileId) {
  const id = Number(fileId);
  const file = db.prepare('SELECT id, file_name FROM bank_files WHERE id = ?').get(id);
  if (!file) throw new Error('Không tìm thấy file sao kê để xoá.');
  db.prepare('DELETE FROM bank_transactions WHERE file_id = ?').run(id);
  db.prepare('DELETE FROM bank_files WHERE id = ?').run(id);
  return { deleted: file.file_name };
}

// ---------------------------------------------------------------------------
// TRUY VẤN cho UI — cùng phong cách với queries.js (SQLite là nguồn đọc duy nhất).
// ---------------------------------------------------------------------------

function summary(db) {
  const totals = db.prepare(`SELECT COUNT(*) AS transactions,
      COALESCE(SUM(credit), 0) AS money_in,
      COALESCE(SUM(debit), 0) AS money_out,
      MIN(tran_date) AS from_date, MAX(tran_date) AS to_date
    FROM bank_transactions`).get();
  const files = db.prepare(`SELECT COUNT(*) AS files,
      COALESCE(SUM(rows_error), 0) AS rows_error
    FROM bank_files`).get();
  return {
    files: files.files,
    transactions: totals.transactions,
    moneyIn: totals.money_in,
    moneyOut: totals.money_out,
    rowsError: files.rows_error,
    from: totals.from_date,
    to: totals.to_date,
  };
}

function listFiles(db, { limit = 50 } = {}) {
  return db.prepare('SELECT id, file_name, rows_total, rows_imported, rows_duplicate, rows_error, period_from, period_to, imported_at, status FROM bank_files ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 50)));
}

// Danh sách giao dịch có phân trang + lọc (tìm kiếm, khoảng ngày, khoảng tiền, chiều vào/ra).
function listTransactions(db, { q = '', from = '', to = '', flow = '', min = '', max = '', limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('tran_date >= ?'); params.push(from); }
  if (to) { where.push('tran_date <= ?'); params.push(to); }
  if (flow === 'in') where.push('credit IS NOT NULL');
  if (flow === 'out') where.push('debit IS NOT NULL');
  // Khoảng tiền: áp lên SỐ TIỀN GIAO DỊCH (tiền vào nếu có, không thì tiền ra).
  const minNum = Number(min);
  const maxNum = Number(max);
  if (min !== '' && Number.isFinite(minNum)) { where.push('COALESCE(credit, debit) >= ?'); params.push(minNum); }
  if (max !== '' && Number.isFinite(maxNum)) { where.push('COALESCE(credit, debit) <= ?'); params.push(maxNum); }
  const text = String(q || '').trim();
  if (text) {
    where.push('(description LIKE ? OR detail LIKE ? OR counterparty_name LIKE ? OR reference LIKE ? OR counterparty_account LIKE ?)');
    const like = `%${text}%`;
    params.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  const skip = Math.max(0, Number(offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM bank_transactions ${clause}`).get(...params).c;
  const rows = db.prepare(`SELECT id, file_id, tran_date, value_date, description, detail, counterparty_name,
      counterparty_account, reference, credit, debit, amount, balance, currency, file_name
    FROM bank_transactions ${clause}
    ORDER BY tran_date DESC, id DESC
    LIMIT ? OFFSET ?`).all(...params, size, skip);
  return { total, limit: size, offset: skip, rows };
}

// Tổng hợp theo NGÀY — nền cho thống kê/thống kê tiền vào-ra trong tab (mục §39).
function dailyTotals(db, { from = '', to = '' } = {}) {
  const where = [];
  const params = [];
  if (from) { where.push('tran_date >= ?'); params.push(from); }
  if (to) { where.push('tran_date <= ?'); params.push(to); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT tran_date AS day, COUNT(*) AS transactions,
      COALESCE(SUM(credit), 0) AS money_in, COALESCE(SUM(debit), 0) AS money_out
    FROM bank_transactions ${clause}
    GROUP BY tran_date ORDER BY tran_date DESC LIMIT 120`).all(...params);
}

module.exports = {
  parseMoney, parseDate, findHeaderRow, mapColumns, normalizeRow, rowHashOf,
  importWorkbook, importRows, parseWorkbookBuffer, previewRows, verifyRows, moveFileToMst,
  deleteFile, summary, listFiles, listTransactions, dailyTotals,
};
