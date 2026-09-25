'use strict';
// Kiểm tra thư mục lưu trước khi dùng: phải là đường dẫn đầy đủ, không phải ổ đĩa gốc, tạo được
// và GHI được (thử ghi một file tạm). Nhờ vậy ổ chỉ đọc / đĩa CD-DVD / thư mục bị chặn quyền bị
// phát hiện ngay lúc chọn, thay vì lỗi EPERM giữa lúc tải hóa đơn.
const fs = require('node:fs');
const path = require('node:path');
const PROBE = '.hoa-don-thu-ghi.part';

async function ensureFolder(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Chưa chọn thư mục lưu. Bấm “Chọn thư mục…” rồi chọn một thư mục.');
  if (!path.isAbsolute(value)) throw new Error('Đường dẫn phải đầy đủ, ví dụ D:\\HoaDon\\2026.');
  const target = /^[A-Za-z]:[\\/]?$/.test(value) ? path.join(value.replace(/[\\/]+$/, '') + path.sep, 'CN-invoice') : value;
  try { await fs.promises.mkdir(target, { recursive: true }); }
  catch (error) { throw new Error(`Không tạo được thư mục "${target}" (${error.code || error.message}). Kiểm tra ổ đĩa rồi chọn lại.`); }
  const probe = path.join(target, PROBE);
  try { await fs.promises.writeFile(probe, 'ok'); await fs.promises.unlink(probe); }
  catch (error) {
    throw new Error(`Không ghi được vào thư mục "${target}" (${error.code || error.message}). Ổ đĩa có thể chỉ đọc (đĩa CD/DVD) hoặc bị chặn quyền — chọn thư mục khác.`);
  }
  return target;
}

module.exports = { ensureFolder, PROBE };
