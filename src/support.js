'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { atomicWrite } = require('./core');
const secrets = require('./secrets');
const machine = require('./machine-id');

const MAX_MESSAGES = 500;
// Bước 2: dùng thử ngầm TRIAL_DAYS ngày, tính từ lần cài đặt đầu tiên trên máy này.
// Máy chủ vẫn là nguồn quyết định; giá trị dưới đây chỉ là phương án dự phòng khi
// chưa đăng ký được hoặc Gateway không phản hồi.
// PHẢI KHỚP với TRIAL_DAYS trong support-gateway/apps-script/Code.gs — lệch nhau là app tự cắt
// sớm hơn CRM (người dùng thấy "hết hạn" trong khi Sheet vẫn còn hạn).
const TRIAL_DAYS = 30;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;
// App chạy nền: chỉ hỏi máy chủ khi CÓ DẤU HIỆU cần hỏi (xem needsServerCheck),
// và tối đa một lần mỗi 4 giờ. Hỏi nhẹ qua /v1/ping nên không tốn quota Apps Script.
// Mỗi máy rải nhịp riêng trong khoảng 3,5–4,5 giờ để không dồn 1 lúc.
const STALE_CHECK_MS = 4 * 60 * 60 * 1000;
const CHECK_JITTER_MS = 30 * 60 * 1000;
const EXPIRY_SOON_MS = 14 * 24 * 60 * 60 * 1000;   // key còn dưới 14 ngày thì hỏi
const VERSION = (() => { try { return require('./version').version || ''; } catch { return ''; } })();
const appVersion = () => String(VERSION || '').slice(0, 32);
const DEVICE_LIMIT_MESSAGE = 'Key này đã đạt giới hạn số thiết bị sử dụng tối đa. Vui lòng liên hệ Admin để mua thêm slot.';
const TRIAL_OVER_MESSAGE = `Đã hết ${TRIAL_DAYS} ngày dùng thử. Vui lòng nhập License Key để tiếp tục sử dụng.`;
// Mất mạng tạm thời: cho chạy tiếp trong OFFLINE_GRACE_DAYS ngày kể từ lần kiểm tra
// thành công cuối. Đánh đổi: /lock và hết hạn có thể trễ tối đa bằng đó với máy offline.
const OFFLINE_GRACE_DAYS = 3;
const OFFLINE_GRACE_MS = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000;
const OFFLINE_MESSAGE = `Không kết nối được máy chủ bản quyền và đã quá ${OFFLINE_GRACE_DAYS} ngày kể từ lần kiểm tra cuối. Vui lòng kết nối mạng rồi thử lại.`;
// Máy chủ hỗ trợ/bản quyền mặc định của bản phát hành. EXE không có du_lieu/support-gateway.json sẽ
// dùng URL này để luôn gửi dữ liệu lên Sheet/Telegram và kiểm tra License Key. File cấu hình (nếu có)
// vẫn được ưu tiên; đặt "url": "local" trong file để buộc chạy local mock.
const DEFAULT_GATEWAY_URL = 'https://hoadon-support-gateway.linhnhaxac10.workers.dev';
const packed = !!process.pkg;
const now = () => Date.now();
const id = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

// Dấu vân tay phần cứng (chỉ để CRM đối chiếu khi mã cục bộ đổi, không dùng làm khoá).
// LƯU Ý: đây là dấu CŨ, băm từ tên máy + tài khoản + card mạng nên khách đổi được.
// Giữ nguyên để dữ liệu đang chạy không bị đội giá trị. Mã máy ổn định mới nằm ở
// machine.deviceId() — xem src/machine-id.js.
function hardwareHash() {
  return crypto.createHash('sha256').update(String(secrets.machineIdentity() || '')).digest('hex').toUpperCase();
}

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  const str = String(val).trim();
  if (!str) return null;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(.*)$/);
  if (dmy) {
    const [, d, m, y, rest] = dmy;
    const time = rest.trim() || '23:59:59';
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${time.length === 8 ? time : '23:59:59'}`);
  }
  const ymd = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(.*)$/);
  if (ymd) {
    const [, y, m, d, rest] = ymd;
    const time = rest.trim().replace(/^T/, '') || '23:59:59';
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${time.length === 8 ? time : '23:59:59'}`);
  }
  const direct = new Date(str);
  return Number.isFinite(direct.getTime()) ? direct : null;
}

function formatExpiry(val) {
  if (!val) return '';
  const d = parseDate(val);
  if (!d) return String(val);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function expired(expiryAt) {
  if (!expiryAt) return false;
  const date = parseDate(expiryAt);
  return date ? date.getTime() < Date.now() : false;
}

// ---------------------------------------------------------------------------
// Chat realtime: giải mã luồng SSE của Firebase RTDB (REST streaming) mà Gateway
// chuyển tiếp. Đây là logic thuần (không I/O) nên test được trực tiếp.
// ---------------------------------------------------------------------------
function parseSseFrame(frame) {
  let name = '';
  const data = [];
  for (const line of String(frame).split('\n')) {
    if (line.startsWith(':')) continue;               // comment / keep-alive của SSE
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { name, data: data.join('\n') };
}

// Gộp một sự kiện Firebase vào map tin nhắn hiện có (đúng ngữ nghĩa REST streaming):
//   name 'put'   : path '/' = ảnh chụp toàn bộ; path '/id' = đặt/xóa một bản ghi
//   name 'patch' : gộp nông (shallow merge) theo path
// Các sự kiện khác (keep-alive, cancel, auth_revoked) không đổi dữ liệu.
function applyStreamEvent(state, name, payload) {
  const path = String((payload && payload.path) || '/');
  const data = payload ? payload.data : undefined;
  const key = path.replace(/^\/+/, '');
  if (name === 'put') {
    if (!key) {
      state.clear();
      if (data && typeof data === 'object') for (const [id, value] of Object.entries(data)) state.set(id, value);
    } else if (data === null || data === undefined) {
      state.delete(key);
    } else {
      state.set(key, data);
    }
    return true;
  }
  if (name === 'patch') {
    if (data === null || data === undefined) return true;
    if (!key) {
      for (const [id, value] of Object.entries(data)) {
        if (value === null) { state.delete(id); continue; }
        const current = state.get(id);
        state.set(id, current && typeof current === 'object' && typeof value === 'object' ? { ...current, ...value } : value);
      }
      return true;
    }
    const current = state.get(key);
    state.set(key, current && typeof current === 'object' && typeof data === 'object' ? { ...current, ...data } : data);
    return true;
  }
  return false;
}

// Cùng thứ tự/định dạng với Gateway (/v1/chats/status): id + nội dung, sắp theo thời gian, 100 tin cuối.
function sortedMessages(state, limit = 100) {
  return [...state.entries()]
    .map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0))
    .slice(-limit);
}

class SupportStore {
  // machineIdOverride chỉ dùng cho test và công cụ CLI cần giả lập "máy khác".
  // Không có nó thì mã máy lấy từ phần cứng thật.
  constructor(dataDir, options = {}) {
    this.file = path.join(dataDir, 'support.json');
    this.gatewayFile = path.join(dataDir, 'support-gateway.json');
    this.machineIdOverride = String(options.machineId || '');
    this.data = read(this.file, null) || this.create();
    this.normalize();
    this.save();
  }

  // MÁY MỚI — hai định danh tách bạch, mỗi đứng một nhiệm vụ:
  //
  //   machineId      = băm từ phần cứng. ỔN ĐỊNH: cài lại app, bật VPN, đổi tên
  //                    máy thì vẫn y hệt. Đây là khoá tra cứu MỚI trên Sheet.
  //   installationId = UUID NGẪU NHIÊN mỗi lần cài. Giữ nguyên hình dạng cũ vì
  //                    Apps Script BẢN CŨ còn đang chạy và nó chỉ chấp nhận UUID;
  //                    gửi DEV_... vào ô đó là khách mới không đăng ký được.
  //                    Apps Script bản mới tra theo machineId TRƯỚC nên vẫn ra
  //                    đúng dòng cũ sau khi cài lại.
  //   chatRoomId     = suy ra từ machineId, nên một máy chỉ có đúng một phòng.
  //
  // Nhờ tách vậy, deploy Worker trước hay Apps Script trước đều được — không có
  // khoảnh khắc nào khách mới bị từ chối.
  create() {
    const machineId = this.machineId() || machine.deviceId();
    return {
      version: 1,
      device: {
        machineId,
        installationId: id(),
        chatRoomId: machine.roomFor(machineId) || `ROOM_WIN_${id().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
        hardwareHash: hardwareHash(),
        firstInstallAt: now(),
        registeredAt: 0,
        phone: '', name: '', plan: ''
      },
      license: { status: 'unactivated', key: '', updatedAt: 0 },
      messages: []
    };
  }

  // Nguồn định danh máy: ưu tiên giá trị ép từ ngoài, không thì đọc phần cứng.
  // Ghi kèm nguồn đã dùng để sau này biết mã đang bám vào fingerprint yếu hay vững.
  machineId() {
    if (this.machineIdOverride) return this.machineIdOverride;
    return machine.deviceId();
  }

  // KHÔNG BAO GIỜ `this.data = this.create()` ở đây nữa.
  // Trước đây thiếu chatRoomId là gán lại toàn bộ dữ liệu, kéo theo mất luôn
  // license đã kích hoạt và toàn bộ lịch sử chat — chỉ vì file hỏng nhẹ.
  // Giờ chỉ bổ sung Ô THIẾU, không đụng vào ô đang có.
  normalize() {
    if (!this.data || typeof this.data !== 'object') this.data = this.create();
    if (!this.data.device || typeof this.data.device !== 'object') this.data.device = {};
    const device = this.data.device;
    const fresh = this.create();

    // Mã máy ổn định: luôn có mặt, kể cả với bản cài cũ chưa từng lưu.
    // KHÔNG đụng installationId/chatRoomId đang có — khách cũ phải giữ nguyên
    // mã cũ để còn ra đúng dòng Sheets, còn đúng key.
    if (!device.machineId) device.machineId = this.machineId() || fresh.device.machineId;
    if (!device.installationId) device.installationId = fresh.device.installationId;
    // Nếu phòng đang lưu không đúng định dạng thì suy lại từ mã máy.
    if (!device.chatRoomId) device.chatRoomId = fresh.device.chatRoomId;
    if (!/^ROOM_WIN_[A-Z0-9]{8,40}$/.test(String(device.chatRoomId || ''))) {
      const derived = machine.roomFor(device.machineId || device.installationId);
      if (derived) device.chatRoomId = derived;
    }

    if (!device.hardwareHash) device.hardwareHash = hardwareHash();
    if (!device.firstInstallAt) device.firstInstallAt = now();
    device.registeredAt = Number(device.registeredAt) || 0;
    if (!device.phone) device.phone = '';
    if (!device.name) device.name = '';
    if (!device.plan) device.plan = '';
    if (!this.data.license || typeof this.data.license !== 'object') this.data.license = { status: 'unactivated', key: '', updatedAt: 0 };
    if (!Array.isArray(this.data.messages)) this.data.messages = [];
  }

  save() { atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }

  publicDevice() {
    const { machineId, installationId, chatRoomId, firstInstallAt, registeredAt, phone, name, plan, hardwareHash: hash } = this.data.device;
    return { machineId: machineId || '', installationId, hardwareId: installationId, chatRoomId, hardwareHash: hash || '', firstInstallAt, registeredAt, phone, name, plan: plan || '', mode: 'local-mock' };
  }

  gatewayUrl() {
    const configured = read(this.gatewayFile, {});
    // Chưa có file cấu hình: EXE dùng máy chủ mặc định, còn chạy bằng node (dev/test) giữ local mock
    // để bộ test không gọi ra Internet. File có url rỗng hoặc "local" cũng ép local mock.
    const url = configured.url === undefined ? (packed ? DEFAULT_GATEWAY_URL : '') : String(configured.url || '').trim();
    if (!url || url.toLowerCase() === 'local') return '';
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('Gateway URL phải dùng HTTPS.');
    return url.replace(/\/$/, '');
  }

  // Đường gọi AI qua Gateway: app KHÔNG cầm API key, Gateway lo url/model/key và
  // tự xoay key khi hết hạn mức (admin đặt bằng lệnh /ai trên Telegram).
  // Chỉ dựng khi có cả URL lẫn token phiên — thiếu token thì để app dùng cấu hình
  // cục bộ như cũ, không dựng đường nửa vời rồi hỏng lúc chat.
  aiGateway() {
    let base = '';
    try { base = this.gatewayUrl(); } catch { base = ''; }
    const token = this.data.license.sessionToken;
    if (!base || !token) return null;
    return { baseURL: base.replace(/\/$/, '') + '/v1/ai/chat/completions', configURL:base.replace(/\/$/,'')+'/v1/ai/config', token };
  }

  gateway(pathname, payload, authorize = false) {
    const base = this.gatewayUrl(); if (!base) return null;
    const target = new URL(pathname, base); const transport = target.protocol === 'https:' ? https : http; const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (authorize && this.data.license.sessionToken) headers.Authorization = `Bearer ${this.data.license.sessionToken}`;
      const request = transport.request(target, { method: 'POST', headers, timeout: 25000 }, response => {
        let output = ''; response.setEncoding('utf8'); response.on('data', chunk => { output += chunk; }); response.on('end', () => {
          try { const value = JSON.parse(output); if (!value.ok) throw new Error(value.error || 'Gateway từ chối yêu cầu.'); resolve(value.value); } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('Gateway không phản hồi.'))); request.on('error', reject); request.end(body);
    });
  }

  saveLicense(value) {
    value = value || {};
    this.data.license.status = value.status || this.data.license.status;
    this.data.license.packageType = value.packageType || value.package || this.data.license.packageType || '';
    this.data.license.keyName = value.keyName || value.licenseKey || value.key || this.data.license.keyName || this.data.license.key || '';
    this.data.license.key = this.data.license.keyName || this.data.license.key || '';
    // KHÔNG xoá hạn đã biết bằng giá trị rỗng.
    // Đường này là chốt chặn cuối: nếu Gateway (bản cũ, hoặc lúc hỏng) trả
    // expiryAt rỗng, app vẫn giữ hạn cũ thay vì báo "đã hết hạn". Chỉ ghi đè khi
    // máy chủ đưa ra một NGÀY khác — đó mới là thay đổi thật (gia hạn, /lock…).
    if (value.expiryAt !== undefined && value.expiryAt !== null) {
      const incoming = formatExpiry(value.expiryAt);
      if (incoming || !this.data.license.expiryAt) this.data.license.expiryAt = incoming;
    }
    // Chỉ nhận đúng định dạng mã phòng của app: sheet cũ từng trả về id Topic Telegram.
    if (value.chatRoomId && /^ROOM_WIN_[A-Z0-9]{8,40}$/.test(String(value.chatRoomId).trim())) {
      this.data.device.chatRoomId = String(value.chatRoomId).trim();
    }
    if (String(this.data.license.status || '').toLowerCase() === 'active' && expired(this.data.license.expiryAt)) {
      this.data.license.status = 'Expired';
    }
    // Mốc kiểm tra thành công cuối (chỉ saveLicense sau khi Gateway trả lời được),
    // dùng cho cửa sổ offline grace ở enforceLicense().
    this.data.license.checkedAt = now();
    this.data.license.updatedAt = now(); this.save();
  }

  register() {
  const remote = this.gateway('/v1/devices/register', {
    ...this.publicDevice(),
    action: 'register_device'
  });

  if (remote) {
    return remote.then(value => {
      this.data.device.registeredAt =
        this.data.device.registeredAt || now();

      this.data.license.sessionToken =
        value.sessionToken ||
        this.data.license.sessionToken ||
        '';

      this.saveLicense(value);
      this.save();

      return {
        ...this.publicDevice(),
        ...value,
        mode: 'gateway'
      };
    });
  }

  if (!this.data.device.registeredAt) {
    this.data.device.registeredAt = now();
  }

  this.save();

  return this.publicDevice();
}

  // Bước 4: khách chọn gói rồi điền Họ tên + SĐT ở giao diện đăng ký. Gateway chuyển
  // tiếp vào cùng action register_device để CRM lưu cột Phone/Name/Plan và đổi tên Topic.
  async updateInfo(phone, name, plan) {
    const cleanName = String(name || '').replace(/[\r\n\t]+/g, ' ').trim();
    const cleanPhone = String(phone || '').replace(/[\s.\-()]/g, '').trim();
    const cleanPlan = String(plan || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40);
    if (cleanName.length < 2) throw new Error('Họ tên khách hàng cần ít nhất 2 ký tự.');
    if (!/^\+?\d{9,15}$/.test(cleanPhone)) throw new Error('Số điện thoại chưa đúng — nhập 9 đến 15 chữ số, ví dụ 0912345678.');
    this.data.device.phone = cleanPhone;
    this.data.device.name = cleanName;
    this.data.device.plan = cleanPlan;
    this.save();

    const remote = this.gateway('/v1/devices/register', { ...this.publicDevice(), action: 'register_device' });
    if (remote) {
      return remote.then(value => {
        this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
        this.saveLicense(value);
        return { ...this.publicDevice(), ...value, mode: 'gateway' };
      });
    }
    return this.publicDevice();
  }

  // Ảnh chụp LOCAL, KHÔNG gọi máy chủ — dùng để hiển thị tức thì (header chat, badge…).
  snapshot() {
    let mode = 'local-mock';
    try { mode = this.gatewayUrl() ? 'gateway' : 'local-mock'; } catch { mode = 'local-mock'; }
    return { device: { ...this.publicDevice(), mode }, license: this.publicLicense(), mode };
  }

  // ---- LICENSE: chỉ kiểm tra khi được gọi (không polling, không timer) ----
  // Gọi Gateway đúng 1 lần cho /v1/licenses/status rồi cập nhật token phiên.
  async checkLicense() {
    const remote = this.gateway('/v1/licenses/status', this.publicDevice());
    if (!remote) return { device: { ...this.publicDevice(), mode: 'local-mock' }, license: this.publicLicense(), mode: 'local-mock' };
    const value = await remote;
    this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
    this.saveLicense(value);
    return { device: { ...this.publicDevice(), mode: 'gateway' }, license: this.publicLicense(), mode: 'gateway' };
  }

  // ---- CHAT: đọc tin nhắn theo yêu cầu (KHÔNG kéo theo kiểm tra License) ----
  async messages() {
    const remote = this.gateway('/v1/chats/status', this.publicDevice(), true);
    if (!remote) return { messages: this.data.messages };
    const value = await remote;
    return { messages: value.messages || [], control:value.control||{mode:'auto',revision:0} };
  }

  // ---- CHAT REALTIME: lắng nghe thay đổi, KHÔNG hỏi định kỳ ----
  // Trả về URL + token để mở luồng SSE tới Gateway (token không bao giờ rời khỏi tiến trình Node).
  streamRequest() {
    const base = this.gatewayUrl();
    if (!base) return null;
    const token = this.data.license.sessionToken;
    if (!token) return null;
    const target = new URL('/v1/chats/stream', base);
    target.searchParams.set('installationId', this.data.device.installationId);
    target.searchParams.set('chatRoomId', this.data.device.chatRoomId);
    return { url: target, token };
  }

  // Mở luồng SSE tới Gateway. Gọi onOpen() khi đã nối được và onMessages(mảng) mỗi khi
  // Firebase báo thay đổi. Promise kết thúc khi luồng đóng/lỗi (tầng gọi tự nối lại).
  watchMessages(onMessages, options = {}) {
    const { signal, onOpen } = options;
    const request = this.streamRequest();
    if (!request) return Promise.resolve({ ok: false, reason: 'no-gateway' });
    if (signal && signal.aborted) return Promise.resolve({ ok: false, reason: 'aborted' });
    return new Promise(resolve => {
      const state = new Map();
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      // Gateway có thể là https (Cloudflare Worker) hoặc http khi trỏ về localhost (dev/test) —
      // cùng quy tắc với gateway().
      const transport = request.url.protocol === 'https:' ? https : http;
      const req = transport.get(request.url, {
        headers: { Authorization: 'Bearer ' + request.token, Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        // Không đặt timeout ngắn: luồng SSE im lặng là bình thường. Chỉ cắt khi socket
        // thật sự không có byte nào trong 5 phút (keep-alive của Firebase tự gia hạn).
        timeout: 300000,
      }, res => {
        if (res.statusCode !== 200) { res.resume(); return done({ ok: false, reason: `http-${res.statusCode}` }); }
        if (onOpen) { try { onOpen(); } catch {} }
        res.setEncoding('utf8');
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const { name, data } = parseSseFrame(frame);
            if (!name) continue;
            if (name === 'cancel' || name === 'auth_revoked') { req.destroy(); return done({ ok: false, reason: name }); }
            if (name !== 'put' && name !== 'patch') continue;
            let payload;
            try { payload = JSON.parse(data); } catch { continue; }
            if (applyStreamEvent(state, name, payload)) onMessages(sortedMessages(state));
          }
        });
        res.on('end', () => done({ ok: true, reason: 'closed' }));
        res.on('error', error => done({ ok: false, reason: error.message }));
      });
      req.on('timeout', () => req.destroy(new Error('stream-timeout')));
      req.on('error', error => done({ ok: false, reason: error.message }));
      if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    });
  }

  // Giữ lại cho test/smoke: gộp License + Chat. Luồng app KHÔNG dùng hàm này nữa —
  // license dùng checkLicense(), chat dùng messages()/watchMessages() để hai luồng độc lập.
  async status() {
    const license = await this.checkLicense();
    const chat = await this.messages();
    return { ...license, ...chat };
  }

  publicLicense() {
    const effective = this.effectiveLicense();
    if (effective.status === 'Expired' && String(this.data.license.status || '').toLowerCase() === 'active') {
      this.data.license.status = 'Expired';
      this.data.license.updatedAt = now();
      this.save();
    }
    return {
      status: effective.status,
      packageType: this.data.license.packageType || '',
      keyName: this.data.license.keyName || this.data.license.key || '',
      expiryAt: effective.expiryAt || '',
      trial: !!effective.trial,
      updatedAt: this.data.license.updatedAt || 0
    };
  }

  // Hạn dùng thử tính từ lần cài đầu tiên trên máy này (Bước 2), dùng khi thiết bị
  // chưa kích hoạt hoặc chưa đăng ký được với máy chủ.
  trialExpiryAt() {
    const start = Number(this.data.device.firstInstallAt || 0);
    return start ? formatExpiry(new Date(start + TRIAL_MS)) : '';
  }

  // Trạng thái hiệu lực: lấy theo máy chủ, chỉ bù phần dùng thử khi chưa có key.
  effectiveLicense() {
    const stored = this.data.license || {};
    const raw = String(stored.status || '').trim();
    const lower = raw.toLowerCase();
    // /lock và giới hạn số máy là quyết định của máy chủ, máy khách không suy diễn lại.
    if (lower === 'locked' || lower === 'device_limit_exceeded') {
      return { status: raw, expiryAt: stored.expiryAt || '', trial: false };
    }
    const unlicensed = lower === 'unactivated' || lower === 'invalid' || lower === '';
    // Trial mà máy chủ không kèm hạn (thiếu First Install Time) vẫn phải có mốc hết hạn.
    const expiryAt = stored.expiryAt || (unlicensed || lower === 'trial' ? this.trialExpiryAt() : '');
    if (expired(expiryAt)) return { status: 'Expired', expiryAt, trial: unlicensed };
    if (unlicensed || lower === 'trial') return { status: 'Trial', expiryAt, trial: true };
    return { status: raw, expiryAt, trial: false };
  }

  // Chặn theo trạng thái đã biết — dùng chung cho cả đường online và offline,
  // để câu chữ không bao giờ lệch giữa hai đường.
  blockBadLicense_(license) {
    const st = String(license.status || '').toLowerCase();

    if (st === 'locked') {
      throw new Error('Bản quyền thiết bị đã bị khóa bởi quản trị viên. Vui lòng liên hệ hỗ trợ.');
    }
    if (st === 'device_limit_exceeded') {
      throw new Error(DEVICE_LIMIT_MESSAGE);
    }
    if (st === 'expired') {
      const activated = String(this.data.license.key || this.data.license.keyName || '').trim();
      throw new Error(activated ? 'License Key đã hết hạn. Vui lòng gia hạn hoặc nhập key mới trong Cài đặt → Bản quyền & Đăng ký.' : TRIAL_OVER_MESSAGE);
    }
  }

  async enforceLicense() {
    const remote = this.gateway('/v1/licenses/status', this.publicDevice());
    let offline = '';

    if (remote) {
      try {
        const value = await remote;
        this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
        this.saveLicense(value);
      } catch (error) {
        offline = error.message || 'Gateway không phản hồi.';
      }
    }

    if (offline) {
      // Trạng thái xấu đã biết (khóa / hết hạn / vượt số máy) vẫn chặn, không grace.
      const known = this.publicLicense();
      this.blockBadLicense_(known);

      // Máy chưa kích hoạt (đang dùng thử) không cần mốc kiểm tra máy chủ: hạn dùng thử
      // đã được tính từ firstInstallAt ngay trong publicLicense(). Nếu thiếu nhánh này,
      // máy cài mới mà đang offline sẽ bị chặn oan.
      if (known.trial) {
        return { ...known, offline: true, offlineReason: offline, graceEndsAt: 0 };
      }

      const lastCheck = Number(this.data.license.checkedAt || this.data.license.updatedAt || 0);
      const age = lastCheck ? Date.now() - lastCheck : Infinity;

      if (age > OFFLINE_GRACE_MS) throw new Error(OFFLINE_MESSAGE);

      return { ...known, offline: true, offlineReason: offline, graceEndsAt: lastCheck + OFFLINE_GRACE_MS };
    }

    const license = this.publicLicense();
    this.blockBadLicense_(license);
    return license;
  }

  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (key.length < 6 || key.length > 160) throw new Error('License Key phải có từ 6 đến 160 ký tự.');
    if (this.gatewayUrl()) {
      if (!this.data.device.registeredAt) {
        try {
  await this.register();
} catch (error) {
  throw new Error(
    `Không đăng ký được thiết bị trước khi kích hoạt: ${error.message}`
  );
}
      }
      const value = await this.gateway('/v1/licenses/activate', { ...this.publicDevice(), key });
      // Bước 5: key đã dùng hết số máy cho phép thì không lưu kích hoạt.
      if (String(value.status || '').toLowerCase() === 'device_limit_exceeded') throw new Error(DEVICE_LIMIT_MESSAGE);
      this.data.license.key = key;
      this.data.license.keyName = key;
      this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
      this.saveLicense(value);
      return { ...this.publicLicense(), mode: 'gateway' };
    }
    this.data.license = { status: 'pending_verification', key, keyName: key, expiryAt: '', updatedAt: now() };
    this.save();
    return { status: this.data.license.status, mode: 'local-mock' };
  }

  // ---- ĐỒNG BỘ LÚC MỞ APP ------------------------------------------------
  // Một chuyến duy nhất lấy về bản quyền + thông báo + token phiên.
  // Trước đây app phải gọi /devices/register rồi /notices/current thành hai chuyến
  // (hai lần vào Apps Script); gộp lại thì một lần, ít chỗ hỏng hơn.
  async sync(reason = 'mo-app') {
    const remote = this.gateway('/v1/sync', { ...this.publicDevice(), appVersion: appVersion(), reason: String(reason || '').slice(0, 40) });
    if (!remote) { this.register(); return { device: this.snapshot().device, license: this.publicLicense(), mode: 'local-mock' }; }
    const value = await remote;
    this.data.device.registeredAt = this.data.device.registeredAt || now();
    this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
    this.saveLicense(value);
    // Máy chủ nhận ra mình ở dòng Sheet KHÁC với mã máy đang lưu -> cần báo cho
    // người dùng biết, vì đó là dấu hiệu dữ liệu cục bộ bị can thiệp/sai lệch.
    this.data.device.syncMismatch = !!(value.machineId && this.data.device.machineId && value.machineId !== this.data.device.machineId);
    this.save();
    if (value.notice) this.data.notice = { text: String(value.notice.text || '').slice(0, 2000), updatedAt: Number(value.notice.updatedAt) || now() };
    return { device: { ...this.publicDevice(), mode: 'gateway' }, license: this.publicLicense(), notice: this.data.notice || null, mode: 'gateway' };
  }

  // ---- HỎI NHẸ (app chạy nền) ---------------------------------------------
  // Chỉ đọc bản ghi nhớ trên Firebase, KHÔNG đụng Apps Script nên không tốn quota.
  // Có bản ghi nhớ -> áp dụng; không có -> tự động hỏi đường đầy đủ.
  async ping(reason = 'nen') {
    const remote = this.gateway('/v1/ping', { ...this.publicDevice(), appVersion: appVersion() });
    if (!remote) return { checked: false, reason: 'khong-co-gateway' };
    const value = await remote;
    this.data.presence = { lastPingAt: now(), reason: String(reason || '') };
    if (!value.licenseCacheHit || !value.license) {
      this.save();
      await this.sync(reason);            // chưa có bản ghi nhớ thì hỏi đầy đủ một lần
      return { checked: true, deep: true, reason };
    }
    this.saveLicense(value.license);
    this.save();
    return { checked: true, deep: false, reason, license: this.publicLicense() };
  }

  // ---- KHÁCH TỰ /CHECK -----------------------------------------------------
  // Gửi lệnh xem thông tin bản quyền của chính máy này. Gateway gọi thẳng
  // CRM (không vòng qua Telegram) rồi đẩy kết quả vào phòng chat, nên khách
  // thấy ngay trong khung hỗ trợ. Chỉ /check|/info được phép — lệnh đổi trạng
  // thái phải để admin gõ trên Telegram.
  check(command = '/check') {
    const remote = this.gateway('/v1/chats/check', { ...this.publicDevice(), command: String(command) }, true);
    if (!remote) return Promise.resolve({ ok: false, reason: 'khong-co-gateway' });
    return remote.then(value => ({ ok: true, detail: String(value && value.detail || '') }));
  }

  // ---- CÓ CẦN HỎI MÁY CHỦ KHÔNG? ----------------------------------------
  // Mục tiêu: app chạy nền KHÔNG gọi mạng vô nghĩa. Chỉ hỏi khi thấy dấu hiệu
  // cần hỏi. Trả về chuỗi lý do, rỗng nghĩa là không cần gọi.
  needsServerCheck() {
    if (!this.gatewayUrl()) return '';
    if (this.data.device.syncMismatch) return 'may-id-lech';
    const license = this.publicLicense();
    // 1. Key sắp hết hạn -> hỏi để biết có được gia hạn không.
    if (license.status === 'Active' && license.expiryAt) {
      const end = parseDate(license.expiryAt);
      if (end && (end.getTime() - Date.now()) <= EXPIRY_SOON_MS) return 'key-sap-het-han';
    }
    // 2. Chưa từng hỏi thành công lần nào -> hỏi để lấy trạng thái thật.
    // CHỈ dùng checkedAt, KHÔNG dùng updatedAt: updatedAt còn bị ghi khi thao tác
    // cục bộ (kích hoạt ở chế độ local-mock), nên nó không chứng minh được là đã
    // liên lạc với máy chủ — dùng nó sẽ khiến máy offline im lặng mãi.
    const last = Number(this.data.license.checkedAt || 0);
    if (!last) return 'chua-hoi-lan-nao';
    // 3. Đã hỏi khá lâu -> hỏi nhẹ một lần (không tốn quota).
    if (Date.now() - last >= STALE_CHECK_MS) return 'da-lau-chua-hoi';
    return '';
  }

  notice() {
    const remote = this.gateway('/v1/notices/current', this.publicDevice());
    if (remote) return remote.catch(() => null);
    return null;
  }

  addMessage(sender, text) {
    if (!['user', 'admin', 'system'].includes(sender)) throw new Error('Người gửi không hợp lệ.');
    text = String(text || '').trim();
    if (!text || text.length > 2000) throw new Error('Tin nhắn phải có từ 1 đến 2.000 ký tự.');
    const remote = this.gateway('/v1/chats/messages', { ...this.publicDevice(), text }, true);
    if (remote) return remote;
    const message = { id: id(), sender, text, timestamp: now(), deliveryStatus: 'local' };
    this.data.messages.push(message);
    if (this.data.messages.length > MAX_MESSAGES) this.data.messages.splice(0, this.data.messages.length - MAX_MESSAGES);
    this.save();
    return message;
  }
  async beginUnified(text,companyId,attachments=[],wantsAdmin=false) {
    // wantsAdmin: do NGƯỜI DÙNG tự chọn "Đợi admin/support" trong app. Gateway chỉ ghi nhận,
    // không tự đoán theo từ khoá — nhờ vậy khách hỏi về bản quyền vẫn được hỏi ý trước.
    const remote=this.gateway('/v1/chats/messages',{...this.publicDevice(),text,companyId,attachments,unified:true,wantsAdmin:wantsAdmin===true},true);
    if(!remote)throw Error('Chưa kết nối máy chủ hỗ trợ. Đăng ký thiết bị trước khi gửi.');
    const value=await remote;this.aiControl=value.control;this.aiControlAt=Date.now();return value;
  }
  async aiAllowed() {
    // CHỈ chặn khi admin THẬT SỰ đang giữ phiên. Lệch số phiên bản một mình không phải lý do
    // chặn: sau khi admin /stop, số phiên bản đổi nhưng phiên đã trả về AI, nên chặn ở đây
    // làm app báo "Admin đang hỗ trợ" oan. Việc admin tiếp quản GIỮA lượt vẫn được chốt ở
    // completeUnified (câu trả lời không được ghi nếu phiên đã đổi chủ).
    const control=this.aiControl&&Date.now()-this.aiControlAt<750?this.aiControl:await this.gateway('/v1/chats/control',this.publicDevice(),true);
    if(!control)throw Error('Không xác minh được phiên hỗ trợ.');
    this.aiControl=control;this.aiControlAt=Date.now();
    if(control.mode!=='auto')throw Object.assign(Error('Admin đang hỗ trợ. AI đã tạm dừng.'),{code:'SUPPORT_ADMIN_ACTIVE'});
    return control;
  }
  observeAiControl(messages) {
    const value=messages.filter(m=>m.controlMode).sort((a,b)=>(a.controlRevision||0)-(b.controlRevision||0)).at(-1);
    if(value&&(!this.aiControl||(value.controlRevision||0)>=this.aiControl.revision)){this.aiControl={mode:value.controlMode,revision:value.controlRevision||0};this.aiControlAt=Date.now();}
  }
  async completeUnified(turnId,revision,text) {
    return this.gateway('/v1/chats/ai-reply',{...this.publicDevice(),turnId,revision,text},true);
  }
}

module.exports = { SupportStore, parseDate, formatExpiry, expired, parseSseFrame, applyStreamEvent, sortedMessages };
