'use strict';
// ---------------------------------------------------------------------------
// Nhập dữ liệu chạy NỀN, có tiến độ — PROJECT_ARCHITECTURE §26, §52.
//
// Mục đích: UI bấm "Nhập dữ liệu từ XML" rồi vẫn dùng được trong lúc quét; tiến độ đọc
// qua /api/db/import/status. Không khoá UI, không reload app.
// Chỉ một lượt nhập chạy tại một thời điểm cho mỗi tiến trình.
// ---------------------------------------------------------------------------

const path = require('node:path');
const { ensureMst } = require('./mst-manager');
const { closeDatabase } = require('./sqlite');
const { scanXmlFolder, listMstXmlFiles } = require('./xml-scanner');

let current = {
  running: false, mst: '', dir: '', total: 0,
  scanned: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, itemsTotal: 0,
  current: '', recent: [], startedAt: null, finishedAt: null, ok: null, error: '',
};

function nowIso() { return new Date().toISOString(); }

// Đếm trước tổng số XML (đệ quy, gồm cả thư mục con) để UI có thanh tiến độ đúng.
function countXmlFiles(dir) {
  try { return listMstXmlFiles(dir).length; } catch { return 0; }
}

function status() {
  return {
    running: current.running, mst: current.mst, dir: current.dir, total: current.total,
    scanned: current.scanned, imported: current.imported, duplicates: current.duplicates,
    skipped: current.skipped, errors: current.errors, itemsTotal: current.itemsTotal,
    current: current.current, recent: current.recent.slice(-8),
    startedAt: current.startedAt, finishedAt: current.finishedAt, ok: current.ok, error: current.error,
  };
}

async function start({ output, mst } = {}) {
  if (current.running) throw new Error('Đang nhập dữ liệu. Chờ lượt hiện tại chạy xong.');
  const { dir, db } = ensureMst({ output, mst });
  current = {
    running: true, mst: String(mst), dir, total: countXmlFiles(dir),
    scanned: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, itemsTotal: 0,
    current: '', recent: [], startedAt: nowIso(), finishedAt: null, ok: null, error: '',
  };
  let failure = null;
  try {
    const scan = await scanXmlFolder({
      db, mst, mstDir: dir,
      onFile: summary => {
        current.scanned = summary.scanned;
        current.imported = summary.imported;
        current.duplicates = summary.duplicates;
        current.skipped = summary.skipped;
        current.errors = summary.errors;
        current.itemsTotal = summary.items;
        const last = summary.files[summary.files.length - 1];
        if (last) {
          current.current = path.basename(last.file);
          current.recent.push({ file: current.current, status: last.status, error: last.error || '' });
        }
      },
    });
    current.ok = scan.errors === 0;
    current.summary = { imported: scan.imported, duplicates: scan.duplicates, skipped: scan.skipped, errors: scan.errors, items: scan.items };
  } catch (error) {
    failure = error;
    current.ok = false;
    current.error = error && error.message ? error.message : String(error);
  } finally {
    current.running = false;
    current.finishedAt = nowIso();
    current.current = '';
    closeDatabase(db);
  }
  // Trạng thái trả về phải được chụp SAU khi dọn dẹp, nếu không UI sẽ tưởng lượt nhập còn đang chạy.
  const result = status();
  if (failure) throw failure;
  return result;
}

module.exports = { start, status };
