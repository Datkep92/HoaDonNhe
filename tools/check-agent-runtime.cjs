'use strict';
const fs = require('node:fs'), path = require('node:path');
const { createRuntime } = require('../src/ai/free-runtime');
const directory = path.resolve('artifacts/direct-free-smoke');
const runtime = createRuntime(directory);
(async () => {
  try {
    if (!runtime.status().installed) { const result = await runtime.install(); if (!result.installed) throw Error(result.error); }
    const result = await runtime.inspect();
    const report = { installed: runtime.status().installed, version: result.version, transport: result.transport, requiresDownload: false, freeModels: result.freeModels.map(m => m.id) };
    if (process.argv.includes('--prompt')) {
      const answer = await runtime.chat({ messages: [{ role: 'user', content: 'Reply OK only.' }], tools: [], signal: AbortSignal.timeout(90000) }); report.promptResult = answer.final;
    }
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { runtime.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
