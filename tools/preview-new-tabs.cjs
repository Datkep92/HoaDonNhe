'use strict';
/**
 * Dựng trang xem trước tĩnh của 2 tab mới để soi bố cục.
 * Mô phỏng đúng khung app: aside 250px + main. Nếu thiếu, pane thành flex-item
 * của body (body{display:flex}) nên bị co về bề rộng nội dung và cột phải
 * đo ra 0px — sai với app thật.
 */
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'src');
const OUT = path.join(__dirname, 'preview-new-tabs.html');

const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
function pane(id) {
  const anchor = html.indexOf(`id="${id}"`);
  const from = html.lastIndexOf('<div class="workspace"', anchor);
  let i = html.indexOf('>', from) + 1, depth = 1, m;
  const tag = /<\/?div\b/g; tag.lastIndex = i;
  while (depth > 0 && (m = tag.exec(html))) depth += (m[0][1] === '/') ? -1 : 1;
  return html.slice(from, m ? m.index + m[0].length : html.indexOf('<footer')).replace(' hidden', '');
}
const css = ['style.css', 'login.css', 'data-view.css']
  .map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');

const DEMO_CSS = [
// aside trong app thật là position:fixed nên không chiếm chỗ trong flow;
// nếu để nó là flex-item bình thường thì main bị đẩy và hẹp lại → đo sai.
'.demo-aside{position:fixed;inset:0 auto 0 0;width:250px;background:#14283f;color:#7b93ab;font:600 12px Segoe UI;padding:20px}',
'.demo-main{margin-left:250px;padding:22px 26px 14px;width:calc(100% - 250px)}',
'.demo-tag{font:700 11px/1 Segoe UI;color:#fff;background:#087f70;padding:6px 10px;border-radius:6px;display:inline-block;margin:0 0 10px}',
'.demo-cap{font:600 13px Segoe UI;color:#40536b;margin:22px 0 10px}',
].join('\n');

const SCRIPT = [
'const $ = id => document.getElementById(id);',
"$('ttk-conn-dot').className = 'status-dot connected';",
"$('ttk-user-mst').textContent = 'Tài khoản: 0100109106';",
"$('ttk-user-name').textContent = 'Cổng Dịch Vụ Công Thuế';",
"$('mst-results-empty').classList.add('hidden');",
"$('mst-count-badge').innerHTML = 'Đã nhận diện: <strong>8</strong> MST';",
"$('mst-btn-export-excel').disabled = false;",
"$('mst-progress-section').hidden = false;",
"$('mst-progress-text').textContent = 'Đang tra cứu: 0101402283 (3/8)';",
"$('mst-progress-detail').textContent = '38%';",
"$('mst-progress-fill').value = 38;",
"$('mst-badge-total').textContent = '3';",
"$('mst-badge-active').textContent = '2';",
"$('mst-badge-inactive').textContent = '1';",
"$('mst-captcha-loading-text').textContent = 'Mã đã điền tự động';",
"$('mst-captcha-input').value = 'A7K2';",
"$('mst-results-count').textContent = '4 MST';",
"const R = [['0100109106','CÔNG TY CP CÔNG NGHỆ VIỄN THÔNG','Đang hoạt động (đã được cấp GCN ĐKT)','Tổng cục Thuế','Số 1, phường Mỹ Đình, Hà Nội'],",
"['0100773180','CÔNG TY TNHH VĂN PHÒNG PHÁP LUẬT VIỆT','Đang hoạt động','Chi cục Thuế Q.1','Hà Nội'],",
"['0300588569','CÔNG TY CỔ PHẦN XÂY DỰNG SỐ 8','Ngừng hoạt động','Chi cục Thuế Q.3','TP. Hồ Chí Minh'],",
"['9999999999','—','Không tìm thấy thông tin người nộp thuế','—','—']];",
"$('mst-results-body').innerHTML = R.map((r, i) => '<tr><td>' + (i+1) + '</td><td><strong>' + r[0] + '</strong></td><td>' + r[1] + '</td>'",
"  + '<td><span class=\"badge-status ' + (i < 2 ? 'badge-status-active' : i === 2 ? 'badge-status-inactive' : 'badge-status-other') + '\">' + r[2] + '</span></td>'",
"  + '<td>' + r[3] + '</td><td>' + r[4] + '</td></tr>').join('');",
"$('ttk-results-section').hidden = false;",
"$('ttk-results-empty').hidden = true;",
"$('ttk-result-count').textContent = '2 hồ sơ';",
"$('ttk-btn-bulk-download').disabled = false;",
"const T = [['24/001/00001','Quý 3/2026','Đã gửi'],['24/001/00002','Quý 3/2026','Chờ tiếp nhận']];",
"$('ttk-results-body').innerHTML = T.map((r, i) => '<tr><td>' + (i+1) + '</td><td><strong>' + r[0] + '</strong></td><td>01/GTGT</td>'",
"  + '<td>' + r[1] + '</td><td>01/GTGT</td><td>0</td><td>1</td><td>30/09/2026</td>'",
"  + '<td><span class=\"badge-status\">' + r[2] + '</span></td>'",
"  + '<td><a href=\"#\" class=\"ttk-hs-link\">Xem</a><button class=\"ttk-btn-download\">Tải</button></td></tr>').join('');",
].join('\n');

const doc = [
'<!doctype html><html lang="vi"><head><meta charset="utf-8">',
'<title>Xem trước — Tra cứu MST / Tờ khai</title>',
'<style>' + css + DEMO_CSS + '</style></head><body>',
'<div class="demo-aside">Cột MST (giả lập)</div>',
'<main class="demo-main">',
'<span class="demo-tag">BẢN XEM TRƯỚC — dữ liệu mẫu</span>',
'<div class="demo-cap">Tab: Tra cứu MST</div>',
pane('pane-mstlookup'),
'<div class="demo-cap">Tab: Tờ khai — đã đăng nhập (khung login mở)</div>',
pane('pane-tokhai').replace('id="ttk-card-direct-login" class="login-box" hidden', 'id="ttk-card-direct-login" class="login-box"'),
'</main>',
'<script>' + SCRIPT + '<' + '/script></body></html>',
].join('\n');

fs.writeFileSync(OUT, doc);
console.log('ghi ' + OUT + ' (' + doc.length + ' ký tự)');