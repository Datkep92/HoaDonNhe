# CN Tax Tools

Ứng dụng Windows x64 tra cứu và tải hóa đơn điện tử từ cổng thuế, chạy bằng **Google Chrome hoặc Microsoft Edge** đã có trên máy; bản phát hành **không kèm Electron, Chromium hay extension**.

## Tải và cài bản mới nhất

- Trang tải: <https://github.com/Datkep92/HoaDonNhe/releases/latest>
- `Datkep92/HoaDonNhe` là **một repo công khai duy nhất**: chứa cả **mã nguồn** lẫn **Releases**. App tự cập nhật đọc đúng repo đó (`src/version.js` > `repository`), nên link tải và self-update luôn khớp nhau — xem *Một repo công khai: mã nguồn + phát hành*.
- Người dùng chỉ cần **một file**: `CN-Tax-Tools-Setup-vX.Y.Z.exe` (tải kèm `…exe.sha256`). Chạy file đó rồi chọn **CÀI ĐẶT VÀO WINDOWS** hoặc **PORTABLE** — xem mục *Phát hành (Release)* bên dưới.
- Kiểm file trước khi cài (tuỳ chọn):

  ```powershell
  (Get-FileHash .\CN-Tax-Tools-Setup-vX.Y.Z.exe -Algorithm SHA256).Hash.ToLower()  # so với nội dung file .sha256
  ```

- App **tự kiểm tra bản mới mỗi lần mở** và tự cập nhật — **không cần chạy lại Setup** (mục *Tự cập nhật (self-update)*).

## Dùng ứng dụng

1. Mở **CN Tax Tools** (shortcut Desktop/Start Menu sau khi cài, hoặc `CN-Tax-Tools.exe` ở bản Portable). Giao diện mở trong cửa sổ app của Chrome/Edge.
2. Cột trái là **danh sách MST** (có ô tìm kiếm theo tên hoặc MST) và 2 nút **＋ Thêm MST** / **Đăng nhập**. Nút **Thêm MST** mở form nhập **Tên khách hàng – MST – Mật khẩu** rồi lưu vào danh sách (`du_lieu/accounts.json`); lưu xong ứng dụng tự mở bước lấy CAPTCHA để đăng nhập. Menu **⋯** trên mỗi dòng có **Đăng nhập / nhập CAPTCHA**, **Sửa MST** (đổi tên khách, đổi MST — đổi luôn thư mục profile và tiến độ — hoặc đổi mật khẩu), **Xoá mật khẩu đã lưu** và **Bỏ khỏi danh sách**. Chấm màu mỗi dòng: xanh = đang có phiên, vàng = có phiên đã lưu, xám = chưa đăng nhập.
3. **Bấm vào một dòng**: nếu còn phiên thì vào thẳng giao diện chính để tra cứu ngay; nếu hết phiên thì ứng dụng **tự giải CAPTCHA và đăng nhập** (tên đăng nhập điền sẵn; MST đã lưu mật khẩu thì không phải gõ gì).
4. **Ứng dụng tự giải CAPTCHA — không phải gõ mã.** Khi đăng nhập, app tự lấy ảnh CAPTCHA từ cổng thuế, đọc mã bằng mô hình nhận dạng **nhúng sẵn trong EXE và chạy ngay trên máy** (không gửi ảnh đi đâu), rồi gửi đăng nhập; đọc sai thì tự lấy ảnh mới và thử lại (tối đa 5 lần). Bạn chỉ cần **mật khẩu**: đã lưu (tick **Nhớ mật khẩu cho MST này**) thì bấm là vào, chưa lưu thì nhập mật khẩu một lần trong form **Đăng nhập**. Muốn tự tay nhập mã hoặc đăng nhập dự phòng trong trình duyệt thì dùng **Hiện Chrome đăng nhập / Ẩn Chrome đăng nhập**. Nút **Xoá mật khẩu đã lưu** bỏ mật khẩu đã nhớ nhưng vẫn giữ phiên đang đăng nhập.
5. Lần sau chọn MST trong danh sách: ứng dụng dùng lại phiên đã lưu (token + cookie), không cần CAPTCHA cho tới khi cổng thuế hết hạn. Tick **Nhớ mật khẩu cho MST này** thì lần sau app tự giải CAPTCHA và đăng nhập, không phải gõ gì. Mỗi MST luôn dùng một profile Chrome riêng (`du_lieu/profiles/{MST}`) nên cookie và phiên không lẫn nhau.
5. Chọn **Thư mục lưu (dùng chung cho mọi MST)**: bấm **Chọn thư mục…** để chọn trong máy, hoặc gõ/dán đường dẫn đầy đủ vào ô rồi bấm ra ngoài. Một thư mục duy nhất cho toàn bộ MST, được ghi nhớ cho lần sau và **không** đổi theo từng lượt tải. Chưa chọn thì bấm **Tải hóa đơn** sẽ báo *"Chọn thư mục lưu hóa đơn trước khi tải."*

6. **Chọn nhanh khoảng ngày**: chọn **Năm** + **Tháng** (hoặc đổi **Chọn nhanh** sang *Theo quý* / *Cả năm*). Chọn quý thì ô Tháng tự ẩn, chọn tháng thì ô Quý tự ẩn; ứng dụng tự điền **Từ ngày — Đến ngày** (ví dụ Năm 2025 + Quý 1 → `01/01/2025 – 31/03/2025`, tháng 2 năm 2024 → `01/02/2024 – 29/02/2024`). Ô **Nhóm hóa đơn** mặc định là **Cả hai nhóm**.

### Một nút "Tải hóa đơn" — bấm một lần là chạy trọn vẹn

Tab **Tra cứu & tải** chỉ còn **MỘT nút**. Nhãn đổi theo trạng thái, và server tự đoán
cần làm gì — người dùng không phải chọn giữa "chỉ tra cứu" và "tải luôn":

| Trạng thái lượt | Nhãn nút | Bấm là |
| --- | --- | --- |
| Chưa có lượt, hoặc đã tải xong | **Tải hóa đơn** | Quét + tải **toàn bộ** hóa đơn trong khoảng ngày đang chọn (mua vào hoặc bán ra, tuỳ ô *Loại*), theo đúng các định dạng đang tick. Hóa đơn **hiện ra ngay khi tải xong từng cái**, không phải đợi hết lượt. |
| Đang chạy | **Ngưng** | Dừng lại, **giữ nguyên tiến độ** để chạy tiếp sau. |
| Lượt còn dở (bị ngắt mạng, 429, ...) | **Tải tiếp** | Chạy tiếp đúng chỗ dừng — chỉ làm phần chưa xong, không quét lại từ đầu. |

Ba nhãn này lấy từ **một hàm duy nhất** (`downloadButtonState()` trong `src/renderer.js`), và
danh sách trạng thái "còn dở" dùng chung với server (`isResumableJob()` trong `src/core.js`) —
nên nút không bao giờ hiện "Tải tiếp" khi server lại coi là lượt mới, hoặc ngược lại.

**Lỗi tạm thời được tự thử lại — không cần bấm lần nữa.** Hoá đơn lỗi *tạm thời*
(`timeout` / `network` / `portal`) được thử lại ngay trong lượt, nghỉ luỹ tiến **5s → 15s → 45s**
(tối đa 3 lần) rồi mới đánh dấu lỗi. Ba loại lỗi sau **không** thử lại từng hóa đơn, vì
làm vậy là sai hoặc vô ích:

| Loại lỗi | Vì sao không thử lại từng hóa đơn | Xử lý thay thế |
| --- | --- | --- |
| `rate_limited` (429) | Cả lượt đều bị chặn — thử lại từng hóa đơn chỉ là **dội thêm request** vào cổng | Lượt dừng, giữ tiến độ; `src/pace.js` tự nghỉ theo `Retry-After` rồi bấm **Tải tiếp** |
| `invalid_xml` | File hỏng, thử lại y hệt cũng hỏng | Giữ nguyên lỗi trên dòng đó, các hóa đơn khác chạy tiếp |
| `auth` (hết phiên) | Phải đăng nhập lại | App tự mở form đăng nhập, xong là bấm **Tải tiếp** |

Cờ này **chỉ bật cho lượt thủ công** của nút này (`autoRetry: true` trong `createEngine()`).
Auto Sync, quét lần đầu MST mới và `retryFailed()` dựng Engine **không** bật — lịch nền giữ
nguyên hành vi cũ. Cấu hình qua biến môi trường: `HOADON_DOWNLOAD_MAX_RETRIES` (mặc định 3),
`HOADON_DOWNLOAD_RETRY_BASE_MS` (5000), `HOADON_DOWNLOAD_RETRY_MAX_MS` (60000).

> Đường `/api/search` và `/api/stream` **vẫn còn** trong server cho Auto Sync / quét lần đầu /
> test, nhưng giao diện **không** gọi tới nữa — mọi thao tác của người dùng đi qua `/api/download`.

7. EXE chạy **không có cửa sổ terminal**. Muốn thoát: đóng cửa sổ app (app cũng tự thoát khi giao diện ngừng phản hồi 2,5 phút). Nhật ký khởi động/lỗi nằm ở `du_lieu/nhat-ky.log`; lỗi nghiêm trọng hiện thêm hộp thoại.

### Quét 10 ngày gần nhất ngay khi thêm khách mới

Thêm khách mới xong là khách **có dữ liệu dùng ngay**, không phải tự bấm tra cứu:

1. Form **Thêm MST** có thêm ô **Thư mục lưu hóa đơn** (dùng chung cho mọi MST). Bấm **Chọn thư mục…** để chọn, hoặc gõ/dán đường dẫn. **Bỏ trống — hoặc bấm Huỷ ở hộp chọn thư mục — thì app dùng mặc định `Documents\CN-invoice`**, không chặn việc thêm MST.
2. Bấm **Lưu vào danh sách** ⇒ app lưu khách rồi **tự động đăng nhập** (giải CAPTCHA hộ).
3. **Đăng nhập thành công** ⇒ app tự tải **10 ngày gần nhất** cho **Mua vào trước, Bán ra sau** (không chạy song song), định dạng **XML**, chạy nền — theo dõi ở thanh tiến độ như mọi lượt tải khác.
4. XML tải về được **tự nhập vào kho dữ liệu**, nên tab **Tổng quan** và **Kho dữ liệu** có số liệu ngay; muốn bảng Excel tổng hợp thì bấm **Tải ngay** như thường.
5. **Đăng nhập thất bại** ⇒ app **không đánh dấu gì**, nên lần đăng nhập sau **vẫn chạy** luồng này.

Các chốt an toàn (chi tiết quyết định nằm ở `src/first-scan.js`):

- **Chỉ chạy MỘT lần cho mỗi MST.** Trạng thái lưu trong `du_lieu/accounts.json` > `accounts[].firstScan`: `pending` → `running` → `done` (hoặc `failed`).
- **Chỉ áp cho MST thêm MỚI từ bản này trở đi.** MST có sẵn trong danh sách không có ô nhớ `firstScan` nên **không** bị quét.
- **Quét lỗi** (mạng/cổng thuế chặn) ⇒ thử lại ở lần đăng nhập sau, nhưng **cách nhau tối thiểu 30 phút** để bấm lia lịa không dội request vào cổng thuế.
- **Không chen ngang**: MST đang chạy tác vụ khác thì nhường; **chưa chọn thư mục lưu** thì hoãn; **chưa được phép dùng** (license/hết hạn) thì không chạy.
- Nhiều khách thêm cùng lúc thì quét **lần lượt từng MST một** (hàng đợi tuần tự dùng chung).
- Tắt app giữa lúc đang quét ⇒ lượt đó ở trạng thái `running`, **không quét lại từ đầu** ở lần mở sau.

### Khoá thư mục lưu — muốn đổi phải xác nhận

Đổi thư mục lưu là app chuyển sang đọc `data.db` và hoá đơn ở **chỗ khác**, nên dữ liệu đã tải ở thư mục cũ **không còn hiện trong app** (Tổng quan, Kho dữ liệu, Sao kê ngân hàng đều đọc thư mục mới). **File không bị xoá** — vẫn nằm nguyên trên đĩa. Chỉ cần gõ nhầm một ký tự là dính, nên:

- **Đã lưu thư mục rồi thì ô đó bị KHOÁ** (nền xám, viền đứt, không sửa được). Nút **Chọn thư mục…** được thay bằng **Đổi thư mục…**.
- Bấm **Đổi thư mục…** ⇒ hiện hộp thoại cảnh báo nói rõ: dữ liệu cũ sẽ không còn hiện trong app, **file không bị xoá**, và muốn thấy lại thì đổi về thư mục cũ. Chọn **Giữ nguyên** thì không đổi gì.
- Chốt này nằm ở **cả server**, không chỉ ở giao diện: gọi `/api/folder` để đổi thư mục mà thiếu xác nhận thì server **từ chối** và giữ nguyên thư mục cũ.
- Trong form **Thêm MST**, nếu đã có thư mục dùng chung thì ô thư mục ở đó cũng bị khoá (thư mục là dùng chung cho mọi MST, đổi ở đó là đổi cho cả app). Chỉ khi **chưa có** thư mục nào thì form mới cho chọn, và bỏ trống thì dùng `Documents\CN-invoice`.

### Tab "Hỗ trợ kế toán" — xuất file nhập vào MISA AMIS

Dùng khi cần **nhập lại hoá đơn bán hàng vào phần mềm kế toán**: tab dọc hoá đơn bán ra trong Kho dữ liệu theo kỳ rồi xuất **file "Mẫu bán hàng" đúng cấu trúc file mẫu MISA** để up thẳng lên AMIS Accounting.

**Cách dùng**

1. Chọn kỳ (**Từ ngày – Đến ngày**, hoặc bấm nhanh *Tháng này / Tháng trước / Quý này / Năm nay*).
2. (Tuỳ chọn) **Nhập danh mục hàng hoá (Danhsach.xlsx)** — file danh mục hàng của công ty. Chỉ dùng để **đối chiếu mã hàng**, KHÔNG phải nguồn số liệu.
3. Bấm **Xem trước & kiểm lỗi** để dọc dữ liệu và xem trước đúng những dòng sẽ ghi ra file.
4. Bấm **Xuất file Mẫu bán hàng (.xls)**.

**Nguyên tắc số liệu**

- **Mọi số liệu lấy từ HOÁ ĐƠN** (số lượng, đơn giá, thành tiền, thuế suất, tên/mã hàng, ĐVT, ngày…). File `Danhsach.xlsx` chỉ để cảnh báo mã hàng lạ.
- **Chỉ hoá đơn BÁN RA còn hiệu lực** — hoá đơn đã bị thay thế / điều chỉnh / huỷ (`tthai` 4/5/6) **không** được nhập lại.
- **Một dòng = một dòng hàng hoá**; các cột chứng từ (A→X) lặp lại trên mọi dòng hàng của cùng hoá đơn.
- **Mã hàng — 3 tầng.** Rất nhiều hoá đơn bán lẻ **để trống cả cột Mã hàng** (đo trên dữ liệu thật: **3.583/34.639 dòng ≈ 10%**), mà MISA lại **bắt buộc** cột này. Cách xử lý, theo thứ tự:
  1. Hoá đơn **có** mã → dùng mã của hoá đơn.
  2. Hoá đơn **không có** mã → **tra TÊN trong danh mục công ty** để lấy **đúng mã**. (Tên trùng nhiều mã thì **không tra** — đoán bừa là gắn sai hàng vào sổ.)
  3. Vẫn không ra mã → **dùng chính TÊN hàng làm mã** (MISA sẽ tạo mặt hàng theo tên này). Đổi được sang **CHẶN XUẤT** bằng ô chọn ở cột lọc, khi đó app báo lỗi và chỉ rõ cách sửa.
     Mọi việc tự điền đều **hiện ra thành cảnh báo kèm số dòng**, không làm ngầm.
- **Dòng ghi chú.** Hoá đơn thật có những dòng **không phải mặt hàng** — không số lượng, không đơn giá, không thành tiền (ví dụ *“Đã giảm 44.267 đồng tương ứng 20% mức tỷ lệ % để tính thuế GTGT theo Nghị quyết số 174/2024/QH15”*, *“(Xuất thành 3 giỏ quà )”*, *“Điều chỉnh thông tin hóa đơn …”*). App nhận ra và đánh dấu **`Là dòng ghi chú` = Có** theo đúng quy ước của MISA, để trống số lượng/đơn giá/thành tiền — **không** coi là lỗi và **không** đẩy câu ghi chú lên thành mặt hàng.
- **Số chứng từ**: mặc định `PT0001`, tăng dần **theo số hoá đơn**, một số cho **mỗi hoá đơn**. Bộ đếm **lưu lại trong `data.db`** nên lượt xuất sau tiếp tục (không quay về PT0001 ⇒ không trùng chứng từ đã nhập). Đổi được tiền tố + số bắt đầu.
- **Mã khách hàng**: cấp tự động `KH0001`, `KH0002`… **ổn định theo TÊN khách** — cùng khách luôn cùng mã (cấp ngẫu nhiên theo từng dòng sẽ khiến MISA tạo **trùng khách hàng** và tách sai công nợ).
- **Phương thức thanh toán** suy từ hình thức thanh toán trên hoá đơn (TM / CK / chưa rõ).
- **Giảm 20% thuế GTGT** suy từ thuế suất (dưới 10% ⇒ `Có`).
- Để **trống** theo yêu cầu: **Địa chỉ**, **Chi tiết giá vốn (AJ→AM)**, Nhóm ngành nghề, Tỷ lệ CK (%). `Mã tra cứu HĐĐT` lấy từ chính file XML nếu có.

**Chốt "bắt buộc đúng"**

- **Còn lỗi thì KHÔNG xuất file.** App kiểm hết ô bắt buộc (`Ngày hạch toán`, `Ngày chứng từ`, `Số chứng từ`, `Mã hàng`, `Số lượng`, `Đơn giá`, `Thành tiền`) và mọi giá trị phải thuộc danh sách chọn của mẫu, rồi hiện **danh sách lỗi** để sửa trước. Mỗi lỗi nêu **số hoá đơn + ký hiệu + ngày + tên khách + số dòng** để tìm ra ngay.
- **8 hàng đầu của file xuất giống hệt file mẫu** (tiêu đề, hướng dẫn, 3 ô gộp nhóm `Y7:AI7` / `AJ7:AM7` / `AN7:AO7` và 41 tiêu đề cột) — app đọc thẳng từ `src/template/mau-ban-hang.xls` chứ không dựng lại tiêu đề bằng tay.
- File ra là **`.xls`** đúng như mẫu, dữ liệu **từ hàng 9**.
- Tên file: `Mau_ban_hang_<MST>_<từ ngày>-<đến ngày>.xls`.

> **Lưu ý trước khi dùng thật:** hãy thử nhập **một file nhỏ** vào MISA trước để xác nhận cách MISA hiểu cột `Số chứng từ` và `Mã khách hàng` đúng như mong đợi.

Cây thư mục tải về (trong thư mục lưu bạn chọn):

```
<thư mục lưu>/
  MST-4500677693/
    Mua_vao/                       ← hóa đơn mua vào
      xml/  pdf/  html/  zip/      ← file hóa đơn theo từng định dạng
      HD-EXCEL-<từ ngày>-<đến ngày>-<mã>.xlsx   ← bảng tổng hợp
      <từ ngày> - <đến ngày> - Mua vào.xlsx     ← Excel danh sách (mẫu MISA)
    Ban_ra/                        ← tương tự cho hóa đơn bán ra
    bao-cao-<mã lượt>.json
```

File trong thư mục định dạng cũ (bản trước ghi phẳng ngay trong `Mua_vao`/`Ban_ra`) vẫn được nhận diện là **đã có** nên không bị tải lại.

### Cửa sổ Chrome tải hóa đơn tự đóng khi tải xong

- Cửa sổ Chrome điều khiển cổng thuế chỉ cần trong lúc tra cứu/tải (và khi xuất PDF). **Tra cứu/tải xong là app tự đóng cửa sổ đó**, không phải tự tắt bằng tay. Nhật ký `du_lieu/nhat-ky.log` ghi rõ: `Đã đóng cửa sổ Chrome tải hóa đơn của MST …`.
- App chỉ tự đóng khi MST đó có **phiên đã lưu** (`du_lieu/secrets/{MST}.json`) — lúc đó mọi request đi bằng Node nên cửa sổ không giữ phiên. Nếu đang dùng phiên nằm ngay trong cửa sổ Chrome (đăng nhập bằng trang thuế, chưa lưu token) thì app **giữ nguyên cửa sổ** để không mất đăng nhập.
- Cần mở lại để xem hoặc nhập tay: bấm **Hiện Chrome đăng nhập** — khi chưa có cửa sổ, nút này mở lại và hiện lên. Lượt tải sau tự mở Chrome ẩn khi cần (ví dụ để tạo PDF).

### File HTML/PDF hóa đơn — dựng giống trang tra cứu của cổng thuế

- `.html` và `.pdf` dùng **cùng một bộ dựng** (`src/invoice-html.js`): Times New Roman, trang A4 210mm, khung viền đôi, **ảnh nền hóa đơn** + dấu **“Signature Valid”** nhúng sẵn dạng `data:` URL, mã **QR** (SVG, sinh bằng `qrcode-generator` trong `src/vendor/qrcode.js`), bảng thuế suất, dòng MCCQT, khối chữ ký số (`nbcks`) — tức là trông như bản chuẩn trên cổng thuế, không còn là trang tự chế.
- Tài nguyên: `src/template/viewinvoice-bg.jpg` + `src/template/sign-check.jpg` (đã khai báo trong `pkg.assets` để exe mang theo). Nếu thiếu ảnh thì HTML vẫn dựng được, chỉ không có nền/dấu chữ ký.
- MCCQT và ngày lập lấy từ detail response của cổng thuế; khi lượt tải **có tải XML** (chọn **XML** hoặc **ZIP**) thì XML gốc là nguồn dự phòng (`<MCCQT>`, `<NLap>`) đúng như luồng API của dự án extension. Chỉ chọn HTML/PDF thì **không** gọi thêm API XML.
- Vì ảnh được nhúng vào từng file nên mỗi `.html`/`.pdf` **nặng thêm ~200 KB**.

### Cột "PDF gốc" — phân biệt bản dựng lại với bản của nhà cung cấp

- Hai thứ này **khác nhau hoàn toàn**, và trước đây ứng dụng gộp làm một:
  - `Mua_vao/pdf/` và `Ban_ra/pdf/` là bản **ứng dụng dựng lại** từ JSON của cổng thuế. Nó **không có chữ ký số của nhà cung cấp**, nên mọi trang đều in kèm dải cảnh báo đỏ ở chân trang (không tắt được — xem `ORIGIN_NOTE` trong `src/data/invoice-a4.js`).
  - **Hoá đơn gốc** là bản PDF **do nhà cung cấp phát hành**, có chữ ký số. Chỉ bản này mới dùng được khi nộp hoặc khi đối chiếu.
- Tab **Kho dữ liệu → Danh sách** có cột **PDF gốc** với ba trạng thái, tất cả đều bấm được ngay trong ứng dụng:

  | Màu | Nhãn | Bấm vào thì |
  | --- | --- | --- |
  | Xanh | Có PDF gốc | Mở PDF **ngay trong ứng dụng** (không mở trình duyệt ngoài) |
  | Vàng | Tra cứu NCC | Hộp thoại: mở cổng tra cứu **trong cửa sổ Chromium của ứng dụng**, hoặc tự chọn file PDF đã tải về |
  | Xám | Chỉ có bản dựng | Hộp thoại hiện **lý do cụ thể** vì sao chưa có bản gốc |

- Ứng dụng **tự ghép** file trong `Mua_vao/pdf-goc/` và `Ban_ra/pdf-goc/` với đúng hóa đơn theo khoá 4 trường (MST người bán · mẫu số · ký hiệu · số hóa đơn) — cùng quy ước đặt tên với file ứng dụng tự tải. Đặt file PDF gốc tải tay từ cổng nhà cung cấp vào đúng thư mục đó là cột chuyển sang xanh ngay, không cần thao tác gì thêm. Ngoài ra mỗi hóa đơn có nút **Bỏ liên kết file này** để gỡ liên kết thủ công.
- **Đã kiểm thật, không giả định:** trong toàn bộ hồ sơ của người dùng, **không nhà cung cấp nào** có đường dẫn trả thẳng file PDF. Cụ thể:
  - **VNPT** (`…vnpt-invoice.com.vn`) — mọi đường dẫn đều bị chuyển hướng về `/Account/LogOn`, tức **bắt buộc đăng nhập**. Ngoài ra URL lưu trong XML có dạng `https://host;817501;` — dấu `;…` dính vào phần tên miền nên URI đó không dùng được.
  - **EasyInvoice** (`…easyinvoice.vn`) — `/` chuyển tới `/Search/Index`, là **trang tra cứu có biểu mẫu**, không phải điểm tải file.
  - Vì vậy ứng dụng **không tự gọi endpoint của bên thứ ba** (dễ vỡ khi bên kia đổi trang, và có rủi ro vi phạm điều khoản dịch vụ). Ứng dụng làm đúng phần nên làm: chỉ ra cổng tra cứu, mở cổng đó **trong cửa sổ của chính ứng dụng** để người dùng nhập CAPTCHA/mã rồi tải, rồi xem lại ngay trong ứng dụng.
- Cột **Cổng tra cứu NCC** trong sheet hóa đơn vẫn giữ (kèm hyperlink bấm được) để đưa cho kế toán. Sheet `Tra cứu PDF gốc NCC` riêng **đã bỏ** — tải Excel ra rồi lại tự mở cổng để xem là vô ích, việc đó nay nằm ngay ở cột trên màn hình.
- Nút **Bổ sung cột tra cứu** trong thanh công cụ Kho dữ liệu đọc lại file XML gốc để điền `MSTTCGP` / cổng tra cứu / mã tra cứu cho những hóa đơn cũ đã nhập trước khi có tính năng. Nút **không chạy tự động** khi mở app hay khi nâng cấp dữ liệu — bấm tay một lần là xong.
- **Bấm vào nút là ứng dụng hỏi luôn** — không bắt người dùng tự tra cứu rồi quay lại. Đúng như bản tham chiếu:
  1. Thiếu **URL cổng** ⇒ mở hộp thoại *Cần URL cổng …*, dán URL ghi trên hóa đơn. Sai định dạng thì báo ngay tại ô nhập, không phải tới lúc mở.
  2. Hóa đơn **mua vào** còn thiếu **mã tra cứu** ⇒ mở tiếp hộp thoại *Cần mã tra cứu …*.
  3. Hóa đơn **bán ra không hỏi mã** — cổng nhà cung cấp tra bằng **số hóa đơn**, hỏi mã là hỏi thừa (và lặp lại ở từng hóa đơn).
  4. Mọi thứ nhập tay đều **lưu vào kho**, lần sau bấm là có ngay, không hỏi lại. Bấm **Hủy** ở bất kỳ bước nào thì luồng dừng, không mở tiếp hộp sau.
- **URL được làm sạch ở mọi nơi** — lúc nhập XML, lúc lưu, lúc mở cổng và lúc xuất Excel, đều dùng chung một hàm. Cần vì XML của VNPT ghi cổng dạng `https://host;817501;`: dấu `;…` bị **dính vào tên miền** nên URI gốc không mở được, và tên miền đó cũng không khớp kiểm tra `.vn$` — nếu không cắt, toàn bộ hóa đơn VNPT sẽ không mở được cổng. URL đang tốt thì **giữ nguyên xi**, không bị "chuẩn hoá" mất dấu `/` cuối.
- **Cột không báo sai:** nút chỉ hiện màu vàng *Tra cứu NCC* khi URL còn dùng được; URL hỏng thì rơi về xám kèm lý do, thay vì báo vàng rồi bấm không mở được gì.
- **Nút bấm không bao giờ "không phản ứng":** phần gắn sự kiện đi qua một hàm kiểm tra phần tử, nên gỡ nhầm một hộp thoại khỏi HTML chỉ in một cảnh báo thay vì làm hỏng cả trang.
### Bảng kê khai thuế GTGT theo quý

- Thẻ **Tổng hợp quý** trong tab Kho dữ liệu tính đúng số liệu kê khai: doanh thu bán ra, tiền trước thuế và tiền thuế mua vào, theo **từng mức thuế suất**, rồi mới cộng vào tổng.
- Cộng dồn theo `(hóa đơn, mức thuế suất)` chứ không theo dòng hàng — hóa đơn nhiều dòng nhiều mức thuế sẽ bị **nhân đôi** nếu cộng `SUM(invoices.tien_truoc_thue) GROUP BY thue_suat`.
- Phân biệt rõ **“không chịu thuế”** với **“chưa đủ dữ liệu”**: hóa đơn không có thuế ghi rõ là không chịu thuế, chứ không để người dùng tưởng là app tính ra 0.
- **Khấu trừ là số nhập tay** — không thể suy ra từ hóa đơn, nên nhãn ghi rõ đó là số nhập, không phải số tính được.
- Bấm **Xuất Excel** ở thẻ này ra một file riêng, không trộn vào workbook của kho dữ liệu.

### Xuất Excel danh sách và tránh tải trùng

- Sau khi tải, nút **Xuất Excel theo mẫu MISA** tạo **01 file `.xlsx`** ngay trong thư mục nhánh 2 `MST-<MST>/<Mua_vao|Ban_ra>/` với tên `<từ ngày> - <đến ngày> - <Mua vào|Bán ra>.xlsx` (ví dụ `14-09-2026 - 16-09-2026 - Mua vào.xlsx`) — **không** nằm trong thư mục `xml/pdf/html`. Dữ liệu lấy **từ chính kết quả tra cứu**: không gọi API chi tiết từng hóa đơn, không tải XML/PDF, không tra cứu lại. File giống **đúng file mẫu** `DANH SÁCH HÓA ĐƠN`: sheet `sheet 1`, 2 dòng trống đầu, dòng 3 tiêu đề, dòng 4 “Từ ngày … đến ngày …”, dòng 6 header **19 cột**, dữ liệu từ dòng 7; `Ngày lập` là text `dd/mm/yyyy`, tiền là số, `Tỷ giá` là text `1.0`, `Tổng tiền phí` để trống nếu không có, độ rộng cột theo mẫu. `Kết quả kiểm tra hóa đơn` suy ra từ `ttxly` (5/8 → `Đã cấp mã hóa đơn`, 6 → `Hóa đơn không có mã`).
- Trước khi tải, ứng dụng **quét thư mục đích một lần** rồi đối chiếu từng hóa đơn; tên file là quy tắc xác định (`MST người bán_mẫu số_ký hiệu_số hóa đơn_hậu tố`) nên cùng một hóa đơn luôn là cùng một file. File đã tồn tại thì **không tải lại, không ghi đè, không đổi tên, không tạo file trùng** — và vẫn kiểm tra lại ngay trước mỗi request.
- Dòng thống kê dưới thanh tiến độ: `Tổng … · đã có sẵn … · đưa vào hàng tải … · đã tải … · bỏ qua … · lỗi …`. Dòng hóa đơn có file sẵn hiện **Đã có sẵn – bỏ qua**.

Ba tầng đúng như vậy: thư mục chính `MST-<số MST>` → `Mua_vao`/`Ban_ra` → thư mục theo định dạng file. Bảng Excel nằm luôn trong `Mua_vao`/`Ban_ra` (không có thư mục riêng); file báo cáo của lượt tải nằm ở `MST-…/`. Mọi hóa đơn cùng loại nằm chung một thư mục; tên file vẫn giữ `MST người bán_mẫu số_ký hiệu_số hóa đơn_hậu tố`, nên không lẫn nhau và không còn tạo thư mục riêng theo ký hiệu hóa đơn. Nút **Mở thư mục** mở thẳng `MST-<số MST>` của lượt đang xem.

Cookie, Local Storage và dữ liệu phiên của mỗi MST nằm ở `du_lieu/profiles/{MST}`. Danh sách MST không chứa token. Tiến độ tải của mỗi MST nằm ở `du_lieu/jobs/{MST}.json`. Phiên đăng nhập trực tiếp (token + cookie) và mật khẩu đã nhớ nằm ở `du_lieu/secrets/{MST}.json`, được mã hoá theo tài khoản Windows đang dùng nên chép sang máy khác không mở được.

Mật khẩu chỉ được lưu khi người dùng tick **Nhớ mật khẩu cho MST này** và có thể xoá bất kỳ lúc nào bằng nút **Xoá mật khẩu đã lưu**. Nút bỏ MST khỏi danh sách không xóa profile hay tiến độ tải, nhưng có xoá phiên và mật khẩu đã lưu của MST đó. Giữ EXE mới trong cùng thư mục `release` để tiếp tục dùng dữ liệu hiện có.

Cookie và JWT vẫn có thể hết hạn theo cổng thuế. Khi đó chọn MST, bấm **Thêm MST / Đăng nhập** và xác thực lại; tiến độ tải được giữ.

## Kiến trúc

- Node 24 được đóng gói thành một EXE duy nhất bằng `@yao-pkg/pkg` (bản `pkg` được duy trì). Runtime bắt buộc là Node 22+ vì tầng dữ liệu dùng module built-in `node:sqlite`.
- EXE được vá PE subsystem `3 (console)` → `2 (GUI)` bằng `tools/hide-console.cjs` (đã gộp vào `npm run build`) nên mở app **không hiện cửa sổ terminal**. Vì không còn console: khởi động/lỗi ghi vào `du_lieu/nhat-ky.log`, lỗi nghiêm trọng hiện hộp thoại, và app tự thoát khi cửa sổ giao diện đóng (tiến trình Chrome kết thúc **và** giao diện đã ngừng gọi `/api/state`) hoặc khi giao diện im lặng quá 2,5 phút.
- Chrome/Edge hệ thống chạy với `--user-data-dir` riêng cho từng MST.
- EXE điều khiển tab cổng thuế qua Chrome DevTools Protocol, chỉ bind debug port ở `127.0.0.1`.
- Lệnh API chạy trong ngữ cảnh trang cổng thuế, nên giữ cơ chế JWT/cookie giống Chrome đang dùng.
- Phiên đăng nhập trực tiếp (token + cookie) và mật khẩu đã nhớ nằm ở `du_lieu/secrets/{MST}.json`, mã hoá bằng DPAPI theo tài khoản Windows hiện tại (`src/secrets.js`), có đường lui AES-256-GCM theo định danh máy nếu DPAPI không dùng được. Chọn lại MST là dùng luôn phiên đã lưu, không cần mở Chrome hay nhập lại CAPTCHA.
- Request Node tới cổng thuế (`src/tct-api.js`) phải mang bộ header giống Chrome: `User-Agent` + `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` + `sec-fetch-site/mode/dest` + `Origin`/`Referer` + `request-id`. Đo ngày 18/09/2026: POST thiếu bộ này bị WAF trả HTTP 403 `Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.`; chỉ thêm `User-Agent` hoặc chỉ thêm client hints vẫn bị chặn, phải đủ cả bộ mới tới được ứng dụng.
- `src/pace.js` giữ **nhịp** giữa hai request tới cổng thuế (mặc định 900ms + jitter 300ms, đổi bằng `HOADON_NHIP_MS` / `HOADON_NHIP_JITTER_MS`) và **tự nghỉ** khi cổng trả 429 hoặc 403: 429 nghỉ theo `Retry-After` của cổng, không có thì tăng dần 20s → 40s → 80s… (tối đa 10 phút); 403 đúng thông báo chặn thì nghỉ 10 phút. Cả đường tải qua Node (`src/tct-api.js`) và qua trang cổng thuế (`src/browser.js`) đều dùng chung nhịp này. Cổng thuế trả 429 là **quá nhiều yêu cầu** — VNIT không bị vì nó cũng có "nhịp" và tự nghỉ (`NHIP`, `PHUT_NGHI_MIN/MAX`, chế độ an toàn); bản này trước đây gọi tra cứu/tải liên tiếp không chờ nên bị chặn.
- `src/first-scan.js` quyết định lượt **quét 10 ngày gần nhất** cho MST mới thêm: cửa sổ ngày theo giờ VN (10 ngày trọn, gồm hôm nay), thứ tự **mua vào → bán ra**, định dạng XML, và **có nên chạy hay không** (4 trạng thái `pending`/`running`/`done`/`failed` lưu ở `accounts[].firstScan` trong `du_lieu/accounts.json`). Module thuần, không phụ thuộc server nên test thẳng được (`tests/first-scan.test.js`). Móc vào **cuối `checkLogin()`** — nơi MỌI đường đăng nhập đều đi qua — nên đăng nhập thất bại không đánh dấu gì, và `/api/state` (vòng poll) không kích hoạt được.
- **Nút tải thủ công tự thử lại lỗi tạm thời** (`autoRetry` trong `src/core.js`, bật riêng cho engine của `createEngine()` — Auto Sync và `runAutoSyncDirection()` dựng engine riêng **không** bật). Chỉ `timeout` / `network` / `portal` được thử lại (`RETRYABLE_DOWNLOAD_TYPES`), nghỉ luỹ tiến 5s → 15s → 45s rồi mới đánh dấu lỗi. `429` / `auth` / XML hỏng **không** thử lại từng hóa đơn — xem bảng ở mục *Một nút "Tải hóa đơn"*; 429 do `pace.js` nghỉ rồi bấm **Tải tiếp**. Lúc nghỉ phải **dừng được** (`sleepInterruptible` nghe `AbortController` của lượt) — bấm Ngưng là dừng ngay, không phải chờ hết thời gian nghỉ. Cấu hình: `HOADON_DOWNLOAD_MAX_RETRIES` / `HOADON_DOWNLOAD_RETRY_BASE_MS` / `HOADON_DOWNLOAD_RETRY_MAX_MS`.
- **`/api/download` là đường DUY NHẤT** của nút tải: server tự đoán theo job — đang chạy thì `pause()`, lượt còn dở (`isResumableJob()` trong `src/core.js`) thì `resume(true)`, còn lại thì `stream()` (tái sử dụng danh sách đã quét nếu `canReuseSearch()` khớp điều kiện). `isResumableJob()` và `downloadButtonState()` trong `renderer.js` dùng **cùng một danh sách trạng thái**, nên nút không bao giờ hiện "Tải tiếp" khi server lại coi là lượt mới. `/api/search` và `/api/stream` **còn** cho Auto Sync / quét lần đầu / test, nhưng giao diện không gọi tới.
- Không lấy hay thay đổi cookie trong profile Chrome/Edge cá nhân của người dùng.
- Icon/version: **file Setup** mang icon + thông tin version; khi cài, installer đặt thêm `CN-Tax-Tools.ico` cạnh app và trỏ shortcut Desktop/Start Menu + mục gỡ cài đặt vào icon đó. Không gán icon trực tiếp vào app EXE vì `rcedit` ghi lại PE resource làm hỏng snapshot nhúng của `pkg` (EXE báo `Pkg: Error reading from file`).

## Build

```powershell
npm install
npm test
npm run smoke
npm run fetch-onnx     # BẮT BUỘC trước build: tải model OCR (~54 MB) vào src/onnx/ — model KHÔNG nằm trong git
npm run build          # -> release/CN-Tax-Tools-v<version>.exe  (payload, đã ẩn console)
npm run installer      # -> release/CN-Tax-Tools-Setup-v<version>.exe (+ .sha256, RELEASE_NOTES.md); cần NSIS
npm run test:browser   # cần Chrome thật: kiểm tra CSP/đăng nhập/CAPTCHA
node tests/browser-regression.js release/CN-Tax-Tools-v<version>.exe
```

`npm run build` **tự chặn bản build khuyết** (đúng lỗi của các bản 1.0.4–1.0.6: EXE phát hành thiếu model OCR nên không giải được CAPTCHA, phải build lại):

1. trước khi đóng gói — thiếu `src/onnx/common.onnx` (54.088.400 byte) hoặc `common.json` (90.092 byte), hoặc sai kích thước ⇒ **dừng ngay**, không đóng gói;
2. sau khi đóng gói — kiểm đủ **toàn bộ file nhúng bắt buộc** (danh sách ở `tools/verify-exe.cjs` > `REQUIRED`, cộng thêm mọi thư viện native quét động trong `node_modules`); thiếu ⇒ **xoá EXE** + báo lỗi;
3. chạy chính EXE vừa build với `--ocr-check` (giải một ảnh CAPTCHA mẫu): không giải được ⇒ **xoá EXE** + báo lỗi.

`npm run fetch-onnx` tải model từ prerelease `ocr-model-v1` của chính repo này (không phải bản phát hành sản phẩm). Chỉ khi cố ý build bản không OCR: `HOADON_ALLOW_NO_OCR=1` — khi đó app sẽ không giải được CAPTCHA.

Repo `Datkep92/HoaDonNhe` là **public**, nên `npm run fetch-onnx` tải model ẩn danh được, không cần token. Nếu sau này chuyển repo sang **private** thì phải đặt token: `GH_TOKEN` (hoặc `GITHUB_TOKEN`) — tool sẽ hỏi GitHub API để lấy file. Workflow đã tự truyền `secrets.GITHUB_TOKEN`, không cần làm gì thêm. Token chỉ gửi tới `api.github.com`, không gửi sang host khi chuyển hướng.

`npm run smoke` kiểm tra server và việc tìm Chrome/Edge. `npm test` kiểm tra phân trang, XML ZIP, resume, chống trùng, tạm dừng và cách ly tài khoản. Cần đăng nhập thật để kiểm chứng API GDT cho từng MST.

Kiểm thử trình duyệt dùng Chrome thật và profile tạm riêng để kiểm tra CSP, API localhost, form đăng nhập, CAPTCHA, báo lỗi và xóa mật khẩu. Phần xác thực dùng dữ liệu mô phỏng, không dùng tài khoản thuế thật. Bản v3 sửa CSP thành `connect-src 'self'` để giao diện gọi đúng server nội bộ, đồng thời giữ xác thực phiên localhost.

Bản v6 đóng popup chào mừng của TCT trước khi bấm Đăng nhập, đợi tối đa 60 giây để TCT tải nội dung, và có thêm nút Ẩn/Hiện Chrome ngay bên cạnh danh sách MST. Nút Ẩn chỉ thu nhỏ cửa sổ, không đóng Chrome nên cookie và phiên vẫn giữ nguyên.

## Phát hành (Release)

Chỉ phát hành **một file duy nhất**: `CN-Tax-Tools-Setup-vX.Y.Z.exe`. Người dùng tải đúng file đó, chạy và chọn một trong hai chế độ:

- **CÀI ĐẶT VÀO WINDOWS** — cài vào `%LOCALAPPDATA%\Programs\CN Tax Tools` (không cần Administrator), tạo shortcut Desktop + Start Menu, có mục gỡ cài đặt trong Windows, có tuỳ chọn chạy ngay sau khi cài.
- **PORTABLE** — chỉ giải nén `CN-Tax-Tools.exe` vào thư mục người dùng chọn để chạy trực tiếp; không ghi vào Windows, không có gỡ cài đặt.

Cả hai chế độ lưu dữ liệu vào thư mục `du_lieu` **nằm cạnh `CN-Tax-Tools.exe`**, nên bản Portable mang cả thư mục sang máy khác là dùng được. Cả hai đều KHÔNG cần Node.js/Python/Chromium/dependency ngoài: app dùng **Google Chrome hoặc Microsoft Edge** có sẵn trên máy (Edge có sẵn trong Windows 10/11); installer kiểm tra và nhắc nếu máy thiếu cả hai. Bản build hiện tại là **Windows 64-bit (x64)** (pkg target `node24-win-x64`).

Chạy im lặng (tuỳ chọn, cho triển khai script):

```powershell
CN-Tax-Tools-Setup-vX.Y.Z.exe /S /PORTABLE /D="C:\ThuMuc\CN Tax Tools"   # giải nén, không shortcut/gỡ cài đặt
```

### Một repo công khai: mã nguồn + phát hành

Bản phát hành nằm **ngay trên `Datkep92/HoaDonNhe`** — cũng chính là nơi chứa mã nguồn:

| Repo | Ai xem được | Chứa gì |
| --- | --- | --- |
| `Datkep92/HoaDonNhe` (**public**) | mọi người | mã nguồn, tag, 4 file trong Releases, prerelease `ocr-model-v1` |

Đây là ràng buộc **kỹ thuật**, không phải chọn cho gọn:

- App trong máy người dùng chỉ biết **một** repo, lấy từ `src/version.js` > `repository` + `releasesUrl` (hiện là `Datkep92/HoaDonNhe`), và **từ chối** mọi URL tải không thuộc repo đó (xem `src/updater.js` và `tests/updater.test.js`).
- Repo phát hành để **private** thì mọi lời gọi API/tải file của người dùng đều nhận **404** ⇒ tự cập nhật hỏng.
- Nên `repository` trong `src/version.js` và repo mà workflow tạo Release **phải luôn là cùng một repo**. `.github/workflows/release.yml` chạy `gh release create` trên chính repo đang chạy workflow, tức `Datkep92/HoaDonNhe` — không có repo phát hành thứ hai, không dùng `RELEASE_REPO`/`RELEASE_REPO_TOKEN`.

Workflow chỉ cần `secrets.GITHUB_TOKEN` (GitHub tự cấp) cho bước tải model OCR — không cần PAT hay secret phụ nào.

**Tải model OCR khi chạy tay:** repo là **public** nên link tải ẩn danh vẫn chạy. Nếu sau này chuyển repo sang private thì phải đặt token `GH_TOKEN` (hoặc `GITHUB_TOKEN`); token chỉ gửi tới `api.github.com`, không gửi sang host khi chuyển hướng.

### Phát hành bằng GitHub Actions

Workflow `.github/workflows/release.yml` chạy khi push tag dạng `cntax-vX.Y.Z` (hoặc `vX.Y.Z`) trên runner `windows-latest`:

```powershell
node tools/set-version.cjs 1.0.9   # (tuỳ chọn) đồng bộ version ở máy, nên commit cùng
npm test                           # kiểm tra trước khi tag (CI cũng chạy lại)
git add -A
git commit -m "release: CN Tax Tools v1.0.9"
git tag -a cntax-v1.0.9 -m "CN Tax Tools v1.0.9"
git push origin main
git push origin cntax-v1.0.9
```

Workflow tự làm: checkout → cài dependency → **đồng bộ version theo tag** → chạy test → **tải model OCR (`npm run fetch-onnx`)** → build app EXE (`npm run build`, có 3 chốt chống bản khuyết ở mục *Build*) → tính SHA-256 cho payload self-update → cài NSIS → đóng gói Setup (`npm run installer`) → **tạo Release trên chính repo `Datkep92/HoaDonNhe`** và upload **cả 4 file** (`CN-Tax-Tools-Setup-vX.Y.Z.exe` + `.sha256`, `CN-Tax-Tools-vX.Y.Z.exe` + `.sha256`); chạy lại cùng tag thì ghi đè file (không lỗi). Không cần build tay trên máy cá nhân. Nếu bước phát hành lỗi, artifact dự phòng vẫn được lưu để tải về.

### Version

`src/version.js` là nguồn version trong repo; `node tools/set-version.cjs X.Y.Z` đồng bộ nó với `package.json` và `package-lock.json`. Workflow tự chạy lệnh này theo tag trước khi build, nên app, file Setup và tên file Release luôn khớp tag.

### Tự cập nhật (self-update)

App đọc bản phát hành mới nhất trên repo khai ở `src/version.js` > `repository` (hiện là `Datkep92/HoaDonNhe`, **công khai**) **một lần khi mở** (hoặc khi bấm kiểm tra lại) — không polling. Nếu có bản mới, một hộp thoại hiện ra:

```
Có phiên bản mới vX.Y.Z
[Cập nhật ngay]   [Để sau]
```

- **Để sau**: không tải gì, app chạy tiếp bình thường.
- **Cập nhật ngay**: tải `CN-Tax-Tools-vX.Y.Z.exe` vào `%TEMP%\CN Tax Tools-update\` (có tiến trình), tải file `.sha256` và so **SHA-256**; chỉ khi khớp mới tiếp tục. Sau đó app tự thay **chính file đang chạy** (backup → thay → kiểm tra → mở lại) rồi tự khởi động lại bản mới. **Không chạy lại Setup.**

Điểm an toàn: app đang chạy **không tự ghi đè chính nó** — nó khởi động bản mới (đã tải + đã xác minh) với cờ `--apply-update` để bản mới làm việc thay thế, rồi thoát. Sai SHA-256, tải lỗi, hay không mở lại được bản mới ⇒ **giữ nguyên bản cũ** (khôi phục từ backup). Chỉ nâng cấp, không hạ cấp. Không đụng tới `du_lieu`, license/device identity, secrets hay dữ liệu hóa đơn. Tắt kiểm tra bằng `HOADON_NO_UPDATE_CHECK=1`; đặt `HOADON_FORCE_UPDATE_CHECK=1` để bật cả khi chạy `--test-server`.

Nếu thư mục ứng dụng không cho ghi, app báo rõ là không thể tự cập nhật và giữ nguyên bản hiện tại (không cần Administrator).

Setup EXE chỉ dùng cho **lần cài đầu tiên** (hoặc repair/uninstall). Mỗi Release phát hành 4 file:

```
CN-Tax-Tools-Setup-vX.Y.Z.exe           <- cài mới / repair
CN-Tax-Tools-Setup-vX.Y.Z.exe.sha256
CN-Tax-Tools-vX.Y.Z.exe                 <- payload cho self-update
CN-Tax-Tools-vX.Y.Z.exe.sha256
```

