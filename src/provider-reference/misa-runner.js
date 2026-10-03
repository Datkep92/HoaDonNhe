(function initMisaRunner() {
  "use strict";
  const RUNNER_VERSION = "1.4.2";
  if (globalThis.__invoiceVaultMisaRunnerVersion === RUNNER_VERSION) return;
  globalThis.__invoiceVaultMisaRunnerVersion = RUNNER_VERSION;

  function isVisible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function officialDownloadUrl(code) {
    return `https://www.meinvoice.vn/tra-cuu/DownloadHandler.ashx?Type=pdf&Code=${encodeURIComponent(code)}`;
  }

  function officialPdfSource(rawSource, code) {
    const url = new URL(officialDownloadUrl(code));
    const query = String(rawSource || "").split("?")[1]?.split("#")[0] || "";
    if (query) {
      for (const [key, value] of new URLSearchParams(query)) {
        if (key.toLowerCase() !== "code" || value) url.searchParams.set(key, value);
      }
    }
    url.searchParams.set("Code", code);
    return url.href;
  }

  let misaAssistBusy = false;

  function installMisaCaptchaAssist(message) {
    let panel = document.querySelector("#invoice-vault-misa-assist");
    if (panel) return;
    panel = document.createElement("section");
    panel.id = "invoice-vault-misa-assist";
    panel.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;width:min(330px,calc(100vw - 28px));box-sizing:border-box;padding:14px;border:1px solid #86a98f;border-radius:12px;background:#f7fff9;box-shadow:0 14px 36px rgba(0,0,0,.28);font:14px/1.4 Arial,sans-serif;color:#17221b";
    panel.innerHTML = `
      <div style="font-weight:700;font-size:16px;margin-bottom:5px">Kho hóa đơn gốc · MISA</div>
      <div style="margin-bottom:8px">Hoàn tất CAPTCHA của MISA rồi bấm nút dưới đây. Extension sẽ tự tải PDF gốc.</div>
      <div id="invoice-vault-misa-status" style="font-size:13px;margin-bottom:9px;color:#374151">Mã tra cứu đã được điền sẵn.</div>
      <button id="invoice-vault-misa-continue" type="button" style="width:100%;padding:10px 12px;border:0;border-radius:8px;background:#174c2b;color:#fff;font-weight:700;cursor:pointer">Tra cứu &amp; tự tải PDF gốc</button>`;
    document.documentElement.appendChild(panel);
    panel.querySelector("#invoice-vault-misa-continue")?.addEventListener("click", async () => {
      if (misaAssistBusy) return;
      misaAssistBusy = true;
      const assistButton = panel.querySelector("#invoice-vault-misa-continue");
      const status = panel.querySelector("#invoice-vault-misa-status");
      assistButton.disabled = true;
      assistButton.textContent = "Đang chờ hóa đơn MISA…";
      status.textContent = "Đang tra cứu trên MISA…";
      try {
        document.querySelector("#btnSearchInvoice")?.click();
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const iframe = document.querySelector("#pnResult iframe, #frmResult");
          const src = iframe?.getAttribute("src") || "";
          if (/DownloadHandler\.ashx/i.test(src)) {
            status.textContent = "Đã thấy hóa đơn; đang lưu PDF gốc…";
            status.style.color = "#166534";
            const response = await chrome.runtime.sendMessage({
              type: "MISA_ASSIST_DOWNLOAD",
              code: message.code,
              sourceUrl: officialPdfSource(src, message.code),
              invoice: message.assistInvoice || { filename: message.filename }
            });
            if (!response?.ok) throw new Error(response?.error || "Không lưu được PDF MISA.");
            status.textContent = "Đã tải PDF gốc. Cửa sổ sẽ tự đóng.";
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error("MISA chưa trả hóa đơn. Kiểm tra CAPTCHA rồi thử lại.");
      } catch (error) {
        status.textContent = error.message || String(error);
        status.style.color = "#b91c1c";
      } finally {
        misaAssistBusy = false;
        assistButton.disabled = false;
        assistButton.textContent = "Thử lại tra cứu & tự tải";
      }
    });
  }

  async function lookupViaPage(code, message) {
    const input = document.querySelector("#txtCode");
    const button = document.querySelector("#btnSearchInvoice");
    if (!input || !button) throw new Error("Không tìm thấy biểu mẫu tra cứu MISA.");

    const previousSrc = document.querySelector("#pnResult iframe, #frmResult")?.getAttribute("src") || "";
    setInputValue(input, code);
    button.click();

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (isVisible(document.querySelector("#captchaContainer"))) {
        installMisaCaptchaAssist(message);
        return {
          requiresUser: true,
          error: "MISA yêu cầu CAPTCHA. Hãy hoàn tất CAPTCHA rồi bấm “Tra cứu & tự tải PDF gốc” trong cửa sổ nhỏ."
        };
      }

      const iframe = document.querySelector("#pnResult iframe, #frmResult");
      const src = iframe?.getAttribute("src") || "";
      const popup = document.querySelector("#showPopupInvoice");
      const hasInvoice = /DownloadHandler\.ashx/i.test(src) &&
        (src !== previousSrc || new RegExp(`Code=${encodeURIComponent(code)}`, "i").test(src));
      if (hasInvoice || (isVisible(popup) && /DownloadHandler\.ashx/i.test(src))) {
        // Giữ nguyên ext token do MISA cấp trong iframe. Một số hóa đơn trả
        // 200/0 byte nếu rút gọn về URL chỉ có Type + Code.
        const sourceUrl = officialPdfSource(src, code);
        return {
          ok: true,
          provider: "MISA meInvoice",
          sourceUrl,
          viewerUrl: new URL(src, location.href).href,
          preparedByOfficialLookup: true,
          // Không click nút của trang sau khi đã qua await: handler của MISA
          // có thể gọi window.open và Chrome sẽ từ chối vì mất user gesture.
          // Service worker sẽ tải trực tiếp DownloadHandler.ashx và kiểm tra
          // chữ ký %PDF- trước khi lưu file.
          nativeDownloadTriggered: false,
          downloadViaBackground: message.mode === "download"
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("MISA chưa mở được hóa đơn trong 20 giây. Tác vụ đã dừng để không quay vô hạn.");
  }

  async function run(message) {
    const code = String(message.code || "").trim();
    if (!/^[A-Z0-9_-]{6,64}$/i.test(code)) throw new Error("Mã tra cứu MISA không hợp lệ hoặc đang bị thiếu.");
    return lookupViaPage(code, message);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "MISA_ORIGINAL_PDF") return false;
    run(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  });
})();
