'use strict';
// Opt-in orchestration of the existing portal controller, with its existing job lock.
const { TokhaiController } = require('../tokhai');
const jobs = new Map();
function jobFor(mst) { if (!jobs.has(mst)) jobs.set(mst, { running: false, progress: { stage: 'idle' } }); return jobs.get(mst); }
function start(context, input, deps) {
  const task = jobFor(context.mst), legacy = deps.downloadJob(context.mst);
  if (task.running || legacy.running) throw new Error('Đang có lượt tải tờ khai. Đợi hoàn tất hoặc bấm Ngưng.');
  const portal = input.portal === 'tdt' ? 'tdt' : 'dvc';
  const from = String(input.submittedFrom || ''), to = String(input.submittedTo || '');
  TokhaiController.splitRange(from, to);
  task.running = legacy.running = true;
  task.stop = false;
  task.progress = { stage: 'start', message: 'Kiểm tra phiên cổng thuế…' };
  const signature = [context.dir, portal, from, to].join('|');
  const publish = progress => { Object.assign(task.progress, progress); };
  const guard = () => {
    if (task.stop) throw new Error('Đã ngưng tải hồ sơ.');
    if (!deps.isCurrent(context)) {
      task.stop = true;
      if (task.controller) task.controller.shouldStop = true;
      throw new Error('MST/thư mục lưu đã thay đổi. Đã dừng tác vụ hồ sơ cũ.');
    }
  };
  task.promise = (async () => {
    try {
      await deps.ensureBrowser();
      guard();
      const session = await deps.session(context.mst, portal);
      if (!session.ok) throw new Error(session.error + ' Đăng nhập ở tab Tải tờ khai rồi chạy lại.');
      if (session.mst && !context.identifiers.includes(session.mst)) throw new Error('Phiên cổng thuế thuộc mã định danh khác.');
      const browser = new Proxy(deps.browser, { get(target, property) {
        const value = target[property];
        return typeof value === 'function' ? (...args) => { guard(); return value.apply(target, args); } : value;
      } });
      const ctl = new TokhaiController({ browser, mst: context.mst, log: deps.log, onProgress: publish });
      task.controller = legacy.controller = ctl;
      ctl.currentPortal = portal;
      ctl.sessionId = session.sessionId || legacy.sessionId || '';
      let captcha = '';
      if (portal === 'dvc') {
        if (input.captcha && task.captchaSignature === signature) captcha = String(input.captcha).trim();
        else {
          publish({ stage: 'captcha_loading', message: 'Lấy mã xác thực cho lượt tải hồ sơ…' });
          const image = await ctl.loadCaptcha('search');
          guard();
          captcha = image.solvedText || '';
          task.captchaSignature = signature;
          if (!captcha) { task.progress = { stage: 'captcha', message: 'Nhập mã xác thực để tiếp tục.', dataUrl: image.dataUrl, solverError: image.solverError || '' }; return; }
        }
      }
      task.captchaSignature = '';
      publish({ stage: 'search', message: `Tìm hồ sơ theo ngày nộp ${from} → ${to}…` });
      const rows = portal === 'tdt' ? await ctl.searchTdt(from, to) : await ctl.searchDvc(from, to, captcha);
      guard();
      legacy.results = rows;
      legacy.portal = portal;
      legacy.sessionId = ctl.sessionId;
      legacy.userMst = session.mst;
      ctl.results = rows;
      if (!rows.length) {
        legacy.progress = { stage: 'complete', files: [], succeeded: 0, failed: 0 };
        const snapshot = await deps.check(context, input);
        task.progress = { stage: 'complete', message: 'Không tìm thấy hồ sơ trong khoảng ngày nộp. Đã kiểm tra dữ liệu đang có; không coi là đã nộp đủ.', downloaded: 0, snapshot };
        return;
      }
      publish({ stage: 'download', total: rows.length, message: `Tải ${rows.length} hồ sơ và thông báo kèm theo…` });
      const result = await ctl.bulkDownload(rows.map(row => row.maHoSo), { outputDir: require('node:path').join(context.dir, 'To_khai') });
      legacy.progress = { ...result, stage: result.stopped ? 'stopped' : 'complete' };
      const registration = await deps.register(context, { ...legacy, running: false, results: [...legacy.results], progress: { ...legacy.progress, files: [...result.files] } });
      if (!deps.isCurrent(context)) {
        task.progress = { stage: 'stopped', message: 'MST/thư mục đã thay đổi. Đã giữ các tệp tải thành công.', downloaded: result.succeeded, failed: result.failed };
        return;
      }
      publish({ stage: 'checking', message: 'Đọc tờ khai và đối chiếu hóa đơn đã lưu…' });
      const snapshot = await deps.check(context, input);
      task.progress = { stage: result.stopped || task.stop ? 'stopped' : 'complete', message: `${result.stopped || task.stop ? 'Đã ngưng. ' : ''}Tải ${result.succeeded}/${result.total} hồ sơ; ${result.failed} lỗi. Đã kiểm tra dữ liệu đã tải.`, downloaded: result.succeeded, failed: result.failed, warnings: registration.warnings, files: result.files, snapshot };
    } catch (error) {
      task.progress = { ...task.progress, stage: task.stop ? 'stopped' : 'error', message: error.message, error: task.stop ? '' : error.message };
    } finally {
      task.running = legacy.running = false;
      task.controller = legacy.controller = null;
    }
  })();
  return { started: true };
}
function stop(mst) { const task = jobFor(mst); task.stop = true; if (task.controller) task.controller.shouldStop = true; return { stopped: true }; }
module.exports = { jobFor, start, stop };
