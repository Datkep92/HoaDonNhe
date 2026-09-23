'use strict';
// ---------------------------------------------------------------------------
// Điểm vào tầng dữ liệu (PHASE 1 – Data Core).
// Chỉ require() các module con, KHÔNG tự chạy gì và KHÔNG đụng tới luồng thủ công.
// ---------------------------------------------------------------------------

module.exports = {
  invoiceKey: require('./invoice-key'),
  schema: require('./schema'),
  sqlite: require('./sqlite'),
  repository: require('./repository'),
  mst: require('./mst-manager'),
  queries: require('./queries'),
  importJob: require('./import-job'),
  autoSync: require('./auto-sync'),
  backfill: require('./backfill'),
  xmlParser: require('./xml-parser'),
  xmlScanner: require('./xml-scanner'),
  xmlImport: require('./xml-import'),
};
