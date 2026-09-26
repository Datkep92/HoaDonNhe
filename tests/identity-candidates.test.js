'use strict';
// ---------------------------------------------------------------------------
// Test — Mã định danh CHƯA GÁN (MST gốc ↔ CCCD của cùng một người).
//
// Bối cảnh thật (F:\web\New folder\MST-4500487170\Mua_vao\xml): hồ sơ đăng nhập MST
// 4500487170 (HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN) nhưng người bán lập hoá đơn cho người
// mua bằng CCCD 058168004258 — cùng một người, khác loại mã (10 file: 4 ghi NMua/MST
// = 4500487170, 6 ghi NMua/MST = 058168004258). detectDirection() từ chối UNKNOWN đúng
// nguyên tắc không đoán (§14); bộ test này bảo đảm:
//   (1) mã lạ được ghi ma-chua-xac-dinh.json và hiện lên để hỏi người dùng,
//   (2) gán mã (identifiers có CCCD) rồi quét lại ⇒ hoá đơn vào kho,
//   (3) hẹn quét lại chỉ khi mã VỪA THẤY LẦN ĐẦU (không lặp vô hạn),
//   (4) mã có vùng MST-<mã> riêng thì không liệt là "chưa gán" của hồ sơ khác.
// Không gọi mạng. Chạy: npm test
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanXmlFolder } = require('../src/data/xml-scanner');
const { openDatabase, closeDatabase } = require('../src/data/sqlite');
const { countInvoices } = require('../src/data/repository');
const identityCandidates = require('../src/data/identity-candidates');

const MST = '4500487170';      // hồ sơ đăng nhập MST gốc
const CCCD = '058168004258';   // cùng người, hoá đơn ghi CCCD
const SELLER = '0301856718';   // người bán không liên quan hồ sơ

// XML mẫu đúng cấu trúc TCT: đủ KHMSHDon/KHHDon/SHDon để có invoice_key.
const invoiceXml = (shDon, buyerMst) =>
  `<HDon><DLHDon Id="V"><TTChung><PBan>2.1.0</PBan><THDon>Hóa đơn giá trị gia tăng</THDon>` +
  `<KHMSHDon>1</KHMSHDon><KHHDon>C26TVC</KHHDon><SHDon>${shDon}</SHDon><NLap>2026-09-11</NLap>` +
  `<DVTTe>VND</DVTTe></TTChung><NDHDon>` +
  `<NBan><Ten>CÔNG TY TNHH VINH CƠ</Ten><MST>${SELLER}</MST></NBan>` +
  `<NMua><Ten>HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN</Ten><MST>${buyerMst}</MST></NMua>` +
  `<HHDVu><TChat>1</TChat><STT>1</STT><MHHDVu>MH1</MHHDVu><THHDVu>Hàng ví dụ</THHDVu><DVTinh>Chai</DVTinh>` +
  `<SLuong>10.000000</SLuong><DGia>1000.000000</DGia><ThTien>10000.000000</ThTien><TSuat>10%</TSuat></HHDVu>` +
  `</NDHDon><TToan><TgTCThue>10000.000000</TgTCThue><TgTThue>1000.000000</TgTThue><TgTTTBSo>11000.000000</TgTTTBSo></TToan>` +
  `</DLHDon></HDon>`;

function makeMstArea(shDon = '000001', buyerMst = CCCD) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkx-test-'));
  const dir = path.join(root, `MST-${MST}`);
  for (const folder of ['Mua_vao', 'Ban_ra']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), invoiceXml(shDon, buyerMst));
  const db = openDatabase(path.join(dir, 'data.db'));
  return { root, dir, db, close: () => { closeDatabase(db); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('unknownParties: lỗi UNKNOWN kèm mã bên bán + bên mua chưa nhận diện', () => {
  const { buildImportRecord } = require('../src/data/xml-parser');
  try {
    buildImportRecord(invoiceXml('000009', CCCD), { currentMst: MST });
    assert.fail('phải ném lỗi UNKNOWN');
  } catch (error) {
    assert.equal(error.unknownDirection, true);
    assert.deepEqual(error.unknownParties.map(party => party.code).sort(), [CCCD, SELLER].sort());
    const mua = error.unknownParties.find(party => party.side === 'mua');
    assert.equal(mua.ten, 'HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN');
  }
});

test('scanner ghi ma-chua-xac-dinh.json và hẹn quét lại khi thấy mã mới', async () => {
  const area = makeMstArea('000001');
  try {
    const first = await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST], mstDir: area.dir });
    assert.equal(first.imported, 0);
    assert.equal(first.errors, 1);
    assert.equal(first.pendingRescan, true);
    const rows = identityCandidates.listCandidates(area.dir);
    assert.deepEqual(rows.map(row => row.code).sort(), [CCCD, SELLER].sort());
    const cccd = rows.find(row => row.code === CCCD);
    assert.equal(cccd.side, 'mua');
    assert.equal(cccd.ownSide, true, 'file trong Mua_vao ⇒ mã bên người mua là CÙNG PHÍA hồ sơ');
    assert.ok(cccd.ten.includes('PHÙNG THỊ KỲ DUYÊN'));
    assert.equal(cccd.decided, '');
    assert.equal(rows.find(row => row.code === SELLER).ownSide, false, 'mã bên người bán chỉ là đối tác, không đề nghị gán');
    // Lần 2 (mã không mới): KHÔNG hẹn quét lại — tránh vòng lặp.
    const second = await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST], mstDir: area.dir });
    assert.equal(second.pendingRescan, false);
  } finally { area.close(); }
});

test('gán CCCD (identifiers có mã) rồi quét lại ⇒ hoá đơn vào kho', async () => {
  const area = makeMstArea('000002');
  try {
    const first = await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST], mstDir: area.dir });
    assert.equal(first.imported, 0);
    identityCandidates.setDecision(area.dir, CCCD, 'assigned', 'test');
    const second = await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST, CCCD], mstDir: area.dir });
    assert.equal(second.imported, 1);
    assert.equal(second.errors, 0);
    assert.equal(countInvoices(area.db), 1);
    const rows = identityCandidates.listCandidates(area.dir);
    assert.equal(rows.find(row => row.code === CCCD).decided, 'assigned');
    assert.equal(rows.find(row => row.code === SELLER).decided, '');
  } finally { area.close(); }
});

test('bỏ qua chỉ là im lặng: gặp file MỚI thì hiện lại', async () => {
  const area = makeMstArea('000003');
  try {
    await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST], mstDir: area.dir });
    identityCandidates.setDecision(area.dir, CCCD, 'ignored', 'test');
    identityCandidates.observeCandidates(area.dir, [{ code: CCCD, ten: 'HKD', side: 'mua', file: 'b.xml' }]);
    const rows = identityCandidates.listCandidates(area.dir);
    assert.equal(rows.find(row => row.code === CCCD).decided, 'ignored'); // vẫn im lặng cho tới khi quyết định lại
    assert.equal(rows.find(row => row.code === CCCD).count, 2); // nhưng đếm file mới
  } finally { area.close(); }
});

test('quét lại nhiều lần KHÔNG phình count: đếm theo số FILE khác nhau', async () => {
  const area = makeMstArea('000005');
  try {
    for (let round = 0; round < 3; round += 1) {
      await scanXmlFolder({ db: area.db, mst: MST, identifiers: [MST], mstDir: area.dir });
    }
    const rows = identityCandidates.listCandidates(area.dir);
    assert.equal(rows.find(row => row.code === CCCD).count, 1); // vẫn là 1 FILE, dù quét 3 lượt
    assert.equal(rows.find(row => row.code === SELLER).count, 1);
  } finally { area.close(); }
});

test('normalizePersonName/samePersonName: cùng một người, nhiều kiểu viết tên', () => {
  const { normalizePersonName, samePersonName } = require('../src/data/identity-candidates');
  assert.equal(normalizePersonName('HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN'), 'PHUNG THI KY DUYEN');
  assert.equal(normalizePersonName('HKD Phùng Thị Kỳ Duyên'), 'PHUNG THI KY DUYEN');
  assert.equal(normalizePersonName('CÔNG TY TNHH VINH CƠ'), 'VINH CO');
  assert.equal(samePersonName('HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN', 'HKD Phùng Thị Kỳ Duyên'), true, 'bỏ tiền tố pháp nhân vẫn là cùng người');
  assert.equal(samePersonName('HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN', 'CÔNG TY TNHH VINH CƠ'), false);
  assert.equal(samePersonName('HỘ KINH DOANH PHÙNG THỊ KỲ DUYÊN', 'NGUYỄN HẢI HUY'), false);
  assert.equal(samePersonName('AB', 'AB'), false, 'tên còn lại quá ngắn thì không khớp');
});

test('server: tự gán theo tên được nối vào GET panel', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(server.includes('function autoAssignByPersonName'), 'phải có hàm tự gán theo tên');
  assert.ok(server.includes('autoAssignByPersonName(mst, db)'), 'GET panel phải gọi tự gán');
  assert.ok(server.includes('data.identityCandidates.samePersonName'), 'so tên phải qua module dùng chung');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'data-ui.js'), 'utf8');
  assert.ok(ui.includes('value.autoAssigned'), 'UI phải thông báo khi hệ thống tự gán');
  assert.ok(ui.includes('Đã phát hiện trùng MST/CCCD'), 'thông báo đúng nội dung người dùng yêu cầu');
});

test('mã có vùng MST-<mã> riêng thì không liệt vào chưa gán của hồ sơ khác', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkx-other-'));
  const dir = path.join(root, `MST-${MST}`);
  fs.mkdirSync(path.join(dir, 'Mua_vao'), { recursive: true });
  fs.mkdirSync(path.join(root, `MST-${SELLER}`), { recursive: true }); // người bán có hồ sơ riêng
  fs.writeFileSync(path.join(dir, 'Mua_vao', 'a.xml'), invoiceXml('000004', CCCD));
  const db = openDatabase(path.join(dir, 'data.db'));
  try {
    const result = await scanXmlFolder({ db, mst: MST, identifiers: [MST], mstDir: dir });
    assert.equal(result.imported, 0);
    const codes = identityCandidates.listCandidates(dir).map(row => row.code);
    assert.ok(!codes.includes(SELLER), 'người bán có MST riêng không được liệt');
    assert.ok(codes.includes(CCCD), 'CCCD chưa có vùng riêng vẫn được liệt');
  } finally { closeDatabase(db); fs.rmSync(root, { recursive: true, force: true }); }
});

test('server: endpoint + nhận diện đăng nhập CCCD được nối đúng', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.ok(server.includes("'/api/db/identity-candidates'"), 'phải có endpoint GET/POST mã chưa gán');
  assert.ok(server.includes('noteLoginIdentifier(selected)'), 'checkLogin phải ghi nhận CCCD của phiên');
  assert.ok(server.includes('identityCandidates.listCandidates(dir)'), 'server phải đọc qua module dùng chung');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'data-ui.js'), 'utf8');
  assert.ok(ui.includes('/api/db/identity-candidates'), 'UI phải nạp danh sách để thông báo');
  assert.ok(!ui.includes('decideCandidate'), 'UI KHÔNG còn panel gán tay — chỉ tự gán theo tên');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.ok(!html.includes('data-candidates'), 'HTML KHÔNG còn khung panel (người dùng yêu cầu bỏ)');
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'xml-watcher.js'), 'utf8');
  assert.ok(watcher.includes('result.pendingRescan'), 'watcher phải hẹn quét lại khi có mã mới');
});
