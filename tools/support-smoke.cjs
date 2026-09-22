'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SupportStore } = require('../src/support');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-support-'));
  fs.writeFileSync(path.join(dir, 'support-gateway.json'), JSON.stringify({
    url: process.env.WORKER_URL || 'https://hoadon-support-gateway.linhnhaxac10.workers.dev'
  }));
  const support = new SupportStore(dir);
  console.log('step: register');
  const registered = await support.register();
  console.log('step: status-before');
  const before = await support.status();
  console.log('step: message');
  const message = await support.addMessage('user', 'Desktop support smoke test.');
  console.log('step: status-after');
  const after = await support.status();
  const last = after.messages[after.messages.length - 1] || {};
  console.log(JSON.stringify({
    registered: registered.mode,
    license: before.license.status,
    messageOk: !!message.id,
    count: after.messages.length,
    lastDeliveryStatus: last.deliveryStatus || ''
  }));
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
