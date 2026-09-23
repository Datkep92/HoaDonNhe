'use strict';
// Ẩn cửa sổ terminal khi mở EXE: pkg đóng gói trên nền node.exe (ứng dụng console) nên sau khi
// build phải vá 2 byte trong PE header — subsystem 3 (console) -> 2 (GUI). EXE vẫn chạy y hệt,
// chỉ không còn cửa sổ đen. Mọi thông báo khởi động/lỗi được ghi vào du_lieu/nhat-ky.log.
// Dùng: node tools/hide-console.cjs release/CN-Tax-Tools-v1.0.0.exe
const fs = require('node:fs');
const file = process.argv[2];
if (!file) { console.error('Dùng: node tools/hide-console.cjs <đường dẫn exe>'); process.exit(1); }
const buffer = fs.readFileSync(file);
if (buffer.length < 0x100 || buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error(`${file} không phải file EXE.`);
const peOffset = buffer.readUInt32LE(0x3c);
if (peOffset + 24 + 0x46 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') throw new Error('Không tìm thấy PE header trong EXE.');
const subsystemAt = peOffset + 24 + 0x44; // Optional Header: Subsystem
const current = buffer.readUInt16LE(subsystemAt);
if (current === 2) { console.log('EXE đã ở chế độ GUI (2), không cần vá.'); process.exit(0); }
if (current !== 3) console.warn(`Cảnh báo: subsystem hiện tại là ${current} (không phải 3), vẫn ghi thành 2.`);
buffer.writeUInt16LE(2, subsystemAt);
fs.writeFileSync(file, buffer);
console.log(`Đã ẩn cửa sổ terminal: subsystem ${current} → 2 · ${file}`);
