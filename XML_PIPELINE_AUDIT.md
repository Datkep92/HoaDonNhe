# BÁO CÁO AUDIT XML PIPELINE (MASTER TASK mục 1)

Báo cáo nội bộ dựng TRƯỚC khi sửa code, đúng thứ tự dòng dữ liệu:

```text
XML FILE → XML PARSER → NORMALIZE → INVOICE OBJECT → DATABASE → API → UI
```

Mọi số dòng dưới đây lấy từ source thật, không suy đoán. Ngày lập báo cáo: 2026-09-29.

---

## 1. Vị trí từng khâu

| Khâu | File | Function | Dòng |
|---|---|---|---|
| Đọc file XML | `src/data/xml-scanner.js` | `scanXmlFolder()` | 247 |
| Ghi một file | `src/data/xml-scanner.js` | `processFile()` | 121 |
| **Parse XML** | `src/data/xml-parser.js` | `parseInvoiceXml(xml)` | 97 |
| **Tạo invoice object** | `src/data/xml-parser.js` | `buildImportRecord(xml, …)` | 160 |
| Normalise ngày | `src/vn-date.js` (gọi tại xml-parser.js:57) | `toVietnamDate()` | 57 |
| Normalise hình thức TT | `src/data/payment-method.js` (gọi tại xml-parser.js:139) | `normalizePaymentMethod()` | 139 |
| Xác định chiều mua/bán | `src/data/xml-parser.js` | `detectDirection()` | 67 |
| Tạo khoá hoá đơn | `src/data/invoice-key.js` | `buildInvoiceKey()` | 32 |
| **Ghi SQLite (INSERT)** | `src/data/repository.js` | `insertInvoice()` | 92 |
| **Ghi SQLite (UPDATE)** | `src/data/repository.js` | `upsertInvoice()` | 145 |
| **Chống trùng** | `src/data/schema.js` + `repository.js` | cột `invoice_key UNIQUE` + bắt lỗi `UNIQUE` | 34 / 125 |
| **API** | `src/server.js` | nhánh `/api/db/*` | 1722–2193 |
| **UI** | `src/data-ui.js` | `loadList()` (danh sách), `refreshOverview()` (Tổng quan) | 1096 / 353 |
| Bản xem trước A4 | `src/data/invoice-a4.js` | `buildInvoiceA4Document()` — **đọc lại XML gốc** | 129 |

Trạng thái hoá đơn `tthai` **KHÔNG có trong XML** — nguồn duy nhất là sổ tra cứu
`MST-…/trang-thai-hoa-don.json`, ghi vào DB ở `xml-scanner.js:144`.

---

## 2. Bảng đối chiếu từng trường

Cột: `XML FIELD → XML PATH/TAG → JS FIELD → SQLITE COLUMN → UI/API → STATUS`

### 2.1. Khối TTChung (thông tin chung)

| XML FIELD | XML PATH/TAG | JS FIELD | SQLITE COLUMN | UI/API | STATUS |
|---|---|---|---|---|---|
| Mãẫu hiệu | `TTChung/KHMSHDon` | `khmsHd` | `invoices.khms_hd` | tìm kiếm + cột Série trong `/api/db/invoices` | **OK** |
| Ký hiệu | `TTChung/KHHDon` | `khhHd` | `invoices.khh_hd` | danh sách, khoá hoá đơn | **OK** |
| Số hoá đơn | `TTChung/SHDon` | `soHd` | `invoices.so_hd` | danh sách, khoá hoá đơn, mọi popup | **OK** |
| Loại hoá đơn | `TTChung/THDon` | `loaiHoaDon` | `invoices.loai_hoa_don` | *không màn hình nào đọc* | **MISSING** (lưu xong để đó) |
| Ngày lập | `TTChung/NLap` | `ngayLap` | `invoices.ngay_lap` | mọi thẻ Tổng quan, bộ chọn kỳ, Excel | **OK** |
| Hình thức TT | `TTChung/HTTToan` | `paymentMethodRaw` / `paymentMethod` | `payment_method_raw` / `payment_method` | thẻ Thanh toán, đối chiếu (CHỈ `TRANSFER`) | **OK** |
| Đơn vị tiền tệ | `TTChung/DVTTe` | `dvtTe` | *không lưu* | bản A4 (`invoice-a4.js:28`) | **OK** (đúng chủ đích: chỉ xem trước) |
| Tỷ giá | `TTChung/TGia` | `tgIa` | *không lưu* | bản A4 (`invoice-a4.js:29`) | **OK** |
| MST cơ quan thuế | `TTChung/MSTTCGP` | `msttcgp` | *không lưu* | bản A4 (`invoice-a4.js:30`) | **OK** |
| Mã CQT cấp | `TTChung/MCCQT` (đọc cả ngoài khối) | `mccqt` | *không lưu* | bản A4 (`invoice-a4.js:56`) | **OK** |
| Phiên bản XML | `TTChung/PBan` | — | — | — | **MISSING** (không đọc) |
| Cờ hoá đơn chính/điều chỉnh | `TTChung/HDCTTChinh` | — | — | — | **MISSING** (không đọc; trạng thái lấy từ `tthai`) |
| Dữ liệu tuỳ biến | `TTChung/TTKhac/TTin` | — | — | — | **MISSING** (không đọc — parser chủ đích bỏ qua, xem xml-parser.js:10) |

### 2.2. Khối NBan / NMua (hai bên)

| XML FIELD | XML PATH/TAG | JS FIELD | SQLITE COLUMN | UI/API | STATUS |
|---|---|---|---|---|---|
| MST người bán | `NBan/MST` | `mstBan` | `invoices.mst_ban` | tìm kiếm, khử trùng lặp, xác định chiều | **OK** |
| Tên người bán | `NBan/Ten` | `tenBan` | `invoices.ten_ban` | danh sách, thẻ công nợ, TÊN DOANH NGHIỆP header | **OK** |
| Địa chỉ người bán | `NBan/DChi` | `dchiBan` | *không lưu* | bản A4 (`invoice-a4.js:52`) | **OK** |
| MST người mua | `NMua/MST` | `mstMua` | `invoices.mst_mua` | như trên | **OK** |
| Tên người mua | `NMua/Ten` **hoặc** `NMua/HVTNMHang` | `tenMua` | `invoices.ten_mua` | như trên | **OK** (HVTNMHang cho hoá đơn bán lẻ — đã kiểm chứng XML thật) |
| Địa chỉ người mua | `NMua/DChi` | `dchiMua` | *không lưu* | bản A4 (`invoice-a4.js:53`) | **OK** |

### 2.3. Khối TToan (tiền)

| XML FIELD | XML PATH/TAG | JS FIELD | SQLITE COLUMN | UI/API | STATUS |
|---|---|---|---|---|---|
| Tiền chưa thuế | `TToan/TgTCThue` | `tienTruocThue` | `invoices.tien_truoc_thue` | thẻ Thuế, Excel | **OK** |
| Tiền thuế | `TToan/TgTThue` | `tienThue` | `invoices.tien_thue` | thẻ Thuế (mục 26), độ phủ thuế `itemsWithTax` | **OK** |
| Tổng tiền | `TToan/TgTTTBSo` | `tongTien` | `invoices.tong_tien` | MỌI thẻ: KPI, đối chiếu, ngân hàng, công nợ | **OK** |
| Số tiền bằng chữ | (không có khối này trong XML mẫu của repo) | — | — | — | **UNKNOWN** (chưa có file thật để kiểm; khi nào có sẽ bổ sung) |

### 2.4. Khối HHDVu (dòng hàng)

| XML FIELD | XML PATH/TAG | JS FIELD | SQLITE COLUMN | UI/API | STATUS |
|---|---|---|---|---|---|
| STT | `HHDVu/STT` | `stt` | `invoice_items.stt` | bản A4 | **OK** |
| Mã hàng | `HHDVu/MHHDVu` | `maHang` | `invoice_items.ma_hang` | tab Hàng hoá (mục 24) | **OK** |
| Tên hàng | `HHDVu/THHDVu` | `tenHang` | `invoice_items.ten_hang` | thẻ Hàng hoá + popup chi tiết (mục 6) | **OK** |
| Đơn vị tính | `HHDVu/DVTinh` | `donVi` | `invoice_items.don_vi` | tab Hàng hoá | **OK** |
| Số lượng | `HHDVu/SLuong` | `soLuong` | `invoice_items.so_luong` | tổng hợp hàng hoá (GROUP BY bằng SQL) | **OK** |
| Đơn giá | `HHDVu/DGia` | `donGia` | `invoice_items.don_gia` | bản A4 | **OK** |
| Tiền chiết khấu | `HHDVu/STCKhau` | `chietKhau` | `invoice_items.chiet_khau` | bản A4 | **OK** |
| Tỷ lệ chiết khấu | `HHDVu/TLCKhau` | — | — | — | **MISSING** (không đọc) |
| Thành tiền dòng | `HHDVu/ThTien` | `thanhTien` | `invoice_items.thanh_tien` | tổng hợp hàng hoá | **OK** |
| Thuế suất | `HHDVu/TSuat` | `thueSuat` | `invoice_items.thue_suat` | bản A4, Excel | **OK** |
| Tiền thuế dòng | `HHDVu/TThue` | `tienThue` | `invoice_items.tien_thue` | độ phủ thuế (`itemsWithTax`) — **không tự tính bù** khi thiếu | **OK** |
| Tính chất dòng | `HHDVu/TChat` | `tchat` | *không lưu* | bản A4 (`invoice-a4.js:40`) | **OK** |

---

## 3. Kết luận từng câu hỏi của mục 1

1. **XML parser ở đâu?** `src/data/xml-parser.js` — `parseInvoiceXml()` (dòng 97), regex
   thay vì thư viện XML (chọn chủ đích, ghi trong header file).
2. **Function nào parse?** `parseInvoiceXml()`.
3. **Function nào tạo invoice object?** `buildImportRecord()` (dòng 160) — ghép
   `record` + `direction` + `invoiceKey`.
4. **Function nào ghi SQLite?** `repository.insertInvoice()` (INSERT, dòng 92) và
   `repository.upsertInvoice()` (UPDATE khi file XML đổi, dòng 145) — mỗi hoá đơn
   ghi trong MỘT transaction: `invoices` + `invoice_items` + `imported_files`.
5. **Chống trùng bằng gì?** cột `invoices.invoice_key UNIQUE` (schema.js:34);
   `insertInvoice()` bắt lỗi `UNIQUE` (repository.js:125) → `inserted=false`,
   không ghi đè. Lượt quét đánh dấu `imported_files.status='duplicate'`.
6. **Hiển thị ở đâu?** Danh sách: `/api/db/invoices` → `data-ui.js:loadList()` (1096).
   Tổng quan: `/api/db/summary|overview|…` → `data-ui.js:refreshOverview()` (353).
   Xem chi tiết A4: `/api/db/invoice/html` → `invoice-a4.buildInvoiceA4Document()`
   đọc **trực tiếp file XML gốc** (không nối từ DB).
7. **Trường đang bị bỏ sót (MISSING):** `PBan`, `HDCTTChinh`, `TLCKhau`,
   `TTKhac/TTin`, và `THDon` (lưu nhưng chưa màn hình nào đọc).
8. **Trường UNKNOWN:** số tiền bằng chữ — trong repo chưa có XML thật chứa trường
   này nên chưa kết luận được.

## 4. An toàn

- Không có trường nào bị đọc SAI sai lệch (WRONG) — không tìm thấy.
- Bảng này KHÔNG đụng tới dữ liệu người dùng, chỉ là tài liệu đối chiếu.
- 470 bài kiểm tra (`npm test`) phủ các trường phía trên.
