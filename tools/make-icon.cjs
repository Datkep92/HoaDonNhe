'use strict';
// ---------------------------------------------------------------------------
// Sinh icon từ ẢNH NGUỒN (mặc định resources/icon-source.png):
//   - resources/icon.ico  : nhiều kích cỡ (16…256), mỗi kích cỡ là một PNG nhúng
//                           → dùng cho icon khay hệ thống, shortcut, installer NSIS
//   - src/icon.png        : 64×64 → favicon của giao diện, Chrome lấy làm icon
//                           cửa sổ --app (taskbar / Alt-Tab)
//
//   node tools/make-icon.cjs [đường-dẫn-ảnh-nguồn]
//
// Lần đầu truyền ảnh gốc (vd ảnh 1024×1024): ảnh sẽ được cắt vuông, thu nhỏ và
// lưu lại thành resources/icon-source.png (nguồn chuẩn, nhẹ) rồi mới sinh icon.
// Không dùng thư viện ngoài: tự giải mã PNG (zlib), tự thu nhỏ, tự mã hoá PNG + ICO.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'resources', 'icon-source.png');
const OUT_ICO = path.join(ROOT, 'resources', 'icon.ico');
const OUT_FAVICON = path.join(ROOT, 'src', 'icon.png');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SOURCE_SIZE = 512; // nguồn chuẩn lưu trong repo: đủ cho icon 256 + favicon, vẫn nhẹ
const FAVICON_SIZE = 64;

// --- PNG: giải mã ----------------------------------------------------------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function unfilterRow(type, line, prev, bpp) {
  const n = line.length;
  if (type === 0) return;
  for (let i = 0; i < n; i += 1) {
    const a = i >= bpp ? line[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    if (type === 1) line[i] = (line[i] + a) & 0xff;
    else if (type === 2) line[i] = (line[i] + b) & 0xff;
    else if (type === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
    else if (type === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff;
    else throw new Error(`PNG dùng bộ lọc lạ: ${type}`);
  }
}

// Đọc PNG 8-bit, không xen kẽ, các kiểu màu 0/2/3/4/6 → Buffer RGBA (w*h*4).
function decodePng(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: không phải file PNG.`);
  let pos = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error(`${file}: PNG thiếu IHDR.`);
  if (ihdr.interlace !== 0) throw new Error(`${file}: PNG xen kẽ (interlaced) chưa hỗ trợ — lưu lại ở dạng thường.`);
  if (ihdr.depth !== 8) throw new Error(`${file}: PNG ${ihdr.depth}-bit chưa hỗ trợ — cần 8-bit/kênh.`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!channels) throw new Error(`${file}: kiểu màu PNG ${ihdr.color} chưa hỗ trợ.`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error(`${file}: dữ liệu PNG không đầy đủ.`);
  const lines = Buffer.alloc(stride * height);
  let prev = null;
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    unfilterRow(type, line, prev, channels);
    line.copy(lines, y * stride);
    prev = line;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i += 1, p += channels) {
    const o = i * 4;
    if (ihdr.color === 6) {
      rgba[o] = lines[p]; rgba[o + 1] = lines[p + 1]; rgba[o + 2] = lines[p + 2]; rgba[o + 3] = lines[p + 3];
    } else if (ihdr.color === 2) {
      rgba[o] = lines[p]; rgba[o + 1] = lines[p + 1]; rgba[o + 2] = lines[p + 2]; rgba[o + 3] = 255;
    } else if (ihdr.color === 0) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = lines[p]; rgba[o + 3] = 255;
    } else if (ihdr.color === 4) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = lines[p]; rgba[o + 3] = lines[p + 1];
    } else {
      const idx = lines[p] * 3;
      rgba[o] = palette[idx]; rgba[o + 1] = palette[idx + 1]; rgba[o + 2] = palette[idx + 2];
      rgba[o + 3] = trns && lines[p] < trns.length ? trns[lines[p]] : 255;
    }
  }
  return { width, height, rgba };
}

// --- PNG: mã hoá (chọn bộ lọc từng dòng cho file nhẹ) ----------------------
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function filterScore(line) {
  let sum = 0;
  for (let i = 0; i < line.length; i += 1) sum += line[i] < 128 ? line[i] : 256 - line[i];
  return sum;
}

function encodePng(width, height, rgba) {
  const bpp = 4;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y += 1) {
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    let chosenType = 0, chosen = candidates[0], chosenScore = Infinity;
    for (let type = 0; type <= 4; type += 1) {
      const candidate = candidates[type];
      for (let i = 0; i < stride; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v;
        if (type === 0) v = line[i];
        else if (type === 1) v = line[i] - a;
        else if (type === 2) v = line[i] - b;
        else if (type === 3) v = line[i] - ((a + b) >> 1);
        else v = line[i] - paeth(a, b, c);
        candidate[i] = v & 0xff;
      }
      const score = filterScore(candidate);
      if (score < chosenScore) { chosenScore = score; chosenType = type; chosen = candidate; }
    }
    raw[y * (stride + 1)] = chosenType;
    chosen.copy(raw, y * (stride + 1) + 1);
    prev = line;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Hình học: cắt vuông giữa ảnh rồi thu nhỏ (lấy trung bình theo diện tích,
//     có nhân trước alpha để viền không bị viền đen) ------------------------
function squareCrop({ width, height, rgba }) {
  const size = Math.min(width, height);
  const left = Math.floor((width - size) / 2);
  const top = Math.floor((height - size) / 2);
  if (size === width && size === height) return { size, rgba };
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const from = ((y + top) * width + left) * 4;
    rgba.copy(out, y * size * 4, from, from + size * 4);
  }
  return { size, rgba: out };
}

function resize({ size, rgba }, target) {
  if (size === target) return Buffer.from(rgba);
  const out = Buffer.alloc(target * target * 4);
  const scale = size / target;
  for (let dy = 0; dy < target; dy += 1) {
    const sy0 = dy * scale, sy1 = (dy + 1) * scale;
    for (let dx = 0; dx < target; dx += 1) {
      const sx0 = dx * scale, sx1 = (dx + 1) * scale;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (Math.min(sy, size - 1) * size + Math.min(sx, size - 1)) * 4;
          const alpha = rgba[i + 3] / 255;
          r += rgba[i] * alpha * w;
          g += rgba[i + 1] * alpha * w;
          b += rgba[i + 2] * alpha * w;
          a += alpha * w;
          wsum += w;
        }
      }
      const o = (dy * target + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (wsum || 1)) * 255);
    }
  }
  return out;
}

// --- ICO: gói nhiều ảnh PNG -------------------------------------------------
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const e = i * 16;
    entries[e] = img.size >= 256 ? 0 : img.size;
    entries[e + 1] = img.size >= 256 ? 0 : img.size;
    entries[e + 2] = 0; entries[e + 3] = 0;
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(img.png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += img.png.length;
  });
  return Buffer.concat([header, entries, ...images.map(img => img.png)]);
}

// --- Icon tổng hợp (dự phòng khi KHÔNG có ảnh nguồn) ------------------------
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function mix(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

const SS = 4;
function renderFallback(size) {
  const S = size * SS;
  const hi = Buffer.alloc(S * S * 4);
  const bgTop = [46, 111, 214], bgBottom = [20, 66, 143], paper = [255, 255, 255], line = [46, 111, 214], accent = [26, 156, 92];
  const m = S * 0.035, radius = S * 0.23, cx = S / 2, cy = S / 2;
  for (let y = 0; y < S; y += 1) {
    const [r, g, b] = mix(bgTop, bgBottom, y / (S - 1));
    for (let x = 0; x < S; x += 1) {
      if (sdRoundRect(x + 0.5, y + 0.5, cx, cy, S / 2 - m, S / 2 - m, radius) <= 0) {
        const i = (y * S + x) * 4;
        hi[i] = r; hi[i + 1] = g; hi[i + 2] = b; hi[i + 3] = 255;
      }
    }
  }
  const pw = S * 0.58, ph = S * 0.68, pr = S * 0.07, top = cy - ph / 2;
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    if (sdRoundRect(x + 0.5, y + 0.5, cx, cy, pw / 2, ph / 2, pr) <= 0) {
      const i = (y * S + x) * 4;
      hi[i] = paper[0]; hi[i + 1] = paper[1]; hi[i + 2] = paper[2]; hi[i + 3] = 255;
    }
  }
  const barH = S * 0.058;
  [top + ph * 0.22, top + ph * 0.42, top + ph * 0.62].forEach((by, idx) => {
    const bw = (idx === 2 ? S * 0.30 : S * 0.36) / 2;
    for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
      if (sdRoundRect(x + 0.5, y + 0.5, cx, by, bw, barH / 2, barH / 2) <= 0) {
        const i = (y * S + x) * 4;
        hi[i] = line[0]; hi[i + 1] = line[1]; hi[i + 2] = line[2]; hi[i + 3] = 255;
      }
    }
  });
  const totalY = top + ph * 0.80, totalW = S * 0.22;
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    if (sdRoundRect(x + 0.5, y + 0.5, cx, totalY, totalW / 2, barH / 2, barH / 2) <= 0) {
      const i = (y * S + x) * 4;
      hi[i] = accent[0]; hi[i + 1] = accent[1]; hi[i + 2] = accent[2]; hi[i + 3] = 255;
    }
  }
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy += 1) for (let sx = 0; sx < SS; sx += 1) {
      const i = (((y * SS + sy) * S) + (x * SS + sx)) * 4;
      const alpha = hi[i + 3] / 255;
      r += hi[i] * alpha; g += hi[i + 1] * alpha; b += hi[i + 2] * alpha; a += alpha;
    }
    const n = SS * SS, o = (y * size + x) * 4;
    out[o] = a > 0 ? Math.round(r / a) : 0;
    out[o + 1] = a > 0 ? Math.round(g / a) : 0;
    out[o + 2] = a > 0 ? Math.round(b / a) : 0;
    out[o + 3] = Math.round((a / n) * 255);
  }
  return out;
}

// --- Chạy ------------------------------------------------------------------
const argSource = process.argv[2] ? path.resolve(process.argv[2]) : '';
let source = null;
if (argSource) {
  if (!fs.existsSync(argSource)) throw new Error(`Không thấy ảnh nguồn: ${argSource}`);
  const decoded = decodePng(argSource);
  source = resize(squareCrop(decoded), SOURCE_SIZE);
  // Lưu ảnh nguồn chuẩn (đã cắt vuông + thu nhỏ) để lần sau tái tạo icon từ nó.
  fs.mkdirSync(path.dirname(SOURCE), { recursive: true });
  fs.writeFileSync(SOURCE, encodePng(SOURCE_SIZE, SOURCE_SIZE, source));
  console.log(`Ảnh nguồn ${decoded.width}×${decoded.height} → ${path.relative(ROOT, SOURCE)} (${(fs.statSync(SOURCE).size / 1024).toFixed(0)} KB, ${SOURCE_SIZE}×${SOURCE_SIZE})`);
} else if (fs.existsSync(SOURCE)) {
  const decoded = decodePng(SOURCE);
  source = resize(squareCrop(decoded), SOURCE_SIZE);
} else {
  console.log('Không có resources/icon-source.png — dùng icon tổng hợp dựng sẵn.');
}

const getRgba = size => (source ? resize({ size: SOURCE_SIZE, rgba: source }, size) : renderFallback(size));

const ico = buildIco(SIZES.map(size => ({ size, png: encodePng(size, size, getRgba(size)) })));
fs.mkdirSync(path.dirname(OUT_ICO), { recursive: true });
fs.writeFileSync(OUT_ICO, ico);

const favicon = encodePng(FAVICON_SIZE, FAVICON_SIZE, getRgba(FAVICON_SIZE));
fs.mkdirSync(path.dirname(OUT_FAVICON), { recursive: true });
fs.writeFileSync(OUT_FAVICON, favicon);

console.log(`Đã tạo ${path.relative(ROOT, OUT_ICO)} (${(ico.length / 1024).toFixed(0)} KB, ${SIZES.length} kích cỡ: ${SIZES.join('/')})`);
console.log(`Đã tạo ${path.relative(ROOT, OUT_FAVICON)} (${(favicon.length / 1024).toFixed(1)} KB, ${FAVICON_SIZE}×${FAVICON_SIZE}) — favicon cho cửa sổ app.`);
