// Test nhận diện hoá đơn thuộc hồ sơ khi MÃ trong XML khác MST hồ sơ (một chủ có nhiều mã).
// Mô phỏng đúng tình huống đo trên dữ liệu thật: hồ sơ 8021214462-001, 86 hoá đơn bán ra có
// người bán 058183000994 (cùng chủ), 11 nhà cung cấp mỗi mã 1–3 hoá đơn mua vào.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { partyEvidence, resolveOwnCode, OWN_SIDE_MIN_COUNT } = require('../src/data/xml-scanner');

const PROFILE = ['8021214462-001', '8021214462'];
const HKD = '058183000994';
const HKD_TEN = 'HỘ KINH DOANH NHÀ THUỐC ÁNH CHÂU';

// Sổ trạng thái mô phỏng: 72 hồ sơ bán ra (người bán = HKD) + 14 hồ sơ mua vào (người mua = HKD).
function parties({ hkdWrongSide = false, soldCount = 72, buyCount = 14 } = {}) {
  const list = [];
  for (let i = 0; i < soldCount; i += 1) {
    list.push({ nbmst: HKD, nbten: HKD_TEN, nmmst: '', direction: 'sold' });
  }
  for (let i = 0; i < buyCount; i += 1) {
    // Nhà cung cấp khác nhau mỗi lượt — mỗi mã chỉ xuất hiện 1–3 lần.
    const supplier = `03106313${String(10 + (i % 4)).padStart(2, '0')}`;
    list.push({ nbmst: supplier, nbten: 'CÔNG TY TNHH DƯỢC PHẨM', nmmst: HKD, nmten: HKD_TEN, direction: 'purchase' });
  }
  if (hkdWrongSide) {
    // Mã đứng SAI PHÍA: nbmst ở lượt MUA VÀO (tức nó là nhà cung cấp, không phải hồ sơ).
    list.push({ nbmst: HKD, nbten: HKD_TEN, nmmst: '0310631333', direction: 'purchase' });
  }
  return list;
}

const codes = (rows) => {
  const map = new Map();
  for (const row of rows) {
    const code = row.code;
    const seen = map.get(code) || { ten: row.ten, count: 0, ownSide: false, files: new Set() };
    if (row.ownSide) seen.ownSide = true;
    seen.count += 1;
    seen.files.add('f' + seen.count + '.xml');
    map.set(code, seen);
  }
  return map;
};

test('partyEvidence: mã hộ đứng đúng phía ở CẢ hai chiều; nhà cung cấp đứng sai phía', () => {
  const evidence = partyEvidence(parties(), PROFILE);
  // Hộ kinh doanh: nbmst ở lượt BÁN RA, nmmst ở lượt MUA VÀO ⇒ đúng phía cả hai, own = 86.
  const hkd = evidence.get(HKD);
  assert.equal(hkd.own, 72 + 14, 'hộ là người bán khi bán ra và người mua khi mua vào');
  assert.equal(hkd.wrong, 0, 'hộ không bao giờ đứng sai phía');
  assert.equal(hkd.sold, 72);
  assert.equal(hkd.purchase, 14);
  // Nhà cung cấp: nbmst ở lượt MUA VÀO ⇒ sai phía.
  const supplier = evidence.get('0310631310');
  assert.equal(supplier.wrong, 4, 'nhà cung cấp đứng sai phía ở lượt mua vào');
  assert.equal(supplier.own, 0);
});

test('resolveOwnCode: mã hộ nhiều lần + đúng chiều ⇒ nhận diện (tên khớp)', () => {
  const rows = [];
  for (let i = 0; i < 72; i += 1) rows.push({ code: HKD, ten: HKD_TEN, ownSide: true });
  const own = resolveOwnCode({ codes: codes(rows), parties: parties(), identifiers: PROFILE, profileNames: [HKD_TEN] });
  assert.ok(own, 'phải nhận diện được mã của hộ kinh doanh');
  assert.equal(own.code, HKD);
  assert.equal(own.direction, 'sold');
  assert.match(own.reason, /tên khớp hồ sơ/);
});

test('resolveOwnCode: tên KHÔNG khớp (hồ sơ để tên là MST) vẫn nhận khi số lượng lớn', () => {
  // Đúng tình huống khách đang gặp: account.name = "8021214462-001" ⇒ không trùng tên hộ, nhưng
  // 86 hồ sơ nhất quán một chiều thì bằng chứng chiều + số lượng đủ để nhận.
  const rows = [];
  for (let i = 0; i < 72; i += 1) rows.push({ code: HKD, ten: HKD_TEN, ownSide: true });
  const own = resolveOwnCode({ codes: codes(rows), parties: parties(), identifiers: PROFILE, profileNames: ['8021214462-001'] });
  assert.ok(own, 'phải nhận khi số lượng vượt ngưỡng dù tên không khớp');
  assert.equal(own.code, HKD);
  assert.match(own.reason, /72 hồ sơ cùng chiều/);
});

test('CHỐNG GÁN NHẦM: số lượng nhỏ + tên không khớp ⇒ không nhận', () => {
  const rows = [];
  for (let i = 0; i < 3; i += 1) rows.push({ code: HKD, ten: HKD_TEN, ownSide: true });
  const own = resolveOwnCode({ codes: codes(rows), parties: parties({ soldCount: 3, buyCount: 0 }), identifiers: PROFILE, profileNames: ['8021214462-001'] });
  assert.equal(own, null, `dưới ngưỡng ${OWN_SIDE_MIN_COUNT} và tên không khớp thì không được gán`);
});

test('CHỐNG GÁN NHẦM: mã có đứng SAI PHÍA dù chỉ một lần ⇒ loại tuyệt đối', () => {
  const rows = [];
  for (let i = 0; i < 72; i += 1) rows.push({ code: HKD, ten: HKD_TEN, ownSide: true });
  const own = resolveOwnCode({ codes: codes(rows), parties: parties({ hkdWrongSide: true }), identifiers: PROFILE, profileNames: [HKD_TEN] });
  assert.equal(own, null, 'mã từng làm người bán trong lượt mua vào là nhà cung cấp, không được gán');
});

test('CHỐNG GÁN NHẦM: mã ở phía đối diện chiều tra (ownSide:false) ⇒ không nhận', () => {
  // Nhà cung cấp xuất hiện 50 lần nhưng đứng ở phía đối diện ⇒ vẫn là đối tác.
  const list = [];
  for (let i = 0; i < 50; i += 1) list.push({ nbmst: '0310631333', nmmst: '8021214462-001', direction: 'purchase' });
  const rows = [];
  for (let i = 0; i < 50; i += 1) rows.push({ code: '0310631333', ten: 'CÔNG TY TNHH DƯỢC PHẨM', ownSide: false });
  const own = resolveOwnCode({ codes: codes(rows), parties: list, identifiers: PROFILE, profileNames: ['HỘ KINH DOANH NHÀ THUỐC ÁNH CHÂU'] });
  assert.equal(own, null, 'mã đối tác ở phía đối diện không được gán, dù xuất hiện nhiều');
});

test('resolveOwnCode: file sổ trạng thái cũ (không có parties) ⇒ hành vi cũ, không gán', () => {
  const rows = [];
  for (let i = 0; i < 72; i += 1) rows.push({ code: HKD, ten: HKD_TEN, ownSide: true });
  const own = resolveOwnCode({ codes: codes(rows), parties: [], identifiers: PROFILE, profileNames: [HKD_TEN] });
  assert.equal(own, null, 'không có bằng chứng chiều thì không được đoán');
});

test('engine ghi khối parties vào trang-thai-hoa-don.json (đọc lại được)', () => {
  const { readStateFile } = require('../src/core');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-parties-'));
  try {
    const file = path.join(dir, 'trang-thai-hoa-don.json');
    fs.writeFileSync(file, JSON.stringify({
      updatedAt: new Date().toISOString(),
      states: { 'A|1|C1|1': '1' },
      parties: {
        'A|1|C1|1': { nbmst: HKD, nmmst: '', nbten: HKD_TEN, direction: 'sold' },
        'A|1|C1|2': { nbmst: '', nmmst: '0310631333', direction: 'purchase' },
        // Rác cố tình: thiếu chiều, sai kiểu, không có mã nào.
        'A|1|C1|3': { nbmst: HKD },
        'A|1|C1|4': 'x',
        'A|1|C1|5': { direction: 'sold' },
      },
    }));
    const { states, parties } = readStateFile(file);
    assert.equal(states['A|1|C1|1'], '1', 'khối states cũ vẫn đọc được');
    assert.equal(Object.keys(parties).length, 2, 'chỉ giữ 2 dòng parties hợp lệ');
    assert.equal(parties['A|1|C1|1'].direction, 'sold');
    assert.equal(parties['A|1|C1|2'].nmmst, '0310631333');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
