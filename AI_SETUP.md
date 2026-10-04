# Sử dụng AI Agent

Mở **Hỗ trợ → AI Agent → Cấu hình**. Mặc định:

- Địa chỉ API: `https://openrouter.ai/api/v1`
- Model: `stealth/space-bunny-alpha`
- Nhập API key rồi Lưu. Key được backend lưu trong kho mã hóa `secrets.js`, không lưu trong JSON provider hoặc trả lại frontend.

Có thể đổi model, endpoint hoặc thêm cấu hình API/Ollama. Endpoint trong hộp cấu hình là base URL, không gồm `/chat/completions`. Model cần hỗ trợ tool calling hoặc structured JSON.

Để test bằng biến môi trường, sao chép `.env.example` thành `.env.local` ở gốc repo (hoặc cạnh EXE) và điền `OPENROUTER_API_KEY`. `AI_API_URL` trong file này là URL đầy đủ có `/chat/completions`. Khởi động lại ứng dụng sau khi đổi `.env.local`. Key lưu trong Cấu hình ưu tiên hơn key môi trường.

Ví dụ:

- “Kiểm tra hóa đơn bán ra tháng 9 năm 2026, tìm hóa đơn nghi trùng và xuất Excel.”
- “Tìm hóa đơn mua vào trên 100 triệu trong tháng này.”
- “Tổng hợp doanh thu và thuế tháng 9, giải thích các khoản cần kiểm tra.”
- “Hóa đơn mua vào gần nhất của nhà cung cấp nào?”

Agent đọc kho dữ liệu của MST đang chọn qua các hàm ứng dụng. Cần có dữ liệu đã nhập/tải; agent báo rõ nếu kho chưa sẵn sàng. Có thể yêu cầu Excel, CSV hoặc báo cáo text. Chat hiển thị link tải, **Mở file**, **Mở thư mục**, **Xem dữ liệu** (50 dòng đầu). Lịch sử chat và link file được giữ khi mở lại ứng dụng.

## Chat mở rộng và file đính kèm

AI hỗ trợ công việc ngoài ứng dụng, ưu tiên thuế doanh nghiệp, kế toán, tài chính, tra cứu văn bản và phân tích tài liệu. Câu hỏi hóa đơn gần nhất có tool riêng. Bộ đọc nhận cả nhiều JSON tool liền nhau, mảng và code fence; lệnh tool không hiện như câu trả lời.

Khung chat mặc định rộng hơn, chữ 14px; kéo cạnh trái để đổi độ rộng hoặc bấm **⤢** để mở rộng. **Enter** gửi, **Shift+Enter** xuống dòng. Bấm Gửi xóa ô soạn và hiện xác nhận ngay; có thể gửi tiếp tối đa 5 tin nhắn chờ trong khi AI xử lý. Dừng hủy lượt hiện tại và các tin chờ.

Đính kèm bằng **Ảnh / File**, kéo thả hoặc dán ảnh. Tối đa 4 file mỗi tin nhắn, 12 MB/file và 24 MB cho 4 file gần nhất trong ngữ cảnh. Hỗ trợ XLSX/XLS/CSV, PDF, DOCX, TXT/MD/JSON/XML, PNG/JPG/WebP. Bảng được đọc local đầy đủ (tối đa 20.000 dòng); văn bản đọc từng đoạn. PDF có chữ được trích xuất local bằng PDF.js (tối đa 200 trang), chỉ văn bản cần đọc đi qua model; không gửi nguyên PDF lên cloud. PDF scan chưa có OCR nhiều trang: gửi ảnh của trang cần phân tích. Ảnh được chuẩn hóa local trước khi gửi model vision. Không đoán chữ/số không đọc được. File có thể được sử dụng trong các lượt tiếp theo, tối đa 4 file gần nhất, trong cùng phạm vi công ty.

Ví dụ: “Đối chiếu file Excel và ảnh chứng từ này, nêu khoản lệch và xuất Excel”; “Đọc báo cáo, lập bảng kiểm tra thuế TNDN”; “Tra cứu quy định VAT áp dụng tháng 10/2026, dẫn văn bản gốc và ngày hiệu lực”.

**Tra cứu web** cấp tool tìm kiếm qua [OpenRouter Web Search](https://openrouter.ai/docs/guides/features/server-tools/web-search). AI ưu tiên nguồn chính phủ/cơ quan thuế/Bộ Tài chính và dẫn URL. Nếu dịch vụ không cung cấp nguồn, tool báo lỗi; không coi kiến thức cũ là quy định đã xác minh.

**Python / Shell local** đang tắt. FINAL MASTER yêu cầu executor local riêng với sandbox, giới hạn tài nguyên, phạm vi file và quyền; chưa đủ điều kiện thì không cấp tool cho model. Adapter cloud thử nghiệm cũ không được đăng ký. JS phân tích hiện chạy trong QuickJS WASM cô lập, không có Node, mạng, filesystem hoặc secrets.

Web hiện dùng endpoint OpenRouter khi bật **Tra cứu web**. Trích đoạn tài liệu, metadata/kết quả phân tích và ảnh đã chọn có thể đi qua nhà cung cấp AI. Kiểm thử dùng upstream mô phỏng; chưa xác minh dịch vụ trả phí bằng key người dùng.

**Dừng** hủy lượt agent và phê duyệt đang chờ. Tác vụ tải đã bắt đầu sau khi được duyệt vẫn thuộc engine tải hiện có; dùng nút **Ngưng** ở tab Tra cứu & tải để dừng tải. **Chat mới** xóa cuộc trò chuyện trong cấu hình và MST hiện tại, thu hồi quyền một lần/phiên chưa dùng, không xóa file hoặc dữ liệu gốc. Lịch sử mới lưu local trong `du_lieu/agent/agent.db`, tách theo provider và MST (hoặc GLOBAL khi không chọn công ty). Lịch sử cũ giữ nguyên và có bản sao không rõ phạm vi; nút **Chat cũ** chỉ đọc, không tự đưa vào context. Job bị gián đoạn khi khởi động lại không tự chạy lại.

License thật được kiểm tra lại trước từng lượt model và tool; AI không có cache hoặc grace riêng. Chọn MST, làm mới tài khoản và bắt đầu tải hóa đơn cần thẻ **Cần bạn phê duyệt**: xem tác động, tham số, công ty rồi Cho phép hoặc Từ chối. Mỗi quyền gắn hash của đúng hành động/phiên bản/phạm vi; thay tham số, công ty, thư mục hoặc nguồn liên quan phải duyệt lại. Quyền một lần không dùng lại được, phê duyệt chờ hết hạn sau 2 phút. Quyền rộng hơn vẫn chỉ cho đúng hành động trong cùng công ty; không cấp full access. Mục **Quyền AI** cho xem và thu hồi. Chọn Always Allow cũng không vượt bản quyền hoặc bật executor bị policy tắt.

Ngữ cảnh gửi model gồm tối đa 12 lượt gần đây (giới hạn 20.000 ký tự), tóm tắt lịch sử local, quy tắc liên quan và tham chiếu file. Chat cũ vẫn tìm được qua `history.search`; bộ tìm hiện dùng FTS và độ liên quan từ khóa, chưa có embedding. “File lúc nãy” được giải thành ID trong session, tồn tại sau restart. Dataset hiện chưa lưu qua lượt: agent phải đọc lại nguồn để tính, không dùng samples hoặc câu trả lời cũ thay cho dữ liệu.

Lưu quy tắc rõ bằng `ghi nhớ VAT dịch vụ: nội dung quy tắc`. Quy tắc mặc định chỉ thuộc MST hiện tại; `ghi nhớ toàn bộ định dạng báo cáo: xuất Excel` áp dụng chung. Ghi lại cùng tên sẽ supersede bản trước; lịch sử correction giữ local. Không tự biến mọi câu chat hoặc tài liệu thành memory, không lưu secrets. Workflow và schema memory được bổ sung trong các phase kế tiếp sau khi có bằng chứng thực thi/kiểm tra tương thích.

Chat hỗ trợ với bộ phận hỗ trợ vẫn hoạt động qua Cloudflare/Firebase/Telegram. Các chế độ AI web miễn phí, iframe và bridge đã bỏ; cấu hình `type:web` cũ tự được loại khi đọc cấu hình, API/local và key riêng được giữ.

## Kiểm tra

- `npm run test:ai`: tool loop, nhiều JSON tool, file đính kèm, Excel, license/key, cloud request/output, migration, fallback, giới hạn và QuickJS.
- `npm run test:ai:browser`: Chrome, dữ liệu SQLite thật, upstream mô phỏng, tìm → JS → Excel → tải/xem file, lịch sử và chuyển lại Hỗ trợ.
- `npm test`: hồi quy toàn dự án.
- `npm run build`, `npm run verify-exe`: đóng gói/xác minh EXE; model OCR lấy bằng `npm run fetch-onnx` nếu chưa có.

Nguồn yêu cầu hiện tại là `HOADONNHE_AI_MASTER_PLAN_FINAL.md`; `chatai.md` chỉ là lịch sử. Xem `AI_MASTER_PHASES.md` để biết gate và phần chưa hoàn thành, `AI_INTEGRATION_MAP.md` để xem adapters thật. Chưa coi bản này hoàn tất master hoặc sẵn sàng production; chưa cấu hình/deploy AI gateway production hoặc gọi OpenRouter thật bằng key người dùng.
