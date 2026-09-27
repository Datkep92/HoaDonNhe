'use strict';
// ---------------------------------------------------------------------------
// Kiểm tra "dây nối" giữa HTML và JS — thứ không thể thấy bằng mắt nhưng vỡ rất dễ:
//   1) mọi phần tử JS tìm theo $('id') phải tồn tại trong index.html;
//   2) index.html KHÔNG được có inline style/handler (CSP của app là style-src 'self');
//   3) mọi file nội bộ index.html tham chiếu phải tồn tại VÀ được khai báo trong pkg.assets,
//      nếu không file sẽ thiếu khi đóng gói EXE.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const excelExport = require(path.join(root, 'src', 'data', 'excel-export'));
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
const assets = require(path.join(root, 'package.json')).pkg.assets;

function idsUsedBy(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return [...new Set([...source.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map(match => match[1]))];
}

function packaged(name) {
  return assets.some(asset => {
    const normalized = String(asset).replace(/^src\//, '');
    if (!normalized.includes('*')) return normalized === name;
    const prefix = normalized.slice(0, normalized.indexOf('*'));
    const suffix = normalized.slice(normalized.lastIndexOf('*') + 1);
    return name.startsWith(prefix) && name.endsWith(suffix);
  });
}

test('mọi phần tử mà JS tìm theo id đều có trong index.html', () => {
  for (const file of ['src/data-ui.js', 'src/renderer.js']) {
    const missing = idsUsedBy(file).filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `${file} gọi các id không tồn tại trong index.html: ${missing.join(', ')}`);
  }
});

test('index.html không dùng inline style hay handler inline (CSP style-src self)', () => {
  assert.equal((html.match(/style="/g) || []).length, 0, 'có style="..." inline trong index.html');
  assert.equal((html.match(/\son[a-z]+="/g) || []).length, 0, 'có handler inline on...="..." trong index.html');
});

test('file nội bộ index.html tham chiếu đều tồn tại và đã khai báo trong pkg.assets', () => {
  const referenced = [...html.matchAll(/(?:src|href)="([^":]+)"/g)].map(match => match[1]).filter(name => !name.startsWith('http'));
  const missingOnDisk = referenced.filter(name => !fs.existsSync(path.join(root, 'src', name)));
  assert.deepEqual(missingOnDisk, [], `index.html trỏ tới file không có trên đĩa: ${missingOnDisk.join(', ')}`);
  const notPackaged = referenced.filter(name => !packaged(name));
  assert.deepEqual(notPackaged, [], `file chưa khai báo trong pkg.assets (sẽ thiếu khi đóng gói EXE): ${notPackaged.join(', ')}`);
});

test('giao diện Kho dữ liệu có đủ các vùng chính', () => {
  for (const id of ['pane-download', 'pane-data', 'data-tiles', 'data-rows', 'data-products', 'data-partners', 'data-tab-list', 'data-tab-products', 'data-tab-partners', 'data-count', 'data-products-count', 'autosync-dialog', 'backfill-dialog', 'invoice-dialog', 'invoice-frame', 'data-new-badge', 'view-download', 'view-data']) {
    assert.ok(ids.has(id), `thiếu vùng #${id}`);
  }
});

test('Kho dữ liệu: bộ lọc gọn ở đầu tab + mỗi bảng có nút chiều riêng (yêu cầu thiết kế)', () => {
  assert.ok(!ids.has('data-filters'), 'đã bỏ aside lọc riêng của tab Kho dữ liệu');
  assert.ok(!ids.has('data-context'), 'đã bỏ dòng ngữ cảnh trùng với cột MST bên trái');
  assert.ok(html.includes('class="data-filters"'), 'bộ lọc phải nằm trong khối đầu tab');
  for (const id of ['data-q', 'data-from', 'data-to', 'data-size', 'data-clear', 'data-tax-note']) {
    assert.ok(ids.has(id), `thiếu ô lọc/ghi chú #${id} ở khối đầu tab`);
  }
  assert.ok(!ids.has('data-range-note'), 'bỏ dòng chữ khoảng ngày (đã có sẵn trong 2 ô ngày)');
  assert.ok(!/data-filters[\s\S]*?<span>[^<]+<\/span>/.test(html), 'khu lọc không còn nhãn chữ, chỉ còn control');
});

test('Kho dữ liệu: toàn bộ bộ lọc nằm trên MỘT dòng, đúng thứ tự (tìm kiếm → lịch → xoá lọc → nút ngày)', () => {
  const block = html.slice(html.indexOf('class="data-filters"'), html.indexOf('</section>', html.indexOf('class="data-filters"')));
  assert.equal((block.match(/data-filter-row/g) || []).length, 1, 'chỉ còn một hàng lọc');
  let last = -1;
  for (const needle of ['id="data-q"', 'id="data-from"', 'id="data-to"', 'id="data-size"', 'id="data-clear"', 'data-range="7d"']) {
    const at = block.indexOf(needle);
    assert.ok(at > last, `${needle} phải nằm sau mục trước đó`);
    last = at;
  }
  assert.ok(block.includes('<svg'), 'nút xoá lọc dùng icon SVG rõ ràng');
  assert.ok(!block.includes('⟲'), 'đã bỏ icon cũ khó hiểu');
  assert.ok(!ids.has('data-advanced'), 'bộ lọc nâng cao phải hiện sẵn, không ẩn trong <details>');
  // Mỗi bảng con có nút chuyển chiều riêng thay cho một ô lọc chiều dùng chung.
  for (const id of ['data-seg-products', 'data-seg-list', 'data-seg-partners']) assert.ok(ids.has(id), `thiếu nút chiều #${id}`);
  assert.ok(!ids.has('data-direction'), 'không còn ô Chiều dùng chung');
});

test('Kho dữ liệu: có cột thuế suất / tiền thuế trong các bảng', () => {
  for (const text of ['Thuế suất', 'Tiền thuế']) assert.ok(html.includes(text), `thiếu cột ${text}`);
});

test('nút đang chạy (Ngưng tra cứu / Ngưng tải) LUÔN bấm được để dừng', () => {
  // Lỗi thật đã gặp: công thức disable có `pending`, mà `pending` = true suốt thời gian request dài
  // đang chờ (server chỉ trả lời khi tác vụ xong) ⇒ nút "Ngưng tải"/"Ngưng tra cứu" bị khoá,
  // hover chỉ thấy vòng xoay (cursor:progress) mà bấm không ăn.
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  for (const id of ['search', 'stream-download']) {
    const found = source.match(new RegExp(`\\$\\('${id}'\\)\\.disabled = [^;]+;`));
    assert.ok(found, `không tìm thấy dòng disable của #${id}`);
    assert.ok(!/disabled = state\.authBusy \|\| pending \|\|/.test(found[0]), `#${id}: không được khoá bằng pending trần (sẽ khoá luôn nút đang chạy)`);
    assert.ok(found[0].includes('pending && !'), `#${id}: pending chỉ được khoá nút KHÔNG phải nút đang chạy`);
  }
});

test('bấm "Ngưng" phải tới được nhánh dừng: nhánh dừng nằm TRƯỚC guard `if (pending) return;`', () => {
  // Lỗi thật đã gặp: runLookup() mở đầu bằng `if (pending) return;` — mà `pending` = true đúng lúc
  // request tải đang chờ ⇒ cú bấm "Ngưng tải" bị nuốt im lặng: không dừng, cũng không báo lỗi.
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function runLookup(');
  assert.ok(start > -1, 'không tìm thấy runLookup trong renderer.js');
  const body = source.slice(start, source.indexOf('\n}', start));
  const stopAt = body.indexOf('if (stoppingSearch || stoppingDownload)');
  const pendingAt = body.indexOf('if (pending) return');
  // runLookup render thẳng vào `current` (bỏ vòng gọi /api/state dư) nên guard giờ so current.busy.
  const busyAt = body.indexOf('if (current.busy) return;');
  assert.ok(stopAt > -1, 'phải có nhánh dừng');
  // Nhánh dừng gọi /api/pause trực tiếp bằng call() (không qua work() để không bị guard pending nuốt).
  assert.ok(/await (work|call)\('\/api\/pause'/.test(body), 'nhánh dừng phải gọi /api/pause');
  assert.ok(pendingAt > stopAt, 'guard pending phải nằm SAU nhánh dừng, nếu không bấm Ngưng bị nuốt');
  assert.ok(busyAt > stopAt, 'guard state.busy cũng phải nằm sau nhánh dừng');
});

test('bấm tra cứu/tải là UI phản hồi NGAY: vẽ optimistic + vòng poll tự hồi phục sau lỗi tạm thời', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function runLookup(');
  const body = source.slice(start, source.indexOf('\n}', start));
  // Vẽ trạng thái "đang chạy" TRƯỚC khi gửi request (optimistic), guard busy nằm trước đó.
  const busyAt = body.indexOf('if (current.busy) return;');
  const optimisticAt = body.indexOf("current.busy = true;");
  const sendAt = body.indexOf("await work(url,");
  assert.ok(busyAt > -1 && optimisticAt > busyAt && sendAt > optimisticAt, 'thứ tự phải là: guard busy → vẽ optimistic → gửi request');
  // Vòng poll không được chết vì một nhịp hụt (nguyên nhân UI kẹt "Đang tải" dù đã xong).
  const refreshStart = source.indexOf('async function refresh()');
  const refresh = source.slice(refreshStart, source.indexOf('\n}', refreshStart));
  assert.ok(refresh.includes('pollFailures'), 'refresh() phải đếm nhịp hụt và tự hồi phục');
});

test('menu "Xuất Excel": Tải toàn bộ + 4 nhóm (Hóa đơn / Hàng hóa / Đối tác / Ngân hàng), mỗi nhóm đúng mục con', () => {
  // Yêu cầu: bấm Xuất Excel ra "Tải toàn bộ", rồi các nhóm có mục con
  // Hóa đơn -> Mua vào/Bán ra, Hàng hóa -> Mua vào/Bán ra, Đối tác -> Nhà cung cấp/Khách hàng,
  // Ngân hàng -> Sao kê ngân hàng.
  const listAt = html.indexOf('id="data-export-list"');
  assert.ok(listAt > -1, 'không tìm thấy menu xuất Excel');
  assert.ok(html.indexOf('data-part="all"') > listAt, 'phải có nút "Tải toàn bộ" trong menu');

  // Các nhóm nằm SAU phần tử menu (không có nơi nào khác trong trang dùng class "group").
  const groups = [...html.matchAll(/<details class="group"><summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
  assert.equal(groups.length, 4, 'phải có đúng 4 nhóm');
  assert.ok(html.indexOf(groups[0][0]) > listAt, 'nhóm phải nằm TRONG menu xuất Excel');
  assert.deepEqual(groups.map(g => g[1]), ['Hóa đơn', 'Hàng hóa', 'Đối tác', 'Ngân hàng']);
  const expected = { 'Hóa đơn': ['buy', 'sell'], 'Hàng hóa': ['productsBuy', 'productsSell'], 'Đối tác': ['suppliers', 'buyers'], 'Ngân hàng': ['bank'] };
  for (const [, name, body] of groups) {
    const parts = [...body.matchAll(/data-part="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(parts, expected[name], `nhóm "${name}" sai mục con`);
  }

  // Mọi mã bảng trong HTML phải là mã module xuất Excel hiểu được ('all' = xuất tất cả).
  const known = [...html.matchAll(/data-part="(\w+)"/g)].map(m => m[1]);
  for (const part of known) assert.ok(part === 'all' || excelExport.PARTS.includes(part), `mã bảng lạ: ${part}`);
  assert.equal(known.length, 8, 'tổng 8 lựa chọn (tất cả + 7 mục con)');

  // JS phải đóng menu VÀ các nhóm con sau khi chọn, nếu không lần sau mở ra còn mở sẵn nhóm cũ.
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/details\.group'\)\) group\.open = false/.test(ui), 'phải đóng các nhóm con khi chọn');
});

test('KHÔNG đụng tên biến cấp cao nhất giữa các script của giao diện', () => {
  // Lỗi thật đã gặp: mst-format.js khai báo `const api` ở cấp cao nhất, period.js CŨNG có `const api`
  // ⇒ cùng một scope global nên:
  //     period.js:1 Uncaught SyntaxError: Identifier 'api' has already been declared
  //     renderer.js Uncaught ReferenceError: Period is not defined
  // (period.js vỡ ⇒ Period undefined ⇒ mất cả danh sách MST vì renderer dừng ngay khi tải).
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length >= 5, `phải thấy các script của giao diện (thấy ${scripts.length})`);

  const owner = new Map();
  const clashes = [];
  for (const rel of scripts) {
    const file = path.join(root, 'src', rel);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    // File đã bọc IIFE ⇒ mọi thứ bên trong có scope riêng, không đụng ai.
    const wrapped = /\(function\s*\(|\(\(\)\s*=>/.test(source.slice(0, 600));
    if (wrapped) continue;
    for (const match of source.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = match[1];
      if (owner.has(name)) clashes.push(`${name} (${owner.get(name)} + ${rel})`);
      else owner.set(name, rel);
    }
  }
  assert.deepEqual(clashes, [], `script dùng chung scope bị đụng tên: ${clashes.join(', ')}`);
});

test('mst-format.js: bọc IIFE, chỉ để lộ window.MstFormat', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'mst-format.js'), 'utf8');
  const iifeAt = source.indexOf('(function () {');
  assert.ok(iifeAt > -1, 'phải bọc trong IIFE');
  assert.ok(/\}\)\(\);\s*$/.test(source.trimEnd()), 'IIFE phải đóng ở cuối file');
  // Trước IIFE chỉ được có 'use strict' + comment — mọi khai báo phải nằm BÊN TRONG.
  const before = source.slice(0, iifeAt)
    .replace(/^'use strict';\s*/m, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  assert.equal(before, '', `có khai báo NGOÀI IIFE (sẽ đụng tên với script khác): ${before.slice(0, 80)}`);
  assert.ok(source.includes('window.MstFormat = api'), 'phải để lộ đúng window.MstFormat');
  // Chỉ một tên được ghi ra global.
  const globals = [...source.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]);
  assert.deepEqual(globals, ['MstFormat'], `chỉ được ghi window.MstFormat, đang ghi: ${globals.join(', ')}`);
});

test('âm thanh thông báo tuỳ chọn: thiếu file trả 204, KHÔNG trả 404', () => {
  // 404 làm trình duyệt ghi "Failed to load resource" mỗi lần mở app dù app chạy đúng.
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const at = server.indexOf("'/template/thong-bao.mp3'");
  assert.ok(at > -1, 'không tìm thấy route âm thanh');
  const block = server.slice(at, at + 500);
  assert.ok(block.includes('existsSync'), 'phải kiểm file có tồn tại không');
  assert.ok(/writeHead\(204/.test(block), 'thiếu file ⇒ phải trả 204 thay vì để rơi xuống 404');
  assert.ok(block.includes("audio/mpeg"), 'có file ⇒ vẫn trả audio/mpeg bình thường');
});

// ===========================================================================
// PHẢN HỒI TỨC THÌ — UI phải đổi hình NGAY lúc bấm, không đợi máy chủ (2026-09).
// Chỉ kiểm tra CƠ CHẾ phản hồi: mọi nhánh logic (đang chạy / rảnh / MST khác) giữ nguyên.
// ===========================================================================
test('chọn MST phản hồi tức thì: work() ghi nhớ MST vừa bấm + dòng tô sáng theo selectingMst', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  // work() phải ghi nhận MST của request NGAY khi đặt pending — trước khi gọi call() đi mạng.
  const start = source.indexOf('async function work(');
  const body = source.slice(start, source.indexOf('\n}', start));
  const pendingAt = body.indexOf('pending = true');
  const markAt = body.indexOf('selectingMst = data.mst');
  const sendAt = body.indexOf('await call(url, data)');
  assert.ok(pendingAt > -1 && markAt > pendingAt && sendAt > markAt, 'thứ tự phải là: đặt pending → ghi selectingMst → gửi request');
  // Nhánh dài (long) không ghi selectingMst (không có dòng MST nào "đang chọn" cho tác vụ dài).
  assert.ok(body.includes('if (isLong) longMst'), 'tác vụ long vẫn tách riêng, không bị pending trần');
  // Dòng MST phải vẽ trạng thái đang chọn từ selectingMst + pending (chỉ hiệu ứng, không chặn bấm).
  assert.ok(source.includes("account.mst === selectingMst"), 'renderAccounts phải biết dòng nào vừa bấm');
  assert.ok(/row\.className = 'mst-row' \+ \(account\.mst === state\.selected \? ' active' : \(selecting \? ' selecting' : ''\)\)/.test(source), 'dòng vừa bấm phải mang class .selecting');
  // Xong phải xoá cờ để dòng trở về trạng thái thật (đã chọn hoặc chưa).
  const finallyBlock = body.slice(body.indexOf('finally {'));
  assert.ok(finallyBlock.includes("selectingMst = ''"), 'finally của work() phải xoá selectingMst');
});

test('chống bấm đúp: laneBusy cho nút ▶/⏹ từng dòng, busyButton cho Đồng bộ tất cả / Xuất Excel', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  // Nút ▶/⏹ trên dòng MST: một MST chỉ chạy một chuỗi chọn→chạy/ngưng cùng lúc.
  assert.ok(source.includes('let laneBusy'), 'phải có cờ laneBusy');
  assert.ok(source.includes('if (laneBusy === account.mst) return;'), 'bấm đúp nút ▶/⏹ phải bị bỏ qua');
  assert.ok(/finally \{ if \(laneBusy === account\.mst\) laneBusy = ''; \}/.test(source), 'laneBusy phải được xoá trong finally');
  // "Đồng bộ tất cả": nhánh CHƯA chạy phải khoá nút ngay (busyButton) — bấm đúp không gửi 2 lệnh chạy.
  const syncAllAt = source.indexOf("'/api/db/autosync/run-all'");
  const stopAt = source.indexOf("'/api/db/autosync/run-all/stop'");
  assert.ok(stopAt > -1 && syncAllAt > stopAt, 'nhánh ngưng phải đứng trước nhánh chạy');
  const afterStop = source.slice(stopAt);
  const busyAt = afterStop.indexOf("busyButton(button, 'Đang khởi động…')");
  const runCallAt = afterStop.indexOf("await work('/api/db/autosync/run-all', {})");
  assert.ok(busyAt > -1 && busyAt < runCallAt, 'phải khoá nút TRƯỚC khi gửi lệnh chạy');
  // Xuất Excel: busyButton chống xuất 2 file từ một cú bấm đúp.
  const exportAt = source.indexOf("$('export-excel').onclick");
  const exportBody = source.slice(exportAt, exportAt + 900);
  assert.ok(exportBody.includes("busyButton($('export-excel'), 'Đang xuất…')"), 'Xuất Excel phải khoá nút + nhãn ngay lúc bấm');
  assert.ok(exportBody.indexOf('busyButton') < exportBody.indexOf("await work('/api/export-excel'"), 'khoá nút phải nằm TRƯỚC lệnh xuất');
  // resume: đổi nhãn ngay (request dài, render() bên trong work() sẽ vẽ nhãn đúng theo state).
  assert.ok(source.includes("$('resume').textContent = 'Đang chạy…'"), 'resume phải đổi nhãn ngay lúc bấm');
});

test('Kho dữ liệu phản hồi tức thì: busyButton cho lưu/chạy Auto Sync, backfill, Tải lại + bảng mờ khi tải', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'src'.replace('src', 'data-ui.js')), 'utf8');
  // data-ui.js là IIFE: cần busyButton CỤC BỘ (script dùng chung scope — test "không đụng tên").
  assert.ok(source.includes('function busyButton(button, label)'), 'data-ui.js phải tự định nghĩa busyButton');
  for (const [fn, label] of [['saveAutoSync', 'Đang lưu…'], ['runAutoSyncNow', 'Đang khởi động…'], ['startBackfill', 'Đang khởi động…']]) {
    const at = source.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `không tìm thấy ${fn}`);
    const body = source.slice(at, source.indexOf('\n  }', at));
    const busy = body.indexOf("busyButton($(");
    assert.ok(busy > -1 && body.includes(label), `${fn}: phải khoá nút + nhãn "${label}" ngay lúc bấm`);
    assert.ok(body.includes('finally { restore(); }'), `${fn}: phải mở khoá trong finally`);
  }
  // "Tải lại": nhãn "Đang tải…" và mở khoá kể cả khi refreshAll ném lỗi.
  const refreshAt = source.indexOf("$('data-refresh').onclick");
  const refreshBody = source.slice(refreshAt, source.indexOf('$(\'data-import\')', refreshAt));
  assert.ok(refreshBody.includes("busyButton($('data-refresh'), 'Đang tải…')"), 'Tải lại phải có nhãn ngay lúc bấm');
  assert.ok(refreshBody.includes('.finally(restore)'), 'Tải lại phải mở khoá qua finally');
  // Xuất Excel trong kho dữ liệu: cờ chống bấm đúp đặt TRƯỚC khi fetch.
  const exportAt = source.indexOf('async function exportExcel(');
  const exportBody = source.slice(exportAt, exportAt + 700);
  assert.ok(/if \(exportBusy\) return;/.test(exportBody), 'bấm đúp xuất Excel phải bị bỏ qua');
  const busySet = exportBody.indexOf('exportBusy = true;');
  const fetchAt = exportBody.indexOf("await fetch(`/api/db/export");
  assert.ok(busySet > -1 && fetchAt > busySet, 'cờ exportBusy phải đặt TRƯỚC fetch');
  // Ba bảng con phải mờ + khoá tương tác trong lúc fetch (chỉ hiệu ứng, không đổi logic tải).
  for (const fn of ['loadList', 'loadProducts', 'loadPartners']) {
    const at = source.indexOf(`async function ${fn}(`);
    const body = source.slice(at, source.indexOf('\n  }', at) + 60);
    assert.ok(body.includes('paintTableLoading(true)'), `${fn}: phải bật hiệu ứng đang tải`);
    assert.ok(body.includes('finally { paintTableLoading(false); }'), `${fn}: phải tắt hiệu ứng trong finally`);
  }
  // Lưu ý đã sửa: hộp Auto Sync không ghi đè ô người dùng đang gõ.
  assert.ok(source.includes('syncEditing'), 'loadAutoSync phải tôn trọng ô người dùng đang gõ (syncEditing)');
});

test('menu ⋯ MỞ RA NGOÀI sidebar: panel position:fixed, toạ độ đặt theo mép phải aside', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  // Panel là con của dòng (để click ngoài vẫn đóng đúng) nhưng định vị fixed nên thoát khung cuộn
  // .mst-items và không bị nhét trong bề rộng 200–250px của sidebar.
  assert.ok(/\.row-menu-panel\s*\{[^}]*position:\s*fixed/.test(style), 'panel phải dùng position:fixed để mở ra ngoài cột trái');
  assert.ok(/aside\s*\{\s*z-index:\s*20/.test(style), 'aside phải cao hơn sticky header (z-index:11) kẻo header che menu');
  assert.ok(/function placeRowMenu\(\)/.test(renderer), 'renderer phải có placeRowMenu() đặt toạ độ panel');
  assert.ok(renderer.includes("querySelectorAll('.row-menu-panel')"), 'closeRowMenus vẫn phải dọn panel');
  const place = renderer.slice(renderer.indexOf('function placeRowMenu()'), renderer.indexOf('\n}', renderer.indexOf('function placeRowMenu()')) + 2);
  assert.ok(place.includes('getBoundingClientRect().right'), 'toạ độ neo vào mép phải của aside (mở sang vùng nội dung)');
  assert.ok(place.includes('panel.style.left'), 'panel phải được đặt left/top bằng JS');
  const open = renderer.slice(renderer.indexOf('function openRowMenu('), renderer.indexOf('function openIdentifiers('));
  assert.ok(open.includes('rowMenuAnchor = { row, panel };') && open.includes('placeRowMenu();'), 'openRowMenu phải đặt lại toạ độ ngay khi mở');
  assert.ok(open.includes('panel.onclick = event => event.stopPropagation();'), 'bấm nền panel không được rơi xuống dòng (chọn MST oan)');
  assert.ok(/document\.addEventListener\('scroll', placeRowMenu, true\)/.test(renderer), 'cuộn danh sách MST thì panel phải bám theo dòng');
  assert.ok(/window\.addEventListener\('resize', placeRowMenu\)/.test(renderer), 'đổi kích thước cửa sổ thì panel phải bám lại mép sidebar');
  assert.ok(!/\.mst-row\s*\{[^}]*overflow:\s*hidden/.test(style), 'KHÔNG được đặt overflow:hidden lên .mst-row');
});

test('cụm thương hiệu sidebar: logo 44px + wordmark "CN" mint, KHÔNG còn cam #ffb020', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  // server.js kiểm tra trang phục vụ phải chứa chuỗi "CN Tax Tools" khi khởi động ⇒ không được xoá chữ này.
  assert.ok(html.includes('<b>CN</b> Tax Tools'), 'phải giữ chuỗi "CN Tax Tools" (health-check server.js) và tách "CN" thành <b>');
  assert.ok(html.includes('class="brand-tag"'), 'phải có dòng phụ .brand-tag');
  assert.ok(html.includes('class="brand-text"'), 'chữ phải nằm trong .brand-text để cắt "…" an toàn');
  assert.ok(!style.includes('#ffb020'), 'cam #ffb020 là màu ngoài palette — phải bỏ khỏi style.css');
  assert.ok(/\.brand h2 b \{ color: #2bd4ae/.test(style), '"CN" phải dùng mint #2bd4ae');
  assert.ok(/\.brand h2 \{[^}]*font-size: 17px/.test(style), 'wordmark 17px cho cân với logo 44px');
  assert.ok(/\.brand-logo \{ height: 44px/.test(style), 'logo co về 44px');
  assert.ok(/\.brand-text \{ min-width: 0/.test(style), 'phải có min-width:0 kẻo chữ tràn biên khi sidebar hẹp');
  assert.ok(/@media \(max-width: 860px\) \{ \.brand-tag \{ display: none/.test(style), 'cửa sổ hẹp thì ẩn dòng phụ, không cắt chữ');
  // Chữ thương hiệu dùng LẠI ở hộp Hỗ trợ + dòng phiên bản đáy sidebar: cùng kiểu "CN" mint.
  assert.ok(html.includes('<span class="support-label">Hỗ trợ</span> <span class="brand-mark"><b>CN</b> Tax Tools</span>'), 'hộp Hỗ trợ phải dùng lại .brand-mark, chữ "Hỗ trợ" tách riêng để làm mờ');
  assert.ok(html.includes('<small id="app-version"><b>CN</b> Tax Tools</small>'), 'đáy sidebar phải có sẵn <b>CN</b> cho lúc chưa gọi được /api/version');
  assert.ok(/\.brand-mark b \{ color: #2bd4ae/.test(style) && /#app-version b \{ color: #2bd4ae/.test(style), 'chữ "CN" ở cả 2 chỗ phải màu mint');
  assert.ok(/\.support-header \.support-label \{[^}]*color: #adbfce/.test(style), '"Hỗ trợ" phải hạ xuống xám nhạt');
  assert.ok(/#app-version \{[^}]*font-size: 11px/.test(style), 'dòng phiên bản phải NHỎ (11px) như các dòng phụ ở đáy sidebar, không to bằng brand');
  assert.ok(/function brandMark\(text\)/.test(renderer) && renderer.includes('el.replaceChildren(brandMark(data.value.name), tag)'), 'initVersion phải dựng <b>CN</b> bằng DOM (không gán textContent một màu)');
  assert.ok(/#app-version \.app-version-tag \{ font-size: 11px/.test(style), 'số phiên bản để cỡ nhỏ để không bị cắt ở sidebar 200px');
});

test('4 thẻ số kết quả, đã bỏ 3 thẻ cũ trùng số, CÙNG nguồn state.stats (không đếm lại)', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  // 3 thẻ cũ bị bỏ hẳn: TÌM THẤY = TỔNG HÓA ĐƠN, ĐÃ HOÀN TẤT = ĐÃ TẢI + ĐÃ CÓ SẴN, CẦN THỬ LẠI = LỖI.
  for (const id of ['total', 'done', 'failed']) {
    assert.ok(!html.includes(`id="${id}"`), `thẻ cũ #${id} phải được bỏ khỏi index.html`);
    assert.ok(!renderer.includes(`$('${id}')`), `renderer không được còn truy cập #${id}`);
  }
  // Đúng 4 thẻ, nằm ngay trong .stats (không còn lớp .stats-breakdown).
  const block = html.slice(html.indexOf('<div class="stats">'), html.indexOf('<div class="stats">') + 700);
  assert.ok(!html.includes('stats-breakdown'), 'không còn lớp .stats-breakdown');
  for (const [id, label] of [['stat-total', 'TỔNG HÓA ĐƠN'], ['stat-downloaded', 'ĐÃ TẢI'], ['stat-existed', 'ĐÃ CÓ SẴN'], ['stat-failed', 'LỖI']]) {
    assert.ok(block.includes(`<span>${label}</span><strong id="${id}">0</strong>`), `thẻ ${label} (#${id}) phải nằm trong .stats`);
  }
  assert.ok((block.match(/class="card/g) || []).length >= 4, '.stats phải có đủ 4 thẻ');
  assert.ok(/function paintStatBreakdown\(stats\)/.test(renderer), 'phải có paintStatBreakdown() để đổ 4 thẻ');
  assert.ok(renderer.includes("['stat-downloaded', 'downloaded']") && renderer.includes("['stat-existed', 'existed']") && renderer.includes("['stat-failed', 'failed']"), 'các thẻ phải đọc ĐÚNG khoá của state.stats (downloaded/existed/failed)');
  // Gọi ở CẢ hai luồng: render() theo nhịp poll (có dự phòng khi máy chủ chưa có stats) và Auto Sync.
  assert.ok(renderer.includes('paintStatBreakdown(stats || { total: state.total || 0, downloaded: 0, existed: 0, failed: state.failed || 0 })'), 'render() phải đổ 4 thẻ từ state.stats, có dự phòng khi chưa có stats');
  assert.ok(renderer.includes("downloaded: preview.items.filter(x => x.state === 'done').length"), 'Auto Sync chiếm bảng thì 4 thẻ tính từ preview.items');
  assert.ok(renderer.includes('counts.downloaded + counts.existed + counts.failed'), 'thanh tiến trình lúc Auto Sync phải dùng chính bộ đếm mới');
  assert.ok(/\.stats \{ grid-template-columns: repeat\(auto-fit, minmax\(140px, 1fr\)\); \}/.test(style), 'lưới .stats phải tự co (4 cột rộng / 2 cột hẹp)');
  assert.ok(style.includes('.stats .card.existed strong { color: #517c78; }'), 'màu "ĐÃ CÓ SẴN" phải đè được rule nth-child cũ');
});

test('dòng MST 2 tầng: banner trải hết bề ngang, ▶/⋯ xếp dọc sát bên phải', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  // 2 nút gom vào .mst-actions (cột dọc) — handler cũ giữ nguyên.
  assert.ok(renderer.includes("actions.className = 'mst-actions';") && renderer.includes('actions.append(stop, menu);'), '▶ và ⋯ phải nằm trong .mst-actions');
  assert.ok(renderer.includes('menu.onclick = event => { event.stopPropagation(); openRowMenu(row, account); };'), 'handler của nút ⋯ không được đổi');
  // Banner gắn vào DÒNG (trải hết ngang), KHÔNG gắn vào khối chữ như trước.
  assert.ok(renderer.includes('row.append(dot, info, actions);') && renderer.includes('if (line) row.append(line);'), 'banner phải được gắn vào dòng');
  assert.ok(!renderer.includes('info.append(line)'), 'không còn gắn banner vào .mst-info (chỗ từng làm banner còn ~65px)');
  assert.ok(renderer.includes('className = `mst-banner ${banner.kind}`'), 'vẫn giữ class .mst-banner theo loại trạng thái');
  // CSS: lưới 2 tầng + cột nút dọc + banner trải hết ngang.
  assert.ok(/\.mst-row \{[^}]*display: grid/.test(style), '.mst-row phải chuyển sang lưới 2 tầng');
  assert.ok(/\.mst-actions \{[^}]*flex-direction: column/.test(style), 'cột nút phải xếp dọc');
  assert.ok(/\.mst-banner \{ grid-column: 1 \/ -1/.test(style), 'banner phải trải hết bề ngang dòng');
  assert.ok(style.includes('.mst-actions .mst-stop, .mst-actions .row-menu { margin: 0; }'), 'phải bỏ margin trái cũ của nút trong cột dọc');
});

test('bấm dòng MST: tự động đăng nhập NGAY, chỉ khi lỗi mới hiện modal 3 lựa chọn', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  for (const id of ['login-choice-auto', 'login-choice-form', 'login-choice-chrome']) {
    assert.ok(html.includes(`id="${id}"`), `modal chọn cách đăng nhập thiếu nút #${id}`);
  }
  assert.ok(html.includes('class="login-choice-actions"'), '3 nút phải nằm trong .login-choice-actions (xếp dọc, gọn)');
  // Bấm dòng: auto-login chạy TRƯỚC, modal chỉ hiện ở nhánh thất bại.
  assert.ok(renderer.includes('notice(`MST ${mst} hết phiên — đang tự động đăng nhập…`);'), 'bấm dòng phải báo đang tự động đăng nhập');
  assert.ok(renderer.includes('try { if (!(await autoLoginMst(mst))) openLoginChoice(mst); }'), 'auto-login chạy trước, chỉ thất bại mới mở modal');
  assert.ok(renderer.includes('catch (error) { noticeFail(error.message); await prepareManualLogin(mst); openLoginChoice(mst); }'), 'lỗi mạng cũng phải chuẩn bị form rồi mới mở modal');
  // Lỗi auto: KHÔNG tự bật form thủ công nữa, chỉ chuẩn bị sẵn rồi đóng lại (giữ CAPTCHA vừa lấy).
  assert.ok(renderer.includes('async function prepareManualLogin(mst, result)'), 'phải có prepareManualLogin()');
  assert.ok(renderer.includes("openLogin(mst, { retryAuto: true });\n  if (result) await acceptLoginResult(result);\n  $('login-dialog').close();"), 'form thủ công phải được chuẩn bị rồi ĐÓNG, chờ người dùng chọn');
  // Modal tái dùng hàm cũ, không có luồng đăng nhập mới.
  assert.ok(renderer.includes("manual.onclick = () => { close(); $('login-dialog').showModal(); $('login-mst').focus(); loginBusy(false); };"), '“Mở giao diện đăng nhập” phải hiện lại ĐÚNG form đã chuẩn bị');
  assert.ok(renderer.includes("await call('/api/account/show', { mst });"), '“Mở Chrome” phải dùng /api/account/show của MST đó');
  assert.ok(renderer.includes('if (await autoLoginMst(mst)) { close(); return; }'), '“Auto lại” thành công thì đóng modal, lỗi thì giữ modal');
});

test('CSS phản hồi tức thì: .mst-row.selecting và table.loading', () => {
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  const dataView = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  assert.ok(style.includes('.mst-row.selecting'), 'style.css phải có trạng thái dòng MST đang chọn');
  assert.ok(style.includes('mstStopSpin'), 'nút ▶/⏹ phải xoay khi dòng đang chọn');
  assert.ok(dataView.includes('table.loading tbody'), 'data-view.css phải có hiệu ứng bảng đang tải');
  assert.ok(dataView.includes('pointer-events: none'), 'bảng đang tải phải khoá tương tác');
});

test('tên công ty: có NGAY sau khi tra cứu, không phải đợi nhập XML vào kho', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8');
  assert.ok(core.includes('function companyNameFromItems'), 'core.js phải có hàm lấy tên từ kết quả tra cứu');
  assert.ok(/module\.exports = \{[^}]*companyNameFromItems/.test(core), 'core.js phải xuất companyNameFromItems');
  // Thứ tự ghép: KHO dữ liệu trước (đã nhập XML), rồi mới tới kết quả tra cứu đang có trong bộ nhớ.
  assert.ok(
    /companyName: companyNameFor\(selected\) \|\| companyNameFromItems\(/.test(server),
    'appState phải ghép: kho dữ liệu trước, kết quả tra cứu sau',
  );
});

// ===========================================================================
// CÂY KHỐI <div>/<section> CỦA index.html — thứ quyết định khối nào thuộc tab nào.
// Lỗi thật (2026-09): ở cuối khối bộ lọc Kho dữ liệu, `</div>` và `</section>` bị đảo
// chỗ và thừa một `</div>`, nên trình duyệt đóng #pane-data NGAY tại đó: `data-toolbar`
// và `data-content` rơi ra ngoài tab ⇒ hiện ở MỌI tab (kể cả Sao kê ngân hàng), còn
// `#pane-bank` bị đẩy lệch lưới 2 cột (bộ lọc sang cột rộng, bảng giao dịch bị nhét vào
// cột 312px nên chỉ thấy một góc). Lỗi này KHÔNG làm hỏng test id nào, phải kiểm bằng cây.
// ===========================================================================
function containerTree(source) {
  const tag = /<(\/?)(div|section)\b([^>]*)>/gi;
  const stack = [];
  const problems = [];
  const roots = [];
  let match;
  while ((match = tag.exec(source))) {
    const [, closing, name, attr] = match;
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) {
        problems.push(`</${name}> tại ký tự ${match.index} đóng nhầm ${open ? `<${open.name}${open.id ? ' id=' + open.id : ''}${open.cls ? ' class="' + open.cls + '"' : ''}>` : '(không còn thẻ mở)'}`);
      }
      continue;
    }
    const node = {
      name,
      id: (attr.match(/id="([^"]*)"/) || [])[1] || '',
      cls: (attr.match(/class="([^"]*)"/) || [])[1] || '',
      at: match.index,
      children: [],
    };
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
    stack.push(node);
  }
  for (const open of stack) problems.push(`<${open.name}${open.cls ? ' class="' + open.cls + '"' : ''}> mở mà không đóng`);
  return { roots, problems };
}

function findNode(nodes, predicate) {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const deeper = findNode(node.children, predicate);
    if (deeper) return deeper;
  }
  return null;
}

test('index.html: thẻ <div>/<section> đóng đúng cặp, không đảo thứ tự', () => {
  const tree = containerTree(html);
  assert.deepEqual(tree.problems, [], `cây khối của index.html bị lệch: ${tree.problems.join(' | ')}`);
});

test('tab Sao kê ngân hàng: khối Kho dữ liệu nằm TRONG #pane-data, #pane-bank là anh em cùng cấp', () => {
  const tree = containerTree(html);
  const paneData = findNode(tree.roots, node => node.id === 'pane-data');
  assert.ok(paneData, 'không tìm thấy #pane-data');
  const names = paneData.children.map(child => child.cls || child.id || child.name);
  // Ba khối này phải là con TRỰC TIẾP của #pane-data — rơi ra ngoài là chúng hiện ở mọi tab.
  for (const cls of ['data-overview', 'card data-toolbar', 'card data-content']) {
    const child = paneData.children.find(node => node.cls === cls);
    assert.ok(child, `"${cls}" phải là con trực tiếp của #pane-data (đang có: ${names.join(' | ')})`);
  }
  const paneBank = findNode(tree.roots, node => node.id === 'pane-bank');
  assert.ok(paneBank, 'không tìm thấy #pane-bank');
  assert.ok(!findNode(paneData.children, node => node.id === 'pane-bank'), '#pane-bank KHÔNG được nằm trong #pane-data (sẽ bị ẩn theo)');
  assert.deepEqual(
    paneBank.children.map(node => node.cls),
    ['bank-overview', 'card filters bank-filters', 'results bank-results'],
    'thứ tự con của #pane-bank phải là: dải số → bộ lọc → bảng giao dịch',
  );
});

test('tab Sao kê ngân hàng: dải số trải hết 2 cột, bộ lọc ở cột hẹp, bảng ở cột rộng', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  // Luật gốc: #pane-bank là lưới (một cột khi cửa sổ hẹp).
  assert.ok(
    /#pane-bank \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/.test(css),
    '#pane-bank phải là lưới một cột ở màn hẹp (bộ lọc trên, bảng dưới)',
  );
  // Màn rộng: 2 cột. Nếu phần này mất, bố cục trở lại một cột — không sai, nhưng phải biết là đã đổi.
  assert.ok(
    /#pane-bank \{ grid-template-columns: 312px minmax\(0, 1fr\); align-items: start; \}/.test(css),
    '#pane-bank phải là lưới 2 cột (312px | phần còn lại) khi cửa sổ rộng',
  );
  // Không có dòng này, ô lưới đầu tiên (dải số) chiếm cột trái ⇒ bộ lọc nhảy sang cột rộng
  // và bảng giao dịch bị nhét vào cột 312px (chỉ thấy một góc).
  assert.ok(
    /\.bank-overview \{[^}]*grid-column: 1 \/ -1/.test(css),
    '.bank-overview phải trải hết cả 2 cột để bộ lọc về cột trái và bảng về cột phải',
  );
});
