#!/usr/bin/env node
'use strict';
// ---------------------------------------------------------------------------
// Backup / khôi phục giao diện cũ — yêu cầu người dùng: "MUỐN BACKUP UI CŨ ...
// LƯU Ý BACKUP ĐỂ CÓ THỂ KHÔI PHỤC LẠI GIAO DIỆN CŨ."
//
// Cách dùng (chạy ở thư mục gốc dự án):
//   node tools/backup-ui.cjs backup     → chép 5 file UI vào backup/ui-<ngày-giờ>/
//   node tools/backup-ui.cjs list       → xem các mốc backup hiện có
//   node tools/backup-ui.cjs restore    → khôi phục từ mốc MỚI NHẤT
//   node tools/backup-ui.cjs restore 2026-09-26_103000   → khôi phục một mốc cụ thể
//
// Chỉ đụng 5 file GIAO DIỆN (html/css/2 js view), không đụng tầng dữ liệu hay server,
// nên khôi phục xong chỉ cần mở lại app là UI cũ quay về nguyên vẹn (build lại EXE nếu
// muốn bản EXE cũng quay theo).
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT = path.join(ROOT, 'backup');
const UI_FILES = [
  'src/index.html',
  'src/style.css',
  'src/data-view.css',
  'src/login.css',
  'src/data-ui.js',
];

function stampNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function copyFile(relative, toDir) {
  const from = path.join(ROOT, relative);
  if (!fs.existsSync(from)) throw new Error(`Thiếu file ${relative}`);
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(from, path.join(toDir, path.basename(relative)));
}

function doBackup() {
  const stamp = stampNow();
  const dir = path.join(BACKUP_ROOT, `ui-${stamp}`);
  for (const file of UI_FILES) copyFile(file, dir);
  fs.writeFileSync(
    path.join(dir, 'README.txt'),
    [
      'BACKUP GIAO DIỆN CŨ — tạo bởi tools/backup-ui.cjs',
      `Thời điểm: ${new Date().toLocaleString('vi-VN')}`,
      '',
      'Khôi phục (chạy ở thư mục gốc dự án):',
      '  node tools/backup-ui.cjs restore ' + stamp,
      '',
      'Ghi chú: khôi phục chỉ thay 5 file giao diện (index.html, style.css, data-view.css,',
      'login.css, data-ui.js). Tính năng tầng dữ liệu (kho, tự gán MST/CCCD) KHÔNG bị ảnh hưởng.',
    ].join('\n'),
  );
  console.log(`✓ Đã backup ${UI_FILES.length} file UI → ${path.relative(ROOT, dir)}`);
  console.log('  Khôi phục: node tools/backup-ui.cjs restore ' + stamp);
}

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return console.log('Chưa có backup nào.');
  const dirs = fs.readdirSync(BACKUP_ROOT).filter(name => name.startsWith('ui-')).sort();
  if (!dirs.length) return console.log('Chưa có backup nào.');
  console.log('Các mốc backup (mới nhất cuối):');
  for (const name of dirs) console.log('  ' + name);
  console.log('Khôi phục mốc mới nhất: node tools/backup-ui.cjs restore');
}

function doRestore(stamp) {
  let dir;
  if (stamp) {
    dir = path.join(BACKUP_ROOT, `ui-${stamp}`);
  } else {
    if (!fs.existsSync(BACKUP_ROOT)) throw new Error('Chưa có backup nào để khôi phục.');
    const dirs = fs.readdirSync(BACKUP_ROOT).filter(name => name.startsWith('ui-')).sort();
    if (!dirs.length) throw new Error('Chưa có backup nào để khôi phục.');
    dir = path.join(BACKUP_ROOT, dirs[dirs.length - 1]);
  }
  if (!fs.existsSync(dir)) throw new Error(`Không tìm thấy mốc backup: ${dir}`);
  for (const file of UI_FILES) {
    const from = path.join(dir, path.basename(file));
    const to = path.join(ROOT, file);
    if (!fs.existsSync(from)) throw new Error(`Backup thiếu file ${path.basename(file)}`);
    fs.copyFileSync(from, to);
    console.log(`✓ Khôi phục ${file}`);
  }
  console.log('Xong. Mở lại app để thấy giao diện cũ (build lại EXE nếu cần bản EXE cũng quay theo).');
}

const command = process.argv[2] || 'backup';
const stamp = process.argv[3] || '';
try {
  if (command === 'backup') doBackup();
  else if (command === 'list') listBackups();
  else if (command === 'restore') doRestore(stamp);
  else throw new Error('Lệnh không rõ. Dùng: backup | list | restore [mốc]');
} catch (error) {
  console.error('✗ LỖI:', error.message);
  process.exit(1);
}
