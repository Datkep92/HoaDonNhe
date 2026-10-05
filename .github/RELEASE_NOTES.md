# CN Tax Tools v1.1.4

## Có gì mới

- Chat AI dùng Cloudflare làm nguồn cấu hình chung cho EXE và Telegram; có AUTO—Cloudflare và MANUAL—API riêng.
- Quản lý URL → nhiều model → nhiều key bằng nút Telegram; thêm/sửa/xóa, thêm nhiều model, kiểm tra và xem lịch sử.
- Deep health check, phân loại lỗi, resolver Chat Completions/Responses, tự chuyển dự phòng, cooldown, phục hồi, sticky conversation và cập nhật revision tại runtime.
- Sửa nút Telegram không nhận callback và lỗi kết nối riêng của Cloudflare; model lỗi không làm mất key/cấu hình.
- Copy URL/model; lấy key/full config riêng cho admin, không gửi full key vào group.
- Chat có trạng thái đang xử lý, hỗ trợ ảnh/file, gọi công cụ và xuất Excel theo quyền đã cấp.
- Giữ chức năng hiện có: tải hóa đơn nhiều MST, XML/PDF gốc, CAPTCHA/OCR, kho dữ liệu, tổng quan, sao kê/đối chiếu, xuất Excel/MISA, tra cứu MST/tờ khai, hỗ trợ và cập nhật ứng dụng.

## Tải và cập nhật

- Cài mới: tải **CN-Tax-Tools-Setup-v1.1.4.exe**, chọn cài đặt hoặc portable.
- Cập nhật thủ công/self-update: **CN-Tax-Tools-v1.1.4.exe** và file **.sha256** tương ứng.
- Dữ liệu trong thư mục du_lieu được giữ theo cơ chế cập nhật hiện có. Yêu cầu Windows x64 và Chrome/Edge.

## Kiểm chứng và giới hạn

Bản phát hành qua bộ kiểm thử, xác minh tài nguyên, OCR và smoke của chính EXE, cùng kiểm tra giao diện bản đóng gói. Báo cáo chi tiết: CHATAI_CHECKLIST_FINAL_REPORT.md trong mã nguồn.

Kiểm thử cuối: **979 tests — 972 PASS, 0 FAIL, 7 SKIP**; EXE đủ **80/80** tài nguyên bắt buộc. Packaged browser, OCR và smoke đều PASS. Các mục SKIP không được tính PASS.

Cloudflare thật đã chat và gọi health_ping thành công qua openrouter/free với key hiện tại. Model stealth/space-bunny-alpha trả MODEL_NOT_FOUND và được giữ lại để quản trị. Dịch vụ free đôi lúc trả rỗng/rate limit; cần cấu hình dự phòng còn quota để tăng độ ổn định.

Keyboard đã được Telegram API thật chấp nhận; thao tác nhấn/copy riêng trên điện thoại chưa được thử trực tiếp. Responses được kiểm tra bằng fixture; capability vision/reasoning/structured từ metadata chưa thay thế thử nghiệm provider thật. Python/shell tự do vẫn theo feature flag và quyền hiện có; bản này không tự bật các quyền đó.
