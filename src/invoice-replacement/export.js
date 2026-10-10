"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { XLSX } = require("./mapping");
const { exportCheck } = require("./engine");
const templatePath = path.join(__dirname, "../../resources/invoice-replacement-misa.xls");
const displayDate = (iso) => iso.split("-").reverse().join("/");
const stateLabels={matched:'Đủ dữ liệu',mismatch:'Lệch thuế suất',unmatched:'Chưa đối chiếu được',ambiguous:'Ghép mơ hồ',error:'Lỗi dữ liệu'};
function build(job, ids, report = false) {
  const selected = new Set(ids || []);
  if (report) {
    const rows = [["Hóa đơn", "Ngày", "Ký hiệu", "Trạng thái nguồn", "Được chọn", "Trạng thái đối chiếu", "Tên hàng", "Thuế suất trước", "Thuế suất sau", "Tiền trước thuế trước", "Tiền trước thuế sau", "Thuế trước", "Thuế sau", "Tổng thanh toán trước", "Tổng thanh toán sau", "Giữ nguyên theo xác nhận", "File", "Sheet", "Dòng", "File đối chiếu", "Sheet đối chiếu", "Dòng đối chiếu", "Lỗi / lý do chặn"]];
    for (const inv of job.result.invoices) for (const l of inv.lines) rows.push([inv.number, inv.date, inv.symbol, inv.sourceStatus || "Chưa rõ", selected.has(inv.id) ? "Có" : "Không", stateLabels[l.state]||l.state, l.name, l.before.rate, l.after.rate, l.before.net, l.after.net, l.before.tax, l.after.tax, l.before.gross, l.after.gross, job.confirmations?.[inv.id]?.keep && ["unmatched", "ambiguous"].includes(l.state) ? "Đã xác nhận" : "", l.source.file, l.source.sheet, l.source.row, l.counterpart?.file, l.counterpart?.sheet, l.counterpart?.row, [...l.issues, ...exportCheck(inv, job).blockers].join("; ")]);
    for (const l of job.result.ignored) rows.push(["", "", "", "", "Không", "Bỏ qua: dòng tổng/thiếu mã", "", "", "", "", "", "", "", "", "", "", l.source.file, l.source.sheet, l.source.row]);
    const book2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book2, XLSX.utils.aoa_to_sheet(rows), "Đối chiếu");
    return XLSX.write(book2, { type: "buffer", bookType: "xlsx" });
  }
  if (!selected.size) throw new Error("Chọn ít nhất một hóa đơn.");
  if ([...selected].some((id) => !job.result.invoices.some((i) => i.id === id))) throw new Error("Hóa đơn không thuộc lượt xử lý này.");
  const invoices = job.result.invoices.filter((i) => selected.has(i.id));
  const book = XLSX.read(fs.readFileSync(templatePath), { type: "buffer", cellStyles: true });
  const sheet = book.Sheets[book.SheetNames[0]], range = XLSX.utils.decode_range(sheet["!ref"]);
  for (const key of Object.keys(sheet)) if (!key.startsWith("!") && XLSX.utils.decode_cell(key).r >= 9) delete sheet[key];
  delete sheet["!autofilter"];
  sheet["!merges"] = (sheet["!merges"] || []).filter((m) => m.e.r < 9);
  let r = 9, sequence = 0;
  for (const inv of invoices) {
    const { metadata: m, blockers } = exportCheck(inv, job);
    if (blockers.length) throw new Error(`HĐ ${inv.number}: ${blockers.join("; ")}`);
    sequence++;
    for (const [index, l] of inv.lines.entries()) {
      const header = index === 0 ? [sequence, displayDate(job.newDate), m.buyer || m.buyerPerson, m.buyerTax, m.address, m.buyerPerson, m.email, m.phone, m.identity, m.payment, m.external, m.symbol, inv.number, displayDate(inv.date), m.authorityCode] : [sequence, ...Array(14).fill("")];
      const row = [...header, l.name, l.unit, l.quantity, l.after.price, l.after.net, l.after.rate, l.after.tax];
      row.forEach((v, c) => {
        if (v != null && v !== "") sheet[XLSX.utils.encode_cell({ r, c })] = { t: typeof v === "number" ? "n" : "s", v, z: typeof v === "number" ? "0.######" : "@" };
      });
      r++;
    }
  }
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(8, r - 1), c: 21 } });
  if (sheet["!rows"]) sheet["!rows"] = sheet["!rows"].slice(0, r);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx", cellStyles: true });
}
module.exports = { build, templatePath };
