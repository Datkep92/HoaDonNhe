'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Admin-only local configuration; no client route may alter these flags.
function readFeatures(dataDir) {
  const defaults = { legacy: false, basic: true, agent: true };
  const filename = path.join(dataDir, 'ai-features.json');
  if (!fs.existsSync(filename)) return defaults;
  const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
  for (const key of Object.keys(defaults)) if (typeof saved[key] === 'boolean') defaults[key] = saved[key];
  return defaults;
}
module.exports = { readFeatures };
