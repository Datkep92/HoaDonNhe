'use strict';
// ---------------------------------------------------------------------------
// NHẬN DIỆN MÁY — sinh mã máy ỔN ĐỊNH: 1 máy = 1 mã, cài lại vẫn giữ nguyên.
//
// Vì sao cần:
//   Trước đây installationId là UUID NGẪU NHIÊN và hardwareHash băm từ
//   (tên máy | tài khoản Windows | địa chỉ card mạng). Cả hai đều đổi được:
//     • cài lại app / xoá thư mục dữ liệu  -> mới UUID -> thấy như máy mới -> MẤT KEY
//     • bật VPN (Windows đổi MAC)          -> mới hash -> thấy như máy mới -> MẤT KEY
//     • đổi tên máy hoặc tên tài khoản    -> mới hash -> mất trial
//   Hậu quả là mỗi lần làm vậy sinh thêm 1 dòng trong Google Sheets và
//   thêm 1 phòng chat Telegram cho CÙNG một khách.
//
// Cách sửa: đọc những thứ KHÔNG do người dùng đổi được.
//   HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid  — sinh 1 lần khi cài Windows,
//     giữ nguyên suốt đời máy, chỉ đổi khi cài lại Windows.
//   HKLM\HARDWARE\DESCRIPTION\System\BIOS\...        — mainboard + BIOS, khách
//     không sửa được bằng giao diện Windows.
//
// Cả hai đọc bằng `reg query` (~70ms, không cần PowerShell, không hiện cửa sổ).
// PowerShell/CIM để lấy SỐ SERI MAINBOARD nhưng chậm ~1s và không phải máy nào
// cũng có, nên KHÔNG đưa vào mã máy — chỉ dùng làm tín hiệu phụ.
//
// LƯU Ý ỔN ĐỊNH: mã máy CHỈ tính từ registry. Nếu có bổ sung nguồn nào sau này
// (PowerShell, disk serial...) thì phải giữ nguyên công thức cũ, nếu không máy
// khách sẽ đổi mã giữa chừng và lại mất key.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REG_MACHINE_GUID = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
const REG_BIOS = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';

// Những giá trị "placeholder" mà mainboard/BIOS hay để trống. Không lấy vì
// chúng giống nhau ở hàng loạt máy -> hai máy khác nhau ra cùng mã.
// LƯU Ý: "n/a" phải viết n\/a — dấu / trong regex literal sẽ kết thúc biểu thức.
const PLACEHOLDER = /^(default string|to be filled by o\.?e\.?m\.?|none|n\/a|unknown|system serial number|not applicable|0{6,}|0{4}-0{4}-0{4}-0{4}-0{12})$/i;

// Độ dài mã máy. 16 ký tự hex = 64 bit: trùng nhau gần như không thể xảy ra
// với số lượng khách của một ứng dụng desktop.
const ID_HEX = 16;
const ROOM_HEX = 12;

let memo = null;

function regQuery(args) {
  try {
    return execFileSync('reg.exe', args, {
      encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024,
    });
  } catch { return ''; }
}

// /v <tên> in ra:  <tên>    REG_SZ    <giá trị>
function regValue(path, name) {
  const out = regQuery(['query', path, '/v', name]);
  const match = out.match(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+REG_\\S+\\s+(.+)$', 'im'));
  return match ? String(match[1]).trim() : '';
}

// Không có /v: đọc hết rồi lấy theo tên dòng "  <tên>    REG_SZ    <giá trị>"
function regValues(path) {
  const out = regQuery(['query', path]);
  const found = {};
  for (const line of String(out).split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s+REG_\S+\s+(.+)$/);
    if (match) found[match[1]] = String(match[2]).trim();
  }
  return found;
}

function usable(value) {
  const text = String(value || '').trim();
  return text && !PLACEHOLDER.test(text) ? text : '';
}

// Chuỗi thô đặc trưng máy. Trả về '' nếu không lấy được gì đáng tin.
function registryFingerprint() {
  if (os.platform() !== 'win32') return '';
  const guid = usable(regValue(REG_MACHINE_GUID, 'MachineGuid'));
  const bios = regValues(REG_BIOS);
  const board = usable(bios.BaseBoardProduct);
  const sku = usable(bios.SystemSKU);
  const model = usable(bios.SystemProductName);
  const biosVersion = usable(bios.BIOSVersion);
  const boardMaker = usable(bios.BaseBoardManufacturer);
  // MachineGuid là thứ đủ để phân biệt máy. Các thứ còn lại chỉ là lớp bổ sung:
  // có chúng thì mã máy đổi khi thay mainboard (đúng ý), thiếu chúng thì vẫn chạy.
  const parts = [];
  if (guid) parts.push('guid:' + guid);
  if (board) parts.push('board:' + board);
  if (sku) parts.push('sku:' + sku);
  if (model) parts.push('model:' + model);
  if (boardMaker) parts.push('maker:' + boardMaker);
  if (biosVersion) parts.push('bios:' + biosVersion);
  return parts.join('|');
}

// Dự phòng cho máy không đọc được registry (bị khoá bởi chính sách công ty,
// chạy trong container/sandbox, hoặc không phải Windows). Ít ổn định hơn hẳn —
// chỉ để app không chết, và đường này KHÔNG phải mặc định.
function fallbackFingerprint() {
  try {
    const nets = os.networkInterfaces();
    const mac = Object.keys(nets).sort().flatMap(name => nets[name] || [])
      .filter(x => !x.internal && x.mac && x.mac !== '00:00:00:00:00:00')
      .map(x => x.mac).sort()[0] || '';
    let user = '';
    try { user = os.userInfo().username; } catch {}
    return `fallback:${os.hostname()}|${user}|${mac}|${os.platform()}|${os.arch()}`;
  } catch { return `fallback:${os.platform()}|${os.arch()}`; }
}

// Chất lượng nguồn định danh: 'registry' (ổn định) | 'fallback' (yếu) | 'none'
function source() {
  const raw = registryFingerprint();
  if (raw) return { kind: 'registry', raw };
  const weak = fallbackFingerprint();
  return { kind: weak ? 'fallback' : 'none', raw: weak };
}

/** Chuỗi đặc trưng máy (đã gộp, đã loại placeholder). Rỗng nếu không lấy được gì. */
function fingerprint() {
  if (!memo) memo = source();
  return memo.raw;
}

/** 'registry' nếu mã máy đáng tin, 'fallback' nếu đang dùng nguồn yếu. */
function kind() {
  if (!memo) memo = source();
  return memo.kind;
}

/**
 * Mã máy ổn định. Cùng một máy + cùng phiên bản công thức => luôn ra cùng kết quả.
 * Dạng: DEV_<16 hex>.  Chữ/số/'_' nên an toàn trong URL, tên cột Sheet và JSON.
 */
function deviceId() {
  const raw = fingerprint();
  if (!raw) return '';
  const hash = crypto.createHash('sha256').update('cn-tax-tools/machine/v1|' + raw).digest('hex');
  return 'DEV_' + hash.slice(0, ID_HEX).toUpperCase();
}

/**
 * Phòng chat SUY RA TỪ mã máy — cùng máy luôn ra cùng phòng.
 * Cài lại app 10 lần vẫn là 1 phòng, không nhân bản.
 * Giữ tiền tố ROOM_WIN_ để khớp regex đang dùng ở Worker, Apps Script và test.
 */
function roomFor(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return '';
  // Đã là phòng thì giữ nguyên — kể cả bản cũ dài ngắn khác nhau. Việc dài
  // đủ hay không là việc Worker/Apps Script lo; ở đây giữ lại cho an toàn,
  // không âm thầm trả về rỗng rồi làm mất phòng cũ của khách.
  if (text.startsWith('ROOM_WIN_')) return text;
  // Bỏ tiền tố DEV_ TRƯỚC khi lấy hex — nếu không thì chữ D/E trong "DEV" lọt
  // vào kết quả và phòng sinh ra không còn là phần đuôi của mã máy nữa.
  const hex = text.replace(/^DEV_/, '').replace(/[^A-F0-9]/g, '');
  if (hex.length >= ROOM_HEX) return 'ROOM_WIN_' + hex.slice(0, ROOM_HEX);
  // Không lấy đủ ký tự hex (mã máy cũ là UUID, hoặc mã không phải hex): BĂM chuỗi
  // gốc để vẫn tất định. Rơi về random ở đây là sai — cài lại app ra phòng khác,
  // mất topic cũ, và đó chính là lỗi ta đang sửa.
  const digest = crypto.createHash('sha256').update('cn-tax-tools/room/v1|' + text).digest('hex').toUpperCase();
  return 'ROOM_WIN_' + digest.slice(0, ROOM_HEX);
}

module.exports = { deviceId, roomFor, fingerprint, kind, ID_HEX, ROOM_HEX };
