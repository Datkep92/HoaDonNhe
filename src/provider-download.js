'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const CDP = require('chrome-remote-interface');
const original = require('./data/original-pdf');
const runner = fs.readFileSync(path.join(__dirname, 'provider-reference', 'generic-runner.js'), 'utf8');
const captchaPanel = fs.readFileSync(path.join(__dirname, 'provider-reference', 'captcha-panel.js'), 'utf8');
const misaRunner = fs.readFileSync(path.join(__dirname, 'provider-reference', 'misa-runner.js'), 'utf8');
const misaAdapter = fs.readFileSync(path.join(__dirname, 'provider-reference', 'misa-adapter.js'), 'utf8');
const sessions = new Map();
const TTL = 10 * 60 * 1000;
let opening = false;
const sweeper = setInterval(() => {
  for (const [id, item] of sessions) if (Date.now() - item.at > TTL) removeSession(id);
}, 30000);
sweeper.unref();

function messageFor(row) {
  return {
    type: 'GENERIC_PROVIDER_STAGE', mode: 'download', providerId: row.provider_id || '',
    lookupCode: row.lookup_code || '', sellerTaxCode: row.mst_ban || '', buyerTaxCode: row.mst_mua || '',
    templateCode: row.khms_hd || '', series: row.khh_hd || '', number: String(row.so_hd || ''),
    date: row.ngay_lap || '', lookupUrl: original.cleanPortalUrl(row.lookup_url),
    filename: 'hoa-don-goc.pdf', providerName: row.provider_name || '', invoiceKey: row.invoice_key,
  };
}

async function invoke(browser, tabId, message) {
  const client = await CDP({ host: '127.0.0.1', port: browser.portalPort, target: tabId });
  let timer;
  try {
    await client.Page.enable();
    const { frameTree } = await client.Page.getFrameTree();
    const host = new URL(frameTree.frame.url).hostname;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) || /\.(local|internal|localhost)$/i.test(host)) throw new Error('Cổng chuyển sang tên miền không được phép.');
    // The extension runtime is private to an isolated world, never exposed to the portal page.
    const { executionContextId } = await client.Page.createIsolatedWorld({ frameId: frameTree.frame.id, worldName: 'cn-original-pdf' });
    const expression = `(() => {
      if (!globalThis.${message.providerId === 'misa' ? '__cnMisaHandler' : '__cnProviderHandler'}) {
        globalThis.chrome = { runtime: {
          onMessage: { addListener: fn => globalThis.__cnProviderHandler = fn },
          sendMessage: async value => {
            if(value.type === 'PROVIDER_ASSIST_DOWNLOAD') {
              globalThis.__cnDownloaded = value.result;
              return {ok:true};
            }
            if(value.type === 'MISA_ASSIST_DOWNLOAD') {
              try { globalThis.__cnDownloaded = await globalThis.__cnFetchMisa(value.sourceUrl); return {ok:true}; }
              catch(error) { return {ok:false,error:error.message}; }
            }
          }
        } };
        ${message.providerId === 'misa' ? '' : runner}
        globalThis.chrome.runtime.onMessage.addListener = fn => globalThis.__cnMisaHandler = fn;
        ${misaRunner}
        ${misaAdapter}
        ${captchaPanel}
      }
      const message = ${JSON.stringify(message)};
      if (message.stage === 'captcha') return globalThis.__cnCaptchaPanel.challenge();
      if (message.stage === 'captcha-preview') return globalThis.__cnCaptchaPanel.preview(message);
      if (message.stage === 'captcha-fill') return globalThis.__cnCaptchaPanel.fill(message);
      if (globalThis.__cnInvoiceKey !== message.invoiceKey) {
        globalThis.__cnDownloaded = null;
        globalThis.__cnMisaSource = '';
        globalThis.__cnAssistInstalled = false;
        globalThis.__cnInvoiceKey = message.invoiceKey;
      }
      if (message.stage === 'dispose') {
        document.getElementById('invoice-vault-captcha-close')?.click();
        document.getElementById('invoice-vault-misa-assist')?.remove();
        globalThis.__cnDownloaded = null;
        return {};
      }
      if (message.stage === 'scan' && globalThis.__cnDownloaded) return globalThis.__cnDownloaded;
      if (message.providerId === 'misa') {
        return globalThis.__cnMisaStage(message).then(value => { globalThis.__cnCaptchaPanel.enhance(); return value; });
      }
      if (message.stage === 'scan' && !globalThis.__cnAssistInstalled) {
        globalThis.__cnAssistInstalled = true;
        globalThis.__cnProviderHandler({...message,stage:'install-assist',restoredAfterNavigation:true}, {}, () => {});
      }
      return new Promise(resolve => globalThis.__cnProviderHandler(message, {}, value => {
        globalThis.__cnCaptchaPanel.enhance();
        resolve(value);
      }));
    })()`;
    const result = await Promise.race([
      client.Runtime.evaluate({ expression, contextId: executionContextId, awaitPromise: true, returnByValue: true, userGesture: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cổng NCC phản hồi quá lâu. Thử lại sau.')), 30000); }),
    ]);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value || {};
  } finally { clearTimeout(timer); await client.close().catch(() => {}); }
}

async function start(browser, row, dir) {
  if (opening) throw new Error('Đang mở cổng NCC cho hóa đơn khác. Hãy chờ rồi thử lại.');
  opening = true;
  try { return await startSession(browser, row, dir); }
  finally { opening = false; }
}

async function startSession(browser, row, dir) {
  for (const [id, item] of sessions) if (Date.now() - item.at > TTL) removeSession(id);
  const message = messageFor(row);
  if (!message.lookupUrl) return { needsProviderUrl: true };
  const portal = new URL(message.lookupUrl);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(portal.hostname) || /\.(local|internal|localhost)$/i.test(portal.hostname) || portal.username || portal.password) {
    throw new Error('Cổng tra cứu phải là tên miền công khai và không chứa mật khẩu trong URL.');
  }
  // Same missing-code rule as 1.4.20; VNPT can query by invoice information.
  if (!message.lookupCode && !['vnpt', 'nacencomm'].includes(message.providerId)) return { needsCode: true };
  // Chrome shares the native download directory: keep one invoice session at a time.
  for (const [id, item] of sessions) {
    if (item.busy) throw new Error('Đang nhận PDF gốc. Hãy chờ vài giây rồi thử lại.');
    await cancel(browser, id, { invoice_key: item.key }, item.dir);
  }
  const tabId = await browser.openAuxPortal(message.lookupUrl);
  for (const [previousId, item] of sessions) if (item.tabId === tabId) removeSession(previousId);
  const id = crypto.randomUUID();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-original-'));
  sessions.set(id, { tabId, message, key: row.invoice_key, dir, downloadDir, at: Date.now(), busy: false });
  try {
    const client = await CDP({ host: '127.0.0.1', port: browser.portalPort, target: tabId });
    sessions.get(id).downloadClient = client;
    try { await client.Page.setDownloadBehavior({ behavior: 'allow', downloadPath: downloadDir }); }
    catch (error) { await client.close(); throw error; }
    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        result = await invoke(browser, tabId, { ...message, stage: 'prepare' });
        if (result.needsCode || result.requiresUser || result.navigationStarted || result.prepared) break;
        if (attempt === 5) throw new Error(result.error || 'Cổng chưa hiện biểu mẫu tra cứu.');
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      catch (error) { if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, 700)); }
    }
    if (result.needsCode) { removeSession(id); return result; }
    if (result.requiresUser) await invoke(browser, tabId, { ...message, stage: 'install-assist' });
    if (result.requiresUser) await solveCaptcha(browser, sessions.get(id));
    return { session: id, requiresUser: !!result.requiresUser, error: result.error || '', prepared: result.prepared };
  } catch (error) { removeSession(id); throw error; }
}

function removeSession(id) {
  const item = sessions.get(id);
  sessions.delete(id);
  if (item?.downloadClient) item.downloadClient.close().catch(() => {});
  if (item?.downloadDir && path.resolve(item.downloadDir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'cn-original-')) {
    try { fs.rmSync(item.downloadDir, { recursive: true, force: true }); } catch { /* browser may still hold an incomplete download */ }
  }
}

async function solveCaptcha(browser, item) {
  try {
    const challenge = await invoke(browser, item.tabId, { ...item.message, stage: 'captcha' });
    if (!challenge.clip || challenge.clip.width > 1200 || challenge.clip.height > 600) return;
    let data = String(challenge.data || '').split(',')[1];
    try {
      if (!data) {
        const client = await CDP({ host: '127.0.0.1', port: browser.portalPort, target: item.tabId });
        try { ({ data } = await client.Page.captureScreenshot({ format: 'png', clip: challenge.clip, captureBeyondViewport: true })); }
        finally { await client.close(); }
      }
    } finally {
      await invoke(browser, item.tabId, { ...item.message, stage: 'captcha-preview', version: challenge.version, data: data ? 'data:image/png;base64,' + data : '' }).catch(() => {});
    }
    if (challenge.hasValue || !data) return;
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (item.captchaHash === hash) return;
    item.captchaHash = hash;
    const text = await require('./captcha-solver').solve('data:image/png;base64,' + data);
    if (text) await invoke(browser, item.tabId, { ...item.message, stage: 'captcha-fill', version: challenge.version, src: challenge.src, text });
  } catch { /* OCR is optional; the mirrored field remains editable. */ }
}

function nativeResult(item) {
  for (const name of fs.readdirSync(item.downloadDir)) {
    if (!/\.pdf$/i.test(name)) continue;
    const file = path.join(item.downloadDir, name);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) continue;
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') continue;
    return { ok: true, downloadDataUrl: 'data:application/pdf;base64,' + bytes.toString('base64'), bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  return null;
}

function savePdf(dir, row, result) {
  if (!/^data:application\/pdf;base64,/.test(result.downloadDataUrl || '')) throw new Error('Cổng chưa trả PDF gốc.');
  if (result.downloadDataUrl.length > 70 * 1024 * 1024) throw new Error('PDF vượt giới hạn 50 MB.');
  const bytes = Buffer.from(result.downloadDataUrl.split(',')[1], 'base64');
  if (bytes.length > 50 * 1024 * 1024) throw new Error('PDF vượt giới hạn 50 MB.');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Dữ liệu tải về không phải PDF.');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!result.sha256 || hash !== result.sha256 || bytes.length !== result.bytes) throw new Error('PDF không khớp kết quả kiểm tra của cổng.');
  const folder = path.join(dir, row.direction === 'SELL' ? 'Ban_ra' : 'Mua_vao', original.ORIGINAL_FOLDER);
  fs.mkdirSync(folder, { recursive: true });
  const safeKey = original.fileKey(row.mst_ban, row.khms_hd, row.khh_hd, row.so_hd).replace(/[^a-z0-9_-]/gi, '_');
  const file = path.join(folder, `${safeKey}_${hash.slice(0, 12)}.pdf`);
  fs.writeFileSync(file, bytes);
  return original.toRelative(dir, file);
}

async function scan(browser, id, row, dir) {
  const item = sessions.get(id);
  if (!item || item.key !== row.invoice_key || item.dir !== dir || Date.now() - item.at > TTL) {
    throw new Error('Phiên tra cứu đã hết hạn hoặc thuộc hồ sơ khác. Bấm tải lại.');
  }
  if (item.busy) return { pending: true };
  item.busy = true;
  try {
    await solveCaptcha(browser, item);
    const result = nativeResult(item) || await invoke(browser, item.tabId, { ...item.message, stage: 'scan' });
    if (sessions.get(id) !== item) return { cancelled: true };
    if (result.ok && result.downloadDataUrl) {
      const relative = savePdf(dir, row, result);
      await invoke(browser, item.tabId, { ...item.message, stage: 'dispose' }).catch(() => {});
      removeSession(id);
      return { downloaded: true, relative };
    }
    // Some portals navigate to a dedicated viewer instead of embedding it.
    if (result.viewerUrl && !item.followed) {
      const viewer = new URL(result.viewerUrl, item.message.lookupUrl);
      if (viewer.origin === new URL(item.message.lookupUrl).origin) {
        item.followed = true;
        const client = await CDP({ host: '127.0.0.1', port: browser.portalPort, target: item.tabId });
        try { await client.Page.navigate({ url: viewer.href }); } finally { await client.close(); }
      }
    }
    return { pending: true, error: result.error || '' };
  } catch (error) {
    if (/context.*(destroyed|not found)|Cannot find context|Inspected target navigated/i.test(error.message)) return { pending: true };
    removeSession(id);
    throw error;
  } finally { item.busy = false; }
}

async function cancel(browser, id, row, dir) {
  const item = sessions.get(id);
  if (!item || item.key !== row.invoice_key || item.dir !== dir) return { cancelled: true };
  await invoke(browser, item.tabId, { ...item.message, stage: 'dispose' }).catch(() => {});
  removeSession(id);
  return { cancelled: true };
}

module.exports = { start, scan, cancel, savePdf, messageFor };
