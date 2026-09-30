# CN Tax Tools v1.1.0

## Có gì mới

- **Một kỳ lọc chung cho toàn bộ app**: trước mỗi tab một bộ lọc riêng và tự khởi đầu bằng
  kỳ khác nhau (Tổng quan = tháng này, Kho dữ liệu = năm, Sao kê = tất cả) nên chuyển tab thấy
  số lệch nhau mà không biết vì sao. Nay **một nút kỳ duy nhất ở đầu trang**: bấm vào đổi, và
  **mọi tab cùng đổi theo** — kể cả bản xuất Excel. Chọn “Tất cả thời gian” để xem tất cả.
- **Tab Sao kê ngân hàng Giai đoạn 1**: 6 thẻ số, biểu đồ tiền vào – tiền ra theo thời gian,
  ô “Cần xử lý”, bộ lọc tài khoản/nhóm giao dịch/trạng thái đối chiếu và **phân nhóm giao dịch**.
  Mở tab không còn trống trơn: nếu kỳ đang chọn không có giao dịch, app ghi rõ dữ liệu nằm ở khoảng nào.
- **Bấm một đối tác là ra danh sách hóa đơn của đối tác đó**, xem được hóa đơn khổ A4 và
  phân loại tiền mặt / chuyển khoản ngay trong danh sách.
- **Sửa lỗi mất giao dịch khi nhập sao kê**: trước đây hai giao dịch trùng ngày + số tiền +
  nội dung bị xem là trùng và **âm thầm bị bỏ** trong khi vẫn báo “số liệu khớp”. Nay mỗi lần xuất
  hiện được giữ đủ, và những dòng bị bỏ đều nêu rõ thay vì giấu chung vào số liệu “trùng”.
- **Sửa lỗi sao kê dài hơn 1 MB không lưu được**: giờ nhận tới 20 MB và báo rõ khi vượt hạn mức.
- **Sửa hộp xác nhận bấm không được**: nút “Xoá” / “Chuyển MST…” trong hộp Quản lý file sao kê
  mở hộp xác nhận nằm **dưới** hộp cha nên không bấm được.
- **Đối chiếu nhanh hơn 2,6–3,3 lần** trên kho lớn (kết quả khớp từng dòng), và lỗi đối chiếu
  giờ được ghi ra nhật ký thay vì bị bỏ qua âm thầm.
- **Giao diện gọn hơn**: đầu trang còn **2 hàng** thay vì 4 (tiết ~139px), bộ lọc kỳ thu về
  **một nút**, tiêu đề tab đứng chung hàng với dãy nút.

## Cài lần đầu

Tải **CN-Tax-Tools-Setup-v1.1.0.exe** ở phần Assets bên dưới và chạy. Chỉ cần 1 file này — không cần ZIP/RAR,
không cần cài thêm dependency.

## Cập nhật cho máy đã cài

**Đang dùng v1.0.2 trở lên**: bạn không cần tải gì — mở CN Tax Tools, app báo có bản mới rồi tự tải,
tự xác minh SHA-256, thay chương trình và khởi động lại. Setup chỉ dùng cho lần cài đầu tiên
(hoặc repair/gỡ cài đặt).

**Đang dùng v1.0.0 hoặc v1.0.1**: bản cũ chỉ *báo* có bản mới chứ chưa tự cập nhật được. Hãy tải
**CN-Tax-Tools-Setup-v1.1.0.exe** và chạy một lần — dữ liệu trong `du_lieu` (danh sách MST, phiên đăng nhập, hóa đơn)
được giữ nguyên. Từ bản này trở đi, mọi lần cập nhật sau đều tự động trong app.

Nếu muốn tải tay cho bản self-update: **CN-Tax-Tools-v1.1.0.exe** (kèm `.sha256`).

Khi chạy, trình cài đặt cho chọn 1 trong 2 chế độ:

- **CÀI ĐẶT VÀO WINDOWS**: cài vào hồ sơ người dùng, tạo shortcut Desktop + Start Menu,
  có mục gỡ cài đặt trong Windows, có tuỳ chọn chạy ngay sau khi cài.
- **PORTABLE**: chỉ giải nén vào thư mục bạn chọn để chạy `CN-Tax-Tools.exe` trực tiếp,
  không ghi vào Windows, không có gỡ cài đặt.

Yêu cầu: **Windows 64-bit (x64)**, có sẵn **Google Chrome** hoặc **Microsoft Edge**
(Edge có sẵn trong Windows 10/11). Không cần Node.js/Python/Chromium. Không cần quyền Administrator.

Cả hai chế độ lưu dữ liệu trong thư mục `du_lieu` nằm cạnh `CN-Tax-Tools.exe`,
nên bản Portable có thể copy cả thư mục sang máy khác.

## SHA-256

```
75a3a97c2726c7aabea84018f25d88dd9dd2684ec2ce7e941deb744344a4dbef  CN-Tax-Tools-Setup-v1.1.0.exe
```

<!-- sinh tu WHATS_NEW trong tools/build-installer.cjs — SHA-256 o day la cua Setup v1.1.0 -->
