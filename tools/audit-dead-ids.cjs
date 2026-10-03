'use strict';
/** Liệt kê id trong 2 pane mà JS tương ứng KHÔNG dùng (markup chết). */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

function sliceOf(src, id) {
  const anchor = src.indexOf('id="' + id + '"');
  const from = src.lastIndexOf('<div class="workspace"', anchor);
  let i = src.indexOf('>', from) + 1, depth = 1, m;
  const tag = /<\/?div\b/g; tag.lastIndex = i;
  while (depth > 0 && (m = tag.exec(src))) depth += (m[0][1] === '/') ? -1 : 1;
  return src.slice(from, m.index + m[0].length);
}

for (const [pane, jsFile] of [['pane-mstlookup', 'mst-lookup-ui.js'], ['pane-tokhai', 'tokhai-ui.js']]) {
  const js = fs.readFileSync(path.join(SRC, jsFile), 'utf8');
  const inner = sliceOf(html, pane);
  const ids = [...new Set([...inner.matchAll(/id="([^"]+)"/g)].map(x => x[1]))];
  const unused = ids.filter(id => !js.includes("'" + id + "'") && !js.includes('#' + id));
  console.log(pane + ': ' + ids.length + ' id | thua: ' + (unused.join(', ') || 'khong'));
  if (unused.length) console.log('   -> ' + unused.map(i => '#' + i).join(', '));
}

console.log('\n--- cac dong chua "progress" trong tokhai-ui.js ---');
const t = fs.readFileSync(path.join(SRC, 'tokhai-ui.js'), 'utf8');
(t.match(/.*progress.*/gi) || []).slice(0, 12).forEach(l => console.log('  ' + l.trim()));