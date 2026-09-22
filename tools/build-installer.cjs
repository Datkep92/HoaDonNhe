'use strict';
// ---------------------------------------------------------------------------
// Đóng gói HoaDonNhe-Setup-v<version>.exe bằng NSIS (makensis):
//   1) lấy payload release/HoaDonNhe-v<version>.exe (do `npm run build` tạo ra)
//   2) copy vào release/installer/payload/HoaDonNhe.exe  (tên cố định để nhúng)
//   3) makensis nhúng payload + icon vào MỘT file Setup duy nhất
//   4) tính SHA-256, ghi file .sha256 và RELEASE_NOTES.md
//
// Chạy: npm run installer      (cần makensis: "choco install nsis -y" hoặc đặt MAKENSIS)
//
// File phát hành duy nhất: release/HoaDonNhe-Setup-v<version>.exe
//
// Đường dẫn payload/icon/output nằm ngay trong packaging/installer.nsi (tính theo
// ${__FILEDIR__}), nên ở đây chỉ truyền các define không chứa khoảng trắng.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { version, repository } = require('../src/version');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const appExe = path.join(releaseDir, `HoaDonNhe-v${version}.exe`);
const payloadDir = path.join(releaseDir, 'installer', 'payload');
const payloadExe = path.join(payloadDir, 'HoaDonNhe.exe');
const setupExe = path.join(releaseDir, `HoaDonNhe-Setup-v${version}.exe`);
const nsi = path.join(root, 'packaging', 'installer.nsi');
const icon = path.join(root, 'resources', 'icon.ico');

function findMakensis() {
  if (process.env.MAKENSIS && fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['makensis.exe', 'makensis']) {
      const file = path.join(dir, name);
      if (dir && fs.existsSync(file)) return file;
    }
  }
  for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES]) {
    if (!base) continue;
    const file = path.join(base, 'NSIS', 'makensis.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function fourPart(v) {
  const parts = String(v).split('.').map(n => (/^\d+$/.test(n) ? n : '0'));
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
}

(async () => {
  if (!fs.existsSync(appExe)) {
    throw new Error(`Không thấy ${path.relative(root, appExe)}. Chạy "npm run build" trước.`);
  }
  if (!fs.existsSync(nsi)) throw new Error(`Không thấy ${path.relative(root, nsi)}.`);
  if (!fs.existsSync(icon)) throw new Error(`Không thấy ${path.relative(root, icon)}. Chạy "node tools/make-icon.cjs".`);

  const makensis = findMakensis();
  if (!makensis) {
    throw new Error('Không tìm thấy makensis. Cài NSIS: "choco install nsis -y" (hoặc đặt biến môi trường MAKENSIS trỏ tới makensis.exe).');
  }

  fs.mkdirSync(payloadDir, { recursive: true });
  fs.copyFileSync(appExe, payloadExe);
  console.log(`Payload: ${path.relative(root, payloadExe)}`);

  const args = [
    `-DVERSION=${version}`,
    `-DVI_VERSION=${fourPart(version)}`,
    '-DAPP_EXE=HoaDonNhe.exe',
    '-DAPP_BASENAME=HoaDonNhe',
    `-DREPO=${repository}`,
    nsi,
  ];
  console.log(`\n> ${makensis} ${args.join(' ')}\n`);
  const result = spawnSync(makensis, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`makensis thất bại (exit ${result.status}).`);

  if (!fs.existsSync(setupExe)) throw new Error(`makensis không tạo ra ${path.relative(root, setupExe)}.`);

  const hash = crypto.createHash('sha256').update(fs.readFileSync(setupExe)).digest('hex');
  const setupName = path.basename(setupExe);
  fs.writeFileSync(`${setupExe}.sha256`, `${hash}  ${setupName}${os.EOL}`);

  const notes = [
    `# HoaDonNhe v${version}`,
    '',
    `Tải **${setupName}** ở phần Assets bên dưới và chạy. Chỉ cần 1 file này — không cần ZIP/RAR,`,
    'không cần cài thêm dependency.',
    '',
    'Khi chạy, trình cài đặt cho chọn 1 trong 2 chế độ:',
    '',
    '- **CÀI ĐẶT VÀO WINDOWS**: cài vào hồ sơ người dùng, tạo shortcut Desktop + Start Menu,',
    '  có mục gỡ cài đặt trong Windows, có tuỳ chọn chạy ngay sau khi cài.',
    '- **PORTABLE**: chỉ giải nén vào thư mục bạn chọn để chạy `HoaDonNhe.exe` trực tiếp,',
    '  không ghi vào Windows, không có gỡ cài đặt.',
    '',
    'Yêu cầu: **Windows 64-bit (x64)**, có sẵn **Google Chrome** hoặc **Microsoft Edge**',
    '(Edge có sẵn trong Windows 10/11). Không cần Node.js/Python/Chromium. Không cần quyền Administrator.',
    '',
    'Cả hai chế độ lưu dữ liệu trong thư mục `du_lieu` nằm cạnh `HoaDonNhe.exe`,',
    'nên bản Portable có thể copy cả thư mục sang máy khác.',
    '',
    '## SHA-256',
    '',
    '```',
    `${hash}  ${setupName}`,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(releaseDir, 'RELEASE_NOTES.md'), notes);

  console.log(`\nSetup:   ${path.relative(root, setupExe)}`);
  console.log(`SHA-256: ${hash}`);
  console.log(`Ghi kèm: ${path.relative(root, `${setupExe}.sha256`)} và release/RELEASE_NOTES.md`);
})().catch(error => {
  console.error(`\nLỖI đóng gói Setup: ${error.message}`);
  process.exit(1);
});
