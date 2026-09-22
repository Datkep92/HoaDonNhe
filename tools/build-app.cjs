'use strict';
// ---------------------------------------------------------------------------
// Build app EXE (payload):
//   1) pkg đóng gói toàn bộ app thành 1 file EXE (nhúng assets trong package.json > pkg.assets)
//   2) vá PE header để không hiện cửa sổ terminal (tools/hide-console.cjs)
//
// Chạy: npm run build     ->     release/HoaDonNhe-v<version>.exe
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
//   HOADON_BUILD_LABEL=test-ui npm run build  ->  release/HoaDonNhe-v1.0.0-test-ui.exe
const label = process.env.HOADON_BUILD_LABEL ? `-${process.env.HOADON_BUILD_LABEL}` : '';
const exe = path.join(releaseDir, `HoaDonNhe-v${version}${label}.exe`);

function run(command, args) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Lệnh thất bại (exit ${result.status}): ${command}`);
}

try {
  fs.mkdirSync(releaseDir, { recursive: true });

  const pkgBin = path.join(root, 'node_modules', 'pkg', 'lib-es5', 'bin.js');
  if (!fs.existsSync(pkgBin)) throw new Error('Chưa có pkg. Chạy "npm install" trước.');

  run(process.execPath, [
    pkgBin, '.',
    '--compress', 'GZip',
    '--targets', 'node16-win-x64',
    '--no-bytecode',
    '--public',
    '--public-packages', '*',
    '--output', exe,
  ]);

  run(process.execPath, [path.join(root, 'tools', 'hide-console.cjs'), exe]);

  const size = fs.statSync(exe).size;
  console.log(`\nXong: ${path.relative(root, exe)} (${(size / 1048576).toFixed(1)} MB)`);
  console.log('Nhắc: chạy "release\\HoaDonNhe-v' + version + '.exe" --smoke-test để kiểm tra EXE chạy được.');
} catch (error) {
  console.error(`\nLỖI build app: ${error.message}`);
  process.exit(1);
}
