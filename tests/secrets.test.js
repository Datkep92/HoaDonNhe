const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HOADON_SECRET_MODE = 'aes'; // DPAPI needs to spawn PowerShell; tests exercise the AES path
const secrets = require('../src/secrets');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-secrets-'));
secrets.init(dir);
const MST = '4500677693';
const file = () => path.join(dir, 'secrets', `${MST}.json`);

test('remembered password and session are stored encrypted and read back', () => {
  secrets.write(MST, { password: 'mat-khau-that', token: 'jwt.token.value', cookies: 'TS0=abc; jwt=xyz' });
  const raw = fs.readFileSync(file(), 'utf8');
  assert(!raw.includes('mat-khau-that')); assert(!raw.includes('jwt.token.value')); assert(!raw.includes('TS0=abc'));
  const value = secrets.read(MST);
  assert.equal(value.password, 'mat-khau-that'); assert.equal(value.token, 'jwt.token.value'); assert.equal(value.cookies, 'TS0=abc; jwt=xyz');
});
test('only the requested keys are decrypted', () => {
  const value = secrets.read(MST, ['password']);
  assert.equal(value.password, 'mat-khau-that'); assert.equal(value.cookies, ''); assert.equal(value.token, '');
});
test('dropping the password keeps the session, dropping everything removes the file', () => {
  secrets.clear(MST, ['password']);
  assert.equal(secrets.read(MST).password, '');
  assert.equal(secrets.read(MST).token, 'jwt.token.value');
  secrets.clear(MST);
  assert(!fs.existsSync(file()));
  assert.equal(secrets.read(MST).password, '');
});
test('tampered or foreign data is refused instead of returning garbage', () => {
  const blob = secrets.protect('bi-mat');
  assert.equal(secrets.unprotect(blob), 'bi-mat');
  const parts = blob.split(':');
  parts[parts.length - 1] = Buffer.from('noi dung khac').toString('base64');
  assert.throws(() => secrets.unprotect(parts.join(':')));
  assert.throws(() => secrets.unprotect('plain-text'));
  assert.equal(secrets.unprotect(''), '');
});

// ---------------------------------------------------------------------------
// KHOÁ NHỚ GIẢI MÃ — thêm vì sao kiểm tra phiên lúc khởi động chậm ~7 giây.
// Nhánh DPAPI spawn powershell.exe bằng execFileSync (~500 ms/lần) cho MỖI
// secret; 7 MST × 2 key là ~7 giây CHẶN cứng event loop của cả server, nên giao
// diện phải đứng hình chờ "Đang kiểm tra phiên đăng nhập".
// Rủi ro của khoá nhớ: lấy nhầm kết quả của MST khác ⇒ RÒ PHIÊN NGƯỜI KHÁC.
// ---------------------------------------------------------------------------
test('cùng một blob giải ra cùng kết quả, và khoá nhớ không trộn dữ liệu giữa các MST', () => {
  const a = '4500677693', b = '4500101451';
  secrets.write(a, { token: 'token-cua-A', cookies: 'cookie-cua-A' });
  secrets.write(b, { token: 'token-cua-B', cookies: 'cookie-cua-B' });
  // Đọc xen kẽ nhiều lần: nếu khoá nhớ gắn nhầm theo MST thì lần thứ hai sẽ trả
  // token của máy kia — đúng loại lỗi rò dữ liệu khách hàng mà test này chặn.
  for (let i = 0; i < 3; i++) {
    const ra = secrets.read(a, ['token', 'cookies']);
    const rb = secrets.read(b, ['token', 'cookies']);
    assert.equal(ra.token, 'token-cua-A', `lan ${i}: MST A phải ra token của A`);
    assert.equal(ra.cookies, 'cookie-cua-A', `lan ${i}: MST A phải ra cookie của A`);
    assert.equal(rb.token, 'token-cua-B', `lan ${i}: MST B phải ra token của B`);
    assert.equal(rb.cookies, 'cookie-cua-B', `lan ${i}: MST B phải ra cookie của B`);
  }
});

test('đăng nhập lại ghi blob mới nên không dùng nhầm kết quả cũ đã ghi nhớ', () => {
  const mst = '4500679228';
  secrets.write(mst, { token: 'token-cu' });
  assert.equal(secrets.read(mst, ['token']).token, 'token-cu');
  secrets.write(mst, { token: 'token-moi' });
  // Salt ngẫu nhiên mỗi lần ghi ⇒ blob khác ⇒ khoá nhớ cũ không được tra lại.
  assert.equal(secrets.read(mst, ['token']).token, 'token-moi');
});

test('xoá phiên xong đọc lại được là rỗng, không trả tên khoá cũ', () => {
  const mst = '4500487170';
  secrets.write(mst, { token: 'token-can-xoa' });
  assert.equal(secrets.read(mst, ['token']).token, 'token-can-xoa');
  secrets.clear(mst);
  assert.equal(secrets.read(mst, ['token']).token, '');
});

// ---------------------------------------------------------------------------
// GHI BẤT ĐỒNG BỘ — đường đăng nhập nền chạy N MST SONG SONG.
//
// `write()` mã hoá bằng `protect()`, mà DPAPI spawn powershell.exe bằng execFileSync
// (~500 ms/lần, CHẶN event loop của cả server). Ghi đồng bộ khi 10 MST đăng nhập cùng lúc
// ⇒ chặn ~500 ms × 10 lần, trong khi giao diện poll `/api/state` mỗi 800 ms nên người dùng
// thấy app đứng hình đúng lúc đang chờ.
//
// `writeAsync()` không phải "ghi sau" (đó là mất dữ liệu khi app tắt) mà là GOM vào hàng đợi
// rồi xử lý khi event loop rảnh — dữ liệu vẫn được ghi đầy đủ, và `flushWrites()` khi thoát.
// ---------------------------------------------------------------------------
test('writeAsync KHÔNG ghi ngay (không chặn event loop) nhưng flushWrites() ghi đủ', () => {
  const mst = '4500999001';
  secrets.writeAsync(mst, { token: 'token-cho', cookies: 'cookie-cho' });
  // Chưa flush ⇒ trên đĩa chưa có gì. Nếu hàm ghi ngay thì dòng này sẽ đúng và test hỏng —
  // đúng thứ ta muốn chặn.
  assert.equal(fs.existsSync(path.join(dir, 'secrets', `${mst}.json`)), false,
    'writeAsync phải hoãn ghi, không ghi đồng bộ ngay');
  secrets.flushWrites();
  assert.equal(secrets.read(mst, ['token']).token, 'token-cho');
  assert.equal(secrets.read(mst, ['cookies']).cookies, 'cookie-cho');
});

test('nhiều MST ghi bất đồng bộ rồi flush MỘT LẦN — không mất MST nào', () => {
  const list = ['4500999002', '4500999003', '4500999004', '4500999005'];
  for (const [i, mst] of list.entries()) secrets.writeAsync(mst, { token: `token-${i}` });
  secrets.flushWrites();
  list.forEach((mst, i) => {
    assert.equal(secrets.read(mst, ['token']).token, `token-${i}`, `MST ${mst} mất dữ liệu khi ghi song song`);
  });
});

test('ghi nhiều lần cho CÙNG MST trước khi flush thì phải gộp lại, không mất khoá nào', () => {
  const mst = '4500999006';
  secrets.writeAsync(mst, { token: 'token-1' });
  secrets.writeAsync(mst, { password: 'mat-khau-1' });
  secrets.writeAsync(mst, { token: 'token-2' });
  secrets.flushWrites();
  const value = secrets.read(mst, ['token', 'password']);
  assert.equal(value.token, 'token-2', 'lần ghi sau thắng cho cùng một khoá');
  assert.equal(value.password, 'mat-khau-1', 'khoá ghi ở giữa không được mất');
});

test('flushWrites() khi không có gì chờ thì không nổ', () => {
  secrets.flushWrites();
  secrets.flushWrites();
});

test('blob bị sửa tay sau khi đã đọc vẫn phải bị từ chối', () => {
  const blob = secrets.protect('gia-tri-that');
  assert.equal(secrets.unprotect(blob), 'gia-tri-that');
  const parts = blob.split(':');
  parts[parts.length - 1] = Buffer.from('noi dung sua').toString('base64');
  assert.throws(() => secrets.unprotect(parts.join(':')), 'blob khác phải là khoá khác');
});

test('REGRESSION: blob định dạng lạ phải ném lỗi, không âm thầm thành "chưa đăng nhập"', () => {
  // Nếu trả '' thì người dùng bị đẩy vào đăng nhập lại với một file chỉ bị hỏng
  // hình thức — lỗi im lặng, khó chịu nhất. Đường batch từng hỏng đúng chỗ này.
  assert.throws(() => secrets.unprotect('khong-phai-dinh-dang'), /định dạng/);
  assert.throws(() => secrets.unprotectBatch(['khong-phai-dinh-dang']), /định dạng/);
});

// ---- readMany: đọc nhiều MST trong một lượt ----------------------------------

test('readMany trả đúng phiên của từng MST, không lẫn và không bỏ sót', () => {
  const list = ['4500101451', '4500677693', '4500679228', '4500487170'];
  list.forEach((mst, i) => secrets.write(mst, { token: `token-${i}`, cookies: `cookie-${i}` }));
  const all = secrets.readMany(list, ['token', 'cookies']);
  assert.equal(all.size, list.length);
  list.forEach((mst, i) => {
    const got = all.get(mst);
    assert.equal(got.token, `token-${i}`, `${mst} phải ra token của nó`);
    assert.equal(got.cookies, `cookie-${i}`, `${mst} phải ra cookie của nó`);
  });
});

test('readMany cho MST chưa có file trong khi chọn đúng phần của MST đã có', () => {
  secrets.write('4500101451', { token: 'token-co' });
  const all = secrets.readMany(['4500101451', '4500679999'], ['token', 'cookies']);
  assert.equal(all.get('4500101451').token, 'token-co');
  assert.equal(all.get('4500679999').token, '', 'MST chưa lưu gì thì phải rỗng, không phải lấy của MST khác');
});

test('readMany bỏ qua MST trùng tên thay vì giải mã hai lần', () => {
  secrets.write('4500101451', { token: 'token-dung' });
  const all = secrets.readMany(['4500101451', '4500101451'], ['token']);
  assert.equal(all.size, 1);
  assert.equal(all.get('4500101451').token, 'token-dung');
});

// ---- unprotectBatch: thứ tự kết quả phải khớp thứ tự đầu vào ----------------
//
// Đây là chỗ nguy hiểm nhất của batch. Nếu một blob hỏng bị BỎ QUA thay vì giữ
// chỗ trống, các kết quả phía sau dồn lên và MST này nhận token của MST khác —
// rò phiên của khách hàng. Các test dưới đây dùng khoá nhớ để không cần PowerShell.
test('REGRESSION: định dạng lạ giữa lô phải ném lỗi thay vì trả rỗng', () => {
  const good1 = secrets.protect('token-cua-MST-1');
  assert.throws(() => secrets.unprotectBatch(['rac-khong-ai-biet-1', good1]), /định dạng/);
});

test('REGRESSION: unprotectBatch phải giữ đúng vị trí, không dồn kết quả', () => {
  const a = secrets.protect('A'); const b = secrets.protect('B'); const c = secrets.protect('C');
  const out = secrets.unprotectBatch([a, b, c]);
  assert.deepEqual(out, ['A', 'B', 'C']);
  // Cùng bộ này nhưng xen kẽ rỗng: vị trí rỗng phải ở đúng chỗ, không dồn.
  const mixed = secrets.unprotectBatch([a, '', b, '', c]);
  assert.deepEqual(mixed, ['A', '', 'B', '', 'C'], 'chỗ trống phải đứng đúng chỗ, không dồn lên đầu');
});

test('REGRESSION: blob AES hỏng không được làm mất phiên của các MST khác trong lô', () => {
  const a = secrets.protect('token-A'); const b = secrets.protect('token-B');
  const out = secrets.unprotectBatch(['aes1:hong:hong:hong:hong', a, 'aes1:x:y:z:w', b]);
  assert.equal(out.length, 4);
  assert.equal(out[0], '', 'blob AES hỏng chỉ mất chính nó');
  assert.equal(out[1], 'token-A', 'MST sau blob hỏng phải còn nguyên phiên');
  assert.equal(out[2], '');
  assert.equal(out[3], 'token-B');
});

test('readMany giống hệt read() từng MST — hai đường không được lệch nhau', () => {
  const list = ['4500101451', '4500677693'];
  secrets.write(list[0], { token: 'tk-0', cookies: 'ck-0', password: 'mk-0' });
  secrets.write(list[1], { password: 'mk-1' });
  const many = secrets.readMany(list, ['token', 'cookies', 'password']);
  for (const mst of list) {
    const one = secrets.read(mst, ['token', 'cookies', 'password']);
    const batch = many.get(mst);
    for (const key of ['token', 'cookies', 'password']) {
      assert.equal(batch[key], one[key], `${mst}.${key} lệch giữa readMany và read`);
    }
  }
});
