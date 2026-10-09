'use strict';
// Browser-side synthetic portal fixture: tests the copied state machine with DOMParser.
const { searchTdtInTab, fetchFilesTdtInTab, fetchFilesDvcInTab, prepareTdtLoginInTab } = require('../src/tokhai-portal');
module.exports = `(${async function (prepare, search, tdtFiles, dvcFiles) {
  const original = window.fetch;
  const seen = [];
  const fields = '<input name="dse_sessionId" value="fixture-session"><input name="dse_processorId" value="processor"><input name="dse_pageId" value="11"><input name="dse_processorState" value="initial">';
  const row = id => '<tr>' + ['1', id, '01/GTGT Tải tệp tờ khai về', '09/2026', 'Chính thức', '1', '0', '01/10/2026', '', 'CQT', 'Đã nhận'].map(c => '<td>' + c + '</td>').join('') + '</tr>';
  const table = id => fields + '<table><tbody id="allResultTableBody">' + row(id) + '</tbody></table>';
  const xml = '<?xml version="1.0"?><HSoThueDTu/>';
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.origin);
    const body = options.body || '';
    seen.push({ path: parsed.pathname, query: parsed.search, body });
    if (parsed.pathname.endsWith('/Request')) {
      const params = options.method === 'POST' ? new URLSearchParams(body) : parsed.searchParams;
      const event = params.get('dse_nextEventName');
      if (event === 'downTkhai' || event === 'download') return new Response(xml);
      if (event === 'viewTBao') return new Response(fields + '<table><tbody><tr><td>1</td><td><a onclick="downloadFile(\'notification\')">TB1</a></td><td>Tiếp nhận</td></tr></tbody></table>');
      if (event === 'query') return new Response(table(params.get('pn') === '2' ? '654321' : '123456') + (params.get('ma_gd') ? '' : '<div id="currAcc"><b>2</b></div>'));
      return new Response(fields + '<form id="goProcForm">' + fields + '</form>');
    }
    if (parsed.pathname.includes('/files/detail/')) return new Response('<input name="_csrf" value="csrf"><div class="row"><b class="fw-bold">Tiếp nhận</b><a data-id="tb1" onclick="downloadThongBao()">TB</a></div>');
    if (parsed.pathname.endsWith('/downloadhoso') || parsed.pathname.endsWith('/downloadthongbao') || parsed.pathname.endsWith('/download-tai-lieu-dkem')) return json({ content: btoa(xml), fileName: 'test.xml' });
    if (parsed.pathname.endsWith('/data-tai-lieu-dkem')) return json({ data: [{ maTep: 'file1', tenTep: 'Dinh kem', dinhDangTep: 'xml' }] });
    throw new Error('Unexpected fixture URL: ' + parsed.pathname);
  };
  try {
    const login = await prepare(location.origin);
    const found = await search({ tuNgay: '01/09/2026', denNgay: '09/10/2026' }, location.origin, 'fixture-session');
    const tdt = await tdtFiles('123456', location.origin, '01/10/2026', 'fixture-session');
    const dvc = await dvcFiles('123456', location.origin);
    return { login, found, tdt, dvc, pagination: seen.some(r => r.query.includes('pn=2')), searchDate: seen.some(r => r.body.includes('qryFromDate=01%2F09%2F2026')), notifications: seen.some(r => r.query.includes('viewTBao')), attachment: seen.some(r => r.path.endsWith('/download-tai-lieu-dkem')) };
  } finally { window.fetch = original; }
}.toString()})(${prepareTdtLoginInTab.toString()},${searchTdtInTab.toString()},${fetchFilesTdtInTab.toString()},${fetchFilesDvcInTab.toString()})`;
