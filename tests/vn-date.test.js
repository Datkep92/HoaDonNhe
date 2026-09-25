'use strict';
// ---------------------------------------------------------------------------
// NGÀY VIỆT NAM — chống tái phát lỗi lệch MỘT NGÀY.
//
// Lỗi thật: tra cứu 01/08/2026–31/08/2026, cổng thuế trả `tdlap` = "2026-08-30T17:00:00Z"
// (đúng, vì đó là 00:00 ngày 31/08 giờ VN) nhưng file Excel ghi
// "Từ ngày 31/07/2026 đến ngày 30/08/2026" — vì cắt thẳng 10 ký tự đầu của chuỗi UTC.
//
// Bộ quy đổi nằm ở MỘT chỗ: src/vn-date.js. Test này vừa kiểm phép tính, vừa kiểm các đường
// xuất thật (Excel MISA, Excel tổng hợp, HTML hoá đơn, xml-parser) đều dùng chung bộ đó.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vnDate = require('../src/vn-date');
const excel = require('../src/invoice-excel');
const { invoiceHtml } = require('../src/invoice-html');
const XLSX = require('../resources/xlsx.cjs');

test('mốc UTC của cổng thuế → ngày Việt Nam (UTC+7), không lệch một ngày', () => {
  // Ca thật lấy từ job tra cứu: 17:00Z ngày 30/08 chính là 00:00 ngày 31/08 giờ VN.
  assert.equal(vnDate.isoDay('2026-08-30T17:00:00Z'), '2026-08-31');
  assert.equal(vnDate.isoDay('2026-07-31T17:00:00Z'), '2026-08-01');
  assert.equal(vnDate.isoDay('2026-09-20T17:00:00Z'), '2026-09-21');
  // Chưa tới mốc nửa đêm thì vẫn cùng ngày.
  assert.equal(vnDate.isoDay('2026-08-30T16:59:59Z'), '2026-08-30');
  assert.equal(vnDate.isoDay('2026-08-30T17:00:00.000Z'), '2026-08-31');
  assert.equal(vnDate.isoDay('2026-08-30T17:00:00z'), '2026-08-31');
});

test('ngày/giờ KHÔNG kèm múi giờ đã là giờ VN ⇒ giữ nguyên ngày', () => {
  assert.equal(vnDate.isoDay('2026-08-30T17:00:00'), '2026-08-30');
  assert.equal(vnDate.isoDay('2026-08-30 23:30:00'), '2026-08-30');
});

test('múi giờ ghi rõ ±HH:MM thì quy theo MỐC thời gian, không cộng mù 7 giờ', () => {
  assert.equal(vnDate.isoDay('2026-08-30T17:00:00+07:00'), '2026-08-30');
  assert.equal(vnDate.isoDay('2026-08-30T20:00:00+07:00'), '2026-08-30');
  assert.equal(vnDate.isoDay('2026-08-31T00:00:00+02:00'), '2026-08-31');
  assert.equal(vnDate.isoDay('2026-08-30T20:00:00-0400'), '2026-08-31');
});

test('NLap của XML (YYYY-MM-DD) giữ nguyên; giá trị hỏng ⇒ null, không đoán', () => {
  assert.equal(vnDate.isoDay('2026-09-21'), '2026-09-21');
  assert.equal(vnDate.isoDay(''), null);
  assert.equal(vnDate.isoDay(null), null);
  assert.equal(vnDate.isoDay(undefined), null);
  assert.equal(vnDate.isoDay('không-phải-ngày'), null);
  assert.equal(vnDate.isoDay('2026-08'), null);
});

test('dmy: dd/mm/yyyy cho Excel, rỗng khi không đọc được', () => {
  assert.equal(vnDate.dmy('2026-08-30T17:00:00Z'), '31/08/2026');
  assert.equal(vnDate.dmy('2026-08-01'), '01/08/2026');
  assert.equal(vnDate.dmy('không-phải-ngày'), '');
  assert.equal(vnDate.dmy(''), '');
});

test('dayOf: mốc thời gian (Date/số) → ngày VN; nửa đêm VN vẫn là hôm nay', () => {
  // 00:30 giờ VN = 17:30Z hôm trước. Cách cũ (toISOString của giờ địa phương) trả về HÔM TRƯỚC.
  assert.equal(vnDate.dayOf(new Date('2026-08-30T17:30:00Z')), '2026-08-31');
  assert.equal(vnDate.dayOf(new Date('2026-08-30T16:30:00Z')), '2026-08-30');
  assert.equal(vnDate.dayOf(Date.parse('2026-08-30T17:30:00Z')), '2026-08-31');
  assert.equal(vnDate.dayOf(new Date('không-hợp-lệ')), null);
});

test('MỘT chỗ duy nhất: xml-parser dùng lại đúng bộ quy đổi này', () => {
  const { toVietnamDate } = require('../src/data/xml-parser');
  for (const value of ['2026-09-21', '2026-09-20T17:00:00Z', '2026-08-30T17:00:00+07:00', '', 'không-phải-ngày']) {
    assert.equal(toVietnamDate(value), vnDate.isoDay(value), `toVietnamDate lệch với vn-date ở ${JSON.stringify(value)}`);
  }
});

test('Excel mẫu MISA: khoảng ngày và Ngày lập đều theo ngày VN', () => {
  const item = {
    invoice: {
      khmshdon: '1', khhdon: 'C26MNT', shdon: '2947', tdlap: '2026-08-30T17:00:00Z',
      nbmst: '058183000994', nbten: 'HỘ KINH DOANH NHÀ THUỐC', nmmst: '', nmten: 'Bán cho người tiêu dùng',
      tgtcthue: 100, tgtthue: 10, tgtttbso: 110, tgia: 1, dvtte: 'VND', tthai: 1, ttxly: 5
    },
    state: 'queued'
  };
  const buffer = excel.workbook([item], { from: '2026-08-01', to: '2026-08-31' });
  const rows = XLSX.utils.sheet_to_json(XLSX.read(buffer, { type: 'buffer' }).Sheets[excel.SHEET_NAME], { header: 1, raw: true, blankrows: true });
  // sheet_to_json bỏ các dòng trống ĐẦU nên: [0] tiêu đề, [1] khoảng ngày, [2] trống, [3] header, [4] dòng dữ liệu.
  assert.equal(rows[1][0], 'Từ ngày 01/08/2026 đến ngày 31/08/2026', 'khoảng ngày phải đúng như người dùng nhập');
  assert.equal(rows[4][4], '31/08/2026', 'Ngày lập phải là ngày VN (31/08), không phải 30/08 của chuỗi UTC');
});

test('HTML hoá đơn: ngày lập hiện theo giờ VN', () => {
  const html = invoiceHtml({ shdon: '1', khhdon: 'C26MNT', khmshdon: '1' }, { tdlap: '2026-08-30T17:00:00Z', hdon: '01', hdhhdvu: [] });
  assert.ok(html.includes('Ng&agrave;y 31 th&aacute;ng 08 n&abreve;m 2026'), 'phải hiện ngày 31/08 giờ VN');
  assert.ok(!html.includes('Ng&agrave;y 30 th&aacute;ng 08'), 'không được hiện ngày UTC 30/08');
});

test('các đường xuất đều đi qua bộ quy đổi chung, không còn cắt chuỗi UTC', () => {
  const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const server = read('src/server.js');
  assert.ok(server.includes("'Ngày lập': vnDate.dmy(i.tdlap)"), 'Excel tổng hợp phải quy về ngày VN');
  assert.ok(!server.includes("'Ngày lập': String(i.tdlap ?? '')"), 'không được in thẳng chuỗi UTC');
  assert.ok(server.includes('const iso = date => vnDate.dayOf(date)'), 'cửa sổ ngày của Auto Sync phải tính theo ngày VN');
  assert.ok(!server.includes('date.toISOString().slice(0, 10)'), 'không còn lấy ngày bằng toISOString của giờ địa phương');
  assert.ok(read('src/invoice-excel.js').includes('const isoToDmy = value => vnDate.dmy(value)'), 'file MISA phải dùng bộ quy đổi chung');
  assert.ok(read('src/data/excel-export.js').includes('const dmy = value => vnDate.dmy(value)'), 'Excel kho dữ liệu phải dùng cùng một bộ định dạng');
  assert.ok(!/\+ *25200000/.test(read('src/invoice-html.js')), 'HTML không còn tự cộng 7 giờ riêng');
});
