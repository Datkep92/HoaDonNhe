'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { Engine, validateParams } = require('./core');

function validateManualParams(input) {
  if (input?.direction !== 'both') return validateParams(input);
  return { ...validateParams({ ...input, direction: 'purchase' }), direction: 'both' };
}

// A combined manual job owns two ordinary engines. Portal URLs, file formats,
// retries and invoice rendering stay in Engine; only sequencing is added here.
class ManualDownloadEngine extends Engine {
  constructor(options) {
    super(options);
    this.childOptions = options;
    this.children = new Map();
    if (this.job?.combined) this.restoreChildren();
  }
  child(direction) {
    if (!this.children.has(direction)) {
      const child = new Engine({
        ...this.childOptions,
        identity: async () => {
          const account = await this.childOptions.identity();
          if (!account || account.key !== this.job.account.key) throw Object.assign(new Error('Cần đăng nhập đúng tài khoản của lượt tải.'), { auth: true });
          return account;
        },
        store: `${this.store}.both-${this.job.id}.${direction}.json`,
        emit: () => this.syncChildren(),
      });
      child.mst = this.mst;
      this.children.set(direction, child);
    }
    return this.children.get(direction);
  }
  restoreChildren() {
    for (const direction of ['purchase', 'sold']) this.child(direction);
    this.syncChildren(false);
  }
  syncChildren(save = true) {
    if (!this.job?.combined) return;
    const j = this.job;
    j.items = [...this.children.values()].flatMap(child => child.job?.items || []);
    j.stats = { total: j.items.length, existed: 0, queued: 0, downloaded: 0, skipped: 0, failed: 0 };
    j.directions = ['purchase', 'sold'].map(direction => {
      const child = this.children.get(direction);
      const shot = child?.snapshot();
      for (const key of ['existed', 'queued', 'downloaded', 'skipped', 'failed']) j.stats[key] += Number(shot?.stats?.[key]) || 0;
      return { direction, state: shot?.state || 'pending', total: shot?.total || 0, done: shot?.done || 0, failed: shot?.failed || 0, message: shot?.message || '' };
    });
    const active = this.children.get(j.activeDirection);
    if (this.busy && !this.cancelled && active?.busy) {
      j.state = active.job?.state || 'searching';
      j.phase = active.job?.phase || 'search';
      j.message = `${j.activeDirection === 'purchase' ? 'Mua vào' : 'Bán ra'}: ${active.job?.message || 'Đang chạy…'}`;
    }
    if (save) this.save();
  }
  snapshot() {
    const shot = super.snapshot();
    if (this.job?.combined) shot.directions = this.job.directions || [];
    return shot;
  }
  flush() {
    for (const child of this.children?.values() || []) child.flush();
    super.flush();
  }
  pause() {
    super.pause();
    for (const child of this.children.values()) if (child.busy) child.pause();
  }
  async startCombined(input, output, mode, hooks = {}) {
    const params = validateManualParams(input);
    const account = await this.identity();
    if (!account) throw Object.assign(new Error('Hãy đăng nhập cổng thuế trước.'), { auth: true });
    if (!output || !path.isAbsolute(output)) throw new Error('Chọn thư mục lưu hóa đơn.');
    if (hooks.authorizeStart) await hooks.authorizeStart();
    hooks.validateStart?.();
    return this.run(async () => {
      this.children.clear();
      this.job = { version: 1, combined: true, id: crypto.randomUUID(), account, output, params,
        mode, phase: 'search', state: 'searching', items: [], directions: [], message: 'Đang tải mua vào rồi bán ra…' };
      this.save(); hooks.onStarted?.({ jobId: this.job.id });
      await this.executeCombined();
    });
  }
  async executeCombined() {
    const j = this.job;
    await this.checkAccount();
    let partial = false;
    for (const direction of ['purchase', 'sold']) {
      this.check();
      await this.checkAccount();
      j.activeDirection = direction;
      const child = this.child(direction);
      if (child.job?.state === 'completed' || (j.mode === 'search' && child.job?.state === 'ready')) continue;
      if (child.job) await child.resume(j.mode === 'stream');
      else {
        const params = { ...j.params, direction };
        if (j.mode === 'stream') await child.stream(params, j.output);
        else await child.search(params, j.output);
      }
      this.syncChildren(); this.check();
      if (child.job?.state === 'auth_required') throw Object.assign(new Error(child.job.message), { auth: true });
      if (child.job?.state === 'paused') throw Object.assign(new Error(child.job.message), { paused: true });
      // Rate limiting affects the whole portal session, so do not start the next
      // direction when the engine has reduced its concurrency to back off.
      if (child.job?.items?.some(item => item.errorType === 'rate_limited')) throw Object.assign(new Error('Cổng thuế giới hạn yêu cầu. Có thể tải tiếp sau.'), { paused: true });
      if (!['completed', 'ready'].includes(child.job?.state)) partial = true;
    }
    j.activeDirection = ''; this.syncChildren(false);
    j.phase = 'download';
    j.state = partial ? 'partial' : j.mode === 'search' ? 'ready' : 'completed';
    j.message = `${partial ? 'Còn hóa đơn hoặc khoảng tra cứu chưa hoàn tất' : 'Hoàn tất hai chiều'}: mua vào ${j.directions[0].done}/${j.directions[0].total}, bán ra ${j.directions[1].done}/${j.directions[1].total}.`;
    this.save();
  }
  search(params, output) {
    return params?.direction === 'both' ? this.startCombined(params, output, 'search') : super.search(params, output);
  }
  stream(params, output, hooks) {
    return params?.direction === 'both' ? this.startCombined(params, output, 'stream', hooks) : super.stream(params, output, hooks);
  }
  resume(download = false) {
    if (!this.job?.combined) return super.resume(download);
    return this.run(async () => {
      if (download) this.job.mode = 'stream';
      this.restoreChildren();
      await this.executeCombined();
    });
  }
  retryFailed() { return this.job?.combined ? this.resume(true) : super.retryFailed(); }
  async exportList() {
    if (!this.job?.combined) return super.exportList();
    if (!this.job.items.length) throw new Error('Lượt tra cứu này không có hóa đơn nào để xuất Excel.');
    this.restoreChildren();
    const results = [];
    for (const child of this.children.values()) if (child.job?.items.length) results.push(await child.exportList());
    return { file: results[0].file, files: results.map(result => result.file), rows: results.reduce((sum, result) => sum + result.rows, 0), columns: results[0].columns };
  }
}

module.exports = { ManualDownloadEngine, validateManualParams };
