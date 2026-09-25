'use strict';
// ---------------------------------------------------------------------------
// CHẨN ĐOÁN "xuất Excel thiếu dữ liệu sheet Nhà cung cấp".
//
// Script này CHỈ ĐỌC: mở từng data.db ở chế độ readOnly và in ra ĐÚNG những gì
// sheet "Nhà cung cấp" / "Khách hàng" sẽ chứa. Không sửa gì, không gọi mạng.
//
// Chạy:
//   node tools/kiem-tra-nha-cung-cap.cjs
//   node tools/kiem-tra-nha-cung-cap.cjs "F:\web\New folder"     (nếu muốn chỉ định thư mục lưu)
//
// Kết quả cũng được ghi ra: du_lieu\kiem-tra-nha-cung-cap.txt  (UTF-8, để dễ copy gửi lại)
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT_DIR, 'du_lieu', 'kiem-tra-nha-cung-cap.txt');
const lines = [];
const say = text => { lines.push(text); console.log(text); };

// Thư mục lưu: ưu tiên tham số dòng lệnh, rồi tới accounts.json của app.
function outputFolder() {
  const arg = String(process.argv[2] || '').trim();
  if (arg) return arg;
  try {
    const accounts = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'du_lieu', 'accounts.json'), 'utf8'));
    const list = Array.isArray(accounts) ? accounts : (accounts.accounts || []);
    const found = list.map(a => a && a.output).filter(Boolean);
    if (found.length) return String(found[0]);
  } catch { /* không đọc được thì báo bên dưới */ }
  return '';
}

const root = outputFolder();
say(`Thư mục lưu: ${root || '(KHÔNG TÌM THẤY — hãy truyền tham số đường dẫn)'}`);
if (!root || !fs.existsSync(root)) { say('=> Không mở được thư mục lưu. Dừng.'); finish(); return; }

let mstDirs = [];
try { mstDirs = fs.readdirSync(root).filter(n => n.startsWith('MST-')); } catch (e) { say(`=> Không đọc được thư mục lưu: ${e.message}`); }
say(`Tìm thấy ${mstDirs.length} thư mục MST: ${mstDirs.join(', ') || '(không có)'}`);

const values = db => { try { return db.prepare('PRAGMA user_version').get().user_version; } catch { return '?'; } };

function columns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); } catch { return []; }
}
function count(db, sql) { try { return db.prepare(sql).get().c; } catch (e) { return `LOI(${e.message})`; } }
function rows(db, sql) { try { return db.prepare(sql).all(); } catch (e) { return [{ loi: e.message }]; } }

for (const name of mstDirs) {
  const file = path.join(root, name, 'data.db');
  say('');
  say(`===== ${name} =====`);
  if (!fs.existsSync(file)) { say('  (chưa có data.db)'); continue; }
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); }
  catch (e) { say(`  MỞ LỖI: ${e.message}`); continue; }
  try {
    say(`  data.db ${(fs.statSync(file).size / 1048576).toFixed(1)} MB · schema v${values(db)}`);
    const cols = columns(db, 'invoices');
    say(`  cột invoices: ${cols.join(', ') || '(không đọc được)'}`);
    for (const need of ['direction', 'mst_ban', 'ten_ban', 'mst_mua', 'ten_mua', 'tong_tien', 'tien_thue', 'ngay_lap']) {
      if (!cols.includes(need)) say(`  !! THIẾU CỘT "${need}" ⇒ sheet đối tác không lấy được dữ liệu này`);
    }
    say(`  tổng hoá đơn        : ${count(db, 'SELECT COUNT(*) c FROM invoices')}`);
    for (const r of rows(db, "SELECT direction, COUNT(*) c FROM invoices GROUP BY direction ORDER BY direction")) {
      say(`   chiều ${r.direction}: ${r.c} hoá đơn`);
    }
    say(`  MUA VÀO thiếu MST người bán : ${count(db, "SELECT COUNT(*) c FROM invoices WHERE direction='BUY' AND (mst_ban IS NULL OR TRIM(mst_ban)='')")}`);
    say(`  MUA VÀO thiếu TÊN người bán : ${count(db, "SELECT COUNT(*) c FROM invoices WHERE direction='BUY' AND (ten_ban IS NULL OR TRIM(ten_ban)='')")}`);
    say(`  BÁN RA  thiếu MST người mua : ${count(db, "SELECT COUNT(*) c FROM invoices WHERE direction='SELL' AND (mst_mua IS NULL OR TRIM(mst_mua)='')")}`);

    const sup = rows(db, `SELECT mst_ban AS mst, ten_ban AS ten, COUNT(*) AS so_hoa_don,
        SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
      FROM invoices WHERE direction='BUY' GROUP BY mst_ban, ten_ban ORDER BY tong_tien DESC`);
    say(`  >>> SHEET "Nhà cung cấp" SẼ CÓ ${Array.isArray(sup) ? sup.length : '?'} dòng dữ liệu`);
    (Array.isArray(sup) ? sup : []).slice(0, 12).forEach((r, i) => {
      say(`     ${i + 1}. MST=${JSON.stringify(r.mst)} | Tên=${JSON.stringify(r.ten)} | ${r.so_hoa_don} HĐ | tổng=${r.tong_tien}`);
    });
    if (Array.isArray(sup) && sup.length > 12) say(`     … còn ${sup.length - 12} dòng nữa`);

    const buy = rows(db, `SELECT mst_mua AS mst, ten_mua AS ten, COUNT(*) AS so_hoa_don,
        SUM(tong_tien) AS tong_tien, SUM(tien_thue) AS tong_thue
      FROM invoices WHERE direction='SELL' GROUP BY mst_mua, ten_mua ORDER BY tong_tien DESC`);
    say(`  >>> SHEET "Khách hàng" SẼ CÓ ${Array.isArray(buy) ? buy.length : '?'} dòng dữ liệu`);
    (Array.isArray(buy) ? buy : []).slice(0, 5).forEach((r, i) => {
      say(`     ${i + 1}. MST=${JSON.stringify(r.mst)} | Tên=${JSON.stringify(r.ten)} | ${r.so_hoa_don} HĐ`);
    });
  } finally { try { db.close(); } catch { /* đã đóng */ } }
}

finish();

function finish() {
  say('');
  say('Xong. (Chỉ đọc — không sửa gì.)');
  try {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, lines.join('\r\n'), 'utf8');
    console.log(`\nĐã ghi kết quả vào: ${OUT_FILE}`);
  } catch (e) { console.log(`Không ghi được file kết quả: ${e.message}`); }
}
