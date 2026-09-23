'use strict';
// ---------------------------------------------------------------------------
// Test bản xem trước hoá đơn A4 (§35): dựng từ XML, tái dùng invoice-html.js,
// và QUAN TRỌNG: dữ liệu trong XML không được lọt ra thành HTML/script (chống XSS).
// Không gọi mạng, không gọi API cổng thuế.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInvoiceA4, buildInvoiceA4Document, toInvoiceShape } = require('../src/data/invoice-a4');
const { parseInvoiceXml } = require('../src/data/xml-parser');

const ITEM = (index, name) => `<HHDVu><TChat>1</TChat><STT>${index}</STT><MHHDVu>MH${index}</MHHDVu><THHDVu>${name}</THHDVu><DVTinh>Thùng</DVTinh><SLuong>2.000000</SLuong><DGia>1000.000000</DGia><STCKhau>0.000000</STCKhau><ThTien>2000.000000</ThTien><TSuat>10%</TSuat></HHDVu>`;

const xml = ({ sellerName = 'CÔNG TY VÍ DỤ NHÀ CUNG CẤP', itemName = 'Hàng ví dụ' } = {}) => `<HDon><DLHDon Id="VIDU"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn giá trị gia tăng</THDon><KHMSHDon>1</KHMSHDon><KHHDon>C26TNT</KHHDon><SHDon>00000001</SHDon><NLap>2026-09-21</NLap><DVTTe>VND</DVTTe><TGia>1.00</TGia><HTTToan>TM/CK</HTTToan><MSTTCGP>0101243150</MSTTCGP><MCCQT>M1-26-ABCDE-00000000001</MCCQT></TTChung><NDHDon><NBan><Ten>${sellerName}</Ten><MST>0100000001</MST><DChi>Số 1 đường ví dụ</DChi></NBan><NMua><Ten>CÔNG TY VÍ DỤ NGƯỜI MUA</Ten><MST>0312345678</MST><DChi>Số 2 đường ví dụ</DChi></NMua><DSHHDVu>${ITEM(1, itemName)}</DSHHDVu></NDHDon><TToan><TgTCThue>2000.000000</TgTCThue><TgTThue>200.000000</TgTThue><TgTTTBSo>2200.000000</TgTTTBSo></TToan></DLHDon></HDon>`;

test('toInvoiceShape: đổi bản ghi XML sang đúng tên trường mà invoice-html.js đọc', () => {
  const { record } = parseInvoiceXml(xml());
  const { inv, detail } = toInvoiceShape(record);
  assert.equal(inv.shdon, '00000001');
  assert.equal(inv.khhdon, 'C26TNT');
  assert.equal(inv.khmshdon, '1');
  assert.equal(inv.nbmst, '0100000001');
  assert.equal(inv.nmten, 'CÔNG TY VÍ DỤ NGƯỜI MUA');
  assert.equal(inv.tdlap, '2026-09-21');
  assert.equal(inv.tgtttbso, 2200);
  assert.equal(detail.nbdchi, 'Số 1 đường ví dụ');
  assert.equal(detail.nmdchi, 'Số 2 đường ví dụ');
  assert.equal(detail.thtttoan, 'TM/CK');
  assert.equal(detail._xmlNlap, '2026-09-21');
  assert.equal(detail._xmlMccqt, 'M1-26-ABCDE-00000000001');
  assert.equal(detail.hdhhdvu.length, 1);
  assert.equal(detail.hdhhdvu[0].ten, 'Hàng ví dụ');
  assert.equal(detail.hdhhdvu[0].dvtinh, 'Thùng');
  assert.equal(detail.hdhhdvu[0].ltsuat, '10%');
  assert.equal(detail.hdhhdvu[0].thtien, 2000);
});

test('buildInvoiceA4: ra HTML có dữ liệu hoá đơn thật (không gọi API)', () => {
  const html = buildInvoiceA4(xml());
  assert.ok(html.length > 1000, 'phải là một tài liệu HTML thật');
  assert.match(html, /00000001/, 'có số hoá đơn');
  assert.match(html, /0100000001/, 'có MST người bán');
  assert.match(html, /CÔNG TY VÍ DỤ NGƯỜI MUA/, 'có tên người mua');
  assert.match(html, /Hàng ví dụ/, 'có tên hàng hoá');
  assert.match(html, /Số 1 đường ví dụ/, 'có địa chỉ người bán');
  assert.match(html, /M1-26-ABCDE-00000000001/, 'có MCCQT từ XML');
});

test('buildInvoiceA4: dữ liệu trong XML KHÔNG được lọt thành thẻ HTML (chống XSS)', () => {
  const html = buildInvoiceA4(xml({ itemName: '<script>alert(1)</script>', sellerName: '<img src=x onerror=alert(2)>' }));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'không được nhét thẳng thẻ script');
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'), 'không được nhét thẳng thẻ img có onerror');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'phải escape thành text');
});

test('buildInvoiceA4Document: thêm viewport + CSS để tờ A4 tự vừa khung xem', () => {
  const doc = buildInvoiceA4Document(xml());
  assert.match(doc, /name="viewport"/);
  assert.ok(doc.includes('id="hd-fit"'), 'phải có khối CSS riêng cho khung xem');
  assert.ok(doc.includes('zoom:'), 'phải thu nhỏ theo bề rộng để không bị che');
  assert.ok(doc.indexOf('id="hd-fit"') < doc.indexOf('</head>'), 'CSS phải nằm trong <head>');
  assert.match(doc, /00000001/, 'vẫn giữ nguyên nội dung hoá đơn');
});

test('buildInvoiceA4: XML lỗi bị từ chối rõ ràng', () => {
  assert.throws(() => buildInvoiceA4(''), /XML rỗng/);
  assert.throws(() => buildInvoiceA4('<html>không phải hoá đơn</html>'), /HDon/);
});
