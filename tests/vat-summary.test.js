'use strict';
// ---------------------------------------------------------------------------
// Mục 4.2 — bảng tổng hợp quý để kê khai thuế GTGT.
//
// Trọng tâm của bộ test: KHÔNG CỘNG TRÙNG khi gom theo thuế suất, và KHÔNG im lặng
// khi số liệu là ước lượng. Đã có bản lỗi thật: cộng SUM(tien_truoc_thue) theo dòng
// hàng ra 45.702.636 thay vì 18.132.988.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const { openDatabase } = require(path.join(REPO, 'src', 'data', 'sqlite'));
const repository = require(path.join(REPO, 'src', 'data', 'repository'));
const vat = require(path.join(REPO, 'src', 'data', 'vat-summary'));
const excelExport = require(path.join(REPO, 'src', 'data', 'excel-export'));

// Hóa đơn: nhiều dòng, một hoặc nhiều thuế suất.
// `month` mặc định 2 (thuộc Q1) vì hầu hết test hỏi Quý 1 — dùng nhầm tháng 5 sẽ
// rơi sang Q2 và mọi khẳng định về Q1 đều hỏng mà không rõ nguyên nhân.
let seq = 0;
function seedInvoice(db, { direction, month = 2, day = 5, pretax, tax, total, rates, tthai = '1' }) {
  const key = `k${++seq}`;
  const file = path.join(db.__dir, `${key}.xml`);
  fs.writeFileSync(file, '<HDon/>', 'utf8');
  const record = {
    direction, mstBan: direction === 'SELL' ? '0900000001' : '0100000002', mstMua: '058183000994',
    tenBan: 'A', tenMua: 'B', ngayLap: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    khmsHd: '1', khhHd: 'C26', soHd: key,
    loaiHoaDon: 'Hóa đơn GTGT', tthai, fileXml: file,
    // `total` tách riêng vì hóa đơn KHÔNG CHỊU THUẾ có tong_tien khác 0 trong khi
    // tiền trước thuế và tiền thuế đều bằng 0 — đúng như dữ liệu thật của nhà thuốc.
    tienTruocThue: pretax, tienThue: tax, tongTien: total === undefined ? pretax + tax : total,
    items: rates.map((r, index) => ({ stt: index + 1, maHang: `H${index}`, tenHang: 'Hàng', donVi: 'Cái',
      soLuong: 1, donGia: r.amount, chietKhau: 0, thanhTien: r.amount, thueSuat: r.rate, tienThue: null })),
  };
  repository.insertInvoice(db, record);
  return { key, lines: rates.length };
}

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-test-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  db.__dir = dir;
  return { dir, db };
}

test('một hóa đơn nhiều dòng cùng thuế suất KHÔNG bị cộng nhiều lần', () => {
  const { dir, db } = build();
  try {
    // 1 hóa đơn 3 dòng @8% = 900.000 trước thuế, 72.000 thuế.
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 900000, tax: 72000,
      rates: [{ rate: '8%', amount: 300000 }, { rate: '8%', amount: 300000 }, { rate: '8%', amount: 300000 }] });
    const s = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    const row = s.buyRates.rates.find(r => r.rate === '8%');
    assert.strictEqual(row.invoices, 1, 'một hóa đơn phải đếm là 1');
    assert.strictEqual(row.lines, 3, 'nhưng vẫn đếm đủ 3 dòng hàng');
    assert.strictEqual(row.pretax, 900000, 'tiền trước thuế không được nhân 3');
    assert.strictEqual(row.tax, 72000, 'tiền thuế không được nhân 3');
    assert.strictEqual(s.buy.pretax, 900000);
    assert.strictEqual(s.ratesMatchTotals.buy, true);
    assert.strictEqual(s.buyRates.mixedRateInvoices, 0, 'cùng suất thì không tính là nhiều suất');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hóa đơn nhiều thuế suất: thuế chia theo tỷ trọng tiền hàng và PHẢI CẢNH BÁO', () => {
  const { dir, db } = build();
  try {
    // 8% giá trị 2845454 + 5% giá trị 0 (dòng "không thu tiền") — đúng dữ liệu thật.
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 2845454, tax: 227636,
      rates: [{ rate: '8%', amount: 681818 }, { rate: '8%', amount: 2163636 }, { rate: '5%', amount: 0 }] });
    const s = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    const eight = s.buyRates.rates.find(r => r.rate === '8%');
    const five = s.buyRates.rates.find(r => r.rate === '5%');
    assert.strictEqual(s.buyRates.mixedRateInvoices, 1, 'phải đếm là 1 hóa đơn nhiều mức suất');
    assert.strictEqual(eight.pretax, 2845454);
    assert.strictEqual(eight.tax, 227636, 'dòng 5% có 0 tiền ⇒ toàn bộ thuế về 8%');
    assert.strictEqual(five.tax, 0);
    assert.strictEqual(s.buyRates.totalTax, s.buy.tax, 'tổng thuế theo suất phải bằng tổng hóa đơn');
    assert.ok(s.warnings.some(w => /nhiều mức thuế suất/.test(w)), 'phải cảnh báo đây là ước lượng');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hóa đơn không còn hiệu lực bị loại, và số lượng bị loại phải trả về', () => {
  const { dir, db } = build();
  try {
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 100000, tax: 5000, rates: [{ rate: '5%', amount: 100000 }] });
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 200000, tax: 10000, rates: [{ rate: '5%', amount: 200000 }], tthai: '4' });
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 300000, tax: 15000, rates: [{ rate: '5%', amount: 300000 }], tthai: '6' });
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 400000, tax: 20000, rates: [{ rate: '5%', amount: 400000 }], tthai: '3' });
    const s = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    assert.strictEqual(s.buy.count, 2, 'chỉ còn tthai 1 và 3 (điều chỉnh vẫn có hiệu lực)');
    assert.strictEqual(s.buy.excluded, 2, 'phải BÁO số hóa đơn bị loại');
    assert.strictEqual(s.buy.tax, 25000);
    assert.ok(s.warnings.some(w => /không còn hiệu lực/.test(w)));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hóa đơn bán ra không ghi thuế: nói rõ là KHÔNG CHỊU THUẾ, không phải thiếu dữ liệu', () => {
  const { dir, db } = build();
  try {
    seedInvoice(db, { direction: 'SELL', pretax: 0, tax: 0, total: 315000, rates: [{ rate: '', amount: 315000 }] });
    seedInvoice(db, { direction: 'BUY', pretax: 100000, tax: 5000, rates: [{ rate: '5%', amount: 100000 }] });
    const s = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    assert.strictEqual(s.sell.tax, 0);
    assert.strictEqual(s.sell.total, 315000, 'tổng tiền thanh toán vẫn có');
    assert.strictEqual(s.sellHasTaxableItems, false);
    assert.ok(s.warnings.some(w => /không chịu thuế GTGT/.test(w)), 'phải giải thích số 0');
    // Dòng hàng không ghi thuế suất không được gộp vào mức 0%.
    assert.strictEqual(s.sellRates.rates.length, 0, 'không được bịa mức thuế suất');
    assert.strictEqual(s.sellRates.missing.lines, 1);
    assert.strictEqual(s.sellRates.missing.rate, vat.NO_RATE);
    // Không có thuế suất nào + thuế 0 ⇒ KHÔông kết luận "thuế = 0" như đã biết số.
    assert.strictEqual(s.taxAvailable, true, 'vì chiều mua vào có thuế nên vẫn đủ dữ liệu');
    assert.strictEqual(s.ratesMatchTotals.sell, true, 'hóa đơn không chịu thuế không được báo lệch');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kho trống: không chốt số 0 mà nói rõ chưa có dữ liệu', () => {
  const { dir, db } = build();
  try {
    const s = vat.quarterSummary(db, { year: 2026, quarter: 2 });
    assert.strictEqual(s.buy.count, 0);
    assert.strictEqual(s.sell.count, 0);
    assert.strictEqual(s.taxAvailable, false);
    assert.strictEqual(s.figures.payable, 0);
    assert.ok(s.warnings.some(w => /chưa có hóa đơn nào/.test(w)));
    assert.deepStrictEqual(vat.availablePeriods(db), []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('thuế phải nộp và phần chuyển kỳ sau: âm thì chuyển, không âm ra ngoài tờ khai', () => {
  const pos = vat.computeFigures({
    sell: { tax: 100000 }, buy: { tax: 40000 }, deduction: 0,
  });
  assert.strictEqual(pos.payable, 60000);
  assert.strictEqual(pos.carried, 0);
  assert.strictEqual(pos.hasDeduction, false);

  const neg = vat.computeFigures({
    sell: { tax: 30000 }, buy: { tax: 90000 }, deduction: 0,
  });
  assert.strictEqual(neg.payable, 0, 'thuế phải nộp không được âm');
  assert.strictEqual(neg.carried, 60000);

  const withDeduct = vat.computeFigures({
    sell: { tax: 100000 }, buy: { tax: 40000 }, deduction: 25000,
  });
  assert.strictEqual(withDeduct.payable, 35000);
  assert.strictEqual(withDeduct.hasDeduction, true);
  // Khấu trừ âm thì coi như 0, không làm thuế phải nộp tăng lên.
  const negative = vat.computeFigures({
    sell: { tax: 100000 }, buy: { tax: 40000 }, deduction: -5000,
  });
  assert.strictEqual(negative.deduction, 0);
  assert.strictEqual(negative.payable, 60000);
});

test('khấu trừ nhập tay chạy qua bảng tổng hợp và phải nhắc là số nhập', () => {
  const { dir, db } = build();
  try {
    seedInvoice(db, { direction: 'SELL', day: 5, pretax: 1000000, tax: 100000, rates: [{ rate: '10%', amount: 1000000 }] });
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 500000, tax: 50000, rates: [{ rate: '10%', amount: 500000 }] });
    const before = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    assert.strictEqual(before.figures.payable, 50000);
    assert.ok(before.warnings.some(w => /Chưa nhập số khấu trừ/.test(w)));

    const after = vat.quarterSummary(db, { year: 2026, quarter: 1, deduction: 20000 });
    assert.strictEqual(after.figures.payable, 30000);
    assert.strictEqual(after.figures.deduction, 20000);
    assert.ok(!after.warnings.some(w => /Chưa nhập số khấu trừ/.test(w)));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('quý khác nhau không lẫn số liệu; availablePeriods liệt kê đúng kỳ có dữ liệu', () => {
  const { dir, db } = build();
  try {
    // Q1 = tháng 1..3, Q3 = tháng 7..9. Hóa đơn tháng 4 thuộc Q2 — dùng để chắc chắn
    // bộ lọc kỳ không trôi sang kỳ kề.
    seedInvoice(db, { direction: 'BUY', month: 2, pretax: 100000, tax: 5000, rates: [{ rate: '5%', amount: 100000 }] });
    seedInvoice(db, { direction: 'BUY', month: 3, pretax: 300000, tax: 24000, rates: [{ rate: '8%', amount: 300000 }] });
    seedInvoice(db, { direction: 'BUY', month: 4, pretax: 999000, tax: 99900, rates: [{ rate: '10%', amount: 999000 }] });
    seedInvoice(db, { direction: 'BUY', month: 8, pretax: 700000, tax: 70000, rates: [{ rate: '10%', amount: 700000 }] });
    const q1 = vat.quarterSummary(db, { year: 2026, quarter: 1 });
    const q2 = vat.quarterSummary(db, { year: 2026, quarter: 2 });
    const q3 = vat.quarterSummary(db, { year: 2026, quarter: 3 });
    assert.strictEqual(q1.buy.tax, 29000);
    assert.strictEqual(q2.buy.tax, 99900);
    assert.strictEqual(q3.buy.tax, 70000);
    assert.strictEqual(q1.range.from, '2026-01-01');
    assert.strictEqual(q1.range.to, '2026-03-31');
    assert.strictEqual(q3.range.from, '2026-07-01');
    const periods = vat.availablePeriods(db);
    assert.deepStrictEqual(periods.map(p => p.label), ['Quý 3/2026', 'Quý 2/2026', 'Quý 1/2026']);
    assert.strictEqual(periods[0].invoices, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('năm và quý sai thì ném lỗi rõ ràng, không âm thầm trả số rỗng', () => {
  const { dir, db } = build();
  try {
    assert.throws(() => vat.quarterSummary(db, { year: 2026, quarter: 0 }), /Quý không hợp lệ/);
    assert.throws(() => vat.quarterSummary(db, { year: 2026, quarter: 5 }), /Quý không hợp lệ/);
    assert.throws(() => vat.quarterSummary(db, { year: 1999, quarter: 1 }), /Năm không hợp lệ/);
    assert.throws(() => vat.quarterSummary(db, { year: 'x', quarter: 1 }), /Năm không hợp lệ/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('xuất Excel tổng hợp quý: 4 sheet, có ghi chú và số khấu trừ đánh dấu là số nhập', () => {
  const { dir, db } = build();
  try {
    seedInvoice(db, { direction: 'SELL', day: 5, pretax: 1000000, tax: 100000, rates: [{ rate: '10%', amount: 1000000 }] });
    seedInvoice(db, { direction: 'BUY', day: 5, pretax: 500000, tax: 50000, rates: [{ rate: '10%', amount: 500000 }] });
    const s = vat.quarterSummary(db, { year: 2026, quarter: 1, deduction: 20000 });
    const book = excelExport.vatQuarterWorkbook(s);
    assert.match(book.filename, /^tong-hop-quy-202601\.xlsx$/);

    const XLSX = require(path.join(REPO, 'resources', 'xlsx.cjs'));
    const read = XLSX.read(book.buffer, { type: 'buffer' });
    assert.deepStrictEqual(read.SheetNames, [
      'Tổng hợp Quý 1-2026', 'Bán ra theo thuế suất', 'Mua vào theo thuế suất', 'Ghi chú',
    ]);
    const main = XLSX.utils.sheet_to_json(read.Sheets[read.SheetNames[0]], { header: 1 });
    const flat = main.map(r => r.map(String).join(' | ')).join('\n');
    assert.match(flat, /Doanh thu bán ra/);
    assert.match(flat, /Thuế phải nộp trong kỳ \| 30000/);
    assert.match(flat, /SỐ NHẬP TAY/, 'khấu trừ phải ghi rõ là số nhập');
    // Ghi chú phải chứa cảnh báo ước lượng/loại trừ, không giấu trong ô số.
    const notes = XLSX.utils.sheet_to_json(read.Sheets['Ghi chú'], { header: 1 });
    assert.ok(notes.some(r => String(r[0]) === 'Kỳ tính thuế'));
    assert.ok(notes.some(r => String(r[0]) === 'Hóa đơn loại trừ'));
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('UI: card tổng hợp quý có đủ điều khiển và nối endpoint', () => {
  const root = REPO;
  const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
  for (const id of ['data-vat-card', 'vat-period', 'vat-deduction', 'vat-reload', 'vat-export', 'vat-warnings', 'vat-body']) {
    assert.ok(html.includes(`id="${id}"`), `thiếu phần tử #${id}`);
  }
  assert.ok(html.indexOf('data-vat-card') > html.indexOf('id="pane-data"'), 'card phải nằm trong tab Kho dữ liệu');
  // Không được nhúng style/handler inline (CSP).
  assert.ok(!/<[^>]+\sstyle="/i.test(html), 'index.html không được dùng inline style');

  const ui = fs.readFileSync(path.join(root, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/\$\('vat-period'\)\.onchange/.test(ui));
  assert.ok(/\$\('vat-reload'\)\.onclick/.test(ui));
  assert.ok(/\$\('vat-export'\)\.onclick/.test(ui));
  assert.ok(/\/api\/db\/vat\/quarter/.test(ui), 'UI phải gọi endpoint tổng hợp quý');
  assert.ok(/\/api\/db\/vat\/quarter\.xlsx/.test(ui), 'UI phải gọi endpoint xuất Excel');

  const server = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  assert.ok(/url\.pathname === '\/api\/db\/vat\/quarter'/.test(server));
  assert.ok(/url\.pathname === '\/api\/db\/vat\/quarter\.xlsx'/.test(server));

  // Tổng hợp quý lỗi KHÔNG được làm hỏng phần còn lại của tab (vì nó trong refreshAll).
  assert.ok(/await loadVat\(\)\.catch\(\(\) => \{\}\)/.test(ui), 'lỗi tổng hợp quý phải được nuốt có chủ đích');
});