'use strict';
// ---------------------------------------------------------------------------
// Import XML cho một MST — dùng cho dòng lệnh (và sau này cho Auto Sync/Backfill).
//
// Từ PHASE 2 dữ liệu vào SQLite bằng QUÉT SAU, không sửa luồng tải thủ công đang chạy
// (mục 21/22 cho phép cả hai cách; cách này không đụng vào phần được bảo toàn).
// Từ PHASE 3 scanner là async để không khoá UI khi quét nhiều file.
// ---------------------------------------------------------------------------

const { ensureMst } = require('./mst-manager');
const { closeDatabase } = require('./sqlite');
const { scanXmlFolder } = require('./xml-scanner');
const { countInvoices, countItems } = require('./repository');

async function runImport({ output, mst, folders } = {}) {
  const { dir, dbFile, db } = ensureMst({ output, mst });
  try {
    const scan = await scanXmlFolder({ db, mst, mstDir: dir, folders });
    return {
      ok: scan.errors === 0,
      mst: String(mst),
      dir,
      dbFile,
      scan,
      invoices: countInvoices(db),
      items: countItems(db),
    };
  } finally {
    closeDatabase(db);
  }
}

module.exports = { runImport };
