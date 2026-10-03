'use strict';
// ---------------------------------------------------------------------------
// Mục 3 — PDF GỐC của nhà cung cấp: ghép file, xem trong app, và KHÔNG bịa.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const originalPdf = require(path.join(REPO, 'src', 'data', 'original-pdf'));
const registry = require(path.join(REPO, 'src', 'data', 'provider-registry'));
const { openDatabase, applySchema, schemaVersion } = require(path.join(REPO, 'src', 'data', 'sqlite'));
const repository = require(path.join(REPO, 'src', 'data', 'repository'));

let seq = 0;
function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orig-test-'));
  const db = openDatabase(path.join(dir, 'data.db'));
  return { dir, db };
}

// Nhập một hóa đơn và TRẢ VỀ DÒNG ĐÃ LƯU.
// Bản đầu truy vấn `WHERE invoice_key = ?` nhưng lại truyền SỐ HÓA ĐƠN ⇒ luôn
// undefined, và các test sau đó che lỗi bằng `{ ...row }` ({...undefined} = {}).
// Phải truy vấn theo đúng khoá hàng thật.
function seedInvoice(db, dir, { direction = 'BUY', mst = '0101452595', lookupUrl = '', provider = 'vnpt' } = {}) {
  const soHd = `HD${++seq}`;
  const xml = path.join(dir, `${soHd}.xml`);
  fs.writeFileSync(xml, '<HDon/>', 'utf8');
  const value = registry.resolve(provider);
  repository.insertInvoice(db, {
    direction, mstBan: mst, mstMua: '058183000994', tenBan: 'NCC', tenMua: 'B',
    ngayLap: '2026-05-05', khmsHd: '1', khhHd: 'C26T', soHd,
    loaiHoaDon: 'HĐ', tthai: '1', fileXml: xml,
    tienTruocThue: 100, tienThue: 5, tongTien: 105,
    msttcgp: value ? value.solutionTaxCode : null,
    providerId: value ? value.id : null, providerName: value ? value.name : null,
    providerLevel: value ? value.level : null,
    lookupCode: '', lookupUrl,
    items: [{ stt: 1, maHang: 'H', tenHang: 'Hàng', donVi: 'Cái', soLuong: 1, donGia: 100, chietKhau: 0, thanhTien: 100, thueSuat: '8%', tienThue: null }],
  });
  const row = db.prepare('SELECT * FROM invoices WHERE so_hd = ? AND direction = ?').get(soHd, direction);
  assert.ok(row, 'không nhập được hóa đơn thử nghiệm');
  return row;
}

function putOriginal(dir, direction, fileName) {
  const folder = path.join(dir, direction, originalPdf.ORIGINAL_FOLDER);
  fs.mkdirSync(folder, { recursive: true });
  const full = path.join(folder, fileName);
  fs.writeFileSync(full, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(600, 1)]));
  return full;
}

test('migration v13 thêm cột original_pdf, chạy lại không đổi', () => {
  const { dir, db } = build();
  try {
    applySchema(db);
    const cols = db.prepare('PRAGMA table_info(invoices)').all().map(r => r.name);
    assert.ok(cols.includes('original_pdf'), 'thiếu cột original_pdf');
    assert.ok(schemaVersion(db) >= 13);
    assert.strictEqual(applySchema(db).changed, false);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('khoá tên file: 4 trường đầu, bỏ hậu tố chống trùng', () => {
  // Tên app đặt: <mst>_<form>_<series>_<no>_<suffix> (core.js:690).
  assert.strictEqual(originalPdf.keyOfFileName('0101452595_1_C26TAA_218213_ab12cd34.pdf'),
    '0101452595_1_c26taa_218213');
  assert.strictEqual(originalPdf.keyOfFileName('0101452595_1_C26TAA_218213.PDF'),
    '0101452595_1_c26taa_218213');
  assert.strictEqual(originalPdf.fileKey('0101452595', '1', 'C26TAA', '218213'),
    '0101452595_1_c26taa_218213');
});

test('tự ghép PDF gốc trong pdf-goc theo đúng khoá', () => {
  const { dir, db } = build();
  try {
    const row = seedInvoice(db, dir, { mst: '0101452595' });
    // Tên file CÓ hậu tố như app đặt — vẫn phải khớp.
    const name = `${row.mst_ban}_${row.khms_hd}_${row.khh_hd}_${row.so_hd}_deadbeef.pdf`;
    putOriginal(dir, 'Mua_vao', name);
    const found = originalPdf.findOriginalPdf(dir, 'Mua_vao', row);
    assert.ok(found && found.endsWith(name), `không ghép được: ${found}`);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('KHÔNG ghép nhầm sang hóa đơn khác', () => {
  const { dir, db } = build();
  try {
    const row = seedInvoice(db, dir, { mst: '0101452595' });
    // Số hóa đơn khác, MST khác, chiều khác — đều không được khớp.
    putOriginal(dir, 'Mua_vao', `${row.mst_ban}_${row.khms_hd}_${row.khh_hd}_999999_x.pdf`);
    putOriginal(dir, 'Mua_vao', `0304628149_${row.khms_hd}_${row.khh_hd}_${row.so_hd}_x.pdf`);
    putOriginal(dir, 'Ban_ra', `${row.mst_ban}_${row.khms_hd}_${row.khh_hd}_${row.so_hd}_x.pdf`);
    assert.strictEqual(originalPdf.findOriginalPdf(dir, 'Mua_vao', row), '');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('đường dẫn người dùng đã chọn được ưu tiên, và chặn đường dẫn ngoài thư mục MST', () => {
  const { dir, db } = build();
  try {
    const row = seedInvoice(db, dir, { mst: '0101452595' });
    const chosen = putOriginal(dir, 'Mua_vao', 'tay-chon.pdf');
    const relative = originalPdf.toRelative(dir, chosen);
    assert.ok(relative, 'phải lưu được đường dẫn tương đối');
    assert.strictEqual(originalPdf.findOriginalPdf(dir, 'Mua_vao', { ...row, original_pdf: relative }), chosen);

    // Đường dẫn tương đối truy ra ngoài thư mục MST ⇒ từ chối, không đọc file.
    const escape = { ...row, original_pdf: path.join('..', '..', 'khac', 'mat.pdf') };
    assert.strictEqual(originalPdf.findOriginalPdf(dir, 'Mua_vao', escape), '');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('file đã xoá khỏi đĩa thì rơi về tự ghép, không báo sai là còn', () => {
  const { dir, db } = build();
  try {
    const row = seedInvoice(db, dir, { mst: '0101452595' });
    const chosen = putOriginal(dir, 'Mua_vao', 'tay-chon.pdf');
    const relative = originalPdf.toRelative(dir, chosen);
    fs.rmSync(chosen);
    assert.strictEqual(originalPdf.findOriginalPdf(dir, 'Mua_vao', { ...row, original_pdf: relative }), '');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('badge: xanh khi có file, vàng khi có cổng tra cứu, xám khi không có gì', () => {
  const row = { direction: 'BUY', msttcgp: '0100684378', lookup_url: 'https://x.vn/', lookup_code: 'C1', provider_name: 'VNPT-Invoice' };
  assert.strictEqual(originalPdf.badgeFor(row, 'C:\\a.pdf').kind, 'have');
  assert.strictEqual(originalPdf.badgeFor(row, '').kind, 'lookup');
  assert.strictEqual(originalPdf.badgeFor({ direction: 'BUY' }, '').kind, 'none');
  assert.strictEqual(originalPdf.badgeFor(row, 'C:\\a.pdf').label, 'Có PDF gốc');
});

test('lý do luôn có câu, kể cả hóa đơn bán ra của chính hồ sơ', () => {
  const sell = originalPdf.reasonMissing({ direction: 'SELL', provider_name: 'MISA meInvoice', msttcgp: '0101243150', lookup_code: '', lookup_url: 'https://www.meinvoice.vn/tra-cuu/' });
  assert.ok(sell.length > 20, 'phải giải thích vì sao bán ra không lấy được PDF gốc');
  assert.match(sell, /hồ sơ này phát hành/);

  const unknown = originalPdf.reasonMissing({ direction: 'BUY' });
  assert.ok(unknown.length > 10, 'MST lạ vẫn phải có lý do');
});

test('mức năng lực PHẢI khớp kết quả kiểm thật: không provider nào tự tải PDF được', () => {
  // Đã kiểm thật 2026-10: VNPT bắt đăng nhập (/Account/LogOn), EasyInvoice và MISA là
  // trang tra cứu có biểu mẫu (/Search/Index). Không dòng nào được gắn supplier-original.
  const levels = Object.values(registry.BY_SOLUTION_TAX_CODE).map(x => x.level);
  assert.ok(!levels.includes('supplier-original'),
    'không được gắn supplier-original khi chưa có bằng chứng tải được PDF');
  assert.ok(levels.includes('portal-assisted') && levels.includes('captcha-assisted'));
  for (const level of levels) assert.ok(registry.LEVELS.includes(level), `mức lạ: ${level}`);
});

test('UI: cột PDF gốc, hộp thoại xem, và không mở trình duyệt ngoài', () => {
  const html = fs.readFileSync(path.join(REPO, 'src', 'index.html'), 'utf8');
  for (const id of ['orig-dialog', 'orig-frame', 'orig-close', 'orig-detach', 'orig-pick-dialog', 'orig-pick-open', 'orig-pick-portal', 'orig-pick-subtitle']) {
    assert.ok(html.includes(`id="${id}"`), `thiếu #${id}`);
  }
  assert.match(html, /<th>PDF gốc<\/th>/, 'thiếu cột PDF gốc trong bảng danh sách');
  assert.ok(!/<[^>]+\sstyle="/i.test(html), 'không được dùng inline style');

  const ui = fs.readFileSync(path.join(REPO, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/orig-badge/.test(ui), 'phải có nút badge 3 màu');
  assert.ok(/\/api\/db\/invoice-original\?key=/.test(ui), 'UI phải xem PDF gốc qua route của app');
  assert.ok(/\/api\/db\/invoice-original\/attach/.test(ui));
  assert.ok(/\/api\/db\/invoice-original\/pick/.test(ui));
  assert.ok(/\/api\/db\/provider\/download/.test(ui));
  // KHÔNG được spawn trình duyệt hệ thống từ luồng xem PDF gốc.
  assert.ok(!/explorer\.exe|shell\.openExternal/.test(ui), 'không được mở ứng dụng ngoài cho PDF gốc');

  const server = fs.readFileSync(path.join(REPO, 'src', 'server.js'), 'utf8');
  for (const route of ['/api/db/invoice-original', '/api/db/invoice-original/attach', '/api/db/invoice-original/pick', '/api/db/provider/open-portal']) {
    assert.ok(server.includes(`'${route}'`), `server thiếu route ${route}`);
  }
  // Xem PDF phải trả `inline` để iframe hiện được, không phải tải về.
  assert.match(server, /'Content-Type': 'application\/pdf'/, 'phải phục vụ đúng kiểu PDF');
  assert.match(server, /Content-Disposition': `inline/, 'phải đặt Content-Disposition inline');
  // Chặn đọc file ngoài thư mục lưu, và chặn file không phải PDF thật.
  assert.match(server, /Chỉ được chọn file nằm trong thư mục lưu/);
  assert.match(server, /%PDF-/, 'phải kiểm chữ ký %PDF- đầu file');
});

test('browser.js mở được cổng tra cứu trong tab của app (webview), không phải trình duyệt ngoài', () => {
  const browserSrc = fs.readFileSync(path.join(REPO, 'src', 'browser.js'), 'utf8');
  assert.match(browserSrc, /async openAuxPortal\(/, 'phải có openAuxPortal');
  // Tab phải được ghi vào auxTabs để close() dọn sạch, không sót cửa sổ Chrome.
  assert.match(browserSrc, /this\.auxTabs\.add\(created\.id\)/);
  // Chặn URL không phải http(s): kiểm bằng regexp tách riêng để tránh ràng buộc escape.
  assert.ok(/\^https\?/.test(browserSrc) && /openAuxPortal[\s\S]{0,400}https\?/.test(browserSrc),
    'openAuxPortal phải kiểm tra URL là http(s)');
});
