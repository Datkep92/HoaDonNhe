'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ensureMst, mstDirectory } = require('./mst-manager');
const { closeDatabase } = require('./sqlite');
const { scanXmlFolder } = require('./xml-scanner');
const MST_FORMAT = require('../mst-format');

function createXmlWatcher({ onChange = () => {}, onStatus = () => {}, shouldPause = () => false, identifiersFor = mst => [mst], debounceMs = 700 } = {}) {
  let root = '';
  let watcher = null;
  let allowed = new Set();
  const timers = new Map();
  const running = new Map();
  const pending = new Set();
  const states = new Map();

  const stateFor = mst => states.get(mst) || { mst, running: false, revision: 0, imported: 0, updated: 0, errors: 0, lastScan: null, error: '' };
  const publish = (mst, patch) => {
    const state = { ...stateFor(mst), ...patch };
    states.set(mst, state);
    onStatus(state);
    return state;
  };

  async function scan(mst) {
    if (!root || !allowed.has(mst)) return;
    if (shouldPause(mst)) { schedule(mst); return; }
    if (running.get(mst)) { pending.add(mst); return; }
    running.set(mst, true);
    publish(mst, { running: true, error: '' });
    let db;
    try {
      const area = ensureMst({ output: root, mst });
      db = area.db;
      const result = await scanXmlFolder({ db, mst, identifiers: identifiersFor(mst), mstDir: area.dir });
      const changed = (result.imported || 0) + (result.updated || 0);
      const previous = stateFor(mst);
      const next = publish(mst, {
        running: false,
        revision: previous.revision + (changed ? 1 : 0),
        imported: result.imported || 0,
        updated: result.updated || 0,
        errors: result.errors || 0,
        lastScan: new Date().toISOString(),
      });
      if (changed) onChange({ mst, revision: next.revision, ...result });
    } catch (error) {
      publish(mst, { running: false, error: error && error.message ? error.message : String(error), lastScan: new Date().toISOString() });
    } finally {
      if (db) closeDatabase(db);
      running.delete(mst);
      if (pending.delete(mst)) schedule(mst);
    }
  }

  function schedule(mst) {
    if (!allowed.has(mst)) return;
    clearTimeout(timers.get(mst));
    const timer = setTimeout(() => { timers.delete(mst); scan(mst); }, debounceMs);
    timer.unref?.();
    timers.set(mst, timer);
  }

  function mstFromFilename(filename) {
    const relative = String(filename || '').replace(/\\/g, '/');
    if (!relative.toLowerCase().endsWith('.xml')) return '';
    const match = relative.match(/(?:^|\/)MST-(\d{6,20}(?:-\d{1,6})?)(?:\/|$)/i);
    return match ? match[1] : '';
  }

  function configure(output, msts = []) {
    const nextRoot = path.resolve(String(output || '.'));
    const previousAllowed = allowed;
    allowed = new Set(msts.map(String).filter(mst => MST_FORMAT.isValidMst(mst)));
    if (!output || !fs.existsSync(nextRoot)) { stop(); root = ''; return; }
    if (watcher && root === nextRoot) {
      for (const mst of allowed) if (!previousAllowed.has(mst)) schedule(mst);
      return;
    }
    stop();
    root = nextRoot;
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      const mst = mstFromFilename(filename);
      if (mst) schedule(mst);
    });
    watcher.on('error', error => onStatus({ mst: '', running: false, error: error.message }));
    for (const mst of allowed) {
      try { if (fs.existsSync(mstDirectory(root, mst))) schedule(mst); } catch { /* cấu hình chưa đủ */ }
    }
  }

  function status(mst) { return { ...stateFor(String(mst || '')) }; }
  function stop() {
    if (watcher) watcher.close();
    watcher = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    pending.clear();
  }

  return { configure, scan, schedule, status, stop, mstFromFilename };
}

module.exports = { createXmlWatcher };
