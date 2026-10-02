'use strict';
// ---------------------------------------------------------------------------
// GOOGLE SEARCH CONSOLE — thao tac truc tiep tu terminal
//
// Cai dat truoc (chi can lam 1 lan):
//   1. gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/webmasters
//   2. gcloud services enable searchconsole.googleapis.com --project=<project-id>
//
// Cach dung:
//   node tools/gsc.cjs list                 danh sach property trong tai khoan
//   node tools/gsc.cjs submit                gui sitemap.xml
//   node tools/gsc.cjs status <duong-dan>    kiem tra trang thai index cua 1 URL
//   node tools/gsc.cjs perf [so-ngay]        so lieu tim kiem 30 ngay qua
//   node tools/gsc.cjs perf 7 "keo hoa don"  loc theo tu khoa
// ---------------------------------------------------------------------------
const { execFileSync } = require('node:child_process');
const https = require('node:https');

const SITE = process.env.GSC_SITE || 'https://datkep92.github.io/cntaxtools-landing/';
const PROJECT = process.env.GSC_PROJECT || 'hddt-49af7';

// --- Token: lay tu ADC cua gcloud, khong luu rieng ------------------------
// Windows khong chay duoc file .cmd truc tiep tu execFileSync, phai qua
// cmd.exe /c. Mac/Linux goi binh thuong.
const IS_WIN = process.platform === 'win32';
const GCL = IS_WIN
  ? (process.env.LOCALAPPDATA || process.env.USERPROFILE) + '\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd'
  : '/usr/bin/gcloud';

function token() {
  const args = ['auth', 'application-default', 'print-access-token'];
  for (const [file, argv] of IS_WIN ? [['cmd.exe', ['/c', GCL, ...args]], [GCL, args]] : [[GCL, args]]) {
    try {
      const out = execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const t = out.trim();
      if (t) return t;
    } catch (e) { /* thu cach tiep theo */ }
  }
  console.error('Khong lay duoc token gcloud. Kiem tra:');
  console.error('  ' + GCL);
  console.error('  gcloud auth application-default print-access-token');
  console.error('Neu chua dang nhap voi quyen webmasters:');
  console.error('  gcloud auth application-default login --scopes=openid,https://www.googleapis.com/auth/webmasters');
  process.exit(1);
}

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://searchconsole.googleapis.com' + urlPath);
    const req = https.request({
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        Authorization: 'Bearer ' + token(),
        'x-goog-user-project': PROJECT,
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const msg = (data.error && data.error.message) || raw || ('HTTP ' + res.statusCode);
        const err = new Error(msg);
        err.status = res.statusCode;
        reject(err);
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// 404 o day co nhieu nguyen nhan, khac nhau theo tung lenh:
//  - submit: API sitemaps tra 404 ca khi da xac minh (da kiem tra ca 2 host)
//  - perf  : searchanalytics tra 404 khi trang CHUA CO DU LIEU — hoan toan binh
//            thuong voi trang moi, khong phai loi quyen
//  - cac lenh khac: kiem tra quyen truoc khi ket luan
async function run(name, fn) {
  try { await fn(); }
  catch (e) {
    if (e.status === 404 || /not found/i.test(e.message)) {
      if (name === 'submit') {
        console.error('API sitemaps tra 404 (ke ca khi da xac minh) — phai lam tren web.');
        console.error('');
        console.error('  Search Console -> "So do trang web" -> dan "sitemap.xml" -> "Gui"');
      } else if (name === 'perf') {
        console.error('Chua co du lieu tim kiem nao cho property nay.');
        console.error('');
        console.error('  Day la binh thuong voi trang moi. Can 3-7 ngay Google thu thap');
        console.error('  xong du lieu truoc khi co so lieu.');
        console.error('');
        console.error('  Kiem tra trang da duoc Google quet chua:');
        console.error('    node tools/gsc.cjs status /');
      } else {
        console.error('API tra 404. Nguyen nhan gan nhat: property CHUA XAC MINH.');
        console.error('');
        console.error('  Mo ' + SITE);
        console.error('  -> "Xac minh" -> chon "The HTML" -> bam "Xac minh"');
      }
    } else {
      console.error('LOI: ' + e.message);
    }
    process.exit(1);
  }
}

const site = () => encodeURIComponent(SITE);
const pad = (s, n) => String(s).padEnd(n);
const num = (n) => Number(n || 0).toLocaleString('vi-VN');

const CMD = {
  // ---- danh sach property -------------------------------------------------
  async list() {
    const d = await call('GET', '/webmasters/v3/sites');
    const list = d.siteEntry || [];
    console.log('Tai khoan: ' + (process.env.GSC_ACCOUNT || 'ADC') + '   |   ' + list.length + ' property\n');
    for (const s of list.sort((a, b) => a.siteUrl.localeCompare(b.siteUrl))) {
      const ok = s.permissionLevel === 'siteOwner';
      console.log('  ' + (ok ? '[CHU SO HUU]' : '[chua xac minh]') + '  ' + s.siteUrl);
      console.log('                 quyen: ' + s.permissionLevel);

      // Property "Domain" (sc-domain:) chi xac minh duoc bang ban ghi DNS TXT.
      // Ai cung khong so huu DNS cua github.io nen loai nay khong bao gio
      // xac minh duoc — canh bao de khong mat thoi gian cho no.
      if (!ok && /^sc-domain:(.*\.)?github\.io$/.test(s.siteUrl)) {
        console.log('                 ^ KHONG THE xac minh: Domain property chi dung DNS TXT,');
        console.log('                   ma ban khong so huu DNS cua github.io.');
        console.log('                   Hay dung property dang https:// thay the.');
      }
    }
  },

  // ---- gui sitemap --------------------------------------------------------
  // Luu y: API sitemaps tra 404 tren property duoc tao bang API (sites.add),
  // ke ca khi da xac minh. Da kiem tra ca hai host, van 404. Nen dung giao
  // dien web: Search Console -> "So do trang web" -> dan "sitemap.xml" -> Gui.
  async submit() {
    await call('PUT', '/webmasters/v3/sitemaps/' + site() + '/sitemap.xml');
    console.log('Da gui sitemap.xml cho ' + SITE);
    console.log('Google se quet trong vong 1-2 ngay.');
  },

  // ---- trang thai index cua mot URL --------------------------------------
  async status(arg) {
    if (!arg) { console.error('Thieu duong dan. Vi du: node tools/gsc.cjs status /'); process.exit(1); }
    const url = arg.startsWith('http') ? arg : SITE.replace(/\/$/, '') + (arg.startsWith('/') ? arg : '/' + arg);
    const d = await call('POST', '/v1/urlInspection/index:inspect', { siteUrl: SITE, inspectionUrl: url });
    const r = d.inspectionResult && d.inspectionResult.indexStatusResult;
    if (!r) { console.log('Khong co ket qua. Response: ' + JSON.stringify(d)); return; }
    console.log('URL      : ' + url);
    console.log('Verdict  : ' + r.verdict + '   (' + (r.coverageState || '') + ')');
    if (r.indexingState) console.log('Indexing : ' + r.indexingState);
    if (r.lastCrawlTime) console.log('Crawl    : ' + r.lastCrawlTime);
    if (r.googleCanonical) console.log('Canonical: ' + r.googleCanonical);
    if (r.userCanonical) console.log('Canonical ban khai: ' + r.userCanonical);
  },

  // ---- so lieu tim kiem ---------------------------------------------------
  async perf(arg, keyword) {
    const days = Math.max(1, Math.min(90, Number(arg) || 30));
    const end = new Date();
    const start = new Date(end.getTime() - days * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);

    const body = {
      startDate: iso(start), endDate: iso(end),
      dimensions: keyword ? ['query'] : [],
      rowLimit: keyword ? 25 : 1,
      dataState: 'final',
    };
    if (keyword) body.dimensionFilterGroups = [{
      filters: [{ dimension: 'query', operator: 'CONTAINS', expression: keyword }],
    }];

    const d = await call('POST', '/webanalytics/search/query', body);
    const rows = d.rows || [];
    console.log('Khoang ' + iso(start) + ' den ' + iso(end) + '   |   ' + SITE + '\n');

    if (!rows.length) {
      console.log('Chua co du lieu. Ly do thuong gap:');
      console.log('  - Trang moi duoc lap chi muc, can 3-7 ngay de co so lieu');
      console.log('  - Trang chua duoc index');
      return;
    }
    const padN = (v) => String(v).padStart(9);
    if (keyword) {
      console.log(pad('Truy van', 42) + padN('Click') + padN('Hien') + padN('CTR') + padN('VTB'));
      for (const r of rows) {
        console.log(pad(r.keys[0].slice(0, 40), 42) + padN(r.clicks) + padN(r.impressions)
          + padN((r.ctr * 100).toFixed(1) + '%') + padN(r.position.toFixed(1)));
      }
    } else {
      const r = rows[0];
      console.log('Click       : ' + num(r.clicks));
      console.log('Hien thi    : ' + num(r.impressions));
      console.log('CTR         : ' + (r.ctr * 100).toFixed(2) + '%');
      console.log('Vi tri TB   : ' + r.position.toFixed(1));
    }
  },
};

// Mo ta tach rieng, de in ra ngan gon
const HELP = {
  list: 'danh sach property trong tai khoan',
  submit: 'gui sitemap.xml',
  status: 'kiem tra trang thai index cua 1 URL',
  perf: 'so lieu tim kiem (mac dinh 30 ngay)',
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !CMD[cmd]) {
  console.log('Dung:  node tools/gsc.cjs <lenh> [tham so]\n');
  for (const k of Object.keys(CMD)) console.log('  ' + pad(k, 8) + HELP[k]);
  console.log('\nVi du:');
  console.log('  node tools/gsc.cjs submit');
  console.log('  node tools/gsc.cjs status /');
  console.log('  node tools/gsc.cjs perf 7 "keo hoa don"');
  console.log('\nSite dang dung: ' + SITE);
  if (cmd) console.log('Khong co lenh "' + cmd + '".');
  process.exit(cmd ? 1 : 0);
}
run(cmd, () => CMD[cmd](...rest));
