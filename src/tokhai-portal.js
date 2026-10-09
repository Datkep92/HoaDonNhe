'use strict';
// Adapted from extension mkkdefnhkihnlojfcmnebckpopcgegip 1.2.2, js/tab-tokhai.js.
// These self-contained functions execute in the hidden portal tab, preserving its cookies.

async function searchTdtInTab(range, baseUrl, cachedSessionId) {
  try {
    const { tuNgay, denNgay } = range;

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 2000) {
      let res;
      for (let i = 0; i <= retries; i++) {
        res = await fetch(url, options);
        if (res.status === 429) {
          if (i < retries) {
            await sleep(delayMs * (i + 1));
            continue;
          }
        }
        break;
      }
      return res;
    }

    function getActiveSessionId() {
      let sessionId = new URLSearchParams(window.location.search).get("dse_sessionId");
      if (sessionId) return sessionId;
      const input = document.querySelector("input[name='dse_sessionId']");
      if (input && input.value) return input.value;
      const links = document.querySelectorAll("a[href*='dse_sessionId=']");
      for (const link of links) {
        const href = link.getAttribute("href");
        const match = href ? href.match(/dse_sessionId=([^&]+)/) : null;
        if (match) return match[1];
      }
      const forms = document.querySelectorAll("form[action*='dse_sessionId=']");
      for (const form of forms) {
        const action = form.getAttribute("action");
        const match = action ? action.match(/dse_sessionId=([^&]+)/) : null;
        if (match) return match[1];
      }
      for (const script of document.scripts) {
        const text = script.textContent || script.innerText || "";
        const match = text.match(/dse_sessionId=([^&'"]+)/);
        if (match) return match[1];
      }
      const htmlMatch = document.documentElement.innerHTML.match(/dse_sessionId=([^&'"]+)/);
      if (htmlMatch) return htmlMatch[1];
      return cachedSessionId;
    }

    const activeSessionId = getActiveSessionId();
    const initUrl = activeSessionId
      ? `${baseUrl}/etaxnnt/Request?dse_sessionId=${activeSessionId}&dse_applicationId=-1&dse_pageId=11&dse_operationName=traCuuToKhaiProc&dse_processorState=initial&dse_nextEventName=start`
      : `${baseUrl}/etaxnnt/Request?dse_applicationId=-1&dse_operationName=traCuuToKhaiProc`;

    // 1. Initialize transaction
    const initRes = await fetchWithRetry(initUrl, {
      credentials: "include"
    });
    if (!initRes.ok) {
      if (initRes.status === 429) throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
      throw new Error(`Vui lòng đăng nhập ${baseUrl} trước khi tìm kiếm`);
    }

    let html = await initRes.text();
    let doc = new DOMParser().parseFromString(html, "text/html");

    let dseSessionId = doc.querySelector("input[name='dse_sessionId']")?.value;
    let dseProcessorId = doc.querySelector("input[name='dse_processorId']")?.value;
    let dsePageId = doc.querySelector("input[name='dse_pageId']")?.value;
    let dseProcessorState = doc.querySelector("input[name='dse_processorState']")?.value;

    if (!dseSessionId || !dseProcessorId) {
      throw new Error(`Vui lòng đăng nhập ${baseUrl} trước khi tìm kiếm`);
    }

    // 2. POST search request
    const searchBody = new URLSearchParams({
      dse_sessionId: dseSessionId,
      dse_applicationId: "-1",
      dse_operationName: "traCuuToKhaiProc",
      dse_pageId: dsePageId,
      dse_processorState: dseProcessorState,
      dse_processorId: dseProcessorId,
      dse_errorPage: "error_page.jsp",
      dse_nextEventName: "query",
      pn: "1",
      maTKhai: "00",
      tenTKhai: "",
      kieuKy: "",
      ma_gd: "",
      qryFromDate: tuNgay,
      qryToDate: denNgay
    });

    await sleep(500);
    const searchRes = await fetchWithRetry(`${baseUrl}/etaxnnt/Request`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: searchBody.toString()
    });
    if (!searchRes.ok) {
      if (searchRes.status === 429) throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
      throw new Error(`HTTP ${searchRes.status} searching declarations`);
    }

    html = await searchRes.text();
    doc = new DOMParser().parseFromString(html, "text/html");

    const rows = [];

    function parseRowsFromDoc(documentObj) {
      const tbody = documentObj.querySelector("#allResultTableBody");
      if (!tbody) return [];
      return [...tbody.querySelectorAll("tr")].map(tr => {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 11) return null;
        const maHoSo = tds[1]?.textContent.trim() || "";
        const toKhai = tds[2]?.textContent.replace(/Tải tệp tờ khai về/gi, "").replace(/\s+/g, " ").trim() || "";
        return {
          maHoSo,
          toKhai,
          kyTinhThue: tds[3]?.textContent.trim() || "",
          loaiToKhai: tds[4]?.textContent.trim() || "",
          lanNop: tds[5]?.textContent.trim() || "",
          lanBoSung: tds[6]?.textContent.trim() || "",
          ngayNop: tds[7]?.textContent.trim() || "",
          donViTiepNhan: tds[9]?.textContent.trim() || "",
          trangThai: tds[10]?.textContent.trim() || "",
        };
      }).filter(r => r && r.maHoSo);
    }

    rows.push(...parseRowsFromDoc(doc));

    // 3. Handle pagination
    const currAcc = doc.querySelector("#currAcc");
    let totalPages = 1;
    if (currAcc) {
      const bTags = currAcc.querySelectorAll("b");
      if (bTags && bTags.length > 0) {
        totalPages = parseInt(bTags[0].textContent.trim(), 10) || 1;
      }
    }

    if (totalPages > 1) {
      dseSessionId = doc.querySelector("input[name='dse_sessionId']")?.value || dseSessionId;
      dseProcessorId = doc.querySelector("input[name='dse_processorId']")?.value || dseProcessorId;
      dsePageId = doc.querySelector("input[name='dse_pageId']")?.value || dsePageId;
      dseProcessorState = doc.querySelector("input[name='dse_processorState']")?.value || dseProcessorState;

      for (let pn = 2; pn <= totalPages; pn++) {
        await sleep(500);
        const pageUrl = `${baseUrl}/etaxnnt/Request?dse_sessionId=${dseSessionId}&dse_applicationId=-1&dse_operationName=traCuuToKhaiProc&dse_pageId=${dsePageId}&dse_processorState=${dseProcessorState}&dse_processorId=${dseProcessorId}&dse_errorPage=error_page.jsp&dse_nextEventName=query&pn=${pn}`;
        const pageRes = await fetchWithRetry(pageUrl, { credentials: "include" });
        if (!pageRes.ok) {
          if (pageRes.status === 429) throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
          throw new Error(`HTTP ${pageRes.status} fetching page ${pn}`);
        }

        const pageHtml = await pageRes.text();
        const pageDoc = new DOMParser().parseFromString(pageHtml, "text/html");

        rows.push(...parseRowsFromDoc(pageDoc));

        dseSessionId = pageDoc.querySelector("input[name='dse_sessionId']")?.value || dseSessionId;
        dseProcessorId = pageDoc.querySelector("input[name='dse_processorId']")?.value || dseProcessorId;
        dsePageId = pageDoc.querySelector("input[name='dse_pageId']")?.value || dsePageId;
        dseProcessorState = pageDoc.querySelector("input[name='dse_processorState']")?.value || dseProcessorState;
      }
    }

    return { success: true, rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchFilesTdtInTab(maHoSo, baseUrl, ngayNop, cachedSessionId) {
  try {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 2000) {
      let res;
      for (let i = 0; i <= retries; i++) {
        res = await fetch(url, options);
        if (res.status === 429) {
          if (i < retries) {
            await sleep(delayMs * (i + 1));
            continue;
          }
        }
        break;
      }
      return res;
    }

    async function blobToBase64(blob) {
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    function toFilename(text) {
      return text.replace(/^V\/v:\s*/i, "").trim()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/gi, "d").replace(/[^a-zA-Z0-9\s_-]/g, "")
        .replace(/\s+/g, "_").replace(/_+/g, "_").substring(0, 80);
    }

    function getActiveSessionId() {
      let sessionId = new URLSearchParams(window.location.search).get("dse_sessionId");
      if (sessionId) return sessionId;
      const input = document.querySelector("input[name='dse_sessionId']");
      if (input && input.value) return input.value;
      const links = document.querySelectorAll("a[href*='dse_sessionId=']");
      for (const link of links) {
        const href = link.getAttribute("href");
        const match = href ? href.match(/dse_sessionId=([^&]+)/) : null;
        if (match) return match[1];
      }
      const forms = document.querySelectorAll("form[action*='dse_sessionId=']");
      for (const form of forms) {
        const action = form.getAttribute("action");
        const match = action ? action.match(/dse_sessionId=([^&]+)/) : null;
        if (match) return match[1];
      }
      for (const script of document.scripts) {
        const text = script.textContent || script.innerText || "";
        const match = text.match(/dse_sessionId=([^&'"]+)/);
        if (match) return match[1];
      }
      const htmlMatch = document.documentElement.innerHTML.match(/dse_sessionId=([^&'"]+)/);
      if (htmlMatch) return htmlMatch[1];
      return cachedSessionId;
    }

    const activeSessionId = getActiveSessionId();
    const initUrl = activeSessionId
      ? `${baseUrl}/etaxnnt/Request?dse_sessionId=${activeSessionId}&dse_applicationId=-1&dse_pageId=11&dse_operationName=traCuuToKhaiProc&dse_processorState=initial&dse_nextEventName=start`
      : `${baseUrl}/etaxnnt/Request?dse_applicationId=-1&dse_operationName=traCuuToKhaiProc`;

    // 1. Initialize transaction
    const initRes = await fetchWithRetry(initUrl, {
      credentials: "include"
    });
    if (!initRes.ok) {
      if (initRes.status === 429) throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
      throw new Error(`Vui lòng đăng nhập ${baseUrl} trước khi tải`);
    }

    let html = await initRes.text();
    let doc = new DOMParser().parseFromString(html, "text/html");

    let dseSessionId = doc.querySelector("input[name='dse_sessionId']")?.value;
    let dseProcessorId = doc.querySelector("input[name='dse_processorId']")?.value;
    let dsePageId = doc.querySelector("input[name='dse_pageId']")?.value;
    let dseProcessorState = doc.querySelector("input[name='dse_processorState']")?.value;

    if (!dseSessionId || !dseProcessorId) {
      throw new Error(`Vui lòng đăng nhập ${baseUrl} trước khi tải`);
    }

    let searchDate = "";
    if (ngayNop) {
      searchDate = ngayNop.split(" ")[0];
    }
    if (!searchDate) {
      const today = new Date();
      searchDate = [
        String(today.getDate()).padStart(2, "0"),
        String(today.getMonth() + 1).padStart(2, "0"),
        today.getFullYear(),
      ].join("/");
    }

    // 2. Search for the specific maHoSo
    const searchBody = new URLSearchParams({
      dse_sessionId: dseSessionId,
      dse_applicationId: "-1",
      dse_operationName: "traCuuToKhaiProc",
      dse_pageId: dsePageId,
      dse_processorState: dseProcessorState,
      dse_processorId: dseProcessorId,
      dse_errorPage: "error_page.jsp",
      dse_nextEventName: "query",
      pn: "1",
      maTKhai: "00",
      tenTKhai: "",
      kieuKy: "",
      ma_gd: maHoSo,
      qryFromDate: searchDate,
      qryToDate: searchDate
    });

    await sleep(500);
    const searchRes = await fetchWithRetry(`${baseUrl}/etaxnnt/Request`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: searchBody.toString()
    });
    if (!searchRes.ok) {
      if (searchRes.status === 429) throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
      throw new Error(`HTTP ${searchRes.status} searching declaration`);
    }

    html = await searchRes.text();
    doc = new DOMParser().parseFromString(html, "text/html");

    dseSessionId = doc.querySelector("input[name='dse_sessionId']")?.value || dseSessionId;
    dseProcessorId = doc.querySelector("input[name='dse_processorId']")?.value || dseProcessorId;
    dsePageId = doc.querySelector("input[name='dse_pageId']")?.value || dsePageId;
    dseProcessorState = doc.querySelector("input[name='dse_processorState']")?.value || dseProcessorState;

    const rows = [...doc.querySelectorAll("#allResultTableBody tr")];
    let matchingRow = null;
    let detailInfo = {};

    for (const tr of rows) {
      const tds = tr.querySelectorAll("td");
      const code = tds[1]?.textContent.trim();
      if (code === maHoSo) {
        matchingRow = tr;
        const toKhaiText = tds[2]?.textContent.replace(/Tải tệp tờ khai về/gi, "").replace(/\s+/g, " ").trim() || "";
        detailInfo = {
          toKhai: toKhaiText,
          kyTinhThue: tds[3]?.textContent.trim() || "",
          loaiToKhai: tds[4]?.textContent.trim() || "",
          lanNop: tds[5]?.textContent.trim() || "",
          lanBoSung: tds[6]?.textContent.trim() || "",
          nghiepVu: "",
          tenNguoiNopThue: "",
          maSoThue: "",
          maHoSoDetail: maHoSo,
          donViTiepNhan: tds[9]?.textContent.trim() || "",
          trangThai: tds[10]?.textContent.trim() || "",
          ngayNop: tds[7]?.textContent.trim() || "",
          ngayTiepNhan: "",
          noiNopToKhai: tds[9]?.textContent.trim() || "",
        };
        break;
      }
    }

    if (!matchingRow) {
      return { success: true, noFile: true, detailInfo: { maHoSoDetail: maHoSo, ngayNop } };
    }

    const files = [];

    // 3. Download declaration XML
    await sleep(500);
    const downloadTkhaiUrl = `${baseUrl}/etaxnnt/Request?dse_sessionId=${dseSessionId}&dse_applicationId=-1&dse_operationName=traCuuToKhaiProc&dse_pageId=${dsePageId}&dse_processorState=${dseProcessorState}&dse_processorId=${dseProcessorId}&dse_nextEventName=downTkhai&messageId=${maHoSo}`;
    const tkhaiRes = await fetchWithRetry(downloadTkhaiUrl, { credentials: "include" });
    if (tkhaiRes.ok) {
      const blob = await tkhaiRes.blob();
      const base64Data = await blobToBase64(blob);
      files.push({
        filename: `ToKhai_${maHoSo}.xml`,
        data: base64Data
      });
    } else if (tkhaiRes.status === 429) {
      throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
    }

    // 4. Download notifications
    await sleep(500);
    const viewTbaoUrl = `${baseUrl}/etaxnnt/Request?dse_sessionId=${dseSessionId}&dse_applicationId=-1&dse_operationName=traCuuToKhaiProc&dse_pageId=${dsePageId}&dse_processorState=${dseProcessorState}&dse_processorId=${dseProcessorId}&dse_nextEventName=viewTBao&ctMaGDich=${maHoSo}`;
    const tbaoRes = await fetchWithRetry(viewTbaoUrl, { credentials: "include" });
    if (tbaoRes.ok) {
      const tbaoHtml = await tbaoRes.text();
      const tbaoDoc = new DOMParser().parseFromString(tbaoHtml, "text/html");

      const tbSessionId = tbaoDoc.querySelector("input[name='dse_sessionId']")?.value || dseSessionId;
      const tbProcessorId = tbaoDoc.querySelector("input[name='dse_processorId']")?.value || dseProcessorId;
      const tbPageId = tbaoDoc.querySelector("input[name='dse_pageId']")?.value || dsePageId;
      const tbProcessorState = tbaoDoc.querySelector("input[name='dse_processorState']")?.value || dseProcessorState;

      const tbRows = [...tbaoDoc.querySelectorAll("table tbody tr")];
      for (const tr of tbRows) {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 3) continue;

        const aLink = tds[1]?.querySelector("a[onclick*='downloadFile']");
        if (!aLink) continue;

        const onclickVal = aLink.getAttribute("onclick");
        const match = onclickVal.match(/downloadFile\('([^']+)'\)/);
        if (!match) continue;

        const messageId = match[1];
        const tbNumber = aLink.textContent.trim();
        const tbDesc = tds[2]?.textContent.trim() || "";

        const tbDownloadBody = new URLSearchParams({
          dse_sessionId: tbSessionId,
          dse_applicationId: "-1",
          dse_operationName: "traCuuToKhaiProc",
          dse_pageId: tbPageId,
          dse_processorState: tbProcessorState,
          dse_processorId: tbProcessorId,
          dse_errorPage: "error_page.jsp",
          dse_nextEventName: "download",
          pn: "1",
          messageId: messageId
        });

        await sleep(500);
        const tbDownloadRes = await fetchWithRetry(`${baseUrl}/etaxnnt/Request`, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: tbDownloadBody.toString()
        });

        if (tbDownloadRes.ok) {
          const tbBlob = await tbDownloadRes.blob();
          const tbBase64Data = await blobToBase64(tbBlob);
          const cleanNumber = toFilename(tbNumber);
          const cleanDesc = toFilename(tbDesc);
          files.push({
            filename: `TB_${cleanNumber}_${cleanDesc}.xml`,
            data: tbBase64Data
          });
        } else if (tbDownloadRes.status === 429) {
          throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
        }
      }
    } else if (tbaoRes.status === 429) {
      throw new Error("Máy chủ Thuế điện tử báo quá nhiều yêu cầu (HTTP 429). Vui lòng thử lại sau.");
    }

    return { success: true, files, detailInfo };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function fetchFilesDvcInTab(maHoSo, baseUrl) {
  try {
    const warnings = [];
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 2000) {
      let res;
      for (let i = 0; i <= retries; i++) {
        try {
          res = await fetch(url, options);
          if (res.status === 429) {
            if (i < retries) {
              await sleep(delayMs * (i + 1));
              continue;
            }
          }
          return res;
        } catch (err) {
          if (i < retries) {
            await sleep(delayMs * (i + 1));
            continue;
          }
          throw err;
        }
      }
      return res;
    }

    async function blobToBase64(blob) {
      const ab = await blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = "";
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }

    function getFilename(res, fallback) {
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      return m ? decodeURIComponent(m[1].trim()) : fallback;
    }

    const detailRes = await fetchWithRetry(`${baseUrl}/tthc/tchs/files/detail/${maHoSo}?loai=`, { credentials: "include" });
    if (!detailRes.ok) {
      if (detailRes.status === 429) throw new Error("Máy chủ quá tải (HTTP 429). Vui lòng thử lại sau.");
      throw new Error(`HTTP ${detailRes.status}: ${detailRes.statusText}`);
    }
    const detailHtml = await detailRes.text();
    const doc = new DOMParser().parseFromString(detailHtml, "text/html");

    const xsrfToken =
      doc.querySelector("input[name='_csrf']")?.value ||
      doc.querySelector("#csrfToken")?.value ||
      doc.querySelector("meta[name='csrf-token']")?.content || "";

    function toFilename(text) {
      return text.replace(/^V\/v:\s*/i, "").trim()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/gi, "d").replace(/[^a-zA-Z0-9\s_-]/g, "")
        .replace(/\s+/g, "_").replace(/_+/g, "_").substring(0, 80);
    }

    function extractDetail(d) {
      const lines = [];
      d.querySelectorAll(".row.mb-3").forEach(row => {
        const labels = row.querySelectorAll("label.col-form-label-sm");
        const inputs = row.querySelectorAll("input[readonly]");
        labels.forEach((label, i) => {
          const input = inputs[i];
          if (input) {
            const l = label.textContent.trim();
            const v = input.value.trim();
            if (l && v) lines.push(`${l}: ${v}`);
          }
        });
      });
      return lines;
    }

    const summaryLines = extractDetail(doc);

    const thongBaoItems = [...doc.querySelectorAll("a[data-id][onclick*='downloadThongBao']")]
      .map((a, i) => {
        const id = a.getAttribute("data-id");
        const titleEl = a.closest(".row")?.querySelector(".fw-bold");
        const title = titleEl ? toFilename(titleEl.textContent.trim()) : `TB_${id}`;
        return { id, filename: `TB${i + 1}_${title}.xml` };
      }).filter(item => item.id);

    async function postDownload(path, body, fallbackName) {
      const res = await fetchWithRetry(`${baseUrl}${path}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-XSRF-TOKEN": xsrfToken,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error("Máy chủ quá tải (HTTP 429). Vui lòng thử lại sau.");
        }
        if (res.status === 500) {
          try {
            const text = await res.text();
            if (text && text.trim()) {
              const errJson = JSON.parse(text);
              if (errJson.error === "Không tìm thấy hồ sơ tương ứng!" || (typeof errJson.error === "string" && errJson.error.includes("Không tìm thấy"))) {
                return null;
              }
            }
          } catch (e) { /* ignore parse error */ }
        }
        throw new Error(`HTTP ${res.status} từ ${path}`);
      }
      const contentType = res.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        const text = await res.text();
        if (!text || !text.trim()) {
          return null;
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch (e) {
          throw new Error(`Lỗi đọc JSON từ ${path}: ${e.message}`);
        }
        if (json.error && (json.error === "Không tìm thấy hồ sơ tương ứng!" || (typeof json.error === "string" && json.error.includes("Không tìm thấy")))) {
          return null;
        }
        if (json.content !== undefined && json.content !== null) return { data: json.content, filename: json.fileName || fallbackName };
        if (json.data?.noiDungTep !== undefined && json.data?.noiDungTep !== null) {
          const fn = json.data.tenTep ? `${json.data.tenTep}.${json.data.dinhDangTep || "xml"}` : fallbackName;
          return { data: json.data.noiDungTep, filename: json.fileName || fn };
        }
        if (json.content === null || json.data === null) {
          return null;
        }
        throw new Error(`Định dạng JSON không nhận ra từ ${path}`);
      }
      const blob = await res.blob();
      return { data: await blobToBase64(blob), filename: getFilename(res, fallbackName) };
    }

    await sleep(500);
    let hoSo = null;
    try {
      hoSo = await postDownload("/tthc/tchs/downloadhoso", { maHoSo }, `hoso_${maHoSo}.zip`);
    } catch (e) {
      warnings.push('Lỗi tải hồ sơ: ' + e.message);
    }

    const thongBaos = [];
    for (const { id, filename } of thongBaoItems) {
      await sleep(500);
      try {
        const tb = await postDownload("/tthc/tchs/downloadthongbao", { idTbao: id, loaiTBao: "" }, filename);
        if (tb) {
          tb.filename = filename;
          thongBaos.push(tb);
        }
      } catch (e) {
        warnings.push(`Lỗi tải thông báo ${id}: ${e.message}`);
      }
    }

    await sleep(500);
    let taiLieuItems = [];
    try {
      const tlRes = await fetchWithRetry(`${baseUrl}/tthc/tchs/data-tai-lieu-dkem`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", "X-XSRF-TOKEN": xsrfToken },
        body: JSON.stringify({ maHso: maHoSo }),
      });
      if (tlRes.ok) {
        const text = await tlRes.text();
        if (text && text.trim()) {
          const tlJson = JSON.parse(text);
          if (tlJson && Array.isArray(tlJson.data)) {
            taiLieuItems = tlJson.data.map((item, i) => ({
              maTep: item.maTep,
              filename: `TL${i + 1}_${toFilename(item.tenTep || "TaiLieu")}.${item.dinhDangTep || "bin"}`,
            }));
          }
        }
      }
    } catch (e) {
      warnings.push('Không lấy được danh sách tài liệu đính kèm: ' + e.message);
    }

    const taiLieus = [];
    for (const { maTep, filename } of taiLieuItems) {
      await sleep(500);
      try {
        const tl = await postDownload("/tthc/tchs/download-tai-lieu-dkem", { maHso: maHoSo, idGiaoDichTthcFile: maTep }, filename);
        if (tl) {
          tl.filename = filename;
          taiLieus.push(tl);
        }
      } catch (e) {
        warnings.push(`Lỗi tải tài liệu đính kèm ${filename}: ${e.message}`);
      }
    }

    return { success: true, hoSo, thongBaos, taiLieus, summaryLines, warnings };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Same corpIndexProc → mainForm → goProcForm/home → login chain as the reference.
async function prepareTdtLoginInTab(baseUrl) {
  const inputs = html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return Object.fromEntries([...doc.querySelectorAll('input[name]')].map(input => [input.name, input.value]));
  };
  const request = async (url, options = {}) => {
    const res = await fetch(url, { ...options, credentials: 'include' });
    if (!res.ok) throw new Error('Thuế điện tử trả HTTP ' + res.status);
    return res.text();
  };
  const post = values => request(baseUrl + '/etaxnnt/Request', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() });
  let html = await request(baseUrl + '/etaxnnt/Request?dse_operationName=corpIndexProc');
  for (let n = 0; n < 4; n++) {
    const redirect = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (!redirect) break;
    const url = new URL(redirect, baseUrl);
    if (url.origin !== baseUrl) throw new Error('Cổng chuyển sang địa chỉ đăng nhập khác.');
    html = await request(url.href);
  }
  const main = inputs(html);
  if (!main.dse_sessionId) throw new Error('Không khởi tạo được phiên Thuế điện tử.');
  html = await post(main);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const form = doc.querySelector('#goProcForm');
  const go = form ? Object.fromEntries([...form.querySelectorAll('input[name]')].map(input => [input.name, input.value])) : inputs(html);
  html = await post({ ...go, dse_operationName: 'corpIndexProc', dse_nextEventName: 'home' });
  const home = inputs(html);
  const query = new URLSearchParams({ dse_sessionId: home.dse_sessionId || main.dse_sessionId, dse_applicationId: '-1', dse_pageId: home.dse_pageId || '4', dse_operationName: 'corpIndexProc', dse_errorPage: 'error_page.jsp', dse_processorState: 'initial', dse_nextEventName: 'login' });
  return inputs(await request(baseUrl + '/etaxnnt/Request?' + query));
}
module.exports = { searchTdtInTab, fetchFilesTdtInTab, fetchFilesDvcInTab, prepareTdtLoginInTab };
