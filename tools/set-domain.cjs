'use strict';
// ---------------------------------------------------------------------------
// ĐỔI URL GỐC CHO TOÀN BỘ TRANG — dùng khi đổi tên miền hoặc chuyển repo.
//
//   node tools/set-domain.cjs cntaxtools.vn
//   node tools/set-domain.cjs cntaxtools.vn --slug cntaxtools-landing
//   node tools/set-domain.cjs datkep92.github.io --slug cntaxtools-landing
//   node tools/set-domain.cjs cntaxtools.vn --sub www
//
// URL cũ được dò bằng cách tìm <link rel="canonical"> trong index.html,
// nên chạy lại nhiều lần vẫn đúng — không cần biết URL cũ là gì.
//
// Sửa cùng lúc trong: index.html · robots.txt · sitemap.xml
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'landing-v4');

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const host = process.argv[2];
if (!host || host.startsWith('--')) {
  console.error('Cach dung: node tools/set-domain.cjs <ten-mien> [--slug <ten-repo>] [--sub <www>]');
  process.exit(1);
}
if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('/')) {
  console.error(`Ten mien khong hop le: ${host}`);
  console.error('Vi du dung:  node tools/set-domain.cjs cntaxtools.vn');
  process.exit(1);
}

const sub = arg('--sub', '');
const slug = arg('--slug', '');

// URL gốc luôn kết thúc bằng dấu / để ghép đường dẫn tương đối không bị lỗi
const base = `https://${host}${sub ? '/' + sub : '/'}${slug ? slug + '/' : ''}`;

const indexPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');

// URL cũ = giá trị canonical hiện tại (đã bỏ dấu / cuối để so khớp an toàn)
const current = (html.match(/<link rel="canonical" href="(https?:\/\/[^"]+)"/) || [])[1];
if (!current) {
  console.error('Khong tim thay <link rel="canonical"> trong index.html.');
  process.exit(1);
}

if (current === base) {
  console.log(`URL goc da dung la ${base} — khong can doi gi.`);
  process.exit(0);
}

// So khớp: bỏ dấu / cuối ở cả hai vế
const from = current.replace(/\/$/, '');
const to = base.replace(/\/$/, '');
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Chỉ thay trong thuộc tính URL (https://...). Không đụng link nội bộ hay
// link ra github.com/Datkep92/HoaDonNhe (trang phát hành phần mềm).
let replaced = 0;
// Phải trả về URL MỚI, không phải chuỗi khớp — nếu trả `m` thì lệnh replace
// chỉ đếm số lần khớp mà không thay gì cả.
const swap = () => { replaced += 1; return to; };
let out = html.replace(new RegExp(escape(from), 'g'), swap);
out = out.replace(/hreflang="[^"]*" href="https?:\/\/[^"]+"/g, m => m.replace(/https?:\/\/[^"]+/, base));

if (replaced === 0) {
  console.error(`Khong tim thay URL cu ${from} trong index.html.`);
  process.exit(1);
}
fs.writeFileSync(indexPath, out, 'utf8');

// robots.txt
const robotsPath = path.join(ROOT, 'robots.txt');
if (fs.existsSync(robotsPath)) {
  const robots = fs.readFileSync(robotsPath, 'utf8');
  const next = robots.replace(/Sitemap:\s*https?:\/\/\S+/, 'Sitemap: ' + base + 'sitemap.xml');
  if (next !== robots) fs.writeFileSync(robotsPath, next, 'utf8');
}

// sitemap.xml
const sitemapPath = path.join(ROOT, 'sitemap.xml');
if (fs.existsSync(sitemapPath)) {
  const map = fs.readFileSync(sitemapPath, 'utf8');
  const next = map.replace(/<loc>https?:\/\/[^<]+<\/loc>/, '<loc>' + base + '</loc>');
  if (next !== map) fs.writeFileSync(sitemapPath, next, 'utf8');
}

console.log('Da doi URL goc trong 3 file:');
console.log('  ' + from);
console.log('  ' + base);
console.log('');
console.log('Nho kiem tra lai:');
console.log('  - canonical / og:url / hreflang  (index.html)');
console.log('  - Sitemap:                       (robots.txt)');
console.log('  - <loc>                          (sitemap.xml)');
console.log('  - neu dung ten mien rieng: them file CNAME chua ten mien do');
