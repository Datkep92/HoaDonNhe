'use strict';

/**
 * CAPTCHA OCR thuần JS — pipeline ddddocr (CaptchaX)
 *
 * Phụ thuộc:
 *   - onnxruntime-node  (Node)  hoặc  onnxruntime-web (browser)
 *   - common.onnx + common.json
 */

// ---------------------------------------------------------------------------
// 1. Preprocess: resize H=64, grayscale, normalize [-1, 1]
// ---------------------------------------------------------------------------
function preprocess(imageData) {
  // imageData: { width, height, data: Uint8ClampedArray RGBA }
  const { width, height, data } = imageData;
  const targetHeight = 64;
  const targetWidth = Math.max(1, Math.floor(width * (targetHeight / height)));

  // Resize gần đúng bằng nearest-neighbor (không cần canvas)
  const floatData = new Float32Array(targetWidth * targetHeight);
  for (let y = 0; y < targetHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y * height / targetHeight));
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor(x * width / targetWidth));
      const i = (srcY * width + srcX) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      floatData[y * targetWidth + x] = (gray / 255 - 0.5) / 0.5;
    }
  }
  return { floatData, targetWidth, targetHeight };
}

// ---------------------------------------------------------------------------
// 2. CTC decode: argmax → bỏ trùng liên tiếp → bỏ blank (index 0)
// ---------------------------------------------------------------------------
function ctcDecode(output, dims, charset) {
  // output shape ddddocr: [seq_len, batch=1, num_classes]
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
// 3. Engine: load model 1 lần, nhận base64 / ImageData → text
// ---------------------------------------------------------------------------
class CaptchaOCR {
  constructor(ort, options = {}) {
    this.ort = ort;                 // module onnxruntime-node hoặc ort từ web
    this.modelPath = options.modelPath || './onnx/common.onnx';
    this.charsetPath = options.charsetPath || './onnx/common.json';
    this.session = null;
    this.charset = null;
  }

  async init() {
    if (this.session && this.charset) return;

    // Node: fs đọc json; Browser: fetch
    if (typeof require !== 'undefined') {
      const fs = require('node:fs');
      this.charset = JSON.parse(fs.readFileSync(this.charsetPath, 'utf8'));
    } else {
      this.charset = await (await fetch(this.charsetPath)).json();
    }

    this.session = await this.ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'], // node: cpu | web: ['wasm']
      logSeverityLevel: 3,
    });
  }

  /**
   * @param {ImageData|{width,height,data}} imageData
   * @returns {Promise<string>}
   */
  async recognize(imageData) {
    await this.init();
    const { floatData, targetWidth, targetHeight } = preprocess(imageData);

    const input = new this.ort.Tensor(
      'float32',
      floatData,
      [1, 1, targetHeight, targetWidth]
    );

    const results = await this.session.run({ input1: input });
    const out = results[Object.keys(results)[0]];
    return ctcDecode(out.data, out.dims, this.charset);
  }
}

// ---------------------------------------------------------------------------
// 4. Helper Node: đọc file ảnh → ImageData (cần sharp hoặc jimp)
// ---------------------------------------------------------------------------
async function loadImageDataFromFile(filePath) {
  // Ví dụ với sharp (npm i sharp)
  const sharp = require('sharp');
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

// Tạo ảnh PNG captcha mô phỏng để test (SVG → PNG qua sharp). Dùng trong tests/captcha-solver.test.js
// thay cho fixture nhị phân — chạy được mọi máy không cần commit ảnh.
async function makeTestPng(svg) {
  const sharp = require('sharp');
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function loadImageDataFromBase64(dataUrlOrB64) {
  let b64 = String(dataUrlOrB64 || '');
  const comma = b64.indexOf(',');
  if (b64.startsWith('data:') && comma >= 0) b64 = b64.slice(comma + 1);
  const buf = Buffer.from(b64, 'base64');

  const sharp = require('sharp');
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
}

module.exports = {
  preprocess,
  ctcDecode,
  CaptchaOCR,
  loadImageDataFromFile,
  loadImageDataFromBase64,
  makeTestPng,
};