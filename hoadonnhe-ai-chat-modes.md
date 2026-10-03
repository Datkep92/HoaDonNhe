# AI Chat Hub — Biến EXE Thành Trung Tâm Chat AI (Miễn Phí + Tự Gán API Key)

> **Bản hoàn chỉnh** — gộp mọi khảo sát đã làm và mọi quyết định đã chốt.
> Khảo sát thực tế bằng Chrome DevTools + đọc code 2 extension thật + đọc code app.
> Ngày: 03/10/2026 · App: `cn-tax-tools` (CN Tax Tools)

---

## 🎯 Mục Tiêu

Biến EXE hiện tại thành **trung tâm chat AI** với 2 nhóm chế độ:

| Nhóm | Cần API key? | Cài gì thêm? | Chi phí | Dữ liệu đi đâu? |
|---|---|---|---|---|
| **AI miễn phí** (`type: web`) | ❌ Không | Không | 0 đồng | Máy chủ `easytool.dev` |
| **AI tự gán key** (`type: openai`) | ✅ Tự nhập | Không | Tiền của người dùng | Thẳng máy chủ AI |
| **AI chạy trên máy** (`type: local`) | ❌ Không | Ollama + model | 0 đồng | **Không ra khỏi máy** |

**Kèm theo:**
- Chat "Hỗ trợ" hiện tại trở thành **1 trong các chế độ** — không tách khung riêng
- **Nhiều cấu hình**, người dùng **tự thêm** được, không cần build lại EXE
- Chặn theo bản quyền, **có cache** để không làm nghẽn hệ thống đang chạy

---

## ✅ Các Quyết Định Đã Chốt

| # | Câu hỏi | Quyết định | Hệ quả |
|---|---|---|---|
| 1 | Đổi nhãn `Hỗ trợ` → `Trợ lý`? | ❌ **KHÔNG đổi** | `tests/ui-wiring.test.js` **không cần sửa dòng nào** |
| 2 | Chặn AI theo bản quyền? | ✅ **Có** | `ensureLicenseAllowed()`, **có cache 10 phút** |
| 3 | Cho tự thêm chế độ? | ✅ **Có, nhiều cấu hình** | `du_lieu/ai-providers.json`, không giới hạn |
| 4 | Loại provider? | ✅ **3 loại** `web` / `openai` / `local` | — |
| 5 | Lưu API key? | ✅ `secrets.js` (DPAPI) | Key **không** trong JSON, **không** lọt xuống trình duyệt |
| 6 | Sửa `chat-widget.js`? | ❌ **KHÔNG** | Tách file mới `src/ai-chat.js` |
| 7 | Chính sách cầu nối (loại `web`)? | ✅ **Lựa chọn 1** | Allowlist 7 khoá + **từ chối đọc trang** |

---

## 🔬 Khảo Sát Thực Tế (không đoán — đều đã kiểm chứng)

### A. App hiện tại **không có AI nào**

`src/chat-widget.js` **KHÔNG phải AI**. Nó là chat hỗ trợ:

```
EXE (127.0.0.1) → /api/support/* → support.js → Cloudflare Worker → GAS/Firebase → Telegram
```

Grep toàn repo: không có OpenAI / Anthropic / Gemini / DeepSeek / Ollama, không có API key nào.

### B. App **đã gọi API ngoài rồi** — thêm AI API không cần kiến trúc mới

| Dòng | Nội dung |
|---|---|
| `src/support.js:38` | `DEFAULT_GATEWAY_URL = 'https://hoadon-support-gateway.linhnhaxac10.workers.dev'` |
| `src/server.js:1661` | `await fetch(DEVEXTHUB_URL, {...})` |

Node đã có sẵn `fetch` toàn cục. **Không cần thư viện mới.**

### C. Nhưng CSP ép phải đi qua `server.js` — và điều này CÓ LỢI

`src/index.html:2`:
```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'
```

`connect-src 'self'` → **trình duyệt KHÔNG gọi được `api.deepseek.com`**.
Lệnh gọi AI buộc phải nằm trong `server.js` (Node không có CSP).

→ **Hệ quả có lợi: API key không bao giờ lọt xuống trình duyệt.**

### D. Extension tham chiếu #1 — `fgbieegonkgdlkmeaapmkejdlfalonkb` (DeepSeek 3.1.0)

Là **vỏ iframe rỗng**. 7 domain hardcode, toàn bộ logic ở `easytool.dev`
(`server: cloudflare` + `x-railway-edge`). **Không phải DeepSeek thật.**

**3/7 chế độ đã CHẾT:**

| Chế độ | Kết quả |
|---|---|
| `chatgpt-5` | ❌ `ENOTFOUND` — domain không tồn tại |
| `chatgpt-sidebar` | ❌ 404 |
| `gemini-2` | ❌ 404 |
| `grok-ai` / `grok-4` / `deepseek-ai` / `perplexity-ai` | ✅ 200 |

→ **Bài học: không hardcode danh sách chế độ.** Mode chết im lặng, user thấy trang trắng.

### E. ⚠️ Cần **CẦU NỐI (BRIDGE)** — không có thì app lỗi

Web app **không phải trang tĩnh**, nó `postMessage` xin host giúp:

```
Không có bridge:   Error: Storage request timeout   (index-CwFjyni0.js)
Có bridge:         0 lỗi ✅   (14 request, trả lời hết)
```

**Giao thức đã bắt từ traffic thật:**

```js
// web app → host   (e.data là OBJECT, không phải chuỗi!)
frame.contentWindow.postMessage({
  type: 'storageRequest',
  messageId: 'storage_1791021421016_2pulxr4ys',
  operation: 'get' | 'set',
  key: 'savedChats-v1',
  value: <chỉ khi set>
}, targetOrigin)

// host → web app   (PHẢI echo đúng messageId, không thì app treo)
parent.contentWindow.postMessage({
  type: 'storageResponse',
  operation: 'get' | 'set',
  key: 'savedChats-v1',
  messageId: '<echo lại>',
  value: null | <giá trị>
}, origin);
```

> ⚠️ **Bẫy đã vấp:** `e.data` là **object**. Test ban đầu dùng `JSON.parse(e.data)` → ném lỗi → bỏ qua im lặng → tưởng web app không gửi gì.
> Code extension kiểm `typeof r !== "object"` → xác nhận object.

### F. Danh sách khoá — **7**, không phải 6

Trong extension chỉ thấy 6. Chạy thật thì web app hỏi thêm `fpHash-v1`.

| Khoá | Ý nghĩa | Xử lý |
|---|---|---|
| `savedChats-v1` | **Lịch sử chat** | đọc/ghi |
| `personalizedPrompt-v1` | System prompt | đọc/ghi |
| `aiModelName-v1` | Model đang chọn | đọc/ghi |
| `colorScheme-v1` | Màu giao diện | đọc/ghi |
| `storageMetadata-v1` | Siêu dữ liệu | đọc/ghi |
| `fp-v1` | Fingerprint máy | **luôn trả `null`** |
| `fpHash-v1` | Hash fingerprint | **luôn trả `null`** |

> `fp-*` nhiều khả năng là cơ chế chống trộm phiên. Trả `null` → app vẫn chạy (đã kiểm, 0 lỗi), không gửi định danh máy ra ngoài.

### G. ⚠️ Web AI chính thức ĐỀU chặn iframe — đã kiểm 20 trang

**🔒 BỊ CHẶN (15)**

| Trang | Header |
|---|---|
| ChatGPT | `frame-ancestors 'self' chrome-extension://iaiigp… chrome-extension://lfkehkp…` (chỉ 2 extension chính thức của OpenAI) |
| Claude | `frame-ancestors 'self'` |
| Gemini | `X-Frame-Options: DENY` |
| Grok | `X-Frame-Options: SAMEORIGIN` |
| Copilot | `frame-ancestors` chỉ cho Microsoft |
| Perplexity, Poe, Zhipu, Mistral | `SAMEORIGIN` |
| HuggingChat | chỉ `huggingface.co` |
| DuckDuckGo AI | chỉ domain họ |
| Qwen | chỉ `*.qwen.ai` |
| LobeChat, LibreChat (demo) | `frame-ancestors 'none'` |

**✅ ĐƯỢC NHÚNG** (kiểm trong Chrome thật, không có log chặn)

| Trang | Ghi chú |
|---|---|
| Kimi / Moonshot | Không có header chặn |
| Doubao | `report-only` → **có báo nhưng không thực thi** → vẫn nhúng được |
| Yuanbao | Không bị chặn, nhưng JS họ lỗi → nên xác nhận bằng mắt |
| OpenWebUI demo | Không chặn |
| **4 mode easytool.dev** | Không chặn — **đã xác nhận code của chúng CHẠY** |

> ⚠️ **Không chụp được ảnh** (cửa sổ trình duyệt không hiện trong môi trường agent).
> Kết luận dựa vào **log chặn của Chrome** — đáng tin hơn ảnh cho việc này.
> **Nếu thêm chế độ mới, hãy xác nhận bằng mắt khi chạy thật.**

> ⚠️ **Bẫy:** `iframe.onload` **LUÔN bắn** kể cả khi khung bị chặn → báo "LOADED" giả.
> Đã vấp: ChatGPT/Gemini/Claude đều báo LOADED dù đã bị chặn.
> **Không dùng `onload` để kết luận chế độ còn sống.**

**Cách tự kiểm chế độ mới:**
```powershell
curl.exe -sI -o NUL -D - "https://site-can-them.com" | Select-String -Pattern "x-frame-options|frame-ancestors"
```
Không có dòng nào → được nhúng. Có dòng → bị chặn.

### H. Năng lực đọc trang của web app — đã đọc code

Extension có message `pageContentRequest` → inject script đọc **tab đang active**:

```js
const l = document.body.cloneNode(true);          // clone TOÀN BỘ body
// XOÁ: script, style, noscript, iframe, video, audio, img, canvas, svg,
//      header, footer, nav, aside, form, button, input, textarea, select,
//      .sidebar, .menu, .ad, [role=navigation], ...
// XOÁ phần tử ẩn: display:none, visibility:hidden, [hidden], aria-hidden
const walker = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);  // CHỈ TEXT NODE
return { url, faviconUrl, status, title, pageText };
```

| Đọc được ✅ | Không đọc được ❌ |
|---|---|
| Toàn bộ **chữ hiển thị** trên trang | `data.db` (nằm trong tiến trình Node) |
| MST, tên CTY, số tiền **nếu đang hiện trên màn hình** | Mật khẩu MST / JWT / cookies (`du_lieu/secrets/`, DPAPI) |
| `document.title`, URL, favicon | Biến JS của trang (isolated world) |
| | `input` / `textarea` — **xoá khỏi cây** trước khi quét |
| | Chữ trong ảnh, canvas |
| | Tab khác (chỉ tab đang active) |

Áp vào app này: "trang" = `127.0.0.1:port` — chính UI app.
Đang mở tab danh sách hóa đơn → DOM chứa MST, tên CTY, số tiền.

**Trong lúc khảo sát, web app CHƯA gửi `pageContentRequest`** — chỉ gửi `storageRequest`.
Chưa chứng minh được nó không tự gọi → **không implement** là cách an toàn.

### I. Extension tham chiếu #2 — `doaiikbpjcgkphpnoiekjhjfipcolipb` (Flash AI 2.0.0)

Tác giả `pagkit`, framework Plasmo. *"bring your own model"*.

| | easytool (#1) | Flash AI (#2) |
|---|---|---|
| Cách hoạt động | nhúng iframe | **gọi API thật** |
| Ai giữ key | họ | **người dùng** |
| Quay về máy chủ họ | bắt buộc | **không có** |

**Provider (đều chuẩn OpenAI-compatible):**
```js
{ label:"DeepSeek", type:"openai-compatible", baseURL:"https://api.deepseek.com", ... }
{ label:"Moonshot", type:"openai-compatible", baseURL:"https://api.moonshot.ai/v1", ... }
{ label:"OpenAI",   type:"openai-compatible", baseURL:"https://api.openai.com/v1", ... }
{ label:"Ollama",   type:"openai-compatible", baseURL:"http://localhost:11434/v1", ... }
{ label:"Custom",   type:"openai-compatible", baseURL:"", ... }   // ← user điền
```

**Đã kiểm, extension này SẠCH:**
- Không có key hardcode nào (`sk-…`, `sk-ant-…` → 0 kết quả)
- Không có máy chủ của nhà phát triển — domain lạ duy nhất là `www.w3.org`
- Background chỉ **2 chỗ gọi mạng**: `fetch(baseURL + "/chat/completions")`, `fetch(baseURL + "/models")`
- Content script chạy ở mọi trang nhưng **chỉ `sendMessage`, không gửi dữ liệu đi đâu**
- Key lưu `chrome.storage.local`, không đồng bộ cloud

**NHƯNG quyền rất nặng** (không nên học theo):

| Quyền | Vì sao |
|---|---|
| **`debugger`** | Gắn CDP vào tab → điều khiển trình duyệt, đọc bộ nhớ tiến trình |
| `host_permissions: <all_urls>` | Không cần xin |
| content script mọi trang | Chạy cả trang ngân hàng, email, quản trị |
| `web_accessible_resources` khớp `<all_urls>` | Bất kỳ trang nào cũng iframe được panel của nó |

→ **App của bạn KHÔNG cần và KHÔNG NÊN xin `debugger`.**

### J. Mẫu thiết kế provider để học

```js
{ label, type:"openai-compatible", baseURL, models, model,
  supportsTools, supportsVision, preset, apiKey:"" }
```

Đặc biệt: `Custom` với `baseURL:""` → user điền bất kỳ endpoint nào.
**Đây chính là cách trỏ về Worker của bạn mà không phải viết lại UI.**

---

## 🏗️ Kiến Trúc

```
┌─ index.html (127.0.0.1:PORT) ───────────────────────────────────────┐
│  CSP: + frame-src 'self' https://*.easytool.dev                    │
│                                                                      │
│  ┌─ #support-panel ────────────────────────────────────────────┐    │
│  │  <header> Hỗ trợ | CN Tax Tools                    [ × ]   │    │
│  │           <small id="support-mode">…</small>  ← của HỖ TRỢ  │    │
│  │           <small id="ai-mode-label" hidden>…</small> ← CỦA AI │    │
│  │  ┌─ #chat-modes ──────────────────────────────────────┐   │    │
│  │  │ [Hỗ trợ] [DeepSeek] [Kimi] [Ollama] [ + Thêm ]    │   │    │
│  │  └────────────────────────────────────────────────────┘   │    │
│  │                                                              │    │
│  │  type:web   → <iframe id="ai-frame">  + bridge postMessage │    │
│  │  type:openai→ #ai-thread  (vẽ tin nhắn)                    │    │
│  │  type:local → #ai-thread  (như trên)                       │    │
│  │  type:support→ #support-messages (giữ nguyên)               │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
         │  POST /api/ai/storage   (loại web — qua bridge)
         │  GET  /api/ai/stream    (loại openai/local — SSE)
         │  GET/POST /api/ai/providers   (cấu hình + key)
         ▼
    server.js ──► du_lieu/ai-providers.json   (cấu hình, KHÔNG có key)
              ──► du_lieu/ai-storage.json     (lịch sử chat loại web)
              ──► du_lieu/secrets/            (key mã hoá DPAPI)
```

**Nguyên tắc bất di bất dịch:** UI (trình duyệt) **không bao giờ** đọc/ghi file.
Mọi I/O đi qua `server.js` — đúng kiến trúc app đang làm với `data.db`.

### Vì sao tách 2 file cho phần lõi

| File | Trách nhiệm | Test được? |
|---|---|---|
| `src/ai-bridge.js` | Thuần logic giao thức cầu nối. **Không đụng DOM** | ✅ `node --test` |
| `src/ai-providers.js` | Chuẩn hoá + kiểm tra cấu hình provider. **Không đụng DOM** | ✅ `node --test` |
| `src/ai-chat.js` | UI + nối 2 file trên vào DOM | ❌ cần browser |

Repo này test nặng các module thuần (`support.js`, `secrets.js`, `core.js`). Tách vậy để giữ convention.

---

## 🔐 Chính Sách Bảo Mật

### Loại `web` — Lựa chọn 1 (đã chốt)

| Hành vi | Quyết định |
|---|---|
| `get` khoá trong allowlist (7 khoá) | ✅ Cho → `du_lieu/ai-storage.json` |
| `set` khoá trong allowlist | ✅ Cho (để lưu lịch sử chat) |
| `get`/`set` khoá **ngoài** allowlist | ❌ Chặn, trả `null` |
| `fp-v1` / `fpHash-v1` | ❌ Luôn trả `null` |
| `pageContentRequest` | ❌ **KHÔNG implement** |
| Tin nhắn từ origin lạ | ❌ Bỏ qua, không đáp lời |
| Loại tin nhắn lạ | ❌ Bỏ qua im lặng |

Ghi vào file riêng, **KHÔNG đụng `data.db`**.

**Vì sao "cho ghi" mà vẫn an toàn:**

| Việc | Tác hại |
|---|---|
| **Ghi** lịch sử chat | Vô hại — tin nhắn người dùng tự gõ |
| **Đọc** màn hình | **Nguy hiểm** — gửi hóa đơn ra máy chủ người khác |

### Loại `openai` / `local`

- API key chỉ tồn tại trong Node (mã hoá DPAPI), **không** gửi xuống UI
- Chỉ gọi `baseURL` mà **người dùng tự nhập** → người dùng tự chịu trách nhiệm
- `baseURL` **phải kiểm ở server**, không tin UI:

| Chặn | Lý do |
|---|---|
| `javascript:` `data:` `file:` `vbscript:` | Gọi được thứ không nên gọi |
| `http://` (trừ `localhost` / `127.0.0.1`) | Gửi key ra ngoài không mã hoá |
| URL không phân giải được | Báo lỗi rõ ràng |

Cho phép: `https://…`, và `http://localhost|127.0.0.1[:port]` cho `type: local`.

---

## 🔑 Điểm Quan Trọng: KIỂM BẢN QUYỀN PHẢI CÓ CACHE

### Vì sao bắt buộc phải cache

```js
// src/support.js:506
async enforceLicense() {
  const remote = this.gateway('/v1/licenses/status', this.publicDevice());  // ← GỌI MẠNG
  if (remote) {
    const value = await remote;
    this.saveLicense(value);        // ← GHI FILE, mỗi lần
  }
```

Cầu nối gọi `/api/ai/storage` **mọi lần web app cần lưu/đọc**. Đo thật:

```
14 lần "get" trong 4 giây lúc mở khung chat
```

Nếu mỗi request đều `ensureLicenseAllowed()`:

| | Trước | Sau khi cache |
|---|---|---|
| Mở khung chat | **14 request** tới Worker + 14 lần ghi file | **1 request** |
| Gửi 1 tin nhắn | thêm N request | **0** |
| Chat cả buổi | hàng trăm | vài chục (1/10 phút) |

⚠️ **Worker đó dùng chung với chat hỗ trợ** (`support.js`).
Không cache sẽ làm chậm tính năng **đang chạy tốt**.

### Cách làm

```js
// server.js
let aiLicenseCheckedAt = 0;
let aiLicenseOk = false;
const AI_LICENSE_TTL = 10 * 60 * 1000;   // 10 phút

async function enforceAiLicense() {
  const now = Date.now();
  if (now - aiLicenseCheckedAt < AI_LICENSE_TTL) {
    if (!aiLicenseOk) throw new Error('Chưa kích hoạt bản quyền.');
    return;
  }
  await ensureLicenseAllowed();      // gọi mạng — giống 29 chỗ khác
  aiLicenseCheckedAt = now;
  aiLicenseOk = true;
}
```

**Ngoài ra:** kiểm bản quyền **1 lần khi bấm chuyển sang chế độ AI** (loại `openai`/`local`),
thấy hết rồi cache cho cả phiên làm việc. Loại `web` thì không cần vì iframe không tốn token của bạn —
nhưng vẫn nên chặn để nhất quán.

**Reset cache** khi: `saveLicense()` chạy (kích hoạt key) → `aiLicenseCheckedAt = 0`.

---

## 📚 Nhiều Cấu Hình + Tự Thêm

### `du_lieu/ai-providers.json` — không giới hạn

```json
{
  "active": "ds-1",
  "providers": [
    { "id":"web-ds", "label":"DeepSeek web", "type":"web",
      "embedUrl":"https://deepseek-ai.easytool.dev/en/new-chat?ref=app&sidepanel=true" },

    { "id":"ds-1", "label":"DeepSeek của tôi", "type":"openai",
      "baseURL":"https://api.deepseek.com", "model":"deepseek-chat" },
    { "id":"ds-2", "label":"DeepSeek dự phòng", "type":"openai",
      "baseURL":"https://api.deepseek.com", "model":"deepseek-reasoner" },
    { "id":"ks", "label":"Kimi", "type":"openai",
      "baseURL":"https://api.moonshot.ai/v1", "model":"kimi-k2" },
    { "id":"worker", "label":"AI qua Worker của tôi", "type":"openai",
      "baseURL":"https://hoadon-ai.linhnhaxac10.workers.dev/v1", "model":"deepseek-chat" },

    { "id":"ollama", "label":"Ollama trên máy", "type":"local",
      "baseURL":"http://localhost:11434/v1", "model":"qwen2.5" }
  ]
}
```

Thêm / sửa / xoá bằng tay **không cần build lại EXE**.

> `type:"openai"` + `baseURL` trỏ Worker của bạn = **đường thoát khỏi `easytool.dev`**, chỉ cần thêm 1 object, **không sửa UI**.

### API key: KHÔNG lưu trong file cấu hình

`keyRef` trỏ sang kho đã mã hoá. File JSON **không bao giờ** chứa key dạng chữ thường.

```js
// src/secrets.js đã hỗ trợ sẵn:
//   KEYS = ['password','token','cookies']   (dòng 14)
//   read(mst, keys) — truyền khoá tuỳ ý     (dòng 187)
//   write(mst, patch)                        (dòng 232)
// Dùng DPAPI (CurrentUser): copy sang máy khác là không mở được.

// Lưu key AI vào file RIÊNG, không theo MST:
secrets.write('__ai__', { 'key:ds-1': 'sk-...', 'key:ks': 'sk-...' });
const { 'key:ds-1': apiKey } = secrets.read('__ai__', ['key:ds-1']);
```

### UI: nút "+ Thêm"

```
[ Hỗ trợ ][ DeepSeek ][ Kimi ][ Ollama ] [ + Thêm ]
```

| Ô | Ghi chú |
|---|---|
| Tên | Tự đặt, ví dụ "DeepSeek của tôi" |
| Loại | `web` / `openai` / `local` |
| Địa chỉ | Mặc định điền sẵn theo loại, sửa được |
| Model | Gõ tay hoặc bấm "Lấy danh sách" (`GET {baseURL}/models`) |
| API key | Chỉ hiện với `openai`. Lưu vào `secrets.js`, **không** gửi lại đọc |

### So sánh 3 loại

| | `web` | `openai` | `local` |
|---|---|---|---|
| Nơi xử lý | trình duyệt, trong `easytool.dev` | `server.js` | `server.js` |
| Cầu nối `postMessage` | ✅ Cần | ❌ Không | ❌ Không |
| Key trong trình duyệt | ❌ | ✅ Trong Node | Không cần |
| Lịch sử chat | `ai-storage.json` | Server tự quản | Server tự quản |
| Rủi ro | Cao | Thấp | Rất thấp |
| Cần cầu nối bridge | ✅ | ❌ | ❌ |

---

## 🎨 Giao Diện

### Vấn đề kích thước

Panel hiện tại là góc nhỏ gọn. Khung chat AI cần chỗ rộng.

```
┌──────────────────────────────────────────────────────────┐
│ Hỗ trợ · CN Tax Tools · AI: DeepSeek             [ × ] │
├──────────────────────────────────────────────────────────┤
│  [Hỗ trợ] [DeepSeek] [Kimi] [Ollama] [ + Thêm ]         │
├──────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────┐  │
│  │  support → #support-messages (khung chat gốc)       │  │
│  │  web      → <iframe id="ai-frame">                  │  │
│  │  openai   → #ai-thread                             │  │
│  │  local    → #ai-thread                             │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  CHỈ ở `support`:  ô nhập + [Gửi]                      │
│  CHỈ ở `support`:  ▸ Nhập License Key                  │
│  CHỈ ở `support`:  Phòng chat · Trạng thái bản quyền   │
└──────────────────────────────────────────────────────────┘
```

**Kích thước:** `support` → giữ nguyên như hiện tại.
Các chế độ khác → panel mở ra khoảng **720 × 560**, canh giữa màn hình.

### Giữ nguyên nhãn "Hỗ trợ" mà không gây nhầm

`tests/ui-wiring.test.js:453` kiểm **đúng chuỗi này**:
```html
<span class="support-label">Hỗ trợ</span> <span class="brand-mark"><b>CN</b> Tax Tools</span>
```

→ **Cấm sửa, cấm xoá, cấm chèn thêm bất cứ thứ gì vào GIỮA 2 thẻ đó.**
Chỉ được thêm **sau** `</span>` của `.brand-mark`.

Giải pháp không đụng test:
```html
<strong><span class="support-label">Hỗ trợ</span> <span class="brand-mark"><b>CN</b> Tax Tools</span></strong>
<small id="support-mode">Kết nối máy chủ / Ngắt kết nối máy chủ</small>   <!-- của HỖ TRỢ -->
<small id="ai-mode-label" hidden>AI: DeepSeek</small>                      <!-- của AI, RIÊNG -->
```
Dải nút chế độ ngay dưới header đã cho biết đang ở đâu.

### Chỉ có MỘT `<iframe>`

Không tạo iframe mới cho mỗi chế độ. Một iframe, đổi `src`.
Tránh rò bộ nhớ và tránh nhiều web app chạy nền cùng lúc.

### Chuyển chế độ phải làm gì

| Đích | Hành động |
|---|---|
| → `support` | Ẩn `#ai-frame-host`, `#ai-thread`. Hiện messages/form/license. Giữ SSE đang mở |
| → `web` | Ẩn khối support. Hiện iframe. Đổi `src`. Bật bridge cho origin đó |
| → `openai`/`local` | Ẩn khối support + iframe. Hiện `#ai-thread`. Kiểm bản quyền (cache). Mở SSE |
| → `web` khác | Đổi `src` iframe, giữ bridge (chỉ đổi origin tin cậy) |
| Đóng panel | **Không** hủy iframe — giữ để mở lại nhanh |

Badge tin chưa đọc chỉ đếm chế độ `support`. Ẩn badge khi đang ở chế độ AI.

---

## 📁 File Cần Làm

### Không đụng (giữ nguyên)

| File | Ghi chú |
|---|---|
| `src/chat-widget.js` | ❌ **KHÔNG sửa** — tách file mới |
| `src/renderer.js` | ❌ Dùng `<script defer>` trong HTML, không thêm vào `DEFERRED_SCRIPTS` |
| `tests/ui-wiring.test.js` | ❌ **KHÔNG sửa dòng nào** |
| `src/index.js.txt`, `src/code.gs.txt` | Không liên quan |

### Tạo mới

| File | Nội dung | Test |
|---|---|---|
| `src/ai-bridge.js` | Thuần logic giao thức cầu nối (loại `web`) | ✅ `node --test` |
| `src/ai-providers.js` | Chuẩn hoá + kiểm tra cấu hình provider | ✅ `node --test` |
| `src/ai-chat.js` | UI + nối vào DOM | ❌ cần browser |
| `tests/ai-bridge.test.js` | Test giao thức, allowlist, khoá lạ | ✅ |

**`src/ai-bridge.js` — mẫu gần hoàn chỉnh:**

```js
'use strict';
// Cầu nối giữa khung chat AI (web easytool.dev) và app.
// Thuần logic, KHÔNG đụng DOM -> test được bằng node --test.
// LƯU Ý: e.data là OBJECT, không phải chuỗi. Đã xác minh từ traffic thật.

const ALLOWED_KEYS = Object.freeze([
  'storageMetadata-v1', 'aiModelName-v1', 'colorScheme-v1',
  'savedChats-v1', 'personalizedPrompt-v1',
  'fp-v1', 'fpHash-v1',      // luôn trả null: không gửi định danh máy ra ngoài
]);
const ALWAYS_NULL = Object.freeze(['fp-v1', 'fpHash-v1']);
const HANDLED_TYPE = 'storageRequest';

function isHandled(data) {
  return !!data && typeof data === 'object' && data.type === HANDLED_TYPE
    && (data.operation === 'get' || data.operation === 'set')
    && typeof data.key === 'string' && !!data.key
    && typeof data.messageId === 'string' && !!data.messageId;
}
function isAllowedKey(key) { return ALLOWED_KEYS.indexOf(key) !== -1; }

// Trả về response, hoặc null nếu cần bỏ qua im lặng.
// pageContentRequest CỐ TÌNH không có trong đây -> không tồn tại đường gọi.
function buildResponse(data, store) {
  if (!isHandled(data)) return null;
  const reply = value => ({
    type: 'storageResponse', operation: data.operation,
    key: data.key, messageId: data.messageId, value,
  });
  if (!isAllowedKey(data.key)) return reply(null);   // khoá lạ: đáp null, KHÔNG đọc/ghi
  if (ALWAYS_NULL.indexOf(data.key) !== -1) return reply(null);
  if (data.operation === 'get') return reply(store.get(data.key) ?? null);
  store.set(data.key, data.value);
  return reply(null);
}

module.exports = { ALLOWED_KEYS, ALWAYS_NULL, isHandled, isAllowedKey, buildResponse };
```

**`src/ai-providers.js` — phần kiểm tra an toàn:**

```js
'use strict';
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function parseBaseUrl(raw, type) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return null; }
  const isLoopback = LOOPBACK.test(url.hostname);
  if (url.protocol === 'https:') return url;
  // Chỉ cho http:// khi là loopback VÀ loại là local.
  if (type === 'local' && url.protocol === 'http:' && isLoopback) return url;
  return null;
}
function isSafeEmbedUrl(raw) {
  try { return new URL(String(raw || '')).protocol === 'https:'; } catch { return false; }
}
module.exports = { parseBaseUrl, isSafeEmbedUrl, LOOPBACK };
```

### Sửa

| File | Sửa gì | Bắt buộc? |
|---|---|---|
| `src/index.html` | CSP `+ frame-src`; thêm `#chat-modes`, `.ai-frame-host`, `#ai-frame`, `#ai-thread`, `#ai-mode-label`; `<script src="ai-chat.js" defer>` | ✅ |
| `src/style.css` | `.chat-modes`, `.ai-mode-label`, `.ai-frame-host`, `#ai-thread`, `.support-panel.is-ai` | ✅ |
| `src/server.js` | 2 route static + `GET/POST /api/ai/storage` + `GET/POST /api/ai/providers` + `GET /api/ai/stream` + `enforceAiLicense` có cache | ✅ **bắt buộc** |
| `tools/minify-ui.cjs` | Thêm 2 file mới vào `TARGETS` | ✅ **bắt buộc** |
| `package.json` | `pkg.assets` +2 file; `scripts.test` +1 test | ✅ **bắt buộc** |

#### `src/index.html`

**a) Dòng 2 — CSP.** Thêm `frame-src`. **Chỉ mở đúng domain, KHÔNG mở `*`:**
```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; frame-src 'self' https://*.easytool.dev;
object-src 'none'; base-uri 'none'; form-action 'self'
```

**b) Khoảng dòng 329–339 — thêm vào trong `#support-panel`.** Giữ nguyên mọi `id` cũ.

```html
<!-- SAU .brand-mark, KHÔNG chèn vào giữa 2 thẻ đang được test -->
<small id="ai-mode-label" hidden></small>

<nav class="chat-modes" role="tablist" aria-label="Chế độ trò chuyện">
  <button type="button" role="tab" data-mode="support" aria-selected="true">Hỗ trợ</button>
  <!-- các nút còn lại sinh bằng JS từ /api/ai/providers -->
  <button type="button" class="chat-mode-add">+ Thêm</button>
</nav>

<div class="ai-frame-host" hidden>
  <iframe id="ai-frame" title="Trò chuyện AI"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="clipboard-write; clipboard-read"></iframe>
</div>

<div id="ai-thread" class="ai-thread" hidden aria-live="polite"></div>
```

> `sandbox` cố tình **KHÔNG** có `allow-top-navigation` → web app không tự điều hướng tab chính.

**c) Script.** Thêm vào nhóm script cuối của `<body>`:
```html
<script src="ai-chat.js" defer></script>
```
→ **Không phải sửa `src/renderer.js`.**

#### `src/server.js`

**a) Sau dòng 4115** (`/chat-widget.js`) — thêm 2 route static:
```js
if (url.pathname === '/ai-bridge.js')    return staticFile(req, res, 'ai-bridge.js',    'text/javascript; charset=utf-8');
if (url.pathname === '/ai-chat.js')      return staticFile(req, res, 'ai-chat.js',      'text/javascript; charset=utf-8');
if (url.pathname === '/ai-providers.js') return staticFile(req, res, 'ai-providers.js', 'text/javascript; charset=utf-8');
```

**b) Endpoint**

| Endpoint | Việc | Chặn bản quyền | Kiểm allowlist ở server |
|---|---|---|---|
| `GET /api/ai/providers` | đọc cấu hình + danh sách model | ✅ (cache) | — |
| `POST /api/ai/providers` | thêm/sửa/xoá cấu hình, lưu key | ✅ (cache) | ✅ `parseBaseUrl` |
| `GET /api/ai/storage` | đọc `ai-storage.json` | ✅ (cache) | ✅ allowlist |
| `POST /api/ai/storage` | ghi 1 khoá | ✅ (cache) | ✅ allowlist |
| `GET /api/ai/stream` | chat SSE tới provider | ✅ (cache) | — |

> ⚠️ **Server phải tự kiểm allowlist — không tin UI.**
> Nếu không, gọi thẳng `POST /api/ai/storage` là ghi được khoá bất kỳ vào file.

**c) Lưu trữ**
```js
const AI_PROVIDERS = path.join(dataDir, 'ai-providers.json');
const AI_STORE     = path.join(dataDir, 'ai-storage.json');
```
Dùng `atomicWrite` (đã import từ `./core`).

**d) Endpoint chat SSE** — dùng mẫu `/api/support/events` (đã chạy production, dòng ~3229),
bao gồm xử lý `req.on('close')`, `Cache-Control: no-store`, `X-Accel-Buffering: no`.

#### `src/style.css`

- `.chat-modes` — dải nút, cuộn ngang, bo tròn
- `.chat-modes [aria-selected="true"]` — nền đậm
- `.chat-mode-add` — nút thêm
- `.ai-mode-label` — nhãn nhỏ cạnh tiêu đề
- `.ai-frame-host` / `#ai-frame` — khung nhúng
- `.ai-thread` — khung chat của loại `openai`/`local`
- `.support-panel.is-ai` — mở rộng `width:720px; height:560px`
- **Giữ nguyên** `.support-header .support-label { color: #adbfce }` (test dòng 456 kiểm tra)

---

## ⚠️ 5 BẪY KỸ Thuật (đã kiểm trong code)

### 1. `server.js` KHÔNG có static fallback — phải khai báo từng file

Khoảng dòng 4104–4135 là chuỗi `if (url.pathname === '/xxx.js') return staticFile(...)`.
Thêm file mà quên dòng route → **404**. `npm start` thấy ngay, dễ sót.

### 2. Test bắt buộc `minify-ui.cjs` khớp route — so khớp **2 chiều**

```js
// tests/minify-ui.test.js:103
const routes = [...server.matchAll(/staticFile\(req, res, '([^']+\.(?:js|css))'/g)].map(m => m[1]);
const own = [...new Set(routes.filter(n => !n.startsWith('vendor/')))].sort();
assert.deepEqual(targets, own,
  'mỗi tài sản tự viết được phục vụ qua HTTP phải có trong TARGETS, và ngược lại');
```
Thêm route vào `server.js` mà quên `minify-ui.cjs` → **`npm test` đỏ ngay**. Và ngược lại cũng vậy.

### 3. `pkg.assets` thiếu → build EXE mất file

| Tình huống | Kết quả |
|---|---|
| `npm start` | ✅ chạy bình thường |
| `npm run build` | ❌ **file biến mất khỏi EXE** |

Bẫy nguy hiểm nhất vì lỗi chỉ xuất hiện lúc đóng gói.

### 4. Encoding: UTF-8 **không BOM**

Đã kiểm: file của bạn là UTF-8 no-BOM, chứa **đúng** Unicode tiếng Việt
(`src/chat-widget.js` mở đầu bằng byte `E1 BB 97` = ký tự `ỗ`).

⚠️ `Get-Content` của PowerShell hiện `?` là **hỏng hiển thị console**, file không hỏng.
Khi sửa: ghi **UTF-8 không BOM**. Đừng dùng `>` / `Out-File` mặc định của PowerShell.

### 5. UI chạy Chrome/Edge thật, không phải WebView2

`server.js` launch UI bằng `--app=` với profile riêng `du_lieu/ui-browser`.
→ iframe hoạt động bình thường. **Chỉ CSP mới là rào.**

---

## 🔗 3 Xung Đột Với `chat-widget.js` (không sửa nó, nhưng phải biết)

Dù không đụng file đó, `ai-chat.js` vẫn **tranh nhau trên cùng panel**:

### 1. `.onclick` sẽ XOÁ handler cũ

```js
// src/chat-widget.js:111 đang gán:
$('support-close').onclick = () => $('support-toggle').click();

// nếu ai-chat.js viết:
$('support-close').onclick = () => {...}   // ← XOÁ MẤT nút đóng của hỗ trợ
```
→ **Bắt buộc dùng `addEventListener`, không bao giờ gán `.onclick`.**

### 2. `#support-mode` sẽ bị ghi đè

`chat-widget.js` `loadHeader()` (dòng 60–67) ghi vào `#support-mode`.
Nếu dùng phần tử đó để hiện tên AI → mỗi lần nó chạy là mất.

→ Giải pháp: dùng phần tử **riêng** `#ai-mode-label`, không giành `#support-mode`.

### 3. Badge tin chưa đọc

`announce()` tự đếm và vẽ badge. Ở chế độ AI mà badge hỗ trợ nhảy → gây nhầm.
→ Chấp nhận, hoặc ẩn badge khi đang ở chế độ AI.

---

## 🧪 Kế Hoạch Kiểm Thử

### Tự động (`node --test`)

| File | Phủ |
|---|---|
| `tests/ai-bridge.test.js` (mới) | Giao thức, allowlist, khoá lạ, `fp-*`, `messageId` thiếu, `pageContentRequest` bị bỏ qua |
| `tests/minify-ui.test.js` | Khớp danh sách rút gọn |
| `tests/static-cache.test.js` | Không hỏng cache tĩnh |
| Toàn bộ `npm test` | Không vỡ test cũ |

`tests/ui-wiring.test.js` chạy y như cũ, **không sửa dòng nào**.

### Thủ công (bắt buộc)

1. Mở panel → chế độ **Hỗ trợ** y như cũ (tin nhắn, SSE, badge, `/check`, license)
2. Chuyển **DeepSeek (web)** → khung chat lên, **không** có `Storage request timeout` ở console
3. Chat vài tin → tắt app → mở lại → **lịch sử chat còn nguyên**
4. Chuyển qua lại 4 chế độ → không rò bộ nhớ, **không nhân bản listener**
5. Tắt mạng → chế độ AI hiện nút thử lại → bật mạng → tự phục hồi
6. **Mở tab danh sách hóa đơn, mở panel AI, chat thử** → hóa đơn **KHÔNG** xuất hiện
7. **Không có bản quyền** → bấm chế độ `openai` phải hiện thông báo, không mở được khung chat
8. **Đo request amplification** → mở khung chat web, đếm request tới Worker. Phải **≈1**, không phải 14
9. Thêm cấu hình mới qua nút "+ Thêm" → xuất hiện ngay, không build lại
10. Thử `baseURL` = `javascript:alert(1)` và `http://evil.com` → **phải bị từ chối**
11. `npm run build` → `npm run verify-exe` → chạy EXE thật, lặp lại bước 2–3

### Tiêu chí đạt

- [ ] `npm test` xanh, không bỏ test nào
- [ ] Console sạch: 0 `Storage request timeout`, 0 `Refused to display`
- [ ] Lịch sử chat còn sau khi tắt/mở lại app
- [ ] Web app **không** đọc được nội dung trang đang mở
- [ ] Không có bản quyền → không dùng được chế độ `openai`/`local`
- [ ] **Request tới Worker ≈1 mỗi 10 phút**, không phải 14 mỗi lần mở khung
- [ ] Chế độ Hỗ trợ không hồi quy
- [ ] Chuỗi `.support-label` + `.brand-mark` **không đổi 1 ký tự nào**
- [ ] `baseURL` không hợp lệ bị từ chối ở server

---

## 📅 Giai Đoạn Sau

### Giai đoạn 2 — Worker làm trung gian

Thêm provider `type:"openai"` trỏ về Worker, key đặt trên Worker thay vì trên máy user.

- Dùng `machine-id` + `license`/`trial` **sẵn có** để giới hạn theo máy
- Đổi model/tên chế độ chỉ cần redeploy Worker, **không build lại EXE**
- Bỏ iframe → **toàn bộ mục Chính sách bảo mật (loại `web`) biến mất**
- Chỉ cần thêm **1 object JSON**, không sửa UI

### Giai đoạn 3 — APK

Logic nằm ở tầng `server.js` nên chuyển được.
Cần làm lại: `secrets.js` đang dùng **DPAPI Windows** — Android không có.

---

## ⚡ Việc Chưa Kiểm Chứng & Rủi Ro

| Việc | Trạng thái | Xử lý |
|---|---|---|
| Gửi `set` khi chat (loại `web`) | ❌ **Chưa thử** — khung nhúng thuộc domain khác, không gõ vào được | Cho ghi vào file riêng (vô hại). Xác nhận lại khi chạy thật |
| Hết hạn dịch vụ họ | ⚠️ **Đã xảy ra** — 3/7 mode chết | Để config + `openai`/`local` là đường thoát |
| `pageContentRequest` tự gọi | ⚠️ Chưa thấy gọi, **chưa chứng minh được** không gọi | **Không implement** → không có đường gọi |
| Web app đọc `fp-*` | Đã trả `null` → không gửi định danh máy | Xác nhận lại khi chạy thật |
| Kimi / Yuanbao có hiện đẹp không | ⚠️ Chưa xác nhận bằng mắt (không chụp được ảnh) | Xác nhận khi chạy thật trước khi thêm vào danh sách mặc định |
| SSE streaming từ provider | Chưa thử (cần API key thật) | Làm sau cùng `type: openai` |
| Trải nghiệm dev | Server phục vụ `.min.js` khi mới hơn bản gốc | Debug kiểu dev sẽ thấy code đã rút gọn — dùng `npm test` để test logic thuần |

### Rủi ro lớn nhất còn lại

**Phụ thuộc bên thứ ba ở giai đoạn 1.** `easytool.dev` kiểm soát 100% loại `web`.
Họ đổi tên miền / thu tiền / chặn → chế độ web chết, **không sửa được vì code ở chỗ họ**.

**Giảm thiểu:** `du_lieu/ai-providers.json` + `ai-providers.js` là chỗ **duy nhất** cần sửa khi chuyển sang
`type: "openai"` trỏ Worker. Đó là lý do giai đoạn 2 quan trọng — không phải để đẹp hơn, mà để **thoát**.

---

## 📌 Thứ Tự Làm

| Bước | Việc | Ghi chú |
|---|---|---|
| 1 | `src/ai-bridge.js` + `src/ai-providers.js` + `tests/ai-bridge.test.js` | Thuần logic. Chạy `npm test` xanh trước khi làm gì khác |
| 2 | `server.js`: 3 route static + `enforceAiLicense` có cache + endpoint storage/providers | **Nhớ `atomicWrite`**. Đặt route cạnh block static sẵn có |
| 3 | `minify-ui.cjs` + `package.json` | **Hai bên phải khớp** — làm ngay sau bước 2 |
| 4 | `index.html`: CSP + dải chế độ + iframe + `#ai-thread` + `#ai-mode-label` | **Cấm đụng chuỗi test** |
| 5 | `src/ai-chat.js` | Dùng `addEventListener`, **không** gán `.onclick`. 1 listener `message` đăng ký 1 lần |
| 6 | `style.css` | |
| 7 | `npm test` → test thủ công 11 bước | |
| 8 | `type: openai` + SSE | Sau cùng — cần API key thật để test |
| 9 | `npm run build` + `verify-exe` + chạy EXE thật | |

### Có thể làm sau

`type: "openai"` và `type: "local"` **không cần** cầu nối `postMessage` nào.
Làm `type: "web"` trước để xem giao diện, thấy ổn rồi mới mở rộng.

---

## 🔴 Rủi Ro Cao Nhất Khi Code

1. **Đụng chuỗi đang được test** ở `src/index.html:332` → phá test. Chép lại y nguyên.
2. **Sửa `server.js` mà quên `minify-ui.cjs`** (hoặc ngược lại) → `npm test` đỏ.
3. **Quên `pkg.assets`** → dev chạy bình thường, build EXE thì mất file.
4. **Gán `.onclick`** trong `ai-chat.js` → xoá nút đóng của chat hỗ trợ.
5. **Không cache license** → spam Worker, làm chậm chat hỗ trợ đang chạy.
6. **Không kiểm `baseURL` ở server** → user (hoặc kẻ xấu) trỏ `file:` / `javascript:` vào là hỏng.
7. **`secrets.js` dùng DPAPI Windows** → giai đoạn APK phải làm lại khoá.