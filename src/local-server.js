'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function startupLease(dataDir, reuseExisting) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'local-server-startup.lock'), token = randomUUID();
  for (let n = 0; n < 100; n++) {
    if (n && reuseExisting && await reuseExisting()) return { reused: true, release() {} };
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
      return { release() { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      let alive = true;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
      } else {
        // A writer can briefly hold an empty file. Never remove it immediately.
        try { alive = Date.now() - fs.statSync(file).mtimeMs < 30000; } catch { continue; }
      }
      if (!alive) { try { fs.unlinkSync(file); } catch {} continue; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw Object.assign(Error('Ứng dụng đang khởi động. Không mở thêm máy chủ hoặc đổi cổng; thử mở lại sau.'), { code: 'APP_STARTUP_BUSY' });
}

function validPort(value) { return Number.isInteger(value) && value >= 1024 && value <= 65535; }
function readPort(file) {
  try { const port = JSON.parse(fs.readFileSync(file, 'utf8')).port; return validPort(port) ? port : 0; }
  catch { return 0; }
}
function bind(server, port) {
  return new Promise((resolve, reject) => {
    const fail = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', fail); resolve(server.address().port); };
    server.once('error', fail); server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}
function rememberPort(dataDir, port, log = () => {}) {
  const file = path.join(dataDir, 'local-server.json');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ port })); fs.renameSync(temp, file);
  } catch (error) { log('Không lưu được cổng ứng dụng: ' + error.message); }
}
async function startLocalServer(server, options = {}) {
  const log = options.log || (() => {});
  // Tests intentionally use independent ephemeral ports, never the user's saved port.
  if (options.testMode) return { reused: false, port: await bind(server, 0) };
  if (options.reuseExisting && await options.reuseExisting()) return { reused: true };
  const lease = options.lockPort ? await startupLease(options.dataDir, options.reuseExisting) : { release() {} };
  if (lease.reused) return { reused: true };
  try {
  if (options.reuseExisting && await options.reuseExisting()) return { reused: true };
  const file = path.join(options.dataDir, 'local-server.json');
  const preferred = readPort(file) || (validPort(options.previousPort) ? options.previousPort : 0);
  if (options.lockPort && fs.existsSync(file) && !preferred) throw Object.assign(Error('Cấu hình cổng đã lưu không hợp lệ. Không tự đổi cổng; cần kiểm tra local-server.json.'), { code: 'APP_PORT_CONFIG_INVALID' });
  let port;
  try { port = await bind(server, preferred); }
  catch (error) {
    if (!preferred || !['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    if (options.lockPort) {
      if (options.reuseExisting && await options.reuseExisting()) return { reused: true };
      throw Object.assign(Error(`Cổng CNTaxTools ${preferred} đã khóa nhưng không thể mở (${error.code}). Không tạo cổng khác và không dừng tiến trình đang dùng cổng. Kiểm tra ứng dụng đang chạy hoặc phần mềm chiếm cổng.`), { code: 'APP_PORT_LOCKED', cause: error });
    }
    log(`Cổng đã lưu ${preferred} không dùng được (${error.code}); chọn cổng khác, không dừng tiến trình đang chiếm cổng.`);
    port = await bind(server, 0);
  }
  if (options.persistOnBind !== false) rememberPort(options.dataDir, port, log);
  if (options.onBound) await options.onBound(port);
  return { reused: false, port };
  } finally { lease.release(); }
}
module.exports = { startLocalServer, validPort, readPort, rememberPort };
