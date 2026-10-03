'use strict';
// ---------------------------------------------------------------------------
// PDF GỐC CỦA NHÀ CUNG CẤP (Mục 3)
//
// PHÂN BIỆT THEN CHỐT — hai thứ này KHÁC NHAU hoàn toàn:
//   • `pdf\`    : bản app DỰNG LẠI từ JSON của Cổng Thuế. KHÔNG có chữ ký số NCC.
//                 Có dải cảnh báo đỏ ở chân mỗi trang (xem invoice-a4.js ORIGIN_NOTE).
//   • `pdf-goc\`: bản PDF DO NHÀ CUNG CẤP PHÁT HÀNH, có chữ ký số. Đây mới là
//                 "hóa đơn gốc" mà người dùng cần khi nộp hoặc đối chiếu.
//
// ĐÃ KIỂM THẬT, không giả định (2026-10): trong toàn bộ hồ sơ của người dùng, KHÔNG
// nhà cung cấp nào có endpoint trả thẳng PDF không cần thao tác:
//   • VNPT (`…vnpt-invoice.com.vn`) — GET bị chuyển hướng `/Account/LogOn`: BẮT BUỘC
//     đăng nhập. Ngoài ra URL lưu trong XML là `https://host;817501;` — dấu `;…` dính
//     vào phần host nên URI đó vô dụng.
//   • EasyInvoice (`…easyinvoice.vn`) — `/` chuyển tới `/Search/Index`, là TRANG TRA
//     CỨU có biểu mẫu, không phải endpoint tải file.
//   • Cổng VNPT theo từng tenant, Viettel, FPT, CyberLotus — đều là cổng tra cứu.
//
// Vì vậy module này KHÔNG tự gọi endpoint của bên thứ ba (dễ vỡ, có rủi ro điều khoản
// sử dụng và chặn IP). Thay vào đó nó làm đúng việc app nên làm:
//
//   1. Ghép PDF gốc trong `pdf-goc\` với đúng hóa đơn, theo khoá 4 trường
//      (MST người bán · mẫu số · ký hiệu · số hóa đơn) — không cần người dùng làm gì.
//   2. Cho người dùng TỰ CHỌN file PDF gốc cho hóa đơn nào đó (PDF họ tải tay từ cổng,
//      hoặc PDF MISA của chính hồ sơ bán ra).
//   3. Xem PDF gốc NGAY TRONG APP (không mở trình duyệt ngoài).
//   4. Nói rõ vì sao hóa đơn nào chưa có PDF gốc — không để trống, không đoán.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const registry = require('./provider-registry');

// Thư mục con do app quản lý, đặt cạnh Mua_vao/Ban_ra theo đúng quy ước cây hiện có.
const ORIGINAL_FOLDER = 'pdf-goc';

// Khoá 4 trường định danh một hóa đơn trong tên file: MST người bán, mẫu số, ký hiệu,
// số hóa đơn. Tên file của app có thêm hậu tố chống trùng, nên so TIỀN TỐ, không so
// bằng (xem core.js:690 — `${mst}_${form}_${series}_${no}_${suffix}`).
function fileKey(mstBan, khmsHd, khhHd, shDon) {
  return [mstBan, khmsHd, khhHd, shDon]
    .map(value => String(value == null ? '' : value).trim())
    .filter(Boolean)
    .join('_')
    .toLowerCase();
}

// Dựng lại khoá từ tên file trên đĩa: lấy 4 đoạn đầu ngăn bởi dấu _.
// Tên do app đặt: mst_form_series_no_suffix → 4 đoạn đầu là mst_form_series_no.
// Tên người dùng đặt tay thường là mst_form_series_no hoặc ký hiệu+số → cũng 4 đoạn
// nếu họ đặt theo cùng quy ước; nếu không khớp thì người dùng tự chọn file (đường 2).
function keyOfFileName(name) {
  const stem = String(name || '').replace(/\.[Pp][Dd][Ff]$/, '');
  const parts = stem.split('_').filter(Boolean);
  return (parts.length >= 4 ? parts.slice(0, 4) : parts).join('_').toLowerCase();
}

// Quét thư mục pdf-goc một lần, trả về Map khoá → đường dẫn (giữ file đầu tiên nếu trùng).
function indexOriginalFolder(mstDir, direction) {
  const map = new Map();
  const folder = path.join(mstDir, direction, ORIGINAL_FOLDER);
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return map; }
  for (const name of names) {
    if (!/\.pdf$/i.test(name)) continue;
    const key = keyOfFileName(name);
    if (!key || map.has(key)) continue;
    map.set(key, path.join(folder, name));
  }
  return map;
}

// PDF gốc của 1 hóa đơn: ưu tiên đường dẫn người dùng đã chọn, không thì tự ghép từ
// thư mục pdf-goc. Trả '' nếu không có, hoặc có nhưng file không còn trên đĩa.
function findOriginalPdf(mstDir, direction, row, index) {
  const stored = String(row.original_pdf || '').trim();
  if (stored) {
    const full = path.resolve(mstDir, stored);
    const root = path.resolve(mstDir);
    // Đường dẫn lưu phải nằm trong thư mục MST — chặn đọc file ngoài phạm vi.
    if (full !== root && !full.startsWith(root + path.sep)) return '';
    try { if (fs.statSync(full).isFile()) return full; } catch { /* không còn → thử tự ghép */ }
  }
  const key = fileKey(row.mst_ban, row.khms_hd, row.khh_hd, row.so_hd);
  if (!key) return '';
  const table = index || indexOriginalFolder(mstDir, direction);
  return table.get(key) || '';
}

// Lý do cụ thể khi chưa có PDF gốc — luôn trả lời được, không để trống (nguyên tắc từ
// provider-registry.reasonMissing).
//
// PHẢI KHỚP TÌNH TRẠNG THẬT. Bản đầu viết một câu CỐ ĐỊNH cho hóa đơn bán ra rồi dùng
// cho MỌI hóa đơn bán ra — kể cả hóa đơn CÓ cổng tra cứu. Người dùng đọc tooltip thấy
// hai câu trái nhau ("có cổng tra cứu" nhưng lại báo "không có mã tra cứu") thì mất
// niềm tin vào cả cột. Nay mọi nhánh đều dựng từ dữ liệu thật của chính hóa đơn đó.
function reasonMissing(row) {
  const portal = String(row.lookup_url || '').trim();
  const hasPortal = /^https?:\/\//i.test(portal);
  const hasCode = Boolean(String(row.lookup_code || '').trim());
  const providerName = row.provider_name || 'nhà cung cấp';
// Dùng tên miền ĐÃ LÀM SẠCH: URL kiểu `…vnpt-invoice.com.vn;817503;` đọc ra sẽ
  // lộ dấu `;817503;` trong tooltip, người dùng tưởng app bị dính ký tự rác.
  const host = portalHost(portal);

  if (row.direction === 'SELL') {
    // Hóa đơn bán ra: bản gốc do chính hồ sơ phát hành, Cổng Thuế không có.
    const parts = [`Hoá đơn do hồ sơ này phát hành — PDF gốc nằm ở hệ thống ${providerName}, Cổng Thuế không có bản PDF này`];
    if (hasPortal) parts.push(`tra tại cổng ${host} bằng số hóa đơn`);
    else parts.push('chưa biết cổng tra cứu của hồ sơ này');
    if (hasCode) parts.push(`mã tra cứu đã lưu: ${row.lookup_code}`);
    return `${parts.join('; ')}.`;
  }

  if (hasPortal && hasCode) {
    return `${providerName}: tra tại cổng ${host} bằng mã đã lưu, cần nhập CAPTCHA hoặc xác nhận trên cổng.`;
  }
  if (hasPortal) {
    return `${providerName}: có cổng tra cứu ${host} nhưng chưa có mã tra cứu trong dữ liệu Cổng Thuế.`;
  }
  if (hasCode) {
    return `${providerName}: có mã tra cứu nhưng chưa có cổng tra cứu của người bán này.`;
  }
  // Không có gì để dựng câu riêng ⇒ nói đúng nguyên nhân sâu nhất mà biết được.
  return registry.reasonMissing(row.msttcgp, row.lookup_code, row.lookup_url);
}

// Làm sạch cổng tra cứu lấy từ XML.
//
// XML của VNPT ghi cổng dạng `https://host;817501;` — dấu `;…` bị DÍNH VÀO TÊN MIỀN
// (URL chuẩn không tách cổng ra), nên `new URL(...).hostname` trả về
// `host.vnpt-invoice.com.vn;817501;`. URI đó không mở được, và nếu đưa nguyên xi vào
// kiểm tra tên miền thì mọi hóa đơn VNPT (15 hóa đơn trong kho thật) đều bị từ chối.
//
// Ý nghĩa thật của URL đó chỉ là `https://host` kèm cổng 817501 — cổng mặc định của
// VNPT là 443/80 cho HTTPS nên bỏ cổng đó đi là dùng được. Hàm này trả về URL sạch, hoặc
// chuỗi rỗng nếu không phải http(s) / không có tên miền.
function cleanPortalUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { return ''; }
  const host = String(parsed.hostname || '');
  // Không có tên miền (localhost, rỗng, chỉ có cổng) ⇒ không dùng được.
  if (!host.includes('.')) return '';
  // KHÔNG CÓ RÁC thì trả NGUYÊN XI. Bỏ qua bước này thì `https://x.vn/` bị đổi thành
  // `https://x.vn` — vẫn mở được nhưng khác dữ liệu gốc, và làm test/so sánh đỏ.
  // Nguyên tắc: chỉ sửa đúng cái đang hỏng, không "chuẩn hoá" phần đang đúng.
  if (!/[;\s<>"'\\^`{|}]/.test(host)) return raw;
  // Cắt phần `;cổng;` (và mọi rác đuôi sau nó) ra khỏi tên miền.
  const fixed = host.replace(/;.*$/, '').replace(/[\s<>"'\\^`{|}]/g, '');
  if (!fixed.includes('.')) return '';
  const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
  return `${parsed.protocol}//${fixed}${path}${parsed.search}`;
}

// Tên miền đã làm sạch, để hiển thị cho người dùng đọc.
function portalHost(value) {
  const clean = cleanPortalUrl(value);
  if (!clean) return '';
  try { return new URL(clean).hostname; } catch { return ''; }
}
// Nhãn + màu cho cột trong danh sách: 'have' | 'lookup' | 'none'
function badgeFor(row, originalPath) {
  if (originalPath) {
    return { kind: 'have', label: 'Có PDF gốc', title: originalPath };
  }
// Chỉ coi là "có cổng tra cứu" khi URL làm sạch còn đúng dạng http(s) — nếu không thì
  // cột báo vàng "Tra cứu NCC" nhưng bấm vào không mở được gì cả.
  const clean = cleanPortalUrl(row.lookup_url);
  if (clean) {
    return { kind: 'lookup', label: 'Tra cứu NCC', title: clean };
  }
  return { kind: 'none', label: 'Chỉ có bản dựng', title: reasonMissing(row) };
}

// Đường dẫn tương đối để lưu vào DB (để dời thư mục lưu không hỏng).
function toRelative(mstDir, fullPath) {
  const root = path.resolve(mstDir);
  const full = path.resolve(fullPath);
  if (full === root || !full.startsWith(root + path.sep)) return '';
  return full.slice(root.length + 1);
}

module.exports = {
  ORIGINAL_FOLDER,
  fileKey,
  keyOfFileName,
  indexOriginalFolder,
  findOriginalPdf,
  reasonMissing,
  badgeFor,
  toRelative,
  cleanPortalUrl,
  portalHost,
};






