'use strict';
// ---------------------------------------------------------------------------
// ĐỊNH DẠNG MST — một chỗ duy nhất, dùng cho cả server (require) và giao diện (window).
//
// Toàn bộ thân file nằm trong IIFE: các script của giao diện (period.js, renderer.js…) dùng
// chung MỘT scope global, nên khai báo `const api`, `const MAX_LENGTH`… ở cấp cao nhất sẽ
// ĐỤNG TÊN với file khác. Lỗi thật đã gặp:
//   period.js:1 Uncaught SyntaxError: Identifier 'api' has already been declared
//   renderer.js Uncaught ReferenceError: Period is not defined
// Chỉ để lộ ĐÚNG một biến: window.MstFormat / module.exports.
//
// CHO NHẬP TỰ DO: không bắt buộc chỉ toàn chữ số, không ép đúng 10 số. Người dùng gõ gì cũng
// nhận — kể cả MST chi nhánh dạng `8021214462-001`, mã có chữ, hoặc mã hồ sơ nội bộ.
//
// CHỈ CHẶN những ký tự PHÁ ĐƯỜNG DẪN, vì MST được dùng làm TÊN FILE/THƯ MỤC ở nhiều chỗ dùng
// chuỗi thô (`secrets/<mst>.json`, `jobs/<mst>.json`, `profiles/<mst>`, `MST-<mst>/`):
//   • dấu tách đường dẫn  /  \
//   • dấu hai chấm, và các ký tự Windows cấm trong tên file  : * ? " < > |
//   • ký tự điều khiển 0x00–0x1f
//   • `.` / `..` hoặc kết thúc bằng dấu chấm (Windows cắt đuôi ⇒ dễ trùng tên)
//   • tên dành riêng của Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
// Ngoài danh sách đó thì nhập gì cũng được.
// ---------------------------------------------------------------------------

(function () {
  const MAX_LENGTH = 64;
  const FORBIDDEN = /[\/\\:*?"<>|\x00-\x1f]/;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  const MST_HINT = 'MST/mã hồ sơ: gõ tự do (ví dụ 4500677693 hoặc 8021214462-001). Không dùng các ký tự / \\ : * ? " < > | .';

  function normalizeMst(value) { return String(value ?? '').trim(); }

  function isValidMst(value) {
    const text = normalizeMst(value);
    if (!text || text.length > MAX_LENGTH) return false;
    if (FORBIDDEN.test(text)) return false;
    if (text === '.' || text === '..' || text.endsWith('.')) return false;
    if (RESERVED.test(text)) return false;
    return true;
  }

  // MST gốc: bỏ phần mã chi nhánh sau dấu gạch nối (8021214462-001 → 8021214462) để đối chiếu với
  // MST trong XML hoá đơn — cổng thuế trả về MST gốc, không kèm mã chi nhánh.
  function baseMst(value) { return normalizeMst(value).split('-')[0]; }

  // Mọi cách viết có thể khớp với cùng một hồ sơ: nguyên văn + MST gốc.
  function mstAliases(value) {
    const text = normalizeMst(value);
    const base = baseMst(text);
    return base && base !== text ? [text, base] : [text];
  }

  // Gán vào một namespace DUY NHẤT — không rò biến nào ra scope chung.
  const api = { MAX_LENGTH, MST_HINT, normalizeMst, isValidMst, baseMst, mstAliases };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.MstFormat = api;
})();
