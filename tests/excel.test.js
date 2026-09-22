const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('../resources/xlsx.cjs');
const excel = require('../src/invoice-excel');

const TEMPLATE = path.join(__dirname, '..', 'DANH SÁCH HÓA ĐƠN - 2026-09-19T140856.168.xlsx');
const item = (over = {}) => ({
  invoice: {
    khmshdon: '1', khhdon: 'C26TMS', shdon: '509494', tdlap: '2026-08-25', ttxly: 5, tthai: 1,
    nbmst: '0101243150', nbten: 'Công ty A', nmmst: '4500677693', nmten: 'Công ty B', nmdchi: 'Số 1 Hà Nội',
    tgtcthue: 1950000, tgtthue: 0, ttcktmai: 0, tgtttbso: 1950000, tgia: 1, dvtte: 'VND',
    family: 'query', direction: 'purchase', ...over
  },
  state: 'queued', files: []
});
const sheetRows = (buffer, raw = true) => XLSX.utils.sheet_to_json(XLSX.read(buffer, { type: 'buffer' }).Sheets[excel.SHEET_NAME], { header: 1, raw, blankrows: true });

test('header đúng 19 cột và đúng thứ tự của mẫu MISA', () => {
  assert.equal(excel.columnNames().length, 19);
  assert.equal(excel.SHEET_NAME, 'sheet 1');
  assert.equal(excel.TITLE, 'DANH SÁCH HÓA ĐƠN');
  assert.deepEqual(excel.columnNames().slice(0, 5), ['STT', 'Ký hiệu mẫu số', 'Ký hiệu hóa đơn', 'Số hóa đơn', 'Ngày lập']);
  assert.equal(excel.columnNames()[18], 'Kết quả kiểm tra hóa đơn');
});
test('so với file mẫu thật: tiêu đề, khoảng ngày, header, độ rộng cột khớp 100%', t => {
  if (!fs.existsSync(TEMPLATE)) { t.skip('không tìm thấy file mẫu trong project'); return; }
  const template = XLSX.read(fs.readFileSync(TEMPLATE), { type: 'buffer', cellStyles: true });
  const tpl = XLSX.utils.sheet_to_json(template.Sheets[template.SheetNames[0]], { header: 1, blankrows: true });
  assert.equal(template.SheetNames[0], excel.SHEET_NAME, 'tên sheet phải giống mẫu');
  assert.equal(tpl[0][0], excel.TITLE);
  assert.match(tpl[1][0], /^Từ ngày \d{2}\/\d{2}\/\d{4} đến ngày \d{2}\/\d{2}\/\d{4}$/);
  assert.deepEqual(tpl[2], []);
  assert.deepEqual(tpl[3], excel.HEADERS, 'header phải giống mẫu từng chữ và từng thứ tự');
  assert.deepEqual((template.Sheets[template.SheetNames[0]]['!cols'] || []).map(c => c && c.wch), excel.WIDTHS);
  // File do app tạo: cùng cấu trúc dòng (2 dòng trống, tiêu đề, khoảng ngày, trống, header, dữ liệu)
  const mine = sheetRows(excel.workbook([item()], { from: '2026-09-14', to: '2026-09-16' }));
  assert.equal(mine.length, 5);
  assert.deepEqual(mine[0], tpl[0]);
  assert.equal(mine[1][0], 'Từ ngày 14/09/2026 đến ngày 16/09/2026');
  assert.deepEqual(mine[2], []);
  assert.deepEqual(mine[3], tpl[3]);
});
test('giá trị mỗi ô đúng kiểu như mẫu: STT số, ngày text dd/mm/yyyy, tiền số, tỷ giá text', () => {
  const data = sheetRows(excel.workbook([item()], { from: '2026-09-14', to: '2026-09-16' }))[4];
  assert.equal(data[0], 1);
  assert.equal(data[1], '1');
  assert.equal(data[2], 'C26TMS');
  assert.equal(data[3], '509494');
  assert.equal(data[4], '25/08/2026');
  assert.equal(data[5], '0101243150');
  assert.equal(data[7], '4500677693');
  assert.equal(data[10], 1950000);
  assert.equal(data[11], 0);
  assert.equal(data[12], 0);
  assert.equal(data[13], undefined);
  assert.equal(data[14], 1950000);
  assert.equal(data[15], 'VND');
  assert.equal(data[16], '1.0');
  assert.equal(data[17], 'Hóa đơn mới');
  assert.equal(data[18], 'Đã cấp mã hóa đơn');
});
test('map trạng thái/kết quả kiểm tra và các giá trị đặc biệt', () => {
  const row = excel.rowOf(item({ tgia: '23500', ttxly: 6, tthai: 4, tgtphi: 12000 }), 7);
  assert.equal(row[0], 8);
  assert.equal(row[13], 12000);
  assert.equal(row[16], '23500.0');
  assert.equal(row[17], 'Đã bị thay thế');
  assert.equal(row[18], 'Hóa đơn không có mã');
  const empty = excel.rowOf({ invoice: {}, state: 'queued', files: [] }, 0);
  assert.equal(empty.length, 19);
  assert.equal(empty[4], '');
  assert.equal(empty[16], '');
});
test('STT định dạng ô text như mẫu, số dòng dữ liệu = số hóa đơn', () => {
  const buffer = excel.workbook([item(), item({ shdon: '509495' })], { from: '2026-09-14', to: '2026-09-16' });
  const sheet = XLSX.read(buffer, { type: 'buffer', cellStyles: true }).Sheets[excel.SHEET_NAME];
  assert.equal(sheet['A7'].z, '@');
  assert.equal(sheet['A7'].v, 1);
  assert.equal(sheet['A8'].v, 2);
  assert.equal(sheetRows(buffer).length, 6);
});
