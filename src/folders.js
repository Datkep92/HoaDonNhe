'use strict';
// Kiểm tra thư mục lưu trước khi dùng: phải là đường dẫn đầy đủ, không phải ổ đĩa gốc, tạo được
// và GHI được (thử ghi một file tạm). Nhờ vậy ổ chỉ đọc / đĩa CD-DVD / thư mục bị chặn quyền bị
// phát hiện ngay lúc chọn, thay vì lỗi EPERM giữa lúc tải hóa đơn.
const fs = require('node:fs');
const path = require('node:path');
const PROBE = '.hoa-don-thu-ghi.part';

async function ensureFolder(folder) {
  const value = String(folder ?? '').trim();
  if (!value) throw new Error('Chưa chọn thư mục lưu. Bấm “Chọn thư mục…” rồi chọn một thư mục.');
  if (!path.isAbsolute(value)) throw new Error('Đường dẫn phải đầy đủ, ví dụ D:\\HoaDon\\2026.');
  if (/^[A-Za-z]:[\\/]?$/.test(value)) {
    const drive = value.replace(/[\\/]+$/, '') || value;
    throw new Error(`"${value}" là ổ đĩa gốc nên không ghi trực tiếp được. Chọn một thư mục con, ví dụ ${drive}\\HoaDon\\2026.`);
  }
  try { await fs.promises.mkdir(value, { recursive: true }); }
  catch (error) { throw new Error(`Không tạo được thư mục "${value}" (${error.code || error.message}). Kiểm tra ổ đĩa rồi chọn lại.`); }
  const probe = path.join(value, PROBE);
  try { await fs.promises.writeFile(probe, 'ok'); await fs.promises.unlink(probe); }
  catch (error) {
    throw new Error(`Không ghi được vào thư mục "${value}" (${error.code || error.message}). Ổ đĩa có thể chỉ đọc (đĩa CD/DVD) hoặc bị chặn quyền — chọn thư mục khác.`);
  }
  return value;
}

module.exports = { ensureFolder, PROBE };
