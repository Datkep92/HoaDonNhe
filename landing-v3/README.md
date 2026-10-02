# CN Tax Tools — Landing v3

Trang landing page tinh, thiet ke 2026, toi uu mobile.

## Chay thu

`ash
python -m http.server 8000
# hoac
npx serve .
`

## Cu truc

`
landing-v3/
├── index.html          # Trang chinh
├── assets/
│   ├── css/style.css   # Styles (mobile-first, glassmorphism)
│   ├── js/main.js      # Tuong tac (gallery, menu, download)
│   └── img/            # Anh logo, icon
├── .nojekyll           # Bo qua Jekyll tren GitHub Pages
├── robots.txt
└── sitemap.xml
`

## Deploy len GitHub Pages

1. Push len repo
2. Settings > Pages > Source: main / (root)
3. Truy cap: https://<user>.github.io/<repo>/
