'use strict';
// ---------------------------------------------------------------------------
// Đặt version cho toàn bộ project từ một nguồn duy nhất.
//
//   node tools/set-version.cjs 1.0.0        (hoặc: npm run set-version -- 1.0.0)
//
// Cập nhật đồng thời:
//   - package.json       > version
//   - package-lock.json  > version  và  packages[""].version  (giữ npm ci vui vẻ)
//   - src/version.js     > version  (sinh lại từ đúng template bên dưới)
//
// Workflow GitHub Actions gọi lệnh này với version lấy từ tag (bỏ "v") trước khi
// build, nên tag là nguồn chính và app/Setup luôn hiển thị đúng version.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const requested = process.argv[2];

if (!requested) {
  console.error('Cách dùng: node tools/set-version.cjs <x.y.z>   (ví dụ: node tools/set-version.cjs 1.0.0)');
  process.exit(1);
}

const version = String(requested).trim().replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Version không hợp lệ: "${requested}". Cần dạng x.y.z (ví dụ 1.0.0).`);
  process.exit(1);
}
if (version.split('.').length < 3) {
  console.error(`Version cần đủ 3 phần x.y.z: "${version}".`);
  process.exit(1);
}

function writeJson(file, mutate) {
  if (!fs.existsSync(file)) return false;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return true;
}

writeJson(path.join(root, 'package.json'), pkg => { pkg.version = version; });

writeJson(path.join(root, 'package-lock.json'), lock => {
  if (lock.version !== undefined) lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
});

const versionSource = `'use strict';
// ---------------------------------------------------------------------------
// NGUỒN VERSION DUY NHẤT của CN Tax Tools.
//
// - Bản phát hành dùng tag git dạng vX.Y.Z (ví dụ v1.0.0) làm nguồn chính.
// - Giữ file này, package.json và package-lock.json khớp nhau bằng lệnh:
//       node tools/set-version.cjs X.Y.Z
//   (workflow GitHub Actions tự chạy lệnh này từ tag trước khi build, nên
//    version trong app và tên file Setup luôn đồng bộ với tag Release.)
// - File này được require() từ server nên pkg nhúng thẳng vào EXE; UI đọc
//   version qua endpoint /api/version.
// ---------------------------------------------------------------------------
module.exports = {
  name: 'CN Tax Tools',
  version: '${version}',
  repository: 'Datkep92/HoaDonNhe',
  releasesUrl: 'https://github.com/Datkep92/HoaDonNhe/releases',
};
`;
fs.writeFileSync(path.join(root, 'src', 'version.js'), versionSource);

console.log(`Đã đặt version = ${version} (package.json, package-lock.json, src/version.js).`);
