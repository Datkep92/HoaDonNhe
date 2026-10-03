'use strict';
// ---------------------------------------------------------------------------
// Điểm vào tầng dữ liệu (PHASE 1 – Data Core).
// Chỉ require() các module con, KHÔNG tự chạy gì và KHÔNG đụng tới luồng thủ công.
// ---------------------------------------------------------------------------

module.exports = {
  invoiceKey: require('./invoice-key'),
  invoiceState: require('./invoice-state'),
  paymentMethod: require('./payment-method'),
  schema: require('./schema'),
  sqlite: require('./sqlite'),
  repository: require('./repository'),
  mst: require('./mst-manager'),
  queries: require('./queries'),
  taxRules: require('./tax-rules'),
  importJob: require('./import-job'),
  autoSync: require('./auto-sync'),
  backfill: require('./backfill'),
  backfillCatchup: require('./backfill-catchup'),
  xmlParser: require('./xml-parser'),
  xmlScanner: require('./xml-scanner'),
  xmlWatcher: require('./xml-watcher'),
  xmlImport: require('./xml-import'),
  excelExport: require('./excel-export'),
  // Mục 4.2 — bảng tổng hợp theo quý để kê khai thuế GTGT (chưa sinh XML: Mục 4.3).
  vatSummary: require('./vat-summary'),
  // Mục 3 — PDF GỐC của nhà cung cấp (khác bản app dựng lại trong pdf\).
  originalPdf: require('./original-pdf'),
  bankStatement: require('./bank-statement'),
  reconciliation: require('./reconciliation'),
  identityCandidates: require('./identity-candidates'),
  // v9 — HỖ TRỢ KẾ TOÁN: xuất file "Mẫu bán hàng" cho MISA AMIS + danh mục hàng hoá công ty.
  misaExport: require('./misa-export'),
  productMaster: require('./product-master'),
};
