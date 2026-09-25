'use strict';
// ---------------------------------------------------------------------------
// Test PHASE 2 – XML Data Engine (PROJECT_ARCHITECTURE §69: Test 4–9, §71).
//
// XML trong test được SINH TẠI CHỖ với dữ liệu giả (không dùng XML thật của người dùng,
// vì repo là công khai) nhưng giữ đúng cấu trúc thẻ của hoá đơn TCT thực tế:
// TTChung / NBan / NMua(+HVTNMHang) / DSHHDVu-HHDVu / TToan / Signature / MCCQT.
// Không gọi mạng. Chạy: npm test
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseInvoiceXml, buildImportRecord, detectDirection, toVietnamDate } = require('../src/data/xml-parser');
const { scanXmlFolder, listMstXmlFiles } = require('../src/data/xml-scanner');
const { createXmlWatcher } = require('../src/data/xml-watcher');
const { runImport } = require('../src/data/xml-import');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { findInvoiceByKey, countInvoices, countItems, itemsOfInvoice } = require('../src/data/repository');

const MST = '0312345678';
const OTHER = '0100000001';

const sampleItem = (index, over = {}) => {
  const value = {
    ma: `MH${index}`, ten: `Hàng ví dụ ${index}`, dv: 'Chai',
    sl: '10.000000', dg: '1000.000000', ck: '0.000000', tt: '10000.000000', ts: '10%', ...over,
  };
  return `<HHDVu><TChat>1</TChat><STT>${index}</STT><MHHDVu>${value.ma}</MHHDVu><THHDVu>${value.ten}</THHDVu><DVTinh>${value.dv}</DVTinh><SLuong>${value.sl}</SLuong><DGia>${value.dg}</DGia><TLCKhau>0.0000</TLCKhau><STCKhau>${value.ck}</STCKhau><ThTien>${value.tt}</ThTien><TSuat>${value.ts}</TSuat><TTKhac><TTin><TTruong>Amount</TTruong><KDLieu>numeric</KDLieu><DLieu>${value.tt}</DLieu></TTin></TTKhac></HHDVu>`;
};

function buildXml(options = {}) {
  const sellerMst = options.sellerMst === undefined ? OTHER : options.sellerMst;
  const buyerMst = options.buyerMst === undefined ? MST : options.buyerMst;
  const khmshDon = options.khmshDon || '1';
  const khhDon = options.khhDon || 'C26TNT';
  const shDon = options.shDon || '00075757';
  const nlap = options.nlap || '2026-09-21';
  const mccqt = options.mccqt || '';
  const items = options.items || [sampleItem(1), sampleItem(2)];
  const buyer = options.buyerNoMst
    ? '<NMua><HVTNMHang>Bán cho người tiêu dùng</HVTNMHang></NMua>'
    : `<NMua><Ten>CÔNG TY VÍ DỤ NGƯỜI MUA</Ten><MST>${buyerMst}</MST><DChi>Địa chỉ ví dụ</DChi></NMua>`;
  return `<HDon><DLHDon Id="VIDU01"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn giá trị gia tăng</THDon>` +
    `<KHMSHDon>${khmshDon}</KHMSHDon><KHHDon>${khhDon}</KHHDon><SHDon>${shDon}</SHDon><NLap>${nlap}</NLap>` +
    `<DVTTe>VND</DVTTe><TGia>1.00</TGia><HTTToan>TM/CK</HTTToan><HDCTTChinh>0</HDCTTChinh>` +
    `<TTKhac><TTin><TTruong>ListStockName</TTruong><KDLieu>string</KDLieu><DLieu>Kho ví dụ</DLieu></TTin></TTKhac>` +
    `${mccqt ? `<MCCQT>${mccqt}</MCCQT>` : ''}</TTChung><NDHDon>` +
    `<NBan><Ten>CÔNG TY VÍ DỤ NHÀ CUNG CẤP &amp; ĐỐI TÁC</Ten><MST>${sellerMst}</MST><DChi>Địa chỉ ví dụ</DChi></NBan>` +
    `${buyer}<DSHHDVu>${items.join('')}</DSHHDVu></NDHDon>` +
    `<TToan><TgTCThue>20000.000000</TgTCThue><TgTThue>2000.000000</TgTThue><TgTTTBSo>22000.000000</TgTTTBSo></TToan>` +
    `</DLHDon><Signature><SignatureValue>GIA_LAP</SignatureValue></Signature></HDon>`;
}

async function withScannerDir(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-xml-'));
  const dir = path.join(root, `MST-${MST}`);
  for (const folder of ['Mua_vao', 'Ban_ra']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    return await fn({ root, dir, db });
  } finally {
    closeDatabase(db);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const write = (dir, folder, name, content) => {
  const file = path.join(dir, folder, name);
  // Tạo thư mục cha: test quét đệ quy ghi vào Mua_vao/xml/ (layout cũ) mà thư mục con chưa có.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

test('Test 6 – BUY: NMua/MST trùng MST hiện tại ⇒ Mua vào', async () => {
  const { record, warnings } = parseInvoiceXml(buildXml({ buyerMst: MST, sellerMst: OTHER }));
  assert.equal(detectDirection(record, MST), 'BUY');
  assert.equal(record.mstBan, OTHER);
  assert.equal(record.mstMua, MST);
  assert.equal(record.tenBan, 'CÔNG TY VÍ DỤ NHÀ CUNG CẤP & ĐỐI TÁC', 'giải mã &amp; trong tên');
  assert.equal(record.ngayLap, '2026-09-21');
  assert.equal(record.khmsHd, '1');
  assert.equal(record.khhHd, 'C26TNT');
  assert.equal(record.soHd, '00075757', 'giữ nguyên SHDon của XML');
  assert.equal(record.loaiHoaDon, 'Hóa đơn giá trị gia tăng');
  assert.equal(record.tienTruocThue, 20000);
  assert.equal(record.tienThue, 2000);
  assert.equal(record.tongTien, 22000);
  assert.equal(record.items.length, 2);
  assert.equal(record.items[0].maHang, 'MH1');
  assert.equal(record.items[0].tenHang, 'Hàng ví dụ 1');
  assert.equal(record.items[0].donVi, 'Chai');
  assert.equal(record.items[0].soLuong, 10);
  assert.equal(record.items[0].donGia, 1000);
  assert.equal(record.items[0].chietKhau, 0);
  assert.equal(record.items[0].thanhTien, 10000);
  assert.equal(record.items[0].thueSuat, '10%');
  assert.equal(record.items[0].tienThue, null, 'TThue không có trong dữ liệu thật ⇒ để trống');
  assert.deepEqual(warnings, []);
});

test('Test 7 – SELL: NBan/MST trùng MST hiện tại, NMua không có MST', async () => {
  const { record } = parseInvoiceXml(buildXml({ sellerMst: MST, buyerNoMst: true, khhDon: 'C26MTH', shDon: '00006423', mccqt: 'M1-26-RV9YX-00002006573' }));
  assert.equal(detectDirection(record, MST), 'SELL');
  assert.equal(record.mstBan, MST);
  assert.equal(record.mstMua, null, 'không có MST người mua thì để trống, KHÔNG đoán');
  assert.equal(record.tenMua, 'Bán cho người tiêu dùng', 'đọc HVTNMHang khi không có Ten');
});

test('một hồ sơ nhận diện nhiều CCCD/MST khi xác định chiều hóa đơn', async () => {
  const identifiers = [MST, '4500002040', '058168003130'];
  const sold = parseInvoiceXml(buildXml({ sellerMst: '4500002040', buyerNoMst: true })).record;
  const bought = parseInvoiceXml(buildXml({ sellerMst: OTHER, buyerMst: '058168003130' })).record;
  assert.equal(detectDirection(sold, identifiers), 'SELL');
  assert.equal(detectDirection(bought, identifiers), 'BUY');
});

test('Test 8 – XML không xác định được hướng ⇒ UNKNOWN, không đoán', async () => {
  const { record } = parseInvoiceXml(buildXml({ sellerMst: '0100000009', buyerMst: '0100000008' }));
  assert.equal(detectDirection(record, MST), 'UNKNOWN');
  assert.throws(() => buildImportRecord(buildXml({ sellerMst: '0100000009', buyerMst: '0100000008' }), { currentMst: MST, fileXml: 'x.xml' }), error => error.unknownDirection === true);
});

test('khoá hoá đơn §13: XML 00075757 và API 75757 cho cùng khoá', async () => {
  const fromXml = buildImportRecord(buildXml({ shDon: '00075757' }), { currentMst: MST, fileXml: 'a.xml' });
  const other = buildImportRecord(buildXml({ shDon: '75757' }), { currentMst: MST, fileXml: 'b.xml' });
  assert.equal(fromXml.record.invoiceKey, `${OTHER}|1|C26TNT|75757`);
  assert.equal(fromXml.record.invoiceKey, other.record.invoiceKey);
  assert.ok(!fromXml.record.invoiceKey.includes('.xml'));
});

test('XML lỗi / rỗng bị từ chối rõ ràng', async () => {
  assert.throws(() => parseInvoiceXml(''), /XML rỗng/);
  assert.throws(() => parseInvoiceXml('<html><body>không phải hoá đơn</body></html>'), /thiếu thẻ HDon/);
});

test('ngày: NLap giữ nguyên, tdlap UTC quy về ngày Việt Nam', async () => {
  assert.equal(toVietnamDate('2026-09-21'), '2026-09-21');
  assert.equal(toVietnamDate('2026-09-20T17:00:00Z'), '2026-09-21', 'UTC+7 → cùng ngày với NLap của XML');
  assert.equal(toVietnamDate(''), null);
  assert.equal(toVietnamDate('không-phải-ngày'), null);
});

test('Test 1/2/3 – quét thư mục: import đủ, chạy lại thì bỏ qua, file trùng khoá bị chặn', async () => {
  await withScannerDir(async ({ dir, db }) => {
    write(dir, 'Mua_vao', 'buy-01.xml', buildXml({ khhDon: 'C26TNT', shDon: '00075757' }));
    const first = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(first.imported, 1);
    assert.equal(first.items, 2);
    assert.equal(countInvoices(db), 1);
    assert.equal(countItems(db), 2);

    // Chạy lại: file đã import ⇒ bỏ qua, KHÔNG nhân bản (mục 19)
    const second = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1);
    assert.equal(countInvoices(db), 1);

    // Test 4/5: cùng hoá đơn nhưng ĐỔI TÊN file ⇒ vẫn không tạo bản ghi thứ hai
    write(dir, 'Mua_vao', 'doi-ten-hoan-toan.xml', buildXml({ khhDon: 'C26TNT', shDon: '75757' }));
    const third = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(third.imported, 0);
    assert.equal(third.duplicates, 1);
    assert.equal(countInvoices(db), 1);
    assert.equal(countItems(db), 2);
  });
});

test('XML cùng đường dẫn thay đổi thì UPSERT hóa đơn và dòng hàng', async () => {
  await withScannerDir(async ({ dir, db }) => {
    const file = write(dir, 'Mua_vao', 'thay-doi.xml', buildXml({ items: [sampleItem(1)] }));
    const first = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(first.imported, 1);
    assert.equal(countItems(db), 1);

    fs.writeFileSync(file, buildXml({ items: [sampleItem(1), sampleItem(2), sampleItem(3)] }));
    const second = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(second.updated, 1);
    assert.equal(second.duplicates, 0);
    assert.equal(countInvoices(db), 1);
    assert.equal(countItems(db), 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM imported_files WHERE file_path = ?').get(file).c, 2);
  });
});

test('scanner nhập XML khớp MST bổ sung vào kho của MST chính', async () => {
  await withScannerDir(async ({ dir, db }) => {
    write(dir, 'Mua_vao', 'cccd-phu.xml', buildXml({ buyerMst: '058168003130', shDon: '00000888' }));
    const result = await scanXmlFolder({ db, mst: MST, identifiers: [MST, '4500002040', '058168003130'], mstDir: dir });
    assert.equal(result.imported, 1);
    assert.equal(result.errors, 0);
    assert.equal(db.prepare('SELECT direction FROM invoices').get().direction, 'BUY');
  });
});

test('watcher chỉ nhận sự kiện XML nằm trong thư mục MST', () => {
  const watcher = createXmlWatcher();
  assert.equal(watcher.mstFromFilename('MST-0312345678\\Mua_vao\\a.xml'), MST);
  assert.equal(watcher.mstFromFilename('MST-0312345678/Ban_ra/a.XML'), MST);
  assert.equal(watcher.mstFromFilename('MST-0312345678/data.db'), '');
  assert.equal(watcher.mstFromFilename('khac/a.xml'), '');
  watcher.stop();
});

test('Test 9 + §71 – một XML lỗi KHÔNG làm dừng cả lượt quét', async () => {
  await withScannerDir(async ({ dir, db }) => {
    write(dir, 'Mua_vao', 'a-tot-1.xml', buildXml({ shDon: '00000001' }));
    write(dir, 'Mua_vao', 'b-hong.xml', '<HDon><DLHDon><TTChung><SHDon>1</SHDon>');
    write(dir, 'Mua_vao', 'c-unknown.xml', buildXml({ sellerMst: '0100000009', buyerMst: '0100000008', shDon: '00000003' }));
    write(dir, 'Mua_vao', 'd-tot-2.xml', buildXml({ shDon: '00000004' }));
    const result = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(result.scanned, 4);
    assert.equal(result.imported, 2, 'hai XML hợp lệ vẫn được import');
    assert.equal(result.errors, 2, 'XML hỏng và XML không rõ hướng đều ghi lỗi');
    assert.equal(countInvoices(db), 2);
    const statuses = db.prepare('SELECT file_name, status FROM imported_files ORDER BY file_name').all();
    assert.deepEqual(statuses.map(r => `${r.file_name}:${r.status}`), [
      'a-tot-1.xml:imported', 'b-hong.xml:error', 'c-unknown.xml:error', 'd-tot-2.xml:imported',
    ]);
    const unknown = db.prepare("SELECT error_message FROM imported_files WHERE file_name = 'c-unknown.xml'").get();
    assert.match(unknown.error_message, /Không xác định được Mua vào\/Bán ra/);
  });
});

test('mục 17 – file nằm sai thư mục vẫn ghi theo NỘI DUNG XML, có cảnh báo', async () => {
  await withScannerDir(async ({ dir, db }) => {
    // Hoá đơn BÁN RA nhưng đặt trong Mua_vao
    write(dir, 'Mua_vao', 'sell-nham-thu-muc.xml', buildXml({ sellerMst: MST, buyerNoMst: true, khhDon: 'C26MTH', shDon: '00006423' }));
    const result = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(result.imported, 1);
    assert.equal(result.warningCount, 1);
    const invoice = db.prepare('SELECT direction, file_xml FROM invoices').get();
    assert.equal(invoice.direction, 'SELL', 'hướng lấy từ XML, không lấy từ tên thư mục');
    assert.ok(fs.existsSync(invoice.file_xml), 'file_xml trỏ tới file có thật');
    const trace = db.prepare("SELECT error_message FROM imported_files WHERE status = 'imported'").get();
    assert.match(trace.error_message, /thư mục Mua_vao/);
  });
});

test('dòng hàng được lưu đúng và cascade khi xoá hoá đơn', async () => {
  await withScannerDir(async ({ dir, db }) => {
    write(dir, 'Ban_ra', 'sell-01.xml', buildXml({ sellerMst: MST, buyerNoMst: true, items: [sampleItem(1, { tt: '10000.000000' })] }));
    await scanXmlFolder({ db, mst: MST, mstDir: dir });
    const invoice = db.prepare('SELECT * FROM invoices').get();
    const items = itemsOfInvoice(db, invoice.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].so_luong, 10);
    assert.equal(items[0].thanh_tien, 10000);
    assert.equal(invoice.direction, 'SELL');
    assert.equal(invoice.tong_tien, 22000);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(invoice.id);
    assert.equal(countItems(db), 0);
  });
});

test('runImport: chạy trọn một MST, tạo data.db + sync.json + cấu trúc thư mục', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-import-'));
  try {
    const dir = path.join(root, `MST-${MST}`);
    for (const folder of ['Mua_vao', 'Ban_ra']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'buy.xml'), buildXml({ shDon: '00000009' }));
    fs.writeFileSync(path.join(dir, 'Ban_ra', 'sell.xml'), buildXml({ sellerMst: MST, buyerNoMst: true, shDon: '00000010' }));

    const result = await runImport({ output: root, mst: MST });
    assert.equal(result.ok, true, JSON.stringify(result.scan.files));
    assert.equal(result.scan.imported, 2);
    assert.equal(result.invoices, 2);
    assert.equal(result.items, 4);
    assert.ok(fs.existsSync(path.join(dir, 'data.db')));
    assert.ok(fs.existsSync(path.join(dir, 'sync.json')));

    // Chạy lần hai: không nhân bản
    const again = await runImport({ output: root, mst: MST });
    assert.equal(again.scan.imported, 0);
    assert.equal(again.invoices, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quét ĐỆ QUY: XML trong Mua_vao/xml/ và Ban_ra/xml/ (layout cũ) vẫn được nhập', async () => {
  await withScannerDir(async ({ dir, db }) => {
    // Đúng layout thực tế: XML nằm trong thư mục con xml/
    write(dir, path.join('Mua_vao', 'xml'), 'buy-01.xml', buildXml({ shDon: '00000021' }));
    write(dir, path.join('Ban_ra', 'xml'), 'sell-01.xml', buildXml({ sellerMst: MST, buyerNoMst: true, shDon: '00000022' }));
    const listed = listMstXmlFiles(dir);
    assert.equal(listed.length, 2, 'phải tìm thấy XML trong thư mục con');
    const result = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(result.scanned, 2);
    assert.equal(result.imported, 2);
    assert.equal(result.errors, 0);
    assert.equal(countInvoices(db), 2);
    const directions = db.prepare('SELECT direction FROM invoices ORDER BY direction').all().map(row => row.direction);
    assert.deepEqual(directions, ['BUY', 'SELL']);
  });
});

test('XML nằm ngay trong thư mục MST (ngoài Mua_vao/Ban_ra) vẫn được nhập, kèm cảnh báo (mục 17)', async () => {
  await withScannerDir(async ({ dir, db }) => {
    fs.writeFileSync(path.join(dir, 'roi-go.xml'), buildXml({ shDon: '00000031' }));
    const result = await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(result.imported, 1);
    assert.equal(result.warningCount, 1);
    const trace = db.prepare("SELECT error_message FROM imported_files WHERE status = 'imported'").get();
    assert.match(trace.error_message, /không nằm trong thư mục Mua_vao\/Ban_ra/);
  });
});

test('MST khác ⇒ database khác, dữ liệu không lẫn nhau (mục 5)', async () => {
  await withScannerDir(async ({ dir, db }) => {
    write(dir, 'Mua_vao', 'buy.xml', buildXml({ shDon: '00000011' }));
    await scanXmlFolder({ db, mst: MST, mstDir: dir });
    assert.equal(countInvoices(db), 1);
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-xml-other-'));
    try {
      const otherDb = openDatabase(path.join(otherDir, 'data.db'));
      try {
        for (const folder of ['Mua_vao', 'Ban_ra']) fs.mkdirSync(path.join(otherDir, folder), { recursive: true });
        fs.writeFileSync(path.join(otherDir, 'Mua_vao', 'buy.xml'), buildXml({ shDon: '00000011' }));
        const other = await scanXmlFolder({ db: otherDb, mst: '0900000000', mstDir: otherDir });
        assert.equal(other.imported, 0, 'MST khác ⇒ XML này không thuộc MST đó nên bị UNKNOWN');
        assert.equal(other.errors, 1);
        assert.equal(countInvoices(otherDb), 0);
        assert.equal(countInvoices(db), 1, 'dữ liệu MST gốc không bị đụng');
      } finally {
        closeDatabase(otherDb);
      }
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
