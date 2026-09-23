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
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { buildImportRecord } = require('./xml-parser');
const { insertInvoice, findInvoiceByKey, recordImportedFile } = require('./repository');

const FOLDER_DIRECTION = { Mua_vao: 'BUY', Ban_ra: 'SELL' };
const MAX_DEPTH = 8;

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
  if (!row || row.status !== 'imported') return false;
  return Number(row.file_size) === stat.size && String(row.modified_time) === stat.mtime.toISOString();
}

// Xử lý ĐÚNG MỘT file: mọi lỗi được bắt tại đây để một file hỏng không làm dừng cả lượt.
function processFile({ db, mst, filePath, folder, summary }) {
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
  if (alreadyImported(db, filePath, stat)) {
    summary.skipped += 1;
    summary.files.push({ file: filePath, status: 'skipped' });
    return;
  }
  const base = { filePath, fileName: name, fileSize: stat.size, modifiedTime: stat.mtime.toISOString() };
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const { record, warnings, direction } = buildImportRecord(xml, { currentMst: mst, fileXml: filePath });
    if (expected && direction !== expected) {
      warnings.push(`File nằm trong thư mục ${folder} nhưng nội dung XML là ${direction} — giữ nguyên file, ghi theo nội dung XML.`);
    }
    if (!expected) {
      warnings.push('File không nằm trong thư mục Mua_vao/Ban_ra — giữ nguyên vị trí, ghi theo nội dung XML.');
    }
    if (findInvoiceByKey(db, record.invoiceKey)) {
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

async function scanXmlFolder({ db, mst, mstDir, folders = Object.keys(FOLDER_DIRECTION), onFile }) {
  const summary = { scanned: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, items: 0, warningCount: 0, files: [] };
  const notify = () => { if (typeof onFile === 'function') onFile(summary); };
  const targets = listMstXmlFiles(mstDir, folders);
  for (const { filePath, folder } of targets) {
    await yieldToLoop();
    summary.scanned += 1;
    processFile({ db, mst, filePath, folder, summary });
    // Gọi SAU mỗi file (kể cả file bị bỏ qua/trùng) để thanh tiến độ trên UI luôn nhích.
    notify();
  }
  return summary;
}

module.exports = { scanXmlFolder, alreadyImported, processFile, collectXmlFiles, listMstXmlFiles, FOLDER_DIRECTION };
