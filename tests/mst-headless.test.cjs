'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { TaxBrowser } = require('../src/browser');

test('MST headless Chrome has no native window and preserves a separate cookie session', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-headless-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'mst_fixture=kept; Path=/; SameSite=Lax');
    res.end('<html><head><title>MST headless fixture</title></head><body>Fixture</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = new TaxBrowser(root, { headless: true, startUrl: url });
  try {
    await browser.open('0101234567', false);
    assert.ok(browser.process.spawnargs.includes('--headless=new'));
    assert.ok(!browser.process.spawnargs.includes('--start-minimized'));
    await browser.show();
    assert.equal(browser.visible, false);
    for (let i = 0; i < 60 && await browser.evalWithTimeout('document.title', 5000) !== 'MST headless fixture'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await browser.evalWithTimeout('document.title', 5000), 'MST headless fixture');
    assert.ok((await browser.evalWithTimeout('document.cookie', 5000)).includes('mst_fixture=kept'));
    if (process.platform === 'win32') {
      const code = `$items = Get-CimInstance Win32_Process; $ids = @(${browser.process.pid}); do { $next = @($items | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count -gt 0); @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 }).Count`;
      const count = execFileSync('powershell', ['-NoProfile', '-Command', code], { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim();
      assert.equal(count, '0', 'headless process and its children must have no native window/taskbar window');
    }
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^mst-headless-/);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { t.diagnostic('Temporary headless profile cleanup: ' + error.code); }
  }
});
