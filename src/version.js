'use strict';
// ---------------------------------------------------------------------------
// NGUỒN VERSION DUY NHẤT của HoaDonNhe.
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
  name: 'HoaDonNhe',
  version: '1.0.2',
  repository: 'Datkep92/HoaDonNhe',
  releasesUrl: 'https://github.com/Datkep92/HoaDonNhe/releases',
};
