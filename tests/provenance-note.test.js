'use strict';
// ---------------------------------------------------------------------------
// Dải cảnh báo nguồn gốc bản in A4 (Mục 1 — khác biệt so với extension tham chiếu).
//
// Bản A4 của ứng dụng dựng lại từ JSON Cổng Thuế, KHÔNG phải PDF của nhà cung cấp.
// Phải in kèm cảnh báo ở MỌI trang, và bản xem trên màn hình không được đổi.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const { buildInvoiceHtml } = require('../src/invoice-html');
const { withProvenanceNote, originNote } = require('../src/data/invoice-a4');

const RED_TEXT = 'KHÔNG PHẢI PDF GỐC NHÀ CUNG CẤP';

function fakeHtml(body = '<div class="print-page">x</div>') {
  return `<html><head><style>.hd-origin{display:none}</style></head><body>${body}</body></html>`;
}

test('originNote: chỉ nhận đúng hai nguồn đã biết, nguồn lạ thì không sinh gì', () => {
  assert.ok(originNote('portal').includes('hd-origin'));
  assert.ok(originNote('portal').includes(RED_TEXT));
  assert.ok(!originNote('portal').includes('hd-origin-ok'));

  assert.ok(originNote('supplier').includes('hd-origin-ok'));
  assert.ok(!originNote('supplier').includes(RED_TEXT));

  // Rỗng / undefined / nguồn không biết ⇒ KHÔNG được bịa dải cảnh báo sai lệch.
  for (const bad of ['', null, undefined, 'portal ', 'khac', 0, {}]) {
    assert.strictEqual(originNote(bad), '', `originNote(${JSON.stringify(bad)}) phải rỗng`);
  }
});

test('withProvenanceNote chèn dải NGAY SAU thẻ <body>', () => {
  const out = withProvenanceNote(fakeHtml(), 'portal');
  // Tìm DẢI (thuộc tính class), không tìm chuỗi 'hd-origin' — chuỗi đó còn xuất hiện
  // trong CSS ở <head>, nằm TRƯỚC <body> và sẽ làm phép so sánh sai.
  const marker = 'class="hd-origin"';
  const afterBody = out.indexOf('>', out.indexOf('<body'));
  assert.ok(out.indexOf(marker) > afterBody, 'dải phải nằm sau <body>');
  assert.ok(out.indexOf(marker) < out.indexOf('<div class="print-page">'),
    'dải phải nằm trước nội dung tờ giấy');
  assert.ok(out.endsWith('</body></html>'), 'phần còn lại của tài liệu phải giữ nguyên');
});

test('withProvenanceNote giữ nguyên tài liệu khi không có <body>', () => {
  const noBody = '<html><head></head></html>';
  // Không có <body> vẫn phải trả về CHỮA DẢI (không được trả nguyên chuỗi rỗng).
  const out = withProvenanceNote(noBody, 'portal');
  assert.ok(out.includes('hd-origin'));
  assert.ok(out.includes(noBody), 'văn bản gốc phải còn nguyên');
});

test('withProvenanceNote trả nguyên chuỗi khi không truyền nguồn', () => {
  const src = fakeHtml();
  assert.strictEqual(withProvenanceNote(src), src);
  assert.strictEqual(withProvenanceNote(src, 'khong-biet'), src);
});

test('CSS: ẩn ngoài media print, hiện + position:fixed trong media print', () => {
  const html = buildInvoiceHtml(
    { hdon: '01', khmshdon: '', khhdon: '', shdon: '', tdlap: '', nbten: '', nbmst: '', nmten: '' },
    {},
    {},
  );
  assert.match(html, /\.hd-origin\{display:none\}/, 'thiếu display:none ngoài print');

  // `position:fixed` là điều kiện để dải LẶP ở mọi trang: khối .main-page có nội dung
  // tràn sang các trang sau, dải tĩnh đặt trước nó chỉ ra trang 1.
  const printBlock = html.slice(html.indexOf('@media print{'), html.indexOf('</style>'));
  assert.match(printBlock, /\.hd-origin\{position:fixed/, 'dải phải position:fixed trong print');
  assert.match(printBlock, /\.hd-origin\{[^}]*display:block/, 'dải phải hiện trong print');
  assert.match(printBlock, /\.hd-origin-ok\{/, 'thiếu biến thể dải xanh cho PDF gốc NCC');
});

test('chèn vào tài liệu thật: có đúng một dải, không lặp, không mất nội dung', () => {
  const html = buildInvoiceHtml(
    { hdon: '01', khmshdon: '1', khhdon: 'C26', shdon: '1', tdlap: '2026-10-01', nbten: 'A', nbmst: '1', nmten: 'B' },
    {},
    {},
  );
  const out = withProvenanceNote(html, 'portal');
  const count = (out.match(/class="hd-origin"/g) || []).length;
  assert.strictEqual(count, 1, 'phải đúng MỘT dải, không lặp');
  assert.ok(out.includes('<div class="print-page">'), 'nội dung tờ giấy phải còn nguyên');
});