'use strict';
// Luồng worker cho src/excel-worker.js: nhận { items } rồi trả lại buffer .xlsx.
// Chỉ require module dựng Excel THUẦN — không đụng node:sqlite, không mạng, không trạng thái chung.
const { parentPort } = require('node:worker_threads');
const excelExport = require('./invoice-excel');
// Guard parentPort: file này cũng được require TĨNH từ luồng chính (để bộ đóng gói pkg thấy được
// file và đưa vào EXE), lúc đó parentPort = null ⇒ không đăng ký gì, vô hại.
if (parentPort) {
  parentPort.on('message', ({ items } = {}) => {
    try {
      const buffer = excelExport.summaryWorkbook(Array.isArray(items) ? items : []);
      parentPort.postMessage({ ok: true, buffer });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
    }
  });
}
