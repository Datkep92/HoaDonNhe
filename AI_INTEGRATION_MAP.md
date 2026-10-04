# HoaDonNhe AI — FINAL MASTER audit

Nguồn yêu cầu hiện tại: `HOADONNHE_AI_MASTER_PLAN_FINAL.md`, đọc đủ 1.619 dòng. Các ghi chú `chatai.md` bên dưới là lịch sử, không phải nghiệm thu master.

## Delta và enforcement thực tế

- `src/support.js` là authoritative license service: `enforceLicense()` gọi gateway, `effectiveLicense()` + `blockBadLicense_()` chặn Locked/Expired/device_limit_exceeded. Existing policy dùng thử theo firstInstallAt, offline grace 3 ngày từ lần check thành công; bad state đã biết vẫn chặn. AI không được tạo cache/grace riêng.
- Service hiện trả status/packageType/keyName/expiryAt/trial, không có granular AI entitlements. Không tự suy diễn tier từ packageType. Reuse existing product gate cho capability AI đã có; nếu service trả explicit entitlements thì bắt buộc kiểm tra. Connector/capability mới chưa có enforcement không được tự bật.
- `src/data/sqlite.js` dùng Node SQLite với migrations/backup. AI metadata phải dùng DB riêng và giữ legacy files; không sửa schema invoice/license.
- `src/server.js` có launch/session guard, MST/account lanes, browser lifecycle, update, download SSE, `getAgentServices()`, read DB cache. Tích hợp qua adapter; không thêm debug bypass.
- `src/data/queries.js` cung cấp listInvoices/getInvoice/summary/products; query/generated logic không được dùng connection write của app.
- `src/secrets.js` giữ DPAPI/AES/env backend; context/memory chỉ dùng secret reference, không giá trị credential.
- UI đang có khung rộng/expand, multiline/queue gửi tức thì, file/paste/drop, artifacts/source links. Giữ các sửa lỗi đã kiểm chứng; thêm approval/progress/dataset renderer theo phase.
- Parser/export reuse `resources/xlsx.cjs`, JSZip, Sharp, `src/bank-pdf.js`, PDF.js, export workers hiện có.
- Chat hỗ trợ Cloudflare/Firebase/Telegram tách khỏi AI và giữ nguyên.

## Các gap master chưa được nghiệm thu

1. AI cache license riêng 10 phút, chưa kiểm từng execution.
2. Identity chưa tập trung; provider chưa true streaming.
3. History theo provider, chưa scoped session/memory/references; dataset chỉ sống một lượt.
4. Permission enum chưa phải Permission Engine/bound approval/anti-replay.
5. Chưa có persistent jobs/checkpoints, fingerprint/schema/accounting profiles, generic DB connector/read-only SQL.
6. Chưa kiểm 100k+ rows/40-company isolation, dynamic UI, desktop/external connectors.
7. Python/Shell cloud của yêu cầu trước không phải local-first master: không cấp mặc định, không coi là local executor.
8. Packaged Windows WASM có lỗi shutdown không ổn định: phải sửa và kiểm, không bỏ test để build xanh.

## Migration/checkpoint

Metadata mới có version trong `du_lieu/agent`. Legacy providers/history/exports giữ và backup trước migration. Không tự gán history cũ thiếu companyId cho company hiện tại để reasoning. Giữ provider id/key references khi đổi nhãn. Không sửa license state hoặc dữ liệu gốc. Các abstraction chưa có executor không được ghi PASS.

Gate từng phase nằm ở `AI_MASTER_PHASES.md`. Không coi bản hiện tại production-ready theo master.

## Ghi chú implementation trước master

Triển khai theo `chatai.md` được cung cấp. Chat hỗ trợ dùng `chat-widget.js → /api/support/* → support.js → Cloudflare Worker → Firebase/Telegram` giữ nguyên.

## Các hàm hiện có được bọc thành tool

- `getAgentServices().context()` lấy MST, trạng thái phiên, danh sách tài khoản và `engine.snapshot()` đã lọc → `app.get_state`, `mst.get_selected`, `invoice.download_status`. Context có ngày Việt Nam, phiên bản và trang/bộ lọc được UI gửi; không có secret hoặc DOM hóa đơn.
- `data.queries.listInvoices()` trên kết nối `readDatabase()` của MST đang chọn → `invoice.search`, `data.query`. Truy vấn phân trang 200 dòng, tối đa 20.000 dòng và báo lỗi nếu vượt giới hạn.
- `data.queries.getInvoice()` → `invoice.read`, `invoice.get_items`. Lọc đường dẫn, mã tra cứu và trường nhạy cảm trước khi trả về model; dòng hàng giới hạn 500 và có thông báo cắt.
- `data.queries.summary()` → `invoice.summary`. Dùng đúng quy tắc tính tổng hóa đơn còn hiệu lực của ứng dụng.
- `selectOperation(() => selectAccount(mst), mst)` → `mst.select`. Chỉ chọn tài khoản đã có, kiểm tra MST thực tế sau thao tác.
- `authOperation(checkLogin, mst)` → `account.refresh`. Kiểm tra phiên hiện có; phiên hết hạn yêu cầu đăng nhập trong form ứng dụng, không đưa mật khẩu/token vào model.
- `validateParams()`, `ensureEngineFor()`, `runDetached()`, `target.stream()`, `autoImportAfterDownload()` → `invoice.download`. Tải XML/Excel bằng engine hiện có, chạy nền trong sổ tác vụ chung. Tool chỉ xác nhận bắt đầu, không báo hoàn tất khi còn đang chạy.
- `resources/xlsx.cjs` → `file.export_excel`, `file.export_csv`. Dataset do agent lọc có thể khác các sheet xuất kho dữ liệu sẵn có, nên dùng cùng thư viện XLSX để xuất dataset đó.

## Thành phần mới

- `src/ai/agent.js`: vòng lặp model/tool tối đa 10 lượt và 40 tool calls; lưu lịch sử user/assistant qua `ai-service.js`.
- `src/ai/openrouter-client.js`: backend gọi Chat Completions và native tool calls. Tool tên dấu chấm được ánh xạ thành dấu `__` khi gửi API. Fallback structured JSON khi upstream từ chối tool calling.
- `src/ai/tool-router.js`: kiểm tra registry, schema, quyền, signal và tối đa hai lần thử lại sau một lỗi. Tool không có trong registry và tham số lạ đều bị từ chối.
- `src/ai/tool-registry.js`: phân tích tổng, dấu hiệu trùng, bất thường, xuất file và wrapper chức năng ứng dụng. Không có quyền xóa hoặc ghi dữ liệu gốc.
- `src/ai/dataset-store.js`: dataset nằm local, giới hạn 16 dataset/32 MB mỗi tác vụ; gắn MST, không dùng lại dataset từ tác vụ khác.
- `src/ai/safe-js.js`: QuickJS trong WebAssembly, không cấp Node API hoặc callback host; giới hạn 1,5 giây, 32 MB bộ nhớ, 8 MB input/output và ba lượt mỗi tác vụ.
- `src/ai/audit-log.js`: log tên tool, model, quyền, kết quả và thời gian; không lưu nội dung chat, mã JS, API key hoặc dữ liệu hóa đơn.
- Xuất file trong `du_lieu/ai-exports`, tên vật lý UUID, không ghi đè. Manifest cấp ID cho route tải/xem/mở file. AI không chọn đường dẫn máy tính.

## Những giới hạn thực tế

- Tác vụ agent tối đa 180 giây, signal tool tối đa 15 giây. Wrapper hành động dùng thời hạn/cơ chế chờ của dịch vụ hiện có và kiểm tra hủy trước/sau; không cưỡng bức ngắt phiên đăng nhập hoặc tác vụ tải nền.
- Sau khi bắt đầu tải nền, nút Dừng trong AI chỉ dừng agent. Muốn dừng tải dùng nút Ngưng trong Tra cứu & tải.
- Phát hiện trùng/bất thường là dấu hiệu để đối chiếu, không xóa dữ liệu hoặc tự kết luận pháp lý.
- Phiên hết hạn cần người dùng đăng nhập bằng form hiện có. Không thêm tự động đăng nhập hay điều khiển browser bằng mã model.
- Giai đoạn này gọi OpenRouter trực tiếp từ backend theo cấu hình test. Chưa triển khai AI Worker/rate limit/quota của giai đoạn production; chat hỗ trợ Cloudflare/Firebase/Telegram vẫn dùng gateway hiện tại.
- Cần API key và model đang khả dụng để kiểm tra OpenRouter thật. Test tự động dùng upstream fixture để kiểm tra tool loop, dữ liệu, cô lập JS, xuất file và UI.
