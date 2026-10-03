'use strict';
// Mục 3 — mở cổng tra cứu NCC: phải MỞ ĐƯỢC THẬT, không thu nhỏ, và nói thật khi hỏng.
//
// Ghi chú: luồng CHÍNH đã đổi sang tải tự động (downloadOriginal → provider-download).
// Các test dưới đây bảo vệ những điều vẫn đúng với cả hai đường: route không được đẩy
// Promise vào JSON, Chrome cổng NCC phải là Chrome RIÊNG và phải hiện, và mọi lỗi phải
// được báo ra chứ không bị nuốt.
//
// KINH NGHIỆM: đừng dựa vào việc comment trong src có chứa hay không một mẫu chữ. Hai
// bản test trước của chính file này đã đỏ vì regex khớp trúng câu giải thích trong
// comment (chính tôi viết comment "đừng viết opened: openPortal(url)" rồi test đòi cấm
// đúng chuỗi ấy). Nên: kiểm tra HÀNH VI qua hàm thật, kiểm tra cấu trúc thì bỏ qua comment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(REPO, 'src', name), 'utf8');

// Bỏ comment block trước khi so khớp cấu trúc. BỎ QUA comment `//` vì `//` xuất hiện
// hợp lệ bên trong regex literal (/^https?:\/\//) — cắt ở đó sẽ phá hỏng chính nội dung
// đang kiểm tra. Vì vậy các assertion cấu trúc bên dưới được viết đủ cụ thể để không
// phụ thuộc vào việc có comment hay không.
const stripBlocks = source => source.replace(/\/\*[\s\S]*?\*\//g, ' ');

const server = read('server.js');
const browserSrc = read('browser.js');
const ui = read('data-ui.js');

const between = (source, from, to) => {
  const a = source.indexOf(from);
  assert.ok(a >= 0, `không tìm thấy đoạn: ${from}`);
  const b = to ? source.indexOf(to, a) : -1;
  return source.slice(a, b > 0 ? b : undefined);
};

test('route mở cổng AWAIT kết quả — không được đẩy Promise vào JSON', () => {
  const route = stripBlocks(between(server, "url.pathname === '/api/db/provider/open-portal'",
    "url.pathname === '/api/db/invoices/backfill-lookup'"));
  // Chỉ kiểm tra DÒNG CODE, không kiểm tra cả khối (comment giải thích sẽ chứa mẫu chữ).
  const codeLines = route.split('\n').map(l => l.trim()).filter(l => !l.startsWith('//') && !l.startsWith('*'));
  const code = codeLines.join('\n');
  assert.ok(!/opened:\s*openPortal\(/.test(code),
    'không được đặt Promise của hàm async vào trường opened — phải await trước');
  assert.match(code, /await openPortal\(/, 'phải await openPortal(...)');
  assert.match(code, /withDatabase\(async/, 'callback phải async để được await');
  assert.match(code, /opened:\s*result\.opened/, 'phải trả boolean thật');
  assert.match(code, /error:\s*result\.error/, 'phải trả kèm lý do lỗi');
});

test('openPortal trả boolean thật kèm lý do, và không nuốt lỗi', () => {
  const code = stripBlocks(between(server, 'async function openPortal', '\n}'))
    .split('\n').map(l => l.trim()).filter(l => !l.startsWith('//') && !l.startsWith('*')).join('\n');
  assert.match(code, /opened:\s*true/, 'thành công phải trả opened:true');
  assert.match(code, /opened:\s*false/, 'thất bại phải trả opened:false');
  assert.match(code, /error:\s*message/, 'phải trả kèm lý do');
  assert.match(code, /log\(/, 'phải ghi log khi hỏng');
  assert.ok(!/\.show\(\)/.test(code),
    'không được gọi show() — hàm đó đưa tab CỔNG THUẾ lên trước, che mất tab cổng NCC');
});

test('Chrome cổng NCC là Chrome RIÊNG và cửa sổ luôn hiện', () => {
  const fn = stripBlocks(between(browserSrc, 'async openAuxPortal', 'async closePortalBrowser'));
  // Chỉ lấy phần THÂN hàm: comment có thể nhắc tên cờ, nên cắt trước phần comment đầu.
  const body = fn.slice(fn.indexOf('async openAuxPortal'));
  assert.ok(!/if \(!this\.client\)/.test(body),
    'không được phụ thuộc this.client — Chrome cổng thuế chỉ dựng khi đăng nhập MST');
  // "this.portalProcess" BẮT ĐẦU bằng "this.port", nên phải so trong ngữ cảnh `port: …`.
  assert.ok(!/port:\s*this\.port\b/.test(body), 'không được dùng cổng debug của cổng thuế');
  assert.match(body, /this\.portalPort = await availablePort\(\)/, 'phải có cổng debug riêng');
  assert.match(body, /this\.portalProcess = spawn\(/, 'phải tự dựng Chrome riêng');
  assert.match(body, /'ncc-portal'/, 'phải dùng profile riêng');
  assert.match(body, /windowsHide:\s*false/, 'phải hiện cửa sổ');
  assert.match(body, /windowState: 'normal'/, 'phải bỏ thu nhỏ cửa sổ');
  assert.match(body, /Page\.bringToFront\(\)/, 'phải đưa tab lên trước');
  assert.match(body, /target: created\.id/, 'phải đưa đúng tab vừa tạo lên trước');
  // Cờ thu nhỏ phải KHÔNG xuất hiện trong danh sách tham số spawn — kiểm trên mảng args.
  const argsLine = body.split('\n').find(l => l.includes('--new-window') || l.includes('const args ='));
  const argsBlock = body.slice(body.indexOf('const args ='), body.indexOf(']', body.indexOf('const args =')) + 1);
  assert.ok(!argsBlock.includes('start-minimized'),
    'cửa sổ cổng tra cứu không được thêm cờ thu nhỏ');
  assert.match(body, /\/\^https\?/, 'phải chặn URL không phải http(s)');
  assert.match(stripBlocks(browserSrc), /async closePortalBrowser\(\)/, 'phải có hàm dọn cửa sổ');
});

test('luồng CHÍNH gọi tải tự động, không phải mở cổng thủ công', () => {
  const handler = between(ui, "bindOrig('orig-pick-portal'", '\n});');
  assert.match(handler, /downloadOriginal\(/,
    'nút phải chạy pipeline tải tự động (provider-download), không mở cổng thủ công');
  // Pipeline phải chạy sau khi đóng hộp thoại chọn để không hai modal chồng nhau.
  assert.match(handler, /orig-pick-dialog'\)\.close\(\)/);
  assert.match(ui, /async function downloadOriginal\(/, 'phải có hàm downloadOriginal');
  assert.match(ui, /\/api\/db\/provider\/download/, 'phải gọi route tải tự động');
});

test('hỏi mã tra cứu CHỈ khi cần, và bỏ qua khi đã có mã', () => {
  // ensureLookupInfo(inv, needsCode) — người gọi quyết định có cần mã hay không.
  // Hỏi mã vô điều kiện sẽ hỏi 244 hóa đơn bán ra một cách vô nghĩa; hỏi khi ĐÃ CÓ mã
  // thì phiền không đáng có.
  const body = between(ui, 'async function ensureLookupInfo', '\n}');
  assert.match(body, /needsCode\s*&&\s*!String\(inv\.lookup_code/, 'chỉ hỏi khi được yêu cầu VÀ chưa có mã');
  assert.match(body, /needsCode = false/, 'mặc định không hỏi mã');
  assert.match(body, /lookup_url/, 'vẫn phải hỏi URL cổng khi thiếu');
  // Chỉ hai nơi gọi: một nơi không cần mã, một nơi cần mã.
  const calls = [...ui.matchAll(/ensureLookupInfo\(([^)]*)\)/g)].map(m => m[1].trim());
  assert.ok(calls.includes('inv'), 'phải có lời gọi không cần mã');
  assert.ok(calls.includes('inv, true'), 'phải có lời gọi yêu cầu mã khi tải tự động');
});

test('bảng điền biểu mẫu: chỉ điền trường CÓ dữ liệu thật, không đoán', () => {
  const fill = require(path.join(REPO, 'src', 'data', 'portal-fill'));
  const full = fill.planFor('vnpt', {
    mst_ban: '0101452595', mst_mua: '058183000994', khh_hd: 'K26TSA', so_hd: '289813', lookup_code: 'pc5P7639',
  });
  const labels = full.fields.map(f => f.label);
  for (const need of ['MST người bán', 'MST người mua', 'ký hiệu', 'số hóa đơn', 'mã tra cứu']) {
    assert.ok(labels.includes(need), `thiếu trường ${need}`);
  }
  assert.deepEqual(full.missing, [], 'đủ dữ liệu thì không được báo thiếu gì');

  const noCode = fill.planFor('vnpt', { mst_ban: '0101452595', mst_mua: '058183000994', khh_hd: 'K26TSA', so_hd: '289813', lookup_code: '' });
  assert.deepEqual(noCode.missing, ['mã tra cứu'], 'thiếu mã thì phải báo đúng mã, không bịa thay');
  assert.strictEqual(noCode.fields.length, 6, 'vẫn điền được các trường còn lại');

  const misa = fill.planFor('misa', { direction: 'SELL', khh_hd: 'C26TMD', so_hd: '11924', lookup_code: '' });
  assert.deepEqual(misa.fields, [], 'cổng MISA chỉ có ô mã tra cứu');
  assert.deepEqual(misa.missing, ['mã tra cứu']);

  const vt = fill.planFor('viettel', { mst_ban: '0301140748', khh_hd: 'C26TTT', so_hd: '10349', ngay_lap: '2026-05-05' });
  const byLabel = Object.fromEntries(vt.fields.map(f => [f.label, f.value]));
  assert.strictEqual(byLabel['ký hiệu và số HĐ'], 'C26TTT10349');
  assert.strictEqual(byLabel['ngày lập'], '05/05/2026');

  assert.strictEqual(fill.supports('khac-biet'), false, 'cổng lạ thì nói không hỗ trợ, không đoán');
});

test('kịch bản điền chạy được trong trang: setter gốc + input/change', () => {
  const fill = require(path.join(REPO, 'src', 'data', 'portal-fill'));
  const script = fill.FILL_SCRIPT(fill.planFor('vnpt', { mst_ban: '0101452595', khh_hd: 'K26TSA', so_hd: '289813' }));
  assert.match(script, /getOwnPropertyDescriptor/, 'phải dùng setter gốc, nếu không framework cổng sẽ ghi đè');
  assert.match(script, /new Event\('input'/);
  assert.match(script, /new Event\('change'/);
  assert.match(script, /document\.createElement\('option'\)/, 'phải thêm option cho select nếu chưa có');
  assert.match(script, /JSON\.stringify/, 'phải trả kết quả để Node biết đã điền được gì');
});