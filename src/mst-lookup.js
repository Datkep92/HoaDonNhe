'use strict';
/**
 * CN Tax Tools — Phân hệ Tra cứu Mã Số Thuế hàng loạt.
 *
 * Cổng tra cứu (tracuuhoadon.gdt.gov.vn) KHÔNG có API token như hoadondientu:
 * nó chỉ nhận phiên cookie của chính nó + ảnh CAPTCHA. Vì vậy mọi lời gọi ở đây
 * đều chạy qua CDP trong tab trình duyệt của MST (TaxBrowser.requestWithCredentials),
 * để cookie phiên do trình duyệt giữ — không dựng lại phiên thủ công.
 *
 * Luồng: lấy CAPTCHA → giải bằng ONNX (captcha-solver) → validate → tra từng MST
 * theo nhịp pace.wait() → trả về mảng kết quả để UI hiển thị / xuất Excel.
 */
const fs = require('node:fs');
const path = require('node:path');
const pace = require('./pace');
const captchaSolver = require('./captcha-solver');

const HOST = 'https://tracuuhoadon.gdt.gov.vn';

function portalJson(res) {
  const stop = (message, code = '') => { const error = new Error(message); error.portal = true; error.code = code; throw error; };
  if (!res || res.status !== 200) stop(`Cổng tra cứu không trả dữ liệu (HTTP ${res?.status || 'không phản hồi'}). Thử lại sau và lấy CAPTCHA mới.`);
  const text = String(res.text || '').trim();
  if (/^</.test(text)) stop('Cổng tra cứu trả HTML thay vì JSON cho yêu cầu này; chưa xác định được thông tin MST. Thử lại sau với CAPTCHA mới.', 'PORTAL_HTML');
  let data;
  try { data = JSON.parse(text); } catch { stop('Cổng tra cứu trả dữ liệu JSON không hợp lệ. Lấy CAPTCHA mới và thử lại sau.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) stop('Cổng tra cứu trả dữ liệu không đúng cấu trúc.');
  return data;
}

function taxOfficeName(value) {
  const raw = String(value || '').trim();
  // Legacy portal encodes [area F] office F year F month F day.
  // Only decode a complete dated suffix; an ordinary F in a name is kept.
  const encoded = raw.match(/^(.*?)F\d{4}F\d{1,2}F\d{1,2}$/);
  return encoded ? encoded[1].split('F').filter(Boolean).at(-1)?.trim() || raw : raw;
}

class MstLookupController {
  /**
   * @param {object} deps
   * @param {import('./browser').TaxBrowser} deps.browser  phiên Chrome của MST
   * @param {string} deps.mst   MST đang tra cứu (dùng cho thông báo lỗi/log)
   * @param {(msg:string, kind?:string)=>void} [deps.log]
   * @param {(p:object)=>void} [deps.onProgress]
   */
  constructor({ browser, mst, log, onProgress } = {}) {
    if (!browser) throw new Error('Tra cứu MST cần phiên trình duyệt (chưa mở Chrome).');
    this.browser = browser;
    this.mst = mst || '';
    this.log = typeof log === 'function' ? log : () => {};
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.shouldStop = false;
    this.currentCaptchaKey = '';
    this.currentUser = '';
  }

  /** Lấy ảnh CAPTCHA + giải. Trả { dataUrl, solvedText } hoặc ném lỗi. */
  async loadCaptcha() {
    const res = await this.browser.fetchSameOrigin(`${HOST}/Captcha.jpg?_t=${Date.now()}`, { method: 'GET' });
    if (!res || res.status !== 200 || !res.body || res.body.length < 100) {
      throw new Error(`Không tải được CAPTCHA (HTTP ${res ? res.status : 'không phản hồi'}).`);
    }
    if (/^\s*</.test(res.body.toString('utf8', 0, 100))) throw new Error('Cổng tra cứu trả HTML thay vì ảnh CAPTCHA. Thử lại sau.');
    const dataUrl = `data:image/jpeg;base64,${res.body.toString('base64')}`;
    let solvedText = '';
    try {
      solvedText = (await captchaSolver.solve(dataUrl, HOST)) || '';
    } catch (error) {
      // Giải hỏng KHÔNG được làm hỏng cả luồng — người dùng gõ tay được.
      this.log(`Bộ giải CAPTCHA không chạy được: ${error.message}`, 'warn');
    }
    const solverError = solvedText ? '' : captchaSolver.lastErrorMessage();
    return { dataUrl, solvedText, solverError };
  }

  /** Kiểm tra mã CAPTCHA có đúng không (nếu cổng trả lỗi sai mã thì báo ngay). */
  async validateCaptcha(code) {
    const res = await this.browser.fetchSameOrigin(`${HOST}/validcode.html`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `captchaCode=${encodeURIComponent(code)}`,
    });
    const data = portalJson(res);
    const message = String(data.strMess || data.message || '');
    if (/sai|mã xác thực không đúng/i.test(message)) {
      throw new Error('Mã CAPTCHA không đúng hoặc đã hết hạn. Bấm 🔄 để lấy mã mới.');
    }
    return true;
  }

  /** Tra cứu một MST. Luôn trả về một dòng kết quả (lỗi cũng thành dòng). */
  async queryOne(mst, captchaCode) {
    try {
      const res = await this.browser.fetchSameOrigin(
        `${HOST}/gettin.html?tin=${encodeURIComponent(mst)}&captchaCode=${encodeURIComponent(captchaCode)}`,
        {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        },
      );
      const data = portalJson(res);
      const model = data && data.tinModel;
      if (!model) {
        const msg = String((data && (data.strMess || data.message)) || '');
        // Cổng báo sai CAPTCHA bằng thông báo chứ không phải thiếu tin — phân biệt để báo đúng.
        if (/sai|hết hạn|không đúng/i.test(msg) && /captcha|mã|xác thực/i.test(msg)) throw new Error('CAPTCHA sai hoặc hết hạn — hãy lấy mã mới rồi thử lại.');
        if ((!Object.hasOwn(data, 'tinModel') || msg) && !/không tìm thấy|không tồn tại|không có thông tin/i.test(msg)) {
          const error = new Error('Cổng tra cứu trả dữ liệu không đúng cấu trúc tinModel. Không thể kết luận MST không tồn tại.');
          error.portal = true;
          throw error;
        }
        return { mst, found: false, ten: '', tThai: 'Không tìm thấy thông tin người nộp thuế', cThue: '', dChi: '' };
      }
      if (typeof model !== 'object' || !model.tin || !model.norm_name || String(model.tin).trim() !== String(mst).trim()) {
        const error = new Error('Dữ liệu cổng trả về thiếu MST/tên hoặc không khớp MST yêu cầu.');
        error.portal = true;
        throw error;
      }
      const cqt = taxOfficeName(model.pay_taxo_name);
      return {
        mst: String(model.tin || mst),
        found: true,
        ten: String(model.norm_name || ''),
        tThai: String(model.statusName || 'Cổng không cung cấp trạng thái'),
        statusUnknown: !model.statusName,
        cThue: cqt,
        cThueRaw: String(model.pay_taxo_name || ''),
        dChi: String(model.tran_addr || ''),
      };
    } catch (error) {
      return { mst, found: false, ten: '', tThai: `Lỗi: ${error.message}`, cThue: '', dChi: '', error: error.message, portalError: !!error.portal, errorCode: error.code || '' };
    }
  }

  /**
   * Tra cứu cả danh sách. Chạy nền, có thể dừng bằng this.shouldStop = true.
   * @returns {Promise<Array>} mảng dòng kết quả
   */
  async search(mstList, captchaCode) {
    await this.validateCaptcha(captchaCode);
    const rows = [];
    const total = mstList.length;
    let consecutiveHtml = 0;
    this.onProgress({ stage: 'start', total, done: 0, message: `Bắt đầu tra cứu ${total} MST…` });

    for (let i = 0; i < total; i += 1) {
      if (this.shouldStop) {
        this.onProgress({ stage: 'stopped', done: rows.length, total, message: `Đã dừng sau ${rows.length}/${total} MST.` });
        break;
      }
      const mst = mstList[i];
      this.onProgress({ stage: 'query', current: i + 1, total, mst, message: `Đang tra cứu ${mst} (${i + 1}/${total})…` });

      const row = await this.queryOne(mst, captchaCode);
      rows.push(row);
      this.onProgress({ stage: 'progress', done: rows.length, total, row, rows: [...rows] });
      consecutiveHtml = row.errorCode === 'PORTAL_HTML' ? consecutiveHtml + 1 : 0;
      if (consecutiveHtml >= 2) throw new Error('Cổng trả HTML cho hai MST liên tiếp. Đã dừng và giữ kết quả; lấy CAPTCHA mới rồi thử lại sau.');
      if ((row.portalError && row.errorCode !== 'PORTAL_HTML') || (row.error && row.errorCode !== 'PORTAL_HTML' && /CAPTCHA|mã xác thực/i.test(row.error))) throw new Error(row.error);

      // Nghỉ giữa các lượt — cổng giới hạn nhịp, dội liên tục sẽ bị chặn.
      if (i < total - 1) await pace.wait();
    }
    return rows;
  }

  /** Ghi kết quả ra file Excel (SheetJS đóng gói sẵn trong resources/). */
  static writeExcel(rows, target) {
    const XLSX = require('../resources/xlsx.cjs');
    const HEADERS = ['STT', 'Mã Số Thuế', 'Tên Doanh Nghiệp / NNT', 'Trạng Thái', 'Cơ Quan Thuế Quản Lý', 'Địa Chỉ Trụ Sở'];
    const data = rows.map((r, i) => ({
      'STT': i + 1,
      'Mã Số Thuế': r.mst || '',
      'Tên Doanh Nghiệp / NNT': r.ten || '',
      'Trạng Thái': r.tThai || '',
      'Cơ Quan Thuế Quản Lý': r.cThue || '',
      'Địa Chỉ Trụ Sở': r.dChi || '',
    }));
    const sheet = XLSX.utils.json_to_sheet(data, { header: HEADERS });
    sheet['!cols'] = [7, 16, 42, 34, 26, 42].map(wch => ({ wch }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'TrangThaiMST');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    return target;
  }
}

module.exports = { MstLookupController, HOST };
