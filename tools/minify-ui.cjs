'use strict';
// ---------------------------------------------------------------------------
// Rút gọn byte tài sản giao diện NGAY LÚC ĐÓNG GÓI — đo thực tế: 272 KB → 200 KB (−27%).
//
// Vì sao không rút gọn thẳng vào src/*.js: file nguồn phải còn ĐỌC ĐƯỢC. Bản rút gọn ghi ra file
// riêng cạnh bản gốc (`src/renderer.js` → `src/renderer.min.js`) và KHÔNG nằm trong git; server
// tự chọn bản rút gọn khi phục vụ (xem minifiedSibling trong server.js). Nhờ vậy:
//   - `node src/server.js` khi dev vẫn thấy đúng bản vừa sửa (bản .min cũ hơn ⇒ bị bỏ qua);
//   - EXE thiếu bản .min (máy build không có esbuild) vẫn chạy bình thường bằng bản gốc.
//
// KHÔNG đổi tên định danh (minifyIdentifiers: false): đây là các <script> cổ điển DÙNG CHUNG một
// phạm vi toàn cục — renderer.js gọi hàm do mst-format.js/period.js định nghĩa, data-ui.js gọi
// window.hdBootReady của renderer.js. Đổi tên là vỡ giao diện ngay.
// Cũng KHÔNG bật minifySyntax cho JS: chỉ cần cắt chú thích + khoảng trắng là đã được 27%, còn
// minifySyntax có thể rút gọn/đổi câu lệnh — không đánh đổi "giữ nguyên logic" lấy vài KB.
// Chạy tay: node tools/minify-ui.cjs
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

// Phải TRÙNG với các route tài sản tĩnh trong server.js (tests/minify-ui.test.js khoá lại điều
// này). Cố ý KHÔNG đụng: vendor/pdfjs/*.mjs (đã rút gọn sẵn, của bên thứ ba), vendor/sound.js
// (bên thứ ba), và mọi file chỉ được `require()` phía Node (tax-login.js, app-lock.js, support.js,
// excel-worker*.js) vì chúng không đi qua đường phục vụ tĩnh.
const TARGETS = [
  { name: 'renderer.js', loader: 'js' },
  { name: 'data-ui.js', loader: 'js' },
  { name: 'app-settings.js', loader: 'js' },
  { name: 'chat-widget.js', loader: 'js' },
  { name: 'ai-chat.js', loader: 'js' },
  { name: 'ai-bridge.js', loader: 'js' },
  { name: 'ai-providers.js', loader: 'js' },
  { name: 'update-ui.js', loader: 'js' },
  { name: 'bank-pdf.js', loader: 'js' },
  { name: 'period.js', loader: 'js' },
  { name: 'mst-format.js', loader: 'js' },
  { name: 'dvt-ui.js', loader: 'js' },
  { name: 'mst-lookup-ui.js', loader: 'js' },
  { name: 'tokhai-ui.js', loader: 'js' },
  { name: 'style.css', loader: 'css' },
  { name: 'login.css', loader: 'css' },
  { name: 'data-view.css', loader: 'css' },
];

function esbuild() {
  try {
    return require('esbuild');
  } catch {
    // Không phải phụ thuộc trực tiếp trong package.json (đi kèm @yao-pkg/pkg). Thiếu nó thì bỏ qua
    // bước rút gọn chứ KHÔNG làm đỏ build: app vẫn chạy bằng bản gốc.
    throw new Error('chưa có esbuild trong node_modules — bỏ qua bước rút gọn tài sản giao diện');
  }
}

// Rút gọn MỘT chuỗi. Tách riêng để test gọi trực tiếp mà không phải ghi ra đĩa.
function minifySource(code, loader) {
  const api = esbuild();
  const options = loader === 'css'
    ? { loader: 'css', minifyWhitespace: true, minifySyntax: true, legalComments: 'none', charset: 'utf8' }
    : { loader: 'js', minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, legalComments: 'none', charset: 'utf8' };
  return String(api.transformSync(code, options).code || '');
}

// Tên bản rút gọn của một tài sản: 'renderer.js' -> 'renderer.min.js'. Tài sản không phải .js/.css
// (ảnh, .mjs…) trả về '' — không có bản rút gọn.
function minifiedName(name) {
  const match = /^(.*)\.(js|css)$/.exec(String(name || ''));
  return match ? `${match[1]}.min.${match[2]}` : '';
}

function minify({ dir = SRC, log = console.log } = {}) {
  const written = [];
  for (const target of TARGETS) {
    const source = path.join(dir, target.name);
    const code = fs.readFileSync(source, 'utf8');
    const output = minifySource(code, target.loader);
    const out = path.join(dir, minifiedName(target.name));
    fs.writeFileSync(out, output);
    written.push({ name: target.name, out: minifiedName(target.name), before: code.length, after: output.length });
    log(`  ${target.name} ${code.length} → ${output.length} B (−${Math.round((1 - output.length / code.length) * 100)}%)`);
  }
  // Dọn bản rút gọn MỒ CÔI: tài sản bị bỏ khỏi TARGETS (hoặc đổi tên) mà file .min còn nằm lại sẽ
  // được server phục vụ như bản mới nhất — đúng loại lỗi "sửa mãi không thấy đổi".
  const keep = new Set(written.map(item => item.out));
  for (const name of fs.readdirSync(dir)) {
    if (!/\.min\.(js|css)$/.test(name) || keep.has(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); log(`  (dọn) ${name}`); } catch { /* không xoá được thì thôi */ }
  }
  const before = written.reduce((sum, item) => sum + item.before, 0);
  const after = written.reduce((sum, item) => sum + item.after, 0);
  log(`Rút gọn ${written.length} tài sản giao diện: ${before} → ${after} B (−${Math.round((1 - after / before) * 100)}%)`);
  return written;
}

module.exports = { TARGETS, minify, minifySource, minifiedName, SRC };

if (require.main === module) {
  try {
    minify();
  } catch (error) {
    console.error(`LỖI rút gọn: ${error.message}`);
    process.exit(1);
  }
}
