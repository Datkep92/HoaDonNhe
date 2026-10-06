# Cloudflare Workers Free Gateway

## Telegram AI manager v2

`AI_ADMIN_V2_ENABLED=1` enables `/ai` with URL → model → key navigation.
Only administrators/creator of `TELEGRAM_CHAT_ID` may operate it. Old inline
buttons open the new tree. Typed legacy editing commands show navigation rather
than updating a different store silently. Replies are bound to the administrator,
the exact prompt message, topic, and a ten-minute expiry. `/cancel` clears a prompt.

The first open imports all legacy profiles from Apps Script into a separate
encrypted Firebase record at `/aiAdmin/v2/config`. The original Sheet remains
unchanged. This new record is the source of truth while v2 is enabled. AES-GCM
uses a key derived from `TOKEN_SECRET`; preserve this secret and re-encrypt the
record deliberately before rotating it. Firebase ETag compare-and-swap prevents
simultaneous admins/check jobs from overwriting each other's changes. Audit entries
contain action, administrator ID and timestamp, never raw keys. Key input messages
are deleted after saving; the bot reports if Telegram denies deletion.

Buttons support add/edit/delete at each level, labels, enable/disable, priority,
active model, check selected subtree/all keys, and a confirmed one-token model
test that may be billed by the provider. Deletions bind to a fresh configuration
revision and expire after two minutes. Lists paginate at eight children per page.
Limits: 20 URLs, 30 models/URL, 30 keys/model, 500 keys total.

Navigation updates a single persisted panel per Telegram topic with
`editMessageText`, including check progress/results and confirmations. Only
typed-input prompts require a new message; prompts and answered inputs are
cleaned up afterward. Missing/deleted panels are recreated, unchanged panels
do not produce duplicate messages. Key Status and Help use short Telegram
alert popups (`answerCallbackQuery`, 200 characters). These alerts are read-only;
editing uses the inline buttons and a bound reply prompt.

Each URL has editable Chat, Models and Key endpoints. Defaults are
`/chat/completions`, `/models` and `/key`, appended to the API base URL.
An absolute HTTPS endpoint is accepted only on the same origin as that URL;
keys cannot be redirected to a different host through an endpoint edit.
Entering `-` restores a default. The panel displays resolved endpoint URLs.
Base URLs accidentally ending with `/chat/completions`, `/models`, or `/key`
are normalized when resolving paths. Endpoint changes clear previous cooldowns
and ignore in-flight checks against the old route.

Checks run in batches of three with an encrypted persisted cursor/lease and HMAC
authenticated Worker continuations. Interrupted jobs expose Resume. `/models`
success on a generic provider is labelled model-list only; public catalogs do not
prove that a key is valid, or that credit/model access exists. OpenRouter `/key` supplies key spending
limit and expiry, which is distinct from the account's total balance. A paid model
test needs a separate exact, one-use confirmation.

Runtime tries enabled keys of the selected model, remaining models of that URL,
then other URLs. Shared 401/402 credentials skip all models at the same URL;
model-scoped 403/429 may still try a different model. Persisted cooldowns: quota
15 minutes, authentication 24 hours, unavailable model 5 minutes, URL transport/
server failure 30 seconds. Manual Check or replacing a key can restore eligibility.
Each chat tries at most 40 candidates to fit Worker subrequest limits. Exhaustion
returns an explicit error; it does not promise service when all providers fail.
Fallback happens before forwarding the response stream; it never replays an
already forwarded stream. API endpoints must use OpenAI-compatible chat APIs.

Validate locally: `npm run test:ai-admin`. Deploy with `wrangler deploy`; retain
the webhook subscription to both `message` and `callback_query`.

This is the no-billing deployment target for the support Gateway. Prefer CLI deployment with `wrangler deploy`, which bundles both `src/index.js` and `src/ai-admin.js`. A manual dashboard upload must include both modules; pasting only the main file is insufficient. Set the non-secret variables from `wrangler.jsonc`.

Add these as **Secrets**, never as plain variables:

- `GAS_SHARED_SECRET`
- `TOKEN_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

After deployment, use the Worker URL as `url` in `release/du_lieu/support-gateway.json`. Register Telegram webhook at `https://<worker>/v1/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET`.

For the `/ai` inline buttons, webhook registration must include
`allowed_updates: ["message", "callback_query"]`. Registering only `message`
lets typed commands work but Telegram never delivers button clicks. Omitting
`allowed_updates` on a later `setWebhook` call preserves the previous filter;
deploying the Worker alone does not fix it. Verify the subscription with
`getWebhookInfo`. Preserve the existing URL and secret, and do not drop pending
updates when repairing this filter.

## AI router v3 — registry chung cho Telegram và EXE

### Luồng tự động (06/10/2026)

Trong `/ai`, chọn **➕ Cấu hình · 3 dòng**, trả lời URL, model và API key (mỗi giá trị
một dòng). Hệ thống tự tạo tên, dedupe, nhận diện giao thức, deep test và chọn cấu hình.
Không cần sửa endpoint hoặc bấm chuyển model. Tin chứa key được xóa sau khi lưu.

Các wire format hỗ trợ: OpenAI Chat Completions, Responses, Anthropic Messages và
Gemini native. URL/model chỉ là gợi ý thứ tự discovery; phản hồi thực tế xác nhận
giao thức. Anthropic dùng header x-api-key/version, Gemini dùng x-goog-api-key;
không đưa key vào query string và không theo redirect. Gemini giữ thought signatures,
function-call IDs và JSON Schema theo [tài liệu function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling).

Giới hạn thử của một request được giữ để bảo vệ ngân sách Worker, nhưng phần chưa xét
được chuyển sang job bền vững trong registry mã hóa, có cursor, lease và HMAC continuation.
Cron mỗi phút tiếp tục job bị gián đoạn và kiểm tra cấu hình đến hạn phục hồi. Cấu hình
khỏe không bị deep-test lại toàn bộ theo phút. Các isolate chia sẻ lease và CAS; job
READY cũ mất hiệu lực không che job failover mới.

Gateway trả HTTP 503 với `AI_ROUTING_PENDING` hoặc `HEALTH_CHECK_IN_PROGRESS`, `jobId`,
progress và retry metadata khi đang tìm cấu hình. `GET /v1/ai/jobs/<jobId>` cần phiên/bản
quyền như chat; chỉ trả status/progress/error counts/revision, không trả request hoặc key.
EXE AUTO tự poll và gửi lại cùng messages khi READY, hủy ngay khi user bấm dừng/đóng kết
nối. `AI_CONFIG_EXHAUSTED` chỉ xuất hiện khi đã xét toàn bộ pool phù hợp; lỗi tạm thời
giữ trạng thái chờ phục hồi. Không retry sau khi đã stream nội dung cho client.

Telegram tự cập nhật panel đã có, gom refresh theo 5 giây và cron. Trạng thái key phân
biệt chat đã xác minh với chỉ xác thực key; chi tiết có protocol, thời điểm check/retry.
Quota chỉ lan sang model dùng chung credential khi có bằng chứng phạm vi key/account;
quota model/rate limit không tự làm chết mọi model ở URL đó. Tôn trọng Retry-After.

EXE kiểm thử riêng: `release/CN-Tax-Tools-v1.1.4-automatic.exe`. Cần dùng client mới một
lần để có luồng tự chờ job và refresh metadata; sau đó đổi cấu hình không cần tải lại
EXE. Release 1.1.4 trên GitHub không bị ghi đè. Xem `../AI_AUTOMATIC_FLOW_REPORT.md`.

Bật `AI_ADMIN_V2_ENABLED=1` và `AI_ROUTER_V3_ENABLED=1` bằng cấu hình Wrangler hiện tại.
Triển khai bằng `npx wrangler deploy` để bundle các module `index.js`, `ai-admin.js` và
`ai-routing.js`. Registry mã hóa lưu trong Firebase; cập nhật bằng ETag/CAS, không lưu
key trong response metadata gửi cho EXE.

`/ai` mở cây URL → model → key. Admin có thể thêm nhiều model (phân cách bằng xuống dòng,
dấu phẩy, chấm phẩy hoặc khoảng trắng), deep test, bật/tắt, xem lịch sử và copy URL/model.
Lấy full key/full config chỉ gửi qua DM sau khi kiểm tra quyền admin, không gửi vào group.
Deep test có xác nhận vì có thể tốn quota; job chạy từng key và có lease/continuation.
Thêm cấu hình không lập tức phát hành: router phải xác minh chat và capability cần thiết.

Mỗi tổ hợp URL/model/key có trạng thái riêng: protocol/endpoint đã resolve, capabilities,
health score, latency, lỗi gần nhất, failure count, cooldown và circuit breaker.
Lỗi model không làm key bị xóa. Lỗi auth/quota của cùng credential được chia sẻ giữa
model phù hợp; timeout tạm thời được thử lại. Cấu hình circuit OPEN hết cooldown được
retest với lease Firebase để nhiều isolate không cùng chạy deep check.

Router ưu tiên cấu hình đang khỏe, ngữ cảnh sticky và lastKnownGood; chỉ tăng revision
khi cần đổi cấu hình toàn cục. Failover giữ messages/tool outputs. Không retry sau khi
đã chuyển bytes stream tới client. Giới hạn số lần thử/discovery và thời gian resolver
giúp tránh vượt ngân sách subrequest của Worker.

`GET /v1/ai/config` cần session/license như AI proxy; trả metadata active/revision, không
trả key. Chat trả `X-AI-Revision` và `X-AI-Model`. EXE AUTO cập nhật ở runtime; MANUAL
dùng cấu hình riêng, giữ các giá trị đã lưu. Telegram có typing; EXE có loading.

Resolver hỗ trợ Chat Completions và Responses, tránh `/v1/v1`. Với Responses, adapter
dùng phản hồi hoàn chỉnh rồi đóng gói SSE tương thích; `nativeStream` không được đánh
true. Vision/reasoning/structured phát hiện từ metadata nếu có, chưa thay thế thử nghiệm
ảnh/schema thật. Một completion rỗng hoặc SSE error không được đánh healthy chỉ vì HTTP 200.

Kiểm tra: `npm run test:ai-admin`, `npm run test:ai`, `npm test` tại thư mục dự án.
Xem `../CHATAI_CHECKLIST_FINAL_REPORT.md` để biết kết quả live, EXE và giới hạn xác minh.

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
