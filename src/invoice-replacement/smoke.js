"use strict";
async function check() {
  const { XLSX } = require("./mapping");
  const { launch } = require("./service");
  const { todayVN } = require("./engine");
  function file(name, rows) {
    const book2 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book2, XLSX.utils.aoa_to_sheet(rows), "Nguồn");
    return { name, buffer: Buffer.from(XLSX.write(book2, { type: "buffer", bookType: "xlsx" })) };
  }
  const files = [file("issued.xlsx", [
    ["Ký hiệu", "Số hóa đơn", "Ngày hóa đơn", "Tên hàng", "Số lượng", "Đơn giá", "Thành tiền", "Thuế suất", "Tiền thuế GTGT", "Tổng tiền TT", "Trạng thái HĐ", "Tên khách hàng", "Hình thức TT"],
    ["1C26ABC", "00000123", "01/07/2026", "Hàng thử", 1, 1e5, 1e5, 10, 1e4, 11e4, "Hoá đơn mới", "Khách kiểm thử", "TM/CK"]
  ]), file("comparison.xlsx", [
    ["Số hóa đơn", "Ngày hóa đơn", "Mặt hàng", "Doanh số bán chưa có thuế GTGT", "Thuế suất"],
    ["00000123", "01/07/2026", "Hàng thử", 1e5, 8]
  ])];
  const job = { revision: 1 };
  const inspected = await launch(job, { action: "inspect", files });
  if (!inspected.selections) throw new Error("Worker không nhận diện đúng hai file.");
  const processed = await launch(job, { action: "process", files, selections: inspected.selections });
  const result = processed.result;
  if (result.stats.changed !== 1 || result.invoices[0].before !== result.invoices[0].after) throw new Error("Worker đối chiếu/tổng tiền không đúng.");
  const exported = await launch(job, { action: "export", job: { result, defaults: {}, overrides: {}, confirmations: {}, newDate: todayVN() }, ids: ["invoice-0"] });
  const output = Buffer.from(exported.buffer), book = XLSX.read(output, { type: "buffer" }), sheet = book.Sheets[book.SheetNames[0]];
  if (sheet.M10?.v !== "00000123" || XLSX.utils.decode_range(sheet["!ref"]).e.c !== 21) throw new Error("Mẫu MISA nhúng không xuất được đúng 22 cột/số hóa đơn.");
  return { worker: true, template: true, bytes: output.length };
}
module.exports = { check };
