'use strict';
// Lấy model OCR ddddocr (common.onnx + common.json) cho src/onnx/.
//
// Thứ tự tìm:
//   1. Đã có sẵn trong src/onnx → bỏ qua
//   2. Extension CaptchaX đã cài trong profile Chrome/Edge (máy có extension thì lấy tại chỗ,
//      model ở đó giống hệt bản ddddocr gốc — đã đối chiếu byte-for-byte)
//   3. Tải từ GitHub sml2h3/ddddocr (nhánh master, file ONNX gốc)
//
// REPO MÃ NGUỒN ĐỂ PRIVATE: khi đó link tải ẩn danh trả 404. Nếu có biến môi trường
// GH_TOKEN (hoặc GITHUB_TOKEN — GitHub Actions tự cấp) thì tool lấy file qua GitHub API.
// Token KHÔNG bao giờ được gửi sang host khác khi chuyển hướng.
//
// Chạy: node tools/fetch-onnx.cjs  (hoặc npm run fetch-onnx)
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');

const DEST_DIR = path.resolve(__dirname, '..', 'src', 'onnx');
// Repo mã nguồn lấy từ src/version.js để không phải nhớ hai nơi.
const SOURCE_REPO = require('../src/version').sourceRepository;
const OCR_TAG = 'ocr-model-v1';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const FILES = [
  { name: 'common.onnx', size: 54_088_400 },
  { name: 'common.json', size: 90_092 },
];

// Model CaptchaX nằm trong profile Chrome/Edge theo ID extension này.
const CAPTCHAX_ID = 'chfieifmclkhjakoadihfkiengbokicf';
function extensionDirs() {
  const bases = [
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  ];
  const dirs = [];
  for (const base of bases) {
    const extRoot = path.join(base, 'Default', 'Extensions', CAPTCHAX_ID);
    if (!fs.existsSync(extRoot)) continue;
    for (const version of fs.readdirSync(extRoot)) {
      const dir = path.join(extRoot, version, 'onnx');
      if (fs.existsSync(path.join(dir, 'common.onnx'))) dirs.push(dir);
    }
  }
  return dirs;
}

function download(url, dest, options) {
  const accept = options && options.accept;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (currentUrl, redirects, sendToken) => {
      if (redirects > 5) { file.close(); reject(new Error('Quá nhiều lần chuyển hướng tải model.')); return; }
      const headers = {};
      if (accept) headers.Accept = accept;
      if (sendToken && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      https.get(currentUrl, { headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          // Bỏ token khi sang host khác: URL đích đã được ký sẵn, gửi kèm token dễ bị từ chối.
          request(new URL(res.headers.location, currentUrl).toString(), redirects + 1, false);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); file.close(); reject(new Error(`HTTP ${res.statusCode} khi tải ${currentUrl}`)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => { file.close(); reject(err); });
    };
    request(url, 0, true);
  });
}

// Hỏi GitHub API để lấy URL tài liệu của prerelease (chỉ dùng được khi repo private + có token).
function githubJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'CN-Tax-Tools-fetch-onnx' },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

// Trả về URL tài liệu qua API khi có token, ngược lại chuỗi rỗng.
async function tokenAssetUrl(fileName) {
  if (!TOKEN) return '';
  const release = await githubJson(`https://api.github.com/repos/${SOURCE_REPO}/releases/tags/${OCR_TAG}`);
  const asset = (release.assets || []).find(item => item && item.name === fileName);
  return asset ? asset.url : '';
}

const SOURCES = {
  // Nguồn CHÍNH: prerelease `ocr-model-v1` của CHÍNH repo này — bản sao cố định, đúng byte đang
  // chạy thật trên máy. Vì sao không lấy từ ddddocr cho cả hai file: repo đó KHÔNG có common.json
  // (charset của nó là file Python charsets.py) — ba URL cũ đều trả 404, đã kiểm thật ngày 27/09.
  // Riêng common.onnx thì ddddocr vẫn dùng được nên giữ làm nguồn dự phòng.
  // KHÔNG tự suy ra common.json từ charsets.py: charset của app là CHARSET_BETA nhưng CÓ thêm một
  // phần tử '' ở vị trí 1173 (do bộ chuyển của extension tách chuỗi escape) — suy diễn sai một ký tự
  // là CAPTCHA ra CHỮ SAI, tệ hơn hẳn việc báo lỗi. Dùng đúng file đang chạy tốt.
  'common.onnx': [
    `https://github.com/${SOURCE_REPO}/releases/download/${OCR_TAG}/common.onnx`,
    'https://raw.githubusercontent.com/sml2h3/ddddocr/master/ddddocr/common.onnx',
  ],
  'common.json': [
    `https://github.com/${SOURCE_REPO}/releases/download/${OCR_TAG}/common.json`,
  ],
};

async function main() {
  fs.mkdirSync(DEST_DIR, { recursive: true });
  const fromExt = extensionDirs();
  for (const file of FILES) {
    const dest = path.join(DEST_DIR, file.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`✓ Đã có: ${path.relative(process.cwd(), dest)}`);
      continue;
    }
    // 1) Copy từ extension CaptchaX cài sẵn
    for (const dir of fromExt) {
      const src = path.join(dir, file.name);
      if (fs.existsSync(src) && fs.statSync(src).size > 1000) {
        fs.copyFileSync(src, dest);
        console.log(`✓ Lấy từ extension CaptchaX: ${file.name}`);
        break;
      }
    }
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) continue;
    // 2) Tải từ mạng (khi có token thì thử lấy qua API trước — cần cho repo private)
    const candidates = [];
    if (TOKEN) {
      try {
        const apiUrl = await tokenAssetUrl(file.name);
        if (apiUrl) candidates.push({ url: apiUrl, accept: 'application/octet-stream' });
      } catch (err) { console.log(`… Không hỏi được GitHub API: ${err.message}`); }
    }
    for (const url of SOURCES[file.name]) candidates.push({ url });

    let ok = false;
    let lastErr = '';
    for (const candidate of candidates) {
      try {
        console.log(`… Đang tải ${file.name} từ ${candidate.url}`);
        await download(candidate.url, dest, { accept: candidate.accept });
        if (fs.statSync(dest).size > 1000) { ok = true; break; }
      } catch (err) { lastErr = err.message; }
    }
    if (!ok) throw new Error(`Không lấy được ${file.name}. ${lastErr}`);
    console.log(`✓ Đã tải: ${file.name}`);
  }
  // KIỂM KÍCH THƯỚC CHÍNH XÁC sau khi lấy: tải thiếu/thừa vài byte cũng phải DỪNG ngay, không để
  // một EXE khuyết model đi ra bản phát hành (xem chốt chặn trong tools/build-app.cjs).
  for (const file of FILES) {
    const size = fs.statSync(path.join(DEST_DIR, file.name)).size;
    if (file.size && size !== file.size) {
      throw new Error(`${file.name} sai kích thước: ${size} bytes, cần ${file.size}. Xoá file đó rồi chạy lại.`);
    }
  }
  console.log('Model OCR sẵn sàng trong src/onnx/');
}

main().catch(err => { console.error('✗ ' + err.message); process.exit(1); });
