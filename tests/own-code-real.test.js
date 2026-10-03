// Chứng minh bằng DỮ LIỆU THẬT của khách, đọc từ thư mục lưu mà app đang dùng (đọc
// du_lieu/accounts.json để biết `output`). Máy không có dữ liệu thật thì test tự bỏ qua.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readParties, resolveOwnCode, partyEvidence } = require('../src/data/xml-scanner');

const ROOT = path.resolve(__dirname, '..');
const HKD = '058183000994';
const HKD_TEN = 'HỘ KINH DOANH NHÀ THUỐC ÁNH CHÂU';

// Thư mục lưu thật: ưu tiên accounts.json (nơi app tự ghi), không có thì dùng du_lieu/.
function realDirs() {
  const dirs = [];
  let output = '';
  try { output = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'du_lieu', 'accounts.json'), 'utf8')).output || ''); } catch {}
  if (output) dirs.push(path.join(output, 'MST-8021214462-001'));
  dirs.push(path.join(ROOT, 'du_lieu', 'MST-8021214462-001'));
  return dirs.filter(dir => fs.existsSync(path.join(dir, 'trang-thai-hoa-don.json')));
}
const DIRS = realDirs();
const PROFILE = ['8021214462-001', '8021214462'];
const skipNoData = t => { if (!DIRS.length) { t.skip('máy này không có dữ liệu thật'); return true; } return false; };
const readReal = name => JSON.parse(fs.readFileSync(path.join(DIRS[0], name), 'utf8'));

// Sổ trạng thái của app có thể ở BA trạng thái khác nhau tuỳ lúc khách chạy:
//   · chưa tải lại lần nào sau khi có tính năng → chỉ có `states` (không `parties`) ⇒ không đoán;
//   · đã tải lại một chiều → `parties` chỉ có `purchase` (14 hồ sơ) ⇒ CHƯA đủ bằng chứng để gán;
//   · đã tải lại cả hai chiều → `parties` có cả sold + purchase ⇒ đủ bằng chứng.
// Test đọc trạng thái thật và kiểm tra hành vi ĐÚNG THEO trạng thái đó — không giả định cứng.
test('sổ trạng thái thật: khối parties đúng cấu trúc, chỉ chứa chiều đã thực sự tra', t => {
  if (skipNoData(t)) return;
  const raw = readReal('trang-thai-hoa-don.json');
  const states = Object.values(raw.states || {});
  assert.ok(states.length > 0, 'phải có khối states');
  for (const value of states) assert.match(value, /^[1-6]$/);
  const parties = raw.parties;
  if (parties === undefined) return t.skip('chưa tải lại lần nào sau khi có tính năng (đúng như mong đợi)');
  const rows = Object.values(parties);
  for (const row of rows) {
    assert.ok(['sold', 'purchase'].includes(row.direction), `chiều phải là sold/purchase, thấy ${row.direction}`);
    assert.ok(row.nbmst || row.nmmst, 'mỗi dòng phải có ít nhất một đầu mã');
    if (row.direction === 'sold') assert.ok(row.nbmst, 'lượt bán ra: người bán phải có MST');
    else assert.ok(row.nmmst, 'lượt mua vào: người mua phải có MST');
  }
  const sold = rows.filter(r => r.direction === 'sold');
  const buy = rows.filter(r => r.direction === 'purchase');
  // Trong dữ liệu khách: lượt bán ra là khách lẻ (người mua KHÔNG có MST) nên 72 hồ sơ bán ra
  // không sinh dòng parties nào hợp lệ về phía người mua — vẫn phải có nbmst (người bán = hộ).
  console.log(`      [thật] states=${states.length} parties=${rows.length} (sold=${sold.length}, purchase=${buy.length})`);
});

// Chứng minh bằng kho THẬT của khách: toàn bộ hồ sơ đã tải về đều vào kho, mã của hộ
// nhận diện tự động từ bằng chứng CHIỀU MUA VÀO (nmmst), và các mã nhà cung cấp không
// bị gán nhầm.
//
// KHÔNG ghim số lượng hồ sơ: kho thật lớn dần theo thời gian (lúc viết test là 86, sau
// đó khách tải tiếp lên hơn 270). Ghim số là test đỏ vì dữ liệu thay đổi chứ không phải
// vì code hỏng — đó là test sai, không phải app sai.
test('KHO THẬT: mọi hồ sơ đã vào kho, mã hộ nhận diện tự động, không gán nhầm mã đối tác', t => {
  if (skipNoData(t)) return;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(DIRS[0], 'data.db'), { readOnly: true });
  } catch { return t.skip('chưa có data.db trên máy này'); }
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM invoices').get().c;
    if (total === 0) return t.skip('kho chưa nhập hoá đơn nào');
    // Hồ sơ có MST 8021214462-001 nhưng mã trong hoá đơn là 058183000994 (cùng chủ, nhiều mã).
    assert.ok(total > 0);
    const sell = db.prepare("SELECT COUNT(*) c FROM invoices WHERE direction='SELL'").get().c;
    const buy = db.prepare("SELECT COUNT(*) c FROM invoices WHERE direction='BUY'").get().c;
    assert.equal(sell + buy, total, 'mọi hoá đơn phải có hướng');
    // Mã của hộ phải xuất hiện ở đúng phía: người bán của SELL, người mua của BUY.
    //
    // QUAN TRỌNG — không ghim cứng mã `058183000994`: hộ kinh doanh có NHIỀU mã (mã hộ
    // 058183000994 và mã chi nhánh 8021214462-001…). Cổng thuế trả về đúng mã mà
    // đối tác ghi trên hoá đơn, nên sẽ có hoá đơn mua vào mang mã CHI NHÁNH.
    // Bất biến đúng là: mã ở phía đối tác trong nước LUÔN thuộc về chính hộ, KHÔNG
    // BAO GIỜ là mã nhà cung cấp. Test ghim cứng sẽ đỏ khi dữ liệu thật lớn lên.
    const OWN_CODES = [HKD, ...PROFILE];
    const codesOf = sql => db.prepare(sql).all().map(r => String(r.c || '').trim());
    const sellOwners = codesOf("SELECT DISTINCT mst_ban c FROM invoices WHERE direction='SELL'");
    const buyOwners = codesOf("SELECT DISTINCT mst_mua c FROM invoices WHERE direction='BUY'");
    for (const code of sellOwners) assert.ok(OWN_CODES.includes(code), `người bán bán ra phải là mã của hộ, thấy ${code}`);
    for (const code of buyOwners) assert.ok(OWN_CODES.includes(code), `người mua mua vào phải là mã của hộ, thấy ${code}`);
    // Hai vế đều rỗng thì assert trên vô nghĩa — phải có ít nhất một mã của hộ.
    assert.ok(sellOwners.length + buyOwners.length > 0, 'phải nhận diện được mã của hộ');
    // Trạng thái vẫn được ghi đúng (tthai=1 cho hồ sơ mới) — nhận diện mã KHÔNG được làm mất trạng thái.
    const withState = db.prepare("SELECT COUNT(*) c FROM invoices WHERE COALESCE(tthai,'')<>''").get().c;
    assert.equal(withState, total, 'mọi hoá đơn phải có trạng thái từ sổ trạng thái');
    console.log(`      [thật] kho: ${total} hoá đơn (bán ra ${sell}, mua vào ${buy}), mã hộ ${HKD}`);
  } finally { db.close(); }
});

test('parties rỗng ⇒ KHÔNG đoán, rơi về hành vi cũ (ghi vết chờ người dùng)', t => {
  if (skipNoData(t)) return;
  const own = resolveOwnCode({
    codes: new Map([[HKD, { ten: HKD_TEN, count: 86, ownSide: true, files: new Set(['a.xml']) }]]),
    parties: [], identifiers: PROFILE, profileNames: ['8021214462-001'],
  });
  assert.equal(own, null, 'không có bằng chứng chiều thì tuyệt đối không gán');
});

test('ma-chua-xac-dinh thật: mã hộ ownSide=true count lớn; mã còn lại ownSide=false', t => {
  if (skipNoData(t)) return;
  if (!fs.existsSync(path.join(DIRS[0], 'ma-chua-xac-dinh.json'))) return t.skip('chưa chạy nhập lần nào');
  const raw = readReal('ma-chua-xac-dinh.json');
  const rows = Object.entries(raw).map(([code, v]) => ({ code, ownSide: v.ownSide === true, count: v.count || 0 }));
  const hkd = rows.find(r => r.code === HKD);
  assert.ok(hkd, 'phải có mã hộ trong danh sách chưa gán');
  assert.equal(hkd.ownSide, true);
  assert.ok(hkd.count >= 50, `hộ có ${hkd.count} hồ sơ`);
  for (const p of rows.filter(r => r.code !== HKD)) assert.equal(p.ownSide, false, `${p.code} phải ownSide=false`);
});

test('mô phỏng đúng số liệu khách: nhận mã hộ, KHÔNG gán nhầm các mã nhà cung cấp', t => {
  if (skipNoData(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-real-'));
  try {
    // 72 hồ sơ bán ra (người bán = hộ) — đúng số đo trong autosync-job-sell.json.
    const parties = Array.from({ length: 72 }, () => ({ nbmst: HKD, nbten: HKD_TEN, direction: 'sold' }));
    // 14 hồ sơ mua vào: người mua = hộ, người bán = các nhà cung cấp. Lấy số lần từ file thật nếu
    // có; không thì dùng số đo đã ghi (3+3+1×8 = 14). Khách lẻ (nmmst rỗng) không có mã để ghi vết
    // nên không xuất hiện trong danh sách này.
    let suppliers = [['0310631333', 3], ['1400460395-019', 3], ['0100274124-003', 1], ['0101452595', 1],
      ['0101887589-002', 1], ['0300483037', 1], ['0301140748', 1], ['0304628149', 1],
      ['4100259564-013', 1], ['4500200808', 1]];
    if (fs.existsSync(path.join(DIRS[0], 'ma-chua-xac-dinh.json'))) {
      const raw = readReal('ma-chua-xac-dinh.json');
      suppliers = Object.entries(raw).filter(([code]) => code !== HKD).map(([code, v]) => [code, v.count || 1]);
    }
    for (const [code, times] of suppliers) {
      for (let i = 0; i < times; i += 1) parties.push({ nbmst: code, nmmst: HKD, direction: 'purchase' });
    }
    fs.writeFileSync(path.join(dir, 'trang-thai-hoa-don.json'), JSON.stringify({
      states: {}, parties: Object.fromEntries(parties.map((p, i) => ['k' + i, p])),
    }));
    const loaded = readParties(dir);
    // Không ghim tổng cứng: `count` trong ma-chua-xac-dinh.json là số file từng gặp mã đó ở MỌI
    // lượt (kể cả khách lẻ ở lượt bán ra), nên tổng mua vào có thể 14 hoặc 15 tuỳ dữ liệu.
    assert.ok(loaded.length >= 86, `${loaded.length} hồ sơ (72 bán ra + phần mua vào)`);

    const codes = new Map();
    for (let i = 0; i < 72; i += 1) {
      codes.set(HKD, { ten: HKD_TEN, count: (codes.get(HKD)?.count || 0) + 1, ownSide: true, files: new Set([`b${i}.xml`]) });
    }
    for (const [code, times] of suppliers) codes.set(code, { ten: 'CÔNG TY', count: times, ownSide: false, files: new Set() });
    const own = resolveOwnCode({ codes, parties: loaded, identifiers: PROFILE, profileNames: ['8021214462-001'] });
    assert.ok(own, 'phải nhận diện được mã hộ kinh doanh');
    assert.equal(own.code, HKD);
    assert.equal(own.direction, 'sold');

    const evidence = partyEvidence(loaded, PROFILE);
    for (const [code] of suppliers) {
      assert.ok(evidence.get(code).wrong > 0, `${code} phải bị đánh dấu sai phía`);
      assert.equal(evidence.get(code).own, 0, `${code} không được tính là đúng phía`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
