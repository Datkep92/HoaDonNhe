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
