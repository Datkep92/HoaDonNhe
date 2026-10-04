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
  // Tài sản SINH RA LÚC CHẠY, không phải file trên đĩa: `/boot-cache.js` là ảnh chụp danh sách MST
  // cho khung hình đầu, dựng từ du_lieu/accounts.json nên không thể là file tĩnh (xem
  // bootCacheScript trong src/server.js). Không cần khai trong pkg.assets — pkg chỉ đóng gói file.
  const generated = new Set(['boot-cache.js']);
  const referenced = [...html.matchAll(/(?:src|href)="([^":]+)"/g)].map(match => match[1]).filter(name => !name.startsWith('http'));
  const missingOnDisk = referenced.filter(name => !generated.has(name) && !fs.existsSync(path.join(root, 'src', name)));
  assert.deepEqual(missingOnDisk, [], `index.html trỏ tới file không có trên đĩa: ${missingOnDisk.join(', ')}`);
  const notPackaged = referenced.filter(name => !generated.has(name) && !packaged(name));
  assert.deepEqual(notPackaged, [], `file chưa khai báo trong pkg.assets (sẽ thiếu khi đóng gói EXE): ${notPackaged.join(', ')}`);
});

test('index.html nhẹ: KHÔNG nhúng ảnh base64, logo thương hiệu là file riêng', () => {
  // Đã từng có logo PNG 1024×1024 (~2 MB) nhúng thẳng base64 vào HTML, chiếm 87% payload
  // trang (2,08 MB HTML / 2,35 MB tổng) để hiển thị ở 44px. Nay logo là file tĩnh `brand-logo.png`.
  const inlineData = [...html.matchAll(/data:[a-z/+.-]+;base64,([A-Za-z0-9+/=]+)/g)];
  const biggest = inlineData.reduce((max, match) => Math.max(max, match[1].length), 0);
  assert.ok(biggest < 4096, `index.html nhúng ảnh base64 ${biggest} ký tự — phải để thành file tĩnh (payload trang tăng vọt)`);
  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < 100 * 1024, `index.html nặng ${Math.round(bytes / 1024)} KB — ngưỡng là 100 KB, xem lại có tài sản lớn nhúng thẳng không`);
  assert.match(html, /<img class="brand-logo"[^>]*src="brand-logo\.png"/, 'logo sidebar phải trỏ tới brand-logo.png');
  // CSS hiển thị 44px ⇒ file nguồn phải ≥ 88px cạnh để không bị nhoè trên màn HiDPI.
  const png = fs.readFileSync(path.join(root, 'src', 'brand-logo.png'));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', 'brand-logo.png không phải PNG hợp lệ');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.ok(width >= 88 && height >= 88, `brand-logo.png là ${width}×${height} — cần ≥ 88×88 cho HiDPI`);
  assert.ok(png.length < 64 * 1024, `brand-logo.png nặng ${Math.round(png.length / 1024)} KB — quá lớn cho một logo 44px`);
});

test('giao diện Kho dữ liệu có đủ các vùng chính', () => {
  for (const id of ['pane-download', 'pane-data', 'data-tiles', 'data-rows', 'data-products', 'data-partners', 'data-tab-list', 'data-tab-products', 'data-tab-partners', 'data-count', 'data-products-count', 'autosync-dialog', 'backfill-dialog', 'invoice-dialog', 'invoice-frame', 'data-new-badge', 'view-download', 'view-data-products', 'view-data-list', 'view-data-partners', 'view-data-vat']) {
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
  // Chỉ soi TRONG khối lọc (trước đây quét cả tài liệu nên hộp thoại khác nằm sau bị tính nhầm).
  const filterBlock = html.slice(html.indexOf('class="data-filters"'), html.indexOf('</section>', html.indexOf('class="data-filters"')));
  assert.ok(!/<span>[^<]+<\/span>/.test(filterBlock), 'khu lọc không còn nhãn chữ, chỉ còn control');
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

test('nút Tải hóa đơn đang chạy LUÔN bấm được để dừng (không khoá bằng pending trần)', () => {
  // Lỗi thật đã gặp: công thức disable có `pending`, mà `pending` = true suốt thời gian request dài
  // đang chờ (server chỉ trả lời khi tác vụ xong) ⇒ nút "Ngưng" bị khoá, hover chỉ thấy vòng xoay
  // (cursor:progress) mà bấm không ăn. Lỗi thứ hai: `state.authBusy` khoá cả nút "Ngưng" — đang
  // tải mà đăng nhập nền bật thì không dừng được. Nay MỌI khoá gộp làm một và chỉ áp dụng khi
  // nút KHÔNG ở trạng thái "Ngưng".
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const found = source.match(/downloadButton\.disabled = [^;]+;/);
  assert.ok(found, 'không tìm thấy dòng disable của #download-btn');
  assert.ok(!/disabled = state\.authBusy \|\| pending \|\|/.test(found[0]), 'không được khoá bằng pending trần (sẽ khoá luôn nút đang chạy)');
  assert.ok(found[0].includes('&& !downloadRunning'), 'mọi khoá phải bỏ qua khi nút đang ở trạng thái Ngưng');
  assert.ok(/authBusy[\s\S]*downloadRunning|disabled = [^;]*authBusy/.test(found[0]), 'công thức phải còn tính authBusy');
});

test('MỘT nút cho cả 3 việc: Tải hóa đơn / Ngưng / Tải tiếp — không còn nút rời rạc', () => {
  // Ba nút cũ (#search "Tra cứu", #stream-download "Tải ngay", #resume "Tải tiếp") đã gộp
  // thành #download-btn: nhãn đổi theo state, server đoán việc cần làm. Người dùng không còn
  // phải tự nhớ bấm nút nào cho việc nào.
  for (const id of ['search', 'stream-download', 'resume']) {
    assert.ok(!ids.has(id), `#${id} phải được bỏ khỏi index.html (đã gộp vào #download-btn)`);
    assert.ok(!html.includes(`id="${id}"`), `index.html vẫn còn #${id}`);
  }
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.ok(source.includes('function downloadButtonState('), 'phải có downloadButtonState() làm nguồn sự thật cho nhãn nút');
  // Nhãn của cả 3 trạng thái phải nằm trong HÀM đó, không rải ở render() và handler.
  const start = source.indexOf('function downloadButtonState(');
  const body = source.slice(start, source.indexOf('\n}', start));
  for (const label of ['Tải hóa đơn', 'Ngưng', 'Tải tiếp']) {
    assert.ok(body.includes(label), `downloadButtonState() phải trả nhãn "${label}"`);
  }
  // Nút dùng đúng hàm đó khi vẽ (render) lẫn khi bấm (handler) — không tự tính lần nữa.
  assert.ok(source.includes('downloadButtonState(state)'), 'render() phải lấy nhãn từ downloadButtonState(state)');
  assert.ok(source.includes('downloadButtonState(current).action'), 'runLookup() phải lấy hành động từ downloadButtonState(current)');
});

test('nút Tải tiếp: giao diện ĐỌC quyết định của server (state.resumable), không tự chế danh sách', () => {
  // Lỗi thật: renderer khai báo mảng RESUMABLE_STATES riêng + thêm hai điều kiện lọc mà server
  // không có (state.authenticated, state.total > 0) ⇒ hai bên lệch nhau:
  //   · hết phiên (auth_required) thì server chạy tiếp được, giao diện lại hiện "Tải hóa đơn";
  //   · ngưng lúc còn đang quét (total = 0) thì mất luôn nút "Tải tiếp".
  // Nay server gửi sẵn `resumable` = isResumableJob(core.js) ⇒ một nguồn sự thật duy nhất.
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('function downloadButtonState(');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.ok(body.includes('state.resumable'), 'downloadButtonState() phải dùng state.resumable của server');
  assert.ok(!/RESUMABLE_STATES/.test(source), 'renderer.js không được tự khai báo danh sách trạng thái còn dở');
  assert.ok(!body.includes('state.authenticated'), '"Tải tiếp" không được đòi state.authenticated (loại mất auth_required)');
  assert.ok(!body.includes('state.total'), '"Tải tiếp" không được đòi state.total > 0 (loại mất lượt ngưng lúc đang quét)');
  // Server phải thật sự gửi cờ này, và gắn nó bằng đúng isResumableJob của core.js.
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(/resumable: isResumableJob\(/.test(server), '/api/state phải gửi resumable: isResumableJob(...)');
});

test('nút Tải tiếp không được tải nhầm khoảng ngày đã đổi', () => {
  // Lỗi thật: "Tải tiếp" gửi confirm:true ⇒ server chạy tiếp job CŨ (job.params), còn người dùng
  // đã đổi Từ ngày/Đến ngày ⇒ tải nhầm khoảng ngày cũ, và không có cách nào bắt đầu lượt mới.
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(/input\.confirm && isResumableJob\(currentJob\) && sameDownloadParams\(currentJob, requested\)/.test(server),
    'nhánh chạy tiếp phải đòi cả isResumableJob lẫn sameDownloadParams (lệch điều kiện tra cứu thì chạy lượt mới)');
  // validateParams phải nằm TRƯỚC nhánh (2) để nhánh đó có `requested` để so.
  const requestedAt = server.indexOf('const requested = validateParams(input);', server.indexOf("url.pathname === '/api/download'"));
  const resumeAt = server.indexOf('isResumableJob(currentJob) && sameDownloadParams', server.indexOf("url.pathname === '/api/download'"));
  assert.ok(requestedAt > -1 && resumeAt > requestedAt, 'validateParams phải chạy trước nhánh chạy tiếp');
  // Giao diện cũng phải nói đúng việc sẽ làm: lệch điều kiện tra cứu thì hiện "Tải hóa đơn".
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.ok(/state\.resumable && sameSearchForm\(/.test(source), 'nhãn phải chỉ "Tải tiếp" khi điều kiện tra cứu còn khớp');
});

test('bấm "Ngưng" phải tới được nhánh dừng: nhánh dừng nằm TRƯỚC guard `if (pending) return;`', () => {
  // Lỗi thật đã gặp: runLookup() mở đầu bằng `if (pending) return;` — mà `pending` = true đúng lúc
  // request tải đang chờ ⇒ cú bấm "Ngưng" bị nuốt im lặng: không dừng, cũng không báo lỗi.
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function runLookup(');
  assert.ok(start > -1, 'không tìm thấy runLookup trong renderer.js');
  const body = source.slice(start, source.indexOf('\n}', start));
  const stopAt = body.indexOf("=== 'pause'");
  const pendingAt = body.indexOf('if (pending) return');
  // runLookup render thẳng vào `current` (bỏ vòng gọi /api/state dư) nên guard giờ so current.busy.
  const busyAt = body.indexOf('if (current.busy) return;');
  assert.ok(stopAt > -1, 'phải có nhánh dừng');
  // Nhánh dừng gọi /api/pause trực tiếp bằng call() (không qua work() để không bị guard pending nuốt).
  assert.ok(/await (work|call)\('\/api\/pause'/.test(body), 'nhánh dừng phải gọi /api/pause');
  assert.ok(pendingAt > stopAt, 'guard pending phải nằm SAU nhánh dừng, nếu không bấm Ngưng bị nuốt');
  assert.ok(busyAt > stopAt, 'guard state.busy cũng phải nằm sau nhánh dừng');
  // "Tải tiếp" phải báo server `confirm: true` — nếu không, server coi là lượt mới và quét lại từ đầu.
  assert.ok(/confirm: action === 'resume'/.test(body), 'phải gửi confirm cho nhánh chạy tiếp');
});

test('bấm tải là UI phản hồi NGAY: vẽ optimistic + vòng poll tự hồi phục sau lỗi tạm thời', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const start = source.indexOf('async function runLookup(');
  const body = source.slice(start, source.indexOf('\n}', start));
  // Vẽ trạng thái "đang chạy" TRƯỚC khi gửi request (optimistic), guard busy nằm trước đó.
  const busyAt = body.indexOf('if (current.busy) return;');
  const optimisticAt = body.indexOf("current.busy = true;");
  const sendAt = body.indexOf("await work(url,");
  assert.ok(busyAt > -1 && optimisticAt > busyAt && sendAt > optimisticAt, 'thứ tự phải là: guard busy → vẽ optimistic → gửi request');
  // Vẽ vào CHÍNH `current` (không tạo bản sao) để refresh() ngay sau đó không ghi đè mất.
  assert.ok(!/current = \{ *\.\.\./.test(body), 'không được tạo bản sao của current khi vẽ optimistic');
  // Vòng poll không được chết vì một nhịp hụt (nguyên nhân UI kẹt "Đang tải" dù đã xong).
  const refreshStart = source.indexOf('async function refresh()');
  const refresh = source.slice(refreshStart, source.indexOf('\n}', refreshStart));
  assert.ok(refresh.includes('pollFailures'), 'refresh() phải đếm nhịp hụt và tự hồi phục');
});

test('nút "Bổ sung cột tra cứu": có trong thanh công cụ và nối đúng API (Mục 2)', () => {
  // Nút phải nằm trong thanh công cụ tab Kho dữ liệu, KHÔNG phải trong hộp thoại: người
  // dùng cần thấy và bấm được bất cứ lúc nào, không phải mở một hộp thoại trước.
  const toolbarAt = html.indexOf('class="card data-toolbar"');
  assert.ok(toolbarAt > -1, 'không tìm thấy thanh công cụ kho dữ liệu');
  const btnAt = html.indexOf('id="data-backfill-lookup"');
  assert.ok(btnAt > toolbarAt, 'nút phải nằm trong thanh công cụ kho dữ liệu');

  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/\$\('data-backfill-lookup'\)\.onclick/.test(ui), 'nút chưa được gắn sự kiện click');
  // Gọi đúng endpoint đã có ở server.js.
  assert.ok(/\/api\/db\/invoices\/backfill-lookup/.test(ui), 'phải gọi endpoint backfill-lookup');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(/url\.pathname === '\/api\/db\/invoices\/backfill-lookup'/.test(server),
    'server phải có endpoint backfill-lookup');
  assert.ok(/backfillProviderLookup/.test(server), 'endpoint phải gọi backfillProviderLookup');

  // Không được tự chạy lúc mở app — người dùng bấm mới chạy (đã thống nhất khi chọn phương án b).
  const scanner = fs.readFileSync(path.join(root, 'src', 'data', 'xml-scanner.js'), 'utf8');
  assert.ok(!/backfillProviderLookup/.test(fs.readFileSync(path.join(root, 'src', 'data', 'sqlite.js'), 'utf8')),
    'KHÔNG được gọi backfill trong migration — phải để người dùng bấm');
  assert.ok(scanner.includes('backfillProviderLookup'), 'hàm backfill phải nằm trong xml-scanner');
});

test('menu "Xuất Excel": Tải toàn bộ + 4 nhóm, mỗi nhóm đúng mục con', () => {
  // Nhóm "Tra cứu NCC" đã BỎ (người dùng: tải Excel ra rồi tự tra là vô ích).
  // Việc tra cứu nay ở cột "PDF gốc" của tab Danh sách.
  const listAt = html.indexOf('id="data-export-list"');
  assert.ok(listAt > -1, 'không tìm thấy menu xuất Excel');
  assert.ok(html.indexOf('data-part="all"') > listAt, 'phải có nút "Tải toàn bộ" trong menu');

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
  assert.match(html, /Tải toàn bộ \(7 bảng\)/, 'nhãn "Tải toàn bộ" phải khớp số bảng thật');

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
  // "Tải tiếp" nay là TRẠNG THÁI của #download-btn: nhãn đổi ngay lúc bấm (request dài, render()
  // bên trong work() sẽ vẽ nhãn đúng theo state) nên không còn handler #resume riêng.
  assert.ok(!ids.has('resume'), 'đã bỏ nút #resume: "Tải tiếp" là trạng thái của #download-btn');
  assert.ok(ids.has('download-btn'), 'phải có nút #download-btn');
  assert.ok(source.includes("runLookup('/api/download')"), 'nút tải phải gọi /api/download');
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
  // Cửa sổ phải đủ rộng: thân hàm có chú thích nên `await fetch` nằm xa hơn 700 ký tự.
  const exportBody = source.slice(exportAt, exportAt + 1600);
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
    ['bank-kpis', 'bank-visual-grid', 'card bank-filter-panel', 'card bank-table-card'],
    'thứ tự con của #pane-bank phải là: KPI → biểu đồ → bộ lọc → bảng giao dịch',
  );
});

test('tab Sao kê ngân hàng Giai đoạn 1: dashboard một cột, biểu đồ và bộ lọc co giãn', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  assert.ok(/#pane-bank,#pane-bank\.workspace\{display:grid;grid-template-columns:minmax\(0,1fr\)/.test(css), 'dashboard phải xếp một cột, không tạo khoảng trống');
  assert.ok(/\.bank-visual-grid\{display:grid;grid-template-columns:minmax\(0,2fr\) minmax\(270px,1fr\)/.test(css), 'biểu đồ và cảnh báo phải theo tỷ lệ 2:1');
  assert.ok(/\.bank-filter-grid\{display:grid;grid-template-columns:repeat\(7/.test(css), 'bộ lọc phải là lưới co giãn');
});

test('nhập sao kê: PDF-có-chữ đọc local không ra dữ liệu thì phải có đường chuyển sang AI', () => {
  // Luồng cũ: PDF có chữ nhưng bố cục lạ khiến đọc local ra 0 dòng ⇒ BÁO LỖI RỒI DỪNG,
  // không có đường nào dùng AI. Nay phải rơi về AI (có hỏi trước vì tốn 1 lượt).
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(ui.includes('const unusable = '), 'phải có hàm xét kết quả đọc local "không dùng được"');
  assert.ok(/preview-rows/.test(ui) && /aiPreview\(/.test(ui), 'phải có cả đường local (preview-rows) lẫn đường AI dùng chung');
  // Nhánh pdf-text: sau khi đọc local, nếu không dùng được thì hỏi rồi gọi AI.
  const branch = ui.slice(ui.indexOf("parsed.kind === 'pdf-text'"), ui.indexOf("parsed.kind === 'pdf-scan'"));
  assert.ok(/unusable\(preview\)/.test(branch), 'nhánh PDF-có-chữ phải kiểm tra kết quả đọc local');
  assert.ok(/askConfirm\(/.test(branch) && /aiPreview\(/.test(branch), 'phải XIN PHÉP (hộp xác nhận của app) trước khi gửi AI đọc lại');
  assert.ok(branch.indexOf('askConfirm(') < branch.indexOf('aiPreview('), 'hộp xác nhận phải đứng TRƯỚC lời gọi AI');
  // Excel / PDF-scan / ảnh giữ nguyên hành vi cũ.
  assert.ok(/parsed.kind === 'pdf-scan' \|\| parsed.kind === 'image'/.test(ui), 'nhánh PDF-scan/ảnh không được đổi');
});

test('nhập sao kê: hộp "AI đọc lại" có đủ bảng đối chiếu + nhãn tin cậy', () => {
  // Phải nhờ AI đọc lại thì mở hộp riêng (không dùng confirm chữ) để user thấy rõ
  // ĐỌC TỰ ĐỘNG vs AI, và biết AI đáng tin tới đâu trước khi lưu.
  for (const id of ['bank-check-dialog', 'bank-check-sub', 'bank-check-why', 'bank-check-compare',
    'bank-check-local-rows', 'bank-check-local-in', 'bank-check-local-out', 'bank-check-local-note',
    'bank-check-ai-rows', 'bank-check-ai-in', 'bank-check-ai-out', 'bank-check-ai-note', 'bank-check-ai-badge',
    'bank-check-verdict', 'bank-check-issues', 'bank-check-save', 'bank-check-cancel']) {
    assert.ok(ids.has(id), `thiếu phần tử #${id} trong hộp AI đọc lại`);
  }
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const save = ui.slice(ui.indexOf('function askBankSave('), ui.indexOf('// Nhập file sao kê —'));
  assert.ok(/askBankSave\(/.test(ui), 'phải gọi hộp riêng khi phải nhờ AI (không chỉ confirm)');
  assert.ok(/bank-check-local-rows'\).textContent = shown\(/.test(save), 'lần đọc tự động không ra dòng nào thì hiện "—", không hiện 0 rối mắt');
  assert.ok(/balanceBreaks/.test(save) && /badge\.className = 'bank-compare-badge warn'/.test(save), 'nhãn AI phải đổi theo kết quả kiểm tra số dư (khớp / lệch)');
  assert.ok(/bank-check-why'\).textContent/.test(save), 'phải nói rõ vì sao phải nhờ AI (đọc tự động không ra dữ liệu)');
  assert.ok(save.indexOf("$('bank-check-issues')") > 0 && /issues\.hidden = !lines\.length/.test(save), 'chi tiết dòng sai phải ẩn khi không có vấn đề');
  // CSS: 2 cột khi rộng, dồn 1 cột khi hẹp.
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  assert.ok(/\.bank-compare \{ display: grid; grid-template-columns: repeat\(2/.test(css), 'bảng đối chiếu phải 2 cột trên màn rộng');
  assert.ok(/@media \(max-width: 640px\) \{ \.bank-compare \{ grid-template-columns: minmax\(0, 1fr\)/.test(css), 'màn hẹp phải dồn thành 1 cột');
});

test('nhập sao kê: có popup tiến trình → kết quả, đồng bộ với hệ thống toast', () => {
  // Khi nhập file, tiến trình phải hiện dạng popup CÙNG CHỖ/CÙNG KHUNG với toast,
  // rồi tự biến thành KẾT QUẢ theo từng đường đọc (Excel/CSV · PDF AI · PDF text).
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.ok(/function noticeProgress\(/.test(renderer), 'renderer.js phải có hàm noticeProgress');
  assert.ok(/window\.noticeProgress = noticeProgress/.test(renderer), 'noticeProgress phải được công khai qua window');
  assert.ok(/class(Name)? = 'toast toast-progress'/.test(renderer), 'popup tiến trình phải dùng chung khung .toast');
  const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  assert.ok(/\.toast\.toast-progress/.test(css) && /\.toast-bar/.test(css), 'style.css phải có style cho toast tiến trình + thanh chạy');
  // data-ui.js: mỗi đường đọc đặt nhãn riêng và kết quả nêu rõ đường nào.
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/noticeProgress\(`Đang đọc \$\{file\.name\}/.test(ui), 'nhập file phải mở popup tiến trình ngay khi bắt đầu');
  for (const route of ["'Excel/CSV'", "'PDF text'", "'PDF AI (đọc lại)'", "'PDF AI'", "'Ảnh AI'"]) {
    assert.ok(ui.includes(route), `phải gắn nhãn đường đọc ${route}`);
  }
  assert.ok(/job\.finish\('ok'/.test(ui) && /job\.finish\('error'/.test(ui), 'tiến trình phải tự biến thành kết quả xong/hỏng');
});

test('hộp xác nhận: thay confirm() gốc bằng popup đồng bộ hệ thống, mở bằng <dialog> showModal()', () => {
  // Hộp xám "127.0.0.1 says" của trình duyệt nhìn lệch hẳn tông app ⇒ luồng nhập sao kê
  // phải dùng hộp xác nhận riêng, trả về Promise<boolean> như confirm().
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.ok(/function askConfirm\(/.test(renderer), 'renderer.js phải có hàm askConfirm dùng chung');
  assert.ok(/window\.askConfirm = askConfirm/.test(renderer), 'askConfirm phải được công khai qua window');
  // Vẫn phải rơi về hộp gốc của trình duyệt khi bản cũ thiếu HTML:
  // confirm() cho xác nhận, prompt() khi hộp đó cần ô nhập chữ — cả hai đều trả kết quả được.
  assert.ok(/if \(!box\) return Promise\.resolve\((options\.input \ ? prompt\(|confirm\()/.test(renderer)
    || /if \(!box\) return Promise\.resolve\((options\.input \? prompt\(|confirm\()/.test(renderer),
    'bản cũ không có HTML thì phải rơi về confirm()/prompt() để không vỡ luồng');
  for (const id of ['app-confirm', 'app-confirm-title', 'app-confirm-text', 'app-confirm-input', 'app-confirm-ok', 'app-confirm-cancel']) {
    assert.ok(ids.has(id), `index.html phải có sẵn phần tử #${id}`);
  }

  // BẮT BUỘC phải là <dialog> + showModal(). Hộp này được mở TỪ TRONG hộp khác đang modal
  // (nút Xoá / Chuyển MST… trong hộp Quản lý file sao kê). Bản cũ dựng bằng <div> z-index 80:
  // một <dialog> showModal() nằm trong TOP LAYER, không z-index nào của phần tử thường vượt
  // được ⇒ hộp xác nhận nằm DƯỚI hộp cha + nền mờ ⇒ "modal nằm dưới, không bấm được".
  const confirmTag = /<dialog[^>]*id="app-confirm"|<div[^>]*id="app-confirm"/.exec(html);
  assert.ok(confirmTag && confirmTag[0].startsWith('<dialog'), 'hộp xác nhận phải là <dialog> để nằm trong top layer');
  assert.ok(/box\.showModal\(\)/.test(renderer), 'askConfirm phải gọi showModal()');
  assert.ok(!/box\.hidden = false/.test(renderer), 'hộp xác nhận <dialog> không điều khiển bằng [hidden]');

  // Esc: <dialog> huỷ bằng sự kiện `cancel`, KHÔNG phải default action của keydown. Chỉ chặn
  // keydown thì hộp cha cũng nhận `cancel` và bị đóng theo ⇒ một lần Esc mất cả hai hộp.
  assert.ok(/addEventListener\('cancel'/.test(renderer) && /onCancel[^\n]*preventDefault/.test(renderer)
    || /onCancel = event => \{ event\.preventDefault\(\); dismiss\(\); \}/.test(renderer),
    'Esc phải xử lý qua sự kiện cancel và preventDefault để không kéo hộp cha đóng theo');

  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  // Luồng nhập sao kê (xác nhận tài khoản · hỏi gửi AI · kết quả khớp/cảnh báo · xoá file) không còn confirm() gốc.
  for (const title of ['Kiểm tra tài khoản trước khi nhập', 'CẢNH BÁO — kiểm tra kỹ trước khi lưu', 'Số liệu KHỚP — lưu vào kho?',
    'Xoá file sao kê', 'Xoá toàn bộ sao kê của MST này', 'PDF có chữ nhưng đọc tự động không ra dữ liệu']) {
    assert.ok(ui.includes(title), `phải dùng hộp xác nhận của app cho: ${title}`);
  }
  const bankFlow = ui.slice(ui.indexOf('async function importBankFile('), ui.indexOf('// ---- Hộp quản lý file sao kê'));
  assert.ok(!/[^k]confirm\(/.test(bankFlow), 'luồng nhập sao kê không được còn confirm() gốc');
  const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  assert.ok(/dialog#app-confirm \{/.test(css), 'phải bỏ khoảng trắng/viền mặc định của <dialog> cho hộp xác nhận');
  assert.ok(/dialog#app-confirm::backdrop \{/.test(css), 'nền mờ của hộp xác nhận phải nằm trên ::backdrop');
  assert.ok(/\.app-confirm-card\.tone-warn/.test(css) && /\.app-confirm-card\.tone-error/.test(css),
    'style.css phải có kiểu màu cảnh báo / lỗi của hộp xác nhận');
});

test('lớp phủ position:fixed KHÔNG được nằm trong <main> (animation vào app làm hỏng containing block)', () => {
  // <main> có animation `app-enter` (translateY). Theo đặc tả CSS, một phần tử đang có
  // transform trở thành containing block cho MỌI `position: fixed` bên trong. Animation bị
  // throttling và dừng ở frame đầu (tab nền, cửa sổ bị che) thì transform kẹt lại ⇒
  // #notice-stack bám khung cao của <main> (~1500px) thay vì khung nhìn ⇒ toast rơi dưới
  // màn hình, không thấy. Lớp phủ dạng này phải nằm ở cấp <body>.
  const mainStart = html.indexOf('<main');
  const mainEnd = html.indexOf('</main>');
  assert.ok(mainStart >= 0 && mainEnd > mainStart, 'index.html phải có <main>');
  const inMain = html.slice(mainStart, mainEnd);
  for (const id of ['notice-stack']) {
    const at = inMain.indexOf(`id="${id}"`);
    assert.equal(at, -1, `#${id} là lớp phủ position:fixed, không được nằm trong <main>`);
    assert.ok(html.includes(`id="${id}"`), `#${id} phải còn trong index.html`);
  }
  // Lớp phủ dạng <dialog> thì miễn nhiễm (top layer) nên vị trí không quan trọng — nhưng
  // vẫn phải bảo đảm hộp xác nhận không phụ thuộc z-index để nổi lên trên hộp cha.
  assert.ok(!/\.app-confirm \{[^}]*z-index/.test(fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8')),
    'hộp xác nhận không được dựa vào z-index để nổi lên trên hộp cha');
});


test('toàn app: hết hộp native confirm()/alert()/prompt(), chỉ còn lưới an toàn khi thiếu HTML', () => {
  // Hộp xám của trình duyệt ("127.0.0.1:55978 says") nhìn lệch hẳn tông app ⇒ mọi chỗ hỏi
  // người dùng trong mã nguồn phải đi qua hộp của app. Chỉ hai nhánh dự phòng khi index.html
  // không có sẵn phần tử (bản cũ) được phép gọi hộp native, và phải nằm trong Promise.resolve(...).
  const ownFiles = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))
    .map(name => `src/${name}`)
    .concat(fs.readdirSync(path.join(root, 'src', 'data')).filter(name => name.endsWith('.js')).map(name => `src/data/${name}`));
  for (const relative of ownFiles) {
    const offenders = fs.readFileSync(path.join(root, relative), 'utf8').split('\n')
      .filter(line => /(^|[^.\w])(confirm|alert|prompt)\s*\(/.test(line))
      .filter(line => !/^\s*(\/\/|\*)/.test(line))
      .filter(line => !/Promise\.resolve\(/.test(line)); // lưới an toàn khi thiếu HTML
    assert.deepStrictEqual(offenders, [], `${relative} còn hộp native: ${offenders.join(' | ')}`);
  }
  // Nút "Chuyển MST…" trước đây gõ tay bằng prompt() ⇒ nay là hộp của app có ô nhập + gợi ý bấm chọn.
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/title: 'Chuyển file sang MST khác'[\s\S]{0,220}input: \{ placeholder: 'MST đích', options: mstOptions \}/.test(ui),
    'nút Chuyển MST phải dùng hộp của app có ô nhập + danh sách MST gợi ý');
  const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  assert.ok(/\.app-confirm-input input/.test(css) && /\.app-confirm-chips \{/.test(css),
    'style.css phải có style ô nhập + dãy gợi ý của hộp xác nhận');
});

test('Tổng quan: mỗi dòng "Cần kiểm tra" là nút bấm → mở đúng danh sách chi tiết (mục 27)', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  // Hộp thoại danh sách phải tồn tại sẵn trong HTML (dây nối $('id') → id thật).
  for (const id of ['pending-dialog', 'pending-title', 'pending-close', 'pending-actions', 'pending-reprocess', 'pending-rows', 'pending-empty']) {
    assert.ok(ids.has(id), `index.html phải có sẵn phần tử #${id}`);
  }
  assert.ok(ui.includes('class="alert-row"') && ui.includes('data-filter='), 'cảnh báo phải render thành nút bấm có data-filter');
  assert.ok(ui.includes('openPending('), 'bấm cảnh báo phải gọi openPending');
  // Danh sách lấy từ KẾT QUẢ ĐÃ LƯU trong SQLite, không phải UI tự tính lại.
  assert.ok(ui.includes("'/api/db/reconciliation/pending'"), 'UI phải đọc /api/db/reconciliation/pending');
  assert.ok(server.includes("'/api/db/reconciliation/pending'"), 'server phải có route /api/db/reconciliation/pending');
  // Mục 32: nút đọc lại file hóa đơn gốc để bù hình thức thanh toán.
  assert.ok(ui.includes("'/api/db/invoices/reprocess-payment'"), 'UI phải có nút gọi reprocess-payment');
  assert.ok(server.includes("'/api/db/invoices/reprocess-payment'"), 'server phải có route reprocess-payment');
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  assert.ok(/\.overview-alerts \.alert-row/.test(css), 'dòng cảnh báo phải có style của chính nó');
});

test('MỤC 3 + 5 + 6 + 7 — mọi popup danh sách đều xem được hoá đơn và phân loại được', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'src', 'data', 'schema.js'), 'utf8');
  // MỤC 3 — cột thao tác ở popup "Cần kiểm tra" + popup danh sách dùng chung đủ chỗ.
  assert.ok(html.includes('<th>Thao tác</th>'), 'bảng "Cần kiểm tra" phải có cột Thao tác');
  for (const id of ['list-dialog', 'list-title', 'list-subtitle', 'list-head', 'list-rows', 'list-empty', 'list-close']) {
    assert.ok(ids.has(id), `index.html phải có sẵn #${id}`);
  }
  assert.ok(ui.includes('reviewActionsHtml') && ui.includes('data-act="view"'), 'mỗi dòng phải có nút Xem hoá đơn A4');
  assert.ok(ui.includes('data-act="cash_manual"') && ui.includes('data-act="transfer_manual"'),
    'phải có nút TM (chưa khớp sao kê) và CK (khớp sao kê)');
  assert.ok(ui.includes("post('/api/db/invoices/review'"), 'bấm phân loại phải POST tới /api/db/invoices/review');
  for (const label of ['Đã kiểm tra', 'Đã xử lý', 'Thiếu tài liệu', 'Đủ tài liệu', 'Lỗi']) {
    assert.ok(ui.includes(`'${label}'`), `ô phân loại phải có: ${label}`);
  }
  // MÁY KHÔNG BAO GIỜ tự phân loại: schema v8 + route chỉ ghi đúng giá trị người dùng bấm.
  assert.ok(schema.includes('review_status') && schema.includes('reviewed_at'), 'schema v8 phải có 2 cột phân loại');
  assert.ok(server.includes("'/api/db/invoices/review'"), 'server phải có route phân loại');
  assert.ok(server.includes('setReview(db, { id: input.id, action: input.action })'), 'route phải gọi đúng setReview');
  // MỤC 5 — công nợ: mỗi đối tượng là nút bấm, có popup chi tiết + route riêng.
  assert.ok(ui.includes('class="debt-party" data-direction='), 'dòng công nợ phải là nút bấm kèm chiều bán/mua');
  assert.ok(ui.includes('openParty') && server.includes("'/api/db/debts/detail'"), 'phải có đường tới chi tiết công nợ');
  assert.ok(ui.includes('data-key='), 'mỗi dòng danh sách phải gắn khoá hoá đơn để mở A4');
  // MỤC 6 — top hàng hoá hiện 3 dòng + nút mở rộng + popup hoá đơn theo mặt hàng.
  assert.ok(ui.includes('slice(0, 3)') && ui.includes('data-goods-more'), 'top hàng hoá phải hiện 3 + nút "Xem thêm"');
  assert.ok(ui.includes('openProduct') && server.includes("'/api/db/products/invoices'"),
    'bấm mặt hàng phải mở được danh sách hoá đơn của mặt hàng đó');
  // MỤC 27 — 4 cảnh báo hàng hoá là nút bấm → danh sách mặt hàng bị dính.
  assert.ok(ui.includes('data-warn') && ui.includes('openGoodsWarn') && server.includes("'/api/db/goods/detail'"),
    '4 cảnh báo hàng hoá phải bấm được sang danh sách chi tiết');
  // MỤC 7 — nút ở chân thẻ ĐỐI CHIẾU / NGÂN HÀNG.
  assert.ok(ui.includes('cardLinks(') && ui.includes("['needs_review',"), 'thẻ đối chiếu phải có nút mở danh sách');
  assert.ok(ui.includes("['bank',"), 'thẻ ngân hàng phải có đường sang tab Sao kê');
  // MỤC 7 — các thẻ còn lại cũng bấm được: dải KPI, 2 thẻ chiều bán/mua, biểu đồ theo tháng.
  assert.ok(ui.includes('kpi-link') && ui.includes("['Cần kiểm tra', num.format(reviewCount), 'warn', 'Đối chiếu và dữ liệu', 'needs_review']"),
    'dòng "Cần kiểm tra" ở dải KPI phải là nút bấm sang popup chi tiết');
  assert.ok(ui.includes('data-invoices=') && ui.includes('openInvoiceList'),
    '2 thẻ chiều bán/mua phải có nút mở danh sách hoá đơn của chiều đó');
  assert.ok(ui.includes('data-month=') && ui.includes('openMonthList'),
    'bấm một tháng trên biểu đồ phải mở hoá đơn của chính tháng đó');
});

test('Tổng quan: có thẻ Công nợ (mục 25) và Thuế/ngưỡng (mục 26), không hard-code số thuế', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  for (const id of ['overview-debt', 'overview-tax', 'tax-rule']) {
    assert.ok(ids.has(id), `index.html phải có sẵn phần tử #${id}`);
  }
  assert.ok(ui.includes('api(`/api/db/debts${period}`)'), 'UI phải đọc công nợ từ API, kèm kỳ đang chọn ở header');
  assert.ok(ui.includes('api(`/api/db/tax?businessType='), 'UI phải gửi loại hình kinh doanh đi lấy ngưỡng');
  assert.ok(server.includes("'/api/db/debts'") && server.includes("'/api/db/tax'"), 'server phải có 2 route trên');
  assert.ok(/overview-debt-card/.test(css) && /overview-tax-card/.test(css), 'hai thẻ phải có bố cục trong lưới 12 cột');
  // Mục 26: KHÔNG được gọi là "THUẾ PHẢI NỘP" và KHÔNG hard-code ngưỡng vào giao diện.
  assert.ok(!html.includes('THUẾ PHẢI NỘP') && !ui.includes('THUẾ PHẢI NỘP'), 'chỉ được gọi là thuế dự kiến/ước tính');
  assert.ok(!ui.includes('500000000') && !html.includes('500000000') && !ui.includes('300000000'),
    'ngưỡng phải lấy từ src/data/tax-rules.js theo năm, không ghi chết trong giao diện');
  const taxRules = require(path.join(root, 'src', 'data', 'tax-rules'));
  assert.ok(taxRules.rulesFor(2026).every(rule => rule.year === 2026 && rule.legalRef), 'quy tắc phải versioned theo năm + dẫn chiếu');
  assert.ok(taxRules.findRule({ year: '2026', businessType: 'doanh_nghiep' }).threshold === null, 'doanh nghiệp không có ngưỡng hộ kinh doanh');
});

test('MỤC 29 — JSON thống kê đủ 7 trường, dựng từ SQLite, CHƯA gọi API AI (chờ mở rộng)', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  for (const id of ['ai-summary-json', 'ai-summary-copy']) {
    assert.ok(ids.has(id), `index.html phải có sẵn phần tử #${id}`);
  }
  // Đúng 7 trường của ví dụ trong mục 29 (giữ nguyên tên trường để mai sau AI nhận đúng object này).
  const block = (ui.match(/aiSummaryJson = JSON\.stringify\(\{[\s\S]{0,700}?\}, null, 2\)/) || [])[0];
  assert.ok(block, 'phải dựng JSON bằng JSON.stringify với đúng cấu trúc của spec');
  for (const key of ['revenue', 'purchase', 'cash_invoice', 'transfer_invoice', 'transfer_unmatched', 'bank_unmatched', 'supplier_debt']) {
    assert.ok(block.includes(`${key}:`), `JSON phải có trường ${key}`);
  }
  // Chưa build AI ⇒ KHÔNG thêm route nào gửi JSON đi: giao diện chỉ hiển thị + sao chép.
  assert.ok(!server.includes('/api/db/summary-text') && !ui.includes('/api/db/summary-text'),
    'chưa tích hợp AI: không được thêm route gửi JSON cho AI (để mở rộng sau)');
  assert.ok(ui.includes('navigator.clipboard.writeText(aiSummaryJson)'), 'nút sao chép phải dùng clipboard');
  // Số lấy từ payload đã đọc (SQLite), không tự tính lại; chưa chạy đối chiếu thì KHÔNG dựng JSON
  // để tránh hiện số 0 giả (mục 35).
  assert.ok(ui.includes('reconciliation.ran') && ui.includes('debt.payable') && ui.includes('reconciliation.cashAmount'),
    '7 trường phải lấy thẳng từ summary + reconciliation + debts');
  assert.ok(/overview-ai-card/.test(css), 'thẻ JSON phải nằm trong lưới Tổng quan');
});

test('Thanh phiên gọn + bộ lọc kỳ nằm riêng trong tab Tổng quan', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  // Thanh phiên chỉ giữ MST · tên · thời gian cập nhật; không chứa bộ lọc thống kê.
  assert.ok(html.includes('class="account-id"') && html.includes('class="account-updated"'),
    'thanh phiên phải có MST/tên và thời gian cập nhật');
  const accountMarkup = html.match(/<section class="account">[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(!accountMarkup.includes('overview-period-mode'), 'bộ lọc thống kê không được nằm trên thanh phiên');
  assert.ok(!html.includes('overview-head'), 'trang Tổng quan không còn khối tiêu đề riêng (bỏ chỗ trùng)');
  for (const id of ['overview-period', 'overview-loading', 'overview-refresh']) {
    assert.ok((html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1, `#${id} phải chỉ xuất hiện đúng 1 lần`);
  }
  // Bộ chọn trong tab Tổng quan: tháng hiện tại / tháng / quý / năm / khoảng ngày.
  for (const key of ['current_month', 'month', 'quarter', 'year', 'custom']) {
    assert.ok(html.includes(`<option value="${key}"`), `thiếu kiểu kỳ: ${key}`);
  }
  // Bộ chọn kỳ nay là MỘT bộ CHUNG cho toàn app, đặt ở header (ngoài pane-overview) để luôn
  // nhìn thấy được — trước đây nó nằm trong tab Tổng quan nên sang tab khác là biến mất.
  assert.ok(ui.includes("$('app-range-mode').onchange"), 'JS phải gắn sự kiện bộ lọc kỳ chung');
  assert.ok(ui.includes('function setAppRange(') && ui.includes('function paintAppRange('),
    'phải có một nguồn sự thật duy nhất cho kỳ: setAppRange() + paintAppRange()');
  // Một hàng dán duy nhất: tab + tiêu đề + MST + bộ lọc kỳ. KHÔNG được tách thêm hàng
  // "KỲ LỌC" hay thêm nút chip kỳ ở header — trước đó có 4 hàng trước nội dung và nhãn kỳ
  // ("Năm 2026") hiện hai lần.
  for (const id of ['app-range-bar', 'app-range-mode', 'app-range-label']) {
    assert.ok((html.match(new RegExp(`id="${id}"`, 'g')) || []).length === 1, `#${id} phải chỉ xuất hiện đúng 1 lần`);
  }
  assert.ok(!html.includes('view-range-chip'), 'không được thêm nút chip kỳ riêng ở header (nhãn kỳ đã có trong bộ lọc)');
  assert.ok(!html.includes('app-range-caption'), 'không cần badge "KỲ LỌC" — nhãn "Kỳ" của select là đủ');
  // Bộ lọc kỳ gộp thành MỘT nút: nhãn kỳ là <summary> mở bộ chọn, không phải select + nhãn.
  assert.ok(/<details class="app-range" id="app-range-details"><summary[^>]*id="app-range-label"/.test(html),
    'nhãn kỳ phải là <summary> bấm được để mở bộ chọn');
  assert.ok(!/class="app-range-bar"/.test(html), 'thanh kỳ cũ (select + nhãn cạnh nhau) đã bỏ');
  assert.ok(/\.app-range\[open\] > summary\{/.test(style), 'nút kỳ phải đổi màu khi đang mở');
  assert.ok(/<main id="main-content"><div class="app-top"><header>/.test(html),
    'header và bộ lọc kỳ phải nằm chung khối .app-top để dán gọn một chỗ');
  assert.ok(/\.app-top\{position:sticky/.test(style), 'khối .app-top phải dán theo — kỳ luôn nhìn thấy khi cuộn');
  assert.ok(!html.includes('overview-period-mode'), 'ô chọn kỳ cũ trong tab Tổng quan phải bỏ (đã gộp vào header)');
  assert.ok(!html.includes('data-period-mode'), 'ô Năm/Quý/Tháng trùng lặp ở tab Kho dữ liệu phải bỏ');
  // Không được còn ba trạng thái kỳ cạnh tranh nhau.
  for (const dead of ['let range = {', 'let bankRange =', 'let overviewPeriod =', 'bankRangeMode']) {
    assert.ok(!ui.includes(dead), `đã gộp kỳ chung thì không được còn "${dead}"`);
  }
  // Mọi bề mặt lọc (chip ở Kho dữ liệu, chip ở Sao kê, chip ở MISA) đều GHI vào appRange.
  for (const call of ['setBankQuickRange(', 'setAppRange(']) {
    assert.ok(ui.includes(call), `thiếu ${call}`);
  }
  assert.ok(ui.includes('function periodQuery()'), 'phải có chuỗi query gửi kèm theo kỳ');
  const periodCalls = (ui.match(/api\(`\/api\/db\/[^`]*\$\{period\}`\)/g) || []).join(' ');
  for (const route of ['/api/db/summary', '/api/db/bank/summary', '/api/db/reconciliation/summary', '/api/db/overview', '/api/db/debts']) {
    assert.ok(periodCalls.includes(route), `${route} phải tải theo kỳ đang chọn`);
  }
  assert.ok(!periodCalls.includes('/api/db/tax'), 'thuế vẫn theo NĂM + loại hình (mục 26), không lọc theo kỳ');
  // Bản xuất Excel phải theo CÙNG kỳ đang xem — nếu không thì file ra sai so với màn hình.
  assert.ok(/const filters = activeFilters\(\)/.test(ui) && /params\.set\('parts', chosen\)/.test(ui)
    && !/RANGE_KEY, JSON\.stringify\(\{ range/.test(ui),
    'Xuất Excel phải lấy bộ lọc chung (activeFilters), không lưu kỳ riêng');
  // Server nhận from/to và truyền xuống từng query (không có thì chạy như cũ).
  assert.ok(/queries\.summary\(db, range\)/.test(server) && /queries\.overview\(db, range\)/.test(server)
    && /queries\.debts\(db, range\)/.test(server) && /reconciliation\.summary\(db, range\)/.test(server)
    && /bankStatement\.summary\(db, range\)/.test(server), 'cả 5 route phải nhận khoảng ngày của kỳ');
  const viewStyle = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  assert.ok(/account-updated/.test(style) && /overview-filterbar/.test(viewStyle), 'thanh phiên và bộ lọc phải có CSS riêng');
});

test('header: tên tab đứng chung hàng với dãy nút, mô tả chuyển sang tooltip', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  for (const id of ['view-title', 'main-license-badge']) assert.ok(ids.has(id), `thiếu #${id}`);
  // Hàng "nhãn TỔNG QUAN + tên tab + mô tả" đã bỏ để tiết chiều cao: #view-eyebrow và
  // #view-note không còn, mô tả nằm trong tooltip của nút tab đang bật.
  assert.ok(!ids.has('view-eyebrow'), '#view-eyebrow đã bỏ — nó chỉ lặp lại tên nút tab');
  assert.ok(!ids.has('view-note'), '#view-note đã bỏ — mô tả chuyển sang tooltip');
  assert.ok(!ui.includes("$('view-eyebrow')") && !ui.includes("$('view-note')"),
    'JS không được còn ghi vào hai phần tử đã bỏ');
  assert.ok(/button\.title = `\$\{tabInfo\[1\]\}/.test(ui), 'phải đưa mô tả tab vào tooltip nút tab');
  for (const key of ['overview:', 'download:', 'data:', 'bank:']) assert.ok(ui.includes(key), `thiếu nội dung header cho ${key}`);
  assert.ok(/\.header-context[\s\S]*text-align:right/.test(style), 'thông tin tab phải căn sát phải');
// Tiêu đề phải nằm CÙNG hàng với dãy nút (header là flex, không có hàng riêng).
  // KHÔNG khóa cứng con số flex cũ: layout đã đổi có chủ ý (nút tab được `flex:1 1 auto`
  // chiếm chỗ, tiêu đề `flex:0 1 auto` + `max-width:34%` nên co lại và chặn trên 1/3 bề ngang
  // thay vì đẩy dãy nút ra mép). Test bám vào BỐ CỤC, không bám vào cách viết CSS.
  const viewSwitch = (style.match(/\.app-top > header > \.view-switch\{([^}]*)\}/) || ['', ''])[1];
  const headerCtx = (style.match(/\.app-top > header > \.header-context\{([^}]*)\}/) || ['', ''])[1];
  assert.ok(/app-top > header\{[^}]*flex-wrap:wrap/.test(style), 'header phải là hàng flex có xuống dòng');
  assert.ok(/flex:\s*\d+ 1 auto/.test(viewSwitch) && /min-width:\s*0/.test(viewSwitch),
    'dãy nút tab phải co được và không giữ chiều rộng tối thiểu');
  assert.ok(/flex:\s*0 1 auto/.test(headerCtx) && /max-width:/.test(headerCtx) && /text-align:right/.test(headerCtx),
    'tiêu đề phải co lại, chặn trên 34% và căn sát phải');
  assert.ok(/<div class="view-switch"[^>]*>(?:(?!<\/header>)[\s\S])*?<div class="header-context"/.test(html),
    'header chỉ được có MỘT hàng: dãy nút + tiêu đề, không có khối tiêu đề riêng');
});

test('Tổng quan: header (mục 18) + KPI (mục 19) + các thẻ (mục 20–23) đủ theo bảng đề bài', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  // Thanh phiên: renderer dựng MST + tên, data-ui cập nhật mốc dữ liệu gần nhất.
  assert.ok(ids.has('account') && ids.has('overview-period'), 'index.html phải có ô tài khoản và thời gian cập nhật');
  assert.ok(ui.includes('`Cập nhật ${shortWhen(summary.lastImport)}`'), 'phải hiện lần cập nhật gần nhất');
  assert.ok(ui.includes('shortWhen(summary.lastImport)'), 'phải hiện lần cập nhật gần nhất');
  // Số trên KPI "Cần kiểm tra" phải lấy từ CÙNG một mảng với thẻ cảnh báo (không đếm hai kiểu).
  assert.ok(ui.includes('const alertCounts = [') && ui.includes('alertCounts.reduce('),
    'số "Cần kiểm tra" phải là tổng của chính danh sách cảnh báo');
  assert.ok(ui.includes('alertCounts.filter(([count]) => Number(count) > 0)'), 'thẻ cảnh báo lọc từ cùng mảng');
  // MỤC 19 – KPI CHÍNH: 5 con số bắt buộc + 2 dòng thêm (Lũy kế năm · So với kỳ trước).
  for (const label of ['Doanh thu bán ra', 'Mua vào', 'Chênh lệch bán - mua', 'Số hóa đơn bán', 'Số hóa đơn mua', 'Lũy kế năm', 'So với kỳ trước']) {
    assert.ok(ui.includes(`['${label}'`), `KPI phải có: ${label}`);
  }
  // "Tiền vào ngân hàng" đã dời sang thẻ NGÂN HÀNG (mục 23) — không lặp lại làm dày hàng KPI.
  assert.ok(!ui.includes("['Tiền vào ngân hàng'"), 'KPI không được trùng số với thẻ ngân hàng');
  // 8 thẻ KPI (5 cũ + "Cần kiểm tra" + 2 dòng mới) → lưới 4 cột × 2 hàng.
  assert.ok(/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/.test(css), '8 thẻ KPI phải chia đủ 4 cột');
  // Số của 2 dòng mới phải do server tính (SQLite) — giao diện không tự chia/trừ số.
  assert.ok(ui.includes('summary.yearToDate') && ui.includes('summary.previousPeriod'),
    'KPI mới phải đọc từ summary().yearToDate / previousPeriod (tính ở server)');
  assert.ok(!ui.includes("['Lợi nhuận'") && !ui.includes('["Lợi nhuận"'),
    'không được đặt tên một dòng KPI là LỢI NHUẬN (mục 19)');
  // MỤC 4 – HAI THẺ TÁCH CHIỀU: bán ra (khách hàng · tiền vào) và mua vào (nhà cung cấp · tiền ra).
  for (const id of ['overview-sell', 'overview-buy']) {
    assert.ok(ids.has(id), `index.html phải có sẵn thẻ #${id}`);
  }
  assert.ok(!ids.has('overview-payment'), 'đã thay thẻ thanh toán gộp chung bằng 2 thẻ theo chiều');
  assert.ok(ui.includes('summary.paymentSides'), 'UI phải đọc số HĐ + tiền theo từng hình thức của TỪNG chiều');
  assert.ok(ui.includes('reconciliation.byDirection'), 'mỗi thẻ phải có kết quả đối chiếu của CHÍNH chiều đó');
  assert.ok(html.includes('Bán ra — Khách hàng') && html.includes('Mua vào — Nhà cung cấp'),
    'tiêu đề 2 thẻ nêu rõ khách hàng / nhà cung cấp');
  assert.ok(/\.overview-sell-card,\.overview-buy-card/.test(css), '2 thẻ mới phải có cột trong lưới 12 cột');
  // MỤC 21 – ĐỐI CHIẾU CHUYỂN KHOẢN: đủ 5 dòng của bảng đề bài.
  for (const label of ['Tổng hóa đơn CK', 'Đã tìm thấy giao dịch', 'Chưa tìm thấy giao dịch', 'Sai số tiền', 'Cần kiểm tra']) {
    assert.ok(ui.includes(`['${label}'`), `thẻ đối chiếu phải có dòng: ${label}`);
  }
  // MỤC 22 – TIỀN MẶT: số + giá trị + ghi rõ không yêu cầu đối chiếu sao kê.
  assert.ok(ui.includes('reconciliation.cashAmount'), 'phải hiện giá trị tiền mặt');
  assert.ok(ui.includes('không cần đối chiếu sao kê'), 'phải ghi rõ không yêu cầu đối chiếu');
  // MỤC 23 – NGÂN HÀNG: đủ 6 dòng.
  for (const label of ['Tổng tiền vào', 'Tổng tiền ra', 'Số giao dịch', 'Đã đối chiếu', 'Chưa đối chiếu', 'Cần kiểm tra']) {
    assert.ok(ui.includes(`['${label}'`), `thẻ ngân hàng phải có dòng: ${label}`);
  }
  // Ghi chú dưới dòng (tiền / điều kiện) phải được CSS nhận diện trong đúng 2 thẻ dùng nó.
  assert.ok(/\.overview-donut-card \.overview-metrics span em/.test(css), 'thẻ đối chiếu/thanh toán cần style cho dòng ghi chú');
});

test('Tổng quan: thẻ Hàng hóa đủ theo mục 24 (tổng hợp 2 chiều, top bán + top mua, 4 cảnh báo)', () => {
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'data-view.css'), 'utf8');
  // MỤC 24 – tổng hợp: tổng số mặt hàng, số lượng mua/bán, giá trị mua/bán.
  for (const label of ['Tổng số mặt hàng', 'Số lượng bán', 'Giá trị bán', 'Số lượng mua', 'Giá trị mua']) {
    assert.ok(ui.includes(`['${label}'`), `thẻ hàng hóa phải có dòng: ${label}`);
  }
  // Top hàng bán + Top hàng mua (đều từ SQLite, hai chiều riêng).
  assert.ok(ui.includes("goodsTop('Top hàng bán'") && ui.includes("goodsTop('Top hàng mua'"), 'phải có cả top bán và top mua');
  assert.ok(ui.includes('overview.topProductsBuy'), 'top mua phải đọc từ API overview');
  assert.ok(server.includes("'/api/db/overview'"), 'server phải có route /api/db/overview');
  // 4 cảnh báo của mục 24.
  for (const key of ['sellOverBuy', 'missingBuy', 'notNormalized', 'codeMismatch']) {
    assert.ok(ui.includes(`goods.${key}`), `phải render cảnh báo: ${key}`);
  }
  assert.ok(css.includes('.goods-warn'), 'cảnh báo hàng hóa phải có style của riêng nó');
  // Không có dữ liệu hàng hóa thì hiện "Chưa có dữ liệu", không hiện số 0 (mục 35).
  assert.ok(ui.includes('Chưa có dữ liệu hàng hóa.'), 'thẻ phải có trạng thái chưa có dữ liệu');
});

test('Thư mục lưu: ĐÃ LƯU thì KHOÁ lại, muốn đổi phải xác nhận cảnh báo mất dữ liệu', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
  // Đổi thư mục lưu = app chuyển sang đọc data.db/hoá đơn ở chỗ khác ⇒ dữ liệu đã tải ở thư mục cũ
  // không còn hiện trong app. Nên ô nhập phải bị KHOÁ, và phải có đường đổi riêng có cảnh báo.
  assert.ok(html.includes('id="change-output"'), 'phải có nút "Đổi thư mục…"');
  assert.ok(ui.includes('field.readOnly = folderLocked'), 'ô thư mục phải readOnly khi đã lưu');
  assert.ok(ui.includes('changeFolderButton.hidden = !folderLocked') && ui.includes('chooseFolderButton.hidden = folderLocked'),
    'chỉ hiện MỘT trong hai nút: Chọn (chưa có thư mục) / Đổi (đã khoá)');
  assert.ok(style.includes('#output.locked'), 'ô bị khoá phải có style riêng để nhìn là biết');
  // Đổi thư mục phải đi qua hộp xác nhận CỦA APP (không dùng confirm() gốc) và nói rõ mất dữ liệu.
  assert.ok(ui.includes('$(\'change-output\').onclick'), 'phải có handler cho nút Đổi thư mục');
  assert.ok(/Đổi thư mục lưu hóa đơn[\s\S]{0,900}?FILE KHÔNG BỊ XOÁ/.test(ui),
    'cảnh báo phải nói rõ app không còn hiện dữ liệu cũ NHƯNG file không bị xoá');
  assert.ok(ui.includes("call('/api/folder', { confirm: true })"), 'phải gửi kèm xác nhận khi đổi');
  // CHỐT Ở SERVER: thiếu xác nhận thì từ chối — không thể lách qua giao diện.
  assert.ok(server.includes('function assertFolderChangeAllowed'), 'phải có chốt ở server');
  assert.ok(server.includes('assertFolderChangeAllowed(next, input.confirm)'), 'route /api/folder phải dùng chốt');
  assert.ok(server.includes('assertFolderChangeAllowed(folder, input.confirmOutput)'), 'route lưu khách mới cũng phải dùng chốt');
  // Form Thêm MST: đã có thư mục dùng chung thì KHOÁ luôn ô ở đó (không đổi chéo từ form khác).
  assert.ok(ui.includes("$('mst-output').readOnly = adding && hasFolder"), 'ô thư mục trong form Thêm MST phải khoá khi đã có thư mục');
});

test('MỌI tab trong index.html đều được NỐI đủ: có onclick, có pane, có trong showView', () => {
  // Lỗi thật đã xảy ra: thêm nút tab "Hỗ trợ kế toán" vào index.html nhưng QUÊN gán onclick ở
  // data-ui.js ⇒ bấm vào KHÔNG có gì xảy ra. Test này khoá lại cho MỌI tab, kể cả tab thêm sau.
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  const buttons = [...html.matchAll(/<button id="(view-[a-z]+)"/g)].map(match => match[1]);
  assert.ok(buttons.length >= 5, `phải có ít nhất 5 tab, đang thấy ${buttons.length}`);
  for (const id of buttons) {
    const name = id.slice('view-'.length);
    assert.ok(ui.includes(`$('${id}').onclick`), `tab ${id} CHƯA được nối onclick ⇒ bấm không có gì xảy ra`);
    assert.ok(html.includes(`id="pane-${name}"`), `tab ${id} thiếu pane #pane-${name}`);
    assert.ok(ui.includes(`'pane-${name}'`), `pane #pane-${name} chưa có trong danh sách pane của showView`);
    assert.ok(ui.includes(`['${id}', '${name}']`), `tab ${id} chưa có trong vòng lặp bật/tắt active của showView`);
  }
  // Mỗi tab cũng phải có tiêu đề riêng trong viewInfo, nếu không header hiện sai nội dung.
  for (const name of buttons.map(id => id.slice('view-'.length))) {
    assert.ok(ui.includes(`${name}: ['`), `showView thiếu tiêu đề cho tab ${name}`);
  }
});

