'use strict';
/**
 * Kiểm tra 2 tab mới khớp với JS:
 *   1) Mọi getElementById trong JS phải có id tương ứng trong HTML
 *   2) Mọi className mà JS gán phải có trong CSS
 *   3) Mọi selector querySelectorAll trong JS phải khớp được phần tử trong HTML
 *   4) Hai pane phải là DIV CÂN BẰNG (không phá vỡ cấu trúc HTML)
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const css = ['style.css', 'login.css', 'data-view.css']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

let bad = 0;
const fail = msg => { console.log('  FAIL ' + msg); bad++; };

for (const file of ['mst-lookup-ui.js', 'tokhai-ui.js']) {
  const js = fs.readFileSync(path.join(SRC, file), 'utf8');
  console.log('\n=== ' + file + ' ===');

  // 1) id
  const ids = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const missing = ids.filter(id => !html.includes(`id="${id}"`));
  if (missing.length) fail('thiếu id trong HTML: ' + missing.join(', '));
  else console.log(`  OK  ${ids.length} id đều có trong HTML`);

  // 2) className do JS gan
  const cls = [...new Set([...js.matchAll(/className\s*=\s*'([^']+)'/g)].flatMap(m => m[1].trim().split(/\s+/)))];
  const noCss = cls.filter(c => c && !new RegExp('\\.' + c + '\\b').test(css));
  if (noCss.length) fail('className không có trong CSS: ' + noCss.join(', '));
  else console.log(`  OK  ${cls.length} className đều có CSS: ${cls.join(', ')}`);

  // 3) selector
  for (const m of js.matchAll(/querySelectorAll\('([^']+)'\)/g)) {
    const sel = m[1];
    const clsMatch = sel.match(/\.([\w-]+)\s*$/);
    if (!clsMatch) continue;
    const c = clsMatch[1];
    if (!html.includes(`class="${c}`) && !html.includes(` ${c}"`) && !html.includes(` ${c} `)) {
      fail(`selector "${sel}" không khớp phần tử nào trong HTML`);
    } else console.log(`  OK  selector "${sel}" khớp`);
  }

  // 4) class trong HTML mà JS tô màu (badge-status-*)
  for (const m of js.matchAll(/badge-status(-\w+)?/g)) {
    const c = m[0];
    if (!new RegExp('\\.' + c + '\\b').test(css)) fail(`class "${c}" dùng trong JS nhưng không có CSS`);
  }
}

// 5) cân bằng thẻ trong 2 pane
for (const id of ['pane-mstlookup', 'pane-tokhai']) {
  const anchor = html.indexOf(`id="${id}"`);
  if (anchor < 0) { fail(`không thấy ${id}`); continue; }
  const from = html.lastIndexOf('<div class="workspace"', anchor);
  let i = html.indexOf('>', from) + 1, depth = 1, m;
  const tag = /<\/?div\b/g; tag.lastIndex = i;
  while (depth > 0 && (m = tag.exec(html))) depth += (m[0][1] === '/') ? -1 : 1;
  if (depth !== 0) fail(`${id} lệch ${depth} thẻ <div>`);
  else console.log(`\nOK  ${id} cân bằng thẻ div`);
}

// 6) index.html van parse duoc nhu HTML: so <section>/</section>
const openSection = (html.match(/<section\b/g) || []).length;
const closeSection = (html.match(/<\/section>/g) || []).length;
console.log(`\nsection: ${openSection} mo / ${closeSection} dong`);
if (openSection !== closeSection) fail('thẻ <section> lệch');

// 7) moi file JS/CSS cuoi cung parse duoc
for (const f of ['mst-lookup.js', 'tokhai.js', 'mst-lookup-ui.js', 'tokhai-ui.js']) {
  try { new Function(fs.readFileSync(path.join(SRC, f), 'utf8')); console.log('OK  parse ' + f); }
  catch (e) { fail('parse ' + f + ': ' + e.message); }
}
const cssBraces = (css.match(/\{/g) || []).length - (css.match(/\}/g) || []).length;
if (cssBraces !== 0) fail('CSS lệch ' + cssBraces + ' dấu {}');
else console.log('OK  CSS cân bằng {}');

console.log('\n' + (bad ? `*** ${bad} LỖI ***` : '=== TẤT CẢ ĐỀU ĐÚNG ==='));
process.exit(bad ? 1 : 0);