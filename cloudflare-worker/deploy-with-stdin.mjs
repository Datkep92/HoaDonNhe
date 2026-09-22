#!/usr/bin/env node
import process from 'node:process';

async function readConfig() {
  if (!process.stdin.isTTY) {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) input += chunk;
    return JSON.parse(input);
  }

  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise((resolve, reject) => {
    let input = '';
    process.stdin.on('data', chunk => {
      const text = String(chunk);
      if (text.includes('\u0004')) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        input += text.replace(/\u0004/g, '');
        try { resolve(JSON.parse(input)); } catch (error) { reject(error); }
        return;
      }
      input += text;
    });
  });
}

const config = await readConfig();
for (const [key, value] of Object.entries(config)) {
  process.env[key] = String(value);
}

await import('./deploy.mjs');
