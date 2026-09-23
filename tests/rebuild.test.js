'use strict';
// ---------------------------------------------------------------------------
// §70 – DATABASE REBUILD TEST.
//
// Yêu cầu của tài liệu: xoá data.db nhưng giữ XML thì hệ thống phải dựng lại được database,
// và số hoá đơn / số dòng hàng / chiều mua-bán / khoá hoá đơn phải khôi phục CHÍNH XÁC.
// Không gọi mạng.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runImport } = require('../src/data/xml-import');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');

const MST = '0312345678';
const OTHER = '0100000001';

const item = (index, over = {}) => {
  const value = { ma: `MH${index}`, ten: `Hàng ví dụ ${index}`, dv: 'Thùng', sl: '2.000000', dg: '1000.000000', tt: '2000.000000', ts: '10%', ...over };
  return `<HHDVu><TChat>1</TChat><STT>${index}</STT><MHHDVu>${value.ma}</MHHDVu><THHDVu>${value.ten}</THHDVu><DVTinh>${value.dv}</DVTinh><SLuong>${value.sl}</SLuong><DGia>${value.dg}</DGia><TLCKhau>0.0000</TLCKhau><STCKhau>0.000000</STCKhau><ThTien>${value.tt}</ThTien><TSuat>${value.ts}</TSuat></HHDVu>`;
};

function buildXml({ sellerMst = OTHER, buyerMst = MST, buyerNoMst = false, khhDon = 'C26TNT', shDon = '00000001', nlap = '2026-09-21', items = [item(1), item(2)] }) {
  const buyer = buyerNoMst
    ? '<NMua><HVTNMHang>Bán cho người tiêu dùng</HVTNMHang></NMua>'
    : `<NMua><Ten>CÔNG TY VÍ DỤ NGƯỜI MUA</Ten><MST>${buyerMst}</MST></NMua>`;
  return `<HDon><DLHDon Id="VIDU"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn giá trị gia tăng</THDon><KHMSHDon>1</KHMSHDon>` +
    `<KHHDon>${khhDon}</KHHDon><SHDon>${shDon}</SHDon><NLap>${nlap}</NLap><DVTTe>VND</DVTTe></TTChung><NDHDon>` +
    `<NBan><Ten>CÔNG TY VÍ DỤ NHÀ CUNG CẤP</Ten><MST>${sellerMst}</MST></NBan>${buyer}` +
    `<DSHHDVu>${items.join('')}</DSHHDVu></NDHDon><TToan><TgTCThue>4000.000000</TgTCThue><TgTThue>400.000000</TgTThue><TgTTTBSo>4400.000000</TgTTTBSo></TToan></DLHDon></HDon>`;
}

// Ảnh chụp dữ liệu để so sánh trước/sau khi dựng lại.
function snapshot(dir) {
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    const invoices = db.prepare('SELECT invoice_key, direction, ngay_lap, so_hd, tong_tien, file_xml FROM invoices ORDER BY invoice_key').all();
    const items = db.prepare('SELECT v.invoice_key AS k, i.stt, i.ma_hang, i.ten_hang, i.so_luong, i.thanh_tien FROM invoice_items i JOIN invoices v ON v.id = i.invoice_id ORDER BY v.invoice_key, i.stt').all();
    return {
      invoiceCount: invoices.length,
      itemCount: items.length,
      keys: invoices.map(row => `${row.invoice_key}|${row.direction}|${row.ngay_lap}|${row.so_hd}`),
      amounts: invoices.map(row => row.tong_tien),
      items: items.map(row => `${row.k}|${row.stt}|${row.ma_hang}|${row.so_luong}|${row.thanh_tien}`),
      xmlPaths: invoices.map(row => path.basename(row.file_xml)),
    };
  } finally {
    closeDatabase(db);
  }
}

test('§70 – xoá data.db, dựng lại từ XML: số liệu, chiều và khoá khôi phục y hệt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-rebuild-'));
  try {
    const dir = path.join(root, `MST-${MST}`);
    // Layout hỗn hợp như thực tế: có file trong thư mục con xml/ và có file nằm trực tiếp.
    fs.mkdirSync(path.join(dir, 'Mua_vao', 'xml'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Ban_ra', 'xml'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'xml', 'a.xml'), buildXml({ shDon: '00000001' }));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'xml', 'b.xml'), buildXml({ shDon: '00000002', items: [item(1)] }));
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'c.xml'), buildXml({ shDon: '00000003' }));
    fs.writeFileSync(path.join(dir, 'Ban_ra', 'xml', 'd.xml'), buildXml({ sellerMst: MST, buyerNoMst: true, khhDon: 'C26MTH', shDon: '00006423', items: [item(1)] }));
    // Một XML lỗi: dựng lại vẫn phải bỏ qua an toàn, không làm hỏng phần còn lại.
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'hong.xml'), '<HDon><DLHDon><TTChung>');

    const first = await runImport({ output: root, mst: MST });
    assert.equal(first.scan.imported, 4);
    assert.equal(first.scan.errors, 1);
    const before = snapshot(dir);
    assert.equal(before.invoiceCount, 4);
    assert.equal(before.itemCount, 6, '3 hoá đơn × 2 dòng + 1 hoá đơn × 1 dòng (bán ra) = 6');
    assert.equal(before.keys.filter(key => key.includes('|SELL|')).length, 1);

    // Xoá database (kể cả file WAL/SHM) nhưng giữ nguyên XML.
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(dir, `data.db${suffix}`), { force: true });
    assert.ok(!fs.existsSync(path.join(dir, 'data.db')), 'data.db phải đã bị xoá');

    const second = await runImport({ output: root, mst: MST });
    assert.equal(second.scan.imported, 4, 'dựng lại phải nhập lại đủ 4 hoá đơn hợp lệ');
    assert.equal(second.scan.errors, 1, 'XML lỗi vẫn bị ghi lỗi, không làm chết lượt');
    const after = snapshot(dir);

    assert.deepEqual(after, before, 'dữ liệu sau khi dựng lại phải giống hệt trước khi xoá');
    assert.equal(after.invoiceCount, 4);
    assert.equal(after.itemCount, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('§70 – dựng lại hai lần liên tiếp không nhân bản', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-rebuild2-'));
  try {
    const dir = path.join(root, `MST-${MST}`);
    fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), buildXml({ shDon: '00000009' }));

    await runImport({ output: root, mst: MST });
    const once = snapshot(dir);
    const again = await runImport({ output: root, mst: MST });
    assert.equal(again.scan.imported, 0);
    assert.equal(again.scan.skipped, 1, 'file đã nhập thì bỏ qua');
    assert.deepEqual(snapshot(dir), once);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
