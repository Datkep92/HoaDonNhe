'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const XLSX = require('../../resources/xlsx.cjs');
const { executeSafeJs } = require('./safe-js');
const { list, read, readRange, stat, exists, search, glob } = require('./fs-tools');
const { detect, listTables, schema, sample, queryReadonly } = require('./db-tools');
const pdfTools = require('./pdf-tools');
const string = (extra = {}) => ({ type: 'string', maxLength: 200, ...extra });
const date = string({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const filters = { from: date, to: date, direction: string({ enum: ['BUY', 'SELL'] }), q: string(), state: string({ enum: ['active', 'inactive', '1', '2', '3', '4', '5', '6'] }) };
function createRegistry({ app, datasets, dataDir, emit, files, attachments = [], attachmentFiles = null, cloud = null, options = {}, contextTools }) {
  const scope = () => app.context().currentUser.selectedMst;
  const rowsOf = id => datasets.get(id, scope());
  const put = rows => datasets.put(rows, scope());
  const tools = [];
  function add(name, description, properties, required, permission, status, handler) {
    tools.push({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, permission, status, handler });
  }
  // Bản PDF GỐC của một attachment: ưu tiên liên kết sourceId (do UI gắn); nếu bản ghi
  // CŨ không có liên kết thì suy từ tên — "sk.pdf.txt" ⇒ tìm attachment "sk.pdf" cùng ngữ cảnh.
  function resolvePdfSource(file) {
    const linked = attachmentFiles ? (attachmentFiles.source(file) || file) : file;
    if (linked && linked.ext === '.pdf') return linked;
    const name = String(file?.filename || '');
    if (/\.pdf\.txt$/i.test(name)) {
      const target = name.replace(/\.txt$/i, '');
      const sibling = attachments.find(item => item.ext === '.pdf' && item.filename === target);
      if (sibling) return sibling;
    }
    return linked;
  }
  // Ghi một file xuất MỚI vào vùng dữ liệu AI (không ghi đè) + xác minh kích thước +
  // phát sự kiện để UI hiện nút tải. Dùng CHUNG cho file.export_* và file.pdf_to_excel.
  function saveExport(buffer, filename, ext, fileRows, clean) {
    const fileId = randomUUID(), directory = path.join(dataDir, 'ai-exports'); fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, fileId + ext);
    fs.writeFileSync(filePath, buffer, { flag: 'wx' });
    const size = fs.statSync(filePath).size;
    if (!size || size !== buffer.length) throw new Error('Không xác minh được file xuất.');
    fs.writeFileSync(path.join(directory, fileId + '.json'), JSON.stringify({ total: clean.length, rows: clean.slice(0, 50) }), { flag: 'wx' });
    const file = { fileId, filename, size, rows: fileRows };
    files[fileId] = { ...file, ext }; emit({ file });
    return file;
  }
  if (contextTools) {
    add('history.search', 'Tìm đoạn chat cũ trong đúng session/MST khi user nhắc chuyện trước; kết quả lịch sử không phải số liệu hiện tại.', { query: string({ maxLength: 500 }) }, ['query'], 'READ', 'Đang tìm lại nội dung trước…', args => contextTools.searchHistory(args.query));
    add('memory.search', 'Tìm quy tắc do user xác nhận cho công ty hiện tại và quy tắc chung được user chỉ rõ. Không cấp quyền hoặc xác nhận số liệu.', { query: string({ maxLength: 500 }) }, ['query'], 'READ', 'Đang tìm quy tắc đã lưu…', args => contextTools.memories(args.query));
    add('reference.resolve', 'Giải tham chiếu file lúc nãy/bảng kê kia/công ty hiện tại thành ID thật cùng scope. Dataset từ lượt cũ chưa được lưu bền: cần đọc lại nguồn.', { name: string({ enum: ['last_created_file', 'last_reference_file', 'current_company'] }) }, ['name'], 'READ', 'Đang xác định tham chiếu…', args => contextTools.reference(args.name));
  }
  add('app.get_state', 'Xem trạng thái, danh sách MST và tiến độ hiện tại; không trả secret.', {}, [], 'READ', 'Đang kiểm tra ứng dụng…', () => app.context());
  add('mst.get_selected', 'Xem MST đang chọn.', {}, [], 'READ', 'Đang kiểm tra MST…', () => ({ selectedMst: scope() }));

  // ── filesystem (READ-ONLY) ──────────────────────────────────────────
  add('fs.list', 'Liệt kê file và thư mục con trong thư mục local. Trả tên, đường dẫn, loại, kích thước và ngày sửa. Tối đa 200 mục; không tự đọc nội dung file.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang liệt kê thư mục…', (args, signal) => list(args.path, signal));
  add('fs.stat', 'Xem metadata của file/thư mục: tồn tại, loại, kích thước, ngày tạo/sửa. Không đọc nội dung.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang kiểm tra file…', args => stat(args.path));
  add('fs.exists', 'Kiểm tra nhanh file/thư mục có tồn tại không. Dùng trước khi đọc để tránh lỗi.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang kiểm tra đường dẫn…', args => exists(args.path));
  add('fs.read', 'Đọc toàn bộ nội dung file text/code local (≤80KB). File >256KB bị từ chối; dùng fs.read_range cho file lớn. Không đọc binary.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang đọc file…', (args, signal) => read(args.path, signal));
  add('fs.read_range', 'Đọc một đoạn file text theo offset và length (mỗi đoạn ≤80KB). Dùng cho file lớn hoặc đọc tiếp đoạn sau.', { path: string({ maxLength: 1000 }), offset: { type: 'number', minimum: 0 }, length: { type: 'number', minimum: 1, maximum: 80000 } }, ['path'], 'READ', 'Đang đọc đoạn file…', (args, signal) => readRange(args.path, args.offset, args.length, signal));
  add('fs.search', 'Tìm file/thư mục theo từ khóa trong tên trong một thư mục gốc. Giới hạn depth và số kết quả. Không đọc nội dung.', { path: string({ maxLength: 1000 }), query: string({ maxLength: 200 }) }, ['path', 'query'], 'READ', 'Đang tìm kiếm file…', (args, signal) => search(args.path, { query: args.query }, signal));
  add('fs.glob', 'Tìm file/thư mục theo pattern (hỗ trợ * và **). Ví dụ: "**/*.js". Giới hạn depth và số kết quả. Không đọc nội dung.', { path: string({ maxLength: 1000 }), pattern: string({ maxLength: 200 }) }, ['path', 'pattern'], 'READ', 'Đang tìm file theo pattern…', (args, signal) => glob(args.path, { pattern: args.pattern }, signal));

  const search = async args => {
    if (args.from && args.to && args.from > args.to) throw new Error('Khoảng ngày không hợp lệ.');
    const mst = scope(), rows = await app.search(args);
    if (scope() !== mst) throw new Error('MST đã thay đổi; tìm lại dữ liệu.');
    return put(rows);
  };
  add('invoice.search', 'Tìm hóa đơn trong kho local, tạo dataset. Ngày YYYY-MM-DD, BUY=mua vào, SELL=bán ra. Tối đa 20.000 dòng, không cắt dữ liệu âm thầm.', filters, [], 'READ', 'Đang tìm hóa đơn…', search);
  add('data.query', 'Đọc dữ liệu hóa đơn local qua data service theo bộ lọc; tạo dataset.', filters, [], 'READ', 'Đang đọc dữ liệu…', search);
  add('invoice.latest', 'Hóa đơn gần nhất theo ngày lập, cùng ngày ưu tiên dòng được nhập kho sau. Dùng cho câu hỏi hóa đơn gần nhất bao nhiêu tiền / nhà cung cấp nào.', { direction: filters.direction }, ['direction'], 'READ', 'Đang tìm hóa đơn gần nhất…', async args => {
    if (app.latest) return app.latest(args);
    const rows = await app.search(args);
    rows.sort((a, b) => String(b.ngay_lap || '').localeCompare(String(a.ngay_lap || '')) || String(b.so_hd || '').localeCompare(String(a.so_hd || ''), 'vi', { numeric: true }));
    return { invoice: rows[0] || null, sameDateCount: rows[0] ? rows.filter(r => r.ngay_lap === rows[0].ngay_lap).length : 0, note: 'Cùng ngày: ưu tiên số hóa đơn lớn; ngày lập không thể hiện thứ tự thời gian chính xác trong ngày.' };
  });
  if (app.goods) add('goods.query', 'Tổng hợp hàng hóa theo mã, tên, đơn vị và thuế suất qua cùng dịch vụ Kho dữ liệu; chỉ hóa đơn còn hiệu lực. Tạo dataset để xuất Excel hàng hóa. Tối đa dưới 500 nhóm; nếu vượt phải lọc lại.', { from: date, to: date, direction: filters.direction, q: string() }, [], 'READ', 'Đang tổng hợp hàng hóa…', async args => {
    if (args.from && args.to && args.from > args.to) throw new Error('Khoảng ngày không hợp lệ.');
    const mst = scope(), rows = await app.goods(args);
    if (scope() !== mst) throw new Error('MST đã thay đổi; tìm lại dữ liệu.');
    return put(rows);
  });
  add('file.read_attachment', 'Đọc file đã đính kèm. Excel/CSV/JSON tạo dataset toàn bộ sheet để tính toán hoặc xuất lại; văn bản đọc từng đoạn, offset tính theo ký tự. Ảnh đã chuẩn hóa trong tin nhắn. PDF có chữ được trích chữ TẠI MÁY theo từng đoạn (không nhét cả file vào ngữ cảnh); muốn chuyển bảng PDF sang Excel hãy dùng file.pdf_to_excel.', { id: string(), sheet: string(), offset: { type: 'number', minimum: 0, maximum: 2000000 } }, ['id'], 'READ', 'Đang đọc file đính kèm…', args => {
    const file = attachments.find(f => f.id === args.id);
    if (!file) throw new Error('File không thuộc ngữ cảnh cuộc trò chuyện hiện tại.');
    if (file.sheets) {
      const sheet = args.sheet ? file.sheets.find(s => s.name === args.sheet) : file.sheets[0];
      if (!sheet) throw new Error('Không tìm thấy sheet.');
      return { filename: file.filename, sheet: sheet.name, ...put(sheet.rows) };
    }
    if (file.text !== undefined) { const offset = Math.floor(args.offset || 0); return { filename: file.filename, text: file.text.slice(offset, offset + 16000), offset, totalCharacters: file.text.length, nextOffset: offset + 16000 < file.text.length ? offset + 16000 : null }; }
    // PDF: đọc chữ TẠI MÁY theo yêu cầu. Chỉ nhánh này trả Promise (Tool Router luôn await);
    // các nhánh trên giữ NGUYÊN kiểu trả về đồng bộ như trước.
    if (file.ext === '.pdf') {
      if (!attachmentFiles) throw new Error('Máy chủ chưa sẵn sàng để đọc PDF đính kèm.');
      const source = resolvePdfSource(file);
      return pdfTools.readText(attachmentFiles.bytes(source)).then(read => {
        if (read.kind !== 'pdf-text') throw new Error('PDF scan chưa có chữ để đọc local. Gửi ảnh các trang cần phân tích.');
        return { filename: file.filename, ...pdfTools.textSlice(read.pages, args.offset, 16000), pages: read.totalPages, note: 'Muốn chuyển bảng trong PDF sang Excel: dùng file.pdf_to_excel (không cần đọc hết văn bản).' };
      });
    }
    return { filename: file.filename, note: 'Xem ảnh đã chuẩn hóa trong tin nhắn. Nếu model không đọc ảnh, chọn model hỗ trợ vision.' };
  });
  add('data.create', 'Tạo dataset từ JSON mảng object, dùng cho dữ liệu trích xuất từ ảnh/PDF hoặc bảng mới theo yêu cầu. Không bịa dữ liệu nguồn.', { json: string({ maxLength: 60000 }) }, ['json'], 'ANALYZE', 'Đang chuẩn bị bảng dữ liệu…', args => {
    const rows = JSON.parse(args.json);
    if (!Array.isArray(rows) || !rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) throw new Error('Cần mảng các object.');
    return put(rows);
  });
  if (cloud && options.web) {
    add('web.search', 'Tìm thông tin web mới, ưu tiên nguồn gốc cơ quan thuế/Bộ Tài chính/chính phủ. Truy vấn chỉ gồm nội dung cần tra cứu, không chứa dữ liệu tài chính riêng tư. Trả nội dung và nguồn; kiểm tra hiệu lực.', { query: string({ maxLength: 2000 }) }, ['query'], 'READ', 'Đang tra cứu web và nguồn văn bản…', (args, signal) => cloud.search(args.query, signal));
    tools[tools.length - 1].timeout = 90000;
  }
  // Cloud execution from the preliminary build is deliberately unavailable:
  // the authoritative master requires a separately guarded local executor.
  if (cloud && options.python && require('./access-policy').FLAGS.generated_python_enabled) {
    add('python.execute', 'Chạy Python trong cloud sandbox, không trên máy người dùng. input là mảng dataset hoặc []; code là thân hàm, return JSON/mảng/{rows}. Có thư viện chuẩn, không mạng. Dữ liệu gửi cloud tối đa 500KB. Dùng JS local trước nếu đủ.', { datasetId: string(), code: string({ maxLength: 12000 }) }, ['code'], 'ANALYZE', 'Đang chạy Python trong cloud…', async (args, signal) => {
      const mst = scope();
      const value = await cloud.execute('python', args.code, args.datasetId ? rowsOf(args.datasetId) : [], signal);
      if (scope() !== mst) throw new Error('MST đã thay đổi; chạy lại phân tích với dữ liệu phù hợp.');
      const rows = Array.isArray(value) ? value : value?.rows;
      if (Array.isArray(rows)) return { ...put(rows), executed: true, environment: 'cloud sandbox' };
      if (Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error('Kết quả Python quá dài; return bảng hoặc tóm tắt.');
      return { result: value, executed: true, environment: 'cloud sandbox' };
    });
    tools[tools.length - 1].timeout = 90000;
    add('cloud.shell', 'Chạy lệnh Shell trong cloud Linux cô lập cho công việc người dùng yêu cầu; không truy cập máy Windows hoặc mạng. Chỉ stdout/stderr được trả về; file tạo trong cloud không tự tải về máy. Muốn xuất file tải được, dùng data.create và file.export.', { code: string({ maxLength: 12000 }) }, ['code'], 'ANALYZE', 'Đang chạy lệnh trong cloud…', (args, signal) => cloud.execute('shell', args.code, [], signal));
    tools[tools.length - 1].timeout = 90000;
  }
  add('invoice.read', 'Đọc một hóa đơn và các dòng hàng theo invoice_key.', { key: string() }, ['key'], 'READ', 'Đang đọc hóa đơn…', args => app.read(args.key));
  add('invoice.get_items', 'Đọc đầy đủ dòng hàng của một hóa đơn thành dataset để tính/xuất; không dùng phần xem trước đã cắt.', { key: string() }, ['key'], 'READ', 'Đang đọc hàng hóa…', async args => {
    if (app.items) return put(await app.items(args.key));
    const value = await app.read(args.key); if (value.truncated) throw new Error('Adapter chỉ có phần xem trước; không coi là toàn bộ dòng hàng.'); return put(value.items);
  });
  add('invoice.summary', 'Tổng hợp hóa đơn theo cùng logic Kho dữ liệu: loại trừ hóa đơn không còn hiệu lực.', { from: date, to: date }, [], 'ANALYZE', 'Đang tổng hợp dữ liệu…', args => {
    if (args.from && args.to && args.from > args.to) throw new Error('Khoảng ngày không hợp lệ.');
    return app.summary(args);
  });
  add('invoice.find_duplicates', 'Tìm dấu hiệu trùng trong dataset: cùng chiều, MST người bán, ký hiệu, số, ngày và tổng tiền. Không kết luận là trùng pháp lý, không xóa dòng.', { datasetId: string() }, ['datasetId'], 'ANALYZE', 'Đang kiểm tra hóa đơn trùng…', args => {
    const groups = new Map();
    for (const row of rowsOf(args.datasetId)) {
      if (!row.mst_ban || !row.so_hd || !row.ngay_lap) continue;
      const key = JSON.stringify(['direction', 'mst_ban', 'khh_hd', 'so_hd', 'ngay_lap', 'tong_tien'].map(k => String(row[k] ?? '').trim()));
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
    }
    let group = 0; const rows = [];
    for (const values of groups.values()) if (values.length > 1) { group++; rows.push(...values.map(row => ({ ...row, duplicate_group: group }))); }
    return { ...put(rows), groups: group, criteria: 'Dấu hiệu trùng; cần đối chiếu XML/trạng thái trước khi kết luận.' };
  });
  add('data.analyze', 'Phân tích dataset tại máy: tổng tiền/thuế, theo chiều, thiếu MST, tổng tiền âm hoặc trên ngưỡng và lệch trước thuế + thuế > 1 đồng. Dấu hiệu cần kiểm tra, không tự kết luận sai.', { datasetId: string(), minTotal: { type: 'number', minimum: 0, maximum: 1e15 } }, ['datasetId'], 'ANALYZE', 'Đang phân tích dữ liệu…', args => {
    const rows = rowsOf(args.datasetId), totals = { count: rows.length, total: 0, pretax: 0, tax: 0 }, byDirection = {};
    const anomalies = [];
    for (const row of rows) {
      const total = Number(row.tong_tien) || 0, pretax = Number(row.tien_truoc_thue) || 0, tax = Number(row.tien_thue) || 0;
      totals.total += total; totals.pretax += pretax; totals.tax += tax;
      const group = byDirection[row.direction] ||= { count: 0, total: 0 }; group.count++; group.total += total;
      const reasons = [];
      if (total < 0) reasons.push('Tổng tiền âm (có thể là điều chỉnh hợp lệ)');
      if (!row.mst_ban) reasons.push('Thiếu MST bên bán');
      if (Math.abs(total - pretax - tax) > 1) reasons.push('Tổng tiền lệch trước thuế + thuế');
      if (args.minTotal !== undefined && total >= args.minTotal) reasons.push('Đạt ngưỡng tổng tiền yêu cầu');
      if (reasons.length) anomalies.push({ ...row, analysis_note: reasons.join('; ') });
    }
    return { totals, byDirection, flagged: put(anomalies), note: 'Tổng dataset bao gồm các trạng thái đã tìm; dùng invoice.summary cho tổng còn hiệu lực.' };
  });
  let jsRuns = 0;
  add('js.compare_safe', 'Đối chiếu hai dataset đầy đủ bằng JS cô lập. input.left và input.right là hai mảng; helpers như execute_safe. Dùng cho so sánh hai file/sheet hoặc file với hóa đơn. return mảng/{rows} để tạo dataset kết quả hoặc object tóm tắt.', { leftDatasetId: string(), rightDatasetId: string(), code: string({ maxLength: 12000 }) }, ['leftDatasetId', 'rightDatasetId', 'code'], 'ANALYZE', 'Đang đối chiếu hai bảng dữ liệu…', async (args, signal) => {
    if (++jsRuns > 3) throw new Error('Tối đa 3 lượt JS mỗi tác vụ.');
    const mst = scope(), value = await executeSafeJs(args.code, { left: rowsOf(args.leftDatasetId), right: rowsOf(args.rightDatasetId) }, signal);
    if (scope() !== mst) throw new Error('MST đã thay đổi; tìm lại dữ liệu.');
    const rows = Array.isArray(value) ? value : value?.rows;
    if (Array.isArray(rows)) return put(rows);
    if (Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error('Kết quả đối chiếu quá dài.');
    return value;
  });
  add('js.execute_safe', 'Xử lý dataset bằng JS cô lập: input mảng, helpers number/normalizeText/groupBy/sum. Không Node, filesystem hoặc mạng. return mảng hoặc {rows,...}.', { datasetId: string(), code: string({ maxLength: 12000 }) }, ['datasetId', 'code'], 'ANALYZE', 'Đang tính toán dữ liệu…', async (args, signal) => {
    if (++jsRuns > 3) throw new Error('Tối đa 3 lượt JS mỗi tác vụ.');
    const mst = scope(), value = await executeSafeJs(args.code, rowsOf(args.datasetId), signal);
    if (scope() !== mst) throw new Error('MST đã thay đổi; tìm lại dữ liệu.');
    const rows = Array.isArray(value) ? value : value?.rows;
    if (Array.isArray(rows)) return put(rows);
    if (Buffer.byteLength(JSON.stringify(value)) > 16000) throw new Error('Kết quả tóm tắt JS quá dài.');
    return value;
  });
  add('file.write_report', 'Tạo báo cáo văn bản mới từ nội dung đã kiểm tra, không cần dataset. Chỉ TXT/MD. Giao diện tự tạo nút tải file.', { filename: string({ maxLength: 100 }), content: string({ maxLength: 60000 }) }, ['content'], 'WRITE_FILE', 'Đang tạo báo cáo…', args => {
    const filename = args.filename || 'bao-cao-ai.txt', ext = path.extname(filename).toLowerCase();
    if (!['.txt', '.md'].includes(ext) || !/^[\p{L}\p{N}_ .-]{1,100}$/u.test(filename) || filename.startsWith('.')) throw new Error('Tên báo cáo phải là TXT hoặc MD.');
    const fileId = randomUUID(), directory = path.join(dataDir, 'ai-exports'); fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(args.content); fs.writeFileSync(path.join(directory, fileId + ext), bytes, { flag: 'wx' });
    fs.writeFileSync(path.join(directory, fileId + '.json'), JSON.stringify({ total: 1, rows: [{ 'Nội dung': args.content }] }), { flag: 'wx' });
    const file = { fileId, filename, size: bytes.length, rows: 1 }; files[fileId] = { ...file, ext }; emit({ file }); return file;
  });
  for (const format of ['excel', 'csv', 'report']) {
    add('file.export_' + format, 'Xuất dataset local thành ' + format + ', tạo file mới và kiểm tra kích thước; không ghi đè. File xuất nằm trong vùng dữ liệu AI.', { datasetId: string(), filename: string({ maxLength: 100 }) }, ['datasetId'], 'WRITE_FILE', 'Đang tạo file ' + (format === 'excel' ? 'Excel' : format.toUpperCase()) + '…', args => {
      const rows = rowsOf(args.datasetId), ext = { excel: '.xlsx', csv: '.csv', report: '.txt' }[format];
      const filename = args.filename || 'hoa-don-ai' + ext;
      if (!/^[\p{L}\p{N}_ .-]{1,100}$/u.test(filename) || !filename.toLowerCase().endsWith(ext) || filename.startsWith('.')) throw new Error('Tên file không hợp lệ.');
      const clean = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !/file|path|url|lookup|token|password/i.test(key))));
      const sheet = XLSX.utils.json_to_sheet(clean.length ? clean : [{ 'Kết quả': 'Không có dòng dữ liệu.' }]);
      let buffer;
      if (format === 'excel') {
        const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Kết quả AI');
        buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
      } else if (format === 'csv') {
        // Neutralize spreadsheet formulas from untrusted invoice strings.
        const csvRows = clean.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' && /^[=+@\-\t\r]/.test(v) ? "'" + v : v])));
        buffer = Buffer.from('\ufeff' + XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(csvRows)));
      } else buffer = Buffer.from('Báo cáo CNTaxTools\nSố dòng: ' + rows.length + '\n\n' + JSON.stringify(clean, null, 2));
      return saveExport(buffer, filename, ext, rows.length, clean);
    });
  }
  // ── PDF → Excel (chạy TẠI MÁY, tái dùng logic lưới + chuẩn hoá sao kê production) ──
  add('file.pdf_to_excel', 'Chuyển file PDF đã đính kèm thành Excel (.xlsx) ngay tại máy — KHÔNG cần đọc nội dung PDF vào ngữ cảnh. Tự lần về file PDF GỐC nếu truyền id của bản .pdf.txt dẫn xuất. Tạo sheet "Giao dich" (chuẩn hoá sao kê) khi nhận ra bảng, luôn kèm sheet "Du lieu goc" giữ nguyên dữ liệu trích được.', { id: string(), outputName: string({ maxLength: 100 }) }, ['id'], 'WRITE_FILE', 'Đang chuyển PDF sang Excel…', async args => {
    const file = attachments.find(f => f.id === args.id);
    if (!file) throw new Error('File không thuộc ngữ cảnh cuộc trò chuyện hiện tại.');
    if (!attachmentFiles) throw new Error('Máy chủ chưa sẵn sàng để đọc file đính kèm trên máy.');
    // Bản dẫn xuất (.pdf.txt do UI trích) KHÔNG có toạ độ chữ ⇒ phải lần về PDF gốc để dựng lại bảng.
    const source = resolvePdfSource(file);
    if (source.ext !== '.pdf') throw Object.assign(new Error('File đính kèm không phải PDF. Với Excel/CSV/văn bản hãy dùng file.read_attachment.'), { code: 'NOT_PDF' });
    const extracted = await pdfTools.extractGrid(attachmentFiles.bytes(source));
    if (extracted.kind !== 'pdf-text') throw Object.assign(new Error('PDF này là bản scan (không có chữ) nên không dựng được bảng. Gửi ảnh các trang cần đọc để AI đọc.'), { code: 'PDF_NO_TEXT' });
    const built = pdfTools.buildSheets(extracted.grid);
    if (!built.rawRows) throw new Error('Không tìm thấy bảng dữ liệu nào trong PDF để chuyển sang Excel.');
    const baseName = path.basename(String(source.filename || 'tai-lieu.pdf'), path.extname(String(source.filename || '.pdf')));
    const filename = args.outputName || (baseName.slice(0, 80) + '.xlsx');
    if (!/^[\p{L}\p{N}_ .-]{1,100}$/u.test(filename) || !filename.toLowerCase().endsWith('.xlsx') || filename.startsWith('.')) throw new Error('Tên file Excel không hợp lệ (chỉ .xlsx).');
    const book = XLSX.utils.book_new();
    for (const def of built.sheets) {
      const aoa = def.rows.length ? def.rows : [['']];
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(aoa), def.name.slice(0, 31));
    }
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    const primary = built.sheets[0];
    const header = primary.rows[0] || [];
    const seen = new Map();
    const columns = header.map((cell, index) => {
      const name = String(cell == null || cell === '' ? 'Cot' + (index + 1) : cell).trim();
      const count = (seen.get(name) || 0) + 1; seen.set(name, count);
      return count > 1 ? name + ' (' + count + ')' : name;
    });
    const clean = primary.rows.slice(1).map(row => Object.fromEntries(columns.map((name, index) => [name, row[index] == null ? '' : row[index]])));
    const out = saveExport(buffer, filename, '.xlsx', Math.max(0, primary.rows.length - 1), clean);
    let dataset = null;
    try { if (clean.length) dataset = put(clean); } catch {}
    return { ...out, source: source.filename, pages: extracted.pages, sheets: built.sheets.map(sheet => ({ name: sheet.name, rows: Math.max(0, sheet.rows.length - 1) })),
      statementRows: built.statementRows, rawRows: built.rawRows, verification: built.verification,
      ...(dataset ? { datasetId: dataset.datasetId } : {}),
      note: 'Đã chuyển PDF tại máy. Nếu cần lọc/tính tiếp, dùng datasetId với data.analyze hoặc js.execute_safe rồi file.export_excel.' };
  });
  tools[tools.length - 1].timeout = 60000;
  add('mst.select', 'Chọn MST đã tồn tại khi người dùng chỉ rõ MST. Không thêm hoặc xóa tài khoản.', { mst: string({ pattern: '^\\d{10}(?:-?\\d{3})?$' }) }, ['mst'], 'ACTION', 'Đang chọn MST…', (args, signal) => app.select(args.mst, scope(), signal));
  add('account.refresh', 'Kiểm tra/khôi phục phiên đăng nhập MST đang chọn bằng cơ chế hiện có. Không trả token/password.', {}, [], 'ACTION', 'Đang kiểm tra phiên đăng nhập…', (_, signal) => app.refresh(signal, scope()));
  add('invoice.download', 'Bắt đầu tác vụ tải nền cho MST đang chọn; không đồng nghĩa đã tải xong. Phải kiểm tra download_status. Không dừng tác vụ đang chạy.', { from: date, to: date, direction: string({ enum: ['BUY', 'SELL'] }) }, ['from', 'to', 'direction'], 'ACTION', 'Đang bắt đầu tải hóa đơn…', (args, signal) => app.download(args, signal, scope()));
  add('invoice.download_status', 'Kiểm tra tiến độ và kết quả tải hóa đơn đang chọn; phản ánh done/failed/busy.', {}, [], 'READ', 'Đang kiểm tra tiến độ tải…', () => app.downloadStatus());

  // ── database READ-ONLY ──────────────────────────────────────────────
  add('db.detect', 'Nhận diện database từ file local (SQLite). Trả loại DB, kích thước, trạng thái read-only. Dùng trước khi list_tables/schema/sample/query.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang nhận diện database…', args => detect(args.path));
  add('db.list_tables', 'Liệt kê tất cả bảng và view của database SQLite cùng số dòng ước tính. Không dump dữ liệu.', { path: string({ maxLength: 1000 }) }, ['path'], 'READ', 'Đang liệt kê bảng…', args => listTables(args.path));
  add('db.schema', 'Đọc cấu trúc bảng/view: tên cột, kiểu dữ liệu, khóa chính, khóa ngoại. Nếu có table thì chỉ schema bảng đó; nếu không trả schema toàn DB.', { path: string({ maxLength: 1000 }), table: string({ maxLength: 200 }) }, ['path'], 'READ', 'Đang đọc cấu trúc bảng…', args => schema(args.path, args.table || null));
  add('db.sample', 'Xem trước vài dòng đầu của bảng để hiểu dữ liệu. Mặc định 5 dòng, tối đa 50. Không thay đổi DB.', { path: string({ maxLength: 1000 }), table: string({ maxLength: 200 }), limit: { type: 'number', minimum: 1, maximum: 50 } }, ['path', 'table'], 'READ', 'Đang xem dữ liệu mẫu…', args => sample(args.path, args.table, args.limit));
  add('db.query_readonly', 'Chạy SELECT/WITH READ-ONLY trên SQLite local. Tối đa 500 dòng. Chỉ SELECT/WITH, không được INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA. Dùng COUNT/SUM/GROUP BY/LIMIT để tổng hợp.', { path: string({ maxLength: 1000 }), sql: string({ maxLength: 4000 }) }, ['path', 'sql'], 'READ', 'Đang truy vấn database…', args => queryReadonly(args.path, args.sql));

  const verifiers = {
    'mst.select': (value, args) => value?.selectedMst === args.mst && scope() === args.mst,
    'account.refresh': (value, _, context) => value?.authenticated === true && value.mst === context.companyId && scope() === context.companyId,
    'invoice.download': (value, _, context) => value?.started === true && value.mst === context.companyId && typeof value.jobId === 'string' && app.downloadStatus().jobId === value.jobId,
  };
  return tools.map(tool => ({ ...require('./access-policy').manifest(tool), verify: verifiers[tool.name] }));
}
module.exports = { createRegistry };
