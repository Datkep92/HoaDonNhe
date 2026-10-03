(function initGenericProviderRunner() {
  "use strict";
  const RUNNER_VERSION = "1.4.17";
  if (globalThis.__invoiceVaultGenericRunnerVersion === RUNNER_VERSION) return;
  globalThis.__invoiceVaultGenericRunnerVersion = RUNNER_VERSION;

  function candidates(message = {}) {
    const found = new Set();
    const add = (value) => {
      if (!value) return;
      try {
        const url = new URL(value, location.href);
        if (["http:", "https:", "blob:"].includes(url.protocol)) found.add(url.href);
      } catch (_) {}
    };
    add(location.href);

    // BKAV trả đường dẫn file trong lời gọi DownloadFile(...) thay vì href.
    document.querySelectorAll("[onclick*='DownloadFile' i]").forEach((node) => {
      const onclick = node.getAttribute("onclick") || "";
      const args = [...onclick.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
      const filePath = args.find((value) => /\.pdf(?:$|[?#])/i.test(value));
      if (filePath) add(`/DownloadFile?FilePath=${encodeURIComponent(filePath)}&BFType=1`);
    });

    // VNPT đặt idInvoice/comId trong showDetailInv(...). Đây là endpoint tải
    // PDF chính thức mà trang Share/ajxPreview sử dụng sau khi mở hóa đơn.
    document.querySelectorAll("[onclick*='showDetailInv' i]").forEach((node) => {
      const onclick = node.getAttribute("onclick") || "";
      const args = [...onclick.matchAll(/["']([^"']*)["']/g)].map((match) => match[1]);
      if (args.length < 3) return;
      const pattern = args[0] || "";
      const idInvoice = args.length >= 5 ? args[3] : args[args.length - 2];
      const comId = args.length >= 5 ? args[4] : args[args.length - 1];
      if (!idInvoice || !comId) return;
      const query = new URLSearchParams({ pattern, comid: comId, idInvoice }).toString();
      add(`${location.origin}/Portal/Share/DownloadPDF?${query}`);
      add(`${location.origin}/Share/DownloadPDF?${query}`);
    });

    const markup = String(document.documentElement?.innerHTML || "").replace(/&amp;/gi, "&");
    for (const match of markup.matchAll(/(?:https?:\/\/[^"'<>\s]+)?\/DownloadFile\?FilePath=[^"'<>\s]+/gi)) add(match[0]);
    document.querySelectorAll("a[href], iframe[src], embed[src], object[data], source[src]").forEach((node) => {
      add(node.getAttribute("href") || node.getAttribute("src") || node.getAttribute("data"));
    });
    performance.getEntriesByType("resource").forEach((entry) => add(entry.name));
    const score = (url) => {
      let value = Number(/pdf|download|export|print/i.test(url));
      if (message.providerId === "bkav" && message.mode === "view" && /\/Invoice_View\//i.test(url)) value += 100;
      if (message.providerId === "bkav" && message.mode === "download" && /\/DownloadFile\?/i.test(url)) value += 100;
      return value;
    };
    return [...found]
      .filter((url) => /^blob:/i.test(url) || /pdf|download|export|print/i.test(url))
      .sort((a, b) => score(b) - score(a));
  }

  async function sha256(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function fetchBuffer(sourceUrl, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(sourceUrl, {
        credentials: "include",
        headers: { "Accept": "application/pdf,*/*;q=0.8" },
        signal: controller.signal
      });
      return { response, buffer: await response.arrayBuffer() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") throw new Error("Chrome chưa hỗ trợ giải nén gói PDF EasyInvoice.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const REJECTED_NON_INVOICE_PDF_SHA256 = new Map([
    ["1c4950e189f282d4f3acfccec30b22809f7acb8ab2bccb736fc507741abee806", "tài liệu hướng dẫn UltraViewer, không phải hóa đơn"]
  ]);

  function normalizedFileToken(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function zipPdfEntryScore(name, expected = {}) {
    const normalizedName = normalizedFileToken(name);
    let score = 0;
    if (/huongdan|ultraview|teamview|readme|tailieu|dinhkem|attachment/.test(normalizedName)) score -= 250;
    if (/hoadon|invoice|billing|bill/.test(normalizedName)) score += 20;
    for (const [value, weight] of [
      [expected.providerInvoiceId || expected.id, 120],
      [expected.lookupCode, 100],
      [expected.series, 80],
      [expected.sellerTaxCode, 60],
      [expected.number, 50]
    ]) {
      const token = normalizedFileToken(value);
      if (token.length >= 2 && normalizedName.includes(token)) score += weight;
    }
    const invoiceNumber = String(expected.number || "").replace(/\D/g, "");
    if (invoiceNumber && normalizedName.includes(invoiceNumber.padStart(8, "0"))) score += 50;
    return score;
  }

  async function extractPdfFromZip(buffer, expected = {}) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 30 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0x04034b50) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const entries = [];
    for (let offset = 0; offset + 46 <= bytes.length;) {
      if (view.getUint32(offset, true) !== 0x02014b50) {
        offset += 1;
        continue;
      }
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (/\.pdf$/i.test(name) && !name.endsWith("/")) {
        entries.push({ method, compressedSize, uncompressedSize, localOffset, name });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    const extracted = [];
    for (const entry of entries) {
      if (entry.uncompressedSize > 30 * 1024 * 1024) continue;
      const localNameLength = view.getUint16(entry.localOffset + 26, true);
      const localExtraLength = view.getUint16(entry.localOffset + 28, true);
      const dataStart = entry.localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
      const output = entry.method === 0 ? compressed : entry.method === 8 ? await inflateRaw(compressed) : null;
      if (!output || (entry.uncompressedSize && output.length !== entry.uncompressedSize)) continue;
      const pdfBuffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
      if (!pdfSignature(pdfBuffer)) continue;
      extracted.push({
        buffer: pdfBuffer,
        filename: entry.name.split(/[\\/]/).pop(),
        score: zipPdfEntryScore(entry.name, expected)
      });
    }
    if (!extracted.length) return null;
    extracted.sort((left, right) => right.score - left.score);
    const selected = extracted[0];
    if (selected.score < 0) return null;
    if (extracted.length > 1 && (selected.score <= 0 || selected.score === extracted[1].score)) return null;
    return { ...selected, candidateCount: extracted.length };
  }

  function deepJsonValue(value, keyPattern, seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (keyPattern.test(key) && ["string", "number", "boolean"].includes(typeof item) && String(item).trim()) return String(item).trim();
      const nested = deepJsonValue(item, keyPattern, seen);
      if (nested) return nested;
    }
    return "";
  }

  function utf8Base64(text) {
    const bytes = new TextEncoder().encode(String(text || ""));
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function easyInvoicePreparedData() {
    // EasyInvoice puts the complete invoice payload in #InvData on the
    // result page. Reading the hidden field is safer than matching
    // `data = {...}` in a script because the embedded invoice HTML contains
    // many nested CSS/JSON braces.
    const hidden = document.querySelector("#InvData");
    const hiddenValue = String(hidden?.value || "").trim();
    if (hiddenValue && hiddenValue !== "''") {
      try {
        const payload = JSON.parse(hiddenValue);
        const encodedHtml = String(payload.str || "");
        if ((payload.token || (payload.idInvoice && payload.pattern)) && encodedHtml) {
          const textarea = document.createElement("textarea");
          textarea.innerHTML = encodedHtml;
          return {
            id: String(payload.idInvoice || ""),
            pattern: String(payload.pattern || ""),
            token: String(payload.token || ""),
            html: utf8Base64(textarea.value)
          };
        }
      } catch (_) {}
    }
    const markup = document.documentElement?.innerHTML || "";
    const match = markup.match(/\bdata\s*=\s*(\{[\s\S]*?\})\s*;/i);
    if (!match) return null;
    let payload;
    try { payload = JSON.parse(match[1]); } catch (_) { return null; }
    const encodedHtml = String(payload.str || "");
    if ((!payload.token && (!payload.idInvoice || !payload.pattern)) || !encodedHtml) return null;
    const textarea = document.createElement("textarea");
    textarea.innerHTML = encodedHtml;
    return {
      id: String(payload.idInvoice || ""),
      pattern: String(payload.pattern || ""),
      token: String(payload.token || ""),
      html: utf8Base64(textarea.value)
    };
  }

  async function easyInvoiceOfficialPdf(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const preparedData = easyInvoicePreparedData();
      if (!preparedData) return null;
      const prepareUrl = new URL("/Invoice/DownloadPdfAndFileAttachFromAvailableHtml", location.origin).href;
      const form = new FormData();
      // EasyInvoice's current native button posts token + rendered HTML. Older
      // tenants still accept id/pattern/fKey, so retain those fields as a
      // compatibility fallback while preferring the proven native contract.
      if (preparedData.token) form.append("token", preparedData.token);
      if (preparedData.id) form.append("id", preparedData.id);
      if (preparedData.pattern) form.append("pattern", preparedData.pattern);
      if (message.lookupCode) form.append("fKey", String(message.lookupCode));
      form.append("html", preparedData.html);
      const prepared = await fetch(prepareUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest" },
        body: form,
        signal: controller.signal
      });
      if (!prepared.ok) return null;
      const text = await prepared.text();
      let payload;
      try { payload = JSON.parse(text); } catch (_) { return null; }
      const fileGuid = deepJsonValue(payload, /^fileguid$/i);
      const fileName = deepJsonValue(payload, /^filename$/i);
      if (!fileGuid || !fileName) return null;
      const downloadUrl = new URL("/Invoice/Download", location.origin);
      downloadUrl.searchParams.set("fileGuid", fileGuid);
      downloadUrl.searchParams.set("fileName", fileName);
      const downloaded = await fetch(downloadUrl.href, { credentials: "include", headers: { "Accept": "application/pdf, application/zip, */*" }, signal: controller.signal });
      if (!downloaded.ok) return null;
      const buffer = await downloaded.arrayBuffer();
      const signature = String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)));
      if (signature.startsWith("%PDF-")) return { sourceUrl: downloadUrl.href, buffer, filename: fileName, extractedFromOfficialZip: false };
      const extracted = await extractPdfFromZip(buffer, { ...message, id: preparedData.id, providerInvoiceId: preparedData.id });
      return extracted ? { sourceUrl: downloadUrl.href, buffer: extracted.buffer, filename: extracted.filename || fileName.replace(/\.zip$/i, ".pdf"), extractedFromOfficialZip: true } : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function viettelTelecomOfficialPdf(message) {
    if (String(message.sellerTaxCode || "").slice(0, 10) !== "0100109106") return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const endpoint = new URL("/api/billing/download-sell-billing-detail", location.origin).href;
      // The public lookup page creates a Laravel session and exposes the
      // request token in its download form. The API rejects an otherwise
      // valid public request with HTTP 419 unless this token accompanies the
      // same browser session.
      const csrfToken = String(document.querySelector("input[name='_token']")?.value || "").trim();
      if (!csrfToken) return null;
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "X-CSRF-TOKEN": csrfToken,
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify({
          fileType: "pdf",
          invoiceNo: `${message.series || ""}${message.number || ""}`,
          issueDate: String(message.date || ""),
          taxCode: String(message.sellerTaxCode || ""),
          _token: csrfToken
        }),
        signal: controller.signal
      });
      if (!response.ok || !/application\/json/i.test(response.headers.get("content-type") || "")) return null;
      const payload = await response.json();
      const base64 = String(payload.dataBase64 || "").replace(/\s+/g, "");
      if (!base64) return null;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const buffer = bytes.buffer;
      if (!pdfSignature(buffer)) return null;
      const sourceName = String(payload.data || "").match(/([^/\\]+\.pdf)(?:[?#]|$)/i)?.[1];
      return { sourceUrl: endpoint, buffer, filename: sourceName || message.filename, extractedFromOfficialZip: false };
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function pdfSignature(buffer) {
    return String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength))).startsWith("%PDF-");
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function officialFilename(response, fallback) {
    const disposition = response.headers.get("content-disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename\s*=\s*["']?([^"';]+)["']?/i)?.[1];
    try { return decodeURIComponent(encoded || plain || "") || fallback; } catch (_) { return plain || fallback; }
  }

  async function wintechOfficialPdf(message) {
    const privateCode = String(message.lookupCode || "").trim();
    const taxCode = String(message.sellerTaxCode || "").trim();
    if (!privateCode || !taxCode) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      let form = document.querySelector("form:has(input[name='phtcsrf_tkndf-tc']), form:has(input[name='private_code'])") || document.querySelector("form");
      let token = document.querySelector("input[name='phtcsrf_tkndf-tc']")?.value || "";
      let actionUrl = new URL(form?.getAttribute("action") || location.href, location.href);
      actionUrl.hash = "";
      if (!token) {
        const page = await fetch(actionUrl.href, { credentials: "include", signal: controller.signal });
        if (!page.ok) return null;
        const html = await page.text();
        const parsed = new DOMParser().parseFromString(html, "text/html");
        token = parsed.querySelector("input[name='phtcsrf_tkndf-tc']")?.value || "";
        form = parsed.querySelector("form:has(input[name='phtcsrf_tkndf-tc']), form:has(input[name='private_code'])") || form;
        actionUrl = new URL(form?.getAttribute("action") || actionUrl.href, actionUrl.href);
      }
      if (!token) return null;
      const body = new URLSearchParams({
        private_code: privateCode,
        cmpn_key: taxCode,
        action: "submit",
        "phtcsrf_tkndf-tc": token,
        test: "1"
      });
      const lookup = await fetch(actionUrl.href, {
        method: "POST",
        credentials: "include",
        headers: { "Accept": "text/html,application/xhtml+xml", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body,
        signal: controller.signal
      });
      if (!lookup.ok) return null;
      const resultPage = new DOMParser().parseFromString(await lookup.text(), "text/html");
      const downloadAnchor = [...resultPage.querySelectorAll("a[href]")]
        .find((node) => /tải\s*file\s*hóa\s*đơn/i.test(node.getAttribute("title") || node.textContent || ""));
      const href = downloadAnchor?.getAttribute("href") || "";
      if (!href) return null;
      const baseWithoutBill = actionUrl.href.replace(/\/bill\/?(?:[?#].*)?$/i, "/");
      const downloadUrl = new URL(href, baseWithoutBill);
      if (downloadUrl.origin !== location.origin) return null;
      const downloaded = await fetch(downloadUrl.href, { credentials: "include", headers: { "Accept": "application/zip, application/pdf, */*" }, signal: controller.signal });
      if (!downloaded.ok) return null;
      const archive = await downloaded.arrayBuffer();
      if (pdfSignature(archive)) {
        return { sourceUrl: downloadUrl.href, buffer: archive, filename: officialFilename(downloaded, message.filename), extractedFromOfficialZip: false };
      }
      const extracted = await extractPdfFromZip(archive, message);
      return extracted ? { sourceUrl: downloadUrl.href, buffer: extracted.buffer, filename: extracted.filename || message.filename, extractedFromOfficialZip: true } : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function hiloOfficialPdf(message) {
    const providerInvoiceId = String(message.providerInvoiceId || "").trim().replace(/^_/, "");
    if (!providerInvoiceId || /_|DL/i.test(providerInvoiceId)) return null;
    const pageUrl = new URL(location.href);
    pageUrl.hash = "";
    pageUrl.pathname = pageUrl.pathname.replace(/Invoice\/.*$/i, "");
    if (!pageUrl.pathname.endsWith("/")) pageUrl.pathname += "/";
    const endpoint = (path) => new URL(`Invoice/${path}`, pageUrl).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 22000);
    try {
      const prepared = await fetch(endpoint("DownloadPDF"), {
        method: "POST",
        credentials: "include",
        headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({
          Pattern: String(message.templateCode || ""),
          Serial: String(message.series || ""),
          TaxCode: String(message.sellerTaxCode || ""),
          invIDs: providerInvoiceId
        }),
        signal: controller.signal
      });
      if (!prepared.ok) return null;
      let payload;
      try { payload = await prepared.json(); } catch (_) { return null; }
      const fileName = deepJsonValue(payload, /^filename$/i);
      if (!fileName) return null;
      let created = false;
      for (let attempt = 0; attempt < 10 && !created; attempt += 1) {
        if (attempt) await delay(1000);
        const status = await fetch(endpoint("isCreatedFile"), {
          method: "POST",
          credentials: "include",
          headers: { "Accept": "application/json, text/javascript, */*; q=0.01", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({ fileName }),
          signal: controller.signal
        });
        if (!status.ok) continue;
        try { created = /^true$/i.test(deepJsonValue(await status.json(), /^success$/i)); } catch (_) {}
      }
      if (!created) return null;
      const downloadUrl = new URL(endpoint("DownloadFile"));
      downloadUrl.searchParams.set("fileName", fileName);
      const downloaded = await fetch(downloadUrl.href, { credentials: "include", headers: { "Accept": "application/pdf, application/zip, */*" }, signal: controller.signal });
      if (!downloaded.ok) return null;
      const buffer = await downloaded.arrayBuffer();
      if (pdfSignature(buffer)) return { sourceUrl: downloadUrl.href, buffer, filename: officialFilename(downloaded, fileName), extractedFromOfficialZip: false };
      const extracted = await extractPdfFromZip(buffer, message);
      return extracted ? { sourceUrl: downloadUrl.href, buffer: extracted.buffer, filename: extracted.filename || fileName, extractedFromOfficialZip: true } : null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function deliverOfficialPdf(official, message) {
    if (!official?.buffer || !pdfSignature(official.buffer)) return null;
    const digest = await sha256(official.buffer);
    const rejectedReason = REJECTED_NON_INVOICE_PDF_SHA256.get(digest.toLowerCase());
    if (rejectedReason) {
      return { ok: false, provider: location.hostname, error: `Từ chối file PDF: ${rejectedReason}.` };
    }
    const downloadDataUrl = message.mode === "download" ? bufferDataUrl(official.buffer) : "";
    let viewHandled = false;
    if (message.mode === "view") {
      const blobUrl = URL.createObjectURL(new Blob([official.buffer], { type: "application/pdf" }));
      viewHandled = true;
      setTimeout(() => location.assign(blobUrl), 100);
    }
    return {
      ok: true,
      provider: location.hostname,
      sourceUrl: official.sourceUrl,
      sha256: digest,
      bytes: official.buffer.byteLength,
      downloaded: message.mode === "download",
      viewHandled,
      extractedFromOfficialZip: Boolean(official.extractedFromOfficialZip),
      downloadDataUrl,
      downloadFilename: message.filename || official.filename
    };
  }

  async function findPdf(message = {}) {
    const errors = [];
    const deadline = Date.now() + 18000;
    for (const sourceUrl of candidates(message).slice(0, 30)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const { response, buffer } = await fetchBuffer(sourceUrl, Math.min(4500, remaining));
        const signature = String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength)));
        if (response.ok && buffer.byteLength >= 5 && signature.startsWith("%PDF-")) {
          const digest = await sha256(buffer);
          const rejectedReason = REJECTED_NON_INVOICE_PDF_SHA256.get(digest.toLowerCase());
          if (rejectedReason) {
            errors.push(`Từ chối ${sourceUrl}: ${rejectedReason}.`);
            continue;
          }
          return { sourceUrl, buffer, sha256: digest, bytes: buffer.byteLength };
        }
        if (response.ok && buffer.byteLength >= 4 && signature.startsWith("PK")) {
          // Một số cổng (đã xác minh trực tiếp với Thái Sơn E-Invoice) dùng
          // URL `format=pdf` nhưng trả ZIP chính thức chứa PDF. Luôn tách và
          // chấm điểm theo định danh hóa đơn thay vì lưu nhầm ZIP với đuôi .pdf.
          const extracted = await extractPdfFromZip(buffer, message);
          if (extracted) {
            const digest = await sha256(extracted.buffer);
            const rejectedReason = REJECTED_NON_INVOICE_PDF_SHA256.get(digest.toLowerCase());
            if (rejectedReason) {
              errors.push(`Từ chối PDF trong ZIP ${sourceUrl}: ${rejectedReason}.`);
              continue;
            }
            return {
              sourceUrl,
              buffer: extracted.buffer,
              sha256: digest,
              bytes: extracted.buffer.byteLength,
              filename: extracted.filename,
              extractedFromOfficialZip: true
            };
          }
        }
      } catch (error) {
        errors.push(error.name === "AbortError" ? "Nguồn PDF phản hồi quá lâu" : (error.message || String(error)));
      }
    }
    return { pdf: null, errors: errors.slice(0, 3) };
  }

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function setInputValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function ensureSelectOption(select, value) {
    if (!(select instanceof HTMLSelectElement) || !value) return;
    if (![...select.options].some((option) => option.value === value || option.textContent.trim() === value)) {
      select.add(new Option(value, value));
    }
  }

  async function vnptPatternForSeries(taxCode, targetSeries, existingPatterns = []) {
    if (!taxCode || !targetSeries || !document.querySelector("#CodeTax, input[name='CodeTax']")) return "";
    let patterns = [...new Set(existingPatterns.filter(Boolean))];
    try {
      if (!patterns.length) {
        const response = await fetch("/Portal/GetPatternAndSerial/", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
          body: new URLSearchParams({ TaxCode: taxCode })
        });
        const payload = response.ok ? await response.json() : null;
        patterns = Array.isArray(payload?.lstpattern) ? payload.lstpattern.map(String) : [];
      }
      for (const pattern of patterns) {
        const response = await fetch("/Portal/GetSerial/", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
          body: new URLSearchParams({ ComTaxCode: taxCode, Pattern: pattern })
        });
        if (!response.ok) continue;
        const payload = await response.json();
        const serials = Array.isArray(payload?.lstserial) ? payload.lstserial.map(String) : [];
        if (serials.includes(targetSeries)) return pattern;
      }
    } catch (_) {}
    return "";
  }

  async function prepareVnptInformationLookup(message) {
    const taxCode = String(message.sellerTaxCode || "").trim();
    const targetSeries = String(message.series || "").trim();
    const searchMode = document.querySelector("#slTracuu, select[name='slTracuu']");
    const taxInput = document.querySelector("#CodeTax, input[name='CodeTax']");
    const patternSelect = document.querySelector("#Pattern, select[name='Pattern']");
    const serialSelect = document.querySelector("#Serial, select[name='Serial']");
    if (searchMode && searchMode.value !== "1") setInputValue(searchMode, "1");
    if (taxInput && taxCode && taxInput.value !== taxCode) setInputValue(taxInput, taxCode);

    const existingPatterns = patternSelect instanceof HTMLSelectElement
      ? [...patternSelect.options].map((option) => String(option.value || option.textContent || "").trim())
      : [];
    const selectedPattern = await vnptPatternForSeries(taxCode, targetSeries, existingPatterns);
    if (patternSelect && selectedPattern) {
      ensureSelectOption(patternSelect, selectedPattern);
      setInputValue(patternSelect, selectedPattern);
      // Trang VNPT thay toàn bộ danh sách ký hiệu sau sự kiện change.
      await delay(350);
    }
    if (serialSelect && targetSeries) {
      ensureSelectOption(serialSelect, targetSeries);
      setInputValue(serialSelect, targetSeries);
    }
    return selectedPattern;
  }

  function captchaState() {
    const input = document.querySelector(
      "#Capcha, #captch, #CaptchaInputText, #ContentPlaceHolder1_txtCapcha, input[name='curentcap' i], input[name*='Captcha' i], input[name*='Capcha' i], input[name*='captch' i], input[formcontrolname='strCaptcha' i], input[placeholder*='xác thực' i], input[placeholder*='xác nhận' i], input[placeholder*='mã kiểm tra' i]"
    );
    const widget = document.querySelector(".g-recaptcha, img[alt*='captcha' i], img[id*='Captcha' i], img[src*='captcha' i]");
    const slide = document.querySelector("app-slide-captcha, .captcha-container, [class*='captcha-container' i]");
    const recaptcha = document.querySelector("input[formcontrolname='recaptcha' i], input[name='recaptcha' i]");
    const slideVisible = Boolean(slide && visible(slide) && /trượt\s+sang\s+phải|slide\s+captcha|captcha/i.test(slide.textContent || ""));
    const present = Boolean((input && visible(input)) || (widget && visible(widget)) || slideVisible);
    const empty = input ? !String(input.value || "").trim() : !String(recaptcha?.value || "").trim();
    return {
      input,
      present,
      empty,
      element: slideVisible ? slide : (input && visible(input) ? input : widget),
      kind: slideVisible ? "slide" : "text"
    };
  }

  function positionCaptchaAssist(panel, captcha) {
    panel.style.top = "";
    panel.style.bottom = "14px";
    const target = captcha?.element;
    if (!target || !visible(target)) return;
    // S-Invoice dàn trang ảnh kéo sau khi script được chèn. Ở popup hẹp,
    // đặt bảng lên trên ngay từ đầu để không phụ thuộc thời điểm ảnh tải xong.
    if (captcha.kind === "slide" && window.innerWidth <= 700) {
      panel.style.top = "14px";
      panel.style.bottom = "auto";
      return;
    }
    const panelRect = panel.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const overlaps = !(
      panelRect.right + 8 < targetRect.left ||
      panelRect.left - 8 > targetRect.right ||
      panelRect.bottom + 8 < targetRect.top ||
      panelRect.top - 8 > targetRect.bottom
    );
    if (overlaps) {
      // Popup nhà cung cấp chỉ rộng 560 px. Đưa bảng hỗ trợ lên trên khi nó
      // che CAPTCHA kéo ở giữa trang, để người dùng luôn thấy và kéo được.
      panel.style.top = "14px";
      panel.style.bottom = "auto";
    }
  }

  function captchaErrorText() {
    const errorPattern = /nhập\s+đúng\s+mã\s+cap(?:tcha|cha)|mã\s+(?:xác\s+thực|captcha|capcha)\s+(?:không\s+chính\s+xác|không\s+đúng|sai)|captcha\s+(?:không\s+chính\s+xác|không\s+đúng|sai)/i;
    const candidates = document.querySelectorAll(
      ".swal2-popup, .sweet-alert, .bootbox, .jconfirm-box, .modal, [role='alertdialog'], [role='dialog'], [class*='modal-content'], [class*='dialog-content']"
    );
    for (const candidate of candidates) {
      if (!visible(candidate)) continue;
      const text = String(candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim();
      if (errorPattern.test(text)) {
        return "CAPTCHA chưa đúng. Bấm OK để đóng thông báo, nhập mã mới rồi bấm thử lại.";
      }
    }
    return "";
  }

  function dismissCaptchaErrorDialog() {
    const errorPattern = /nhập\s+đúng\s+mã\s+cap(?:tcha|cha)|mã\s+(?:xác\s+thực|captcha|capcha)\s+(?:không\s+chính\s+xác|không\s+đúng|sai)|captcha\s+(?:không\s+chính\s+xác|không\s+đúng|sai)/i;
    const containers = document.querySelectorAll(
      ".swal2-popup, .sweet-alert, .bootbox, .jconfirm-box, .modal, [role='alertdialog'], [role='dialog'], [class*='modal-content'], [class*='dialog-content']"
    );
    for (const container of containers) {
      if (!visible(container) || !errorPattern.test(String(container.innerText || container.textContent || ""))) continue;
      const close = [...container.querySelectorAll("button, input[type='button'], input[type='submit'], a")]
        .find((item) => /^(ok|đóng|close|x)$/i.test(String(item.textContent || item.value || item.getAttribute("aria-label") || "").trim()));
      if (close) {
        try { close.click(); } catch (_) {}
        return true;
      }
    }
    return false;
  }

  let assistMessage = null;
  let assistBusy = false;
  let assistDownloadControlReady = false;
  let assistRunToken = 0;
  let assistAutoContinueTimer = null;

  function stopCaptchaAutoContinue() {
    if (assistAutoContinueTimer !== null) {
      clearInterval(assistAutoContinueTimer);
      assistAutoContinueTimer = null;
    }
  }

  function armViettelSliderAutoContinue() {
    stopCaptchaAutoContinue();
    if (assistMessage?.providerId !== "viettel") return;
    const initial = captchaState();
    if (initial.kind !== "slide" || !initial.present || !initial.empty) return;
    const recaptcha = document.querySelector("input[formcontrolname='recaptcha' i], input[name='recaptcha' i]");
    if (!recaptcha) return;
    setAssistStatus("Hãy kéo CAPTCHA. Khi Viettel xác nhận thành công, extension sẽ tự tra cứu và tải PDF gốc.");
    assistAutoContinueTimer = setInterval(() => {
      if (!assistMessage || assistBusy) return;
      const token = String(recaptcha.value || recaptcha.getAttribute("value") || "").trim();
      if (!token) return;
      stopCaptchaAutoContinue();
      setAssistStatus("CAPTCHA đã hoàn tất; đang tự tra cứu hóa đơn…", "ok");
      queueMicrotask(() => { void runCaptchaAssist(); });
    }, 250);
  }

  function setAssistStatus(text, kind = "") {
    const status = document.querySelector("#invoice-vault-captcha-status");
    if (!status) return;
    status.textContent = text;
    status.style.color = kind === "error" ? "#b91c1c" : kind === "ok" ? "#166534" : "#374151";
  }

  function installCaptchaAssist(message) {
    assistMessage = message;
    let panel = document.querySelector("#invoice-vault-captcha-assist");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "invoice-vault-captcha-assist";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Hỗ trợ CAPTCHA hóa đơn");
      panel.style.cssText = [
        "position:fixed", "right:14px", "bottom:14px", "z-index:2147483647",
        "width:min(330px,calc(100vw - 28px))", "box-sizing:border-box", "padding:14px",
        "border:1px solid #86a98f", "border-radius:12px", "background:#f7fff9",
        "box-shadow:0 14px 36px rgba(0,0,0,.28)", "font:14px/1.4 Arial,sans-serif", "color:#17221b"
      ].join(";");
      const captchaHelp = message.providerId === "viettel"
        ? "Kéo CAPTCHA trên trang. Khi Viettel xác nhận thành công, extension sẽ tự tra cứu và tự tải PDF gốc."
        : "Nhập CAPTCHA trên trang, rồi bấm nút dưới đây. Extension sẽ tra cứu và tự tải PDF gốc.";
      panel.innerHTML = `
        <div style="font-weight:700;font-size:16px;margin-bottom:5px">Kho hóa đơn gốc</div>
        <div style="margin-bottom:8px">${captchaHelp}</div>
        <div id="invoice-vault-captcha-status" style="font-size:13px;margin-bottom:9px;color:#374151">Thông tin hóa đơn đã được điền sẵn.</div>
        <button id="invoice-vault-captcha-continue" type="button" style="width:100%;padding:10px 12px;border:0;border-radius:8px;background:#174c2b;color:#fff;font-weight:700;cursor:pointer">Tra cứu &amp; tự tải PDF gốc</button>
        <button id="invoice-vault-captcha-close" type="button" style="width:100%;margin-top:7px;padding:7px;border:0;background:transparent;color:#526158;cursor:pointer">Đóng hướng dẫn</button>`;
      document.documentElement.appendChild(panel);
      panel.querySelector("#invoice-vault-captcha-close")?.addEventListener("click", () => {
        assistRunToken += 1;
        stopCaptchaAutoContinue();
        panel.remove();
        assistMessage = null;
        assistBusy = false;
        assistDownloadControlReady = false;
        chrome.runtime.sendMessage({ type: "CLEAR_CAPTCHA_ASSIST" }).catch(() => {});
      });
      panel.querySelector("#invoice-vault-captcha-continue")?.addEventListener("click", runCaptchaAssist);
    }
    // Sau khi tra cứu thành công, nhiều cổng (đặc biệt EasyInvoice) vẫn giữ
    // nguyên form CAPTCHA ở cuối trang kết quả. Nếu chỉ nhìn thấy ô CAPTCHA,
    // extension sẽ gửi lại nút "Tra cứu" và làm người dùng quay về trang xem.
    // Trang kết quả phải được nhận diện bằng nút PDF chính thức trước.
    const officialDownload = findDownloadControl();
    const captcha = captchaState();
    positionCaptchaAssist(panel, captcha);
    if (officialDownload) {
      assistDownloadControlReady = true;
      setAssistStatus(
        captcha.present && captcha.empty
          ? "Trang đã hiện hóa đơn. Hãy nhập CAPTCHA mới rồi bấm nút xanh để tải PDF gốc."
          : "Trang đã hiện hóa đơn. Bấm nút xanh để tải PDF gốc bằng nút chính thức.",
        captcha.present && captcha.empty ? "" : "ok"
      );
      const button = panel.querySelector("#invoice-vault-captcha-continue");
      if (button) button.textContent = "Tải PDF gốc từ hóa đơn";
      if (message.providerId === "viettel" && !(captcha.present && captcha.empty)) {
        setAssistStatus("Trang đã hiện hóa đơn; extension đang tự tải PDF gốc…", "ok");
        queueMicrotask(() => { void runCaptchaAssist(); });
      }
    }
    const restoredCaptchaError = captchaErrorText();
    if (restoredCaptchaError) {
      setAssistStatus(restoredCaptchaError, "error");
    } else if (message.restoredAfterNavigation && !officialDownload) {
      setAssistStatus("Trang vừa cập nhật. Hãy nhập CAPTCHA mới rồi bấm nút để thử lại.");
    }
    if (captcha.input && captcha.empty) {
      try { captcha.input.focus({ preventScroll: false }); } catch (_) { captcha.input.focus(); }
    }
    if (!officialDownload) armViettelSliderAutoContinue();
    return { ok: false, requiresUser: true, assistInstalled: true };
  }

  async function runCaptchaAssist() {
    if (assistBusy || !assistMessage) return;
    // Re-check on every click because a successful CAPTCHA submission may have
    // navigated to a result page after the assist panel was installed.
    const currentDownloadControl = findDownloadControl();
    if (currentDownloadControl) assistDownloadControlReady = true;
    const currentCaptcha = captchaState();
    const existingCaptchaError = captchaErrorText();
    if (existingCaptchaError) {
      dismissCaptchaErrorDialog();
      setAssistStatus(existingCaptchaError, "error");
      if (currentCaptcha.input) {
        setInputValue(currentCaptcha.input, "");
        currentCaptcha.input.focus();
      }
      return;
    }
    if (assistDownloadControlReady) {
      if (currentCaptcha.present && currentCaptcha.empty) {
        setAssistStatus("Bạn chưa nhập CAPTCHA mới trên trang hóa đơn.", "error");
        currentCaptcha.input?.focus();
        return;
      }
      // Try the official endpoint/byte path first. This avoids opening an
      // inline viewer when a provider's button is implemented as a JS view
      // action, while still retaining the native button as a fallback.
      const scanned = await scan({ ...assistMessage, mode: "download" });
      if (scanned?.ok && scanned.downloadDataUrl) {
        setAssistStatus("Đã tìm thấy PDF gốc; đang lưu xuống máy…", "ok");
        const response = await chrome.runtime.sendMessage({
          type: "PROVIDER_ASSIST_DOWNLOAD",
          invoice: assistMessage.assistInvoice || {},
          result: scanned
        });
        if (response?.ok) {
          setAssistStatus("Đã tải PDF gốc. Cửa sổ sẽ tự đóng.", "ok");
          return;
        }
        setAssistStatus(response?.error || "Không lưu được PDF gốc; sẽ bấm nút tải chính thức.", "error");
      }
      const triggered = triggerDownload();
      if (triggered.ok) {
        setAssistStatus("Đã bấm nút tải PDF chính thức của nhà cung cấp.", "ok");
        const button = document.querySelector("#invoice-vault-captcha-continue");
        if (button) button.textContent = "Đã yêu cầu tải PDF gốc";
      } else {
        setAssistStatus(triggered.error || "Không bấm được nút tải PDF.", "error");
      }
      return;
    }
    const captcha = captchaState();
    if (captcha.present && captcha.empty) {
      setAssistStatus("Bạn chưa nhập CAPTCHA.", "error");
      captcha.input?.focus();
      return;
    }
    stopCaptchaAutoContinue();
    assistBusy = true;
    const runToken = ++assistRunToken;
    const button = document.querySelector("#invoice-vault-captcha-continue");
    if (button) {
      button.disabled = true;
      button.textContent = "Đang tra cứu và chờ PDF…";
    }
    setAssistStatus("Đang gửi biểu mẫu và chờ hóa đơn…");
    try {
      const submit = lookupButton(assistMessage.providerId);
      if (submit && visible(submit)) submit.click();
      const deadline = Date.now() + 45000;
      let last = null;
      while (Date.now() < deadline) {
        await delay(750);
        if (runToken !== assistRunToken || !assistMessage) return;
        const captchaError = captchaErrorText();
        if (captchaError) {
          dismissCaptchaErrorDialog();
          const currentCaptcha = captchaState();
          if (currentCaptcha.input) setInputValue(currentCaptcha.input, "");
          throw new Error(captchaError);
        }
        last = await scan({ ...assistMessage, mode: "download" });
        if (last?.ok && last.downloadDataUrl) {
          setAssistStatus("Đã tìm thấy PDF gốc; đang lưu xuống máy…", "ok");
          const response = await chrome.runtime.sendMessage({
            type: "PROVIDER_ASSIST_DOWNLOAD",
            invoice: assistMessage.assistInvoice || {},
            result: last
          });
          if (!response?.ok) throw new Error(response?.error || "Không lưu được PDF gốc.");
          setAssistStatus("Đã tải PDF gốc. Cửa sổ sẽ tự đóng.", "ok");
          return;
        }
        if (last?.downloadControl) {
          assistDownloadControlReady = true;
          const resultCaptcha = captchaState();
          if (resultCaptcha.present && resultCaptcha.empty) {
            setAssistStatus("Cổng đã hiện hóa đơn nhưng yêu cầu CAPTCHA mới trước khi tải PDF gốc.");
            if (button) button.textContent = "Tải PDF gốc từ hóa đơn";
            resultCaptcha.input?.focus();
            return;
          }
          const triggered = triggerDownload();
          if (!triggered.ok) throw new Error(triggered.error || "Không bấm được nút tải PDF chính thức.");
          setAssistStatus("Đã tự bấm nút tải PDF chính thức của nhà cung cấp.", "ok");
          if (button) button.textContent = "Đã yêu cầu tải PDF gốc";
          return;
        }
      }
      throw new Error(last?.error || "Cổng chưa trả hóa đơn sau 45 giây. Kiểm tra CAPTCHA rồi thử lại.");
    } catch (error) {
      setAssistStatus(error.message || String(error), "error");
    } finally {
      assistBusy = false;
      if (button) {
        button.disabled = false;
        if (!/Tải PDF gốc từ hóa đơn|Đã yêu cầu tải PDF gốc/.test(button.textContent || "")) {
          button.textContent = "Thử lại tra cứu & tự tải";
        }
      }
    }
  }

  function lookupInput(providerId, providerCode = "") {
    const selectorMap = {
      bkav: "#txtInvoiceCode",
      thaison: "#MA_NHAN_HOA_DON, input[name='MaNhanHoaDon'], input.MaNhanHoaDon, input[placeholder*='Nhập mã số' i]",
      // S-Invoice có cả supplierTaxCode và reservationCode đều chứa chữ
      // "code". Chỉ dùng tên control tuyệt đối; selector *='code' sẽ chọn
      // nhầm ô MST bên bán trước ô mã bí mật.
      viettel: "#searchInvoiceForm\\:reservationCode, input[name$=':reservationCode'], input[formcontrolname='reservationCode' i], input[formcontrolname='privateCode' i], input[formcontrolname='secretCode' i], input[name*='secret' i], input[placeholder*='mã số bí mật' i]",
      vnpt: "#strFkey, input[name*='matracuu' i], input[name*='fkey' i], input[placeholder*='mã tra cứu' i]",
      easyinvoice: "#iFkey, input[name='FKey']",
      cyberbill: "input[name='MaSoBiMat' i], input[placeholder*='mã tra cứu hóa đơn' i]",
      vina: "#ContentPlaceHolder1_txtCode, input[placeholder*='Mã nhận hóa đơn' i]",
      visnam: "input[placeholder*='Mã số bí mật' i]",
      wintech: "input[name='private_code'], #txtSobaomat, #body-page form div:first-child input",
      minvoice: "input[name='sobaomat'], input[placeholder*='số bảo mật' i]",
      fpt: "#key",
      vetc: "#secureId",
      atis: "#secureId",
      sapo: "#reference_code",
      ngp: "#ASPxTextBox_search_I",
      beinvoice: "#code",
      qinvoice: "#InvoiceCode",
      ts24: "#lookup_id",
      nhanhoa: "#MaTraCuuHoaDon",
      pavietnam: "#invoice-code",
      tgdd: "#billNum",
      invoice3a: "#contact-form div:nth-child(1) input",
      vnpay: "input[formcontrolname*='transaction' i], input[placeholder*='mã tra cứu' i]",
      vdsg: "input[placeholder*='mã tra cứu' i]",
      tax24: "input[placeholder*='mã tra cứu' i]",
      ptp: "input[placeholder*='mã tra cứu' i]",
      acconline: "input[placeholder*='mã tra cứu' i]",
      htinvoice: "input[placeholder*='mã tra cứu' i]"
    };
    const technicalMap = {
      tvan_megabiz: "#key",
      tvan_mobifone: "#txtSobaomat",
      tvan_acman: "#PageContent_txtMaTraCuuHoaDon",
      tvan_truonghai: "#code",
      tvan_vininvoice: "#root input",
      tvan_msinvoice: "input[placeholder*='mã tra cứu' i]"
    };
    return document.querySelector(technicalMap[providerCode] || selectorMap[providerId] || "input[placeholder*='mã tra cứu' i], input[placeholder*='số bảo mật' i], input[name*='lookup' i]");
  }

  function lookupButton(providerId) {
    if (providerId === "thaison") {
      const exactThaiSon = document.querySelector("form[action='/tra-cuu'] button[type='submit']") ||
        [...document.querySelectorAll("button, input[type='submit']")].find((item) =>
          visible(item) && /^tra\s*cứu\s*hóa\s*đơn$/i.test(String(item.textContent || item.value || "").trim())
        );
      if (exactThaiSon) return exactThaiSon;
    }
    if (providerId === "viettel") {
      const exactViettel = document.querySelector("button[name$=':search']") ||
        [...document.querySelectorAll("button")].find((item) => visible(item) && /^(?:tìm kiếm|tra cứu)$/i.test(String(item.textContent || "").trim()));
      if (exactViettel) return exactViettel;
    }
    const exact = { bkav: "#Button1", easyinvoice: "#btnSubmit", vina: "#btnXML", sapo: "#downloadInvoiceBtn", qinvoice: "button[type='submit']", nhanhoa: "button[type='submit']" }[providerId];
    return (exact && document.querySelector(exact)) ||
      document.querySelector("button[type='submit'], input[type='submit']") ||
      [...document.querySelectorAll("button, input[type='button']")].find((item) => /tra\s*cứu|search/i.test(item.textContent || item.value || ""));
  }

  async function prepareLookup(message) {
    const code = String(message.lookupCode || "").trim();
    if (!code && !["vnpt", "nacencomm"].includes(message.providerId)) {
      return { ok: false, needsCode: true, error: "Cổng nhà cung cấp yêu cầu mã tra cứu riêng nhưng dữ liệu Thuế chưa có mã này." };
    }
    const input = lookupInput(message.providerId, message.providerCode);
    if (input && code && input.value !== code) setInputValue(input, code);
    let preparedFields = Number(Boolean(input && code));

    const supplementalFields = {
      wintech: [["input[name='cmpn_key'], #txtMST", message.sellerTaxCode]],
      minvoice: [["input[name='masothue'], input[placeholder*='mã số thuế' i]", message.sellerTaxCode]],
      nhanhoa: [["#BenBanMaDonVi", message.sellerTaxCode]],
      thaison: [["#MA_DV", message.sellerTaxCode]],
      easyinvoice: [["#taxCode, input[name='TaxCode']", message.sellerTaxCode]],
      invoice3a: [["#contact-form div:nth-child(2) input", message.number], ["#contact-form div:nth-child(3) input", message.sellerTaxCode]],
      vnpay: [["input[placeholder*='mã số thuế' i], input[formcontrolname*='tax' i]", message.sellerTaxCode]]
    }[message.providerId] || [];
    if (message.providerCode === "tvan_mobifone") supplementalFields.push(["#txtMST", message.sellerTaxCode]);
    if (message.providerCode === "tvan_acman") supplementalFields.push(["#PageContent_txtMaDonViPhatHanh", message.sellerTaxCode]);
    supplementalFields.forEach(([selector, value]) => {
      const field = document.querySelector(selector);
      const text = String(value || "").trim();
      if (field && text) {
        if (field.value !== text) setInputValue(field, text);
        preparedFields += 1;
      }
    });

    if (message.providerId === "viettel") {
      const issueDate = String(message.date || "").replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1");
      const values = [
        ["input[name$=':supplierTaxCode'], input[formcontrolname='supplierTaxCode' i], input[formcontrolname='taxcodeSeller' i]", message.sellerTaxCode],
        ["input[name$=':invoiceNo']", `${message.series || ""}${message.number || ""}`],
        ["input[name$=':issueDate_input']", issueDate]
      ];
      values.forEach(([selector, value]) => {
        const field = document.querySelector(selector);
        if (field && String(value || "").trim() && field.value !== String(value).trim()) setInputValue(field, String(value).trim());
      });
    }
    if (message.providerId === "vnpt") {
      const selectedPattern = await prepareVnptInformationLookup(message);
      const values = [
        ["#CodeTax, input[name='CodeTax']", message.sellerTaxCode],
        ["#Pattern, select[name='Pattern'], input[name='Pattern']", selectedPattern || message.templateCode],
        ["#Serial, select[name='Serial'], input[name='Serial']", message.series],
        ["#InvNo, input[name='InvNo'], #strNo, input[name='strNo']", message.number],
        ["#nameCus, input[name='nameCus']", message.buyerTaxCode],
        ["#strFkey, input[name='strFkey']", code]
      ];
      values.forEach(([selector, value]) => {
        const field = document.querySelector(selector);
        const text = String(value || "").trim();
        if (field && text) {
          if (field.value !== text) setInputValue(field, text);
          preparedFields += 1;
        }
      });
    }

    const captcha = captchaState();
    if (captcha.present && captcha.empty) {
      return {
        ok: false,
        requiresUser: true,
        prepared: preparedFields > 0,
        error: message.providerId === "viettel"
          ? "Đã điền MST và mã bí mật. Hãy kéo CAPTCHA; sau khi Viettel xác nhận, extension sẽ tự tra cứu và tự tải PDF gốc."
          : message.providerId === "vnpt"
            ? "Đã mở cửa sổ nhỏ VNPT và điền MST, mẫu, ký hiệu, số hóa đơn, Fkey nếu có. Hãy nhập CAPTCHA rồi bấm “Tra cứu & tự tải PDF gốc” ngay trong cửa sổ đó."
            : "Đã mở cửa sổ nhỏ và điền thông tin tra cứu. Hãy nhập CAPTCHA rồi bấm “Tra cứu & tự tải PDF gốc” ngay trong cửa sổ đó."
      };
    }

    const button = lookupButton(message.providerId);
    if (button && visible(button)) {
      button.click();
      return { ok: false, navigationStarted: true };
    }
    return { ok: false, prepared: preparedFields > 0, error: "Không tìm thấy nút Tra cứu phù hợp trên cổng nhà cung cấp." };
  }

  function findViewerUrl() {
    const node = document.querySelector("object[data*='.pdf' i], embed[src*='.pdf' i], iframe[src*='.pdf' i], iframe[src*='InvoiceGUID' i], iframe[src*='/Lookup' i], a[href*='InvoiceGUID' i]");
    const value = node?.getAttribute("src") || node?.getAttribute("href") || "";
    try { return value ? new URL(value, location.href).href : ""; } catch (_) { return ""; }
  }

  function findDownloadControl() {
    // #btnDownload on BKAV is only the dropdown toggle; the actual PDF item
    // is #LinkDownPDF. Prefer explicit PDF/download actions and never choose
    // a generic menu button before the real file action.
    const exact = document.querySelector(
      "#LinkDownPDF, #adownload, .dm-item.pdf, a[download], [onclick*='DownloadFile' i], [onclick*='downloadPdfAndFileAttach' i]"
    );
    if (exact && visible(exact)) return exact;
    const labelled = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit'], span")]
      // Bảng hỗ trợ cũng có chữ "tải PDF". Nếu tự quét chính nút của mình,
      // extension sẽ nhận nhầm form CAPTCHA là trang kết quả hóa đơn.
      .filter((item) => !item.closest("#invoice-vault-captcha-assist") && visible(item))
      .filter((item) => !/^(x|close|đóng|cancel)$/i.test((item.textContent || item.value || item.title || "").trim()))
      .find((item) => /tải\s*(?:file\s*)?(?:pdf|hóa\s*đơn)|pdf\s*(?:&|và)?\s*(?:đính\s*kèm|tải)|download\s*(?:file\s*)?(?:pdf|invoice)|tải\s*về/i.test(item.textContent || item.value || item.title || ""));
    if (labelled) return labelled;
    return [...document.querySelectorAll("button, a, input[type='button'], input[type='submit'], span")]
      .find((item) => !item.closest("#invoice-vault-captcha-assist") && visible(item) && /tải.*pdf|pdf.*tải|download.*pdf|tải về|^\s*pdf\s*$/i.test(item.textContent || item.value || item.title || ""));
  }

  function downloadBuffer(buffer, filename) {
    const blobUrl = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = String(filename || "hoa-don-goc.pdf").replace(/[<>:\"/\\|?*\x00-\x1f]/g, "-").slice(0, 180);
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    try {
      anchor.click();
    } catch (error) {
      anchor.remove();
      URL.revokeObjectURL(blobUrl);
      return { ok: false, requiresUser: true, error: error?.message || String(error) };
    }
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    return { ok: true };
  }

  function bufferDataUrl(buffer, mime = "application/pdf") {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  }

  async function scan(message) {
    if (message.providerId === "wintech") {
      const delivered = await deliverOfficialPdf(await wintechOfficialPdf(message), message);
      if (delivered) return delivered;
    }
    if (message.providerId === "hilo" && message.providerInvoiceId) {
      const delivered = await deliverOfficialPdf(await hiloOfficialPdf(message), message);
      if (delivered) return delivered;
    }
    if (message.providerId === "easyinvoice") {
      const delivered = await deliverOfficialPdf(await easyInvoiceOfficialPdf(message), message);
      if (delivered) return delivered;
    }
    if (message.providerId === "viettel" && /(?:^|\.)vietteltelecom\.vn$/i.test(location.hostname)) {
      const delivered = await deliverOfficialPdf(await viettelTelecomOfficialPdf(message), message);
      if (delivered) return delivered;
    }
    const found = await findPdf(message);
    if (found?.sourceUrl) {
      const downloadDataUrl = message.mode === "download" ? bufferDataUrl(found.buffer) : "";
      return {
        ok: true,
        provider: location.hostname,
        sourceUrl: found.sourceUrl,
        sha256: found.sha256,
        bytes: found.bytes,
        downloaded: message.mode === "download",
        extractedFromOfficialZip: Boolean(found.extractedFromOfficialZip),
        downloadDataUrl,
        downloadFilename: message.filename || found.filename || "hoa-don-goc.pdf"
      };
    }
    return {
      ok: false,
      viewerUrl: findViewerUrl(),
      downloadControl: Boolean(findDownloadControl()),
      errors: found?.errors || [],
      error: "Trang nhà cung cấp chưa lộ ra byte PDF gốc."
    };
  }

  function triggerDownload() {
    const control = findDownloadControl();
    if (!control) return { ok: false, error: "Không tìm thấy nút tải PDF chính thức trên trang hóa đơn." };
    try {
      control.click();
      return { ok: true, nativeDownloadTriggered: true, provider: location.hostname };
    } catch (error) {
      return {
        ok: false,
        requiresUser: true,
        provider: location.hostname,
        error: "Cổng nhà cung cấp yêu cầu một cú bấm trực tiếp trên tab hóa đơn. Extension đã mở đúng tab; hãy bấm nút Tải PDF trên trang rồi quay lại thử lại.",
        technicalError: error?.message || String(error)
      };
    }
  }

  async function run(message) {
    switch (message.stage) {
      case "scan": return scan(message);
      case "prepare": return prepareLookup(message);
      case "trigger-download": return triggerDownload();
      case "install-assist": {
        return installCaptchaAssist(message);
      }
      default: return scan(message);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!["GENERIC_PROVIDER_STAGE", "GENERIC_SCAN_PDF"].includes(message?.type)) return false;
    run({ ...message, stage: message.stage || "scan" })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });
})();
