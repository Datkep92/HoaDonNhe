'use strict';
// TỰ KHỞI ĐỘNG CÙNG WINDOWS — ghi khoá Run trong registry của CHÍNH người dùng.
//
// Vì sao HKCU chứ không phải HKLM hay Task Scheduler:
//   • HKCU ("HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run") không
//     cần quyền Administrator ⇒ bộ cài đặt "chạy cho mọi người dùng" không cần
//     nâng quyền, và người dùng tự xoá được trong Task Manager → Startup.
//   • Task Scheduler mạnh hơn nhưng cần quyền, tạo task khó dọn, và bị chặn bởi
//     một số chính sách doanh nghiệp nhiều hơn. Run key là cách ít ma sát nhất.
//
// Vì sao gọi reg.exe thay vì module native:
//   • Icon khay đã đi theo hướng này (PowerShell NotifyIcon) để giữ bản portable,
//     không phải cài driver. Thêm module native chỉ để ghi 1 giá trị registry là
//     không đáng.
//   • reg.exe có mặt sẵn trên mọi Windows, không cần kèm file thêm khi đóng gói.
//
// LƯU Ý về nguồn sự thật: registry là nơi Windows thực sự đọc, nên trạng thái bật/tắt
// phải lưu ở đó. Nhưng "người dùng đã TẮT" cũng phải nhớ — không có thì lần khởi
// động sau app lại tự bật lên, tức không tắt được. Vì vậy lựa chọn của người dùng được
// ghi thêm vào du_lieu/app-settings.json (autostart: true/false), còn registry là nơi
// thi hành. Lần chạy đầu tiên chưa có lựa chọn nào ⇒ coi như BẬT.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VALUE_NAME = 'CN Tax Tools';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// Cờ này là toàn bộ ý nghĩa của module: có nó thì server khởi động mà KHÔNG mở cửa
// sổ Chrome, chỉ hiện icon khay. Xem src/server.js (--start-hidden).
const START_FLAG = '--start-hidden';

// Mặc định BẬT: cài mới thì muốn app tự chạy nền. Chỉ áp dụng khi người dùng chưa
// từng chọn gì (xem readChoice).
const DEFAULT_ENABLED = true;

// ---- lựa chọn của người dùng (du_lieu/app-settings.json) ------------------------

function settingsFile(dataDir) { return path.join(dataDir, 'app-settings.json'); }

function readChoice(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(dataDir), 'utf8'));
    // Chỉ nhận đúng boolean. Chuỗi "false" hay số 0 từ file hỏng không được đổi
    // thành BẬT — sẽ bật lại thứ người dùng đã tắt.
    return typeof raw.autostart === 'boolean' ? raw.autostart : null;
  } catch { return null; }
}

function writeChoice(dataDir, enabled) {
  const file = settingsFile(dataDir);
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { current = {}; }
  if (!current || typeof current !== 'object') current = {};
  current.autostart = !!enabled;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Ghi tạm rồi đổi tên: điện máy tắt đột ngột giữa chừng không để lại file hỏng
    // khiến lựa chọn của người dùng mất và app tự bật lại.
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(temp, file);
    return true;
  } catch { return false; }
}

// ---- lệnh sẽ ghi vào registry --------------------------------------------------

// Khi đóng gói bằng pkg, process.execPath là chính file EXE. Khi chạy thử bằng
// `node src/server.js` thì phải ghi cả node + đường dẫn script, nếu không Windows
// sẽ cố chạy file .js như một chương trình và hỏng.
function launchCommand() {
  const exe = process.execPath || '';
  const quote = value => '"' + String(value).replace(/"/g, '') + '"';
  if (process.pkg) return quote(exe) + ' ' + START_FLAG;
  const script = process.argv[1] || path.join(__dirname, 'server.js');
  return quote(exe) + ' ' + quote(script) + ' ' + START_FLAG;
}

// ---- đọc/ghi registry ---------------------------------------------------------

// reg.exe trả mã thoát 1 khi giá trị không tồn tại — đó là câu trả lời "tắt", không
// phải lỗi. Chỉ coi là lỗi khi không phân tích được đầu ra.
function reg(args) {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 8000, encoding: 'latin1' },
      (error, stdout, stderr) => resolve({
        ok: !error,
        code: error ? error.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
  });
}

// Cột phải bắt đầu bằng 4 khoảng trắng rồi tới tên giá trị — định dạng cố định của
// `reg query`. Dùng regex bám mép chứ không tách theo khoảng trắng vì chính lệnh
// cũng có khoảng trắng trong đường dẫn.
function parseRunValue(stdout, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp('^\\s{4}' + escaped + '\\s+REG_SZ\\s+(.*)$', 'im').exec(stdout);
  return match ? match[1].trim() : '';
}

// `runner` cho phép thay lớp đọc/ghi registry khi kiểm thử, để test không bao giờ
// đụng registry thật của máy đang chạy test. Mặc định là reg.exe.
async function readRegistry(runner = reg) {
  const result = await runner(['query', RUN_KEY, '/v', VALUE_NAME]);
  if (result.code === 1) return { exists: false, command: '' };
  const command = parseRunValue(result.stdout, VALUE_NAME);
  return { exists: !!command, command: command };
}

async function writeRegistry(command, runner = reg) {
  // /f = không hỏi xác nhận (đây là chạy tự động lúc app mở, không ai bấm được).
  const result = await runner(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  return { ok: result.ok, error: result.ok ? '' : (result.stderr || result.stdout).trim() };
}

async function deleteRegistry(runner = reg) {
  const result = await runner(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  // reg delete trả mã 1 khi giá trị không có sẵn — đó là đúng ý muốn, coi như xoá xong.
  return { ok: result.ok || result.code === 1, error: result.ok || result.code === 1 ? '' : (result.stderr || result.stdout).trim() };
}

// ---- API cho server ------------------------------------------------------------

// Trạng thái để hiện lên UI. `pending` = người dùng đã bật nhưng ghi registry hỏng
// (thường là do chính sách doanh nghiệp khóa Run key) — cần báo để họ không tưởng
// là đã bật xong trong khi Windows không hề chạy app lúc khởi động.
async function status(dataDir, runner = reg) {
  const supported = process.platform === 'win32';
  const choice = readChoice(dataDir);
  const enabled = choice === null ? DEFAULT_ENABLED : choice;
  if (!supported) return { supported: false, enabled: false, chosen: choice, command: '', pending: false, error: '' };
  const registry = await readRegistry(runner);
  return {
    supported: true,
    enabled: registry.exists,
    chosen: choice,
    command: registry.command,
    pending: enabled && !registry.exists,
    error: '',
  };
}

// Bật/tắt theo lựa chọn của người dùng. Ghi lựa chọn TRƯỚC, thi hành registry
// SAU: nếu reg.exe lỗi thì lựa chọn vẫn được nhớ, và `sync()` sẽ thử lại ở lần
// khởi động sau thay vì âm thầm bật lại.
async function setEnabled(dataDir, enabled, runner = reg) {
  const want = !!enabled;
  writeChoice(dataDir, want);
  const result = want ? await writeRegistry(launchCommand(), runner) : await deleteRegistry(runner);
  const current = await status(dataDir, runner);
  return { ...current, error: result.error || current.error };
}

// Đồng bộ registry theo lựa chọn đã lưu — gọi lúc khởi động.
// Ba trường hợp:
//   • chưa chọn gì  → mặc định BẬT, ghi Run key
//   • chọn BẬT     → ghi nếu thiếu, HOẶC sửa nếu lệnh đang trỏ sai chỗ (app được
//                     chuyển thư mục / nâng cấp ⇒ Windows vẫn chạy file cũ)
//   • chọn TẮT     → xoá nếu còn sót (trường hợp gỡ cài đặt cũ chưa dọn khoá)
async function sync(dataDir, runner = reg) {
  if (process.platform !== 'win32') return { supported: false, changed: false, error: '' };
  const choice = readChoice(dataDir);
  const want = choice === null ? DEFAULT_ENABLED : choice;
  try {
    const registry = await readRegistry(runner);
    if (!want) {
      if (!registry.exists) return { supported: true, changed: false, error: '' };
      const removed = await deleteRegistry(runner);
      return { supported: true, changed: removed.ok, error: removed.error };
    }
    const command = launchCommand();
    // So sánh bỏ qua khác biệt khoảng trắng quanh dấu nháy: cùng một ý mà khác
    // chuỗi thì ghi lại mỗi lần khởi động, vô nghĩa.
    if (registry.exists && registry.command.replace(/\s+/g, ' ').trim() === command.replace(/\s+/g, ' ').trim()) {
      return { supported: true, changed: false, error: '' };
    }
    const written = await writeRegistry(command, runner);
    return { supported: true, changed: written.ok, error: written.error };
  } catch (error) {
    return { supported: true, changed: false, error: String((error && error.message) || error) };
  }
}

module.exports = {
  VALUE_NAME,
  RUN_KEY,
  START_FLAG,
  DEFAULT_ENABLED,
  settingsFile,
  launchCommand,
  readChoice,
  writeChoice,
  parseRunValue,
  readRegistry,
  status,
  setEnabled,
  sync,
};