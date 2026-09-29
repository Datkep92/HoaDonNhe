'use strict';
// ---------------------------------------------------------------------------
// TÔ SÁNG MST PHIÊN GẦN NHẤT NGAY KHUNG HÌNH ĐẦU (cache localStorage).
//
// Lỗi cảm nhận: mở app, sidebar TRỐNG 1–3 giây vì chưa có `/api/state`; không biết app đang
// làm gì, cũng không biết sắp vào khách hàng nào.
//
// Cách chữa: trước nhịp `/api/state` đầu tiên, dựng danh sách MST từ một cache NHẸ trong
// localStorage (mã + tên + trạng thái phiên) và tô sáng `selected` đã lưu; dữ liệu thật về thì
// ghi đè. Test này khoá cả BA mặt:
//   1. cache là hàm thật, chạy được (khứ hồi, cắt trần, cache hỏng, không ghi lặp);
//   2. cache KHÔNG chứa gì nhạy cảm (mật khẩu, cookie, profile) — chỉ trường để vẽ dòng;
//   3. thứ tự khởi động: nạp cache TRƯỚC `render(current)`/`refresh()`.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');

// Cắt đúng khối cache (từ hằng khoá tới hết writeMstCache) rồi chạy trong Node với một
// localStorage giả — không cần DOM, nên test được HÀNH VI chứ không chỉ so chuỗi nguồn.
function loadCacheHelpers() {
  const start = renderer.indexOf('const MST_CACHE_KEY');
  const end = renderer.indexOf('// Ngày lập của cổng thuế');
  assert.ok(start > -1 && end > start, 'không tìm thấy khối cache MST trong renderer.js');
  const body = renderer.slice(start, end);
  const store = new Map();
  let writes = 0;
  const fakeLocalStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { writes += 1; store.set(key, String(value)); },
  };
  const factory = new Function('localStorage', `${body}\nreturn { readMstCache, writeMstCache };`);
  return { ...factory(fakeLocalStorage), store, writeCount: () => writes };
}

const account = (overrides = {}) => ({
  mst: '2222222222', name: 'Hộ kinh doanh A', session: 'active', identifiers: ['2222222222-001'],
  remembered: true, ...overrides,
});

test('cache MST: khứ hồi giữ đúng danh sách và MST đang chọn', () => {
  const cache = loadCacheHelpers();
  assert.equal(cache.readMstCache(), null, 'chưa có cache thì phải trả null, không dựng danh sách rỗng');
  cache.writeMstCache({ selected: '2222222222', accounts: [account(), account({ mst: '1111111111', name: '' })] });
  const cached = cache.readMstCache();
  assert.equal(cached.selected, '2222222222', 'phải nhớ MST phiên gần nhất để tô sáng ngay');
  assert.equal(cached.accounts.length, 2);
  assert.equal(cached.accounts[0].name, 'Hộ kinh doanh A');
  assert.deepEqual(cached.accounts[1].identifiers, ['2222222222-001']);
});

test('cache MST: KHÔNG sao chép mật khẩu / cookie / profile', () => {
  const cache = loadCacheHelpers();
  cache.writeMstCache({
    selected: '2222222222',
    accounts: [account({ password: 'mat-khau-that', cookie: 'session=abc', profileDir: 'C:\\du_lieu\\chrome\\2222' })],
  });
  const raw = cache.store.get('hd.mst-cache.v1');
  for (const secret of ['mat-khau-that', 'session=abc', 'profileDir', 'password', 'cookie']) {
    assert.ok(!raw.includes(secret), `cache MST không được chứa ${secret}`);
  }
  const keys = Object.keys(JSON.parse(raw).accounts[0]).sort();
  assert.deepEqual(keys, ['identifiers', 'mst', 'name', 'remembered', 'session'], 'chỉ giữ trường để VẼ dòng MST');
});

test('cache MST: cắt trần và coi cache hỏng/rỗng như không có', () => {
  const cache = loadCacheHelpers();
  const many = Array.from({ length: 90 }, (_, i) => account({ mst: String(1000000000 + i) }));
  cache.writeMstCache({ selected: '1000000000', accounts: many });
  assert.equal(cache.readMstCache().accounts.length, 60, 'cache chỉ để vẽ nhanh — không cần vượt trần');

  cache.store.set('hd.mst-cache.v1', '{ không phải JSON');
  assert.equal(cache.readMstCache(), null, 'cache hỏng phải bị bỏ qua, không làm sập khởi động');

  cache.writeMstCache({ selected: '', accounts: [] });
  assert.equal(cache.readMstCache(), null, 'danh sách rỗng ⇒ không có gì để dựng sẵn');
});

test('cache MST: vòng poll không ghi localStorage lặp lại vô ích', () => {
  const cache = loadCacheHelpers();
  const state = { selected: '2222222222', accounts: [account()] };
  cache.writeMstCache(state);
  cache.writeMstCache(state);
  assert.equal(cache.writeCount(), 1, 'state y hệt thì không ghi lại (poll 1,5 giây)');
  cache.writeMstCache({ selected: '1111111111', accounts: [account()] });
  assert.equal(cache.writeCount(), 2, 'đổi MST đang chọn thì phải ghi lại');
});

test('khởi động: nạp cache TRƯỚC lần render/refresh đầu tiên', () => {
  // Nguồn cache cho khung hình đầu do `firstPaintMstList()` chọn (ảnh chụp của máy chủ trước,
  // localStorage sau) — xem tests/boot-cache.test.js cho phần ưu tiên nguồn.
  const hydrate = renderer.indexOf('const cachedMstList = firstPaintMstList();');
  const firstRender = renderer.indexOf('render(current);\nrefresh();');
  assert.ok(hydrate > -1, 'renderer.js phải nạp cache MST lúc khởi động');
  assert.ok(firstRender > hydrate, 'cache phải được nạp TRƯỚC nhịp /api/state đầu tiên');
  assert.ok(renderer.includes("if (cachedMstList) current = { ...current, accounts: cachedMstList.accounts, selected: cachedMstList.selected || '' };"),
    'cache phải đổ vào `current` để sidebar có dòng và tô sáng sẵn MST đang chọn');
  assert.ok(!/cachedMstList[\s\S]{0,120}initialLoading = false/.test(renderer),
    'cache KHÔNG được coi là dữ liệu thật (vẫn phải hiện trạng thái đang kiểm tra phiên)');
});

test('/api/state về thì ghi lại cache từ dữ liệu THẬT (kể cả khi danh sách rỗng)', () => {
  const refresh = renderer.slice(renderer.indexOf('async function refresh()'), renderer.indexOf('async function refresh()') + 900);
  assert.ok(refresh.includes('const state = await call(\'/api/state\');'), 'refresh() phải giữ lại state vừa nhận');
  assert.ok(refresh.indexOf('writeMstCache(state);') < refresh.indexOf('render(state);'),
    'ghi cache ngay khi có dữ liệu thật, trước khi vẽ');
});
