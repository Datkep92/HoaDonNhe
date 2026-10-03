(() => {
  if (globalThis.__cnMisaStage) return;
  globalThis.__cnFetchMisa = async source => {
    const url = new URL(source);
    if (!/^(www\.)?meinvoice\.vn$/i.test(url.hostname) || !/\/DownloadHandler\.ashx$/i.test(url.pathname)) throw new Error('Đường dẫn PDF MISA không hợp lệ.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url.href, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error('MISA chưa trả PDF gốc.');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 50 * 1024 * 1024) { await reader.cancel(); throw new Error('PDF vượt giới hạn 50 MB.'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Error('MISA chưa trả PDF gốc.');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return { ok: true, downloadDataUrl: 'data:application/pdf;base64,' + btoa(binary), bytes: size,
        sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
    } finally { clearTimeout(timer); }
  };
  globalThis.__cnMisaStage = async message => {
    if (message.stage === 'prepare') {
      globalThis.__cnMisaSource = '';
      globalThis.__cnDownloaded = null;
      await new Promise((resolve, reject) => {
        const ready = () => document.querySelector('#txtCode') && document.querySelector('#btnSearchInvoice');
        if (ready()) { resolve(); return; }
        const observer = new MutationObserver(() => {
          if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(); }
        });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Không tìm thấy biểu mẫu tra cứu MISA.')); }, 14000);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      });
      document.querySelectorAll('#pnResult iframe, #frmResult').forEach(frame => frame.removeAttribute('src'));
      const result = await new Promise(resolve => globalThis.__cnMisaHandler({ type: 'MISA_ORIGINAL_PDF', mode: 'download', code: message.lookupCode }, {}, resolve));
      if (result.sourceUrl) globalThis.__cnMisaSource = result.sourceUrl;
      if (result.error && !result.requiresUser) throw new Error(result.error);
      return { ...result, prepared: true };
    }
    if (message.stage === 'scan') {
      const src = document.querySelector('#pnResult iframe, #frmResult')?.getAttribute('src') || '';
      let source = globalThis.__cnMisaSource || '';
      if (/DownloadHandler\.ashx/i.test(src)) {
        const params = new URL(src, location.href).searchParams;
        params.set('Type', 'pdf'); params.set('Code', message.lookupCode);
        source = 'https://www.meinvoice.vn/tra-cuu/DownloadHandler.ashx?' + params;
      }
      if (source) {
        try { return await globalThis.__cnFetchMisa(source); }
        catch (error) { return { pending: true, error: error.message }; }
      }
      return { pending: true };
    }
    return {};
  };
})();
