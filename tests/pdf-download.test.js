'use strict';
// ---------------------------------------------------------------------------
// IN PDF — trần thời gian printToPDF và XML gốc cho MCCQT
//
// Lỗi 1 (nghiêm trọng): bản cũ viết
//     try { return Promise.race([...]) } finally { clearTimeout(timer) }
// trong hàm KHÔNG async. `finally` chạy đồng bộ ngay sau khi Promise.race trả về
// promise — TỨC clearTimeout xoá timer TRƯỚC khi race settle. Trần 60 giây chết
// ngay lập tức, Promise.race treo vô hạn. Hệ quả: tab/CDP treo ⇒ cả `downloadConcurrency`
// worker đều kẹt ⇒ lượt tải KHÔNG BAO GIỜ kết thúc, không báo lỗi, không dừng được.
//
// Lỗi 2 (âm thầm): XML gốc chỉ được tải khi người dùng chọn xml/zip. Tải riêng PDF
// thì sourceXml rỗng ⇒ withXmlFields() trả detail nguyên trạng ⇒ dòng "MCCQT:" mất
// khỏi hóa đơn in ra. File vẫn tạo được nên không ai thấy lỗi.
//
// Yêu cầu: sửa lỗi PDF, các LOẠI HÓA ĐƠN/ĐỊNH DẠNG khác giữ nguyên.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const browserSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'browser.js'), 'utf8');
const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
const { withTimeout, PDF_TIMEOUT_MS } = require('../src/browser.js');

// ---------------------------------------------------------------------------
// 1. TRẦN THỜI GIAN THẬT SỰ HOẠT ĐỘNG
// ---------------------------------------------------------------------------
test('REGRESSION: thao tác treo phải bị ném lỗi sau đúng số giây quy định', async () => {
  // Đây là bản tái lại nguyên khuôn code cũ, chỉ khác thời hạn rút còn 300ms.
  const started = Date.now();
  await assert.rejects(
    () => withTimeout(() => new Promise(() => {}), 300, 'treo quá lâu'),
    /treo quá lâu/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 280, `phải chờ đủ hạn mới ném lỗi (chỉ ${elapsed}ms)`);
  assert.ok(elapsed < 3000, `phải ném đúng hạn, không chờ lâu vô ích (${elapsed}ms)`);
});

test('REGRESSION: lỗi ném ra phải mang cờ timeout để phân loại được', async () => {
  await withTimeout(() => new Promise(() => {}), 200, 'hết giờ').catch(error => {
    assert.equal(error.timeout, true, 'phải có error.timeout = true');
    assert.equal(error.message, 'hết giờ');
  });
});

test('REGRESSION: thao tác xong sớm thì trả kết quả, KHÔNG ném lỗi', async () => {
  assert.equal(await withTimeout(async () => 'xong', 5000, 'hết giờ'), 'xong');
  assert.deepEqual(await withTimeout(async () => ({ a: 1 }), 5000, 'hết giờ'), { a: 1 });
});

test('REGRESSION: lỗi gốc phải được ném nguyên vẹn, không bị đổi thành lỗi timeout', async () => {
  // Che lỗi thật của printToPDF bằng thông báo timeout là mất dấu vết khi điều tra.
  await assert.rejects(() => withTimeout(async () => { throw new Error('lỗi gốc'); }, 5000, 'hết giờ'), /lỗi gốc/);
  await withTimeout(async () => { throw new Error('lỗi gốc'); }, 5000, 'hết giờ').catch(error => {
    assert.equal(error.timeout, undefined, 'lỗi gốc không được gắn cờ timeout');
  });
});

test('REGRESSION: sau khi hết hạn thì timer phải được dọn, không giữ tiến trình', async () => {
  // Không dọn thì mỗi lượt tải PDF để lại một timer 60 giây treo ⇒ rò rỉ bộ nhớ.
  const before = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
  for (let i = 0; i < 5; i++) await withTimeout(async () => i, 5000, 'hết giờ');
  const after = process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
  assert.ok(after <= before, `còn sót timer: ${before} → ${after}`);
});

test('trần thời gian phải là con số, không để vô hạn', () => {
  assert.equal(typeof PDF_TIMEOUT_MS, 'number');
  assert.ok(PDF_TIMEOUT_MS >= 10000, 'quá ngắn thì máy yếu in nổi A4');
  assert.ok(PDF_TIMEOUT_MS <= 120000, 'quá dài thì lượt tải đứng im rất lâu');
});

test('printToPDF phải đi qua withTimeout, không tự dựng race sai khuôn cũ', () => {
  const body = browserSrc.slice(browserSrc.indexOf('async pdf(html)'));
  assert.match(body, /withTimeout\(/, 'pdf() phải bọc printToPDF bằng withTimeout');
  assert.doesNotMatch(body, /Promise\.race/, 'pdf() không được tự viết Promise.race nữa');
  assert.match(body, /printToPDF/, 'vẫn phải gọi printToPDF');
  assert.match(browserSrc, /clearTimeout\(timer\);\s*\}\s*$/m, 'clearTimeout phải nằm cuối hàm withTimeout');
});

test('REGRESSION: withTimeout phải await bên trong, nếu không timer lại chết như cũ', () => {
  const body = browserSrc.slice(browserSrc.indexOf('async function withTimeout'));
  const fn = body.slice(0, body.indexOf('\nfunction '));
  assert.match(fn, /await Promise\.race\(/,
    'thiếu await ⇒ finally chạy sớm và xoá timer trước khi race settle — đúng lỗi cũ');
});

// ---------------------------------------------------------------------------
// 2. XML GỐC CHO MCCQT
// ---------------------------------------------------------------------------
test('REGRESSION: tải riêng PDF vẫn phải lấy XML gốc, nếu không mất dòng MCCQT', () => {
  const body = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['html', 'pdf'].includes(x))"));
  const block = body.slice(0, body.indexOf('item.state = \'done\''));
  assert.match(block, /if \(!sourceXml[\s\S]{0,400}export-xml\?/,
    'PDF/HTML mà chưa có XML gốc thì phải tải export-xml');
  assert.match(block, /withXmlFields\(detail, sourceXml\)/, 'vẫn phải ghép XML vào detail');
});

test('hết XML gốc thì vẫn in được PDF, chỉ mất MCCQT — không làm hỏng cả lượt tải', () => {
  const body = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['html', 'pdf'].includes(x))"));
  const block = body.slice(0, body.indexOf('item.state = \'done\''));
  const guard = block.slice(block.indexOf('catch (error)'));
  assert.match(guard, /item\.warning/, 'phải ghi cảnh báo cho người dùng biết');
  // Được ném, nhưng CHỈ tín hiệu DỪNG. Nuốt mất `paused` thì nghẽn dây chuyền đang
  // chạy không dừng đúng — mỗi lượt đều phải ghi đè.
  assert.match(guard, /if \(error && error\.paused\) throw error;/,
    'phải ném lại tín hiệu paused');
  assert.doesNotMatch(guard.replace(/if \(error && error\.paused\) throw error;/, ''), /throw/,
    'ngoài tín hiệu paused thì KHÔNG ném lỗi khác');
});

// ---------------------------------------------------------------------------
// 3. CÁC ĐỊNH DẠNG KHÁC GIỮ NGUYÊN
// ---------------------------------------------------------------------------
test('REGRESSION: XML/ZIP không đổi hành vi — vẫn là một nhánh riêng, không lấy trùng', () => {
  const block = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['xml', 'zip'].includes(x))"));
  assert.match(block, /export-xml\?/, 'nhánh xml/zip vẫn phải tải export-xml như cũ');
  assert.match(block, /validateInvoiceXml\(sourceXml, inv\)/, 'vẫn phải kiểm tra định danh XML');
  assert.match(block, /item\.xmlIdentity/, 'vẫn phải ghi kết quả đối chiếu');
  // Điều kiện phải là "chưa có XML" để không tải lần thứ hai, VÀ chỉ lấy XML khi
  // detail THIẾU mã/ngày — vì detail đã có sẵn mhdon + tdlap thì export-xml là thừa
  // một lời gọi lên cổng thuế (cổng có giới hạn nhịp).
  assert.match(coreSrc, /if \(!sourceXml && !\(detail && detail\.mhdon && detail\.tdlap\)\)/,
    'điều kiện phải là "chưa có XML" + "detail còn thiếu mã/ngày"');
});

test('các định dạng khác không bị đụng tới', () => {
  // Không được thêm request nào vào luồng chỉ tải XML/ZIP.
  const block = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['xml', 'zip'].includes(x))"));
  const zipBlock = block.slice(0, block.indexOf("formats.some(x => ['html', 'pdf']"));
  assert.doesNotMatch(zipBlock, /Không lấy được XML gốc/,
    'cảnh báo PDF không được lọt vào nhánh xml/zip');
});

// ---------------------------------------------------------------------------
// 4. SỐ LỜI GỌI LÊN CỔNG THUẾ
// ---------------------------------------------------------------------------

test('REGRESSION: detail phải được lấy TRƯỚC khi cân nhắc lấy XML', () => {
  // Cổng thuế có giới hạn nhịp. Nếu lấy export-xml trước rồi mới lấy detail thì mỗi
  // hóa đơn tốn 2 lời gọi vô điều kiện, kể cả khi detail đã đủ dữ liệu in.
  const body = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['html', 'pdf'].includes(x))"));
  const block = body.slice(0, body.indexOf("item.state = 'done'"));
  const detailAt = block.indexOf('const detail = JSON.parse');
  const xmlAt = block.indexOf('export-xml');
  assert.ok(detailAt > 0 && xmlAt > 0, 'phải có cả hai lời gọi');
  assert.ok(detailAt < xmlAt,
    `detail phải lấy trước export-xml (detail ở ${detailAt}, xml ở ${xmlAt})`);
});

test('XML chỉ là DỰ PHÒNG: HTML cần 66 trường mà XML gốc chỉ cho 2', () => {
  // Ghi rõ lý do để đừng ai đó "tối ưu" ngược lại thành tải XML rồi tự dựng PDF:
  // XML không đủ dữ liệu để dựng hóa đơn.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'invoice-html.js'), 'utf8');
  const body = html.slice(html.indexOf('function buildInvoiceHtml'));
  const fromDetail = new Set([...body.matchAll(/\bd\.([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]));
  const fromXml = new Set(['_xmlMccqt', '_xmlNlap']);
  assert.ok(fromDetail.size >= 60, `HTML phải cần nhiều trường từ detail (thấy ${fromDetail.size})`);
  // Chỉ 2 trường đến từ XML; phần còn lại bắt buộc phải có detail.
  assert.equal(fromXml.size, 2, 'XML chỉ cấp MCCQT + NLap');
  assert.ok(fromDetail.size > fromXml.size * 10,
    'XML không thể thay thế detail — nếu test này fail thì logic tối ưu đã sai');
});

test('trường XML chỉ là DỰ PHÒNG — detail có sẵn mhdon và tdlap', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'invoice-html.js'), 'utf8');
  assert.match(html, /const mccqt\s*=\s*d\._xmlMccqt \|\| d\.mhdon \|\|/,
    'MCCQT phải fallback sang detail.mhdon');
  // File nguồn CĂN CỘT nên có nhiều khoảng trắng quanh `||` — regex phải linh hoạt.
  assert.match(html, /const tdlap\s*=\s*d\._xmlNlap\s*\|\|\s*d\.tdlap/,
    'ngày lập phải fallback sang detail.tdlap');
});

test('REGRESSION: nhánh xml/zip vẫn không bị động tới khi thêm điều kiện mới', () => {
  const block = coreSrc.slice(coreSrc.indexOf("formats.some(x => ['xml', 'zip'].includes(x))"));
  const zipBlock = block.slice(0, block.indexOf("formats.some(x => ['html', 'pdf']"));
  assert.doesNotMatch(zipBlock, /detail\.mhdon/, 'điều kiện mới không được lọt vào nhánh xml/zip');
  assert.match(zipBlock, /export-xml\?/, 'nhánh xml/zip vẫn tải export-xml như cũ');
});

test('cả hai loại hóa đơn (query và sco-query) vẫn dùng chung đường detail', () => {
  for (const family of ['/${inv.family}/invoices/detail?${query}', '/${inv.family}/invoices/export-xml?${query}']) {
    assert.ok(coreSrc.includes(family), `thiếu đường dẫn ${family}`);
  }
  assert.match(coreSrc, /\['query', 'sco-query'\]/, 'vẫn phải hỗ trợ cả hai loại hồ sơ');
});

test('dữ liệu PDF vẫn ghi đúng định dạng và không ghi đè file đã có', () => {
  const block = coreSrc.slice(coreSrc.indexOf('const write = (kind'));
  assert.match(block, /fs\.existsSync\(file\)/, 'vẫn phải bỏ qua file đã tồn tại');
  assert.match(coreSrc, /if \(j\.params\.formats\.includes\('pdf'\)\) write\('pdf', '\.pdf',/, 'vẫn ghi .pdf');
  assert.match(coreSrc, /if \(j\.params\.formats\.includes\('html'\)\) write\('html', '\.html',/, 'vẫn ghi .html');
});

// ---------------------------------------------------------------------------
// 5. PDF RỖNG — lỗi đã xảy ra thật trên máy người dùng
// ---------------------------------------------------------------------------
//
// File thật tìm được trên đĩa: 850 byte, /Title (about:blank), /Length 0,
// /MediaBox [0 0 612 792] (Letter — hóa đơn phải là A4 595x842).
// Nguyên nhân: pdf() gọi this.evalWithTimeout() (chạy trên `this.client` = tab CỔNG
// THUẾ) nên hóa đơn bị document.write vào tab cổng thuế, còn printToPDF in tab
// about:blank vẫn còn trống. Không lỗi nào được ném ra ⇒ người dùng tải về file
// hỏng mà app báo "thành công".
const pdfFn = () => {
  const at = browserSrc.indexOf('async pdf(html)');
  const tail = browserSrc.slice(at);
  return tail.slice(0, tail.indexOf('\n  }'));
};
const pdfCode = () => pdfFn().split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('REGRESSION: HTML phải được ghi vào CHÍNH tab sắp in, không phải tab cổng thuế', () => {
  assert.match(pdfCode(), /client\.Runtime\.evaluate\(/,
    'phải evaluate trên client của tab mới');
  assert.doesNotMatch(pdfCode(), /this\.evalWithTimeout\(/,
    'this.evalWithTimeout() chạy trên this.client = tab CỔNG THUẾ ⇒ in ra trang trắng');
  assert.doesNotMatch(pdfCode(), /this\.eval\(/, 'tương tự: không đánh giá trên tab khác');
});

test('REGRESSION: phải chờ nét chữ và ảnh nền nạp xong trước khi in', () => {
  // In quá sớm thì PDF ra trắng dù HTML đúng. Ảnh nền là data: URL ~200KB.
  assert.match(pdfCode(), /document\.fonts\.ready/, 'phải chờ fonts.ready');
  assert.match(pdfCode(), /document\.images/, 'phải chờ ảnh nền nạp xong');
  assert.match(pdfCode(), /awaitPromise:\s*true/, 'phải awaitPromise để chờ được promise trong trang');
});

test('REGRESSION: KHÔNG BAO GIỜ ghi ra file PDF rỗng', () => {
  // Điều kiện nhận dạng đã tách ra isBlankPdf() để core.js dùng chung — kiểm ở đó,
  // còn pdf() chỉ phải GỌI hàm đó và ném lỗi khi trả true.
  const code = pdfCode();
  assert.match(code, /isBlankPdf\(bytes\)/, 'pdf() phải dùng hàm chung isBlankPdf');
  assert.match(code, /if \(isBlankPdf\(bytes\)\)/, 'phải kiểm tra trước khi trả về');
  assert.match(code, /throw new Error\('Trang hóa đơn in ra rỗng/, 'phải ném lỗi có thông điệp rõ');

  // Hàm chung phải bắt được cả hai dấu hiệu.
  const helper = browserSrc.slice(browserSrc.indexOf('function isBlankPdf'));
  const fn = helper.slice(0, helper.indexOf('\n}'));
  assert.match(fn, /length < 1024/, 'phải chặn PDF quá nhỏ');
  assert.match(fn, /\/Length\\s\+0\\s\*>>\\s\*stream/, 'phải nhận ra stream rỗng');
});

test('REGRESSION: quy tắc PDF rỗng phải là MỘT chỗ, dùng chung giữa sinh PDF và ghi đĩa', () => {
  const { isBlankPdf } = require('../src/browser.js');
  // Gọi được thật, không chỉ so chuỗi mã nguồn.
  assert.equal(isBlankPdf(Buffer.from('')), true, 'rỗng');
  assert.equal(isBlankPdf(null), true, 'null');
  assert.equal(isBlankPdf(Buffer.from('%PDF-1.4\n3 0 obj\n<</Length 0>> stream\n\nendstream\nendobj\n%%EOF\n')), true, 'trang in rỗng');
  assert.equal(isBlankPdf(Buffer.from('%PDF-1.4\n' + 'x'.repeat(5000) + '\n3 0 obj\n<</Length 4210>> stream\nBT (Hoa don) Tj ET\nendstream\nendobj\n%%EOF\n')), false, 'PDF có nội dung');

  // core.js (ghi đĩa) phải dùng đúng hàm đó, không tự viết lần hai.
  assert.match(coreSrc, /const \{ isBlankPdf \} = require\('\.\/browser'\)/,
    'core.js phải import isBlankPdf từ browser.js');
  assert.match(coreSrc, /kind === 'pdf' && isBlankPdf\(existing\)/,
    'write() phải coi PDF rỗng là chưa có để ghi đè');
});

test('REGRESSION: PDF rỗng cũ phải được coi là "chưa có" — không thì không bao giờ tải lại được', () => {
  // File hỏng 850 byte có size > 0 nên logic cũ "bỏ qua file đã có" sẽ bỏ qua nó
  // mãi mãi ⇒ người dùng thử bao nhiêu lần cũng chỉ nhận lại file rỗng.
  const block = coreSrc.slice(coreSrc.indexOf('const write = (kind'));
  const write = block.slice(0, block.indexOf('\n      };'));
  assert.match(write, /isBlankPdf\(existing\)/, 'phải kiểm tra file PDF đang có');
  assert.match(write, /if \(existing\.length > 0 && !blank\)/,
    'chỉ bỏ qua khi file KHÔNG rỗng — file rỗng phải ghi đè');
});

test('pdf() vẫn đóng cả tab mới lẫn kết nối CDP, kể cả khi ném lỗi', () => {
  const fn = pdfFn();
  assert.match(fn, /finally\s*\{/, 'phải có finally để không rò tab');
  assert.match(fn, /client\.close\(\)/, 'đóng kết nối CDP');
  assert.match(fn, /CDP\.Close\(/, 'đóng tab mới');
});