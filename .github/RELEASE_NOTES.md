# CN Tax Tools v1.1.1 — ghi chú phát hành

> File này được commit vào repo nên CI luôn đọc được (thư mục `release/` bị .gitignore).
> Cố ý **không** ghi SHA-256 ở đây: NSIS đóng timestamp nên mỗi lần build ra hash khác nhau.
> Hash thật do `npm run installer` ghi vào `release/*.sha256`, workflow tính lại lúc build.

## Sửa lỗi

### PDF không có nền (hình mờ của cổng thuế)

Khối `@media print` trong HTML hoá đơn có `background:none` cho `.main-page`. Chrome khi in áp
dụng *print media* nên nền bị giết: **PDF ra trắng trơn**, trong khi bản `.html` mở bằng trình
duyệt vẫn thấy nền. Lỗi có từ commit đầu tiên, không phải do các bản cập nhật gần đây.

Đã bỏ. PDF giờ chứa lại ảnh nền gốc 1280×1280 (dung lượng file PDF tăng ~150 KB).

### PDF tải về khác bản xem trước A4

Hai đường dựng lấy dữ liệu khác nhau: bản xem trước đọc thẳng từ file XML, còn PDF dựng từ
`detail` của cổng. `xml-parser.js` bỏ sót những thẻ **XML có sẵn** nên bản xem trước thiếu:

| Thẻ trong XML | Hiển thị ở |
| --- | --- |
| `NBan/MCHang`, `NBan/TCHang` | Mã cửa hàng, Tên cửa hàng |
| `NBan/SDThoai` | Điện thoại |
| `TToan/TgTTTBChu` | Tổng tiền bằng chữ |
| `DSCKS/SigningTime`, `DSCKS/X509SubjectName` | Khung chữ ký số |

Lưu ý khi tra: `TTCKTMai` trong XML là **con số** (thường `0.000000`), chữ nằm ở `TgTTTBChu` —
dễ tưởng XML không có dữ liệu này.

Sau khi sửa, đối chiếu từng khối giữa hai bản: các trường dữ liệu **khớp hết**, bảng hàng khớp
11/11 dòng, khối chữ ký khớp hệt, tổng chiều cao chênh **2px** trên 2280px.

### PDF rỗng / tải lỗi

`pdf()` đánh giá script trên tab của cổng thuế trong khi `printToPDF` chạy ở tab mới ⇒ in ra trang
trắng. Chuyển sang chạy trên đúng tab in. Thêm:
- chờ `document.fonts.ready` và mọi ảnh tải xong trước khi in;
- **từ chối PDF trắng** và tự tải lại, không bắt người dùng xoá tay;
- gọi `detail` trước, chỉ gọi `export-xml` khi `detail` thiếu `mhdon`/`tdlap` (giảm 1 lời gọi cổng);
- `withTimeout` thật sự hết giờ (bản cũ đặt 60 giây nhưng không bao giờ chạy).

### Khởi động chậm

Nguyên nhân: 14 lần gọi PowerShell đồng bộ để giải mã DPAPI. Gom lại 1 lần gọi cho 14 khối.

- 5,7 giây → **0,8 giây**
- kiểm tra phiên dời sang 10 giây sau khi cửa sổ hiện
- bỏ màn hình "Vui lòng chờ" chặn giao diện
- tách nhãn "đã hết hạn" khỏi "đang kiểm tra" để không báo sai

### Đăng nhập lại khi hết phiên

Tự đăng nhập lại ở nền, **không khoá giao diện**. Nếu cần nhập tay thì đóng hộp thoại và bỏ qua.
Tách hai loại khoá: chống gọi trùng ở máy chủ và khoá giao diện — chỉ loại sau mới chặn người dùng.

## Tính năng

- **Tuỳ chọn "Khởi động cùng Windows"** trong Cài đặt, **mặc định BẬT**. Ghi khoá
  `HKCU\...\Run` kèm `--start-hidden`; lựa chọn được lưu trong `du_lieu/app-settings.json`
  (khoá Registry tự nó không nhớ được "người dùng đã tắt").
- **Trạng thái trực tuyến**: nhịp 10 phút, độc lập với lần kiểm tra licence 4 giờ. Chạy nền vẫn
  tính là online; offline = không mở app. Nhãn nhóm Telegram đổi 🟢/⚪️ theo trạng thái.
- Lệnh Telegram: `/check_SDT` (tra theo MST trả về **mọi** hoá đơn của MST đó), `/online`, `/who`.
- Bot kiểm tra nền chỉ chạy khi có chênh lệch.

## Ghi chú kỹ thuật

Bản dựng HTML hoá đơn lấy nguyên từ extension gốc. Nơi này `buildInvoiceHtml` **chưa bao giờ
được in ra** trong extension (không có `printToPDF`, `window.print`, hay ghi file HTML) — nên
bố cục nó vừa khít vừa không vừa một trang A4 chưa từng được kiểm. Bản này mới là lần đầu dựng
PDF thật từ template đó.

Còn tồn đọng: tài liệu cao ~2280px so với trang A4 1123px ⇒ **3 trang**, trang thứ 3 chỉ nhận
~34px. Xếp khối người bán/mua thành 2 cột (đúng mẫu cơ quan thuế) tiết kiệm 172px ⇒ còn 2 trang.
Chưa sửa vì cần đối chiếu với PDF chuẩn của cổng thuế.