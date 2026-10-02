'use strict';
// ---------------------------------------------------------------------------
// Kiem tra tuong phan WCAG AA cho cac cap mau chu/nen trong landing-v4.
// Dung sau moi lan doi mau sac:   node tools/check-contrast.cjs
// Tra ve exit code 0 neu tat ca cap dat, 1 neu con cap khong dat.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'landing-v4');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf8');

// --- Doc token mau ---
// Tuong minh: --brand: #087f70;   hoac   --line-2:#d3dde8;
function readVars(selector, scope) {
  const out = {};
  const re = new RegExp(selector + '\\s*\\{([^}]*)\\}', 'g');
  let m;
  while ((m = re.exec(scope))) {
    for (const decl of m[1].split(';')) {
      const i = decl.indexOf(':');
      if (i < 1) continue;
      const k = decl.slice(0, i).trim();
      if (!k.startsWith('--')) continue;
      // cat comment // ... va cat sau dau // trong gia tri
      const v = decl.slice(i + 1).split('//')[0].trim();
      if (v) out[k] = v;
    }
  }
  return out;
}

// Tach phan @media (prefers-color-scheme: dark) ra khoi phan con lai
const iDark = CSS.indexOf('@media (prefers-color-scheme: dark)');
const phanLight = iDark < 0 ? CSS : CSS.slice(0, iDark);
const phanDark = iDark < 0 ? '' : CSS.slice(iDark);

const light = { ...readVars(':root', phanLight) };
const darkVars = readVars(':root', phanDark);
// Rule gan truc tiep cho phan tuong phan (component overrides) phai
// lay tu ca khoi dark, vi no dat o CUOI file va se de len rule light.
const lightVars = { ...light };
for (const k of Object.keys(darkVars)) darkVars[k] = darkVars[k]; // token dark ghi de token light

// Mau hard-code theo tung ched do (rule nao cuoi cung thang)
const HARD = {
  light: [
    ['#9a6414', '--paper-2', 4.5, 'so khoi mau vai trong KPI'],
    ['#9a6414', '--paper', 4.5, 'so khoi mau vai tren nen the'],
    ['#ffffff', '#9a6414', 4.5, 'chu trong khoi "Phai tra"'],
    ['#8a5a12', '#fdf3e0', 4.5, 'nhan "Dang xay dung"'],
    ['#0a7d5f', '#e2f6ee', 4.5, 'nhan trang thai OK'],
    ['#b04a38', '#fcecea', 4.5, 'nhan trang thai loi'],
    ['#3a5ba0', '#e9eefb', 4.5, 'nhan trang thai AI'],
    ['#ffffff', '#0b1a2b', 4.5, 'chu trang tren nen hero toi'],
    ['#9db4ca', '#0b1a2b', 4.5, 'chu phu trong hero toi'],
    ['#a9c0d5', '#122a41', 4.5, 'chu phu tren cot ben slide'],
    ['#93aac2', '#122a41', 4.5, 'chu mo ta cot ben slide'],
    ['#dceaf5', '#0b1a2b', 4.5, 'chu nut "Xem cach cai dat" trong hero'],
    ['#9a6414', '#fffaf0', 4.5, 'tieu de o cam bao SmartScreen (light)'],
    ['#8a5a12', '#fffaf0', 4.5, 'tieu de o cam bao trong hop thoai (light)'],
    ['#d6e4f1', '#122a41', 4.5, 'chu khoi lenh kiem tra ma bam (light)'],
  ],
  dark: [
    ['#d9a45c', '--paper-2', 4.5, 'so khoi mau vai trong KPI'],
    ['#d9a45c', '--paper', 4.5, 'so khoi mau vai tren nen the'],
    ['#05231c', '#d9a45c', 4.5, 'chu trong khoi "Phai tra" (dark)'],
    ['#f0c674', '#2f2410', 4.5, 'nhan "Dang xay dung"'],
    ['#7fe8c4', '#0d2f26', 4.5, 'nhan trang thai OK'],
    ['#f5a99b', '#33191a', 4.5, 'nhan trang thai loi'],
    ['#a8bdf0', '#1a2140', 4.5, 'nhan trang thai AI'],
    ['#05231c', '#4fd6b0', 4.5, 'chu tren nut chinh (dark)'],
    ['#7df3d5', '#0b1a2b', 4.5, 'chu nhan trong hero toi'],
    ['#d9a45c', '#211a0c', 4.5, 'tieu de o cam bao SmartScreen (dark)'],
    ['#f0c674', '#211a0c', 4.5, 'tieu de o cam bao trong hop thoai (dark)'],
    ['#d6e4f1', '#122a41', 4.5, 'chu khoi lenh kiem tra ma bam (dark)'],
  ],
};

const VARP = [
  ['--ink', '--paper', 4.5, 'chu chinh tren nen the'],
  ['--ink-2', '--paper', 4.5, 'chu do hoa tren nen the'],
  ['--muted', '--paper', 4.5, 'chu phu tren nen the'],
  ['--muted-2', '--paper', 4.5, 'nhan nho tren nen the'],
  ['--brand', '--paper', 4.5, 'link tren nen the'],
  ['--brand-ink', '--paper', 4.5, 'chu dac tren nen the'],
  ['--brand-ink', '--mint-soft', 4.5, 'chu dac trong o ghi chu'],
  ['--muted-2', '--bg-2', 4.5, 'nhan nho tren nen nhat'],
  ['--ink', '--bg-2', 4.5, 'chu chinh tren nen nhat'],
  ['--on-brand', '--brand', 4.5, 'chu tren nut chinh'],
];

// Chuan hoa mau: #fff -> #ffffff, #abc -> #aabbcc
const hex = c => {
  if (typeof c !== 'string') return null;
  let s = c.trim().toLowerCase();
  const m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return '#' + s;
};

const lum = h => {
  const f = i => { const v = parseInt(h.slice(1 + i, 3 + i), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

let fail = 0, unknown = 0;
for (const mode of ['light', 'dark']) {
  const v = mode === 'light' ? lightVars : darkVars;
  console.log('\n================ ' + mode.toUpperCase() + ' MODE ================');
  const rows = [
    ...VARP.map(([a, b, n, m]) => ({ fg: v[a], bg: v[b], need: n, m })),
    ...HARD[mode].map(([a, b, n, m]) => ({ fg: a, bg: v[b] || b, need: n, m })),
  ];
  for (const r of rows) {
    const fg = hex(r.fg), bg = hex(r.bg);
    if (!fg || !bg) {
      unknown++;
      console.log(`  ??  khong doc duoc mau  ${r.m}   (${r.fg} / ${r.bg})`);
      continue;
    }
    const v2 = ratio(fg, bg);
    const good = v2 >= r.need;
    if (!good) fail++;
    console.log(`  ${good ? 'PASS' : 'FAIL'}  ${v2.toFixed(2).padStart(5)}:1  (can ${r.need})  ${r.m}`);
  }
}

console.log('');
if (unknown) console.log(`Luu y: ${unknown} cap khong doc duoc mau (nen trong bang hard-code bi thieu o che do hien tai).`);
console.log(fail === 0 ? '>>> TAT CA CAP MAU DA DAT WCAG AA.' : `>>> CO ${fail} CAP MAU CHUA DAT.`);
process.exit(fail === 0 ? 0 : 1);
