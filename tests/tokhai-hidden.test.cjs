'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { TaxBrowser } = require('../src/browser');

test('Declaration Chrome stays hidden with a live cookie session and background tabs', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokhai-hidden-'));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'declaration_fixture=kept; Path=/; SameSite=Lax');
    res.end('<html><head><title>Declaration hidden fixture</title></head><body>Fixture</body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = new TaxBrowser(root, { startUrl: url });
  try {
    await browser.open('0101234567', false);
    const pid = browser.process.pid;
    assert.equal(browser.visible, false);
    for (let i = 0; i < 60 && !(await browser.evalWithTimeout('document.cookie', 5000)).includes('declaration_fixture=kept'); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const tab = await browser.tabForOrigin(url);
    assert.ok((await browser.evalInTab(tab, 'document.cookie')).includes('declaration_fixture=kept'));
    await browser.hide();
    assert.equal(browser.process.pid, pid, 'Hiding preserves the same browser process/session');
    if (process.platform === 'win32') {
      const inspect = () => JSON.parse(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InspectChromeWindow {
  public delegate bool Callback(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int length);
  public static string Read(uint wanted) {
    List<string> rows = new List<string>();
    EnumWindows((handle, state) => { uint owner; GetWindowThreadProcessId(handle, out owner);
      StringBuilder name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (owner == wanted && name.ToString() == "Chrome_WidgetWin_1") {
        int style = GetWindowLong(handle, -20);
        rows.Add("{\\"visible\\":" + (IsWindowVisible(handle) ? "true" : "false") + ",\\"tool\\":" + ((style & 0x80) != 0 ? "true" : "false") + ",\\"app\\":" + ((style & 0x40000) != 0 ? "true" : "false") + "}");
      } return true; }, IntPtr.Zero);
    return "[" + string.Join(",", rows.ToArray()) + "]";
  }
}
'@
[InspectChromeWindow]::Read(${pid})`], { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim());
      let windows = inspect();
      assert.ok(windows.length > 0, 'Inspect the real owned Chrome window rather than an empty MainWindowHandle');
      for (const window of windows) assert.deepEqual(window, { visible: false, tool: true, app: false });
      // A newly created target must not bypass hiding because an earlier hide was cached.
      const target = await browser.client.Target.createTarget({ url: url + '?new-tab', background: true });
      await browser.hide();
      windows = inspect();
      for (const window of windows) assert.deepEqual(window, { visible: false, tool: true, app: false });
      await browser.client.Target.closeTarget({ targetId: target.targetId });
      assert.equal(browser.nativeHidden, true);
    }
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^tokhai-hidden-/);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { t.diagnostic('Temporary declaration profile cleanup: ' + error.code); }
  }
});
