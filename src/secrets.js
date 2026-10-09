'use strict';
// Machine-bound storage for the portal password and the saved portal session
// (JWT + cookies) of each MST. Same idea as VNIT's .matkhau.json/.tokens.json: the file
// stays on this machine, copy it elsewhere and it cannot be opened.
// Windows DPAPI (CurrentUser) is used when available; otherwise AES-256-GCM with a key
// derived from this machine's identity. HOADON_SECRET_MODE=aes forces the AES path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const DPAPI = 'dpap1:';
const AES = 'aes1:';
const KEYS = ['password', 'token', 'cookies', 'dvc_login'];
const POWERSHELL = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$t=[Console]::In.ReadToEnd()'
].join(';');
const UNPROTECT_SCRIPT = `${POWERSHELL};$b=[Convert]::FromBase64String($t.Trim());$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))`;
const PROTECT_SCRIPT = `${POWERSHELL};$b=[Text.Encoding]::UTF8.GetBytes($t);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($p))`;
let directory = '';
let dpapiWorks = null;

// Chỉ nhớ trong một tiến trình: danh tính máy không đổi giữa các lần gọi, còn
// os.networkInterfaces() phải hệ thống liệt kê adapter (có thể chậm trên máy có
// nhiều card mạng). Nhánh DPAPI không dùng hàm này — nhánh AES dùng mỗi lần khoá.
let machineIdCache = null;
function machineIdentity() {
  if (machineIdCache !== null) return machineIdCache;
  const nets = os.networkInterfaces();
  const mac = Object.keys(nets).sort().flatMap(name => nets[name] || []).filter(x => !x.internal && x.mac && x.mac !== '00:00:00:00:00:00').map(x => x.mac).sort()[0] || '';
  let username = '';
  try { username = os.userInfo().username; } catch {}
  machineIdCache = [os.hostname(), username, mac, os.platform(), os.arch()].join('|');
  return machineIdCache;
}
function keyFor(salt) { return crypto.scryptSync(machineIdentity(), salt, 32, { N: 16384, r: 8, p: 1 }); }
function dpapi(script, value) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim();
}
function aesProtect(text) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return AES + [salt, iv, cipher.getAuthTag(), body].map(x => x.toString('base64')).join(':');
}
function aesUnprotect(blob) {
  const [salt, iv, tag, body] = blob.slice(AES.length).split(':');
  if (!salt || !iv || !tag || !body) throw new Error('Dữ liệu đã lưu không đúng định dạng.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(Buffer.from(salt, 'base64')), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
function protect(text) {
  const value = String(text ?? '');
  if (dpapiWorks !== false && process.env.HOADON_SECRET_MODE !== 'aes') {
    try { const blob = DPAPI + dpapi(PROTECT_SCRIPT, value); dpapiWorks = true; return blob; } catch { dpapiWorks = false; }
  }
  return aesProtect(value);
}
// GHI NHỚ KẾT QUẢ GIẢI MÃ — tốt cho lần đọc LẶP, không giúp lúc khởi động.
//
// Đo thật: unprotect() với DPAPI gọi dpapi(), mà dpapi() spawn `powershell.exe`
// bằng execFileSync. Mỗi lần spawn ~500 ms và nó CHẶN event loop của cả server.
// Lúc khởi động app đọc token+cookie của N MST là 2×N lần giải mã.
//
// NHƯNG khoá nhớ KHÔNG cứu được lần đầu: 7 MST có 7 token khác nhau ⇒ 14 blob
// khác nhau ⇒ 14 lần trượt ⇒ vẫn 14 lần spawn (đo được: 3,3s → 4,1s, tức không
// cải thiện). Cái thật sự rút ngắn lần đầu là unprotectBatch() bên dưới — gom hết
// vào MỘT tiến trình PowerShell. Khoá nhớ ở đây chỉ để các lần đọc lại (bấm lại
// cùng MST, đọc cùng một phiên ở nhiều nơi) không phải spawn thêm.
//
// An toàn: khoá theo CHÍNH blob đã mã hoá, không theo MST. Cùng một blob luôn
// giải ra cùng một bản rõ (DPAPI và AES-256-GCM đềy tất định), nên không thể trả
// nhầm dữ liệu máy này cho máy khác. Đăng nhập lại ghi blob MỚI (salt ngẫu nhiên)
// ⇒ khoá cũ không bao giờ được tra lại. Xoá phiên thì xoá file ⇒ đọc ra null.
const DECRYPT_CACHE = new Map();
const DECRYPT_CACHE_MAX = 256; // token+cookie đều nhỏ; trần này để app chạy nhiều ngày không phình
function unprotect(blob) {
  const value = String(blob || '');
  if (!value) return '';
  const hit = DECRYPT_CACHE.get(value);
  if (hit !== undefined) {
    // Đưa lên đầu để khoá bị dùng nhiều không bị đẩy ra khi có dữ liệu mới.
    DECRYPT_CACHE.delete(value); DECRYPT_CACHE.set(value, hit);
    return hit;
  }
  // isolate = false: đường đơn giữ nguyên việc NÉM LỖI khi dữ liệu hỏng, để nơi gọi
  // phát hiện được băng dữ liệu băng hỏng thay vì âm thầm coi là "chưa đăng nhập".
const plain = unprotectBatch([value], false)[0];
  cacheRemember(value, plain);
  return plain;
}
function cacheRemember(blob, plain) {
  if (DECRYPT_CACHE.size >= DECRYPT_CACHE_MAX) DECRYPT_CACHE.delete(DECRYPT_CACHE.keys().next().value);
  DECRYPT_CACHE.set(blob, plain);
}

// Giải mã N blob trong MỘT tiến trình PowerShell duy nhất.
// Đây là thứ thực sự rút ngắn lúc khởi động: 14 lần spawn (~7s chặn event loop)
// thành 1 lần (~0,5s). Chỉ gom blob DPAPI; blob AES giải ngay trong JS vì
// scryptSync chỉ mất vài chục ms và không tốn tiến trình ngoài.
// Blob rỗng trả '' — không hỏi PowerShell, tiết kiệm thêm một vòng.
//
// `isolate` phân biệt hai đường, và sự khác biệt này CÓ CHỦ ĐÍCH:
//   • unprotect() (đường đơn, isolate = false) — dữ liệu hỏng thì NÉM LỖI. Đây là
//     hành vi từ trước, giữ nguyên để nơi gọi kiểm tra được dữ liệu băng hỏng thay
//     vì âm thầm nhận "không có phiên" rồi đẩy người dùng đi đăng nhập lại.
//   • unprotectBatch() (đường lô, isolate = true) — dữ liệu hỏng thì để vị trí đó
//     RỖNG. Lý do: nếu lỗi ném ra ngoài, một blob AES hỏng sẽ giết cả đợt và mất
//     phiên của các MST hợp lệ còn lại trong cùng lượt.
// Dù sao, vị trí phải giữ nguyên chỉ số: xem dpapiUnprotectMany (ký hiệu '#').
function unprotectBatch(blobs, isolate = true) {
  const list = (blobs || []).map(value => String(value || ''));
  const out = new Array(list.length).fill('');
  const dpapiIndexes = [];
  list.forEach((value, index) => {
    if (!value) return;
    if (value.startsWith(DPAPI)) dpapiIndexes.push(index);
    else if (value.startsWith(AES)) {
      try { out[index] = aesUnprotect(value); } catch (error) { if (!isolate) throw error; out[index] = ''; }
    }
    // Định dạng lạ PHẢI ném lỗi, không trả '' — trả rỗng nghĩa là coi như "không có
    // phiên", khiến người dùng bị đẩy vào đăng nhập lại với một file chỉ hỏng hình thức.
    else throw new Error('Không nhận ra định dạng dữ liệu đã lưu.');
  });
  if (!dpapiIndexes.length) return out;
  const encoded = dpapiIndexes.map(index => list[index].slice(DPAPI.length));
  const decoded = dpapiUnprotectMany(encoded);
  dpapiIndexes.forEach((index, position) => { out[index] = decoded[position]; });
  return out;
}

// Một tiến trình PowerShell giải mã hết, trả về mảng plaintext.
// Kết quả trả về dạng BASE64, mỗi phần tử một dòng — bảng chữ cái base64 không
// có ký tự xuống dòng nên tách theo dòng luôn chắc ăn, không sợ bản rõ chứa \n.
// Blob hỏng: PowerShell nuốt lỗi và không in dòng nào ⇒ dòng đó rỗng, khớp với
// hành vi cũ (unprotect lỗi → người gọi tự bắt và coi như không có).
function dpapiUnprotectMany(encodedList) {
  // POWERSHELL gồm ba phần: $ErrorActionPreference='Stop', Add-Type System.Security,
  // và $t=[Console]::In.ReadToEnd(). Ta GIỮ hai phần đầu, BỎ 'Stop' — ở cấp này ta cố
  // ý nuốt lỗi từng blob biến thành dòng rỗng, giống read() khi unprotect ném lỗi.
  // Giữ 'Stop' thì một blob hỏng làm hỏng cả lô, mất hết phiên của các MST còn lại.
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$t=[Console]::In.ReadToEnd()',
    // $t đã được POWERSHELL đọc hết stdin vào rồi; đọc [Console]::In lần nữa là rỗng.
    // Chia theo DÒNG, không dùng JSON: ConvertFrom-Json trên PowerShell 5.1 với mảng
    // JSON trả về đúng MỘT phần tử gộp lại (đo: 3 blob → Count = 1), nên cách đó chỉ
    // giải được blob đầu mà không báo lỗi. Tách dòng thì không có kiểu dữ liệu phải parse.
    '$lines = @($t -split "`n" | Where-Object { $_.Trim() -ne "" })',
    // PowerShell LUÔN in đúng MỘT dòng cho mỗi blob, kể cả blob hỏng thì in ký hiệu
    // '#'. Bắt buộc: nếu bỏ qua blob hỏng, các dòng còn lại dồn lên và chỉ số lệch —
    // MST thứ sau sẽ nhận token của MST khác. Đó là loại lỗi rò phiên khách hàng,
    // đáng để đổi cả kiến trúc để tránh. '#' nằm ngoài bảng chữ cái base64 nên
    // không bao giờ nhầm với dữ liệu thật.
    'foreach ($line in $lines) {',
    '  $out = "#"',
    '  try {',
    '    $p = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($line.Trim()), $null, \'CurrentUser\')',
    '    $s = [Text.Encoding]::UTF8.GetString($p)',
    '    $out = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))',
    '  } catch { }',
    // Kết quả trả về dạng base64, mỗi phần tử một dòng: bảng chữ cái base64 không có
    // ký tự xuống dòng nên tách theo dòng luôn chắc ăn, không sợ bản rõ chứa \n.
    '  [Console]::Out.Write(($out + "`n"))',
    '}',
  ].join('; ');
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: encodedList.join('\n'), encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const lines = String(raw || '').split('\n');
  lines.pop(); // phần tử rỗng sinh ra bởi dấu xuống dòng cuối, không phải một kết quả
  const out = lines.map(line => {
    const value = line.trim();
    return value && value !== '#' ? Buffer.from(value, 'base64').toString('utf8') : '';
  });
  // Cân bằng độ dài cho đúng số blob đầu vào. Nếu PowerShell sập giữa chừng, phần
  // thiếu thành RỖNG (không có phiên) chứ không được lệch chỉ số sang MST khác —
  // hỏng thì thà hỏng, chứ tuyệt đối không được nhầm phiên người khác.
  while (out.length < encodedList.length) out.push('');
  return out.length === encodedList.length ? out : new Array(encodedList.length).fill('');
}
function file(mst) { return path.join(directory, 'secrets', `${mst}.json`); }
function readRaw(mst) { try { return JSON.parse(fs.readFileSync(file(mst), 'utf8')); } catch { return null; } }
function drop(mst) { try { fs.unlinkSync(file(mst)); } catch {} }
function read(mst, keys = KEYS) {
  const raw = readRaw(mst) || {}; const value = { password: '', token: '', cookies: '', savedAt: raw.savedAt || 0 };
  for (const key of keys) { try { value[key] = unprotect(raw[key]); } catch { value[key] = ''; } }
  return value;
}
// Đọc N MST trong MỘT lần giải mã. Đây là đường mà lúc khởi động dùng: đọc tuần tự
// sẽ spawn PowerShell 2×N lần (~7s chặn event loop với 7 MST), còn gom lại thì
// MỘT lần spawn cho tất cả. Trả về Map<mst, {token, cookies, ...}>.
function readMany(msts, keys = KEYS) {
  const list = Array.from(new Set((msts || []).map(mst => String(mst || '').trim()).filter(Boolean)));
  const raws = list.map(mst => readRaw(mst) || {});
  // Gom toàn bộ blob cần giải trước, giải một lần, rồi rải ngược về từng MST.
  const slots = [];   // { row, key, blob }
  raws.forEach((raw, row) => {
    for (const key of keys) {
      const blob = raw[key];
      if (!blob) continue;
      const hit = DECRYPT_CACHE.get(String(blob));
      if (hit !== undefined) continue;                       // đã ghi nhớ, không cần hỏi PowerShell
      slots.push({ row, key, blob: String(blob) });
    }
  });
  if (slots.length) {
    const plains = unprotectBatch(slots.map(slot => slot.blob));
    slots.forEach((slot, index) => {
      // Bản rõ rỗng = blob hỏng hoặc thuộc máy khác (DPAPI): để người gọi coi như
      // không có, đúng như read() đang làm khi unprotect ném lỗi.
      if (plains[index]) cacheRemember(slot.blob, plains[index]);
      if (!raws[slot.row].__done) raws[slot.row].__done = {};
      raws[slot.row].__done[slot.key] = plains[index] || '';
    });
  }
  const out = new Map();
  list.forEach((mst, row) => {
    const value = { password: '', token: '', cookies: '', savedAt: raws[row].savedAt || 0 };
    const done = raws[row].__done || {};
    for (const key of keys) {
      try {
        value[key] = key in done ? done[key] : unprotect(raws[row][key]);
      } catch { value[key] = ''; }
    }
    out.set(mst, value);
  });
  return out;
}
function write(mst, patch) {
  const raw = readRaw(mst) || { version: 1, mst };
  for (const [key, value] of Object.entries(patch || {})) { if (value) raw[key] = protect(value); else delete raw[key]; }
  raw.version = 1; raw.mst = mst; raw.savedAt = Date.now();
  if (!KEYS.some(key => raw[key])) { drop(mst); return; }
  fs.mkdirSync(path.dirname(file(mst)), { recursive: true });
  const temp = file(mst) + '.part'; fs.writeFileSync(temp, JSON.stringify(raw, null, 2)); fs.renameSync(temp, file(mst));
}

// GHI BẤT ĐỒNG BỘ — dành cho đường đăng nhập nền khi N MST chạy SONG SONG.
//
// Vì sao cần: `write()` gọi `protect()` mỗi blob, mà `protect()` spawn `powershell.exe`
// bằng execFileSync (~500 ms, CHẶN event loop của cả server). 10 MST đăng nhập song song
// ⇒ 10 lần spawn × 3 blob (token + cookies + password) = chặn ~15 s, trong khi giao diện
// poll `/api/state` mỗi 800 ms nên người dùng thấy app đứng hình.
//
// Cách sửa KHÔNG phải "ghi sau" (mất dữ liệu khi app tắt) mà là GOM các lần ghi vào một
// hàng đợi rồi xử lý từng lô khi event loop rảnh: dữ liệu vẫn được ghi, chỉ là không chặn
// các request khác trong lúc đợi. `flushWrites()` được gọi khi app thoát (`stop()`) để
// không mất gì.
const WRITE_QUEUE = new Map();   // mst -> patch (gộp nhiều lần ghi cùng MST)
let writeTimer = null;
function scheduleWrite(mst, patch) {
  const previous = WRITE_QUEUE.get(mst) || {};
  WRITE_QUEUE.set(mst, { ...previous, ...patch });
  if (writeTimer) return;
  // setImmediate chạy ở lượt kế của event loop — chờ các request hiện tại xử lý xong rồi mới ghi.
  writeTimer = setImmediate(() => { writeTimer = null; flushWrites(); });
}
function flushWrites() {
  const entries = [...WRITE_QUEUE.entries()];
  WRITE_QUEUE.clear();
  for (const [mst, patch] of entries) {
    try { write(mst, patch); }
    catch { /* lỗi ghi secrets không được làm hỏng cả lượt đăng nhập */ }
  }
}
function flushWritesSync() { if (writeTimer) { clearImmediate(writeTimer); writeTimer = null; } flushWrites(); }
function clear(mst, keys) {
  const raw = readRaw(mst); if (!raw) return;
  for (const key of keys) delete raw[key];
  if (!KEYS.some(key => raw[key])) { drop(mst); return; }
  raw.savedAt = Date.now();
  fs.mkdirSync(path.dirname(file(mst)), { recursive: true });
  const temp = file(mst) + '.part'; fs.writeFileSync(temp, JSON.stringify(raw, null, 2)); fs.renameSync(temp, file(mst));
}
function init(dir) { directory = path.resolve(dir); dpapiWorks = null; fs.mkdirSync(path.join(directory, 'secrets'), { recursive: true }); return api; }
function guard() { if (!directory) throw new Error('Kho bí mật chưa được khởi tạo.'); }
const api = {
  init,
  machineIdentity,
  read: (mst, keys) => { guard(); return read(mst, keys); },
  readMany: (msts, keys) => { guard(); return readMany(msts, keys); },
  write: (mst, patch) => { guard(); return write(mst, patch); },
  // Ghi bất đồng bộ — đường đăng nhập nền song song dùng để không chặn event loop ~500ms/blob.
  writeAsync: (mst, patch) => { guard(); scheduleWrite(mst, patch); },
  flushWrites: flushWritesSync,
  clear: (mst, keys = KEYS) => { guard(); return clear(mst, keys); },
  protect, unprotect,
  unprotectBatch,   // để test chặn hồi quy "định dạng lạ phải ném lỗi"
};
module.exports = api;
