# HoaDonNhe

`release/HoaDonNhe-v6.exe` là bản Windows x64 chạy bằng Chrome hoặc Microsoft Edge đã có trên máy. EXE không kèm Electron, Chromium hay extension.

## Dùng ứng dụng

1. Mở `HoaDonNhe-v8.exe`. Giao diện mở trong cửa sổ app của Chrome/Edge.
2. Cột trái là **danh sách MST** (có ô tìm kiếm theo tên hoặc MST) và 2 nút **＋ Thêm MST** / **Đăng nhập**. Nút **Thêm MST** mở form nhập **Tên khách hàng – MST – Mật khẩu** rồi lưu vào danh sách (`du_lieu/accounts.json`); lưu xong ứng dụng tự mở bước lấy CAPTCHA để đăng nhập. Menu **⋯** trên mỗi dòng có **Đăng nhập / nhập CAPTCHA**, **Sửa MST** (đổi tên khách, đổi MST — đổi luôn thư mục profile và tiến độ — hoặc đổi mật khẩu), **Xoá mật khẩu đã lưu** và **Bỏ khỏi danh sách**. Chấm màu mỗi dòng: xanh = đang có phiên, vàng = có phiên đã lưu, xám = chưa đăng nhập.
3. **Bấm vào một dòng**: nếu còn phiên thì vào thẳng giao diện chính để tra cứu ngay; nếu hết phiên thì ứng dụng mở form đăng nhập (tên đăng nhập điền sẵn, mật khẩu đã lưu thì chỉ cần gõ mã CAPTCHA).
4. Khi ảnh CAPTCHA xuất hiện, nhập tên đăng nhập, mật khẩu và mã xác nhận rồi bấm **Đăng nhập** (có thể để trống mật khẩu nếu MST đó đã lưu mật khẩu). Nút **Xoá mật khẩu đã lưu** bỏ mật khẩu đã nhớ nhưng vẫn giữ phiên đang đăng nhập. Có nút **Hiện Chrome đăng nhập / Ẩn Chrome đăng nhập** khi cần đăng nhập dự phòng trong trình duyệt.
5. Lần sau chọn MST trong danh sách: ứng dụng dùng lại phiên đã lưu (token + cookie), không cần CAPTCHA cho tới khi cổng thuế hết hạn. Tick **Nhớ mật khẩu cho MST này** thì lần sau chỉ cần gõ mã trong ảnh. Mỗi MST luôn dùng một profile Chrome riêng (`du_lieu/profiles/{MST}`) nên cookie và phiên không lẫn nhau.
5. Chọn **Thư mục lưu (dùng chung cho mọi MST)**: bấm **Chọn thư mục…** để chọn trong máy, hoặc gõ/dán đường dẫn đầy đủ vào ô rồi bấm ra ngoài. Một thư mục duy nhất cho toàn bộ MST, được ghi nhớ cho lần sau và **không** đổi theo từng lượt tải. Chưa chọn thì bấm **Tra cứu** sẽ báo *"Chọn thư mục lưu hóa đơn trước khi tra cứu."*

6. **Chọn nhanh khoảng ngày**: chọn **Năm** + **Tháng** (hoặc đổi **Chọn nhanh** sang *Theo quý* / *Cả năm*). Chọn quý thì ô Tháng tự ẩn, chọn tháng thì ô Quý tự ẩn; ứng dụng tự điền **Từ ngày — Đến ngày** (ví dụ Năm 2025 + Quý 1 → `01/01/2025 – 31/03/2025`, tháng 2 năm 2024 → `01/02/2024 – 29/02/2024`). Ô **Nhóm hóa đơn** mặc định là **Cả hai nhóm**.

7. EXE chạy **không có cửa sổ terminal**. Muốn thoát: đóng cửa sổ app (app cũng tự thoát khi giao diện ngừng phản hồi 2,5 phút). Nhật ký khởi động/lỗi nằm ở `du_lieu/nhat-ky.log`; lỗi nghiêm trọng hiện thêm hộp thoại.

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

### Xuất Excel danh sách và tránh tải trùng

- Sau khi tra cứu, nút **Xuất Excel theo mẫu MISA** tạo **01 file `.xlsx`** ngay trong thư mục nhánh 2 `MST-<MST>/<Mua_vao|Ban_ra>/` với tên `<từ ngày> - <đến ngày> - <Mua vào|Bán ra>.xlsx` (ví dụ `14-09-2026 - 16-09-2026 - Mua vào.xlsx`) — **không** nằm trong thư mục `xml/pdf/html`. Dữ liệu lấy **từ chính kết quả tra cứu**: không gọi API chi tiết từng hóa đơn, không tải XML/PDF, không tra cứu lại. File giống **đúng file mẫu** `DANH SÁCH HÓA ĐƠN`: sheet `sheet 1`, 2 dòng trống đầu, dòng 3 tiêu đề, dòng 4 “Từ ngày … đến ngày …”, dòng 6 header **19 cột**, dữ liệu từ dòng 7; `Ngày lập` là text `dd/mm/yyyy`, tiền là số, `Tỷ giá` là text `1.0`, `Tổng tiền phí` để trống nếu không có, độ rộng cột theo mẫu. `Kết quả kiểm tra hóa đơn` suy ra từ `ttxly` (5/8 → `Đã cấp mã hóa đơn`, 6 → `Hóa đơn không có mã`).
- Trước khi tải, ứng dụng **quét thư mục đích một lần** rồi đối chiếu từng hóa đơn; tên file là quy tắc xác định (`MST người bán_mẫu số_ký hiệu_số hóa đơn_hậu tố`) nên cùng một hóa đơn luôn là cùng một file. File đã tồn tại thì **không tải lại, không ghi đè, không đổi tên, không tạo file trùng** — và vẫn kiểm tra lại ngay trước mỗi request.
- Dòng thống kê dưới thanh tiến độ: `Tổng … · đã có sẵn … · đưa vào hàng tải … · đã tải … · bỏ qua … · lỗi …`. Dòng hóa đơn có file sẵn hiện **Đã có sẵn – bỏ qua**.

Ba tầng đúng như vậy: thư mục chính `MST-<số MST>` → `Mua_vao`/`Ban_ra` → thư mục theo định dạng file. Bảng Excel nằm luôn trong `Mua_vao`/`Ban_ra` (không có thư mục riêng); file báo cáo của lượt tải nằm ở `MST-…/`. Mọi hóa đơn cùng loại nằm chung một thư mục; tên file vẫn giữ `MST người bán_mẫu số_ký hiệu_số hóa đơn_hậu tố`, nên không lẫn nhau và không còn tạo thư mục riêng theo ký hiệu hóa đơn. Nút **Mở thư mục** mở thẳng `MST-<số MST>` của lượt đang xem.

Cookie, Local Storage và dữ liệu phiên của mỗi MST nằm ở `du_lieu/profiles/{MST}`. Danh sách MST không chứa token. Tiến độ tải của mỗi MST nằm ở `du_lieu/jobs/{MST}.json`. Phiên đăng nhập trực tiếp (token + cookie) và mật khẩu đã nhớ nằm ở `du_lieu/secrets/{MST}.json`, được mã hoá theo tài khoản Windows đang dùng nên chép sang máy khác không mở được.

Mật khẩu chỉ được lưu khi người dùng tick **Nhớ mật khẩu cho MST này** và có thể xoá bất kỳ lúc nào bằng nút **Xoá mật khẩu đã lưu**. Nút bỏ MST khỏi danh sách không xóa profile hay tiến độ tải, nhưng có xoá phiên và mật khẩu đã lưu của MST đó. Giữ EXE mới trong cùng thư mục `release` để tiếp tục dùng dữ liệu hiện có.

Cookie và JWT vẫn có thể hết hạn theo cổng thuế. Khi đó chọn MST, bấm **Thêm MST / Đăng nhập** và xác thực lại; tiến độ tải được giữ.

## Kiến trúc

- Node 16 được đóng gói thành một EXE duy nhất bằng `pkg`.
- EXE được vá PE subsystem `3 (console)` → `2 (GUI)` bằng `tools/hide-console.cjs` (đã gộp vào `npm run build`) nên mở app **không hiện cửa sổ terminal**. Vì không còn console: khởi động/lỗi ghi vào `du_lieu/nhat-ky.log`, lỗi nghiêm trọng hiện hộp thoại, và app tự thoát khi cửa sổ giao diện đóng (tiến trình Chrome kết thúc **và** giao diện đã ngừng gọi `/api/state`) hoặc khi giao diện im lặng quá 2,5 phút.
- Chrome/Edge hệ thống chạy với `--user-data-dir` riêng cho từng MST.
- EXE điều khiển tab cổng thuế qua Chrome DevTools Protocol, chỉ bind debug port ở `127.0.0.1`.
- Lệnh API chạy trong ngữ cảnh trang cổng thuế, nên giữ cơ chế JWT/cookie giống Chrome đang dùng.
- Phiên đăng nhập trực tiếp (token + cookie) và mật khẩu đã nhớ nằm ở `du_lieu/secrets/{MST}.json`, mã hoá bằng DPAPI theo tài khoản Windows hiện tại (`src/secrets.js`), có đường lui AES-256-GCM theo định danh máy nếu DPAPI không dùng được. Chọn lại MST là dùng luôn phiên đã lưu, không cần mở Chrome hay nhập lại CAPTCHA.
- Request Node tới cổng thuế (`src/tct-api.js`) phải mang bộ header giống Chrome: `User-Agent` + `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform` + `sec-fetch-site/mode/dest` + `Origin`/`Referer` + `request-id`. Đo ngày 18/09/2026: POST thiếu bộ này bị WAF trả HTTP 403 `Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.`; chỉ thêm `User-Agent` hoặc chỉ thêm client hints vẫn bị chặn, phải đủ cả bộ mới tới được ứng dụng.
- `src/pace.js` giữ **nhịp** giữa hai request tới cổng thuế (mặc định 900ms + jitter 300ms, đổi bằng `HOADON_NHIP_MS` / `HOADON_NHIP_JITTER_MS`) và **tự nghỉ** khi cổng trả 429 hoặc 403: 429 nghỉ theo `Retry-After` của cổng, không có thì tăng dần 20s → 40s → 80s… (tối đa 10 phút); 403 đúng thông báo chặn thì nghỉ 10 phút. Cả đường tải qua Node (`src/tct-api.js`) và qua trang cổng thuế (`src/browser.js`) đều dùng chung nhịp này. Cổng thuế trả 429 là **quá nhiều yêu cầu** — VNIT không bị vì nó cũng có "nhịp" và tự nghỉ (`NHIP`, `PHUT_NGHI_MIN/MAX`, chế độ an toàn); bản này trước đây gọi tra cứu/tải liên tiếp không chờ nên bị chặn.
- Không lấy hay thay đổi cookie trong profile Chrome/Edge cá nhân của người dùng.
- Icon/version: **file Setup** mang icon + thông tin version; khi cài, installer đặt thêm `HoaDonNhe.ico` cạnh app và trỏ shortcut Desktop/Start Menu + mục gỡ cài đặt vào icon đó. Không gán icon trực tiếp vào app EXE vì `rcedit` ghi lại PE resource làm hỏng snapshot nhúng của `pkg` (EXE báo `Pkg: Error reading from file`).

## Build

```powershell
npm install
npm test
npm run smoke
npm run build          # -> release/HoaDonNhe-v<version>.exe  (payload, đã ẩn console)
npm run installer      # -> release/HoaDonNhe-Setup-v<version>.exe (+ .sha256, RELEASE_NOTES.md)
npm run test:browser   # cần Chrome thật: kiểm tra CSP/đăng nhập/CAPTCHA
node tests/browser-regression.js release/HoaDonNhe-v1.0.0.exe
```

`npm run smoke` kiểm tra server và việc tìm Chrome/Edge. `npm test` kiểm tra phân trang, XML ZIP, resume, chống trùng, tạm dừng và cách ly tài khoản. Cần đăng nhập thật để kiểm chứng API GDT cho từng MST.

Kiểm thử trình duyệt dùng Chrome thật và profile tạm riêng để kiểm tra CSP, API localhost, form đăng nhập, CAPTCHA, báo lỗi và xóa mật khẩu. Phần xác thực dùng dữ liệu mô phỏng, không dùng tài khoản thuế thật. Bản v3 sửa CSP thành `connect-src 'self'` để giao diện gọi đúng server nội bộ, đồng thời giữ xác thực phiên localhost.

Bản v6 đóng popup chào mừng của TCT trước khi bấm Đăng nhập, đợi tối đa 60 giây để TCT tải nội dung, và có thêm nút Ẩn/Hiện Chrome ngay bên cạnh danh sách MST. Nút Ẩn chỉ thu nhỏ cửa sổ, không đóng Chrome nên cookie và phiên vẫn giữ nguyên.

## Phát hành (Release)

Chỉ phát hành **một file duy nhất**: `HoaDonNhe-Setup-vX.Y.Z.exe`. Người dùng tải đúng file đó, chạy và chọn một trong hai chế độ:

- **CÀI ĐẶT VÀO WINDOWS** — cài vào `%LOCALAPPDATA%\Programs\HoaDonNhe` (không cần Administrator), tạo shortcut Desktop + Start Menu, có mục gỡ cài đặt trong Windows, có tuỳ chọn chạy ngay sau khi cài.
- **PORTABLE** — chỉ giải nén `HoaDonNhe.exe` vào thư mục người dùng chọn để chạy trực tiếp; không ghi vào Windows, không có gỡ cài đặt.

Cả hai chế độ lưu dữ liệu vào thư mục `du_lieu` **nằm cạnh `HoaDonNhe.exe`**, nên bản Portable mang cả thư mục sang máy khác là dùng được. Cả hai đều KHÔNG cần Node.js/Python/Chromium/dependency ngoài: app dùng **Google Chrome hoặc Microsoft Edge** có sẵn trên máy (Edge có sẵn trong Windows 10/11); installer kiểm tra và nhắc nếu máy thiếu cả hai. Bản build hiện tại là **Windows 64-bit (x64)** (pkg target `node16-win-x64`).

Chạy im lặng (tuỳ chọn, cho triển khai script):

```powershell
HoaDonNhe-Setup-vX.Y.Z.exe /S /PORTABLE /D="C:\ThuMuc\HoaDonNhe"   # giải nén, không shortcut/gỡ cài đặt
```

### Phát hành bằng GitHub Actions

Workflow `.github/workflows/release.yml` chạy khi push tag dạng `vX.Y.Z` trên runner `windows-latest`:

```powershell
node tools/set-version.cjs 1.0.1   # (tuỳ chọn) đồng bộ version ở máy, nên commit cùng
npm test                           # kiểm tra trước khi tag
git add -A
git commit -m "release v1.0.1"
git tag v1.0.1
git push origin main
git push origin v1.0.1
```

Workflow tự làm: checkout → cài dependency → **đồng bộ version theo tag** → chạy test → build app EXE (`npm run build`) → cài NSIS → đóng gói Setup (`npm run installer`, nhúng payload + tính SHA-256) → tạo GitHub Release và upload `HoaDonNhe-Setup-vX.Y.Z.exe` kèm file `.sha256`. Không cần build tay trên máy cá nhân.

### Version

`src/version.js` là nguồn version trong repo; `node tools/set-version.cjs X.Y.Z` đồng bộ nó với `package.json` và `package-lock.json`. Workflow tự chạy lệnh này theo tag trước khi build, nên app, file Setup và tên file Release luôn khớp tag.

### Kiểm tra bản mới

App đọc bản phát hành mới nhất trên GitHub Releases (endpoint `/api/update`, chỉ đọc) và hiện nhãn **Có bản mới vX.Y.Z** ở cột trái nếu có; bấm vào sẽ mở trang Release. **Không có updater tự động ghi đè EXE đang chạy** — người dùng tự tải bản mới. Tắt kiểm tra bằng biến môi trường `HOADON_NO_UPDATE_CHECK=1`.
