'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseBaseUrl } = require('../ai-providers');
function loadConfig(dataDir) {
  // dotenv is read only on the backend; never expose any key in public config.
  const env = {};
  const local = path.join(process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '../..'), '.env.local');
  if (fs.existsSync(local)) {
    for (const line of fs.readFileSync(local, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(OPENROUTER_API_KEY|AI_MODEL|AI_API_URL)\s*=\s*(.*?)\s*$/);
      if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const endpoint = process.env.AI_API_URL || env.AI_API_URL || 'https://openrouter.ai/api/v1/chat/completions';
  if (!parseBaseUrl(endpoint, 'openai')) throw new Error('AI_API_URL phải là địa chỉ HTTPS hợp lệ.');
  return {
    endpoint, model: process.env.AI_MODEL || env.AI_MODEL || 'stealth/space-bunny-alpha',
    apiKey: process.env.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || '',
  };
}
module.exports = { loadConfig };
