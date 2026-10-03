'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/data/provider-registry');
test('Viettel has default S-Invoice portal and separate Telecom and ePass routes', () => {
  const general = registry.resolveInvoice({ msttcgp: '0100109106', mst_ban: '0900000001' });
  assert.equal(general.lookup_url, 'https://vinvoice.viettel.vn/utilities/invoice-search');
  assert.equal(general.provider_name, 'Viettel S-Invoice');
  const telecom = registry.resolveInvoice({ msttcgp: '0100109106', mst_ban: '0100109106-293' });
  assert.equal(telecom.lookup_url, 'https://vietteltelecom.vn/tra-cuu-hoa-don-dien-tu');
  assert.equal(telecom.provider_name, 'Viettel Telecom');
  assert.match(registry.resolveInvoice({ msttcgp: '0100109106', mst_ban: '0109266456' }).lookup_url, /epass-vdtc/);
});
test('specific FPT hostname beats broad einvoice.vn; explicit portal beats solution evidence', () => {
  const fpt = registry.resolveInvoice({ msttcgp: '0104128565', lookup_url: 'https://fpt.einvoice.vn/' });
  assert.equal(fpt.provider_id, 'fpt');
  const mixed = registry.resolveInvoice({ msttcgp: '0100109106', lookup_url: 'https://seller.easyinvoice.com.vn/' });
  assert.equal(mixed.provider_id, 'easyinvoice');
  assert.equal(mixed.solution_provider_name, 'Viettel Telecom');
  assert.equal(mixed.lookup_url, 'https://seller.easyinvoice.com.vn/');
});
test('solution registry is broader and unknown tax codes do not acquire made-up identity', () => {
  assert.match(registry.resolve('0101360697').name, /BKAV/i);
  assert.equal(registry.resolve('9999999999'), null);
  assert.equal(registry.resolveInvoice({ msttcgp: '9999999999' }).lookup_url, null);
});
test('seller registry does not overwrite a different solution provider', () => {
  assert.equal(registry.sellerPortal('0101452595', 'viettel'), '');
  assert.match(registry.sellerPortal('0101452595', 'vnpt'), /vnpt/);
});
