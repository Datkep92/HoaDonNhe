'use strict';
// ---------------------------------------------------------------------------
// PDF → BẢNG cho AI (chạy TẠI MÁY, không gửi cloud).
// Tái dùng ĐÚNG logic lưới đang chạy trên UI (src/bank-pdf.js — hàm pageToGrid
// port từ extension "pdf conver") và ĐÚNG bộ chuẩn hoá sao kê production
// (src/data/bank-statement.js). Không viết bản thứ hai để tránh lệch kết quả.
//
// pdfjs nạp bằng fs.readFileSync + import(data:) — cùng cách safe-js.js nạp
// wasm — nên chạy được cả khi đóng gói EXE (pkg), không phụ thuộc đường dẫn
// thật trên đĩa lúc runtime.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const BankPdf = require('../bank-pdf');
const bankStatement = require('../data/bank-statement');

const MAX_PAGES = 30;          // cùng trần với UI (bank-pdf.js)
const MAX_TEXT_CHARS = 1_500_000;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.resolve().then(() => {
      const dir = path.join(__dirname, '..', 'vendor', 'pdfjs');
      const moduleSource = fs.readFileSync(path.join(dir, 'pdf.min.mjs'), 'utf8');
      const workerSource = fs.readFileSync(path.join(dir, 'pdf.worker.min.mjs'), 'utf8');
      const toDataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64');
      return import(toDataUrl(moduleSource)).then(lib => {
        lib.GlobalWorkerOptions.workerSrc = toDataUrl(workerSource);
        return lib;
      });
    }).catch(error => {
      pdfjsPromise = null;
      throw Object.assign(new Error('Không nạp được bộ đọc PDF: ' + error.message), { code: 'INTERNAL_ERROR' });
    });
  }
  return pdfjsPromise;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

// Bảng (grid) + lượng chữ — dùng nguyên hàm dựng lưới của UI.
async function extractGrid(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw Object.assign(new Error('File không phải PDF hợp lệ.'), { code: 'NOT_PDF' });
  }
  let lib;
  try { lib = await loadPdfjs(); }
  catch (error) { throw error; }
  try {
    return await BankPdf.readPdf(toArrayBuffer(bytes), () => Promise.resolve(lib));
  } catch (error) {
    throw Object.assign(new Error('Không đọc được PDF: ' + String(error.message || error).slice(0, 200)), { code: 'PDF_READ_FAILED' });
  }
}

// Văn bản PDF (đọc theo yêu cầu) — dùng khi model cần HIỂU nội dung, không phải để chuyển bảng.
// Trả theo TRANG để nơi gọi cắt từng đoạn (offset) chứ không nhét cả file vào ngữ cảnh.
async function readText(buffer, maxPages = MAX_PAGES) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw Object.assign(new Error('File không phải PDF hợp lệ.'), { code: 'NOT_PDF' });
  }
  const lib = await loadPdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true }).promise;
    const limit = Math.min(doc.numPages, maxPages);
    const pages = [];
    let chars = 0;
    for (let i = 1; i <= limit; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
      chars += text.trim().length;
      pages.push(text);
      page.cleanup();
      if (chars > MAX_TEXT_CHARS) break;
    }
    return { kind: chars > 50 ? 'pdf-text' : 'pdf-scan', pages, chars, totalPages: doc.numPages };
  } catch (error) {
    throw Object.assign(new Error('Không đọc được PDF: ' + String(error.message || error).slice(0, 200)), { code: 'PDF_READ_FAILED' });
  } finally {
    try { await doc?.destroy(); } catch {}
  }
}

// Cắt văn bản theo ký tự (offset/length) trên toàn bộ các trang đã đọc.
function textSlice(textPages, offset = 0, length = 16000) {
  const joined = (textPages || []).map((text, index) => '\nTrang ' + (index + 1) + '\n' + text).join('');
  const start = Math.max(0, Math.floor(offset || 0));
  const end = Math.min(joined.length, start + Math.max(1, Math.floor(length || 16000)));
  return { text: joined.slice(start, end), offset: start, totalCharacters: joined.length, nextOffset: end < joined.length ? end : null };
}

// Lưới thô (bỏ dòng/cột rỗng) — trung thực 100% với file gốc, không diễn giải.
function rawGrid(grid) {
  return bankStatementNormalizeGrid(grid).filter(row => row.some(cell => String(cell ?? '').trim().length > 0));
}

// Bọc qua đúng hàm làm sạch đang dùng cho sao kê để hai đường cho cùng kết quả.
function bankStatementNormalizeGrid(grid) {
  const BankPdfTrim = BankPdf.trimEmptyColumns ? BankPdf.trimEmptyColumns(BankPdf.trimEmptyRows(grid)) : grid;
  return BankPdfTrim.map(row => row.map(cell => (cell == null ? '' : String(cell))));
}

// Chuẩn hoá sao kê (production): trả các giao dịch có cấu trúc + kiểm tra số liệu.
function statementRows(grid) {
  const preview = bankStatement.previewRows(grid);
  const rows = Array.isArray(preview.rows) ? preview.rows : [];
  return { rows, verification: preview.verification, grid: rows.length ? bankStatement.normalizedRowsToGrid(rows) : null };
}

// Quyết định bộ sheet đưa vào Excel: luôn có sheet THÔ (không mất dữ liệu);
// thêm sheet GIAO DỊCH khi bộ chuẩn hoá sao kê nhận ra bảng có cấu trúc.
function buildSheets(grid) {
  const raw = rawGrid(grid);
  const sheets = [{ name: 'Du lieu goc', rows: raw }];
  const statement = statementRows(grid);
  if (statement.grid && statement.rows.length >= 3) sheets.unshift({ name: 'Giao dich', rows: statement.grid });
  return { sheets, rawRows: raw.length, statementRows: statement.rows.length, verification: statement.verification };
}

module.exports = { loadPdfjs, extractGrid, readText, textSlice, buildSheets, rawGrid, statementRows, MAX_PAGES, MAX_TEXT_CHARS };