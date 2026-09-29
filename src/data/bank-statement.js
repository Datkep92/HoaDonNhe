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
// Khoảng ngày của kỳ đang chọn (bộ chọn kỳ trên header) — dùng chung, xem src/data/sqlite.js.
const { dateRange } = require('./sqlite');

// ---------------------------------------------------------------------------
// ĐỌC FILE THÔ → bảng chuỗi (mảng mảng). Excel đọc bằng SheetJS; CSV tự tách cột
// (dấu phẩy/chấm phẩy/tab tự nhận) để hỗ trợ file ngân hàng xuất CSV.
// ---------------------------------------------------------------------------

function detectDelimiter(text) {
  const head = String(text || '').split(/\r?\n/).slice(0, 10).join('\n');
  const counts = { ',': (head.match(/,/g) || []).length, ';': (head.match(/;/g) || []).length, '\t': (head.match(/\t/g) || []).length };
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || ',';
}

// Tách CSV/TSV đúng chuẩn: hiểu ô "bọc trong nháy kép" (nội dung có thể chứa dấu phân cách
// và nháy kép nhân đôi) — sao kê ngân hàng hay có "Nội dung" kèm dấu phẩy. Ô được trim.
function parseCsv(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n');
  const delimiter = detectDelimiter(raw);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      field = '';
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows.length ? rows : [[]];
}

function sheetToRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    .map(row => row.map(cell => (cell === null || cell === undefined ? '' : String(cell).trim())));
}

// ---------------------------------------------------------------------------
// ĐỌC "EXCEL" THEO NỘI DUNG — đuôi .xls KHÔNG nói lên định dạng: ngân hàng hay
// xuất .xls mà thực chất là HTML <table>, SpreadsheetML 2003 (XML), hoặc CSV đội
// lốt. Nhận diện bằng chữ ký byte + nội dung, không tin tên file. Trả về DANH SÁCH
// lưới ứng viên (mỗi sheet / mỗi <table> một lưới) để nơi gọi chọn lưới giống sao kê nhất.
// ---------------------------------------------------------------------------

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', deg: '°', ndash: '–' };

function fromCodePointSafe(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePointSafe(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(html) {
  return decodeHtmlEntities(String(html ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const looksLikeHtml = text => /<html[\s>]|<table[\s>]|<!doctype\s+html/i.test(String(text ?? '').slice(0, 40000));
const looksLikeSpreadsheetXml = text => {
  const head = String(text ?? '').slice(0, 6000);
  return /<Workbook\b/i.test(head) && /office:spreadsheet|xmlns:ss=/i.test(head);
};

// HTML <table> → lưới. Tolerant: bỏ qua thuộc tính, giải mã entity, tôn trọng colspan.
function htmlTablesToGrids(text) {
  const grids = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let table;
  while ((table = tableRe.exec(String(text ?? '')))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = rowRe.exec(table[1]))) {
      const cells = [];
      const cellRe = /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
      let cell;
      while ((cell = cellRe.exec(tr[1]))) {
        cells.push(stripTags(cell[2]));
        const span = /\bcolspan\s*=\s*"?(\d+)/i.exec(cell[1]);
        const n = span ? Math.min(30, Number(span[1])) : 1;
        for (let k = 1; k < n; k += 1) cells.push('');
      }
      // Ô không có thẻ đóng (một số export ẩu): tách thô theo thẻ mở.
      if (!cells.length) for (const piece of tr[1].split(/<t[dh]\b[^>]*>/i).slice(1)) cells.push(stripTags(piece));
      if (cells.some(value => value !== '')) rows.push(cells);
    }
    if (rows.length) grids.push(rows);
  }
  return grids;
}

// SpreadsheetML 2003 (XML) → lưới. Tôn trọng ss:Index (ô nhảy cột) và ss:MergeAcross.
function spreadsheetXmlToGrids(text) {
  const grids = [];
  const wsRe = /<Worksheet\b[^>]*>([\s\S]*?)<\/Worksheet>/gi;
  let ws;
  while ((ws = wsRe.exec(String(text ?? '')))) {
    const rows = [];
    const rowRe = /<Row\b[^>]*>([\s\S]*?)<\/Row>/gi;
    let row;
    while ((row = rowRe.exec(ws[1]))) {
      const cells = [];
      const cellRe = /<Cell\b([^>]*?)\/>|<Cell\b([^>]*?)>([\s\S]*?)<\/Cell>/gi;
      let cell;
      while ((cell = cellRe.exec(row[1]))) {
        const attrs = cell[1] || cell[2] || '';
        const body = cell[3] || '';
        const index = /\bss:Index\s*=\s*"(\d+)"/i.exec(attrs);
        if (index) while (cells.length < Number(index[1]) - 1) cells.push('');
        const data = /<Data\b[^>]*>([\s\S]*?)<\/Data>/i.exec(body);
        cells.push(data ? stripTags(data[1]) : stripTags(body));
        const across = /\bss:MergeAcross\s*=\s*"(\d+)"/i.exec(attrs);
        if (across) for (let k = 0; k < Number(across[1]); k += 1) cells.push('');
      }
      if (cells.some(value => value !== '')) rows.push(cells);
    }
    if (rows.length) grids.push(rows);
  }
  return grids;
}

// Đọc buffer bất kỳ → danh sách lưới ứng viên. Ném lỗi code 'pdf' để nơi gọi biết
// đây là PDF (đi đường đọc chữ riêng).
function readStatementGrids(buffer, fileName) {
  if (buffer.slice(0, 5).toString('latin1') === '%PDF-') {
    const error = new Error('Đây là file PDF — dùng bộ đọc PDF.');
    error.code = 'pdf';
    throw error;
  }
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle = buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  const grids = [];
  const push = grid => { if (Array.isArray(grid) && grid.length && grid.some(row => row.some(c => String(c ?? '').trim()))) grids.push(grid); };

  // 1) Excel nhị phân/zip thật (SheetJS).
  if (isZip || isOle) {
    try {
      const book = XLSX.read(buffer, { type: 'buffer' });
      for (const name of book.SheetNames) push(sheetToRows(book.Sheets[name]));
      if (grids.length) return grids;
    } catch { /* thử các đường văn bản bên dưới */ }
  }

  // 2) Container văn bản: SpreadsheetML XML, HTML <table>, CSV.
  const text = decodeText(buffer);
  // "Excel HTML Frameset": file .xls chỉ chứa khung, dữ liệu nằm ở thư mục <tên>_files
  // đi kèm (sheet001.htm). Một mình file này KHÔNG có dữ liệu — báo rõ để user lưu lại .xlsx.
  if (/<frameset\b/i.test(text) || /Excel Workbook Frameset/i.test(text)) {
    throw new Error('File .xls này là khung HTML của Excel (Excel Workbook Frameset) — dữ liệu thật nằm ở thư mục "..._files" đi kèm chứ không có trong file. Hãy mở bằng Excel rồi Lưu thành .xlsx (hoặc chọn file sheet001.htm trong thư mục đó).');
  }
  if (looksLikeSpreadsheetXml(text)) spreadsheetXmlToGrids(text).forEach(push);
  if (!grids.length && looksLikeHtml(text)) htmlTablesToGrids(text).forEach(push);
  if (!grids.length && !isZip && !isOle) {
    const csv = parseCsv(text);
    if (csv.length) push(csv);
  }
  if (grids.length) return grids;

  // 3) Chót: để SheetJS thử đọc chính chuỗi văn bản (vài biến thể HTML/XML).
  try {
    const book = XLSX.read(text, { type: 'string' });
    for (const name of book.SheetNames) push(sheetToRows(book.Sheets[name]));
  } catch { /* bỏ */ }
  return grids;
}

// Điểm "giống sao kê" của một lưới: đếm dòng dữ liệu (có ngày VÀ tiền), dòng có tiền
// nhưng thiếu ngày tính nửa điểm (dòng chốt của bố cục nhiều dòng).
function gridStatementScore(rows) {
  let score = 0;
  for (const row of cleanRows(rows)) {
    const hasDate = row.some(cell => pureDateCell(cell) || splitDateMoneyCell(cell));
    const hasMoney = row.some(cell => moneyCellOf(cell));
    if (hasDate && hasMoney) score += 1;
    else if (hasMoney) score += 0.5;
  }
  return score;
}

const headerSignature = grid => {
  const at = findHeaderRow(grid);
  if (at === -1) return '';
  return grid[at].map(normalizeHeaderCell).join('|');
};

// Chọn lưới dữ liệu tốt nhất trong nhiều ứng viên (nhiều sheet / nhiều <table>).
// Gộp thêm các lưới CÙNG dòng tiêu đề (sao kê chia nhiều sheet/kỳ nối tiếp).
function pickBestGrid(grids) {
  const cleaned = grids.map(cleanRows).filter(grid => grid.length);
  if (cleaned.length <= 1) return cleaned[0] || [];
  const ranked = cleaned.map(grid => ({ grid, score: gridStatementScore(grid) }))
    .sort((a, b) => b.score - a.score || b.grid.length - a.grid.length);
  const best = ranked[0].grid;
  const signature = headerSignature(best);
  if (!signature) return best;
  const at = findHeaderRow(best);
  const extra = ranked.slice(1).filter(item => headerSignature(item.grid) === signature)
    .map(item => item.grid.slice(findHeaderRow(item.grid) + 1));
  if (!extra.length) return best;
  return best.slice(0, at + 1).concat(...extra);
}

// Bảng chuỗi thô (mảng mảng) — bỏ dòng trống toàn rỗng.
function cleanRows(rows) {
  return rows.filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
}

// ---------------------------------------------------------------------------
// GỘP DÒNG THÀNH GIAO DỊCH (recompose) — chạy cho MỌI nguồn (PDF chữ, AI, Excel/CSV)
// trước khi tìm tiêu đề + map cột.
// Một số sao kê (MB Bank…) in MỘT giao dịch trên NHIỀU dòng:
//   [ | 01/04/2026 | | | MBVCB… chuyen]   ← ngày + nội dung
//   [ | 5078 - 78262 | | | HOANG CAO…]    ← số chứng từ + nội dung
//   [1 | | 485,000 | 34.818.968 |]        ← dòng "chốt": STT + tiền + số dư
// Chỉ dòng chốt mang tiền/số dư (≥2 ô thuần số), ngày nằm ở dòng trên ⇒ parser cũ
// không dòng nào tự đủ ngày + tiền ⇒ lỗi "Thiếu cột ngày giao dịch".
// Gộp lại thành 1 dòng: ngày → cột đầu, tiền/số dư → các cột kế, mô tả nối lại cột cuối.
// Sao kê kiểu "1 dòng = 1 giao dịch" (dòng chốt CÓ ngày riêng) đi qua KHÔNG ĐỔI gì.
// ---------------------------------------------------------------------------

// Ô NGÀY: dd/mm/yyyy, dd-mm-yyyy, hoặc dd/mm không năm.
function dateLikeCell(text) {
  return /(^|[^\d])\d{1,2}[\/\-.]\d{1,2}([^\d]|$)/.test(String(text ?? '').trim()) || /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(String(text ?? ''));
}

// Ô TIỀN thuần: chỉ số + dấu ngăn cách (loại ngày, loại mã có chữ, loại "5078 - 78262").
function moneyCellOf(text) {
  const raw = String(text ?? '').trim();
  if (!raw || !/\d/.test(raw)) return false;
  if (dateLikeCell(raw)) return false;
  if (/[A-Za-z]/.test(raw)) return false;
  const cleaned = raw.replace(/[^\d.,\-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return false;
  if (/[.,]/.test(cleaned)) return true; // "485,000" / "34.818.968" / "-1,000"
  return /^\d+$/.test(cleaned); // "485000" nguyên thuần; "5078-78262" có gạch → loại
}

// Đếm ô khớp tên cột quen thuộc — nhận diện dòng tiêu đề ĐƯỢC IN LẠI giữa bảng (PDF nhiều
// trang lặp header mỗi trang) để bỏ đi, tránh chữ header dính vào nội dung giao dịch.
function headerHitsOf(row) {
  let hits = 0;
  for (const cell of row) {
    const text = normalizeHeaderCell(cell);
    if (!text) continue;
    for (const aliases of Object.values(HEADER_ALIASES)) {
      if (aliases.some(alias => text === alias || text.includes(alias))) { hits += 1; break; }
    }
  }
  return hits;
}

const isPageHeaderRow = row => headerHitsOf(row) >= 2
  || row.some(cell => /^(số ct|doc no)$/i.test(String(cell ?? '').trim())); // sub-header lặp của MB

// Ô NGÀY THUẦN: dd/mm/yyyy, dd/mm (không năm), HOẶC ISO yyyy-mm-dd — không kèm chữ hay số lạ.
function pureDateCell(text) {
  const t = String(text ?? '').trim();
  return /^\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?$/.test(t) || /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}$/.test(t);
}

// Ô "ngày + tiền dính nhau" (MB in sát nhau): "03/04/2026 30.371.250" → { date, money }.
function splitDateMoneyCell(text) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^(\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\s+(.+)$/);
  if (!match) return null;
  const rest = match[2].trim();
  return moneyCellOf(rest) ? { date: match[1], money: rest } : null;
}

// Trích xuất MỘT nhóm (dòng phụ + dòng chốt) theo NỘI DUNG, không dựa vào lưới cột toàn trang
// (grid PDF lệch cột giữa các trang):
//   ngày    = ô ngày thuần hoặc phần ngày trong ô dính;
//   số dư   = ô tiền PHẢI NHẤT trong nhóm (header Balance luôn ngoài cùng);
//   tiền GD = các ô tiền còn lại, GIỮ Index CỘT (vị trí trên DÒNG TIỀN thì tin được: Debit trái, Credit phải);
//   mô tả   = mọi ô chữ còn lại. Nhóm thiếu ngày hoặc thiếu tiền ⇒ trả null (không bịa dữ liệu).
function extractGroup(group) {
  const dates = [];
  const amounts = [];
  const desc = [];
  for (const row of group) {
    row.forEach((cell, i) => {
      const value = String(cell ?? '').trim();
      if (!value) return;
      if (i === 0 && /^\d{1,4}$/.test(value)) return; // STT ở cột đầu
      if (pureDateCell(value)) { if (!dates.includes(value)) dates.push(value); return; }
      const merged = splitDateMoneyCell(value);
      if (merged) { if (!dates.includes(merged.date)) dates.push(merged.date); amounts.push({ value: merged.money, col: i }); return; }
      if (moneyCellOf(value)) { amounts.push({ value, col: i }); return; }
      desc.push(value);
    });
  }
  if (!dates.length || !amounts.length) return null;
  const balance = amounts[amounts.length - 1]; // ô tiền PHẢI NHẤT = số dư
  const rest = amounts.slice(0, -1).sort((a, b) => a.col - b.col);
  return { date: dates[0], amounts: rest.map(a => a.value), cols: rest.map(a => a.col), balance: balance.value, desc };
}

// Phân loại các ô tiền GIAO DỊCH: 1) chuỗi số dư (chính xác nhất); 2) vị trí cột trên dòng
// tiền (Debit trái, Credit phải — như header); 3) fallback theo thứ tự header.
// Ghép mảnh: ô tiền bị vỡ đôi ("18.539" + "460") cũng được thử nối lại.
function assignAmounts(amounts, cols, prev, balNum) {
  const fallback = () => ({ debit: amounts[0] || '', credit: amounts[1] || '', leftover: amounts.slice(2) });
  const num = a => parseMoney(a);
  // 1) chuỗi số dư: chọn cách gán khiến "dư trước + vào − ra = dư sau" khớp.
  if (prev != null && balNum != null && amounts.length && amounts.length <= 3) {
    const matches = (credit, debit) => Math.abs(prev + credit - debit - balNum) <= BALANCE_TOLERANCE;
    const combos = [];
    const walk = (index, credit, debit) => {
      if (index === amounts.length) { combos.push({ credit, debit }); return; }
      walk(index + 1, credit, debit + (debit ? ' ' : '') + amounts[index]);
      walk(index + 1, credit + (credit ? ' ' : '') + amounts[index], debit);
    };
    walk(0, '', '');
    for (const c of combos) {
      const cr = num(c.credit);
      const db = num(c.debit);
      if (cr != null && db != null && matches(cr, db)) return { credit: c.credit, debit: c.debit, leftover: [] };
    }
    // 1b) chỉ MỘT ô là tiền thật, hoặc nối mảnh vỡ lại.
    const joined = [amounts.join(''), amounts.join('.'), amounts.join(',')].map(s => (num(s) != null ? s : null)).filter(Boolean);
    for (const pick of [...amounts, ...joined]) {
      const value = num(pick);
      if (value == null) continue;
      if (matches(value, 0)) return { credit: pick, debit: '', leftover: amounts.filter(a => a !== pick) };
      if (matches(0, value)) return { credit: '', debit: pick, leftover: amounts.filter(a => a !== pick) };
    }
  }
  // 2) vị trí cột trên dòng tiền: ≥2 ô ở cột KHÁC nhau → trái = ra, phải = vào.
  if (amounts.length >= 2 && cols && cols.length === amounts.length
    && Math.max(...cols) - Math.min(...cols) > 0) {
    return { debit: amounts[0], credit: amounts[1], leftover: amounts.slice(2) };
  }
  // 3) không suy được gì: để cột VÀO (an toàn hơn — tiền ra thường đi kèm nội dung rõ ràng,
  //    và verify sẽ soi lại bằng chuỗi số dư).
  return { credit: amounts[0] || '', debit: amounts[1] || '', leftover: amounts.slice(2) };
}

const isMoneyRow = row => row.filter(cell => moneyCellOf(cell)).length >= 2;

// Header tổng hợp cho bố cục nhiều dòng — mapColumns sẽ đọc được đúng ngay: ngày 0, vào 1, ra 2, dư 3, nội dung 4.
const SPLIT_HEADER = ['Ngày giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư', 'Nội dung', 'Chi tiết'];

function recomposeRows(bodyRows) {
  const out = [];
  let group = [];
  let prevBalance = null; // chuỗi số dư để suy HƯỚNG vào/ra khi chỉ in 1 ô tiền
  let lastDate = ''; // ngày gần nhất đã thấy — thừa kế cho dòng tiền mất ngày (ngắt trang)
  for (const row of bodyRows) {
    if (isPageHeaderRow(row)) continue; // header lặp giữa trang
    for (const cell of row) {
      const merged = splitDateMoneyCell(cell);
      if (pureDateCell(cell)) lastDate = String(cell).trim();
      else if (merged) lastDate = merged.date;
    }
    if (!isMoneyRow(row)) { group.push(row); continue; } // dòng phụ: ngày / số CT / mô tả
    // Dòng chốt (có tiền + số dư). Có ngày riêng vẫn phải trích xuất lại vì cột grid lệch giữa các trang.
    const hasOwnDate = row.some(cell => pureDateCell(cell) || splitDateMoneyCell(cell));
    const source = hasOwnDate ? [row] : [...group, row]; // KHÔNG dùng concat: concat làm phẳng row thành chuỗi
    group = [];
    const found = extractGroup(source);
    if (!found) {
      // Dòng tiền MỒ CÔI (nhóm trống, mất ngày do ngắt trang): chỉ cứu khi chuỗi số dư CHỨNG
      // MINH (dư trước +/− tiền ô 1 = số dư ô 2) — ngược lại giữ nguyên (chú thích/tổng kết).
      if (lastDate && source.length === 1 && prevBalance != null) {
        const moneys = [];
        const texts = [];
        row.forEach((cell, i) => {
          const value = String(cell ?? '').trim();
          if (!value) return;
          if (i === 0 && /^\d{1,4}$/.test(value)) return; // STT
          if (moneyCellOf(value)) { moneys.push(value); return; }
          texts.push(value);
        });
        if (moneys.length === 2) {
          const amount = parseMoney(moneys[0]);
          const bal = parseMoney(moneys[1]);
          let credit = '';
          let debit = '';
          if (amount != null && bal != null && Math.abs(prevBalance + amount - bal) <= BALANCE_TOLERANCE) credit = moneys[0];
          else if (amount != null && bal != null && Math.abs(prevBalance - amount - bal) <= BALANCE_TOLERANCE) debit = moneys[0];
          if (credit || debit) {
            out.push([lastDate, credit, debit, moneys[1], texts.join(' '), '']);
            prevBalance = bal;
            continue;
          }
        }
      }
      out.push(...source); // chú thích/tổng kết: giữ nguyên, không bịa
      continue;
    }
    const balNum = parseMoney(found.balance);
    const assigned = assignAmounts(found.amounts, found.cols, prevBalance, balNum);
    out.push([found.date || lastDate, assigned.credit, assigned.debit, found.balance ?? '',
      found.desc.join(' '), assigned.leftover.join(' ')]);
    if (balNum != null) prevBalance = balNum;
  }
  if (group.length) {
    // Đuôi chữ không có dòng tiền (MB in mô tả SAU dòng tiền ở trang cuối): nối vào mô tả
    // giao dịch vừa xuất để không rơi thành dòng lỗi "thiếu ngày".
    const tail = group.map(row => row.filter(cell => String(cell ?? '').trim()).join(' ')).filter(Boolean).join(' ');
    if (tail && out.length && out[out.length - 1].length >= 6) out[out.length - 1][4] = `${out[out.length - 1][4]} ${tail}`.trim();
    else out.push(...group);
  }
  return out;
}

// Toàn bộ bảng: sao kê thường (mọi dòng tiền đều có ngày riêng) trả NGUYÊN; bố cục nhiều dòng
// (≥3 dòng tiền không có ngày riêng) thì thay header bằng header tổng hợp + gộp dòng, bỏ phần đầu/junk.
function recomposeStatement(rows) {
  const cleaned = cleanRows(rows);
  const headerAt = findHeaderRow(cleaned);
  if (headerAt === -1) return cleaned;
  const body = cleaned.slice(headerAt + 1);
  let splitRows = 0;
  for (const row of body) {
    if (isMoneyRow(row) && !row.some(cell => pureDateCell(cell) || splitDateMoneyCell(cell))) splitRows += 1;
  }
  if (splitRows < 3) return cleaned; // sao kê 1 dòng = 1 giao dịch: không đụng gì
  // BỎ phần đầu (banner, logo, chữ công ty…): chỉ giữ tiêu đề tổng hợp + dữ liệu đã gộp.
  return [SPLIT_HEADER, ...recomposeRows(body)];
}

// ---------------------------------------------------------------------------
// CHUẨN HÓA
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  tranDate: ['ngày giao dịch', 'ngay giao dich', 'ngày gd', 'ngày', 'transaction date', 'posting date', 'ngày ghi sổ', 'ngày hợp lệ', 'txn date', 'booking date'],
  valueDate: ['ngày hiệu lực', 'ngày giá trị', 'value date'],
  description: ['nội dung', 'diễn giải', 'mô tả', 'description', 'nội dung giao dịch', 'chi tiết giao dịch'],
  detail: ['chi tiết', 'thông tin bổ sung', 'detail', 'mô tả thêm'],
  counterpartyName: ['tên người chuyển', 'đối tác', 'tên đối ứng', 'counterparty', 'tên đơn vị', 'người chuyển/nhận'],
  counterpartyAccount: ['số tài khoản đối tác', 'tk đối ứng', 'tài khoản đối ứng', 'số tk đối tác'],
  reference: ['mã giao dịch', 'số tham chiếu', 'số chứng từ', 'reference', 'mã tham chiếu'],
  // "Phát sinh nợ/có" — kiểu header Nam Á/VCB. KHÔNG để alias một chữ mơ hồ
  // ("tăng"/"giảm"/"giá trị") vì ô header dính chữ khác (vd "Ngày giá trị") sẽ nhảy cột.
  credit: ['tiền vào', 'số tiền vào', 'tiền có', 'credit', 'doanh số tăng', 'phát sinh có', 'phat sinh co'],
  debit: ['tiền ra', 'số tiền ra', 'tiền nợ', 'debit', 'doanh số giảm', 'phát sinh nợ', 'phat sinh no'],
  amount: ['số tiền', 'amount', 'số tiền giao dịch'],
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
      if (aliases.some(alias => text === alias || text.includes(alias))) {
        map[field] = index;
        break; // 1 ô header chỉ mang 1 nghĩa — "Nội dung Phát sinh nợ" là nội dung, không phải cột tiền ra
      }
    }
  }
  return map;
}

// DÒ DỰ PHÒNG CỘT NỘI DUNG khi header KHÔNG ghi tên cột mô tả (MB: cột chữ nằm ngoài
// cùng, ô tiêu đề để TRỐNG nên mapColumns không thấy). Chọn cột CHỮ nhiều nhất chưa
// có chủ — không phải tiền/ngày, không thiên về số (mã, số tài khoản), xuất hiện ở
// phần lớn dòng và trung bình đủ dài. Chỉ dùng khi header thiếu; file có tên cột đúng
// đi qua y như cũ.
function guessDescriptionColumn(rows, headerAt, map) {
  const used = new Set(Object.values(map).filter(index => index !== undefined));
  const dataRows = rows.slice(headerAt + 1).filter(row => row.some(cell => String(cell ?? '').trim()));
  if (!dataRows.length) return undefined;
  const nCols = Math.max(...dataRows.map(row => row.length));
  let best = { col: undefined, chars: 0, hits: 0 };
  for (let col = 0; col < nCols; col += 1) {
    if (used.has(col)) continue;
    let chars = 0;
    let hits = 0;
    for (const row of dataRows) {
      const value = String(row[col] ?? '').trim();
      if (!value) continue;
      if (moneyCellOf(value) || pureDateCell(value) || splitDateMoneyCell(value)) continue;
      const digits = (value.match(/\d/g) || []).length;
      if (digits / value.length > 0.5) continue; // ô thiên về số (mã GD, số TK) — không phải mô tả
      chars += value.length;
      hits += 1;
    }
    if (hits > best.hits || (hits === best.hits && chars > best.chars)) best = { col, chars, hits };
  }
  if (best.col === undefined) return undefined;
  if (best.hits < Math.ceil(dataRows.length * 0.5)) return undefined; // quá thưa: không chắc là cột nội dung
  if (best.chars / best.hits < 4) return undefined; // toàn ô ngắn (mã, loại tiền): bỏ
  return best.col;
}

// ---------------------------------------------------------------------------
// TỰ HIỆU CHỈNH CỘT TIỀN BẰNG SỐ DƯ LIÊN MẠCH.
// Vì sao: mapColumns dựa vào TÊN cột nên lệch được — sao kê Nam Á dịch cột tiền lệch
// 1 vị trí so với header (PDF căn phải + ô gộp "Nội dung Phát sinh nợ"), AI trả header
// cũng kiểu này. May là sao kê luôn có cột Số dư và dòng sau = dòng trước + vào − ra,
// nên thử các cách gán cột Tiền vào/Tiền ra (kể cả cột Số tiền đơn) rồi chọn cách
// khớp số dư liên mạch NHIỀU NHẤT — sai cột thì không thể khớp liên tục.
// ---------------------------------------------------------------------------
function chooseMoneyMap(dataRows, map) {
  if (dataRows.length < 2) return map;
  const nCols = Math.max(...dataRows.map(r => r.length));
  if (nCols < 2) return map;
  // Không ứng cử các cột đã có chủ: ngày, mã GD, TK đối ứng (đều parse ra số được).
  // Cột số dư/mô tả KHÔNG loại trừ — header lệch cột (Nam Á dịch 1 cột) thì cột số dư gốc cũng sai.
  const skip = new Set([map.tranDate, map.valueDate, map.reference,
    map.counterpartyAccount, map.currency].filter(i => i !== undefined));
  const parsed = dataRows.map(r => Array.from({ length: nCols }, (_, c) => parseMoney(r[c])));
  // Cột "số": ≥1 dòng parse được số. Ngưỡng 1 (không phải 2) vì cột tiền MỘT CHIỀU có khi
  // chỉ vài ô (sao kê toàn phát sinh có, hay tiền ra chỉ 1 dòng/30 trang) — bỏ sót là mất cả cột.
  const numeric = [];
  for (let c = 0; c < nCols; c += 1) {
    if (skip.has(c)) continue;
    let count = 0;
    for (const row of parsed) if (row[c] !== null) count += 1;
    if (count >= 1) numeric.push(c);
  }
  if (!numeric.length) return map;

  // Đếm bước "dư sau = dư trước + vào − ra" khớp (tolerance như verifyRows).
  // Ý nghĩa dấu giống normalizeRow: âm ở cột nào cũng đổi sang cột kia.
  const recurrence = config => {
    const useAmount = config.amount !== undefined && config.credit === undefined && config.debit === undefined;
    const balIdx = config.balance;
    if (balIdx === undefined) return 0;
    let ok = 0;
    let prev = null;
    for (const row of parsed) {
      const bal = row[balIdx];
      if (bal === null) continue; // thiếu số dư: bỏ qua bước này, giữ prev (như verifyRows)
      if (prev !== null) {
        let inc;
        let out;
        if (useAmount) {
          const a = row[config.amount] || 0;
          inc = Math.max(a, 0);
          out = Math.max(-a, 0);
        } else {
          const cr = config.credit === undefined ? 0 : (row[config.credit] || 0);
          const db = config.debit === undefined ? 0 : (row[config.debit] || 0);
          inc = Math.max(cr, 0) + Math.max(-db, 0);
          out = Math.max(db, 0) + Math.max(-cr, 0);
        }
        if (Math.abs(prev + inc - out - bal) <= BALANCE_TOLERANCE) ok += 1;
      }
      prev = bal;
    }
    return ok;
  };
  // Số dòng ĐỌC ĐƯỢC với một cách gán — để cả file không có cột số dư vẫn chọn được cột tiền.
  // Chỉ chấm trên mẫu (tối đa 300 dòng đầu) cho nhanh; đủ phân biệt cách gán đúng/sai.
  const sample = dataRows.slice(0, 300);
  const readable = config => {
    let ok = 0;
    for (const row of sample) {
      if (row.every(cell => !String(cell ?? '').trim())) continue;
      if (!normalizeRow(row, config).error) ok += 1;
    }
    return ok;
  };
  const current = map;
  let bestScore = { rec: recurrence(current), rd: readable(current) };
  let best = current;
  const consider = config => {
    const rec = recurrence(config);
    if (rec < bestScore.rec) return;
    const rd = readable(config);
    if (rec > bestScore.rec || rd > bestScore.rd) { bestScore = { rec, rd }; best = config; }
  };
  const use = fields => Object.assign({}, map, { credit: undefined, debit: undefined, amount: undefined, balance: map.balance }, fields);
  for (const b of numeric) {
    // Hai cột riêng (phổ biến): ưu tiên cột TRÁI = Tiền ra, cột PHẢI = Tiền vào (quy ước sao kê VN).
    for (const i of numeric) for (const j of numeric) {
      if (i !== j && i !== b && j !== b) consider(use({ credit: j, debit: i, balance: b }));
    }
    for (const c of numeric) if (c !== b) consider(use({ credit: c, balance: b }));
    for (const d of numeric) if (d !== b) consider(use({ debit: d, balance: b }));
    for (const a of numeric) if (a !== b) consider(use({ amount: a, balance: b }));
  }
  // Không có cột số dư: chọn cột tiền đọc được nhiều dòng nhất (recurrence = 0 cho mọi cách).
  for (const i of numeric) for (const j of numeric) if (i !== j) consider(use({ credit: j, debit: i }));
  for (const c of numeric) consider(use({ credit: c }));
  for (const d of numeric) consider(use({ debit: d }));
  for (const a of numeric) consider(use({ amount: a }));
  // Chỉ đổi khi cách mới KHỎI HƠN RÕ (mapping gốc tốt rồi thì không đụng vào).
  return best === current ? map : best;
}

// mapColumns + tự hiệu chỉnh — dùng chung cho preview và import để hai đường luôn giống nhau.
function resolveMap(rows, headerAt) {
  const map = mapColumns(rows[headerAt]);
  if (map.tranDate === undefined) return map; // thiếu ngày: trả nguyên map để nơi gọi báo lỗi chuẩn
  if (map.description === undefined) {
    const guess = guessDescriptionColumn(rows, headerAt, map);
    if (guess !== undefined) map.description = guess;
  }
  return chooseMoneyMap(rows.slice(headerAt + 1), map);
}

// ---------------------------------------------------------------------------
// SUY LUẬN CỘT THEO NỘI DUNG (độc lập với TÊN cột — thậm chí không cần dòng tiêu đề).
// Đích: đọc được MỌI sao kê Excel/CSV/HTML/XML/PDF-chữ, kể cả file lạ không header,
// header đổi tên, header dính nhiều nghĩa. Tín hiệu dùng: hình dạng dữ liệu từng cột
// (ngày / tiền / chữ) + số dư liên mạch. Chốt an toàn: chỉ GHI ĐÈ khi tín hiệu nội
// dung rõ ràng hơn mapping theo tên, nên file đang đọc đúng đi qua KHÔNG ĐỔI.
// ---------------------------------------------------------------------------

// Phân loại một ô: 'date' (ngày/ngày+kèm tiền), 'money' (số tiền), 'text' (chữ), 'other'.
function classifyCell(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'empty';
  if (pureDateCell(text) || splitDateMoneyCell(text)) return 'date';
  if (moneyCellOf(text) || parseMoney(text) !== null) return 'money';
  if (/[A-Za-zÀ-ỹ]/.test(text)) return 'text';
  return 'other';
}

// Lưới dữ liệu để dò cột: bỏ dòng tiêu đề; nếu KHÔNG có tiêu đề thì bỏ luôn banner đầu
// file (giữ từ dòng dữ liệu đầu tiên trở đi).
function statementDataRows(rows, headerAt) {
  if (headerAt >= 0) return rows.slice(headerAt + 1);
  let start = rows.findIndex(row => row.some(cell => pureDateCell(cell) || splitDateMoneyCell(cell))
    || row.filter(cell => moneyCellOf(cell)).length >= 2);
  if (start === -1) start = 0;
  return rows.slice(start);
}

// Thống kê từng cột trên lưới dữ liệu.
function profileColumns(dataRows, nCols) {
  const profile = Array.from({ length: nCols }, () => ({ date: 0, money: 0, text: 0, chars: 0, fill: 0 }));
  for (const row of dataRows) {
    for (let col = 0; col < nCols; col += 1) {
      const kind = classifyCell(row[col]);
      if (kind === 'empty') continue;
      const p = profile[col];
      p.fill += 1;
      if (kind === 'date') p.date += 1;
      else if (kind === 'money') p.money += 1;
      else if (kind === 'text') { p.text += 1; p.chars += String(row[col]).trim().length; }
    }
  }
  return profile;
}

// Gán vai trò cột theo nội dung, chỉ khi vượt ngưỡng rõ ràng (tránh suy diễn bừa).
function inferRoles(dataRows, map, headerRow) {
  if (dataRows.length < 2) return map;
  const out = Object.assign({}, map);
  const nCols = Math.max(dataRows.reduce((m, row) => Math.max(m, row.length), 0), headerRow ? headerRow.length : 0);
  if (nCols < 2) return out;
  const profile = profileColumns(dataRows, nCols);
  const dateRows = dataRows.filter(row => row.some(cell => classifyCell(cell) === 'date')).length;
  const dateFloor = Math.max(2, Math.ceil(dateRows * 0.5), Math.ceil(dataRows.length * 0.1));

  // 1) NGÀY GIAO DỊCH: giữ cột header nếu nó thực sự chứa ngày; nếu không, chọn cột ngày đông nhất.
  const bestDate = profile.map((p, col) => ({ col, n: p.date })).sort((a, b) => b.n - a.n || a.col - b.col)[0];
  const curDate = out.tranDate;
  const curDateOk = curDate !== undefined && profile[curDate] && profile[curDate].date >= dateFloor;
  if (!curDateOk && bestDate && bestDate.n >= dateFloor) out.tranDate = bestDate.col;

  // 2) NGÀY HIỆU LỰC: chỉ khi có cột ngày thứ hai đủ đầy và khác cột ngày giao dịch.
  if (out.valueDate === undefined || out.valueDate === out.tranDate) {
    const second = profile.map((p, col) => ({ col, n: p.date })).sort((a, b) => b.n - a.n || a.col - b.col)
      .find(item => item.col !== out.tranDate && item.n >= dateFloor);
    if (second) out.valueDate = second.col;
    else if (out.valueDate === out.tranDate) delete out.valueDate;
  }

  // 3) CỘT NỘI DUNG: nếu header thiếu tên, chọn cột CHỮ dày nhất chưa có chủ.
  if (out.description === undefined) {
    const used = new Set(Object.values(out).filter(index => index !== undefined));
    const bestText = profile.map((p, col) => ({ col, chars: p.chars, hits: p.text }))
      .filter(item => !used.has(item.col))
      .sort((a, b) => b.chars - a.chars || b.hits - a.hits || a.col - b.col)[0];
    if (bestText && bestText.hits >= Math.max(2, Math.ceil(dataRows.length * 0.5))) out.description = bestText.col;
  }

  return out;
}

// Dùng chung: map theo tên (nếu có tiêu đề) → dò nội dung → hiệu chỉnh cột tiền bằng số dư.
function resolveMapExpanded(rows, headerAt) {
  const headerRow = headerAt >= 0 ? rows[headerAt] : null;
  const dataRows = statementDataRows(rows, headerAt);
  let map = headerRow ? mapColumns(headerRow) : {};
  map = inferRoles(dataRows, map, headerRow);
  if (map.description === undefined && headerAt >= 0) {
    const guess = guessDescriptionColumn(rows, headerAt, map);
    if (guess !== undefined) map.description = guess;
  }
  return chooseMoneyMap(dataRows, map);
}

// Phân tích bảng thô → lưới dữ liệu + mapping cột. Dùng chung cho preview và import.
// KHÔNG ném lỗi vì thiếu tiêu đề: suy luận nội dung xử lý file không header.
function analyzeStatement(rows) {
  const cleaned = recomposeStatement(rows);
  if (!cleaned.length) throw new Error('File không có dòng dữ liệu nào.');
  const headerAt = findHeaderRow(cleaned);
  const map = resolveMapExpanded(cleaned, headerAt);
  if (map.tranDate === undefined) {
    throw new Error('Không đọc được cột ngày giao dịch (thử đặt tên cột là "Ngày giao dịch" hoặc dùng định dạng ngày dd/mm/yyyy).');
  }
  if (map.credit === undefined && map.debit === undefined && map.amount === undefined) {
    throw new Error('Thiếu cột tiền: cần "Tiền vào"/"Tiền ra" hoặc "Số tiền" (cột số dư không thay thế được).');
  }
  const allRows = headerAt === -1 ? cleaned : cleaned.slice(headerAt + 1);
  // Bỏ dòng "Số dư đầu kỳ / Số dư cuối kỳ" (không phải giao dịch) — nhiều ngân hàng in
  // lẫn trong bảng; nếu giữ sẽ bị tính là dòng lỗi và làm nhiễu cảnh báo.
  const dataRows = allRows.filter(row => !isBalanceSummaryRow(row, map));
  return { cleaned, headerAt, map, dataRows };
}

// Dòng tổng kết số dư (đầu/cuối kỳ) — KHÔNG có phát sinh (chỉ số dư + chữ khóa) nên bỏ an toàn.
const BALANCE_SUMMARY_RE = /s[ốo]\s*d[ưu]\s*(đ[ầa]u|cu[ốo]i)\s*k[ỳy]|opening\s*balance|closing\s*balance|d[ưu]\s*(đ[ầa]u|cu[ốo]i)\s*k[ỳy]/i;
function isBalanceSummaryRow(raw, map) {
  const hasIn = map.credit !== undefined && parseMoney(raw[map.credit]) !== null;
  const hasOut = map.debit !== undefined && parseMoney(raw[map.debit]) !== null;
  const hasAmount = map.amount !== undefined && parseMoney(raw[map.amount]) !== null;
  if (hasIn || hasOut || hasAmount) return false; // có phát sinh ⇒ là giao dịch thật
  return raw.some(cell => BALANCE_SUMMARY_RE.test(String(cell ?? '')));
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
  // GỘP DÒNG trước khi chuẩn hoá: sao kê MB in 1 giao dịch trên nhiều dòng; sao kê thường
  // 1 dòng = 1 giao dịch đi qua không đổi. Dùng chung cho preview + import.
  const { cleaned, map, dataRows } = analyzeStatement(rows);

  const hash = fileHash || rowsHashOf(cleaned);
  const existing = db.prepare('SELECT id, file_name FROM bank_files WHERE file_hash = ?').get(hash);
  if (existing) throw new Error(`Dữ liệu này đã nhập trước đó (${existing.file_name}). Không nhập lại cùng một file.`);
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
  const result = withTransaction(db, run);
  // Giao dịch mới vào ⇒ kết quả đối chiếu cũ không còn đúng → tính lại NGAY (mục 36).
  // reconcile() tự bỏ qua nếu không có gì mới, nên nhập lại file trùng không tốn công.
  if (result.imported > 0) require('./reconciliation').reconcile(db);
  return result;
}

// Đọc buffer Excel/CSV thành bảng chuỗi thô (dùng chung cho import + preview).
function parseWorkbookBuffer(buffer, fileName) {
  const grids = readStatementGrids(buffer, fileName);
  if (!grids.length) throw new Error('File không đọc được: chỉ nhận Excel (.xlsx/.xls), CSV, HTML/XML bảng, PDF hoặc ảnh PNG/JPG.');
  return pickBestGrid(grids);
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
    const firstNet = (first.credit || 0) - (first.debit || 0);
    if (Math.abs(expectedEnd - last.balance) > BALANCE_TOLERANCE) {
      // File KHÔNG có dòng số dư đầu kỳ: first.balance là dư SAU giao dịch đầu nên phép tổng
      // kết bị tính trùng giao dịch đó (lệch đúng bằng số tiền của giao dịch đầu) — ghi chú,
      // không coi là lỗi (chuỗi liên mạch đã kiểm tra từng bước riêng).
      if (Math.abs(Math.abs(expectedEnd - last.balance) - Math.abs(firstNet)) <= BALANCE_TOLERANCE) {
        issues.push(`File không có dòng số dư đầu kỳ — tổng kết tính từ sau giao dịch đầu (dư đầu suy ra ${fmt(first.balance - firstNet)}).`);
      } else {
        issues.push(`Số dư cuối kỳ đọc được ${fmt(last.balance)} nhưng tổng kết lại là ${fmt(expectedEnd)} (dư đầu ${fmt(first.balance)} + tổng vào ${fmt(moneyIn)} − tổng ra ${fmt(moneyOut)}).`);
      }
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
  // GỘP DÒNG + SUY LUẬN CỘT (dùng chung cho preview + import) — xử lý cả file không header.
  const { map, dataRows } = analyzeStatement(rows);
  const normalized = [];
  let failed = 0;
  let firstError = '';
  for (const raw of dataRows) {
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

// Dựng lại BẢNG chuỗi (mảng mảng) từ các DÒNG ĐÃ CHUẨN HOÁ — đúng đường
// /api/db/bank/import-rows dùng khi UI gửi lại các dòng nó đã xem và xác nhận.
// Tách ra đây để server và test dùng CHUNG một cách dựng, không lệch nhau.
const NORMALIZED_GRID_HEADER = [
  'Ngày giao dịch', 'Ngày hiệu lực', 'Nội dung', 'Chi tiết', 'Tên đối ứng', 'TK đối ứng',
  'Mã giao dịch', 'Tiền vào', 'Tiền ra', 'Số dư', 'Loại tiền',
];

function normalizedRowsToGrid(rows) {
  return [NORMALIZED_GRID_HEADER].concat((rows || []).map(row => ([
    row.tranDate || '', row.valueDate || '', row.description || '', row.detail || '', row.counterpartyName || '',
    row.counterpartyAccount || '', row.reference || '',
    row.credit == null ? '' : String(row.credit), row.debit == null ? '' : String(row.debit),
    row.balance == null ? '' : String(row.balance), row.currency || 'VND',
  ])));
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
  // Giao dịch RỜI đi ⇒ số liệu hai bên đều đổi. Dòng bị xóa không còn mang trạng thái NULL
  // nên stale() không phát hiện được → phải ép chạy lại.
  const { forceReconcile, reconcile } = require('./reconciliation');
  forceReconcile(sourceDb);
  reconcile(targetDb);
  return result;
}

// Xoá một file sao kê ⇒ xoá luôn giao dịch của file đó (ON DELETE CASCADE).
function deleteFile(db, fileId) {
  const id = Number(fileId);
  const file = db.prepare('SELECT id, file_name FROM bank_files WHERE id = ?').get(id);
  if (!file) throw new Error('Không tìm thấy file sao kê để xoá.');
  db.prepare('DELETE FROM bank_transactions WHERE file_id = ?').run(id);
  db.prepare('DELETE FROM bank_files WHERE id = ?').run(id);
  // Giao dịch biến mất ⇒ những hóa đơn từng "đã khớp" giờ không còn ⇒ ép tính lại.
  require('./reconciliation').forceReconcile(db);
  return { deleted: file.file_name };
}

// ---------------------------------------------------------------------------
// TRUY VẤN cho UI — cùng phong cách với queries.js (SQLite là nguồn đọc duy nhất).
// ---------------------------------------------------------------------------

function summary(db, range) {
  // Kỳ đang chọn ở header: giao dịch lọc theo ngày giao dịch; không chọn kỳ thì giữ nguyên.
  const picked = dateRange(range, { column: 'tran_date' });
  const totals = db.prepare(`SELECT COUNT(*) AS transactions,
      COALESCE(SUM(credit), 0) AS money_in,
      COALESCE(SUM(debit), 0) AS money_out,
      MIN(tran_date) AS from_date, MAX(tran_date) AS to_date
    FROM bank_transactions ${picked.where}`).get(...picked.params);
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
  parseMoney, parseDate, findHeaderRow, mapColumns, chooseMoneyMap, resolveMap, resolveMapExpanded,
  analyzeStatement, classifyCell, inferRoles, readStatementGrids, pickBestGrid, normalizeRow, rowHashOf,
  recomposeRows, recomposeStatement,
  importWorkbook, importRows, parseWorkbookBuffer, previewRows, verifyRows, moveFileToMst,
  NORMALIZED_GRID_HEADER, normalizedRowsToGrid,
  deleteFile, summary, listFiles, listTransactions, dailyTotals,
};
