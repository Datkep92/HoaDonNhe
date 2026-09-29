'use strict';
// ---------------------------------------------------------------------------
// Build app EXE (payload):
//   1) @yao-pkg/pkg (bản pkg được duy trì) đóng gói app thành 1 file EXE (nhúng assets trong
//      package.json > pkg.assets). Target mặc định node24-win-x64 vì từ PHASE 1 tầng dữ liệu
//      dùng node:sqlite — module built-in của Node 22+ (xem SOURCE_ANALYSIS.md §4).
//   2) vá PE header để không hiện cửa sổ terminal (tools/hide-console.cjs)
//
// Chạy: npm run build     ->     release/CN-Tax-Tools-v<version>.exe
//
// Version lấy từ src/version.js (nguồn duy nhất — xem tools/set-version.cjs).
//
// KHÔNG dùng rcedit để gán icon/version vào EXE này: rcedit ghi lại PE resource và làm
// hỏng phần snapshot nhúng của pkg — đã kiểm chứng thực tế, EXE sau đó báo
// "Pkg: Error reading from file" và bị hụt ~1,4 MB. Thay vào đó, icon + version tới
// người dùng qua:
//   - chính file Setup (packaging/installer.nsi: MUI_ICON + VIProductVersion)
//   - shortcut Desktop/Start Menu + mục gỡ cài đặt trong Windows, dùng resources/icon.ico
//     do NSIS cài kèm cạnh app (xem packaging/installer.nsi)
//   - thông tin version trong app: /api/version + hiển thị ở UI
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { version } = require('../src/version');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
// Nhãn tuỳ chọn cho bản build thử, để không đè lên bản phát hành:
//   HOADON_BUILD_LABEL=test-ui npm run build  ->  release/CN-Tax-Tools-v1.0.0-test-ui.exe
const label = process.env.HOADON_BUILD_LABEL ? `-${process.env.HOADON_BUILD_LABEL}` : '';
const exe = path.join(releaseDir, `CN-Tax-Tools-v${version}${label}.exe`);
// Runtime nhúng trong EXE. Đổi target thì BẮT BUỘC build lại và smoke test EXE trước khi phát hành.
const PKG_TARGET = process.env.HOADON_PKG_TARGET || 'node24-win-x64';

function run(command, args) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Lệnh thất bại (exit ${result.status}): ${command}`);
}

try {
  fs.mkdirSync(releaseDir, { recursive: true });

  const pkgBin = path.join(root, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
  if (!fs.existsSync(pkgBin)) throw new Error('Chưa có @yao-pkg/pkg. Chạy "npm install" trước.');

  // CHỐT CHẶN MODEL OCR — phải có TRƯỚC khi đóng gói.
  // Vì sao cần: pkg chỉ *cảnh báo* khi thiếu asset ("Warning Cannot stat, ENOENT") rồi VẪN xuất EXE
  // thiếu model. Đã xảy ra thật: mọi bản phát hành qua GitHub Actions thiếu src/onnx (54 MB, không
  // nằm trong git) nên EXE tải về KHÔNG giải được CAPTCHA — mà không ai biết vì build vẫn "xanh".
  // Thiếu/sai kích thước thì DỪNG build (exit 1) thay vì âm thầm ra bản khuyết.
  // Cố ý build bản không OCR (hiếm): HOADON_ALLOW_NO_OCR=1
  const OCR_FILES = [['common.onnx', 54088400], ['common.json', 90092]];
  if (process.env.HOADON_ALLOW_NO_OCR === '1') {
    console.log('⚠ HOADON_ALLOW_NO_OCR=1 — build KHÔNG có model OCR (EXE sẽ không giải CAPTCHA được).');
  } else {
    for (const [name, size] of OCR_FILES) {
      const file = path.join(root, 'src', 'onnx', name);
      if (!fs.existsSync(file)) throw new Error(`Thiếu model OCR: src/onnx/${name}. Chạy "npm run fetch-onnx" trước khi build.`);
      const actual = fs.statSync(file).size;
      if (actual !== size) throw new Error(`Model OCR sai kích thước: src/onnx/${name} là ${actual}, cần ${size}. Chạy lại "npm run fetch-onnx".`);
    }
    console.log('Model OCR: đủ (common.onnx + common.json) — sẽ được nhúng vào EXE.');
  }

  // RÚT GỌN BYTE TÀI SẢN GIAO DIỆN — phải chạy TRƯỚC pkg để bản .min có mặt lúc nhúng vào EXE.
  // Vì sao đặt ở bước ĐÓNG GÓI chứ không sửa thẳng src/*.js: file nguồn phải còn đọc được. Server
  // tự chọn bản .min khi phục vụ (xem minifiedSibling trong server.js); bản gốc vẫn nằm trong EXE
  // làm đường lùi nên thiếu .min (máy build không có esbuild) app vẫn chạy đúng, chỉ nặng hơn.
  const shrink = [];
  try {
    console.log('\nRút gọn tài sản giao diện (tools/minify-ui.cjs):');
    for (const item of require('./minify-ui.cjs').minify()) shrink.push(item.out); // pkg nhúng tên file không có tiền tố src/
  } catch (error) {
    console.log(`⚠ ${error.message} — EXE sẽ phục vụ bản gốc (nặng hơn ~27%).`);
  }

  run(process.execPath, [
    pkgBin, '.',
    '--compress', 'GZip',
    '--targets', PKG_TARGET,
    '--no-bytecode',
    '--public',
    '--public-packages', '*',
    '--output', exe,
  ]);

  run(process.execPath, [path.join(root, 'tools', 'hide-console.cjs'), exe]);

  // Icon cạnh EXE: helper System Tray (PowerShell) chỉ đọc được file THẬT trên đĩa, nên bản portable
  // cần resources/icon.ico nằm ngay cạnh EXE (xem trayIconPath trong src/server.js).
  const icon = path.join(root, 'resources', 'icon.ico');
  if (fs.existsSync(icon)) {
    const iconOut = path.join(releaseDir, 'icon.ico');
    fs.copyFileSync(icon, iconOut);
    console.log(`Icon khay: ${path.relative(root, iconOut)}`);
  }

  // KIỂM EXE NGAY TRONG BƯỚC BUILD: thiếu bất kỳ file nhúng bắt buộc nào là build THẤT BẠI.
  // Nhờ vậy "build xong" đồng nghĩa "EXE đủ" — ở máy này và trên GitHub như nhau. Đây là chốt
  // cuối: kể cả khi ai đó cố tình bỏ qua chốt model phía trên (HOADON_ALLOW_NO_OCR=1), bước này
  // vẫn bắt được và không cho EXE khuyết ra đời.
  const { verify, REQUIRED } = require('./verify-exe.cjs');
  // Đòi luôn bản rút gọn vừa sinh: bản gốc vẫn có trong EXE làm đường lùi nên thiếu .min là lỗi
  // IM LẶNG (app vẫn chạy, chỉ nặng như cũ). Khai vào đây thì build đỏ ngay nếu pkg.assets sót.
  const check = verify(exe, shrink);
  if (check.missing.length) {
    // XOÁ luôn file khuyết: bảo đảm bất biến "EXE nào còn nằm trên đĩa là EXE đã qua kiểm".
    // (pkg ghi file xong mới tới bước này, nên nếu không xoá thì build lỗi vẫn để lại một EXE khuyết.)
    try { fs.unlinkSync(exe); } catch { /* không xoá được thì vẫn phải báo lỗi */ }
    throw new Error(`EXE thiếu ${check.missing.length}/${REQUIRED.length} file nhúng bắt buộc: ${check.missing.join(', ')} — đã xoá file khuyết, KHÔNG phát hành.`);
  }
  console.log(`Đã kiểm EXE: đủ ${check.total}/${check.total} file nhúng bắt buộc${shrink.length ? ` (gồm ${shrink.length} bản rút gọn)` : ''}.`);

  // CHỐT MẠNH NHẤT: chạy chính EXE vừa đóng gói với --ocr-check (giải 1 ảnh CAPTCHA mẫu tại chỗ,
  // không gọi mạng, không dùng tài khoản nào). Kiểm theo TÊN file là chưa đủ — đã xảy ra thật:
  // libvips CÓ trong EXE nhưng sharp vẫn không nạp được vì thiếu JS của gói nền (@img), nên
  // EXE không giải được CAPTCHA ⇒ không đăng nhập được, trong khi `node src/server.js` thì tốt.
  const ocr = spawnSync(exe, ['--ocr-check'], { encoding: 'utf8', timeout: 180000 });
  const ocrOut = `${String(ocr.stdout || '').trim()} ${String(ocr.stderr || '').trim()}`.trim();
  if (ocr.status !== 0) {
    try { fs.unlinkSync(exe); } catch { /* không xoá được thì vẫn phải báo lỗi */ }
    throw new Error(`EXE KHÔNG giải được CAPTCHA (--ocr-check thất bại) — đã xoá file khuyết. ${ocrOut || ocr.error || ''}`);
  }
  console.log('Đã kiểm OCR trong EXE: giải đúng ảnh mẫu.');

  // CHỐT THỨ HAI: chạy chính EXE với --smoke-test. Bài kiểm này giờ không chỉ hỏi "giao diện có mở
  // không" mà còn tải MỌI file giao diện (script/link trong index.html + pdfjs) và đòi HTTP 200 —
  // nhờ vậy EXE thiếu một tab (ví dụ "Sao kê ngân hàng" ở bản 1.0.7) là build ĐỎ ngay tại đây,
  // chứ không phải để người dùng phát hiện sau khi tải về.
  const smoke = spawnSync(exe, ['--smoke-test'], { encoding: 'utf8', timeout: 180000, env: { ...process.env, HOADON_NO_UPDATE_CHECK: '1' } });
  const smokeOut = `${String(smoke.stdout || '').trim()} ${String(smoke.stderr || '').trim()}`.trim();
  if (smoke.status !== 0) {
    try { fs.unlinkSync(exe); } catch { /* không xoá được thì vẫn phải báo lỗi */ }
    throw new Error(`EXE chạy --smoke-test thất bại (thiếu file giao diện hoặc API không lên) — đã xoá file khuyết. ${smokeOut || smoke.error || ''}`);
  }
  console.log(`Đã kiểm giao diện trong EXE: ${smokeOut}`);

  const size = fs.statSync(exe).size;
  console.log(`\nXong: ${path.relative(root, exe)} (${(size / 1048576).toFixed(1)} MB)`);
  console.log(`Nhắc: EXE đã qua cả --ocr-check lẫn --smoke-test ngay trong bước build này.`);
} catch (error) {
  console.error(`\nLỖI build app: ${error.message}`);
  process.exit(1);
}
