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

  /** Script chạy trong tab TĐT để đọc mã hồ sơ + nội dung bảng kết quả. */
  static get TDT_SEARCH_SCRIPT() {
    return `(async (tuNgay, denNgay, base) => {
      const sid = new URLSearchParams(location.search).get('dse_sessionId')
        || (document.querySelector("input[name='dse_sessionId']") || {}).value || '';
      if (!sid) return { ok: false, error: 'Chưa đăng nhập Thuế điện tử (thiếu dse_sessionId).' };
      const form = document.createElement('form');
      form.method = 'GET'; form.style.display = 'none';
      for (const kv of [['dse_sessionId', sid], ['dse_applicationId', '-1'], ['dse_pageId', '5'],
        ['dse_operationName', 'searchDeclProc'], ['dse_nextEventName', 'search'],
        ['dse_processorState', 'initial'], ['dse_errorPage', 'error_page.jsp'],
        ['tuNgay', tuNgay], ['denNgay', denNgay]]) {
        const i = document.createElement('input'); i.type = 'hidden'; i.name = kv[0]; i.value = kv[1];
        form.appendChild(i);
      }
      document.body.appendChild(form);
      form.submit();
      await new Promise(r => setTimeout(r, 4000));
      const doc = document;
      const rows = [...doc.querySelectorAll('table tbody tr')].map(tr => {
        const t = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());
        return t;
      }).filter(t => t.length >= 6);
      return { ok: true, rows, url: location.href, text: (doc.body && doc.body.innerText || '').slice(0, 1500) };
    })`;
  }

  // ---------------- CAPTCHA ----------------

  async loadCaptcha() {
    const isDvc = this.currentPortal === 'dvc';
    const url = isDvc
      ? `${DVC}/tthc/login/getCaptcha?_t=${Date.now()}`
      : `${TDT}/etaxnnt/servlet/ImageServlet?d=${Date.now()}`;
    const res = await this.browser.fetchSameOrigin(url, { method: 'GET' });
    if (!res || res.status !== 200 || !res.body || res.body.length < 100) {
      throw new Error(`Không tải được CAPTCHA (HTTP ${res ? res.status : 'không phản hồi'}).`);
    }
    const head = res.body.subarray(0, 4);
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isJpg = head[0] === 0xff && head[1] === 0xd8;
    const isGif = head[0] === 0x47 && head[1] === 0x49;
    const mime = isPng ? 'image/png' : isJpg ? 'image/jpeg' : isGif ? 'image/gif' : 'image/svg+xml';
    const dataUrl = `data:${mime};base64,${res.body.toString('base64')}`;
    let solvedText = '';
    try {
      solvedText = (await captchaSolver.solve(dataUrl, isDvc ? DVC : TDT)) || '';
    } catch (error) {
      this.log(`Bộ giải CAPTCHA không chạy được: ${error.message}`, 'warn');
    }
    return { dataUrl, solvedText };
  }

  // ---------------- Đăng nhập DVC ----------------

  /** Đọc CSRF token từ trang login DVC (Cần cho mọi lời gọi loginLDAP). */
  async readDvcCsrf() {
    const res = await this.browser.fetchSameOrigin(`${DVC}/tthc/login`, { method: 'GET' });
    const html = res && res.ok ? res.text : '';
    return (html.match(/name="csrf-token"\s+content="([^"]+)"/i) || html.match(/name="_csrf"\s+value="([^"]+)"/i) || [])[1] || '';
  }

  async loginDvc(username, password, captcha) {
    const csrf = await this.readDvcCsrf();
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

  /** Điền form login trong tab TĐT rồi submit; đọc lại dse_sessionId sau khi trang chuyển. */
  async loginTdt(username, password, captcha) {
    const tabs = await browserTabs(this.browser, 'thuedientu.gdt.gov.vn');
    if (!tabs.length) throw new Error('Chưa mở tab Thuế Điện Tử. Bấm "Mở cổng trên Chrome" trước.');

    const submitted = await this.browser.evalInTab(tabs[0].id, `(() => {
      const u = document.querySelector('input[name="_userName"], #_userName');
      const p = document.querySelector('input[name="_password"], #password');
      const c = document.querySelector('input[name="_verifyCode"], #vcode');
      if (!u || !p) {
        const sid = new URLSearchParams(location.search).get('dse_sessionId')
          || (document.querySelector("input[name='dse_sessionId']") || {}).value || '';
        location.href = sid
          ? '${TDT}/etaxnnt/Request?&dse_sessionId=' + encodeURIComponent(sid) + '&dse_applicationId=-1&dse_pageId=4&dse_operationName=corpIndexProc&dse_errorPage=error_page.jsp&dse_processorState=initial&dse_nextEventName=login'
          : '${TDT}/etaxnnt/Request?&dse_operationName=corpIndexProc';
        return { moved: true };
      }
      u.value = ${JSON.stringify(username)};
      p.value = ${JSON.stringify(password)};
      if (c) c.value = ${JSON.stringify(captcha)};
      const btn = document.querySelector('input[type="submit"], input[type="button"][value*="nh" i], button.btn-login');
      if (btn) btn.click(); else u.form.submit();
      return { submitted: true };
    })()`, 30000);

    if (submitted && submitted.moved) {
      await sleep(4000); // trang đang chuyển tới form login
      await this.browser.evalInTab(tabs[0].id, `(() => {
        const u = document.querySelector('input[name="_userName"], #_userName');
        const p = document.querySelector('input[name="_password"], #password');
        const c = document.querySelector('input[name="_verifyCode"], #vcode');
        if (!u || !p) return { again: false };
        u.value = ${JSON.stringify(username)};
        p.value = ${JSON.stringify(password)};
        if (c) c.value = ${JSON.stringify(captcha)};
        const btn = document.querySelector('input[type="submit"], input[type="button"][value*="nh" i], button.btn-login');
        if (btn) btn.click(); else u.form.submit();
        return { submitted: true };
      })()`, 30000);
      await sleep(5000);
    } else {
      await sleep(5000);
    }

    const info = await this.browser.evalInTab(tabs[0].id, `(() => {
      const text = (document.body && document.body.innerText || '');
      const bad = /Mã xác thuận không chính xác|Mã xác nhận không đúng|Sai tên đăng nhập|Mật khẩu không đúng/i.test(text);
      const sid = new URLSearchParams(location.search).get('dse_sessionId')
        || (document.querySelector("input[name='dse_sessionId']") || {}).value || '';
      const nameM = text.match(/Tên đơn vị\\s*:\\s*([^\\n]{2,80})/i);
      return { bad, sessionId: sid, name: nameM ? nameM[1].trim() : '', url: location.href };
    })()`, 30000);

    if (!info || info.bad) throw new Error('Cổng Thuế điện tử từ chối thông tin đăng nhập (sai tài khoản/mật khẩu/CAPTCHA).');
    if (!info.sessionId) throw new Error('Sau khi đăng nhập không lấy được dse_sessionId — cổng có thể đã đổi luồng. Kiểm tra lại trên tab Chrome.');
    this.sessionId = info.sessionId;
    this.userMst = username;
    this.userName = info.name || 'Cổng Thuế Điện Tử';
    return { ok: true, portal: 'tdt', mst: username, name: this.userName };
  }

  // ---------------- Tra cứu DVC ----------------

  async searchDvc(tuNgay, denNgay, captcha) {
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
    if (/Mã xác nhận không đúng|Mã captcha không đúng/i.test(res.text || '')) {
      throw new Error('CAPTCHA không đúng. Bấm 🔄 lấy mã mới rồi thử lại.');
    }
    return parseDvcRows(res.text || '');
  }

  // ---------------- Tra cứu Thuế điện tử ----------------

  /** Cổng TĐT giới hạn 365 ngày/lượt nên tự chia nhỏ khoảng ngày. */
  static splitRange(tuNgay, denNgay) {
    const parse = s => { const [d, m, y] = s.split('/').map(Number); return new Date(y, m - 1, d); };
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
      const out = await this.browser.evalInTab(tabs[0].id, `${TokhaiController.TDT_SEARCH_SCRIPT}(${JSON.stringify(range.from)}, ${JSON.stringify(range.to)}, ${JSON.stringify(TDT)})`, 60000);
      if (!out || !out.ok) throw new Error((out && out.error) || 'Tra cứu Thuế điện tử không trả dữ liệu.');
      rows.push(...parseTdtRows(out.rows));
      if (i < ranges.length - 1) await pace.wait();
    }
    return rows;
  }

  // ---------------- Tải hồ sơ ----------------

  /** Tải một mã hồ sơ. Trả Buffer thô (ZIP/XML) hoặc ném lỗi. */
  async downloadOne(maHoSo) {
    if (this.currentPortal === 'tdt') {
      if (!this.sessionId) throw new Error('Chưa có phiên Thuế điện tử. Đăng nhập lại.');
      const tabs = await browserTabs(this.browser, 'thuedientu.gdt.gov.vn');
      if (!tabs.length) throw new Error('Không tìm thấy tab Thuế Điện Tử.');
      const out = await this.browser.evalInTab(tabs[0].id, `(async (id, sid) => {
        const url = '${TDT}/etaxnnt/Request?&dse_sessionId=' + encodeURIComponent(sid)
          + '&dse_applicationId=-1&dse_pageId=6&dse_operationName=downloadDeclProc&dse_nextEventName=download&maHoSo=' + encodeURIComponent(id);
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return { ok: false, status: res.status };
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
        return { ok: true, base64: btoa(bin) };
      })(${JSON.stringify(maHoSo)}, ${JSON.stringify(this.sessionId)})`, 60000);
      if (!out || !out.ok) throw new Error(`Cổng trả HTTP ${(out && out.status) || 'không phản hồi'}`);
      return Buffer.from(out.base64, 'base64');
    }

    const res = await this.browser.fetchSameOrigin(`${DVC}/tthc/ho-so/${encodeURIComponent(maHoSo)}/download`, {
      method: 'GET', headers: { accept: 'application/zip, application/octet-stream, */*' },
    });
    if (!res || res.status !== 200 || !res.body || !res.body.length) {
      throw new Error(`Cổng DVC trả HTTP ${res ? res.status : 'không phản hồi'} hoặc rỗng.`);
    }
    return res.body;
  }

  /** Tải cả danh sách, ghi vào thư mục. Kết quả { total, succeeded, failed, files }. */
  async bulkDownload(maHoSoList, { outputDir } = {}) {
    const files = [];
    let succeeded = 0;
    let failed = 0;
    const dir = outputDir || '';
    if (!dir) this.log('Chưa chọn thư mục lưu — tệp tải về sẽ không được ghi.', 'warn');

    for (let i = 0; i < maHoSoList.length; i += 1) {
      if (this.shouldStop) { this.log(`Đã dừng sau ${succeeded}/${maHoSoList.length} hồ sơ.`, 'warn'); break; }
      const id = maHoSoList[i];
      this.onProgress({ stage: 'download', current: i + 1, total: maHoSoList.length, maHoSo: id, message: `Đang tải ${id} (${i + 1}/${maHoSoList.length})…` });
      try {
        const bytes = await this.downloadOne(id);
        if (dir) {
          const name = safeFileName(`${id}.zip`, bytes);
          fs.mkdirSync(dir, { recursive: true });
          const target = path.join(dir, name);
          fs.writeFileSync(target, bytes);
          files.push(target);
        }
        succeeded += 1;
      } catch (error) {
        failed += 1;
        this.log(`Tải ${id} lỗi: ${error.message}`, 'error');
      }
      if (i < maHoSoList.length - 1) await pace.wait();
    }
    return { total: maHoSoList.length, succeeded, failed, files };
  }
}

// ---------------- helpers ----------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function browserTabs(browser, hostFragment) {
  const tabs = await browser.listTabs();
  return tabs.filter(t => t.type === 'page' && t.url && t.url.includes(hostFragment));
}

/** Đuôi file đúng theo nội dung: ZIP hay XML/HTML. */
function safeFileName(base, bytes) {
  const head = bytes.subarray(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4b) return base.replace(/\.(zip|xml|html)$/i, '') + '.zip';
  const text = bytes.subarray(0, 200).toString('utf8');
  if (/<HDon[\s>]/i.test(text)) return base.replace(/\.(zip|xml|html)$/i, '') + '.xml';
  return base.replace(/\.(zip|xml|html)$/i, '') + '.html';
}

/** Bảng DVC: cột cố định, nhưng bắt theo header để không vỡ khi cổng đổi bố cục. */
function parseDvcRows(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html))) {
    const cells = [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => decode(stripTags(c[1])));
    if (cells.length < 6) continue;
    const pick = (...names) => {
      for (const name of names) {
        const at = cells.findIndex(c => c.toLowerCase().includes(name));
        if (at >= 0 && cells[at]) return cells[at];
      }
      return '';
    };
    const maHoSo = pick('mã hồ sơ', 'ma ho so');
    if (!maHoSo) continue;
    out.push({
      maHoSo,
      toKhai: pick('tờ khai'),
      kyTinhThue: pick('kỳ tính thuế', 'ky tinh thue'),
      loaiToKhai: pick('loại tờ khai', 'loai to khai'),
      lanBoSung: pick('lần bổ sung', 'lan bo sung'),
      lanNop: pick('lần nộp', 'lan nop'),
      ngayNop: pick('ngày nộp', 'ngay nop'),
      trangThai: pick('trạng thái', 'trang thai'),
    });
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

module.exports = { TokhaiController, DVC, TDT };