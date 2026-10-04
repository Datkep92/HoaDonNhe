'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { validate } = require('./fs-tools');

// ── limits ─────────────────────────────────────────────────────────────
const MAX_QUERY_ROWS        = 500;      // max rows a query may return
const MAX_SERIALIZED_BYTES  = 64_000;   // max JSON size of a tool result payload
const QUERY_TIMEOUT_MS      = 10_000;   // soft timeout (may be extended by row cap)
const MAX_SCHEMA_TABLES     = 200;
const MAX_SAMPLE_ROWS       = 50;
const DEFAULT_SAMPLE_ROWS   = 5;

// ── errors ─────────────────────────────────────────────────────────────
function err(msg, code) { return Object.assign(new Error(msg), { code }); }

// ── SQLite format detection (must NOT rely on extension) ───────────────
const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
function detectFormat(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    if (n >= 16 && head.subarray(0, 16).equals(SQLITE_MAGIC)) return 'sqlite';
    return null;
  } finally { fs.closeSync(fd); }
}

// ── SQL read-only validator (defense in depth, layer 1) ────────────────
// Blocks statements that could mutate DB / file / runtime even before the
// read-only connection is opened. Never relies solely on startsWith().
const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|VACUUM|ATTACH|DETACH|REINDEX|ANALYZE|PRAGMA|TRUNCATE|MERGE|UPSERT|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const BLOCKED_WORDS = /\b(load_extension|writefile|readfile|eval|edit)\b/i;

function validateReadOnlySql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw err('SQL trống hoặc không hợp lệ.', 'INVALID_SQL');
  const trimmed = sql.trim();
  // Strip leading line/block comments to inspect the true first keyword.
  let probe = strippedComments(trimmed);
  // Multiple statements: detect any semicolon that is not the last token.
  if (hasMultipleStatements(sql)) throw err('Chỉ cho phép một câu lệnh SQL duy nhất.', 'MULTIPLE_STATEMENTS_BLOCKED');
  if (WRITE_KEYWORDS.test(probe)) throw err('Chỉ cho phép truy vấn READ-ONLY (SELECT/WITH).', 'WRITE_QUERY_BLOCKED');
  if (BLOCKED_WORDS.test(sql)) throw err('Hàm/đối tượng không được phép trong truy vấn.', 'WRITE_QUERY_BLOCKED');
  // Must begin with SELECT or WITH (after comment stripping + CTE prefix).
  if (!/^(SELECT|WITH)\b/i.test(probe)) throw err('Chỉ cho phép truy vấn SELECT/WITH.', 'WRITE_QUERY_BLOCKED');
  return probe;
}

function strippedComments(sql) {
  // Remove /* ... */ and -- ... line comments for keyword inspection,
  // while keeping the original for the actual statement check.
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return s;
}

function hasMultipleStatements(sql) {
  // A semicolon counts as a separator only when followed by more non-whitespace
  // non-comment content. A single trailing semicolon is allowed.
  let depth = 0, inSingle = false, inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inSingle) { if (c === "'" && sql[i-1] !== '\\') inSingle = false; continue; }
    if (inDouble) { if (c === '"' && sql[i-1] !== '\\') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      const rest = strippedComments(sql.slice(i + 1)).trim();
      if (rest) return true;
      return false; // trailing semicolon only — single statement
    }
  }
  return false;
}

// ── open a SQLite connection READ-ONLY (defense in depth, layer 2) ─────
function openReadOnly(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    const msg = String(e.message || e);
    if (/file is not a database|not a database|malformed/i.test(msg)) throw err('Cơ sở dữ liệu hỏng hoặc không phải SQLite.', 'DB_CORRUPT');
    if (/unable to open|no such/i.test(msg)) throw err('Không mở được cơ sở dữ liệu.', 'DB_OPEN_FAILED');
    throw err('Không mở được cơ sở dữ liệu.', 'DB_OPEN_FAILED');
  }
  try { db.enableDefensive(true); } catch {}
  return db;
}

function safeIdentifier(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw err('Tên bảng/identifier không hợp lệ.', 'INVALID_SQL');
  return '"' + name.replace(/"/g, '""') + '"';
}

function tableExists(db, table) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").all(table);
  return rows.length > 0;
}

// Serialize rows into a bounded object (drop very large cells + mark truncation).
function boundResult(rows, rowCount) {
  const truncated = rows.length < rowCount;
  let serialized;
  try { serialized = JSON.stringify(rows); } catch { serialized = JSON.stringify({ error: 'unserializable' }); }
  const tooLarge = Buffer.byteLength(serialized) > MAX_SERIALIZED_BYTES;
  if (tooLarge) {
    // Truncate by shrinking cell content instead of dropping the whole result.
    const limited = rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (typeof v === 'string' && v.length > 500) return [k, v.slice(0, 500) + '…'];
      return [k, v];
    })));
    return { rows: limited, truncated: true, rowsReturned: limited.length, truncatedBySize: true };
  }
  return { rows, truncated, rowsReturned: rows.length, truncatedBySize: false };
}

// ── tool handlers ──────────────────────────────────────────────────────

function detect(file) {
  const resolved = validate(file);
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw err('Đường dẫn không phải là file.', 'NOT_A_FILE');
  const format = detectFormat(resolved);
  if (format !== 'sqlite') throw err('Không nhận diện được định dạng database (chỉ hỗ trợ SQLite).', 'UNSUPPORTED_DATABASE');
  return {
    path: resolved, databaseType: 'sqlite', readOnly: true, size: st.size, modified: st.mtime.toISOString(),
  };
}

function listTables(file) {
  const resolved = validate(file);
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const db = openReadOnly(resolved);
  try {
    const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY (type='table') DESC, name").all();
    const tables = rows.slice(0, MAX_SCHEMA_TABLES).map(r => {
      let count = null;
      if (r.type === 'table' && !/^sqlite_/.test(r.name)) {
        try { count = db.prepare('SELECT COUNT(*) AS c FROM ' + safeIdentifier(r.name)).get().c; } catch {}
      }
      return { name: r.name, type: r.type, rowCount: count };
    });
    return { path: resolved, tables, total: tables.length, truncated: rows.length > MAX_SCHEMA_TABLES };
  } finally { db.close(); }
}

function schema(file, table) {
  const resolved = validate(file);
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const db = openReadOnly(resolved);
  try {
    if (table) {
      if (!tableExists(db, table)) throw err('Không tìm thấy bảng/view.', 'TABLE_NOT_FOUND');
      return { database: resolved, table, ...tableSchema(db, table) };
    }
    // Whole DB schema (bounded)
    const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all();
    const tables = rows.slice(0, MAX_SCHEMA_TABLES).map(r => ({ name: r.name, type: r.type, ...tableSchema(db, r.name) }));
    return { database: resolved, tables, total: tables.length, truncated: rows.length > MAX_SCHEMA_TABLES };
  } finally { db.close(); }
}

function tableSchema(db, table) {
  const id = safeIdentifier(table);
  let columns = [];
  try { columns = db.prepare('PRAGMA table_info(' + id + ')').all(); } catch {}
  const cols = columns.map(c => ({
    name: c.name, type: c.type, notNull: !!c.notnull, primaryKey: !!c.pk, defaultValue: c.dflt_value,
  }));
  let foreignKeys = [];
  try { foreignKeys = db.prepare('PRAGMA foreign_key_list(' + id + ')').all(); } catch {}
  const fks = foreignKeys.map(f => ({ from: f.from, table: f.table, to: f.to }));
  // SQL used to create the object (for indexes/PK hints) — first 4000 chars.
  const createRows = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").all(table);
  const createSql = createRows[0]?.sql ? String(createRows[0].sql).slice(0, 4000) : undefined;
  return { columns: cols, foreignKeys: fks, createSql };
}

function sample(file, table, limit = DEFAULT_SAMPLE_ROWS) {
  const resolved = validate(file);
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const lim = Math.min(Math.max(1, Math.floor(limit || DEFAULT_SAMPLE_ROWS)), MAX_SAMPLE_ROWS);
  const db = openReadOnly(resolved);
  try {
    if (!tableExists(db, table)) throw err('Không tìm thấy bảng/view.', 'TABLE_NOT_FOUND');
    const rows = db.prepare('SELECT * FROM ' + safeIdentifier(table) + ' LIMIT ' + lim).all();
    const b = boundResult(rows, rows.length);
    return { path: resolved, table, rows: b.rows, rowsReturned: b.rowsReturned, truncated: b.truncated };
  } finally { db.close(); }
}

function queryReadonly(file, sql, params = []) {
  const resolved = validate(file);
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const query = validateReadOnlySql(sql);
  const bind = Array.isArray(params) ? params : [];
  const db = openReadOnly(resolved);
  const started = Date.now();
  try {
    // Cap fetching at rows+1 to detect truncation without materializing unbounded data.
    const stmt = db.prepare(query);
    const rows = stmt.all(...bind.slice(0, 64));
    if (Date.now() - started > QUERY_TIMEOUT_MS && rows.length === 0) throw err('Truy vấn quá thời gian xử lý.', 'QUERY_TIMEOUT');
    const trimmed = rows.slice(0, MAX_QUERY_ROWS);
    const b = boundResult(trimmed, rows.length);
    return { path: resolved, sql: query, columns: rows[0] ? Object.keys(rows[0]) : [], rows: b.rows, rowsReturned: b.rowsReturned, totalRows: rows.length, truncated: b.truncated || rows.length > MAX_QUERY_ROWS, truncatedBySize: b.truncatedBySize };
  } catch (e) {
    if (e && e.code) throw e; // rethrow our own coded errors
    const msg = String(e.message || e);
    if (/no such table/i.test(msg)) throw err('Bảng không tồn tại trong truy vấn.', 'TABLE_NOT_FOUND');
    if (/no such column/i.test(msg)) throw err('Cột không tồn tại trong truy vấn.', 'INVALID_SQL');
    if (/attempt to write a readonly database/i.test(msg)) throw err('Chỉ cho phép READ-ONLY.', 'WRITE_QUERY_BLOCKED');
    if (/syntax error|near "/i.test(msg)) throw err('Cú pháp SQL không hợp lệ.', 'INVALID_SQL');
    throw err('Lỗi truy vấn: ' + msg.slice(0, 200), 'INVALID_SQL');
  } finally { db.close(); }
}

module.exports = { detect, listTables, schema, sample, queryReadonly, validateReadOnlySql, hasMultipleStatements,
  MAX_QUERY_ROWS, MAX_SERIALIZED_BYTES, MAX_SAMPLE_ROWS, DEFAULT_SAMPLE_ROWS };