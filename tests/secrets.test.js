const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HOADON_SECRET_MODE = 'aes'; // DPAPI needs to spawn PowerShell; tests exercise the AES path
const secrets = require('../src/secrets');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoadon-secrets-'));
secrets.init(dir);
const MST = '4500677693';
const file = () => path.join(dir, 'secrets', `${MST}.json`);

test('remembered password and session are stored encrypted and read back', () => {
  secrets.write(MST, { password: 'mat-khau-that', token: 'jwt.token.value', cookies: 'TS0=abc; jwt=xyz' });
  const raw = fs.readFileSync(file(), 'utf8');
  assert(!raw.includes('mat-khau-that')); assert(!raw.includes('jwt.token.value')); assert(!raw.includes('TS0=abc'));
  const value = secrets.read(MST);
  assert.equal(value.password, 'mat-khau-that'); assert.equal(value.token, 'jwt.token.value'); assert.equal(value.cookies, 'TS0=abc; jwt=xyz');
});
test('only the requested keys are decrypted', () => {
  const value = secrets.read(MST, ['password']);
  assert.equal(value.password, 'mat-khau-that'); assert.equal(value.cookies, ''); assert.equal(value.token, '');
});
test('dropping the password keeps the session, dropping everything removes the file', () => {
  secrets.clear(MST, ['password']);
  assert.equal(secrets.read(MST).password, '');
  assert.equal(secrets.read(MST).token, 'jwt.token.value');
  secrets.clear(MST);
  assert(!fs.existsSync(file()));
  assert.equal(secrets.read(MST).password, '');
});
test('tampered or foreign data is refused instead of returning garbage', () => {
  const blob = secrets.protect('bi-mat');
  assert.equal(secrets.unprotect(blob), 'bi-mat');
  const parts = blob.split(':');
  parts[parts.length - 1] = Buffer.from('noi dung khac').toString('base64');
  assert.throws(() => secrets.unprotect(parts.join(':')));
  assert.throws(() => secrets.unprotect('plain-text'));
  assert.equal(secrets.unprotect(''), '');
});
