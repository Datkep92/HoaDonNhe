# Luồng AI tự động — báo cáo triển khai

Ngày 06/10/2026. Dự án: `C:\Users\cana2\OneDrive\Desktop\hoadon_auto_clicker_v2\desktop - Copy - Copy\HoaDonNhe`.

## Đã triển khai

- Telegram: `/ai` → **➕ Cấu hình · 3 dòng** → nhập URL, model, API key. Tự tạo tên, lưu/dedupe, xóa tin chứa key, deep test và chọn cấu hình; không yêu cầu map hoặc chuyển thủ công.
- Resolver hỗ trợ OpenAI Chat, Responses, Anthropic và Gemini native. Header/payload/stream được chuyển đúng theo từng giao thức; lưu kết quả theo URL/model/key. Gemini giữ function-call IDs/thought signatures và JSON Schema, Anthropic chuyển tool_use/tool_result; giữ context khi đổi provider.
- Health check bằng chat, stream, tools; probe ảnh/schema khi request cần. Key chỉ được xác thực không được hiển thị như cấu hình đã chạy thành công. Phân biệt quota, hết hạn, model, endpoint/protocol, lỗi tạm thời và thiếu capability.
- Hết ngân sách thử của một request chuyển sang job lưu trong Firebase mã hóa, có cursor, lease, HMAC continuation. Cron mỗi phút tự tiếp tục/phục hồi; không bỏ ứng viên tốt ở cuối danh sách.
- Tự chuyển key → model → URL. Quota chỉ lan sang credential khác model khi phản hồi chứng minh là quota key/account; đọc Retry-After. Không xóa key lỗi; publish/revision/lastKnownGood qua CAS.
- EXE AUTO tự chờ/poll job, giữ câu hỏi/messages, gửi lại khi có cấu hình tốt, cho phép hủy. Metadata cập nhật khi chat mở và từ header revision; MANUAL giữ nguyên cấu hình riêng.
- Sau khi đã stream nội dung, không retry tự động; giữ nội dung dang dở kèm thông báo. Công cụ chỉ thực thi sau khi đọc hoàn chỉnh phản hồi.
- Telegram cập nhật panel thay vì spam tin, có trạng thái, protocol, giờ kiểm tra và giờ thử lại. Giữ Google Script cho bản quyền và cấu hình legacy; không tạo hai nơi cùng quyết định routing.

## PASS giả lập

`tests/ai-automatic.test.cjs`: **14/14 PASS**, dùng key giả và provider giả, gồm:

1. Bốn wire format tự nhận diện tại cùng loại URL proxy, kể cả header sai bị từ chối 401 trước khi tìm được adapter đúng.
2. Native SSE tool arguments và Gemini thought signatures đi qua parser client thật.
3. Cấu hình tốt ở vị trí cuối trong 14 cấu hình: vượt 8 attempts/3 discoveries, tiếp tục qua job, restart manager nhiều lần và EXE tự nhận câu trả lời, giữ messages.
4. Quota model không làm chết cùng key ở model khác; chuyển tiếp giữa model và URL.
5. Toàn bộ hết quota → báo exhausted; đồng hồ giả qua Retry-After → cron tự phục hồi, không deep-test lại pool khỏe mỗi phút.
6. 100 client/100 isolate cùng discovery: một lease, một job dùng chung, một revision.
7. Nhập 3 dòng qua handler Telegram thật của code: tự test/publish, xóa tin đầu vào, panel không chứa full key và giữ trạng thái sau restart.
8. Completion rỗng/SSE lỗi không được coi là khỏe; stream dang dở không retry và chờ routing có thể hủy.
9. Lease của isolate chết hết hạn: tiếp tục cùng cursor; lỗi mạng tạm thời phục hồi bằng cron.
10. Thiếu tools/không hỗ trợ giao thức/model sai được phân biệt, key vẫn được giữ.
11. Job API chặn phiên không hợp lệ; Worker có scheduled handler.
12. Toàn bộ key hết hạn → exhausted đúng; thêm key tốt qua Telegram → AUTO hoạt động lại, không map thủ công.
13. Job READY cũ không còn dùng được: 100 client tạo một job failover mới, không 100 job trùng.

14. Lỗi stream sau khi đã gửi nội dung: giữ phần trả lời, không retry; ghi nhận sức khỏe, chuyển model ở request tiếp theo sau lỗi được xác nhận. Hủy từ client không làm provider bị đánh lỗi.

Regression toàn dự án và kết quả đóng gói được ghi ở phần xác minh cuối bên dưới. Bài skip không được tính PASS.

## PASS dịch vụ thật

- Đã deploy Worker, kèm Cron `* * * * *`. Phiên bản cuối: `7bb51bc3-d6c9-4a3e-8f02-a5e139d6f41f`.
- `/healthz` HTTP 200.
- Telegram API thật chấp nhận panel root/URL/model/key và các nút mới. Route kiểm tra tạm đã được xóa; các mirror đồng bộ.
- Các lần chat/health_ping OpenRouter thật trước đợt này đã thành công; không dùng bằng chứng cũ đó để tuyên bố native Anthropic/Gemini trong đợt này đã chạy dịch vụ thật.

## Chưa xác minh runtime

- Không có credential native Anthropic/Gemini hoặc provider Responses-only để thử thật; các adapter này đã kiểm tra bằng fixture.
- Không thử trực tiếp thao tác nhấn/copy trên điện thoại Telegram. API keyboard và quyền admin/copy riêng đã được kiểm tra.
- Cron logic đã chạy với đồng hồ giả và restart isolate; lịch Cron production được Cloudflare xác nhận khi deploy. Chưa tạo sự cố quota/hết hạn thật trên tài khoản của admin để ép failover.
- Provider free có thể không sẵn sàng hoặc trả rỗng. Hệ thống phân loại/đợi/phục hồi; không thể đảm bảo provider còn quota hoặc luôn online.

## Cách sử dụng

Chạy `release/CN-Tax-Tools-v1.1.4-automatic.exe` một lần để dùng client mới, chọn AUTO—Cloudflare. Sau đó vào Telegram `/ai`, bấm **➕ Cấu hình · 3 dòng** và nhập URL/model/key. Từ đó cấu hình mới, chuyển dự phòng và cập nhật metadata không cần tải lại EXE/làm mới ứng dụng.

Bản này là EXE kiểm thử riêng, không ghi đè Release 1.1.4 đã công bố. Key không được gửi xuống EXE. Phạm vi giao thức ngoài bốn loại nêu trên được báo chưa hỗ trợ.

## Xác minh cuối

- Regression toàn dự án: **993 tests, 986 PASS, 0 FAIL, 7 SKIP**. Log: `backup/ai-automatic/regression-final.log`.
- Build EXE: đủ 80 tài nguyên bắt buộc và 16 tài nguyên minify; OCR mẫu PASS, packaged smoke PASS (20 kiểm tra). Log: `backup/ai-automatic/build-final.log`.
- Kiểm tra trình duyệt chạy từ chính EXE đóng gói: PASS desktop/mobile, gửi tức thời và hàng đợi, ảnh/file, phân tích CSV và xuất Excel, quyền AI, tách dữ liệu công ty, support/CSP. Ảnh: `backup/ai-automatic/ui/ai-desktop.png`, `ai-mobile.png`.
- Artifact: `release/CN-Tax-Tools-v1.1.4-automatic.exe`, 185.314.728 bytes. SHA256: `d88b2e55b0c772223c42c62446da28b2b6ef33c318d664cd403d7cd1b6426773`.
- Worker cuối `7bb51bc3-d6c9-4a3e-8f02-a5e139d6f41f` đã deploy; health HTTP 200. Các mirror khớp source, không còn route chẩn đoán tạm, `git diff --check` PASS.

**Hoàn thành triển khai và các tình huống giả lập bắt buộc.** Phần dịch vụ thật và giới hạn runtime được tách riêng ở trên; không coi fixture là bằng chứng provider thật đã hoạt động.
