'use strict';
(function () {
  const $ = id => document.getElementById(id);
  if (!$('review-workspace')) return;
  const state = { mst: '', output: '', range: {}, value: null, version: 0, busy: false, issue: null, issuePage: 0, collection: false, timer: null };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const number = value => value == null ? '—' : Number(value).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  const labels = { todo: 'Cần xử lý', inprogress: 'Đang xử lý', done: 'Đã xử lý', ignored: 'Không áp dụng' };
  const validRange = () => !!(state.mst && state.output && state.range.from && state.range.to);
  function message(text, bad = false) { $('review-status').textContent = text; $('review-status').style.color = bad ? '#b91c1c' : ''; }
  function controls() {
    for (const id of ['review-check', 'review-refresh', 'review-collect', 'review-save-settings', 'review-save-comparison', 'review-bank-add']) $(id).disabled = !validRange() || state.busy || state.collection;
    $('review-export').disabled = !state.value?.checked || state.value.stale || state.busy || state.collection;
    $('review-close-period').disabled = !state.value?.checked || state.value.stale || state.busy || state.collection || state.value.issues.some(issue => !['done', 'ignored'].includes(issue.state));
    $('review-collect-stop').disabled = !state.collection;
  }
  async function request(action, body, method = 'POST', ticket = state.version) {
    if (ticket !== state.version) throw new Error('Hồ sơ đã thay đổi; bỏ thao tác cũ.');
    if (!state.mst) throw new Error('Chọn MST trước.');
    const scope = state.mst;
    const query = new URLSearchParams({ from: state.range.from || '', to: state.range.to || '' });
    const url = action.startsWith('/') ? action : '/api/review/' + action + (method === 'GET' ? '?' + query : '');
    const response = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Feature-Mst': scope }, ...(body === undefined ? {} : { body: JSON.stringify({ ...state.range, ...body }) }) });
    if (ticket !== state.version || scope !== state.mst) throw new Error('Hồ sơ đã thay đổi; bỏ phản hồi cũ.');
    let data;
    try { data = await response.json(); } catch { throw new Error('Ứng dụng trả phản hồi không hợp lệ; kiểm tra phiên và khởi động lại bản mã nguồn.'); }
    if (!data.ok) throw new Error(data.error || 'Không thực hiện được thao tác.');
    return data.value;
  }
  async function operation(text, fn) {
    if (state.busy || state.collection) return;
    const ticket = state.version;
    state.busy = true; controls(); message(text);
    try { await fn(ticket); }
    catch (error) { if (ticket === state.version) message(error.message, true); }
    finally { if (ticket === state.version) { state.busy = false; controls(); } }
  }
  function populateSettings(config) {
    for (const [name, id] of [['buyComplete', 'buy-complete'], ['sellComplete', 'sell-complete'], ['requireVat', 'require-vat'], ['requirePdf', 'require-pdf'], ['requireBank', 'require-bank']]) $('review-' + id).checked = !!config[name];
    $('review-actor').value = config.actor || '';
    $('review-adjustment-note').value = config.adjustmentNote || '';
    $('review-acceptance-note').value = config.acceptanceNote || '';
    for (const code of ['ct23', 'ct24', 'ct34', 'ct35']) $('review-adjust-' + code).value = config.adjustments?.[code] || 0;
  }
  function render(value) {
    if (value.mst !== state.mst) return;
    state.value = value;
    const config = value.config || {};
    populateSettings(config);
    if (value.coverage) { $('review-buy-complete').checked = !!value.coverage.BUY; $('review-sell-complete').checked = !!value.coverage.SELL; }
    const issues = value.issues || [], open = issues.filter(issue => !['done', 'ignored'].includes(issue.state));
    const metrics = value.checked ? [
      ['CẦN XỬ LÝ', open.length], ['THIẾU DỮ LIỆU', open.filter(issue => issue.severity === 'blocking').length],
      ['HÓA ĐƠN ĐÃ KIỂM TRA', value.invoiceCount], ['MỤC ĐÃ XỬ LÝ', issues.length - open.length],
    ] : [['CHƯA KIỂM TRA', '—'], ['ĐỘ ĐẦY ĐỦ', 'Chưa xác nhận'], ['ĐỐI CHIẾU', 'Chưa chạy'], ['CHỐT KỲ', 'Chưa chốt']];
    $('review-metrics').innerHTML = metrics.map(([label, amount]) => `<div class="review-metric"><span>${label}</span><strong>${esc(typeof amount === 'number' ? number(amount) : amount)}</strong></div>`).join('');
    $('review-completeness').textContent = value.checked ? `Chứng từ đang lưu: XML ${number(value.counts?.invoiceXml)}/${number(value.invoiceCount)} hóa đơn · PDF gốc ${number(value.counts?.invoicePdf)}/${number(value.invoiceCount)} ${config.requirePdf ? '(yêu cầu)' : '(không yêu cầu)'} · ${number(value.counts?.declarations)} tờ khai trong kỳ · ${number(value.bankCount)} giao dịch ngân hàng. Đủ kỳ mua vào: ${value.coverage?.BUY ? 'đã xác nhận' : 'chưa xác nhận'}; bán ra: ${value.coverage?.SELL ? 'đã xác nhận' : 'chưa xác nhận'}.` : 'Độ đầy đủ chứng từ: chưa kiểm tra.';
    $('review-bank-originals').textContent = value.bankOriginals?.length ? value.bankOriginals.map(file => `${file.fileName} · ${file.verifiedImport ? 'Khớp tệp đã nhập' : 'Người dùng xác nhận, chưa khớp dữ liệu đã nhập'} · ${file.actor}: ${file.note}`).join('\n') : 'Chưa có sao kê gốc bổ sung; gói xuất chỉ có bảng giao dịch ngân hàng đã nhập.';
    if (!value.checked) message('Chưa kiểm tra kỳ này. Bấm Kiểm tra hồ sơ; dữ liệu thiếu không được coi là 0 lỗi.');
    else {
      const closed = value.lastClosed ? ` · ${value.lastClosed.current && !value.stale ? 'Đã chốt kỳ' : 'Lần chốt cũ'}: ${new Date(value.lastClosed.created_at).toLocaleString('vi-VN')} (${value.lastClosed.actor})` : ' · Chưa chốt kỳ';
      message((value.stale ? 'Dữ liệu/phạm vi đã thay đổi. Chạy kiểm tra lại; lần chốt cũ không xác nhận dữ liệu hiện tại. ' : '') + `Kiểm tra lúc ${new Date(value.checkedAt).toLocaleString('vi-VN')} · ${open.length} mục chưa hoàn tất` + closed, value.stale);
    }
    const docs = value.declarations || [];
    $('review-declaration').innerHTML = '<option value="">' + (docs.length ? 'Chọn phiên bản cần đối chiếu' : 'Chưa có XML 01/GTGT đúng kỳ') + '</option>' + docs.map(doc => `<option value="${esc(doc.id)}">${esc(doc.type === 'B' ? 'Bổ sung lần ' + doc.amendment : 'Chính thức')} · ${esc(doc.period)} · ${esc(doc.date || 'Chưa rõ ngày lập')} · ${esc(doc.dossier || doc.relative)}</option>`).join('');
    $('review-declaration').value = config.selectedDeclaration || value.selectedDeclaration?.id || '';
    const selected = value.selectedDeclaration;
    $('review-accepted').checked = !!selected && config.acceptedDeclaration === selected.id;
    $('review-declaration-info').textContent = selected ? `${selected.name} · XML ${selected.version || 'chưa rõ phiên bản'} · Trạng thái cổng: ${selected.portalStatus || 'Chưa ghi nhận'} · ${selected.relative}${selected.entry ? ' → ' + selected.entry : ''}` : 'Chỉ đối chiếu tờ khai có MST và kỳ khớp; không tự chọn/cộng các lần bổ sung.';
    $('review-comparisons').innerHTML = (value.comparisons || []).map(row => {
      const reviewed = issues.find(issue => issue.id === 'vat:difference:' + row.code);
      const resolved = reviewed && ['done', 'ignored'].includes(reviewed.state);
      const label = row.status === 'matched' ? 'Khớp số liệu' : row.status === 'difference' ? resolved ? 'Đã giải trình' : 'Cần giải trình' : 'Chưa đủ dữ liệu';
      return `<tr><td>[${esc(row.code.slice(2))}] ${esc(row.label)}<span class="review-reason">${number(row.count)} hóa đơn; loại ${number(row.excluded)} theo trạng thái${resolved ? ' · ' + esc(reviewed.note) : ''}</span></td><td>${number(row.declared)}</td><td>${number(row.invoices)}</td><td>${number(row.adjustment)}</td><td>${number(row.difference)}</td><td><span class="review-pill ${row.status === 'matched' || resolved ? 'review-ready' : 'review-blocking'}">${label}</span></td></tr>`;
    }).join('');
    $('review-history').textContent = (value.history || []).map(row => `${new Date(row.created_at).toLocaleString('vi-VN')} · ${row.actor || 'Hệ thống'} · ${{ checked: 'Kiểm tra hồ sơ', review: 'Cập nhật xử lý', settings: 'Lưu phạm vi/giải trình', evidence_changed: 'Chứng cứ thay đổi, mở lại vấn đề', closed: 'Chốt kỳ', exported: 'Xuất hồ sơ' }[row.action] || row.action}\n${row.details}`).join('\n\n') || 'Chưa có lịch sử.';
    if (value.notice) $('review-notice').textContent = value.notice;
    renderIssues(); controls();
  }
  function renderIssues() {
    const kind = $('review-filter-kind').value, status = $('review-filter-state').value;
    const issues = (state.value?.issues || []).filter(issue => (!kind || issue.kind === kind) && (!status || (status === 'open' ? !['done', 'ignored'].includes(issue.state) : issue.state === status))).sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking'));
    state.issuePage = Math.max(0, Math.min(state.issuePage, Math.ceil(issues.length / 100) - 1));
    const start = state.issuePage * 100;
    $('review-issues').innerHTML = issues.slice(start, start + 100).map(issue => `<tr><td><strong>${esc(issue.title)}</strong><span class="review-reason">${esc(issue.reason)}</span>${issue.note ? `<span class="review-reason">Kết luận: ${esc(issue.note)}</span>` : ''}</td><td><span class="review-pill ${issue.severity === 'blocking' ? 'review-blocking' : ''}">${issue.severity === 'blocking' ? 'Thiếu dữ liệu' : 'Cần xem lại'}</span></td><td>${esc(labels[issue.state])}</td><td>${esc(issue.assignee || 'Chưa phân công')}</td><td><button type="button" data-review-issue="${esc(issue.id)}">Xem / xử lý</button></td></tr>`).join('');
    $('review-issues-page').textContent = issues.length ? `${start + 1}–${Math.min(start + 100, issues.length)} / ${number(issues.length)} mục` : '0 mục trong bộ lọc';
    $('review-issues-prev').disabled = !state.issuePage;
    $('review-issues-next').disabled = start + 100 >= issues.length;
    $('review-empty').hidden = issues.length > 0;
    $('review-empty').textContent = !state.value?.checked ? 'Chưa kiểm tra hồ sơ.' : state.value.stale ? 'Kết quả cũ cần được kiểm tra lại.' : 'Không có mục phù hợp bộ lọc hiện tại.';
  }
  function configFromForm() {
    const selected = $('review-declaration').value;
    return {
      buyComplete: $('review-buy-complete').checked, sellComplete: $('review-sell-complete').checked,
      requireVat: $('review-require-vat').checked, requirePdf: $('review-require-pdf').checked, requireBank: $('review-require-bank').checked,
      actor: $('review-actor').value.trim(), selectedDeclaration: selected,
      acceptedDeclaration: $('review-accepted').checked ? selected : '', acceptanceNote: $('review-acceptance-note').value.trim(),
      adjustmentNote: $('review-adjustment-note').value.trim(), adjustments: Object.fromEntries(['ct23', 'ct24', 'ct34', 'ct35'].map(code => [code, Number($('review-adjust-' + code).value)])),
    };
  }
  async function saveAndCheck(ticket) { await request('settings', { config: configFromForm() }, 'POST', ticket); render(await request('check', {}, 'POST', ticket)); }
  async function refresh() {
    if (!validRange()) { resetPanel(); return; }
    await operation('Đọc hồ sơ kiểm tra đã lưu…', async ticket => {
      render(await request('snapshot', undefined, 'GET', ticket));
      const progress = await request('progress', undefined, 'GET', ticket);
      if (progress.running) { state.collection = true; controls(); scheduleProgress(ticket); }
      else if (progress.stage === 'captcha') showCaptcha(progress);
    });
  }
  function resetPanel() {
    state.value = null;
    render({ mst: state.mst, checked: false, config: { requireVat: true }, issues: [], history: [] });
    $('review-scope').textContent = state.mst ? `MST ${state.mst} · ${state.range.from && state.range.to ? state.range.from + ' → ' + state.range.to : 'Chọn tháng/quý hoặc khoảng ngày để kiểm tra'}` : 'Chọn MST và kỳ cần kiểm tra.';
    if (!validRange()) message('Chọn MST, thư mục lưu và khoảng ngày trước khi kiểm tra hồ sơ.');
    controls();
  }
  function changed() {
    state.version++; state.busy = false; state.collection = false; state.issue = null; state.issuePage = 0;
    clearTimeout(state.timer);
    if ($('review-dialog').open) $('review-dialog').close();
    $('review-captcha').hidden = true; $('review-captcha-code').value = '';
    $('review-bank-file').value = ''; $('review-bank-note').value = '';
    $('review-submitted-from').value = state.range.from || '';
    const date = new Date(), today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    $('review-submitted-to').value = today;
    resetPanel(); void refresh();
  }
  function showCaptcha(progress) { $('review-captcha').hidden = false; $('review-captcha-image').src = progress.dataUrl; message(progress.message + (progress.solverError ? ' ' + progress.solverError : '')); }
  function scheduleProgress(ticket) { clearTimeout(state.timer); state.timer = setTimeout(() => void pollProgress(ticket), 1000); }
  async function pollProgress(ticket) {
    if (ticket !== state.version) return;
    try {
      const progress = await request('progress', undefined, 'GET', ticket);
      message(progress.message || 'Đang tải và kiểm tra hồ sơ…', progress.stage === 'error');
      if (progress.running) { scheduleProgress(ticket); return; }
      state.collection = false;
      if (progress.stage === 'captcha') showCaptcha(progress);
      else {
        $('review-captcha').hidden = true; $('review-captcha-code').value = '';
        if (progress.snapshot) render(progress.snapshot);
        message(progress.message + (progress.warnings?.length ? '\n' + progress.warnings.join('\n') : ''), progress.stage === 'error');
      }
    } catch (error) { if (ticket === state.version) { state.collection = false; message(error.message, true); } }
    finally { if (ticket === state.version) controls(); }
  }
  function openIssue(id) {
    const issue = state.value?.issues.find(issue => issue.id === id);
    if (!issue) return;
    state.issue = issue;
    $('review-issue-title').textContent = issue.title;
    $('review-issue-reason').textContent = issue.reason;
    $('review-issue-evidence').textContent = JSON.stringify(issue.evidence, null, 2);
    $('review-issue-state').value = issue.state;
    for (const option of $('review-issue-state').options) option.disabled = issue.severity === 'blocking' && ['done', 'ignored'].includes(option.value);
    $('review-issue-assignee').value = issue.assignee || '';
    $('review-issue-note').value = issue.note || '';
    $('review-issue-status').textContent = state.value.stale ? 'Dữ liệu đã thay đổi. Kiểm tra lại trước khi lưu kết luận.' : '';
    $('review-dialog').showModal();
  }
  async function openSource() {
    const target = state.issue?.target;
    if (!target) return;
    $('review-dialog').close();
    if (target.invoice && window.HD_DATA_VIEW?.openInvoice) { await window.HD_DATA_VIEW.openInvoice(target.invoice); return; }
    if (target.file) { await request('/api/open-file', { path: target.file }); return; }
    if (target.view) window.HD_DATA_VIEW?.show(target.view);
  }
  $('review-refresh').onclick = refresh;
  $('review-check').onclick = () => operation('Đang kiểm tra chứng từ và đọc tờ khai…', async ticket => render(await request('check', {}, 'POST', ticket)));
  $('review-save-settings').onclick = $('review-save-comparison').onclick = () => operation('Lưu phạm vi và đối chiếu lại…', saveAndCheck);
  $('review-declaration').onchange = () => { $('review-accepted').checked = false; $('review-acceptance-note').value = ''; message('Bấm Lưu và đối chiếu lại để dùng phiên bản vừa chọn.'); };
  $('review-export').onclick = () => operation('Đang đóng gói chứng từ gốc và bảng kiểm tra…', async ticket => {
    const result = await request('export', {}, 'POST', ticket);
    message(`Đã lưu ${result.path}\n${result.files} tệp chứng từ; ${result.unresolved} mục chưa hoàn tất. Gói hồ sơ được lưu trên máy.`);
    if (window.notice) window.notice('Đã xuất hồ sơ: ' + result.path);
  });
  $('review-close-period').onclick = () => operation('Đang kiểm tra lại điều kiện chốt kỳ…', async ticket => render(await request('close', { actor: $('review-actor').value.trim() }, 'POST', ticket)));
  $('review-collect').onclick = () => operation('Bắt đầu tải tờ khai và đối chiếu…', async ticket => {
    await request('collect', { portal: $('review-portal').value, submittedFrom: isoDisplay($('review-submitted-from').value), submittedTo: isoDisplay($('review-submitted-to').value), captcha: $('review-captcha-code').value.trim() }, 'POST', ticket);
    state.collection = true; scheduleProgress(ticket); controls();
  });
  function isoDisplay(value) { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value); if (!match) throw new Error('Chọn ngày nộp hợp lệ.'); return `${match[3]}/${match[2]}/${match[1]}`; }
  $('review-collect-stop').onclick = () => { request('stop', {}).then(() => message('Đang ngưng; giữ các tệp đã tải thành công.')).catch(error => message(error.message, true)); };
  $('review-login').onclick = () => window.HD_DATA_VIEW?.show('tokhai');
  $('review-bank-add').onclick = () => $('review-bank-file').click();
  $('review-bank-file').onchange = () => {
    const file = $('review-bank-file').files[0];
    if (!file) return;
    void operation('Đang lưu bản sao sao kê gốc…', async ticket => {
      const actor = $('review-actor').value.trim(), note = $('review-bank-note').value.trim();
      if (!actor || !note) throw new Error('Điền Người kiểm tra và ngân hàng/tài khoản/kỳ sao kê trước khi bổ sung.');
      if (file.size > 13 * 1024 * 1024) throw new Error('Giới hạn sao kê gốc bổ sung là 13 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      const result = await request('attach-bank', { fileName: file.name, dataBase64: btoa(binary), actor, note }, 'POST', ticket);
      render(await request('check', {}, 'POST', ticket));
      message(result.message);
      $('review-bank-file').value = '';
    });
  };
  $('review-filter-kind').onchange = $('review-filter-state').onchange = () => { state.issuePage = 0; renderIssues(); };
  $('review-issues-prev').onclick = () => { state.issuePage--; renderIssues(); };
  $('review-issues-next').onclick = () => { state.issuePage++; renderIssues(); };
  $('review-issues').onclick = event => { const button = event.target.closest('[data-review-issue]'); if (button) openIssue(button.dataset.reviewIssue); };
  $('review-dialog-close').onclick = () => $('review-dialog').close();
  $('review-issue-source').onclick = () => openSource().catch(error => message(error.message, true));
  $('review-issue-form').onsubmit = async event => {
    event.preventDefault();
    if (!state.issue) return;
    const ticket = state.version, issue = state.issue;
    const button = event.submitter; button.disabled = true;
    try {
      const result = await request('issue', { id: issue.id, fingerprint: issue.fingerprint, state: $('review-issue-state').value, note: $('review-issue-note').value, assignee: $('review-issue-assignee').value, actor: $('review-actor').value.trim() }, 'POST', ticket);
      $('review-dialog').close(); render(result);
    } catch (error) { if (ticket === state.version) $('review-issue-status').textContent = error.message; }
    finally { button.disabled = false; }
  };
  window.addEventListener('hd:state', event => {
    const next = event.detail || {};
    if (next.selected !== state.mst || next.output !== state.output) { state.mst = next.selected || ''; state.output = next.output || ''; changed(); }
  });
  window.addEventListener('hd:range', event => {
    const range = event.detail || {};
    if (range.from !== state.range.from || range.to !== state.range.to) { state.range = { from: range.from || '', to: range.to || '' }; changed(); }
  });
  window.addEventListener('hd:view', event => { if (event.detail === 'overview' && !state.busy && !state.collection) void refresh(); });
  state.range = window.HD_DATA_VIEW?.range?.() || {};
  resetPanel();
  fetch('/api/state', { credentials: 'include' }).then(response => response.json()).then(data => {
    if (!data.ok || state.mst) return;
    state.mst = data.value.selected || ''; state.output = data.value.output || ''; changed();
  }).catch(error => message(error.message, true));
  window.AccountingReviewUI = { refresh };
})();
