# Đưa trang lên Google Search Console

**Trang đã deploy:** <https://datkep92.github.io/cntaxtools-landing/>
**Repo:** <https://github.com/Datkep92/cntaxtools-landing> (nhánh `master`)

Phần kỹ thuật đã xong hết. Việc còn lại cần bạn đăng nhập Google — làm theo 6 bước dưới, tầm 10 phút.

---

## Bước 1 — Thêm trang vào Search Console

1. Mở <https://search.google.com/search-console>
2. Nếu chưa có tài khoản: bấm **Add property**
3. Chọn loại **URL prefix** (không phải Domain)
4. Dán đúng URL này, có dấu `/` ở cuối:

   ```
   https://datkep92.github.io/cntaxtools-landing/
   ```

5. Bấm **Continue**

---

## Bước 2 — Xác minh quyền sở hữu

Google sẽ đưa ra mã xác minh, ví dụ `abc123XYZ...`.

**Cách khuyến nghị: tạo file HTML** — không phải sửa code, không mất khi deploy lại.

Trong `landing-v4/`, tạo file tên **`google-site-verification.html`**, bên trong **chỉ có đúng mã**:

```
abc123XYZ...
```

Không thêm thẻ, dấu chấm, hay dòng nào khác. Rồi báo tôi để tôi deploy giúp.

**Cách thay thế: thẻ meta.** Mở `landing-v4/index.html`, dòng đã để sẵn chỗ:

```html
<!-- <meta name="google-site-verification" content="DAN_MA_XAC_MINH_VAO_DAY"> -->
```

Bỏ comment `<!--` và `-->`, thay chữ `DAN_MA_XAC_MINH_VAO_DAY` bằng mã của bạn.

> **Không dùng được bản ghi DNS TXT** cho địa chỉ `*.github.io` — bạn không sở hữu DNS của
> `github.io` nên không thêm được bản ghi. Chỉ khi mua tên miền riêng mới dùng được cách này.

---

## Bước 3 — Gửi sitemap

Sau khi xác minh xong:

1. Menu bên trái → **Sitemaps** → mục **Sitemaps**
2. Dán:

   ```
   sitemap.xml
   ```

3. Bấm **Submit**

Đã có sẵn `https://datkep92.github.io/cntaxtools-landing/sitemap.xml` — nội dung:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://datkep92.github.io/cntaxtools-landing/</loc>
    <lastmod>2026-09-30</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

> Mỗi lần sửa nội dung trang, nhớ cập nhật `lastmod`.

---

## Bước 4 — Yêu cầu lập chỉ mục

1. Menu **URL Inspection** (ô tìm kiếm ở trên)
2. Dán `https://datkep92.github.io/cntaxtools-landing/`
3. Bấm **Request indexing**

Google sẽ quét và index trong vài ngày. Có thể gửi lại lần nữa sau 1–2 tuần nếu trang có thay đổi lớn.

---

## Bước 5 — Kiểm tra dữ liệu có hiển thị đúng không

Ở tab **Enhancements** (Cải tiến) của Search Console, kiểm tra các mục:

| Mục | Kỳ vọng |
| --- | --- |
| **Breadcrumbs** | Có — đã khai `BreadcrumbList` |
| **Social previews** | Có — ảnh 1200×630 hiện đúng khi dán link vào Facebook/Zalo |
| **Sitelinks** | Chưa có — sẽ tự xuất hiện sau khi Google index |

**Kiểm tra JSON-LD:** dán link trang vào <https://validator.schema.org/> → **Validate URL**.

**Kiểm tra hiển thị Google:** tìm trong Google:

```
site:datkep92.github.io
```

---

## Bước 6 — Theo dõi

| Báo cáo | Xem gì |
| --- | --- |
| **Hiệu suất** (Performance) | Từ khoá nào đưa người vào trang |
| **Trang** (Pages) | Trang nào được index, trang nào lỗi |
| **Trải nghiệm trên trang** (Core Web Vitals) | LCP, CLS, INP — hiện đang tốt |
| **Liên kết bên ngoài** (Links) | Nguồn giới thiệu truy cập |

---

## Những gì đã chuẩn bị sẵn

| Mục | Trạng thái |
| --- | --- |
| `title` (61 ký tự) | ✅ đúng độ dài Google hiển thị |
| `meta description` (146 ký tự) | ✅ |
| `canonical` | ✅ trỏ đúng URL |
| `hreflang` vi-VN + x-default | ✅ |
| `robots.txt` (`Allow: /` + sitemap) | ✅ |
| `sitemap.xml` | ✅ |
| `lang="vi-VN"` | ✅ |
| `meta robots` (index, follow) | ✅ |
| Open Graph đầy đủ + ảnh 1200×630 | ✅ |
| Twitter Card | ✅ |
| JSON-LD: Organization · WebSite · SoftwareApplication · BreadcrumbList | ✅ hợp lệ |
| Favicon PNG + SVG | ✅ |
| `manifest` | ✅ |
| Trang 404 riêng | ✅ |
| LCP image preload | ✅ |
| Lighthouse A11y / Best Practices / SEO | ✅ 1.0 / 1.0 / 1.0 |

---

## ⚠️ Giới hạn của địa chỉ `*.github.io`

Google xếp hạng trang trên `github.io` **rất thấp** — gần như không ai tìm thấy ngoài trừ khi gõ đúng tên.
Nguyên nhân: hàng triệu trang dùng chung một tên miền, Google không tin tưởng domain đó.

Nên kế hoạch thực tế:

1. **Bây giờ** — vào Search Console như trên, để có dữ liệu và theo dõi.
2. **Khi nào có tiền** — mua tên miền riêng, ví dụ `cntaxtools.vn` (~250.000–450.000đ/năm).
3. **Đổi sang domain riêng** — chạy đúng một lệnh:

   ```powershell
   node tools/set-domain.cjs cntaxtools.vn
   ```

   Lệnh này sửa đồng thời `canonical`, `og:url`, `hreflang`, toàn bộ URL trong JSON-LD,
   `robots.txt` và `sitemap.xml` — không sót chỗ nào.
4. Trỏ DNS về GitHub Pages và tạo file `CNAME` chứa tên miền.

Xem mục 3 trong `README.md` để có đủ lệnh.

---

## Bing Webmaster Tools (tuỳ chọn)

Trang này cũng dùng được cho Bing/Edge — Bing đọc chung nhiều tín hiệu với Google:

1. <https://www.bing.com/webmasters>
2. **Import from GSC** — nhập URL trên, đăng nhập bằng tài khoản Google đã dùng.

---

## Mục 7. Trạng thái hiện tại + làm việc bằng CLI

**Đã xong tự động (30/09/2026):**

| Việc | Trạng thái |
| --- | --- |
| Property thêm vào Search Console | ✅ `https://datkep92.github.io/cntaxtools-landing/` |
| Token xác minh đã deploy | ✅ meta tag + file `google-site-verification.html` |
| Tài khoản | `linhnhaxac10@gmail.com` |
| Search Console API | ✅ đã bật trên project `hddt-49af7` |
| Quyền | đang chờ Google xác nhận → sẽ thành `siteOwner` |

**Token đang dùng:** `_ym4zbT-vyDN5vEuqdj5oLXCSZIKvVM84SHVmLxIJL8`

> Token cũ `knzPa5yuyQUsSKowyqsqbovCyIKj5zEBLRiHS1wmMb8` là token dạng DNS của
> property `sc-domain:datkep92.github.io` — **không xác minh được**. Đã thay bằng
> token HTML của property `https://`.

Nên deploy **cả hai** cùng lúc:

| Cách | Vị trí | Ghi chú |
| --- | --- | --- |
| HTML tag | `index.html`, thẻ `<head>` | Cách phổ biến nhất |
| File HTML | `google-site-verification.html` ở thư mục gốc | Chỉ chứa token, không thêm gì; không bị mất khi deploy lại |

Cả hai cùng trỏ một token nên Google đọc được từ đường dẫn nào cũng xong.

### Nếu vẫn chưa xác minh sau 24 giờ

Kiểm tra trực tiếp bằng trình duyệt:

- <https://datkep92.github.io/cntaxtools-landing/google-site-verification.html> — phải hiện đúng 43 ký tự
- Mở View Source trang chủ, tìm `google-site-verification`

Cả hai đúng mà vẫn chưa xác minh thì vào web bấm **Xác minh** lại để xem Google
báo lỗi gì. Thường là do property trong Search Console bị gõ sai (thiếu dấu `/`
cuối cùng) — phải khớp chính xác với `canonical` trong trang.

### Sau khi xác minh xong

Phần còn lại chạy từ terminal — không cần vào web nữa:

```powershell
node tools/gsc.cjs submit               # gửi sitemap
node tools/gsc.cjs status /             # xem đã index chưa
node tools/gsc.cjs perf                 # số liệu 30 ngày
```

> **Lưu ý về `gcloud`:** CLI này quản lý tài nguyên Google Cloud, **không có** lệnh
> Search Console. Nhưng Search Console có REST API, và API cho phép thêm property
> (`sites.add`) — nên toàn bộ thiết lập ở trên đã làm tự động được.
> Riêng bước xác minh thì Google cố tình giữ ở giao diện web, vì đó là chứng minh
> bạn sở hữu trang.

---

## Deploy lại sau này

```powershell
# 1. Sửa trong landing-v4/
# 2. Cập nhật ?v= trong index.html để người dùng tải CSS mới ngay
#    (GitHub Pages cache tài nguyên tĩnh 10 phút)
# 3. Đẩy lên
$stage = "$env:TEMP\cntaxtools-landing"
robocopy landing-v4 $stage /E /NFL /NDL /NJH /NJS /NP | Out-Null
git -C $stage add -A
git -C $stage commit -m "noi dung thay doi"
git -C $stage push origin master
```

Trang tự lên trong 1–3 phút, không cần workflow (Pages đang phục vụ trực tiếp từ nhánh `master`).

**Kiểm tra tương phản sau khi đổi màu:**

```powershell
node tools/check-contrast.cjs
```

Script kiểm 39 cặp màu chữ/nền ở cả light mode và dark mode, báo FAIL nếu dưới chuẩn WCAG AA.
