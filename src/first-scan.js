'use strict';
// ---------------------------------------------------------------------------
// QUÉT LẦN ĐẦU CHO MỘT MST — 10 ngày gần nhất, MUA VÀO trước rồi BÁN RA.
//
// NGHIỆP VỤ (yêu cầu người dùng): khách vừa thêm MST và đăng nhập thành công lần đầu thì app tự
// lấy 10 ngày hóa đơn gần nhất cho CẢ HAI chiều, để khách có dữ liệu dùng ngay, không phải tự bấm.
//   · CHỈ chạy MỘT lần cho mỗi MST.
//   · Đăng nhập THẤT BẠI thì KHÔNG đánh dấu gì ⇒ lần đăng nhập sau VẪN chạy luồng này.
//   · CHỈ áp cho MST THÊM MỚI từ bản này trở đi. MST cũ không có ô nhớ `firstScan` nên không chạy.
//
// Vì sao tách riêng file này: toàn bộ phần QUYẾT ĐỊNH (cửa sổ ngày, thứ tự chạy, có nên chạy hay
// không) nằm ở đây, KHÔNG phụ thuộc server/Chrome/SQLite ⇒ test được trực tiếp mà không phải dựng
// cả app. server.js chỉ đọc kết quả rồi thực thi.
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 10;
const DAY_MS = 86400000;
// Lượt quét LỖI chỉ được thử lại sau 30 phút. Vì sao cần: `checkLogin()` chạy mỗi lần khách bấm
// vào dòng MST còn phiên sẵn, nên nếu không chặn thì bấm lia lịa sẽ dội liên tiếp request vào cổng
// thuế — đúng thứ mà pace.js và các cổng của app đang tránh. Không ảnh hưởng đường đi bình thường
// (khách đăng nhập lại sau đó vài giờ).
const RETRY_COOLDOWN_MS = 30 * 60 * 1000;

// Ô nhớ `firstScan` trong du_lieu/accounts.json — 4 trạng thái, KHÔNG phải "rồi/chưa":
//   pending — vừa thêm MST, chưa quét lần nào
//   running — đang quét. Ghi TRƯỚC khi chạy, để tắt app giữa chừng thì lần sau KHÔNG quét lại
//             từ đầu (nếu chỉ ghi "xong" khi thành công thì lần bị tắt ngang sẽ quét lại mãi).
//   done    — đã quét xong ⇒ KHÔNG bao giờ chạy lại
//   failed  — quét lỗi (mạng / cổng thuế chặn) ⇒ cho chạy lại ở lần đăng nhập sau. Nếu ghi "done"
//             luôn khi lỗi thì khách mất dữ liệu lần đầu mà không ai biết.
const STATE = { PENDING: 'pending', RUNNING: 'running', DONE: 'done', FAILED: 'failed' };

// Ô nhớ mới cho một MST vừa được thêm vào danh sách.
function newRecord() {
  return { state: STATE.PENDING, at: '', from: '', to: '' };
}

// KHÔNG dùng "false"/"true" đơn giản: MST cũ (thêm trước bản này) không có `firstScan`, và đó
// chính là cách phân biệt "không thuộc diện" với "thuộc diện nhưng chưa chạy".
function isEligible(record) {
  return !!(record && record.firstScan);
}

// Cửa sổ 10 NGÀY TRỌN tính theo giờ Việt Nam, GỒM cả hôm nay: [hôm nay − 9, hôm nay].
// VN là UTC+7 và KHÔNG có giờ mùa hè, nên trừ đúng bội số 24h giữ nguyên giờ trong ngày ⇒ ngày
// VN lùi đúng 9 ngày, không bị lệch sang ngày khác. Cùng cách catchupEndDay() đang dùng.
function windowFor(dayOf, now = Date.now()) {
  return { from: dayOf(now - (WINDOW_DAYS - 1) * DAY_MS), to: dayOf(now) };
}

// Thứ tự chạy: MUA VÀO trước, BÁN RA sau — KHÔNG song song (giữ đúng luật của app: không dồn
// request vào cổng thuế; mỗi lượt /api/stream chỉ nhận MỘT chiều nên phải hai lượt).
// Định dạng mặc định: XML. App tự nhập XML vào SQLite sau khi tải xong (autoImportAfterDownload)
// nên tab Tổng quan / Kho dữ liệu vẫn có số liệu ngay, chỉ là không sinh thêm file Excel.
function requestsFor({ from, to }) {
  return ['purchase', 'sold'].map(direction => ({
    direction, from, to, family: 'both', status: '', formats: ['xml'],
  }));
}

// QUYẾT ĐỊNH có chạy lượt quét đầu cho MST này hay không, ngay sau khi đăng nhập thành công.
// `env.output` = thư mục lưu; `env.busy` = MST đang có tác vụ; `env.alreadyQueued` = đã xếp hàng.
// Cổng LICENSE kiểm ở phần chạy nền (là hàm async), không kiểm ở đây.
function decide(record, env = {}) {
  if (!isEligible(record)) return { run: false, reason: 'MST cũ — không thuộc diện quét lần đầu' };
  if (record.firstScan.state === STATE.DONE) return { run: false, reason: 'đã quét lần đầu rồi' };
  if (record.firstScan.state === STATE.RUNNING) return { run: false, reason: 'đang quét dở (hoặc đã quét dở lần trước)' };
  if (env.alreadyQueued) return { run: false, reason: 'đã xếp hàng quét lần đầu' };
  if (!env.output) return { run: false, reason: 'chưa có thư mục lưu' };
  if (env.busy) return { run: false, reason: 'MST đang chạy tác vụ khác' };
  // Lỗi rồi thì chờ hết "thời gian nguội" mới thử lại — tránh bấm lia lịa dội request vào cổng thuế.
  if (record.firstScan.state === STATE.FAILED && env.now !== undefined) {
    const failedAt = Date.parse(record.firstScan.at || '');
    if (Number.isFinite(failedAt) && env.now - failedAt < RETRY_COOLDOWN_MS) {
      return { run: false, reason: 'vừa lỗi, chưa hết thời gian chờ thử lại' };
    }
  }
  return { run: true, reason: record.firstScan.state === STATE.FAILED ? 'chạy lại sau lỗi' : 'quét lần đầu' };
}

module.exports = { WINDOW_DAYS, DAY_MS, RETRY_COOLDOWN_MS, STATE, newRecord, isEligible, windowFor, requestsFor, decide };
