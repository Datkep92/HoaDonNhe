'use strict';
/**
 * CN Tax Tools — UI cho Tab Tra Cứu MST
 */
(function() {
  let state = {
    captchaDataUrl: '',
    captchaSolved: '',
    isLoadingCaptcha: false,
    isSearching: false,
    results: [],
    mstList: [],
    partners: [],
    partnerSelected: new Set(),
    partnerRequest: 0
  };

  const els = {};

  function init() {
    cacheElements();
    bindEvents();
    loadCaptcha();
  }

  function cacheElements() {
    for (const id of ['mst-btn-suppliers', 'mst-btn-buyers', 'mst-partners', 'mst-partner-note', 'mst-partner-all', 'mst-partner-body']) els[id] = document.getElementById(id);
    els.mstInput = document.getElementById('mst-input');
    els.mstCountBadge = document.getElementById('mst-count-badge');
    els.btnSampleMst = document.getElementById('mst-btn-sample');
    els.btnClearMst = document.getElementById('mst-btn-clear');
    els.captchaImg = document.getElementById('mst-captcha-img');
    els.captchaLoadingText = document.getElementById('mst-captcha-loading-text');
    els.btnReloadCaptcha = document.getElementById('mst-btn-reload-captcha');
    els.captchaInput = document.getElementById('mst-captcha-input');
    els.btnStart = document.getElementById('mst-btn-start');
    els.btnStop = document.getElementById('mst-btn-stop');
    els.btnExportExcel = document.getElementById('mst-btn-export-excel');
    els.btnClearResults = document.getElementById('mst-btn-clear-results');
    els.progressSection = document.getElementById('mst-progress-section');
    els.progressFill = document.getElementById('mst-progress-fill');
    els.progressText = document.getElementById('mst-progress-text');
    els.progressDetail = document.getElementById('mst-progress-detail');
    els.badgeTotal = document.getElementById('mst-badge-total');
    els.badgeActive = document.getElementById('mst-badge-active');
    els.badgeInactive = document.getElementById('mst-badge-inactive');
    els.badgeNotFound = document.getElementById('mst-badge-notfound');
    els.badgeError = document.getElementById('mst-badge-error');
    els.resultsBody = document.getElementById('mst-results-body');
    els.resultsEmpty = document.getElementById('mst-results-empty');
    els.resultsCount = document.getElementById('mst-results-count');
    els.logContainer = document.getElementById('mst-log-container');
    els.btnClearLog = document.getElementById('mst-btn-clear-log');
  }

  function bindEvents() {
    els['mst-btn-suppliers']?.addEventListener('click', () => loadPartners('supplier'));
    els['mst-btn-buyers']?.addEventListener('click', () => loadPartners('buyer'));
    els['mst-partner-all']?.addEventListener('change', () => {
      state.partnerSelected = new Set(els['mst-partner-all'].checked ? state.partners.map(row => row.mst) : []);
      renderPartners();
    });
    els['mst-partner-body']?.addEventListener('change', event => {
      const mst = event.target.dataset.mst;
      if (!mst) return;
      if (event.target.checked) state.partnerSelected.add(mst); else state.partnerSelected.delete(mst);
      updatePartnerSelection();
    });
    els.mstInput.addEventListener('input', updateMstCount);
    els.btnSampleMst.addEventListener('click', loadSampleMst);
    els.btnClearMst.addEventListener('click', clearMstList);
    els.btnReloadCaptcha.addEventListener('click', loadCaptcha);
    els.captchaImg.addEventListener('click', loadCaptcha);
    els.captchaLoadingText.addEventListener('click', loadCaptcha);
    els.btnStart.addEventListener('click', startSearch);
    els.btnStop.addEventListener('click', stopSearch);
    els.btnExportExcel.addEventListener('click', exportExcel);
    els.btnClearResults.addEventListener('click', clearResults);
    els.btnClearLog.addEventListener('click', clearLog);
  }

  function updateMstCount() {
    const list = selectedMsts();
    state.mstList = list;
    els.mstCountBadge.innerHTML = `Đã nhận diện: <strong>${list.length}</strong> MST`;
  }

  function selectedMsts() {
    return [...new Set([...parseMstList(els.mstInput.value), ...state.partnerSelected])];
  }

  function updatePartnerSelection() {
    const all = els['mst-partner-all'];
    all.checked = state.partners.length > 0 && state.partnerSelected.size === state.partners.length;
    all.indeterminate = state.partnerSelected.size > 0 && !all.checked;
    all.disabled = !state.partners.length;
    if (state.partnerNote) els['mst-partner-note'].textContent = `${state.partnerNote} Đã chọn ${state.partnerSelected.size}/${state.partners.length}.`;
    updateMstCount();
  }

  function renderPartners() {
    els['mst-partner-body'].innerHTML = state.partners.map(row => `<tr><td><input type="checkbox" data-mst="${escapeHtml(row.mst)}" aria-label="Chọn ${escapeHtml(row.mst)}" ${state.partnerSelected.has(row.mst) ? 'checked' : ''}></td><td>${escapeHtml(row.mst)}</td><td>${escapeHtml(row.ten)}</td><td>${Number(row.so_hoa_don) || 0}</td></tr>`).join('');
    updatePartnerSelection();
  }

  async function loadPartners(kind) {
    const request = ++state.partnerRequest;
    els['mst-btn-suppliers'].disabled = els['mst-btn-buyers'].disabled = true;
    try {
      const response = await featureFetch('/api/db/mst-partners?kind=' + kind);
      const data = await response.json();
      if (request !== state.partnerRequest) return;
      if (!data.ok) throw new Error(data.error || 'Không đọc được danh sách đối tác.');
      if (data.value.mst !== state.scope) return;
      state.partners = data.value.rows || [];
      state.partnerSelected.clear();
      els['mst-partners'].hidden = false;
      state.partnerNote = `MST ${data.value.mst}: ${state.partners.length} ${kind === 'supplier' ? 'nhà cung cấp' : 'người mua'} có MST trong hóa đơn đã lưu.`;
      renderPartners();
    } catch (error) {
      if (request === state.partnerRequest) fail(error.message);
    } finally {
      if (request === state.partnerRequest) els['mst-btn-suppliers'].disabled = els['mst-btn-buyers'].disabled = false;
    }
  }

  function parseMstList(text) {
    if (!text) return [];
    const raw = text.split(/[\r\n,\t\s;]+/).map(s => s.trim()).filter(Boolean);
    const cleaned = raw.map(s => s.replace(/[^0-9A-Za-z-]/g, '')).filter(s => s.length >= 8);
    return [...new Set(cleaned)];
  }

  function loadSampleMst() {
    els.mstInput.value = [
      '0100109106', '0100773180', '0101402283', '0100107518',
      '0300588569', '0106888888', '0300432742', '0104938184'
    ].join('\n');
    updateMstCount();
    log('Đã nạp danh sách 8 MST mẫu kiểm thử.', 'info');
  }

  function clearMstList() {
    els.mstInput.value = '';
    state.partnerSelected.clear();
    if (els['mst-partner-body']) renderPartners();
    updateMstCount();
  }

  async function loadCaptcha() {
    if (state.isLoadingCaptcha) return;
    state.isLoadingCaptcha = true;
    const scope = state.scope;

    els.captchaLoadingText.classList.remove('hidden');
    els.captchaLoadingText.hidden = false;
    els.captchaLoadingText.innerText = 'Đang nạp mã...';
    els.captchaImg.classList.add('hidden');
    els.captchaImg.hidden = true;
    els.captchaInput.value = '';
    els.btnReloadCaptcha.disabled = true;

    try {
      const res = await featureFetch('/api/mst/lookup/captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      const data = await res.json();
      if (scope && scope !== state.scope) return;
      if (!data.ok) throw new Error(data.error || 'Không lấy được CAPTCHA');

      const { dataUrl, solvedText, solverError } = data.value;
      if (solverError) log('Không tự giải được CAPTCHA: ' + solverError + '. Bạn có thể nhập mã bằng tay.', 'warn');
      state.captchaDataUrl = dataUrl;
      state.captchaSolved = solvedText || '';

      els.captchaImg.src = dataUrl;
      els.captchaImg.hidden = false;
      els.captchaImg.classList.remove('hidden');
      els.captchaLoadingText.hidden = true;
      els.captchaLoadingText.classList.add('hidden');
      els.captchaInput.value = state.captchaSolved;

      if (state.captchaSolved) {
        log(`Tự động giải mã CAPTCHA: "${state.captchaSolved}"`, 'info');
      }
    } catch (err) {
      els.captchaLoadingText.innerText = 'Lỗi tải mã (Bấm để thử lại)';
      els.captchaLoadingText.hidden = false;
      els.captchaLoadingText.classList.remove('hidden');
      log(`Lỗi tải CAPTCHA: ${err.message}`, 'error');
    } finally {
      state.isLoadingCaptcha = false;
      els.btnReloadCaptcha.disabled = false;
    }
  }

  async function startSearch() {
    if (state.isSearching) return;

    const mstList = selectedMsts();
    if (mstList.length === 0) {
      fail('Vui lòng nhập ít nhất 1 Mã Số Thuế hợp lệ!');
      return;
    }

    const captchaCode = els.captchaInput.value.trim();
    if (!captchaCode) {
      fail('Đang giải CAPTCHA hoặc chưa có mã. Vui lòng kiểm tra lại!');
      return;
    }

    state.operationScope = state.scope;
    state.isSearching = true;
    state.shouldStop = false;
    state.results = [];
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
    els.btnExportExcel.disabled = true;
    els.btnClearResults.disabled = true;
    els.progressSection.hidden = false;
    els.progressFill.style.width = '0%';
    els.resultsEmpty.classList.remove('hidden');
    els.resultsBody.innerHTML = '';

    clearResultsUI();

    try {
      log(`Bắt đầu tra cứu ${mstList.length} MST...`, 'info');

      const res = await featureFetch('/api/mst/lookup/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mstList, captchaCode })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Tra cứu thất bại');

      // Poll for progress
      await pollProgress();
    } catch (err) {
      log(`Lỗi tra cứu: ${err.message}`, 'error');
      fail(`Lỗi: ${err.message}`);
    } finally {
      state.operationScope = null;
      state.isSearching = false;
      els.btnStart.disabled = false;
      els.btnStop.disabled = true;
      els.btnExportExcel.disabled = state.results.length === 0;
      els.btnClearResults.disabled = false;
    }
  }

  function stopSearch() {
    featureFetch('/api/mst/lookup/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ mst: getSelectedMst() })
    }).catch(() => {});
    log('Đang dừng tiến trình tra cứu...', 'warn');
  }

  async function pollProgress() {
    while (state.isSearching) {
        const res = await featureFetch('/api/mst/lookup/progress?mst=' + encodeURIComponent(getSelectedMst()), {
          credentials: 'include'
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Không đọc được tiến độ.');
        if (data.value) {
          updateProgressUI(data.value);
          if (data.value.stage === 'error') throw new Error(data.value.error || data.value.message);
          if (['complete', 'stopped'].includes(data.value.stage)) return data.value;
        }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  function updateProgressUI(p) {
    const total = Number(p.total) || 0;
    if (Array.isArray(p.rows)) renderResults(p.rows);
    els.progressText.innerText = p.message || 'Đang tra cứu...';
    if (p.stage === 'start' || p.stage === 'query') {
      els.progressText.innerText = p.message || 'Đang tra cứu...';
      const pct = total > 0 ? Math.round((p.done / total) * 100) : 0;
      els.progressFill.style.width = `${pct}%`;
      els.progressDetail.innerText = `${pct}% (${p.done}/${p.total})`;
    } else if (p.stage === 'progress') {
      const pct = total > 0 ? Math.round((p.done / total) * 100) : 0;
      els.progressFill.style.width = `${pct}%`;
      els.progressDetail.innerText = `${pct}% (${p.done}/${total})`;
      
    } else if (p.stage === 'complete') {
      els.progressFill.style.width = '100%';
      els.progressText.innerText = p.message || 'Hoàn thành';
      els.progressDetail.innerText = '100%';
    }
  }

  function appendResultRow(item, index) {
    els.resultsEmpty.classList.add('hidden');
    const tr = document.createElement('tr');
    
    let badgeClass = 'badge-status-other';
    if (item.found && !item.statusUnknown) {
      badgeClass = (item.tThai.includes('đang hoạt động') || item.tThai.includes('Đang hoạt động'))
        ? 'badge-status-active'
        : 'badge-status-inactive';
    }

    item = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, typeof v === 'string' ? escapeHtml(v) : v]));
    tr.innerHTML = `
      <td>${index}</td>
      <td><strong>${item.mst}</strong></td>
      <td>${item.ten || '—'}</td>
      <td><span class="badge-status ${badgeClass}">${item.tThai}</span></td>
      <td>${item.cThue || '—'}</td>
      <td>${item.dChi || '—'}</td>
    `;
    els.resultsBody.appendChild(tr);
  }

  function clearResultsUI() {
    els.resultsBody.innerHTML = '';
    els.resultsEmpty.classList.remove('hidden');
    els.badgeTotal.innerText = 0;
    els.badgeActive.innerText = 0;
    els.badgeInactive.innerText = 0;
    els.badgeNotFound.innerText = 0;
    els.badgeError.innerText = 0;
  }

  function renderResults(data) {
    state.results = Array.isArray(data) ? data : [];
    clearResultsUI();
    state.results.forEach((row, i) => appendResultRow(row, i + 1));
    els.badgeTotal.innerText = state.results.length;
    els.badgeActive.innerText = state.results.filter(r => r.found && /đang hoạt động/i.test(r.tThai)).length;
    els.badgeInactive.innerText = state.results.filter(r => r.found && !r.statusUnknown && !/đang hoạt động/i.test(r.tThai)).length;
    els.badgeNotFound.innerText = state.results.filter(r => !r.found && !r.error).length;
    els.badgeError.innerText = state.results.filter(r => r.error).length;
    if (els.resultsCount) els.resultsCount.textContent = `${state.results.length} MST`;
  }

  function clearResults() {
    state.results = [];
    clearResultsUI();
    els.progressFill.style.width = '0%';
    els.progressText.innerText = 'Sẵn sàng tra cứu';
    els.progressDetail.innerText = '0%';
  }

  async function exportExcel() {
    if (state.results.length === 0) {
      fail('Chưa có kết quả để xuất Excel!');
      return;
    }
    try {
      const res = await featureFetch('/api/mst/lookup/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mst: getSelectedMst(), filename: 'Tra_Cuu_MST.xlsx' })
      });
      const data = await res.json();
      if (data.ok) {
        log(`Đã xuất file Excel: ${data.value.filename}`, 'ok');
      } else {
        throw new Error(data.error);
      }
    } catch (err) {
      log(`Lỗi xuất Excel: ${err.message}`, 'error');
      fail(`Lỗi: ${err.message}`);
    }
  }

  function clearLog() {
    els.logContainer.innerHTML = '<div class="log-entry log-info"><span class="log-time">--:--:--</span><span>Đã xóa nhật ký.</span></div>';
  }

  function log(msg, type = 'info') {
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN');
    const div = document.createElement('div');
    div.className = `log-entry log-${type}`;
    div.innerHTML = `<span class="log-time">${time}</span><span>${escapeHtml(msg)}</span>`;
    if (els.logContainer) {
      els.logContainer.prepend(div);
    }
  }

  // Báo lỗi ra LƯỚI AN TOÀN của app (toast góc phải) thay vì alert() native — toàn app đã bỏ
  // alert/confirm/prompt, và hộp native che app, không tự tắt, không đọc được bằng trình đọc màn hình.
  function fail(message) {
    if (window.noticeFail) window.noticeFail(String(message || ''));
    else if (window.notice) window.notice(String(message || ''));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  }
  function getSelectedMst() {
    return state.scope || '';
  }


  async function featureFetch(url, options = {}) {
    if (!state.scope) {
      const response = await fetch('/api/state', { credentials: 'include' });
      const data = await response.json();
      if (!data.ok || !data.value.selected) throw new Error('Chọn MST trước khi sử dụng tab này.');
      state.scope = data.value.selected;
    }
    if (state.operationScope && state.operationScope !== state.scope) throw new Error('MST đã thay đổi. Tra cứu lại trên MST đang chọn.');
    return fetch(url, { ...options, headers: { ...options.headers, 'X-Feature-Mst': state.scope } });
  }
  window.addEventListener('hd:state', event => {
    const selected = event.detail && event.detail.selected || '';
    const changed = state.scope && selected !== state.scope;
    state.scope = selected;
    if (changed && initialized) {
      ++state.partnerRequest;
      state.partners = [];
      state.partnerNote = '';
      state.partnerSelected.clear();
      els.mstInput.value = '';
      if (els['mst-partners']) {
        els['mst-partners'].hidden = true;
        els['mst-btn-suppliers'].disabled = els['mst-btn-buyers'].disabled = false;
        renderPartners();
      }
      clearResults();
      state.captchaSolved = '';
      els.captchaInput.value = '';
      els.captchaImg.classList.add('hidden');
      els.captchaLoadingText.classList.remove('hidden');
      els.captchaLoadingText.innerText = 'Bấm để lấy CAPTCHA cho MST đang chọn';
    }
  });

  // Khởi tạo đúng MỘT lần. data-ui.js gọi ensureInit() mỗi lần bấm tab, nên phải
  // chống gọi lại — nếu không sẽ gắn trùng listener và tải CAPTCHA liên tục.
  let initialized = false;
  function ensureInit() {
    if (initialized) return;
    if (!document.getElementById('mst-input')) return; // pane chưa có trong DOM
    initialized = true;
    init();
  }

  window.MstLookupUI = { ensureInit, init: ensureInit };
})();
