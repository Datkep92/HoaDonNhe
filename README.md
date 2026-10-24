# CN Tax Tools — Trợ lý cho công việc kế toán

**Miễn phí trong giai đoạn phát triển.** Quản lý hóa đơn của nhiều doanh nghiệp, xử lý sao kê, đối chiếu dữ liệu và làm việc với trợ lý AI ngay trong ứng dụng Windows.

## Tải và cài đặt

Tải **[CNTaxTools-Setup-v1.8.3.exe](https://github.com/Datkep92/HoaDonNhe/releases/download/v1.8.3/CNTaxTools-Setup-v1.8.3.exe)** rồi chạy bộ cài. Có sẵn giao diện, Node x86, OCR và thư viện thông thường; lần cài đầu cần mạng để tải thêm phần xử lý đã ký vào Engine riêng, ẩn. Không cần cài Node hoặc giải nén ZIP/script.

Bản 1.8.3 sửa lỗi cập nhật từ bộ cài 1.7 xong vẫn mở lại bản cũ do đọc sai tệp chọn thư mục dữ liệu. Người dùng 1.7.0 có thể cập nhật trong ứng dụng. Giữ thư mục dữ liệu đang dùng; khi đổi vị trí, chọn đúng du_lieu chứa accounts.json. Không tự gộp hai kho. Gỡ/cài lại giữ dữ liệu và cookie.

Đã kiểm EXE/Engine x86 trên Windows x64; chưa kiểm Windows 32-bit thật. Cần Chrome hoặc Edge. EXE chưa có chứng thư Windows Authenticode; Engine có chữ ký kiểm toàn vẹn. [Ghi chú và giới hạn 1.8.3](https://github.com/Datkep92/HoaDonNhe/releases/tag/v1.8.3).

## Các chức năng

- **Hóa đơn:** tải mua vào, bán ra hoặc cả hai theo thứ tự; xem, tìm kiếm và xuất Excel theo bộ lọc. Cột cuối ghi trạng thái Mới, Thay thế, Điều chỉnh, Đã bị thay thế, Đã bị điều chỉnh, Đã bị hủy; dữ liệu thiếu trạng thái được ghi Chưa xác định.
- **Nhiều doanh nghiệp:** quản lý danh sách MST, phiên đăng nhập và tiến độ đồng bộ riêng.
- **Hàng hóa và đối tác:** tổng hợp từ hóa đơn, lọc theo kỳ và xuất Excel riêng cho từng tab.
- **Sao kê ngân hàng:** nhập file được hỗ trợ, phân loại giao dịch và đối chiếu với hóa đơn. Kiểm tra kết quả nhận diện trước khi sử dụng.
- **Tổng quan và Tổng hợp GTGT:** thống nhất số tiền với Dữ liệu, kết hợp XML và dữ liệu cục thuế khi chưa có XML, tách ngoại tệ và cảnh báo tiền thuế còn thiếu. Tổng hợp GTGT/Excel giữ phần lẻ và ghi phần chưa phân loại theo suất; đây là bảng đối chiếu, chưa phải tờ khai đã chốt.
- **Tra cứu MST:** nhập danh sách hoặc lấy MST nhà cung cấp/người mua từ dữ liệu đã lưu, chọn các đối tác cần kiểm tra và xuất kết quả.
- **Tờ khai:** đăng nhập, đồng bộ phiên web khi cần và tải tờ khai theo điều kiện hỗ trợ.
- **Thay thế hóa đơn hàng loạt:** nhận hai file Excel, kiểm tra nhận diện cột, đối chiếu thuế suất và xuất theo mẫu MISA. File xuất để nhập vào MISA, **chưa phải hóa đơn đã phát hành**. Cần kiểm tra trên phiên bản MISA đang dùng. Với phần mềm khác, gửi mẫu file cho Admin để đánh giá hỗ trợ.
- **Chatbot AI hỗ trợ kế toán:** tìm nguồn, đọc và phân tích dữ liệu CNTaxTools cùng file kế toán được hỗ trợ, hỏi thêm khi chưa rõ yêu cầu, tạo báo cáo và kiểm tra kết quả. Có thể tiếp tục tác vụ đang làm sau khi mở lại ứng dụng.
- **Liên hệ Admin:** nút riêng trong ứng dụng để trao đổi trực tiếp khi cần hỗ trợ.
- **Thông báo từ Admin:** nhận tin ngay trong ứng dụng, tự đóng khi đã đọc; vẫn tải, đồng bộ và làm việc bình thường.

Các màn hình đang xây dựng sẽ ghi rõ trạng thái; khả năng xử lý phụ thuộc loại file và dữ liệu thực tế.

## Làm việc cùng AI

Bạn có thể hỏi:

- “Báo cáo kinh doanh tháng 10 của doanh nghiệp có MST …”
- “So sánh doanh thu tháng này với tháng trước và giải thích chênh lệch.”
- “Đối chiếu bảng xuất từ phần mềm kế toán này với hóa đơn trong CNTaxTools.”
- “Xuất Excel danh sách chênh lệch để tôi kiểm tra.”

AI tìm dữ liệu phù hợp, phân tích, hỏi bổ sung khi thiếu thông tin và thực hiện những bước ứng dụng hỗ trợ. Hãy cung cấp tên doanh nghiệp/MST, kỳ và file hoặc đường dẫn cần đọc để kết quả sát yêu cầu hơn.

File mới được tạo trong thư mục riêng. Thao tác ghi cần xác nhận và dữ liệu gốc được bảo vệ. AI không tự đọc trực tiếp mọi phần mềm kế toán; hãy dùng các bảng xuất hoặc tài liệu được hỗ trợ. Kiểm tra số liệu, chứng từ và kết luận trước khi kê khai hoặc phát hành hóa đơn. Nguồn AI miễn phí có hạn mức; hết nguồn khả dụng, ứng dụng báo để thử lại sau.

## Cập nhật và sao lưu

Thông báo cập nhật hiển thị nội dung thay đổi để đọc trước khi cài. Bạn có thể chọn Để sau, dấu × hoặc Esc để tiếp tục làm việc; mở lại thông báo bằng nút Cập nhật ở cuối thanh bên. Chỉ bấm Cập nhật khi muốn bắt đầu tải và cài.

Dùng bộ cài EXE của phiên bản mới hoặc nút Cập nhật trong ứng dụng; tiếp tục dùng đúng thư mục dữ liệu cũ. Các ZIP/script lịch sử vẫn được giữ trên GitHub nhưng không phải bộ cài được khuyên dùng cho phiên bản này.

Giữ bản sao thư mục dữ liệu trước khi chuyển máy hoặc nâng cấp quan trọng. Không gỡ ứng dụng và xóa dữ liệu trước khi nâng cấp. Không chia sẻ thư mục chứa phiên đăng nhập, mật khẩu hoặc dữ liệu doanh nghiệp.

## Hỗ trợ

Bấm **Liên hệ Admin** trong ứng dụng hoặc [báo lỗi trên GitHub](https://github.com/Datkep92/HoaDonNhe/issues). Gửi phiên bản đang dùng, bước gây lỗi và ảnh thông báo; che mật khẩu, thông tin đăng nhập và dữ liệu nhạy cảm.

[Xem lịch sử cập nhật và tải bộ cài](https://github.com/Datkep92/HoaDonNhe/releases).
