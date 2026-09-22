'use strict';
// Machine-bound storage for the portal password and the saved portal session
// (JWT + cookies) of each MST. Same idea as VNIT's .matkhau.json/.tokens.json: the file
// stays on this machine, copy it elsewhere and it cannot be opened.
// Windows DPAPI (CurrentUser) is used when available; otherwise AES-256-GCM with a key
// derived from this machine's identity. HOADON_SECRET_MODE=aes forces the AES path.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const DPAPI = 'dpap1:';
const AES = 'aes1:';
const KEYS = ['password', 'token', 'cookies'];
const POWERSHELL = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$t=[Console]::In.ReadToEnd()'
].join(';');
const UNPROTECT_SCRIPT = `${POWERSHELL};$b=[Convert]::FromBase64String($t.Trim());$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))`;
const PROTECT_SCRIPT = `${POWERSHELL};$b=[Text.Encoding]::UTF8.GetBytes($t);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($p))`;
let directory = '';
let dpapiWorks = null;

function machineIdentity() {
  const nets = os.networkInterfaces();
  const mac = Object.keys(nets).sort().flatMap(name => nets[name] || []).filter(x => !x.internal && x.mac && x.mac !== '00:00:00:00:00:00').map(x => x.mac).sort()[0] || '';
  let username = '';
  try { username = os.userInfo().username; } catch {}
  return [os.hostname(), username, mac, os.platform(), os.arch()].join('|');
}
function keyFor(salt) { return crypto.scryptSync(machineIdentity(), salt, 32, { N: 16384, r: 8, p: 1 }); }
function dpapi(script, value) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim();
}
function aesProtect(text) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(salt), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return AES + [salt, iv, cipher.getAuthTag(), body].map(x => x.toString('base64')).join(':');
}
function aesUnprotect(blob) {
  const [salt, iv, tag, body] = blob.slice(AES.length).split(':');
  if (!salt || !iv || !tag || !body) throw new Error('Dữ liệu đã lưu không đúng định dạng.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(Buffer.from(salt, 'base64')), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
function protect(text) {
  const value = String(text ?? '');
  if (dpapiWorks !== false && process.env.HOADON_SECRET_MODE !== 'aes') {
    try { const blob = DPAPI + dpapi(PROTECT_SCRIPT, value); dpapiWorks = true; return blob; } catch { dpapiWorks = false; }
  }
  return aesProtect(value);
}
function unprotect(blob) {
  const value = String(blob || '');
  if (!value) return '';
  if (value.startsWith(DPAPI)) return dpapi(UNPROTECT_SCRIPT, value.slice(DPAPI.length));
  if (value.startsWith(AES)) return aesUnprotect(value);
  throw new Error('Không nhận ra định dạng dữ liệu đã lưu.');
}
function file(mst) { return path.join(directory, 'secrets', `${mst}.json`); }
function readRaw(mst) { try { return JSON.parse(fs.readFileSync(file(mst), 'utf8')); } catch { return null; } }
function drop(mst) { try { fs.unlinkSync(file(mst)); } catch {} }
function read(mst, keys = KEYS) {
  const raw = readRaw(mst) || {}; const value = { password: '', token: '', cookies: '', savedAt: raw.savedAt || 0 };
  for (const key of keys) { try { value[key] = unprotect(raw[key]); } catch { value[key] = ''; } }
  return value;
}
function write(mst, patch) {
  const raw = readRaw(mst) || { version: 1, mst };
  for (const [key, value] of Object.entries(patch || {})) { if (value) raw[key] = protect(value); else delete raw[key]; }
  raw.version = 1; raw.mst = mst; raw.savedAt = Date.now();
  if (!KEYS.some(key => raw[key])) { drop(mst); return; }
  fs.mkdirSync(path.dirname(file(mst)), { recursive: true });
  const temp = file(mst) + '.part'; fs.writeFileSync(temp, JSON.stringify(raw, null, 2)); fs.renameSync(temp, file(mst));
}
function clear(mst, keys) {
  const raw = readRaw(mst); if (!raw) return;
  for (const key of keys) delete raw[key];
  if (!KEYS.some(key => raw[key])) { drop(mst); return; }
  raw.savedAt = Date.now();
  fs.mkdirSync(path.dirname(file(mst)), { recursive: true });
  const temp = file(mst) + '.part'; fs.writeFileSync(temp, JSON.stringify(raw, null, 2)); fs.renameSync(temp, file(mst));
}
function init(dir) { directory = path.resolve(dir); dpapiWorks = null; fs.mkdirSync(path.join(directory, 'secrets'), { recursive: true }); return api; }
function guard() { if (!directory) throw new Error('Kho bí mật chưa được khởi tạo.'); }
const api = {
  init,
  machineIdentity,
  read: (mst, keys) => { guard(); return read(mst, keys); },
  write: (mst, patch) => { guard(); return write(mst, patch); },
  clear: (mst, keys = KEYS) => { guard(); return clear(mst, keys); },
  protect, unprotect
};
module.exports = api;
