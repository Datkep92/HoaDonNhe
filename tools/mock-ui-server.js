// Mock server nội bộ để TEST GIAO DIỆN không cần app thật (node tools/mock-ui-server.js).
// Serve src/ tĩnh + giả /api/state: mở http://127.0.0.1:8899 trong Chrome để bấm thử UI.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'src');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const state = {
  ok: true,
  value: {
    busy: false, authBusy: false, authenticated: true, selected: '0123456789',
    accounts: [{ mst: '0123456789', name: 'Cửa hàng Minh Anh', session: 'saved', identifiers: ['9876543210'], remembered: true, job: { state: 'idle', total: 0 }, sync: null }],
    pool: {}, stats: null, state: 'idle', message: '', total: 0, done: 0, failed: 0, percentage: 0,
    mode: 'search', output: 'C:\\xuathoadon', browserVisible: false, browserReady: false, itemsRevision: 0, items: []
  }
};
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state)); }
  if (u.pathname === '/api/state/items') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, value: [] })); }
  if (req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, value: {} })); }
  const file = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname);
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(8899, '127.0.0.1', () => console.log('mock UI: http://127.0.0.1:8899'));
