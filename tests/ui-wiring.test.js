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
  const busyAt = body.indexOf('if (state.busy) return;');
  assert.ok(stopAt > -1, 'phải có nhánh dừng');
  assert.ok(body.includes("work('/api/pause'"), 'nhánh dừng phải gọi /api/pause');
  assert.ok(pendingAt > stopAt, 'guard pending phải nằm SAU nhánh dừng, nếu không bấm Ngưng bị nuốt');
  assert.ok(busyAt > stopAt, 'guard state.busy cũng phải nằm sau nhánh dừng');
});

test('menu "Xuất Excel": Tải toàn bộ + 3 nhóm (Hóa đơn / Hàng hóa / Đối tác), mỗi nhóm 2 mục con', () => {
  // Yêu cầu: bấm Xuất Excel ra "Tải toàn bộ", rồi các nhóm có mục con
  // Hóa đơn -> Mua vào/Bán ra, Hàng hóa -> Mua vào/Bán ra, Đối tác -> Nhà cung cấp/Khách hàng.
  const listAt = html.indexOf('id="data-export-list"');
  assert.ok(listAt > -1, 'không tìm thấy menu xuất Excel');
  assert.ok(html.indexOf('data-part="all"') > listAt, 'phải có nút "Tải toàn bộ" trong menu');

  // Các nhóm nằm SAU phần tử menu (không có nơi nào khác trong trang dùng class "group").
  const groups = [...html.matchAll(/<details class="group"><summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g)];
  assert.equal(groups.length, 3, 'phải có đúng 3 nhóm');
  assert.ok(html.indexOf(groups[0][0]) > listAt, 'nhóm phải nằm TRONG menu xuất Excel');
  assert.deepEqual(groups.map(g => g[1]), ['Hóa đơn', 'Hàng hóa', 'Đối tác']);
  const expected = { 'Hóa đơn': ['buy', 'sell'], 'Hàng hóa': ['productsBuy', 'productsSell'], 'Đối tác': ['suppliers', 'buyers'] };
  for (const [, name, body] of groups) {
    const parts = [...body.matchAll(/data-part="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(parts, expected[name], `nhóm "${name}" sai mục con`);
  }

  // Mọi mã bảng trong HTML phải là mã module xuất Excel hiểu được ('all' = xuất tất cả).
  const known = [...html.matchAll(/data-part="(\w+)"/g)].map(m => m[1]);
  for (const part of known) assert.ok(part === 'all' || excelExport.PARTS.includes(part), `mã bảng lạ: ${part}`);
  assert.equal(known.length, 7, 'tổng 7 lựa chọn (tất cả + 6 mục con)');

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
