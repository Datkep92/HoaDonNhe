

> Đây là tài liệu kiến trúc bắt buộc của dự án.
> AI/dev phải đọc file này trước khi sửa hoặc thêm code.
> File này định nghĩa **kiến trúc, ranh giới module và invariant**.
> Không tự ý thay đổi kiến trúc nếu chưa được yêu cầu.

---

# 1. CORE PRINCIPLES

```text
XML = SOURCE OF TRUTH
SQLite = INDEX / QUERY LAYER
Manual Download = EXISTING PROTECTED FLOW
Auto Sync = SEPARATE BACKGROUND MODULE
BUY/SELL = DERIVED FROM XML
Invoice Key = DERIVED FROM XML, NEVER FILENAME
UI LIST = SQLITE
PREVIEW = LAZY XML READ
ONE MST = ONE SQLITE DATABASE
```

Các nguyên tắc trên là bắt buộc.

---

# 2. TECHNOLOGY

Ứng dụng hiện tại:

```text
Windows x64
Node.js
V8
pkg
HTML UI
Chrome/Edge runtime
```

Không tự ý chuyển sang:

```text
Electron
.NET
Java
React/Vue/etc.
```

nếu không được yêu cầu.

Ưu tiên tái sử dụng code hiện tại.

---

# 3. HIGH-LEVEL ARCHITECTURE

```text
                    TCT API
                       │
              ┌────────┴────────┐
              │                 │
       Manual Download      Auto Sync
              │                 │
              └────────┬────────┘
                       │
                       ▼
                  XML Download
                       │
                       ▼
                XML Data Engine
                       │
             ┌─────────┼─────────┐
             │         │         │
           Parse    BUY/SELL  Invoice Key
             │         │         │
             └─────────┼─────────┘
                       │
                       ▼
                Duplicate Check
                       │
                ┌──────┴──────┐
                │             │
                ▼             ▼
           XML Storage      SQLite
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
                  List     Search    Reports
                    │
                    ▼
                    UI
```

---

# 4. DATA OWNERSHIP

## XML

XML là dữ liệu gốc.

XML có thể đến từ:

```text
Manual Download
Auto Sync
Backfill
Import XML
```

Nếu SQLite mất hoặc lỗi:

```text
XML → Parse → Rebuild SQLite
```

phải có thể thực hiện.

Không lưu nguyên XML vào SQLite nếu không cần.

---

## SQLite

SQLite chỉ là:

```text
index
query layer
metadata
invoice items
duplicate detection
sync state
```

SQLite không thay thế XML.

---

# 5. MULTI-MST

Mỗi MST hoàn toàn độc lập.

Cấu trúc:

```text
HoaDonData/
└── <MST>/
    ├── BanRa/
    ├── MuaVao/
    ├── data.db
    └── sync.json
```

Quy tắc:

```text
1 MST = 1 data.db
1 MST = 1 vùng XML
1 MST = 1 sync state
```

Không để dữ liệu MST này lẫn MST khác.

Không hard-code một MST.

---

# 6. XML STORAGE

```text
SELL → BanRa/
BUY  → MuaVao/
```

SQLite lưu đường dẫn XML thực tế qua `file_xml`.

Không để SQLite trỏ tới file không tồn tại.

XML có thể được đổi tên mà không làm thay đổi Invoice Key.

---

# 7. INVOICE IDENTITY

**Filename không phải identity.**

Không dùng:

```text
filename
SHDon alone
file path
```

làm Invoice Key.

Invoice Key phải:

```text
stable
deterministic
derived from XML
filename-independent
```

Định dạng dự kiến:

```text
MST người bán
+
KHMSHDon
+
KHHDon
+
SHDon
```

Có thể bổ sung field khác nếu XML thực tế yêu cầu.

Không khóa format cuối cùng bằng suy đoán.

---

# 8. BUY / SELL

Phân loại dựa trên XML và MST hiện tại.

```text
NBan/MST == currentMST
→ SELL

NMua/MST == currentMST
→ BUY
```

Nếu không xác định được:

```text
UNKNOWN / ERROR
```

Không tự đoán.

Nếu XML bất thường hoặc có trường hợp xung đột:

```text
log
→ error/unknown
→ không tự ép BUY/SELL
```

---

# 9. XML DATA ENGINE

XML Data Engine là lớp xử lý XML dùng chung.

Pipeline:

```text
XML
 ↓
Read
 ↓
Parse
 ↓
Validate
 ↓
Extract
 ↓
BUY/SELL
 ↓
Invoice Key
 ↓
Duplicate Check
 ↓
SQLite Transaction
```

Các nguồn XML phải ưu tiên đi qua cùng Data Engine:

```text
Manual Download
Auto Sync
Backfill
Import
Rebuild
```

Không tạo nhiều XML parser khác nhau cho từng module nếu có thể dùng chung.

---

# 10. SQLITE CORE

Mỗi MST có:

```text
data.db
```

Core tables:

```text
invoices
invoice_items
imported_files
sync_state
```

Database access nên đi qua một lớp repository/data-access dùng chung.

Không để UI tự viết SQL rải rác khắp codebase nếu có thể tránh.

---

# 11. DUPLICATE PROTECTION

Invoice Key là identity chính.

Thứ tự ưu tiên:

```text
SQLite lookup
      ↓
XML fallback nếu cần
      ↓
download
      ↓
final Invoice Key check
      ↓
insert
```

Nếu XML đã tồn tại nhưng SQLite chưa có:

```text
IMPORT XML
```

không download lại nếu có thể xác định đúng Invoice Key.

Duplicate không được tạo record thứ hai.

---

# 12. MANUAL DOWNLOAD

Manual Download là **protected existing flow**.

Phải giữ behavior hiện tại.

Không tự ý rewrite:

```text
UI
Search
API
Session
Authentication
Downloader
File naming
Pagination
Duplicate behavior
```

Chỉ thay đổi khi task yêu cầu hoặc bắt buộc để tích hợp kiến trúc.

Nếu cần dùng chung code:

```text
Extract reusable service
```

thay vì viết lại Manual Download.

---

# 13. AUTO SYNC

Auto Sync là module riêng.

Không được trộn business logic Auto Sync vào Manual UI.

Mặc định:

```text
BUY
 ↓
complete
 ↓
SELL
```

Không chạy song song API/session nếu chưa xác nhận an toàn.

Pipeline:

```text
Query API
 ↓
Invoice Key
 ↓
SQLite check
 ↓
XML check
 ↓
Download missing
 ↓
XML Data Engine
 ↓
SQLite
```

Auto Sync phải:

```text
background
non-blocking UI
retry hữu hạn
error isolation
progress/state
```

---

# 14. BACKFILL

Backfill dùng cùng pipeline với Auto Sync.

Hỗ trợ:

```text
date range
year
quarter
month
custom range
```

Không tạo downloader riêng chỉ cho Backfill.

Pipeline:

```text
API
 ↓
Invoice Key
 ↓
SQLite
 ↓
XML fallback
 ↓
Download
 ↓
XML Data Engine
 ↓
SQLite
```

---

# 15. UI ARCHITECTURE

Danh sách hóa đơn:

```text
UI
 ↓
SQLite
 ↓
Pagination
```

Không:

```text
UI
 ↓
scan XML
 ↓
parse hàng nghìn XML
 ↓
render
```

Không parse toàn bộ XML khi:

```text
open UI
switch tab
search
filter
change page
```

Không load toàn bộ invoice vào:

```text
RAM
DOM
JavaScript state
```

---

# 16. PREVIEW

Preview là lazy-load.

```text
User click invoice
        ↓
SQLite
        ↓
file_xml
        ↓
Read ONE XML
        ↓
Parse
        ↓
Render
```

Không preload toàn bộ XML.

---

# 17. PRODUCT DATA

`invoice_items` chứa dữ liệu hàng hóa từ hóa đơn.

Không biến thành hệ thống quản lý kho.

Không tự thêm:

```text
inventory
stock in/out
unit conversion
warehouse logic
```

Aggregation ưu tiên SQL.

Không tự gộp hàng hóa nếu chưa có business rule rõ ràng.

---

# 18. IMPORT / REBUILD

Import:

```text
XML
 ↓
Parse
 ↓
Validate
 ↓
Invoice Key
 ↓
BUY/SELL
 ↓
Duplicate Check
 ↓
SQLite Transaction
```

Rebuild:

```text
XML folders
 ↓
Scanner
 ↓
XML Data Engine
 ↓
SQLite
```

Nếu `data.db` mất nhưng XML còn nguyên, database phải có khả năng rebuild.

---

# 19. ERROR BOUNDARY

Một invoice lỗi không được làm crash toàn bộ batch nếu có thể tiếp tục.

Phân loại lỗi tối thiểu:

```text
API_ERROR
AUTH_ERROR
NETWORK_ERROR
DOWNLOAD_ERROR
XML_PARSE_ERROR
INVALID_INVOICE
UNKNOWN_DIRECTION
DUPLICATE
DATABASE_ERROR
FILE_ERROR
```

Retry phải hữu hạn.

Không retry vô hạn.

Không log:

```text
password
token
cookie
session secret
```

---

# 20. FILE / DATABASE SAFETY

Download:

```text
file.tmp
 ↓
complete
 ↓
rename
 ↓
file.xml
```

Import invoice dùng transaction:

```text
BEGIN
 ↓
invoices
 ↓
invoice_items
 ↓
imported_files
 ↓
COMMIT
```

Lỗi:

```text
ROLLBACK
```

---

# 21. PERFORMANCE ARCHITECTURE

Ưu tiên:

```text
SQLite query
    >
filesystem access
    >
XML parsing
```

Không parse XML nếu SQLite đã có đủ dữ liệu cho operation.

Không giữ dataset lớn trong RAM nếu không cần.

Không render dataset lớn vào DOM.

Mọi tối ưu phải:

```text
Measure
→ Change
→ Measure
```

Không tối ưu mù.

---

# 22. MODULE BOUNDARIES

Kiến trúc logic:

```text
src/
├── app/
├── api/
├── auth/
├── downloader/
├── manual/
├── autosync/
├── backfill/
├── data/
│   ├── mst/
│   ├── sqlite/
│   ├── xml/
│   ├── parser/
│   └── importer/
├── ui/
├── utils/
└── logging/
```

Đây là ranh giới logic, **không bắt buộc phải di chuyển source hiện tại**.

Không move hàng loạt file chỉ để làm đẹp.

---

# 23. SHARED SERVICES

Có thể dùng chung:

```text
API Client
Session Manager
Downloader
XML Data Engine
Invoice Key Builder
Duplicate Detector
SQLite Repository
Logger
```

Manual UI và Auto Sync vẫn là hai consumer/module riêng.

Không duplicate cùng một business logic nếu có thể dùng shared service.

---

# 24. ARCHITECTURE CHANGE RULE

Nếu source hiện tại khác architecture:

```text
KHÔNG TỰ Ý REWRITE.
```

Phải xác định:

```text
Current source
Architecture rule
Conflict
Impact
Required change
```

Chỉ thay đổi kiến trúc khi task yêu cầu hoặc được phê duyệt.

Nếu chưa chắc:

```text
READ SOURCE FIRST
```

Không đoán.

---

# 25. AI DEVELOPMENT RULES

Trước khi sửa:

```text
1. Read PROJECT_ARCHITECTURE.md
2. Inspect relevant source
3. Identify existing implementation
4. Reuse existing code where possible
5. Identify architecture conflicts
6. Change only the requested scope
```

AI không được tự ý:

```text
rewrite project
rewrite Manual Download
change framework
invent API
invent XML schema
invent business rules
move files unnecessarily
remove existing behavior
```

Nếu task chỉ yêu cầu nghiên cứu:

```text
DO NOT MODIFY CODE.
DO NOT RUN LARGE REAL-DATA TESTS.
```

Nếu task yêu cầu sửa:

```text
Make the smallest architectural change necessary.
```

---

# 26. PHASE PRINCIPLE

Dự án phát triển theo:

```text
PHASE 0
Source Analysis
      ↓
PHASE 1
Data Core
      ↓
PHASE 2
XML Data Engine
      ↓
PHASE 3
Data UI
      ↓
PHASE 4
Auto Sync
      ↓
PHASE 5
Backfill
      ↓
PHASE 6
Optimization
```

Không tự động chuyển sang Phase tiếp theo.

Chi tiết implementation/test không nằm trong architecture file này.

---

# 27. SOURCE OF TRUTH HIERARCHY

Khi có xung đột, ưu tiên:

```text
1. Existing working behavior
2. Real source code / real API behavior
3. This architecture
4. AI assumption
```

**AI assumption luôn thấp nhất.**

Không được dùng suy đoán để thay thế source thực tế.

---

# 28. NON-NEGOTIABLE INVARIANTS

Các điều sau tuyệt đối không phá:

```text
XML là source of truth.

SQLite không thay thế XML.

1 MST = 1 SQLite DB.

Filename không phải Invoice Key.

SHDon không phải Invoice Key duy nhất.

BUY/SELL phải xác định từ XML.

Không đoán dữ liệu thiếu.

Manual Download phải được bảo toàn.

Auto Sync không được khóa UI.

UI list phải dùng SQLite.

Preview chỉ đọc XML khi cần.

Không parse toàn bộ XML để mở UI.

Không load toàn bộ dataset vào DOM/RAM.

Duplicate phải được chặn bằng Invoice Key.

DB phải có khả năng rebuild từ XML.

Không bịa API/XML/business rule.

Không rewrite toàn bộ project nếu không cần.
```

---

