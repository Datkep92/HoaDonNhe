# PLAN --- AI Agent tích hợp vào Chat của HoaDonNhe EXE

## 1. Mục tiêu

Tích hợp một AI Agent trực tiếp vào phần Chat của HoaDonNhe.

Người dùng không cần biết lệnh kỹ thuật. Người dùng chỉ cần nhắn bằng
ngôn ngữ tự nhiên, ví dụ:

-   "Kiểm tra hóa đơn bán ra tháng 9."
-   "Tìm hóa đơn trùng và xuất Excel."
-   "Cho tôi xem các hóa đơn trên 100 triệu."
-   "Tại sao dữ liệu tháng này bị lệch?"
-   "Tải hóa đơn của MST đang chọn."
-   "Đọc dữ liệu hiện tại và tổng hợp giúp tôi."

Agent phải:

1.  Hiểu yêu cầu người dùng.
2.  Chỉ hỗ trợ các công việc thuộc phạm vi HoaDonNhe.
3.  Tự xác định dữ liệu/context cần đọc.
4.  Tự chọn tool hoặc logic JS phù hợp.
5.  Có thể thực hiện nhiều bước liên tiếp.
6.  Tự kiểm tra kết quả sau mỗi hành động.
7.  Có thể phân tích, đánh giá, tổng hợp dữ liệu.
8.  Có thể tạo/xuất file khi người dùng yêu cầu.
9.  Trả lời kết quả lại ngay trong Chat.
10. Không được có quyền tùy ý trên máy tính ngoài phạm vi EXE.

------------------------------------------------------------------------

## 2. Cấu hình API giai đoạn TEST

Provider: OpenRouter

``` js
const AI_CONFIG = {
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  model: "stealth/space-bunny-alpha",
  apiKey: process.env.OPENROUTER_API_KEY || "<TEST_API_KEY>"
};
```

Trong giai đoạn test có thể đặt key trong file cấu hình local không
commit Git.

Khuyến nghị:

``` text
HoaDonNhe/
  .env.local
  .gitignore
```

`.env.local`:

``` env
OPENROUTER_API_KEY=<TEST_API_KEY>
AI_MODEL=stealth/space-bunny-alpha
AI_API_URL=https://openrouter.ai/api/v1/chat/completions
```

`.gitignore` phải có:

``` gitignore
.env
.env.*
!.env.example
```

Sau khi Agent chạy ổn:

``` text
EXE
 ↓
Cloudflare Worker
 ↓
OpenRouter
```

Khi đó API key không còn nằm trong EXE.

------------------------------------------------------------------------

## 3. Kiến trúc tổng thể

``` text
┌──────────────────────────────────┐
│          CHAT HOA DON NHE        │
│                                  │
│  Chat thường / AI hỗ trợ         │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│          AI CHAT CONTROLLER      │
│  session / messages / context    │
└───────────────┬──────────────────┘
                │
                ▼
┌──────────────────────────────────┐
│             AGENT LOOP           │
│ understand → plan → act → verify │
└───────┬────────────┬─────────────┘
        │            │
        ▼            ▼
┌─────────────┐  ┌─────────────────┐
│ TOOL ROUTER │  │ SAFE JS RUNTIME │
└──────┬──────┘  └────────┬────────┘
       │                  │
       └────────┬─────────┘
                ▼
┌──────────────────────────────────┐
│       EXISTING APP SERVICES      │
│ account / invoices / search      │
│ download / data / export / ...   │
└───────────────┬──────────────────┘
                ▼
┌──────────────────────────────────┐
│        RESULT + VERIFICATION     │
└───────────────┬──────────────────┘
                ▼
              AGENT
                │
        cần làm tiếp?
          YES ──┘
          NO
                ↓
          trả lời User
```

------------------------------------------------------------------------

## 4. Chế độ Chat

Trong giao diện Chat thêm lựa chọn:

``` text
[ Chat hỗ trợ ] [ AI Agent ]
```

Khi chọn `AI Agent`:

-   Message của user được gửi vào `AgentController`.
-   Agent nhận context hiện tại của app.
-   Agent có danh sách tools được phép sử dụng.
-   Agent tự quyết định trả lời hoặc hành động.
-   UI hiển thị trạng thái ngắn gọn khi Agent đang chạy.

Ví dụ:

``` text
Đang kiểm tra dữ liệu...
Đang tìm hóa đơn...
Đang phân tích 1.284 hóa đơn...
Đang tạo file Excel...
```

Không hiển thị chain-of-thought nội bộ của model.

------------------------------------------------------------------------

## 5. Context cấp cho Agent

Không gửi toàn bộ ứng dụng vào model ở mỗi request.

Tạo `getAgentContext()` trả về context cần thiết:

``` js
{
  app: {
    name: "HoaDonNhe",
    version: "..."
  },

  currentUser: {
    selectedMst: "...",
    accountStatus: "authenticated"
  },

  screen: {
    currentPage: "invoice-list",
    activeTab: "...",
    filters: {}
  },

  capabilities: [
    "invoice.search",
    "invoice.read",
    "invoice.download",
    "invoice.analyze",
    "file.exportExcel"
  ]
}
```

Dữ liệu lớn chỉ gửi khi Agent gọi tool yêu cầu.

------------------------------------------------------------------------

## 6. System Prompt bắt buộc

Agent phải có system instruction riêng.

Yêu cầu chính:

``` text
Bạn là AI Agent tích hợp trong ứng dụng HoaDonNhe.

NHIỆM VỤ:
- Hỗ trợ người dùng sử dụng và xử lý dữ liệu trong HoaDonNhe.
- Hiểu yêu cầu bằng ngôn ngữ tự nhiên.
- Sử dụng các tool được cung cấp khi cần hành động.
- Có thể thực hiện nhiều tool liên tiếp.
- Sau hành động phải kiểm tra kết quả.
- Nếu kết quả chưa đạt yêu cầu, được phép thử cách khác trong phạm vi tools.
- Ưu tiên sử dụng chức năng/logic hiện có của ứng dụng.
- Chỉ sử dụng Safe JS Runtime khi tools hiện có không đủ cho thao tác xử lý dữ liệu.

PHẠM VI:
- hóa đơn
- hàng hóa/dịch vụ
- MST
- dữ liệu ứng dụng
- tra cứu
- tải dữ liệu
- phân tích
- đối chiếu
- tổng hợp
- xuất file
- hướng dẫn sử dụng HoaDonNhe
- các chức năng khác được Tool Registry công bố

KHÔNG ĐƯỢC:
- thực hiện công việc ngoài phạm vi HoaDonNhe
- tự ý chạy shell/CMD/PowerShell
- truy cập secret/API key
- tự ý truy cập filesystem ngoài vùng được cấp
- chạy Node.js API nguy hiểm
- tự ý xóa dữ liệu
- tự ý thay đổi source code
- tự tạo hoặc gọi tool không tồn tại

Nếu yêu cầu ngoài phạm vi, trả lời ngắn gọn rằng bạn chỉ hỗ trợ công việc trong HoaDonNhe.
```

------------------------------------------------------------------------

## 7. Tool Registry

Tạo một registry trung tâm.

Ví dụ:

``` js
const agentTools = {
  "app.get_state": getAppState,
  "mst.get_selected": getSelectedMst,

  "invoice.search": searchInvoices,
  "invoice.read": readInvoice,
  "invoice.get_items": getInvoiceItems,
  "invoice.download": downloadInvoices,
  "invoice.find_duplicates": findDuplicateInvoices,
  "invoice.summary": summarizeInvoices,

  "data.query": queryAppData,
  "data.analyze": analyzeData,

  "file.export_excel": exportExcel,
  "file.export_csv": exportCsv,
  "file.export_report": exportReport,

  "js.execute_safe": executeSafeJs
};
```

Không để model gọi function nội bộ bằng tên tùy ý.

Mọi action phải đi qua:

``` text
AI
 ↓
Tool Router
 ↓
validate tool
 ↓
validate arguments
 ↓
permission check
 ↓
execute
 ↓
normalize result
 ↓
return to AI
```

------------------------------------------------------------------------

## 8. Tool Schema

Mỗi tool phải có:

``` js
{
  name,
  description,
  inputSchema,
  permission,
  handler
}
```

Ví dụ:

``` js
{
  name: "invoice.search",

  description:
    "Tìm hóa đơn trong dữ liệu HoaDonNhe theo MST, ngày, loại hóa đơn, tên hoặc điều kiện.",

  inputSchema: {
    type: "object",
    properties: {
      fromDate: { type: "string" },
      toDate: { type: "string" },
      type: { type: "string" },
      keyword: { type: "string" }
    }
  },

  permission: "read",

  handler: searchInvoices
}
```

------------------------------------------------------------------------

## 9. Agent Loop

Agent không dừng sau một tool call.

Pseudo flow:

``` js
async function runAgent(userMessage) {
  let messages = buildInitialMessages(userMessage);

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const response = await callAI(messages);

    if (response.type === "final") {
      return response.message;
    }

    if (response.type === "tool_call") {
      const result = await toolRouter.execute(
        response.tool,
        response.arguments
      );

      messages.push({
        role: "tool",
        tool_call_id: response.id,
        content: JSON.stringify(result)
      });

      continue;
    }
  }

  return "Tác vụ vượt quá số bước xử lý cho phép.";
}
```

Đặt giới hạn ban đầu:

``` js
MAX_AGENT_STEPS = 10;
```

Có timeout cho từng tool và toàn bộ task.

------------------------------------------------------------------------

## 10. Tự kiểm tra và tự xử lý lỗi

Tool phải trả về kết quả chuẩn:

``` js
{
  ok: true,
  data: {},
  meta: {}
}
```

hoặc:

``` js
{
  ok: false,
  error: {
    code: "SESSION_EXPIRED",
    message: "Phiên đăng nhập đã hết hạn"
  }
}
```

Agent có thể xử lý:

``` text
invoice.search
 ↓
SESSION_EXPIRED
 ↓
account.refresh
 ↓
invoice.search
 ↓
SUCCESS
```

Các lỗi có thể cho Agent tự phục hồi:

-   session hết hạn
-   chưa chọn MST
-   filter không hợp lệ
-   dữ liệu chưa load
-   cần refresh
-   không tìm thấy theo từ khóa đầu tiên
-   export thất bại tạm thời

Không cho Agent retry vô hạn.

Ví dụ:

``` js
MAX_TOOL_RETRIES = 2;
```

------------------------------------------------------------------------

## 11. Safe JS Runtime

Mục tiêu:

Cho Agent khả năng tự viết JavaScript để:

-   lọc dữ liệu
-   map dữ liệu
-   group dữ liệu
-   tính toán
-   thống kê
-   tìm bất thường
-   chuyển đổi cấu trúc dữ liệu
-   chuẩn bị dữ liệu xuất file

Ví dụ AI cần:

``` js
const largeInvoices = invoices
  .filter(x => Number(x.total) >= 100000000);

return {
  count: largeInvoices.length,
  rows: largeInvoices
};
```

KHÔNG chạy:

``` js
eval(aiCode);
```

trực tiếp trong process chính.

Runtime phải cô lập và chỉ expose:

``` js
{
  input,
  helpers: {
    number,
    normalizeText,
    groupBy,
    sum
  }
}
```

Không expose:

``` text
require
process
global
fs
child_process
net
http
https
worker_threads
module
Buffer nếu không cần
API key
cookie/session secret
```

Có:

-   timeout
-   giới hạn kích thước input/output
-   giới hạn số lần chạy
-   bắt exception
-   log execution

------------------------------------------------------------------------

## 12. "Chạy JS như người dùng"

Không hiểu theo nghĩa Agent có toàn quyền DevTools.

Thiết kế thành hai mức.

### Mức A --- App Action

Agent gọi các hành động ứng dụng:

``` text
click/search/select/download/refresh/export
```

thông qua tool có sẵn.

Ví dụ:

``` js
app.action({
  action: "select_mst",
  mst: "..."
});
```

### Mức B --- Data JS

Agent tự tạo JS để xử lý dữ liệu trong Safe JS Runtime.

Không cho Agent inject JS tùy ý vào Chromium/page trong phiên bản đầu.

Nếu sau này thực sự cần browser action động, tạo riêng:

``` text
browser.inspect
browser.click
browser.read
browser.fill
```

và whitelist target/action thay vì cấp `page.evaluate(aiGeneratedCode)`
không giới hạn.

------------------------------------------------------------------------

## 13. Đọc dữ liệu

Agent không đọc DB trực tiếp.

Tạo Data Access Layer:

``` text
Agent
 ↓
data.query
 ↓
DataService
 ↓
data.db / XML / JSON / app state
```

Ví dụ:

``` js
data.query({
  source: "invoices",
  filters: {
    month: "2026-09",
    type: "sold"
  }
});
```

Ưu điểm:

-   kiểm soát dữ liệu
-   dễ audit
-   đổi database không ảnh hưởng Agent
-   tránh AI tạo SQL nguy hiểm

------------------------------------------------------------------------

## 14. Dữ liệu lớn

Không gửi hàng chục nghìn hóa đơn trực tiếp vào model.

Luồng:

``` text
AI yêu cầu dữ liệu
 ↓
Tool lấy dữ liệu local
 ↓
JS/local analyzer xử lý
 ↓
trả summary + mẫu cần thiết
 ↓
AI đánh giá
```

Ví dụ thay vì gửi 20.000 rows:

``` json
{
  "count": 20000,
  "total": 18200000000,
  "duplicates": 37,
  "abnormal": 12,
  "samples": []
}
```

Nếu Agent cần chi tiết, nó gọi tool tiếp.

------------------------------------------------------------------------

## 15. Xuất file

Agent có thể yêu cầu:

``` text
file.export_excel
file.export_csv
file.export_report
```

Ví dụ:

``` js
{
  name: "file.export_excel",
  arguments: {
    filename: "hoa_don_trung_09_2026.xlsx",
    datasetId: "agent_result_123",
    highlight: "duplicates"
  }
}
```

Tool trả:

``` js
{
  ok: true,
  data: {
    filename: "hoa_don_trung_09_2026.xlsx",
    path: "...",
    size: 125820
  }
}
```

Agent phải verify `ok === true` trước khi nói với user rằng file đã được
tạo.

------------------------------------------------------------------------

## 16. Dataset Store

Không nhét toàn bộ dữ liệu qua API nhiều lần.

Khi tool tạo dataset:

``` js
{
  datasetId: "ds_abc123",
  rows: 1284,
  schema: [...]
}
```

Agent dùng `datasetId` cho bước tiếp:

``` text
invoice.search
→ ds_abc123

invoice.find_duplicates(ds_abc123)
→ ds_def456

file.export_excel(ds_def456)
```

Dữ liệu thật vẫn nằm local.

------------------------------------------------------------------------

## 17. Permission

Chia quyền:

``` text
READ
- xem state
- xem MST
- đọc hóa đơn
- tìm kiếm
- đọc dataset

ANALYZE
- lọc
- thống kê
- đối chiếu
- safe JS

WRITE_FILE
- Excel
- CSV
- báo cáo

ACTION
- tải hóa đơn
- refresh
- đổi MST
- thao tác app

DANGEROUS
- xóa
- ghi đè
- thay đổi dữ liệu gốc
```

Ban đầu:

``` text
READ        → auto
ANALYZE     → auto
WRITE_FILE  → auto
ACTION      → auto với action an toàn
DANGEROUS   → không cấp cho AI
```

------------------------------------------------------------------------

## 18. Audit Log

Ghi lại:

``` js
{
  time,
  sessionId,
  userMessage,
  model,
  tool,
  argumentsSummary,
  result,
  duration,
  error
}
```

Không log:

-   API key
-   password
-   cookie đầy đủ
-   token đăng nhập
-   dữ liệu bí mật không cần thiết

Mục đích:

-   debug Agent
-   biết AI đã gọi gì
-   phát hiện loop
-   đánh giá tool nào lỗi

------------------------------------------------------------------------

## 19. API Client

Tạo module riêng:

``` text
src/
  ai/
    config.js
    openrouter-client.js
    agent.js
    prompt.js
    tool-registry.js
    tool-router.js
    permissions.js
    safe-js.js
    dataset-store.js
    audit-log.js
```

`openrouter-client.js` chịu trách nhiệm duy nhất:

``` text
messages + tools
 ↓
OpenRouter
 ↓
normalize response
```

Không để UI gọi OpenRouter trực tiếp.

------------------------------------------------------------------------

## 20. API request

Request cơ bản:

``` js
{
  model: AI_CONFIG.model,
  messages,
  tools,
  tool_choice: "auto"
}
```

Authorization:

``` text
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Phải kiểm tra khả năng tool/function calling thực tế của model đang
dùng.

Nếu model/provider không trả native tool calls ổn định, Agent sử dụng
structured JSON protocol:

``` json
{
  "type": "tool_call",
  "tool": "invoice.search",
  "arguments": {}
}
```

Tool Router vẫn giữ nguyên.

Điều này giúp sau này đổi model mà không phải viết lại Agent.

------------------------------------------------------------------------

## 21. UI Chat

Message type:

``` text
user
assistant
tool-status
file
error
```

Ví dụ:

``` text
USER
Tìm hóa đơn trùng tháng 9 và xuất Excel.

AI
Đang kiểm tra dữ liệu tháng 9...

AI STATUS
Đã đọc 1.284 hóa đơn.

AI STATUS
Đang kiểm tra hóa đơn trùng...

FILE
hoa_don_trung_09_2026.xlsx

AI
Phát hiện 17 hóa đơn thuộc 8 nhóm có dấu hiệu trùng.
Tôi đã đánh dấu và xuất file.
```

Cho phép nút:

``` text
[Mở file]
[Mở thư mục]
[Xem dữ liệu]
```

------------------------------------------------------------------------

## 22. Không để Agent nói sai kết quả hành động

Quy tắc bắt buộc:

Agent chỉ được nói:

``` text
"Đã tải"
"Đã xuất"
"Đã xóa"
"Đã thay đổi"
```

khi tool trả `ok: true`.

Nếu tool chưa chạy:

``` text
"Tôi có thể thực hiện..."
```

Nếu lỗi:

``` text
"Không thể hoàn thành vì..."
```

Không được giả lập kết quả.

------------------------------------------------------------------------

## 23. Ví dụ end-to-end

User:

``` text
Kiểm tra hóa đơn bán ra tháng 9,
tìm hóa đơn trùng và xuất cho tôi Excel.
```

Agent:

``` text
1. mst.get_selected
2. invoice.search
   from=2026-09-01
   to=2026-09-30
   type=sold

3. invoice.find_duplicates
   datasetId=...

4. kiểm tra kết quả

5. file.export_excel
   datasetId=duplicateDataset

6. verify file

7. trả lời
```

Kết quả:

``` text
Đã kiểm tra 1.284 hóa đơn bán ra tháng 9.

Phát hiện:
- 17 hóa đơn nghi trùng
- 8 nhóm trùng

File Excel đã được tạo:
hoa_don_trung_09_2026.xlsx
```

------------------------------------------------------------------------

# 24. Các giai đoạn triển khai

## PHASE 0 --- Audit code hiện tại

Trước khi sửa code:

-   đọc cấu trúc project
-   tìm Chat hiện tại
-   tìm API chat/support hiện tại
-   tìm `src/server.js`
-   xác định data layer
-   xác định invoice functions
-   xác định export functions
-   xác định Chromium/browser layer
-   xác định account/MST state
-   tìm logic có thể tái sử dụng

Không viết lại chức năng đã tồn tại.

Kết quả Phase 0 phải tạo:

``` text
AI_INTEGRATION_MAP.md
```

ghi rõ:

``` text
Existing function → Agent tool tương ứng
```

------------------------------------------------------------------------

## PHASE 1 --- AI Chat tối thiểu

Làm:

-   nút/chế độ AI Agent
-   AI config
-   OpenRouter client
-   system prompt
-   gửi message
-   nhận response
-   render response

Chưa cấp quyền action.

PASS khi:

``` text
User → Chat → OpenRouter → model → response → Chat
```

------------------------------------------------------------------------

## PHASE 2 --- Tool Calling

Tạo:

-   Tool Registry
-   Tool Router
-   schema validation
-   permissions
-   Agent Loop

Tools đầu tiên:

``` text
app.get_state
mst.get_selected
invoice.search
invoice.read
```

PASS:

``` text
User hỏi dữ liệu
→ AI tự gọi tool
→ đọc kết quả
→ trả lời đúng
```

------------------------------------------------------------------------

## PHASE 3 --- Analysis

Thêm:

``` text
invoice.summary
invoice.find_duplicates
data.analyze
```

Thêm Dataset Store.

PASS:

``` text
User yêu cầu phân tích
→ Agent lấy data
→ xử lý local
→ AI đánh giá
→ trả lời
```

------------------------------------------------------------------------

## PHASE 4 --- Safe JS

Thêm:

``` text
js.execute_safe
```

Có:

-   isolation
-   timeout
-   input/output limit
-   no Node access
-   audit

PASS:

Agent tự tạo JS lọc/tính toán trên dataset nhưng không thể đọc
filesystem hoặc chạy process.

------------------------------------------------------------------------

## PHASE 5 --- Export

Thêm:

``` text
file.export_excel
file.export_csv
file.export_report
```

PASS:

``` text
User yêu cầu
→ Agent phân tích
→ Agent export
→ verify
→ Chat hiển thị file
```

------------------------------------------------------------------------

## PHASE 6 --- App Actions

Map logic hiện có:

``` text
account.refresh
mst.select
invoice.download
invoice.refresh
...
```

Không duplicate browser logic.

Agent chỉ gọi service hiện có.

PASS:

``` text
User yêu cầu hành động
→ Agent hiểu
→ Tool Router
→ existing JS
→ verify
→ trả lời
```

------------------------------------------------------------------------

## PHASE 7 --- Recovery Agent

Thêm khả năng xử lý lỗi:

``` text
session expired
→ refresh
→ retry

MST chưa chọn
→ kiểm tra danh sách
→ yêu cầu user chọn hoặc tự chọn nếu yêu cầu đã rõ

data stale
→ refresh
→ query lại
```

Có hard limit:

``` text
MAX_AGENT_STEPS
MAX_TOOL_RETRIES
TASK_TIMEOUT
```

------------------------------------------------------------------------

## PHASE 8 --- Security + Production

Sau khi test ổn:

1.  bỏ API key khỏi EXE
2.  rotate/revoke test key
3.  tạo Cloudflare AI Gateway/Worker
4.  EXE gọi Worker
5.  Worker giữ OpenRouter key
6.  rate limit theo license/device
7.  quota
8.  logging
9.  model routing nếu cần

Kiến trúc:

``` text
HoaDonNhe EXE
     ↓
HoaDonNhe AI Gateway
     ↓
OpenRouter
     ↓
AI Model
```

------------------------------------------------------------------------

# 25. Nguyên tắc triển khai cho coding agent

Coding agent khi thực hiện plan này phải tuân thủ:

1.  Audit code thật trước.
2.  Không đoán tên function.
3.  Không viết lại logic đã có.
4.  Ưu tiên wrapper existing function → Agent Tool.
5.  Không phá Chat/support hiện tại.
6.  Không phá login/Chromium/session hiện tại.
7.  Mỗi phase phải test trước khi sang phase sau.
8.  Không refactor ngoài phạm vi nếu không cần.
9.  Không đưa API key vào frontend/browser.
10. Không commit API key.
11. Không dùng `eval()` trực tiếp cho AI-generated JS.
12. Không cấp shell cho Agent.
13. Mọi action phải qua Tool Router.
14. Mọi tool phải trả result có cấu trúc.
15. Mọi action thực tế phải được verify trước khi Agent báo thành công.

------------------------------------------------------------------------

# 26. Definition of Done

Tính năng hoàn thành khi người dùng có thể vào Chat → chọn AI Agent và
nói tự nhiên:

``` text
"Kiểm tra hóa đơn bán ra tháng này,
tìm những hóa đơn bất thường,
giải thích cho tôi và xuất Excel."
```

Hệ thống tự:

``` text
Hiểu yêu cầu
→ lấy context
→ đọc dữ liệu
→ gọi logic hiện có
→ xử lý JS local khi cần
→ phân tích
→ tự kiểm tra
→ xuất file
→ verify
→ trả lời user
```

mà user không cần biết:

``` text
API
function
JS
database
XML
tool name
```

Agent chỉ hoạt động trong phạm vi HoaDonNhe và không có quyền tùy ý trên
hệ điều hành.
