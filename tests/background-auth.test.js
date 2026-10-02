'use strict';
// ---------------------------------------------------------------------------
// TỰ ĐĂNG NHẬP NỀN — phát hiện phiên hết và đăng lại mà không khoá giao diện,
// không mở hộp thoại.
//
// Rủi ro chính của nhóm này KHÔNG phải "đăng nhập không chạy" mà là ba thứ âm thầm:
//   1. Khoá UI khi đăng nhập nền ⇒ mở app là đứng hình (đúng thứ người dùng ghét).
//   2. Cờ "đang đăng nhập" bị quên xoá khi lượt ném lỗi ⇒ MST kẹt vĩnh viễn,
//      không bao giờ đăng nhập lại được nữa.
//   3. Tự dộng thử lại vô hạn ⇒ dội cổng thuế, có thể khiến tài khoản bị khoá.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

const fn = (name, span = 2600) => {
  const at = serverSrc.indexOf(name);
  assert.ok(at > 0, `khong tim thay ${name} trong server.js`);
  return serverSrc.slice(at, at + span);
};

// ---- không khoá UI -------------------------------------------------------------

test('REGRESSION: đăng nhập nền KHÔNG được báo thành authBusy cho giao diện', () => {
  // authBusy tắt nút Tra cứu / Tải / Tiếp tục / toggle Chrome (renderer.js:774+).
  // Nếu appState() lấy thẳng authBusy.has(selected) thì mỗi lần tự đăng nhập nền
  // lại đóng băng giao diện — tức là tính năng này vô dụng.
  const body = fn('function appState()', 1400);
  assert.match(body, /authBusy:\s*foregroundAuth\.has\(selected\)/,
    'appState phai bao authBusy theo foregroundAuth, khong theo authBusy');
  assert.doesNotMatch(body, /authBusy:\s*authBusy\.has\(selected\)/,
    'vẫn đang khoá UI khi đăng nhập nền');
  assert.match(body, /backgroundAuth:\s*backgroundAuth\.has\(selected\)/,
    'phai bao trạng thái đăng nhập nền để giao diện hiện dòng báo');
});

test('hai cờ phải tách bạch, và đều được xoá trong finally', () => {
  assert.match(serverSrc, /const authBusy = new Set\(\)/);
  assert.match(serverSrc, /const foregroundAuth = new Set\(\)/);
  // authOperation là nơi dễ quên: xoá authBusy mà quên foregroundAuth thì MST kẹt.
  const op = fn('async function authOperation', 600);
  assert.match(op, /foregroundAuth\.add\(key\)/);
  const block = op.slice(op.indexOf('try {'), op.indexOf('\n}'));
  assert.match(block, /finally\s*\{[^}]*foregroundAuth\.delete\(key\)[^}]*\}/,
    'foregroundAuth.delete phai nam TRONG finally — nam ngoai thi loi se lam MST ket vinh vien');
  assert.doesNotMatch(block, /\}\s*foregroundAuth\.delete/,
    'foregroundAuth.delete dang nam NGOAI finally');
});

// ---- không mở hộp thoại -------------------------------------------------------

test('REGRESSION: đăng nhập nền không được để lại trạng thái chờ CAPTCHA', () => {
  // autoLoginAccount() ghi loginChallenge (toàn cục) khi cần CAPTCHA. Đăng nhập nền
  // không mở modal nào, nên để lại trạng thái đó ⇒ giao diện tưởng đang chờ nhập
  // CAPTCHA ở một hộp thoại không tồn tại.
  const body = fn('function maybeAutoRelogin', 1800);
  assert.match(body, /const before = loginChallenge/);
  assert.match(body, /loginChallenge = before/);
  const finallyBlock = body.slice(body.indexOf('.finally('));
  assert.match(finallyBlock, /loginChallenge = before/,
    'phai khoi phuc loginChallenge trong finally');
});

test('đăng nhập nền chỉ ghi log, không gọi hàm mở hộp thoại nào', () => {
  const body = fn('function maybeAutoRelogin', 1800);
  assert.doesNotMatch(body, /challengeResponse\(/, 'tu dong dang nhap nen khong duoc tao challenge');
  assert.doesNotMatch(body, /submitLogin|captcha\(mst\)/, 'khong duoc tu goi CAPTCHA');
  assert.match(body, /noteBackgroundAuthFail/, 'that bai phai duoc ghi lai de bo qua');
  assert.match(body, /return true;\n?\s*}\n/, 'co bao hien ra ket qua');
});

test('đăng nhập nền không được phép ném lỗi ra ngoài', () => {
  const body = fn('function maybeAutoRelogin', 1800);
  // Không await (nếu await thì chặn thao tác của người dùng) và không throw.
  assert.match(body, /autoLoginAccount\([\s\S]*?\)\s*\n\s*\.then\(/,
    'phai chay khong await roi .then() — await se lam tra cuu cua nguoi dung bi treo');
  assert.match(body, /\.catch\(error => noteBackgroundAuthFail/,
    'phai co .catch — loi nen duoc ghi lai chu khong duot lan sang request nao');
});

// ---- hạn chế số lần thử -------------------------------------------------------

test('REGRESSION: tự đăng nhập phải có hạn số lần, không dội cổng thuế vô hạn', () => {
  const max = /BACKGROUND_AUTH_MAX_ATTEMPTS\s*=\s*(\d+)/.exec(serverSrc);
  const cooldown = /BACKGROUND_AUTH_COOLDOWN_MS\s*=\s*(\d+)/.exec(serverSrc);
  assert.ok(max, 'phai co BACKGROUND_AUTH_MAX_ATTEMPTS');
  assert.ok(cooldown, 'phai co BACKGROUND_AUTH_COOLDOWN_MS');
  assert.ok(Number(max[1]) <= 5, `${max[1]} lần thử là quá nhiều, có thể bị cổng thuế khoá tài khoản`);
  assert.ok(Number(cooldown[1]) >= 30000, 'cooldown quá ngắn thì hai lần thử liên tiếp như nhau');
  const guard = fn('function canAutoRelogin', 1200);
  assert.match(guard, /BACKGROUND_AUTH_MAX_ATTEMPTS/, 'canAutoRelogin phai chan khi het luot');
  assert.match(guard, /BACKGROUND_AUTH_COOLDOWN_MS/, 'canAutoRelogin phai chan khi chua qua cooldown');
});

test('đăng nhập nền chỉ chạy khi có mật khẩu đã lưu', () => {
  const guard = fn('function canAutoRelogin', 1200);
  assert.match(guard, /isRemembered\(mst\)/,
    'khong co mat khau thi khong the tu dong — phai bo qua thay vi lo nhac');
});

test('đăng nhập nền không xen vào lúc MST đang chạy tác vụ', () => {
  const guard = fn('function canAutoRelogin', 1200);
  assert.match(guard, /engineFor\(mst\)\?\.busy/,
    'engine dang chay thi dang nhap xen vao se lam hong luot tra cuu dang dung');
});

// ---- phạm vi ------------------------------------------------------------------

test('đăng nhập nền chỉ áp cho MST ĐANG CHỌN, không mở cả danh sách', () => {
  const guard = fn('function canAutoRelogin', 1200);
  assert.match(guard, /mst !== selected/, 'chi MST dang chon');
});

// ---- chặn chạy lượt giữa lúc đang đăng nhập ---------------------------------

test('REGRESSION: bấm Tra cứu giữa lúc đang tự đăng nhập nền phải CHỜ, không ném lỗi', () => {
  // Nút không bị khoá khi đăng nhập nền (nếu khoá, tính năng này đóng băng giao diện).
  // Nên bấm vào phải chạy được — ném "đang tự đăng nhập lại, thử lại sau" tức là người
  // dùng bấm nút hoạt động rồi nhận lỗi: tệ hơn cả lúc khoá nút.
  for (const route of ['/api/search', '/api/stream']) {
    const at = serverSrc.indexOf(`url.pathname === '${route}'`);
    assert.ok(at > 0, `khong tim thay ${route}`);
    const tail = serverSrc.slice(at, at + 1600);
    assert.match(tail, /waitBackgroundAuth\(target\.mst\)/,
      `${route} phai cho luot dang chay`);
    assert.doesNotMatch(tail, /authBusy\.has\(target\.mst\)\) throw/,
      `${route} khong duoc nem loi cho nguoi dung`);
  }
});

test('REGRESSION: chờ lượt đăng nhập nền phải có trần thời gian', () => {
  // Không có trần thì request treo vĩnh viễn nếu người dùng không bấm được nút nữa.
  const fn = serverSrc.slice(serverSrc.indexOf('async function waitBackgroundAuth'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /setTimeout\(resolve, \d+\)/, 'phai co tran thoi gian');
  assert.match(body, /task\.catch/, 'phai nuot loi de khong de ket qua moi mat');
});

// ---- các điểm kích hoạt -------------------------------------------------------

test('có đủ ba điểm kích hoạt: chọn MST · lúc khởi động · lượt tra cứu hết phiên', () => {
  assert.match(fn('async function selectAccount', 1200), /maybeAutoRelogin\(mst,/, 'khi bam chon MST');
  assert.match(fn('async function startupSessionCheck', 2600), /maybeAutoRelogin\(selected,/, 'luc khoi dong');
  const search = serverSrc.slice(serverSrc.indexOf("url.pathname === '/api/search'"), serverSrc.indexOf("url.pathname === '/api/stream'"));
  assert.match(search, /maybeAutoRelogin\(target\.mst,/, 'khi luot tra cuu dung vi het phien');
});

test('REGRESSION: chỉ kích hoạt khi phiên thực sự không dùng được', () => {
  // Nếu kiểm tra thiếu, phiên còn tốt vẫn bị đăng nhập lại vô ích (và tốn lượt cổng thuế).
  const select = fn('async function selectAccount', 1200);
  assert.match(select, /if \(!restored && !account\) maybeAutoRelogin/,
    'chi khi vua restore that bai va checkLogin that khong ra gi do moi dang lai');
  const startup = fn('async function startupSessionCheck', 2600);
  assert.match(startup, /if \(selected && !directTokens\.has\(selected\)\)/,
    'chi khi MST dang chon khong con token moi dang lai');
});

// ---- giao diện ----------------------------------------------------------------

test('giao diện hiện trạng thái đăng nhập nền thay vì để trống', () => {
  const body = rendererSrc.slice(rendererSrc.indexOf('const sessionHint'));
  assert.match(body, /state\.backgroundAuth/, 'phai hien "dang tu dang nhap lai"');
  assert.match(body, /account\.autoLoginBlocked/, 'phai hien "tu dang nhap that bai"');
  assert.match(rendererSrc, /sessionHint\(account, state\)/, 'phai truyen ca state');
});

test('giao diện vẽ lại khi trạng thái đăng nhập nền đổi', () => {
  // Bỏ sót stateSignature thì dòng báo hiện mãi sau khi đăng nhập xong.
  const sig = rendererSrc.slice(rendererSrc.indexOf('function stateSignature'));
  // `return [...]` nằm ở dòng KẾ TIẾP, không phải cùng dòng khai báo hàm.
  const line = sig.slice(0, sig.indexOf("].join("));
  assert.match(line, /state\.backgroundAuth/, 'stateSignature phai co backgroundAuth');
  assert.match(line, /state\.autoLoginBlocked/, 'stateSignature phai co autoLoginBlocked');
});

test('giao diện KHÔNG khoá nút khi đăng nhập nền', () => {
  // Công thức khoá nút phải dùng authBusy (đã tách sang foreground) chứ không dùng
  // cờ đăng nhập nền. Test này chặn việc sau này ai đó nhét backgroundAuth vào.
  const at = rendererSrc.indexOf("$('search').disabled =");
  const line = rendererSrc.slice(at, rendererSrc.indexOf('\n', at));
  assert.match(line, /state\.authBusy/, 'nut Tra cuu khoa theo authBusy (foreground)');
  assert.doesNotMatch(line, /backgroundAuth/, 'nut Tra cuu KHONG duoc khoa theo dang nhap nen');
});