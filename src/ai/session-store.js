'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { redact } = require('./data-minimizer');
function createSessionStore(dataDir) {
  const directory = path.join(dataDir, 'agent'); fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'agent.db');
  const db = new DatabaseSync(filename);
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw new Error('Metadata AI mới hơn phiên bản ứng dụng; giữ nguyên dữ liệu và cập nhật app.');
    if (!version) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.length) { db.close(); throw new Error('Metadata AI chưa có phiên bản xác định; không tự sửa dữ liệu.'); }
      db.exec(`BEGIN;
        CREATE TABLE sessions(id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, company_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', refs TEXT NOT NULL DEFAULT '{}', UNIQUE(provider_id,company_id));
        CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
        CREATE INDEX message_session_time ON messages(session_id,created_at);
        CREATE TABLE jobs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, company_id TEXT NOT NULL, status TEXT NOT NULL, current_step TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      const legacy = path.join(dataDir, 'ai-history.json');
      if (fs.existsSync(legacy)) { const backup = path.join(directory, 'legacy-history.unscoped.json'); if (!fs.existsSync(backup)) fs.copyFileSync(legacy, backup, fs.constants.COPYFILE_EXCL); }
    }
    if (db.prepare('PRAGMA user_version').get().user_version === 1) {
      const backup = path.join(directory, 'agent-v1-' + randomUUID() + '.db');
      db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
      try {
        db.exec(`BEGIN;
          CREATE TABLE memories(id TEXT PRIMARY KEY, company_id TEXT NOT NULL, kind TEXT NOT NULL, memory_key TEXT NOT NULL, content TEXT NOT NULL, confirmed INTEGER NOT NULL, confidence REAL NOT NULL, supersedes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
          CREATE INDEX memory_scope ON memories(company_id,active,memory_key);
          CREATE VIRTUAL TABLE message_search USING fts5(content,content='messages',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2');
          INSERT INTO message_search(message_search) VALUES('rebuild');
          CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO message_search(rowid,content) VALUES(new.rowid,new.content); END;
          CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN INSERT INTO message_search(message_search,rowid,content) VALUES('delete',old.rowid,old.content); END;
          PRAGMA user_version=2; COMMIT;`);
      } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    }
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; UPDATE jobs SET status='interrupted' WHERE status IN ('queued','running','waiting_approval')");
  } catch (error) { try { db.close(); } catch {} throw error; }
  function company(id) { if (typeof id !== 'string' || (id !== 'GLOBAL' && !require('../mst-format').isValidMst(id))) throw new Error('Thiếu phạm vi công ty hợp lệ.'); return id; }
  function resolve(providerId, companyId) {
    company(companyId);
    let session = db.prepare('SELECT * FROM sessions WHERE provider_id=? AND company_id=?').get(providerId, companyId);
    if (!session) { const date = new Date().toISOString(), id = randomUUID(); db.prepare('INSERT INTO sessions(id,provider_id,company_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, providerId, companyId, date, date); session = db.prepare('SELECT * FROM sessions WHERE id=?').get(id); }
    return { id: session.id, providerId: session.provider_id, companyId: session.company_id, summary: session.summary, refs: JSON.parse(session.refs) };
  }
  function history(session, limit = 40) {
    checked(session);
    const rows = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT ?').all(session.id, Math.min(200, Math.max(1, limit))).reverse();
    return rows.map(row => ({ role: row.role, content: row.content, files: JSON.parse(row.files), attachments: JSON.parse(row.attachments), companyId: session.companyId, createdAt: row.created_at }));
  }
  function append(session, row) {
    checked(session);
    const date = new Date().toISOString();
    db.prepare('INSERT INTO messages(id,session_id,role,content,attachments,files,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), session.id, row.role, row.content, JSON.stringify(row.attachments || []), JSON.stringify(row.files || []), date);
    db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(date, session.id);
    const refs = references(session);
    if (row.attachments?.length) refs.last_reference_file = { kind: 'attachment', ...row.attachments.at(-1), companyId: session.companyId };
    if (row.files?.length) refs.last_created_file = { kind: 'artifact', ...row.files.at(-1), companyId: session.companyId, verified: true };
    db.prepare('UPDATE sessions SET refs=? WHERE id=?').run(JSON.stringify(redact(refs)), session.id);
  }
  function checked(session) {
    const actual = db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id);
    if (!actual || actual.company_id !== session.companyId || actual.provider_id !== session.providerId) throw new Error('Session không thuộc phạm vi hiện tại.');
    return actual;
  }
  function references(session) { const row = checked(session); return { ...JSON.parse(row.refs), current_company: { kind: 'company', companyId: row.company_id } }; }
  function searchHistory(session, query, limit = 5) {
    checked(session);
    const tokens = [...new Set(String(query || '').match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 20);
    if (!tokens.length) return [];
    const expression = tokens.map(token => '"' + token + '"').join(' OR ');
    return db.prepare('SELECT m.role,m.content,m.created_at AS createdAt FROM message_search s JOIN messages m ON m.rowid=s.rowid WHERE message_search MATCH ? AND m.session_id=? ORDER BY rank LIMIT ?').all(expression, session.id, Math.min(10, Math.max(1, limit))).map(row => ({ ...row, content: redact(row.content).slice(0, 2000), companyId: session.companyId }));
  }
  function compact(session, recent = 12) {
    checked(session);
    const older = db.prepare('SELECT role,content,files FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT 40 OFFSET ?').all(session.id, recent).reverse();
    const summary = older.map(row => (row.role === 'user' ? 'Yêu cầu cũ: ' : 'Phản hồi cũ (không xác minh hiện tại): ') + redact(row.content).slice(0, 160) + (JSON.parse(row.files).length ? ' [có file: ' + JSON.parse(row.files).map(f => f.filename).join(', ').slice(0, 180) + ']' : '')).join('\n').slice(-8000);
    db.prepare('UPDATE sessions SET summary=? WHERE id=?').run(summary, session.id);
    return summary;
  }
  function remember(session, { key, content, global = false }) {
    checked(session);
    if (typeof key !== 'string' || typeof content !== 'string' || !key.trim() || !content.trim() || key.length > 80 || content.length > 2000) throw new Error('Quy tắc cần tên và nội dung trong giới hạn.');
    if (redact(key) !== key || redact(content) !== content || /password|api.?key|license.?key|token|secret|mật khẩu/i.test(key + ' ' + content)) throw new Error('Không lưu thông tin bí mật trong memory.');
    const companyId = global ? 'GLOBAL' : session.companyId, memoryKey = require('./context-manager').normalize(key.trim());
    const previous = db.prepare('SELECT id FROM memories WHERE company_id=? AND memory_key=? AND active=1').get(companyId, memoryKey);
    const id = randomUUID();
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE memories SET active=0 WHERE company_id=? AND memory_key=?').run(companyId, memoryKey);
      db.prepare('INSERT INTO memories(id,company_id,kind,memory_key,content,confirmed,confidence,supersedes,created_at) VALUES(?,?,?,?,?,1,1,?,?)').run(id, companyId, global ? 'user' : 'correction', memoryKey, content, previous?.id || null, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { id, key: memoryKey, companyId, supersedes: previous?.id || null, confirmed: true };
  }
  function memories(session, query, limit = 8) {
    checked(session);
    const terms = require('./context-manager').normalize(query).split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 2);
    return db.prepare("SELECT id,company_id AS companyId,kind,memory_key AS key,content,confidence,confirmed,supersedes,created_at AS createdAt FROM memories WHERE active=1 AND (company_id=? OR (company_id='GLOBAL' AND kind='user')) ORDER BY rowid DESC LIMIT 200").all(session.companyId).map(row => ({ ...row, score: terms.filter(t => require('./context-manager').normalize(row.key + ' ' + row.content).includes(t)).length + (row.companyId === session.companyId ? 1 : 0) })).sort((a, b) => b.score - a.score).slice(0, Math.min(10, Math.max(1, limit)));
  }
  function startJob(session) {
    const id = randomUUID(), date = new Date().toISOString();
    db.prepare('INSERT INTO jobs(id,session_id,company_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, session.id, session.companyId, 'running', date, date); return id;
  }
  return { resolve, history, append, startJob, references, compact, searchHistory, remember, memories,
    clear(session) { checked(session); db.prepare('DELETE FROM messages WHERE session_id=?').run(session.id); db.prepare("UPDATE sessions SET summary='',refs='{}' WHERE id=?").run(session.id); },
    updateJob(id, status, step = '') { db.prepare('UPDATE jobs SET status=?,current_step=?,updated_at=? WHERE id=?').run(status, String(step).slice(0, 150), new Date().toISOString(), id); },
    getJob(id) { return db.prepare('SELECT * FROM jobs WHERE id=?').get(id); },
    close() { db.close(); },
  };
}
module.exports = { createSessionStore };
