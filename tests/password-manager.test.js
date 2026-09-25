'use strict';
// ---------------------------------------------------------------------------
// Tắt hộp thoại "Lưu mật khẩu?" của Chrome/Edge.
// Ba lớp: (1) cờ dòng lệnh, (2) Preferences của profile, (3) autocomplete trong HTML.
// Test này khoá lớp 2 và 3 — lớp dễ bị vô hiệu ngầm nhất.
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { disablePasswordManager } = require('../src/browser');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-prefs-'));

test('disablePasswordManager: tắt dịch vụ lưu mật khẩu trong Preferences của profile', () => {
  const dir = tempDir();
  try {
    assert.equal(disablePasswordManager(dir), true, 'phải ghi được Preferences');
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
    assert.equal(data.credentials_enable_service, false, 'tắt dịch vụ lưu mật khẩu');
    assert.equal(data.credentials_enable_autosignin, false, 'tắt tự động đăng nhập');
    assert.equal(data.profile.password_manager_enabled, false, 'tắt quản lý mật khẩu');
    assert.equal(data.profile.password_manager_leak_detection, false, 'tắt cảnh báo rò rỉ mật khẩu');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disablePasswordManager: ghi kiểu GỘP, không phá thiết lập sẵn có của profile', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Profile đã có sẵn dữ liệu Chrome thật (ví dụ danh sách extension, chế độ hiển thị…).
    fs.writeFileSync(file, JSON.stringify({ profile: { exit_type: 'Normal', avatar_index: 12 }, savefile: { default_directory: 'D:\\HoaDon' } }));

    assert.equal(disablePasswordManager(dir), true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.profile.exit_type, 'Normal', 'giữ nguyên khoá cũ trong profile');
    assert.equal(data.profile.avatar_index, 12, 'giữ nguyên khoá cũ trong profile');
    assert.equal(data.savefile.default_directory, 'D:\\HoaDon', 'giữ nguyên nhóm khoá khác');
    assert.equal(data.profile.password_manager_enabled, false, 'vẫn phải tắt quản lý mật khẩu');
    assert.equal(data.credentials_enable_service, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('disablePasswordManager: Preferences hỏng thì tạo lại, không ném lỗi', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ hong json');
    assert.equal(disablePasswordManager(dir), true, 'JSON hỏng ⇒ bỏ qua bản cũ rồi ghi mới');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.credentials_enable_service, false);
    assert.equal(data.profile.password_manager_enabled, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('index.html: ô mật khẩu/PIN KHÔNG dùng autocomplete current-password / new-password', () => {
  // current-password / new-password là dấu hiệu để Chrome hiện "Lưu mật khẩu?" / "Cập nhật mật khẩu?".
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const passwordInputs = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map(match => match[0]);
  assert.ok(passwordInputs.length >= 5, `phải tìm thấy các ô mật khẩu/PIN (thấy ${passwordInputs.length})`);
  for (const input of passwordInputs) {
    assert.ok(!/autocomplete="(current|new)-password"/.test(input), `ô mật khẩu còn autocomplete dễ bị hỏi lưu: ${input}`);
  }
  // Ô mật khẩu cổng thuế trên form đăng nhập phải có autocomplete="off".
  assert.match(html, /id="login-password"[^>]*autocomplete="off"/, '#login-password phải tắt autocomplete');
  assert.match(html, /id="mst-password"[^>]*autocomplete="off"/, '#mst-password phải tắt autocomplete');
});

test('tax-login.js: trước khi gửi form thì tắt autocomplete cho form cổng thuế', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tax-login.js'), 'utf8');
  assert.match(source, /const quietPasswordManager = f => \{/, 'phải có hàm quietPasswordManager');
  assert.match(source, /quietPasswordManager\(f\);\n/, 'phải gọi hàm này trong nhánh submit');
  // Không được đụng tới name/id/value của form — nếu đổi sẽ làm hỏng việc gửi form của cổng thuế.
  const fn = source.slice(source.indexOf('const quietPasswordManager = f => {'), source.indexOf('const token ='));
  assert.ok(!/\.name\s*=/.test(fn), 'không được đổi name');
  assert.ok(!/\.value\s*=/.test(fn), 'không được đổi value');
});

test('browser.js: mở Chrome thì tắt bong bóng lưu mật khẩu và ghi Preferences trước khi spawn', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser.js'), 'utf8');
  assert.match(source, /--disable-save-password-bubble/, 'thiếu cờ --disable-save-password-bubble');
  assert.match(source, /--disable-features=PasswordManagerOnboarding/, 'thiếu cờ --disable-features cho password manager');
  // Gọi TRƯỚC khi spawn để Chrome đọc Preferences ngay lúc khởi động.
  const callAt = source.indexOf('disablePasswordManager(profile);');
  const spawnAt = source.indexOf('this.process = spawn(executablePath, args');
  assert.ok(callAt > -1 && spawnAt > -1 && callAt < spawnAt, 'phải ghi Preferences TRƯỚC khi spawn Chrome');
});
