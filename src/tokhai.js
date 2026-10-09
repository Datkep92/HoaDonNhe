'use strict';
/**
 * CN Tax Tools — Phân hệ Tờ khai thuế & Dịch vụ công (DVC / Thuế điện tử).
 *
 * Hai cổng, hai kiểu đăng nhập khác nhau:
 *   · DVC (dichvucong.gdt.gov.vn) — form loginLDAP, có CSRF token + CAPTCHA PNG.
 *     Đăng nhập được ngay trong tab bằng fetch, không cần thao tác chuột.
 *   · Thuế điện tử (thuedientu.gdt.gov.vn) — bảng State Machine dse_* (JSP cũ),
 *     phải đi đúng thứ tự form và giữ dse_sessionId; đăng nhập bằng cách điền
 *     form rồi submit trong tab đã mở.
 *
 * Mọi lời gọi chạy qua CDP (TaxBrowser) để dùng cookie phiên của trình duyệt.
 */
const fs = require('node:fs');
const path = require('node:path');
const pace = require('./pace');
const captchaSolver = require('./captcha-solver');
const JSZip = require('jszip');
const portalScripts = require('./tokhai-portal');

const DVC = 'https://dichvucong.gdt.gov.vn';
const TDT = 'https://thuedientu.gdt.gov.vn';

class TokhaiController {
  constructor({ browser, mst, log, onProgress } = {}) {
    if (!browser) throw new Error('Tờ khai cần phiên trình duyệt (chưa mở Chrome).');
    this.browser = browser;
    this.mst = mst || '';
    this.log = typeof log === 'function' ? log : () => {};
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.currentPortal = 'dvc';
    this.shouldStop = false;
    this.sessionId = '';
    this.userMst = '';
    this.userName = '';
  }

  // ---------------- CAPTCHA ----------------

  async loadCaptcha(purpose = 'login') {
    const isDvc = this.currentPortal === 'dvc';
    const csrfToken = isDvc && purpose !== 'search' ? await this.readDvcCsrf() : '';
    const loginCaptcha = isDvc ? '' : await this.prepareTdtLogin();
    const url = isDvc
      ? `${DVC}/tthc/${purpose === 'search' ? '' : 'login/'}getCaptcha?_t=${Date.now()}`
      : loginCaptcha || `${TDT}/etaxnnt/servlet/ImageServlet?d=${Date.now()}`;
    const res = await this.browser.fetchSameOrigin(url, { method: 'GET' });
    if (!res || res.status !== 200 || !res.body || res.body.length < 100) {
      throw new Error(`Không tải được CAPTCHA (HTTP ${res ? res.status : 'không phản hồi'}).`);
    }
    const head = res.body.subarray(0, 4);
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    const isGif = head[0] === 0x47 && head[1] === 0x49;
    if (!isPng && !isJpg && !isGif && !/<svg[\s>]/i.test(res.body.toString('utf8'))) {
      throw new Error('Cổng trả trang HTML thay cho ảnh CAPTCHA. Mở cổng và kiểm tra phiên đăng nhập.');
    }
    const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : 'image/svg+xml';
    const dataUrl = `data:${mime};base64,${res.body.toString('base64')}`;
    let solvedText = '';
    try {
      solvedText = (await captchaSolver.solve(dataUrl, isDvc ? DVC : TDT)) || '';
    } catch (error) {
      this.log(`Bộ giải CAPTCHA không chạy được: ${error.message}`, 'warn');
    }
    return { dataUrl, solvedText, csrfToken, solverError: solvedText ? '' : captchaSolver.lastErrorMessage() };
  }

  // ---------------- Đăng nhập DVC ----------------

  /** Đọc CSRF token từ trang login DVC (Cần cho mọi lời gọi loginLDAP). */
  async readDvcCsrf() {
    const tabId = await this.browser.tabForOrigin(DVC);
    const token = await this.browser.evalInTab(tabId, `(() => document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.content || document.querySelector('input[name="_csrf"]')?.value || '')()`);
    if (token) return token;
    const res = await this.browser.fetchSameOrigin(`${DVC}/tthc/login`, { method: 'GET' });
    const html = res && res.ok ? res.text : '';
    return (html.match(/name="csrf-token"\s+content="([^"]+)"/i) || html.match(/name="_csrf"\s+value="([^"]+)"/i) || [])[1] || '';
  }

  async loginDvc(username, password, captcha, csrfToken = '') {
    // Không tải lại trang login sau CAPTCHA: trang mới có thể đổi challenge.
    const tabId = await this.browser.tabForOrigin(DVC);
    const csrf = csrfToken || await this.browser.evalInTab(tabId, `(() => document.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.content || document.querySelector('input[name="_csrf"]')?.value || '')()`);
    // Cách gõ MST mà cổng chấp nhận: doanh nghiệp 10 số (-MST chi nhánh), cá nhân 12 số (CCCD).
    const candidates = [username];
    if (username.includes('-')) {
      const base = username.split('-')[0].trim();
      if (base && base !== username) candidates.push(base);
    }

    let lastError = '';
    for (const user of candidates) {
      const doiTuong = /^\d{12}$/.test(user) ? 'CN' : 'DN';
      const body = new URLSearchParams({
        tenDN: user,
        matKhau: Buffer.from(unescape(encodeURIComponent(password)), 'binary').toString('base64'),
        doiTuong,
        captcha,
      });
      if (csrf) body.append('_csrf', csrf);

      const res = await this.browser.fetchSameOrigin(`${DVC}/tthc/loginLDAP`, {
        method: 'POST',
        headers: {
          'X-XSRF-TOKEN': csrf || '',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: body.toString(),
      });
      if (!res || !res.ok) { lastError = `HTTP ${res ? res.status : 'không phản hồi'}`; continue; }
      let data = {};
      try { data = JSON.parse(res.text || '{}'); } catch (error) { lastError = 'Cổng trả dữ liệu không đọc được.'; continue; }
      const status = String(data.status || '');
      if (['200', '201'].includes(status)) {
        this.userMst = user;
        this.userName = data.name || data.tenNnt || 'Dịch Vụ Công Thuế';
        return { ok: true, portal: 'dvc', mst: user, name: this.userName };
      }
      lastError = String(data.desc || data.message || `Cổng trả status ${status || 'rỗng'}`);
      // Sai CAPTCHA thì thử lại cũng vô ích — báo ngay cho người dùng lấy mã mới.
      if (/captcha/i.test(lastError)) throw new Error(`CAPTCHA không đúng: ${lastError}`);
    }
    throw new Error(`Đăng nhập Dịch Vụ Công thất bại: ${lastError || 'không rõ nguyên nhân'}`);
  }

  // ---------------- Đăng nhập Thuế điện tử ----------------

  async prepareTdtLogin() {
    const tab = await this.browser.tabForOrigin(TDT);
    this.tdtLoginFields = await this.browser.evalInTab(tab, '(' + portalScripts.prepareTdtLoginInTab.toString() + ')(' + JSON.stringify(TDT) + ')', 90000);
    if (!this.tdtLoginFields?.dse_sessionId) throw new Error('Không lấy được phiên đăng nhập Thuế điện tử.');
    return '';
  }

  async loginTdt(username, password, captcha) {
    const fields = this.tdtLoginFields;
    if (!fields?.dse_sessionId) throw new Error('Lấy CAPTCHA Thuế điện tử mới trước khi đăng nhập.');
    const body = new URLSearchParams({
      dse_sessionId: fields.dse_sessionId, dse_applicationId: '-1', dse_pageId: fields.dse_pageId || '5',
      dse_operationName: 'corpUserLoginProc', dse_errorPage: 'error_page.jsp', dse_processorState: 'initial',
      dse_nextEventName: 'start', showVerifyCode: 'show', isEtaxtmdt: '',
      _userName: username, _password: password, login_type: '01', _verifyCode: captcha,
    });
    const res = await this.browser.fetchSameOrigin(TDT + '/etaxnnt/Request', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!res?.ok) throw new Error('Thuế điện tử trả HTTP ' + (res?.status || 0));
    if (/Mã xác thực không chính xác|Mã xác nhận không đúng|Sai tên đăng nhập|mật khẩu không đúng/i.test(res.text)) throw new Error('Sai tài khoản, mật khẩu hoặc CAPTCHA Thuế điện tử.');
    if (!/value=["']complete["']|corporateHomeProc|Đăng xuất/i.test(res.text)) throw new Error('Cổng chưa xác nhận đăng nhập Thuế điện tử thành công.');
    const sid = res.text.match(/name=["']dse_sessionId["'][^>]*value=["']([^"']+)["']/i)?.[1];
    this.sessionId = sid || fields.dse_sessionId;
    this.userMst = username;
    this.userName = 'Cổng Thuế Điện Tử';
    return { ok: true, portal: 'tdt', mst: username, name: this.userName, sessionId: this.sessionId };
  }

  // ---------------- Tra cứu DVC ----------------

  async searchDvc(tuNgay, denNgay, captcha) {
    const checked = await this.browser.fetchSameOrigin(`${DVC}/tthc/checkCaptcha?captcha=${encodeURIComponent(captcha)}&_=${Date.now()}`, { method: 'GET' });
    if (!checked?.ok || checked.text.trim() !== 'success') throw new Error('CAPTCHA tra cứu không đúng hoặc đã hết hạn. Lấy mã tra cứu mới.');
    const query = new URLSearchParams({
      maNghiepVu: '', maTTHC: '', maToKhai: '', maHoSo: '',
      tuNgay, denNgay, scope_tdt1: 'SELF', mstUyQuyen_tdt1: '', captcha, size: '1000',
    });
    const res = await this.browser.fetchSameOrigin(`${DVC}/tthc/ho-so/search?${query}`, {
      method: 'GET',
      headers: {
        'HX-Request': 'true',
        'HX-Target': 'table-container',
        'HX-Trigger': 'form-search-advanced',
        'HX-Current-URL': `${DVC}/tthc/tchs`,
        accept: 'text/html-partial',
      },
    });
    if (res && res.status === 403) throw new Error('Chưa đăng nhập Dịch Vụ Công hoặc phiên đã hết hạn. Bấm "Đăng nhập" lại.');
    if (!res || res.status !== 200) throw new Error(`Cổng DVC trả HTTP ${res ? res.status : 'không phản hồi'}.`);
    if (/Mã xác nhận (?:không đúng|không chính xác|sai)|captcha không đúng/i.test(res.text || '')) {
      throw new Error('CAPTCHA không đúng. Bấm 🔄 lấy mã mới rồi thử lại.');
    }
    if (/<input[^>]+(?:name|id)=["'](?:matKhau|_password)["']/i.test(res.text || '')) throw new Error('Phiên DVC đã hết hạn. Đăng nhập lại.');
    return parseDvcRows(res.text || '');
  }

  // ---------------- Tra cứu Thuế điện tử ----------------

  /** Cổng TĐT giới hạn 365 ngày/lượt nên tự chia nhỏ khoảng ngày. */
  static splitRange(tuNgay, denNgay) {
    const parse = s => {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(s)) throw new Error('Ngày không hợp lệ (dd/mm/yyyy).');
      const [d, m, y] = s.split('/').map(Number);
      const date = new Date(y, m - 1, d);
      if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) throw new Error('Ngày không tồn tại.');
      return date;
    };
    const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    const start = parse(tuNgay);
    const end = parse(denNgay);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Ngày không hợp lệ (định dạng dd/mm/yyyy).');
    if (start > end) throw new Error('Từ ngày không được lớn hơn Đến ngày.');
    const out = [];
    let cur = new Date(start);
    while (cur <= end) {
      const stop = new Date(cur);
      stop.setDate(stop.getDate() + 364);
      const last = stop > end ? end : stop;
      out.push({ from: fmt(cur), to: fmt(last) });
      cur = new Date(last);
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  async searchTdt(tuNgay, denNgay) {
    const ranges = TokhaiController.splitRange(tuNgay, denNgay);
    const tabs = await browserTabs(this.browser, 'thuedientu.gdt.gov.vn');
    if (!tabs.length) throw new Error('Chưa mở tab Thuế Điện Tử.');

    const rows = [];
    for (let i = 0; i < ranges.length; i += 1) {
      if (this.shouldStop) break;
      const range = ranges[i];
      this.onProgress({ stage: 'query', current: i + 1, total: ranges.length, message: `Đang tra cứu ${range.from} → ${range.to}…` });
      const out = await this.browser.evalInTab(tabs[0].id, '(' + portalScripts.searchTdtInTab.toString() + ')(' + JSON.stringify({ tuNgay: range.from, denNgay: range.to }) + ',' + JSON.stringify(TDT) + ',' + JSON.stringify(this.sessionId || '') + ')', 180000);
      if (!out || !out.success) throw new Error((out && out.error) || 'Tra cứu Thuế điện tử không trả dữ liệu.');
      rows.push(...(out.rows || []));
      if (i < ranges.length - 1) await pace.wait();
    }
    return [...new Map(rows.map(row => [row.maHoSo, row])).values()];
  }

  // ---------------- Tải hồ sơ ----------------

  /** Tải một mã hồ sơ. Trả Buffer thô (ZIP/XML) hoặc ném lỗi. */
  async downloadOne(maHoSo) {
    const base = this.currentPortal === 'tdt' ? TDT : DVC;
    const tab = await this.browser.tabForOrigin(base);
    const row = (this.results || []).find(row => row.maHoSo === maHoSo);
    const script = this.currentPortal === 'tdt' ? portalScripts.fetchFilesTdtInTab : portalScripts.fetchFilesDvcInTab;
    const args = this.currentPortal === 'tdt' ? [maHoSo, base, row?.ngayNop || '', this.sessionId || ''] : [maHoSo, base];
    const result = await this.browser.evalInTab(tab, '(' + script.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')', 180000);
    if (!result?.success) throw new Error(result?.error || 'Không tải được hồ sơ.');
    this.downloadWarnings = result.warnings || [];
    const documents = this.currentPortal === 'tdt' ? result.files || [] : [result.hoSo, ...(result.thongBaos || []), ...(result.taiLieus || [])].filter(Boolean);
    if (!documents.length) throw new Error('Hồ sơ không có tệp tải được hoặc phiên đã hết hạn.');
    return documents.map(doc => ({ filename: doc.filename, bytes: Buffer.from(doc.data, 'base64') }));
  }

  /** Tải cả danh sách, ghi vào thư mục. Kết quả { total, succeeded, failed, files }. */
  async bulkDownload(maHoSoList, { outputDir } = {}) {
    const files = [];
    let succeeded = 0;
    let failed = 0;
    const dir = outputDir || '';
    if (!dir) throw new Error('Chọn thư mục lưu trước khi tải tờ khai.');

    for (let i = 0; i < maHoSoList.length; i += 1) {
      if (this.shouldStop) { this.log(`Đã dừng sau ${succeeded}/${maHoSoList.length} hồ sơ.`, 'warn'); break; }
      const id = maHoSoList[i];
      this.onProgress({ stage: 'download', current: i + 1, total: maHoSoList.length, maHoSo: id, message: `Đang tải ${id} (${i + 1}/${maHoSoList.length})…` });
      try {
        const downloaded = await this.downloadOne(id);
        const documents = Buffer.isBuffer(downloaded) ? [{ filename: `${id}.zip`, bytes: downloaded }] : downloaded;
        if (dir) {
          if (!documents.length) throw new Error('Không có tệp hồ sơ.');
          const targets = [];
          const folder = path.join(dir, String(id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'));
          for (const { filename, bytes } of documents) {
            const name = safeFileName(filename, bytes);
            if (/\.zip$/i.test(name)) await JSZip.loadAsync(bytes);
            fs.mkdirSync(folder, { recursive: true });
            const target = path.join(folder, name);
            fs.writeFileSync(target, bytes);
            targets.push(target);
          }
          files.push({ maHoSo: id, path: targets[0], paths: targets, success: true, warnings: this.downloadWarnings || [] });
        }
        succeeded += 1;
      } catch (error) {
        failed += 1;
        files.push({ maHoSo: id, success: false, error: error.message });
        this.log(`Tải ${id} lỗi: ${error.message}`, 'error');
      }
      if (i < maHoSoList.length - 1) await pace.wait();
    }
    return { total: maHoSoList.length, succeeded, failed, files, stopped: this.shouldStop };
  }
}

// ---------------- helpers ----------------

async function browserTabs(browser, hostFragment) {
  const tabs = await browser.listTabs();
  return tabs.filter(t => t.type === 'page' && t.url && t.url.includes(hostFragment));
}

/** Đuôi file đúng theo nội dung: ZIP hay XML/HTML. */
function safeFileName(base, bytes) {
  base = String(base).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const head = bytes.subarray(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4b) return /\.(docx|xlsx)$/i.test(base) ? base : base.replace(/\.(zip|xml|html)$/i, '') + '.zip';
  const text = bytes.subarray(0, 200).toString('utf8');
  if (/^\s*%PDF-/.test(text)) return base.replace(/\.(zip|xml|html)$/i, '') + '.pdf';
  if (/<(?:!doctype\s+html|html|head|body|form)[\s>]/i.test(bytes.toString('utf8'))) throw new Error('Cổng trả trang HTML thay cho tệp tờ khai. Kiểm tra phiên đăng nhập.');
  if (/^\s*(?:\uFEFF)?\s*<\?xml\b|^\s*<(?:[\w.-]+:)?(?:HSoThueDTu|HSoKhaiThue|TKhaiThue|HDon)[\s>]/i.test(text)) return base.replace(/\.(zip|xml|html)$/i, '') + '.xml';
  if (bytes.length && /\.(?:docx?|xlsx?|csv|txt|rar|7z|png|jpe?g|bin)$/i.test(base)) return base;
  throw new Error('Nội dung tải về không phải tệp hồ sơ hợp lệ.');
}

/** Bảng DVC: cột cố định, nhưng bắt theo header để không vỡ khi cổng đổi bố cục. */
function parseDvcRows(html) {
  const alert = html.match(/<(?:div|span)[^>]*class=["'][^"']*(?:alert-danger|invalid-feedback)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i);
  if (alert && stripTags(alert[1])) throw new Error(decode(stripTags(alert[1])));
  const out = [];
  const fields = {
    maHoSo: ['mã hồ sơ', 'ma ho so'], toKhai: ['tờ khai', 'to khai', 'tên hồ sơ'],
    kyTinhThue: ['kỳ tính thuế', 'ky tinh thue', 'kỳ kê khai'], loaiToKhai: ['loại tờ khai', 'loai to khai', 'loại'],
    lanBoSung: ['lần bổ sung', 'lan bo sung', 'lần bs'], lanNop: ['lần nộp', 'lan nop'],
    ngayNop: ['ngày nộp', 'ngay nop'], trangThai: ['trạng thái', 'trang thai'],
  };
  const defaults = { maHoSo: 2, toKhai: 4, kyTinhThue: 5, loaiToKhai: 6, lanBoSung: 7, lanNop: 8, ngayNop: 10, trangThai: 11 };
  let headers = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html))) {
    const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => decode(stripTags(c[1])));
    if (cells.some(c => fields.maHoSo.includes(c.toLowerCase()))) {
      headers = cells.map(c => c.toLowerCase());
      continue;
    }
    if (cells.length < 6) continue;
    const row = {};
    for (const [key, names] of Object.entries(fields)) {
      let at = headers.findIndex(h => names.some(name => h === name || (name !== 'loại' && h.includes(name))));
      if (key === 'toKhai') at = headers.findIndex(h => /tờ khai|to khai|tên hồ sơ/.test(h) && !/loại/.test(h));
      if (at < 0 && !headers.length && cells.length >= 12) at = defaults[key];
      row[key] = at >= 0 ? cells[at] || '' : '';
    }
    const attribute = match[1].match(/data-ma-ho-so=["']([^"']+)["']/i)?.[1];
    if (attribute) row.maHoSo = decode(attribute);
    if (row.maHoSo && /\d/.test(row.maHoSo)) out.push(row);
  }
  if (!out.length && /<td\b/i.test(html) && !headers.length && !/không (?:có|tìm thấy)|no (?:data|records)/i.test(stripTags(html))) {
    throw new Error('Không nhận diện được cột mã hồ sơ trong bảng cổng thuế; cần kiểm tra bố cục bảng thực tế.');
  }
  return out;
}

/** Bảng TĐT trả về mảng ô; đọc theo vị trí vì bố cục cổng cũ không có header ổn định. */
function parseTdtRows(rows) {
  const cell = (t, i) => String((t && t[i]) || '').trim();
  return rows
    .map(t => ({
      maHoSo: cell(t, 0) || cell(t, 2),
      toKhai: cell(t, 2),
      kyTinhThue: cell(t, 3),
      loaiToKhai: cell(t, 4),
      lanBoSung: cell(t, 5),
      lanNop: cell(t, 6),
      ngayNop: cell(t, 7),
      trangThai: cell(t, 8),
    }))
    .filter(r => r.maHoSo && /\d/.test(r.maHoSo));
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decode(text) {
  return String(text)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

module.exports = { TokhaiController, DVC, TDT, parseDvcRows, safeFileName };
