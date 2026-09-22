'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppLockStore } = require('../src/app-lock');

test('app lock hashes PIN locally and resets only with saved license key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-lock-'));
  const support = { data: { license: { key: 'PLUS-TEST-KEY' } } };
  const lock = new AppLockStore(dir, support);
  assert.equal(lock.status().enabled, false);
  lock.setPin('1234');
  const raw = fs.readFileSync(path.join(dir, 'app-lock.json'), 'utf8');
  assert.equal(raw.includes('1234'), false);
  assert.throws(() => lock.verify('9999'), /Mã PIN không đúng/);
  assert.equal(lock.verify('1234').locked, false);
  assert.throws(() => lock.resetWithLicense('WRONG', '5678'), /License Key không khớp/);
  lock.resetWithLicense('PLUS-TEST-KEY', '5678');
  assert.throws(() => lock.verify('1234'), /Mã PIN không đúng/);
  assert.equal(lock.verify('5678').locked, false);
});
