'use strict';
const path = require('node:path');
const { TaxBrowser } = require('./browser');

// CAPTCHA/cookie tra cứu thuộc phiên riêng từng MST; không dùng Chrome đăng nhập hóa đơn/tờ khai.
class MstBrowserPool {
  constructor(root) { this.root = path.join(root, 'mst-lookup'); this.browsers = new Map(); }
  async get(mst, open = false) {
    let browser = this.browsers.get(mst);
    if (!browser && open) {
      browser = new TaxBrowser(this.root, { headless: true, startUrl: 'https://tracuuhoadon.gdt.gov.vn/' });
      this.browsers.set(mst, browser);
    }
    if (!browser) throw new Error('Lấy CAPTCHA mới trước khi tra cứu MST.');
    if (open) await browser.ensureOpen(mst, false);
    if (!browser.client) throw new Error('Phiên tra cứu đã đóng. Lấy CAPTCHA mới rồi thử lại.');
    return browser;
  }
  async close() {
    await Promise.allSettled([...this.browsers.values()].map(browser => browser.close()));
    this.browsers.clear();
  }
}
module.exports = { MstBrowserPool };
