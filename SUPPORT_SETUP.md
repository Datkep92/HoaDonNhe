# Thiết lập License Gateway (Phase 2)

Desktop app có sẵn chế độ local. Chỉ bật Gateway sau khi hoàn thành toàn bộ các bước dưới đây.

## 1. Tạo Google Sheet

Tạo một Spreadsheet mới với đúng hai tab và đúng dòng tiêu đề đầu tiên:

`Devices`

```text
Hardware ID | Chat Room ID | License Key | Status | Expiry Date | First Install Time | Last Seen Time
```

`Licenses`

```text
License Key | Status | Expiry Date | Hardware ID | Chat Room ID | Activated At
```

Mỗi key bán ra được tạo một dòng trong `Licenses`; cột `Status` đặt `Active`, và `Expiry Date` là ngày hết hạn. Không sửa `Hardware ID` bằng tay sau khi key đã được kích hoạt.

Cột thêm không bắt buộc — thêm tới đâu bật tính năng tới đó, chưa thêm thì chạy như cũ:

```text
Devices   + Phone | Name | Plan | Hardware Hash
Licenses  + Max Devices
```

`Bindings` (tab mới) — chỉ tạo khi bán key dùng cho nhiều máy:

```text
License Key | Hardware ID | Chat Room ID | Activated At
```

`Settings` (tab mới) — chỉ tạo khi muốn phát thông báo cho app:

```text
Key | Value
```

Trạng thái app nhận được: `Active | Trial | Expired | Locked | Unactivated | device_limit_exceeded`. Máy chưa kích hoạt được dùng thử **3 ngày**, tính từ `First Install Time` do máy chủ ghi — khách cài lại máy cũng không reset được (cột `Hardware Hash` dùng để nối lại dấu vết khi mã máy cục bộ đổi). Một key mặc định dùng cho 1 máy; đặt `Max Devices` lớn hơn 1 để bán key nhiều máy. Khi quá số máy, app báo *"Key này đã đạt giới hạn số thiết bị sử dụng tối đa…"*.

`Phone`/`Name`/`Plan` được điền từ giao diện đăng ký: khách bấm nút **Đăng ký** ở thanh trên (hoặc chọn một gói trong Cài đặt → Bản quyền & Đăng ký), chọn gói rồi gửi Họ tên + SĐT. Gateway chuyển cả ba giá trị vào sheet và đổi tên Topic Telegram của máy đó thành `SĐT - Họ tên`, kèm một dòng ghi rõ gói khách chọn.

## 2. Deploy Apps Script

1. Trong Sheet, chọn **Extensions → Apps Script**.
2. Dán nội dung [Code.gs](support-gateway/apps-script/Code.gs).
3. Vào **Project Settings → Script properties**, tạo `GATEWAY_SHARED_SECRET`: chuỗi ngẫu nhiên ít nhất 32 ký tự.
4. Chọn **Deploy → New deployment → Web app**. Thực thi với tài khoản của bạn, quyền truy cập có thể là *Anyone*. Sao chép URL kết thúc bằng `/exec`.

Apps Script có thể public vì nó từ chối mọi request không có secret; secret chỉ nằm trên Gateway.

## 3. Deploy Gateway HTTPS

Deploy thư mục `support-gateway` lên Cloud Run, Render hoặc máy chủ HTTPS có Node 18+. Khai báo biến môi trường theo [`.env.example`](support-gateway/.env.example):

- `GAS_URL`: URL `/exec` ở bước 2.
- `GAS_SHARED_SECRET`: đúng secret của Apps Script.
- `TOKEN_SECRET`: chuỗi ngẫu nhiên khác, ít nhất 32 ký tự.

Kiểm tra `https://gateway-cua-ban/healthz` trả `{ "ok": true }` trước khi nối app.

## 4. Nối desktop app

Sao chép [support-gateway.example.json](support-gateway.example.json) thành `du_lieu/support-gateway.json`, rồi thay `url` bằng HTTPS URL của Gateway. Khởi động lại app.

Khi file này không tồn tại, app vẫn hoạt động ở local mock mode. File trong `du_lieu` không được commit và không chứa key/bot token.

## 5. Firebase Realtime Database (Phase 3)

1. Tạo Firebase project và bật **Realtime Database** ở production mode.
2. Lấy Database URL, ví dụ `https://PROJECT-default-rtdb.firebaseio.com`.
3. Tạo service account cho Gateway, tải JSON key và lưu nguyên nội dung JSON một dòng trong secret `FIREBASE_SERVICE_ACCOUNT_JSON` của nhà cung cấp Gateway. Không tải file key này về máy khách.
4. Đặt `FIREBASE_DATABASE_URL` và `FIREBASE_SERVICE_ACCOUNT_JSON` trên Gateway, sau đó redeploy.

Desktop chỉ gọi Gateway. Gateway dùng OAuth service account để ghi/đọc `/chats/{chatRoomId}/messages`; vì vậy Realtime Database Rules có thể chặn hoàn toàn client trực tiếp:

```json
{ "rules": { ".read": false, ".write": false } }
```

Sau khi Firebase đã cấu hình, widget chat **lắng nghe thay đổi** thay vì hỏi lại theo chu kỳ: app mở kết nối SSE tới `GET /v1/chats/stream` của Gateway, Gateway chuyển tiếp REST streaming của Firebase RTDB (`Accept: text/event-stream`) xuống app, nên Firebase chỉ đẩy dữ liệu khi có tin mới. Tin nhắn có `sender`, `text`, `timestamp`, `source` và ID Firebase để Phase 4 map an toàn sang Telegram Topic.

## 6. Telegram Topics bridge (Phase 4)

1. Tạo một Telegram **supergroup**, bật **Topics**, rồi thêm bot làm admin. Bot cần quyền tạo/chỉnh Topic và gửi tin nhắn.
2. Lấy `TELEGRAM_BOT_TOKEN` từ BotFather, và `TELEGRAM_CHAT_ID` của group (dạng thường là `-100…`). Tạo `TELEGRAM_WEBHOOK_SECRET` ngẫu nhiên ít nhất 32 ký tự.
3. Lưu ba giá trị này trong secret store của Gateway và redeploy.
4. Với `PUBLIC_GATEWAY_URL` là HTTPS URL đã deploy, chạy `npm run telegram:webhook` trong môi trường có các secret trên.
5. **Gán danh sách lệnh cho bot** (bắt buộc sau khi thêm lệnh mới):

   ```powershell
   $env:TELEGRAM_BOT_TOKEN='123456:ABC...'
   npm run telegram:commands          # ghi danh sách lệnh
   npm run telegram:commands:list     # xem danh sách đang có
   ```

   > **Vì sao cần bước này:** Telegram **không** suy ra danh sách lệnh từ code.
   > Menu lệnh (nút ☰ cạnh ô nhập tin) là cấu hình riêng trên máy chủ Telegram.
   > Worker xử lý được `/ai` nhưng nếu chưa đăng ký thì menu vẫn chỉ hiện lệnh cũ
   > (`/lock`, `/unlock`…). Chạy lại script sau mỗi lần thêm lệnh mới là an toàn —
   > nó ghi đè danh sách, không xoá gì ngoài ý muốn. Script gán cho cả ba phạm vi:
   > `default`, `group_administrators` (nhóm supergroup có Topics) và
   > `chat_administrators` (từng topic), nên lệnh hiện ở mọi nơi bot dùng được.

Khi khách gửi tin lần đầu, Gateway tạo Topic `Support · ROOM_WIN_…`, lưu `telegramThreadId` trong Firebase rồi gửi các tin sau đúng vào Topic đó. Khi admin trả lời trong Topic, Telegram webhook ghi tin `sender: admin` ngược vào đúng room Firebase. Tin nhắn không thuộc Topic, hoặc từ bot, được bỏ qua để tránh loop.

> **Phân chia trách nhiệm:** Apps Script không tạo Topic, không gửi tin và không nhận webhook Telegram. **Gateway là nơi duy nhất tạo và quản lý Topic**: khi máy đăng ký lần đầu, Gateway mở Topic `Support · ROOM_WIN_…`, ghi `chatRoomId` vào `/chats/<room>/meta/telegramThreadId` và `/telegramTopics/<thread>/chatRoomId`, rồi gửi một tin báo máy mới kèm SĐT/Tên. Ba định danh phải tách biệt, không dùng chung một cột cho hai loại:
>
> ```text
> installationId   550e8400-e29b-41d4-a716-446655440000   khoá dòng trong sheet Devices
> chatRoomId       ROOM_WIN_A1B2C3D4                      phòng chat của app
> telegramThreadId 57                                      id Topic, chỉ ở Firebase/Gateway
> ```
>
> Các lệnh quản trị trong Topic do Gateway nhận rồi chuyển sang Apps Script bằng action `admin_command` (`/check`, `/new [thang|nam] [số_máy]`, `/extend [số_ngày]`, `/reset`, `/lock`, `/unlock`); Apps Script chỉ đọc/ghi Google Sheet và trả nội dung trả lời, Gateway gửi nội dung đó lại vào Topic. Định vị thiết bị bằng `Chat Room ID` của Topic, nên lệnh chỉ chạy khi Topic đã gắn với một máy (khách đã mở app lần đầu). Lệnh không lọt vào cửa sổ chat của khách; chữ thường không bắt đầu bằng `/` vẫn được ghi vào chat như tin của admin.

## 7. Luồng License và Chat (realtime, KHÔNG polling)

**License — chỉ kiểm tra khi được gọi.** Không còn timer nào kiểm tra License định kỳ:

- Một lần lúc mở app, khi mở **Cài đặt**, khi mạng trở lại, sau khi kích hoạt key.
- Trước mỗi tác vụ thật (`/api/search`, `/api/download`, `/api/export-excel`) qua `enforceLicense()`.

Mỗi lần kiểm tra = 1 request tới Gateway `/v1/licenses/status` → 1 lần chạy Apps Script. Endpoint cũ
`/api/support/status` đã bị bỏ để Chat không còn kéo theo kiểm tra License.

**Chat — lắng nghe thay đổi.** `GET /v1/chats/stream` (SSE) → Firebase RTDB REST streaming. App không hỏi
lại định kỳ: khi Firebase đổi, sự kiện `put`/`patch` được đẩy xuống và UI cập nhật ngay. Nếu luồng chưa
sẵn sàng (Gateway chưa deploy route này, hoặc mất mạng), UI tự chuyển sang đọc theo yêu cầu (mở panel /
sau khi gửi) và **không** quay lại polling.

Chi phí khi app mở mà không thao tác gì (License đã Active):

- Cloudflare Worker: **1 request** cho kết nối stream (thêm vài request nếu edge ngắt kết nối — app tự nối lại với backoff 5s→300s), cộng 1 request đăng ký lúc mở app.
- Google Apps Script: **0 lần chạy** (đăng ký và kiểm tra License chỉ xảy ra khi được gọi).
- Firebase: **1 lượt đọc** cho ảnh chụp ban đầu của kết nối, sau đó chỉ phát khi dữ liệu thay đổi.

Realtime chỉ bật sau khi deploy route stream lên Gateway (`wrangler deploy` trong `cloudflare-worker/`);
trước khi deploy, app chạy ở chế độ đọc theo yêu cầu và vẫn dùng đủ chức năng.

### Vòng đời kết nối (số liệu đo trên production)

- Firebase RTDB gửi `event: keep-alive` khoảng **30 giây** một lần (đo thực tế: 100 giây → 1 `put` + 3 `keep-alive`),
  nên kết nối được giữ mở liên tục và **không cần nối lại định kỳ**.
- Nếu luồng đứt: nối lại với backoff **5s → 10s → 20s → … tối đa 300s**. Luồng sống đủ lâu (≥ 30 giây) rồi mới
  đứt thì coi là bình thường và nối lại sau **2 giây** (đồng thời reset backoff) — nhờ vậy upstream “flapping”
  không tạo vòng lặp nối lại dày.
- Mỗi thời điểm chỉ có **đúng một** kết nối tới Gateway; khi không còn cửa sổ nào nghe, app đóng luôn kết nối.
- Kiểm tra thủ công phần này: `node tools/realtime-lifecycle-check.mjs` (chạy ~50 giây, không nằm trong `npm test`).
- `cloudflare-worker/wrangler.jsonc` phải khớp cấu hình đang chạy trên dashboard (nhất là `GAS_URL`), nếu không
  `wrangler deploy` sẽ ghi đè production bằng giá trị trong file — wrangler cảnh báo và dừng khi thấy lệch.

## 8. Cấu hình AI của bot bằng lệnh Telegram (`/ai`)

Admin đổi url / model / API key ngay trong Telegram, không sửa code và không
đụng vào máy khách.

**Nơi lưu cấu hình AI (nên để Sheet riêng):**

1. Tạo Google Sheet mới, ví dụ tên `HoaDonNhe_AI_Config`.
2. Trong Sheet đó tạo tab tên **`PROFILES`** (để trống cũng được — script tự ghi
   hàng tiêu đề và tự thêm cột thiếu).
3. Lấy **ID** của Sheet (đoạn giữa `/d/` và `/edit` trong URL) và đặt vào
   **Script Property** của Apps Script: `AI_CONFIG_SPREADSHEET_ID`.

Khi có property này, lệnh `/ai` ghi vào Sheet riêng và **không đụng** vào Sheet
bản quyền — nên có thể chia sẻ Sheet CRM cho kế toán/nhân sự mà không lộ key
của bot. Để trống property thì quay về tab `AI_PROFILES` của Sheet CRM (đường
cũ vẫn chạy).

Cấu trúc một dòng trong `PROFILES`:

| Cột | Ý nghĩa |
| --- | --- |
| `Alias` | Tên gọi cấu hình (chữ/số và `. _ -`, tối đa 40 ký tự) |
| `Active` | `Yes` = cấu hình đang dùng cho mọi máy |
| `Base URL` | Địa chỉ API (https) |
| `Model` | Model của dòng này |
| `API Keys` | Nhiều key trong một ô, tách bằng xuống dòng hoặc `;` |
| `Order` | Thứ tự dự phòng (nhỏ hơn = thử trước). Dòng mới luôn thêm cuối |

## Dùng bằng nút bấm (khuyến nghị)

Gõ `/ai` → bot trả về menu nút bấm:

```
📋 Cấu hình   | 🔍 Kiểm tra key
🗝 Thêm key   | ➕ Thêm model
❓ Hướng dẫn  | 🔄 Làm mới
```

- **📋 Cấu hình** → danh sách từng dòng (bấm vào để vào màn hình của riêng dòng đó).
- Màn hình một dòng: `✅ Bật`, `🔑 Danh sách key`, `🔍 Kiểm tra key`, `🗝 Thêm key`, `🗑 Xoá`.
- **🔑 Danh sách key** → hiện từng key (che giữa); bấm một key là xoá key đó.
- **🗝 Thêm key** → chọn dòng, bot mới hỏi *gõ key vào đây*, tin nhắn kế tiếp
  trong topic được lấy làm key (giữ nguyên các key cũ).
- **➕ Thêm model** → bot hỏi lần lượt: tên → URL → model.
- **🔍 Kiểm tra key** → Gateway gọi `GET {url}/models` với từng key và báo
  `✅ hoạt động` / `❌ key không hợp lệ (401)` / `❌ hết hạn mức (402)`; key hết
  hạn mức bị loại khỏi vòng xoay luôn.

Ngoài nút bấm, các lệnh viết tay vẫn chạy (tiện khi gõ nhanh):

| Lệnh | Tác dụng |
| --- | --- |
| `/ai` | xem cấu hình đang dùng (key hiện ở dạng che) |
| `/ai add <tên> <url> <model>` | tạo mới, hoặc sửa url/model của `<tên>` cũ |
| `/ai url <tên> <url>` | chỉ đổi địa chỉ API (giữ nguyên key) |
| `/ai model <tên> <model>` | chỉ đổi model (giữ nguyên key) |
| `/ai use <tên>` | bật cấu hình này cho mọi máy |
| `/ai del <tên>` | xoá cấu hình |
| `/ai key <tên> add <key>` | thêm API key (một cấu hình được thêm nhiều key) |
| `/ai key <tên> list` | xem key đang lưp (che giữa) |
| `/ai key <tên> del <số>` | xoá key thứ n |

Cách dùng:

```
/ai add chinh https://openrouter.ai/api/v1 stealth/space-bunny-alpha
/ai key chinh add sk-or-...
/ai key chinh add sk-or-...        # thêm key thứ hai
/ai use chinh
```

Luồng chạy:

1. Worker nhận lệnh `/ai...` từ Telegram → `action: ai_admin` → Apps Script ghi
   Sheet cấu hình AI (Sheet riêng nếu đã đặt `AI_CONFIG_SPREADSHEET_ID`) và trả
   kèm cấu hình vừa lưu (Worker dùng ngay, không chờ hết hạn bản ghi nhớ).
2. Khi app chat, app gọi `POST /v1/ai/chat/completions` trên Gateway (thay vì
   tự gọi OpenRouter) kèm token phiên của máy. Worker đọc cấu hình từ
   `action: ai_config`, **tự gắn model của admin** vào request và chuyển tiếp.
3. Worker đi theo **chuỗi dự phòng** (tối đa 12 lần thử):
   key ngẫu nhiên của model đang chạy → key còn lại của model đó → **model kế
   tiếp CÙNG URL** → **URL tiếp theo** (theo cột `Order`). Key trả
   `401/402/403/429` hoặc thân lỗi có quota/limit/balance/credit ⇒ bị loại khỏi
   vòng xoay 15 phút rồi thử bước kế tiếp **ngay trong lượt chat đó**, nên hết
   hạn mức một key không làm AI của khách sập. Lỗi khác hạn mức (model sai, 500)
   thì trả thẳng lỗi thật, không quay key vô ích.

Ranh giới bảo mật:

- API key nằm trên Gateway, **không bao giờ đi xuống máy khách**: app chỉ nhận
  câu trả lời của model. Khi không có Gateway (chạy local-mock / mất mạng) app
  rơi về key cấu hình trên máy như trước.
- `/v1/ai/chat/completions` đòi token phiên hợp lệ và chặn bản quyền
  `Expired`/`Locked`, nên người lạ biết URL Gateway cũng không dùng được key.
- Trả lời trong topic Telegram và nhãn nút bấm đều không in key thật (che giữa).
- `/ai` là lệnh TOÀN CỤC: chạy được ở topic nào, kể cả topic chưa gắn máy.
- Nút bấm chỉ mang mã lệnh + tên cấu hình trong `callback_data` (Telegram giới
  hạn 64 byte), không bao giờ mang key.
- Hai action `ai_admin`/`ai_config` chỉ chạy được khi có `gatewaySecret` đúng, và
  không gọi `ensureTabs_()` nên vẫn phục vụ được khi script chưa gắn Sheet CRM.

## Bảo mật và vận hành

- Không đưa `GAS_SHARED_SECRET`, `TOKEN_SECRET`, Telegram bot token hoặc Firebase service-account vào source/EXE/Google Sheet; token bot chỉ nằm trong secret của Gateway/Worker. Token cũ từng bị hardcode trong `code.gs.txt`, `code.txt` và `set-telegram-webhook.js` nên phải thu hồi (BotFather → `/revoke`) rồi cấp token mới trước khi phát hành.
- Apps Script là CRM license, không nên làm Telegram bridge hoặc cấp Firebase Admin access.
- Gateway đã giới hạn sơ bộ 8 lần kích hoạt/phút mỗi IP, và 60 request/phút cho mỗi action còn lại (`status`, `register`, `chat`, `message`, `notice`). Ở production nên dùng rate limit của nền tảng/WAF và log tập trung.
- Ngày hết hạn là dữ liệu máy chủ; app không được tự quyết định trạng thái Active.
