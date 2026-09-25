# SOURCE_ANALYSIS.md

> Output chính thức của **PHASE 0 – PHÂN TÍCH SOURCE** theo `giaithichkientruc.md` §62.
> Người thực hiện: Codewhale · Ngày: 2026-09-23 · Không sửa code, không chạy test đánh vào cổng thuế.
> Mốc source: commit `075cc3f` (v1.0.4).

---

## 0. Cách đọc tài liệu này

Mỗi mục dưới đây theo định dạng §62 yêu cầu: **file · function/class · làm gì · input · output · dependency**.
Chỉ ghi điều đã đọc/kiểm chứng trực tiếp trong source; chỗ chưa kiểm chứng được ghi rõ **chưa xác minh**.

---

## 1. Kiến trúc runtime hiện tại

- Ứng dụng Node.js đóng gói bằng `pkg` thành 1 EXE Windows x64, cửa sổ giao diện do Chrome/Edge đã có trên máy mở (không kèm Chromium).
- Entry point: `src/server.js` (`package.json > main` và `bin`).
- Điều khiển trình duyệt: thư viện `chrome-remote-interface` (CDP).
- `pkg.assets` chỉ gồm file tĩnh + vendor + `resources/xlsx.cjs` (xem §2.14).
- **Không có** SQLite, không có native module, không có scheduler/background worker ngoài luồng SSE của module support.

---

## 2. Map 12 mục theo §62

### 2.1 Manual Search Flow

- **File**: `src/core.js`, `src/tct-api.js`
- **Function/class**: `Engine.search()`, `Engine.scan()`, `Engine.run()`, `tasksFor()`, `dates()`, `searchExpression()`, `validateParams()`
- **Làm gì**:
  - `validateParams()` chuẩn hoá tham số: `direction` (`purchase`/`sold`), `from`/`to` (YYYY-MM-DD), `family` (`query`/`sco-query`/`both`), `status`, `formats` (xml/zip/html/pdf/xlsx).
  - `dates()` tách khoảng ngày thành **từng tháng trọn vẹn**.
  - `tasksFor()` sinh ma trận task = `family` × `tháng` × `variant`; `purchase` tạo 3 variant `[5, 6, 8]` (ttxly), `sold` tạo 1 task `[null]`.
  - `Engine.scan()` chạy từng task tới hết dữ liệu, dùng **cursor** của cổng thuế.
  - Request thật (`core.js:136`):
    `GET /{family}/invoices/{direction}?sort=tdlap:desc&size=50&search=<expr>[&state=<cursor>]`
    với `searchExpression()` sinh: `tdlap=ge=DD/MM/YYYYT00:00:00;tdlap=le=DD/MM/YYYYT23:59:59[;ttxly==variant]`.
- **Input**: `params {from,to,direction,family,status,formats}` + `output` (thư mục lưu).
- **Output**: mảng `job.items[]` (mỗi item = bản ghi API + trạng thái) và checkpoint `job.tasks[]`.
- **Dependency**: `tct-api.request()`, `pace.wait()`, `identity()` (phiên đã chọn), `atomicWrite()` để lưu job.
- **Quy tắc phân trang (đã kiểm chứng trong code)**:
  - Hết dữ liệu ⟺ cổng không trả cursor nữa (`task.done = !cursor`), **không** dùng `total` của cổng (cổng trả `total` không nhất quán — đã ghi chú ngay trong code).
  - Chặn cứng: cursor lặp lại, trang rỗng mà vẫn còn cursor, `MAX_PAGES_PER_TASK = 400` (`core.js:67`).
  - Một task lỗi **không** làm chết cả lượt: lỗi được ghi vào `task.error` rồi đi tiếp (`core.js:173`).
- **Trạng thái/tương thích**: đây là luồng đang chạy thật, thuộc nhóm **protected** (§12/§21).

### 2.2 Manual Download Flow

- **File**: `src/core.js`, `src/invoice-html.js`, `src/invoice-excel.js`
- **Function/class**: `Engine.resume(download=true)`, `Engine.download()`, `Engine.exportList()`, `Engine.scanFolder()`, `invoiceHtml()`, `withXmlFields()`, `invoiceExport.workbook()`
- **Làm gì**:
  - `download()` quét thư mục đích 1 lần, rồi với từng hoá đơn: kiểm tra đã có → tải → ghi file.
  - XML: `GET /{family}/invoices/export-xml?{query}`; nội dung có thể là XML đơn hoặc gói ZIP nhiều XML (đã kiểm tra tính hợp lệ trước khi ghi).
  - HTML/PDF: gọi thêm `GET /{family}/invoices/detail?{query}` rồi dựng HTML theo bộ dựng port từ trang tra cứu của cổng thuế; PDF sinh từ chính HTML đó.
  - Excel: 2 loại — `HD-EXCEL-<from>-<to>-<id8>.xlsx` (bảng tổng hợp trong thư mục nhánh) và `<dd-mm-yyyy> - <dd-mm-yyyy> - Mua vào|Bán ra.xlsx` (danh sách mẫu MISA, 19 cột).
  - Sau cùng ghi `bao-cao-<jobId>.json` (danh sách item + state + files).
- **Input**: `job.items[]`, `job.params.formats`, `job.output`.
- **Output**: file XML/ZIP/HTML/PDF + 2 file Excel + báo cáo JSON; cập nhật `job.stats`.
- **Dependency**: `jszip`, `atomicWrite()`, `this.pdf()` (PDF qua trình duyệt), `resources/xlsx.cjs`.
- **Ghi chú quan trọng**: mọi dữ liệu Excel lấy từ **kết quả tra cứu**, không gọi API chi tiết, không tải XML (chính source ghi rõ) ⇒ hiện **không có dữ liệu hàng hóa**.

### 2.3 API Bán ra (sold)

- **File**: `src/core.js` (`tasksFor`, `scan`, `download`), `src/tct-api.js`
- **Làm gì**: `direction = 'sold'` → `GET /{family}/invoices/sold?…`; `tasksFor()` chỉ tạo 1 variant `null` (không lọc `ttxly`); thư mục đích `Ban_ra`.
- **Input/Output**: như 2.1/2.2, khác giá trị `direction` và thư mục.
- **Dependency**: như 2.1.

### 2.4 API Mua vào (purchase)

- **File**: `src/core.js`
- **Làm gì**: `direction = 'purchase'` → `GET /{family}/invoices/purchase?…`, **3 variant `[5,6,8]`** của `ttxly` (để phủ hoá đơn có mã / không mã), thư mục đích `Mua_vao`.
- **Ghi chú**: vì mỗi tháng mua vào = 3 task, tổng số task của một lượt "both + purchase" = 2 family × N tháng × 3 variant.

### 2.5 Login / Session / Authentication

- **File**: `src/tct-api.js`, `src/secrets.js`, `src/browser.js`, `src/tax-login.js`, `src/server.js`
- **Function/class**: `captcha()`, `authenticate()`, `request()`, `portalHeaders()`, `storeCookies()/setCookies()/clearCookies()`, `browser.open()/prepareLogin()/loginAction()`, các endpoint `/api/account/*`.
- **Làm gì**:
  - `GET /api/captcha` → `{key, content}` (SVG) → UI hiển thị.
  - `POST /api/security-taxpayer/authenticate` với `{username, password, ckey, cvalue}` → `token`.
  - Mọi request nghiệp vụ: `GET /api{route}` + header `Authorization: Bearer <token>`, `Action`, `End-Point: /tra-cuu/tra-cuu-hoa-don`.
  - Bộ header mô phỏng Chrome (UA, `sec-ch-ua`, `Origin`, `Referer`, `request-id`) là **bắt buộc** — nếu thiếu, WAF trả 403 (đã ghi chú trong source kèm ngày đo).
  - Cookie của cổng được giữ trong `jar` (RAM) và gửi lại như trình duyệt; có thể lưu/khôi phục qua `secrets.js`.
  - Đăng nhập dự phòng bằng trình duyệt thật: `browser.js` mở Chrome/Edge, mỗi MST một profile riêng.
- **Input**: `{mst, username, password, captcha, key}` (hoặc phiên đã lưu).
- **Output**: `token` + cookie; file phiên theo MST trong `du_lieu/secrets/<MST>.json`.
- **Dependency**: `https`, `zlib` (br/gzip/deflate), `chrome-remote-interface`.
- **Chưa xác minh**: danh sách field đầy đủ bên trong `du_lieu/secrets/<MST>.json` (không in giá trị secret khi phân tích).

### 2.6 XML download mechanism

- **File**: `src/core.js`
- **Function**: `Engine.download()` (nhánh `formats` chứa `xml`/`zip`)
- **Làm gì**: gọi `export-xml`; nếu trả ZIP thì giải nén bằng `jszip`; kiểm tra nội dung bắt đầu bằng `<?xml` / `<HDon` trước khi ghi; ghi từng XML (1 file → `.xml`, nhiều file → `_1.xml`, `_2.xml`…).
- **Input**: 1 hoá đơn trong `job.items[]` + `params.formats`.
- **Output**: file XML trên đĩa; đồng thời giữ biến `sourceXml` (chuỗi XML đầu tiên) để dùng cho HTML/PDF.
- **Dependency**: `jszip`, `atomicWrite()`.

### 2.7 XML destination

- **File**: `src/core.js`
- **Quy tắc thực tế**: `<thư mục lưu>/MST-<MST>/<Mua_vao|Ban_ra>/` — **chỉ 2 thư mục con**, không chia thêm `xml/`/`pdf/`/`html/`/`zip/` (khác mô tả trong README cũ).
- **Ghi chú**: kiến trúc mong muốn (§4) là `HoaDonData/<MST>/{BanRa,MuaVao,data.db,sync.json}` — hiện đã có phần `MST-<MST>/<Mua_vao|Ban_ra>` tương đương, **chưa có** `data.db`/`sync.json`, và tên thư mục đang dùng dạng `Mua_vao`/`Ban_ra` chứ không phải `MuaVao`/`BanRa`.

### 2.8 XML naming

- **File**: `src/core.js` (`Engine.download()`, dòng 269)
- **Công thức thật** (đã kiểm chứng bằng 5 file XML thật):
  `{nbmst}_{khmshdon}_{khhdon}_{shdon}_{sha256(invoiceKey)[:10]}.xml`
- **Bằng chứng**: tính lại `sha256("query|purchase|4500222022|1|C26TNT|75757")[:10]` cho ra đúng hậu tố trong tên file `4500222022_1_C26TNT_75757_43102b5029.xml` — khớp **5/5** mẫu.
- **Kết luận**: tên file **có chứa** thành phần suy ra từ khoá hoá đơn, nhưng bản thân tên file **không phải** định danh: hậu tố là hash của khoá do API sinh, và `shdon` trong tên file là dạng của API (`75757`) trong khi nội dung XML là `00075757`.

### 2.9 Duplicate detection hiện tại

- **File**: `src/core.js`
- **Cơ chế (3 lớp đang có)**:
  1. Trong một lượt quét: `Set` các `invoiceKey` đã thấy → không thêm item trùng.
  2. Trong `scan()`: mảng `task.seen[]` (cursor đã dùng) chống lặp vô hạn.
  3. Trong `download()`: `scanFolder()` quét thư mục đích và so **tên file** (`${base}.xml`, `${base}_N.xml`) để bỏ qua file đã có.
- **Khoá đang dùng**: `invoiceKey(inv) = family|direction|nbmst|khmshdon|khhdon|shdon` — lấy từ **bản ghi API**, không phải từ XML.
- **Đối chiếu kiến trúc**: đúng *công thức* §13 nhưng (a) nguồn là API chứ không phải XML, (b) lớp 3 dựa vào tên file — chính là điều §2.3/§86.6 cấm, (c) chưa có lớp SQLite.

### 2.10 MST handling

- **File**: `src/server.js`, `src/core.js`, `src/secrets.js`, `src/app-settings.js`, `src/browser.js`, `du_lieu/accounts.json`
- **Làm gì**: danh sách MST trong `du_lieu/accounts.json`; mỗi MST có profile trình duyệt riêng `du_lieu/profiles/<MST>/`, phiên đăng nhập riêng `du_lieu/secrets/<MST>.json`, job riêng `du_lieu/jobs/<MST>.json`; chọn MST qua `/api/account/select`.
- **Đối chiếu kiến trúc**: tinh thần "1 MST = 1 vùng dữ liệu, không lẫn nhau" **đã có**; còn thiếu `MST Manager` hình thức (tạo `data.db`, `sync.json`) và việc tạo thư mục theo §6.

### 2.11 Reusable services (đã có, có thể tái dùng cho Data Engine/Auto Sync)

- **API client**: `src/tct-api.js` — `request()`, `portalHeaders()`, quản lý cookie, `decodeBody()`.
- **Session/Auth**: `src/secrets.js` + `src/browser.js`.
- **Nhịp & giới hạn**: `src/pace.js` — `wait()`, `mark()`, `note()`, `restRemaining()`, `resetRest()` (dùng chung cho cả đường Node và đường trình duyệt).
- **Ghi file an toàn**: `atomicWrite()` trong `src/core.js` (tmp → rename, có đường lui khi Windows khoá file — quan sát thực tế với OneDrive/antivirus).
- **Đặt tên an toàn**: `safeName()` (`src/core.js`).
- **Khoá hoá đơn**: `invoiceKey()` (`src/core.js`).
- **Khoảng ngày → tháng**: `dates()` (`src/core.js`); giao diện chọn kỳ: `src/period.js`.
- **Xuất Excel**: `src/invoice-excel.js` + `resources/xlsx.cjs`.
- **Dựng HTML/PDF hoá đơn**: `src/invoice-html.js`.
- **Log**: ghi ra `du_lieu/nhat-ky.log` (xem §2.13).

### 2.12 Build / package process

- **File**: `tools/build-app.cjs`, `tools/build-installer.cjs`, `tools/set-version.cjs`, `packaging/installer.nsi`, `.github/workflows/release.yml`
- **Làm gì**:
  - `build-app.cjs`: `pkg . --compress GZip --targets node16-win-x64 --no-bytecode --public --public-packages * --output release/HoaDonNhe-v<version>.exe`, rồi vá PE để ẩn cửa sổ console (`tools/hide-console.cjs`). **Cố ý không dùng rcedit** (đã ghi chú: làm hỏng snapshot của pkg).
  - `build-installer.cjs`: đưa EXE vào payload rồi gọi NSIS → `HoaDonNhe-Setup-v<version>.exe` + `.sha256` + `RELEASE_NOTES.md`.
  - `set-version.cjs`: đồng bộ version ở `package.json`, `package-lock.json`, `src/version.js` (tag git là nguồn chính).
  - Workflow `Release`: chạy khi push tag `v*` → test → build → đóng gói → tạo GitHub Release. Có `workflow_dispatch` để build thử không phát hành.
- **Input**: source + version (tag).
- **Output**: EXE app, Setup EXE, file SHA-256, Release.
- **Ràng buộc quan trọng cho Phase 1**: EXE hiện nhúng runtime **Node 16** (`--targets node16-win-x64`) — xem §4 dưới đây.

### 2.13 Current UI architecture

- **File**: `src/server.js`, `src/index.html`, `src/renderer.js`, `src/style.css`, `src/app-settings.js`, `src/update-ui.js`, `src/chat-widget.js`, `src/app-lock.js`
- **Làm gì**: HTTP server chỉ nghe `127.0.0.1`; mở cửa sổ app của Chrome/Edge trỏ tới `http://127.0.0.1:<port>/?launch=<secret>`; sau đó mọi lời gọi đi kèm cookie `hd_session` và phải thoả điều kiện host/Origin (`allowed()`).
- **Endpoint hiện có** (nhóm chính): `/api/state`, `/api/version`, `/api/update*`, `/api/account/*` (thêm/sửa/xoá/chọn MST, login, captcha, hiện-ẩn Chrome), `/api/folder`, `/api/search`, `/api/download`, `/api/resume`, `/api/pause`, `/api/export-excel`, `/api/open-folder`, `/api/open-file`, `/api/app-lock/*`, `/api/support/*` (kể cả SSE `/api/support/events`).
- **Nguồn dữ liệu cho danh sách hoá đơn hiện tại**: `appState()` → `engine.snapshot()` → `items: j.items.slice(0, 1000)` (cắt trong RAM, không phân trang, không truy vấn).
- **Đối chiếu kiến trúc**: §15/§31/§32/§33 yêu cầu danh sách đi qua SQLite + phân trang; hiện **chưa có** — đây là việc của Phase 3.
- **Log**: `du_lieu/nhat-ky.log` (khởi động/lỗi; lỗi nghiêm trọng hiện thêm hộp thoại).

### 2.14 Dependencies

- **Runtime**: `jszip@3.10.1`, `chrome-remote-interface@0.33.3`.
- **Dev**: `pkg@5.8.1`.
- **Nội bộ (không qua npm)**: `resources/xlsx.cjs` (đọc/ghi XLSX tự viết), `src/vendor/qrcode.js`, `src/vendor/sound.js`.
- **Không có**: SQLite (mọi dạng), native addon, framework UI, ORM.

---

## 3. Đối chiếu với PROJECT_ARCHITECTURE

### 3.1 Đã khớp / đã có

| Mục kiến trúc | Trạng thái |
| --- | --- |
| §2.4 / §12 / §21 – bảo toàn Manual Download | Đang chạy thật; nhóm protected |
| §2.3 (tinh thần) | Khoá hoá đơn đã là tổ hợp `nbmst+khmshdon+khhdon+shdon` (+ family/direction), **không** dùng `shdon` riêng |
| §14 | `direction` đã tách `purchase`/`sold` ở tầng API |
| §42/§71 – cách ly lỗi | Lỗi 1 hoá đơn → `item.state='failed'`; lỗi 1 tháng → `task.error`, các tháng khác chạy tiếp |
| §43 – retry hữu hạn | Retry do người dùng chủ động ("Tải tiếp"); có chặn cursor lặp/trang rỗng/quá 400 trang |
| §44 – atomic download | `atomicWrite()` (tmp → rename) |
| §48/§49 (tinh thần) | Chưa parse XML hàng loạt; XML chỉ dùng cho HTML/PDF |
| §53 – không đổi framework | Đúng: Node + pkg + Chrome/Edge |
| §56 – ranh giới module | Chưa tách thư mục; §22/§56 cho phép giữ nguyên nếu source đã ổn |

### 3.2 Thiếu hoàn toàn

`MST Manager` (§6) · SQLite + schema `invoices`/`invoice_items`/`imported_files`/`sync_state` + index (§7–§12) · XML Data Engine + Parser (§15–§16) · nhận diện BUY/SELL từ XML (§14) · Import/Scanner/Rebuild (§18, §46) · UI theo SQLite + phân trang (§15, §31–§33) · Preview lazy (§2.6, §35) · hàng hóa & tổng hợp SQL (§9, §17, §36–§38) · Auto Sync (§23–§28) · Backfill (§29–§30) · `sync.json`.

### 3.3 Conflict (theo §74)

| # | Conflict | Impact | Đề xuất |
| --- | --- | --- | --- |
| C1 | Nhận diện "file đã có" dựa trên **tên file** (`scanFolder()`), trái §2.3/§86.6 | Đổi tên file ⇒ tải lại; không thể thực hiện §18 "XML có mà DB thiếu ⇒ import, không tải lại" | Phase 1–2: thay bằng tra cứu theo `invoice_key`; tên file chỉ là dẫn xuất |
| C2 | Excel/`items` **không có** dữ liệu hàng hóa | Không thể đáp ứng §9/§17/§36–§38 | Phase 2: parse XML → `invoice_items` |
| C3 | UI nhận tối đa 1000 dòng từ RAM; job JSON giữ **nguyên bản ghi API** của mọi hoá đơn và ghi lại toàn bộ file mỗi trang | Ở 6.000–100.000 hoá đơn: RAM/DOM/ghi đĩa tăng tuyến tính | Phase 1 (SQLite) + Phase 3 (UI phân trang) |
| C4 | `snapshot()` trả dữ liệu **từ job JSON**, không từ lớp truy vấn | §32 yêu cầu danh sách từ SQLite | Phase 3 |
| C5 | `direction` do **người dùng chọn**; §14 yêu cầu BUY/SELL **suy từ XML** | Auto Sync không thể tự quyết định hướng | Phase 2 (suy từ XML) + Phase 4 (dùng lại) |
| C6 | Có chạy **song song 2 task** khi tra cứu (`HOADON_SCAN_CONCURRENCY`, 1..4) — do yêu cầu tăng tốc của chủ dự án cho luồng thủ công | §23/§66 cấm chạy song song khi chưa xác minh an toàn | Giữ nguyên cho luồng thủ công; **không** bê concurrency sang Auto Sync; ghi nhận là ngoại lệ có chủ đích |
| C7 | `src/src/` là **bản copy cũ** của cùng các file (ví dụ `core.js` 279 dòng so với 356 dòng), không được `package.json`/`pkg` tham chiếu | Rủi ro sửa nhầm file, trái §55 (đọc đúng source) | Đề xuất xoá/lưu trữ riêng — cần chủ dự án cho phép |
| C8 | Tài liệu §54 gọi tên `PROJECT_ARCHITECTURE.md`; trong repo có `giaithichkientruc.md` (bản đầy đủ, dòng cuối ghi END OF PROJECT_ARCHITECTURE.md) và `bosungkientruc.md` (bản rút gọn) | Mơ hồ "file nào là chuẩn" | Chốt 1 tên chuẩn và để bản kia trỏ tới nó |

---

## 4. Ràng buộc kỹ thuật phải chốt trước Phase 1 (SQLite trong EXE)

Bằng chứng đã kiểm tra:

- `tools/build-app.cjs` build với `--targets node16-win-x64` ⇒ runtime **bên trong EXE là Node 16**.
- `pkg@5.8.1`, `pkg-fetch@3.4.2` — bộ patch đi kèm chỉ tới `node.v18.5.0` ⇒ trần target của công cụ này là **Node 18**; cache cục bộ đã có `fetched-v16.16.0-win-x64` và `fetched-v18.5.0-win-x64`.
- `node:sqlite` chỉ xuất hiện từ **Node 22** ⇒ **không thể** dùng SQLite built-in của Node với cấu hình hiện tại.

Ba hướng khả thi (chưa chọn — §53 yêu cầu kiểm tra compatibility và báo cáo trước):

1. Nâng target lên `node18-win-x64` — vẫn **không** có `node:sqlite`, chỉ giúp runtime mới hơn.
2. Native addon (`better-sqlite3`) nhúng làm asset, giải nén rồi nạp lúc chạy — SQLite thật, chạy theo file, WAL, hợp §2.2/§10/§47; đổi lại phải xử lý đóng gói + self-update.
3. WASM (`sql.js`) — không cần native, nhưng nạp **toàn bộ DB vào RAM**, xung đột §49 và mục tiêu 100.000 hoá đơn (§72).

**Đề xuất**: chạy một spike ngắn chứng minh hướng (2) chạy được **trong EXE đã đóng gói** trước khi viết tầng repository.

---

## 5. Kiểm chứng bằng XML thật (§13 yêu cầu khoá Invoice Key bằng dữ liệu thực tế)

5 mẫu XML thật (2 nhà cung cấp: `4500222022`/`C26TNT`, `4500240279`/`C26TTT`; 54 dòng hàng; tất cả là **mua vào** của MST `4500677693`).

Kết quả đối chiếu:

1. **Khớp**: `nbmst`, `khmshdon`, `khhdon`, tổng thanh toán (`TgTTTBSo` ↔ `tgtttbso`) — 5/5.
2. **Lệch định dạng `SHDon`**: XML `00075757` ↔ API `75757` (thiếu/đủ số 0 đầu).
   ⇒ Nếu khoá lấy nguyên chuỗi, khoá-sinh-từ-XML sẽ **khác** khoá-sinh-từ-API, và §19 lớp 1 vs lớp 2 sẽ không nhận ra nhau ⇒ **tải trùng**.
   ⇒ **Bắt buộc chuẩn hoá** `SHDon` trong một hàm khoá dùng chung (§57): **bỏ số 0 đầu** (vì cả API và tên file hiện tại đều ở dạng đó).
   ⇒ **Không** chuẩn hoá như vậy cho MST: MST Việt Nam thường bắt đầu bằng `0` (ví dụ `0100000001`), bỏ số 0 sẽ làm mất định danh và có thể gây trùng khoá giữa hai MST khác nhau. Đã cài đúng như vậy trong `src/data/invoice-key.js` và có test hồi quy.
3. **Lệch cách ghi ngày**: XML `NLap=2026-09-21` ↔ API `tdlap=2026-09-20T17:00:00Z` — cùng một ngày theo giờ VN (UTC+7). ⇒ Khi lưu/so sánh phải chuẩn hoá về **ngày VN**, không so chuỗi thô.
4. **`TThue` (tiền thuế từng dòng) không có** trong 54/54 dòng hàng thật (`STCKhau` có đủ 54/54). §16 liệt kê `TThue` ⇒ theo §2.7 phải coi là **optional**, để trống, **không tự tính**.
5. **`MCCQT` không tồn tại** trong 5 mẫu, dù `src/invoice-html.js` có nhánh fallback đọc `<MCCQT>` từ XML.
6. Trong XML có `TTKhac/TTin` lồng ở `TTChung`, `NBan`, `NMua` và **từng dòng hàng** (`Amount`, `AmountOC`, `AmountWithoutVATOC`, `DiscountAmount`, `ListStockName`, `SellerAddress`…), cùng khối `<Signature>` ⇒ parser phải bỏ qua an toàn; §16 nói không lưu chữ ký vào SQLite.
7. §14 đã kiểm chứng được trên dữ liệu thật: cả 5 đều `NMua/MST = 4500677693` (MST hiện tại) ⇒ **BUY**; `NBan/MST` khác ⇒ không rơi vào SELL. **Chưa có mẫu bán ra** ⇒ Test 7 (§69) chưa kiểm tra được.

Cấu trúc XML quan sát được: `HDon > DLHDon(Id) > [TTChung, NDHDon(NBan, NMua, DSHHDVu/HHDVu), TToan, Signature]`.
Dòng hàng có đủ các trường §16 yêu cầu (trừ `TThue`): `TChat, STT, MHHDVu, THHDVu, DVTinh, SLuong, DGia, STCKhau, ThTien, TSuat`.

---

## 6. Code KHÔNG được đụng (protected)

`src/core.js` (toàn bộ luồng search/scan/resume/download/pagination) · `src/tct-api.js` (endpoint, header, cookie, auth) · `src/pace.js` (nhịp) · cách đặt tên file (`core.js:269`) · `src/invoice-excel.js` + `resources/xlsx.cjs` · `src/invoice-html.js` · `src/server.js` (endpoint hiện có, `allowed()`, vòng đời server) · `src/updater.js`, `src/update-check.js`, `src/app-lock.js`, `src/support.js` + hạ tầng `support-gateway/`, `cloudflare-worker/` · `tools/*` và `packaging/*` (trừ khi phase yêu cầu).

Mọi thay đổi về sau phải theo §76: **ADD / EXTRACT**, không REWRITE.

---

## 7. Việc tiếp theo (điều kiện vào Phase 1)

1. Chốt quy tắc chuẩn hoá `SHDon` cho Invoice Key (§5.2).
2. Chạy spike SQLite chứng minh driver chạy được trong EXE đã đóng gói (§4).
3. Có thêm XML **bán ra** (và nếu có: XML nhóm `sco-query`) để phủ Test 7 và kiểm tra `family`.
4. Chốt việc dọn `src/src/` (C7) và tên file kiến trúc chuẩn (C8).

**Không có thay đổi code nào được thực hiện trong Phase 0.**
