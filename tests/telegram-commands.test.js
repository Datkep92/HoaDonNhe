'use strict';
// ---------------------------------------------------------------------------
// Danh sách lệnh Telegram phải khớp với lệnh mà Gateway thực sự xử lý.
//
// Vì sao cần test: Telegram không suy ra danh sách lệnh từ code. Thêm lệnh mới
// trong Worker mà quên chạy `npm run telegram:commands` thì lệnh đó chạy được
// nhưng KHÔNG hiện trong menu — đúng lỗi đã xảy ra với /ai. Test này chặn
// trường hợp đó ngay tại lần chạy test, không phải lúc khách báo.
// ---------------------------------------------------------------------------
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'support-gateway', 'set-telegram-commands.js');
const WORKER = path.join(ROOT, 'cloudflare-worker', 'src', 'index.js');
const CODE_GS = path.join(ROOT, 'support-gateway', 'apps-script', 'Code.gs');

// Lấy mảng COMMANDS mà KHÔNG chạy phần gọi mạng của script: chỉ nạp đúng khối
// khai báo lệnh. Chạy cả file sẽ bắt đầu gọi api.telegram.org — không được.
function commands() {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const from = source.indexOf('const COMMANDS = [');
  const to = source.indexOf('\n];', from);
  assert.ok(from > 0 && to > from, 'không tìm thấy khai báo COMMANDS trong script');
  return vm.runInNewContext('(' + source.slice(from + 'const COMMANDS = '.length, to + 2) + ')');
}

async function runRegistration(args=[],mismatch=false) {
  let source=fs.readFileSync(SCRIPT,'utf8');
  const calls=[],stored=new Map(),proc={argv:['node',SCRIPT,...args],env:{TELEGRAM_BOT_TOKEN:'test-only',TELEGRAM_CHAT_ID:'-100123'},stdin:{isTTY:false},stderr:{}};
  source=source.replace('(async () => {',`post = globalThis.mockPost; globalThis.job = (async () => {`);
  const context=vm.createContext({require:()=>({}),Buffer,process:proc,console:{log(){},error(){}},mockPost:async(token,method,payload)=>{
    calls.push({method,payload});const key=JSON.stringify([payload.scope,payload.language_code]);
    if(method==='setMyCommands'){stored.set(key,payload.commands);return true;}
    return mismatch?[]:stored.get(key)||[];
  }});
  vm.runInContext(source,context);await context.job;return {calls,proc};
}

test('registration writes and reads back both languages in default, group and admin scopes',async()=>{
  const {calls,proc}=await runRegistration();
  const writes=calls.filter(x=>x.method==='setMyCommands'),reads=calls.filter(x=>x.method==='getMyCommands');
  assert.equal(writes.length,6);assert.equal(reads.length,6);assert.equal(proc.exitCode,undefined);
  for(const type of ['default','all_group_chats','chat_administrators'])for(const language of ['','vi'])assert.ok(writes.some(x=>x.payload.scope.type===type&&x.payload.language_code===language));
  assert.equal(writes.find(x=>x.payload.scope.type==='chat_administrators').payload.scope.chat_id,-100123);
});
test('listing queries the same six scope/language pairs and failed verification exits nonzero',async()=>{
  const list=await runRegistration(['--list']);assert.equal(list.calls.length,6);assert.ok(list.calls.every(x=>x.method==='getMyCommands'));
  const failed=await runRegistration([],true);assert.equal(failed.proc.exitCode,1);
});

test('mọi lệnh đăng ký đều đúng định dạng Telegram', () => {
  const list = commands();
  assert.ok(list.length, 'phải có danh sách lệnh');
  const seen = new Set();
  // Telegram CHỈ nhận chữ thường + số + gạch dưới trong tên lệnh; có chữ hoa là
// setMyCommands trả BOT_COMMAND_INVALID và KHÔNG lệnh nào được ghi — đúng lỗi
// đã gặp khi đăng ký /check_SDT. Vì vậy phải kiểm trước khi gọi.
  for (const item of list) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/, 'tên lệnh sai định dạng Telegram: ' + item.command);
    assert.doesNotMatch(item.command, /^\//, 'tên lệnh không được có dấu /: ' + item.command);
    assert.ok(item.description && item.description.length <= 256, 'mô tả phải có và không quá 256 ký tự: ' + item.command);
    assert.equal(seen.has(item.command), false, 'lệnh bị lặp: ' + item.command);
    seen.add(item.command);
  }
});

test('compact commands match Worker menu while legacy typed commands stay supported', () => {
  const worker = fs.readFileSync(WORKER, 'utf8');
  const gas = fs.readFileSync(CODE_GS, 'utf8');

  // Lệnh Gateway tự nhận diện trước (nhánh toàn cục / theo phòng).
  for (const name of ['online', 'ai', 'who']) {
    assert.ok(worker.includes(`/${name}`), 'Worker phải còn xử lý /' + name);
    assert.ok(commands().some(c => c.command === name), 'thiếu lệnh /' + name + ' trong danh sách đăng ký');
  }
  // /trang-thai là bí danh tiếng Việt của /who: không bắt buộc phải đăng ký (nó
  // chỉ là cách gõ thay thế), nên chỉ nhắc Worker còn hỗ trợ.
  assert.ok(worker.includes('/trang-thai'), 'Worker phải còn hỗ trợ bí danh /trang-thai');
  // /check_SDT là dạng lệnh tra cứu SĐT. Worker nhận không phân biệt hoa thường,
  // nhưng danh sách đăng ký BẮT BUỘC phải viết thường.
  assert.ok(worker.includes('check[_\\s]'), 'Worker phải còn xử lý lệnh tra cứu SĐT');
  assert.ok(commands().some(c => c.command === 'check_sdt'), 'thiếu lệnh /check_sdt');

  // Lệnh quản trị do Apps Script xử lý.
  for (const name of ['check', 'info', 'new', 'extend', 'reset', 'lock', 'unlock']) {
    assert.ok(gas.includes("command === '/" + name + "'"), 'Apps Script phải còn xử lý /' + name);
  }
  const start=worker.indexOf('function adminMenuCommands_()'),end=worker.indexOf('function adminMenuMarkup_',start);
  const actual=vm.runInNewContext(worker.slice(start,end)+'adminMenuCommands_()');
  assert.equal(JSON.stringify(commands()),JSON.stringify(actual));
  for(const name of ['menu','check','checkdulieu','billing','cancel'])assert.ok(commands().some(c=>c.command===name));
  for (const name of ['ai_add','ai_use','ai_del','ai_url','ai_model','ai_key','usage','new','commerce','lock'])assert.ok(!commands().some(c=>c.command===name));
});
