'use strict';
/**
 * CAPTCHA solver JS thuần — pipeline y hệt extension CaptchaX (đã kiểm chứng giải chuẩn):
 *   1. Decode ảnh ở kích thước gốc (PNG/JPEG qua sharp; SVG cổng thuế cũng qua sharp rasterize)
 *   2. Resize về H=64, W tỉ lệ — nội suy bilinear như canvas.drawImage của browser
 *   3. Grayscale (0.299/0.587/0.114) + normalize (x/255 - 0.5)/0.5
 *   4. Chạy model common.onnx (ddddocr) bằng onnxruntime-node → CTC decode
 *
 * Không gọi C# API cổng 28374, không dùng ddddocr-node (jimp của nó resize khác canvas
 * nên kém chính xác hơn — đây là lý do CaptchaX giải chuẩn hơn).
 *
 * Model nằm ở src/onnx/common.onnx + common.json (lấy từ extension CaptchaX).
 * Nếu thiếu, chạy: node tools/fetch-onnx.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
let ort = null;
let sharp = null;
try { ort = require('onnxruntime-node'); } catch { /* thiếu module — solve() sẽ trả null */ }
try { sharp = require('sharp'); } catch { /* thiếu module — solve() sẽ trả null */ }

// Đường dẫn model: cạnh file này (src/onnx), hoặc ghi đè bằng biến môi trường
const ROOT = path.resolve(__dirname);
const MODEL_PATH = process.env.HOADON_OCR_MODEL || path.join(ROOT, 'onnx', 'common.onnx');
const CHARSET_PATH = process.env.HOADON_OCR_CHARSET || path.join(ROOT, 'onnx', 'common.json');

let session = null;
let charset = null;
let initPromise = null;
let lastError = '';

// ---------------------------------------------------------------------------
// Init: load model + charset 1 lần
// ---------------------------------------------------------------------------
async function initModel() {
  if (!ort) throw new Error('Thiếu onnxruntime-node — chưa cài: npm i onnxruntime-node');
  if (!sharp) throw new Error('Thiếu sharp — chưa cài: npm i sharp');
  if (session && charset) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!fs.existsSync(MODEL_PATH)) {
      throw new Error(`Không thấy model OCR: ${MODEL_PATH}. Chạy "node tools/fetch-onnx.cjs" để tải từ extension CaptchaX.`);
    }
    if (!fs.existsSync(CHARSET_PATH)) {
      throw new Error(`Không thấy charset: ${CHARSET_PATH}. Chạy "node tools/fetch-onnx.cjs".`);
    }
    charset = JSON.parse(fs.readFileSync(CHARSET_PATH, 'utf8'));
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      logSeverityLevel: 3,
    });
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

// ---------------------------------------------------------------------------
// Preprocess: resize bilinear H=64 (giống canvas.drawImage của browser — CaptchaX),
// grayscale, normalize [-1, 1]
// ---------------------------------------------------------------------------
function bilinearResizeGray(imageData) {
  const { width, height, data } = imageData;
  const targetHeight = 64;
  const targetWidth = Math.max(1, Math.floor(width * (targetHeight / height)));

  // Scale factor giống canvas: dst pixel (x,y) sample từ src tại (x+0.5)*scale-0.5
  const xScale = width / targetWidth;
  const yScale = height / targetHeight;

  // Trước hết chuyển ảnh gốc sang mảng grayscale 1 kênh
  const gray = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }

  const floatData = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const srcY = (y + 0.5) * yScale - 0.5;
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(srcY)));
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, srcY - y0));
    for (let x = 0; x < targetWidth; x++) {
      const srcX = (x + 0.5) * xScale - 0.5;
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(srcX)));
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, srcX - x0));

      const g00 = gray[y0 * width + x0], g01 = gray[y0 * width + x1];
      const g10 = gray[y1 * width + x0], g11 = gray[y1 * width + x1];
      const top = g00 + (g01 - g00) * fx;
      const bottom = g10 + (g11 - g10) * fx;
      const value = top + (bottom - top) * fy;
      floatData[y * targetWidth + x] = (value / 255 - 0.5) / 0.5;
    }
  }
  return { floatData, targetWidth, targetHeight };
}

// ---------------------------------------------------------------------------
// CTC decode: argmax → bỏ trùng liên tiếp → bỏ blank (index 0) — như CaptchaX
// ---------------------------------------------------------------------------
function ctcDecode(output, dims) {
  const seqLen = dims[0];
  const numClasses = dims[2];
  const result = [];
  let last = 0;

  for (let t = 0; t < seqLen; t++) {
    let maxVal = -Infinity;
    let maxIdx = 0;
    const base = t * numClasses;
    for (let c = 0; c < numClasses; c++) {
      const v = output[base + c];
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }
    if (maxIdx === last) continue;
    last = maxIdx;
    if (maxIdx !== 0 && maxIdx < charset.length) {
      result.push(charset[maxIdx]);
    }
  }
  return result.join('');
}

// ---------------------------------------------------------------------------
// data-URL / base64 → ImageData RGBA (hỗ trợ PNG/JPEG và SVG — cổng thuế TCT trả SVG)
// sharp rasterize SVG ở kích thước gốc qua density/resize, decode PNG/JPEG nguyên bản.
// ---------------------------------------------------------------------------
async function toImageData(base64OrDataUrl) {
  if (!sharp) throw new Error('Thiếu sharp — chưa cài: npm i sharp');
  let input = String(base64OrDataUrl || '');
  if (!input) throw new Error('Ảnh CAPTCHA rỗng');

  let buffer;
  if (input.startsWith('data:')) {
    const comma = input.indexOf(',');
    const meta = input.slice(0, comma);
    const body = input.slice(comma + 1);
    if (/;base64/i.test(meta)) {
      buffer = Buffer.from(body, 'base64');
    } else {
      // data:image/svg+xml;charset=utf-8,<svg...Encoded>
      buffer = Buffer.from(decodeURIComponent(body), 'utf8');
    }
  } else {
    buffer = Buffer.from(input.replace(/\s/g, ''), 'base64');
  }

  const pipeline = sharp(buffer, { density: 96 }).ensureAlpha();
  const meta = await pipeline.metadata();
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return {
    width: meta.width || info.width,
    height: meta.height || info.height,
    data: new Uint8ClampedArray(data),
  };
}

// ---------------------------------------------------------------------------
// API công khai — login-auto.js gọi: captchaSolver.solve(challenge.captcha, PORTAL)
// ---------------------------------------------------------------------------
/**
 * @param {string} base64OrDataUrl
 * @param {string} [pageUrl]
 * @returns {Promise<string|null>}  mã CAPTCHA hoặc null nếu lỗi
 */
async function solve(base64OrDataUrl, pageUrl = '') {
  try {
    await initModel();
    const imageData = await toImageData(base64OrDataUrl);
    const { floatData, targetWidth, targetHeight } = bilinearResizeGray(imageData);

    const tensor = new ort.Tensor('float32', floatData, [1, 1, targetHeight, targetWidth]);
    const results = await session.run({ input1: tensor });
    const out = results[Object.keys(results)[0]];
    const text = ctcDecode(out.data, out.dims).trim();

    // CAPTCHA cổng thuế 4-6 ký tự; kết quả quá dài chắc chắn sai
    if (!text || text.length > 10) return null;
    return text;
  } catch (err) {
    lastError = err.message;
    // Không ném lỗi ra ngoài — login-auto sẽ fallback CAPTCHA thủ công
    return null;
  }
}

/** Kiểm tra solver đã sẵn sàng (thay cho ping cổng 28374). */
async function isAvailable() {
  try {
    await initModel();
    return true;
  } catch (err) {
    lastError = err.message;
    return false;
  }
}

function lastErrorMessage() { return lastError; }

function toRawBase64(input) {
  const s = String(input || '');
  if (!s) return '';
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma >= 0) return s.slice(comma + 1).replace(/\s/g, '');
  return s.replace(/\s/g, '');
}

module.exports = { solve, isAvailable, toRawBase64, lastErrorMessage };
