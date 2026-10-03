# CN Tax Tools v1.1.2 — ghi chú phát hành

> File này được commit vào repo nên CI luôn đọc được (thư mục `release/` bị .gitignore).
> Cố ý **không** ghi SHA-256 ở đây: NSIS đóng timestamp nên mỗi lần build ra hash khác nhau.
> Hash thật do `npm run installer` ghi vào `release/*.sha256`, workflow tính lại lúc build.

Bản này gom toàn bộ công việc của các phiên trước (chưa từng phát hành) vào một bản hoàn
chỉnh, kèm các lỗi khiến tính năng **chết trong khi giao diện vẫn báo bình thường**.

## Tính năng

### PDF gốc của nhà cung cấp (mục 3)

Phân biệt rõ **bản gốc có chữ ký số của NCC** với bản app dựng lại. Trước đây cột bấm được
nhưng bấm xong không có gì xảy ra — giờ chạy thật:

1. Mở cổng tra cứu của NCC trong **cửa sổ Chrome riêng** của app (profile
   `profiles/ncc-portal`) — không phụ thuộc phiên đăng nhập cổng thuế, không đụng cửa sổ
   Chrome cổng thuế đang mở.
2. Runner điền sẵn các trường từ dữ liệu XML (`#CodeTax`, `#Pattern`, `#Serial`, `#InvNo`,
   `#nameCus`, `#strFkey`; Viettel gộp ký hiệu + số và ngày `dd/MM/yyyy`).
3. Người dùng làm CAPTCHA → app tự tải PDF → kiểm chữ ký `%PDF-` → ghi `invoices.original_pdf`.
4. Cột chuyển sang xanh, xem PDF ngay trong app.

Hỏi bổ sung mã tra cứu / URL cổng ngay trong app khi thiếu, rồi **lưu vào kho** — lần sau bấm
là có, không hỏi lại. Tự ghép file trong `pdf-goc/` với hoá đơn theo khoá 4 trường; đường
dẫn lưu tương đối nên dời cả thư mục lữ không hỏng.

**Không tự giải CAPTCHA ở cổng nào** — phần đó giao lại cho người dùng.

### Cảnh báo nguồn gốc trên mọi trang in (mục 1)

File `.pdf` trong `pdf/` là app **dựng lại** từ JSON của cổng thuế, không có chữ ký số của
NCC. Mọi trang in giờ có dải cảnh báo ở chân trang, không tắt được — tắt được thì người dùng
lại nộp nhầm bản không chữ ký. Đối chiếu trên 86 hoá đơn thật: 178 trang, **không đổi số
trang**, đúng 1 dải mỗi trang.

### Cột tra cứu nhà cung cấp (mục 2)

Đọc `<MSTTCGP>` và `<TTKhac>` từ XML gốc. Không nhập bảng tra 1279 dòng (chỉ phủ 2/11 người
bán trong hồ sơ thật) và **không bịa URL nào** — chỉ dùng những gì XML thật sự có.

### Bảng kê khai thuế GTGT theo quý (mục 4.2)

Gom theo (hoá đơn, mức thuế suất) **trước khi cộng** — cộng `SUM(tien_truoc_thue) GROUP BY
thue_suat` sẽ nhân đôi hoá đơn nhiều dòng. Phân biệt "không chịu thuế" với "chưa đủ dữ liệu".

## Sửa lỗi

### Bịa mã tra cứu từ số cổng

Bản cũ lấy `;817501;` trong URL làm mã tra cứu. Kho thật bác bỏ: ba hoá đơn liên tiếp
11922/11923/11924 có "mã" 817501/817502/817503 — đó là **CỔNG**; mã VNPT thật dài như
`pc5P7639265106584137312289813`. Bịa ở đây làm app tưởng đã đủ điều kiện tải PDF rồi hỏi
người dùng một thứ họ không có.

Schema **v14** dọn dữ liệu bẩn: chỉ xoá mã **bằng đúng** đoạn cổng trong URL. Thử trên bản
sao kho thật: v13 → v14, 271 hoá đơn giữ nguyên, 9 mã → 6 mã (xoá đúng 3), cột cổng tra
cứu không đổi, còn 0 mã trùng cổng.

### "Đã mở…" là lời nói dối

Route trả `opened: openPortal(url)` **không `await`**. Hàm async trả `Promise`, JSON hoá
thành `{}`, mà `{}` là truthy ⇒ giao diện **luôn** báo "Đã mở …" kể cả khi hỏng. Người
dùng bấm xong không thấy gì mà vẫn tin là đã mở. Nay trả boolean thật kèm lý do.

### Toàn bộ `data-ui.js` chết vì một dòng

`data-ui.js` là **một IIFE**: một dòng gắn sự kiện cho phần tử không tồn tại ném `TypeError`
ngay ở cấp IIFE, khiến **mọi thứ khai báo phía dưới** không được đăng ký. Phần Mục 3 nay
gắn qua `bindOrig()` có kiểm tra.

### Tab đổi ĐVTH chết âm thầm

`src/data/dvt-converter.js` khai `normalizeTenHang` trùng với phần import ⇒ `SyntaxError` ⇒
cả module không nạp được. Lệnh build chỉ in cảnh báo Babel rồi **vẫn xuất exe** và báo
"đủ 56/56 file"; `npm test` cũng xanh vì không test nào nạp file đó.

Cùng file còn có `const tyLe = Number(tyLe)` (khai trùng tham số) và gọi
`require('./mst-format').normalizeTenHang` trong khi `mst-format` không export hàm đó ⇒
`ten_chuan` ghi vào kho thành chuỗi `"undefined"`.

Thêm `tests/parse-all-src.test.js` để chặn **cả lớp lỗi** "build xanh nhưng module chết".

### Nhãn lý do tự mâu thuẫn

Cột PDF gốc viết câu cố định cho mọi hoá đơn bán ra nên báo "không có mã tra cứu" ngay cạnh
nút "Tra cứu NCC". Nay dựng từ dữ liệu thật.

### Cổng VNPT không mở được

URL ghi dạng `…vn;817501;` — dấu `;` dính vào **tên miền** nên URI không mở được và không
khớp kiểm tra `.vn$`, khiến **mọi** hoá đơn VNPT không mở được cổng. Làm sạch bằng **một**
hàm dùng chung cho lúc đọc XML, lúc lưu, lúc mở cổng và lúc xuất Excel; URL đang tốt thì
giữ nguyên xi.

### Mojibake UTF-8 (Windows-1252)

Trong `src/server.js` và một số file khác.

## Build và kiểm tra

- **Nối toàn bộ 73 file test vào `npm test`.** Trước đó có 5 file đã viết nhưng không được
  chạy, nên `npm test` báo xanh 857 test trong khi bỏ sót — đúng kiểu "xanh giả" nguy hiểm
  nhất. Lệnh nay tự dò thư mục `tests/` nên lần sau thêm file mới cũng không thể quên nối.
- **879 test · 877 pass · 0 fail · 2 skip** (2 skip là test phụ thuộc dữ liệu thật).
- Thêm kiểm `--smoke-test` **đọc thật** 4 script runner tải PDF gốc bằng đúng đường dẫn
  `provider-download.js` dùng lúc chạy. Trước đó danh sách file bắt buộc không có chúng,
  mà app đọc bằng `fs.readFileSync` lúc chạy ⇒ thiếu thì tính năng chết mà build vẫn xanh.

### Bộ kiểm EXE từng xoá mất bản phát hành hai lần

`tools/verify-exe.cjs` quét byte EXE theo **đường dẫn đầy đủ**, nhưng pkg lưu bảng tên
trong gói **phẳng** (chỉ tên file). Nên `provider-reference/generic-runner.js` không trúng
dù file **có** trong gói. Bổ sung 4 script vào danh sách bắt buộc khiến build kết luận thiếu
4/35 rồi **xoá sạch exe** — hai lần, trước khi soi thẳng snapshot mới thấy đủ cả 4 file.

Đã sửa `verify()` thử tên phẳng và cả hai dấu phân cách (Windows), và chuyển sang kiểm lúc
chạy — đọc thật thì đáng tin hơn quét byte.

## Ghi chú pháp lý — đã được báo trước khi commit

`src/provider-reference/` chứa **4 bản sao nguyên văn** của extension tham chiếu:

| File | Kích thước |
| --- | --- |
| `core.js` | 39 KB |
| `generic-runner.js` | 58 KB |
| `misa-runner.js` | 7 KB |
| `provider-registry.js` | 228 KB |

Extension đó **không khai báo giấy phép** trong `manifest` và không có file `LICENSE`. Việc
này đã nêu rõ với chủ sở hữu và chủ sở hữu đã chọn commit, chấp nhận rủi ro. Ghi lại ở đây
để ai đọc lịch sử git sau này cũng thấy, chứ không im lặng.

Ghi chú thứ hai: `.gitignore` của repo có nguyên tắc *"không đưa nguồn extension vào repo —
đã port logic sang `src/bank-pdf.js`"*. Lần này chưa port lại logic mà sao chép thẳng.