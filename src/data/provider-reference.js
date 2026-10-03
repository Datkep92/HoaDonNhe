'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ URL, module: { exports: {} } });
for (const file of ['provider-registry', 'core', 'solution-providers']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'provider-reference', file + '.js'), 'utf8'), context);
}
const core = context.InvoiceCore;
const solutions = context.module.exports.INVOICE_PROVIDERS;
function solution(taxCode) {
  const key = String(taxCode || '').trim();
  const record = solutions.find(item => item.MST === key) || solutions.find(item => item.MST === key.split('-')[0]);
  if (!record) return null;
  const detected = core.detectProvider({ portal: record.lookup || record.homePage });
  return { id: detected.id === 'generic' || detected.id === 'unknown' ? '' : detected.id,
    name: record.name, portalUrl: record.lookup || '', level: 'portal-only', solutionTaxCode: key };
}
function invoice(row, known) {
  const clean = require('./original-pdf').cleanPortalUrl;
  let url = clean(row.lookup_url);
  if (url === 'https://business.sinvoice.viettel.vn/tracuuhoadon.html') url = 'https://vinvoice.viettel.vn/utilities/invoice-search';
  let provider = core.detectProvider({ nbmst: row.mst_ban, msttcgp: row.msttcgp, portal: url, ngcnhat: row.ngcnhat || '' });
  if ((!url || ['unknown', 'generic'].includes(provider.id)) && known) {
    provider = { ...(core.PROVIDERS.find(item => item.id === known.id) || {}), id: known.id || 'generic', name: known.name,
      lookupUrl: url || known.portalUrl, lookupSource: url ? 'document' : 'solution-provider-tax-code' };
  }
  if (url) {
    const host = new URL(url).hostname;
    const matches = core.PROVIDERS.flatMap(item => item.hosts.filter(suffix => host === suffix || host.endsWith('.' + suffix)).map(suffix => ({ item, length: suffix.length })));
    matches.sort((a, b) => b.length - a.length);
    if (matches.length) provider = { ...matches[0].item, lookupUrl: url, lookupSource: 'document' };
  }
  provider = core.providerWithFallback(provider, row.lookup_code, { sellerTaxCode: row.mst_ban, providerInvoiceId: row.provider_invoice_id });
  const telecomPortal = provider.id === 'viettel' && core.VIETTEL_PORTAL_BY_TAX_CODE[String(row.mst_ban || '').slice(0, 10)];
  if (!url && telecomPortal) provider.lookupUrl = telecomPortal;
  if (!url && provider.id === 'viettel' && !telecomPortal) provider.lookupUrl = 'https://vinvoice.viettel.vn/utilities/invoice-search';
  if (provider.id === 'viettel') provider.name = telecomPortal ? 'Viettel Telecom' : 'Viettel S-Invoice';
  const portal = clean(url || provider.lookupUrl || known?.portalUrl);
  return { ...row, provider_id: provider.id === 'unknown' ? null : provider.id,
    provider_name: provider.name || known?.name || 'Chưa nhận diện NCC', lookup_url: portal || null,
    provider_source: url ? 'Link đã lưu / XML' : provider.lookupSource === 'registry-seller' ? 'Bảng người bán 1.4.20' : 'Bảng NCC',
    solution_provider_name: known?.name || '', provider_level: known?.level || 'portal-only',
    provider_code: provider.tvanCode || '', direct_pdf_url: provider.directPdfUrl || '' };
}
module.exports = { solution, invoice, core, registry: context.InvoiceProviderRegistry };
