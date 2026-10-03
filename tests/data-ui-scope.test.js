'use strict';
// Chống lỗi PHẠM VI trong src/data-ui.js — "X is not defined" lúc chạy.
//
// data-ui.js bọc toàn bộ thân trong MỘT IIFE `(function () { … })();`. Nếu một dòng
// gán sự kiện cấp IIFE mà phần tử đích không có trong index.html, dòng đó ném
// TypeError NGAY tại chỗ ⇒ MỌI thứ khai báo phía dưới không được đăng ký. Đúng lỗi đã
// gặp: các hàm phía dưới báo "is not defined", nút bấm không phản ứng, còn
// `node --check` thì XANH vì cú pháp vẫn đúng.
//
// Hai test dưới chặn đúng lớp lỗi đó:
//   1. mọi id mà data-ui.js chạm tới đều phải có thật trong index.html;
//   2. phần Mục 3 phải gắn sự kiện qua bindOrig() (tự kiểm tra, bỏ qua khi thiếu) chứ
//      không để dòng gán trực tiếp làm chết cả IIFE.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'data-ui.js');
const HTML = path.join(__dirname, '..', 'src', 'index.html');
const source = fs.readFileSync(SRC, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

test('data-ui.js: mọi id mà top-level gán sự kiện đều có trong index.html', () => {
  const ids = [...new Set([...source.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `thiếu id trong index.html: ${missing.join(', ')}`);
});

test('data-ui.js: phần Mục 3 gắn sự kiện qua bindOrig, không gán trực tiếp ở cấp IIFE', () => {
  assert.ok(/function bindOrig\(/.test(source), 'thiếu hàm bindOrig()');
  // Gán trực tiếp cấp IIFE (`$('id').onclick = …`) là thứ làm chết IIFE khi id thiếu.
  const direct = [...source.matchAll(/\$\('(orig-[a-z-]+)'\)\.(?:onclick|onsubmit)\s*=/g)].map(m => m[1]);
  assert.deepEqual(direct, [], `còn gán sự kiện trực tiếp — sửa thành bindOrig(): ${direct.join(', ')}`);
  // Ngược lại: các nút bấm thật sự phải đi qua bindOrig.
  for (const id of ['orig-close', 'orig-detach', 'orig-pick-open', 'orig-pick-portal', 'orig-input-form']) {
    assert.ok(source.includes(`bindOrig('${id}'`), `thiếu bindOrig('${id}')`);
  }
});

test('data-ui.js: hộp thoại bổ sung mã/URL có đủ phần tử như bản tham chiếu', () => {
  for (const id of ['orig-input-dialog', 'orig-input-form', 'orig-input-title', 'orig-input-help',
    'orig-input-label', 'orig-input-value', 'orig-input-error', 'orig-input-submit']) {
    assert.ok(html.includes(`id="${id}"`), `thiếu #${id}`);
  }
  // Phải là <form> + submit để người dùng bấm Enter là gửi được.
  assert.match(html, /<dialog id="orig-input-dialog"[\s\S]*?<form id="orig-input-form"[^>]*>[\s\S]*?type="submit"/,
    'hộp thoại phải có form với nút submit để bấm Enter hoạt động');
  // Hộp thoại bấm bên ngoài không được đóng nhầm khi đang nhập.
  assert.ok(!html.includes('id="orig-input-dialog" class="invoice-dialog" onclick'),
    'không đóng modal bằng onclick ở thẻ ngoài');
});

test('data-ui.js: chỉ hỏi mã tra cứu cho hóa đơn MUA VÀO, không hỏi cho hóa đơn BÁN RA', () => {
  // Hỏi mã cho 72 hóa đơn bán ra là hỏi thừa: cổng nhà cung cấp tra bằng số hóa đơn.
  const body = source.slice(source.indexOf('async function ensureLookupInfo'));
  const end = body.indexOf('\n}');
  const fn = body.slice(0, end);
  assert.ok(/inv\.direction\s*!==\s*'BUY'\)\s*return inv;/.test(fn),
    'phải bỏ qua bước hỏi mã với hóa đơn bán ra');
  assert.ok(fn.includes("requestOrigInput") && fn.includes('lookup_code'), 'phải hỏi mã cho hóa đơn mua vào');
  assert.ok(fn.includes('lookup_url'), 'phải hỏi URL cổng khi thiếu');
});

test('data-ui.js: cột PDF gốc được gắn vào ĐÚNG bảng danh sách hóa đơn', () => {
  const calls = (source.match(/originalCell\(/g) || []).length;
  assert.strictEqual(calls, 2, 'đúng 2 chỗ: định nghĩa + 1 lời gọi trong danh sách');
  assert.ok(html.includes('<th>PDF gốc</th>'), 'thiếu cột PDF gốc trong thead');
  const goodsBlock = source.slice(source.indexOf('loadGoods'), source.indexOf('loadList'));
  assert.ok(!goodsBlock.includes('originalCell('), 'bảng Hàng hóa không được gọi originalCell');
});