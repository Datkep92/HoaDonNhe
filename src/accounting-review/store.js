'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const reviewHash = issues => crypto.createHash('sha256').update(JSON.stringify(issues.map(issue => [issue.id, issue.fingerprint, issue.state, issue.note, issue.assignee]))).digest('hex');
const DEFAULTS = Object.freeze({ buyComplete: false, sellComplete: false, requirePdf: false, requireBank: false, requireVat: true, selectedDeclaration: '', actor: '', acceptanceNote: '', acceptedDeclaration: '', adjustments: { ct23: 0, ct24: 0, ct34: 0, ct35: 0 }, adjustmentNote: '' });
function open(dir, create = true) {
  const file = path.join(dir, 'Kiem_tra', 'ho_so.db');
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const realRoot = fs.realpathSync(dir), realFolder = fs.realpathSync(path.dirname(file));
  const relative = path.relative(realRoot, realFolder);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Kho kiểm tra liên kết ra ngoài thư mục MST.');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Kho kiểm tra không được là liên kết tệp.');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(period TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(period TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issues(period TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', assignee TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(period,id));
    CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY, period TEXT NOT NULL, issue TEXT, action TEXT NOT NULL,
      actor TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, period TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS closures(id INTEGER PRIMARY KEY, period TEXT NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL);`);
  return db;
}
function settings(db, key) { return { ...DEFAULTS, ...JSON.parse(db?.prepare('SELECT value FROM settings WHERE period=?').get(key)?.value || '{}') }; }
function event(db, key, issue, action, actor, details) {
  db.prepare('INSERT INTO history(period,issue,action,actor,details,created_at) VALUES(?,?,?,?,?,?)').run(key, issue || '', action, actor || '', JSON.stringify(details), new Date().toISOString());
}
function transaction(db, fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } }
function saveRun(db, key, snapshot, actor) {
  return transaction(db, () => {
    const previous = new Map(db.prepare('SELECT * FROM issues WHERE period=?').all(key).map(issue => [issue.id, issue]));
    db.prepare('UPDATE issues SET active=0 WHERE period=?').run(key);
    for (const issue of snapshot.issues) {
      const old = previous.get(issue.id);
      let state = old?.state || 'todo';
      if (old && (old.fingerprint !== issue.fingerprint || !old.active)) { state = 'todo'; event(db, key, issue.id, 'evidence_changed', actor, { previous: old.state }); }
      db.prepare(`INSERT INTO issues(period,id,fingerprint,state,note,assignee,payload,active,updated_at) VALUES(?,?,?,?,?,?,?,1,?)
        ON CONFLICT(period,id) DO UPDATE SET fingerprint=excluded.fingerprint,state=excluded.state,payload=excluded.payload,active=1,updated_at=excluded.updated_at`)
        .run(key, issue.id, issue.fingerprint, state, old?.note || '', old?.assignee || '', JSON.stringify(issue), snapshot.checkedAt);
    }
    const present = new Set(snapshot.issues.map(issue => issue.id));
    for (const old of previous.values()) if (old.active && !present.has(old.id)) event(db, key, old.id, 'source_resolved', actor, { previous: old.state, reason: 'Vấn đề không còn xuất hiện trong chứng cứ/phạm vi hiện tại; giữ lịch sử và ghi chú.' });
    delete snapshot.issues;
    db.prepare('INSERT OR REPLACE INTO runs(period,snapshot) VALUES(?,?)').run(key, JSON.stringify(snapshot));
    event(db, key, '', 'checked', actor, { fingerprint: snapshot.fingerprint });
  });
}
function readRun(db, key) {
  const snapshot = JSON.parse(db?.prepare('SELECT snapshot FROM runs WHERE period=?').get(key)?.snapshot || 'null');
  if (!snapshot) return null;
  snapshot.issues = db.prepare('SELECT * FROM issues WHERE period=? AND active=1 ORDER BY id').all(key).map(row => ({ ...JSON.parse(row.payload), state: row.state, note: row.note, assignee: row.assignee, updatedAt: row.updated_at }));
  snapshot.history = db.prepare('SELECT * FROM history WHERE period=? ORDER BY id DESC LIMIT 100').all(key);
  const closure = db.prepare('SELECT id,actor,created_at,snapshot FROM closures WHERE period=? ORDER BY id DESC LIMIT 1').get(key);
  if (closure) {
    const closed = JSON.parse(closure.snapshot);
    snapshot.lastClosed = { id: closure.id, actor: closure.actor, created_at: closure.created_at, current: closed.fingerprint === snapshot.fingerprint && reviewHash(closed.issues) === reviewHash(snapshot.issues) };
  } else snapshot.lastClosed = null;
  return snapshot;
}
module.exports = { DEFAULTS, open, settings, event, transaction, saveRun, readRun };
