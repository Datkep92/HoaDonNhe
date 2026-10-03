'use strict';
// ---------------------------------------------------------------------------
// Mục 2 — tra cứu nhà cung cấp: đọc MSTTCGP + TTTKhac, không bịa cổng, không bỏ sót lý do.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.join(__dirname, '..');
const { parseInvoiceXml, readTTKhac, extractLookup, isLookupUrl } = require(path.join(REPO, 'src', 'data', 'xml-parser'));
const registry = require(path.join(REPO, 'src', 'data', 'provider-registry'));
const { openDatabase, applySchema, schemaVersion } = require(path.join(REPO, 'src', 'data', 'sqlite'));
const repository = require(path.join(REPO, 'src', 'data', 'repository'));
const scanner = require(path.join(REPO, 'src', 'data', 'xml-scanner'));
const excelExport = require(path.join(REPO, 'src', 'data', 'excel-export'));

// Khoá chứa MSTTCGP + TTTKhac tối thiểu, đúng hình dạng XML thật.
// mstBan mặc định là MST TRUNG LẬP (không có trong BY_SELLER_TAX_CODE) để test về
// cổng chung của NCC không bị cổng riêng của người bán chen vào. Test về cổng riêng thì
// truyền mstBan = '0101452595'.
function makeXml({ msttcgp = '', ttKhac = [], mstBan = '0900000001' } = {}) {
  const fields = ttKhac.map(([k, v]) => `<TTin><TTruong>${k}</TTruong><KDLieu>string</KDLieu><DLieu>${v}</DLieu></TTin>`).join('');
  return `<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>123</SHDon>`
    + `<NLap>2026-10-01</NLap><MSTTCGP>${msttcgp}</MSTTCGP><TTKhac>${fields}</TTKhac></TTChung>`
    + `<NDHDon><NBan><Ten>Cty ban</Ten><MST>${mstBan}</MST></NBan>`
    + `<NMua><Ten>Khach</Ten><MST>058183000994</MST></NMua></NDHDon>`
    + `<TToan><TgTCThue>100</TgTCThue><TgTThue>10</TgTThue><TgTTTBSo>110</TgTTTBSo></TToan>`
    + `<HHDVu><STT>1</STT><MHHDVu>A</MHHDVu><THHDVu>Ten hang</THHDVu><DVTinh>Cai</DVTinh>`
    + `<SLuong>1</SLuong><DGia>100</DGia><ThTien>100</ThTien><TSuat>10</TSuat></HHDVu>`
    + `</DLHDon></HDon>`;
}

test('đọc MSTTCGP và tra ra nhà cung cấp + mức năng lực', () => {
  const { record } = parseInvoiceXml(makeXml({ msttcgp: '0101243150' }));
  assert.strictEqual(record.msttcgp, '0101243150');
  assert.strictEqual(record.providerId, 'misa');
  assert.strictEqual(record.providerName, 'MISA meInvoice');
  // Đã KIỂM THẬT: meinvoice.vn là TRANG TRA CỨU có biểu mẫu, không phải endpoint trả
  // PDF thẳng ⇒ mức là portal-assisted, KHÔNG phải supplier-original.
  assert.strictEqual(record.providerLevel, 'portal-assisted');
  // Không có trong XML ⇒ dùng cổng chung của NCC (MISA có cổng dùng chung).
  assert.strictEqual(record.lookupUrl, 'https://www.meinvoice.vn/tra-cuu/');
});

test('MSTTCGP lạ ⇒ KHÔNG bịa tên NCC, không bịa cổng', () => {
  const { record } = parseInvoiceXml(makeXml({ msttcgp: '9999999999' }));
  assert.strictEqual(record.providerId, null);
  assert.strictEqual(record.providerName, null);
  assert.strictEqual(record.providerLevel, null);
  assert.strictEqual(record.lookupUrl, null, 'không được bịa cổng cho MST lạ');
});

test('không có MSTTCGP thì các cột NCC đều null, không đoán', () => {
  const { record } = parseInvoiceXml(makeXml({}));
  for (const key of ['msttcgp', 'lookupCode', 'lookupUrl', 'providerId', 'providerName', 'providerLevel']) {
    assert.strictEqual(record[key], null, `${key} phải null`);
  }
});

test('PortalLink trong TTTKhac được dùng làm cổng tra cứu', () => {
  const { record } = parseInvoiceXml(makeXml({
    msttcgp: '0100684378',
    ttKhac: [['PortalLink', 'https://hoadondientu.ezrx.com.vn']],
  }));
  assert.strictEqual(record.lookupUrl, 'https://hoadondientu.ezrx.com.vn');
  assert.strictEqual(record.providerName, 'VNPT-Invoice');
});

test('URL trong khoá Extra1 chỉ được lấy khi đúng là URL (14/17 giá trị là rác)', () => {
  const { record } = parseInvoiceXml(makeXml({
    msttcgp: '0100684378',
    ttKhac: [['Extra1', 'NSX: MEGA LIFESCIENCES'], ['Extra2', '007/26'], ['Extra1', 'https://dmcmd-tt78admin.vnpt-invoice.com.vn;817501;']],
  }));
  // URL phải được LÀM SẠCH ngay khi đọc XML: `…vn;817501;` để nguyên thì tên miền
  // dính dấu `;` nên URI không mở được, và không khớp kiểm tra `.vn$` khi mở cổng.
  assert.strictEqual(record.lookupUrl, 'https://dmcmd-tt78admin.vnpt-invoice.com.vn');
  assert.strictEqual((record.lookupUrl || '').includes(';'), false, 'không được giữ dấu ;');
  // Mã tra cứu bóc ra từ chính URL kiểu VNPT (;817501;).
  assert.strictEqual(record.lookupCode, '817501');
});

test('cổng thanh toán payoo.vn bị loại, không lọt vào cột tra cứu', () => {
  const { record } = parseInvoiceXml(makeXml({
    msttcgp: '0105232093',
    ttKhac: [['ZUEQRURL', 'https://payoo.vn/v2/paynow/prepare?_token=abc']],
  }));
  assert.strictEqual(record.lookupUrl, 'https://tracuuhoadon1.xcyber.vn/#/tracuuhoadon/tracuu',
    'phải rơi về cổng chung của NCC, không dùng URL payoo');
  assert.strictEqual((record.lookupUrl || '').includes('payoo'), false);
});

test('mã tra cứu lấy theo thứ tự MaTraCuu → Fkey → SearchKey', () => {
  const withCode = key => parseInvoiceXml(makeXml({ msttcgp: '0105232093', ttKhac: [[key, 'CODE123']] })).record.lookupCode;
  assert.strictEqual(withCode('MaTraCuu'), 'CODE123');
  assert.strictEqual(withCode('Fkey'), 'CODE123');
  assert.strictEqual(withCode('SearchKey'), 'CODE123');
  // Cả ba cùng lúc ⇒ MaTraCuu thắng.
  const all = parseInvoiceXml(makeXml({
    msttcgp: '0105232093',
    ttKhac: [['SearchKey', 'C'], ['Fkey', 'B'], ['MaTraCuu', 'A']],
  })).record.lookupCode;
  assert.strictEqual(all, 'A');
});

test('VNPT: cổng riêng theo người bán thắng, không dùng cổng chung', () => {
  // Cổng chung của VNPT KHÔNG tồn tại trong bảng (mỗi khách một tenant) — nên khi không
  // có URL trong XML thì phải trống, không trả về một cổng VNPT bất kỳ.
  assert.strictEqual(registry.resolve('0100684378').portalUrl, '', 'VNPT không được có cổng chung');
  assert.strictEqual(registry.resolve('0100109106').portalUrl, '', 'Viettel không được có cổng chung');
  const unknownSeller = parseInvoiceXml(makeXml({ msttcgp: '0100684378' })).record;
  assert.strictEqual(unknownSeller.lookupUrl, null, 'người bán lạ + VNPT ⇒ để trống');
  // Người bán có trong bảng thì dùng tenant riêng của họ.
  const knownSeller = parseInvoiceXml(makeXml({ msttcgp: '0100684378', mstBan: '0101452595' })).record;
  assert.strictEqual(knownSeller.lookupUrl, registry.sellerPortal('0101452595'));
  assert.strictEqual(knownSeller.lookupUrl, 'https://cpnamduoc-tt78.vnpt-invoice.com.vn/Portal/Index/');
  // Cổng riêng bị đè bởi URL thật trong XML.
  const withXmlUrl = parseInvoiceXml(makeXml({
    msttcgp: '0100684378', mstBan: '0101452595', ttKhac: [['PortalLink', 'https://sai-cu-the-chi.xml.vn']],
  })).record;
  assert.strictEqual(withXmlUrl.lookupUrl, 'https://sai-cu-the-chi.xml.vn', 'URL trong XML phải thắng cổng riêng');
});

test('isLookupUrl: chỉ nhận http(s) có host, loại host không phải cổng tra cứu', () => {
  assert.equal(isLookupUrl('https://tracuu.easyinvoice.vn/'), true);
  assert.equal(isLookupUrl('http://0304628149hd.easyinvoice.vn'), true);
  assert.equal(isLookupUrl('https://payoo.vn/v2/paynow/prepare?_token=x'), false);
  assert.equal(isLookupUrl('http://www.w3.org/2000/09/xmldsig#'), false);
  assert.equal(isLookupUrl('007/26'), false);
  assert.equal(isLookupUrl('NSX: MEGA LIFESCIENCES'), false);
  assert.equal(isLookupUrl(''), false);
  assert.equal(isLookupUrl(null), false);
  assert.equal(isLookupUrl('https://'), false, 'URL không có host thì loại');
});

test('readTTKhac giữ được nhiều khối và giá trị rỗng', () => {
  const pairs = readTTKhac('<TTKhac><TTin><TTruong>A</TTruong><KDLieu>string</KDLieu><DLieu>1</DLieu></TTin></TTKhac>'
    + '<TTKhac><TTin><TTruong>B</TTruong><KDLieu>string</KDLieu><DLieu></DLieu></TTin></TTKhac>');
  assert.deepStrictEqual(pairs, [['A', '1'], ['B', '']]);
  assert.deepStrictEqual(readTTKhac(''), []);
});

test('reasonMissing luôn trả lời được, không im lặng', () => {
  for (const args of [
    ['', '', ''],
    ['9999999999', '', ''],
    ['0101243150', '', 'https://x.vn'],
    ['0101243150', 'CODE', ''],
    ['0100684378', 'CODE', 'https://x.vn'],
  ]) {
    const reason = registry.reasonMissing(...args);
    assert.ok(typeof reason === 'string' && reason.length > 10,
      `reasonMissing(${JSON.stringify(args)}) phải có lý do cụ thể`);
  }
  assert.match(registry.reasonMissing('9999999999', '', ''), /Chưa biết nhà cung cấp/);
  assert.match(registry.reasonMissing('0101243150', '', 'https://x.vn'), /không có mã tra cứu/);
});

// ---------------------------------------------------------------- DB + Excel
function buildDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muc2-test-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  return { dir, db };
}

test('migration thêm đủ 6 cột, chạy lại không đổi, và không mất hoá đơn', () => {
  const { dir, db } = buildDb();
  try {
    const again = applySchema(db);
    assert.strictEqual(again.changed, false, 'DB mới đã ở version hiện tại');
    const cols = db.prepare('PRAGMA table_info(invoices)').all().map(r => r.name);
    for (const col of ['msttcgp', 'lookup_code', 'lookup_url', 'provider_id', 'provider_name', 'provider_level']) {
      assert.ok(cols.includes(col), `thiếu cột ${col}`);
    }
    assert.ok(schemaVersion(db) >= 12);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('vòng nhập lưu đủ 6 cột tra cứu; backfill là idempotent và bỏ qua dòng đã có', async () => {
  const { dir, db } = buildDb();
  try {
    const xmlDir = path.join(dir, 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    const file = path.join(xmlDir, 'hd1.xml');
    fs.writeFileSync(file, makeXml({ msttcgp: '0101243150', ttKhac: [['MaTraCuu', 'MK123']] }), 'utf8');
    const record = { ...parseInvoiceXml(fs.readFileSync(file, 'utf8')).record, direction: 'BUY', fileXml: file };
    repository.insertInvoice(db, record);
    const row = db.prepare('SELECT * FROM invoices').get();
    assert.strictEqual(row.msttcgp, '0101243150');
    assert.strictEqual(row.lookup_code, 'MK123');
    assert.strictEqual(row.lookup_url, 'https://www.meinvoice.vn/tra-cuu/');
    assert.strictEqual(row.provider_id, 'misa');
    assert.strictEqual(row.provider_level, 'portal-assisted');

    // backfill không có ứng viên vì dòng đã có đủ dữ liệu ⇒ chạy lại vẫn rỗng.
    const back = await scanner.backfillProviderLookup({ db, mstDir: dir });
    assert.strictEqual(back.candidates, 0);
    assert.strictEqual(back.updated, 0);
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM invoices').get().n, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backfill điền dữ liệu cho dòng cũ, và giữ nguyên khi file XML đã mất', async () => {
  const { dir, db } = buildDb();
  try {
    // Dòng nhập tay, không qua parser ⇒ các cột tra cứu NULL.
    const good = path.join(dir, 'a.xml');
    const gone = path.join(dir, 'khong-co-that.xml');
    fs.writeFileSync(good, makeXml({ msttcgp: '0105232093', ttKhac: [['PortalLink', 'https://tracuuhoadon1.xcyber.vn/']] }), 'utf8');
    const base = { ...parseInvoiceXml(fs.readFileSync(good, 'utf8')).record, direction: 'BUY' };
    db.prepare(`INSERT INTO invoices (invoice_key, direction, mst_ban, mst_mua, ten_ban, ten_mua, ngay_lap,
        khms_hd, khh_hd, so_hd, loai_hoa_don, tthai, payment_method_raw, payment_method,
        tien_truoc_thue, tien_thue, tong_tien, file_xml, created_at, updated_at)
      VALUES ('k1','BUY','0101452595','058183000994','A','B','2026-10-01','1','C26','1',NULL,'1','CK','TRANSFER',100,10,110,?, 'x','x')`).run(good);
    db.prepare(`INSERT INTO invoices (invoice_key, direction, mst_ban, mst_mua, ten_ban, ten_mua, ngay_lap,
        khms_hd, khh_hd, so_hd, loai_hoa_don, tthai, payment_method_raw, payment_method,
        tien_truoc_thue, tien_thue, tong_tien, file_xml, created_at, updated_at)
      VALUES ('k2','BUY','0101452595','058183000994','A','B','2026-10-02','1','C26','2',NULL,'1','CK','TRANSFER',100,10,110,?, 'x','x')`).run(gone);

    const back = await scanner.backfillProviderLookup({ db, mstDir: dir });
    assert.strictEqual(back.candidates, 2);
    assert.strictEqual(back.updated, 1, 'chỉ dòng còn file XML mới điền được');
    assert.strictEqual(back.missing, 1, 'dòng mất file phải được đếm riêng, không ghi rỗng');
    assert.ok(base);

    const filled = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get('k1');
    assert.strictEqual(filled.provider_id, 'cyberbill');
    assert.strictEqual(filled.lookup_url, 'https://tracuuhoadon1.xcyber.vn/');
    const kept = db.prepare('SELECT * FROM invoices WHERE invoice_key = ?').get('k2');
    assert.strictEqual(kept.provider_id, null, 'không có file ⇒ giữ NULL, không đoán');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Excel: cột cổng tra cứu + hyperlink bấm được; KHÔNG còn sheet tra cứu riêng', () => {
  const { dir, db } = buildDb();
  try {
    const file = path.join(dir, 'x.xml');
    fs.writeFileSync(file, makeXml({ msttcgp: '0100684378', ttKhac: [['PortalLink', 'https://hoadondientu.ezrx.com.vn']] }), 'utf8');
    repository.insertInvoice(db, { ...parseInvoiceXml(fs.readFileSync(file, 'utf8')).record, direction: 'BUY', fileXml: file });

    const book = excelExport.buildWorkbook(db, {}, null);
    // Sheet tra cứu NCC đã bỏ — cột link vẫn giữ trong sheet hóa đơn để đưa cho kế toán.
    assert.ok(!book.parts.includes('lookup'), 'không được còn sheet tra cứu NCC');
    assert.ok(!('lookup' in book.counts));

    const XLSX = require(path.join(REPO, 'resources', 'xlsx.cjs'));
    const read = XLSX.read(book.buffer, { type: 'buffer' });
    const buy = XLSX.utils.sheet_to_json(read.Sheets['Hóa đơn mua vào'], { header: 1 });
    assert.strictEqual(buy[0][buy[0].length - 1], 'Cổng tra cứu NCC');
    assert.strictEqual(buy[1][buy[1].length - 1], 'https://hoadondientu.ezrx.com.vn');

    const linked = Object.keys(read.Sheets['Hóa đơn mua vào'])
      .filter(k => /^L\d+$/.test(k) && read.Sheets['Hóa đơn mua vào'][k].l);
    assert.ok(linked.length, 'ô cổng tra cứu phải bấm được');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
