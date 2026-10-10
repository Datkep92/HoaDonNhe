# Bản quyền và chế độ miễn phí

Bản 1.1.7 mặc định chưa công khai thương mại: không giới hạn tính năng và không hiện mua key/hết hạn. Khóa thiết bị của Admin vẫn có hiệu lực. Không tự đổi giá hoặc quyền key cũ.

## Triển khai

1. Chạy `node tools/sync-billing.cjs` khi thay quy tắc dùng chung hoặc extension Apps Script.
2. Đối chiếu và triển khai `support-gateway/apps-script/Code.gs` vào dự án Sheet hiện có bằng `node tools/deploy-apps-script.cjs --script-id <ID> --sheet-id <SHEET_ID> --deployment-id <DEPLOYMENT_ID> --apply`. Script kiểm tra parentId và Web App, tạo bản sao lưu trước khi ghi, giữ nguyên manifest và Deployment ID. Không tạo Sheet/CRM khác để thay thế dự án đang dùng.
3. Triển khai Worker từ `cloudflare-worker/wrangler.jsonc` sau khi Apps Script đã cập nhật. Giữ secrets/bindings đang có; không đưa secrets vào mã hay file phát hành.
4. Kiểm tra bằng thiết bị/key thử nghiệm. Gõ `/billing` trong Topic đã gắn thiết bị để mở menu.
5. Chỉ `/commerce on` mới công bố gói. `/commerce off` mở miễn phí trở lại. Một khoảng sử dụng đầu 30 ngày bắt đầu từ lúc công bố hoặc đăng ký thiết bị mới, lấy mốc muộn hơn.

## Gói

MST10/20/30/50: 50.000/90.000/120.000/150.000đ mỗi tháng cho một máy. Máy thêm cộng 50%; quý giảm 5%; năm trả 10 tháng, dùng 12 tháng theo lịch. Gói trả phí chia sẻ danh sách MST theo key; tài liệu không được đồng bộ giữa máy.

Cơ bản sau hết hạn: 1 MST, được đổi 3 lần tổng cộng (không tính chọn đầu), sao kê 2 lần **mỗi tháng**, xuất file thay thế MISA 1 lần mỗi tháng. Chỉ đếm khi lưu/xuất thành công; thất bại trả lại lượt giữ chỗ. Hạn mức được quản lý phía máy chủ. Gói cũ chưa gán loại mới giữ quyền đến khi hết hạn.

`Plans` quản lý giá. `Orders` và `Quotes` lưu báo giá, yêu cầu và trạng thái duyệt. `KeyEntitlements`, `LicenseMSTs`, `QuotaLedger` quản lý quyền/lượt; `UsageDaily` lưu snapshot thống kê từng bản cài. `AdminAudit` ghi lệnh quản trị. Các bảng mới không thay thế Devices/Licenses/Bindings cũ.

## Lệnh quản trị

Gõ `/billing` trong Topic khách để mở menu nút bấm. Tạo key hoặc đổi gói: chọn MST10/20/30/50 → 30/90/365 ngày → 1/2/3/5/10 máy → xác nhận. Đây là thời hạn theo ngày khi cấp thủ công; đơn mua tháng/quý/năm vẫn tính theo tháng lịch. Đổi gói thủ công đặt lại hạn từ hiện tại, nên kiểm tra thông tin trước khi xác nhận.

Nút công bố thương mại và miễn phí áp dụng toàn hệ thống, có bước xác nhận. Mỗi lần mở `/billing`, Worker cập nhật gợi ý lệnh Telegram cho Admin của nhóm đã cấu hình (tiếng Việt và mặc định), giữ lệnh cũ. Người dùng thường không được cấp quyền qua menu. Nút xác nhận tạo/đổi key đã xử lý không được thực hiện lại. Gia hạn số ngày tùy ý và thay MST vẫn dùng lệnh trong mục Hướng dẫn.

Chỉ thấy menu mới sau khi triển khai cả Apps Script và Worker. Việc sửa mã hoặc chạy tests tại máy không cập nhật bot đang hoạt động. `npm run test:billing-menu` kiểm tra menu, quyền Admin, xác nhận và chống tạo key lặp.

Worker tự khởi tạo bảng và đăng ký lệnh một lần theo revision ở lịch cron; đọc lại menu Telegram trước khi đánh dấu thành công. Menu gợi ý được thu gọn ở ngôn ngữ mặc định và tiếng Việt. Mở Topic của khách rồi gõ `/menu` hoặc `/billing`, dùng các nút thay vì nhớ cú pháp. `/checkdulieu` xem thống kê; `/check` giữ nguyên. Xem quy trình trong [ADMIN_MENU.md](support-gateway/ADMIN_MENU.md). Các nút công khai thương mại và miễn phí nằm trong nhóm toàn hệ thống và cần xác nhận.

## Thống kê sử dụng

EXE gửi snapshot sau 1 phút và mỗi 15 phút, kể cả khi tắt kiểm tra cập nhật. Lỗi gửi ghi vào `du_lieu/nhat-ky.log`. Cần EXE mới; bản cũ không tự có bộ đếm. `UsageDaily` hiển thị số MST, danh sách MST, thời gian tương tác thực tế, lượt yêu cầu tải/tra cứu và số lần nhập sao kê/xuất MISA thành công. `UsageFeatures` ghi chi tiết từng ngày/tính năng/kết quả; gửi lại snapshot không nhân đôi số liệu. Bộ đếm yêu cầu tải không phải số lượng hóa đơn tải thành công. Thời gian tính khi giao diện có focus và có tương tác gần đây. Không gửi mật khẩu, JWT, nội dung hóa đơn hoặc dòng sao kê trong báo cáo này.

CRM đang dùng: Sheet `1AAgGBqZG4SVbTmgd9zvNpfjDwS07lSVxwyw_IIYoJVQ`, Script `1TYH-B-zqjds6jgJVC-T1P90a35pQjP3jRneKF1IQML3HRTQmYLX6iC9H`, Web App `AKfycbyjNfQQw1pxyZ5PNJ4T5u8Q3Yg6J0KC4sBZLsJ8gyeaTKcUsa8YHB4dTdAb7bAnTW6s`. Ngày 10/10/2026 đã triển khai version 15, xác nhận lệnh Admin và bảng thống kê trên máy chủ; `commercial=false`.

Các lệnh cũ giữ nguyên. `/newplan MST10 30 1` cấp gói 30 ngày/1 máy; `/setplan MST20 30 2` chỉnh thủ công có audit. Khách mua thông thường chọn tháng/quý/năm trong app, Admin xem `/orders`, rồi `/approve <mã> paid` sau khi thực sự nhận tiền. `/reject <mã>` từ chối. `/mst`, `/replace_mst <cũ> <mới>`, `/reset_mst_changes`, `/usage` quản lý MST và thống kê.

`/release <version> <nội dung>` lưu bản nháp; `/release publish` công bố; `/release off` thu hồi. EXE chỉ tự tải khi bản GitHub mới nhất trùng phiên bản đã công bố và có payload/hash hợp lệ. Chờ tác vụ/dữ liệu chưa xuất hoàn tất rồi tự cài. Node chạy nguồn không tự thay mã.

## Kiểm tra bàn giao

`npm test`, `node tools/billing-browser-check.cjs`, `npm run build` và verify/smoke EXE. Tests giả lập không chứng minh bot, Sheet thật hay thay EXE trên máy khách đã hoạt động. Cần kiểm tra riêng sau triển khai máy chủ và một lần nâng cấp từ bản EXE cũ.

Hardware ID V2 băm UUID/serial mainboard hợp lệ; ID cài đặt vẫn dùng cho phiên kết nối. Không có serial hợp lệ thì giữ định danh cũ để app hoạt động, nhưng cần Admin xác minh khi cài lại Windows. Không có cơ chế định danh desktop nào trong bản này đảm bảo chống giả lập phần cứng tuyệt đối.
