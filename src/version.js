'use strict';
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
//
// HAI TRƯỜNG REPO, ĐỪNG LẪN:
//   * repository       — nơi app kiểm tra bản mới và tải EXE về (xem src/update-check.js,
//     src/updater.js). Phải là repo mà người dùng TẢI ĐƯỢC file; repo private thì tự cập
//     nhật sẽ nhận 404 với mọi người.
//   * sourceRepository — repo MÃ NGUỒN, chỉ dùng lúc build (tools/fetch-onnx.cjs lấy model OCR).
//     Repo này để private cũng được.
// Đổi nơi phát hành chỉ cần sửa 'repository' + 'releasesUrl' ở dưới.
// ---------------------------------------------------------------------------
module.exports = {
  name: 'CN Tax Tools',
  version: '1.1.4',
  sourceRepository: 'Datkep92/HoaDonNhe',
  repository: 'Datkep92/HoaDonNhe',
  releasesUrl: 'https://github.com/Datkep92/HoaDonNhe/releases',
};
