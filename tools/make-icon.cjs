'use strict';
// ---------------------------------------------------------------------------
// Sinh resources/icon.ico (nhiều kích cỡ, mỗi kích cỡ là một ảnh PNG) — dùng
// cho installer NSIS, shortcut và (tuỳ chọn) icon của app EXE qua rcedit.
//
//   node tools/make-icon.cjs
//
// Không dùng thư viện ngoài: tự mã hoá PNG (zlib) và tự đóng gói ICO.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.resolve(__dirname, '..', 'resources', 'icon.ico');
const SS = 4; // supersampling: vẽ lớn gấp 4 rồi thu nhỏ để viền mượt

// --- PNG encoder tối thiểu -------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // màu RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- hình học --------------------------------------------------------------
// Khoảng cách có dấu tới hình chữ nhật bo góc: âm là ở trong.
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Vẽ một icon ở kích cỡ `size`, trả về Buffer RGBA (size*size*4).
function renderIcon(size) {
  const S = size * SS;
  const hi = Buffer.alloc(S * S * 4); // nền trong suốt
  const bgTop = [46, 111, 214];   // xanh dương sáng
  const bgBottom = [20, 66, 143]; // xanh dương đậm
  const paper = [255, 255, 255];
  const line = [46, 111, 214];
  const accent = [26, 156, 92];   // xanh lá cho dòng "tổng"

  const m = S * 0.035;                 // lề ngoài
  const radius = S * 0.23;             // bo góc nền
  const cx = S / 2;
  const cy = S / 2;

  // 1) nền bo góc + gradient dọc
  for (let y = 0; y < S; y += 1) {
    const t = y / (S - 1);
    const [r, g, b] = mix(bgTop, bgBottom, t);
    for (let x = 0; x < S; x += 1) {
      if (sdRoundRect(x + 0.5, y + 0.5, cx, cy, S / 2 - m, S / 2 - m, radius) <= 0) {
        const i = (y * S + x) * 4;
        hi[i] = r; hi[i + 1] = g; hi[i + 2] = b; hi[i + 3] = 255;
      }
    }
  }

  // 2) tờ "hóa đơn" trắng
  const pw = S * 0.58, ph = S * 0.68, pr = S * 0.07;
  const top = cy - ph / 2;
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    if (sdRoundRect(x + 0.5, y + 0.5, cx, cy, pw / 2, ph / 2, pr) <= 0) {
      const i = (y * S + x) * 4;
      hi[i] = paper[0]; hi[i + 1] = paper[1]; hi[i + 2] = paper[2]; hi[i + 3] = 255;
    }
  }

  // 3) các dòng chữ trên tờ hóa đơn
  const barH = S * 0.058;
  const barsY = [top + ph * 0.22, top + ph * 0.42, top + ph * 0.62];
  barsY.forEach((by, idx) => {
    const bw = (idx === 2 ? S * 0.30 : S * 0.36) / 2;
    const color = idx === 2 ? line : line;
    for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
      if (sdRoundRect(x + 0.5, y + 0.5, cx, by, bw, barH / 2, barH / 2) <= 0) {
        const i = (y * S + x) * 4;
        hi[i] = color[0]; hi[i + 1] = color[1]; hi[i + 2] = color[2]; hi[i + 3] = 255;
      }
    }
  });

  // 4) dòng "tổng" màu xanh lá, ngắn hơn
  const totalY = top + ph * 0.80;
  const totalW = S * 0.22;
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    if (sdRoundRect(x + 0.5, y + 0.5, cx, totalY, totalW / 2, barH / 2, barH / 2) <= 0) {
      const i = (y * S + x) * 4;
      hi[i] = accent[0]; hi[i + 1] = accent[1]; hi[i + 2] = accent[2]; hi[i + 3] = 255;
    }
  }

  // 5) thu nhỏ SS×SS -> size×size (trung bình có trọng số alpha)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy += 1) for (let sx = 0; sx < SS; sx += 1) {
        const i = (((y * SS + sy) * S) + (x * SS + sx)) * 4;
        const alpha = hi[i + 3] / 255;
        r += hi[i] * alpha; g += hi[i + 1] * alpha; b += hi[i + 2] * alpha; a += alpha;
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function buildIco(sizes) {
  const images = sizes.map(size => ({ size, png: encodePng(size, size, renderIcon(size)) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const e = i * 16;
    entries[e] = img.size >= 256 ? 0 : img.size;
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries[e + 2] = 0;
    entries[e + 3] = 0;
    entries.writeUInt16LE(1, e + 4);   // planes
    entries.writeUInt16LE(32, e + 6);  // bit count
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, entries, ...images.map(img => img.png)]);
}

const ico = buildIco([16, 20, 24, 32, 40, 48, 64, 128, 256]);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);
console.log(`Đã tạo ${path.relative(process.cwd(), OUT)} (${ico.length} byte, 9 kích cỡ).`);
