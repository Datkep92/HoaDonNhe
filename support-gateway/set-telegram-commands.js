'use strict';

// ===========================================================================
// GÁN DANH SÁCH LỆNH CHO BOT TELEGRAM (setMyCommands)
//
// Vì sao cần script này:
//   Telegram KHÔNG tự suy ra danh sách lệnh từ code. Menu lệnh (nút ☰ cạnh
//   ô nhập tin) là một cấu hình riêng trên máy chủ Telegram, do đăng ký qua
//   BotFather hoặc API setMyCommands. Worker/Apps Script có xử lý `/ai` thì
//   Telegram vẫn không hiện nó trong menu — trước đây vì vậy menu chỉ hiện
//   /lock /unlock… (đăng ký từ lâu) và các lệnh /ai mới "biến mất" khỏi menu.
//
// Cách dùng (PowerShell):
//   $env:TELEGRAM_BOT_TOKEN='123:ABC'; node support-gateway/set-telegram-commands.js
//   Hoặc nhập tay khi chạy lệnh trên (không cần tạo biến môi trường):
//   node support-gateway/set-telegram-commands.js
//
// Chạy lại script là vô hại: nó ghi đè danh sách, không xoá gì ngoài ý muốn.
// Muốn xem lại danh sách hiện tại mà không ghi: chạy với --list.
// ===========================================================================

const https = require('node:https');

const DEFAULT_LANGUAGE = 'vi';

// Danh sách lệnh của bot. `command` KHÔNG được chứa dấu "/" (Telegram tự thêm),
// tối đa 32 ký tự, và CHỈ chữ thường + số + "_" — Telegram trả BOT_COMMAND_INVALID
// nếu có chữ hoa, và khi đó KHÔNG lệnh nào được ghi cả. Vì vậy lệnh tra cứu SĐT
// đăng ký là /check_sdt (Worker nhận cả /check_SDT vì regex không phân biệt hoa
// thường). `description` tối đa 256 ký tự — giữ ngắn gọn vì Telegram hiện trên
// nút hẹp, dài quá bị cắt. Thứ tự = thứ tự hiện trong menu.
const COMMANDS = [
  { command: 'stop', description: 'Đóng phiên admin trong topic này, cho AI hoạt động lại' },
  { command: 'ai', description: 'Cấu hình AI của bot (menu nút bấm: xem/bật/thêm key/kiểm tra key)' },
  { command: 'ai_add', description: 'Tạo mới hoặc sửa cấu hình AI: /ai add <tên> <url> <model>' },
  { command: 'ai_use', description: 'Bật một cấu hình AI cho mọi máy: /ai use <tên>' },
  { command: 'ai_del', description: 'Xoá một cấu hình AI: /ai del <tên>' },
  { command: 'ai_url', description: 'Đổi địa chỉ API của cấu hình: /ai url <tên> <url>' },
  { command: 'ai_model', description: 'Đổi model của cấu hình: /ai model <tên> <model>' },
  { command: 'ai_key', description: 'Quản lý API key: /ai key <tên> add|list|del|check ...' },
  { command: 'check', description: 'Xem thông tin bản quyền của máy trong topic này' },
  { command: 'info', description: 'Tương tự /check — xem thông tin bản quyền của máy' },
  { command: 'new', description: 'Cấp key mới: /new [thang|nam] [số máy]' },
  { command: 'extend', description: 'Gia hạn thêm số ngày: /extend 30' },
  { command: 'reset', description: 'Gỡ liên kết máy để khách kích hoạt sang máy khác' },
  { command: 'lock', description: 'Khoá thiết bị' },
  { command: 'unlock', description: 'Mở khoá thiết bị' },
  { command: 'who', description: 'Trạng thái NGAY BÂY GIỜ của máy trong topic này' },
  { command: 'online', description: 'Danh sách máy đang chạy / đã tắt app' },
  { command: 'check_sdt', description: 'Tra cứu khách theo số điện thoại: /check_0987654321' },
  { command: 'link', description: 'Gắn lại topic với máy: /link ROOM_WIN_XXXXXXXXXXXX' },
];

function post(token, method, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      let out = '';
      response.setEncoding('utf8');
      response.on('data', part => { out += part; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(out); } catch { return reject(new Error(`Telegram trả về không phải JSON: ${out.slice(0, 200)}`)); }
        if (!parsed.ok) return reject(new Error(parsed.description || 'Telegram từ chối yêu cầu.'));
        resolve(parsed.result);
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

// Đọc token: biến môi trường trước, hỏi trên console sau. Không ghi token ra
// file .env và không in ra màn hình — token bot là bí mật của Gateway.
async function ask(question) {
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return String(await rl.question(question)).trim(); } finally { rl.close(); }
}

(async () => {
  const listOnly = process.argv.includes('--list');
  let token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token && !listOnly) {
    // process.stdin.isTTY false khi chạy trong CI/pipeline → hỏi sẽ treo, nên bỏ qua.
    if (process.stdin.isTTY) token = await ask('TELEGRAM_BOT_TOKEN (gõ vào, không in ra log): ');
  }
  if (!token) {
    console.error('Cần TELEGRAM_BOT_TOKEN. Đặt biến môi trường rồi chạy lại, ví dụ:\n  $env:TELEGRAM_BOT_TOKEN=\'123:ABC\'; node support-gateway/set-telegram-commands.js');
    process.exitCode = 1;
    return;
  }

  if (listOnly) {
    // Telegram lưu lệnh THEO NGÔN NGỮ. Danh sách được gán với language_code=vi
    // nên phải hỏi đúng ngôn ngữ đó; hỏi bản không ngôn ngữ sẽ ra rỗng và dễ
    // làm người vận hành tưởng chưa đăng ký gì cả.
    const rows = [];
    for (const language of [DEFAULT_LANGUAGE, '']) {
      const current = await post(token, 'getMyCommands', { scope: { type: 'default' }, language_code: language });
      for (const item of current) rows.push('/' + item.command + ' — ' + item.description + '  [' + (language || 'mặc định') + ']');
    }
    console.log(rows.length ? [...new Set(rows)].join('\n') : '(chưa có lệnh nào được đăng ký)');
    return;
  }

  // Ghi cho các phạm vi Telegram thực sự chấp nhận (Bot API: default,
  // all_private_chats, all_group_chats, chat_administrators, chat, user…). Ở đây
  // gán "default" (áp cho mọi nơi chưa đặt riêng), "all_group_chats" (mọi nhóm,
  // gồm supergroup có Topics) và "chat_administrators" (mọi nơi mà người dùng
  // là admin — đúng chỗ admin gõ lệnh).
  // `chat_administrators` BẮT BUỘC kèm chat_id (Telegram trả lỗi "Can't find
  // field chat_id" nếu thiếu), nên chỉ gán phạm vi này khi có TELEGRAM_CHAT_ID.
  const scopes = [{ type: 'default' }, { type: 'all_group_chats' }];
  const chatId = Number(process.env.TELEGRAM_CHAT_ID || 0);
  if (chatId) scopes.push({ type: 'chat_administrators', chat_id: chatId });
  let failed = 0;
  for (const scope of scopes) {
    try {
      await post(token, 'setMyCommands', { scope, language_code: DEFAULT_LANGUAGE, commands: COMMANDS });
      console.log('Đã gán ' + COMMANDS.length + ' lệnh cho phạm vi ' + scope.type + '.');
    } catch (error) {
      // Một phạm vi hỏng không được làm mất các phạm vi đã gán được, và phải nói
      // rõ phạm vi nào hỏng — im lặng thì admin tưởng đã xong xuôi.
      failed++;
      console.error('⚠️ Phạm vi ' + scope.type + ': ' + error.message);
    }
  }
  if (!chatId) console.log('Bỏ qua phạm vi chat_administrators vì thiếu TELEGRAM_CHAT_ID (không bắt buộc).');
  console.log(failed ? '⚠️ Còn ' + failed + ' phạm vi chưa gán được.' : 'Xong. Mở lại nhóm Telegram (đóng/mở app) để thấy danh sách mới.');
})().catch(error => {
  console.error('Không gán được danh sách lệnh: ' + error.message);
  process.exitCode = 1;
});
