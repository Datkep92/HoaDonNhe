'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomicWrite } = require('../core');
const { canonical } = require('./permission-engine');
// Separate additive metadata. Accounting databases are never opened here.
function createExecutionStore(dataDir) {
  const directory = path.join(dataDir, 'agent', 'requests'); fs.mkdirSync(directory, { recursive: true });
  const filename = id => { if (!/^[a-f0-9-]{36}$/.test(id || '')) throw Error('Request ID không hợp lệ.'); return path.join(directory, id + '.json'); };
  const load = id => fs.existsSync(filename(id)) ? JSON.parse(fs.readFileSync(filename(id), 'utf8')) : null;
  const save = record => atomicWrite(filename(record.id), JSON.stringify(record));
  function begin(id, scope, input) {
    const digest = crypto.createHash('sha256').update(canonical(input)).digest('hex');
    const previous = load(id);
    if (previous) { if (previous.scope !== scope || previous.digest !== digest) throw Error('Request ID đã dùng cho nội dung/MST khác.'); return previous; }
    const record = { id, scope, digest, input, state: 'running', tools: {}, createdAt: new Date().toISOString() }; save(record); return record;
  }
  return { begin, load,
    list(scope) { return fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => load(name.slice(0, -5))).filter(record => record.scope === scope && record.state !== 'completed').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10).map(record => ({ id: record.id, state: record.state, input: record.input, createdAt: record.createdAt })); },
    finish(record, state, answer) { record.state = state; if (answer !== undefined) record.answer = answer; save(record); },
    checkpoint(record, value) { record.checkpoint = value; save(record); },
    toolKey: (name, args) => crypto.createHash('sha256').update(canonical({ name, args })).digest('hex'),
    tool(record, key) { return record.tools[key]; },
    startTool(record, key) { record.tools[key] = { state: 'unknown' }; save(record); },
    completeTool(record, key, result) { record.tools[key] = { state: 'completed', result }; save(record); },
  };
}
module.exports = { createExecutionStore };
