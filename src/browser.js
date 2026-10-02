'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const pace = require('./pace');
const mstFormat = require('./mst-format');
const loginSource = fs.readFileSync(path.join(__dirname, 'tax-login.js'), 'utf8');
const TAX_HOME = 'https://hoadondientu.gdt.gov.vn/';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// NHẬN DẠNG PDF RỖNG — quy tắc DUY NHẤT, dùng ở cả browser.js và core.js.
//
// File thật gặp trên máy người dùng: 850 byte, /Title (about:blank),
// /Length 0, /MediaBox [0 0 612 792] (Letter thay vì A4). Nguyên nhân: in nhầm tab
// about:blank. Dấu hiệu chính xác là stream rỗng; ngưỡng 1KB chỉ để bắt nhanh.
//
// ĐỘT NÀY đặc biệt quan trọng vì core.js dùng hàm này để coi file rỗng là "chưa có"
// — nếu không, một file hỏng 850 byte vẫn có size > 0 nên bị bỏ qua mọi lần tải lại
// và người dùng KHÔNG BAO GIỜ tải được bản PDF đúng, trừ khi tự xoá file tay.
function isBlankPdf(buffer) {
  if (!buffer || buffer.length === 0) return true;
  if (buffer.length < 1024) return true;
  return /\/Length\s+0\s*>>\s*stream/.test(buffer.toString('latin1'));
}

// printToPDF cần trần thời gian: hóa đơn A4 in thường trong vài giây, treo quá 60 giây
// coi như lỗi (tab/CDP có vấn đề) — nếu không thì vòng tải kẹt vĩnh viễn ở bước này,
// cả worker tải cùng lúc đều treo và lượt tải không bao giờ kết thúc.
const PDF_TIMEOUT_MS = 60000;

// Giới hạn thời gian cho một thao tác bất đồng bộ.
//
// VÌ SAO HÀM NÀY PHẢI CÓ `await` BÊN TRONG: bản cũ viết
//     try { return Promise.race([...]) } finally { clearTimeout(timer) }
// trong hàm KHÔNG async. `finally` ở đó chạy ngay lập tức, tức xoá timer TRƯỚC khi
// `Promise.race` kịp settle ⇒ trần thời gian chết ngay và race treo vô hạn. Đã tái lại
// đúng khuôn đó để chứng minh: timer hết hạn 300ms, kết quả là "không báo lỗ — treo vô
// hạn". `await` buộc `finally` chạy SAU khi race kết thúc thì clearTimeout mới có ý nghĩa.
async function withTimeout(start, ms, message) {
  let timer = null;
  try {
    return await Promise.race([
      start(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message), { timeout: true })), ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
function browserPath() {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) for (const suffix of ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']) { const file = path.join(root, suffix); if (fs.existsSync(file)) return file; }
  return '';
}
function availablePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); }); }
// Tắt trình quản lý mật khẩu của Chrome cho profile này.
// Cờ dòng lệnh che được bong bóng "Lưu mật khẩu?", nhưng cờ có thể bị bỏ qua giữa các bản Chrome,
// nên ghi thẳng vào Preferences của profile — đây là dữ liệu Chrome TỰ ĐỌC lúc khởi động:
//   credentials_enable_service=false  → tắt dịch vụ lưu mật khẩu
//   profile.password_manager_enabled=false → tắt tính năng quản lý mật khẩu
//   profile.password_manager_leak_detection=false → tắt cảnh báo rò rỉ mật khẩu
// Ghi kiểu GỘP (đọc → sửa → ghi) để không phá các thiết lập khác của profile; file hỏng thì tạo mới.
function disablePasswordManager(profileDir) {
  const file = path.join(profileDir, 'Default', 'Preferences');
  let data = {};
  try { const raw = JSON.parse(fs.readFileSync(file, 'utf8')); if (raw && typeof raw === 'object') data = raw; } catch { /* chưa có hoặc hỏng */ }
  data.credentials_enable_service = false;
  data.credentials_enable_autosignin = false;
  data.profile = { ...(data.profile && typeof data.profile === 'object' ? data.profile : {}), password_manager_enabled: false, password_manager_leak_detection: false };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); return true; } catch { return false; }
}
function jwtAccount(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); if (payload.exp && payload.exp * 1000 <= Date.now()) return null;
    const pick = paths => { for (const route of paths) { const value = route.split('.').reduce((item, key) => item && item[key], payload); if (value !== undefined && value !== null && String(value).trim()) return String(value).trim(); } return ''; };
    const mst = pick(['mst', 'maSoThue', 'taxCode', 'user.mst', 'profile.mst', 'taxpayer.mst']); const user = pick(['username', 'userName', 'preferred_username', 'user.username', 'userId', 'sub']);
    return mst || user ? { key: `${mst}|${user}`, mst, label: user || mst } : null;
  } catch { return null; }
}
class TaxBrowser {
  constructor(root) { this.root = path.resolve(root); this.client = null; this.mst = ''; this.process = null; this.port = 0; this.visible = false; }
  // Đóng trình duyệt CÓ GIỚI THỜI GIAN: nếu Chrome/CDP treo thì Browser.close() chờ VĨNH VIỄN,
  // request /api/stream (giữ mở suốt lượt tải) không bao giờ trả lời ⇒ UI kẹt nút "Đang tải" dù
  // dữ liệu đã về hết — phải bấm Ngưng thủ công mới thoát (triệu chứng người dùng báo). Sau 5s
  // thì hủy tiến trình Chrome trực tiếp: cửa sổ chắc chắn đóng, luồng luôn được trả về.
  async close() {
    const client = this.client; this.client = null; this.mst = '';
    const kill = () => { try { if (this.process && !this.process.killed) this.process.kill(); } catch {} this.process = null; this.port = 0; this.visible = false; };
    try {
      if (client) {
        await Promise.race([
          (async () => { try { await client.Browser.close(); await client.close(); } catch { try { await client.close(); } catch {} } })(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      }
    } finally { kill(); }
  }
  async open(mst, visible) {
    if (!mstFormat.isValidMst(mst)) throw new Error(mstFormat.MST_HINT);

    if (this.client && this.mst === mst) {
      try { await this.evalWithTimeout('1', 10000); if (visible) await this.show(); else await this.hide(); return; }
      catch { await this.close(); }
    }
    await this.close(); const executablePath = browserPath(); if (!executablePath) throw new Error('Không tìm thấy Google Chrome hoặc Microsoft Edge. Cài một trong hai trình duyệt rồi thử lại.');
    const port = await availablePort(); const profile = path.join(this.root, 'profiles', mst); fs.mkdirSync(profile, { recursive: true });
    disablePasswordManager(profile);
    // Không hỏi lưu mật khẩu trên cửa sổ cổng thuế: tắt bong bóng + các tính năng autofill/khe rò mật khẩu.
    // Cần cho cả form đăng nhập trong app (UI) lẫn form đăng nhập của cổng thuế.
    const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=http://127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-save-password-bubble', '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication,AutofillEnableAccountWalletStorage', '--new-window', TAX_HOME];
    if (!visible) args.push('--start-minimized'); this.process = spawn(executablePath, args, { windowsHide: !visible, stdio: 'ignore' }); this.port = port;
    let error; for (let n = 0; n < 80; n += 1) {
      try { const tabs = await CDP.List({ host: '127.0.0.1', port }); const tab = tabs.find(x => x.type === 'page' && x.url.includes('hoadondientu.gdt.gov.vn')) || tabs.find(x => x.type === 'page'); if (tab) { this.client = await CDP({ host: '127.0.0.1', port, target: tab }); break; } } catch (caught) { error = caught; }
      await sleep(250);
    }
    if (!this.client) { await this.close(); throw new Error(`Không kết nối được với trình duyệt hệ thống: ${error?.message || 'unknown error'}`); }
    const connected = this.client;
    connected.on('disconnect', () => { if (this.client === connected) this.client = null; });
    if (visible) await this.show();
    this.mst = mst;
  }
  async show() {
    if (!this.client) return;
    const { windowId } = await this.client.Browser.getWindowForTarget();
    await this.client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } });
    await this.client.Page.bringToFront();
    this.visible = true;
  }
  async hide() {
    if (!this.client) return;
    const { windowId } = await this.client.Browser.getWindowForTarget();
    await this.client.Browser.setWindowBounds({ windowId, bounds: { windowState: 'minimized' } });
    this.visible = false;
  }
  // Chạy một lệnh CDP có CHẾ GIỚI THỜI GIAN phía Node. Trước đây Runtime.evaluate(awaitPromise)
  // chờ VĨNH VIỄN nếu tab cổng thuế bị treo (Chrome đóng băng tab nền, hộp thoại chặn trang…) —
  // cờ "ngưng" của Engine không bao giờ được đọc lại vì vòng lặp đang kẹt ở chính lệnh await này,
  // nên nút Ngưng bấm mấy lần cũng vô hiệu. Giờ hết giờ là ném lỗi có cờ { timeout: true } —
  // classifyDownloadError() xếp vào loại 'timeout' (retryable) và vòng lặp thoát ra được để
  // đọc cờ ngưng ở mốc check() kế tiếp.
  async evalWithTimeout(expression, timeoutMs = 45000) {
    let timer = null;
    try {
      return await Promise.race([
        this.eval(expression),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error(`Trang cổng thuế không phản hồi sau ${Math.round(timeoutMs / 1000)} giây (tab có thể bị treo).`),
            { timeout: true },
          )), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async eval(expression) { if (!this.client) throw new Error('Cửa sổ cổng thuế đã đóng. Bấm Lấy CAPTCHA để mở lại.'); const answer = await this.client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }); if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description?.split('\n')[0] || answer.exceptionDetails.text || 'Lỗi thực thi trong trang cổng thuế.'); return answer.result.value; }
  async loginAction(options) {
    const origin = await this.eval('location.origin');
    if (origin !== new URL(TAX_HOME).origin) throw new Error('Trang hiện tại không phải cổng thuế. Mở lại phiên trước khi đăng nhập.');
    // pkg bytecode cannot reliably preserve Function.toString(). Ship the source asset.
    return this.eval(`(() => { if (location.origin !== ${JSON.stringify(new URL(TAX_HOME).origin)}) throw new Error('Trang thuế đã chuyển hướng. Hãy thử lại.'); const module = { exports: {} }; ${loginSource}\n return module.exports.taxLoginAction(${JSON.stringify(options)}); })()`);
  }
  async prepareLogin() {
    for (let n = 0; n < 80; n++) {
      let ready = false;
      try { ready = await this.eval('location.origin') === new URL(TAX_HOME).origin; } catch (e) { if (n === 79) throw e; }
      if (ready) {
        try { return await this.loginAction({ mode: 'open' }); }
        catch (error) { if (!/context|navigat/i.test(error.message) || n === 79) throw error; }
      }
      await sleep(250);
    }
    throw new Error('Cổng thuế chưa tải xong. Bấm Lấy CAPTCHA lại.');
  }
  // account() chạy TRƯỚC MỖI request (checkAccount() của Engine) — dùng eval có giới hạn thời gian;
  // eval trần ở đây là đường kẹt "Đang tải" vĩnh viễn: tab treo thì vòng tải không bao giờ thoát,
  // mọi mốc check() kế tiếp đều đứng chờ ngay ở bước đọc token (xem verify()).
  async account() { if (!this.client) return null; return jwtAccount(await this.evalWithTimeout("(()=>{try{return window.__NEXT_REDUX_STORE__?.getState?.().authReducer?.jwt||null}catch{return null}})()")); }
  async verify(expectedMst) {
    // Dùng eval CÓ hạn thời gian: verify() được Engine gọi ở mốc checkAccount() trước mỗi trang —
    // nếu tab treo mà chờ vô hạn thì cờ ngưng của Engine không bao giờ được đọc lại.
    const account = await this.account(); if (!account) return null;
    if (!account.mst && /^(\d{10}(?:-\d{3})?|\d{13})$/.test(account.label)) account.mst = account.label;
    if (!account.mst) {
      account.mst = await this.evalWithTimeout(`(() => { const s = window.__NEXT_REDUX_STORE__?.getState?.() || {}; const codes = new Set(); const seen = new WeakSet(); function visit(o, depth) { if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 5 || seen.has(o)) return; seen.add(o); for (const [k,v] of Object.entries(o)) { if (/^(mst|maSoThue|ma_so_thue|taxCode|tax_code)$/i.test(k) && /^(\\d{10}(?:-\\d{3})?|\\d{13})$/.test(String(v))) codes.add(String(v)); else if (typeof v === 'object') visit(v,depth+1); } } for (const [k,v] of Object.entries(s)) if (/auth|user|profile|account|taxpayer|nnt/i.test(k)) visit(v,0); return codes.size === 1 ? [...codes][0] : ''; })()`);
    }
    if (!account.mst) throw new Error('Đã có token nhưng chưa xác định được MST từ tài khoản cổng thuế; chưa cho phép tải để tránh nhầm doanh nghiệp.');
    if (!mstFormat.mstAliases(expectedMst).includes(String(account.mst))) throw new Error(`Phiên đang là MST ${account.mst}, không khớp hồ sơ ${expectedMst}.`);
    return account;
  }
  async request(route, action, check) {
    check(); await pace.wait(); const account = await this.account(); if (!account) throw Object.assign(new Error('Phiên cổng thuế đã hết. Chọn MST và đăng nhập lại.'), { auth: true });
    const expression = `(async(p)=>{const token=window.__NEXT_REDUX_STORE__?.getState?.().authReducer?.jwt;if(!token)return{status:401,text:''};const c=new AbortController(),t=setTimeout(()=>c.abort(),30000);try{const r=await fetch('https://hoadondientu.gdt.gov.vn/api'+p.route,{method:'GET',credentials:'include',signal:c.signal,headers:{Accept:'application/json, text/plain, */*','Accept-Language':'vi',Authorization:'Bearer '+token,Action:encodeURIComponent(p.action),'End-Point':'/tra-cuu/tra-cuu-hoa-don','request-id':crypto.randomUUID()}});const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return{status:r.status,body:btoa(s),retryAfter:r.headers.get('retry-after')}}catch(e){return{status:0,error:e.message||'Network error'}}finally{clearTimeout(t)}})(${JSON.stringify({ route, action })})`;
    // Timeout 45s (fetch trong trang tự hủy ở 30s, để 15s dự phòng chuyển dữ liệu về Node):
    // tab treo không làm kẹt vòng tải — lỗi timeout thoát ra để nút Ngưng có hiệu lực.
    const data = await this.evalWithTimeout(expression); check();
    pace.note(data.status || 0, Buffer.from(String(data.body || ''), 'base64').toString('utf8').slice(0, 500), data.retryAfter); pace.mark();
    if (data.status >= 200 && data.status < 300) return Buffer.from(data.body, 'base64'); if (data.status === 401) throw Object.assign(new Error('Phiên cổng thuế đã hết. Đăng nhập lại rồi tải tiếp.'), { auth: true }); throw new Error(pace.blocked() || (data.status ? `Cổng thuế trả HTTP ${data.status}. Đã giữ tiến độ để thử lại.` : (data.error || 'Không kết nối được cổng thuế.')));
  }
  async pdf(html) {
    if (!this.client) throw new Error('Chưa có phiên trình duyệt để xuất PDF.');
    const target = await CDP.New({ host: '127.0.0.1', port: this.port, url: 'about:blank' });
    const client = await CDP({ host: '127.0.0.1', port: this.port, target });
    try {
      // PHẢI ghi HTML vào CHÍNH tab vừa tạo (client), KHÔNG dùng this.evalWithTimeout.
      //
      // Lý do: eval()/evalWithTimeout() chạy trên `this.client` — đó là tab CỔNG
      // THUẾ, không phải tab `client` ở đây. Bản cũ gọi this.evalWithTimeout() nên
      // hóa đơn bị document.write vào tab cổng thuế (làm hỏng luôn trang đó), còn
      // printToPDF thì in tab about:blank vẫn còn trống. Kết quả: mọi file PDF ra
      // đều rỗng (~850 byte, /Title = about:blank, /Length 0, khổ Letter thay A4) và
      // KHÔNG có lỗi nào được báo ra — người dùng phải tự mở file mới thấy.
      await client.Runtime.evaluate({
        expression: `(async () => {
          document.open(); document.write(${JSON.stringify(html)}); document.close();
          // Chờ nét chữ và ảnh nền (data: URL) nạp xong, nếu không PDF ra trắng trơn.
          try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
          const imgs = Array.from(document.images || []);
          await Promise.all(imgs.map(img => (img.complete && img.naturalWidth > 0) ? null
            : new Promise(resolve => { img.onload = img.onerror = resolve; })));
          return true;
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const output = await withTimeout(
        () => client.Page.printToPDF({ printBackground: true, preferCSSPageSize: true }),
        PDF_TIMEOUT_MS,
        'In PDF từ trang cổng thuế không phản hồi sau 60 giây.',
      );
      const bytes = Buffer.from(String(output.data || ''), 'base64');
      // CHỐT: không bao giờ ghi ra file PDF rỗng. Ghi file hỏng thì người dùng mở ra
      // thấy trang trắng, mất công tải lại; báo lỗi thì họ biết ngay và thử lại.
      if (isBlankPdf(bytes)) {
        throw new Error('Trang hóa đơn in ra rỗng (không có nội dung) — thử tải lại hoặc xuất HTML.');
      }
      return bytes;
    }
    finally { try { await client.close(); } catch {}; try { await CDP.Close({ host: '127.0.0.1', port: this.port, id: target.id }); } catch {} }
  }
}
module.exports = { TaxBrowser, browserPath, jwtAccount, disablePasswordManager, withTimeout, isBlankPdf, PDF_TIMEOUT_MS };
