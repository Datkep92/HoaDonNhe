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
  // Logo thương hiệu trong sidebar: index.html trỏ tới file riêng này (KHÔNG nhúng base64 để
  // index.html nhẹ). Thiếu nó thì app vẫn chạy nhưng sidebar trắng logo — đúng kiểu "bản khuyết
  // im lặng" mà bước kiểm này sinh ra để chặn.
  'brand-logo.png',
  // Mã chạy trong cửa sổ app
  'renderer.js', 'tax-login.js', 'chat-widget.js', 'app-settings.js', 'update-ui.js',
  'app-lock.js', 'support.js', 'period.js', 'mst-format.js', 'data-ui.js',
  'ai-chat.js', 'ai-providers.js', 'ai-service.js', 'agent.js', 'openrouter-client.js',
  'tool-registry.js', 'tool-router.js', 'dataset-store.js', 'safe-js.js', 'audit-log.js',
  'attachments.js', 'cloud-tools.js',
  'identity.js', 'model-provider.js', 'session-store.js', 'access-policy.js',
  'data-minimizer.js', 'context-manager.js', 'permission-engine.js',
  'emscripten-module.cjs', 'emscripten-module.wasm',
  // SAO KÊ NGÂN HÀNG — CẢ MỘT TAB. Đã xảy ra thật: bản 1.0.7 phát hành trên GitHub KHÔNG có tab này
  // (quét thẳng file EXE 1.0.7: thiếu bank-pdf.js, bank-statement.js, pdf.min.mjs, pdf.worker.min.mjs
  // và cả chuỗi "Sao kê ngân hàng") vì các file mới chưa được khai vào pkg.assets / chưa vào git.
  // pkg chỉ CẢNH BÁO rồi vẫn xuất EXE, nên phải có tên ở đây để build ĐỎ khi thiếu.
  'bank-pdf.js', 'bank-statement.js', 'pdf.min.mjs', 'pdf.worker.min.mjs',
  // Dựng Excel (kể cả bản chạy trong worker thread)
  'xlsx.cjs', 'excel-worker.js', 'excel-worker-thread.js',
  // OCR CAPTCHA — chỗ đã từng thiếu và làm bản phát hành không đăng nhập tự động được
  'common.onnx', 'common.json', 'onnxruntime',
  // Tài nguyên dựng hoá đơn A4
  'viewinvoice-bg.jpg', 'sign-check.jpg', 'qrcode.js',
  // MẪU MISA cho tab "Hỗ trợ kế toán": file xuất giữ NGUYÊN 8 hàng đầu của chính file này (tiêu đề
  // + hướng dẫn + 3 ô gộp nhóm), và TIÊM khối danh sách chọn của mẫu vào file .xlsx.
  // Thiếu bất kỳ file nào ⇒ tab đó KHÔNG xuất được file MISA đọc được — đúng loại "bản khuyết im
  // lặng" mà bước kiểm này sinh ra để chặn.
  'mau-ban-hang.xls',
  'mau-ban-hang-dv.xml',
  // KHÔNG đòi 'thong-bao.mp3': đó là âm thanh TUỲ CHỌN (server.js ghi rõ "bỏ file ... không có thì
  // dùng tiếng mặc định") và file chưa từng có trong repo. Đòi nó sẽ khiến MỌI build đều đỏ vô cớ.
  // (Đây cũng là nguồn của cảnh báo "Warning Cannot stat, ENOENT" của pkg — do glob
  // TẢI PDF GỐC TỪ NHÀ CUNG CẤP (mục 3). provider-download.js đọc 4 script runner bằng
  // fs.readFileSync(__dirname + 'provider-reference/…') LÚC CHẠY, không phải lúc build.
  // Nếu chúng không nằm trong EXE thì TÍNH NĂNG CHẾT ÂM THẦM — app vẫn mở được, nút vẫn
  // bấm được, chỉ tới lúc tải PDF gốc mới ném lỗi đọc file. Bước kiểm này sinh ra để chặn
  // đúng kiểu "bản khuyết im lặng" ấy, nên tên chúng phải nằm ở đây.
  'provider-reference/generic-runner.js',
  'provider-reference/misa-runner.js',
  'provider-reference/misa-adapter.js',
  'provider-reference/captcha-panel.js',
  // KHÔNG đòi 'thong-bao.mp3': đó là âm thanh TUỲ CHỌN (server.js ghi rõ "bỏ file ... không có thì
  // dùng tiếp mặc định") và file chưa từng có trong repo. Đòi nó sẽ khiến MỌI build đều đỏ vô cớ.
  // (Đây cũng là nguồn của cảnh báo "Warning Cannot stat, ENOENT" của pkg — do glob
  // src/template/*.mp3 không khớp file nào, KHÔNG phải do thiếu model như tôi từng đoán sai.)
];

// `extra`: tên các file BẮT BUỘC THÊM cho riêng lần build này. build-app dùng để đòi luôn BẢN RÚT
// GỌN tài sản giao diện khi bước rút gọn đã chạy: bản gốc vẫn nằm trong EXE làm đường lùi, nên nếu
// quên khai `src/*.min.*` vào pkg.assets thì app VẪN chạy đúng — nghĩa là lỗi sẽ im lặng và bản
// phát hành lại nặng như cũ. Đòi thẳng tên file ở đây thì build ĐỎ, không thể quên.
function verify(exePath, extra = []) {
  const bytes = fs.readFileSync(exePath);
  const required = [...REQUIRED, ...nativeNames(), ...extra];
  // pkg nhúng asset theo ĐƯỜNG DẪN nhưng bảng tên trong EXE lưu PHẲNG (chỉ tên file), nên
  // quét chuỗi "provider-reference/generic-runner.js" sẽ không trúng dù file CÓ trong gói.
  // Đã xảy ra: kiểm này kết luận thiếu 4/35 file rồi XOÁ mất bản phát hành, hai lần.
  // Vì vậy thử tên phẳng trước; chỉ khi cả tên phẳng cũng không có mới tính là thiếu.
  const missing = required.filter(name => {
    const flat = name.split('/').pop();
    return bytes.indexOf(Buffer.from(name)) < 0
      && bytes.indexOf(Buffer.from(name.replace(/\//g, '\\'))) < 0
      && bytes.indexOf(Buffer.from(flat)) < 0;
  });
  return { missing, size: bytes.length, total: required.length };
}

// MỌI thư viện NATIVE trong node_modules đều phải có mặt trong EXE.
// Vì sao phải quét động: pkg KHÔNG tự nhúng .node/.dll của gói phụ thuộc — nó chỉ theo require graph
// rồi bỏ qua thư mục. Đã xảy ra thật hai lần: thiếu model ONNX (sửa bằng cách khai trong assets),
// rồi thiếu sharp/libvips ⇒ EXE KHÔNG rasterize được SVG CAPTCHA nên không đăng nhập được, trong khi
// chạy `node src/server.js` (có node_modules) thì vẫn tốt. Quét động nên không sợ thiếu tên nào.
function nativeNames() {
  const found = new Set();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(node|dll)$/i.test(entry.name)) found.add(entry.name);
    }
  };
  for (const base of ['node_modules/@img', 'node_modules/sharp', 'node_modules/onnxruntime-node']) {
    walk(path.join(__dirname, '..', base));
  }
  return [...found];
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

module.exports = { verify, REQUIRED, nativeNames, defaultExe };
