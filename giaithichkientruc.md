
>
> Đây là tài liệu kiến trúc chính của toàn bộ dự án.
> Mọi AI/dev phải đọc file này trước khi sửa hoặc thêm code.
> Không được tự ý thay đổi kiến trúc hoặc phá luồng Manual Download hiện tại.

---

# 1. MỤC TIÊU DỰ ÁN

Dự án là ứng dụng Windows x64 dạng EXE:

`HoaDonNhe-v13.exe`

Mục tiêu:

- Tra cứu và tải hóa đơn điện tử từ hệ thống TCT.
- Giữ nguyên luồng tải thủ công đang hoạt động.
- Bổ sung hệ thống quản lý dữ liệu hóa đơn.
- Lưu XML gốc lâu dài.
- Dùng SQLite làm lớp index/query nhanh.
- Hỗ trợ nhiều MST.
- Tự động phân loại hóa đơn Mua vào / Bán ra dựa trên nội dung XML.
- Có Auto Sync chạy nền.
- Có Backfill dữ liệu lịch sử.
- UI nhanh, nhẹ.
- Không đọc hàng nghìn XML mỗi lần mở màn hình.
- Không phụ thuộc tên file để xác định hóa đơn.
- Chống tải trùng và chống import trùng.
- Có khả năng rebuild SQLite từ XML.
- Có kiến trúc đủ ổn định để mở rộng về sau.

---

# 2. NGUYÊN TẮC KIẾN TRÚC BẮT BUỘC

## 2.1 XML là SOURCE OF TRUTH

XML là dữ liệu gốc và có giá trị cao nhất trong hệ thống.

XML có thể đến từ:

- Manual Download
- Auto Sync
- Import/copy XML

SQLite không thay thế XML.

Nếu SQLite bị mất hoặc lỗi, hệ thống phải có khả năng đọc lại XML và rebuild database.

---

## 2.2 SQLite là INDEX / QUERY LAYER

SQLite dùng để:

- tìm kiếm nhanh;
- lọc dữ liệu;
- phân trang;
- thống kê;
- tổng hợp hàng hóa;
- kiểm tra hóa đơn đã tồn tại;
- lưu trạng thái import;
- lưu trạng thái Auto Sync.

Không được coi SQLite là bản sao duy nhất của XML.

---

## 2.3 KHÔNG DÙNG FILENAME LÀM ĐỊNH DANH HÓA ĐƠN

Không được dùng:

```text
filename
```

làm Invoice Key.

Tên file có thể:

- bị đổi;
- bị trùng;
- khác format;
- do người dùng tự đặt;
- không phản ánh đúng Invoice Key.

Invoice Key phải được tạo từ dữ liệu bên trong XML.

---

## 2.4 KHÔNG PHÁ MANUAL DOWNLOAD

Luồng Manual Download hiện tại đang hoạt động phải được bảo toàn.

Không được tự ý:

- viết lại downloader;
- thay đổi API;
- thay đổi session;
- thay đổi UI;
- xóa duplicate check;
- thay đổi cách đặt tên file;
- thay đổi behavior người dùng.

Chỉ được thay đổi khi thực sự cần thiết cho kiến trúc mới.

Nếu cần dùng chung code giữa Manual Download và Auto Sync thì ưu tiên tách reusable service.

---

## 2.5 KHÔNG PARSE TOÀN BỘ XML KHI MỞ UI

Không được:

```text
Mở màn hình
→ đọc toàn bộ XML
→ parse toàn bộ
→ tạo toàn bộ object
→ render toàn bộ
```

Thay vào đó:

```text
UI
→ SQLite
→ pagination
```

Chỉ đọc XML khi cần.

---

## 2.6 PREVIEW LÀ LAZY LOAD

Khi người dùng click một hóa đơn:

```text
SQLite
→ lấy file_xml
→ đọc đúng XML đó
→ parse
→ render preview
```

Không parse trước toàn bộ hóa đơn.

---

## 2.7 KHÔNG TỰ ĐOÁN DỮ LIỆU

Nếu XML không đủ thông tin để xác định:

- BUY/SELL;
- Invoice Key;
- MST;

thì:

```text
Không được tự đoán.
```

Phải:

- đánh dấu lỗi/unknown;
- ghi log;
- xử lý theo error flow.

---

# 3. KIẾN TRÚC TỔNG THỂ

```text
┌──────────────────────────────────────────┐
│                  UI                      │
├──────────────────────────────────────────┤
│        Application / Business Layer      │
├──────────────────────────────────────────┤
│ XML Engine │ SQLite │ Sync │ Backfill    │
├──────────────────────────────────────────┤
│ API │ Session │ Downloader │ Manual       │
├──────────────────────────────────────────┤
│ Filesystem │ SQLite DB                   │
├──────────────────────────────────────────┤
│                XML GỐC                   │
└──────────────────────────────────────────┘
```

Luồng tổng quát:

```text
TCT API
   │
   ├────────────── Manual Download
   │
   └────────────── Auto Sync
                         │
                         ▼
                    Download XML
                         │
                         ▼
                  XML Data Engine
                         │
             ┌───────────┼───────────┐
             │           │           │
           Parse      BUY/SELL   Invoice Key
             │           │           │
             └───────────┼───────────┘
                         │
                         ▼
                  Duplicate Check
                         │
                 ┌───────┴───────┐
                 │               │
              XML File         SQLite
                 │               │
                 └───────┬───────┘
                         │
                         ▼
                         UI
```

---

# 4. CẤU TRÚC DỮ LIỆU THEO MST

Mỗi MST có một vùng dữ liệu riêng.

Ví dụ:

```text
HoaDonData/
└── 4500673875/
    ├── BanRa/
    │   ├── invoice1.xml
    │   ├── invoice2.xml
    │   └── ...
    │
    ├── MuaVao/
    │   ├── invoice3.xml
    │   ├── invoice4.xml
    │   └── ...
    │
    ├── data.db
    └── sync.json
```

Quy tắc:

- Một MST = một SQLite database.
- Không tạo DB riêng cho BanRa và MuaVao.
- XML vật lý vẫn chia thành hai folder.
- `data.db` quản lý cả BUY và SELL.
- `sync.json` chỉ chứa trạng thái Auto Sync.

---

# 5. MULTI-MST

Hệ thống phải hỗ trợ nhiều MST.

Ví dụ:

```text
HoaDonData/
├── 4500673875/
│   ├── BanRa/
│   ├── MuaVao/
│   ├── data.db
│   └── sync.json
│
├── 0100109106/
│   ├── BanRa/
│   ├── MuaVao/
│   ├── data.db
│   └── sync.json
│
└── 0312345678/
    ├── BanRa/
    ├── MuaVao/
    ├── data.db
    └── sync.json
```

Mỗi MST độc lập về:

- XML;
- database;
- sync state;
- lịch sử;
- cấu hình.

Không được để dữ liệu của MST này lẫn với MST khác.

---

# 6. MST MANAGER

Cần có module:

```text
MST Manager
```

Nhiệm vụ:

- thêm MST;
- chọn MST;
- validate MST;
- tạo folder;
- tạo database;
- tạo sync.json;
- mở database;
- đóng database;
- xác định MST hiện tại.

Ví dụ:

```text
User chọn MST
      ↓
4500673875
      ↓
HoaDonData/4500673875/
```

Không hard-code một MST duy nhất.

---

# 7. SQLITE DATABASE

Mỗi MST có:

```text
data.db
```

Database tối thiểu gồm:

```text
invoices
invoice_items
imported_files
sync_state
```

Có thể thêm bảng khác nếu cần nhưng không được phá nguyên tắc kiến trúc.

---

# 8. BẢNG invoices

Mục đích:

Lưu metadata cần thiết cho UI và duplicate detection.

Schema đề xuất:

```sql
CREATE TABLE invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    invoice_key TEXT NOT NULL UNIQUE,

    direction TEXT NOT NULL,

    mst_ban TEXT,
    mst_mua TEXT,

    ten_ban TEXT,
    ten_mua TEXT,

    ngay_lap TEXT,

    khms_hd TEXT,
    khh_hd TEXT,
    so_hd TEXT,

    loai_hoa_don TEXT,

    tien_truoc_thue REAL DEFAULT 0,
    tien_thue REAL DEFAULT 0,
    tong_tien REAL DEFAULT 0,

    file_xml TEXT NOT NULL,

    created_at TEXT,
    updated_at TEXT
);
```

`direction`:

```text
SELL = Bán ra
BUY  = Mua vào
```

UI hiển thị tiếng Việt.

---

# 9. BẢNG invoice_items

Lưu các dòng hàng hóa của hóa đơn.

```sql
CREATE TABLE invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    invoice_id INTEGER NOT NULL,

    stt INTEGER,

    ma_hang TEXT,
    ten_hang TEXT,
    don_vi TEXT,

    so_luong REAL,
    don_gia REAL,

    chiet_khau REAL,
    thanh_tien REAL,

    thue_suat TEXT,
    tien_thue REAL,

    FOREIGN KEY(invoice_id)
        REFERENCES invoices(id)
        ON DELETE CASCADE
);
```

Không biến bảng này thành hệ thống quản lý kho.

---

# 10. BẢNG imported_files

Theo dõi XML đã được xử lý.

```sql
CREATE TABLE imported_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    file_path TEXT NOT NULL,
    file_name TEXT,

    file_size INTEGER,
    modified_time TEXT,

    file_hash TEXT,

    invoice_key TEXT,

    import_time TEXT,

    status TEXT,

    error_message TEXT
);
```

Mục đích:

- biết file nào đã import;
- phát hiện XML được copy vào;
- phát hiện XML lỗi;
- hỗ trợ rebuild;
- hỗ trợ debug.

Hash có thể dùng nếu cần.

---

# 11. BẢNG sync_state

Lưu trạng thái đồng bộ.

Có thể chứa:

```text
last_buy_sync
last_sell_sync
last_success_buy
last_success_sell
last_error
status
```

Không lưu dữ liệu hóa đơn chính ở đây.

---

# 12. SQLITE INDEX

Tối thiểu:

```sql
CREATE UNIQUE INDEX idx_invoice_key
ON invoices(invoice_key);

CREATE INDEX idx_invoice_date
ON invoices(ngay_lap);

CREATE INDEX idx_invoice_direction
ON invoices(direction);

CREATE INDEX idx_invoice_sell_mst
ON invoices(mst_ban);

CREATE INDEX idx_invoice_buy_mst
ON invoices(mst_mua);

CREATE INDEX idx_invoice_number
ON invoices(so_hd);

CREATE INDEX idx_item_code
ON invoice_items(ma_hang);

CREATE INDEX idx_item_invoice
ON invoice_items(invoice_id);
```

Có thể bổ sung composite index sau khi kiểm tra query thực tế.

Không tạo quá nhiều index nếu không cần.

---

# 13. INVOICE KEY

Invoice Key là định danh logic của hóa đơn.

Không dùng:

```text
filename
```

Không dùng riêng:

```text
SHDon
```

Invoice Key dự kiến:

```text
MST người bán
+
KHMSHDon
+
KHHDon
+
SHDon
```

Có thể bổ sung `NLap` nếu dữ liệu thực tế yêu cầu.

Ví dụ:

```text
4500610804|1|C25TTD|2714
```

Format cuối cùng phải được kiểm tra bằng XML thực tế trước khi khóa implementation.

Invoice Key phải:

- ổn định;
- deterministic;
- không phụ thuộc filename;
- giống nhau dù file được đổi tên.

---

# 14. PHÂN LOẠI BUY / SELL

Dựa trên MST hiện tại.

Nếu:

```text
NBan/MST == currentMST
```

thì:

```text
SELL / Bán ra
```

Nếu:

```text
NMua/MST == currentMST
```

thì:

```text
BUY / Mua vào
```

Nếu không xác định được:

```text
UNKNOWN / ERROR
```

Không tự đoán.

Nếu XML bất thường hoặc cả hai cùng trùng MST:

- log;
- đánh dấu lỗi;
- không tự đưa vào BUY/SELL nếu chưa có quy tắc rõ ràng.

---

# 15. XML DATA ENGINE

XML Data Engine là thành phần trung tâm.

Mọi XML đi vào hệ thống nên đi qua Data Engine.

Nguồn XML:

```text
Manual Download
Auto Sync
Import XML
```

Luồng:

```text
XML
 ↓
Read
 ↓
Parse
 ↓
Validate
 ↓
Extract data
 ↓
Detect BUY/SELL
 ↓
Create Invoice Key
 ↓
Check duplicate
 ↓
Insert invoices
 ↓
Insert invoice_items
 ↓
Record imported_files
```

---

# 16. XML PARSER

XML Parser tối thiểu phải đọc:

## TTChung

```text
PBan
THDon
KHMSHDon
KHHDon
SHDon
NLap
DVTTe
TGia
HTTToan
```

## Người bán

```text
NBan/Ten
NBan/MST
```

## Người mua

```text
NMua/Ten
NMua/MST
```

## Hàng hóa

```text
DSHHDVu/HHDVu

TChat
STT
MHHDVu
THHDVu
DVTinh
SLuong
DGia
STCKhau
ThTien
TSuat
TThue
```

## Thanh toán

```text
TToan/TgTCThue
TToan/TgTThue
TToan/TgTTTBSo
```

Các field khác có thể bổ sung sau.

Không cần lưu toàn bộ chữ ký điện tử vào SQLite.

XML gốc vẫn giữ nguyên.

---

# 17. XML STORAGE

Sau khi xác định direction:

```text
SELL → BanRa/
BUY  → MuaVao/
```

Ví dụ:

```text
4500673875/
├── BanRa/
│   └── ...
└── MuaVao/
    └── ...
```

Nếu XML nằm sai folder:

- Data Engine phải phát hiện;
- có thể di chuyển về đúng folder;
- phải cập nhật `file_xml`.

Không được để SQLite trỏ tới file không tồn tại.

---

# 18. IMPORT XML

XML có thể xuất hiện từ:

```text
Manual Download
Auto Sync
User copy XML
```

Data Engine phải có khả năng scan/import.

Nếu XML đã tồn tại trong SQLite:

```text
SKIP
```

Nếu XML có trong folder nhưng SQLite chưa có:

```text
IMPORT XML → SQLite
```

Điều này giúp SQLite có thể phục hồi từ XML.

---

# 19. CHỐNG TRÙNG

Phải có nhiều lớp.

## Lớp 1 - SQLite

```text
API invoice
 ↓
Invoice Key
 ↓
SQLite lookup
```

Nếu có:

```text
SKIP
```

---

## Lớp 2 - XML Storage

Nếu SQLite không có:

- kiểm tra XML tương ứng;
- không dựa vào filename;
- có thể scan/index XML hoặc parse metadata khi cần.

Nếu XML đã có:

```text
IMPORT → SQLite
SKIP DOWNLOAD
```

---

## Lớp 3 - Trước từng download

Ngay trước khi download:

```text
Check SQLite
Check XML
```

Sau đó mới download.

Mục tiêu chống race condition.

---

## Lớp 4 - Sau download

Data Engine kiểm tra Invoice Key lần cuối.

Nếu trùng:

```text
Không INSERT record thứ hai.
```

---

# 20. VÍ DỤ 1000 HÓA ĐƠN

API trả:

```text
1000 invoice
```

SQLite đã có:

```text
999 invoice
```

Kết quả bắt buộc:

```text
1000 API results
        ↓
SQLite lookup
        ↓
999 → SKIP
1   → DOWNLOAD
```

Không được đọc 1000 XML trước khi quyết định.

---

# 21. MANUAL DOWNLOAD

Manual Download là luồng hiện tại.

Phải giữ:

- UI;
- search;
- API;
- session;
- download;
- file naming;
- duplicate logic;
- behavior hiện tại.

Nếu cần tích hợp:

```text
Manual Download
      ↓
Download XML
      ↓
XML Data Engine
```

Không được viết lại toàn bộ downloader chỉ để phục vụ Data Engine.

---

# 22. MANUAL DOWNLOAD + DATABASE

Sau khi Manual Download tải thành công:

```text
XML
 ↓
Data Engine
 ↓
Parse
 ↓
Invoice Key
 ↓
SQLite
```

Có thể tích hợp trực tiếp hoặc để scanner/background import.

Kiến trúc cuối cùng phải đảm bảo XML mới cuối cùng được index vào SQLite.

---

# 23. AUTO SYNC

Auto Sync là module độc lập với Manual Download.

Có hai luồng:

```text
Auto Sync
├── Mua vào
└── Bán ra
```

Mặc định:

```text
Mua vào
   ↓ complete
Bán ra
   ↓ complete
```

Không chạy song song nếu chưa xác nhận API/session thread-safe.

---

# 24. AUTO SYNC MUA VÀO

```text
Auto Sync BUY
 ↓
API query Mua vào
 ↓
Danh sách invoice
 ↓
Invoice Key
 ↓
SQLite lookup
 ↓
Đã có?
 ├── YES → SKIP
 └── NO
       ↓
   XML fallback
       ↓
   Đã có XML?
    ├── YES → IMPORT SQLite
    └── NO
          ↓
       DOWNLOAD
          ↓
     XML Data Engine
          ↓
       SQLite
```

---

# 25. AUTO SYNC BÁN RA

```text
Auto Sync SELL
 ↓
API query Bán ra
 ↓
Invoice Key
 ↓
SQLite lookup
 ↓
Đã có?
 ├── YES → SKIP
 └── NO
       ↓
   XML fallback
       ↓
   DOWNLOAD
       ↓
   XML Data Engine
       ↓
   SQLite
```

---

# 26. AUTO SYNC CHẠY NỀN

Auto Sync không được khóa UI.

Ví dụ:

```text
UI
│
├── Search
├── Invoice Preview
├── Filter
└── Auto Sync Worker
```

Trong khi sync:

- user vẫn xem dữ liệu;
- user vẫn tìm kiếm;
- user vẫn mở preview;
- user có thể chuyển tab;
- app không reload.

Không F5.

Không reload toàn bộ app.

---

# 27. KHI MỞ MST

Luồng tối ưu:

```text
Open MST
 ↓
Open SQLite
 ↓
Query tổng quan
 ↓
Hiển thị UI ngay
 ↓
Background Auto Sync
 ↓
Có dữ liệu mới?
 ├── NO → giữ UI
 └── YES
       ↓
Refresh query hiện tại
```

Không:

```text
Open MST
 ↓
Parse toàn bộ XML
 ↓
Chờ
 ↓
Hiện UI
```

---

# 28. SYNC.JSON

Ví dụ:

```json
{
  "buy": {
    "lastSync": null,
    "lastSuccess": null,
    "status": "idle"
  },
  "sell": {
    "lastSync": null,
    "lastSuccess": null,
    "status": "idle"
  }
}
```

Có thể mở rộng:

```text
lastError
lastErrorTime
lastQueryFrom
lastQueryTo
totalFound
totalSkipped
totalDownloaded
```

`sync.json` chỉ là state/config.

Không dùng thay SQLite.

---

# 29. BACKFILL

Backfill dùng để tải dữ liệu lịch sử.

Hỗ trợ:

```text
Ngày bắt đầu
Ngày kết thúc
```

hoặc:

```text
Năm
Quý
Tháng
Khoảng ngày
```

Ví dụ:

```text
01/01/2025 → 31/12/2025
```

Pipeline vẫn dùng:

```text
API
 ↓
Invoice Key
 ↓
SQLite
 ↓
XML check
 ↓
Download missing
 ↓
Data Engine
 ↓
SQLite
```

Không tạo downloader riêng hoàn toàn khác.

---

# 30. ROUTINE SYNC

Sau khi Backfill:

```text
Auto Sync định kỳ
```

Có thể query khoảng thời gian gần hiện tại.

Ví dụ:

```text
7 ngày gần nhất
```

Khoảng thời gian phải configurable nếu có thể.

---

# 31. UI - NGUYÊN TẮC

UI phải:

- nhanh;
- nhẹ;
- ít DOM;
- ít RAM;
- không parse XML hàng loạt;
- không render hàng nghìn row.

Không:

```text
10000 invoice
→ 10000 DOM nodes
```

nếu pagination có thể xử lý.

---

# 32. DANH SÁCH HÓA ĐƠN

Nguồn:

```text
SQLite
```

Không phải:

```text
filesystem scan
```

Các cột cơ bản:

```text
Ký hiệu
Số hóa đơn
Ngày
Người bán
Người mua
Tổng tiền
```

Có thể thêm:

```text
MST
Thuế
Trạng thái
```

---

# 33. PAGINATION

Mặc định:

```text
50 hoặc 100 rows/page
```

Ví dụ:

```sql
SELECT ...
FROM invoices
WHERE ...
ORDER BY ngay_lap DESC
LIMIT 100 OFFSET 0;
```

Trang tiếp:

```text
OFFSET 100
```

Nếu dataset cực lớn có thể chuyển sang keyset pagination.

---

# 34. SEARCH / FILTER

Tìm kiếm từ SQLite.

Hỗ trợ:

- số hóa đơn;
- ký hiệu;
- MST;
- tên người bán;
- tên người mua;
- ngày;
- khoảng ngày;
- BUY/SELL.

Không scan XML cho mỗi lần tìm kiếm.

---

# 35. PREVIEW HÓA ĐƠN

Khi click:

```text
Invoice List
 ↓
SQLite lấy file_xml
 ↓
Read 1 XML
 ↓
Parse
 ↓
Render
```

Preview gồm:

```text
Mẫu số
Ký hiệu
Số hóa đơn
Ngày

Người bán
MST người bán

Người mua
MST người mua

Danh sách hàng hóa
- STT
- Mã hàng
- Tên hàng
- Đơn vị
- Số lượng
- Đơn giá
- Thành tiền
- Thuế suất
- Tiền thuế

Tổng trước thuế
Tiền thuế
Tổng thanh toán
Hình thức thanh toán
```

Giao diện nên gần với hóa đơn điện tử TCT.

Không cần pixel-perfect.

---

# 36. HÀNG HÓA

Hàng hóa là:

```text
Tổng hợp hàng hóa từ hóa đơn
```

Không phải:

```text
Quản lý kho
```

Không tự:

- nhập kho;
- xuất kho;
- tính tồn;
- quy đổi đơn vị.

---

# 37. TỔNG HỢP HÀNG HÓA

Ưu tiên SQL.

Ví dụ:

```sql
SELECT
    ma_hang,
    ten_hang,
    don_vi,
    SUM(so_luong) AS tong_so_luong,
    SUM(thanh_tien) AS tong_tien
FROM invoice_items
GROUP BY
    ma_hang,
    ten_hang,
    don_vi;
```

Không lấy toàn bộ invoice_items lên JavaScript rồi mới group nếu SQL xử lý được.

---

# 38. KHÔNG TỰ Ý GỘP HÀNG

Chỉ xem là cùng hàng khi khóa dữ liệu phù hợp.

Ví dụ:

```text
ma_hang
+
ten_hang
+
don_vi
```

Không tự suy luận:

```text
Thùng Tiger = Lon Tiger
```

Không tự quy đổi:

```text
Thùng → Chai
```

nếu chưa có module quy đổi.

---

# 39. KHÁCH HÀNG / NHÀ CUNG CẤP

Có thể lấy trực tiếp từ `invoices`.

Bán ra:

```text
Người mua = khách hàng
```

Mua vào:

```text
Người bán = nhà cung cấp
```

Có thể dùng SQL GROUP BY.

Không cần bảng riêng nếu chưa có nhu cầu.

---

# 40. LOG

Log tối thiểu:

```text
API request
API response error
Download
Duplicate skip
XML parse
Import
SQLite
Auto Sync
Backfill
```

Không log:

- password;
- token nhạy cảm;
- cookie/session secret;
- dữ liệu bí mật không cần thiết.

Log nên có:

```text
MST
Invoice Key
Time
Module
Status
Error
```

---

# 41. SESSION / API

API hiện tại phải được đọc từ source thực tế.

Trước khi thay đổi cần xác định:

- Login;
- Session;
- Cookie;
- Token;
- API Bán ra;
- API Mua vào;
- API download;
- payload;
- response.

Không được tự đoán endpoint.

Nếu chưa đọc source:

```text
KHÔNG BỊA API.
```

---

# 42. ERROR HANDLING

Các loại lỗi nên được phân loại:

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

Một XML lỗi không được làm crash toàn bộ sync.

Ví dụ:

```text
1000 invoice
999 thành công
1 lỗi
```

thì:

```text
999 vẫn được lưu.
1 ghi lỗi.
```

---

# 43. RETRY

Network/API error có thể retry.

Không retry vô hạn.

Ví dụ:

```text
Retry 1
Retry 2
Retry 3
→ Failed
```

Sau đó log và chuyển invoice khác nếu phù hợp.

Duplicate không phải lỗi retry.

---

# 44. ATOMIC DOWNLOAD

Khi download:

Không ghi trực tiếp file cuối nếu chưa hoàn thành.

Có thể:

```text
invoice.xml.tmp
```

Download xong:

```text
rename
→ invoice.xml
```

Mục tiêu tránh Data Engine đọc XML chưa hoàn tất.

---

# 45. DATABASE TRANSACTION

Import một invoice:

```text
BEGIN

INSERT invoices

INSERT invoice_items

INSERT imported_files

COMMIT
```

Nếu lỗi:

```text
ROLLBACK
```

Không để database ở trạng thái nửa chừng.

---

# 46. REBUILD DATABASE

Vì XML là source of truth nên phải có khả năng:

```text
XML folders
 ↓
Scanner
 ↓
Parser
 ↓
Invoice Key
 ↓
Rebuild SQLite
```

Nếu:

```text
data.db bị mất
```

nhưng:

```text
XML còn nguyên
```

thì hệ thống có thể khôi phục database.

---

# 47. SQLITE WAL

Có thể dùng:

```sql
PRAGMA journal_mode=WAL;
```

nếu phù hợp với SQLite runtime.

Mục tiêu:

- background sync ghi;
- UI đọc;
- giảm lock.

Phải test trên Windows thực tế trước khi coi là bắt buộc.

---

# 48. PERFORMANCE

Ưu tiên:

```text
SQLite query
>
filesystem scan
>
XML parse
```

Không đọc XML nếu SQLite đã có đủ thông tin.

Ví dụ không cần parse XML chỉ để lấy:

```text
Ngày
Số hóa đơn
Tổng tiền
```

nếu đã có trong SQLite.

---

# 49. RAM

Không giữ:

```text
10000 XML string
```

trong RAM.

Không giữ:

```text
10000 parsed invoice objects
```

nếu UI chỉ cần 100 record.

Chỉ giữ dữ liệu cần thiết cho màn hình hiện tại.

---

# 50. CPU

Không parse toàn bộ XML khi:

- mở tab;
- chuyển page;
- search;
- filter;
- đổi MST.

XML parsing chỉ khi:

- import;
- rebuild;
- preview;
- fallback duplicate check cần thiết.

---

# 51. DISK

XML là dữ liệu gốc.

SQLite chỉ chứa:

- metadata;
- index;
- query data;
- trạng thái.

Không lưu nguyên XML string vào SQLite nếu không cần.

`file_xml` trỏ tới XML vật lý.

---

# 52. UI UPDATE SAU AUTO SYNC

Không reload app.

Không F5.

Không reset state.

Chỉ refresh query hiện tại khi cần.

Ví dụ:

```text
User đang xem Bán ra 09/2026

Auto Sync tải thêm 2 invoice

→ refresh query hiện tại
```

---

# 53. BUILD / EXE

Ứng dụng hiện tại:

```text
Node.js + V8
pkg
Windows x64
```

Không tự ý chuyển sang:

```text
Electron
.NET
Java
```

nếu chưa được yêu cầu.

Mục tiêu:

```text
EXE nhẹ
EXE ổn định
Windows x64
```

Nếu SQLite native module gây vấn đề với pkg:

- phải kiểm tra compatibility;
- không tự ý đổi framework;
- báo cáo trước.

---

# 54. SOURCE OF TRUTH VỀ KIẾN TRÚC

File:

```text
PROJECT_ARCHITECTURE.md
```

là tài liệu kiến trúc chính.

Mọi AI/dev phải:

1. Đọc file.
2. Đọc source.
3. So sánh.
4. Báo conflict.
5. Chỉ sửa Phase được giao.

Không tự ý bỏ qua file.

---

# 55. QUY TẮC CHO AI CODING AGENT

Trước mỗi task:

```text
1. Read PROJECT_ARCHITECTURE.md
2. Inspect relevant existing source
3. Understand current implementation
4. Identify reusable code
5. Identify conflicts
6. Implement only requested phase
7. Run tests
8. Report result
```

Không:

```text
rewrite everything
```

Không:

```text
replace existing downloader
```

nếu không được yêu cầu.

Không tự thêm framework lớn.

Ưu tiên:

```text
existing code
+
small modular changes
```

---

# 56. CẤU TRÚC MODULE LOGIC

Đề xuất:

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

Đây là kiến trúc logic.

Không bắt buộc phải di chuyển source hiện tại vào đúng folder này nếu source hiện tại đã có cấu trúc tốt.

Không di chuyển file hàng loạt chỉ để làm đẹp.

---

# 57. SHARED SERVICES

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

Manual và Auto Sync có thể dùng chung các service.

Nhưng:

```text
Manual UI
```

và:

```text
Auto Sync logic
```

phải độc lập.

---

# 58. DATA FLOW - MANUAL

```text
User
 ↓
Manual Search
 ↓
API
 ↓
Invoice List
 ↓
Duplicate Check
 ↓
Download XML
 ↓
XML Data Engine
 ↓
Classify BUY/SELL
 ↓
Invoice Key
 ↓
XML Storage
 ↓
SQLite
 ↓
UI
```

---

# 59. DATA FLOW - AUTO SYNC

```text
Scheduler
 ↓
BUY query
 ↓
Duplicate Check
 ↓
Download missing
 ↓
Data Engine
 ↓
SQLite
 ↓
SELL query
 ↓
Duplicate Check
 ↓
Download missing
 ↓
Data Engine
 ↓
SQLite
```

---

# 60. DATA FLOW - IMPORT XML

```text
XML folder
 ↓
Scanner
 ↓
Parser
 ↓
Invoice Key
 ↓
BUY/SELL
 ↓
SQLite
```

---

# 61. DEVELOPMENT PHASES

Toàn bộ dự án được xây theo Phase.

Không làm tất cả một lần.

Thứ tự:

```text
PHASE 0
↓
PHASE 1
↓
PHASE 2
↓
PHASE 3
↓
PHASE 4
↓
PHASE 5
↓
PHASE 6
```

Không tự động chuyển Phase.

---

# 62. PHASE 0 - PHÂN TÍCH SOURCE

Mục tiêu:

Hiểu chính xác source hiện tại.

Không sửa code.

Phải tìm:

```text
1. Manual Search Flow
2. Manual Download Flow
3. API Bán ra
4. API Mua vào
5. Login/Session
6. XML destination
7. XML naming
8. Duplicate check
9. MST handling
10. Reusable modules
11. Build/package
12. UI architecture
```

Output:

```text
SOURCE_ANALYSIS.md
```

Báo:

- file;
- function;
- module;
- API;
- dependency;
- conflict;
- reusable code;
- code không được đụng.

---

# 63. PHASE 1 - DATA CORE

Xây:

```text
MST Manager
Folder Manager
SQLite Manager
Schema
Invoice Key
imported_files
sync_state
```

Chưa xây:

```text
Auto Sync
Full Data UI
Backfill
```

Không phá Manual Download.

---

# 64. PHASE 2 - XML DATA ENGINE

Xây:

```text
XML Scanner
XML Parser
BUY/SELL detection
Invoice Key
Import
Duplicate protection
Transaction
Error handling
```

Test XML thật.

---

# 65. PHASE 3 - DATA UI

Xây:

```text
MST
Overview
Invoice List
Search
Filter
Pagination
Invoice Preview
Products
Customers
Suppliers
```

Critical:

```text
List = SQLite
Preview = lazy XML
```

Không parse toàn bộ XML khi mở màn hình.

---

# 66. PHASE 4 - AUTO SYNC

Xây:

```text
BUY Sync
SELL Sync
SQLite duplicate check
XML fallback
Download
Data Engine
Background
sync.json
Progress
Retry
Error
```

Mặc định:

```text
BUY → SELL
```

Không chạy song song nếu API/session chưa được xác minh.

---

# 67. PHASE 5 - BACKFILL

Xây:

```text
Date Range
Year
Quarter
Month
Custom Range
Historical Sync
```

Dùng chung pipeline.

---

# 68. PHASE 6 - OPTIMIZATION

Tối ưu:

```text
SQLite
Indexes
Queries
Pagination
RAM
CPU
XML parsing
Filesystem
Auto Sync
Duplicate detection
Startup
UI
```

Không tối ưu mù.

Nếu có thể:

```text
Measure
→ Change
→ Measure again
```

---

# 69. TEST CASE BẮT BUỘC

## Test 1 - Database trống

API:

```text
1000 invoice
```

Kết quả:

```text
1000 XML
1000 SQLite records
```

---

## Test 2 - 999 đã có

API:

```text
1000 invoice
```

Đã có:

```text
999
```

Kết quả:

```text
999 skip
1 download
```

---

## Test 3 - XML có nhưng DB thiếu

Kết quả:

```text
Không download lại.
Import XML → SQLite.
```

---

## Test 4 - Rename XML

Đổi tên file.

Kết quả:

```text
Không tạo duplicate.
```

---

## Test 5 - Hai filename khác nhau

Nhưng cùng Invoice Key.

Kết quả:

```text
Không duplicate.
```

---

## Test 6 - BUY

XML:

```text
NMua/MST = currentMST
```

Kết quả:

```text
MuaVao/
direction = BUY
```

---

## Test 7 - SELL

XML:

```text
NBan/MST = currentMST
```

Kết quả:

```text
BanRa/
direction = SELL
```

---

## Test 8 - XML thiếu MST

Kết quả:

```text
Không đoán.
Log error.
```

---

## Test 9 - 1 XML lỗi trong 1000

Kết quả:

```text
999 xử lý thành công.
1 lỗi.
```

---

## Test 10 - Auto Sync + UI

Trong khi Auto Sync chạy:

```text
User mở invoice
```

Kết quả:

```text
UI không treo.
```

---

## Test 11 - 100.000 invoice

Mở MST:

```text
Không parse 100.000 XML.
```

UI lấy:

```text
page đầu từ SQLite.
```

---

## Test 12 - Preview

Click một invoice:

```text
Chỉ đọc 1 XML.
```

---

# 70. DATABASE REBUILD TEST

Xóa:

```text
data.db
```

Giữ:

```text
BanRa/*.xml
MuaVao/*.xml
```

Chạy rebuild.

Kết quả:

```text
SQLite được tạo lại
```

và:

```text
Invoice count
Item count
BUY/SELL
Invoice Key
```

phải khôi phục chính xác.

---

# 71. ERROR ISOLATION TEST

Nếu một invoice lỗi:

```text
Invoice #500 lỗi
```

thì:

```text
#499
#501
#502
...
```

vẫn phải tiếp tục xử lý nếu có thể.

Không crash toàn bộ Auto Sync.

---

# 72. LARGE DATA TEST

Phải test với dataset lớn.

Ví dụ:

```text
10.000 invoice
50.000 items
100.000 invoice
500.000 items
```

Kiểm tra:

- startup;
- search;
- filter;
- pagination;
- preview;
- aggregation;
- sync;
- RAM;
- CPU.

---

# 73. TIÊU CHUẨN HOÀN THÀNH MỖI PHASE

AI/dev phải báo:

```text
1. Files added
2. Files modified
3. Files removed
4. Implementation
5. Database changes
6. API changes
7. Tests
8. Test results
9. Known issues
10. Next Phase prerequisites
```

Không tự động làm Phase tiếp theo.

---

# 74. KHI SOURCE KHÁC ARCHITECTURE

Nếu source thực tế khác:

Không tự ý thay đổi architecture.

Phải báo:

```text
CONFLICT

Current source:
...

Architecture:
...

Impact:
...

Recommendation:
...
```

Sau khi xác định hướng mới được sửa cấu trúc.

---

# 75. KHI CHƯA BIẾT API

Không được bịa:

```text
endpoint
headers
payload
token
response
download URL
```

Phải đọc source thực tế.

---

# 76. QUY TẮC GIỮ TƯƠNG THÍCH

Ưu tiên:

```text
ADD
```

thay vì:

```text
REWRITE
```

Ưu tiên:

```text
EXTRACT REUSABLE FUNCTION
```

thay vì:

```text
DUPLICATE CODE
```

Không thay đổi behavior hiện tại nếu không cần.

---

# 77. PROMPT CHUNG CHO AI DEV

Copy prompt này trước mỗi Phase:

```text
You are working on HoaDonNhe-v13.

FIRST:
Read PROJECT_ARCHITECTURE.md completely.

Then inspect the existing source code relevant to this task.

IMPORTANT:
- Do not rewrite the whole project.
- Do not replace the existing Manual Download flow unless explicitly required.
- Do not invent APIs, endpoints, payloads, XML structures, or filenames.
- Do not silently change the architecture.
- Do not move to the next phase automatically.
- Keep the existing Node.js + V8 + pkg architecture unless explicitly instructed otherwise.
- XML is the source of truth.
- SQLite is the query/index layer.
- Do not use filename as Invoice Key.
- Do not parse all XML files when opening the UI.
- Do not load all invoices into RAM or DOM.

TASK:
Implement ONLY the requested phase.

Before coding:
1. Identify relevant existing files.
2. Explain the current implementation.
3. Identify reusable components.
4. Identify conflicts with PROJECT_ARCHITECTURE.md.
5. If a structural conflict exists, report it before making a major rewrite.

After coding:
1. List files added.
2. List files modified.
3. List files removed.
4. Explain implementation.
5. Explain database/schema changes.
6. Explain integration points.
7. Run relevant tests.
8. Report test results.
9. Report unresolved issues.
10. Stop.

DO NOT continue to the next phase automatically.
```

---

# 78. PROMPT PHASE 0

```text
Read PROJECT_ARCHITECTURE.md completely.

Do NOT modify any code.

Inspect the entire existing HoaDonNhe-v13 source.

Map exactly:

1. Manual Search Flow
2. Manual Download Flow
3. API Bán ra
4. API Mua vào
5. Login / Session / Authentication
6. XML download mechanism
7. XML destination
8. XML naming
9. Existing duplicate detection
10. MST handling
11. Existing reusable services
12. Build/package process
13. Current UI architecture
14. Current dependencies

For each item provide:
- file path
- function/class/module
- what it does
- inputs
- outputs
- dependencies

Then compare the source with PROJECT_ARCHITECTURE.md.

Report:
- compatible parts
- conflicts
- risks
- reusable code
- code that should NOT be touched

Do not write code.
Do not modify files.
Do not start Phase 1.

Stop after the analysis report.
```

---

# 79. PROMPT PHASE 1

```text
Read PROJECT_ARCHITECTURE.md completely.

Read the Phase 0 analysis report.

Inspect the existing source before coding.

Implement ONLY PHASE 1 - DATA CORE.

Build:

- MST Manager
- MST folder structure
- One SQLite DB per MST
- Database initialization
- invoices table
- invoice_items table
- imported_files table
- sync_state table
- required indexes
- Invoice Key utility
- basic repository/data-access layer

Requirements:

- XML remains the source of truth.
- One DB per MST.
- BanRa and MuaVao remain separate XML folders.
- Do not build Auto Sync.
- Do not build the full Data UI.
- Do not rewrite Manual Download.
- Keep architecture compatible with XML Data Engine and Auto Sync.

If the real source conflicts with the architecture:
STOP and report the conflict before making a structural rewrite.

After implementation:
- list changed files
- list new files
- explain schema
- explain Invoice Key
- run tests
- report results
- report unresolved issues

Do NOT continue to Phase 2.
```

---

# 80. PROMPT PHASE 2

```text
Read PROJECT_ARCHITECTURE.md completely.

Read the Phase 0 report and Phase 1 implementation.

Implement ONLY PHASE 2 - XML DATA ENGINE.

Build:

- XML scanner
- XML parser
- TTChung extraction
- seller extraction
- buyer extraction
- item extraction
- payment/total extraction
- BUY/SELL detection
- Invoice Key generation
- duplicate detection
- XML import
- SQLite transaction
- imported_files tracking
- error handling

Use real XML samples from the project.

Requirements:

- XML is source of truth.
- Do not use filename as invoice identity.
- Do not use SHDon alone.
- Do not guess BUY/SELL.
- Do not duplicate invoices.
- Existing Manual Download must remain functional.

Test:

- BUY XML
- SELL XML
- duplicate XML
- renamed XML
- invalid XML
- XML with missing MST
- XML with multiple items

Do NOT build Auto Sync.
Do NOT build the full UI.
Do NOT continue to Phase 3.
```

---

# 81. PROMPT PHASE 3

```text
Read PROJECT_ARCHITECTURE.md completely.

Read completed Phase 1 and Phase 2.

Implement ONLY PHASE 3 - DATA UI.

Build:

- MST selection
- Overview
- Invoice list
- Search
- Filters
- Pagination
- Invoice preview
- Products
- Customers
- Suppliers

Critical performance requirements:

- Invoice list comes from SQLite.
- Never scan all XML when opening the list.
- Never parse all XML when opening the list.
- Never render thousands of DOM rows.
- Use pagination.
- Preview is lazy-loaded.
- Clicking one invoice reads only that XML.
- Product aggregation uses SQL where possible.

Test with a large SQLite dataset.

Do NOT build Auto Sync.
Do NOT build Backfill.
Do NOT rewrite Manual Download.
Do NOT continue to Phase 4.
```

---

# 82. PROMPT PHASE 4

```text
Read PROJECT_ARCHITECTURE.md completely.

Read completed Phase 1, Phase 2, and Phase 3.

Implement ONLY PHASE 4 - AUTO SYNC.

Build:

- Auto Sync BUY
- Auto Sync SELL
- SQLite duplicate lookup
- XML fallback duplicate check
- per-download final duplicate check
- XML download
- XML Data Engine integration
- background execution
- sync.json
- progress/status
- retry
- error handling

Default sequence:

BUY → complete → SELL → complete

Do not assume parallel API requests are safe unless confirmed from the existing source.

Critical test:

If API returns 1000 invoices and SQLite/XML already contains 999:
- only 1 invoice may be downloaded.

Auto Sync must not block the UI.

Do not rewrite Manual Download.
Do not build Backfill.
Do not continue to Phase 5.
```

---

# 83. PROMPT PHASE 5

```text
Read PROJECT_ARCHITECTURE.md completely.

Read completed previous phases.

Implement ONLY PHASE 5 - BACKFILL.

Support:

- date range
- year
- quarter
- month
- custom range

Use the same pipeline:

API
→ Invoice Key
→ SQLite check
→ XML fallback
→ download
→ XML Data Engine
→ SQLite

Do not create a completely separate downloader.

Do not create duplicate data.

Backfill must support large historical datasets without freezing the UI.

Do not continue to Phase 6.
```

---

# 84. PROMPT PHASE 6

```text
Read PROJECT_ARCHITECTURE.md completely.

Read all previous phase reports and implementation.

Implement ONLY PHASE 6 - OPTIMIZATION.

Profile and optimize:

- SQLite queries
- indexes
- pagination
- startup
- UI rendering
- RAM
- CPU
- XML parsing
- filesystem access
- duplicate detection
- Auto Sync
- background tasks

Do not optimize blindly.

Measure before and after where possible.

Test with a large dataset.

Do not change behavior unless required for performance or stability.

Report:

- bottleneck
- before
- change
- after
- risk
- test result

Stop after Phase 6.
```

---

# 85. FINAL ACCEPTANCE CHECKLIST

```text
[ ] Manual Download vẫn hoạt động
[ ] API Mua vào hoạt động
[ ] API Bán ra hoạt động
[ ] Multiple MST
[ ] One DB per MST
[ ] XML source of truth
[ ] BUY/SELL automatic classification
[ ] Stable Invoice Key
[ ] Duplicate protection
[ ] XML import
[ ] SQLite indexing
[ ] Invoice search
[ ] Pagination
[ ] Lazy preview
[ ] Product aggregation
[ ] Customer aggregation
[ ] Supplier aggregation
[ ] Auto Sync BUY
[ ] Auto Sync SELL
[ ] Background Sync
[ ] sync.json
[ ] Backfill
[ ] Retry
[ ] Error handling
[ ] Rebuild DB from XML
[ ] Large dataset performance tested
[ ] EXE build tested
[ ] No secret in source
```

---

# 86. ABSOLUTE RULES

Các quy tắc sau là bắt buộc:

1. Không dùng filename làm Invoice Key.
2. Không dùng SHDon riêng làm Invoice Key.
3. Không parse toàn bộ XML khi mở UI.
4. Không load toàn bộ invoice vào DOM.
5. Không load toàn bộ invoice vào RAM.
6. Không dùng filesystem scan làm duplicate check chính.
7. SQLite là duplicate index chính.
8. XML là source of truth.
9. Một MST chỉ có một SQLite DB.
10. BanRa và MuaVao chỉ khác folder + direction.
11. BUY/SELL phải xác định từ XML.
12. Không tự đoán khi XML bất thường.
13. Manual Download phải được bảo toàn.
14. Auto Sync là module riêng.
15. Auto Sync không được khóa UI.
16. Preview chỉ đọc XML khi user yêu cầu.
17. Hàng hóa tổng hợp bằng SQL khi có thể.
18. Không tự quy đổi đơn vị.
19. Không biến hệ thống thành quản lý kho.
20. Không bịa API.
21. Không bịa XML schema.
22. Không tự chuyển framework.
23. Không rewrite toàn bộ source nếu không cần.
24. Mọi thay đổi lớn phải được báo cáo.
25. Mỗi Phase phải test trước khi hoàn thành.
26. Không tự động chuyển Phase.
27. Nếu DB mất, XML phải đủ để rebuild.
28. Một XML lỗi không được làm crash toàn bộ sync.
29. Không ghi secret vào log.
30. Không commit secret vào Git.

---

# 87. KIẾN TRÚC CUỐI CÙNG

```text
                    ┌───────────────┐
                    │    TCT API    │
                    └───────┬───────┘
                            │
               ┌────────────┴────────────┐
               │                         │
        Manual Download             Auto Sync
               │                         │
               └────────────┬────────────┘
                            │
                           XML
                            │
                    XML Data Engine
                            │
             ┌──────────────┼──────────────┐
             │              │              │
          Validate       BUY/SELL      Invoice Key
             │              │              │
             └──────────────┼──────────────┘
                            │
                     Duplicate Check
                            │
                 ┌──────────┴──────────┐
                 │                     │
             XML Storage            SQLite
                 │                     │
                 │               ┌─────┴─────┐
                 │               │           │
                 │             Search      Reports
                 │               │           │
                 └───────────────┴─────┬─────┘
                                       │
                                      UI
```

---

# 88. THỨ TỰ TRIỂN KHAI

```text
PHASE 0
Phân tích source
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

Không bỏ qua Phase 0.

Không xây Auto Sync trước khi hiểu API và Manual Download.

Không tối ưu trước khi có dữ liệu và query thực tế.

---

# 89. KẾT LUẬN

Kiến trúc cuối cùng phải giữ nguyên các nguyên tắc:

```text
XML = SOURCE OF TRUTH

SQLite = FAST INDEX / QUERY LAYER

Manual Download = GIỮ NGUYÊN

Auto Sync = MODULE RIÊNG

BUY/SELL = XÁC ĐỊNH TỪ XML

Invoice Key = KHÔNG DỰA VÀO FILENAME

UI = SQLITE + PAGINATION

PREVIEW = LAZY XML READ

HÀNG HÓA = SQL AGGREGATION

ONE MST = ONE SQLITE DB

MST DATA = ĐỘC LẬP

AUTO SYNC = BACKGROUND

DEVELOPMENT = PHASE BY PHASE
```

Ưu tiên theo thứ tự:

```text
ĐÚNG
↓
ỔN ĐỊNH
↓
KHÔNG PHÁ CODE CŨ
↓
NHANH
↓
NHẸ
↓
DỄ BẢO TRÌ
↓
DỄ MỞ RỘNG
```

END OF PROJECT_ARCHITECTURE.md
```
