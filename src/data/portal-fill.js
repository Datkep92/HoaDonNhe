'use strict';
// ---------------------------------------------------------------------------
// TỰ ĐIỀN BIỂU MẪU TRA CỨU CỦA NHÀ CUNG CẤP (Mục 3)
// ---------------------------------------------------------------------------
// VÌ SAO CẦN: người dùng phải tự gõ MST, ký hiệu, số hóa đơn vào cổng NCC thì rất phiền,
// và họ hay không biết tra ở đâu. Bản tham chiếu 1.4.20_0 làm đúng việc này: mở cổng,
// điền sẵn mọi trường mà dữ liệu XML có, rồi CHỈ giao lại phần CAPTCHA (thứ máy không
// được phép tự làm thay).
//
// NGUYÊN TẮC — chỉ điền những gì ta CÓ THẬT trong XML:
//   · MST người bán / người mua, ký hiệu, số hóa đơn, ngày lập: luôn có.
//   · Mã tra cứu: CHỈ có với một phần nhỏ hóa đơn. Không có thì để trống và nói rõ,
//     tuyệt đối không đoán/bịa (xem xml-parser: số cổng trong URL không phải mã).
//
// Mỗi mục là { sel, label, from } hoặc { sel, label, value }:
//   from  — tên trường của hóa đơn để lấy giá trị
//   value — hàm tính giá trị từ hóa đơn (dùng cho trường ghép như ký hiệu+số)

const FIELDS = {
  // VNPT: tra cứu theo thông tin hóa đơn (không cần mã bí mật nếu đủ thông tin).
  vnpt: [
    { sel: '#slTracuu, select[name="slTracuu"]', label: 'chế độ tra cứu', value: () => '1' },
    { sel: '#CodeTax, input[name="CodeTax"]', label: 'MST người bán', from: 'mst_ban' },
    { sel: '#Pattern, select[name="Pattern"]', label: 'mẫu số', kind: 'pattern', from: 'khh_hd' },
    { sel: '#Serial, select[name="Serial"]', label: 'ký hiệu', from: 'khh_hd' },
    { sel: '#InvNo, input[name="InvNo"], #strNo, input[name="strNo"]', label: 'số hóa đơn', from: 'so_hd' },
    { sel: '#nameCus, input[name="nameCus"]', label: 'MST người mua', from: 'mst_mua' },
    { sel: '#strFkey, input[name="strFkey"]', label: 'mã tra cứu', from: 'lookup_code' },
  ],
  // Viettel: một ô "số hóa đơn" gộp cả ký hiệu và số.
  viettel: [
    { sel: 'input[name$=":supplierTaxCode"], input[formcontrolname="supplierTaxCode" i], input[formcontrolname="taxcodeSeller" i]', label: 'MST người bán', from: 'mst_ban' },
    { sel: 'input[name$=":reservationCode"], input[formcontrolname="reservationCode" i], input[formcontrolname="privateCode" i], input[formcontrolname="secretCode" i]', label: 'mã tra cứu', from: 'lookup_code' },
    { sel: 'input[name$=":invoiceNo"]', label: 'ký hiệu và số HĐ', value: inv => `${inv.khh_hd || ''}${inv.so_hd || ''}`.trim() },
    { sel: 'input[name$=":issueDate_input"]', label: 'ngày lập', value: inv => vnDate(inv.ngay_lap) },
  ],
  // MISA: cổng tra cứu chỉ có MỘT ô, và ô đó là mã tra cứu. Số hóa đơn không giúp được.
  misa: [
    { sel: '#txtCode', label: 'mã tra cứu', from: 'lookup_code' },
  ],
  // EasyInvoice: tra theo mã tra cứu hoặc MST + tên.
  easyinvoice: [
    { sel: '#txtCode, input[name="code"], input[id*="code" i]', label: 'mã tra cứu', from: 'lookup_code' },
    { sel: '#TaxCode, input[name="TaxCode"], input[name*="tax" i]', label: 'MST người bán', from: 'mst_ban' },
  ],
  fpt: [
    { sel: '#TaxCode, input[name="TaxCode"]', label: 'MST người bán', from: 'mst_ban' },
    { sel: '#Serial, input[name="Serial"]', label: 'ký hiệu', from: 'khh_hd' },
    { sel: '#InvNo, input[name="InvNo"]', label: 'số hóa đơn', from: 'so_hd' },
    { sel: '#strFkey, input[name="strFkey"]', label: 'mã tra cứu', from: 'lookup_code' },
  ],
  cyberbill: [
    { sel: '#txtCode, input[name="code"]', label: 'mã tra cứu', from: 'lookup_code' },
    { sel: '#TaxCode, input[name="TaxCode"]', label: 'MST người bán', from: 'mst_ban' },
    { sel: '#Serial, input[name="Serial"]', label: 'ký hiệu', from: 'khh_hd' },
    { sel: '#InvNo, input[name="InvNo"]', label: 'số hóa đơn', from: 'so_hd' },
  ],
};

// Ngày ISO (2026-05-05) → dd/MM/yyyy, đúng định dạng cổng Viettel dùng.
function vnDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/**
 * Dựng kế hoạch điền cho 1 hóa đơn.
 * @returns {{ fields: Array, missing: string[], supported: boolean, providerId: string }}
 *   fields  — [{ sel, label, value, kind }] chỉ gồm trường CÓ giá trị thật
 *   missing — nhãn các trường cần mà ta không có dữ liệu (để nói rõ với người dùng)
 *   supported — cổng này có bảng điền trường không
 */
function planFor(providerId, invoice = {}) {
  const id = String(providerId || '').trim().toLowerCase();
  const spec = FIELDS[id] || null;
  if (!spec) return { fields: [], missing: [], supported: false, providerId: id };
  const fields = [];
  const missing = [];
  for (const item of spec) {
    const raw = item.value ? item.value(invoice) : invoice[item.from];
    const value = String(raw == null ? '' : raw).trim();
    if (!value) { missing.push(item.label); continue; }
    fields.push({ sel: item.sel, label: item.label, value, kind: item.kind || '' });
  }
  return { fields, missing, supported: true, providerId: id };
}

// Kịch bản chạy trong trang cổng để điền. Dùng setter gốc của HTMLInputElement/
// HTMLSelectElement rồi bắn input + change, nếu không các framework của cổng (Angular,
// React, ASP.NET) không "thấy" giá trị mới và sẽ tự ghi đè khi người dùng bấm nút.
const FILL_SCRIPT = plan => `(() => {
  const plan = ${JSON.stringify(plan)};
  const log = (name, ok, note) => { try { if (name) window['__cnTaxFill'] = (window['__cnTaxFill'] || []).concat([[name, !!ok, note || '']]); } catch {} };
  const setValue = (el, value) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (el instanceof HTMLSelectElement) {
      const exists = [...el.options].some(o => String(o.value || o.textContent || '').trim() === value);
      if (!exists) {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = value; el.appendChild(opt);
      }
    }
    if (setter && setter.set) setter.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const filled = [];
  for (const item of plan.fields) {
    let el = null;
    try { el = document.querySelector(item.sel); } catch {}
    if (!el) { log(item.label, false, 'không thấy ô nhập'); continue; }
    try { setValue(el, item.value); filled.push(item.label); }
    catch (e) { log(item.label, false, String(e && e.message || e)); }
  }
  return JSON.stringify({ filled, missing: plan.missing, total: plan.fields.length });
})()`;

module.exports = { FIELDS, planFor, vnDate, FILL_SCRIPT, supports: id => Boolean(FIELDS[String(id || '').toLowerCase()]) };
