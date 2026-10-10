# Menu quản lý khách trên Telegram

Admin mở Topic của khách, gõ `/menu` hoặc `/billing`. Topic mới tự có menu; Topic cũ mở bằng lệnh. Bot chỉ nhận thao tác từ quản trị viên đúng nhóm cấu hình.

## Các nhóm thao tác

- **Thông tin / bản quyền:** giữ kết quả `/check` hiện có.
- **Dữ liệu sử dụng:** báo cáo `/checkdulieu`, số MST hiện quản lý, lượt sử dụng tháng/tổng, thời gian tương tác, thời điểm gửi báo cáo.
- **Key / gói / gia hạn:** tạo key theo gói, đổi gói/số máy, cộng thêm ngày, xem giá. Chọn nhanh hoặc nhập số ngày 1–3650, số thiết bị 1–100. Đổi gói đặt lại hạn từ hôm nay; gia hạn cộng vào hạn còn hiệu lực.
- **Thiết bị / MST:** xem MST đăng ký theo key, tín hiệu thiết bị, khóa/mở khóa, gỡ liên kết thiết bị, thay MST và đặt lại số lần đổi. MST đăng ký theo key khác với danh sách MST đang lưu trong EXE khi đang dùng miễn phí.
- **Yêu cầu mua:** chọn đơn đang chờ, xem lại mã/gói/số tiền rồi xác nhận đã nhận tiền hoặc từ chối. Không tự xác minh thanh toán ngân hàng.
- **Hỗ trợ khách:** nhận hỗ trợ trực tiếp hoặc kết thúc và chuyển lại AI; không đổi quyền bản quyền.
- **Toàn hệ thống:** danh sách thiết bị, tìm theo điện thoại, menu AI, công khai thương mại/mở miễn phí, soạn/xem/công bố/thu hồi nội dung cập nhật. Công bố nội dung không build hoặc tải EXE lên GitHub.

## Nhập và xác nhận

Bot yêu cầu trả lời đúng tin nhập. Giá trị không hợp lệ không làm thay đổi dữ liệu. Tin hỗ trợ thông thường tiếp tục đi theo luồng chat cũ. `/cancel` hủy bước nhập. Một Admin chỉ có một bước đang chờ trong một Topic; mở menu mới thay bước cũ.

Thao tác thay đổi dữ liệu cần xem lại và xác nhận. Phiên xác nhận gắn với Admin/Topic/phòng khách, hết hạn sau 10 phút. Key thay đổi hoặc bản nháp cập nhật thay đổi sẽ chặn nút cũ. Tạo/đổi key, duyệt đơn và gia hạn có mã xử lý chống lặp; nhật ký lưu tại AdminAudit. Gỡ liên kết không xóa định danh phần cứng hoặc dữ liệu khách.

Các trang điều hướng ưu tiên sửa tin menu hiện có. Kết quả thay đổi và bước nhập có tin riêng để Admin theo dõi. Topic chưa gắn khách có nút tìm SĐT và liên kết; chỉ liên kết phòng đã tồn tại trong CRM, không ghi đè khách khác.

## Menu lệnh gọn

`/menu`, `/check`, `/checkdulieu`, `/billing`, `/online`, `/who`, `/check_sdt`, `/ai`, `/stop`, `/cancel`.

Lệnh cũ đã có xử lý vẫn được giữ để tương thích nhưng không đưa lên menu gợi ý. Nhóm `/ai_add`, `/ai_use`, `/ai_del`, `/ai_url`, `/ai_model`, `/ai_key` không nằm trong menu; dùng `/ai` và nút bấm. Các lệnh quản lý key cũ không nên dùng thay menu theo gói.

Đăng ký menu ở ngôn ngữ mặc định và tiếng Việt cho phạm vi mặc định, nhóm và Admin của nhóm cấu hình. Việc ẩn lệnh khỏi gợi ý không tự vô hiệu hóa một lệnh gõ tay. Quyền Admin được kiểm tra tại Gateway trước thao tác.
