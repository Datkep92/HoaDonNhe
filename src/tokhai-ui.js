'use strict';
/**
 * CN Tax Tools — UI cho Tab Tải Tờ Khai / DVC
 */
(function() {
  let state = {
    currentPortal: 'dvc',
    captchaDataUrl: '',
    captchaSolved: '',
    isLoadingCaptcha: false,
    isSearching: false,
    isDownloading: false,
    results: [],
    currentUserMST: '',
    currentUserName: '',
    loggedIn: false
  };

  const els = {};

  function init() {
    cacheElements();
    bindEvents();
    loadCaptcha();
    initDatePickers();
  }

  function cacheElements() {
    // Connection
    els.connDot = document.getElementById('ttk-conn-dot');
    els.userMst = document.getElementById('ttk-user-mst');
    els.userName = document.getElementById('ttk-user-name');
    els.btnShowLogin = document.getElementById('ttk-btn-show-login');
    els.btnSyncToken = document.getElementById('ttk-btn-sync-token');
    els.cardDirectLogin = document.getElementById('ttk-card-direct-login');
    els.btnCloseLogin = document.getElementById('ttk-btn-close-login');

    // Login form
    els.loginPortal = document.getElementById('ttk-login-portal');
    els.txtUser = document.getElementById('ttk-login-user');
    els.txtPass = document.getElementById('ttk-login-pass');
    els.btnTogglePass = document.getElementById('ttk-btn-toggle-pass');
    els.captchaImg = document.getElementById('ttk-captcha-img');
    els.captchaLoadingText = document.getElementById('ttk-captcha-loading-text');
    els.btnReloadCaptcha = document.getElementById('ttk-btn-reload-captcha');
    els.txtCaptcha = document.getElementById('ttk-login-captcha');
    els.chkRemember = document.getElementById('ttk-chk-remember');
    els.btnDoLogin = document.getElementById('ttk-btn-do-login');
    els.btnOpenPortal = document.getElementById('ttk-btn-open-portal');

    // Portal tabs
    els.portalTabs = document.querySelectorAll('#pane-tokhai .portal-tab');

    // Search
    els.txtTuNgay = document.getElementById('ttk-txt-tu-ngay');
    els.txtDenNgay = document.getElementById('ttk-txt-den-ngay');
    els.presetBtns = document.querySelectorAll('#pane-tokhai .preset-btn');
    els.btnSearch = document.getElementById('ttk-btn-search');
    els.btnBulkDownload = document.getElementById('ttk-btn-bulk-download');

    // Results
    els.resultsSection = document.getElementById('ttk-results-section') || document.querySelector('.tokhai-results');
    els.resultCount = document.getElementById('ttk-result-count');
    els.resultsBody = document.getElementById('ttk-results-body');
    els.resultsEmpty = document.getElementById('ttk-results-empty');

    // Log
    els.logContainer = document.getElementById('ttk-log-container');
    els.btnClearLog = document.getElementById('ttk-btn-clear-log');
  }

  function bindEvents() {
    // Connection & Login
    els.btnShowLogin.addEventListener('click', toggleLoginPanel);
    els.btnCloseLogin.addEventListener('click', () => { els.cardDirectLogin.hidden = true; els.btnShowLogin.classList.remove('active'); });
    els.btnSyncToken.addEventListener('click', syncTokenFromWeb);
    els.btnTogglePass.addEventListener('click', togglePassword);
    els.btnReloadCaptcha.addEventListener('click', loadCaptcha);
    els.captchaImg.addEventListener('click', loadCaptcha);
    els.btnDoLogin.addEventListener('click', handleDirectLogin);
    if (els.btnOpenPortal) els.btnOpenPortal.addEventListener('click', openPortalInBrowser);

    // Portal tabs
    els.portalTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        els.portalTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentPortal = tab.dataset.portal;
        if (els.loginPortal) els.loginPortal.value = state.currentPortal;
        loadCaptcha();
      });
    });

    if (els.loginPortal) {
      els.loginPortal.addEventListener('change', (e) => {
        state.currentPortal = e.target.value;
        els.portalTabs.forEach(t => t.classList.toggle('active', t.dataset.portal === state.currentPortal));
        loadCaptcha();
      });
    }

    // Presets
    els.presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        els.presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyPreset(btn.dataset.preset);
      });
    });

    // Search & Download
    els.btnSearch.addEventListener('click', searchDeclarations);
    els.btnBulkDownload.addEventListener('click', bulkDownload);

    // Results table delegation
    if (els.resultsBody) {
      els.resultsBody.addEventListener('click', async (e) => {
        const link = e.target.closest('.ttk-hs-link');
        if (link) {
          e.preventDefault();
          const maHoSo = link.dataset.maHoSo;
          // show detail modal
        }
        const dlBtn = e.target.closest('.ttk-btn-download');
        if (dlBtn) {
          e.preventDefault();
          const maHoSo = dlBtn.dataset.maHoSo;
          await downloadSingle(maHoSo, dlBtn);
        }
      });
    }

    els.btnClearLog.addEventListener('click', clearLog);
  }

  function initDatePickers() {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    if (typeof flatpickr !== 'undefined') {
      flatpickr(els.txtTuNgay, { dateFormat: 'd/m/Y', allowInput: true, locale: flatpickr.l10ns.vn || 'default', defaultDate: firstDay });
      flatpickr(els.txtDenNgay, { dateFormat: 'd/m/Y', allowInput: true, locale: flatpickr.l10ns.vn || 'default', defaultDate: lastDay });
    }
  }

  function applyPreset(preset) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    let s, e;

    switch (preset) {
      case 'this_month': s = new Date(y, m, 1); e = new Date(y, m + 1, 0); break;
      case 'last_month': s = new Date(y, m - 1, 1); e = new Date(y, m, 0); break;
      case 'q1': s = new Date(y, 0, 1); e = new Date(y, 2, 31); break;
      case 'q2': s = new Date(y, 3, 1); e = new Date(y, 5, 30); break;
      case 'q3': s = new Date(y, 6, 1); e = new Date(y, 8, 30); break;
      case 'q4': s = new Date(y, 9, 1); e = new Date(y, 11, 31); break;
      case 'this_year': s = new Date(y, 0, 1); e = new Date(y, 11, 31); break;
      default: return;
    }

    const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
    if (els.txtTuNgay._flatpickr) els.txtTuNgay._flatpickr.setDate(s, true);
    else els.txtTuNgay.value = fmt(s);
    if (els.txtDenNgay._flatpickr) els.txtDenNgay._flatpickr.setDate(e, true);
    else els.txtDenNgay.value = fmt(e);
  }

  function toggleLoginPanel() {
    const isHidden = els.cardDirectLogin.hidden;
    if (isHidden) {
      els.cardDirectLogin.hidden = false;
      els.btnShowLogin.classList.add('active');
      loadCaptcha();
    } else {
      els.cardDirectLogin.hidden = true;
      els.btnShowLogin.classList.remove('active');
    }
  }

  function togglePassword() {
    const isPass = els.txtPass.type === 'password';
    els.txtPass.type = isPass ? 'text' : 'password';
    els.btnTogglePass.textContent = isPass ? '🙈' : '👁️';
  }

  async function loadCaptcha() {
    if (state.isLoadingCaptcha) return;
    state.isLoadingCaptcha = true;

    els.captchaLoadingText.classList.remove('hidden');
    els.captchaLoadingText.innerText = 'Đang nạp mã...';
    els.captchaImg.classList.add('hidden');
    els.captchaImg.src = '';
    els.txtCaptcha.value = '';
    els.btnReloadCaptcha.disabled = true;

    try {
      const res = await fetch('/api/tokhai/captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ portal: state.currentPortal })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Không lấy được CAPTCHA');

      const { dataUrl, solvedText } = data.value;
      state.captchaDataUrl = dataUrl;
      state.captchaSolved = solvedText || '';

      els.captchaImg.src = dataUrl;
      els.captchaImg.classList.remove('hidden');
      els.captchaLoadingText.classList.add('hidden');
      els.txtCaptcha.value = state.captchaSolved;

      if (state.captchaSolved) {
        log(`[Captcha ${state.currentPortal.toUpperCase()}] Tự động giải mã: "${state.captchaSolved}"`, 'info');
      }
    } catch (err) {
      els.captchaLoadingText.innerText = 'Lỗi tải mã (Bấm để thử lại)';
      els.captchaLoadingText.classList.remove('hidden');
      log(`Lỗi tải CAPTCHA: ${err.message}`, 'error');
    } finally {
      state.isLoadingCaptcha = false;
      els.btnReloadCaptcha.disabled = false;
    }
  }

  async function syncTokenFromWeb() {
    els.connDot.className = 'status-dot';
    els.userMst.textContent = 'Đang kiểm tra...';
    els.userName.textContent = 'Quét tab và cookies...';

    try {
      const res = await fetch('/api/sync-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ portal: state.currentPortal })
      });
      const data = await res.json();
      if (data.ok && data.value) {
        state.currentUserMST = data.value.mst || '';
        state.currentUserName = data.value.name || 'Đã kết nối qua Web';
        state.loggedIn = true;
        updateConnectionUI(true);
        log('Đồng bộ phiên thành công từ tab Web!', 'ok');
      } else {
        throw new Error(data.error || 'Không đồng bộ được');
      }
    } catch (err) {
      els.connDot.className = 'status-dot disconnected';
      els.userMst.textContent = 'Chưa kết nối';
      els.userName.textContent = 'Bấm Đăng nhập hoặc mở cổng thuế';
      log('Không đồng bộ được Token từ tab Web: ' + err.message, 'warn');
    }
  }

  async function handleDirectLogin() {
    const username = els.txtUser.value.trim();
    const password = els.txtPass.value.trim();
    const captcha = els.txtCaptcha.value.trim().toUpperCase();

    if (!username || !password) {
      fail('Vui lòng nhập đầy đủ Tài khoản/MST và Mật khẩu!');
      return;
    }
    if (!captcha) {
      fail('Vui lòng nhập Mã CAPTCHA!');
      return;
    }

    els.btnDoLogin.disabled = true;
    els.btnDoLogin.innerHTML = '⏳ ĐANG ĐĂNG NHẬP...';

    try {
      const res = await fetch('/api/tokhai/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, captcha, portal: state.currentPortal })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Đăng nhập thất bại');

      state.currentUserMST = username;
      state.currentUserName = state.currentPortal === 'dvc' ? 'Cổng Dịch Vụ Công Thuế' : 'Cổng Thuế Điện Tử (eTax)';
      state.loggedIn = true;
      updateConnectionUI(true);

      els.cardDirectLogin.hidden = true;
      els.btnShowLogin.classList.remove('active');
      log(`Đăng nhập trực tiếp thành công vào ${state.currentPortal === 'dvc' ? 'Dịch Vụ Công' : 'Thuế Điện Tử'}!`, 'ok');
    } catch (err) {
      log(`Đăng nhập thất bại: ${err.message}`, 'error');
      fail(`Đăng nhập không thành công: ${err.message}`);
      loadCaptcha();
    } finally {
      els.btnDoLogin.disabled = false;
      els.btnDoLogin.innerHTML = '⚡ ĐĂNG NHẬP TRỰC TIẾP';
    }
  }

  function updateConnectionUI(connected) {
    if (connected) {
      els.connDot.className = 'status-dot connected';
      els.userMst.textContent = `Tài khoản: ${state.currentUserMST}`;
      els.userName.textContent = state.currentUserName;
    } else {
      els.connDot.className = 'status-dot disconnected';
      els.userMst.textContent = 'Chưa kết nối';
      els.userName.textContent = 'Bấm Đăng nhập để bắt đầu';
    }
  }

  function openPortalInBrowser() {
    const url = state.currentPortal === 'dvc' ? 'https://dichvucong.gdt.gov.vn/tthc/home' : 'https://thuedientu.gdt.gov.vn/etaxnnt/';
    window.open(url, '_blank');
    log(`Đã mở ${state.currentPortal === 'dvc' ? 'Dịch Vụ Công' : 'Thuế Điện Tử'} trên trình duyệt.`, 'info');
  }

  async function searchDeclarations() {
    if (state.isSearching) return;

    if (!state.loggedIn) {
      fail('Vui lòng đăng nhập trước khi tra cứu!');
      els.cardDirectLogin.hidden = false;
      els.btnShowLogin.classList.add('active');
      loadCaptcha();
      return;
    }

    const tuNgay = els.txtTuNgay.value.trim();
    const denNgay = els.txtDenNgay.value.trim();
    if (!tuNgay || !denNgay) {
      fail('Vui lòng chọn khoảng thời gian Từ ngày và Đến ngày!');
      return;
    }

    state.isSearching = true;
    state.results = [];
    els.btnSearch.disabled = true;
    els.btnSearch.innerHTML = '⏳ ĐANG TRA CỨU...';
    els.btnBulkDownload.disabled = true;
    clearResultsUI();

    try {
      log(`Bắt đầu tra cứu tờ khai ${state.currentPortal.toUpperCase()} từ ${tuNgay} đến ${denNgay}...`, 'info');

      let captchaCode = '';
      if (state.currentPortal === 'dvc') {
        captchaCode = els.txtCaptcha.value.trim();
        if (!captchaCode) {
          fail('Vui lòng nhập mã CAPTCHA cho DVC!');
          return;
        }
      }

      const res = await fetch('/api/tokhai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tuNgay, denNgay, captcha: captchaCode, portal: state.currentPortal })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Tra cứu thất bại');

      state.results = data.value.results;
      renderResults(state.results);
      els.resultCount.textContent = `${state.results.length} hồ sơ`;
      els.btnBulkDownload.disabled = state.results.length === 0;

      if (state.results.length > 0) {
        log(`Tra cứu thành công: Tìm thấy ${state.results.length} hồ sơ tờ khai!`, 'ok');
      } else {
        log('Không tìm thấy hồ sơ tờ khai nào trong khoảng thời gian này.', 'warn');
      }
    } catch (err) {
      log(`Lỗi tra cứu: ${err.message}`, 'error');
      fail(`Lỗi: ${err.message}`);
    } finally {
      state.isSearching = false;
      els.btnSearch.disabled = false;
      els.btnSearch.innerHTML = '🔍 Tìm Kiếm';
    }
  }

  async function bulkDownload() {
    if (state.isDownloading) return;
    if (!state.results.length) {
      fail('Chưa có kết quả để tải!');
      return;
    }

    const maHoSoList = state.results.map(r => r.maHoSo).filter(Boolean);
    if (!maHoSoList.length) {
      fail('Không có mã hồ sơ hợp lệ để tải!');
      return;
    }

    state.isDownloading = true;
    els.btnBulkDownload.disabled = true;
    els.btnBulkDownload.innerHTML = '⏳ ĐANG TẢI...';

    try {
      log(`Bắt đầu tải ${maHoSoList.length} tờ khai...`, 'info');

      const res = await fetch('/api/tokhai/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ maHoSoList, portal: state.currentPortal, results: state.results })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Tải thất bại');

      const results = data.value;
      let success = 0, failed = 0;
      for (const r of results) {
        if (r.success) success++;
        else failed++;
      }

      log(`Tải xong: ${success} thành công, ${failed} lỗi.`, success > 0 ? 'ok' : 'error');
    } catch (err) {
      log(`Lỗi tải hàng loạt: ${err.message}`, 'error');
      fail(`Lỗi: ${err.message}`);
    } finally {
      state.isDownloading = false;
      els.btnBulkDownload.disabled = false;
      els.btnBulkDownload.innerHTML = '⬇ Tải tất cả';
    }
  }

  async function downloadSingle(maHoSo, btn) {
    const oldText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Đang tải...';

    try {
      const res = await fetch('/api/tokhai/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ maHoSoList: [maHoSo], portal: state.currentPortal, results: state.results })
      });
      const data = await res.json();
      if (data.ok && data.value.length > 0 && data.value[0].success) {
        btn.innerHTML = '✓ Đã tải';
        log(`Đã tải tờ khai ${maHoSo}`, 'ok');
      } else {
        throw new Error(data.value[0]?.error || 'Tải thất bại');
      }
    } catch (err) {
      btn.innerHTML = oldText;
      log(`Lỗi tải ${maHoSo}: ${err.message}`, 'error');
      fail(`Lỗi: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  function renderResults(items) {
    els.resultsSection.hidden = false;
    els.resultsEmpty.hidden = items.length === 0;
    els.resultsBody.innerHTML = '';

    if (items.length === 0) return;

    els.resultsBody.innerHTML = items.map((item, idx) => `
      <tr data-ma-ho-so="${item.maHoSo}" data-to-khai="${item.toKhai}" data-ky-tinh-thue="${item.kyTinhThue}" data-loai-to-khai="${item.loaiToKhai}" data-lan-bo-sung="${item.lanBoSung}" data-lan-nop="${item.lanNop}" data-ngay-nop="${item.ngayNop}" data-trang-thai="${item.trangThai}">
        <td>${idx + 1}</td>
        <td><strong>${item.maHoSo}</strong></td>
        <td>${item.toKhai}</td>
        <td>${item.kyTinhThue}</td>
        <td>${item.loaiToKhai}</td>
        <td>${item.lanBoSung}</td>
        <td>${item.lanNop}</td>
        <td>${item.ngayNop}</td>
        <td><span class="badge-status">${item.trangThai}</span></td>
        <td>
          <a href="#" class="ttk-hs-link" data-ma-ho-so="${item.maHoSo}" title="Xem chi tiết">🔗 Xem</a>
          <button class="ttk-btn-download" data-ma-ho-so="${item.maHoSo}" title="Tải tờ khai này">⬇ Tải</button>
        </td>
      </tr>
    `).join('');
  }

  function clearResultsUI() {
    state.results = [];
    els.resultsBody.innerHTML = '';
    els.resultsEmpty.hidden = false;
    els.resultCount.textContent = '0 hồ sơ';
    els.btnBulkDownload.disabled = true;
  }

  function clearLog() {
    els.logContainer.innerHTML = '<div class="log-entry log-info"><span class="log-time">--:--:--</span><span>Đã xóa nhật ký.</span></div>';
  }

  function log(msg, type = 'info') {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN');
    const div = document.createElement('div');
    div.className = `log-entry log-${type}`;
    div.innerHTML = `<span class="log-time">${time}</span><span>${msg}</span>`;
    if (els.logContainer) {
      els.logContainer.prepend(div);
    }
  }

  // Báo lỗi ra LƯỚI AN TOÀN của app (toast góc phải) thay vì alert() native — toàn app đã bỏ
  // alert/confirm/prompt: hộp native che app, không tự tắt, không đọc được bằng trình đọc màn hình.
  function fail(message) {
    if (window.noticeFail) window.noticeFail(String(message || ''));
    else if (window.notice) window.notice(String(message || ''));
  }

  // Khởi tạo đúng MỘT lần — data-ui.js gọi ensureInit() mỗi lần bấm tab.
  let initialized = false;
  function ensureInit() {
    if (initialized) return;
    if (!document.getElementById('ttk-btn-search')) return; // pane chưa có trong DOM
    initialized = true;
    init();
  }

  window.TokhaiUI = { ensureInit, init: ensureInit };
})();