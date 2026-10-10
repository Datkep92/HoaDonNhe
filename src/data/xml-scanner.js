'use strict';
// ---------------------------------------------------------------------------
// XML Scanner / Importer — PROJECT_ARCHITECTURE §17, §18, §19, §42, §71, §26.
//
// Quét XML trong vùng dữ liệu của MST, đọc → xác định hướng → khoá hoá đơn → ghi SQLite
// trong MỘT transaction cho mỗi hoá đơn (mục 45), và ghi vết vào imported_files (mục 10).
//
// Nguyên tắc:
//   - XML là nguồn gốc; hướng lấy từ NỘI DUNG XML, không lấy từ tên thư mục (mục 17).
//   - Quét ĐỆ QUY trong Mua_vao/Ban_ra: dữ liệu cũ nằm ở <Mua_vao|Ban_ra>/xml/… vẫn được nhận.
//   - File XML nằm ngay trong thư mục MST (ngoài 2 thư mục chuẩn) vẫn được nhập, kèm cảnh báo.
//   - Một file lỗi KHÔNG làm dừng cả lượt (mục 42/71): ghi error rồi đi tiếp.
//   - Chạy lại nhiều lần không nhân bản (mục 19): file đã import (đúng path + size + mtime)
//     thì bỏ qua; hoá đơn đã có (theo invoice_key) thì ghi vết duplicate.
//   - Async + nhường event loop sau mỗi file: UI theo dõi được tiến độ và không bị khoá (mục 26/52).
//   - Trạng thái hoá đơn (tthai) do engine tra cứu ghi vào MST-<mst>/trang-thai-hoa-don.json
//     (XML không mang trạng thái) được lưu vào cột invoices.tthai. Hoá đơn bị thay thế/điều
//     chỉnh/huỷ VẪN được nhập và GIỮ trong kho — chỉ không cộng vào hàng hoá và tổng tiền.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { buildImportRecord, parseInvoiceXml } = require('./xml-parser');
const { samePersonName } = require('./identity-candidates');
const { insertInvoice, upsertInvoice, findInvoiceByKey, recordImportedFile } = require('./repository');
const { withTransaction } = require('./sqlite');
const { isExcluded } = require('./invoice-state');
const { observeCandidates: defaultObserveCandidates } = require('./identity-candidates');

const FOLDER_DIRECTION = { Mua_vao: 'BUY', Ban_ra: 'SELL' };
const MAX_DEPTH = 8;
const IMPORT_BATCH_SIZE = 25;
// Trạng thái imported_files coi như "đã xử lý" (không đọc lại file mỗi lượt quét).
// Trạng thái 'imported' là "đã xử lý". KHÔNG còn 'superseded': bản trước đánh dấu rồi bỏ qua file
// của hoá đơn bị thay thế, nên những file đó sẽ được đọc lại một lần để vào kho kèm tthai.
const HANDLED_STATUS = ['imported'];
const STATE_FILE = 'trang-thai-hoa-don.json';
const LEGACY_SUPERSEDED_FILE = 'hoa-don-bi-thay-the.json';

const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

// Tìm mọi file .xml dưới một thư mục, kể cả trong thư mục con (ví dụ Mua_vao/xml/).
function collectXmlFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

// Danh sách XML của một MST: theo thứ tự Mua_vao → Ban_ra → file rời trong thư mục MST.
// Đọc khối `parties` (hai đầu mã + chiều đã tra) do engine ghi lúc tải. File cũ không có khối này
// ⇒ rỗng, mọi thứ rơi về hành vi cũ (không nhận diện theo chiều).
function readParties(mstDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(mstDir, STATE_FILE), 'utf8'));
    const entries = raw && typeof raw === 'object' && raw.parties && typeof raw.parties === 'object' ? raw.parties : {};
    const list = [];
    for (const value of Object.values(entries)) {
      if (!value || typeof value !== 'object') continue;
      const row = {};
      for (const field of ['nbmst', 'nmmst', 'nbten', 'nmten']) {
        const text = String(value[field] ?? '').trim();
        if (text) row[field] = text;
      }
      const direction = String(value.direction ?? '').trim();
      if ((direction === 'sold' || direction === 'purchase') && (row.nbmst || row.nmmst)) {
        row.direction = direction;
        list.push(row);
      }
    }
    return list;
  } catch { return []; }
}

function listMstXmlFiles(mstDir, folders = Object.keys(FOLDER_DIRECTION)) {
  const list = [];
  for (const folder of folders) {
    const dir = path.join(mstDir, folder);
    if (!fs.existsSync(dir)) continue;
    for (const filePath of collectXmlFiles(dir)) list.push({ filePath, folder });
  }
  if (fs.existsSync(mstDir)) {
    let entries = [];
    try { entries = fs.readdirSync(mstDir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) list.push({ filePath: path.join(mstDir, entry.name), folder: '' });
    }
  }
  return list;
}

function alreadyImported(db, filePath, stat) {
  const row = db.prepare('SELECT status, file_size, modified_time FROM imported_files WHERE file_path = ? ORDER BY id DESC LIMIT 1').get(filePath);
  if (!row || !HANDLED_STATUS.includes(String(row.status))) return false;
  return Number(row.file_size) === stat.size && String(row.modified_time) === stat.mtime.toISOString();
}

// Trạng thái hoá đơn theo khoá tầng dữ liệu — nguồn duy nhất, vì XML không mang tthai.
// File mới: MST-<mst>/trang-thai-hoa-don.json dạng { states: { "khoá": "1".."6" } }.
// File của BẢN CŨ (hoa-don-bi-thay-the.json: mảng khoá trần hoặc { keys }) vẫn được đọc với
// tthai = '4' để nâng cấp không mất dấu; giá trị trong file mới LUÔN thắng.
function readStates(mstDir) {
  const states = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(mstDir, LEGACY_SUPERSEDED_FILE), 'utf8'));
    const keys = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.keys) ? raw.keys : []);
    for (const key of keys.map(String).filter(Boolean)) states.set(key, '4');
  } catch { /* chưa có file bản cũ */ }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(mstDir, STATE_FILE), 'utf8'));
    const entries = raw && typeof raw === 'object' && raw.states && typeof raw.states === 'object' ? raw.states : {};
    for (const [key, value] of Object.entries(entries)) {
      const state = String(value ?? '').trim();
      if (key && /^\d+$/.test(state)) states.set(String(key), state);
    }
  } catch { /* chưa có file mới */ }
  return states;
}

// ---------------------------------------------------------------------------
// BẰNG CHỨNG CHIỀU TRA CỨU — dùng để nhận diện hoá đơn thuộc hồ sơ KHI MÃ KHÁC MST hồ sơ.
// ---------------------------------------------------------------------------
// Bối cảnh thật (đo trên dữ liệu của khách): hồ sơ MST 8021214462-001 nhưng hoá đơn bán ra lấy về
// có người bán là 058183000994 — vì một chủ có NHIỀU mã (MST + CCCD, MST chi nhánh…). Cổng thuế ĐÃ
// lọc sẵn theo MST đang đăng nhập: tra "bán ra" thì mọi hồ sơ trả về đều có hồ sơ làm người bán.
// detectDirection() chỉ so MST trong XML với MST hồ sơ nên thành UNKNOWN ⇒ 86 file không vào kho.
//
// Khối `parties` trong trang-thai-hoa-don.json (engine ghi lúc tải) lưu lại hai đầu mã + chiều đã
// tra, để ở đây đối chiếu. Cổng thuế lọc sẵn theo MST đang đăng nhập, nên:
//   · lượt tra "bán ra"  (sold)    : hồ sơ là NGƯỜI BÁN  ⇒ mã hồ sơ ở nbmst, đối tác ở nmmst
//   · lượt tra "mua vào" (purchase) : hồ sơ là NGƯỜI MUA   ⇒ mã hồ sơ ở nmmst, đối tác ở nbmst
//
// VÌ SAO MỘT CHIỀU LÀ ĐỦ (đo trên dữ liệu thật, không phải suy đoán):
// Cổng thuế lọc sẵn theo MST đang đăng nhập, nên trong lượt tra "mua vào", MỌI hồ sơ trả về đều
// có hồ sơ ở phía người mua (nmmst). Do đó mã nào đứng ở nmmst của lượt mua vào CHÍNH LÀ MÃ CỦA
// HỒ SƠ — đối tác đứng ở nbmst (sai phía). Lượt tra "bán ra" đối xứng: hồ sơ ở nbmst.
//
// Vì vậy CHỈ CẦN CHIỀU NÀO có dữ liệu cũng đủ; không bắt buộc phải đủ cả hai. Điều kiện BẮT BUỘC:
//   1) KHÔNG hề đứng sai phía: sold ⇒ mã ở nbmst; purchase ⇒ mã ở nmmst. Sai phía lần nào là loại
//      tuyệt đối — đây là điều kiện CHỐNG GÁN NHẦM mạnh nhất (nhà cung cấp luôn sai phía);
//   2) lượt quét phải xếp file này vào đúng phía hồ sơ (`ownSide`) — mã ở thư mục/file đối lập với
//      chiều đã tra là đối tác, không phải mã hồ sơ;
//   3) tên khớp tên hồ sơ SAU khi bỏ dấu + bỏ cụm pháp lý, HOẶC số lượng vượt ngưỡng (để tránh
//      trùng tên cụt); và số lượng của mã lạ này phải LỚN HƠN số lần của mọi mã lạ khác.
//
// Hệ quả nếu thiếu điều kiện nào: hệ thống rơi về hành vi cũ (ghi mã lạ vào ma-chua-xac-dinh.json,
// người dùng tự gán) — không đoán bừa.
const OWN_SIDE_MIN_COUNT = 5; // ngưỡng "số lượng lớn" khi tên không khớp

// Gom bằng chứng phía cho từng mã lạ, từ toàn bộ khối `parties` đã đọc.
// Trả Map<mã, { own, wrong }> — own = số lần đứng ĐÚNG phía, wrong = số lần đứng SAI phía.
function partyEvidence(parties, identifiers) {
  // identifiers có thể undefined (lượt nhập từ dòng lệnh / test không truyền) ⇒ coi như chỉ có MST.
  const own = new Set((Array.isArray(identifiers) ? identifiers : [identifiers])
    .map(v => String(v ?? '').trim()).filter(Boolean));
  const byCode = new Map();
  const bump = (code, field) => {
    const key = String(code).trim();
    const seen = byCode.get(key) || { own: 0, wrong: 0, sold: 0, purchase: 0 };
    seen[field] += 1;
    byCode.set(key, seen);
  };
  for (const row of parties) {
    // Chiều 'sold' ⇒ đúng phía là nbmst; 'purchase' ⇒ đúng phía là nmmst. Đầu kia là đối tác.
    const right = String(row.direction === 'sold' ? row.nbmst : row.nmmst || '').trim();
    const other = String(row.direction === 'sold' ? row.nmmst : row.nbmst || '').trim();
    if (right && !own.has(right)) {
      bump(right, 'own');
      byCode.get(right)[row.direction === 'sold' ? 'sold' : 'purchase'] += 1;
    }
    if (other && !own.has(other)) bump(other, 'wrong');
  }
  return byCode;
}

// Mã lạ có đủ bằng chứng để coi là của hồ sơ không? Trả mã đạt, hoặc '' nếu chưa đủ.
// `codes` = tập mã lạ thấy trong các file XML (kèm tên + số lần), `identifiers` = mã hồ sơ.
function resolveOwnCode({ codes, parties, identifiers, profileNames }) {
  const evidence = partyEvidence(parties, identifiers);
  const candidates = [];
  for (const [code, seen] of evidence) {
    if (seen.wrong > 0) continue; // từng đứng sai phía một lần ⇒ là đối tác, tuyệt đối không gán
    if (!seen.own) continue;
    const info = codes.get(code) || {};
    if (info.ownSide !== true) continue; // lượt này file nằm ở phía đối diện chiều tra
    candidates.push({ code, seen, info });
  }
  // Nhiều mã cùng đạt thì lấy mã ĐỨNG ĐẦU (nhiều hồ sơ nhất) — trường hợp này hiếm và nếu có thì
  // người dùng vẫn xem được lý do trong nhật ký để kiểm chứng.
  candidates.sort((a, b) => b.seen.own - a.seen.own || String(a.code).localeCompare(String(b.code)));
  const best = candidates[0];
  if (!best) return null;
  // Phải vượt mọi mã lạ khác một cách rõ ràng, nếu không thì bằng chứng không đủ phân biệt.
  if (candidates.length > 1 && best.seen.own <= candidates[1].seen.own) return null;
  const count = Number(best.info.count || 0) || best.seen.own;
  const sameName = profileNames.some(name => samePersonName(best.info.ten, name));
  const many = count >= OWN_SIDE_MIN_COUNT;
  if (!sameName && !many) return null;
  const direction = best.seen.purchase > best.seen.sold ? 'purchase' : 'sold';
  return {
    code: best.code,
    direction,
    reason: sameName ? `tên khớp hồ sơ, ${count} hồ sơ` : `${count} hồ sơ cùng chiều`,
  };
}

function previousFile(db, filePath) {
  return db.prepare('SELECT status, file_size, modified_time, invoice_key FROM imported_files WHERE file_path = ? ORDER BY id DESC LIMIT 1').get(filePath) || null;
}

// Trạng thái hoá đơn có thể ĐỔI sau khi file đã nhập (hoá đơn tháng 1 đến tháng 3 mới bị thay thế).
// Lúc đó file KHÔNG đổi (cùng path/size/mtime) nên bước "đã nhập thì bỏ qua" sẽ bỏ luôn phần cập
// nhật trạng thái ⇒ kho giữ trạng thái cũ vĩnh viễn. Phát hiện lệch thì cho file đi lại luồng bình
// thường (đọc XML → upsert) để cập nhật tthai.
function stateChanged(db, known, states) {
  if (!known || !known.invoice_key) return false;
  if (!states.has(String(known.invoice_key))) return false;
  const next = states.get(String(known.invoice_key));
  const row = findInvoiceByKey(db, known.invoice_key);
  if (!row) return false;
  return String(row.tthai ?? '') !== String(next ?? '');
}

// Xử lý ĐÚNG MỘT file: mọi lỗi được bắt tại đây để một file hỏng không làm dừng cả lượt.
function processFile({ db, mst, identifiers, filePath, folder, summary, states, ownCodes }) {
  const name = path.basename(filePath);
  const expected = FOLDER_DIRECTION[folder] || '';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    summary.errors += 1;
    summary.files.push({ file: filePath, status: 'error', error: `Không đọc được file: ${error.message}` });
    return;
  }
  const base = { filePath, fileName: name, fileSize: stat.size, modifiedTime: stat.mtime.toISOString() };
  const known = previousFile(db, filePath);
  if (alreadyImported(db, filePath, stat) && !stateChanged(db, known, states)) {
    summary.skipped += 1;
    summary.files.push({ file: filePath, status: 'skipped' });
    return;
  }
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const { record, warnings, direction } = buildImportRecord(xml, { currentMst: identifiers && identifiers.length ? identifiers : mst, fileXml: filePath });
    // Trạng thái lấy từ kết quả tra cứu (XML không mang). Không có trong sổ trạng thái ⇒ null:
    // KHÔNG suy đoán là '1', và null KHÔNG bị coi là loại trừ.
    record.tthai = states.get(record.invoiceKey) || null;
    if (expected && direction !== expected) {
      warnings.push(`File nằm trong thư mục ${folder} nhưng nội dung XML là ${direction} — giữ nguyên file, ghi theo nội dung XML.`);
    }
    if (!expected) {
      warnings.push('File không nằm trong thư mục Mua_vao/Ban_ra — giữ nguyên vị trí, ghi theo nội dung XML.');
    }
    const existing = findInvoiceByKey(db, record.invoiceKey);
    if (!states.has(record.invoiceKey) && existing) record.tthai = existing.tthai;
    if (existing && known && known.invoice_key === record.invoiceKey) {
      const result = upsertInvoice(db, {
        ...record,
        importedFile: { ...base, status: 'imported', errorMessage: warnings.join(' | ') || null },
      });
      summary.updated += 1;
      summary.items += result.itemsInserted;
      summary.warningCount += warnings.length;
      if (isExcluded(record.tthai)) summary.inactive += 1;
      summary.files.push({ file: filePath, status: 'updated', invoiceKey: record.invoiceKey, direction, items: result.itemsInserted, warnings });
      return;
    }
    if (existing) {
      recordImportedFile(db, { ...base, invoiceKey: record.invoiceKey, status: 'duplicate', errorMessage: warnings.join(' | ') || null });
      summary.duplicates += 1;
      summary.files.push({ file: filePath, status: 'duplicate', invoiceKey: record.invoiceKey });
      return;
    }
    const result = insertInvoice(db, {
      ...record,
      importedFile: { ...base, status: 'imported', errorMessage: warnings.join(' | ') || null },
    });
    summary.imported += 1;
    summary.items += result.itemsInserted;
    summary.warningCount += warnings.length;
    if (isExcluded(record.tthai)) summary.inactive += 1;
    summary.files.push({ file: filePath, status: 'imported', invoiceKey: record.invoiceKey || result.invoiceKey, direction, items: result.itemsInserted, warnings });
  } catch (error) {
    summary.errors += 1;
    const message = error && error.message ? error.message : String(error);
    // Hoá đơn UNKNOWN (mst_ban/mst_mua đều không thuộc định danh hồ sơ): gom mã lạ để sau lượt
    // quét ghi vào ma-chua-xac-dinh.json — UI hỏi người dùng gán (vd CCCD 058168004258 của cùng
    // người MST 4500487170) rồi lượt quét sau tự nhập lại. File vẫn giữ status 'error' trong
    // imported_files nên khi định danh đã đủ, lượt sau ĐỌC LẠI được (không bị coi đã nhập).
    // Chỉ mã CÙNG PHÍA với hồ sơ mới đáng gán: file trong Mua_vao ⇒ hồ sơ là người mua ⇒ mã
    // đáng gán là bên NMua; Ban_ra ⇒ bên NBan. Mã phía đối diện chỉ là nhà cung cấp/khách hàng
    // bình thường — ghi vết (ownSide:false) nhưng UI không đề nghị gán.
    if (error && Array.isArray(error.unknownParties) && error.unknownParties.length) {
      const expectedSide = expected === 'BUY' ? 'mua' : (expected === 'SELL' ? 'ban' : '');
      for (const party of error.unknownParties) {
        const ownSide = !expectedSide || party.side === expectedSide;
        (summary.unknownSeen ||= []).push({ ...party, file: filePath, ownSide });
        // Dồn mã lạ theo tên + số lần + phía, để sau lượt quét mới đủ căn cứ gán (resolveOwnCode).
        // File MỚI mới đếm: cùng một file bị quét lại không được tăng bộ đếm.
        if (ownCodes) {
          const code = String(party.code || '').trim();
          if (code) {
            const seen = ownCodes.get(code) || { ten: '', count: 0, ownSide: false, files: new Set() };
            if (party.ten && !seen.ten) seen.ten = String(party.ten).trim();
            if (ownSide) seen.ownSide = true;
            if (seen.files.size < 5000) seen.files.add(filePath);
            ownCodes.set(code, seen);
          }
        }
      }
    }
    try {
      recordImportedFile(db, { ...base, status: 'error', errorMessage: message });
    } catch { /* không ghi được vết thì vẫn phải đi tiếp */ }
    summary.files.push({ file: filePath, status: 'error', error: message, unknownDirection: !!(error && error.unknownDirection) });
  }
}

// Cây thư mục con của file trong vùng MST: 'Mua_vao' | 'Ban_ra' | '' (file rời/không thuộc 2 cây).
function folderOf(mstDir, filePath) {
  const rel = path.relative(mstDir, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // nằm ngoài vùng MST ⇒ bỏ
  const first = rel.split(path.sep)[0];
  return Object.prototype.hasOwnProperty.call(FOLDER_DIRECTION, first) ? first : '';
}

// ---------------------------------------------------------------------------
// REPROCESS PAYMENT METHOD — MASTER TASK mục 32.
//
// Hoá đơn nhập TRƯỚC khi có cột payment_method sẽ mang giá trị NULL ở payment_method_raw.
// Chức năng này đọc LẠI file XML gốc (XML vẫn là nguồn gốc) và chỉ BỔ SUNG 2 cột
//   payment_method_raw  = chữ ghi trong <HTTToan> (nguyên bản)
//   payment_method      = giá trị đã chuẩn hoá
// KHÔNG sửa số tiền, KHÔNG sửa ngày, KHÔNG sửa file XML, KHÔNG đoán khi XML không ghi.
//
// Phân biệt 2 trạng thái để không phải đọc lại file mỗi lượt:
//   payment_method_raw IS NULL  → CHƯA đọc lại (chưa biết XML ghi gì)
//   payment_method_raw = ''     → ĐÃ đọc lại, XML không ghi hình thức → giữ UNKNOWN
// File XML đã bị xoá/không đọc được → đếm riêng, GIỮ NGUYÊN giá trị cũ.
// ---------------------------------------------------------------------------
async function reprocessPaymentMethods({ db, mstDir, onFile, limit = 0 } = {}) {
  const rows = db.prepare(`SELECT id, so_hd, file_xml FROM invoices
    WHERE payment_method_raw IS NULL ORDER BY id${Number(limit) > 0 ? ` LIMIT ${Number(limit)}` : ''}`).all();
  const result = { candidates: rows.length, updated: 0, empty: 0, missing: 0, failed: 0 };
  const update = db.prepare('UPDATE invoices SET payment_method_raw = ?, payment_method = ? WHERE id = ?');
  for (const row of rows) {
    if (typeof onFile === 'function') onFile({ ...result, current: row.file_xml });
    await yieldToLoop();
    let source;
    try {
      if (!row.file_xml || !fs.existsSync(row.file_xml)) { result.missing += 1; continue; }
      source = fs.readFileSync(row.file_xml, 'utf8');
    } catch { result.missing += 1; continue; }
    let record;
    try { record = parseInvoiceXml(source).record; } catch { result.failed += 1; continue; }
    const raw = record.paymentMethodRaw || '';
    const method = record.paymentMethod || 'UNKNOWN';
    update.run(raw, method, row.id);
    if (raw) result.updated += 1; else result.empty += 1;
  }
  // Hình thức thay đổi ⇒ kết quả đối chiếu cũ không còn đúng (UNKNOWN → CASH/TRANSFER).
  if (result.updated > 0) require('./reconciliation').forceReconcile(db);
  return result;
}

// ---------------------------------------------------------------------------
// BÙ CỘT TRA CỨU NCC CHO HÓA ĐƠN ĐÃ CÓ (Mục 2 — cần thiết khi nâng schema).
//
// Vì sao không dùng lượt quét thường: quét gặp file đã nhập thì đánh dấu "trùng"
// và KHÔNG cập nhật dòng đã có, nên cột mới luôn NULL với kho cũ. Hàm này đọc thẳng
// file XML mà invoices.file_xml trỏ tới và ghi đè 6 cột tra cứu.
//
// Hẹn (giống reprocessPaymentMethods): chỉ xét dòng đang thiếu, tự bỏ qua dòng đã có
// dữ liệu ⇒ chạy lại nhiều lần cho cùng kết quả (idempotent). File XML không còn thì
// đếm `missing` và GIỮ NGUYÊN giá trị cũ — không đoán, không ghi rỗng.
// ---------------------------------------------------------------------------
async function backfillProviderLookup({ db, mstDir, onFile, limit = 0 } = {}) {
  const rows = db.prepare(`SELECT id, file_xml, provider_id FROM invoices
    WHERE msttcgp IS NULL OR provider_id IS NULL OR COALESCE(lookup_code, '') = ''
    ORDER BY id${Number(limit) > 0 ? ` LIMIT ${Number(limit)}` : ''}`).all();
  const result = { candidates: rows.length, updated: 0, missing: 0, failed: 0 };
  const update = db.prepare(`UPDATE invoices SET
    msttcgp = COALESCE(msttcgp, ?), lookup_code = COALESCE(NULLIF(lookup_code, ''), ?),
    lookup_url = COALESCE(NULLIF(lookup_url, ''), ?), provider_id = COALESCE(provider_id, ?),
    provider_name = COALESCE(provider_name, ?), provider_level = COALESCE(provider_level, ?)
    WHERE id = ?`);
  for (const row of rows) {
    if (typeof onFile === 'function') onFile({ ...result, current: row.file_xml });
    await yieldToLoop();
    let source;
    try {
      if (!row.file_xml || !fs.existsSync(row.file_xml)) { result.missing += 1; continue; }
      source = fs.readFileSync(row.file_xml, 'utf8');
    } catch { result.missing += 1; continue; }
    let record;
    try { record = parseInvoiceXml(source).record; } catch { result.failed += 1; continue; }
    update.run(
      record.msttcgp ?? null,
      record.lookupCode || require('./lookup-code').findLookupCode(source, row.provider_id || '') || null,
      record.lookupUrl ?? null,
      record.providerId ?? null,
      record.providerName ?? null,
      record.providerLevel ?? null,
      row.id,
    );
    result.updated += 1;
  }
  return result;
}

async function scanXmlFolder({ db, mst, identifiers, mstDir, folders = Object.keys(FOLDER_DIRECTION), onlyFiles, onFile, observeCandidates = defaultObserveCandidates, profileNames }) {
  const summary = { scanned: 0, imported: 0, updated: 0, duplicates: 0, skipped: 0, errors: 0, inactive: 0, items: 0, warningCount: 0, files: [] };
  const notify = () => { if (typeof onFile === 'function') onFile(summary); };
  const states = readStates(mstDir);
  // Nhận diện hoá đơn thuộc hồ sơ khi MÃ ghi trong XML khác MST hồ sơ (một chủ nhiều mã):
  // dùng bằng chứng chiều tra cứu + tên/số lượng. Xem partyEvidence() và OWN_SIDE_MIN_COUNT.
  // ownCodes = Map<mã, { ten, count, ownSide }> dồn từ chính các file XML lỗi của lượt này.
  const ownCodes = new Map();
  const names = Array.isArray(profileNames) ? profileNames.map(String).filter(Boolean) : [];
  let targets;
  if (Array.isArray(onlyFiles) && onlyFiles.length) {
    // Chế độ "chỉ nhập ĐÚNG các file này" (engine truyền danh sách file VỪA tải): thay vì quét lại
    // toàn bộ kho (mỗi lần = readdir đệ quy + statSync + 1 SELECT imported_files cho TỪNG file),
    // chỉ stat đúng các file đã biết. File nào đã nhập từ trước cũng chỉ tốn một lần SELECT để
    // bỏ qua — kết quả nhập GIỐNG HỆT quét cả kho vì các file còn lại chắc chắn chưa đổi (bước quét
    // đầu lượt đã xử lý chúng, và giữa hai lần quét không ai ghi vào vùng này ngoài engine).
    targets = [...new Set(onlyFiles.map(String))]
      .map(file => ({ filePath: file, folder: folderOf(mstDir, file) }))
      .filter(({ filePath, folder }) => folder !== null && (() => { try { return fs.statSync(filePath).isFile(); } catch { return false; } })());
  } else {
    targets = listMstXmlFiles(mstDir, folders);
  }
  for (let start = 0; start < targets.length; start += IMPORT_BATCH_SIZE) {
    await yieldToLoop();
    const batch = targets.slice(start, start + IMPORT_BATCH_SIZE);
    withTransaction(db, () => {
      for (const { filePath, folder } of batch) {
        summary.scanned += 1;
        processFile({ db, mst, identifiers, filePath, folder, summary, states, ownCodes });
        // Thông báo tiến độ TỪNG FILE: UI đọc qua /api/db/import/status (polling) nên chi phí chỉ là
        // vài phép gán trong bộ nhớ, không phải "hàng nghìn UI update". Giao dịch vẫn GỘP THEO LÔ
        // (IMPORT_BATCH_SIZE) — đó mới là chỗ tiết kiệm thời gian ghi SQLite.
        notify();
      }
    });
  }
  // Ghi các mã định danh CHƯA NHẬN DIỆN vừa gặp (hoá đơn UNKNOWN) vào ma-chua-xac-dinh.json.
  // Mã VỪA THẤY LẦN ĐẦU ⇒ hẹn quét lại sau một nhịp: nếu người dùng (hoặc máy khác) vừa gán mã
  // vào hồ sơ trong lúc quét đang chạy, lượt kế tiếp sẽ nhập được các file đang lỗi UNKNOWN.
  let pendingRescan = false;
  if (Array.isArray(summary.unknownSeen) && summary.unknownSeen.length) {
    try {
      const observed = observeCandidates(mstDir, summary.unknownSeen);
      pendingRescan = observed.added.length > 0;
    } catch { /* vết phụ — không được làm hỏng kết quả quét chính */ }
  }
  // Mã lạ đủ bằng chứng là mã của HỒ SƠ (một chủ nhiều mã) ⇒ nhập lại ngay trong lượt này.
  // File lỗi UNKNOWN giữ status 'error' nên lượt nhập lại ĐỌC LẠI được, không bị coi là đã nhập.
  const own = resolveOwnCode({ codes: ownCodes, parties: readParties(mstDir), identifiers, profileNames: names });
  if (own) {
    const retried = [...ownCodes.values()].flatMap(info => [...info.files]);
    summary.ownCode = { code: own.code, reason: own.reason, direction: own.direction, files: retried.length };
    try {
      const again = await scanXmlFolder({
        db, mst, mstDir, onlyFiles: retried, identifiers: [...identifiers, own.code],
        profileNames: names, observeCandidates: () => ({ added: [], merged: 0 }),
      });
      summary.imported += again.imported;
      summary.updated += again.updated;
      summary.duplicates += again.duplicates;
      summary.skipped += again.skipped;
      summary.items += again.items;
      summary.warningCount += again.warningCount;
      summary.inactive += again.inactive;
      summary.files.push(...again.files);
      // Đã vào kho rồi thì không cần hẹn quét lại lần nữa.
      if (again.imported || again.updated) pendingRescan = false;
    } catch (error) {
      summary.secondPassError = `Nhập lại với mã ${own.code} lỗi: ${error && error.message ? error.message : error}`;
    }
  }
  // Hóa đơn mới vào kho ⇒ kết quả đối chiếu cũ lệch → tính lại NGAY.
  // reconcile() chỉ chạy thật khi có dòng chưa có trạng thái (tức là có gì đó đổi),
  // nên lượt quét không có gì mới chỉ tốn 2 câu COUNT — không làm chậm auto sync / watcher.
  require('./reconciliation').reconcile(db);
  return { ...summary, pendingRescan };
}

module.exports = { scanXmlFolder, reprocessPaymentMethods, backfillProviderLookup, alreadyImported, previousFile, processFile, stateChanged, collectXmlFiles, listMstXmlFiles, folderOf, readStates, readParties, partyEvidence, resolveOwnCode, OWN_SIDE_MIN_COUNT, FOLDER_DIRECTION, IMPORT_BATCH_SIZE, STATE_FILE, LEGACY_SUPERSEDED_FILE };
