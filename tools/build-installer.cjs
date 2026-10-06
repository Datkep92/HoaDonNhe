'use strict';
// ---------------------------------------------------------------------------
// Đóng gói CN-Tax-Tools-Setup-v<version>.exe bằng NSIS (makensis):
//   1) lấy payload release/CN-Tax-Tools-v<version>.exe (do `npm run build` tạo ra)
//   2) copy vào release/installer/payload/CN-Tax-Tools.exe  (tên cố định để nhúng)
//   3) makensis nhúng payload + icon vào MỘT file Setup duy nhất
//   4) tính SHA-256, ghi file .sha256 và RELEASE_NOTES.md
//
// Chạy: npm run installer      (cần makensis: "choco install nsis -y" hoặc đặt MAKENSIS)
//
// File phát hành duy nhất: release/CN-Tax-Tools-Setup-v<version>.exe
//
// Đường dẫn payload/icon/output nằm ngay trong packaging/installer.nsi (tính theo
// ${__FILEDIR__}), nên ở đây chỉ truyền các define không chứa khoảng trắng.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { version, repository } = require('../src/version');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const appExe = path.join(releaseDir, `CN-Tax-Tools-v${version}.exe`);
const payloadDir = path.join(releaseDir, 'installer', 'payload');
const payloadExe = path.join(payloadDir, 'CN-Tax-Tools.exe');
const setupExe = path.join(releaseDir, `CN-Tax-Tools-Setup-v${version}.exe`);
const nsi = path.join(root, 'packaging', 'installer.nsi');
const icon = path.join(root, 'resources', 'icon.ico');

function findMakensis() {
  if (process.env.MAKENSIS && fs.existsSync(process.env.MAKENSIS)) return process.env.MAKENSIS;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['makensis.exe', 'makensis']) {
      const file = path.join(dir, name);
      if (dir && fs.existsSync(file)) return file;
    }
  }
  for (const base of [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES]) {
    if (!base) continue;
    const file = path.join(base, 'NSIS', 'makensis.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// "Có gì mới" của từng bản — thêm một mục mỗi lần phát hành, để trang Release trên GitHub nói đúng
// thứ người dùng nhận được (bản 1.0.7 phát hành thiếu hẳn tab Sao kê ngân hàng mà không ai biết).
// Bản không có trong bảng thì bỏ qua mục này, phần cài đặt/cập nhật vẫn đầy đủ.
const WHATS_NEW = {
  '1.1.5': [
    '- **Khung Hỗ trợ chung AI/Admin**: một khung chat duy nhất. AI trả lời ngay, admin tiếp quản',
    '  được bất cứ lúc nào; lịch sử AI và admin ghép theo thứ tự thời gian nên không bị mất tin.',
    '  Bấm lại nút Hỗ trợ là mở đúng tin mới nhất.',
    '- **Chủ động chọn "Tiếp tục với AI" hay "Đợi gặp admin/support"** khi câu hỏi liên quan bản',
    '  quyền/key — app hỏi trước, không tự đoán theo từ khoá. Bản quyền hết hạn vẫn liên hệ được admin.',
    '- **Admin tiếp quản / trả lại phiên**: khi admin giữ phiên thì AI tạm dừng ngay và huỷ tác vụ đang',
    '  chạy; admin gõ `/stop` là AI trả lời tiếp. Người không có quyền admin không thể đóng phiên.',
    '- **AI không lỗ âm thầm**: nếu model cắt ngang giữa chừng, phần đã trả vẫn còn lại kèm lý do',
    '  thay vì mất trắng; có trạng thái rõ từng bước (đọc yêu cầu → chạy công cụ → tổng hợp →',
    '  tìm cấu hình AI) và không lộ suy luận nội bộ của model.',
    '- **Chờ AI tự tìm cấu hình nhanh hơn**: app chọn đúng dạng yêu cầu ngay từ đầu, lùi dần tới mức',
    '  chat thuần thay vì chờ hàng phút; có trần chờ và báo rõ cấu hình nào đang kiểm tra.',
    '- **Thêm adapter provider native**: OpenAI Chat, OpenAI Responses, Anthropic và Gemini,',
    '  giữ function-call/thought signature và JSON Schema; key chỉ nằm trong header, không lọt vào URL.',
    '- Telegram: `/ai` → **➕ Cấu hình · 3 dòng** (URL, model, key), tự kiểm tra và chọn cấu hình;',
    '  thêm nút `/stop`, bảng điều khiển cập nhật tại chỗ, có deep health check và lịch sử kiểm tra.',
    '- **Giữ nguyên toàn bộ chức năng cũ**: tải hóa đơn nhiều MST, XML/PDF gốc, CAPTCHA/OCR, kho dữ liệu,',
    '  tổng quan, sao kê/đối chiếu, xuất Excel/MISA, tra cứu MST/tờ khai, bản quyền và cập nhật ứng dụng.',
  ],
  '1.1.0': [
    '- **Một kỳ lọc chung cho toàn bộ app**: trước mỗi tab một bộ lọc riêng và tự khởi đầu bằng',
    '  kỳ khác nhau (Tổng quan = tháng này, Kho dữ liệu = năm, Sao kê = tất cả) nên chuyển tab thấy',
    '  số lệch nhau mà không biết vì sao. Nay **một nút kỳ duy nhất ở đầu trang**: bấm vào đổi, và',
    '  **mọi tab cùng đổi theo** — kể cả bản xuất Excel. Chọn “Tất cả thời gian” để xem tất cả.',
    '- **Tab Sao kê ngân hàng Giai đoạn 1**: 6 thẻ số, biểu đồ tiền vào – tiền ra theo thời gian,',
    '  ô “Cần xử lý”, bộ lọc tài khoản/nhóm giao dịch/trạng thái đối chiếu và **phân nhóm giao dịch**.',
    '  Mở tab không còn trống trơn: nếu kỳ đang chọn không có giao dịch, app ghi rõ dữ liệu nằm ở khoảng nào.',
    '- **Bấm một đối tác là ra danh sách hóa đơn của đối tác đó**, xem được hóa đơn khổ A4 và',
    '  phân loại tiền mặt / chuyển khoản ngay trong danh sách.',
    '- **Sửa lỗi mất giao dịch khi nhập sao kê**: trước đây hai giao dịch trùng ngày + số tiền +',
    '  nội dung bị xem là trùng và **âm thầm bị bỏ** trong khi vẫn báo “số liệu khớp”. Nay mỗi lần xuất',
    '  hiện được giữ đủ, và những dòng bị bỏ đều nêu rõ thay vì giấu chung vào số liệu “trùng”.',
    '- **Sửa lỗi sao kê dài hơn 1 MB không lưu được**: giờ nhận tới 20 MB và báo rõ khi vượt hạn mức.',
    '- **Sửa hộp xác nhận bấm không được**: nút “Xoá” / “Chuyển MST…” trong hộp Quản lý file sao kê',
    '  mở hộp xác nhận nằm **dưới** hộp cha nên không bấm được.',
    '- **Đối chiếu nhanh hơn 2,6–3,3 lần** trên kho lớn (kết quả khớp từng dòng), và lỗi đối chiếu',
    '  giờ được ghi ra nhật ký thay vì bị bỏ qua âm thầm.',
    '- **Giao diện gọn hơn**: đầu trang còn **2 hàng** thay vì 4 (tiết ~139px), bộ lọc kỳ thu về',
    '  **một nút**, tiêu đề tab đứng chung hàng với dãy nút.',
  ],
  '1.0.9': [
    '- **Tab “Tổng quan” đầy đủ**: KPI, biểu đồ bán ra/mua vào theo 12 tháng, tổng hợp hàng hoá,',
    '  công nợ phải thu – phải trả, doanh thu luỹ kế kèm **ngưỡng thuế theo năm + loại hình kinh doanh**',
    '  (số liệu lấy 100% từ SQLite, không hard-code) và bản **JSON thống kê** để sẵn cho AI.',
    '- **Đối chiếu sao kê ngân hàng với hoá đơn**: tự phân loại **tiền mặt / chuyển khoản**, khớp từng giao dịch,',
    '  phát hiện **hoá đơn chuyển khoản chưa có sao kê**, **sao kê chưa có hoá đơn**, **lệch số tiền**,',
    '  **lệch đối tượng**. Dòng “Cần kiểm tra” trên Tổng quan bấm được để xem từng chi tiết, kèm nút',
    '  **Đọc lại file hoá đơn gốc** bù hình thức thanh toán còn thiếu (không sửa file, không sửa số tiền).',
    '- **Quét bù lịch sử**: tự nhận ra khoảng ngày còn thiếu và quét lại, ưu tiên MST lâu chưa quét nhất.',
    '- **Khởi động nhanh hơn**: màn hình khởi động có tiến trình, nhớ đúng MST đang chọn khi mở lại app,',
    '  và cache tài sản tĩnh bằng ETag nên mở lại giao diện nhanh hơn.',
    '- **EXE nhẹ hơn**: tài sản giao diện được rút gọn ngay lúc đóng gói; bản gốc vẫn nằm trong EXE làm đường lùi.',
    '- Sửa: toàn bộ hộp thoại xác nhận/nhập liệu dùng popup đồng bộ của app (không còn hộp native của trình duyệt).',
  ],
  '1.0.8': [
    '- **Tab “Sao kê ngân hàng”**: nhập sao kê Excel/CSV, đọc **PDF có chữ ngay trong máy** (không gửi lên mạng),',
    '  chuẩn hoá ngày/số tiền, tự bỏ giao dịch trùng, lọc theo ngày – khoảng tiền – tiền vào/tiền ra,',
    '  quản lý file đã nhập (xoá hoặc chuyển sang MST khác) và xuất Excel sheet “Sao kê ngân hàng”.',
    '- Sửa lỗi giao diện: khối Kho dữ liệu không còn tràn sang tab Sao kê ngân hàng; bộ lọc nằm cột trái,',
    '  bảng giao dịch nằm cột phải (trước đây bảng bị nhét vào cột 312px nên chỉ thấy một góc).',
  ],
};

function fourPart(v) {
  const parts = String(v).split('.').map(n => (/^\d+$/.test(n) ? n : '0'));
  while (parts.length < 4) parts.push('0');
  return parts.slice(0, 4).join('.');
}

(async () => {
  if (!fs.existsSync(appExe)) {
    throw new Error(`Không thấy ${path.relative(root, appExe)}. Chạy "npm run build" trước.`);
  }
  if (!fs.existsSync(nsi)) throw new Error(`Không thấy ${path.relative(root, nsi)}.`);
  if (!fs.existsSync(icon)) throw new Error(`Không thấy ${path.relative(root, icon)}. Chạy "node tools/make-icon.cjs".`);

  const makensis = findMakensis();
  if (!makensis) {
    throw new Error('Không tìm thấy makensis. Cài NSIS: "choco install nsis -y" (hoặc đặt biến môi trường MAKENSIS trỏ tới makensis.exe).');
  }

  fs.mkdirSync(payloadDir, { recursive: true });
  fs.copyFileSync(appExe, payloadExe);
  console.log(`Payload: ${path.relative(root, payloadExe)}`);

  const args = [
    `-DVERSION=${version}`,
    `-DVI_VERSION=${fourPart(version)}`,
    '-DAPP_EXE=CN-Tax-Tools.exe',
    '-DAPP_BASENAME=CN-Tax-Tools',
    `-DREPO=${repository}`,
    nsi,
  ];
  console.log(`\n> ${makensis} ${args.join(' ')}\n`);
  const result = spawnSync(makensis, args, { stdio: 'inherit', cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`makensis thất bại (exit ${result.status}).`);

  if (!fs.existsSync(setupExe)) throw new Error(`makensis không tạo ra ${path.relative(root, setupExe)}.`);

  const hash = crypto.createHash('sha256').update(fs.readFileSync(setupExe)).digest('hex');
  const setupName = path.basename(setupExe);
  fs.writeFileSync(`${setupExe}.sha256`, `${hash}  ${setupName}${os.EOL}`);

  const whatsNew = WHATS_NEW[version] || [];
  const notes = [
    `# CN Tax Tools v${version}`,
    '',
    ...(whatsNew.length ? ['## Có gì mới', '', ...whatsNew, ''] : []),
    '## Cài lần đầu',
    '',
    `Tải **${setupName}** ở phần Assets bên dưới và chạy. Chỉ cần 1 file này — không cần ZIP/RAR,`,
    'không cần cài thêm dependency.',
    '',
    '## Cập nhật cho máy đã cài',
    '',
    '**Đang dùng v1.0.2 trở lên**: bạn không cần tải gì — mở CN Tax Tools, app báo có bản mới rồi tự tải,',
    'tự xác minh SHA-256, thay chương trình và khởi động lại. Setup chỉ dùng cho lần cài đầu tiên',
    '(hoặc repair/gỡ cài đặt).',
    '',
    '**Đang dùng v1.0.0 hoặc v1.0.1**: bản cũ chỉ *báo* có bản mới chứ chưa tự cập nhật được. Hãy tải',
    `**${setupName}** và chạy một lần — dữ liệu trong \`du_lieu\` (danh sách MST, phiên đăng nhập, hóa đơn)`,
    'được giữ nguyên. Từ bản này trở đi, mọi lần cập nhật sau đều tự động trong app.',
    '',
    `Nếu muốn tải tay cho bản self-update: **CN-Tax-Tools-v${version}.exe** (kèm \`.sha256\`).`,
    '',
    'Khi chạy, trình cài đặt cho chọn 1 trong 2 chế độ:',
    '',
    '- **CÀI ĐẶT VÀO WINDOWS**: cài vào hồ sơ người dùng, tạo shortcut Desktop + Start Menu,',
    '  có mục gỡ cài đặt trong Windows, có tuỳ chọn chạy ngay sau khi cài.',
    '- **PORTABLE**: chỉ giải nén vào thư mục bạn chọn để chạy `CN-Tax-Tools.exe` trực tiếp,',
    '  không ghi vào Windows, không có gỡ cài đặt.',
    '',
    'Yêu cầu: **Windows 64-bit (x64)**, có sẵn **Google Chrome** hoặc **Microsoft Edge**',
    '(Edge có sẵn trong Windows 10/11). Không cần Node.js/Python/Chromium. Không cần quyền Administrator.',
    '',
    'Cả hai chế độ lưu dữ liệu trong thư mục `du_lieu` nằm cạnh `CN-Tax-Tools.exe`,',
    'nên bản Portable có thể copy cả thư mục sang máy khác.',
    '',
    '## SHA-256',
    '',
    '```',
    `${hash}  ${setupName}`,
    '```',
    '',
  ].join('\n');
  // Ghi chú sinh ở đây (không lấy từ repo) vì nó chứa SHA-256 của đúng file Setup vừa đóng gói.
  // NSIS nhúng timestamp nên mỗi lần build cho SHA khác nhau — commit sẵn vào repo là vô nghĩa.
  fs.writeFileSync(path.join(releaseDir, 'RELEASE_NOTES.md'), notes);

  console.log(`\nSetup:   ${path.relative(root, setupExe)}`);
  console.log(`SHA-256: ${hash}`);
  console.log(`Ghi kèm: ${path.relative(root, `${setupExe}.sha256`)} và release/RELEASE_NOTES.md`);
})().catch(error => {
  console.error(`\nLỖI đóng gói Setup: ${error.message}`);
  process.exit(1);
});
