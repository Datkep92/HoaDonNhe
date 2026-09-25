'use strict';
// ---------------------------------------------------------------------------
// CHẠY NỀN THEO KHUNG GIỜ — hai cổng: TRONG KHUNG GIỜ và CỬA SỔ APP ĐÃ ĐÓNG.
//
// Yêu cầu người dùng:
//   • chỉ chạy trong giờ làm việc (không cần sau 18h)
//   • chạy khi app đã thu xuống khay (cửa sổ đóng) — người dùng là ưu tiên số 1
//   • mỗi lúc MỘT MST, chạy lần lượt
//   • người dùng mở lại cửa sổ hoặc thao tác ⇒ nền ngưng NGAY và trả giao diện
// Không gọi mạng, không đọc file: mọi phụ thuộc đều được bơm vào.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_WINDOWS, parseTime, vnClock, normalizeWindows, activeWindow, windowKey, minutesUntilNext } = require('../src/data/sync-window');
const { createSyncScheduler, dailySyncState } = require('../src/data/sync-scheduler');

// Mốc thời gian theo GIỜ VN cho dễ đọc: vn('2026-09-25', 9, 0) = 09:00 giờ VN.
const vn = (day, hh, mm) => Date.parse(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`);
const flush = () => new Promise(resolve => setImmediate(resolve));

// ---------- sync-window: phần tính thời gian ----------

test('parseTime: chỉ nhận HH:MM hợp lệ, còn lại null (không đoán)', () => {
  assert.equal(parseTime('08:00'), 480);
  assert.equal(parseTime('18:00'), 1080);
  assert.equal(parseTime('0:05'), 5);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('08:60'), null);
  assert.equal(parseTime('8h'), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime(null), null);
});

test('vnClock: đọc đúng giờ VN bất kể máy đặt múi giờ nào', () => {
  // 01:00Z = 08:00 giờ VN cùng ngày.
  assert.deepEqual(vnClock(new Date('2026-09-25T01:00:00Z')), { day: '2026-09-25', minutes: 480 });
  // 17:00Z hôm trước = 00:00 giờ VN hôm sau — đúng ca dễ lệch một ngày nếu dùng toISOString().
  assert.deepEqual(vnClock(new Date('2026-09-24T17:00:00Z')), { day: '2026-09-25', minutes: 0 });
  assert.deepEqual(vnClock(new Date('2026-09-24T16:59:00Z')), { day: '2026-09-24', minutes: 1439 });
});

test('khung mặc định là 08:00–18:00 giờ làm việc, không có khung tối', () => {
  assert.equal(DEFAULT_WINDOWS.length, 1);
  assert.deepEqual(DEFAULT_WINDOWS[0].from, '08:00');
  assert.deepEqual(DEFAULT_WINDOWS[0].to, '18:00');
});

test('activeWindow: đúng ở hai đầu biên, và KHÔNG chạy sau 18h', () => {
  const windows = normalizeWindows(DEFAULT_WINDOWS);
  const at = (hh, mm) => activeWindow(windows, { day: '2026-09-25', minutes: hh * 60 + mm });
  assert.equal(at(7, 59), null, 'trước 08:00 thì chưa chạy');
  assert.ok(at(8, 0), 'đúng 08:00 là bắt đầu');
  assert.ok(at(12, 0), 'giữa giờ làm việc');
  assert.ok(at(17, 59), 'sát cuối khung vẫn chạy');
  assert.equal(at(18, 0), null, 'đúng 18:00 là dừng — "không cần sau 18h"');
  assert.equal(at(18, 30), null, 'buổi tối không chạy');
  assert.equal(at(2, 0), null, 'ban đêm không chạy');
});

test('khung hỗ trợ mở (to: null) và vắt qua nửa đêm (to < from)', () => {
  const open = normalizeWindows([{ id: 'mo', from: '08:00', to: null }]);
  assert.equal(activeWindow(open, { day: 'd', minutes: 7 * 60 }), null);
  assert.ok(activeWindow(open, { day: 'd', minutes: 23 * 60 }), 'khung mở chạy tới hết ngày');

  const wrap = normalizeWindows([{ id: 'dem', from: '22:00', to: '06:00' }]);
  assert.ok(activeWindow(wrap, { day: 'd', minutes: 23 * 60 }), '22:00–06:00: 23:00 đang trong khung');
  assert.ok(activeWindow(wrap, { day: 'd', minutes: 5 * 60 }), '22:00–06:00: 05:00 đang trong khung');
  assert.equal(activeWindow(wrap, { day: 'd', minutes: 12 * 60 }), null, '12:00 ngoài khung');
});

test('normalizeWindows: bỏ khung sai thay vì đoán, và kẹp days vào 1..365', () => {
  const list = normalizeWindows([
    { id: 'ok', from: '08:00', to: '18:00', days: 999 },
    { id: 'sai-gio', from: '25:00', to: '18:00' },
    { id: 'sai-to', from: '08:00', to: '99:99' },
    { id: 'bang-nhau', from: '08:00', to: '08:00' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'ok');
  assert.equal(list[0].days, 365);
  assert.equal(normalizeWindows([]).length, DEFAULT_WINDOWS.length, 'rỗng ⇒ dùng mặc định');
});

test('windowKey tách khung theo NGÀY; minutesUntilNext đếm tới khung kế', () => {
  const windows = normalizeWindows([{ id: 'a', from: '08:00', to: '12:00' }, { id: 'b', from: '13:00', to: '18:00' }]);
  assert.equal(windowKey(activeWindow(windows, { day: '2026-09-25', minutes: 540 }), { day: '2026-09-25', minutes: 540 }), '2026-09-25#a');
  assert.equal(minutesUntilNext(windows, { day: 'd', minutes: 480 }), 0, 'đang trong khung ⇒ 0');
  assert.equal(minutesUntilNext(windows, { day: 'd', minutes: 12 * 60 + 30 }), 30, '12:30 ⇒ còn 30 phút');
  assert.equal(minutesUntilNext(windows, { day: 'd', minutes: 20 * 60 }), 12 * 60, '20:00 ⇒ còn 12 tiếng');
});

// ---------- sync-scheduler: quyết định chạy hay nhường ----------

function harness({ at = vn('2026-09-25', 9, 0), due = () => [], uiClosed = () => true, manualBusy = () => false } = {}) {
  const started = [];
  const paused = [];
  const logs = [];
  let clock = at;
  let finish = null;
  const scheduler = createSyncScheduler({
    windows: DEFAULT_WINDOWS,
    now: () => clock,
    uiClosed,
    manualBusy,
    dueMsts: due,
    runOne: (mst, options) => { started.push({ mst, options }); return new Promise(resolve => { finish = resolve; }); },
    pauseOne: mst => paused.push(mst),
    log: message => logs.push(message),
  });
  return {
    scheduler, started, paused, logs,
    setClock: value => { clock = value; },
    finishRun: (result = {}) => { const done = finish; finish = null; if (done) done(result); },
  };
}

test('trong khung + cửa sổ đã đóng ⇒ chạy MST lâu chưa đồng bộ nhất, một mình', async () => {
  const h = harness({ due: () => [{ mst: 'B', lastSync: 500 }, { mst: 'A', lastSync: 100 }] });
  await h.scheduler.tick();
  assert.equal(h.started.length, 1, 'mỗi lúc chỉ MỘT MST');
  assert.equal(h.started[0].mst, 'A', 'MST lâu chưa sync nhất chạy trước');
  assert.equal(h.started[0].options.days, DEFAULT_WINDOWS[0].days, 'truyền số ngày của khung xuống lượt chạy');

  await h.scheduler.tick();
  assert.equal(h.started.length, 1, 'đang chạy thì không khởi động thêm MST khác');
});

test('cửa sổ app CÒN MỞ ⇒ không chạy nền (người dùng là ưu tiên số 1)', async () => {
  const h = harness({ due: () => [{ mst: 'A', lastSync: 0 }], uiClosed: () => false });
  await h.scheduler.tick();
  assert.equal(h.started.length, 0);
  const status = h.scheduler.status();
  assert.equal(status.running, false);
  assert.match(status.reason, /cửa sổ app đang mở/);
  assert.equal(status.inWindow, true, 'vẫn ĐANG trong khung giờ — chỉ là chưa được phép chạy');
});

test('ngoài khung giờ ⇒ không chạy nền', async () => {
  const h = harness({ at: vn('2026-09-25', 18, 30), due: () => [{ mst: 'A', lastSync: 0 }] });
  await h.scheduler.tick();
  assert.equal(h.started.length, 0, 'sau 18h không chạy (yêu cầu người dùng)');
  assert.equal(h.scheduler.status().inWindow, false);
  assert.match(h.scheduler.status().reason, /ngoài khung giờ/);
});

test('đang chạy mà người dùng MỞ LẠI cửa sổ ⇒ ngưng ngay và trả giao diện', async () => {
  let open = false;
  const h = harness({ due: () => [{ mst: 'A', lastSync: 0 }], uiClosed: () => !open });
  await h.scheduler.tick();
  assert.equal(h.started.length, 1, 'đã bắt đầu chạy nền');

  open = true;                       // người dùng mở cửa sổ
  await h.scheduler.tick();          // nhịp kế tiếp phát hiện
  assert.deepEqual(h.paused, ['A'], 'phải pause ĐÚNG MST đang chạy');
  assert.equal(h.scheduler.status().phase, 'yielding');

  h.finishRun();                     // engine thoát ra theo cờ paused
  await flush();
  assert.equal(h.scheduler.status().phase, 'yielded', 'kết quả phải là "đã nhường", KHÔNG phải "xong"');
  assert.equal(h.scheduler.running, false);
});

test('đang chạy mà hết khung giờ ⇒ ngưng, lượt sau chạy tiếp', async () => {
  const h = harness({ at: vn('2026-09-25', 17, 55), due: () => [{ mst: 'A', lastSync: 0 }] });
  await h.scheduler.tick();
  assert.equal(h.started.length, 1);

  h.setClock(vn('2026-09-25', 18, 0));  // hết khung
  await h.scheduler.tick();
  assert.deepEqual(h.paused, ['A']);
  h.finishRun();
  await flush();

  // Hôm sau, trong khung, MST đó lại được chạy (job file giữ cursor nên tiếp đúng chỗ).
  h.setClock(vn('2026-09-26', 8, 30));
  const h2 = h;
  await h2.scheduler.tick();
  assert.equal(h2.started.length, 2, 'khung sau chạy tiếp');
});

test('có việc thủ công đang chạy ⇒ nhường, không chen vào', async () => {
  const h = harness({ due: () => [{ mst: 'A', lastSync: 0 }], manualBusy: () => true });
  await h.scheduler.tick();
  assert.equal(h.started.length, 0);
  assert.match(h.scheduler.status().reason, /việc thủ công/);
});

test('không MST nào tới hạn ⇒ nghỉ, không gọi gì', async () => {
  const h = harness({ due: () => [] });
  await h.scheduler.tick();
  assert.equal(h.started.length, 0);
  assert.equal(h.scheduler.status().phase, 'idle');
  assert.match(h.scheduler.status().reason, /không MST nào tới hạn/);
});

test('status đủ dữ liệu cho UI: khung giờ, đang trong khung hay không, còn bao lâu', () => {
  const h = harness({ at: vn('2026-09-25', 7, 0) });
  const status = h.scheduler.status();
  assert.equal(status.inWindow, false);
  assert.equal(status.nextInMinutes, 60, '07:00 ⇒ còn 60 phút tới 08:00');
  assert.deepEqual(status.windows.map(w => `${w.from}-${w.to}`), ['08:00-18:00']);
});

test('stop() ngưng MST đang chạy và không nhận nhịp mới', async () => {
  const h = harness({ due: () => [{ mst: 'A', lastSync: 0 }] });
  await h.scheduler.tick();
  h.scheduler.stop();
  assert.deepEqual(h.paused, ['A']);
  const before = h.started.length;
  await h.scheduler.tick();
  assert.equal(h.started.length, before, 'sau stop() không khởi động thêm');
});

// ---------- ĐÃ ĐỒNG BỘ / CHƯA ĐỒNG BỘ: một ngày một lần ----------

test('dailySyncState: đã đồng bộ = CẢ HAI hướng chạy XONG trong ngày VN hiện tại', () => {
  const clock = { day: '2026-09-25', minutes: 540 };
  assert.deepEqual(
    dailySyncState({ buy: { lastSuccess: '2026-09-25T02:00:00Z' }, sell: { lastSuccess: '2026-09-25T03:00:00Z' } }, clock),
    { synced: true, missing: [], at: '2026-09-25T03:00:00Z' },
    'xong cả hai ⇒ đã đồng bộ, mốc là lần muộn nhất');

  const partial = dailySyncState({ buy: { lastSuccess: '2026-09-25T02:00:00Z' }, sell: { lastSuccess: '2026-09-24T03:00:00Z' } }, clock);
  assert.equal(partial.synced, false, 'một hướng còn của hôm qua ⇒ CHƯA đồng bộ');
  assert.deepEqual(partial.missing, ['bán ra']);

  assert.deepEqual(dailySyncState(null, clock).missing, ['mua vào', 'bán ra'], 'chưa chạy lần nào ⇒ thiếu cả hai');
  assert.deepEqual(dailySyncState({}, clock).missing, ['mua vào', 'bán ra']);
});

test('dailySyncState: lượt bị NGƯNG không được tính là đã đồng bộ', () => {
  const clock = { day: '2026-09-25', minutes: 540 };
  // Lượt bị ngưng chỉ ghi `lastSync`, KHÔNG ghi `lastSuccess` — nên vẫn phải chạy tiếp.
  const state = { buy: { lastSync: '2026-09-25T02:00:00Z', lastSuccess: '2026-09-24T02:00:00Z' }, sell: { lastSync: '2026-09-25T02:00:00Z', lastSuccess: '' } };
  const daily = dailySyncState(state, clock);
  assert.equal(daily.synced, false);
  assert.deepEqual(daily.missing, ['mua vào', 'bán ra']);
});

test('dailySyncState: mốc 17:00Z hôm trước là 00:00 giờ VN HÔM NAY (không lệch ngày)', () => {
  const clock = { day: '2026-09-25', minutes: 0 };
  const state = { buy: { lastSuccess: '2026-09-24T17:00:00Z' }, sell: { lastSuccess: '2026-09-24T17:00:00Z' } };
  assert.equal(dailySyncState(state, clock).synced, true);
  // Còn 16:59Z hôm trước là 23:59 hôm qua ⇒ chưa đồng bộ.
  const earlier = { day: '2026-09-25', minutes: 0 };
  assert.equal(dailySyncState({ buy: { lastSuccess: '2026-09-24T16:59:00Z' }, sell: { lastSuccess: '2026-09-24T16:59:00Z' } }, earlier).synced, false);
});

test('bộ lọc MST tới hạn dùng luật MỘT NGÀY MỘT LẦN, và UI có hiện trạng thái đồng bộ', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('if (dailySyncState(state, clock).synced) continue;'), 'phải BỎ QUA MST đã đồng bộ đủ hôm nay');
  assert.ok(server.includes('if (lastAttempt && nowMs - lastAttempt < intervalMs) continue;'), 'vừa thử mà chưa xong thì phải chờ — chống vòng lặp khi lỗi');
  assert.ok(server.includes('syncedToday: daily.synced'), 'phải gửi trạng thái đồng bộ ra giao diện');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('đã đồng bộ hôm nay'), 'dòng MST phải hiện "đã đồng bộ hôm nay"');
  assert.ok(renderer.includes('chưa đồng bộ hôm nay'), 'dòng MST phải hiện "chưa đồng bộ hôm nay"');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'style.css'), 'utf8');
  assert.ok(css.includes('.mst-banner.pending'), 'banner "chưa đồng bộ" phải có kiểu riêng');
});
