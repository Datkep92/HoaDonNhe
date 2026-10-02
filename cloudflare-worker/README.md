# Cloudflare Workers Free Gateway

This is the no-billing deployment target for the support Gateway. Create a Worker from the Cloudflare dashboard, paste `src/index.js`, and set the non-secret variables from `wrangler.jsonc`.

Add these as **Secrets**, never as plain variables:

- `GAS_SHARED_SECRET`
- `TOKEN_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

After deployment, use the Worker URL as `url` in `release/du_lieu/support-gateway.json`. Register Telegram webhook at `https://<worker>/v1/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET`.

## Deploy without the dashboard (API)

`deploy.mjs` uploads `src/index.js` as an ES module through the Cloudflare API (no wrangler, no browser).
The token needs one permission only: **Account → Workers Scripts → Edit** (give it a 1-day expiry and revoke it afterwards).

```powershell
cd cloudflare-worker
$env:CLOUDFLARE_API_TOKEN = (Get-Content "$env:TEMP\cf-token.txt" -Raw).Trim()   # or paste the token here
$env:GAS_URL = 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec'
$env:FIREBASE_DATABASE_URL = 'https://<PROJECT>-default-rtdb.firebaseio.com'
$env:TELEGRAM_CHAT_ID = '-1001234567890'
node deploy.mjs
```

Optional: set `GAS_SHARED_SECRET`, `TOKEN_SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET` as environment variables and the same script pushes them as secrets too; otherwise
add them by hand in **Settings → Variables and Secrets**. Variables left unset are simply skipped, so the
script is safe to run before Google Apps Script or Firebase are ready.

If the token cannot list accounts, set `CLOUDFLARE_ACCOUNT_ID` (the `…` id in your dashboard URL) as well.

The script finishes by calling `<worker>/healthz`, which must answer `{"ok":true}`.

Verify the wiring without touching spreadsheet data: `POST /v1/licenses/status` with a made-up
`installationId` (UUID) and `chatRoomId` (`ROOM_WIN_…`) is read-only and must answer
`{"ok":true,"value":{"status":"Unactivated"}}`. Do **not** use `/v1/devices/register` for testing — it appends
a row to the `Devices` sheet.

Chat realtime (không polling): `GET /v1/chats/stream?installationId=<mã máy>&chatRoomId=ROOM_WIN_…` kèm
`Authorization: Bearer <sessionToken>` (token do `/v1/sync`, `/v1/devices/register` hoặc `/v1/licenses/status`
trả về) sẽ chuyển tiếp REST streaming của Firebase RTDB dưới dạng SSE (`event: put` / `patch`). Route này giúp
app không phải hỏi tin nhắn định kỳ; **phải deploy lại Worker thì route mới có hiệu lực**, sau đó app tự nối lại
khi mở lần sau (backoff 5s→300s).

## Mã máy ổn định — 1 máy = 1 mã = 1 phòng chat

Mọi action nhận `machineId` (dạng `DEV_` + 16 hex, băm từ `MachineGuid` + mainboard) bên cạnh
`installationId` cũ (UUID). Worker chấp nhận **cả hai** để app đang chạy ngoài hiện trường không bị chặn;
`machineId` sai dạng thì bị từ chối ngay (nếu lọt, giá trị rác sẽ được ghi vào cột khoá `Machine ID`).

Apps Script tự thêm cột `Machine ID` vào tab `Devices` nếu chưa có, rồi tra dòng theo thứ tự:
`Machine ID` → `Hardware ID` (cũ) → `Hardware Hash` (cũ). Khớp lần đầu sẽ **ghi ngược `Machine ID` vào dòng
đó**, nên từ lần sau khách cài lại app (mất hết dữ liệu cục bộ) vẫn ra đúng dòng cũ: giữ `First Install Time`
(không reset được dùng thử), giữ key, giữ `Chat Room ID` (không sinh phòng chat thứ hai).

`chatRoomId` được **suy ra từ mã máy**, không random — xem `src/machine-id.js`.

## Tín hiệu app ↔ máy chủ

| Endpoint | Khi nào | Đụng Apps Script? |
|---|---|---|
| `POST /v1/sync` | mở app | có (1 lần, trả cả bản quyền + thông báo + token) |
| `POST /v1/ping` | app chạy nền, **chỉ khi có dấu hiệu cần hỏi** | **không** — chỉ đọc bản ghi nhớ Firebase |
| `GET /v1/chats/stream` | khi có cửa sổ chat mở | không (Firebase streaming) |

App **không** polling theo đồng hồ cứng. Mỗi nhịp ~4h (có chênh lệch riêng theo mã máy) app tự hỏi
`needsServerCheck()` — hỏi máy chủ khi: key còn dưới 14 ngày, chưa từng hỏi thành công, đã hỏi quá 4h, hoặc
máy chủ báo mã máy lệch. Không có dấu hiệu thì không gọi mạng.

Mỗi lần Gateway nhận trạng thái thật từ Apps Script, nó ghi bản ghi nhớ tại
`/devices/<chatRoomId>/license` và `/devices/<chatRoomId>/presence`. Nhờ vậy lệnh `/lock`, `/unlock`,
`/reset` do admin gõ trên Telegram được phản ánh cho app ở lần hỏi nhẹ kế tiếp mà không tốn quota.

## Đối soát dữ liệu

```powershell
$env:FIREBASE_DATABASE_URL = 'https://<PROJECT>-default-rtdb.firebaseio.com'
$env:FIREBASE_SERVICE_ACCOUNT_JSON = Get-Content '<service-account>.json' -Raw
node tools/support-reconcile.cjs               # chỉ báo cáo
node tools/support-reconcile.cjs --fix         # nối lại mapping ngược bị mất
node tools/support-reconcile.cjs --fix --delete-orphan-topics   # dọn topic thừa (không hoàn tác được)
```

Tìm phòng chưa có topic, topic mồ côi, mapping ngược bị mất, một phòng bị nhiều topic trỏ tới, máy lâu
không mở app. Mặc định **chỉ báo cáo**. `--fix` chỉ sửa thứ chắc chắn đúng; topic đang bị phòng khác trỏ
tới thì báo `contestedTopics` để sửa tay bằng `/link` chứ không xoá.

## Thông báo tải app từ landing

`POST /v1/landing/download` — mỗi lượt khách bấm nút tải trên trang landing thì bắn một tin vào
topic Telegram **"⬇️ Tải app từ landing"** (tự tạo lần đầu, nhớ id ở Firebase
`/landingDownload/telegramThreadId`; nếu admin xoá topic thì tự tạo lại).

```
⬇️ CÓ NGƯỜI TẢI APP
🕐 14:32 01/10/2026 (GMT+7)
📄 Trang: /#download
🌍 Quốc gia: VN
💻 Thiết bị: Windows · máy tính · Edge
```

Route này **không cần phiên, không cần token, không đụng GAS** — trang gửi duy nhất đường dẫn
(`{"page": "/#download"}`); quốc gia và thiết bị Worker tự đọc từ header Cloudflare
(`CF-IPCountry`, `User-Agent`) chứ không phải từ trình duyệt. CORS mở `*` vì landing nằm ở
domain khác (`github.io`). Trang gọi bằng `navigator.sendBeacon` với `Blob` kiểu `text/plain`
nên không dính preflight, và việc báo cáo không chặn không cản lượt tải.

Bật cho landing-page: đánh dấu nút tải bằng `data-dl` và gọi endpoint ở `click`
(xem `landing-page/script.js`). Thử sau khi deploy:

```powershell
cd cloudflare-worker
node smoke-landing.mjs      # bắn 1 tin thật và kiểm tra header CORS
```

Bỏ giới hạn số lượt theo yêu cầu — bấm bao nhiêu lần thì báo bấy nhiêu tin.
