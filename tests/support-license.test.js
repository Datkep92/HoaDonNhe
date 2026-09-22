'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SupportStore, parseDate, formatExpiry, expired } = require('../src/support');

test('support license becomes expired locally after expiry date', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-support-license-'));
  const support = new SupportStore(dir);
  support.saveLicense({ status: 'Active', packageType: 'Plus', keyName: 'PLUS-EXPIRED', expiryAt: '2000-01-01' });
  const license = support.publicLicense();
  assert.equal(license.status, 'Expired');
  await assert.rejects(() => support.enforceLicense(), /License Key đã hết hạn/);
});

test('date parsing and formatting handles ISO, YYYY-MM-DD, DD/MM/YYYY, and lifetime', () => {
  // ISO date from Apps Script Date object serialization
  const iso = '2099-12-31T00:00:00.000Z';
  assert.equal(formatExpiry(iso), '2099-12-31');
  assert.equal(expired(iso), false);

  // Expired ISO date
  const pastIso = '2000-01-01T00:00:00.000Z';
  assert.equal(formatExpiry(pastIso), '2000-01-01');
  assert.equal(expired(pastIso), true);

  // Vietnamese format DD/MM/YYYY
  const vnFuture = '31/12/2099';
  assert.equal(formatExpiry(vnFuture), '2099-12-31');
  assert.equal(expired(vnFuture), false);

  const vnPast = '01/01/2000';
  assert.equal(formatExpiry(vnPast), '2000-01-01');
  assert.equal(expired(vnPast), true);

  // Standard YYYY-MM-DD
  const stdFuture = '2099-06-15';
  assert.equal(formatExpiry(stdFuture), '2099-06-15');
  assert.equal(expired(stdFuture), false);

  // Empty string / lifetime license
  assert.equal(formatExpiry(''), '');
  assert.equal(expired(''), false);
  assert.equal(expired(null), false);
  assert.equal(expired(undefined), false);
});

test('SupportStore preserves key when GAS status update omits keyName', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-support-key-'));
  const support = new SupportStore(dir);

  // Initial activation with a key
  support.data.license.key = 'VIP-KEY-12345';
  support.data.license.keyName = 'VIP-KEY-12345';
  support.data.license.status = 'Active';
  support.save();

  // GAS license_status returns only { status: 'Active', expiryAt: '2099-12-31' } as in code.txt
  support.saveLicense({ status: 'Active', expiryAt: '2099-12-31' });

  const license = support.publicLicense();
  assert.equal(license.status, 'Active');
  assert.equal(license.keyName, 'VIP-KEY-12345');
  assert.equal(support.data.license.key, 'VIP-KEY-12345');
  assert.equal(license.expiryAt, '2099-12-31');
});

test('integration with code.txt Google Apps Script & Gateway logic', async () => {
  // Mock Google Sheet data
  const devices = []; // rows: [Hardware ID, Chat Room ID, License Key, Status, Expiry Date, First Install Time, Last Seen Time]
  const licenses = [
    { key: 'ACTIVE-KEY-9999', status: 'Active', expiryDate: '2099-12-31', boundDevice: '', boundRoom: '', activatedAt: '' },
    { key: 'EXPIRED-KEY-0000', status: 'Active', expiryDate: '2000-01-01', boundDevice: '', boundRoom: '', activatedAt: '' },
    { key: 'LIFETIME-KEY-1111', status: 'Active', expiryDate: '', boundDevice: '', boundRoom: '', activatedAt: '' }
  ];

  // Mock server emulating the Gateway backed by code.txt Apps Script logic
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}');
      const { installationId, chatRoomId, key } = input;
      const send = (code, val) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(val));
      };

      if (req.url === '/v1/devices/register') {
        const found = devices.findIndex(d => d[0] === installationId);
        if (found < 0) {
          devices.push([installationId, chatRoomId, '', 'Unactivated', '', new Date().toISOString(), new Date().toISOString()]);
          return send(200, { ok: true, value: { status: 'Unactivated', registered: true, sessionToken: 'mock-token' } });
        }
        devices[found][1] = chatRoomId;
        devices[found][6] = new Date().toISOString();
        return send(200, { ok: true, value: { status: devices[found][3], expiryAt: devices[found][4], registered: false, sessionToken: 'mock-token' } });
      }

      if (req.url === '/v1/licenses/activate') {
        // verifyKey_ logic from code.txt
        const license = licenses.find(l => l.key === key);
        if (!license) return send(400, { ok: false, error: 'License key does not exist.' });
        if (license.status.toLowerCase() !== 'active') return send(400, { ok: false, error: 'License is not active.' });
        if (license.expiryDate && new Date(license.expiryDate).getTime() < Date.now()) {
          return send(400, { ok: false, error: 'License has expired.' });
        }
        if (license.boundDevice && license.boundDevice !== installationId) {
          return send(400, { ok: false, error: 'License is already bound to another device.' });
        }
        license.boundDevice = installationId;
        license.boundRoom = chatRoomId;
        license.activatedAt = new Date().toISOString();

        let deviceRow = devices.find(d => d[0] === installationId);
        if (!deviceRow) {
          // Auto-registration in gateway
          deviceRow = [installationId, chatRoomId, '', 'Unactivated', '', new Date().toISOString(), new Date().toISOString()];
          devices.push(deviceRow);
        }
        deviceRow[2] = key;
        deviceRow[3] = 'Active';
        deviceRow[4] = license.expiryDate || '';

        return send(200, {
          ok: true,
          value: { status: 'Active', expiryAt: license.expiryDate || '', keyName: key, sessionToken: 'mock-token' }
        });
      }

      if (req.url === '/v1/licenses/status') {
        const found = devices.find(d => d[0] === installationId);
        if (!found) return send(200, { ok: true, value: { status: 'Unactivated', sessionToken: 'mock-token' } });
        return send(200, { ok: true, value: { status: found[3], expiryAt: found[4] || '', sessionToken: 'mock-token' } });
      }

      if (req.url === '/v1/chats/status') {
        return send(200, { ok: true, value: { messages: [] } });
      }

      send(404, { ok: false, error: 'Not found.' });
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-integration-'));
    fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));

    const client = new SupportStore(dir);

    // 1. Device registers
    const reg = await client.register();
    assert.equal(reg.status, 'Unactivated');
    assert.equal(devices.length, 1);
    assert.equal(devices[0][0], client.data.device.installationId);

    // 2. Cannot activate invalid or expired key
    await assert.rejects(() => client.activate('NON-EXISTENT-KEY'), /License key does not exist/);
    await assert.rejects(() => client.activate('EXPIRED-KEY-0000'), /License has expired/);

    // 3. Successfully activate valid key
    const act = await client.activate('ACTIVE-KEY-9999');
    assert.equal(act.status, 'Active');
    assert.equal(act.expiryAt, '2099-12-31');
    assert.equal(act.keyName, 'ACTIVE-KEY-9999');

    // Verify sheet device state updated
    assert.equal(devices[0][2], 'ACTIVE-KEY-9999');
    assert.equal(devices[0][3], 'Active');
    assert.equal(devices[0][4], '2099-12-31');

    // 4. Verify another device cannot activate the same key
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-integration-2-'));
    fs.writeFileSync(path.join(dir2, 'support-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const client2 = new SupportStore(dir2);
    await client2.register();
    await assert.rejects(() => client2.activate('ACTIVE-KEY-9999'), /already bound to another device/);

    // 5. Client 1 status query reflects active state
    const st = await client.status();
    assert.equal(st.license.status, 'Active');
    assert.equal(st.license.keyName, 'ACTIVE-KEY-9999');
    assert.equal(st.license.expiryAt, '2099-12-31');

    // 6. enforceLicense succeeds for active license
    const enforced = await client.enforceLicense();
    assert.equal(enforced.status, 'Active');

    // 7. Admin locks device with /lock
    devices[0][3] = 'Locked';
    const lockedStatus = await client.status();
    assert.equal(lockedStatus.license.status, 'Locked');
    await assert.rejects(() => client.enforceLicense(), /Bản quyền thiết bị đã bị khóa/);

    // 8. Admin unlocks device with /unlock
    devices[0][3] = 'Active';
    const unlockedStatus = await client.status();
    assert.equal(unlockedStatus.license.status, 'Active');
    const unlockedEnforced = await client.enforceLicense();
    assert.equal(unlockedEnforced.status, 'Active');

    // 9. Admin resets device with /reset (clears boundDevice)
    devices[0][0] = '';
    devices[0][3] = 'Unactivated';
    const boundLic = licenses.find(l => l.key === 'ACTIVE-KEY-9999');
    boundLic.boundDevice = '';

    // Now client2 CAN activate the reset key!
    const act2 = await client2.activate('ACTIVE-KEY-9999');
    assert.equal(act2.status, 'Active');
    assert.equal(act2.keyName, 'ACTIVE-KEY-9999');
  } finally {
    server.close();
  }
});
