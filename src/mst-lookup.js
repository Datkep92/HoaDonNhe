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
    const dataUrl = `data:image/jpeg;base64,${res.body.toString('base64')}`;
    let solvedText = '';
    try {
      solvedText = (await captchaSolver.solve(dataUrl, HOST)) || '';
    } catch (error) {
      // Giải hỏng KHÔNG được làm hỏng cả luồng — người dùng gõ tay được.
      this.log(`Bộ giải CAPTCHA không chạy được: ${error.message}`, 'warn');
    }
    return { dataUrl, solvedText };
  }

  /** Kiểm tra mã CAPTCHA có đúng không (nếu cổng trả lỗi sai mã thì báo ngay). */
  async validateCaptcha(code) {
    const res = await this.browser.fetchSameOrigin(`${HOST}/validcode.html`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: `captchaCode=${encodeURIComponent(code)}`,
    });
    if (!res || res.status !== 200) return true; // không kiểm được thì cho qua, lỗi sẽ lộ ở lần tra đầu
    const message = String((res.text || '').match(/"strMess"\s*:\s*"([^"]*)"/)?.[1] || '');
    if (/sai mã xác thực|mã xác thực không đúng/i.test(message)) {
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
      if (!res || res.status !== 200) throw new Error(`HTTP ${res ? res.status : 'không phản hồi'}`);

      const data = JSON.parse(res.text || '{}');
      const model = data && data.tinModel;
      if (!model) {
        const msg = String((data && (data.strMess || data.message)) || '');
        // Cổng báo sai CAPTCHA bằng thông báo chứ không phải thiếu tin — phân biệt để báo đúng.
        if (/sai mã xác thực/i.test(msg)) throw new Error('CAPTCHA sai — hãy lấy mã mới rồi thử lại.');
        return { mst, found: false, ten: '', tThai: 'Không tìm thấy thông tin người nộp thuế', cThue: '', dChi: '' };
      }
      let cqt = String(model.pay_taxo_name || '');
      if (cqt.includes('F')) cqt = cqt.split('F')[0];
      return {
        mst: String(model.tin || mst),
        found: true,
        ten: String(model.norm_name || ''),
        tThai: String(model.statusName || 'Đang hoạt động (đã được cấp GCN ĐKT)'),
        cThue,
        dChi: String(model.tran_addr || ''),
      };
    } catch (error) {
      return { mst, found: false, ten: '', tThai: `Lỗi: ${error.message}`, cThue: '', dChi: '', error: error.message };
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
      this.onProgress({ stage: 'progress', done: rows.length, total, row });

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