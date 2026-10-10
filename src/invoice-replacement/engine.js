"use strict";
const { XLSX, normalize, cellValue, getCell, validateSelection, metadataFields } = require("./mapping");
function number(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  return /^[-+]?\d+(\.\d+)?$/.test(s) && Number.isFinite(+s) ? +s : null;
}
function rate(v) {
  let n = number(typeof v === "string" ? v.trim().replace(/%$/, "") : v);
  if (n == null) return null;
  if (n > 0 && n < 1 && !String(v).includes("%")) n *= 100;
  for (const known of [0, 5, 8, 10]) if (Math.abs(n - known) < 0.05) return known;
  return n >= 0 && n <= 100 ? n : null;
}
function date(v, date1904 = false) {
  if (typeof v === "number") {
    const d2 = XLSX.SSF.parse_date_code(v, { date1904 });
    if (d2) return date(`${d2.y}-${String(d2.m).padStart(2, "0")}-${String(d2.d).padStart(2, "0")}`);
  }
  const s = String(v ?? "").trim(), m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/), iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const value = m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : iso ? iso[0] : null;
  if (!value) return null;
  const d = /* @__PURE__ */ new Date(value + "T00:00:00Z");
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === value ? value : null;
}
function identifier(sheet, r, c, value) {
  if (value == null) return "";
  const cell = getCell(sheet, r, c);
  return typeof value === "number" && cell?.z && /^0+$/.test(cell.z) ? XLSX.SSF.format(cell.z, value) : String(value).trim();
}
function rows(source, selection) {
  const choice = validateSelection(source, selection), sheet = source.book.Sheets[choice.sheet], end = XLSX.utils.decode_range(sheet["!ref"]).e.r, out = [];
  for (let r = choice.start + choice.depth; r <= end; r++) {
    const raw = {}, errors = [];
    for (const [f, c] of Object.entries(choice.fields)) try {
      raw[f] = cellValue(sheet, r, c);
    } catch (e) {
      raw[f] = null;
      errors.push(e.message);
    }
    if (Object.values(raw).every((v) => v == null || v === "")) continue;
    const idField = choice.role === "catalog" ? "code" : "number";
    const primary = identifier(sheet, r, choice.fields[idField], raw[idField]);
    const line = { raw, errors, source: { file: source.name, sheet: choice.sheet, row: r + 1 }, number: choice.role === "catalog" ? "" : primary, code: choice.role === "catalog" ? primary : identifier(sheet, r, choice.fields.code, raw.code), date: date(raw.date, source.book.Workbook?.WBProps?.date1904 === true) };
    for (const f of [...metadataFields, "name", "unit", "status", "order"]) line[f] = raw[f] == null ? "" : identifier(sheet, r, choice.fields[f], raw[f]);
    for (const f of ["quantity", "price", "net", "tax", "gross", "discount", "discountRate", "promotionTotal", "credits"]) line[f] = number(raw[f]);
    line.rate = rate(raw.rate);
    line.discountRate = rate(raw.discountRate);
    line.promotion = raw.promotion;
    line.ignored = !primary;
    out.push(line);
  }
  return out;
}
function knownStatus(s) {
  const value = normalize(s);
  if (/huy|da bi thay the|bi thay the|xoa bo/.test(value)) return "excluded";
  if (["hoa don moi", "hoa don thay the", "hoa don dieu chinh", "da phat hanh"].includes(value)) return "active";
  return "unknown";
}
function moneyIssues(l) {
  const problems = [...l.errors];
  for (const field of ["discount", "discountRate", "promotionTotal", "credits", "gross"]) if (l.raw[field] != null && l.raw[field] !== "" && l[field] == null) problems.push(`Giá trị ${field} không hợp lệ`);
  for (const f of ["net", "tax", "quantity", "price"]) if (l[f] == null) problems.push(`Thiếu/sai ${f}`);
  if (!l.name) problems.push("Thiếu tên hàng");
  if (!l.date) problems.push("Ngày hóa đơn không hợp lệ");
  if (l.net != null && l.tax != null && l.gross != null && Math.abs(l.net + l.tax - (l.discount || 0) - l.gross) > 1) problems.push("Tổng thanh toán không khớp tiền hàng, chiết khấu và thuế");
  if (l.net != null && l.quantity != null && l.price != null && Math.abs(l.quantity * l.price - l.net) > Math.max(1, Math.abs(l.quantity) * (Number.isInteger(l.price) ? 0.5 : 1e-6))) problems.push("Thành tiền không khớp số lượng và đơn giá (ngoài sai số làm tròn)");
  if (l.discount != null && l.discount !== 0) problems.push("Chiết khấu cần kiểm tra riêng");
  if (l.discountRate != null && l.discountRate !== 0) problems.push("Tỷ lệ chiết khấu cần kiểm tra riêng");
  if ([l.promotionTotal, l.credits].some((value) => value != null && value !== 0)) problems.push("Tổng khuyến mại/điểm cần kiểm tra riêng");
  if (l.promotion != null && l.promotion !== "" && !["0", "false", "khong", "no"].includes(normalize(l.promotion))) problems.push("Khuyến mại cần kiểm tra riêng");
  if (l.quantity != null && l.quantity <= 0) problems.push("Số lượng bằng 0/âm cần kiểm tra riêng");
  if ([l.net, l.tax, l.gross, l.price].some((v) => v != null && v < 0)) problems.push("Giá trị âm cần kiểm tra riêng");
  return problems;
}
function process(sources, selections, progress = () => {
}) {
  const choices = sources.map((s, i) => validateSelection(s, selections[i]));
  const roles = choices.map((c) => c.role), v2 = roles.includes("issued") && roles.includes("sales"), legacy = roles.includes("ledger") && roles.includes("catalog");
  if (!v2 && !legacy) throw new Error("Cần đúng cặp: bảng kê đã phát hành + bán ra, hoặc sổ chi tiết + danh sách hàng hóa.");
  const ai = roles.indexOf(v2 ? "issued" : "ledger"), bi = 1 - ai, a = rows(sources[ai], choices[ai]), b = rows(sources[bi], choices[bi]);
  progress(20, "Đã đọc các dòng nguồn");
  const index = /* @__PURE__ */ new Map(), ignored = [...a.filter((l) => l.ignored), ...b.filter((l) => l.ignored)];
  const blockers = a.filter((l) => l.ignored && l.name && l.net != null && !["tong", "tong cong", "cong", "total"].includes(normalize(l.name))).map((l) => `Thiếu số hóa đơn tại ${l.source.file} / ${l.source.sheet} / dòng ${l.source.row}; không thể bảo đảm đủ dòng hàng`);
  const key = (l) => v2 ? JSON.stringify([l.number, l.date, normalize(l.name), Math.round(l.net ?? NaN)]) : l.code.trim().toUpperCase();
  b.filter((l) => !l.ignored).forEach((l, i) => {
    l.compareId = i;
    const k = key(l);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(l);
  });
  const candidateMap = /* @__PURE__ */ new Map(), usage = /* @__PURE__ */ new Map();
  a.filter((l) => !l.ignored).forEach((l) => {
    let options = (index.get(key(l)) || []).filter((x) => !v2 || !l.symbol || !x.symbol || l.symbol === x.symbol);
    if (!v2 && options.length > 1) {
      const rates = new Set(options.map((x) => x.rate));
      if (rates.size === 1 && ![...rates].includes(null)) options = [options[0]];
      else l.catalogConflict = true;
    }
    candidateMap.set(l, options);
    if (v2 && options.length === 1) usage.set(options[0], (usage.get(options[0]) || 0) + 1);
  });
  const invoices = /* @__PURE__ */ new Map();
  let count = 0;
  for (const l of a.filter((l2) => !l2.ignored)) {
    l.id = `line-${count++}`;
    l.issues = moneyIssues(l);
    if (l.catalogConflict) l.issues.push("Mã hàng trùng có thuế suất khác nhau hoặc thiếu thuế suất; sửa danh sách hàng hóa trước khi xuất");
    if (l.rate == null && (l.raw.rate == null || l.raw.rate === "") && l.net > 0 && l.tax != null) l.rate = rate(l.tax / l.net * 100);
    if (l.rate == null) l.issues.push("Không xác định được thuế suất nguồn");
    const options = candidateMap.get(l);
    l.counterpart = options.length === 1 ? options[0].source : null;
    l.targetRate = options.length === 1 ? options[0].rate : null;
    l.state = l.issues.length ? "error" : !options.length ? "unmatched" : options.length > 1 || v2 && usage.get(options[0]) > 1 ? "ambiguous" : l.targetRate == null ? "unmatched" : Math.abs(l.rate - l.targetRate) > 1e-6 ? "mismatch" : "matched";
    l.before = { net: l.net, tax: l.tax, gross: l.gross ?? (l.net != null && l.tax != null ? l.net + l.tax - (l.discount || 0) : null), price: l.price, rate: l.rate };
    l.after = { ...l.before };
    if (l.state === "mismatch") {
      const net = Math.round(l.before.gross / (1 + l.targetRate / 100));
      l.after = { net, tax: l.before.gross - net, gross: l.before.gross, price: Math.round(net / l.quantity * 1e6) / 1e6, rate: l.targetRate };
    }
    const k = JSON.stringify([l.symbol, l.number, l.date]);
    if (!invoices.has(k)) invoices.set(k, { id: `invoice-${invoices.size}`, number: l.number, date: l.date, symbol: l.symbol, lines: [], status: knownStatus(l.status), sourceStatus: l.status, metadata: {} });
    const inv = invoices.get(k);
    inv.lines.push(l);
    if (knownStatus(l.status) === "excluded") inv.status = "excluded";
    else if (knownStatus(l.status) === "unknown" && inv.status !== "excluded") inv.status = "unknown";
    if (count % 500 === 0) progress(20 + Math.round(count / a.length * 70), "Đang đối chiếu");
  }
  const result = [...invoices.values()];
  for (const inv of result) {
    inv.candidate = inv.lines.some((l) => l.state === "mismatch");
    inv.unresolved = inv.lines.filter((l) => ["unmatched", "ambiguous"].includes(l.state)).length;
    inv.errors = inv.lines.filter((l) => l.state === "error").length;
    inv.before = inv.lines.reduce((n, l) => n + (l.before.gross || 0), 0);
    inv.after = inv.lines.reduce((n, l) => n + (l.after.gross || 0), 0);
    for (const f of metadataFields) {
      const values = [...new Set(inv.lines.map((l) => l[f]).filter(Boolean))];
      if (values.length > 1) {
        inv.errors++;
        inv.metadata[f] = "";
        inv.metadataConflict = (inv.metadataConflict || []).concat(f);
      } else inv.metadata[f] = values[0] || "";
    }
  }
  const stats = { invoices: result.length, lines: count, ignored: ignored.length, candidates: result.filter((i) => i.candidate).length, changed: result.reduce((n, i) => n + i.lines.filter((l) => l.state === "mismatch").length, 0), states: {} };
  for (const inv of result) for (const l of inv.lines) stats.states[l.state] = (stats.states[l.state] || 0) + 1;
  progress(100, "Đối chiếu hoàn tất");
  return { mode: v2 ? "v2" : "legacy", invoices: result, ignored, blockers, stats };
}
function todayVN() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(/* @__PURE__ */ new Date());
}
function exportCheck(inv, job) {
  const metadata = { ...job.defaults, ...inv.metadata, ...job.overrides?.[inv.id] };
  for (const f of Object.keys(metadata)) metadata[f] = job.overrides?.[inv.id]?.[f] || inv.metadata[f] || job.defaults?.[f] || "";
  const blockers = [...job.result?.blockers || []];
  if (!inv.candidate) blockers.push("Không có dòng lệch thuế suất");
  if (inv.status === "excluded") blockers.push("Hóa đơn đã hủy/đã bị thay thế");
  if (inv.status === "unknown" && !job.confirmations?.[inv.id]?.status) blockers.push("Cần xác minh trạng thái hóa đơn");
  if (inv.errors) blockers.push("Có lỗi dữ liệu cần sửa ở nguồn");
  if (inv.unresolved && !job.confirmations?.[inv.id]?.keep) blockers.push("Cần xác nhận giữ nguyên dòng chưa đối chiếu được");
  for (const f of ["symbol", "payment", "buyer"]) if (!metadata[f] && !(f === "buyer" && metadata.buyerPerson)) blockers.push(`Thiếu ${f === "symbol" ? "ký hiệu hóa đơn gốc" : f === "payment" ? "hình thức thanh toán" : "người mua"}`);
  if (!date(job.newDate)) blockers.push("Ngày hóa đơn mới không hợp lệ");
  if (inv.before !== inv.after) blockers.push("Tổng thanh toán thay đổi");
  return { metadata, blockers };
}
module.exports = { number, rate, date, rows, knownStatus, process, exportCheck, todayVN };
