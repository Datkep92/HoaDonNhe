# Hồ sơ kiểm tra kế toán

Module độc lập: `service.js` đọc `data.db` bằng kết nối SQLite `readOnly: true`. Không nâng schema, chạy lại đối chiếu ngân hàng hay cập nhật hóa đơn. Dữ liệu kiểm tra nằm riêng trong `<thư mục MST>/Kiem_tra/ho_so.db`.

- `xml.js`: đọc XML có namespace, từ chối DTD/entity, XML không hợp lệ, thẻ metadata trùng, số liệu thiếu. Nhận diện kỳ từ metadata, không từ tên tệp/ngày nộp. Chỉ đối chiếu 01/GTGT theo tháng/quý, các chỉ tiêu `ct23`, `ct24`, `ct34`, `ct35` trong `CTieuTKhaiChinh`. Không dùng chỉ tiêu khấu trừ `ct25`, không cộng dồn tờ khai bổ sung.
- `store.js`: phạm vi theo kỳ, vấn đề và dấu vết chứng cứ, ghi chú/người phụ trách, lịch sử, các bản chốt. Chứng cứ thay đổi hoặc vấn đề xuất hiện lại sẽ mở lại việc cần xử lý. Các bản chốt cũ được giữ nguyên.
- `collect.js`: tác vụ do người dùng bấm, tái sử dụng `TokhaiController` và khóa tác vụ tờ khai hiện có. Cần phiên đăng nhập DVC/TĐT phù hợp. Tải theo ngày nộp; sau tải, lọc tờ khai theo kỳ XML để đối chiếu. CAPTCHA tự giải không được thì hiển thị ô nhập tay. Tiến trình nền tiếp tục khi chuyển tab; sau khởi động lại ứng dụng phải chạy lại, tệp đã tải được giữ nguyên.
- `accounting-review-ui.js/.css`: giao diện riêng trong Tổng quan. Adapter trong `data-ui.js` chỉ phát sự kiện kỳ/tab và cung cấp hàm mở hóa đơn. Thống kê cũ vẫn nằm trong mục có thể mở rộng.

## Quy trình

1. Chọn MST và kỳ ở thanh kỳ chung. Bấm **Kiểm tra hồ sơ** để đọc dữ liệu đã lưu, hoặc đăng nhập ở tab Tải tờ khai rồi bấm **Tải và đối chiếu**.
2. Kiểm tra và xác nhận đủ hóa đơn mua/bán, kể cả kỳ không phát sinh. Xác nhận bị vô hiệu khi dữ liệu hóa đơn chiều tương ứng thay đổi.
3. Chọn phiên bản tờ khai. Nếu chỉ có một phiên bản đúng kỳ, có thể đọc tự động; nhiều phiên bản cần người dùng chọn. Trạng thái “đã nhận” không được coi là chấp nhận. Người dùng có thể ghi tên và nguồn thông báo đã kiểm tra.
4. Xem chênh lệch và chứng từ. Khoản điều chỉnh chỉ thay đổi bộ đối chiếu, yêu cầu giải trình; không sửa dữ liệu gốc. Mục thiếu dữ liệu không được bỏ qua bằng ghi chú. Mục cần xem lại có thể lưu kết luận “đã xử lý/không áp dụng”, kèm người thực hiện và lý do.
5. Chốt kỳ khi dữ liệu hiện tại đã kiểm tra, xác nhận đầy đủ và không còn việc chưa xử lý. Chứng cứ hoặc kết luận thay đổi khiến lần chốt cũ không còn xác nhận cho tình trạng hiện tại.
6. Xuất ZIP trong `Kiem_tra/Xuat_ho_so`. ZIP có chứng từ gốc đúng hồ sơ, bảng đối chiếu, vấn đề, lịch sử đầy đủ và manifest SHA-256. Có thể xuất hồ sơ chưa hoàn tất, trạng thái thiếu phải được ghi rõ. Không gửi ra ngoài.

## Giới hạn được hiển thị

- Đây là đối chiếu số liệu tham khảo, không tự xác định kê khai sai, điều kiện khấu trừ, nghĩa vụ thuế hay đã thanh toán.
- XML không có tiền thuế/tiền trước thuế không tự điền 0. Cấu trúc tờ khai chưa nhận diện báo chưa hỗ trợ. Hiện chưa có XML tờ khai thật trong checkout để xác nhận mọi phiên bản; kiểm thử dùng XML mô phỏng có cấu trúc được hỗ trợ.
- Kho cũ không lưu đường dẫn sao kê gốc. Người dùng có thể bổ sung bản gốc Excel/CSV/PDF (tối đa 13 MB), ghi người thực hiện và ngân hàng/tài khoản/kỳ đã kiểm tra. Module lưu bản sao riêng, không nhập thêm giao dịch. Nếu SHA-1 khớp tệp đã nhập thì ghi nhận liên kết; nếu không thì ghi rõ do người dùng xác nhận, chưa xác minh khớp dữ liệu ngân hàng. ZIP chỉ ghi `bankOriginalsIncluded:true` khi thực sự có bản gốc bổ sung, đồng thời có bảng giao dịch đã nhập.
- PDF được yêu cầu theo phạm vi người dùng chọn. Đường dẫn chứng từ ngoài thư mục MST và liên kết ra ngoài bị từ chối. ZIP có XML thuộc MST khác không được đóng gói vào hồ sơ này.
- Giới hạn: XML 8 MB, đọc ZIP tờ khai 32 MB/100 XML, gói hồ sơ 250 MB. Không giải nén ZIP vào hệ thống tệp.

## Kiểm thử

`npm run test:accounting-review` kiểm tra module và adapter HTTP thực. `npm run test:accounting-review:browser` kiểm tra DOM thực, SQLite và ZIP bằng Chrome headless với profile/dữ liệu riêng. Không dùng tài khoản thuế thật hoặc dừng Chrome của người dùng.
