"use strict";
const XLSX = require("../../resources/xlsx.cjs");
const crypto = require("node:crypto");
const normalize = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/\(\*\)/g, "").replace(/[%()*]/g, " ").replace(/\s+/g, " ").trim();
const aliases = {
  number: ["Số hóa đơn"],
  date: ["Ngày hóa đơn", "Ngày"],
  symbol: ["Ký hiệu", "Ký hiệu hóa đơn"],
  order: ["Mã đơn hàng eShop", "Số chứng từ"],
  code: ["Mã hàng", "Mã hàng hóa"],
  name: ["Tên hàng", "Tên hàng hóa", "Mặt hàng", "Tên hàng hóa/dịch vụ"],
  unit: ["ĐVT", "Đơn vị tính"],
  quantity: ["Số lượng"],
  price: ["Đơn giá", "Đơn giá trước thuế"],
  net: ["Thành tiền", "Thành tiền trước thuế", "Doanh số bán chưa có thuế GTGT"],
  gross: ["Tổng tiền TT", "Tổng thanh toán", "Tổng tiền thanh toán"],
  tax: ["Tiền thuế GTGT", "Thuế GTGT"],
  rate: ["Thuế suất", "Thuế suất GTGT"],
  discount: ["Tiền CK", "Tiền chiết khấu"],
  discountRate: ["Tỷ lệ CK", "Tỷ lệ chiết khấu"],
  promotion: ["Khuyến mại trước thuế", "Hàng KM"],
  promotionTotal: ["Tổng KM trước thuế", "Tổng khuyến mại trước thuế"],
  credits: ["Điểm trước thuế"],
  status: ["Trạng thái HĐ", "Trạng thái hóa đơn"],
  buyer: ["Tên khách hàng", "Tên người mua", "Tên đơn vị mua hàng"],
  buyerTax: ["MST/CCCD chủ hộ", "Mã số thuế người mua", "Mã số thuế"],
  address: ["Địa chỉ"],
  buyerPerson: ["Người mua hàng"],
  payment: ["Hình thức TT", "Hình thức thanh toán"],
  email: ["Email"],
  phone: ["Số điện thoại"],
  identity: ["Căn cước công dân"],
  authorityCode: ["Mã của CQT trên HĐ bị thay thế"],
  external: ["HĐ bị thay thế thuộc hệ thống khác"]
};
const metadataFields = ["symbol", "buyer", "buyerTax", "address", "buyerPerson", "payment", "email", "phone", "identity", "authorityCode", "external"];
const roles = {
  issued: { label: "Bảng kê hóa đơn đã phát hành", required: ["number", "date", "name", "net", "tax", "quantity", "price"], signature: ["symbol", "gross", "status"] },
  sales: { label: "Bảng kê bán ra đối chiếu thuế suất", required: ["number", "date", "name", "net", "rate"], signature: ["buyerTax", "buyer"] },
  ledger: { label: "Sổ chi tiết bán hàng", required: ["number", "date", "code", "name", "net", "tax", "quantity", "price"], signature: ["order", "promotion"] },
  catalog: { label: "Danh sách hàng hóa", required: ["code", "rate"], signature: ["name", "unit"] }
};
const lookup = new Map(Object.entries(aliases).flatMap(([f, a]) => a.map((v) => [normalize(v), f])));
function getCell(sheet, r, c) {
  let cell = sheet[XLSX.utils.encode_cell({ r, c })];
  if (!cell) {
    const merge = (sheet["!merges"] || []).find((m) => r >= m.s.r && r <= m.e.r && c >= m.s.c && c <= m.e.c);
    if (merge) cell = sheet[XLSX.utils.encode_cell(merge.s)];
  }
  return cell;
}
function cellValue(sheet, r, c) {
  const cell = getCell(sheet, r, c);
  if (!cell) return null;
  if (cell.t === 'e') throw new Error(`Ô Excel báo lỗi: ${XLSX.utils.encode_cell({ r, c })}`);
  if (cell.f && cell.v == null) throw new Error(`Ô công thức chưa có giá trị tính sẵn: ${XLSX.utils.encode_cell({ r, c })}`);
  return cell.v ?? null;
}
function headerAt(sheet, start, depth) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const headers = [];
  for (let c = 0; c <= range.e.c; c++) {
    const parts = [];
    for (let r = start; r < start + depth; r++) {
      let cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (!cell) {
        const m = (sheet["!merges"] || []).find((m2) => r >= m2.s.r && r <= m2.e.r && c >= m2.s.c && c <= m2.e.c);
        if (m) cell = sheet[XLSX.utils.encode_cell(m.s)];
      }
      if (cell?.v != null) parts.push(String(cell.v));
    }
    const unique = [...new Set(parts)], combined = unique.join(" "), leaf = unique.at(-1) || "", reversed = [...unique].reverse().join(" ");
    headers.push(lookup.has(normalize(combined)) ? combined : lookup.has(normalize(leaf)) ? leaf : lookup.has(normalize(reversed)) ? reversed : combined);
  }
  return headers;
}
function mapHeaders(headers) {
  const fields = {}, conflicts = {};
  headers.forEach((h, c) => {
    const f = lookup.get(normalize(h));
    if (f) {
      (conflicts[f] ||= []).push(c);
    }
  });
  for (const [f, cs] of Object.entries(conflicts)) if (cs.length === 1) fields[f] = cs[0];
  return { fields, conflicts: Object.fromEntries(Object.entries(conflicts).filter(([, v]) => v.length > 1)) };
}
function fingerprint(headers) {
  return crypto.createHash("sha256").update(JSON.stringify(headers.map(normalize))).digest("hex");
}
function inspect(buffer, name) {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false, cellStyles: true });
  const candidates = [];
  for (const sheetName of book.SheetNames) {
    const sheet = book.Sheets[sheetName];
    if (!sheet["!ref"]) continue;
    const end = XLSX.utils.decode_range(sheet["!ref"]).e.r;
    for (let start = 0; start <= Math.min(49, end); start++) for (let depth = 1; depth <= 3 && start + depth <= end + 1; depth++) {
      const headers = headerAt(sheet, start, depth), mapping = mapHeaders(headers), found = Object.keys(mapping.fields);
      if (found.length < 2) continue;
      const samples = headers.map((_, c) => Array.from({ length: 3 }, (_2, n) => {
        try {
          return cellValue(sheet, start + depth + n, c);
        } catch {
          return "[Công thức thiếu giá trị]";
        }
      }));
      for (const [role, spec] of Object.entries(roles)) {
        const covered = spec.required.filter((f) => found.includes(f)).length;
        if (covered < Math.min(3, spec.required.length)) continue;
        const title = normalize(Array.from({ length: start }, (_, r) => headerAt(sheet, r, 1).join(" ")).join(" "));
        const titleMatch = { issued: /hoa don da su dung|hoa don da phat hanh/, sales: /dich vu ban ra|bang ke ban ra/, ledger: /so chi tiet ban hang/, catalog: /danh sach hang hoa/ }[role].test(title);
        const score = covered * 10 + spec.signature.filter((f) => found.includes(f)).length * 4 + (titleMatch ? 5 : 0);
        candidates.push({ sheet: sheetName, start, depth, headers, samples, role, fields: mapping.fields, conflicts: mapping.conflicts, missing: spec.required.filter((f) => !found.includes(f)), score, fingerprint: fingerprint(headers) });
      }
    }
  }
  const best = [];
  for (const c of candidates.sort((a, b) => b.score - a.score || a.depth - b.depth)) if (!best.some((b) => b.sheet === c.sheet && b.role === c.role && Math.abs(b.start - c.start) < 3)) best.push(c);
  return { name, book, candidates: best };
}
function validateSelection(source, choice) {
  if (!roles[choice.role]) throw new Error("Loại báo cáo không hợp lệ.");
  if (!source.book.Sheets[choice.sheet]) throw new Error("Sheet không tồn tại.");
  if (!Number.isInteger(choice.start) || choice.start < 0 || choice.start > 49 || ![1, 2, 3].includes(choice.depth)) throw new Error("Dòng tiêu đề không hợp lệ.");
  const headers = headerAt(source.book.Sheets[choice.sheet], choice.start, choice.depth);
  const fields = choice.fields || {};
  const used = /* @__PURE__ */ new Set();
  for (const [field, c] of Object.entries(fields)) {
    if (!aliases[field] || !Number.isInteger(c) || c < 0 || c >= headers.length || used.has(c)) throw new Error("Mapping trùng cột hoặc không hợp lệ.");
    used.add(c);
  }
  const missing = roles[choice.role].required.filter((f) => fields[f] == null);
  if (missing.length) throw new Error(`Thiếu cột bắt buộc: ${missing.map((f) => aliases[f][0]).join(", ")}`);
  return { ...choice, headers, fingerprint: fingerprint(headers) };
}
function autoSelections(sources) {
  const pairs = [["issued", "sales"], ["ledger", "catalog"]];
  const possibilities = [];
  for (const pair of pairs) for (const order of [pair, [...pair].reverse()]) {
    const lists = sources.map((s, i) => s.candidates.filter((c) => c.role === order[i] && !c.missing.length && !Object.keys(c.conflicts).length));
    for (const a of lists[0]) for (const b of lists[1]) possibilities.push({ choices: [a, b], score: a.score + b.score });
  }
  possibilities.sort((a, b) => b.score - a.score);
  return possibilities.length && (!possibilities[1] || possibilities[0].score > possibilities[1].score) ? possibilities[0].choices : null;
}
module.exports = { XLSX, normalize, aliases, roles, metadataFields, inspect, getCell, cellValue, headerAt, mapHeaders, validateSelection, autoSelections, fingerprint };
