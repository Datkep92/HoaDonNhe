# CN Tax Tools v1.1.5

## Có gì mới

- **Khung Hỗ trợ chung AI/Admin**: một khung chat duy nhất. AI trả lời ngay, admin tiếp quản được bất cứ lúc nào; lịch sử AI và admin ghép theo thứ tự thời gian nên không bị mất tin. Bấm lại nút Hỗ trợ là mở đúng tin mới nhất.
- **Chủ động chọn “Tiếp tục với AI” hay “Đợi gặp admin/support”** khi câu hỏi liên quan bản quyền/key — app hỏi trước, không tự đoán theo từ khoá. Bản quyền hết hạn vẫn liên hệ được admin.
- **Admin tiếp quản / trả lại phiên**: khi admin giữ phiên thì AI tạm dừng ngay và huỷ tác vụ đang chạy; admin gõ `/stop` là AI trả lời tiếp. Người không có quyền admin không thể đóng phiên.
- **AI không lỗ âm thầm**: nếu model cắt ngang giữa chừng, phần đã trả vẫn còn lại kèm lý do thay vì mất trắng; có trạng thái rõ từng bước (đọc yêu cầu → chạy công cụ → tổng hợp → tìm cấu hình AI) và không lộ suy luận nội bộ của model.
- **Chờ AI tự tìm cấu hình nhanh hơn**: app chọn đúng dạng yêu cầu ngay từ đầu, lùi dần tới mức chat thuần thay vì chờ hàng phút; có trần chờ và báo rõ cấu hình nào đang kiểm tra.
- **Thêm adapter provider native**: OpenAI Chat, OpenAI Responses, Anthropic và Gemini, giữ function-call/thought signature và JSON Schema; key chỉ nằm trong header, không lọt vào URL hay nhật ký.
- **Telegram quản trị AI**: `/ai` → **➕ Cấu hình · 3 dòng** (URL, model, key) tự kiểm tra và chọn cấu hình; thêm nút `/stop`, bảng điều khiển cập nhật tại chỗ, deep health check phân loại lỗi và lịch sử kiểm tra.
- **Giữ nguyên toàn bộ chức năng cũ**: tải hóa đơn nhiều MST, XML/PDF gốc, CAPTCHA/OCR, kho dữ liệu, tổng quan, sao kê/đối chiếu, xuất Excel/MISA, tra cứu MST/tờ khai, bản quyền và cập nhật ứng dụng.

## Tải và cập nhật

- Cài mới: tải **CN-Tax-Tools-Setup-v1.1.5.exe** ở phần Assets bên dưới, chọn cài đặt vào Windows hoặc portable.
- Cập nhật thủ công / self-update: **CN-Tax-Tools-v1.1.5.exe** kèm file **.sha256** tương ứng.
- Máy đang dùng từ v1.0.2 trở lên: mở app, app tự báo bản mới rồi tải, tự kiểm SHA-256, thay chương trình và khởi động lại. Dữ liệu trong `du_lieu` được giữ nguyên.
- Yêu cầu: Windows 64-bit (x64), có sẵn Google Chrome hoặc Microsoft Edge. Không cần Node.js/Python/Quyền Administrator.

## Kiểm chứng

- Bộ kiểm thử toàn dự án: **1020 tests — 1013 PASS, 0 FAIL, 7 SKIP** (bài SKIP không được tính PASS).
- Bản build này được Actions tự kiểm trước khi phát hành: đủ tài nguyên nhúng bắt buộc, `--ocr-check` giải đúng ảnh CAPTCHA mẫu, `--smoke-test` tải hết tài nguyên giao diện.
- Báo cáo chi tiết trong mã nguồn: `AI_AUTOMATIC_FLOW_REPORT.md` và `SUPPORT_AI_UPDATE_REPORT.md`.

## Dịch vụ thật và giới hạn

- Worker + Cron đã deploy, `/healthz` trả HTTP 200; Telegram API thật chấp nhận các panel và lệnh `/stop`.
- Adapter Anthropic/Gemini/Responses mới được kiểm bằng fixture — **chưa** có credential native để thử với dịch vụ thật trong đợt này.
- Pool provider free đôi lúc hết hạn mức hoặc chậm; hệ thống tự chuyển dự phòng và tự phục hồi nhưng không thể đảm bảo provider luôn có quota.
- Chưa thử trực tiếp thao tác nhấn/copy trên điện thoại Telegram; API bàn phím và quyền admin đã được kiểm.