'use strict';
// ---------------------------------------------------------------------------
// KHỞI ĐỘNG NHANH — không chặn giao diện vào lúc kiểm tra phiên.
//
// Bối cảnh (đo trên máy thật, log nhat-ky.log):
//   00:19:32  Đã mở giao diện          ← 0 giây
//   00:19:45  Đã hiện icon khay        ← 13 giây, dù timer chỉ 2,5s
//   00:19:46  Kiểm tra phiên MST đầu   ← 14 giây, dù lệnh gọi từ 3 giây
//   00:19:53  Xong 7 MST               ← 21 giây
// Timer 2,5 giây hoãn tới 13 giây ⇒ event loop bị chặn ~10 giây. Thủ phạm đo
// được: secrets.unprotect() với DPAPI spawn `powershell.exe` bằng execFileSync,
// ~500 ms mỗi lần; 7 MST × 2 key (token + cookie) = ~7 giây chặn cứng.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer.js');
const SECRETS = path.join(__dirname, '..', 'src', 'secrets.js');

const serverSrc = fs.readFileSync(SERVER, 'utf8');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const secretsSrc = fs.readFileSync(SECRETS, 'utf8');

// ---- không chặn event loop ----------------------------------------------------

test('REGRESSION: giải mã phải có khoá nhớ, nếu không thì lại chặn ~7 giây lúc mở app', () => {
  // execFileSync(powershell) là đồng bộ: nó đứng hình MỌI request của giao diện,
  // không chỉ riêng lúc kiểm tra phiên. Đây là nguyên nhân gốc, phần còn lại chỉ
  // là triệu chứng.
  assert.match(secretsSrc, /DECRYPT_CACHE/, 'secrets.js phải nhớ kết quả giải mã');
  assert.match(secretsSrc, /DECRYPT_CACHE_MAX\s*=/, 'phải có trần bộ nhớ');
});

test('REGRESSION: khoá nhớ phải theo blob đã mã hoá, không theo tên MST', () => {
  // Theo MST thì hai MST trùng tên (đổi MST chủ, copy du_lieu) sẽ nhận nhầm phiên
  // của nhau. Theo blob thì không: cùng blob ⇔ cùng bản rõ.
  const body = secretsSrc.slice(secretsSrc.indexOf('function unprotect'));
  const cache = body.slice(0, body.indexOf('function file'));
  assert.match(cache, /DECRYPT_CACHE\.get\(value\)/, 'khoá phải là chính blob');
  assert.doesNotMatch(cache, /DECRYPT_CACHE\.get\(mst\)/, 'không được khoá theo mst');
});

test('khoá nhớ có trần và đuổi bản cũ nhất khi vượt', () => {
  const body = secretsSrc.slice(secretsSrc.indexOf('function unprotect'));
  assert.match(body, /DECRYPT_CACHE\.size\s*>=\s*DECRYPT_CACHE_MAX/,
    'app chạy nhiều ngày sẽ phình bộ nhớ nếu không đuổi bản cũ nhất');
});

test('danh tính máy được nhớ trong tiến trình (nhánh AES gọi mỗi lần khoá)', () => {
  assert.match(secretsSrc, /machineIdCache/,
    'os.networkInterfaces() phải được gọi một lần, không phải mỗi lần khoá');
});

// ---- kiểm tra phiên chạy nền, không chặn giao diện ---------------------------

test('kiểm tra phiên lúc khởi động được trì hoãn, không chạy ngay lúc mở app', () => {
  assert.match(serverSrc, /SESSION_CHECK_DELAY_MS\s*=\s*\d+/, 'phải có hằng số trễ');
  const delay = Number(/SESSION_CHECK_DELAY_MS\s*=\s*(\d+)/.exec(serverSrc)[1]);
  assert.ok(delay >= 8000, `trễ ${delay}ms là quá ngắn, giao diện kịp chưa vẽ xong`);
  assert.ok(delay <= 20000, `trễ ${delay}ms là quá dài, phiên hết hạn mà chưa ai kiểm tra`);
});

test('REGRESSION: nơi cần phiên sống phải chờ lần kiểm tra đang chạy', () => {
  // Nếu không chờ: người dùng bấm Tra cứu trong 10 giây đầu sẽ bị báo "chưa đăng
  // nhập" và phải đăng nhập lại, dù phiên vẫn còn nguyên.
  for (const route of ['/api/search', '/api/stream']) {
    const at = serverSrc.indexOf(`url.pathname === '${route}'`);
    assert.ok(at > 0, `không tìm thấy route ${route}`);
    const tail = serverSrc.slice(at, at + 400);
    assert.match(tail, /ensureSessionCheck\(\)/, `${route} phải chờ kiểm tra phiên`);
  }
});

test('ensureSessionCheck là idempotent — gọi lại không dựng lần kiểm tra thứ hai', () => {
  const body = serverSrc.slice(serverSrc.indexOf('function ensureSessionCheck'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /if \(!sessionCheckPromise\)/,
    'phải nhớ promise; nếu không, bấm Tra cứu hai lần sẽ chạy hai lượt kiểm tra chồng nhau trên engine');
});

test('/api/state báo đã kiểm tra phiên hay chưa để giao diện không nói nhầm', () => {
  // Không có cờ này thì giao diện coi phiên đã lưu là "đã hết hạn" — người dùng
  // phải đăng nhập lại trong khi phiên vẫn dùng được.
  assert.match(serverSrc, /sessionChecked:\s*sessionCheckFinished/);
});

// ---- giao diện không chặn -----------------------------------------------------

test('REGRESSION: giao diện không hiện màn hình chặn "vui lòng chờ"', () => {
  // Đây là thứ người dùng thấy vào những giây đầu: một màn hình trắng bảo họ chờ
  // dù dữ liệu của họ đã có sẵn trên máy. Cụm này phải biến mất khỏi renderer.js
  // hoàn toàn — kể cả trong comment, để lần sửa sau không vô tình dựng lại nó.
  assert.doesNotMatch(rendererSrc, /vui lòng chờ trong giây lát/i,
    'vẫn còn màn hình chặn lúc khởi động');
});

test('nhãn phiên phân biệt "chưa kiểm tra" với "đã hết hạn"', () => {
  const fn = rendererSrc.slice(rendererSrc.indexOf('const sessionHint'));
  const body = fn.slice(0, fn.indexOf('\n};') + 3);
  assert.match(body, /session === 'saved'/, 'phải xử lý trạng thái saved');
  assert.match(body, /sessionChecked\s*\?[^:]*hết hạn/, 'chỉ khi ĐÃ kiểm tra mới nói hết hạn');
  assert.match(body, /Đang kiểm tra phiên đã lưu/, 'khi chưa kiểm tra phải nói đang kiểm tra');
});

test('gọi sessionHint xuyên suốt dòng gợi ý, không còn nhánh nói nhầm "đã hết hạn"', () => {
  const at = rendererSrc.indexOf('const sessionHint');
  const after = rendererSrc.slice(at, at + 1800);
  assert.doesNotMatch(after, /session === 'saved'\s*\?\s*'Có phiên đã lưu nhưng đã hết hạn'/,
    'vẫn còn nhánh gộp "có phiên đã lưu" với "đã hết hạn"');
  assert.match(after, /sessionHint\(/, 'phải dùng hàm chung để hai chỗ không lệch nhau');
});

test('vùng kết quả không còn bị thay bằng lời nhắc chờ khi khởi động', () => {
  const at = rendererSrc.indexOf("if (initialLoading && !state.selected)");
  const block = rendererSrc.slice(at, at + 500);
  assert.doesNotMatch(block, /loading-spinner/,
    'spinner toàn màn hình ở vùng kết quả vẫn làm người dùng tưởng phải chờ');
});

// ---------------------------------------------------------------------------
// HỒi quy do chính lần rà soát này phát hiện
// ---------------------------------------------------------------------------

test('REGRESSION: mật khẩu phải nạp sẵn trong lô giải mã lúc khởi động', () => {
  // isRemembered() đọc riêng blob 'password' ⇒ spawn PowerShell đồng bộ ~500ms.
  // Nó được gọi từ canAutoRelogin() tức nằm trong selectAccount() — nếu không nạp sẵn,
  // LẦN ĐẦU bấm MST là đứng thêm nửa giây, và đứng trong lúc người dùng đang bấm.
  const fn = serverSrc.slice(serverSrc.indexOf('async function startupSessionCheck'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /readMany\([\s\S]{0,200}?\[\s*'token',\s*'cookies',\s*'password'\s*\]/,
    'lô giải mã lúc khởi động phải lấy cả password');
  assert.match(body, /remembered\.set\(/,
    'phải nạp sẵn cờ "đã nhớ mật khẩu" để isRemembered() không phải đọc lại từ đĩa');
});

test('REGRESSION: khi lấy XML cho PDF, phải ném lại tín hiệu dừng', () => {
  // Nuốt `paused` trong catch của khối PDF là nghẽn dây chuyền đang chạy không dừng
  // đúng — mỗi lượt sau lại ghi đè. Còn nuốt mọi lỗi khác thì hỏng cả lượt tải.
  const coreSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'core.js'), 'utf8');
  const body = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['html', 'pdf'].includes(x))"));
  const block = body.slice(0, body.indexOf("item.state = 'done'"));
  const guard = block.slice(block.indexOf('catch (error)'));
  assert.match(guard, /if \(error && error\.paused\) throw error;/,
    'tín hiệu dừng phải nằm trong finally/khối catch, không được nuốt');
});

test('REGRESSION: hằng cửa sổ online phải khai báo TRƯỚC chỗ dùng', () => {
  // `const` ở cấp module rơi vào TDZ. Hiện tại isOnlineAt() chỉ được gọi lúc chạy thật
  // nên chưa lộ, nhưng một lần ai đó gọi ở cấp module là ném ReferenceError ngay.
  const workerSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'cloudflare-worker', 'src', 'index.js'), 'utf8');
  const decl = workerSrc.indexOf('const ONLINE_WINDOW_MS');
  const firstUse = workerSrc.indexOf('function isOnlineAt');
  assert.ok(decl > 0 && firstUse > 0);
  assert.ok(decl < firstUse,
    `ONLINE_WINDOW_MS phải khai báo trước dòng ${firstUse}, hiện ở dòng ${decl}`);
  assert.equal((workerSrc.match(/const ONLINE_WINDOW_MS/g) || []).length, 1,
    'chỉ được khai báo hằng này một lần');
});