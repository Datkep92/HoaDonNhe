# CN Tax Tools — Trợ lý cho công việc kế toán

**Miễn phí trong giai đoạn phát triển.** Quản lý hóa đơn của nhiều doanh nghiệp, xử lý sao kê, đối chiếu dữ liệu và làm việc với trợ lý AI ngay trong ứng dụng Windows.

## Tải và cài đặt

Vào [bản phát hành mới nhất](https://github.com/Datkep92/HoaDonNhe/releases/latest), chọn file **CN-Tax-Tools-Setup-v…exe** trong mục Assets rồi chạy bộ cài. Có thể cài vào Windows hoặc chọn Portable để dùng trong một thư mục riêng.

Yêu cầu Windows **64 bit**, có Google Chrome hoặc Microsoft Edge và kết nối Internet khi đăng nhập, tải dữ liệu hoặc sử dụng AI. Không cần cài Node.js, npm, Python hay công cụ dòng lệnh.

Mở ứng dụng, thêm mã số thuế, đăng nhập cổng thuế và chọn kỳ cần làm việc. Khi đóng cửa sổ, ứng dụng có thể tiếp tục chạy ở khay hệ thống; mở lại qua biểu tượng hoặc chọn Thoát hoàn toàn khi muốn kết thúc.

## Các chức năng

- **Hóa đơn:** tải mua vào, bán ra hoặc cả hai theo thứ tự; xem, tìm kiếm và xuất Excel theo bộ lọc. Cột cuối ghi trạng thái Mới, Thay thế, Điều chỉnh, Đã bị thay thế, Đã bị điều chỉnh, Đã bị hủy; dữ liệu thiếu trạng thái được ghi Chưa xác định.
- **Nhiều doanh nghiệp:** quản lý danh sách MST, phiên đăng nhập và tiến độ đồng bộ riêng.
- **Hàng hóa và đối tác:** tổng hợp từ hóa đơn, lọc theo kỳ và xuất Excel riêng cho từng tab.
- **Sao kê ngân hàng:** nhập file được hỗ trợ, phân loại giao dịch và đối chiếu với hóa đơn. Kiểm tra kết quả nhận diện trước khi sử dụng.
- **Tổng quan và hỗ trợ kế toán:** xem doanh thu, chi phí, dòng tiền, công nợ, các chứng từ cần kiểm tra; tổng hợp quý phục vụ kê khai GTGT và xuất PDF.
- **Tra cứu MST:** nhập danh sách hoặc lấy MST nhà cung cấp/người mua từ dữ liệu đã lưu, chọn các đối tác cần kiểm tra và xuất kết quả.
- **Tờ khai:** đăng nhập, đồng bộ phiên web khi cần và tải tờ khai theo điều kiện hỗ trợ.
- **Thay thế hóa đơn hàng loạt:** nhận hai file Excel, kiểm tra nhận diện cột, đối chiếu thuế suất và xuất theo mẫu MISA. File xuất để nhập vào MISA, **chưa phải hóa đơn đã phát hành**. Cần kiểm tra trên phiên bản MISA đang dùng. Với phần mềm khác, gửi mẫu file cho Admin để đánh giá hỗ trợ.
- **Chatbot AI hỗ trợ kế toán:** tìm nguồn, đọc và phân tích dữ liệu CNTaxTools cùng file kế toán được hỗ trợ, hỏi thêm khi chưa rõ yêu cầu, tạo báo cáo và kiểm tra kết quả. Có thể tiếp tục tác vụ đang làm sau khi mở lại ứng dụng.
- **Liên hệ Admin:** nút riêng trong ứng dụng để trao đổi trực tiếp khi cần hỗ trợ.

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

Từ v1.1.7, khi phát hiện bản mới, ứng dụng hiển thị **Có gì mới**. Bấm **Cập nhật** hoặc click bên ngoài thông báo để bắt đầu. Công việc đang chạy cần hoàn tất hoặc lưu trước khi thay chương trình; lỗi tải sẽ giữ phiên bản cũ và cho thử lại.

Từ v1.1.8, ứng dụng kiểm tra bản mới mỗi 15 phút ngay cả khi đã đóng giao diện và vẫn chạy trong khay hệ thống. Có bản mới sẽ hiện thông báo Windows; bấm thông báo để mở nội dung cập nhật. Nếu mất mạng, ứng dụng thử lại sau 5 phút. Windows có thể ẩn thông báo khi bật chế độ Không làm phiền; nội dung cập nhật vẫn hiện khi mở giao diện.

Cơ chế này có hiệu lực trong phiên bản đã nâng cấp. Các bản cũ có cách cập nhật riêng; nếu không nâng cấp được trong ứng dụng, tải bộ cài mới từ GitHub. Giữ bản sao thư mục dữ liệu trước khi chuyển máy hoặc thực hiện thao tác quan trọng. Không chia sẻ thư mục dữ liệu chứa thông tin doanh nghiệp và phiên đăng nhập.

## Hỗ trợ

Bấm **Liên hệ Admin** trong ứng dụng hoặc [báo lỗi trên GitHub](https://github.com/Datkep92/HoaDonNhe/issues). Gửi phiên bản đang dùng, bước gây lỗi và ảnh thông báo; che mật khẩu, thông tin đăng nhập và dữ liệu nhạy cảm.

[Xem lịch sử cập nhật và tải bộ cài](https://github.com/Datkep92/HoaDonNhe/releases).
