'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { atomicWrite } = require('./core');
const secrets = require('./secrets');

const MAX_MESSAGES = 500;
// Bước 2: dùng thử ngầm TRIAL_DAYS ngày, tính từ lần cài đặt đầu tiên trên máy này.
// Máy chủ vẫn là nguồn quyết định; giá trị dưới đây chỉ là phương án dự phòng khi
// chưa đăng ký được hoặc Gateway không phản hồi.
const TRIAL_DAYS = 3;
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;
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
  constructor(dataDir) {
    this.file = path.join(dataDir, 'support.json');
    this.gatewayFile = path.join(dataDir, 'support-gateway.json');
    this.data = read(this.file, null) || this.create();
    this.normalize();
    this.save();
  }

  create() {
    const installationId = id();
    return {
      version: 1,
      device: { installationId, chatRoomId: `ROOM_WIN_${id().replace(/-/g, '').slice(0, 12).toUpperCase()}`, hardwareHash: hardwareHash(), firstInstallAt: now(), registeredAt: 0, phone: '', name: '', plan: '' },
      license: { status: 'unactivated', key: '', updatedAt: 0 },
      messages: []
    };
  }

  normalize() {
    if (!this.data.device?.installationId || !this.data.device?.chatRoomId) this.data = this.create();
    if (!this.data.device.phone) this.data.device.phone = '';
    if (!this.data.device.name) this.data.device.name = '';
    if (!this.data.device.plan) this.data.device.plan = '';
    if (!this.data.device.hardwareHash) this.data.device.hardwareHash = hardwareHash();
    if (!this.data.license) this.data.license = { status: 'unactivated', key: '', updatedAt: 0 };
    if (!Array.isArray(this.data.messages)) this.data.messages = [];
  }

  save() { atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }

  publicDevice() {
    const { installationId, chatRoomId, firstInstallAt, registeredAt, phone, name, plan, hardwareHash: hash } = this.data.device;
    return { installationId, hardwareId: installationId, chatRoomId, hardwareHash: hash || '', firstInstallAt, registeredAt, phone, name, plan: plan || '', mode: 'local-mock' };
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
    this.data.license.status = value.status || this.data.license.status;
    this.data.license.packageType = value.packageType || value.package || this.data.license.packageType || '';
    this.data.license.keyName = value.keyName || value.licenseKey || value.key || this.data.license.keyName || this.data.license.key || '';
    this.data.license.key = this.data.license.keyName || this.data.license.key || '';
    if (value.expiryAt !== undefined) {
      this.data.license.expiryAt = formatExpiry(value.expiryAt);
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
    return { messages: value.messages || [] };
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
}

module.exports = { SupportStore, parseDate, formatExpiry, expired, parseSseFrame, applyStreamEvent, sortedMessages };