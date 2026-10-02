'use strict';
// ---------------------------------------------------------------------------
// ĐỐI SOÁT DỮ LIỆU HỖ TRỢ — công cụ vận hành, chạy tay khi cần.
//
// Mục tiêu: bảo đảm "1 máy = 1 mã máy = 1 phòng chat = 1 topic Telegram".
// Trước khi có mã máy ổn định, mỗi lần khách cài lại app / bật VPN / đổi tên máy
// là sinh thêm một dòng Sheet và một topic Telegram. Công cụ này tìm ra những
// trường hợp còn sót lại và gợi ý sửa.
//
// CÁCH DÙNG
//   $env:FIREBASE_DATABASE_URL         = 'https://<project>-default-rtdb.firebaseio.com'
//   $env:FIREBASE_SERVICE_ACCOUNT_JSON = '<nội dung file json service account>'
//   node tools/support-reconcile.cjs                    # chỉ báo cáo
//   node tools/support-reconcile.cjs --fix              # sửa an toàn (nối lại mapping)
//   node tools/support-reconcile.cjs --fix --mark-stale # đánh dấu topic thừa
//   node tools/support-reconcile.cjs --delete-orphan-topics
//   node tools/support-reconcile.cjs --json
//
// Cần thêm TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID chỉ khi xoá topic Telegram.
//
// MẶC ĐỊNH CHỈ BÁO CÁO. --fix chỉ sửa thứ chắc chắn đúng (nối lại mapping ngược).
// Xoá topic Telegram thì phải nói rõ cờ --delete-orphan-topics vì không hoàn tác được.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const crypto = require('node:crypto');

const DAY = 24 * 3600000;

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const FLAG_FIX = has('--fix');
const FLAG_DELETE_TOPICS = has('--delete-orphan-topics');
const FLAG_JSON = has('--json');

// ---------------------------------------------------------------------------
// PHẦN THUẦN — không I/O, test được trực tiếp.
// ---------------------------------------------------------------------------
/**
 * @param {{rooms?: object, topics?: object, devices?: object}} snapshot
 * @returns {{problems: Array, summary: object}}
 */
function analyze(snapshot, now = Date.now()) {
  const rooms = snapshot.rooms || {};
  const topics = snapshot.topics || {};
  const devices = snapshot.devices || {};
  const problems = [];
  const note = (level, code, title, detail = '') => problems.push({ level, code, title, detail });

  for (const [room, data] of Object.entries(rooms)) {
    const meta = data.meta || {};
    const messages = Object.keys(data.messages || {}).length;
    const device = devices[room] || {};

    // 1. Phòng chưa có topic -> lần chat tới sẽ tự tạo, nhưng nên tạo sẵn.
    if (!meta.telegramThreadId) {
      note(messages ? 'warn' : 'info', 'room-chua-co-topic', `Phòng chưa có topic Telegram: ${room}`,
        messages ? `Phòng đã có ${messages} tin nhắn nhưng chưa gắn topic.` : 'Phòng mới, chưa gắn topic. Không cần làm gì.');
      continue;
    }

    const thread = String(meta.telegramThreadId);
    const mapped = topics[thread] ? String(topics[thread].chatRoomId || '') : '';

    // 2. Topic trỏ sang phòng khác.
    if (mapped && mapped !== room) {
      note('error', 'topic-tro-sai-phong', `Topic ${thread} đang trỏ về ${mapped} nhưng ${room} lại trỏ topic khác`,
        `Gõ /link ${room} trong topic ${thread} để sửa.`);
      continue;
    }
    // 3. Thiếu mapping ngược -> admin gõ trong topic này sẽ rơi im lặng.
    if (!mapped) {
      note('error', 'thieu-mapping', `Topic ${thread} của phòng ${room} chưa có mapping ngược trong Firebase`,
        'Sửa ngay bằng --fix (không mất dữ liệu).');
    }
  }

  // 4. Topic trỏ về phòng không tồn tại trong Firebase.
  for (const [thread, map] of Object.entries(topics)) {
    const target = String((map && map.chatRoomId) || '');
    if (target && !rooms[target]) {
      note('warn', 'topic-tro-phong-khong-ton-tai', `Topic ${thread} trỏ về phòng ${target} nhưng phòng đó không có trong Firebase`,
        'Phòng đã bị xoá khỏi Firebase nhưng topic vẫn còn.');
    }
  }

  // 5. Một phòng bị nhiều topic cùng trỏ tới -> admin gõ ở topic nào cũng nhận
  //    về app, khách thấy tin trùng. Đây là hệ quả của việc tạo topic trùng.
  const active = room => Number((rooms[room] && rooms[room].meta && rooms[room].meta.telegramThreadId) || 0);
  const activeAnywhere = new Set(Object.keys(rooms).map(active).filter(Boolean));
  const byRoom = new Map();
  for (const [thread, map] of Object.entries(topics)) {
    const target = String((map && map.chatRoomId) || '');
    if (!target) continue;
    if (!byRoom.has(target)) byRoom.set(target, []);
    byRoom.get(target).push(Number(thread));
  }
  const orphanTopics = [];
  for (const [room, list] of byRoom) {
    if (list.length <= 1) continue;
    const extra = list.filter(id => id !== active(room));
    orphanTopics.push(...extra);
    note('error', 'mot-phong-nhieu-topic', `Phòng ${room} đang bị ${list.length} topic trỏ tới: ${list.join(', ')}`,
      `Topic đang dùng: ${active(room) || '(chưa có)'}. Topic thừa: ${extra.join(', ') || '(không có)'}.`);
  }
  // CHỈ đưa vào danh sách dọn những topic mà KHÔNG phòng nào đang dùng.
  // Một topic có thể bị tranh: ROOM_A trỏ vào nó mà ROOM_B cũng trỏ vào nó. Xoá
  // đi là cắt luôn liên kết của ROOM_A — phải sửa tay bằng /link, không tự động.
  const safeToDelete = orphanTopics.filter(id => !activeAnywhere.has(id));

  // 6. Phòng có tin nhắn nhưng chưa từng đồng bộ -> app bản cũ.
  for (const [room, data] of Object.entries(rooms)) {
    const messages = Object.keys(data.messages || {}).length;
    const device = devices[room] || {};
    if (messages && !device.license) {
      note('warn', 'chua-co-ban-ghi-nho', `Phòng ${room} chưa có bản ghi nhớ bản quyền`,
        'Máy chủ chưa đồng bộ với app bản mới. Sẽ tự có sau lần khách mở app.');
    }
    const presence = device.presence || {};
    if (!presence.lastSeen) {
      note('info', 'chua-co-presence', `Phòng ${room} chưa ghi nhận lần chạy app nào`,
        'Máy chưa mở app kể từ khi thêm phần nhận diện.');
    } else if (now - Number(presence.lastSeen) > 30 * DAY) {
      note('info', 'khong-mo-app-lau', `Phòng ${room}: ${Math.floor((now - presence.lastSeen) / DAY)} ngày chưa mở app`,
        'Phiên bản ghi nhận: ' + (presence.appVersion || '—'));
    }
  }

  const summary = {
    rooms: Object.keys(rooms).length,
    topics: Object.keys(topics).length,
    devices: Object.keys(devices).length,
    errors: problems.filter(p => p.level === 'error').length,
    warns: problems.filter(p => p.level === 'warn').length,
    infos: problems.filter(p => p.level === 'info').length,
    // danh sách có thể dọn tự động + danh sách bị tranh, phải sửa tay.
    orphanTopics: [...new Set(safeToDelete)].sort((a, b) => a - b),
    contestedTopics: [...new Set(orphanTopics.filter(id => activeAnywhere.has(id)))].sort((a, b) => a - b),
  };
  return { problems, summary };
}

// ---------------------------------------------------------------------------
// Firebase (cùng cách làm OAuth với Worker: RS256 service account -> access token)
// ---------------------------------------------------------------------------
const b64url = value => Buffer.from(value).toString('base64url');
const json64 = value => b64url(JSON.stringify(value));

function loadServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const raw = inline || (file ? fs.readFileSync(file, 'utf8') : '');
  if (!raw) throw new Error('Thiếu FIREBASE_SERVICE_ACCOUNT_JSON (hoặc ..._FILE trỏ tới file json).');
  return JSON.parse(raw);
}

let tokenCache = { value: '', expiry: 0 };

async function accessToken(service) {
  if (tokenCache.expiry > Date.now() + 60000) return tokenCache.value;
  const now = Math.floor(Date.now() / 1000);
  const signed = json64({ alg: 'RS256', typ: 'JWT' }) + '.' + json64({
    iss: service.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database',
    aud: service.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const assertion = signed + '.' + b64url(crypto.sign('RSA-SHA256', Buffer.from(signed), service.private_key));
  const response = await fetch(service.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await response.json();
  if (!data.access_token) throw new Error('Không lấy được access token Firebase: ' + (data.error_description || data.error || 'không rõ'));
  tokenCache = { value: data.access_token, expiry: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

const firebaseUrl = String(process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');

async function fb(path, method = 'GET', value) {
  const service = loadServiceAccount();
  const options = { method, headers: { Authorization: 'Bearer ' + await accessToken(service) } };
  if (value !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(value); }
  const response = await fetch(firebaseUrl + path + '.json', options);
  if (!response.ok) throw new Error('Firebase ' + method + ' ' + path + ' -> HTTP ' + response.status);
  return response.json();
}

async function deleteTopic(threadId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('Cần TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID để xoá topic.');
  const response = await fetch('https://api.telegram.org/bot' + token + '/deleteForumTopic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, message_thread_id: Number(threadId) }),
  });
  const data = await response.json();
  return !!data.ok;
}

// ---------------------------------------------------------------------------
// Sửa
// ---------------------------------------------------------------------------
async function applyFixes(snapshot, analysis) {
  const fixed = [];
  const rooms = snapshot.rooms || {};
  const topics = snapshot.topics || {};

  // Nối lại mapping ngược cho phòng có topic nhưng thiếu mục /telegramTopics.
  for (const [room, data] of Object.entries(rooms)) {
    const thread = (data.meta || {}).telegramThreadId;
    if (!thread) continue;
    const mapped = topics[thread] ? String(topics[thread].chatRoomId || '') : '';
    if (mapped === room) continue;
    if (mapped && mapped !== room) continue;          // trường hợp này phải sửa tay
    await fb('/telegramTopics/' + thread, 'PUT', { chatRoomId: room, createdAt: Date.now() });
    fixed.push(`Nối lại topic ${thread} -> ${room}`);
  }

  // Topic thừa: đánh dấu stale, chỉ xoá thật khi được yêu cầu rõ ràng.
  for (const thread of analysis.summary.orphanTopics) {
    if (FLAG_DELETE_TOPICS) {
      if (await deleteTopic(thread)) { await fb('/telegramTopics/' + thread, 'DELETE'); fixed.push(`Đã xoá topic thừa ${thread}`); }
      else fixed.push(`Không xoá được topic ${thread}`);
    } else {
      await fb('/telegramTopics/' + thread, 'PUT', { stale: true, orphanOf: String(Object.keys(rooms).find(r => String((topics[thread] || {}).chatRoomId || '') === r) || ''), createdAt: Date.now() });
      fixed.push(`Đã đánh dấu topic thừa ${thread} là stale (chưa xoá trên Telegram)`);
    }
  }
  return fixed;
}

function report(snapshot, analysis, fixed) {
  if (FLAG_JSON) {
    console.log(JSON.stringify({ ...analysis.summary, problems: analysis.problems, fixed }, null, 2));
    return;
  }
  const s = analysis.summary;
  console.log(`\nĐã kiểm tra ${s.rooms} phòng chat, ${s.topics} topic Telegram, ${s.devices} máy.`);
  if (!analysis.problems.length) console.log('\n✓ Không có bất thường nào. Mỗi máy một mã, một phòng, một topic.\n');

  const icons = { error: '✗ LỖI', warn: '⚠ CẢNH BÁO', info: '· THÔNG TIN' };
  let current = '';
  for (const problem of analysis.problems) {
    if (problem.level !== current) { current = problem.level; console.log(`\n${icons[problem.level]}`); }
    console.log('  ' + problem.title);
    if (problem.detail) console.log('      ' + problem.detail);
  }

  if (fixed && fixed.length) {
    console.log('\nĐÃ SỬA:');
    for (const line of fixed) console.log('  ✓ ' + line);
  } else if (!FLAG_FIX) {
    console.log('\n(Chỉ đang báo cáo. Thêm --fix để sửa những mục an toàn.)');
  }
  console.log(`\nTóm lại: ${s.errors} lỗi, ${s.warns} cảnh báo, ${s.infos} thông tin.`);
  console.log(`Topic thừa, dọn được: ${s.orphanTopics.length ? s.orphanTopics.join(', ') : 'không có'}`);
  console.log(`Topic bị tranh (phải sửa tay bằng /link): ${s.contestedTopics.length ? s.contestedTopics.join(', ') : 'không có'}\n`);
}

async function main() {
  if (!firebaseUrl) throw new Error('Thiếu FIREBASE_DATABASE_URL.');
  const [rooms, topics, devices] = await Promise.all([fb('/chats'), fb('/telegramTopics'), fb('/devices')]);
  const snapshot = { rooms: rooms || {}, topics: topics || {}, devices: devices || {} };
  const analysis = analyze(snapshot);
  const fixed = FLAG_FIX ? await applyFixes(snapshot, analysis) : [];
  report(snapshot, analysis, fixed);
  // Có lỗi thì để mã thoát khác 0 để CI/script biết mà báo đỏ.
  process.exitCode = analysis.summary.errors > 0 ? 2 : 0;
}

if (require.main === module) main().catch(error => { console.error('Lỗi: ' + error.message); process.exit(1); });

module.exports = { analyze };
