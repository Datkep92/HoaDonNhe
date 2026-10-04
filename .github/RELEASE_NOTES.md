# CN Tax Tools v1.1.3 — ghi chú phát hành

> File này được commit vào repo nên CI luôn đọc được (thư mục `release/` bị .gitignore).
> Cố ý **không** ghi SHA-256 ở đây: NSIS đóng timestamp nên mỗi lần build ra hash khác nhau.
> Hash thật do `npm run installer` ghi vào `release/*.sha256`, workflow tính lại lúc build.

Bản này gom phần việc của kỳ refactor AI, đồng thời dọn kho và khôi phục landing page đang chạy.

## Tính năng

### Trợ lý AI chạy được trong app (đợt refactor lớn)

`src/ai-bridge.js` cũ chỉ là một file khổng lồ, vỡ dần theo số tính năng. Nay tách thành **21 module** trong `src/ai/`:

| Nhóm | Module | Việc |
| --- | --- | --- |
| Lõi | `agent.js`, `tool-router.js`, `prompt.js` | vòng lặp agent, định tuyến lệnh, dựng prompt |
| Công cụ | `tool-registry.js`, `fs-tools.js`, `db-tools.js`, `pdf-tools.js`, `cloud-tools.js` | đăng ký + chạy tool |
| An toàn | `permission-engine.js`, `access-policy.js`, `audit-log.js`, `data-minimizer.js` | chặn ngoài vùng dữ liệu, giới hạn theo vai trò, ghi log, lọc dữ liệu gửi đi |
| Sandbox | `safe-js.js` | chạy JS trong QuickJS thay vì `eval` trực tiếp |
| Trạng thái | `session-store.js`, `context-manager.js`, `dataset-store.js`, `attachments.js` | hội thoại, ngữ cảnh, tập dữ liệu, tệp đính kèm |
| Cấu hình | `config.js`, `identity.js`, `model-provider.js`, `openrouter-client.js` | đọc `.env`, định danh máy, gọi model |

Ba điểm an toàn đáng chú ý so với bản cũ:

1. **`safe-js` dùng QuickJS** (`quickjs-emscripten`) thay cho `eval`. Mã do AI sinh ra không chạy trực tiếp trên tiến trình Node của app.
2. **`permission-engine` chặn vùng dữ liệu.** Tool đọc/ghi file và DB bị giới hạn theo danh sách đường dẫn được phép — không còn đường dẫn tự do.
3. **`audit-log` ghi lại mọi lần gọi tool**, kể cả lần bị từ chối, để truy vết được AI đã đụng vào dữ liệu nào.

### `.env` không còn lọt lên git

`.gitignore` chặn `.env` và `.env.*`; thêm `.env.example` làm mẫu (giá trị rỗng). Khóa API của người dùng giờ nằm ngoài repo.

## Sửa lỗi / dọn dẹp

### Khôi phục `landing-v4`

`landing-v4` (trang đang phục vụ trên GitHub Pages) từng bị xoá khỏi cây làm việc trong lúc dọn dẹp. `.github/workflows/pages.yml` kiểm tra bắt buộc `landing-v4/index.html`, `.nojekyll`, `assets/css/style.css`, `assets/js/main.js` — thiếu thì workflow hỏng. Nay đã khôi phục nguyên vẹn.

`landing-v2` và `landing-v3` (hai bản cũ không còn dùng) vẫn giữ ở trạng thái đã xoá.

### Bỏ thư mục `KETOAN`

Hai file mẫu `.xls`/`.xlsx` cũ. Bản mẫu dùng thật của app nằm ở `src/template/`.

## Build và kiểm tra

- **901 test: 894 pass, 0 fail, 7 skip.**
- Thay `tests/ai-bridge.test.js` bằng `ai-agent`, `ai-files`, `ai-master` — tất cả nằm trong `npm test` (danh sách test được liệt kê tường minh trong `package.json` nên thêm file mới cũng không thể quên khai báo).
- `tools/verify-exe.cjs` kiểm tra thêm phần runtime AI và 21 file `src/ai/` phải nằm trong EXE.
- Build v1.1.3: `npm run build` → `release/CN-Tax-Tools-v1.1.3.exe`, đã tự kiểm 80/80 file nhúng, OCR đọc đúng ảnh mẫu, smoke-test `ui`/`api`/`aiRuntime` đều OK.
