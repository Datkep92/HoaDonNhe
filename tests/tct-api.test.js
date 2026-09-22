const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const tct = require('../src/tct-api');
const BLOCK = JSON.stringify({ status: 403, message: 'Hệ thống phát hiện hành vi không hợp lệ. Yêu cầu đã bị chặn.' });

test('portal requests carry a complete and consistent Chrome fingerprint', () => {
  const headers = tct.portalHeaders({ Authorization: 'Bearer token' });
  for (const name of ['Accept', 'Accept-Language', 'Accept-Encoding', 'User-Agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'Origin', 'Referer', 'request-id', 'Connection']) assert.ok(headers[name], name);
  const chrome = headers['User-Agent'].match(/Chrome\/(\d+)\./);
  assert.ok(chrome, 'User-Agent must announce Chrome');
  assert.match(headers['sec-ch-ua'], new RegExp(`"Google Chrome";v="${chrome[1]}"`));
  assert.equal(headers.Origin, 'https://hoadondientu.gdt.gov.vn');
  assert.match(headers.Referer, /^https:\/\/hoadondientu\.gdt\.gov\.vn\//);
  assert.equal(headers.Authorization, 'Bearer token');
  assert.notEqual(tct.portalHeaders()['request-id'], tct.portalHeaders()['request-id']);
});
test('compressed responses are decoded and untouched bodies keep their bytes', () => {
  const payload = Buffer.from('{"key":"k","content":"<svg/>"}');
  for (const [encoding, body] of [['gzip', zlib.gzipSync(payload)], ['deflate', zlib.deflateSync(payload)], ['br', zlib.brotliCompressSync(payload)]]) {
    assert.equal(tct.decodeBody({ headers: { 'content-encoding': encoding }, body }).toString('utf8'), payload.toString('utf8'));
  }
  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  assert.deepEqual(tct.decodeBody({ headers: {}, body: binary }), binary);
});
test('a blocked request pauses portal calls instead of retrying immediately', async t => {
  t.after(() => tct.resetRest());
  tct.noteRest(403, BLOCK);
  assert.ok(tct.restRemaining() > 0);
  await assert.rejects(() => tct.captcha(), /tạm từ chối truy cập/);
  assert.match(await tct.captcha().catch(error => error.message), /HTTP 403/);
  tct.noteRest(200, '{}');
  assert.equal(tct.restRemaining(), 0);
});
test('portal cookies are kept and sent back the way a browser would', t => {
  t.after(() => tct.clearCookies());
  tct.clearCookies();
  assert.equal(tct.portalHeaders().Cookie, undefined);
  tct.storeCookies(['TS0114b13e=abc123; Path=/; HttpOnly', 'jwt=xyz; Expires=Wed, 01 Jan 2030 00:00:00 GMT']);
  assert.equal(tct.cookies(), 'TS0114b13e=abc123; jwt=xyz');
  assert.equal(tct.portalHeaders().Cookie, 'TS0114b13e=abc123; jwt=xyz');
  tct.storeCookies(['jwt=; Expires=Wed, 01 Jan 1990 00:00:00 GMT']); // session ended -> cookie dropped
  assert.equal(tct.cookies(), 'TS0114b13e=abc123');
  tct.setCookies('jwt=restored'); // a session saved to disk is loaded again
  assert.equal(tct.cookies(), 'jwt=restored');
  tct.clearCookies();
  assert.equal(tct.portalHeaders().Cookie, undefined);
});
