'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./core');

function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function hash(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
}

function validPin(pin) {
  return /^\d{4}$/.test(String(pin || ''));
}

class AppLockStore {
  constructor(dataDir, support) {
    this.file = path.join(dataDir, 'app-lock.json');
    this.support = support;
    this.data = read(this.file, { version: 1, enabled: false, salt: '', pinHash: '', locked: false, updatedAt: 0 });
    this.normalize();
    this.save();
  }

  normalize() {
    this.data.version = 1;
    this.data.enabled = !!this.data.enabled;
    this.data.salt = String(this.data.salt || '');
    this.data.pinHash = String(this.data.pinHash || '');
    this.data.locked = !!this.data.locked;
    this.data.updatedAt = Number(this.data.updatedAt || 0);
    if (!this.data.pinHash) this.data.enabled = false;
  }

  save() { atomicWrite(this.file, JSON.stringify(this.data, null, 2)); }

  status() {
    return { enabled: this.data.enabled, locked: this.data.enabled && this.data.locked, updatedAt: this.data.updatedAt };
  }

  setPin(pin) {
    if (!validPin(pin)) throw new Error('Mã PIN phải gồm đúng 4 số.');
    const salt = crypto.randomBytes(16).toString('hex');
    this.data = { version: 1, enabled: true, salt, pinHash: hash(pin, salt), locked: false, updatedAt: Date.now() };
    this.save();
    return this.status();
  }

  verify(pin) {
    if (!this.data.enabled) return true;
    if (!validPin(pin) || hash(pin, this.data.salt) !== this.data.pinHash) throw new Error('Mã PIN không đúng.');
    this.data.locked = false;
    this.save();
    return this.status();
  }

  lock() {
    if (!this.data.enabled) throw new Error('Chưa thiết lập mã PIN.');
    this.data.locked = true;
    this.save();
    return this.status();
  }

  resetWithLicense(licenseKey, newPin) {
    const saved = String(this.support?.data?.license?.key || this.support?.data?.license?.keyName || '').trim();
    if (!saved || String(licenseKey || '').trim() !== saved) throw new Error('License Key không khớp với key đã kích hoạt trên máy này.');
    return this.setPin(newPin);
  }
}

module.exports = { AppLockStore };
