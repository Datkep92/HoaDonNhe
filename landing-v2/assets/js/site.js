/* ==========================================================================
   CN Tax Tools — landing v2
   Tương tác tối giản: menu di động, trạng thái header, hiệu ứng xuất hiện.
   Không phụ thuộc thư viện ngoài.
   ========================================================================== */
(function () {
  'use strict';

  var header = document.getElementById('hd');
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');

  /* ---------- Header đổ bóng khi cuộn ---------- */
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      if (header) header.classList.toggle('is-stuck', window.scrollY > 8);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Menu di động ---------- */
  function closeMenu() {
    if (!nav || !burger) return;
    nav.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Mở menu');
  }

  if (burger && nav) {
    burger.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      burger.setAttribute('aria-label', open ? 'Đóng menu' : 'Mở menu');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeMenu();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenu();
    });

    document.addEventListener('click', function (event) {
      if (!nav.classList.contains('open')) return;
      if (nav.contains(event.target) || burger.contains(event.target)) return;
      closeMenu();
    });
  }

  /* ---------- Chuyển tab trong một nhóm (hỗ trợ tương lai) ---------- */
  /* ---------- Xuất hiện khi cuộn ---------- */
  var reveals = document.querySelectorAll('.rv');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!('IntersectionObserver' in window) || reduceMotion) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    reveals.forEach(function (el, index) {
      el.style.transitionDelay = (index % 3) * 70 + 'ms';
      observer.observe(el);
    });
  }

  /* ---------- Đóng ghim thanh mobile khi chạm đáy trang ---------- */
  var bar = document.querySelector('.mbar');
  if (bar) {
    var footer = document.querySelector('.ft');
    if (footer && 'IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          bar.style.display = entry.isIntersecting ? 'none' : '';
        });
      }, { threshold: 0 }).observe(footer);
    }
  }

  /* ==========================================================================
     NÚT TẢI — tự dò bản mới nhất trong GitHub Releases
     --------------------------------------------------------------------------
     Mọi nút tải đánh dấu `data-dl`. Trong HTML, href của chúng đã trỏ sẵn về
     /releases/latest (GitHub tự chuyển hướng tới release mới nhất) nên kể cả khi
     JavaScript bị chặn, mạng lỗi hay API GitHub sập, nút vẫn tải đúng bản mới —
     chỉ mất chút tiện lợi là phải bấm thêm một lần ở trang Releases.

     Có JavaScript thì ta tra API để lấy thẳng link file .exe. api.github.com có
     CORS `*` nên gọi thẳng từ trình duyệt được, không cần máy chủ.

     Cùng lần tra đó, mọi nhãn đánh dấu `data-dl-ver` cũng được đổi theo (badge
     phiên bản ở đầu trang, các dòng "v1.0.8 · Cài đặt" trong ảnh mô phỏng) — để
     trang không còn rơi lại số phiên bản cũ sau khi đã phát hành bản mới.
     Chỉ tiền tố "v<số>" bị thay, phần chữ còn lại giữ nguyên.

     Vì sao bấm lúc chưa tra xong vẫn tải đúng: ta chặn sự kiện click, chờ tối đa
     3 giây cho lời gọi về rồi mới chuyển trang. Quá hạn thì thả theo href sẵn có.

     Cache localStorage 30 phút: GitHub giới hạn 60 lượt/giờ cho request không
     đăng nhập, và bản mới không xuất hiện dày đặc đến vậy.
     ========================================================================== */
  (function downloadLinks() {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-dl]'));
    var labels = Array.prototype.slice.call(document.querySelectorAll('[data-dl-ver]'));
    if ((!buttons.length && !labels.length) || !window.fetch) return;

    var REPO = 'Datkep92/HoaDonNhe';
    var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
    var CACHE_KEY = 'cntax.dl.v1';
    var TTL_MS = 30 * 60 * 1000;
    var WAIT_CLICK_MS = 3000;

    var url = null;        // link .exe đã dò được
    var version = null;    // số phiên bản đã đổi lên nhãn
    var pending = null;    // promise đang chờ, dùng lại cho mọi lần bấm

    /* Chỉ nhận đúng tệp bộ cài của CN Tax Tools, bỏ qua .sha256 */
    function pickAsset(assets) {
      if (!Array.isArray(assets)) return null;
      for (var i = 0; i < assets.length; i++) {
        var name = assets[i] && assets[i].name;
        if (typeof name === 'string' && /^CN-Tax-Tools-Setup-v\d+\.\d+\.\d+\.exe$/.test(name)) {
          return assets[i].browser_download_url || null;
        }
      }
      return null;
    }

    /* Số phiên bản từ tag (cntax-v1.0.8) hoặc từ chính tên tệp — tag chuẩn hơn */
    function pickVersion(data) {
      var tag = data && typeof data.tag_name === 'string' ? data.tag_name : '';
      var m = tag.match(/(\d+\.\d+\.\d+)/);
      if (m) return m[1];
      var assets = data && data.assets;
      if (Array.isArray(assets) && assets[0] && typeof assets[0].name === 'string') {
        var n = assets[0].name.match(/(\d+\.\d+\.\d+)/);
        if (n) return n[1];
      }
      return null;
    }

    /* Nhãn nào bắt đầu bằng "v<số>" thì thay tiền tố đó, giữ nguyên phần còn lại.
       Ví dụ "v1.0.8 · Cài đặt" -> "v1.0.9 · Cài đặt"; "v1.0.8" -> "v1.0.9". */
    function applyVersion(value) {
      if (!value) return;
      version = value;
      labels.forEach(function (el) {
        var text = el.textContent || '';
        if (!/^v\d+\.\d+\.\d+/.test(text)) return;
        el.textContent = 'v' + value + text.replace(/^v\d+\.\d+\.\d+/, '');
      });
    }

    function readCache() {
      try {
        var raw = window.localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (!data || typeof data !== 'object') return null;
        if (Date.now() - Number(data.at || 0) > TTL_MS) return null;
        // Chỉ nhận link https của chính repo phát hành, không tin dữ liệu lạ ghi vào
        if (typeof data.url === 'string' && data.url.indexOf('https://github.com/' + REPO + '/releases/download/') !== 0) {
          return null;
        }
        return data;
      } catch (error) {
        return null;   // localStorage bị chặn (chế độ riêng tư) — cứ bỏ qua cache
      }
    }

    function writeCache(value) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
      } catch (error) { /* bỏ qua */ }
    }

    function apply(cached) {
      if (!cached) return;
      if (cached.url && !url && buttons.length) {
        url = cached.url;
        buttons.forEach(function (btn) { btn.setAttribute('href', cached.url); });
      }
      if (cached.version && !version) applyVersion(cached.version);
    }

    function resolve() {
      var needUrl = buttons.length && !url;
      var needVersion = labels.length && !version;
      if (!needUrl && !needVersion) return Promise.resolve(url);
      if (pending) return pending;

      pending = window.fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var found = { url: pickAsset(data && data.assets), version: pickVersion(data) };
          if (found.url && !url) {
            url = found.url;
            buttons.forEach(function (btn) { btn.setAttribute('href', found.url); });
          }
          if (found.version && !version) applyVersion(found.version);
          if (found.url || found.version) writeCache({ url: url, version: version, at: Date.now() });
          return found.url;
        })
        .catch(function () {
          return null;   // mạng lỗi / API lỗi / đổi cấu trúc -> giữ nguyên href dự phòng
        })
        .then(function (value) {
          pending = null;   // cho phép thử lại ở lượt sau nếu lần này hỏng
          return value;
        });

      return pending;
    }

    apply(readCache());
    if ((buttons.length && !url) || (labels.length && !version)) resolve();

    /* Bấm trước khi tra xong -> chờ một nhịp rồi mới đi, không mất lượt tải */
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function (event) {
        if (url) return;   // đã có link thẳng, để trình duyệt xử lý
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;

        event.preventDefault();
        var fallback = btn.getAttribute('href');
        var settled = false;
        var wait = window.setTimeout(function () { go(fallback); }, WAIT_CLICK_MS);

        function go(target) {
          if (settled) return;
          settled = true;
          window.clearTimeout(wait);
          window.location.href = target;
        }

        resolve().then(function (value) { go(value || fallback); });
      });
    });
  })();

  /* ==========================================================================
     XEM TRƯỚC GIAO DIỆN — chuyển ảnh theo nút bấm, tự chạy, hỗ trợ bàn phím
     ========================================================================== */
  (function gallery() {
    var root = document.getElementById('gal');
    if (!root) return;

    var buttons = Array.prototype.slice.call(root.querySelectorAll('.gal-btn'));
    var panes = Array.prototype.slice.call(root.querySelectorAll('.gal-pane'));
    var dots = Array.prototype.slice.call(root.querySelectorAll('.gal-dots button'));
    if (!buttons.length || !panes.length) return;

    var current = -1;
    var timer = null;
    var AUTO_MS = 9000;

    function show(index, focusBtn) {
      if (index === current) return;
      if (index < 0) index = panes.length - 1;
      if (index >= panes.length) index = 0;
      current = index;

      buttons.forEach(function (btn, i) {
        var on = i === index;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.setAttribute('tabindex', on ? '0' : '-1');
        if (on && focusBtn) btn.focus();
      });
      panes.forEach(function (pane, i) { pane.classList.toggle('on', i === index); });
      dots.forEach(function (dot, i) { dot.setAttribute('aria-current', i === index ? 'true' : 'false'); });
    }

    function step(delta) { show((current + delta + panes.length) % panes.length, true); }

    buttons.forEach(function (btn, i) {
      btn.addEventListener('click', function () { show(i); restart(); });
    });
    dots.forEach(function (dot, i) {
      dot.addEventListener('click', function () { show(i, true); restart(); });
    });

    root.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight') { event.preventDefault(); step(1); restart(); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); restart(); }
    });

    function restart() {
      if (timer) window.clearInterval(timer);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      if (document.hidden) return;
      timer = window.setInterval(function () { show(current + 1); }, AUTO_MS);
    }

    show(0);
    restart();

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (timer) window.clearInterval(timer); }
      else restart();
    });

    /* Kéo ngang trên màn hình cảm ứng */
    var stage = root.querySelector('.gal-stage');
    if (stage) {
      var x0 = null, y0 = null;
      stage.addEventListener('touchstart', function (e) {
        x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      }, { passive: true });
      stage.addEventListener('touchend', function (e) {
        if (x0 === null) return;
        var dx = e.changedTouches[0].clientX - x0;
        var dy = e.changedTouches[0].clientY - y0;
        if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
        x0 = null; y0 = null;
        restart();
      }, { passive: true });
    }
  })();
})();
