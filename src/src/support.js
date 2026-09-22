'use strict';

// Phase 1 local adapter.  The public API intentionally mirrors the future
// Gateway API so the renderer does not need to know whether support is local
// or backed by Firebase/Telegram.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { atomicWrite } = require('./core');

const MAX_MESSAGES = 500;
const now = () => Date.now();
const id = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

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
      device: { installationId, chatRoomId: `ROOM_WIN_${id().replace(/-/g, '').slice(0, 12).toUpperCase()}`, firstInstallAt: now(), registeredAt: 0 },
      license: { status: 'unactivated', key: '', updatedAt: 0 },
      messages: []
    };
  }

  normalize() {
    if (!this.data.device?.installationId || !this.data.device?.chatRoomId) this.data = this.create();
    if (!this.data.license) this.data.license = { status: 'unactivated', key: '', updatedAt: 0 };
    if (!Array.isArray(this.data.messages)) this.data.messages = [];
  }

  save() { atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }

  publicDevice() {
    const { installationId, chatRoomId, firstInstallAt, registeredAt } = this.data.device;
    return { installationId, hardwareId: installationId, chatRoomId, firstInstallAt, registeredAt, mode: 'local-mock' };
  }

  gatewayUrl() {
    const configured = read(this.gatewayFile, {});
    const url = String(configured.url || '').trim();
    if (!url) return '';
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
    if (value.chatRoomId && String(value.chatRoomId).trim()) {
      this.data.device.chatRoomId = String(value.chatRoomId).trim();
    }
    if (String(this.data.license.status || '').toLowerCase() === 'active' && expired(this.data.license.expiryAt)) {
      this.data.license.status = 'Expired';
    }
    this.data.license.updatedAt = now(); this.save();
  }

  register() {
    const remote = this.gateway('/v1/devices/register', this.publicDevice());
    if (remote) return remote.then(value => { this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || ''; this.saveLicense(value); return { ...this.publicDevice(), ...value, mode: 'gateway' }; });
    if (!this.data.device.registeredAt) this.data.device.registeredAt = now();
    this.save();
    return this.publicDevice();
  }

  status() {
    const remote = this.gateway('/v1/licenses/status', this.publicDevice());
    if (remote) return remote.then(async value => {
      this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || ''; this.saveLicense(value);
      const chat = await this.gateway('/v1/chats/status', this.publicDevice(), true);
      return { device: { ...this.publicDevice(), mode: 'gateway' }, license: this.publicLicense(), messages: chat.messages || [] };
    });
    return { device: this.publicDevice(), license: this.publicLicense(), messages: this.data.messages };
  }

  publicLicense() {
    if (expired(this.data.license.expiryAt) && String(this.data.license.status || '').toLowerCase() === 'active') {
      this.data.license.status = 'Expired';
      this.data.license.updatedAt = now();
      this.save();
    }
    return {
      status: this.data.license.status || 'unactivated',
      packageType: this.data.license.packageType || '',
      keyName: this.data.license.keyName || this.data.license.key || '',
      expiryAt: this.data.license.expiryAt || '',
      updatedAt: this.data.license.updatedAt || 0
    };
  }

  async enforceLicense() {
    const remote = this.gateway('/v1/licenses/status', this.publicDevice());
    if (remote) {
      const value = await remote;
      this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
      this.saveLicense(value);
    }
    const license = this.publicLicense();
    const st = String(license.status || '').toLowerCase();
    if (st === 'locked') {
      throw new Error('Bản quyền thiết bị đã bị khóa bởi quản trị viên. Vui lòng liên hệ hỗ trợ.');
    }
    if (st === 'expired' || expired(license.expiryAt)) {
      this.data.license.status = 'Expired';
      this.save();
      throw new Error('License Key đã hết hạn. Vui lòng gia hạn hoặc nhập key mới trong Cài đặt → Bản quyền & Đăng ký.');
    }
    return license;
  }

  async activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (key.length < 6 || key.length > 160) throw new Error('License Key phải có từ 6 đến 160 ký tự.');
    if (this.gatewayUrl()) {
      if (!this.data.device.registeredAt) {
        try { await this.register(); } catch {}
      }
      const value = await this.gateway('/v1/licenses/activate', { ...this.publicDevice(), key });
      this.data.license.key = key;
      this.data.license.keyName = key;
      this.data.license.sessionToken = value.sessionToken || this.data.license.sessionToken || '';
      this.saveLicense(value);
      return { ...this.publicLicense(), mode: 'gateway' };
    }
    // No key is treated as valid locally.  A real Gateway replaces this with
    // server-side validation and a signed, expiring license response.
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

module.exports = { SupportStore, parseDate, formatExpiry, expired };
