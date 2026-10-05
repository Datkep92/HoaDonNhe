\# MASTER TASK — CLOUDFLARE AI CONFIG / ROUTER / TELEGRAM / EXE



\## 1. MỤC TIÊU



Nâng cấp hệ thống AI hiện tại để \*\*Cloudflare trở thành nguồn cấu hình AI trung tâm\*\* cho Telegram và ứng dụng EXE.



Mục tiêu cuối:



```text

URL / API KEY / MODEL

&#x20;       ↓

Cloudflare Registry

&#x20;       ↓

Auto Detect / Resolver

&#x20;       ↓

Deep Health Check

&#x20;       ↓

Capability Check

&#x20;       ↓

Health Score

&#x20;       ↓

Active Configuration

&#x20;       ↓

Telegram + EXE

```



Khi cấu hình đang sử dụng gặp:



\- hết quota

\- API key hết hạn

\- API key không hợp lệ

\- model không tồn tại

\- endpoint sai

\- provider lỗi

\- timeout

\- rate limit

\- protocol không tương thích



hệ thống phải có khả năng:



```text

Detect

→ xác nhận lỗi

→ cooldown cấu hình lỗi

→ tìm cấu hình khác

→ test

→ chọn cấu hình hoạt động

→ publish cấu hình mới

→ EXE tự nhận cấu hình mới

```



Mục tiêu quan trọng:



> User bình thường phải luôn có cấu hình Chat AI hoạt động mà không cần hiểu URL, API key hay model.



\---



\# 2. NGUYÊN TẮC IMPLEMENT



\## BẮT BUỘC AUDIT CODE TRƯỚC



Trước khi sửa:



1\. Đọc implementation hiện tại.

2\. Xác định cấu trúc Cloudflare Worker.

3\. Xác định Telegram bot hiện tại.

4\. Xác định registry/config hiện tại.

5\. Xác định logic test URL/API/model.

6\. Xác định logic map model → URL → API.

7\. Xác định API mà EXE đang sử dụng.

8\. Xác định cơ chế lưu cấu hình hiện tại.

9\. Xác định UI/nút Telegram hiện có.

10\. Xác định command Telegram hiện có.



Không được viết lại hệ thống nếu có thể mở rộng logic hiện tại.



Ưu tiên:



```text

Reuse existing logic

→ Extend existing functions

→ Giữ backward compatibility

→ Không phá cấu hình đang chạy

```



\---



\# 3. KHÔNG ĐƯỢC KẾT LUẬN KEY CHỈ BẰNG 1 REQUEST



Đây là yêu cầu quan trọng.



Hiện có trường hợp:



```text

Cùng URL

Cùng API key

Cùng model



EXE → chạy

Telegram → không chạy

```



Do đó không được chỉ:



```text

request thành công = GREEN

request lỗi = RED

```



Phải xây dựng \*\*Deep Health Check\*\*.



\---



\# 4. DEEP HEALTH CHECK



Mỗi cấu hình phải được kiểm tra nhiều tầng nếu provider hỗ trợ.



Ví dụ:



```text

1\. Base URL reachable

2\. Authentication

3\. Models endpoint

4\. Requested model tồn tại

5\. Chat completion thật

6\. Streaming

7\. Tool calling nếu cần

8\. Response format

```



Không bắt buộc provider phải hỗ trợ tất cả endpoint.



Resolver phải tự nhận biết capability.



\---



\# 5. RETRY / CONFIRM FAILURE



Không đánh DOWN chỉ vì một request lỗi mạng.



Ví dụ:



```text

Test 1 FAIL

Test 2 PASS

Test 3 PASS



=> HEALTHY

```



Có thể sử dụng cơ chế kiểu:



```text

2/3 failures

```



hoặc health scoring phù hợp hơn.



Riêng lỗi chắc chắn như:



```text

401

403

invalid\_api\_key

invalid\_model

```



có thể phân loại ngay tùy response thực tế.



\---



\# 6. PHÂN LOẠI LỖI



Ít nhất phải phân biệt:



```text

AUTH\_ERROR

INVALID\_KEY

EXPIRED\_KEY

QUOTA\_EXCEEDED

RATE\_LIMIT

MODEL\_NOT\_FOUND

ENDPOINT\_NOT\_FOUND

PROTOCOL\_MISMATCH

PROVIDER\_ERROR

NETWORK\_ERROR

TIMEOUT

CAPABILITY\_MISMATCH

UNKNOWN\_ERROR

```



Không gom tất cả thành:



```text

API FAILED

```



\---



\# 7. AUTO PROTOCOL / STRUCTURE RESOLVER



Đây là chức năng bắt buộc.



Không được giả định mọi API đều có cùng cấu trúc OpenAI.



Resolver phải có khả năng xác định cấu trúc thích hợp.



Ví dụ có thể thử:



```text

/v1/chat/completions

/chat/completions

/v1/responses

```



và adapter/provider-specific nếu codebase hiện tại có hỗ trợ.



Phải tránh nối URL sai kiểu:



```text

.../v1/v1/chat/completions

```



hoặc bỏ `/v1` khi provider yêu cầu.



Khi tìm được cấu trúc hoạt động:



```text

URL

\+ protocol

\+ model

\+ API key

\+ capabilities

```



phải được cache/lưu.



Không resolver lại từ đầu ở mọi request nếu cấu hình đã được xác nhận.



\---



\# 8. CONFIGURATION LÀ MỘT ĐƠN VỊ HOÀN CHỈNH



Không chỉ quản lý API key.



Một configuration phải có tối thiểu:



```text

provider

baseUrl

protocol

model

apiKey/reference

capabilities

priority

health

healthScore

latency

failureCount

lastSuccess

lastFailure

lastError

cooldownUntil

```



Failover phải dựa trên \*\*configuration\*\*, không chỉ API key.



\---



\# 9. HEALTH SCORE



Không chỉ sử dụng:



```text

GREEN

RED

```



Có thể vẫn hiển thị GREEN/RED cho UI, nhưng backend cần score.



Score nên xem xét:



```text

success rate

recent failures

latency

quota/rate limit

last successful request

capability compatibility

```



Router ưu tiên cấu hình:



```text

HEALTHY

\+

ổn định

\+

phù hợp capability

\+

priority cao

```



Không nhất thiết chọn API có một lần ping nhanh nhất.



\---



\# 10. CIRCUIT BREAKER



Configuration lỗi liên tục:



```text

ACTIVE

→ FAIL

→ FAIL

→ DOWN

→ COOLDOWN

```



Trong cooldown không spam request vào API lỗi.



Sau cooldown:



```text

RETEST

```



Nếu PASS:



```text

HEALTHY

→ quay lại pool

```



KHÔNG tự động xóa key/model/configuration chỉ vì lỗi.



\---



\# 11. FAILOVER



Ví dụ:



```text

CONFIG A

↓ quota



CONFIG B

↓ model unavailable



CONFIG C

↓ PASS



ACTIVE = CONFIG C

```



Failover có thể thay đổi:



```text

key

model

provider

URL

protocol

```



nếu cần.



\---



\# 12. CHỐNG FAILOVER LOOP



Không được:



```text

A → B → A → B → A...

```



Cần:



```text

cooldown

failure counter

health score

last known good

```



để tránh vòng lặp.



\---



\# 13. LAST KNOWN GOOD



Luôn lưu:



```text

currentConfig

lastKnownGood

```



Nếu config mới được publish nhưng phát sinh lỗi nghiêm trọng:



```text

rollback → lastKnownGood

```



\---



\# 14. CONFIG REVISION



Mỗi lần Active Configuration thay đổi:



```text

configRevision++

```



Ví dụ:



```text

revision 31

↓ failover

revision 32

```



EXE có thể nhận biết cấu hình đã thay đổi.



\---



\# 15. CLOUDFLARE LÀ CONFIG SOURCE CHÍNH CỦA EXE



Chat AI trong EXE mặc định sử dụng:



```text

Cloudflare Active Configuration

```



Không yêu cầu user bình thường tự nhập:



```text

URL

API key

model

```



\---



\# 16. MANUAL CONFIG TRONG EXE VẪN GIỮ



Không xóa chức năng cấu hình thủ công.



Cần hai chế độ rõ ràng:



```text

AUTO — Cloudflare

MANUAL — User configuration

```



Nếu:



```text

MANUAL = ON

```



Cloudflare không được tự ghi đè cấu hình riêng của user.



Nếu:



```text

AUTO = ON

```



EXE sử dụng Active Configuration từ Cloudflare.



\---



\# 17. EXE AUTO UPDATE CONFIG



Nếu EXE đang dùng:



```text

revision 31

```



Cloudflare failover và publish:



```text

revision 32

```



EXE phải có khả năng nhận configuration mới.



Không yêu cầu:



```text

update EXE

restart EXE

user nhập lại API

```



nếu kiến trúc hiện tại cho phép cập nhật runtime.



\---



\# 18. KHÔNG ĐỂ NHIỀU EXE GÂY FAILOVER STORM



Ví dụ 100 client cùng gặp quota.



Không được chạy:



```text

100 health check

100 failover

100 revision update

```



Cloudflare phải có lock/debounce/single-flight hoặc cơ chế tương đương.



Mục tiêu:



```text

Client đầu tiên phát hiện

→ Cloudflare xác nhận

→ failover 1 lần

→ revision thay đổi

→ client khác nhận revision mới

```



\---



\# 19. STICKY ROUTING



Nếu một cuộc hội thoại đang chạy tốt với:



```text

Model A

```



không tự đổi sang Model B chỉ vì B vừa có latency tốt hơn.



Tiếp tục Model A cho đến khi:



```text

A unhealthy

A quota

A unavailable

hoặc policy yêu cầu chuyển

```



\---



\# 20. PRESERVE CHAT CONTEXT KHI FAILOVER



Nếu:



```text

Model A

→ chết giữa conversation

→ chuyển Model B

```



phải giữ conversation context cần thiết.



User không được gặp tình trạng:



```text

AI quên toàn bộ cuộc trò chuyện

```



chỉ vì failover.



\---



\# 21. CAPABILITY DETECTION



Mỗi model/config nên có capability khi xác định được:



```text

chat

stream

tools

vision

reasoning

```



Có thể mở rộng sau.



Một API trả HTTP 200 không đồng nghĩa nó phù hợp với Chat AI của EXE.



Router phải chọn configuration đáp ứng capability mà request yêu cầu.



\---



\# 22. TELEGRAM — THÊM 1 MODEL



Giữ chức năng hiện tại:



```text

Thêm model

→ nhập 1 model

→ test

→ map

→ lưu

```



\---



\# 23. TELEGRAM — THÊM NHIỀU MODEL



Bổ sung nút:



```text

➕ Thêm nhiều model

```



Cho phép paste:



```text

model-a

model-b

model-c

model-d

```



Có thể chấp nhận thêm format khác nếu dễ triển khai và không phá logic.



Sau khi nhận:



```text

parse

→ trim

→ validate

→ deduplicate

→ detect provider/config

→ test

→ lưu kết quả

```



Phải trả summary.



Ví dụ:



```text

4 models received

3 PASS

1 FAIL

```



\---



\# 24. TEST BEFORE PUBLISH



Configuration mới không được lập tức đưa cho EXE.



Luồng:



```text

INPUT

↓

DETECT

↓

MAP

↓

DEEP TEST

↓

CAPABILITY TEST

↓

PASS

↓

PUBLISH

```



Nếu FAIL:



```text

lưu trạng thái nếu cần

nhưng KHÔNG publish làm Active Config

```



\---



\# 25. TELEGRAM — COPY API KEY



Trong khu vực quản trị riêng của owner/admin:



API key \*\*không bắt buộc mask\*\*.



Admin phải có khả năng lấy full API key để sử dụng cấu hình cá nhân.



Nhưng:



\- Không gửi full key vào group/channel.

\- Không ghi full key vào log.

\- Không đưa full key vào error message.

\- Không expose cho user thường.



Phải kiểm tra Telegram Admin/User ID trước khi reveal.



\---



\# 26. TELEGRAM — COPY MODEL



Bổ sung khả năng lấy/copy chính xác:



```text

model

```



Ví dụ:



```text

openai/gpt-6.1-sol

```



\---



\# 27. TELEGRAM — COPY URL



Bổ sung khả năng lấy/copy chính xác:



```text

Base URL

```



Ví dụ:



```text

https://openrouter.ai/api/v1

```



\---



\# 28. TELEGRAM — COPY FULL CONFIG



Nên có:



```text

📋 Copy cấu hình

```



Trả về đầy đủ:



```text

URL

MODEL

API KEY

```



và protocol/provider nếu hữu ích.



Chỉ Admin được xem full API key.



\---



\# 29. TELEGRAM UI — GIẢM COMMAND KHÔNG CẦN THIẾT



Audit toàn bộ command hiện tại.



Nếu chức năng đã có UI button tốt thì không cần tiếp tục hiển thị hướng dẫn command dài dòng.



Ưu tiên:



```text

Button

→ submenu

→ action

```



Command chỉ giữ cho:



\- chức năng cần thiết

\- thao tác nhanh thực sự hữu ích

\- admin/debug nếu cần



Không xóa backend function chỉ vì bỏ command khỏi menu nếu function vẫn được UI sử dụng.



\---



\# 30. AI WORKING INDICATOR — TELEGRAM



Ngay khi user gửi câu hỏi:



Telegram phải cho user biết AI đang xử lý.



Ưu tiên sử dụng:



```text

typing...

```



Nếu xử lý kéo dài, phải duy trì trạng thái phù hợp nếu Telegram API cho phép.



Không để user gửi câu hỏi rồi im lặng nhiều giây.



\---



\# 31. AI WORKING INDICATOR — EXE



Chat AI trong EXE cần trạng thái trực quan.



Ví dụ:



```text

AI đang xử lý.

AI đang xử lý..

AI đang xử lý...

```



hoặc animation loading phù hợp UI hiện tại.



Khi response bắt đầu stream:



```text

loading → response

```



Khi hoàn thành:



```text

remove loading

```



Khi lỗi:



```text

remove loading

→ hiển thị thông báo phù hợp

```



\---



\# 32. FAILOVER PHẢI TRANSPARENT VỚI USER



Nếu request đang chạy:



```text

Config A

→ quota

→ failover Config B

→ PASS

```



user không cần nhìn thấy error kỹ thuật của Config A.



User chỉ cần:



```text

AI đang xử lý...

→ response

```



Chi tiết failover dành cho Admin/diagnostics.



\---



\# 33. ADMIN FAILOVER HISTORY



Nên lưu lịch sử ngắn gọn:



```text

timestamp

fromConfig

toConfig

reason

errorClass

revision

```



Ví dụ:



```text

00:52

OpenRouter/A → OpenRouter/B

429 QUOTA

rev 31 → 32

```



Không lưu full API key trong history.



\---



\# 34. API KEY SECURITY



API key có thể reveal cho Admin theo yêu cầu.



Nhưng tuyệt đối không:



```text

console.log(fullApiKey)

error(fullApiKey)

history(fullApiKey)

public API response(fullApiKey)

normal user response(fullApiKey)

```



Mask trong log:



```text

sk-o\*\*\*\*2806

```



\---



\# 35. BACKWARD COMPATIBILITY



Sau khi nâng cấp:



\- Telegram hiện tại vẫn chạy.

\- Config hiện tại vẫn đọc được.

\- EXE hiện tại không bị phá API contract nếu không thật sự cần.

\- Dữ liệu/key/model hiện tại không bị mất.

\- Không tự xóa cấu hình lỗi.

\- Không đổi schema phá dữ liệu mà không migration.



Nếu cần migration:



```text

migration phải backward-safe

```



\---



\# 36. KHÔNG OVER-ENGINEER



Không được viết lại toàn bộ project chỉ để thực hiện task này.



Ưu tiên:



```text

minimal safe changes

\+

reusable modules

\+

clear state machine

```



Nhưng không được dùng "minimal change" làm lý do bỏ qua các yêu cầu bắt buộc.



\---



\# 37. CHECKLIST IMPLEMENTATION



AI phải tự đánh dấu checklist sau khi thực hiện.



```text

[x] Audit architecture hiện tại

[x] Audit Telegram flow

[x] Audit EXE config API

[x] Audit health-check hiện tại

[x] Deep health check

[x] Retry/confirmation

[x] Error classification

[x] Protocol resolver

[x] URL normalization

[x] Configuration-level routing

[x] Health score

[x] Circuit breaker

[x] Cooldown/recovery

[x] Failover

[x] Anti failover-loop

[x] LastKnownGood

[x] Rollback

[x] Config revision

[x] Cloudflare Active Config

[x] EXE Auto mode

[x] EXE Manual override

[x] Runtime config refresh

[x] Failover storm protection

[x] Sticky routing

[x] Preserve conversation context

[x] Capability detection

[x] Telegram add one model

[x] Telegram bulk add models

[x] Test before publish

[x] Copy API key

[x] Copy model

[x] Copy URL

[x] Copy full configuration

[x] Admin authorization

[x] Remove unnecessary command clutter

[x] Telegram typing indicator

[x] EXE AI working animation

[x] Transparent failover

[x] Failover history

[x] Secret-safe logging

[x] Backward compatibility

```



\---



\# 38. TEST CASES BẮT BUỘC



Không được kết luận hoàn thành chỉ vì code compile.



Phải test tối thiểu các trường hợp có thể test trong môi trường hiện tại.



\### TEST 1 — GOOD CONFIG



```text

Valid URL

Valid key

Valid model

```



Expected:



```text

HEALTHY

```



\---



\### TEST 2 — INVALID KEY



Expected:



```text

AUTH/INVALID\_KEY

không publish

```



\---



\### TEST 3 — INVALID MODEL



Expected:



```text

MODEL\_NOT\_FOUND

```



Không được kết luận API key chết.



\---



\### TEST 4 — WRONG ENDPOINT STRUCTURE



Resolver phải thử cấu trúc thích hợp nếu provider hỗ trợ.



Expected:



```text

detect correct protocol

→ PASS

```



\---



\### TEST 5 — QUOTA



Expected:



```text

QUOTA/RATE\_LIMIT

→ cooldown

→ failover

```



\---



\### TEST 6 — TEMPORARY NETWORK FAILURE



Một timeout đơn lẻ không được lập tức permanently DOWN config.



\---



\### TEST 7 — FAILOVER



```text

A FAIL

B PASS

```



Expected:



```text

Active = B

revision++

```



\---



\### TEST 8 — RECOVERY



```text

A cooldown

→ retest

→ PASS

```



Expected:



```text

A trở lại healthy pool

```



\---



\### TEST 9 — TELEGRAM BULK MODEL



Input:



```text

model-a

model-b

model-c

```



Expected:



```text

parse 3

dedupe

test từng model

summary chính xác

```



\---



\### TEST 10 — COPY CONFIG



Admin:



```text

copy URL

copy model

copy API

copy full config

```



Expected:



```text

full values available

```



Normal user:



```text

không reveal secret

```



\---



\### TEST 11 — EXE AUTO CONFIG



Expected:



```text

EXE lấy Active Configuration

```



\---



\### TEST 12 — MANUAL OVERRIDE



Expected:



```text

Manual ON

→ Cloudflare không override user config

```



\---



\### TEST 13 — REVISION CHANGE



```text

rev N

→ failover

→ rev N+1

```



EXE phải nhận được revision mới theo cơ chế sync được implement.



\---



\### TEST 14 — CHAT CONTEXT



Failover giữa conversation.



Expected:



```text

conversation tiếp tục hợp lý

```



\---



\### TEST 15 — WORKING INDICATOR



Telegram:



```text

typing immediately

```



EXE:



```text

loading immediately

```



Không để UI trông như bị treo.



\---



\# 39. KHÔNG ĐƯỢC BÁO "HOÀN THÀNH" NẾU CHƯA TEST



Nếu phần nào không test được vì thiếu:



```text

credential

runtime

external service

EXE environment

Telegram environment

```



phải ghi rõ:



```text

IMPLEMENTED — NOT RUNTIME VERIFIED

```



Không được ghi PASS giả.



\---



\# 40. FINAL REPORT BẮT BUỘC



Sau khi hoàn thành, trả một báo cáo duy nhất.



Format:



\## FINAL REPORT



\### A. AUDIT



Tóm tắt kiến trúc cũ đã tìm thấy.



\### B. IMPLEMENTED



Liệt kê chính xác chức năng đã làm.



\### C. FILES CHANGED



```text

file A — lý do

file B — lý do

file C — lý do

```



\### D. TEST RESULTS



```text

PASS — ...

PASS — ...

FAIL — ...

NOT VERIFIED — ...

```



\### E. CHECKLIST



In lại checklist với:



```text

\[x]

\[ ]

```



\### F. BACKWARD COMPATIBILITY



Xác nhận những behavior cũ đã kiểm tra.



\### G. REMAINING ISSUES



Nếu còn vấn đề, ghi rõ.



Nếu không:



```text

NONE

```



\### H. FINAL STATUS



Chỉ được dùng một trong:



```text

COMPLETE

```



hoặc



```text

PARTIAL — ACTION REQUIRED

```



\---



\# 41. QUY TẮC CUỐI



Không hỏi user xác nhận cho từng thay đổi nhỏ.



Tự audit → implement → test → sửa lỗi phát hiện được → test lại.



Chỉ dừng và hỏi khi gặp blocker thật sự như:



```text

thiếu credential bắt buộc

không có quyền truy cập

có nguy cơ mất dữ liệu

cần quyết định kiến trúc không thể suy ra từ code

```



Không được:



```text

implement nửa chừng rồi tuyên bố complete

```



Không được bỏ test.



Không được phá chức năng đang hoạt động.



Không được xóa cấu hình/key chỉ vì health check thất bại.



Mục tiêu cuối cùng:



```text

PASTE CONFIG

→ AUTO DETECT

→ AUTO MAP

→ DEEP TEST

→ PUBLISH

→ EXE/TELEGRAM USE

→ AUTO FAILOVER

→ AUTO RECOVER

```



với trải nghiệm user:



```text

Mở Chat AI

→ hỏi

→ thấy AI đang xử lý

→ nhận câu trả lời

```
