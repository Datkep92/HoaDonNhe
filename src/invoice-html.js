'use strict';
// Dựng file HTML hóa đơn giống trang tra cứu của cổng thuế (dùng cho cả .html và .pdf).
// Port từ dự án extension `New folder (3)` — background-api.js: buildInvoiceHtml (dòng 4684-5030)
// và các hàm phụ trợ — để file HTML/PDF của app khớp bản chuẩn: Times New Roman, khổ A4 210mm,
// khung viền đôi, ảnh nền hóa đơn, dấu "Signature Valid", mã QR, bảng thuế suất, chữ ký số.
const fs = require('node:fs');
const path = require('node:path');
const { QRCode, QRErrorCorrectLevel } = require('./vendor/qrcode.js');
const vnDate = require('./vn-date');

// ===== Nguyên hàm phụ trợ (giữ nguyên từ dự án gốc) =====

function isBlankValue(value) {
  return value === null || value === undefined || value === '';
}

function itemName(item) {
  return item?.ten || item?.thdon || item?.thhdon || '';
}

function itemQuantity(item) {
  return item?.sluong ?? item?.slvban ?? null;
}

function itemUnitPrice(item) {
  return item?.dgia ?? item?.dgban ?? null;
}

function itemAmount(item) {
  return item?.thtien ?? item?.thtcthue ?? null;
}

// Sinh QR cho hóa đơn từ chuỗi qrcode trong detail response của GDT. Dùng đúng encoder
// qrcode-generator nên QR giống trang thuế và quét được. Ưu tiên typeNumber 9 (ra
// 53x53 như trang thuế); chỉ tăng kích thước khi nội dung quá dài. Trả về chuỗi SVG
// để nhúng thẳng vào HTML và PDF (không cần script chạy lúc mở file).
function buildInvoiceQr(text) {
  if (typeof QRCode === 'undefined' || isBlankValue(text)) return null;
  const data = String(text);
  let qr = null;
  for (let t = 9; t <= 40 && !qr; t++) {
    try { const q = new QRCode(t, QRErrorCorrectLevel.L); q.addData(data); q.make(); qr = q; } catch (_) {}
  }
  for (let t = 1; t < 9 && !qr; t++) {
    try { const q = new QRCode(t, QRErrorCorrectLevel.L); q.addData(data); q.make(); qr = q; } catch (_) {}
  }
  return qr;
}

function qrSvgFromText(text, sizePx = 80) {
  const qr = buildInvoiceQr(text);
  if (!qr) return '';
  const n = qr.getModuleCount();
  // Gộp các ô đen liền nhau theo hàng thành một path để SVG gọn hơn nhiều so với
  // việc vẽ từng rect riêng lẻ.
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.isDark(r, c)) {
        let run = 1;
        while (c + run < n && qr.isDark(r, c + run)) run++;
        d += `M${c} ${r}h${run}v1h-${run}z`;
        c += run;
      } else {
        c++;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

function invoiceQrText(detail, inv) {
  return firstNonBlank(detail?.qrcode, detail?.qrCode, detail?.QRCode, inv?.qrcode, inv?.qrCode, inv?.QRCode);
}

// Rút gọn chuỗi chủ thể chữ ký số (X509 Subject) chỉ còn tên đơn vị (CN), giống cách
// trang thuế hiển thị trong ô "Ký bởi".
function signerCommonName(subject) {
  if (isBlankValue(subject)) return '';
  const s = String(subject);
  const m = s.match(/CN\s*=\s*([^,]+(?:,(?!\s*[A-Za-z0-9.]+\s*=)[^,]*)*)/);
  return m ? m[1].trim() : s.trim();
}

// Bản gốc lấy URL tài nguyên qua chrome.runtime.getURL; ở app desktop, wrapper luôn truyền ảnh đã nhúng
// sẵn dạng data: URL, nên đây chỉ là đường lui khi thiếu ảnh — trả về rỗng để HTML vẫn dựng được.
function extensionAssetUrl() { return ''; }

// MCCQT (Mã của cơ quan thuế) và NLap (ngày lập) cũng có trong XML gốc. Cổng thuế trả sẵn hai giá trị
// này trong detail response, nhưng XML là đường lui khi detail thiếu: cùng cách extension làm
// (background-api.js: extractXmlFields). Bản gốc nhận mảng xmlFiles; ở đây nhận thẳng chuỗi XML.
function extractXmlFields(xml) {
  const result = {};
  if (isBlankValue(xml)) return result;
  const mccqtMatch = String(xml).match(/<MCCQT[^>]*>([^<]+)<\/MCCQT>/);
  if (mccqtMatch) result.mccqt = mccqtMatch[1].trim();
  const nlapMatch = String(xml).match(/<NLap>([^<]+)<\/NLap>/);
  if (nlapMatch) result.nlap = nlapMatch[1].trim();
  return result;
}

// Ghép MCCQT/NLap lấy từ XML gốc vào detail trước khi dựng HTML/PDF — giống `detailWithXml` của
// extension. Không có dữ liệu XML thì trả lại nguyên detail (không thêm khóa rỗng).
function withXmlFields(detail, xml) {
  const fields = extractXmlFields(xml);
  if (!fields.mccqt && !fields.nlap) return detail;
  return { ...detail, _xmlMccqt: fields.mccqt || null, _xmlNlap: fields.nlap || null };
}

/**
 * Builds a properly formatted invoice HTML from JSON detail data.
 * Used for both HTML and PDF (print-ready) output files.
 */
function buildInvoiceHtml(inv, detail, assets) {
  const d = detail || {};
  const invoiceBgUrl = (assets && assets.invoiceBg) || extensionAssetUrl('template/viewinvoice-bg.jpg');
  const signCheckUrl = (assets && assets.signCheck) || extensionAssetUrl('template/sign-check.jpg');

  // Parse chữ ký số từ nbcks (JSON string)
  let cksInfo = null;
  try { if (d.nbcks) cksInfo = JSON.parse(d.nbcks); } catch (_) {}
  const signingTime = cksInfo?.SigningTime ? String(cksInfo.SigningTime) : '';

  const fmtNum = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (isNaN(num)) return String(n);
    // Giữ nguyên toàn bộ số lẻ như trang thuế (vd đơn giá 60.185,1875), không làm tròn.
    return num.toLocaleString('vi-VN', { maximumFractionDigits: 20 });
  };

  const fmtDate = (s) => {
    if (!s) return '';
    s = String(s);
    let day, month, year;
    if (s.includes('/')) { [day, month, year] = s.split('/'); }
    else if (s.includes('-')) {
      // tdlap của cổng thuế là MỐC UTC ("...T17:00:00Z" = ngày hôm sau giờ VN) ⇒ quy về ngày VN.
      // NLap của XML (YYYY-MM-DD) và chuỗi không kèm múi giờ đã là ngày VN nên giữ nguyên.
      const dateStr = vnDate.isoDay(s);
      if (!dateStr) return '';
      [year, month, day] = dateStr.split('-');
    }
    else return s;
    return `Ng&agrave;y ${day} th&aacute;ng ${month} n&abreve;m ${year}`;
  };

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const hdon = String(d.hdon || inv.hdon || '01');
  const titleMap = { '01': 'HO&Aacute; &#272;&#416;N GI&Aacute; TR&#7882; GIA T&#258;NG', '02': 'HO&Aacute; &#272;&#416;N B&Aacute;N H&Agrave;NG', '03': 'HO&Aacute; &#272;&#416;N B&Aacute;N H&Agrave;NG', '04': 'HO&Aacute; &#272;&#416;N B&Aacute;N T&Agrave;I S&#7842;N C&Ocirc;NG' };
  const invoiceTitle = titleMap[hdon] || titleMap['01'];

  const httoanMap = { 1: 'Tiền mặt', 2: 'Chuyển khoản', 3: 'Tiền mặt/Chuyển khoản', 4: 'Thẻ', 5: 'Tiền mặt/Thẻ', 6: 'Chuyển khoản/Thẻ', 7: 'Tiền mặt/Chuyển khoản/Thẻ', 8: 'Bù trừ công nợ', 9: 'Khác' };

  const khmshdon = d.khmshdon || inv.khmshdon || '';
  const khhdon   = d.khhdon   || inv.khhdon   || '';
  const shdon    = d.shdon    || inv.shdon    || '';
  const tdlap    = d._xmlNlap  || d.tdlap    || inv.tdlap    || '';
  // MCCQT (Mã của cơ quan thuế) = field `mhdon` trong JSON detail (HĐ có mã thì có giá trị,
  // HĐ không mã thì null → không hiện dòng). Fallback _xmlMccqt nếu có XML. KHÔNG dùng
  // mtdtchieu (đó là mã tra cứu, khác MCCQT).
  const mccqt    = d._xmlMccqt || d.mhdon || '';

  const nbten    = d.nbten    || inv.nbten    || '';
  const nbmst    = d.nbmst    || inv.nbmst    || '';
  const nbmaCh   = d.chma || d.nbmcuahang || d.nbmch || d.nbmchhang || '';
  const nbtenCh  = d.chten || d.nbtencuahang || d.nbtch || d.nbtchhang || '';
  const nbdchi   = d.nbdchi   || '';
  const nbdt     = d.nbsdthoai || d.nbdt      || '';
  const nbstk    = d.nbstkhoan || '';
  const nbnh     = d.nbtnhang  || '';
  const signerSubject = signerCommonName(cksInfo?.Subject || cksInfo?.X509SubjectName) || nbten || '';
  const qrSvg = qrSvgFromText(invoiceQrText(d, inv), 80);

  const nmten    = d.nmten    || d.nmtnmua || inv.nmten    || '';
  const nmHoTen  = d.nmhoten || d.nmhvt || d.nmtennguoimua || '';
  const nmmst    = d.nmmst    || inv.nmmst    || '';
  const nmDvcq   = d.nmdvcqhvnsnn || d.nmdvcq || d.madvcqhvnsnn || '';
  const nmCccd   = d.nmcccd || d.nmcmnd || d.nmshcccd || '';
  const nmHoChieu = d.nmhochieu || d.nmshochieu || d.nmshchieu || '';
  const nmdchi   = d.nmdchi   || '';
  const nmstk    = d.nmstkhoan || '';
  const soBangKe = d.sobke || d.sbke || '';
  const ngayBangKe = d.ngaybke || d.nbke || '';
  const httoanText = String(d.thtttoan || '');
  const httoanCode = Number(d.htttoan);
  const httoan     = httoanText || (!isNaN(httoanCode) && httoanMap[httoanCode]) || '';

  const tgtcthue  = d.tgtcthue  || inv.tgtcthue  || 0;
  const tgtthue   = d.tgtthue   || inv.tgtthue   || 0;
  const tgtttbso  = d.tgtttbso  || inv.tgtttbso  || 0;
  const tgtttbchu = d.tgtttbchu || inv.tgtttbchu || '';
  const tgtphi    = d.tgtphi    || 0;
  const tgtcktm   = d.ttcktmai ?? d.tgtcktm ?? d.tgtck ?? inv.tgtck ?? 0;
  const tgtkcthue = d.tgtkcthue ?? 0;
  const tgtkhac   = d.tgtkhac ?? 0;

  // Loại hóa đơn (cấp hóa đơn): 1=gốc, 2=thay thế, 3=điều chỉnh
  const tchatHd   = Number(d.tchat ?? inv.tchat ?? 1);
  const isReplace = tchatHd === 2;
  const isAdjust  = tchatHd === 3;
  // Tham chiếu hóa đơn gốc (chỉ có ở HĐ thay thế/điều chỉnh)
  const khmshdgoc = d.khmshdgoc || '';
  const khhdgoc   = d.khhdgoc || '';
  const shdgoc    = d.shdgoc != null ? d.shdgoc : '';
  const tdlhdgoc  = d.tdlhdgoc || '';

  // Dấu +/− cho HĐ điều chỉnh: ô >0 thêm '+', <0 giữ '-' (data có sẵn), =0 để nguyên
  const fmtSigned = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (isNaN(num)) return fmtNum(n);
    return (isAdjust && num > 0) ? '+' + fmtNum(num) : fmtNum(num);
  };
  // Ngày dạng dd/mm/yyyy (cho dòng "thay thế/điều chỉnh cho..."), quy về ngày VN qua src/vn-date.js
  const fmtDateDMY = (s) => {
    if (!s) return '';
    s = String(s);
    let day, month, year;
    if (s.includes('/')) { [day, month, year] = s.split('/'); }
    else if (s.includes('-')) {
      const dateStr = vnDate.isoDay(s);
      if (!dateStr) return '';
      [year, month, day] = dateStr.split('-');
    } else return s;
    return `${day}/${month}/${year}`;
  };

  const items = (d.hdhhdvu || d.hhonDs || d.hhdvu || []).filter(Boolean);
  const tchatMap = { '1': 'H&agrave;ng h&oacute;a, d&#7883;ch v&#7909;', '2': 'Khuy&#7871;n m&#7841;i', '3': 'Chi&#7871;t kh&#7845;u th&#432;&#417;ng m&#7841;i', '4': 'Ghi ch&uacute;, di&#7877;n gi&#7843;i', '5': 'H&agrave;ng h&oacute;a &#273;&#7863;c tr&#432;ng' };

  // Cột "Loại hàng hóa đặc trưng" (vd HĐ vận tải): từ item.tthhdtrung[]
  const dacTrungTypeMap = { '2': 'D&#7883;ch v&#7909; v&#7853;n chuy&#7875;n' };
  const dacTrungFieldMap = { bksptvchuyen: 'BKS ph&#432;&#417;ng ti&#7879;n v&#7853;n chuy&#7875;n' };
  const dacTrungCell = (item) => {
    const arr = Array.isArray(item.tthhdtrung) ? item.tthhdtrung : [];
    if (!arr.length) return '';
    const head = dacTrungTypeMap[String(arr[0].lhhdtrung)] || '';
    const lines = arr.map(t => `${dacTrungFieldMap[String(t.ttruong || '').toLowerCase()] || esc(String(t.ttruong || ''))} : ${esc(String(t.dlieu || ''))}`).join('<br>');
    return (head ? `${head}<br>` : '') + `<span>${lines}</span>`;
  };

  let sttCounter = 0;
  const itemRows = items.map((item, i) => {
    // Tính chất: lấy đúng theo data; thiếu thì để trống (giống thuế), KHÔNG mặc định '1'
    const chat = item.tchat != null && item.tchat !== '' ? String(item.tchat) : '';
    // STT: đánh số thứ tự chạy (1,2,3...), BỎ QUA dòng "Ghi chú, diễn giải" (tchat=4 → trống).
    // KHÔNG dùng item.stt vì một số NCC điền ID nội bộ (vd 2288) thay vì số thứ tự.
    const sttCell = chat === '4' ? '' : String(++sttCounter);
    return `<tr>
      <td class="tx-center">${sttCell}</td>
      <td class="tx-left"><span>${chat ? (tchatMap[chat] || esc(chat)) : ''}</span></td>
      <td class="tx-left" style="max-width:200px;word-wrap:break-word">${dacTrungCell(item)}</td>
      <td class="tx-left">${esc(itemName(item))}</td>
      <td class="tx-left">${esc(item.dvtinh || '')}</td>
      <td class="tx-center">${fmtSigned(itemQuantity(item))}</td>
      <td class="tx-center">${fmtSigned(itemUnitPrice(item))}</td>
      <td class="tx-center">${item.stckhau != null ? fmtSigned(item.stckhau) : ''}</td>
      <td class="tx-center">${esc(item.ltsuat || '')}</td>
      <td class="tx-center">${fmtSigned(itemAmount(item))}</td>
    </tr>`;
  }).join('');

  // Bảng thuế suất: render đúng theo thttltsuat. Nếu data rỗng → KHÔNG tạo dòng (chỉ còn
  // header trống), giống cách trang thuế render HĐ thiếu bảng thuế. KHÔNG tự chế dòng fallback.
  const taxEntries = d.thttltsuat || [];
  const taxRows = taxEntries.map(t => `<tr>
      <td class="tx-center">${esc(t.tsuat || '')}</td>
      <td class="tx-center">${fmtSigned(t.thtien)}</td>
      <td class="tx-center">${fmtSigned(t.tthue)}</td>
    </tr>`).join('');

  const dataItemContent = (label, val, style = '') => `<div class="data-item"${style ? ` style="${style}"` : ''}><div class="di-label"><span>${label}:</span></div><div class="di-value"><div>${val}</div></div></div>`;
  const dataItem = (label, val) => `<li>${dataItemContent(label, val)}</li>`;

  // Dòng "Thay thế/Điều chỉnh cho..." (chỉ HĐ tchat 2/3)
  const refLabel = isReplace ? 'Thay th&#7871;' : (isAdjust ? '&#272;i&#7873;u ch&#7881;nh' : '');
  const refLineHtml = (refLabel && (khhdgoc || shdgoc !== ''))
    ? `<div class="mg-bottom"><span>${refLabel} cho k&yacute; hi&#7879;u m&#7851;u s&#7889; h&oacute;a &#273;&#417;n </span><b>${esc(String(khmshdgoc))}</b>, k&yacute; hi&#7879;u h&oacute;a &#273;&#417;n <b>${esc(String(khhdgoc))}</b>, s&#7889; h&oacute;a &#273;&#417;n <b>${esc(String(shdgoc))}</b>, ng&agrave;y l&#7853;p <b>${fmtDateDMY(tdlhdgoc)}</b></div>`
    : '';

  // Bảng tổng: 2 dòng giảm trừ chỉ hiện ở HĐ điều chỉnh (giống trang thuế)
  const totalRow = (label, val) => `<tr><td class="tx-center">${label}</td><td class="tx-center" style="min-width:200px;max-width:300px">${val}</td></tr>`;
  const giamTruKCTRow  = isAdjust ? totalRow('T&#7893;ng gi&#7843;m tr&#7915; kh&ocirc;ng ch&#7883;u thu&#7871;', fmtSigned(tgtkcthue)) : '';
  const giamTruKhacRow = isAdjust ? totalRow('T&#7893;ng gi&#7843;m tr&#7915; kh&aacute;c', fmtSigned(tgtkhac)) : '';

  return `<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>H&oacute;a &#273;&#417;n ${esc(String(khhdon))}-${esc(String(shdon))}</title>
<style>
*{box-sizing:border-box;-moz-box-sizing:border-box}
html{font-size:100%}
body{width:100%;min-height:100%;margin:0 auto;padding:0;font-size:13pt;font-family:"Times New Roman",serif;background:#fff}
.print-page{width:100%;max-width:210mm;min-height:297mm;margin:0 auto;background:#fff}
.main-page{width:100%;max-width:210mm;padding:20px;margin:auto;background-image:url("${invoiceBgUrl}");background-repeat:no-repeat;background-position:center center;background-size:180%;border:3px double rgba(145,87,21,.69);line-height:1.5;box-shadow:0 0 9px 2px rgba(222,226,230,.7)}
.heading-content .main-title{font-size:20pt;text-align:center;display:block;font-weight:bold;text-transform:uppercase}
.heading-content p{font-size:13pt;text-align:right}
.heading-content p.day{text-align:center;display:block}
.heading-content .top-content{display:flex;justify-content:space-between}
.heading-content .code-content{display:inline-block}
.heading-content .code-ms{display:flex;font-size:12pt}
.day{font-size:13pt;text-align:center;display:block}
.day .mg-bottom{margin-bottom:8px!important;text-align:center}
.vip-divide{width:100%;height:0;border-bottom:1px solid rgba(145,87,21,.69)}
.flex-li{display:flex}
.content-info{padding-top:5px}
.content-info .list-fill-out{list-style:none;padding-inline-start:0;margin-top:5px;margin-bottom:5px}
.content-info .list-fill-out li{font-size:13pt}
.content-info .tx-money{text-align:right}
.content-info .square-list{display:flex;flex-wrap:wrap;align-items:center;padding:10px 0}
.content-info .square-list ul{display:flex;flex-wrap:wrap;padding-left:25px}
.content-info .square-list ul li{width:35px;height:35px;display:block;border-left:1px solid #000;border-top:1px solid #000;border-bottom:1px solid #000}
.content-info .square-list ul li:last-child{border-right:1px solid #000}
.table-horizontal-wrapper{display:flex;justify-content:space-between}
.res-tb{border-collapse:collapse;border-spacing:0;width:100%;overflow-x:auto;margin:10px 0;min-width:250px}
.res-tb tr td{border:1px solid #000;padding:6px 4px;vertical-align:baseline}
.res-tb tr td.tx-center{text-align:center}
.res-tb tr td.tx-left{text-align:left}
.res-tb tr td.tx-right{text-align:right}
.res-tb thead tr th{border:1px solid #000;vertical-align:middle;text-align:center;padding:6px 4px}
.res-tb thead tr th.tb-stt{width:70px;text-align:center}
.res-tb thead tr th.tb-thh{width:200px;text-align:center}
.res-tb thead tr th.tb-dvt{width:100px;text-align:center}
.res-tb thead tr th.tb-sl{width:80px;text-align:center}
.res-tb thead tr th.tb-dg{width:80px;text-align:center}
.res-tb thead tr th.tb-ts{width:80px;text-align:center}
.res-tb thead tr th.tb-ttct{width:250px;text-align:center}
.ft-sign{padding-top:20px}
.ft-sign .sign-dx{display:flex;flex-wrap:wrap;justify-content:space-around;align-items:flex-start}
.ft-sign .sign-dx h3 p{text-align:center;font-size:13pt;font-weight:100}
.ft-sign .sign-dx h3 p:nth-child(2){font-size:14px;font-weight:normal}
.ft-sign .fd-end{padding-top:120px;text-align:center}
.sign-box{width:260px!important;padding:5px!important;border:2px solid #23b709!important;background-image:url("${signCheckUrl}")!important;background-repeat:no-repeat!important;background-position:right 45px bottom 10px!important;background-size:70px 60px!important;margin-top:10px!important;font-weight:500;text-align:left!important}
.span-sign-box{display:inline!important}
.sign-box span{color:#23b709!important;font-size:13pt!important;text-align:left!important;display:block}
.data-item-auto-w{display:flex;justify-content:left;align-items:flex-start;font-size:13pt;color:#000}
.data-item-auto-w .di-label{min-height:25px;height:auto;border-bottom:1px dashed transparent;display:flex;align-items:flex-start}
.data-item-auto-w .di-value{box-sizing:border-box;flex:1;min-height:25px;height:auto;border-bottom:1px dashed #e8e8e8;display:flex;align-items:flex-start;padding-left:10px;justify-content:flex-start}
.data-item{width:100%;display:flex;justify-content:left;align-items:flex-start;font-size:13pt;color:#000;margin-bottom:10px}
.data-item .di-label{min-height:25px;height:auto;border-bottom:1px dashed transparent;display:flex;align-items:flex-start}
.data-item .di-value{box-sizing:border-box;flex:1;min-height:25px;height:auto;border-bottom:1px dashed #e8e8e8;display:flex;align-items:flex-start;padding-left:10px;justify-content:flex-start}
@page{size:A4;margin:0!important}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{width:auto;height:auto;margin:0 auto}table,tr,td{page-break-inside:avoid}table thead{display:table-row-group!important}.table-horizontal-wrapper{page-break-inside:avoid;padding-top:5px}.main-page{margin:0;width:initial;min-height:296mm;background:none;border:none}.ft-sign{page-break-inside:avoid!important;page-break-after:auto}.fd-end{padding-top:0!important}.sign-box{line-height:1.2!important}}
</style>
</head>
<body>
<div class="print-page">
<div class="main-page">
  <div class="heading-content">
    <div class="top-content">
      <div style="width:80px;min-height:20px"><div id="qrcodeTable">${qrSvg}</div></div>
      <div class="code-content">
        <b>M&#7851;u s&#7889;: ${esc(String(khmshdon))}</b><br>
        <b>K&yacute; hi&#7879;u: ${esc(String(khhdon))}</b><br>
        <b>S&#7889;: ${esc(String(shdon))}</b>
      </div>
    </div>
    <div class="title-heading">
      <h2 class="main-title">${invoiceTitle}</h2>
      <p class="day"><div class="day">${refLineHtml}<p class="day">${fmtDate(tdlap)}</p>${mccqt ? `<p class="day">MCCQT: ${esc(String(mccqt))}</p>` : ''}</div></p>
    </div>
  </div>
  <div class="vip-divide"></div>
  <div class="content-info">
    <ul class="list-fill-out">
      ${dataItem('T&ecirc;n ng&#432;&#7901;i b&aacute;n', esc(nbten))}
      ${dataItem('M&atilde; s&#7889; thu&#7871;', esc(nbmst))}
      ${dataItem('M&atilde; c&#7917;a h&agrave;ng', esc(nbmaCh))}
      ${dataItem('T&ecirc;n c&#7917;a h&agrave;ng', esc(nbtenCh))}
      ${dataItem('&#272;&#7883;a ch&#7881;', esc(nbdchi))}
      ${dataItem('&#272;i&#7879;n tho&#7841;i', esc(nbdt))}
      ${dataItem('S&#7889; t&agrave;i kho&#7843;n', esc(nbstk) + (nbnh ? ' &nbsp;&nbsp;&nbsp; ' + esc(nbnh) : ''))}
      <li><div class="vip-divide" style="margin:5px 0"></div></li>
      ${dataItem('T&ecirc;n ng&#432;&#7901;i mua', esc(nmten))}
      ${dataItem('H&#7885; t&ecirc;n ng&#432;&#7901;i mua', esc(nmHoTen))}
      ${dataItem('M&atilde; s&#7889; thu&#7871;', esc(nmmst))}
      ${dataItem('M&atilde; &#272;VCQHVNSNN', esc(nmDvcq))}
      ${dataItem('CCCD ng&#432;&#7901;i mua', esc(nmCccd))}
      ${dataItem('S&#7889; h&#7897; chi&#7871;u', esc(nmHoChieu))}
      ${dataItem('&#272;&#7883;a ch&#7881;', esc(nmdchi))}
      ${dataItem('S&#7889; t&agrave;i kho&#7843;n', esc(nmstk))}
      ${dataItem('H&igrave;nh th&#7913;c thanh to&aacute;n', esc(httoan))}
      <li class="flex-li">
        ${dataItemContent('S&#7889; b&#7843;ng k&ecirc;', esc(soBangKe), 'width:50%')}
        ${dataItemContent('Ng&agrave;y b&#7843;ng k&ecirc;', esc(ngayBangKe), 'width:50%')}
      </li>
    </ul>
    <table class="res-tb">
      <thead style="text-align:center"><tr>
        <th class="tb-stt">STT</th>
        <th class="tb-stt">T&iacute;nh ch&#7845;t</th>
        <th class="tb-stt">Lo&#7841;i h&agrave;ng ho&aacute; &#273;&#7863;c tr&#432;ng</th>
        <th class="tb-thh">T&ecirc;n h&agrave;ng h&oacute;a, d&#7883;ch v&#7909;</th>
        <th class="tb-dvt">&#272;&#417;n v&#7883; t&iacute;nh</th>
        <th class="tb-sl">S&#7889; l&#432;&#7907;ng</th>
        <th class="tb-dg">&#272;&#417;n gi&aacute;</th>
        <th class="tb-dg">Chi&#7871;t kh&#7845;u</th>
        <th class="tb-ts">Thu&#7871; su&#7845;t</th>
        <th class="tb-ttct">Th&agrave;nh ti&#7873;n ch&#432;a c&oacute; thu&#7871; GTGT</th>
      </tr></thead>
      <tbody>${itemRows || '<tr><td colspan="10" class="tx-center">&mdash;</td></tr>'}</tbody>
    </table>
    <div class="table-horizontal-wrapper">
      <div style="margin-right:10px">
        <table class="res-tb">
          <thead style="text-align:center"><tr>
            <th>Thu&#7871; su&#7845;t</th>
            <th>T&#7893;ng ti&#7873;n ch&#432;a thu&#7871;</th>
            <th>T&#7893;ng ti&#7873;n thu&#7871;</th>
          </tr></thead>
          <tbody>${taxRows}</tbody>
        </table>
      </div>
      <div style="flex:1">
        <table class="res-tb">
          <tbody>
            ${totalRow('T&#7893;ng ti&#7873;n ch&#432;a thu&#7871;<br>(T&#7893;ng c&#7897;ng th&agrave;nh ti&#7873;n ch&#432;a c&oacute; thu&#7871;)', fmtSigned(tgtcthue))}
            ${giamTruKCTRow}
            ${totalRow('T&#7893;ng ti&#7873;n thu&#7871; (T&#7893;ng c&#7897;ng ti&#7873;n thu&#7871;)', fmtSigned(tgtthue))}
            ${totalRow('T&#7893;ng ti&#7873;n ph&iacute;', fmtSigned(tgtphi))}
            ${totalRow('T&#7893;ng ti&#7873;n chi&#7871;t kh&#7845;u th&#432;&#417;ng m&#7841;i', fmtSigned(tgtcktm))}
            ${giamTruKhacRow}
            ${totalRow('T&#7893;ng ti&#7873;n thanh to&aacute;n b&#7857;ng s&#7889;', fmtSigned(tgtttbso))}
            ${totalRow('T&#7893;ng ti&#7873;n thanh to&aacute;n b&#7857;ng ch&#7919;', esc(tgtttbchu))}
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="vip-divide"></div>
  <div class="ft-sign">
    <div class="sign-dx">
      <h3>
        <p>NG&#431;&#7900;I MUA H&Agrave;NG</p>
        <p><i>(Ch&#7919; k&yacute; s&#7889; (n&#7871;u c&oacute;))</i></p>
        <td></td>
      </h3>
      <h3>
        <p>NG&#431;&#7900;I B&Aacute;N H&Agrave;NG</p>
        <p><i>(Ch&#7919; k&yacute; &#273;i&#7879;n t&#7917;, ch&#7919; k&yacute; s&#7889;)</i></p>
        ${cksInfo ? `<div class="sign-box"><span>Signature Valid</span><span class="span-sign-box">K&yacute; b&#7903;i&nbsp;</span><span id="cks" class="span-sign-box">${esc(signerSubject)}</span><span></span>${signingTime ? `<span class="span-sign-box">K&yacute; ng&agrave;y:&nbsp;</span><span class="span-sign-box">${esc(signingTime)}</span>` : ''}</div>` : '<td></td>'}
      </h3>
    </div>
    <div class="fd-end"><p><i>(C&#7847;n ki&#7875;m tra, &#273;&#7889;i chi&#7871;u khi l&#7853;p, nh&#7853;n h&oacute;a &#273;&#417;n)</i></p></div>
  </div>
</div>
<input type="hidden" id="qrcodeContent" value="">
</div>
</body>
</html>`;
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (!isBlankValue(value)) return value;
  }
  return '';
}


// Ảnh template nhúng thẳng dạng data: URL để file HTML tự chứa: copy đi đâu, mở bằng trình duyệt nào
// cũng hiển đúng (nếu thiếu ảnh thì HTML vẫn dựng được, chỉ không có nền/dấu chữ ký).
let templateAssets = null;
function loadTemplateAssets() {
  if (templateAssets) return templateAssets;
  const read = (file, mime) => {
    try { return `data:${mime};base64,${fs.readFileSync(path.join(__dirname, 'template', file)).toString('base64')}`; }
    catch { return ''; }
  };
  templateAssets = { invoiceBg: read('viewinvoice-bg.jpg', 'image/jpeg'), signCheck: read('sign-check.jpg', 'image/jpeg') };
  return templateAssets;
}
// Trả về nguyên trang HTML hóa đơn (self-contained) để ghi ra file .html hoặc in ra .pdf.
function invoiceHtml(inv, detail) {
  return buildInvoiceHtml(inv || {}, detail || {}, loadTemplateAssets());
}
module.exports = { invoiceHtml, buildInvoiceHtml, extractXmlFields, withXmlFields };