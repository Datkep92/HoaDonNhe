# Thay thế hóa đơn hàng loạt

Module xử lý cục bộ, độc lập với kho hóa đơn. Không phát hành hóa đơn và không gửi dữ liệu ra dịch vụ ngoài.

## Đầu vào

- `issued` + `sales`: bảng kê chi tiết hóa đơn đã phát hành + bảng kê bán ra đối chiếu thuế suất.
- `ledger` + `catalog`: sổ chi tiết bán hàng + danh sách hàng hóa đối chiếu theo mã.

Không phụ thuộc tên/thứ tự file; quét các sheet và 50 dòng đầu, tiêu đề tối đa 3 dòng. Mapping dùng alias chính xác; mơ hồ phải chọn. Công thức thiếu giá trị tính sẵn không được chuyển thành 0. Header fingerprint bao gồm thứ tự cột: profile cũ không áp dụng cho cấu trúc khác.

## Cấu trúc

- `mapping.js`: nhận diện, đọc giá trị, kiểm tra mapping và fingerprint.
- `engine.js`: chuẩn hóa, ghép một-một, phân loại, tính lại và kiểm soát xuất.
- `export.js`: mẫu 22 cột và báo cáo riêng.
- `worker.js`: đọc, đối chiếu, xuất trong worker; dừng bằng terminate.
- `service.js`: các lượt trong bộ nhớ, UUID/revision, profile mapping cục bộ.
- `smoke.js`: kiểm tra worker và mẫu thực sự trong EXE.

Mỗi hóa đơn lệch xuất toàn bộ dòng hàng; chỉ dòng lệch tính lại, giữ tổng thanh toán. Dòng chưa đối chiếu/ghép mơ hồ được giữ nguyên khi xác nhận riêng hóa đơn. Lỗi dữ liệu, mã catalog trùng thuế suất khác nhau, chiết khấu/khuyến mại, thiếu số hóa đơn và trạng thái hủy/đã bị thay thế không được bỏ qua bằng xác nhận. Trạng thái chưa rõ cần xác minh riêng.

Thông tin nguồn được ưu tiên hơn giá trị chung; override riêng được ưu tiên nhất. Ngày mới mặc định ngày Việt Nam. Đổi file/mapping/dừng làm kết quả và xác nhận cũ hết hiệu lực.

## API `/api/invoice-replacement/`

Các API dùng phiên localhost hiện có. Không cần MST hoặc database hóa đơn.

- GET `schema`: role, alias, metadata và ngày Việt Nam.
- POST `upload`: `files: [{name, dataBase64}, ...]`, đúng hai file, tối đa 25 MB/file.
- GET `progress?jobId=...`: trạng thái, revision, mô tả nguồn, mapping gợi ý và profile.
- POST `preview`: `{jobId, revision, index, choice:{sheet,start,depth,role}}`; `start` bắt đầu từ 0.
- POST `mapping` / `process`: `{jobId,revision,selections:[{sheet,start,depth,role,fields}],save}`; `fields` ánh xạ trường sang chỉ số cột bắt đầu từ 0. Trả revision mới.
- POST `invalidate` / `stop`: hủy kết quả; stop có thể dừng worker đang chạy.
- POST `metadata`: `defaults`, `newDate` (ISO), hoặc `invoiceId` + `values`.
- POST `confirm`: `invoiceId`, `keep`, `status`; xác nhận gắn với revision của lượt.
- GET `results`: `jobId`, `revision`, `page` (50 hóa đơn/trang), `filter=candidates|all`.
- GET `detail`: `jobId`, `revision`, `invoiceId`.
- POST `export` / `report`: `jobId`, `revision`, `ids`; trả file `.xlsx`.

Các thao tác sau nhận diện phải truyền revision hiện tại. Lượt hết hạn sau một giờ không hoạt động được dọn khi nhập mới; tối đa 4 lượt trong bộ nhớ. Profile lưu riêng tại thư mục dữ liệu ứng dụng, không ghi vào nguồn.

## Kiểm tra

`npm run test:replacement` kiểm tra engine, dữ liệu thực nếu có, API localhost và UI trên Chrome headless. Đặt `REPLACEMENT_FIXTURES` trỏ tới thư mục bộ nguồn để chạy hồi quy ở máy khác. Mốc v2: 257 hóa đơn / 534 dòng / 270 dòng sửa / 171.165.002 đồng trước và sau.

`--smoke-test` kiểm tra thật worker và xuất file từ mẫu nhúng trong EXE. Mẫu hiện tại là `resources/invoice-replacement-misa.xls` do người dùng cung cấp; chưa xác nhận nhập thực tế trên MISA SME. Không coi kiểm tra XLSX/EXE là kiểm tra tương thích SME. Phần mềm/mẫu khác cần cung cấp mẫu nhập cho Admin.
