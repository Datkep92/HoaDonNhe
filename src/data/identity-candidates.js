'use strict';
// ---------------------------------------------------------------------------
// Mã định danh CHƯA GÁN cho hồ sơ — nguồn sự thật "MST & CCCD của cùng một người".
//
// Bối cảnh thật (F:\web\New folder\MST-4500487170\Mua_vao\xml): hồ sơ đăng nhập MST
// 4500487170 (HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN) nhưng người bán lập hoá đơn cho người
// mua bằng CCCD 058168004258 — CÙNG MỘT NGƯỜI, chỉ khác LOẠI MÃ (10 file thì 4 ghi
// NMua/MST=4500487170, 6 ghi NMua/MST=058168004258). detectDirection() chỉ biết các
// định danh đã khai báo nên 6 file đó bị từ chối UNKNOWN (đúng nguyên tắc không đoán,
// §14). File này ghi lại CÁC MÃ ĐÓ để tab Kho dữ liệu hỏi người dùng: Gán vào hồ sơ
// (tương đương nhập ô CCCD/MST bổ sung) thì lượt quét sau nhập được hoá đơn; Bỏ qua
// thì tạm im lặng.
//
// Ma trận lưu tại MST-<mst>/ma-chua-xac-dinh.json (JSON đữ người, KHÔNG vào data.db):
// { "058168004258": { ten, side: 'mua'|'ban'|'', count, seenFiles[], firstFile, firstSeen,
//                     lastSeen, decided: ''|'assigned'|'ignored', decidedAt, decidedBy } }
// count = số FILE KHÁC NHAU từng sinh mã này (file lỗi UNKNOWN bị quét lại mỗi lượt KHÔNG
// được đếm lại); seenFiles giới hạn 500 path đầu để file JSON không phình vô hạn.
// "ignored" chỉ là im lặng: gặp lại file MỚI (path/size/mtime đổi) count tăng, UI
// hiện lại để người dùng quyết định lần nữa.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'ma-chua-xac-dinh.json';
const MAX_SEEN_FILES = 500; // chặn trên số path lưu mỗi mã — đủ cho kho vài nghìn file, JSON vẫn gọn

// Mã đã có vùng MST-<code> riêng trong cùng thư mục lưu ⇒ chắc chắn KHÔNG phải định danh
// của hồ sơ này (vd XML của hồ sơ A chứa MST hồ sơ B). Có thì không liệt vào "chưa gán".
function belongsToOtherMst(mstDir, code) {
  const base = String(code || '').trim();
  if (!base) return false;
  const root = path.dirname(mstDir); // vùng output chung chứa mọi MST-<mst>
  try { return fs.existsSync(path.join(root, `MST-${base}`)); } catch { return false; }
}

// side: 'mua'|'ban' (bên trong hoá đơn mang mã), ownSide: mã có cùng phía với HỒ SƠ không
// (file trong Mua_vao ⇒ hồ sơ là người mua ⇒ ownSide=true với mã bên NMua). ownSide=false
// = nhà cung cấp/khách hàng bình thường — chỉ để tra cứu, KHÔNG đề nghị gán.
function normalizeMap(value) {
  const base = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [code, raw] of Object.entries(base)) {
    const item = raw && typeof raw === 'object' ? raw : {};
    out[String(code).trim()] = {
      ten: String(item.ten || '').trim(),
      side: item.side === 'mua' || item.side === 'ban' ? item.side : '',
      ownSide: item.ownSide !== false,
      count: Math.max(0, Number(item.count) || 0),
      seenFiles: Array.isArray(item.seenFiles) ? item.seenFiles.map(String).filter(Boolean).slice(0, MAX_SEEN_FILES) : [],
      firstFile: String(item.firstFile || '').trim(),
      firstSeen: String(item.firstSeen || '').trim(),
      lastSeen: String(item.lastSeen || '').trim(),
      decided: item.decided === 'assigned' || item.decided === 'ignored' ? item.decided : '',
      decidedAt: String(item.decidedAt || '').trim(),
      decidedBy: String(item.decidedBy || '').trim(),
    };
  }
  return out;
}

function readCandidates(mstDir) {
  try {
    return normalizeMap(JSON.parse(fs.readFileSync(path.join(mstDir, FILE_NAME), 'utf8')));
  } catch { return {}; }
}

function writeCandidates(mstDir, map) {
  try {
    fs.mkdirSync(mstDir, { recursive: true });
    const entries = Object.entries(map).filter(([, item]) => item && item.count > 0);
    entries.sort((a, b) => b[1].count - a[1].count || String(a[0]).localeCompare(String(b[0])));
    const out = {};
    for (const [code, item] of entries) out[code] = item;
    fs.writeFileSync(path.join(mstDir, FILE_NAME), JSON.stringify(out, null, 2));
  } catch { /* đây chỉ là vết để hỏi lại người dùng — ghi không được thì bỏ qua */ }
}

// Ghi nhận các mã vừa gặp trong lượt quét. Trả về mã VỪA THẤY LẦN ĐẦU (kể cả đã decided)
// — server dùng để biết có nên hẹn quét lại không. File đã nhập rồi bị scanner bỏ qua ở
// bước imported_files nên KHÔNG đếm lại: count chỉ tăng khi gặp file MỚI/ĐỔI.
function observeCandidates(mstDir, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return { added: [], merged: 0 };
  const map = readCandidates(mstDir);
  const now = new Date().toISOString();
  const added = [];
  let merged = 0;
  for (const item of candidates) {
    const code = String(item.code || '').trim();
    if (!code || belongsToOtherMst(mstDir, code)) continue;
    const file = String(item.file || '').trim();
    const previous = map[code];
    if (!previous) {
      map[code] = {
        ten: String(item.ten || '').trim(),
        side: item.side === 'mua' || item.side === 'ban' ? item.side : '',
        ownSide: item.ownSide !== false,
        count: 1,
        seenFiles: file ? [file] : [],
        firstFile: file,
        firstSeen: now,
        lastSeen: now,
        decided: '', decidedAt: '', decidedBy: '',
      };
      added.push(code);
    } else {
      // File đã thấy rồi (lượt quét lại đọc lại file lỗi UNKNOWN cũ) ⇒ KHÔNG đếm lại.
      const isNewFile = file && !previous.seenFiles.includes(file);
      if (isNewFile) {
        previous.count += 1;
        if (previous.seenFiles.length < MAX_SEEN_FILES) previous.seenFiles.push(file);
        previous.lastSeen = now;
      }
      merged += 1;
      // ownSide: đủ điều kiện gán là tính chất "một lần thấy ở phía hồ sơ" — không bỏ đi khi
      // mã này sau đó còn xuất hiện với vai trò đối tác ở lượt khác.
      if (item.ownSide === true) previous.ownSide = true;
      if (!previous.ten && item.ten) previous.ten = String(item.ten).trim();
      // `side` = phía mã đứng ở lần thấy ĐẦU TIÊN đã ghi, và KHÔNG bị ghi đè (xem ghi chú bên dưới).
      if (!previous.side && (item.side === 'mua' || item.side === 'ban')) previous.side = item.side;
      if (!previous.firstFile && file) previous.firstFile = file;
    }
  }
  writeCandidates(mstDir, map);
  return { added, merged };
}

// Gán/bỏ qua một mã (POST từ UI). decision: 'assigned' | 'ignored' | '' (nhận lại).
function setDecision(mstDir, code, decision, by = '') {
  const key = String(code || '').trim();
  if (!key) return null;
  const map = readCandidates(mstDir);
  if (!map[key]) return null;
  map[key].decided = decision === 'assigned' || decision === 'ignored' ? decision : '';
  map[key].decidedAt = map[key].decided ? new Date().toISOString() : '';
  map[key].decidedBy = map[key].decided ? String(by || '').trim() : '';
  writeCandidates(mstDir, map);
  return map[key];
}

// Danh sách cho UI: CHƯA quyết định trước, rồi đã bỏ qua, rồi đã gán; cùng nhóm thì count giảm.
function listCandidates(mstDir) {
  const order = { '': 0, ignored: 1, assigned: 2 };
  return Object.entries(readCandidates(mstDir))
    .map(([code, item]) => ({ code, ...item }))
    .sort((a, b) => order[a.decided] - order[b.decided] || b.count - a.count || String(a.code).localeCompare(String(b.code)));
}

// ---------------------------------------------------------------------------
// So khớp "CÙNG MỘT NGƯỜI" theo TÊN — dùng cho gợi ý tự gán (KHÔNG dùng cho nghiệp vụ khác).
//
// Bài toán thật: hồ sơ MST 4500487170 (HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN) nhưng hoá đơn ghi
// người mua bằng CCCD 058168004258. Tên của cùng một người viết nhiều kiểu:
//   "HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN" ≡ "HKD Phùng Thị Kỳ Duyên" ≡ "PHÙNG THỊ KỲ DUYÊN"
// Chuẩn hoá: bỏ dấu, hoa hoá, bỏ dấu câu, rồi bỏ CỤM PHÁP NHÂN ("hộ kinh doanh", "công ty
// TNHH", "cổ phần"…) — lọc theo CỤM thay vì từ đơn để không ăn nhầm tên riêng ("VINH CƠ" phải
// giữ nguyên "CƠ", chỉ "CỔ PHẦN" mới bị bỏ). Chỉ coi là trùng khi phần tên còn lại ≥ 4 ký tự
// để không khớp nhầm tên cụt.
// ---------------------------------------------------------------------------
const LEGAL_PHRASES = [ // DÀI TRƯỚC — NGẮN SAU để cụm dài được khớp trước
  'CONG TY TNHH MOT THANH VIEN',
  'TRACH NHIEM HUU HAN MOT THANH VIEN',
  'CONG TY TNHH MTV',
  'CONG TY CO PHAN',
  'TRACH NHIEM HUU HAN',
  'HO KINH DOANH',
  'CONG TY',
  'CO PHAN',
  'TNHH MTV',
  'KINH DOANH',
];
const LEGAL_WORDS = new Set(['HO', 'HKD', 'KD', 'CTY', 'CP', 'TNHH', 'MTV', 'DNNN', 'HTX']);

function normalizePersonName(value) {
  const words = String(value ?? '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  const kept = [];
  for (let i = 0; i < words.length; i += 1) {
    let matched = false;
    for (const phrase of LEGAL_PHRASES) {
      const parts = phrase.split(' ');
      if (words.slice(i, i + parts.length).join(' ') === phrase) { i += parts.length - 1; matched = true; break; }
    }
    if (!matched && !LEGAL_WORDS.has(words[i])) kept.push(words[i]);
  }
  return (kept.length ? kept : words).join(' ');
}

// Trùng tên ⇒ CÙNG MỘT NGƯỜI (chỉ khi phần tên còn lại đủ dài để không khớp nhầm tên cụt).
function samePersonName(left, right) {
  const a = normalizePersonName(left);
  const b = normalizePersonName(right);
  return a.length >= 4 && a === b;
}

module.exports = { FILE_NAME, MAX_SEEN_FILES, belongsToOtherMst, readCandidates, writeCandidates, observeCandidates, setDecision, listCandidates, normalizePersonName, samePersonName };
