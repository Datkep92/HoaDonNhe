# CN Tax Tools — Landing page v2

Trang giới thiệu phần mềm **CN Tax Tools** (ứng dụng Windows hỗ trợ kế toán cho hộ
kinh doanh, doanh nghiệp nhỏ và kế toán dịch vụ).

Trang là **static thuần**: HTML + CSS + vanilla JS, không framework, không build step.

## Cấu trúc

```
landing-v2/
├── index.html            # toàn bộ nội dung + ảnh giao diện dạng SVG inline
├── robots.txt
├── sitemap.xml
├── .nojekyll             # để GitHub Pages không bị Jekyll xử lý
└── assets/
    ├── css/site.css      # design system + layout + responsive
    ├── js/site.js        # menu, reveal, sticky bar, gallery slideshow
    └── img/
        ├── logo.png      # logo thật từ app
        ├── app-icon.png  # icon thật từ app
        └── og-cover.png  # ảnh chia sẻ 1200x630 (render từ make-og.mjs)
```

## Ảnh giao diện

Toàn bộ ảnh trong `index.html` là **SVG inline** (class `.mk`), viewBox `0 0 900 574`,
`preserveAspectRatio="xMidYMid meet"` nên sắc nét ở mọi kích thước màn hình.

- Hero + các khối `.frow` dùng bố cục 2 cột (ảnh – chữ).
- Gallery `#xem-truoc` là slideshow 8 tab, dùng chung khung `.gal-screen` với
  `aspect-ratio: 900/574` để khung không nhảy khi đổi tab.

Đổi ảnh ⇒ sửa trực tiếp nội dung `<svg class="mk">` tương ứng trong `index.html`.
Nếu muốn sinh lại ảnh OG:

```bash
node make-og.mjs <thư-mục-landing-v2> og-cover.svg
npx @resvg/resvg-js-cli og-cover.svg <thư-mục-landing-v2>/assets/img/og-cover.png
```

## Gallery (`.gal`)

Được điều khiển bởi IIFE `gallery()` trong `assets/js/site.js`:

- đổi tab bằng click, phím `←` / `→`, hoặc vuốt ngang trên màn hình cảm ứng;
- tự chuyển sau 9 giây, **dừng** khi tab trình duyệt bị ẩn hoặc khi người dùng bật
  `prefers-reduced-motion`;
- mọi selector đều giới hạn trong `#gal` để không đụng phần tử cùng tên ở nơi khác.

## Kiểm tra trước khi deploy

```bash
node check-landing.mjs landing-v2
```

Script kiểm tra: cân bằng thẻ HTML, id trùng, neo nội bộ hỏng, cấu trúc SVG, và các
tài nguyên nội bộ (`src`/`href`) có tồn tại thật không.

## Deploy

`.github/workflows/deploy.yml` đẩy thư mục `landing-v2/` lên GitHub Pages bằng
Actions (không ảnh hưởng workflow `release.yml` của ứng dụng).

URL dự kiến: <https://datkep92.github.io/cntaxtools/>

> Bản landing cũ ở thư mục `landing-page/` được giữ nguyên, không sửa.
