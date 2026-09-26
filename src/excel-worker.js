'use strict';
// Dựng workbook Excel trong WORKER THREAD để không chặn vòng lặp sự kiện chính (UI poll liên tục,
// còn SheetJS với vài nghìn dòng làm cả tiến trình khựng vài trăm ms). Khi worker không khởi động
// được (môi trường đóng gói pkg, nền tảng thiếu worker_threads…) tự rơi về đường đồng bộ trong
// luồng chính — cùng một module, cùng một đầu ra, chỉ là không còn lợi ích bất đồng bộ.
//
// Chú ý đóng gói: worker chạy BÊN TRONG snapshot của pkg thì require tương đối vẫn đúng; chạy từ
// EXE không snapshot được (pkg trước @yao-pkg mới nhất) thì khởi tạo worker hỏng ở constructor —
// trường hợp đó rơi xuống fallback bên dưới, app vẫn hoạt động bình thường.
const path = require('node:path');

let workerPool = null;
let workerBroken = false;

function getWorker() {
  if (workerBroken) return null;
  if (workerPool) return workerPool;
  try {
    const { Worker } = require('node:worker_threads');
    // File worker được nạp bằng đường dẫn runtime; require TĨNH bên dưới chỉ để bộ đóng gói (pkg)
    // thấy và đưa file vào EXE — ở luồng chính parentPort là null nên nó vô hại.
    require('./excel-worker-thread');
    const file = path.join(__dirname, 'excel-worker-thread.js');
    workerPool = new Worker(file);
    workerPool.unref(); // không giữ tiến trình sống chỉ vì worker này còn đó
    workerPool.on('error', () => { workerBroken = true; try { workerPool.terminate(); } catch { /* đã chết */ } workerPool = null; });
    return workerPool;
  } catch {
    workerBroken = true;
    return null;
  }
}

function buildSync(items) {
  // Như cũ: dựng thẳng trong luồng chính. Đầu ra phải GIỐNG HỆT nhánh worker (bảng tổng hợp 13 cột).
  const excelExport = require('./invoice-excel');
  return excelExport.summaryWorkbook(items);
}

function buildExcelBuffer(items) {
  const worker = getWorker();
  if (!worker) return buildSync(items);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    // LUÔN phải settle. Hai nhánh chết của bản trước:
    //   • worker trả ok:false  ⇒ handler đặt settled = true RỒI gọi fallback(), mà fallback lại
    //     `if (settled) return` ⇒ KHÔNG làm gì ⇒ promise treo VĨNH VIỄN (timer đã bị clearTimeout nên
    //     không còn lưới nào đỡ). Đây là nguyên nhân lượt tải kẹt `busy = true`, nút cứ ở "Ngưng tải".
    //   • buildSync ném lỗi ⇒ resolve không bao giờ được gọi.
    // Nay: ok:false thì rơi về đường đồng bộ, lỗi thì reject để lượt tải kết thúc bằng thông báo lỗi.
    const fallback = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { resolve(buildSync(items)); }
      catch (error) { reject(error); }
    };
    try {
      timer = setTimeout(fallback, 60000); // worker treo ⇒ vẫn có file như cũ
      if (timer.unref) timer.unref();
      worker.once('message', message => {
        if (settled) return;
        if (message && message.ok) {
          settled = true; if (timer) clearTimeout(timer);
          resolve(Buffer.from(message.buffer));
          return;
        }
        fallback(); // worker báo lỗi ⇒ dựng lại ở luồng chính, KHÔNG được bỏ rơi promise
      });
      worker.once('error', fallback);
      worker.postMessage({ items });
    } catch {
      fallback();
    }
  });
}

module.exports = { buildExcelBuffer };
