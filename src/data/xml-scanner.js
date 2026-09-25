'use strict';
// ---------------------------------------------------------------------------
// XML Scanner / Importer — PROJECT_ARCHITECTURE §17, §18, §19, §42, §71, §26.
//
// Quét XML trong vùng dữ liệu của MST, đọc → xác định hướng → khoá hoá đơn → ghi SQLite
// trong MỘT transaction cho mỗi hoá đơn (mục 45), và ghi vết vào imported_files (mục 10).
//
// Nguyên tắc:
//   - XML là nguồn gốc; hướng lấy từ NỘI DUNG XML, không lấy từ tên thư mục (mục 17).
//   - Quét ĐỆ QUY trong Mua_vao/Ban_ra: dữ liệu cũ nằm ở <Mua_vao|Ban_ra>/xml/… vẫn được nhận.
//   - File XML nằm ngay trong thư mục MST (ngoài 2 thư mục chuẩn) vẫn được nhập, kèm cảnh báo.
//   - Một file lỗi KHÔNG làm dừng cả lượt (mục 42/71): ghi error rồi đi tiếp.
//   - Chạy lại nhiều lần không nhân bản (mục 19): file đã import (đúng path + size + mtime)
//     thì bỏ qua; hoá đơn đã có (theo invoice_key) thì ghi vết duplicate.
//   - Async + nhường event loop sau mỗi file: UI theo dõi được tiến độ và không bị khoá (mục 26/52).
//   - Hoá đơn cổng thuế báo "Đã bị thay thế" (tthai = 4) KHÔNG thuộc kho dữ liệu: bộ nhập đọc
//     danh sách khoá trong MST-<mst>/hoa-don-bi-thay-the.json (do engine tra cứu ghi) để bỏ qua
//     và dọn bản đã nhập trước đó. XML không mang trạng thái nên đây là nguồn duy nhất biết được.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { buildImportRecord } = require('./xml-parser');
const { insertInvoice, upsertInvoice, findInvoiceByKey, recordImportedFile } = require('./repository');
const { withTransaction } = require('./sqlite');

const FOLDER_DIRECTION = { Mua_vao: 'BUY', Ban_ra: 'SELL' };
const MAX_DEPTH = 8;
const IMPORT_BATCH_SIZE = 25;
// Trạng thái imported_files coi như "đã xử lý" (không đọc lại file mỗi lượt quét).
const HANDLED_STATUS = ['imported', 'superseded'];
const SUPERSEDED_FILE = 'hoa-don-bi-thay-the.json';

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

// Tìm mọi file .xml dưới một thư mục, kể cả trong thư mục con (ví dụ Mua_vao/xml/).
function collectXmlFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

// Danh sách XML của một MST: theo thứ tự Mua_vao → Ban_ra → file rời trong thư mục MST.
function listMstXmlFiles(mstDir, folders = Object.keys(FOLDER_DIRECTION)) {
  const list = [];
  for (const folder of folders) {
    const dir = path.join(mstDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const filePath of collectXmlFiles(dir)) list.push({ filePath, folder });
  }
  if (fs.existsSync(mstDir)) {
    let entries = [];
    try { entries = fs.readdirSync(mstDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) list.push({ filePath: path.join(mstDir, entry.name), folder: '' });
    }
  }
  return list;
}

function alreadyImported(db, filePath, stat) {
  const row = db.prepare('SELECT status, file_size, modified_time FROM imported_files WHERE file_path = ? ORDER BY id DESC LIMIT 1').get(filePath);
  if (!row || !HANDLED_STATUS.includes(String(row.status))) return false;
  return Number(row.file_size) === stat.size && String(row.modified_time) === stat.mtime.toISOString();
}

// Danh sách khoá hoá đơn cổng thuế đã báo "Đã bị thay thế" (tthai = 4), do engine ghi trong
// MST-<mst>/hoa-don-bi-thay-the.json. Chấp nhận cả mảng trần lẫn { keys: [...] }.
function readSuperseded(mstDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(mstDir, SUPERSEDED_FILE), 'utf8'));
    const keys = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.keys) ? raw.keys : []);
    return new Set(keys.map(String).filter(Boolean));
  } catch { return new Set(); }
}

// Dọn một hoá đơn đã bị thay thế khỏi kho (dòng hàng xoá theo nhờ ON DELETE CASCADE).
function removeSuperseded(db, invoiceKey) {
  const row = findInvoiceByKey(db, invoiceKey);
  if (!row) return false;
  db.prepare('DELETE FROM invoices WHERE id = ?').run(row.id);
  return true;
}

function previousFile(db, filePath) {
  return db.prepare('SELECT status, file_size, modified_time, invoice_key FROM imported_files WHERE file_path = ? ORDER BY id DESC LIMIT 1').get(filePath) || null;
}

// Xử lý ĐÚNG MỘT file: mọi lỗi được bắt tại đây để một file hỏng không làm dừng cả lượt.
function processFile({ db, mst, identifiers, filePath, folder, summary, superseded }) {
  const name = path.basename(filePath);
  const expected = FOLDER_DIRECTION[folder] || '';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    summary.errors += 1;
    summary.files.push({ file: filePath, status: 'error', error: `Không đọc được file: ${error.message}` });
    return;
  }
  const base = { filePath, fileName: name, fileSize: stat.size, modifiedTime: stat.mtime.toISOString() };
  const known = previousFile(db, filePath);
  // Hoá đơn đã bị cổng thuế báo "Đã bị thay thế": dọn khỏi kho và ghi vết để lần sau bỏ qua NGAY.
  // Dùng khoá đã lưu trong imported_files nên KHÔNG phải đọc lại XML — chạy TRƯỚC bước "đã nhập thì bỏ qua".
  if (superseded && superseded.size && known && known.invoice_key && superseded.has(String(known.invoice_key))) {
    const removed = removeSuperseded(db, known.invoice_key);
    const unchanged = String(known.status) === 'superseded' && known.file_size === stat.size && known.modified_time === stat.mtime.toISOString();
    if (!unchanged) recordImportedFile(db, { ...base, invoiceKey: known.invoice_key, status: 'superseded' });
    summary.superseded += 1;
    summary.files.push({ file: filePath, status: 'superseded', invoiceKey: known.invoice_key, removed });
    return;
  }
  if (alreadyImported(db, filePath, stat)) {
    summary.skipped += 1;
    summary.files.push({ file: filePath, status: 'skipped' });
    return;
  }
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const { record, warnings, direction } = buildImportRecord(xml, { currentMst: identifiers && identifiers.length ? identifiers : mst, fileXml: filePath });
    // Hoá đơn "Đã bị thay thế": bỏ qua và dọn bản đã nhập trước đó (nếu có).
    if (superseded && superseded.size && superseded.has(record.invoiceKey)) {
      const removed = removeSuperseded(db, record.invoiceKey);
      recordImportedFile(db, { ...base, invoiceKey: record.invoiceKey, status: 'superseded' });
      summary.superseded += 1;
      summary.files.push({ file: filePath, status: 'superseded', invoiceKey: record.invoiceKey, removed, direction });
      return;
    }
    if (expected && direction !== expected) {
      warnings.push(`File nằm trong thư mục ${folder} nhưng nội dung XML là ${direction} — giữ nguyên file, ghi theo nội dung XML.`);
    }
    if (!expected) {
      warnings.push('File không nằm trong thư mục Mua_vao/Ban_ra — giữ nguyên vị trí, ghi theo nội dung XML.');
    }
    const existing = findInvoiceByKey(db, record.invoiceKey);
    if (existing && known && known.invoice_key === record.invoiceKey) {
      const result = upsertInvoice(db, {
        ...record,
        importedFile: { ...base, status: 'imported', errorMessage: warnings.join(' | ') || null },
      });
      summary.updated += 1;
      summary.items += result.itemsInserted;
      summary.warningCount += warnings.length;
      summary.files.push({ file: filePath, status: 'updated', invoiceKey: record.invoiceKey, direction, items: result.itemsInserted, warnings });
      return;
    }
    if (existing) {
      recordImportedFile(db, { ...base, invoiceKey: record.invoiceKey, status: 'duplicate', errorMessage: warnings.join(' | ') || null });
      summary.duplicates += 1;
      summary.files.push({ file: filePath, status: 'duplicate', invoiceKey: record.invoiceKey });
      return;
    }
    const result = insertInvoice(db, {
      ...record,
      importedFile: { ...base, status: 'imported', errorMessage: warnings.join(' | ') || null },
    });
    summary.imported += 1;
    summary.items += result.itemsInserted;
    summary.warningCount += warnings.length;
    summary.files.push({ file: filePath, status: 'imported', invoiceKey: record.invoiceKey || result.invoiceKey, direction, items: result.itemsInserted, warnings });
  } catch (error) {
    summary.errors += 1;
    const message = error && error.message ? error.message : String(error);
    try {
      recordImportedFile(db, { ...base, status: 'error', errorMessage: message });
    } catch { /* không ghi được vết thì vẫn phải đi tiếp */ }
    summary.files.push({ file: filePath, status: 'error', error: message, unknownDirection: !!(error && error.unknownDirection) });
  }
}

async function scanXmlFolder({ db, mst, identifiers, mstDir, folders = Object.keys(FOLDER_DIRECTION), onFile }) {
  const summary = { scanned: 0, imported: 0, updated: 0, duplicates: 0, skipped: 0, errors: 0, superseded: 0, items: 0, warningCount: 0, files: [] };
  const notify = () => { if (typeof onFile === 'function') onFile(summary); };
  const superseded = readSuperseded(mstDir);
  const targets = listMstXmlFiles(mstDir, folders);
  for (let start = 0; start < targets.length; start += IMPORT_BATCH_SIZE) {
    await yieldToLoop();
    const batch = targets.slice(start, start + IMPORT_BATCH_SIZE);
    withTransaction(db, () => {
      for (const { filePath, folder } of batch) {
        summary.scanned += 1;
        processFile({ db, mst, identifiers, filePath, folder, summary, superseded });
        // Thông báo tiến độ TỪNG FILE: UI đọc qua /api/db/import/status (polling) nên chi phí chỉ là
        // vài phép gán trong bộ nhớ, không phải "hàng nghìn UI update". Giao dịch vẫn GỘP THEO LÔ
        // (IMPORT_BATCH_SIZE) — đó mới là chỗ tiết kiệm thời gian ghi SQLite.
        notify();
      }
    });
  }
  return summary;
}

module.exports = { scanXmlFolder, alreadyImported, previousFile, processFile, collectXmlFiles, listMstXmlFiles, readSuperseded, removeSuperseded, FOLDER_DIRECTION, IMPORT_BATCH_SIZE, SUPERSEDED_FILE };
