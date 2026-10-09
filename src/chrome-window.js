'use strict';
const { execFile } = require('node:child_process');

// Chỉ điều khiển cửa sổ thuộc tiến trình Chrome do ứng dụng đã khởi chạy.
function setChromeWindowVisible(pid, visible) {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CnChromeWindow {
  public delegate bool Callback(IntPtr handle, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int length);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW")] public static extern int SetWindowLong(IntPtr handle, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  [ComImport, Guid("56FDF342-FD6D-11d0-958A-006097C9A090"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface TaskbarList {
    void HrInit(); void AddTab(IntPtr handle); void DeleteTab(IntPtr handle); void ActivateTab(IntPtr handle); void SetActiveAlt(IntPtr handle);
  }
  public static int Set(uint wanted, bool visible) {
    int count = 0;
    TaskbarList taskbar = (TaskbarList)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11d0-958A-006097C9A090")));
    taskbar.HrInit();
    try {
    EnumWindows((handle, state) => { uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner != wanted) return true;
      StringBuilder name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (name.ToString() != "Chrome_WidgetWin_1") return true;
      // WS_EX_TOOLWINDOW loại cửa sổ khỏi taskbar/Alt+Tab kể cả Chrome tự khôi phục nó.
      // WS_EX_APPWINDOW ép Explorer tạo nút taskbar nên phải bỏ khi chạy nền.
      int style = GetWindowLong(handle, -20);
      ShowWindow(handle, 0);
      SetWindowLong(handle, -20, visible ? ((style & ~0x80) | 0x40000) : ((style | 0x80) & ~0x40000));
      SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, 0x37);
      if (visible) { ShowWindow(handle, 9); taskbar.AddTab(handle); }
      else { taskbar.DeleteTab(handle); ShowWindow(handle, 0); }
      count++; return true; }, IntPtr.Zero);
    } finally { Marshal.ReleaseComObject(taskbar); }
    return count;
  }
}
'@
[CnChromeWindow]::Set(${pid}, $${visible ? 'true' : 'false'})`;
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, timeout: 20000 }, (error, stdout, stderr) => error ? reject(new Error('Không đổi được trạng thái cửa sổ Chrome: ' + (stderr.trim() || (error.killed ? 'Windows không phản hồi trong 20 giây.' : error.message)))) : resolve(Number(stdout.trim()) || 0)));
}
module.exports = { setChromeWindowVisible };
