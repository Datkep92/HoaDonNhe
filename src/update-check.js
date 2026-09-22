'use strict';
// ---------------------------------------------------------------------------
// Kiểm tra bản mới trên GitHub Releases.
//
// QUAN TRỌNG: module này CHỈ ĐỌC (GET) thông tin bản phát hành mới nhất để
// báo cho người dùng. Nó KHÔNG tự tải và KHÔNG tự ghi đè EXE đang chạy — mọi
// việc cập nhật vẫn do người dùng tự tải từ GitHub Releases.
//
// Mọi lỗi (mất mạng, GitHub đổi API, hết thời gian chờ…) đều bị nuốt và trả về
// ok:false để không bao giờ chặn/treo ứng dụng. Kết quả được cache 1 giờ.
// ---------------------------------------------------------------------------
const https = require('node:https');
const { version, name, repository, releasesUrl } = require('./version');

const RELEASES_API = `https://api.github.com/repos/${repository}/releases/latest`;
const TTL_MS = 60 * 60 * 1000; // cache 1 giờ
const TIMEOUT_MS = 6000;

let cache = null;
let cacheAt = 0;

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': `${name}/${version}`, Accept: 'application/vnd.github+json' },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(new Error('Phản hồi quá lớn.')); });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`GitHub trả HTTP ${res.statusCode}.`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Hết thời gian chờ GitHub.')));
    req.on('error', reject);
  });
}

// So sánh 2 version dạng "1.2.3" (bỏ tiền tố v). Trả -1 / 0 / 1.
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function checkUpdate(force) {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const current = String(version);
  try {
    const data = await getJson(RELEASES_API, TIMEOUT_MS);
    const latest = String(data.tag_name || '').replace(/^v/i, '');
    cache = {
      ok: true,
      current,
      latest,
      updateAvailable: !!latest && compareVersions(latest, current) > 0,
      name: data.name || data.tag_name || latest,
      url: data.html_url || `${releasesUrl}/latest`,
      publishedAt: data.published_at || '',
    };
  } catch (error) {
    cache = { ok: false, current, latest: '', updateAvailable: false, url: '', error: error && error.message ? error.message : String(error) };
  }
  cacheAt = Date.now();
  return cache;
}

module.exports = { checkUpdate, compareVersions, getJson };
