'use strict';
// ---------------------------------------------------------------------------
// CHẨN ĐOÁN CẤU HÌNH AI: kiểm tra máy chủ trả lời được cho CẢ HAI phía.
//
//   • Telegram  → gửi stream:false, KHÔNG kèm tool  (xem ai-admin.js telegramChat)
//   • App (EXE) → gửi stream:true  + kèm tool        (xem ai/openrouter-client.js)
//
// Gateway lọc cấu hình theo "khả năng" mà bên gọi yêu cầu. Vì vậy một cấu hình có thể
// chạy tốt cho Telegram mà bị loại cho App (hoặc ngược lại). Lệnh này chỉ ra chính xác
// bên nào hỏng và vì sao — dùng ĐÚNG dữ liệu trên máy, không cần đăng nhập lại.
//
// Cách chạy:
//   node tools/ai-config-check.cjs                 (dùng ./du_lieu)
//   node tools/ai-config-check.cjs <thư-mục-dữ-liệu>
//   node tools/ai-config-check.cjs --poll=120      (giây chờ mỗi phía, mặc định 120)
//
// CHỈ ĐỌC: không ghi vào cấu hình, không đổi key, không gửi tin nhắn hỗ trợ.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const pollArg = args.find(a => a.startsWith('--poll='));
const pollSeconds = pollArg ? Math.max(0, Number(pollArg.split('=')[1]) || 0) : 120;
const dataDir = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'du_lieu'));

function fail(message) { console.log('\n✖ ' + message); process.exitCode = 1; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const gatewayFile = path.join(dataDir, 'support-gateway.json');
  const supportFile = path.join(dataDir, 'support.json');
  if (!fs.existsSync(gatewayFile)) return fail('Chưa có ' + gatewayFile + ' — chưa khai địa chỉ máy chủ.');
  if (!fs.existsSync(supportFile)) return fail('Chưa có ' + supportFile + ' — chưa có thông tin thiết bị.');
  const base = String(JSON.parse(fs.readFileSync(gatewayFile, 'utf8')).url || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(base)) return fail('Địa chỉ máy chủ không hợp lệ: ' + JSON.stringify(base));
  const d = JSON.parse(fs.readFileSync(supportFile, 'utf8')).device || {};
  const payload = { machineId: d.machineId, installationId: d.installationId, hardwareId: d.installationId, chatRoomId: d.chatRoomId, firstInstallAt: d.firstInstallAt, registeredAt: d.registeredAt, phone: d.phone || '', name: d.name || '', plan: d.plan || '', mode: 'local-mock' };

  console.log('Máy chủ : ' + base);
  console.log('Thiết bị: ' + payload.machineId + '  ·  phòng ' + payload.chatRoomId);
  console.log('Dữ liệu : ' + dataDir);

  // ── 1. vé phiên ────────────────────────────────────────────────────────
  const status = await fetch(base + '/v1/licenses/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(25000) });
  const statusJson = await status.json().catch(() => ({}));
  const token = statusJson?.value?.sessionToken;
  console.log('\n1) BẢN QUYỀN   : HTTP ' + status.status + '  trạng thái=' + JSON.stringify(statusJson?.value?.status) + '  hết hạn=' + (statusJson?.value?.expiryAt || '-'));
  if (!token) return fail('Máy chủ không cấp vé phiên — không kiểm tra tiếp được.');
  console.log('   Vé phiên   : CÓ');
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // ── 2. cấu hình máy chủ đang chạy ──────────────────────────────────────
  const cfgRes = await fetch(base + '/v1/ai/config', { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  const cfg = (await cfgRes.json().catch(() => ({})))?.value || {};
  const caps = cfg?.active?.capabilities || {};
  console.log('\n2) CẤU HÌNH ĐANG DÙNG');
  if (!cfg.active) {
    console.log('   (chưa chốt được cấu hình nào — máy chủ chưa xác minh xong)');
  } else {
    console.log('   Nhà cung cấp : ' + cfg.active.provider);
    console.log('   Model        : ' + cfg.active.model);
    console.log('   Phiên bản    : ' + cfg.revision);
    console.log('   Khả năng     : ' + Object.entries(caps).map(([k, v]) => k + '=' + v).join(', '));
  }

  // ── 3. thử từng phía ───────────────────────────────────────────────────
  const tools = [{ type: 'function', function: { name: 'app__get_state', description: 'x', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }];
  async function probe(label, body) {
    const started = Date.now();
    let job = null;
    for (let round = 1; round <= 2; round++) {
      const r = await fetch(base + '/v1/ai/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (r.status === 200) {
        const text = await r.text();
        const sse = /event-stream/i.test(r.headers.get('Content-Type') || '');
        return { ok: true, seconds: Math.round((Date.now() - started) / 1000), mode: sse ? 'truyền dần' : 'một lần', bytes: text.length };
      }
      const j = await r.json().catch(() => ({}));
      const code = j?.error?.code || String(r.status);
      if (code === 'AI_CONFIG_EXHAUSTED') return { ok: false, seconds: Math.round((Date.now() - started) / 1000), code, reason: j?.errors || null };
      if (!j.jobId) return { ok: false, seconds: Math.round((Date.now() - started) / 1000), code };
      job = j.jobId;
      if (round === 2) break;
      const deadline = Date.now() + pollSeconds * 1000;
      while (Date.now() < deadline) {
        await sleep(3000);
        const poll = await fetch(base + '/v1/ai/jobs/' + encodeURIComponent(job), { headers, signal: AbortSignal.timeout(20000) });
        if (!poll.ok) continue;
        const v = (await poll.json())?.value || {};
        if (v.status === 'ready') break;
        if (v.status === 'exhausted') return { ok: false, seconds: Math.round((Date.now() - started) / 1000), code: 'AI_CONFIG_EXHAUSTED', reason: v.errors || null };
      }
    }
    return { ok: false, seconds: Math.round((Date.now() - started) / 1000), code: 'QUÁ_THỜI_GIAN_CHỜ', job };
  }

  console.log('\n3) THỬ TỪNG PHÍA  (chờ tối đa ' + pollSeconds + 's mỗi phía)');
  const telegram = await probe('Telegram', { model: 'x', messages: [{ role: 'user', content: 'Trả lời đúng một chữ: OK' }], stream: false, max_tokens: 16 });
  console.log('   Telegram (stream:false, không tool) → ' + (telegram.ok ? '✅ DÙNG ĐƯỢC (' + telegram.mode + ', ' + telegram.seconds + 's)' : '❌ ' + telegram.code + ' sau ' + telegram.seconds + 's'));
  const exe = await probe('App', { model: 'x', messages: [{ role: 'user', content: 'Trả lời đúng một chữ: OK' }], stream: true, max_tokens: 16, tools, tool_choice: 'auto' });
  console.log('   App/EXE  (stream:true,  có tool)    → ' + (exe.ok ? '✅ DÙNG ĐƯỢC (' + exe.mode + ', ' + exe.seconds + 's)' : '❌ ' + exe.code + ' sau ' + exe.seconds + 's'));

  // ── 4. kết luận ────────────────────────────────────────────────────────
  console.log('\n4) KẾT LUẬN');
  if (telegram.ok && exe.ok) console.log('   ✅ Cả hai phía dùng được. Không còn lệch cấu hình.');
  else if (telegram.ok && !exe.ok) {
    console.log('   ⚠ Telegram dùng được nhưng App KHÔNG — đúng kiểu lệch KHẢ NĂNG.');
    if (caps.stream === false) console.log('   → Máy chủ khai cấu hình này KHÔNG hỗ trợ truyền dần (stream=false), mà App cũ đòi stream:true.');
    if (caps.tools !== true) console.log('   → Máy chủ chưa xác minh cấu hình này gọi được tool, mà App luôn gửi kèm tool.');
    console.log('   → App đã được sửa để tự lùi về stream:false trong trường hợp này; khởi động lại app rồi thử lại.');
  } else if (!telegram.ok && exe.ok) console.log('   ⚠ App dùng được nhưng Telegram KHÔNG — kiểm tra đường Telegram của worker.');
  else {
    console.log('   ❌ CẢ HAI phía đều không dùng được ⇒ vấn đề ở cấu hình/key, không phải ở app.');
    if (telegram.reason || exe.reason) console.log('   Lý do máy chủ báo: ' + JSON.stringify(telegram.reason || exe.reason));
    console.log('   → Mở /ai trên Telegram: bấm "Kiểm tra key", sửa key/model hỏng.');
  }
}
main().catch(error => fail(error.message));
