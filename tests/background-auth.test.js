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

// Cùng cách cắt, nhưng BỎ CHÚ THÍCH — nhiều chốt ở đây được giải thích trong comment
// ("KHÔNG đụng loginChallenge"…) nên so thẳng ra sẽ khớp nhầm chữ trong comment chứ không
// phải trong code. Chỉ code mới là hành vi thật.
const fnCode = (name, span = 2600) => fn(name, span)
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

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
  // Bản cũ phải CẤT giữ `loginChallenge` rồi khôi phục lại, vì `autoLoginAccount` ghi biến
  // toàn cục đó khi cần CAPTCHA. Nay lõi là `autoLoginFor` — nó KHÔNG đụng `loginChallenge`
  // chút nào, nên không còn gì để cất/khôi phục.
  //
  // Nếu sau này ai đó thêm `loginChallenge` vào lõi, giao diện sẽ tưởng đang chờ nhập CAPTCHA
  // ở một hộp thoại không tồn tại ⇒ nên chặn ngay tại đây thay vì chỉ hy vọng có nhớ phục hồi.
  const body = fnCode('function maybeAutoRelogin', 1800);
  assert.doesNotMatch(body, /loginChallenge/,
    'lõi đăng nhập nền không được đụng loginChallenge (trạng thái CAPTCHA toàn cục)');
  const core = fnCode('async function autoLoginFor', 2200);
  assert.doesNotMatch(core, /loginChallenge/, 'lõi autoLoginFor cũng không được đụng');
});

test('đăng nhập nền chỉ ghi log, không gọi hàm mở hộp thoại nào', () => {
  const body = fn('function maybeAutoRelogin', 1800);
  assert.doesNotMatch(body, /challengeResponse\(/, 'tu dong dang nhap nen khong duoc tao challenge');
  assert.doesNotMatch(body, /submitLogin/, 'khong duoc tu goi submitLogin');
  assert.match(body, /noteBackgroundAuthFail/, 'that bai phai duoc ghi lai de bo qua');
  // PhảI trả promise ra để nơi gọi chờ được (startupSessionCheck gom Promise.all).
  assert.match(body, /backgroundAuthTasks\.set\(mst, task\)/, 'phai luu promise de request cho duoc');
  assert.match(body, /return task;/, 'phai tra promise ra ngoai');
});

test('đăng nhập nền không được phép ném lỗi ra ngoài', () => {
  const body = fn('function maybeAutoRelogin', 1800);
  // Không await (nếu await thì chặn thao tác của người dùng) và không throw.
  // Lõi gọi là `autoLoginFor` (không đụng `selected`/`loginChallenge`) để nhiều MST chạy song song.
  assert.match(body, /autoLoginFor\(mst,[\s\S]*?\)\s*\n\s*\.then\(/,
    'phai chay khong await roi .then() — await se lam tra cuu cua nguoi dung bi treo');
  assert.match(body, /\.catch\(error => \{ noteBackgroundAuthFail/,
    'phai co .catch — loi nen duoc ghi lai chu khong duot lan sang request nao');
});

// ---- hạn chế số lần thử -------------------------------------------------------

test('REGRESSION: tự đăng nhập phải có hạn số lần, không dội cổng thuế vô hạn', () => {
  const max = /BACKGROUND_AUTH_MAX_ATTEMPTS\s*=\s*(\d+)/.exec(serverSrc);
  const cooldown = /BACKGROUND_AUTH_COOLDOWN_MS\s*=\s*(\d+)/.exec(serverSrc);
  assert.ok(max, 'phai co BACKGROUND_AUTH_MAX_ATTEMPTS');
  assert.ok(cooldown, 'phai co BACKGROUND_AUTH_COOLDOWN_MS');
  assert.ok(Number(max[1]) <= 5, `${max[1]} lần thử là quá nhiều, có thể bị cổng thuế khoá tài khoản`);
  // Chạy SONG SONG KHÔNG được nới lỏng hai chốt này: đó là chốt chống khoá tài khoản, còn
  // tốc độ đến từ việc bỏ giới hạn "chỉ MST đang chọn" (xem test phạm vi ở trên).
  assert.ok(Number(cooldown[1]) >= 30000, 'cooldown quá ngắn thì hai lần thử liên tiếp như nhau');
  // Hạn mức phải tính THEO TỪNG MST — nếu dùng chung một bộ đếm thì 10 MST đăng nhập song
  // song sẽ cộng dồn và đủ 3 lần là cả danh sách bị bỏ, dù mỗi MST mới hỏng đúng một lần.
  assert.match(serverSrc, /backgroundAuthFails\.set\(mst,/, 'bộ đếm lỗi phải khoá theo từng MST');
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

test('đăng nhập nền chạy cho MỌI MST có mật khẩu, SONG SONG — không chỉ MST đang chọn', () => {
  // Đổi (1.1.2): trước đây chỉ login MST đang chọn (`mst !== selected`) nên các MST khác phải
  // chờ người dùng bấm tay — mở app phải chờ tuần tự từng cái. Mỗi MST có kho cookie riêng
  // (tct-api `jars`) nên chạy song song được.
  const guard = fn('function canAutoRelogin', 1200);
  assert.doesNotMatch(guard, /mst !== selected/, 'đã bỏ giới hạn chỉ MST đang chọn');
  // Nhưng vẫn phải kẹp đúng các điều kiện an toàn — nới phạm vi KHÔNG được nới chốt.
  assert.match(guard, /accountFor\(mst\)/, 'vẫn chỉ MST có trong danh sách');
  assert.match(guard, /isRemembered\(mst\)/, 'vẫn chỉ MST đã lưu mật khẩu');
  assert.match(guard, /authBusy\.has\(mst\)/, 'vẫn chặn khi MST đó đang đăng nhập');
});

test('đăng nhập nền KHÔNG đụng biến MST đang xem — nếu không sẽ giành nhau khi chạy song song', () => {
  // Đây là lý do tách `autoLoginFor` ra khỏi `autoLoginAccount`: bản gọi `selectAccount(mst)`
  // nên mỗi lượt ghi đè `selected` toàn cục — vài lượt chạy song song sẽ đổi MST đang xem
  // của người dùng và ghi nhầm danh tính vào phiên.
  const relogin = fnCode('function maybeAutoRelogin', 2000);
  assert.match(relogin, /autoLoginFor\(mst,/, 'phải dùng lõi không đụng selected');
  assert.doesNotMatch(relogin, /autoLoginAccount\(/, 'không được gọi đường có selectAccount()');
  const core = fnCode('async function autoLoginFor', 2200);
  assert.doesNotMatch(core, /selectAccount\(/, 'lõi không được đổi MST đang chọn');
  assert.doesNotMatch(core, /loginChallenge/, 'lõi không được đụng trạng thái CAPTCHA toàn cục');
  // `authAccount` chỉ cập nhật khi đúng MST đang xem.
  assert.match(core, /if \(mst === selected\) authAccount/, 'chỉ cập nhật authAccount của MST đang chọn');
});

test('lúc khởi động: login SONG SONG mọi MST hết phiên, không phải lần lượt', () => {
  const startup = fn('async function startupSessionCheck', 3400);
  assert.match(startup, /needLogin/, 'phải gom danh sách MST cần đăng nhập');
  assert.match(startup, /Promise\.all\(needLogin\.map/, 'phải chạy SONG SONG, không tuần tự');
  assert.match(startup, /!directTokens\.has\(item\.mst\)/, 'chỉ MST chưa có phiên');
  assert.match(startup, /isRemembered\(item\.mst\)/, 'chỉ MST đã lưu mật khẩu');
  assert.doesNotMatch(fnCode('async function startupSessionCheck', 3400), /maybeAutoRelogin\(selected,/,
    'không còn giới hạn MST đang chọn');
});

test('đăng nhập xong thì tự chạy Auto Sync — dữ liệu sẵn sàng không cần bấm nút', () => {
  const relogin = fn('function maybeAutoRelogin', 2000);
  assert.match(relogin, /autoSyncFor\(mst\)/, 'phải tự kích hoạt Auto Sync cho MST vừa đăng nhập');
  assert.match(relogin, /!instance\.running/, 'không chạy chồng nếu MST đang đồng bộ');
  assert.match(relogin, /instance\.run\('auto-login'\)/, 'chạy Auto Sync ngầm');
});

// ---- chặn chạy lượt giữa lúc đang đăng nhập ---------------------------------

test('REGRESSION: bấm Tra cứu giữa lúc đang tự đăng nhập nền phải CHỜ, không ném lỗi', () => {
  // Nút không bị khoá khi đăng nhập nền (nếu khoá, tính năng này đóng băng giao diện).
  // Nên bấm vào phải chạy được — ném "đang tự đăng nhập lại, thử lại sau" tức là người
  // dùng bấm nút hoạt động rồi nhận lỗi: tệ hơn cả lúc khoá nút.
  // /api/download là đường DUY NHẤT của nút tải từ 1.1.2 (#search + #stream-download + #resume
  // đã gộp). /api/search và /api/stream còn lại là đường NỘI BỘ cho Auto Sync / quét lần đầu.
  for (const route of ['/api/download', '/api/search', '/api/stream']) {
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
  // Lúc khởi động nay gom nhiều MST và chạy song song (xem test ở trên) thay vì một MST.
  // Điểm kích hoạt theo LƯỢT THỦ CÔNG nay nằm ở /api/download (đường duy nhất của nút tải).
  const download = serverSrc.slice(serverSrc.indexOf("url.pathname === '/api/download'"), serverSrc.indexOf("url.pathname === '/api/resume'"));
  assert.match(download, /maybeAutoRelogin\(target\.mst,/, 'khi luot tai dung vi het phien');
  // Đường nội bộ /api/search vẫn phải giữ điểm kích hoạt của riêng nó (quét lần đầu MST mới).
  const search = serverSrc.slice(serverSrc.indexOf("url.pathname === '/api/search'"), serverSrc.indexOf("url.pathname === '/api/stream'"));
  assert.match(search, /maybeAutoRelogin\(target\.mst,/, 'khi luot tra cuu dung vi het phien');
});

test('REGRESSION: chỉ kích hoạt khi phiên thực sự không dùng được', () => {
  // Nếu kiểm tra thiếu, phiên còn tốt vẫn bị đăng nhập lại vô ích (và tốn lượt cổng thuế).
  const select = fn('async function selectAccount', 1200);
  assert.match(select, /if \(!restored && !account\) maybeAutoRelogin/,
    'chi khi vua restore that bai va checkLogin that khong ra gi do moi dang lai');
  // Lúc khởi động: mọi MST đều được soi trước bằng restoreSession, nên chỉ MST KHÔNG có token
  // mới vào danh sách đăng nhập lại.
  const startup = fn('async function startupSessionCheck', 3200);
  assert.match(startup, /\.filter\(item => !directTokens\.has\(item\.mst\)/,
    'chi khi MST khong con token moi dang lai');
  // Và phải còn chốt canAutoRelogin() bên trong maybeAutoRelogin — nếu mất thì mọi MST
  // đều bị kích hoạt kể cả MST không có mật khẩu / đang chạy tác vụ.
  assert.match(fn('function maybeAutoRelogin', 300), /if \(!canAutoRelogin\(mst\)\) return null/,
    'van phai kiem tra canAutoRelogin truoc khi chay');
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
  // Từ 1.1.2 nút "Tra cứu" + "Tải ngay" + "Tải tiếp" đã gộp thành MỘT #download-btn.
  const at = rendererSrc.indexOf("downloadButton.disabled =");
  const line = rendererSrc.slice(at, rendererSrc.indexOf('\n', at));
  assert.match(line, /state\.authBusy/, 'nut Tai hoa don khoa theo authBusy (foreground)');
  assert.doesNotMatch(line, /backgroundAuth/, 'nut Tai hoa don KHONG duoc khoa theo dang nhap nen');
});