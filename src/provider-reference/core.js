(function attachInvoiceCore(root, factory) {
  const api = factory();
  root.InvoiceCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createInvoiceCore() {
  "use strict";

  const PROVIDER_REGISTRY = typeof globalThis !== "undefined" ? globalThis.InvoiceProviderRegistry || null : null;
  const PROVIDER_CAPABILITIES = {
    direct: { status: "supplier-original", label: "Link PDF trực tiếp; xác minh chữ ký trước khi tải", originalPdf: true, automated: true },
    misa: { status: "supplier-original", label: "Tự tải PDF gốc", originalPdf: true, automated: true },
    bachkhoa: { status: "supplier-original", label: "Tự tải PDF gốc", originalPdf: true, automated: true },
    minvoice: { status: "supplier-original", label: "Tự tải PDF gốc khi có mã", originalPdf: true, automated: true },
    hilo: { status: "supplier-original", label: "Tự tải PDF gốc khi có Fkey/ID", originalPdf: true, automated: true },
    wintech: { status: "supplier-original", label: "Tự tải PDF trong ZIP gốc", originalPdf: true, automated: true },
    ts24: { status: "supplier-original", label: "Tự tải PDF gốc theo mã nhận hóa đơn", originalPdf: true, automated: true },
    minhkhang: { status: "supplier-original", label: "Tự tải PDF gốc theo ID trong XML Thuế", originalPdf: true, automated: true },
    vinhhy: { status: "supplier-original", label: "Tự tải PDF gốc theo ID trong XML Thuế", originalPdf: true, automated: true },
    vnisc: { status: "supplier-original", label: "Tự tải PDF gốc theo mã hóa đơn", originalPdf: true, automated: true },
    icorp: { status: "supplier-original", label: "Tự tải PDF gốc khi có endpoint theo người bán", originalPdf: true, automated: true },
    easyinvoice: { status: "supplier-original", label: "Tự tải PDF/ZIP gốc sau tra cứu", originalPdf: true, automated: true },
    bkav: { status: "portal-assisted", label: "Tải qua cổng chính thức", originalPdf: true, automated: false },
    cyberbill: { status: "portal-assisted", label: "Tải qua cổng chính thức", originalPdf: true, automated: false },
    vnpt: { status: "captcha-assisted", label: "Tự điền, người dùng nhập CAPTCHA", originalPdf: true, automated: false },
    viettel: { status: "captcha-assisted", label: "Cần mã bí mật/CAPTCHA", originalPdf: true, automated: false },
    thaison: { status: "captcha-assisted", label: "Cần mã/CAPTCHA", originalPdf: true, automated: false },
    vina: { status: "captcha-assisted", label: "Cần mã/CAPTCHA", originalPdf: true, automated: false },
    visnam: { status: "captcha-assisted", label: "Cần mã/CAPTCHA", originalPdf: true, automated: false },
    nacencomm: { status: "portal-assisted", label: "Tải qua cổng chính thức", originalPdf: true, automated: false },
    efy: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM dựng từ XML", originalPdf: false, automated: false },
    fast: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM tải XML lên cổng", originalPdf: false, automated: false },
    newinvoice: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM tải XML lên cổng", originalPdf: false, automated: false },
    ehoadon: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM tải XML lên cổng", originalPdf: false, automated: false },
    onlinevina: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM dựng từ XML", originalPdf: false, automated: false },
    petrolimex: { status: "xml-derived-only", label: "Chưa xác minh PDF gốc; GAM dựng từ HTML", originalPdf: false, automated: false }
  };

  const PROVIDERS = [
    { id: "misa", name: "MISA meInvoice", verified: true, tvan: ["tvan_misa"], hosts: ["meinvoice.vn"], patterns: ["lhd_misa", "meinvoice"] },
    { id: "vnpt", name: "VNPT Invoice", verified: false, tvan: ["tvan_buuchinhvt"], hosts: ["vnpt-invoice.com.vn", "invoice.vnpt.vn"], patterns: ["vnpt invoice"] },
    { id: "viettel", name: "Viettel S-Invoice", verified: false, tvan: ["tvan_viettel"], hosts: ["vinvoice.viettel.vn", "sinvoice.viettel.vn"], patterns: ["s-invoice", "sinvoice"] },
    { id: "easyinvoice", name: "SoftDreams EasyInvoice", verified: false, tvan: ["tvan_softdreams"], hosts: ["easyinvoice.com.vn"], patterns: ["softdreams", "easyinvoice"] },
    { id: "cyberbill", name: "CyberBill / CyberLotus", verified: true, tvan: ["tvan_cyberlotus"], hosts: ["cyberbill.vn", "xcyber.vn"], patterns: ["cyberbill", "cyberlotus"] },
    { id: "bkav", name: "Bkav eHoadon", verified: false, tvan: ["tvan_bkav"], hosts: ["ehoadon.vn"], patterns: ["bkav ehoadon"] },
    { id: "thaison", name: "Thái Sơn E-Invoice", verified: false, tvan: ["tvan_thaison"], hosts: ["einvoice.vn"], patterns: ["thaison", "thái sơn"] },
    { id: "visnam", name: "VISNAM VIN-HOADON", verified: false, tvan: ["tvan_visnam"], hosts: ["vin-hoadon.com"], patterns: ["visnam", "vin-hoadon"] },
    { id: "vina", name: "VI NA / SmartSign eInvoice", verified: true, tvan: ["tvan_vina"], hosts: ["smartsign.com.vn", "smartvas.vn"], patterns: ["chữ ký số vi na", "smartsign", "smartvas"] },
    { id: "hilo", name: "Hilo Invoice", verified: false, tvan: ["tvan_hilo"], hosts: ["hilo.com.vn", "tracuuhoadon.ipos.vn", "vn.einvoice.grab.com"], patterns: ["hilo invoice", "hilo"] },
    { id: "minvoice", name: "M-Invoice", verified: true, tvan: ["tvan_minvoice", "tvan_m-invoice", "tvan_invoice"], hosts: ["minvoice.com.vn"], patterns: ["m-invoice", "minvoice"] },
    { id: "bachkhoa", name: "Hóa đơn Bách Khoa", verified: true, tvan: ["tvan_bachkhoa"], hosts: ["hdbk.pmbk.vn"], patterns: ["bách khoa", "bach khoa", "pmbk"] },
    { id: "wintech", name: "Wintech / Win Invoice", verified: true, tvan: ["tvan_wintech", "tvan_casta", "tvan_trandinhtung", "tvan_triluat", "tvan_vlc"], hosts: ["wininvoice.vn", "homecasta.vn"], patterns: ["win invoice", "wintech"] },
    { id: "nacencomm", name: "Nacencomm", verified: false, tvan: ["tvan_nacencom"], hosts: ["nacencomm.vn"], patterns: ["nacencomm"] },
    { id: "fpt", name: "FPT.eInvoice", verified: false, tvan: ["tvan_fpt"], hosts: ["fpt.einvoice.vn"], patterns: ["fpt.einvoice", "fpt einvoice"] }
  ];

  function capabilityFor(providerId) {
    return PROVIDER_CAPABILITIES[providerId] || { status: "portal-only", label: "Đã biết cổng; chưa xác minh tự tải PDF gốc", originalPdf: null, automated: false };
  }

  function decorateProvider(provider) {
    const capability = capabilityFor(provider?.id || "unknown");
    return { ...provider, capability, verified: Boolean(provider?.verified || capability.automated) };
  }

  function providerFromRegistry(record) {
    if (!record?.providerId) return null;
    const canonical = PROVIDERS.find((item) => item.id === record.providerId);
    return decorateProvider({
      ...(canonical || { id: record.providerId, name: record.providerName || record.providerId, verified: false, tvan: [], hosts: [], patterns: [] }),
      name: canonical?.name || record.providerName || record.providerId,
      lookupUrl: record.lookupUrl || "",
      lookupSource: "registry"
    });
  }

  // Một số cổng VNPT dùng tenant riêng theo người bán. Đây là các ánh xạ đã
  // được đối chiếu từ bộ dữ liệu thử; không suy đoán tenant từ tên doanh nghiệp.
  const VNPT_TENANT_BY_TAX_CODE = {
    "0300514849": "https://snp-tt78.vnpt-invoice.com.vn/Portal/Index/",
    "0300555450-008": "https://hoadon.petrolimex.com.vn/SearchInvoicebycode/Index"
  };

  const VIETTEL_PORTAL_BY_TAX_CODE = {
    "0100109106": "https://vietteltelecom.vn/tra-cuu-hoa-don-dien-tu",
    "0109266456": "https://sinvoice.epass-vdtc.com.vn/#/tra-cuu-hoa-don"
  };

  // MSTTCGP là MST của đơn vị cung cấp giải pháp lập hóa đơn, không phải MST
  // người bán. Chỉ thêm ánh xạ đã được đối chiếu bằng PDF gốc của chính nền
  // tảng; không suy đoán từ tên doanh nghiệp hoặc mã TVAN trung gian.
  const SOLUTION_PROVIDER_BY_TAX_CODE = {
    "0101243150": {
      providerId: "misa",
      providerName: "MISA meInvoice",
      lookupUrl: "https://www.meinvoice.vn/tra-cuu/"
    }
  };

  function cleanString(value) {
    return value == null ? "" : String(value).trim();
  }

  function firstValue(source, keys, fallback = "") {
    for (const key of keys) {
      const value = source && source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return fallback;
  }

  function toNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (value == null || value === "") return 0;
    let text = String(value).trim().replace(/[\s\u00a0₫đ]/gi, "");
    if (!text) return 0;
    const negative = /^\(.*\)$/.test(text);
    text = text.replace(/[()]/g, "").replace(/[^0-9,.-]/g, "");
    const comma = text.lastIndexOf(",");
    const dot = text.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? "," : ".";
      const thousands = decimal === "," ? /\./g : /,/g;
      text = text.replace(thousands, "").replace(decimal, ".");
    } else if (comma >= 0) {
      const digits = text.length - comma - 1;
      text = digits > 0 && digits <= 2 ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
    } else if (dot >= 0) {
      const dots = (text.match(/\./g) || []).length;
      const digits = text.length - dot - 1;
      if (dots > 1 || digits === 3) text = text.replace(/\./g, "");
    }
    const number = Number(text);
    return Number.isFinite(number) ? (negative ? -Math.abs(number) : number) : 0;
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const text = String(value).trim();
    const vn = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s].*)?$/);
    if (vn) {
      const date = new Date(Number(vn[3]), Number(vn[2]) - 1, Number(vn[1]));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    // API Thuế đôi khi trả thời điểm UTC (ví dụ 17:00Z là 00:00 giờ Việt
    // Nam). Phải đổi sang ngày cục bộ trước khi lấy YYYY-MM-DD, nếu không
    // danh sách hóa đơn sẽ lệch một ngày.
    if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      const zoned = new Date(text);
      return Number.isNaN(zoned.getTime()) ? null : zoned;
    }
    const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoDate) {
      const date = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function isoDay(value) {
    const date = parseDate(value);
    if (!date) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function calendarMonthAgo(value) {
    const date = parseDate(value);
    if (!date) return null;
    const rawMonth = date.getMonth() - 1;
    const year = date.getFullYear() + Math.floor(rawMonth / 12);
    const month = ((rawMonth % 12) + 12) % 12;
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(date.getDate(), lastDay));
  }

  function apiDate(value) {
    const day = isoDay(value);
    if (!day) return "";
    const [year, month, date] = day.split("-");
    return `${date}/${month}/${year}`;
  }

  function formatDate(value) {
    const day = isoDay(value);
    if (!day) return "—";
    const [year, month, date] = day.split("-");
    return `${date}/${month}/${year}`;
  }

  function deepEntries(value, path = "", seen = new WeakSet(), output = []) {
    if (value == null) return output;
    if (typeof value === "object") {
      if (seen.has(value)) return output;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((item, index) => deepEntries(item, `${path}[${index}]`, seen, output));
      } else {
        Object.entries(value).forEach(([key, item]) => {
          const nextPath = path ? `${path}.${key}` : key;
          output.push([nextPath, item]);
          deepEntries(item, nextPath, seen, output);
        });
      }
    }
    return output;
  }

  function deepObjects(value, seen = new WeakSet(), output = []) {
    if (!value || typeof value !== "object" || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => deepObjects(item, seen, output));
    } else {
      output.push(value);
      Object.values(value).forEach((item) => deepObjects(item, seen, output));
    }
    return output;
  }

  function primitive(value) {
    if (value && typeof value === "object" && "_text" in value) return value._text;
    return value;
  }

  function findUrls(raw) {
    const urls = new Set();
    for (const [, value] of deepEntries(raw)) {
      if (typeof value !== "string") continue;
      const variants = new Set([value, value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&")]);
      try { variants.add(decodeURIComponent(value)); } catch (_) {}
      const matches = [...variants].flatMap((text) => text.match(/https?:\/\/[^\s<>"']+/gi) || []);
      for (const match of matches) {
        try {
          const decoded = match.replace(/&amp;/g, "&").replace(/[),.;]+$/, "");
          urls.add(new URL(decoded).href);
        } catch (_) {}
      }
    }
    return [...urls];
  }

  // Bỏ các URL namespace trong XML (ví dụ www.w3.org); đây không phải cổng
  // hóa đơn và không được dùng làm lookupUrl của nhà cung cấp.
  function isInvoicePortalUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (/^(?:www\.)?(?:w3\.org|schema\.org|xml\.org|xmlns\.com|example\.com|example\.net|example\.org)$/i.test(host)) return false;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
      if (/^(?:www\.)?gdt\.gov\.vn$/i.test(host) || host.endsWith(".gdt.gov.vn")) return false;
      if (/\/xmlschema(?:[-_a-z0-9.]*)?(?:\/|$)/i.test(url.pathname)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function providerWithFallback(provider, lookupCode, context = {}) {
    const next = { ...provider };
    const taxCode = cleanString(context.sellerTaxCode).replace(/\s+/g, "");
    const baseTaxCode = taxCode.slice(0, 10);
    const sellerRecord = PROVIDER_REGISTRY?.sellers?.[taxCode] || PROVIDER_REGISTRY?.sellers?.[baseTaxCode];
    if (sellerRecord?.lookupUrl && sellerRecord.providerId === next.id && next.lookupSource !== "document") {
      next.lookupUrl = sellerRecord.lookupUrl;
      next.lookupSource = "registry-seller";
    }
    if (next.lookupUrl?.startsWith("http://einvoice.vn/")) next.lookupUrl = next.lookupUrl.replace(/^http:/, "https:");
    if (next.lookupUrl?.startsWith("http://www.einvoice.vn/")) next.lookupUrl = next.lookupUrl.replace(/^http:/, "https:");
    if (next.id === "easyinvoice" && /^http:\/\/[^/]+\.easyinvoice\.com\.vn\//i.test(next.lookupUrl || "")) next.lookupUrl = next.lookupUrl.replace(/^http:/, "https:");
    if (next.id === "easyinvoice" && next.lookupSource === "tax-guess") {
      next.lookupUrl = "https://tracuu.easyinvoice.vn/Search/Index";
      next.lookupSource = "global-portal";
    }
    if (next.id === "vnpt" && VNPT_TENANT_BY_TAX_CODE[taxCode]) next.lookupUrl = VNPT_TENANT_BY_TAX_CODE[taxCode];
    if (next.id === "viettel" && VIETTEL_PORTAL_BY_TAX_CODE[taxCode]) next.lookupUrl = VIETTEL_PORTAL_BY_TAX_CODE[taxCode];
    if (next.id === "hilo" && next.lookupUrl && lookupCode) {
      try {
        const portal = new URL(next.lookupUrl);
        if (/grab\.com$/i.test(portal.hostname)) {
          next.directPdfUrl = `${portal.origin}/Invoice/DowloadPdf?Fkey=${encodeURIComponent(lookupCode)}`;
        }
      } catch (_) {}
    }
    if (next.id === "minvoice" && lookupCode && taxCode) {
      const direct = new URL("https://tracuuhoadon.minvoice.com.vn/api/Search/SearchInvoice");
      direct.searchParams.set("masothue", taxCode);
      direct.searchParams.set("sobaomat", lookupCode);
      direct.searchParams.set("type", "PDF");
      direct.searchParams.set("inchuyendoi", "false");
      next.directPdfUrl = direct.href;
    }
    if (next.id === "nacencomm" && context.providerInvoiceId && taxCode) {
      const portal = new URL(next.lookupUrl || "https://hoadon78.nacencomm.vn/view.aspx?type=2");
      portal.searchParams.set("type", portal.searchParams.get("type") || "2");
      portal.searchParams.set("madv", taxCode);
      portal.searchParams.set("id", String(context.providerInvoiceId).replace(/^_/, ""));
      next.lookupUrl = portal.href;
      next.lookupSource = "supplier-id";
    }
    if (lookupCode && next.lookupUrl && ["icorp", "asiasoft", "vnisc"].includes(next.id)) {
      if (next.lookupUrl.includes("{0}")) next.lookupUrl = next.lookupUrl.replaceAll("{0}", encodeURIComponent(lookupCode));
      else if (/[?&][^=]+=$/.test(next.lookupUrl)) next.lookupUrl += encodeURIComponent(lookupCode);
      if (["icorp", "vnisc"].includes(next.id) && /(?:\/pdf(?:$|[?#])|viewpdf)/i.test(next.lookupUrl)) {
        next.directPdfUrl = next.lookupUrl;
      }
    }
    if (next.id === "ts24" && lookupCode && next.lookupUrl) {
      next.directPdfUrl = new URL(`invoice/download/pdf/1/${encodeURIComponent(lookupCode)}`, next.lookupUrl.endsWith("/") ? next.lookupUrl : `${next.lookupUrl}/`).href;
    }
    if (next.id === "minhkhang" && context.providerInvoiceId && next.lookupUrl) {
      let supplierId = String(context.providerInvoiceId).replace(/^_/, "");
      const insertAt = taxCode.length + 4;
      if (supplierId.length > insertAt && supplierId[insertAt] !== "_") supplierId = `${supplierId.slice(0, insertAt)}_${supplierId.slice(insertAt)}`;
      next.directPdfUrl = `${next.lookupUrl}${encodeURIComponent(supplierId).replace(/%5F/gi, "_")}`;
    }
    if (next.id === "vinhhy" && context.providerInvoiceId && next.lookupUrl) {
      let supplierId = String(context.providerInvoiceId).replace(/^_/, "");
      if (supplierId.length > 14 && supplierId[14] !== "_") supplierId = `${supplierId.slice(0, 14)}_${supplierId.slice(14)}`;
      const base = next.lookupUrl.replace(/Tracuu\.aspx.*$/i, "");
      next.directPdfUrl = new URL(`Account/GenerateFile.aspx?r=ct_${encodeURIComponent(supplierId).replace(/%5F/gi, "_")}&type=pdf`, base).href;
    }
    const encoded = encodeURIComponent(lookupCode || "");
    if (next.id === "bkav" && lookupCode) {
      // DLHDon/@Id trong XML Thuế là InvoiceGUID mà cổng BKAV dùng trực tiếp.
      // Mã tra cứu dạng ngắn vẫn đi qua màn hình TCHD?MTC như trước.
      next.lookupUrl = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(lookupCode || "")
        ? `https://tchd.ehoadon.vn/Lookup?InvoiceGUID=${encoded}`
        : `https://tchd.ehoadon.vn/TCHD${encoded ? `?MTC=${encoded}` : ""}`;
      next.lookupSource = "supplier-code";
    } else if (!next.lookupUrl && next.id === "bkav") {
      next.lookupUrl = "https://tchd.ehoadon.vn/TCHD";
    }
    if (!next.lookupUrl && next.id === "thaison") next.lookupUrl = "https://einvoice.vn/tra-cuu";
    if (!next.lookupUrl && next.id === "viettel") next.lookupUrl = "https://business.sinvoice.viettel.vn/tracuuhoadon.html";
    if (!next.lookupUrl && next.id === "easyinvoice") {
      next.lookupUrl = "https://tracuu.easyinvoice.vn/Search/Index";
      next.lookupSource = "global-portal";
    }
    if (!next.lookupUrl && next.id === "cyberbill") next.lookupUrl = "https://tracuuhoadon.cyberbill.vn/";
    if (!next.lookupUrl && next.id === "vina") next.lookupUrl = "https://tracuuhd.smartsign.com.vn/";
    if (!next.lookupUrl && next.id === "visnam") next.lookupUrl = "https://tracuu.vin-hoadon.com/";
    if (!next.lookupUrl && next.id === "minvoice") next.lookupUrl = "https://tracuuhoadon.minvoice.com.vn/tra-cuu-hoa-don";
    if (!next.lookupUrl && next.id === "vnpt") {
      next.lookupUrl = VNPT_TENANT_BY_TAX_CODE[taxCode] || "";
    }
    return decorateProvider(next);
  }

  function normalizedLookupLabel(value) {
    return cleanString(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/gi, "d")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
  }

  function isLookupLabel(label) {
    return /^(?:transactionid|searchkey|searchinvoice|fkey|lookupcode|invoicecode|invoiceid|secureid|referencecode|mnhdon|manhanhoadon|mhso|masohdon|matracuu|matracuuhoadon|matc|mtcuu|mtchdon|idtracuu|masobimat|mabimat|mabaomat)$/.test(label);
  }

  function findLookupCode(raw, providerId = "") {
    const keyPattern = /(^|\.)(transactionid|transaction_id|searchkey|search_key|searchinvoice|fkey|lookupcode|lookup_code|matracuu|ma_tra_cuu|mtracuu|matcuu|matc|mtchdon|secretcode|secret_code|invoicecode|invoiceid|secureid|referencecode|mnhdon|manhanhoadon|mhso|masohdon)$/i;
    if (providerId === "bkav" || providerId === "misa") {
      for (const [, value] of deepEntries(raw)) {
        if (typeof value !== "string") continue;
        const documentId = value.match(/<(?:[\w.-]+:)?DLHDon\b[^>]*\bId\s*=\s*["']([^"']{6,128})["']/i)?.[1]?.trim() || "";
        if (providerId === "bkav" && documentId) return documentId;
        // MISA dùng mã tra cứu dạng ngắn làm DLHDon/@Id trên một số hóa đơn
        // máy tính tiền. Chỉ nhận tập ký tự mà DownloadHandler chính thức cho
        // phép, tránh coi GUID/ID nội bộ của nền tảng khác là mã MISA.
        if (providerId === "misa" && /^[A-Z0-9_-]{6,64}$/i.test(documentId)) return documentId;
      }
    }
    for (const object of deepObjects(raw)) {
      const fields = Object.fromEntries(Object.entries(object).map(([key, value]) => [key.toLowerCase(), primitive(value)]));
      const label = normalizedLookupLabel(fields.ttruong ?? fields.fieldname ?? fields.name ?? fields.key);
      if (!isLookupLabel(label)) continue;
      const candidate = cleanString(fields.dlieu ?? fields.value ?? fields.giatri ?? fields.data);
      if (/^[A-Z0-9_./-]{4,128}$/i.test(candidate)) return candidate;
    }
    for (const [path, value] of deepEntries(raw)) {
      if (keyPattern.test(path) && /^[A-Z0-9_./-]{4,128}$/i.test(cleanString(value))) return cleanString(value);
      if (typeof value !== "string") continue;
      const urlMatch = value.match(/[?&](?:code|transactionid|matracuu|fkey|searchkey|secret-code)=([A-Z0-9_./-]{4,128})/i);
      if (urlMatch) return urlMatch[1];
      const xmlMatch = value.match(/<(?:[\w.-]+:)?(?:TransactionID|SearchKey|SearchInvoice|Fkey|MaTraCuu|MTCuu|MTCHDon|LookupCode|InvoiceId|MNHDon|MaNhanHoaDon|MaSoHD|MHSo|MaTC)>\s*([A-Z0-9_./-]{4,128})\s*</i);
      if (xmlMatch) return xmlMatch[1];
      const xmlFields = value.matchAll(/<(?:[\w.-]+:)?(?:TTruong|FieldName|Name)>\s*([^<]{1,120})\s*<\/(?:[\w.-]+:)?(?:TTruong|FieldName|Name)>[\s\S]{0,600}?<(?:[\w.-]+:)?(?:DLieu|Value|GiaTri|Data)>\s*([^<]{1,256})\s*</gi);
      for (const field of xmlFields) {
        if (isLookupLabel(normalizedLookupLabel(field[1])) && /^[A-Z0-9_./-]{4,128}$/i.test(field[2].trim())) return field[2].trim();
      }
    }
    return "";
  }

  function findSupplierInvoiceId(raw) {
    for (const [path, value] of deepEntries(raw)) {
      const candidate = cleanString(primitive(value));
      if (/(^|\.)(providerinvoiceid|supplierinvoiceid|invoiceguid|invids)$/i.test(path) && /^[A-Z0-9_./-]{6,160}$/i.test(candidate)) {
        return candidate.replace(/^_/, "");
      }
      if (typeof value !== "string") continue;
      const xmlId = value.match(/<(?:[\w.-]+:)?DLHDon\b[^>]*\bId\s*=\s*["']([^"']{6,160})["']/i)?.[1];
      if (xmlId) return xmlId.trim().replace(/^_/, "");
    }
    return "";
  }

  function parseTlv(text) {
    const fields = [];
    let offset = 0;
    while (offset + 4 <= text.length) {
      const tag = text.slice(offset, offset + 2);
      const lengthText = text.slice(offset + 2, offset + 4);
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) break;
      const length = Number(lengthText);
      const value = text.slice(offset + 4, offset + 4 + length);
      if (value.length !== length) break;
      fields.push({ tag, value });
      offset += 4 + length;
    }
    return fields;
  }

  function findMisaCodeFromQr(raw) {
    const sellerTaxCode = cleanString(firstValue(raw, ["nbmst", "sellerTaxCode", "mstnb", "mst"])).replace(/[^0-9-]/g, "");
    for (const [path, value] of deepEntries(raw)) {
      if (typeof value !== "string") continue;
      const compact = value.toUpperCase().replace(/\s+/g, "");
      const qrStart = compact.indexOf("000201");
      const qrValue = qrStart >= 0 ? compact.slice(qrStart) : compact;
      if (qrValue.length < 12) continue;
      const outer = parseTlv(qrValue);
      const custom = outer.find((field) => field.tag === "99")?.value;
      if (custom) {
        const identifier = parseTlv(custom).find((field) => field.tag === "00")?.value || "";
        const code = identifier.slice(-12);
        if (/^[A-Z0-9]{12}$/i.test(code)) return code;
      }
      if (sellerTaxCode) {
        const marker = `01${String(sellerTaxCode.length).padStart(2, "0")}${sellerTaxCode}`;
        const markerIndex = qrValue.indexOf(marker);
        const code = markerIndex >= 12 ? qrValue.slice(markerIndex - 12, markerIndex) : "";
        if (/^[A-Z0-9]{12}$/i.test(code)) return code;
      }
      if (/(^|\.)(qrcode|dlqrcode)$/i.test(path) && /^[A-Z0-9]{24,48}$/i.test(qrValue)) {
        const code = qrValue.slice(-12);
        if (/^[A-Z0-9]{12}$/i.test(code)) return code;
      }
    }
    return "";
  }

  // `NgcNhat` identifies the Tax Portal transmission channel, but it does not
  // always identify the supplier portal that actually issued the PDF.  When
  // the XML names a different solution provider, keep that stronger evidence
  // so a stale TVAN mapping cannot open and upload data to the wrong portal.
  function findSolutionProviderTaxCode(raw) {
    for (const [path, value] of deepEntries(raw)) {
      const primitiveValue = primitive(value);
      if (/(^|\.)msttcgp$/i.test(path) && ["string", "number"].includes(typeof primitiveValue)) {
        const taxCode = cleanString(primitiveValue).replace(/[^0-9-]/g, "");
        if (taxCode) return taxCode;
      }
      if (typeof primitiveValue !== "string" || !/<(?:[\w.-]+:)?MSTTCGP\b/i.test(primitiveValue)) continue;
      const taxCode = primitiveValue.match(/<(?:[\w.-]+:)?MSTTCGP\b[^>]*>\s*([0-9-]+)/i)?.[1] || "";
      if (taxCode) return taxCode;
    }
    return "";
  }

  function detectProvider(raw) {
    const urls = findUrls(raw).filter((url) => !url.includes("hoadondientu.gdt.gov.vn") && isInvoicePortalUrl(url));
    const directPdfUrl = urls.find((url) => /(?:\.pdf(?:$|[?#])|[?&]type=pdf(?:&|$)|download[^?#]*pdf)/i.test(url)) || "";
    const genericLookupUrl = urls.find((url) => url !== directPdfUrl) || directPdfUrl || "";
    const sellerTaxCode = cleanString(firstValue(raw, ["nbmst", "sellerTaxCode", "mstnb", "mst"])).replace(/\s+/g, "");
    const solutionProviderTaxCode = findSolutionProviderTaxCode(raw);
    const sellerRecord = PROVIDER_REGISTRY?.sellers?.[sellerTaxCode] || PROVIDER_REGISTRY?.sellers?.[sellerTaxCode.slice(0, 10)];

    // ngcnhat is the Tax Portal's technical TVAN identifier and is stronger
    // evidence than seller names or arbitrary text contained in an invoice.
    const tvanValues = deepEntries(raw)
      .filter(([path, value]) => /(^|\.)ngcnhat$/i.test(path) && typeof primitive(value) === "string")
      .map(([, value]) => cleanString(primitive(value)).toLowerCase());
    const registryTvanRecord = tvanValues.map((code) => PROVIDER_REGISTRY?.tvan?.[code]).find(Boolean);
    const solutionProviderRecord = SOLUTION_PROVIDER_BY_TAX_CODE[solutionProviderTaxCode];
    let provider = PROVIDERS.find((item) => item.tvan.some((code) => tvanValues.includes(code)));
    const registryProvider = providerFromRegistry(registryTvanRecord);
    const solutionProvider = providerFromRegistry(solutionProviderRecord);
    if (!provider && registryProvider) provider = registryProvider;
    if (provider && registryProvider?.id === provider.id && registryProvider.lookupUrl) {
      provider = { ...provider, lookupUrl: registryProvider.lookupUrl, lookupSource: "registry-tvan" };
    }
    // MSTTCGP là MST của đơn vị cung cấp giải pháp lập hóa đơn và là bằng
    // chứng trực tiếp hơn kênh truyền nhận NgcNhat. Ca máy tính tiền MISA thực
    // tế chỉ có MSTTCGP=0101243150, không có NgcNhat/URL nhà cung cấp.
    if (solutionProvider) {
      provider = { ...solutionProvider, lookupSource: "solution-provider-tax-code" };
    }
    if (!provider && sellerRecord) provider = providerFromRegistry(sellerRecord);
    const hosts = urls.map((url) => {
      try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
    });
    const hostProvider = PROVIDERS.find((item) => item.hosts.some((suffix) => hosts.some((host) => host === suffix || host.endsWith(`.${suffix}`))));
    // PortalLink/Fkey trỏ thẳng vào nền tảng phát hành là bằng chứng thực thi
    // mạnh hơn mã TVAN trung gian. Ví dụ một hóa đơn có tvan_viettel nhưng cổng
    // tải thật là tenant *.easyinvoice.com.vn.
    if (hostProvider && (!provider || hostProvider.id !== provider.id)) provider = hostProvider;

    // Verified live case: XML with NgcNhat=tvan_vina but MSTTCGP=0318511655
    // was rejected by SmartSign as not issued by VI NA. TTC distributes more
    // than one invoice platform, so without an explicit portal URL or lookup
    // code the only honest classification is unresolved TTC, not SmartSign.
    if (solutionProviderTaxCode === "0318511655" && !hostProvider) {
      provider = {
        id: "unknown",
        name: "Chưa xác định — giải pháp TTC",
        verified: false,
        tvan: [],
        hosts: [],
        patterns: [],
        lookupUrl: "",
        lookupSource: "solution-provider-tax-code"
      };
    }

    if (!provider) {
      const evidence = deepEntries(raw)
        .filter(([path, value]) =>
          ["string", "number"].includes(typeof primitive(value)) &&
          /(^|\.)(provider|tvan|website|portal|url|link|transactionid|lookupcode|matracuu|ma_tra_cuu)$/i.test(path)
        )
        .map(([path, value]) => `${path}:${primitive(value)}`)
        .join(" ")
        .toLowerCase();
      provider = PROVIDERS.find((item) => item.patterns.some((pattern) => evidence.includes(pattern)));
    }

    if (provider) {
      const knownHosts = new Set(provider.hosts || []);
      for (const knownUrl of [provider.lookupUrl, registryTvanRecord?.lookupUrl, sellerRecord?.lookupUrl]) {
        try { if (knownUrl) knownHosts.add(new URL(knownUrl).hostname.toLowerCase()); } catch (_) {}
      }
      const documentLookupUrl = urls.find((url) => {
        if (url === directPdfUrl) return false;
        try {
          const host = new URL(url).hostname.toLowerCase();
          return [...knownHosts].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
        } catch (_) { return false; }
      }) || "";
      let resolved = {
        ...provider,
        tvanCode: tvanValues[0] || sellerRecord?.tvanCode || provider.tvanCode || "",
        solutionProviderTaxCode,
        directPdfUrl,
        lookupUrl: documentLookupUrl || provider.lookupUrl || "",
        lookupSource: documentLookupUrl ? "document" : provider.lookupSource || ""
      };
      if (sellerRecord?.providerId === resolved.id && sellerRecord.lookupUrl && !documentLookupUrl) {
        resolved = { ...resolved, lookupUrl: sellerRecord.lookupUrl, lookupSource: "registry-seller" };
      }
      return decorateProvider(resolved);
    }
    if (directPdfUrl) return decorateProvider({ id: "direct", name: "Liên kết PDF của nhà cung cấp", verified: true, directPdfUrl, lookupUrl: directPdfUrl });
    if (genericLookupUrl) {
      let host = "Nhà cung cấp hóa đơn";
      try { host = new URL(genericLookupUrl).hostname; } catch (_) {}
      return decorateProvider({ id: "generic", name: host, verified: false, directPdfUrl: "", lookupUrl: genericLookupUrl, lookupSource: "document" });
    }
    return decorateProvider({ id: "unknown", name: "Chưa nhận diện", verified: false, directPdfUrl: "", lookupUrl: "" });
  }

  function normalizeInvoice(raw = {}) {
    const date = firstValue(raw, ["tdlap", "nlap", "issuedDate", "invoiceIssuedDate", "tdlhdon"]);
    const sellerTaxCode = cleanString(firstValue(raw, ["nbmst", "sellerTaxCode", "mstnb", "mst"]));
    const sellerName = cleanString(firstValue(raw, ["nbten", "sellerName", "sellerLegalName", "tennb"]));
    const buyerTaxCode = cleanString(firstValue(raw, ["nmmst", "buyerTaxCode", "mstnmua", "mstnguoiMua"]));
    const templateCode = cleanString(firstValue(raw, ["khmshdon", "templateCode", "mshdon"]));
    const series = cleanString(firstValue(raw, ["khhdon", "invoiceSeries", "kyhieu"]));
    const number = cleanString(firstValue(raw, ["shdon", "invoiceNumber", "sohoadon"]));
    const pretax = toNumber(firstValue(raw, ["tgtcthue", "tgttcthue", "tgcthue", "totalAmountWithoutVAT", "totalBeforeTax"]));
    const tax = toNumber(firstValue(raw, ["tgtthue", "tgtt", "totalVATAmount", "taxAmount"]));
    let total = toNumber(firstValue(raw, ["tgtttbso", "tgtttb", "totalAmountWithVAT", "totalAmount", "tongtien"]));
    if (!total && (pretax || tax)) total = pretax + tax;
    const id = cleanString(firstValue(raw, ["id", "idhdon", "invoiceId"]));
    const key = [sellerTaxCode, templateCode, series, number, isoDay(date), id].join("|");
    let provider = detectProvider(raw);
    if (provider.id === "unknown" && VIETTEL_PORTAL_BY_TAX_CODE[sellerTaxCode]) provider = { ...PROVIDERS.find((item) => item.id === "viettel") };
    if (provider.id === "unknown" && VNPT_TENANT_BY_TAX_CODE[sellerTaxCode]) provider = { ...PROVIDERS.find((item) => item.id === "vnpt") };
    const lookupCode = findLookupCode(raw, provider.id) || (provider.id === "misa" ? findMisaCodeFromQr(raw) : "");
    const providerInvoiceId = findSupplierInvoiceId(raw);
    provider = providerWithFallback(provider, lookupCode, { sellerTaxCode, providerInvoiceId });
    return {
      id,
      key,
      date: isoDay(date),
      sellerTaxCode,
      sellerName,
      buyerTaxCode,
      templateCode,
      series,
      number,
      pretax,
      tax,
      total,
      currency: cleanString(firstValue(raw, ["dvtte", "currencyCode"], "VND")) || "VND",
      nature: firstValue(raw, ["tchat", "nature", "adjustmentType"], ""),
      status: firstValue(raw, ["tthai", "ttxly", "status", "statusName"], ""),
      invoiceType: cleanString(firstValue(raw, ["lhdon", "invoiceType"])),
      gdtEndpoint: cleanString(firstValue(raw, ["__gdtEndpoint"])),
      provider,
      lookupCode,
      providerInvoiceId,
      raw
    };
  }

  function invoiceIdentity(invoice) {
    return [invoice.sellerTaxCode, invoice.templateCode, invoice.series, invoice.number, invoice.date].join("|");
  }

  function dedupeInvoices(invoices) {
    const map = new Map();
    for (const invoice of invoices) {
      const normalized = invoice.raw ? invoice : normalizeInvoice(invoice);
      const identity = invoiceIdentity(normalized) || normalized.key;
      if (!map.has(identity)) map.set(identity, normalized);
    }
    return [...map.values()];
  }

  function isCancelled(invoice) {
    const text = `${invoice.status || ""} ${invoice.raw?.ttten || ""} ${invoice.raw?.tthdon || ""}`
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    return /(^|\s)(da )?(huy|xoa bo|cancelled)(\s|$)/.test(text);
  }

  function filterInvoices(invoices, filters = {}) {
    const from = isoDay(filters.from);
    const to = isoDay(filters.to);
    const sellerTaxCode = cleanString(filters.sellerTaxCode).toLowerCase();
    const gdtEndpoint = cleanString(filters.gdtEndpoint);
    const keyword = cleanString(filters.keyword).toLowerCase();
    return invoices.filter((item) => {
      const invoice = item.raw ? item : normalizeInvoice(item);
      if (from && invoice.date < from) return false;
      if (to && invoice.date > to) return false;
      if (sellerTaxCode && !invoice.sellerTaxCode.toLowerCase().includes(sellerTaxCode)) return false;
      if (gdtEndpoint && invoice.gdtEndpoint !== gdtEndpoint) return false;
      if (keyword) {
        const haystack = [invoice.sellerName, invoice.sellerTaxCode, invoice.number, invoice.series, invoice.lookupCode].join(" ").toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }

  function summarize(invoices, grouping = "day") {
    const rawCount = invoices.length;
    const unique = dedupeInvoices(invoices);
    const included = unique.filter((invoice) => !isCancelled(invoice));
    const groups = new Map();
    let pretax = 0;
    let tax = 0;
    let total = 0;
    const currencies = new Map();
    for (const invoice of included) {
      pretax += invoice.pretax;
      tax += invoice.tax;
      total += invoice.total;
      const period = grouping === "month" ? invoice.date.slice(0, 7) : invoice.date;
      const currency = invoice.currency || "VND";
      const key = `${period}|${currency}`;
      const current = groups.get(key) || { key: period, currency, count: 0, pretax: 0, tax: 0, total: 0 };
      current.count += 1;
      current.pretax += invoice.pretax;
      current.tax += invoice.tax;
      current.total += invoice.total;
      groups.set(key, current);
      const currencyTotal = currencies.get(currency) || { currency, count: 0, pretax: 0, tax: 0, total: 0 };
      currencyTotal.count += 1;
      currencyTotal.pretax += invoice.pretax;
      currencyTotal.tax += invoice.tax;
      currencyTotal.total += invoice.total;
      currencies.set(currency, currencyTotal);
    }
    return {
      rawCount,
      uniqueCount: unique.length,
      duplicateCount: rawCount - unique.length,
      includedCount: included.length,
      excludedCancelled: unique.length - included.length,
      pretax,
      tax,
      total,
      mixedCurrencies: currencies.size > 1,
      currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency))
    };
  }

  function mergeInvoiceDetail(invoice, detail) {
    const combined = { ...(invoice.raw || invoice), ...(detail || {}), __list: invoice.raw || invoice, __detail: detail || {} };
    return normalizeInvoice(combined);
  }

  function safeFilename(invoice) {
    const parts = [invoice.date, invoice.sellerTaxCode, invoice.series, invoice.number].filter(Boolean);
    return `${parts.join("_").replace(/[^a-zA-Z0-9._-]+/g, "-") || "hoa-don-goc"}.pdf`;
  }

  return {
    PROVIDERS,
    PROVIDER_CAPABILITIES,
    PROVIDER_REGISTRY,
    VIETTEL_PORTAL_BY_TAX_CODE,
    VNPT_TENANT_BY_TAX_CODE,
    apiDate,
    calendarMonthAgo,
    cleanString,
    dedupeInvoices,
    detectProvider,
    filterInvoices,
    findLookupCode,
    findMisaCodeFromQr,
    findSupplierInvoiceId,
    findUrls,
    formatDate,
    isInvoicePortalUrl,
    isoDay,
    isCancelled,
    mergeInvoiceDetail,
    normalizeInvoice,
    parseDate,
    providerWithFallback,
    safeFilename,
    summarize,
    toNumber
  };
});
