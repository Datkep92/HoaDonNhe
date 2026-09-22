const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureFolder, PROBE } = require('../src/folders');

function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-folder-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('a drive root is refused with an explanation instead of a raw EPERM', async () => {
  await assert.rejects(() => ensureFolder('D:\\'), /ổ đĩa gốc/);
  await assert.rejects(() => ensureFolder('D:'), /ổ đĩa gốc|đầy đủ/); // 'D:' là đường dẫn tương đối theo ổ
  await assert.rejects(() => ensureFolder('D:/'), /ổ đĩa gốc/);
  await assert.rejects(() => ensureFolder(''), /Chưa chọn thư mục/);
  await assert.rejects(() => ensureFolder('HoaDon\\2026'), /đầy đủ/);
});
test('a proper folder is created and write-probed', async t => {
  const dir = path.join(scratch(t), 'MST-4500677693', 'Mua_vao');
  assert.equal(await ensureFolder(dir), dir);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, PROBE)), false, 'the write probe must be removed');
});
test('a folder that cannot be created says what went wrong', async t => {
  const base = scratch(t);
  const file = path.join(base, 'khong-phai-thu-muc.txt'); fs.writeFileSync(file, 'x');
  await assert.rejects(() => ensureFolder(path.join(file, 'con')), /Không (tạo|ghi) được thư mục/);
});
test('an existing folder is accepted as is', async t => {
  const dir = scratch(t);
  assert.equal(await ensureFolder(dir), dir);
});
