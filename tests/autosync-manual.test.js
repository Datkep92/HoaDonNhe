'use strict';
// ---------------------------------------------------------------------------
// Auto Sync từ 1.0.2: CHỈ chạy khi người dùng bấm nút trên dòng MST.
//   - Không tự chạy lúc mở app, không tự chạy theo nhịp 30 phút.
//   - Bấm play ⇒ chạy cho ĐÚNG MST đó; bấm stop ⇒ ngưng.
//   - Mua vào + Bán ra có thể chạy SONG SONG (chỉ an toàn trong cùng một MST).
// Không gọi mạng: `runDirection` là hàm giả.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoSync } = require('../src/data/auto-sync');
const { readSyncState } = require('../src/data/mst-manager');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-manual-sync-'));
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('KHÔNG tự chạy theo nhịp: schedule() không tạo timer khi autoRun mặc định là false', () => {
  const dir = tempDir();
  try {
    const autoSync = createAutoSync({ syncFile: path.join(dir, 'sync.json'), runDirection: async () => ({}) });
    assert.equal(autoSync.schedule(), null, 'autoRun=false ⇒ không có timer tự chạy');
    autoSync.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server KHÔNG tự chạy Auto Sync lúc mở app; kiểm tra phiên TOÀN BỘ nhưng BỎ QUA nếu phải đăng nhập', () => {
  // Lỗi thiết kế cũ: sau 3 giây, app tự chạy Auto Sync cho MỌI MST ⇒ mở app là gọi cổng thuế.
  assert.ok(!serverSource.includes('autoStartBackground'), 'phải bỏ hẳn hàm tự chạy lúc mở app');
  assert.ok(!/autoSyncInstance\.schedule\(\)/.test(serverSource), 'không được bật lại bộ hẹn tự chạy');
  assert.ok(serverSource.includes('startupSessionCheck()'), 'khởi động phải dùng startupSessionCheck()');
  const check = serverSource.slice(serverSource.indexOf('async function startupSessionCheck()'));
  const body = check.slice(0, check.indexOf('\n}'));
  assert.ok(!body.includes('runAutoSyncFor'), 'kiểm tra phiên KHÔNG được chạy Auto Sync');
  // Kiểm tra TOÀN BỘ danh sách MST (để chấm màu từng dòng), sắp theo lần dùng gần nhất trước.
  assert.ok(body.includes('for (const item of queue)'), 'phải duyệt cả danh sách MST');
  assert.ok(body.includes('lastUsedAt'), 'sắp theo lần dùng gần nhất');
  // Nhưng MST không có phiên sẵn thì BỎ QUA: chỉ đọc token đã lưu, KHÔNG mở Chrome ẩn.
  assert.ok(body.includes('restoreSession(mst)'), 'chỉ khôi phục token đã lưu trên máy');
  assert.ok(!body.includes('browser.open'), 'không được mở Chrome cho từng MST lúc khởi động');
  assert.ok(!body.includes('refreshSessionOnStartup'), 'không dùng đường mở Chrome ẩn nữa');
  assert.ok(!serverSource.includes('refreshSessionOnStartup'), 'hàm mở Chrome ẩn lúc khởi động phải được bỏ hẳn');
});

test('có endpoint chạy theo MST và endpoint ngưng; MỖI MST LÀ MỘT LUỒNG RIÊNG', () => {
  assert.ok(serverSource.includes("url.pathname === '/api/db/autosync/run'"), 'thiếu endpoint chạy');
  assert.ok(serverSource.includes("url.pathname === '/api/db/autosync/stop'"), 'thiếu endpoint ngưng');
  const run = serverSource.slice(serverSource.indexOf("url.pathname === '/api/db/autosync/run'"));
  // '}\n' KHÔNG khớp khi file checkout ra CRLF (`}\r\n`) ⇒ dùng /\}\r?\n/ để đúng ở cả hai kiểu xuống dòng.
  const runEnd = run.search(/\}\r?\n/);
  const runBlock = runEnd > -1 ? run.slice(0, runEnd) : run.slice(0, 900);
  assert.ok(runBlock.includes('input.mst'), 'endpoint chạy phải nhận ĐÚNG MST được bấm');
  assert.ok(runBlock.includes('accountFor(mst)'), 'phải kiểm MST có trong danh sách');
  // Yêu cầu: MST này đang chạy KHÔNG được chặn MST khác — chỉ chặn chính nó chạy chồng.
  assert.ok(/instance && instance\.running/.test(runBlock), 'chỉ chặn khi CHÍNH MST đó đang chạy');
  assert.ok(!/autoSync\(\)\.running\) throw/.test(runBlock), 'không được chặn vì MST khác đang chạy');
  // Mỗi MST một bộ điều phối riêng, không dùng biến toàn cục dùng chung.
  assert.ok(serverSource.includes('const autoSyncByMst = new Map()'), 'phải có Map bộ điều phối theo MST');
  assert.ok(!/\bautoSyncTarget\b\s*=/.test(serverSource), 'không còn biến autoSyncTarget toàn cục');
  const stop = serverSource.slice(serverSource.indexOf("url.pathname === '/api/db/autosync/stop'"));
  const stopBlock = stop.slice(0, 900);
  assert.ok(stopBlock.includes('autoSyncEngines'), 'ngưng phải pause engine của lượt Auto Sync');
  assert.ok(stopBlock.includes('.pause()'), 'ngưng phải gọi pause()');
  // Song song có nhiều engine cùng lúc ⇒ phải là một TẬP và chỉ pause engine của đúng MST.
  assert.ok(serverSource.includes('const autoSyncEngines = new Set()'), 'phải dùng tập engine');
  assert.ok(stopBlock.includes('one.job.account.mst === target'), 'chỉ pause engine của ĐÚNG MST bị bấm ngưng');
});

test('job của hai hướng tách file để chạy song song không ghi chung một file tiến độ', () => {
  assert.ok(serverSource.includes('autosync-job-${direction === \'BUY\' ? \'buy\' : \'sell\'}.json'), 'job phải tách theo hướng');
  assert.ok(!serverSource.includes("path.join(dir, 'autosync-job.json')"), 'không còn dùng chung một file job');
  assert.ok(serverSource.includes('withScanLock'), 'bước quét SQLite phải xếp hàng khi chạy song song');
});

test('runAutoSyncDirection: engine khai báo NGOÀI try để finally dọn được (lỗi thật: syncEngine is not defined)', () => {
  // Lỗi thật đã gặp: `const syncEngine` nằm TRONG `try`, nhưng khối `finally` lại dùng nó ⇒
  // ReferenceError làm hỏng CẢ lượt Auto Sync, và lỗi đó bị ghi vào sync.json thành banner đỏ.
  const start = serverSource.indexOf('async function runAutoSyncDirection(');
  assert.ok(start > -1, 'không tìm thấy runAutoSyncDirection');
  const finallyAt = serverSource.indexOf('} finally {', start);
  const body = serverSource.slice(start, serverSource.indexOf('\n}', finallyAt) + 2);
  const declAt = body.indexOf('let syncEngine = null;');
  const tryAt = body.indexOf('try {');
  assert.ok(declAt > -1, 'phải khai báo `let syncEngine = null;`');
  assert.ok(tryAt > -1 && declAt < tryAt, 'khai báo phải nằm TRƯỚC `try {` để finally thấy được');
  assert.ok(!/const syncEngine = new Engine/.test(body), 'không được khai báo const trong try (finally sẽ không thấy)');
  assert.ok(body.includes('if (syncEngine) autoSyncEngines.delete(syncEngine)'), 'finally phải dọn engine có kiểm tra null');
});

test('song song: hai hướng chạy CÙNG LÚC và không ghi đè kết quả của nhau', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    let live = 0;
    let peak = 0;
    const seen = [];
    const autoSync = createAutoSync({
      syncFile,
      parallel: () => true,
      runDirection: async ({ direction }) => {
        live += 1; peak = Math.max(peak, live); seen.push(direction);
        await new Promise(resolve => setTimeout(resolve, 30));
        live -= 1;
        return { found: direction === 'BUY' ? 3 : 5, downloaded: 1, imported: 1 };
      },
    });
    const result = await autoSync.run('manual');
    assert.equal(result.parallel, true, 'phải chạy ở chế độ song song');
    assert.equal(peak, 2, 'hai hướng phải chạy cùng lúc (không tuần tự)');
    assert.deepEqual(seen.slice().sort(), ['BUY', 'SELL']);
    const state = readSyncState(syncFile);
    assert.equal(state.buy.found, 3, 'kết quả Mua vào không bị hướng kia ghi đè');
    assert.equal(state.sell.found, 5, 'kết quả Bán ra không bị hướng kia ghi đè');
    assert.equal(state.buy.status, 'idle');
    assert.equal(state.sell.status, 'idle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mặc định vẫn TUẦN TỰ khi parallel() trả false (giữ nhịp thưa cho cổng thuế)', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    let live = 0;
    let peak = 0;
    const order = [];
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async ({ direction }) => {
        live += 1; peak = Math.max(peak, live); order.push(direction);
        await new Promise(resolve => setTimeout(resolve, 10));
        live -= 1;
        return {};
      },
    });
    const result = await autoSync.run('manual');
    assert.equal(result.parallel, false);
    assert.equal(peak, 1, 'không được chạy chồng khi chưa được phép');
    assert.deepEqual(order, ['BUY', 'SELL'], 'đúng thứ tự Mua vào → Bán ra (mục 23/§66)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('song song: một hướng lỗi KHÔNG làm chết hướng còn lại', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const autoSync = createAutoSync({
      syncFile,
      parallel: () => true,
      runDirection: async ({ direction }) => {
        if (direction === 'BUY') throw new Error('cổng lỗi tạm thời');
        return { found: 2, downloaded: 2 };
      },
    });
    const result = await autoSync.run('manual');
    assert.equal(result.detail.buy.ok, false);
    assert.equal(result.detail.sell.ok, true, 'hướng Bán ra vẫn phải xong');
    const state = readSyncState(syncFile);
    assert.equal(state.buy.status, 'error');
    assert.equal(state.sell.status, 'idle');
    assert.equal(state.sell.found, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bấm Ngưng: trạng thái là "đã ngưng", KHÔNG ghi thành lỗi', async () => {
  const dir = tempDir();
  try {
    const syncFile = path.join(dir, 'sync.json');
    const autoSync = createAutoSync({
      syncFile,
      runDirection: async () => { throw Object.assign(new Error('Đã ngưng theo yêu cầu.'), { paused: true }); },
    });
    const result = await autoSync.run('manual');
    const state = readSyncState(syncFile);
    assert.equal(state.buy.status, 'idle', 'ngưng theo yêu cầu ⇒ idle, không phải error');
    assert.equal(state.buy.lastError, null, 'không được lưu thông báo ngưng như một lỗi');
    assert.equal(result.detail.buy.stopped, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('banner dòng MST: có đủ trạng thái đang chạy / xong / trống / lỗi', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = renderer.indexOf('function syncBanner(');
  assert.ok(start > -1, 'phải có hàm syncBanner');
  const body = renderer.slice(start, renderer.indexOf('\n}', start));
  for (const need of ['Đang tải', 'Đang tra cứu', 'Xong', 'Không có hóa đơn mới', 'Lỗi']) {
    assert.ok(body.includes(need), `banner phải có trạng thái "${need}"`);
  }
  // Trạng thái CUỐI phải kèm MỐC THỜI GIAN đã ghi trong sync.json. Mốc này được ghi lại mỗi lượt
  // Auto Sync nên nhìn banner là biết trạng thái đó CŨ hay MỚI — trước đây banner đỏ mãi cho một
  // lỗi đã hết từ lâu (lỗi thật: "database disk image is malformed" không ai xoá khỏi sync.json).
  assert.ok(renderer.includes('function bannerWhen('), 'phải có hàm bannerWhen để hiện mốc thời gian');
  assert.ok(body.includes('bannerWhen(sync.lastErrorTime)'), 'banner lỗi phải kèm thời gian của chính lỗi đó');
  assert.ok(body.includes('bannerWhen(sync.lastSuccess)'), 'banner xong phải kèm thời gian của lượt thành công cuối');
  const dataUi = fs.readFileSync(path.join(__dirname, '..', 'src', 'data-ui.js'), 'utf8');
  assert.ok(dataUi.includes('state.lastErrorTime ?'), 'dòng trạng thái Auto Sync phải kèm mốc thời gian khi lỗi');
  assert.ok(renderer.includes("className = `mst-banner ${banner.kind}`"), 'banner phải được gắn vào dòng MST');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
  for (const kind of ['running', 'done', 'empty', 'error']) assert.ok(css.includes(`.mst-banner.${kind}`), `thiếu style banner .${kind}`);
});

test('banner MST: lỗi đi kèm ĐÚNG mốc thời gian của chính nó, không ghép lệch hướng', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // Trước đây ghép rời: lastError của hướng này với lastErrorTime của hướng kia ⇒ khi cả hai
  // hướng cùng lỗi thì banner hiện sai giờ. Nay lấy cả cặp từ một hướng.
  assert.ok(server.includes('const errorSide = [state.buy, state.sell]'), 'phải chọn lỗi theo một hướng duy nhất');
  assert.ok(server.includes('lastErrorTime: errorSide ? errorSide.lastErrorTime'), 'lastErrorTime phải lấy từ chính hướng đang lỗi');
  assert.ok(server.includes("const lastSuccess = [state.buy.lastSuccess, state.sell.lastSuccess]"), 'lượt thành công cũng phải lấy mốc mới nhất trong hai hướng');
});

test('nút play/stop trên dòng MST điều khiển Auto Sync của đúng MST đó', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const start = renderer.indexOf('const syncing = !!account.sync?.running');
  assert.ok(start > -1, 'phải có biến phân biệt Auto Sync với lượt tải thủ công');
  // Cắt tới HẾT hàm renderAccounts (mốc cấu trúc) thay vì một số ký tự cố định — cửa sổ cố định
  // sẽ đỏ oan mỗi lần thêm chữ vào hàm, dù hành vi không đổi.
  const end = renderer.indexOf('let lastRenderedState = null;', start);
  const body = renderer.slice(start, end > start ? end : start + 4000);
  assert.ok(body.includes("work('/api/db/autosync/run', { mst: account.mst })"), 'bấm play phải chạy Auto Sync cho ĐÚNG MST đó');
  assert.ok(body.includes("work('/api/db/autosync/stop', {})"), 'bấm stop phải gọi endpoint ngưng');  assert.ok(body.includes("work('/api/pause', {})"), 'đang tải thủ công thì vẫn tạm dừng lượt tải');
  assert.ok(!body.includes("'/api/resume'"), 'không còn dùng nút này để chạy tiếp lượt tải cũ');
  assert.ok(body.includes('const syncing = !!account.sync?.running'), 'phải phân biệt Auto Sync với lượt tải thủ công');
});

test('kho cookie cổng thuế TÁCH THEO MST — nhiều MST chạy song song không lẫn phiên', () => {
  const tct = require('../src/tct-api');
  // Ghi cookie cho hai MST khác nhau rồi đọc lại: mỗi MST phải giữ cookie riêng.
  tct.setCookies('WAF_SESSION=aaa; CAPTCHA=1', '1111111111');
  tct.setCookies('WAF_SESSION=bbb; CAPTCHA=2', '2222222222');
  assert.match(tct.cookies('1111111111'), /WAF_SESSION=aaa/);
  assert.match(tct.cookies('2222222222'), /WAF_SESSION=bbb/);
  assert.ok(!/bbb/.test(tct.cookies('1111111111')), 'MST 1 không được thấy cookie của MST 2');
  // Ghi đè cookie của MST này KHÔNG được xoá cookie của MST kia (lỗi của bản dùng chung một kho).
  tct.setCookies('WAF_SESSION=ccc', '1111111111');
  assert.match(tct.cookies('2222222222'), /WAF_SESSION=bbb/, 'MST 2 phải giữ nguyên cookie');
  tct.clearCookies('1111111111');
  assert.equal(tct.cookies('1111111111'), '', 'xoá MST 1 ⇒ rỗng');
  assert.match(tct.cookies('2222222222'), /WAF_SESSION=bbb/, 'xoá MST 1 KHÔNG được đụng MST 2');
  // Kho mặc định (không gắn MST) vẫn hoạt động cho luồng lấy CAPTCHA chưa chọn MST.
  tct.setCookies('X=1');
  assert.match(tct.cookies(), /X=1/);
  tct.clearCookies();
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'tct-api.js'), 'utf8');
  assert.ok(source.includes('const jars = new Map()'), 'phải dùng Map kho cookie theo phạm vi');
});

test('server truyền MST làm phạm vi cookie cho mọi đường gọi cổng thuế', () => {
  for (const call of ['tct.request(token, route, action, mst)', 'tct.setCookies(stored.cookies, mst)', 'tct.cookies(mst)', 'tct.clearCookies(mst)']) {
    assert.ok(serverSource.includes(call), `thiếu phạm vi MST ở lời gọi: ${call}`);
  }
  assert.ok(!/tct\.request\(token, route, action\)/.test(serverSource), 'còn lời gọi tct.request thiếu phạm vi MST');
  assert.ok(!/tct\.cookies\(\)/.test(serverSource), 'còn lời gọi tct.cookies() thiếu phạm vi MST');
});

test('Auto Sync hiện lên tab Tra cứu & tải: cấu hình + danh sách hoá đơn đang tải', () => {
  assert.ok(serverSource.includes('function autoSyncPreview('), 'server phải có hàm lấy ảnh chụp lượt đang chạy');
  assert.ok(serverSource.includes('preview: value.running ? autoSyncPreview(mst) : null'), 'endpoint status phải trả preview khi đang chạy');
  const preview = serverSource.slice(serverSource.indexOf('function autoSyncPreview('));
  assert.ok(preview.slice(0, 900).includes('one.job.account.mst === mst'), 'chỉ lấy engine của ĐÚNG MST');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('async function paintSyncPreview()'), 'UI phải có hàm vẽ lượt Auto Sync');
  assert.ok(/api\/db\/autosync\/status\?mst=/.test(renderer), 'UI phải hỏi status theo MST');
  const paint = renderer.slice(renderer.indexOf('function paintSyncPreviewInto('));
  const body = paint.slice(0, 2600);
  assert.ok(body.includes("$('from').value = params.from"), 'phải điền Từ ngày của lượt sync vào form');
  assert.ok(body.includes("$('to').value = params.to"), 'phải điền Đến ngày');
  assert.ok(body.includes("$('direction').value = params.direction"), 'phải điền Mua vào/Bán ra');
  assert.ok(body.includes('Auto Sync đang tải hóa đơn'), 'tiêu đề bảng phải nói rõ đây là lượt Auto Sync');
  // Không giành bảng với người dùng đang thao tác thủ công.
  assert.ok(renderer.includes('if (!selected || current.busy || current.authBusy || pending) { clearSyncPreview(); return; }'), 'không được đè bảng khi lượt thủ công đang bận');
  // Bỏ nhớ cấu hình lượt tra cứu cũ khi mở app.
  assert.ok(!renderer.includes('for (const key of [\'from\', \'to\', \'direction\', \'family\', \'status\'])'), 'không được tự điền lại params của lượt cũ');
});
