const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { Engine, dates, safeName, invoiceHtml, canReuseSearch, classifyDownloadError, validateInvoiceXml } = require('../src/core');
const account = { key: '123|user', mst: '0123456789', label: 'user' };
const params = { from: '2026-01-01', to: '2026-01-31', direction: 'sold', family: 'query', formats: ['xml'], status: '' };
function setup(t, request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { store: path.join(dir, 'job.json'), identity: async () => account, request, emit: () => {}, pdf: async () => Buffer.from('%PDF'), excel: async () => Buffer.from('PK') };
  return { dir, options, engine: new Engine(options) };
}
const invoice = n => ({ shdon: String(n), nbmst: '0123456789', khhdon: 'C26TAA', khmshdon: '1', tthai: 1 });
test('calendar month split handles leap day and invalid dates', () => {
  assert.deepEqual(dates('2024-02-28', '2024-03-02'), [['2024-02-28', '2024-02-29'], ['2024-03-01', '2024-03-02']]);
  assert.throws(() => dates('2026-02-29', '2026-03-01'));
  assert.throws(() => dates('2026-03-02', '2026-03-01'));
});
test('download errors are classified for safe retry handling', () => {
  assert.deepEqual(classifyDownloadError(new Error('TCT không phản hồi sau 30 giây.')).type, 'timeout');
  assert.equal(classifyDownloadError(new Error('TCT trả HTTP 429.')).retryable, true);
  assert.equal(classifyDownloadError(new Error('Gói tải không có XML.')).retryable, false);
  assert.equal(classifyDownloadError(Object.assign(new Error('Hết phiên'), { auth: true })).type, 'auth');
});
test('downloaded XML must identify the requested invoice', () => {
  const xml = '<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>9</SHDon></TTChung></DLHDon></HDon>';
  assert.deepEqual(validateInvoiceXml(xml, invoice(9)), { number: '9', symbol: 'C26TAA', form: '1', verified: true });
  assert.throws(() => validateInvoiceXml(xml, invoice(10)), /không khớp/i);
  assert.equal(validateInvoiceXml('<HDon/>', invoice(9)).verified, false);
  assert.equal(validateInvoiceXml(xml.replace('<SHDon>9</SHDon>', '<SHDon>00000009</SHDon>'), invoice(9)).verified, true, 'số 0 đầu không làm XML thành hóa đơn khác');
});
test('file names and HTML cannot introduce paths or active content', () => {
  assert(!/[<>:"/\\|?*]/.test(safeName('../../x:y')));
  assert.equal(safeName('CON'), '_CON');
  const html = invoiceHtml({ shdon: '<script>alert(1)</script>' }, { hdhhdvu: [{ ten: '<img src=x onerror=alert(1)>' }] });
  assert(!html.includes('<script>')); assert(!html.includes('<img'));
  assert(html.includes('&lt;script&gt;alert(1)'), 'nội dung độc hại phải bị escape chứ không bị cắt');
});
test('file HTML dựng giống trang hóa đơn của cổng thuế (bản chuẩn, không phải bản tự chế)', () => {
  const inv = { shdon: '123', khhdon: 'C26TAA', khmshdon: '1', nbmst: '0100100101', nbten: 'CONG TY A', tdlap: '2026-04-29', tgtttbso: 1100000 };
  const detail = {
    tdlap: '2026-04-29T10:00:00', hdon: '01', nbten: 'CONG TY A', nbmst: '0100100101', nbdchi: 'Ha Noi',
    nmten: 'CONG TY B', nmmst: '4500677693', nmdchi: 'HN', khmshdon: '1', khhdon: 'C26TAA', shdon: '123',
    mhdon: 'MCCQT-TEST-1', tgtcthue: 1000000, tgtthue: 100000, tgtttbso: 1100000, tgtttbchu: 'Một triệu đồng',
    qrcode: 'TEST|0100100101|C26TAA|123|', htttoan: 2,
    hdhhdvu: [{ ten: 'Hàng hóa A', dvtinh: 'cái', sluong: 2, dgia: 500000, thtien: 1000000, ltsuat: '10%', tchat: '1' }],
    thttltsuat: [{ tsuat: '10%', thtien: 1000000, tthue: 100000 }],
    nbcks: JSON.stringify({ SigningTime: '2026-04-29T10:05:00', Subject: 'CN=CONG TY A, O=Ha Noi' })
  };
  const html = invoiceHtml(inv, detail);
  assert(html.includes('class="main-page"'), 'thiếu khung trang hóa đơn như trang thuế');
  assert(html.includes('Times New Roman'), 'phải dùng font Times New Roman như trang thuế');
  assert(html.includes('@page{size:A4'), 'phải khổ A4 khi in');
  assert(html.includes('class="res-tb"'), 'thiếu bảng hàng hóa kiểu trang thuế');
  assert(html.includes('data:image/jpeg;base64,'), 'ảnh nền/dấu chữ ký phải được nhúng vào file HTML');
  // Khối chữ ký số hiện đúng như trang thuế: dấu "Signature Valid" + "Ký bởi <CN>", KHÔNG in cả
  // chuỗi X509 Subject thô.
  assert(html.includes('Signature Valid') && html.includes('>CONG TY A</span>'), 'thiếu khối chữ ký số');
  assert(!html.includes('O=Ha Noi'), 'ô "Ký bởi" chỉ hiện tên đơn vị (CN), không in cả Subject');
  assert(html.includes('K&yacute; ng&agrave;y:'), 'thiếu thời điểm ký của chữ ký số');
  assert(html.includes('<svg'), 'thiếu mã QR');
  assert(html.includes('MCCQT: MCCQT-TEST-1'), 'thiếu dòng MCCQT của hóa đơn có mã');
  assert(html.includes('Hàng hóa A') && html.includes('Một triệu đồng'), 'thiếu dữ liệu hóa đơn');
  assert(!html.includes('dựng từ dữ liệu API'), 'không được còn câu ghi chú của bản tự chế');
  assert(!html.includes('<script'), 'file HTML không được chứa script');
});
test('hóa đơn thiếu dữ liệu vẫn ra một trang HTML hợp lệ', () => {
  const html = invoiceHtml({ shdon: '', khhdon: '', khmshdon: '' }, {});
  // Trang chuẩn của cổng thuế KHÔNG có doctype (cố ý): trình duyệt chạy quirks mode nên cỡ chữ
  // trong bảng mới đúng 16px như bản gốc, nhờ đó .html và .pdf khớp nhau.
  assert(/^<html>/i.test(html));
  assert(html.trimEnd().endsWith('</html>'));
  assert(!html.includes('undefined'), 'thiếu dữ liệu thì để trống, không in "undefined"');
});
test('XML gốc cấp MCCQT/NLap cho HTML khi trang thuế không trả trong detail', async t => {
  // HĐ có mã: MCCQT nằm trong XML gốc; HĐ thiếu ngày lập trong detail thì lấy NLap của XML.
  const xml = '<?xml version="1.0"?><HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon>'
    + '<SHDon>1</SHDon><NLap>2026-01-05</NLap><MCCQT>XML-MCCQT-9</MCCQT></TTChung><NDHDon><NMua>'
    + '<Ten>CONG TY B</Ten><MST>0123456789</MST></NMua></NDHDon></DLHDon></HDon>';
  const zip = new JSZip(); zip.file('invoice.xml', xml);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const detail = { hdon: '01', nbmst: '0123456789', nbten: 'CONG TY A', nmten: 'CONG TY B', nmmst: '0123456789', khmshdon: '1', khhdon: 'C26TAA', shdon: '1', tgtcthue: 100, tgtthue: 10, tgtttbso: 110, thttltsuat: [{ tsuat: '10%', thtien: 100, tthue: 10 }], hdhhdvu: [] };
  const { dir, engine } = setup(t, async route => {
    if (route.includes('export-xml')) return bytes;
    if (route.includes('detail')) return Buffer.from(JSON.stringify(detail));
    return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 }));
  });
  await engine.search({ ...params, formats: ['xml', 'html'] }, dir);
  await engine.resume(true);
  const html = fs.readFileSync(engine.job.items[0].files.find(x => x.endsWith('.html')), 'utf8');
  assert(html.includes('MCCQT: XML-MCCQT-9'), 'MCCQT phải lấy từ XML gốc như luồng API của extension');
  assert(html.includes('Ng&agrave;y 05 th&aacute;ng 01 n&abreve;m 2026'), 'ngày lập phải lấy theo NLap của XML');
  assert(html.includes('class="main-page"'), 'file HTML phải là trang chuẩn của cổng thuế');
  // Chỉ chọn HTML (không chọn XML) thì không gọi thêm API XML — giống extension.
  const onlyHtml = setup(t, async route => {
    if (route.includes('detail')) return Buffer.from(JSON.stringify(detail));
    if (route.includes('export-xml')) throw new Error('không được gọi export-xml khi chỉ chọn HTML');
    return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 }));
  });
  await onlyHtml.engine.search({ ...params, formats: ['html'] }, onlyHtml.dir);
  await onlyHtml.engine.resume(true);
  const single = fs.readFileSync(onlyHtml.engine.job.items[0].files.find(x => x.endsWith('.html')), 'utf8');
  assert(!single.includes('MCCQT:'), 'detail không có MCCQT thì không tự bịa dòng MCCQT');
});
test('pagination retrieves all pages, deduplicates invoices and preserves order', async t => {
  let calls = 0;
  const { dir, engine } = setup(t, async () => {
    calls++;
    return Buffer.from(JSON.stringify(calls === 1 ? { datas: Array.from({ length: 50 }, (_, i) => invoice(i)), total: 51, state: 'page2' } : { datas: [invoice(49), invoice(50)], total: 51, state: '' }));
  });
  await engine.search(params, dir);
  assert.equal(calls, 2); assert.equal(engine.job.items.length, 51); assert.equal(engine.job.state, 'ready');
});
test('hết cursor là hết dữ liệu của tháng: task hoàn tất và có cảnh báo khi count != total', async t => {
  // Cổng trả 1 dòng, không trả cursor, nhưng total nói 100 -> KHÔNG được báo "đã đủ", chỉ ghi cảnh báo
  // và để task hoàn tất (trước đây trường hợp này làm cả lượt tra cứu thất bại).
  const { dir, engine } = setup(t, async () => Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 100 })));
  await engine.search(params, dir);
  const task = engine.job.tasks[0];
  assert.equal(task.done, true);
  assert.equal(task.count, 1);
  assert.equal(task.total, 100);
  assert.equal(task.pages, 1);
  assert.match(task.warning || '', /không nhất quán/);
  assert.equal(engine.job.state, 'ready');
  assert.match(engine.job.message, /CHƯA XÁC NHẬN ĐỦ/);
});
test('cursor lặp lại thì dừng đúng task đó, không lặp vô hạn', async t => {
  let calls = 0;
  const { dir, engine } = setup(t, async () => {
    calls += 1;
    return Buffer.from(JSON.stringify({ datas: Array.from({ length: 50 }, (_, i) => invoice(calls * 100 + i)), total: 5000, state: 'same-cursor' }));
  });
  await engine.search(params, dir);
  const task = engine.job.tasks[0];
  assert.equal(calls, 2, 'trang 1 nhận cursor, trang 2 trả lại chính cursor đó thì phải dừng');
  assert.equal(task.done, false);
  assert.match(task.error, /cursor đã dùng/);
  // Còn task dở -> giữ phase 'search' để "Tải tiếp" vào lại scan(), và state 'partial' để nút đó bật.
  assert.equal(engine.job.phase, 'search');
  assert.equal(engine.job.state, 'partial');
  assert.match(engine.job.message, /CHƯA XÁC NHẬN ĐỦ/);
});
test('trang rỗng mà vẫn còn cursor thì dừng task đó và ghi lỗi', async t => {
  const { dir, engine } = setup(t, async () => Buffer.from(JSON.stringify({ datas: [], total: 10, state: 'next' })));
  await engine.search(params, dir);
  assert.equal(engine.job.tasks[0].done, false);
  assert.match(engine.job.tasks[0].error, /trang rỗng/);
});
test('một tháng lỗi không làm dừng các tháng còn lại', async t => {
  const { dir, engine } = setup(t, async route => {
    if (route.includes('01/01/2026')) return Buffer.from(JSON.stringify({ datas: Array.from({ length: 50 }, (_, i) => invoice(i)), total: 999, state: 'loop' }));
    return Buffer.from(JSON.stringify({ datas: [invoice(500)], total: 1 }));
  });
  await engine.search({ ...params, to: '2026-02-28' }, dir);
  assert.equal(engine.job.tasks.length, 2);
  assert.ok(engine.job.tasks[0].error, 'tháng 01 phải ghi lỗi');
  assert.equal(engine.job.tasks[1].done, true, 'tháng 02 vẫn phải chạy xong');
  assert.equal(engine.job.items.length, 51);
  assert.equal(engine.job.state, 'partial', 'còn tháng lỗi nên chưa phải ready');
  assert.equal(engine.job.phase, 'search', 'giữ phase search để Tải tiếp chạy nốt tháng lỗi');
});
test('resume() chỉ chạy lại tháng lỗi, tiếp từ cursor đã lưu, không quét lại tháng đã xong', async t => {
  let january = 0;
  const routes = [];
  const { dir, engine } = setup(t, async route => {
    routes.push(route);
    if (route.includes('01/01/2026')) {
      january += 1;
      if (january === 1) return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 2, state: 'c1' }));
      if (january === 2) throw new Error('TCT không phản hồi sau 30 giây.');
      return Buffer.from(JSON.stringify({ datas: [invoice(2)], total: 2 }));
    }
    return Buffer.from(JSON.stringify({ datas: [invoice(500)], total: 1 }));
  });
  await engine.search({ ...params, to: '2026-02-28' }, dir);
  const janTask = engine.job.tasks[0];
  assert.equal(janTask.done, false);
  assert.ok(janTask.cursor, 'cursor của trang kế tiếp phải được giữ lại');
  assert.match(janTask.error, /30 giây/);
  assert.equal(engine.job.tasks[1].done, true, 'tháng 02 đã xong ở lượt đầu');
  assert.equal(engine.job.phase, 'search');
  assert.equal(engine.job.state, 'partial');
  const febCalls = routes.filter(r => r.includes('02/2026')).length;
  assert.equal(febCalls, 1);

  await engine.resume(); // đúng việc nút "Tải tiếp" gọi
  assert.equal(engine.job.tasks[0].done, true, 'retry phải hoàn tất tháng 01');
  assert.equal(engine.job.tasks[0].error, '', 'lỗi cũ phải được xoá sau khi retry thành công');
  assert.equal(engine.job.items.length, 3, '1 + 2 của tháng 01 và 1 của tháng 02');
  assert.equal(routes.filter(r => r.includes('02/2026')).length, febCalls, 'không được quét lại tháng 02 đã xong');
  assert.equal(engine.job.phase, 'download', 'xong hết mới chuyển sang download');
  assert.equal(engine.job.state, 'ready');
});
test('chạy song song nhiều tháng vẫn giữ items đúng thứ tự như chạy tuần tự', async t => {
  // Tháng 01 trả chậm hơn tháng 02 để hai task thật sự chồng lấn; items phải vẫn xếp 01 rồi 02.
  const { dir, engine } = setup(t, async route => {
    if (route.includes('01/01/2026')) { await new Promise(resolve => setTimeout(resolve, 60)); return Buffer.from(JSON.stringify({ datas: [invoice(1), invoice(2)], total: 2 })); }
    return Buffer.from(JSON.stringify({ datas: [invoice(9)], total: 1 }));
  });
  await engine.search({ ...params, to: '2026-02-28' }, dir);
  assert.equal(engine.job.tasks.length, 2);
  assert.deepEqual(engine.job.items.map(x => String(x.invoice.shdon)), ['1', '2', '9'], 'tháng 01 phải đứng trước tháng 02 dù chạy song song');
  assert.equal(engine.job.state, 'ready');
  assert.equal(engine.job.phase, 'download');
});
test('tự chạy tiếp lượt bị ngắt (trên đĩa là searching) khi mở lại app', async t => {
  let calls = 0;
  const { dir, options } = setup(t, async () => { calls += 1; return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })); });
  // Giả lập app bị tắt giữa lượt: trên đĩa vẫn là `searching` và còn task chưa xong.
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    version: 1, id: 'interrupted-1', account, output: dir, params,
    tasks: [{ family: 'query', from: '2026-01-01', to: '2026-01-31', variant: null, cursor: '', count: 0, done: false, seen: [] }],
    items: [], phase: 'search', state: 'searching', message: 'Đang tra cứu...',
  }));
  const restarted = new Engine(options);
  assert.equal(restarted.interrupted, true, 'phải nhận ra lượt bị ngắt');
  assert.equal(restarted.job.state, 'paused', 'vẫn hiện là tạm dừng để UI bật nút Tải tiếp');
  const snapshot = await restarted.autoResume();
  assert.equal(calls, 1, 'phải tự gọi lại cổng một lần');
  assert.equal(snapshot.state, 'ready', 'chạy tiếp xong thì về ready');
  assert.equal(restarted.job.items.length, 1);
});
test('KHÔNG tự chạy tiếp khi người dùng đã bấm Tạm dừng (trên đĩa là paused)', async t => {
  let calls = 0;
  const { dir, options } = setup(t, async () => { calls += 1; return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })); });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    version: 1, id: 'paused-1', account, output: dir, params,
    tasks: [{ family: 'query', from: '2026-01-01', to: '2026-01-31', variant: null, cursor: '', count: 0, done: false, seen: [] }],
    items: [], phase: 'search', state: 'paused', message: 'Đã tạm dừng. Có thể tải tiếp.',
  }));
  const restarted = new Engine(options);
  assert.equal(restarted.interrupted, false);
  assert.equal(await restarted.autoResume(), null);
  assert.equal(calls, 0, 'không được gọi cổng khi người dùng đã chủ động tạm dừng');
  assert.equal(restarted.job.state, 'paused');
});
test('XML ZIP extraction, checkpoint restore, and existing file skip', async t => {
  const zip = new JSZip(); zip.file('../../invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  let downloads = 0;
  const { dir, engine, options } = setup(t, async route => {
    if (route.includes('export-xml')) { downloads++; return bytes; }
    return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 }));
  });
  await engine.search(params, dir); await engine.resume(true);
  assert.equal(engine.job.state, 'completed'); assert.equal(downloads, 1);
  const file = engine.job.items[0].files[0]; assert(file.startsWith(dir + path.sep)); assert(fs.readFileSync(file, 'utf8').includes('<HDon/>'));
  const restored = new Engine(options); await restored.resume(true); assert.equal(downloads, 1);
  fs.unlinkSync(file); await restored.resume(true); assert.equal(downloads, 2);
});
test('downloaded files are grouped by MST, direction and format only', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const { dir, engine } = setup(t, async route => route.includes('export-xml') ? bytes : Buffer.from(JSON.stringify({ datas: [invoice(9)], total: 1 })));
  await engine.search({ ...params, direction: 'sold', formats: ['xml', 'zip', 'xlsx'] }, dir);
  await engine.resume(true);
  const relative = engine.job.items[0].files.map(f => path.relative(dir, f).split(path.sep).join('/'));
  // Cây đúng: MST-<MST>/<Mua_vao|Ban_ra>/<xml|pdf|html|zip>/<tên file>
  assert(relative.every(x => /^MST-0123456789\/Ban_ra\/(xml|zip)\/[^/]+$/.test(x)), relative.join(', '));
  assert(!relative.some(x => path.dirname(x).includes('C26TAA')), 'the invoice symbol must not become a folder (only part of the file name)');
  const summaryDir = path.join(dir, 'MST-0123456789');
  assert.deepEqual(fs.readdirSync(summaryDir).sort(), ['Ban_ra', 'bao-cao-' + engine.job.id + '.json'], 'only Mua_vao/Ban_ra below the MST folder');
  const directionFiles = fs.readdirSync(path.join(summaryDir, 'Ban_ra')).sort();
  const xlsx = directionFiles.filter(x => x.endsWith('.xlsx'));
  assert.equal(xlsx.length, 1, 'bảng Excel nằm ngay trong Ban_ra');
  assert(directionFiles.includes('xml') && directionFiles.includes('zip'), 'hóa đơn nằm trong thư mục con theo định dạng');
  assert(fs.readdirSync(summaryDir).some(x => x.startsWith('bao-cao')), 'the run report stays at MST-.../');
});
test('files left flat in <Mua_vao|Ban_ra> by the earlier build are still recognised', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  let downloads = 0;
  const request = async route => { if (route.includes('export-xml')) { downloads++; return bytes; } return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })); };
  const first = setup(t, request);
  await first.engine.search({ ...params, formats: ['xml', 'xlsx'] }, first.dir); await first.engine.resume(true);
  assert.equal(downloads, 1);
  // Mô phỏng bản trước: kéo file XML ra nằm thẳng trong thư mục nhánh (không có thư mục xml/).
  const flat = first.engine.job.items[0].files.find(x => x.endsWith('.xml'));
  const target = path.join(first.dir, 'MST-0123456789', 'Ban_ra', path.basename(flat));
  fs.renameSync(flat, target); fs.rmdirSync(path.dirname(flat));
  const second = setup(t, request);
  await second.engine.search({ ...params, formats: ['xml', 'xlsx'] }, first.dir); await second.engine.resume(true);
  assert.equal(downloads, 1, 'không tải lại file đã có (dù nằm phẳng trong Mua_vao)');
  assert.equal(second.engine.job.items[0].files.find(x => x.endsWith('.xml')), target);
});
test('a fresh search does not re-download invoices whose files are already on disk', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  let downloads = 0;
  const request = async route => { if (route.includes('export-xml')) { downloads++; return bytes; } return Buffer.from(JSON.stringify({ datas: [invoice(1), invoice(2)], total: 2 })); };
  const first = setup(t, request);
  await first.engine.search({ ...params, formats: ['xml'] }, first.dir); await first.engine.resume(true);
  assert.equal(downloads, 2);
  assert.deepEqual([first.engine.job.stats.total, first.engine.job.stats.downloaded, first.engine.job.stats.skipped], [2, 2, 0]);
  // Tra cứu LẠI cùng khoảng ngày: job mới không biết file nào đã có, nên phải quét thư mục đích.
  const second = new Engine({ ...first.options, store: path.join(first.dir, 'job2.json'), request });
  await second.search({ ...params, formats: ['xml'] }, first.dir); await second.resume(true);
  assert.equal(downloads, 2, 'file đã có trên đĩa thì không request lại');
  const stats = second.job.stats;
  assert.deepEqual({ total: stats.total, existed: stats.existed, queued: stats.queued, downloaded: stats.downloaded, skipped: stats.skipped, failed: stats.failed }, { total: 2, existed: 2, queued: 0, downloaded: 0, skipped: 2, failed: 0 });
  assert.deepEqual(second.job.items.map(x => x.state), ['skipped', 'skipped']);
  assert.deepEqual(second.job.items[0].files, first.engine.job.items[0].files, 'dùng lại đúng file cũ, không tạo file trùng');
  assert.equal(second.job.state, 'completed');
  // Giao diện cần đường dẫn file từng dòng để bấm vào mở hóa đơn.
  const snapshot = second.snapshot();
  assert.equal(snapshot.items.length, 2);
  assert(snapshot.items.every(x => x.files.length >= 1), 'mỗi dòng phải kèm đường dẫn file đã có');
});
test('pause stops a running search right away and keeps what was found', async t => {
  // Trang đầu trả về ngay (đã có 1 hóa đơn), trang sau chậm — bấm tạm dừng trong lúc chờ trang sau.
  let calls = 0;
  const { dir, engine } = setup(t, async () => {
    calls += 1;
    if (calls > 1) await new Promise(resolve => setTimeout(resolve, 200));
    return Buffer.from(JSON.stringify({ datas: [invoice(calls)], total: 500, state: `p${calls}` }));
  });
  const running = engine.search({ ...params, formats: ['xml'] }, dir);
  setTimeout(() => engine.pause(), 80); // người dùng bấm “Tạm dừng tra cứu”
  const snapshot = await running;
  assert.equal(snapshot.state, 'paused');
  assert.equal(engine.busy, false, 'engine phải rảnh ngay sau khi tạm dừng');
  assert.match(snapshot.message, /tạm dừng/i);
  assert.equal(snapshot.total, 1, 'không mất hóa đơn đã tìm được trước khi dừng');
});
test('pause also stops a running download mid-way', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  // 20 hoá đơn để chắc chắn còn hoá đơn dở: luồng tải chạy NHIỀU worker song song nên không thể
  // khẳng định "đúng 1 hoá đơn xong" — chỉ có thể chắc chắn ≥1 xong và < tổng.
  const invoices = Array.from({ length: 20 }, (_, i) => invoice(i + 1));
  const { dir, options } = setup(t, async route => {
    if (route.includes('export-xml')) { await new Promise(resolve => setTimeout(resolve, 20)); return bytes; }
    return Buffer.from(JSON.stringify({ datas: invoices, total: invoices.length }));
  });
  // Tạm dừng NGAY khi hoá đơn đầu tiên hoàn tất — mốc XÁC ĐỊNH qua emit, không dùng hẹn giờ, nên
  // test không phụ thuộc tốc độ máy (trước đây dùng setTimeout(…,120) nên máy bận là done=0, đỏ oan).
  let paused = false;
  let engine = null;
  engine = new Engine({
    ...options,
    emit: snapshot => { if (!paused && snapshot.done >= 1) { paused = true; engine.pause(); } },
  });
  await engine.search({ ...params, formats: ['xml'] }, dir);
  const snapshot = await engine.resume(true);
  assert.equal(snapshot.state, 'paused');
  assert.ok(snapshot.done >= 1 && snapshot.done < invoices.length, `dừng giữa đường (done=${snapshot.done}/${invoices.length})`);
});

// GỐI ĐẦU: khi trang 1 còn cursor thì app LẤY TRƯỚC trang 2 (search-2) rồi mới bắt đầu tải trang 1
// (download-1, download-2) — nhờ vậy cổng không bị nghỉ giữa hai trang. Trước đây thứ tự là tải xong
// trang 1 mới tra cứu trang 2; đổi theo yêu cầu "tra cứu gối đầu để tải cuốn chiếu không bị delay".
test('tải cuốn chiếu: LẤY TRƯỚC trang kế rồi tải trang hiện tại (gối đầu, không chờ hết trang)', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const events = [];
  let page = 0;
  const { dir, engine } = setup(t, async route => {
    if (route.includes('export-xml')) { events.push(`download-${new URLSearchParams(route.split('?')[1]).get('shdon')}`); return bytes; }
    page += 1; events.push(`search-${page}`);
    return Buffer.from(JSON.stringify({ datas: [invoice(page)], total: 2, state: page === 1 ? 'next-page' : null }));
  });
  const snapshot = await engine.stream(params, dir);
  assert.deepEqual(events, ['search-1', 'search-2', 'download-1', 'download-2'], 'search-2 (trang kế) phải được gọi TRƯỚC khi tải trang 1');
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.mode, 'stream');
  assert.equal(snapshot.items.length, 2, 'UI chỉ nhận các hóa đơn tải thành công');
  assert(snapshot.items.every(item => item.state === 'done'));
});
test('purchase invoices land in Mua_vao regardless of the issued-code state', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const { dir, engine } = setup(t, async route => route.includes('export-xml') ? bytes : Buffer.from(JSON.stringify({ datas: [{ ...invoice(3), ttxly: 6 }, { ...invoice(4), ttxly: 5 }], total: 2 })));
  await engine.search({ ...params, direction: 'purchase', formats: ['xml'] }, dir);
  await engine.resume(true);
  const relative = engine.job.items.flatMap(x => x.files).map(f => path.relative(dir, f).split(path.sep).join('/'));
  assert.equal(relative.length, 2);
  assert(relative.every(x => /^MST-0123456789\/Mua_vao\/xml\/[^/]+\.xml$/.test(x)), relative.join(', '));
});
test('saving the job leaves no .part file behind and overwrites cleanly', async t => {
  const zip = new JSZip(); zip.file('invoice.xml', '<?xml version="1.0"?><HDon/>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const { dir, engine } = setup(t, async route => route.includes('export-xml') ? bytes : Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })));
  await engine.search({ ...params, formats: ['xml'] }, dir);
  engine.job.message = 'ghi lại lần 2'; engine.save();
  const store = path.join(dir, 'job.json');
  assert.deepEqual(fs.readdirSync(dir).filter(x => x.endsWith('.part')), [], 'không còn file tạm .part (lỗi rename EPERM trên Windows)');
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).message, 'ghi lại lần 2');
});
test('different account cannot resume a saved job', async t => {
  let requests = 0;
  const { dir, engine } = setup(t, async () => { requests++; return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })); });
  await engine.search(params, dir); engine.identity = async () => ({ key: 'other' }); await engine.resume(true);
  assert.equal(engine.job.state, 'auth_required'); assert.equal(requests, 1);
});
test('pause does not checkpoint a partially completed response', async t => {
  const { dir, engine } = setup(t, async () => { engine.pause(); return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 })); });
  await engine.search(params, dir); assert.equal(engine.job.state, 'paused'); assert.equal(engine.job.tasks[0].done, false);
  engine.request = async () => Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 }));
  await engine.resume(); assert.equal(engine.job.state, 'ready'); assert.equal(engine.job.items.length, 1);
});
test('invalid XML response is kept as per-invoice failure', async t => {
  const { dir, engine } = setup(t, async route => Buffer.from(route.includes('export-xml') ? '{"message":"No XML"}' : JSON.stringify({ datas: [invoice(1)], total: 1 })));
  await engine.search(params, dir); await engine.resume(true);
  assert.equal(engine.job.state, 'partial'); assert.equal(engine.job.items[0].state, 'failed'); assert.equal(engine.job.items[0].files.length, 0);
});
test('retry does not inflate queued or failed counters', async t => {
  const good = Buffer.from('<HDon><DLHDon><TTChung><KHMSHDon>1</KHMSHDon><KHHDon>C26TAA</KHHDon><SHDon>1</SHDon></TTChung></DLHDon></HDon>');
  let attempts = 0;
  const { dir, engine } = setup(t, async route => {
    if (!route.includes('export-xml')) return Buffer.from(JSON.stringify({ datas: [invoice(1)], total: 1 }));
    attempts += 1;
    if (attempts === 1) throw new Error('network timeout');
    return good;
  });
  await engine.search(params, dir); await engine.resume(true);
  assert.deepEqual({ queued: engine.job.stats.queued, downloaded: engine.job.stats.downloaded, failed: engine.job.stats.failed }, { queued: 1, downloaded: 0, failed: 1 });
  await engine.resume(true);
  assert.deepEqual({ queued: engine.job.stats.queued, downloaded: engine.job.stats.downloaded, failed: engine.job.stats.failed }, { queued: 1, downloaded: 1, failed: 0 });
});
test('HTTP 429 pauses the queue instead of failing every remaining invoice', async t => {
  const invoices = Array.from({ length: 10 }, (_, index) => invoice(index + 1));
  let exports = 0;
  const { dir, engine } = setup(t, async route => {
    if (!route.includes('export-xml')) return Buffer.from(JSON.stringify({ datas: invoices, total: invoices.length }));
    exports += 1;
    throw new Error('TCT trả HTTP 429 – quá nhiều yêu cầu.');
  });
  await engine.search(params, dir); await engine.resume(true);
  assert.equal(engine.job.state, 'paused');
  assert.ok(exports <= 2, `chỉ các worker đang bay được phép lỗi, thực tế ${exports}`);
  assert.ok(engine.job.stats.failed <= 2);
});
test('Tra cứu & tải ngay: CHỈ tái sử dụng danh sách khi điều kiện trùng hoàn toàn', () => {
  const ready = { phase: 'download', state: 'ready', params: { ...params, formats: ['xml', 'pdf'] } };
  const same = { ...params, formats: ['pdf', 'xml'] };
  assert.equal(canReuseSearch(ready, same), true, 'cùng điều kiện (khác thứ tự formats) thì dùng lại danh sách');
  assert.equal(canReuseSearch(ready, { ...same, from: '2025-12-01' }), false, 'khác TỪ NGÀY thì không dùng lại');
  assert.equal(canReuseSearch(ready, { ...same, to: '2026-02-28' }), false, 'khác ĐẾN NGÀY thì không dùng lại');
  assert.equal(canReuseSearch(ready, { ...same, direction: 'purchase' }), false, 'khác chiều mua/bán thì không dùng lại');
  assert.equal(canReuseSearch(ready, { ...same, family: 'sco-query' }), false, 'khác nhóm hóa đơn thì không dùng lại');
  assert.equal(canReuseSearch(ready, { ...same, formats: ['xml'] }), false, 'khác định dạng tải thì không dùng lại');
  assert.equal(canReuseSearch(ready, { ...same, status: '1' }), false, 'khác trạng thái thì không dùng lại');
  assert.equal(canReuseSearch({ phase: 'search', state: 'searching', params }, params), false, 'đang tra cứu thì không dùng lại');
  assert.equal(canReuseSearch({ phase: 'search', state: 'partial', params }, params), false, 'tra cứu dở thì không dùng lại');
  assert.equal(canReuseSearch({ phase: 'download', state: 'paused', params }, params), false, 'job tạm dừng thì không dùng lại (phải bấm Tải tiếp)');
  assert.equal(canReuseSearch(null, params), false, 'chưa có lượt nào thì không dùng lại');
});
test('Mở lại EXE giữa lúc đang chạy: job chuyển "paused", KHÔNG tự chạy, không chiếm trạng thái bận', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-interrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'job.json');
  fs.writeFileSync(store, JSON.stringify({ version: 1, id: 'x', account, output: dir, params, tasks: [], items: [], phase: 'download', state: 'downloading', mode: 'stream', message: 'Đang tải...' }));
  let calls = 0;
  const engine = new Engine({
    store, identity: async () => account, request: async () => { calls += 1; return Buffer.from('{}'); },
    emit: () => {}, pdf: async () => Buffer.alloc(0), excel: async () => Buffer.alloc(0),
  });
  assert.equal(engine.job.state, 'paused', 'lượt dở phải nằm ở trạng thái tạm dừng, không tự chạy');
  assert.equal(engine.interrupted, true, 'phải ghi nhớ lượt bị ngắt để người dùng chủ động Tải tiếp');
  assert.equal(engine.busy, false, 'không được chiếm trạng thái bận ⇒ form đăng nhập vẫn bấm được');
  assert.equal(calls, 0, 'không được gọi mạng khi chưa có phiên đăng nhập');
});

test('Tải ngay: gối đầu TRANG KẾ trong lúc tải trang hiện tại (không ngồi chờ hết trang)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-prefetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const request = async query => {
    const q = String(query);
    if (q.includes('export-xml')) { calls.push('xml'); return Buffer.from('<?xml version="1.0" encoding="UTF-8"?><HDon/>'); }
    const matched = /[?&]state=([^&]*)/.exec(q);
    const cursor = matched ? decodeURIComponent(matched[1]) : '';
    calls.push('page:' + (cursor || 'first'));
    if (!cursor) return Buffer.from(JSON.stringify({ datas: [invoice(1), invoice(2)], total: 4, state: 'c1' }));
    return Buffer.from(JSON.stringify({ datas: [invoice(3), invoice(4)], total: 4, state: '' }));
  };
  const engine = new Engine({
    store: path.join(dir, 'job.json'), identity: async () => account, request,
    emit: () => {}, pdf: async () => Buffer.alloc(0), excel: async () => Buffer.alloc(0),
  });
  await engine.stream(params, dir);
  assert.deepEqual(calls.slice(0, 2), ['page:first', 'page:c1'], 'phải LẤY TRƯỚC trang kế (bằng cursor vừa nhận) ngay khi trang đầu xong');
  assert.ok(calls.slice(2).every(x => x === 'xml'), 'chỉ sau khi đã lấy trước trang kế mới bắt đầu tải XML của trang hiện tại');
  assert.equal(engine.job.stats.prefetched, 1, 'phải ghi nhận số trang đã gối đầu');
  assert.equal(engine.job.state, 'completed');
  assert.equal(engine.job.items.length, 4, 'không được mất hóa đơn nào');
});
