'use strict';
// Bổ sung cho Mục 3 sau khi sửa luồng bấm: lý do phải KHỚP DỮ LIỆU THẬT, phải lưu
// được mã/URL người dùng nhập tay, và URL phải làm sạch trước khi dùng.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const originalPdf = require(path.join(REPO, 'src', 'data', 'original-pdf'));

test('lý do hóa đơn BÁN RA có cổng tra cứu thì KHÔNG được nói "không có mã tra cứu"', () => {
  // Đây đúng lỗi người dùng báo: tooltip ghi "XML cũng không có mã tra cứu" ngay cạnh
  // nút "Tra cứu NCC" — hai câu trái nhau trong cùng một nút.
  const reason = originalPdf.reasonMissing({
    direction: 'SELL', provider_name: 'MISA meInvoice',
    lookup_url: 'https://www.meinvoice.vn/tra-cuu/', lookup_code: '', so_hd: '00032761',
  });
  assert.ok(!/không có mã tra cứu/i.test(reason), `lý do vẫn phủ nhận có mã: ${reason}`);
  assert.ok(/meinvoice\.vn/.test(reason), `phải nêu cổng tra cứu đang có: ${reason}`);
  assert.ok(/hồ sơ này phát hành/.test(reason), 'phải nói rõ đây là hóa đơn của chính hồ sơ');
});

test('lý do hóa đơn BÁN RA có cả cổng lẫn mã thì nêu cả hai', () => {
  const reason = originalPdf.reasonMissing({
    direction: 'SELL', provider_name: 'VNPT-Invoice',
    lookup_url: 'https://hoadondientu.ezrx.com.vn/abc', lookup_code: 'C26TTD-32761',
  });
  assert.match(reason, /ezrx\.com\.vn/);
  assert.match(reason, /C26TTD-32761/);
});

test('lý do hóa đơn MUA VÀO phân biệt đủ 4 tình trạng', () => {
  const base = { direction: 'BUY', provider_name: 'VNPT-Invoice' };
  const both = originalPdf.reasonMissing({ ...base, lookup_url: 'https://x.vn/a', lookup_code: 'M1' });
  assert.match(both, /CAPTCHA/, 'có cổng + mã ⇒ cần CAPTCHA');

  const urlOnly = originalPdf.reasonMissing({ ...base, lookup_url: 'https://x.vn/a', lookup_code: '' });
  assert.match(urlOnly, /chưa có mã tra cứu/, 'chỉ có cổng ⇒ thiếu mã');

  const codeOnly = originalPdf.reasonMissing({ ...base, lookup_url: '', lookup_code: 'M1' });
  assert.match(codeOnly, /chưa có cổng tra cứu/, 'chỉ có mã ⇒ thiếu cổng');

  const none = originalPdf.reasonMissing({ ...base, lookup_url: '', lookup_code: '' });
  assert.ok(none.length > 10, 'không có gì vẫn phải có lý do');
});

test('lý do không bao giờ rỗng và không chứa "undefined"', () => {
  const rows = [
    { direction: 'SELL' }, { direction: 'BUY' },
    { direction: 'SELL', provider_name: 'X', lookup_url: 'https://a.vn/p' },
    { direction: 'BUY', provider_name: 'X', lookup_code: 'C1' },
    { direction: 'BUY', msttcgp: '0100684378', lookup_url: '', lookup_code: '' },
  ];
  for (const row of rows) {
    const reason = originalPdf.reasonMissing(row);
    assert.ok(reason && reason.length > 10, `lý do rỗng cho ${JSON.stringify(row)}`);
    assert.ok(!/undefined|null|NaN/.test(reason), `lý do lộ giá trị rỗng: ${reason}`);
  }
});

// VNPT ghi cổng dạng `https://host;817501;` — dấu `;…` dính vào TÊN MIỀN nên URI gốc
// không mở được, và tên miền đó không khớp biểu thức kiểm tra `.vn$`. Trong kho thật
// có 15 hóa đơn VNPT — nếu không làm sạch thì nút "Mở cổng tra cứu" hỏng với tất cả.
test('cổng VNPT dính cổng `;817501;` được làm sạch thành URL dùng được', () => {
  const raw = 'https://dmcmd-tt78admin.vnpt-invoice.com.vn;817503;';
  const clean = originalPdf.cleanPortalUrl(raw);
  assert.strictEqual(clean, 'https://dmcmd-tt78admin.vnpt-invoice.com.vn');
  assert.strictEqual(originalPdf.portalHost(raw), 'dmcmd-tt78admin.vnpt-invoice.com.vn');
  assert.ok(!clean.includes(';'), 'không được giữ lại dấu chấm phẩy trong URL');
});

test('làm sạch URL: giữ nguyên URL tốt, chặn URL không dùng được', () => {
  const keep = [
    'https://www.meinvoice.vn/tra-cuu/',
    'http://tracuuhoadon1.xcyber.vn/abc',
    'https://x.vn/p?q=1',
  ];
  for (const raw of keep) assert.strictEqual(originalPdf.cleanPortalUrl(raw), raw, `phải giữ nguyên: ${raw}`);

  const drop = [
    'javascript:alert(1)', 'data:text/html,<h1>x', 'file:///C:/Windows/System32',
    'khong phai url', '', null, undefined,
    'https://;817501;',            // chỉ có cổng, không có tên miền
    'https://localhost/x',        // không có dấu chấm trong tên miền
  ];
  for (const raw of drop) {
    assert.strictEqual(originalPdf.cleanPortalUrl(raw), '', `phải bỏ: ${JSON.stringify(raw)}`);
  }
});

test('badge chỉ vàng "Tra cứu NCC" khi URL còn dùng được — bấm vào mới mở được', () => {
  // URL hỏng mà vẫn báo vàng là nhãu dối: người dùng bấm rồi không có gì xảy ra.
  const good = originalPdf.badgeFor({ direction: 'BUY', lookup_url: 'https://x.vn/a' }, '');
  assert.strictEqual(good.kind, 'lookup');
  assert.ok(!good.title.includes(';'), 'tooltip không được lộ dấu ;cổng;');

  const broken = originalPdf.badgeFor({ direction: 'BUY', lookup_url: 'https://;817501;' }, '');
  assert.strictEqual(broken.kind, 'none', 'URL không dùng được thì không được báo vàng');
});

test('server mở cổng qua URL ĐÃ LÀM SẠCH, và lưu URL cũng vậy', () => {
  const server = fs.readFileSync(path.join(REPO, 'src', 'server.js'), 'utf8');
  const openBlock = server.slice(server.indexOf("'/api/db/provider/open-portal'"));
  assert.ok(/cleanPortalUrl/.test(openBlock), 'route mở cổng phải làm sạch URL trước');
  assert.ok(/portalHost/.test(openBlock), 'route mở cổng phải kiểm tên miền đã sạch');
  const saveBlock = server.slice(server.indexOf("'/api/db/invoice-lookup'"));
  assert.ok(/cleanPortalUrl/.test(saveBlock), 'route lưu phải lưu URL đã sạch');
});

test('lưu mã/URL: chỉ hai cột được phép, và giá trị rác bị chặn', () => {
  const server = fs.readFileSync(path.join(REPO, 'src', 'server.js'), 'utf8');
  assert.ok(server.includes("'/api/db/invoice-lookup'"), 'thiếu route lưu mã/URL');
  const block = server.slice(server.indexOf("'/api/db/invoice-lookup'"));
  assert.ok(block.includes("field === 'lookup_code'"), 'phải nhận lookup_code');
  assert.ok(block.includes("field === 'lookup_url'"), 'phải nhận lookup_url');
  assert.ok(/Chỉ được cập nhật mã tra cứu hoặc URL cổng tra cứu/.test(block), 'phải từ chối cột khác');
  assert.ok(/URL phải bắt đầu bằng http/.test(block), 'phải chặn javascript:/data:/file:');
  assert.ok(/URL phải có tên miền/.test(block), 'phải đòi URL có tên miền');
  assert.ok(/value\.length > 120/.test(block), 'phải giới hạn độ dài mã tra cứu');
});

test('sau khi lưu, cột PDF gốc dùng ngay giá trị MÁY CHỦ trả về', () => {
  const ui = fs.readFileSync(path.join(REPO, 'src', 'data-ui.js'), 'utf8');
  assert.ok(/\/api\/db\/invoice-lookup/.test(ui), 'UI phải gọi route lưu mã/URL');
  // Phải lấy giá trị đã làm sạch từ server, không dùng giá trị thô người dùng gõ.
  assert.ok(/result\.value\.value/.test(ui), 'phải dùng giá trị server trả về (URL đã sạch)');
  // Hủy ở hộp nhập thì không mở tiếp hộp chọn file (tránh 2 modal chồng nhau).
  assert.ok(/if \(!ready\) return;/.test(ui), 'bấm Hủy thì phải dừng luồng');
});