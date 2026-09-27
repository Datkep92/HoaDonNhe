'use strict';
// Lấy model OCR ddddocr (common.onnx + common.json) cho src/onnx/.
//
// Thứ tự tìm:
//   1. Đã có sẵn trong src/onnx → bỏ qua
//   2. Extension CaptchaX đã cài trong profile Chrome/Edge (máy có extension thì lấy tại chỗ,
//      model ở đó giống hệt bản ddddocr gốc — đã đối chiếu byte-for-byte)
//   3. Tải từ GitHub sml2h3/ddddocr (nhánh master, file ONNX gốc)
//
// Chạy: node tools/fetch-onnx.cjs  (hoặc npm run fetch-onnx)
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const os = require('node:os');

const DEST_DIR = path.resolve(__dirname, '..', 'src', 'onnx');
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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (currentUrl, redirects) => {
      if (redirects > 5) { file.close(); reject(new Error('Quá nhiều lần chuyển hướng tải model.')); return; }
      https.get(currentUrl, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); request(res.headers.location, redirects + 1); return; }
        if (res.statusCode !== 200) { res.resume(); file.close(); reject(new Error(`HTTP ${res.statusCode} khi tải ${currentUrl}`)); return; }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', err => { file.close(); reject(err); });
    };
    request(url, 0);
  });
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
    'https://github.com/Datkep92/HoaDonNhe/releases/download/ocr-model-v1/common.onnx',
    'https://raw.githubusercontent.com/sml2h3/ddddocr/master/ddddocr/common.onnx',
  ],
  'common.json': [
    'https://github.com/Datkep92/HoaDonNhe/releases/download/ocr-model-v1/common.json',
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
    // 2) Tải từ mạng
    let ok = false;
    let lastErr = '';
    for (const url of SOURCES[file.name]) {
      try {
        console.log(`… Đang tải ${file.name} từ ${url}`);
        await download(url, dest);
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
