'use strict';
// ---------------------------------------------------------------------------
// MST cho nhập TỰ DO: không bắt buộc chỉ toàn chữ số, nhận cả dạng có mã chi nhánh
// (8021214462-001), mã có chữ, mã hồ sơ nội bộ.
//
// Nhưng MST vẫn được dùng làm TÊN FILE/THƯ MỤC ở nhiều chỗ dùng chuỗi thô
// (secrets/<mst>.json, jobs/<mst>.json, profiles/<mst>, MST-<mst>/), nên vẫn phải
// chặn ký tự phá đường dẫn. Test này khoá cả hai phía.
// Chạy: npm test
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mstFormat = require('../src/mst-format');
const root = path.resolve(__dirname, '..');

test('nhận đúng các dạng MST người dùng thực tế hay gõ', () => {
  for (const value of [
    '4500677693',          // 10 số
    '8021214462-001',      // MST chi nhánh — yêu cầu trực tiếp của người dùng
    '8021214462-1',        // mã chi nhánh ngắn
    '0011990123456',       // 13 số
    '0331234567-001',      // MST có số 0 đầu
    '001-1',               // mã hồ sơ nội bộ
    'KH001',               // mã có chữ
    'MST_ABC.01',          // có gạch dưới + dấu chấm Ở GIỮA (hợp lệ)
  ]) {
    assert.equal(mstFormat.isValidMst(value), true, `phải nhận: ${value}`);
  }
});

test('CHẶN ký tự phá đường dẫn (MST là tên file/thư mục ở nhiều chỗ dùng chuỗi thô)', () => {
  for (const value of [
    '../../etc/passwd',    // đi ngược thư mục
    'a/b',                 // dấu chéo
    'a\\b',                // dấu chéo ngược (Windows)
    'C:evil',              // dấu hai chấm
    'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b',   // ký tự Windows cấm trong tên file
    'a\u0000b',            // ký tự điều khiển
    '.', '..', 'abc.',     // dấu chấm đuôi (Windows cắt đuôi ⇒ dễ trùng tên)
    'CON', 'prn', 'aux', 'nul', 'COM1', 'lpt9',  // tên dành riêng của Windows
    '',                    // rỗng
    '   ',                 // chỉ khoảng trắng
    'x'.repeat(65),        // quá dài
  ]) {
    assert.equal(mstFormat.isValidMst(value), false, `phải chặn: ${JSON.stringify(value)}`);
  }
});

test('baseMst / mstAliases: bỏ mã chi nhánh để khớp với MST gốc trong XML', () => {
  assert.equal(mstFormat.baseMst('8021214462-001'), '8021214462');
  assert.equal(mstFormat.baseMst('4500677693'), '4500677693');
  assert.deepEqual(mstFormat.mstAliases('8021214462-001'), ['8021214462-001', '8021214462']);
  assert.deepEqual(mstFormat.mstAliases('4500677693'), ['4500677693'], 'không có mã chi nhánh ⇒ chỉ một cách viết');
  // Cổng thuế trả MST gốc nên phải khớp được với hồ sơ có mã chi nhánh.
  assert.ok(mstFormat.mstAliases('8021214462-001').includes('8021214462'));
});

test('server: mọi chỗ kiểm MST dùng bộ định dạng chung, không còn ép toàn chữ số', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes("require('./mst-format')"), 'phải dùng module dùng chung');
  assert.ok(server.includes('function safeMst(mst) { return mstFormat.isValidMst(mst); }'), 'safeMst phải đi qua mstFormat');
  assert.ok(!/function safeMst\(mst\) \{ return \/\^\\d\+\$\//.test(server), 'không được ép MST toàn chữ số');
  assert.ok(!/MST chỉ được gồm chữ số|Nhập MST chỉ gồm chữ số/.test(server), 'không còn thông báo ép chữ số');
  // So khớp phiên phải theo MST GỐC, nếu không hồ sơ "8021214462-001" sẽ bị báo sai phiên.
  assert.ok(server.includes('mstFormat.mstAliases(selected).includes(String(identity.mst))'), 'kiểm MST phải so theo aliases');
  assert.ok(server.includes('accountIdentifiers') && server.includes('...mstFormat.mstAliases(mst)'), 'identifiers phải gồm MST gốc');
});

test('browser: kiểm phiên cũng so theo MST gốc', () => {
  const browser = fs.readFileSync(path.join(root, 'src', 'browser.js'), 'utf8');
  assert.ok(browser.includes('mstFormat.mstAliases(expectedMst).includes(String(account.mst))'), 'phải so theo aliases');
  assert.ok(browser.includes("require('./mst-format')"), 'phải dùng module dùng chung');
});

test('giao diện: nạp mst-format.js, có route tĩnh và khai báo trong pkg.assets', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  assert.ok(/<script src="mst-format\.js"><\/script>/.test(html), 'index.html phải nạp mst-format.js');
  assert.ok(html.indexOf('mst-format.js') < html.indexOf('renderer.js'), 'phải nạp TRƯỚC renderer.js');
  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes("url.pathname === '/mst-format.js'"), 'server phải phục vụ /mst-format.js (nếu không sẽ 404)');
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).pkg.assets;
  assert.ok(assets.includes('src/mst-format.js'), 'phải khai báo trong pkg.assets để EXE có file này');
  // Ô nhập MST không được ép bàn phím số hay cắt độ dài quá ngắn.
  const code = html.match(/id="mst-code"[^>]*/);
  assert.ok(code, 'không tìm thấy ô nhập MST');
  assert.ok(!/inputmode="numeric"/.test(code[0]), 'không được ép inputmode số (chặn gõ dấu gạch nối)');
});

test('renderer: có bản dự phòng nếu mst-format.js không nạp được (không vỡ TypeError)', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.ok(renderer.includes('const MstFormat = window.MstFormat ||'), 'phải có bản dự phòng');
  assert.ok(!renderer.includes('window.MstFormat.isValidMst'), 'không gọi thẳng window.MstFormat (undefined ⇒ TypeError)');
  // Cả hai chỗ kiểm MST trong giao diện đều phải dùng bản dự phòng.
  const uses = renderer.match(/MstFormat\.isValidMst\(/g) || [];
  assert.ok(uses.length >= 2, `còn chỗ chưa dùng bản dự phòng (thấy ${uses.length})`);
});
