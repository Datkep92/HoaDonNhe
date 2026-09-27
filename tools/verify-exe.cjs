'use strict';
// ---------------------------------------------------------------------------
// Kiểm EXE đã đóng gói có ĐỦ file nhúng mà app cần hay không.
//
// Vì sao có file này: `pkg` khi thiếu asset chỉ *cảnh báo* ("Warning Cannot stat, ENOENT") rồi
// VẪN xuất EXE. Đã xảy ra thật: bản phát hành qua GitHub Actions thiếu src/onnx/common.onnx +
// common.json nên EXE tải về KHÔNG giải được CAPTCHA — mà build vẫn báo "xanh" và không ai biết.
//
// Cách kiểm: pkg nhúng TÊN file dạng không nén (chỉ nội dung mới nén), nên tìm tên trong file là
// đủ để biết nó có mặt. Không cần mạng, không cần chạy app.
//
// Dùng: node tools/verify-exe.cjs [đường-dẫn-exe]     (mặc định: release/CN-Tax-Tools-v<version>.exe)
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

// Danh sách BẮT BUỘC — rút từ package.json > pkg.assets, chỉ giữ thứ app THẬT SỰ cần lúc chạy.
// Thiếu bất kỳ mục nào ⇒ EXE khuyết ⇒ build phải coi là thất bại.
const REQUIRED = [
  // Giao diện
  'index.html', 'style.css', 'login.css', 'data-view.css', 'icon.png',
  // Mã chạy trong cửa sổ app
  'renderer.js', 'tax-login.js', 'chat-widget.js', 'app-settings.js', 'update-ui.js',
  'app-lock.js', 'support.js', 'period.js', 'mst-format.js', 'data-ui.js',
  // Dựng Excel (kể cả bản chạy trong worker thread)
  'xlsx.cjs', 'excel-worker.js', 'excel-worker-thread.js',
  // OCR CAPTCHA — chỗ đã từng thiếu và làm bản phát hành không đăng nhập tự động được
  'common.onnx', 'common.json', 'onnxruntime',
  // Tài nguyên dựng hoá đơn A4
  'viewinvoice-bg.jpg', 'sign-check.jpg', 'qrcode.js',
  // KHÔNG đòi 'thong-bao.mp3': đó là âm thanh TUỲ CHỌN (server.js ghi rõ "bỏ file ... không có thì
  // dùng tiếng mặc định") và file chưa từng có trong repo. Đòi nó sẽ khiến MỌI build đều đỏ vô cớ.
  // (Đây cũng là nguồn của cảnh báo "Warning Cannot stat, ENOENT" của pkg — do glob
  // src/template/*.mp3 không khớp file nào, KHÔNG phải do thiếu model như tôi từng đoán sai.)
];

function verify(exePath) {
  const bytes = fs.readFileSync(exePath);
  const missing = REQUIRED.filter(name => bytes.indexOf(Buffer.from(name)) < 0);
  return { missing, size: bytes.length, total: REQUIRED.length };
}

function defaultExe() {
  const { version } = require('../src/version');
  const label = process.env.HOADON_BUILD_LABEL ? `-${process.env.HOADON_BUILD_LABEL}` : '';
  return path.join(__dirname, '..', 'release', `CN-Tax-Tools-v${version}${label}.exe`);
}

if (require.main === module) {
  const exe = process.argv[2] || defaultExe();
  if (!fs.existsSync(exe)) {
    console.error(`✗ Không thấy EXE: ${exe}`);
    process.exit(1);
  }
  const { missing, size, total } = verify(exe);
  const mb = (size / 1048576).toFixed(1);
  if (missing.length) {
    console.error(`✗ EXE THIẾU ${missing.length}/${total} file nhúng bắt buộc (${mb} MB):`);
    for (const name of missing) console.error(`    - ${name}`);
    console.error('  EXE này KHÔNG được phát hành. Chạy "npm run fetch-onnx" rồi build lại.');
    process.exit(1);
  }
  console.log(`✓ EXE đủ ${total}/${total} file nhúng bắt buộc (${mb} MB).`);
}

module.exports = { verify, REQUIRED, defaultExe };
