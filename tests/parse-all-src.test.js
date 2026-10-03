'use strict';
// MỌI FILE NGUỒN PHẢI PARSE ĐƯỢC — bắt lớp lỗi mà lệnh build bỏ lọt.
//
// Vì sao cần: `dvt-converter.js` từng khai `normalizeTenHang` trùng với phần import,
// gây SyntaxError ⇒ cả module không nạp được ⇒ tính năng DVT chết âm thầm. Lệnh build chỉ
// in cảnh báo Babel rồi vẫn xuất EXE và báo "đủ 56/56 file", còn `npm test` cũng xanh vì
// không test nào nạp file đó. Đây là kiểu hỏng nguy hiểm nhất: xanh giả.
//
// Dùng `vm.Script` thay vì `node --check` từng tiến trình: cùng kết luận nhưng nhanh hơn
// nhiều lần, không sinh tiến trình. PHẢI bọc trong khung CommonJS vì file của Node cho
// phép `return` ở cấp cao nhất — `vm.Script` trần sẽ báo "Illegal return statement".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..');
const ROOTS = ['src', 'tools'];
const SKIP_DIR = new Set(['node_modules', 'vendor']);
// Khung CommonJS của Node: (function (exports, require, module, __filename, __dirname) { … })
const CJS_WRAPPER = body => `(function (exports, require, module, __filename, __dirname) {${body}\n})`;

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      collect(path.join(dir, entry.name), out);
    } else if (/\.(js|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('mọi file .js/.cjs trong src và tools đều parse được', () => {
  const files = ROOTS.flatMap(root => collect(path.join(REPO, root)));
  assert.ok(files.length > 40, `số lượng file có vẻ lạ: ${files.length}`);
  const broken = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    try {
      // Node TỰ bỏ dòng shebang (`#!/usr/bin/env node`) trước khi biên dịch, còn `vm.Script`
      // thì không — đặt shebang vào trong thân hàm sẽ thành "Invalid or unexpected token".
      const withoutShebang = source.replace(/^#![^\n]*/, '');
      new vm.Script(CJS_WRAPPER(withoutShebang), { filename: file });
    } catch (error) {
      if (error instanceof SyntaxError) broken.push(`${path.relative(REPO, file)}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], `file không parse được:\n${broken.join('\n')}`);
});

test('mọi file trong src/data nạp được thật (require không ném)', () => {
  // Parse OK chưa đủ: require sai đường dẫn hay dùng hàm không tồn tại chỉ chết lúc CHẠY.
  const dir = path.join(REPO, 'src', 'data');
  const files = fs.readdirSync(dir).filter(name => /\.js$/.test(name) && name !== 'index.js');
  const broken = [];
  for (const name of files) {
    try {
      require(path.join(dir, name));
    } catch (error) {
      broken.push(`${name}: ${error.message}`);
    }
  }
  assert.deepEqual(broken, [], `module src/data không nạp được:\n${broken.join('\n')}`);
});

test('dvt-converter: hàm chuẩn hoá tên hàng phải dùng được, không phải undefined', () => {
  // Lỗi gốc: `require('./mst-format').normalizeTenHang` — mst-format KHÔNG export hàm đó
  // ⇒ ten_chuan ghi vào kho thành chuỗi "undefined". Test này khoá lại đúng điều đó.
  const dvt = require(path.join(REPO, 'src', 'data', 'dvt-converter'));
  const mstFormat = require(path.join(REPO, 'src', 'mst-format'));
  assert.ok(!('normalizeTenHang' in mstFormat),
    'nếu mst-format đã export normalizeTenHang thì phải dùng hàm đó, đừng để hai bản khác nhau');
  assert.strictEqual(typeof dvt.normalizeTenHang, 'function', 'dvt-converter phải export hàm này');
  assert.strictEqual(dvt.normalizeTenHang('  café   sữa  '), 'CAFÉ SỮA');
  assert.strictEqual(dvt.normalizeTenHang(''), '');
  assert.strictEqual(dvt.normalizeTenHang(null), '');
});