'use strict';
// ---------------------------------------------------------------------------
// TỰ KHỞI ĐỘNG CÙNG WINDOWS — src/autostart.js
//
// Vì sao có file test này: ghi khoá Run là thao tác KHÓ HOÀN LẠI được. Một lần
// ghi sai (đường dẫn hỏng, sai tên giá trị) là mỗi lần bật máy Windows lại thử
// chạy một file không tồn tại — và điều đó không có dấu hiệu gì để ta phát hiện
// ngoài việc người dùng báo lại.
//
// QUY TẮC BẮT BUỘC: test KHÔNG được đụng registry thật của máy đang chạy test.
// Mọi lời gọi reg.exe đi qua runner giả lưu trong bộ nhớ.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const autostart = require('../src/autostart.js');

// Registry giả: bộ nhớ trong tiến trình test, không đụng HKCU thật.
function fakeRegistry(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const runner = async args => {
    const verb = args[0];
    calls.push(args);
    if (verb === 'query') {
      if (!store.has(autostart.VALUE_NAME)) return { ok: false, code: 1, stdout: '', stderr: '' };
      // Đúng định dạng `reg query`: 4 khoảng trắng rồi tới tên giá trị.
      return { ok: true, code: 0, stdout: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n'
        + '    ' + autostart.VALUE_NAME + '    REG_SZ    ' + store.get(autostart.VALUE_NAME) + '\r\n\r\n', stderr: '' };
    }
    if (verb === 'add') {
      store.set(autostart.VALUE_NAME, args[args.indexOf('/d') + 1]);
      return { ok: true, code: 0, stdout: 'The operation completed successfully.', stderr: '' };
    }
    if (verb === 'delete') {
      if (!store.has(autostart.VALUE_NAME)) return { ok: false, code: 1, stdout: '', stderr: '' };
      store.delete(autostart.VALUE_NAME);
      return { ok: true, code: 0, stdout: '', stderr: '' };
    }
    throw new Error('reg.exe lạ: ' + verb);
  };
  return { store, calls, runner, get: name => store.get(name) };
}

// Phải chờ cả hàm bất đồng bộ trước khi xoá thư mục. Bản đầu chỉ gọi fn(dir) rồi
// xoá ngay trong finally — mọi test dùng await bên trong lập tức hỏng vì thư mục
// đã biến mất, và lỗi hiện ra thành "readChoice trả null" rất khó đoán nguyên nhân.
const withDir = async fn => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autostart-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

// ---- phân tích output của reg.exe -------------------------------------------

test('parseRunValue đọc đúng giá trị có dấu nháy và khoảng trắng', () => {
  const stdout = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n'
    + '    CN Tax Tools    REG_SZ    "C:\\Program Files\\CN Tax Tools\\CN-Tax-Tools.exe" --start-hidden\r\n\r\n';
  assert.equal(autostart.parseRunValue(stdout, 'CN Tax Tools'), '"C:\\Program Files\\CN Tax Tools\\CN-Tax-Tools.exe" --start-hidden');
});

test('parseRunValue không nhầm giá trị khác có chứa tên của app', () => {
  const stdout = '\r\n    CN Tax Tools Old    REG_SZ    "D:\\x.exe"\r\n    Khac    REG_SZ    "E:\\y.exe"\r\n';
  assert.equal(autostart.parseRunValue(stdout, 'CN Tax Tools'), '');
});

test('parseRunValue trả rỗng khi giá trị không tồn tại', () => {
  assert.equal(autostart.parseRunValue('', 'CN Tax Tools'), '');
});

// ---- lệnh khởi động ----------------------------------------------------------

test('REGRESSION: lệnh khởi động luôn kèm --start-hidden', () => {
  // Không có cờ này thì Windows mở app lên kèm một cửa sổ Chrome — đúng thứ
  // người dùng đã nói là không muốn.
  assert.match(autostart.launchCommand(), /--start-hidden$/);
});

test('lệnh khởi động trích dẫn đường dẫn có khoảng trắng', () => {
  // Đường dẫn kiểu C:\Program Files\... không có nháy thì reg add cắt đôi chuỗi
  // và Windows chạy file sai. Cờ -WindowStyle/-STA của tray từng dính lỗi này.
  const command = autostart.launchCommand();
  const quoted = command.match(/"[^"]+"/g) || [];
  assert.ok(quoted.length >= 1, 'phải có ít nhất một phần đặt trong nháy kép');
  assert.equal(command.replace(/"[^"]+"/g, '').trim(), '--start-hidden');
});

// ---- lựa chọn của người dùng ------------------------------------------------

test('chưa chọn gì thì coi như BẬT (mặc định của bản cài mới)', () => {
  withDir(dir => assert.equal(autostart.readChoice(dir), null));
});

test('lựa chọn TẮT được nhớ, không bị mất khi khởi động lại', () => {
  withDir(dir => {
    autostart.writeChoice(dir, false);
    assert.equal(autostart.readChoice(dir), false);
  });
});

test('REGRESSION: file cài đặt hỏng KHÔNG được hiểu là "tắt" rồi tự bật lại', () => {
  // Giá trị hỏng (chuỗi "false", số 0, rỗng) phải đọc thành null = chưa chọn, để
  // áp dụng mặc định BẬT một lần rồi ghi lại cho sạch. Đọc thành false thì người
  // dùng bật lại sẽ thấy nó tự tắt mình ở lần khởi động kế tiếp.
  withDir(dir => {
    for (const junk of ['{"autostart":"false"}', '{"autostart":0}', '{"autostart":null}', 'not json at all']) {
      fs.writeFileSync(autostart.settingsFile(dir), junk, 'utf8');
      assert.equal(autostart.readChoice(dir), null, `phải bỏ qua "${junk}"`);
    }
  });
});

test('ghi lựa chọn không làm mất các trường khác trong file cài đặt', () => {
  withDir(dir => {
    fs.writeFileSync(autostart.settingsFile(dir), JSON.stringify({ someOtherSetting: 42 }), 'utf8');
    autostart.writeChoice(dir, true);
    const saved = JSON.parse(fs.readFileSync(autostart.settingsFile(dir), 'utf8'));
    assert.equal(saved.autostart, true);
    assert.equal(saved.someOtherSetting, 42);
  });
});

// ---- đồng bộ registry --------------------------------------------------------

test('lần chạy đầu (chưa chọn) thì ghi khoá Run — đây là mặc định BẬT', async () => {
  await withDir(async dir => {
    const reg = fakeRegistry();
    const result = await autostart.sync(dir, reg.runner);
    assert.equal(result.changed, true);
    assert.equal(reg.get(autostart.VALUE_NAME), autostart.launchCommand());
  });
});

test('đã bật và lệnh khớp thì KHÔNG ghi lại mỗi lần khởi động', async () => {
  await withDir(async dir => {
    const reg = fakeRegistry({ [autostart.VALUE_NAME]: autostart.launchCommand() });
    const result = await autostart.sync(dir, reg.runner);
    assert.equal(result.changed, false, 'ghi lại mỗi lần là vô nghĩa và đụng registry liên tục');
    assert.equal(reg.calls.length, 1, 'chỉ được đọc, không được ghi');
  });
});

test('REGRESSION: app bị chuyển thư mục thì lệnh cũ phải được sửa', async () => {
  // Nếu không tự sửa, Windows vẫn chạy đường dẫn cũ ở mỗi lần bật máy — app
  // đã xoá, nên người dùng thấy lỗi Windows không hiểu nguyên nhân.
  await withDir(async dir => {
    const reg = fakeRegistry({ [autostart.VALUE_NAME]: '"C:\\Program Files\\CN Tax Tools\\CN-Tax-Tools.exe" --start-hidden' });
    const result = await autostart.sync(dir, reg.runner);
    assert.equal(result.changed, true);
    assert.equal(reg.get(autostart.VALUE_NAME), autostart.launchCommand());
  });
});

test('đã chọn TẮT thì sync KHÔNG ghi lại, kể cả khi khoá Run còn sót', async () => {
  await withDir(async dir => {
    autostart.writeChoice(dir, false);
    const reg = fakeRegistry();
    const result = await autostart.sync(dir, reg.runner);
    assert.equal(result.changed, false, 'lần đầu chưa có gì để dọn');
    assert.equal(reg.calls.some(a => a[0] === 'add'), false);
  });
});

test('đã chọn TẮT và khoá Run còn sót (bộ cài cũ chưa dọn) thì phải xoá', async () => {
  await withDir(async dir => {
    autostart.writeChoice(dir, false);
    const reg = fakeRegistry({ [autostart.VALUE_NAME]: '"C:\\x\\CN-Tax-Tools.exe" --start-hidden' });
    const result = await autostart.sync(dir, reg.runner);
    assert.equal(result.changed, true);
    assert.equal(reg.store.has(autostart.VALUE_NAME), false, 'còn sót thì Windows vẫn chạy app đã gỡ');
  });
});

// ---- bật/tắt từ UI ----------------------------------------------------------

test('bật từ UI thì ghi đúng lệnh và nhớ lựa chọn', async () => {
  await withDir(async dir => {
    const reg = fakeRegistry();
    const value = await autostart.setEnabled(dir, true, reg.runner);
    assert.equal(value.enabled, true);
    assert.equal(value.pending, false);
    assert.equal(reg.get(autostart.VALUE_NAME), autostart.launchCommand());
    assert.equal(autostart.readChoice(dir), true);
  });
});

test('tắt từ UI thì xoá khoá Run và nhớ lựa chọn', async () => {
  await withDir(async dir => {
    const reg = fakeRegistry({ [autostart.VALUE_NAME]: autostart.launchCommand() });
    const value = await autostart.setEnabled(dir, false, reg.runner);
    assert.equal(value.enabled, false);
    assert.equal(reg.store.has(autostart.VALUE_NAME), false);
    assert.equal(autostart.readChoice(dir), false);
  });
});

test('tắt khi vốn chưa có gì thì không lỗi', async () => {
  await withDir(async dir => {
    const reg = fakeRegistry();
    const value = await autostart.setEnabled(dir, false, reg.runner);
    assert.equal(value.enabled, false);
    assert.equal(value.error, '');
  });
});

test('REGRESSION: registry bị chặn thì vẫn nhớ lựa chọn, và báo pending', async () => {
  // Một số máy trong doanh nghiệp khoá CurrentVersion\Run. Nếu vì lỗi này mà
  // KHÔNG nhớ lựa chọn, lần khởi động sau app lại tự bật — người dùng bật rồi
  // thấy vẫn không chạy lúc bật máy, dễ nghĩ là ứng dụng hỏng.
  await withDir(async dir => {
    const blocked = async args => (args[0] === 'add')
      ? { ok: false, code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }
      : { ok: false, code: 1, stdout: '', stderr: '' };
    const value = await autostart.setEnabled(dir, true, blocked);
    assert.match(value.error, /Access is denied/);
    assert.equal(autostart.readChoice(dir), true, 'lựa chọn của người dùng phải được nhớ');
    const after = await autostart.status(dir, blocked);
    assert.equal(after.pending, true, 'UI phải báo chưa ghi được, không được hiện là đã bật xong');
  });
});

// ---- nối vào app -------------------------------------------------------------

test('server có nối cờ --start-hidden để bỏ mở cửa sổ lúc khởi động', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // Lỗi tinh vi: có dùng cờ nhưng vẫn gọi launchUi ở nhánh ẩn ⇒ mở cửa sổ dù
  // khởi động ẩn. Kiểm cả hai vế.
  assert.match(src, /process\.argv\.includes\(autostart\.START_FLAG\)/, 'phải đọc cờ');
  assert.match(src, /if \(hidden\)[\s\S]{0,400}?else launchUi\(port\)/, 'cờ phải thực sự bỏ launchUi');
  assert.match(src, /autostart\.sync\(dataDir\)/, 'phải đồng bộ khoá Run lúc khởi động');
});

test('mọi route autostart đều đi qua allowed() chứ không mở công khai', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  // /api/... nằm SAU `if (!allowed(req))` trong router. Nếu đặt sai chỗ thì bất kỳ
  // trang nào trên máy cũng bật/tắt autostart được.
  const guard = src.indexOf("if (!allowed(req)) return reply(res, 403");
  const route = src.indexOf("/api/autostart");
  assert.ok(guard >= 0 && route > guard, 'route /api/autostart phải nằm sau chặn phiên');
});

test('bộ cài gỡ phải dọn khoá Run — sót thì Windows cố chạy EXE đã xoá', () => {
  const nsi = fs.readFileSync(path.join(__dirname, '..', 'packaging', 'installer.nsi'), 'utf8');
  const uninstall = nsi.slice(nsi.indexOf('Section "Uninstall"'));
  assert.match(
    uninstall,
    /DeleteRegValue\s+HKCU\s+"Software\\Microsoft\\Windows\\CurrentVersion\\Run"/,
    'thiếu dọn khoá Run trong phần gỡ cài đặt'
  );
});

test('autostart.js phải nằm trong danh sách asset của pkg', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.pkg.assets.includes('src/autostart.js'), 'thiếu trong pkg.assets thì bản EXE không tìm thấy module');
});

// ---- khớp id giữa HTML và JS -------------------------------------------------

test('mọi id mà app-settings.js truy vấn đều tồn tại trong index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'app-settings.js'), 'utf8');
  // showPane() dựng id bằng nội dung suy ra ('settings-' + pane), nên phải kiểm
  // đủ cả ba tab — thiếu một thì người dùng bấm tab đó ra trang trắng.
  for (const pane of ['license', 'lock', 'startup']) {
    assert.match(html, new RegExp('id="settings-' + pane + '"'), 'thiếu pane settings-' + pane);
    assert.match(html, new RegExp('id="settings-tab-' + pane + '"'), 'thiếu nút settings-tab-' + pane);
  }
  for (const id of ['autostart-enabled', 'autostart-message', 'autostart-command']) {
    assert.match(html, new RegExp('id="' + id + '"'), 'thiếu phần tử #' + id);
    assert.match(js, new RegExp("'" + id + "'"), 'app-settings.js chưa dùng #' + id);
  }
});

test('showPane() hỗ trợ đủ ba tab sau khi thêm tab Khởi động', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'app-settings.js'), 'utf8');
  const body = js.slice(js.indexOf('function showPane'));
  const fn = body.slice(0, body.indexOf('\n  }'));
  for (const pane of ['license', 'lock', 'startup']) {
    assert.ok(fn.includes("'" + pane + "'"), 'showPane() thiếu "' + pane + '"');
  }
});
