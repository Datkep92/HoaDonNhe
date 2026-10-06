# Hỗ trợ chung AI / Admin — 06/10/2026

## Hành vi đã sửa

- Khung Hỗ trợ chung dùng AUTO qua Cloudflare, kể cả dữ liệu cũ lưu CNTaxTools ở MANUAL với model đã ngừng hoạt động. Cấu hình API riêng vẫn ở các chế độ riêng.
- Chat AI thông thường không gửi nội dung tới Telegram. Chỉ sau khi chuyển sang admin, các tin của phiên hỗ trợ mới được chuyển sang topic thiết bị.
- Yêu cầu liên quan admin/bản quyền có lựa chọn tiếp tục với AI hoặc đợi admin ngay trong khung chung. Thao tác kích hoạt license trên EXE gửi yêu cầu có key được che; license không còn cho dùng AI thì chuyển sang admin.
- Khi admin trả lời, quyền giữ phiên được lưu bằng CAS; Gateway chặn AI và EXE hủy tác vụ đang chạy. `/stop` từ admin trả phiên về AI; người không có quyền admin không thể đóng phiên. Phản hồi cũ không được ghi sau khi quyền giữ phiên đã đổi.
- Hiển thị trạng thái ngắn: đọc yêu cầu, xử lý dữ liệu/công cụ, tổng hợp kết quả, tìm cấu hình. Không hiển thị suy luận nội bộ của model.
- Mở chat tại tin mới nhất. Ghép lịch sử AI và admin theo thời gian; tránh để kết quả tải lịch sử chậm xóa tin vừa gửi. Mỗi công ty vẫn giữ phạm vi lịch sử/file riêng.

## Giảm thời gian chờ

- Tái dùng endpoint đã xác minh trên cùng URL giữa các model; nếu đường dẫn/header không còn phù hợp thì dò lại. Kiểm thử đường đã ấm: chỉ một provider request cho model tiếp theo.
- Ưu tiên cấu hình/capability đã biết và chọn hình thức request tương thích từ đầu; có fallback chat thường/JSON tools khi cần, thay vì chờ một dạng request không tương thích.
- Bỏ một lần đọc registry Firebase thừa trước khi trả stream; dùng kết quả CAS vừa publish cho revision.
- Đọc trạng thái tiếp quản bằng API metadata nhỏ `/v1/chats/control`, thay vì tải toàn bộ lịch sử trong mỗi bước. Cache tối đa 750 ms, sự kiện realtime cập nhật/hủy ngay khi admin tiếp quản.
- Bỏ chuyến mạng Telegram trong đường chat AI thông thường. Tốc độ sinh câu trả lời vẫn phụ thuộc model/provider; chưa có đo lường độ trễ trước/sau trên một provider thật đang khỏe.

## PASS giả lập và EXE đóng gói

- Regression: **1.018 tests, 1.011 PASS, 0 FAIL, 7 SKIP**. `backup/support-ai/regression-final.log`.
- Các tình huống routing: nhiều cấu hình, continuation, 100 client/isolate, quota/key/model/URL fallback, lease/restart, stream dang dở, native formats, metadata và endpoint cache.
- Các tình huống hỗ trợ: AI không gửi Telegram; chuyển admin mới gửi; tiếp quản/restart; `/stop`; chặn người không phải admin; từ chối phản hồi cũ; bản quyền hết hạn vẫn liên hệ admin.
- Trình duyệt chạy chính EXE: PASS khung chung, model MANUAL cũ không còn đi vào đường chat chung, tự gửi lại sau routing job, handoff/license, admin qua SSE, không gọi AI trong phiên admin, `/stop` hoạt động lại, mở ở tin mới nhất, desktop/mobile và không lỗi JavaScript.
- Regression UI riêng: PASS gửi tức thì/hàng đợi/ảnh, CSV → phân tích → Excel, quyền AI từ chối/thu hồi/cho phép, tách công ty và file, CSP.
- Build: đủ 80/80 tài nguyên bắt buộc, 16 bản minify; OCR mẫu và packaged smoke 20 checks PASS. `backup/support-ai/build-final.log`.
- EXE: `release/CN-Tax-Tools-v1.1.4-support-ai.exe`, 185.320.902 bytes; SHA256 `ec01d3ca42317114e9d73129147c6eb3e0059c23a7e4e738763ed8d29bc9c88e`.

## Dịch vụ thật và giới hạn

- Đã triển khai Worker/Cron phiên bản `fdf6c437-45ae-4756-a72a-c18f5c2da911`; `/healthz` HTTP 200. Telegram API chấp nhận đăng ký `/stop` cho menu mặc định và tiếng Việt. Các route probe tạm đã xóa, mirror khớp source và `git diff --check` PASS.
- Probe thật trong đợt này chưa có câu trả lời thành công: pool báo QUOTA_EXCEEDED (2 cấu hình OpenRouter), RATE_LIMIT (OpenCode), PROVIDER_ERROR (cấu hình còn lại). Gateway trả AI_ROUTING_PENDING, không trả PASS giả. Chi tiết metadata không chứa key ở `backup/support-ai/live-result.json`.
- Hệ thống giữ key và cooldown/phục hồi tự động; không tự thêm key/model/provider ngoài dữ liệu admin.
- Chưa kiểm tra thao tác trên điện thoại Telegram, chưa ép quota/hết hạn trên tài khoản thật và chưa xác minh native provider bằng credential riêng.
- EXE kiểm thử riêng; Release 1.1.4 đã công bố không bị ghi đè.
