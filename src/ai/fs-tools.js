'use strict';
const fs = require('node:fs');
const path = require('node:path');

// ── limits ─────────────────────────────────────────────────────────────
const MAX_READ_BYTES       = 80_000;
const MAX_LIST_ENTRIES     = 200;
const MAX_SEARCH_RESULTS   = 50;
const MAX_SEARCH_DEPTH     = 4;
const SEARCH_TIMEOUT_MS    = 5_000;
const MAX_GLOB_RESULTS     = 100;
const MAX_GLOB_DEPTH       = 6;

// ── path denylist ──────────────────────────────────────────────────────
const DENY = [
  /^[A-Z]:\\Windows(\\|$)/i,
  /\\System32(\\|$)/i,
  /\\WinSxS(\\|$)/i,
  /\\AppData\\Local\\Temp\\dsh/i,
];

// ── helpers ────────────────────────────────────────────────────────────
function err(msg, code) { return Object.assign(new Error(msg), { code }); }

function normalize(input) {
  if (typeof input !== 'string' || !input.trim()) throw err('Đường dẫn không hợp lệ.', 'INVALID_PATH');
  const raw = input.trim();
  // Resolve relative to CWD so relative paths still work.
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(resolved)) throw err('Chỉ hỗ trợ đường dẫn tuyệt đối.', 'INVALID_PATH');
  if (resolved.startsWith('\\\\')) throw err('Không hỗ trợ đường dẫn mạng (UNC).', 'INVALID_PATH');
  const m = resolved.match(/^([A-Za-z]):/);
  if (!m) throw err('Đường dẫn phải có ký tự ổ đĩa.', 'INVALID_PATH');
  return m[0].toUpperCase() + resolved.slice(2);
}

function denied(absPath) {
  if (/(?:^|[\\/])(?:secrets|\.ssh|\.aws|\.gnupg)(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.[^\\/]*)?$|[\\/](?:auth|credentials|ai-providers)\.json$|[\\/]agent[\\/]opencode(?:[\\/]|$)/i.test(absPath)) return true;
  if (/[<>"|?*\x00-\x1f]/.test(absPath)) return true;
  for (const re of DENY) if (re.test(absPath)) return true;
  const ext = path.extname(absPath).toUpperCase();
  return ['.DLL','.EXE','.SYS','.DRV','.PDB','.BIN','.OBJ','.LIB','.OCX','.CPL','.SCR'].includes(ext);
}

function validate(absPath) {
  const p = normalize(absPath);
  if (denied(p)) throw err('Không được phép truy cập đường dẫn này.', 'ACCESS_DENIED');
  if (fs.existsSync(p) && denied(fs.realpathSync(p))) throw err('Đích đường dẫn không được phép truy cập.', 'ACCESS_DENIED');
  return p;
}

function isBinary(buf) { return buf.indexOf(0) !== -1; }

function statEntry(full) {
  const s = fs.statSync(full);
  return {
    name: path.basename(full), path: full,
    type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
    size:  s.isFile() ? s.size : undefined,
    modified: s.mtime.toISOString(),
  };
}

function textResult(file, buf, truncated) {
  if (isBinary(buf)) throw err('File có vẻ là binary, không đọc nội dung.', 'UNSUPPORTED_BINARY');
  const text = buf.toString('utf8');
  const r = { filename: path.basename(file), path: file, size: buf.length, text, totalBytes: buf.length };
  if (truncated) { r.truncated = true; r.hint = 'Dùng fs.read_range để đọc các đoạn còn lại.'; }
  return r;
}

// ── tool handlers ──────────────────────────────────────────────────────

function list(dir, signal) {
  const resolved = validate(dir);
  signal?.throwIfAborted?.();
  if (!fs.existsSync(resolved)) throw err('Thư mục không tồn tại.', 'NOT_FOUND');
  const st = fs.statSync(resolved);
  if (!st.isDirectory()) throw err('Đường dẫn không phải là thư mục.', 'NOT_A_DIRECTORY');
  const entries = [];
  const names = fs.readdirSync(resolved);
  for (let i = 0; i < names.length && entries.length < MAX_LIST_ENTRIES; i++) {
    try { entries.push(statEntry(path.join(resolved, names[i]))); } catch {}
  }
  return { directory: resolved, entries, count: entries.length, totalOnDisk: names.length, truncated: entries.length < names.length };
}

function read(file, signal) {
  const resolved = validate(file);
  signal?.throwIfAborted?.();
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw err('Đường dẫn không phải là file.', 'NOT_A_FILE');
  if (st.size > 256_000) throw err('File quá lớn để đọc toàn bộ. Dùng fs.read_range(path, offset, length).', 'TOO_LARGE');
  const buf = fs.readFileSync(resolved);
  return textResult(resolved, buf, st.size > MAX_READ_BYTES && buf.length === MAX_READ_BYTES);
}

function readRange(file, offset, length, signal) {
  const resolved = validate(file);
  signal?.throwIfAborted?.();
  if (!fs.existsSync(resolved)) throw err('File không tồn tại.', 'NOT_FOUND');
  const st = fs.statSync(resolved);
  if (!st.isFile()) throw err('Đường dẫn không phải là file.', 'NOT_A_FILE');
  const off = Math.max(0, Math.floor(offset || 0));
  const len = Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(length || MAX_READ_BYTES)));
  if (off >= st.size) throw err('Offset vượt quá kích thước file.', 'INVALID_PATH');
  const buf = Buffer.alloc(Math.min(len, st.size - off));
  const fd = fs.openSync(resolved, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, off); } finally { fs.closeSync(fd); }
  const r = textResult(resolved, buf, false);
  r.offset = off; r.length = buf.length; r.totalBytes = st.size;
  r.nextOffset = off + buf.length < st.size ? off + buf.length : null;
  return r;
}

function stat(file) {
  const resolved = validate(file);
  const exists = fs.existsSync(resolved);
  if (!exists) return { exists: false, path: resolved };
  const s = fs.statSync(resolved);
  return {
    exists: true, path: resolved,
    type:  s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other',
    size:  s.isFile() ? s.size : undefined,
    modified: s.mtime.toISOString(), created: s.birthtime.toISOString(),
  };
}

function exists(file) {
  const resolved = validate(file);
  const ok = fs.existsSync(resolved);
  if (!ok) return { exists: false, path: resolved };
  const s = fs.statSync(resolved);
  return { exists: true, path: resolved, type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other' };
}

function search(root, opts = {}, signal) {
  const query = String(opts.query || '').toLowerCase();
  if (!query) throw err('Thiếu từ khóa tìm kiếm.', 'INVALID_PATH');
  const resolved = validate(root);
  signal?.throwIfAborted?.();
  if (!fs.existsSync(resolved)) throw err('Thư mục không tồn tại.', 'NOT_FOUND');
  if (!fs.statSync(resolved).isDirectory()) throw err('Đường dẫn không phải là thư mục.', 'NOT_A_DIRECTORY');
  const maxResults = Math.min(opts.maxResults || MAX_SEARCH_RESULTS, 100);
  const maxDepth   = Math.min(opts.maxDepth   || MAX_SEARCH_DEPTH,   8);
  const results = [];
  const started = Date.now();
  function walk(dir, depth) {
    signal?.throwIfAborted?.();
    if (results.length >= maxResults || Date.now() - started > SEARCH_TIMEOUT_MS) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (results.length >= maxResults || Date.now() - started > SEARCH_TIMEOUT_MS) return;
      const full = path.join(dir, name);
      if (denied(full)) continue;
      try { if (fs.lstatSync(full).isSymbolicLink() || denied(fs.realpathSync(full))) continue; } catch { continue; }
      if (name.toLowerCase().includes(query)) {
        try { results.push(statEntry(full)); } catch {}
      }
      if (depth < maxDepth) {
        let s;
        try { s = fs.statSync(full); } catch { continue; }
        if (s.isDirectory()) walk(full, depth + 1);
      }
    }
  }
  walk(resolved, 0);
  return { root: resolved, query: opts.query, results, total: results.length, truncated: results.length >= maxResults };
}

function globPatternToRegExp(pattern) {
  // Translate glob to a regex matching a forward-slash relative path.
  let out = '';
  const n = pattern.length;
  for (let i = 0; i < n; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` followed by `/` or end → matches zero or more path segments
        if (pattern[i + 2] === '/' || pattern[i + 2] === '\\' || i + 2 >= n) {
          out += '(?:[^/]+/)*'; i++;
          if (pattern[i + 1] === '/' || pattern[i + 1] === '\\') i++;
          continue;
        }
        out += '.*'; i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '/' || c === '\\') {
      out += '/';
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$', 'i');
}

function glob(root, opts = {}, signal) {
  const pattern = String(opts.pattern || '*');
  if (pattern.length > 200 || /[<>"|]/.test(pattern)) throw err('Pattern không hợp lệ.', 'INVALID_PATH');
  const resolved = validate(root);
  signal?.throwIfAborted?.();
  if (!fs.existsSync(resolved)) throw err('Thư mục không tồn tại.', 'NOT_FOUND');
  if (!fs.statSync(resolved).isDirectory()) throw err('Đường dẫn không phải là thư mục.', 'NOT_A_DIRECTORY');
  const maxResults = Math.min(opts.maxResults || MAX_GLOB_RESULTS, 200);
  const maxDepth   = Math.min(opts.maxDepth   || MAX_GLOB_DEPTH,   10);
  const re = globPatternToRegExp(pattern);
  const matches = [];
  const rootPrefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  function walk(dir, depth, rel) {
    signal?.throwIfAborted?.();
    if (matches.length >= maxResults) return;
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (matches.length >= maxResults) return;
      const full = path.join(dir, name);
      try { if (fs.lstatSync(full).isSymbolicLink() || denied(fs.realpathSync(full))) continue; } catch { continue; }
      const childRel = rel ? rel + '/' + name : name;
      if (!denied(full) && re.test(childRel)) {
        try { matches.push(statEntry(full)); } catch {}
      }
      if (depth < maxDepth) {
        let s;
        try { s = fs.statSync(full); } catch { continue; }
        if (s.isDirectory()) walk(full, depth + 1, childRel);
      }
    }
  }
  walk(resolved, 0, '');
  return { root: resolved, pattern, results: matches, total: matches.length, truncated: matches.length >= maxResults };
}

module.exports = { normalize, validate, denied, list, read, readRange, stat, exists, search, glob,
  MAX_READ_BYTES, MAX_LIST_ENTRIES, MAX_SEARCH_RESULTS, MAX_SEARCH_DEPTH, SEARCH_TIMEOUT_MS, MAX_GLOB_RESULTS, MAX_GLOB_DEPTH,
};
