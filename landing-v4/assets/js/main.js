/* ==========================================================================
   CN Tax Tools — Landing 2026 · main.js
   Không phụ thuộc thư viện ngoài. Tôn trọng prefers-reduced-motion.
   ========================================================================== */
(function () {
  'use strict';

  var $  = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var yr = $('#yr');
  if (yr) yr.textContent = String(new Date().getFullYear());

  /* ----------------------------------------------------------------------
     1. Header dính + thanh tiến độ + dock
     ---------------------------------------------------------------------- */
  var hdr = $('#hdr'), pbar = $('#pbar'), dock = $('#dock');
  var ticking = false;

  function onScroll() {
    var y = window.pageYOffset;
    var docH = document.documentElement.scrollHeight - window.innerHeight;
    if (hdr) hdr.classList.toggle('is-stuck', y > 8);
    if (pbar) {
      var pct = docH > 0 ? Math.min(1, Math.max(0, y / docH)) : 0;
      pbar.style.width = (pct * 100).toFixed(2) + '%';
    }
    if (dock) dock.classList.toggle('is-on', y > 380);
    ticking = false;
  }
  function requestScroll() { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }
  window.addEventListener('scroll', requestScroll, { passive: true });
  window.addEventListener('resize', requestScroll, { passive: true });
  onScroll();

  /* ----------------------------------------------------------------------
     2. Menu trượt — đóng bằng 4 cách: ✕ · burger · bấm ngoài · ESC
     ---------------------------------------------------------------------- */
  var burger = $('#burger'), nav = $('#nav'), scrim = $('#scrim'), sheetClose = $('#sheet-close');
  var menuOpen = false;

  function lockScroll(on) {
    var b = document.body;
    if (on) {
      var pad = window.innerWidth - document.documentElement.clientWidth;
      if (pad > 0) b.style.paddingRight = pad + 'px';
      b.style.overflow = 'hidden';
    } else { b.style.overflow = ''; b.style.paddingRight = ''; }
  }
  function focusables() {
    return $$('a[href], button:not([disabled])', nav).filter(function (el) { return el.offsetParent !== null; });
  }
  function setMenu(open) {
    if (!nav || !burger) return;
    menuOpen = open;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Đóng menu' : 'Mở menu');
    if (open) {
      lockScroll(true);
      if (scrim) { scrim.hidden = false; void scrim.offsetWidth; scrim.classList.add('is-open'); }
      nav.classList.add('is-open');
      var f = focusables();
      if (f.length) f[0].focus();
    } else {
      lockScroll(false);
      if (scrim) {
        scrim.classList.remove('is-open');
        window.setTimeout(function () { if (!menuOpen) scrim.hidden = true; }, 300);
      }
      nav.classList.remove('is-open');
    }
  }
  if (burger) burger.addEventListener('click', function () { setMenu(!menuOpen); });
  if (scrim) scrim.addEventListener('click', function () { setMenu(false); });
  if (sheetClose) sheetClose.addEventListener('click', function () { setMenu(false); burger && burger.focus(); });
  if (nav) {
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    nav.addEventListener('keydown', function (e) {
      if (!menuOpen || e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && menuOpen) { setMenu(false); burger && burger.focus(); }
  });
  var wide = window.matchMedia('(min-width: 1001px)');
  (wide.addEventListener ? wide.addEventListener.bind(wide, 'change') : wide.addListener.bind(wide))(function (e) {
    if ((e.matches !== undefined ? e.matches : e) && menuOpen) setMenu(false);
  });

  /* ----------------------------------------------------------------------
     3. Slide demo giao diện
     ---------------------------------------------------------------------- */
  var vp = $('#deco-vp');
  if (vp) {
    var slides = $$('[data-slide]', vp);
    var pipsBox = $('#pips');
    var capT = $('#cap-t'), capD = $('#cap-d');
    var cur = 0, timer = null;
    var AUTO = 6500;

    var CAPS = [
      ['Quản lý nhiều MST', 'Thêm bao nhiêu khách hàng cũng được. Mỗi MST một phiên riêng, tự đăng nhập lại khi hết hạn.'],
      ['Tải hóa đơn hàng loạt', 'Chọn năm + quý là ứng dụng tự kéo toàn bộ hóa đơn theo định dạng bạn chọn.'],
      ['Quản lý hàng hóa & tồn kho', 'Hóa đơn tải về được tách thành dòng hàng hóa, đối chiếu mã với danh mục và theo dõi tồn.'],
      ['Sao kê, dòng tiền & công nợ', 'Nạp sao kê ngân hàng, app tự khớp từng dòng và chỉ ra dòng nào lệch cần xem lại.']
    ];

    // Dựng nút chuyển slide
    slides.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pip';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', 'slide-' + i);
      b.setAttribute('aria-label', (i + 1) + '. ' + CAPS[i][0]);
      b.addEventListener('click', function () { go(i); restart(); });
      pipsBox && pipsBox.appendChild(b);
      s.id = 'slide-' + i;
    });
    var pips = $$('.pip', pipsBox);

    function go(i) {
      cur = (i + slides.length) % slides.length;
      slides.forEach(function (s, k) {
        var on = k === cur;
        s.hidden = !on;
        s.classList.toggle('is-on', on);
      });
      pips.forEach(function (p, k) {
        p.setAttribute('aria-current', String(k === cur));
        p.setAttribute('aria-selected', String(k === cur));
        p.tabIndex = k === cur ? 0 : -1;
      });
      if (capT) capT.textContent = CAPS[cur][0];
      if (capD) capD.textContent = CAPS[cur][1];
    }

    function stop() { if (timer) { window.clearInterval(timer); timer = null; } }
    function start() { if (!REDUCED && !timer) timer = window.setInterval(function () { go(cur + 1); }, AUTO); }
    function restart() { stop(); start(); }

    var next = $('#next'), prev = $('#prev');
    if (next) next.addEventListener('click', function () { go(cur + 1); restart(); });
    if (prev) prev.addEventListener('click', function () { go(cur - 1); restart(); });

    // Phím mũi tên khi khung slide có tiêu điểm
    vp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); restart(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); restart(); }
    });

    // Vuốt ngang trên cảm ứng
    var sx = 0, sy = 0, swiping = false;
    vp.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; swiping = true; stop();
    }, { passive: true });
    vp.addEventListener('touchend', function (e) {
      if (!swiping) return;
      swiping = false;
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? cur + 1 : cur - 1);
      start();
    }, { passive: true });

    // Dừng tự chạy khi rê chuột / tab ẩn
    ['mouseenter', 'focusin'].forEach(function (ev) { vp.addEventListener(ev, stop); });
    ['mouseleave', 'focusout'].forEach(function (ev) { vp.addEventListener(ev, start); });
    document.addEventListener('visibilitychange', function () { document.hidden ? stop() : start(); });

    go(0);
    start();
  }

  /* ----------------------------------------------------------------------
     4. NÚT TẢI — tự dò bản mới nhất trong GitHub Releases
     ----------------------------------------------------------------------
     Mọi nút tải đánh dấu `data-dl`. Trong HTML, href của chúng đã trỏ sẵn về
     /releases/latest (GitHub tự chuyển hướng tới release mới nhất) nên kể cả khi
     JavaScript bị chặn, mạng lỗi hay API GitHub sập, nút vẫn tải đúng bản mới —
     chỉ mất tiện lợi là phải bấm thêm một lần ở trang Releases.

     Có JavaScript thì tra API để lấy thẳng link file .exe. api.github.com có
     CORS `*` nên gọi thẳng từ trình duyệt được, không cần máy chủ.

     Cùng lần tra đó, mọi nhãn `data-dl-ver` cũng được đổi theo — để trang không
     còn rơi lại số phiên bản cũ sau khi đã phát hành bản mới.

     Link đã dò được và hàm `resolve()` được đặt vào `dl` cho hộp thoại ở mục 5
     dùng lại: bấm nút tải trong hộp thoại phải ra đúng bản mới nhất y hệt bấm
     nút ngoài trang, không phải chờ tra lại lần nữa.

     Cache localStorage 30 phút: GitHub giới hạn 60 lượt/giờ cho request không
     đăng nhập, và bản mới không xuất hiện dày đặc đến vậy. */
  var dl = { url: null, resolve: null, wait: 3000 };

  /* Đi tới link tải, chờ tối đa `dl.wait` ms cho lời gọi API về rồi mới chuyển
     trang. Quá hạn thì thả theo `fallback` (href dự phòng trong HTML) — không
     mất lượt tải vì chậm một chút. */
  function startDownload(fallback) {
    var settled = false;
    var wait = window.setTimeout(function () { go(fallback); }, dl.wait);

    function go(target) {
      if (settled) return;
      settled = true;
      window.clearTimeout(wait);
      window.location.href = target;
    }

    if (dl.resolve) dl.resolve().then(function (value) { go(value || fallback); });
    else go(fallback);
  }

  (function downloadLinks() {
    var buttons = $$('[data-dl]');
    var labels = $$('[data-dl-ver]');
    if ((!buttons.length && !labels.length) || !window.fetch) return;

    var REPO = 'Datkep92/HoaDonNhe';
    var API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
    var CACHE_KEY = 'cntax.dl.v1';
    var TTL_MS = 30 * 60 * 1000;

    var url = null;        // link .exe đã dò được
    var version = null;    // số phiên bản đã đổi lên nhãn
    var pending = null;    // promise đang chờ, dùng lại cho mọi lần bấm

    /* Ghi link .exe vào mọi nút tải và nhớ lại cho hộp thoại. Chỉ gán một lần:
       nếu API đổi ý giữa chừng thì vẫn giữ link đã biết là đúng. */
    function setUrl(value) {
      if (!value || url) return false;
      url = value;
      dl.url = value;
      buttons.forEach(function (btn) { btn.setAttribute('href', value); });
      return true;
    }

    /* Chỉ nhận đúng tệp bộ cài của CN Tax Tools: bỏ qua .sha256, bỏ qua bản
       payload CN-Tax-Tools-vX.Y.Z.exe (dùng cho self-update, không phải để cài). */
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

    /* Số phiên bản lấy từ tag (v1.0.9), không có thì lấy từ tên tệp */
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
       "v1.0.9 là bản mới nhất" -> "v1.0.10 là bản mới nhất" */
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
        return null;   // localStorage bị chặn (chế độ riêng tư) — bỏ qua cache
      }
    }

    function writeCache(value) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(value));
      } catch (error) { /* bỏ qua */ }
    }

    function apply(cached) {
      if (!cached) return;
      if (cached.url) setUrl(cached.url);
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
          if (found.url) setUrl(found.url);
          if (found.version && !version) applyVersion(found.version);
          if (url || version) writeCache({ url: url, version: version, at: Date.now() });
          return url;
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
    dl.resolve = resolve;
    if ((buttons.length && !url) || (labels.length && !version)) resolve();

    /* KHÔNG bắt sự kiện click ở đây nữa: mọi lượt bấm chuột trái đã bị hộp thoại
       ở mục 5 chặn lại trước để hiện cảnh báo. Giữ `href` đã dò sẵn ở trên là đủ
       cho các lượt mở bằng chuột phải / Ctrl+click / mở tab mới. */
  })();

  /* ----------------------------------------------------------------------
     5. CẢNH BÁO TRƯỚC KHI TẢI — đổi nội dung theo thiết bị đang dùng
     ----------------------------------------------------------------------
     Mọi lượt bấm nút `data-dl` đều mở hộp thoại này, không có ngoại lệ:
     người dùng Windows cần chỉ đường qua bảng cảnh báo SmartScreen và cần
     tin rằng đây không phải virus; người dùng điện thoại thì phải biết ngay
     là ứng dụng không chạy được trên máy của họ — nút chính đổi sang Zalo.

     Nội dung viết sẵn trong HTML, mỗi thiết bị một khối `[data-dlm-pane]`, JS
     chỉ chọn khối cần hiện. Muốn đổi câu chữ thì sửa thẳng trong index.html.

     Click chuột phải, Ctrl+click hay mở tab mới thì KHÔNG chặn: người dùng
     đang chủ động làm việc khác, chặn cả thì chỉ gây khó chịu chứ không thêm
     được thông tin nào cho họ. */
  (function downloadNotice() {
    var box = $('#dlm');
    if (!box) return;

    var RELEASE = 'https://github.com/Datkep92/HoaDonNhe/releases/latest';
    var GATEWAY = 'https://hoadon-support-gateway.linhnhaxac10.workers.dev/v1/landing/download';

    // `box` là lớp phủ, `dlg` là hộp thoại có tabindex="-1" — chỉ hộp thoại mới
    // nhận được focus, đưa focus nhầm vào lớp phủ thì không có tác dụng gì.
    var dlg = $('.dlm__box', box);
    var panes = $$('[data-dlm-pane]', box);
    var badgeEl = $('#dlm-badge'), titleEl = $('#dlm-t'), descEl = $('#dlm-d');
    var useEl = $('#dlm-ic').querySelector('use');
    var goBtn = $('#dlm-go'), goTxt = $('#dlm-go-t');
    var zaloBtn = $('#dlm-zalo'), zaloTxt = $('#dlm-zalo-t');
    var lastFocus = null, target = RELEASE, isOpen = false;

    /* Câu chữ theo từng trường hợp. `zaloFirst: true` nghĩa là trên máy này nút
       Zalo mới là hành động chính (điện thoại), nút tải lùi xuống nút phụ. */
    var COPY = {
      win: {
        badge: 'Máy tính Windows',
        icon: '#i-win',
        title: 'Cài đặt CN Tax Tools trên Windows',
        desc: 'Chỉ vài thao tác là xong — kể cả khi Windows hiện bảng cảnh báo xanh “Windows đã bảo vệ PC của bạn”.',
        go: 'Tải và cài đặt',
        zalo: 'Cài bị lỗi? Nhắn Zalo'
      },
      mobile: {
        badge: '',   // lấy theo hệ điều hành, xem mobileBadge()
        icon: '#i-info',
        title: 'Ứng dụng này chỉ chạy trên máy tính Windows',
        desc: 'Bạn đang xem trên điện thoại hoặc máy tính bảng. Tệp .exe tải về máy này cũng không mở được.',
        go: 'Tải tệp .exe về',
        zalo: 'Nhắn Zalo hỗ trợ',
        zaloFirst: true
      },
      other: {
        badge: 'Không phải máy tính Windows',
        icon: '#i-info',
        title: 'Máy này không chạy được ứng dụng Windows',
        desc: 'CN Tax Tools chỉ có bản cài cho Windows 10 / 11 – 64-bit. Tệp .exe không mở được trên máy này.',
        go: 'Tải tệp .exe về',
        zalo: 'Nhắn Zalo hỗ trợ'
      }
    };

    /* Nhận diện thiết bị → 'win' | 'mobile' | 'other'.

       Thứ tự có chủ đích:
       · Di động xét trước, và xét bằng UA — UA-CH (`navigator.userAgentData`)
         không có giá trị cho iPhone/iPad nên chỉ dựa vào nó sẽ bỏ sót.
       · Hệ điều hành thì ưu tiên UA-CH, thiếu mới đọc UA: Chrome trên Windows
         báo platform = "Windows" chính xác, còn UA thì dài dòng và hay bị rút gọn.
       · iPadOS từ 13 tự khai là "Macintosh", nên phải tính là iPad khi có chạm
         (maxTouchPoints > 1) — nếu không, khách xem bằng iPad sẽ nhận hướng
         dẫn cài Windows.
       · `pointer: coarse` làm chốt chặn cuối cho máy cảm ứng mà UA không nói
         rõ (điện thoại Android rút gọn UA, Windows Tablet...). */
    function detect() {
      var ua = (navigator.userAgent || '').toLowerCase();
      var data = navigator.userAgentData;
      var plat = String((data && data.platform) || navigator.platform || '').toLowerCase();
      var both = ua + ' ' + plat;
      var touch = (navigator.maxTouchPoints || 0) > 1;

      if ((touch && /macintosh/.test(ua)) ||
          /android|iphone|ipod|ipad|iemobile|blackberry|opera mini|windows phone|webos|kindle/.test(both)) return 'mobile';
      if (/windows/.test(plat)) return 'win';
      if (/mac/.test(plat)) return 'other';
      if (/windows|win32|win64/.test(ua)) return 'win';
      if (/macintosh|mac os x|macos/.test(ua)) return 'other';
      if (window.matchMedia('(pointer: coarse)').matches) return 'mobile';
      return 'other';
    }

    function mobileBadge() {
      var data = navigator.userAgentData;
      var s = ((navigator.userAgent || '') + ' ' +
               ((data && data.platform) || navigator.platform || '')).toLowerCase();
      if (/android/.test(s)) return 'Điện thoại / máy tính bảng Android';
      if (/iphone|ipod|ipad/.test(s)) return 'iPhone hoặc iPad';
      return 'Điện thoại hoặc máy tính bảng';
    }

    function focusables() {
      return $$('a[href], button:not([disabled])', box).filter(function (el) {
        return el.offsetParent !== null;   // khối panel đang ẩn thì nút bên trong không tính
      });
    }

    function open(kind, href) {
      var cfg = COPY[kind] || COPY.other;
      target = href || RELEASE;

      panes.forEach(function (pane) {
        pane.hidden = pane.getAttribute('data-dlm-pane') !== kind;
      });

      badgeEl.textContent = kind === 'mobile' ? mobileBadge() : cfg.badge;
      useEl.setAttribute('href', cfg.icon);
      titleEl.textContent = cfg.title;
      descEl.textContent = cfg.desc;
      goTxt.textContent = cfg.go;
      zaloTxt.textContent = cfg.zalo;
      goBtn.className = 'btn ' + (cfg.zaloFirst ? 'btn--ghost' : 'btn--primary');
      zaloBtn.className = 'btn ' + (cfg.zaloFirst ? 'btn--primary' : 'btn--ghost');

      lastFocus = document.activeElement;
      if (menuOpen) setMenu(false);     // không để menu trượt nằm đè lên hộp thoại
      isOpen = true;
      box.hidden = false;
      lockScroll(true);
      void box.offsetWidth;             // ép vẽ trạng thái mở để có hiệu ứng vào
      box.classList.add('is-open');
      // Đưa focus vào hộp thoại. Gọi thẳng, và gọi lại một nhịp sau: có trường
      // hợp trình duyệt trả focus về nút đã bấm (nút vốn đang có focus, ví dụ bấm
      // bằng bàn phím) và người dùng đọc hộp thoại bằng mắt trong khi screen
      // reader im lặng. Dùng setTimeout chứ không rAF — rAF bị treo khi tab ẩn.
      dlg.focus();
      window.setTimeout(function () { if (isOpen) dlg.focus(); }, 0);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      box.classList.remove('is-open');
      lockScroll(false);
      window.setTimeout(function () { if (!isOpen) box.hidden = true; }, REDUCED ? 0 : 300);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }

    /* Báo chủ trang biết có người tải thật. sendBeacon không chặn, không dính
       CORS preflight nên không làm mất lượt tải; Worker tự đọc quốc gia và thiết
       bị từ header của Cloudflare. Chỉ báo khi tải, không báo mỗi lần mở hộp
       thoại — nếu không thì số tin Telegram thành số lần bấm chứ không phải số
       lượt tải. */
    function report() {
      if (!navigator.sendBeacon) return;
      try {
        navigator.sendBeacon(GATEWAY, new Blob(
          [JSON.stringify({ page: window.location.pathname + window.location.hash })],
          { type: 'text/plain' }
        ));
      } catch (error) { /* im lặng — báo cáo hỏng không được phép làm hỏng lượt tải */ }
    }

    /* Bất cứ lần bấm nào cũng hiện cảnh báo: bắt ở thẻ gốc nên không phụ thuộc
       thứ tự đăng ký, và `data-install` (nút "Xem cách cài đặt" ở hero) cũng mở
       chung một hộp thoại. */
    document.addEventListener('click', function (event) {
      var el = event.target.closest ? event.target.closest('[data-dl], [data-install]') : null;
      if (!el) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      event.preventDefault();
      open(detect(), el.getAttribute('href') || RELEASE);
    });

    box.addEventListener('click', function (event) {
      if (event.target.closest('[data-dlm-close]')) close();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isOpen) { close(); return; }
      if (event.key !== 'Tab' || !isOpen) return;
      var list = focusables();
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      // Focus còn ở ngoài hộp thoại (nút đã bấm chưa nhường focus) thì kéo vào
      // luôn, không cho Tab lọt sang phần tử của trang.
      if (!box.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      // Tab hết vòng về phần tử đầu/cuối thì quay lại đầu/cuối — không bao giờ
      // đọc tràn ra ngoài hộp thoại.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    goBtn.addEventListener('click', function () {
      report();
      close();
      startDownload(target);
    });
  })();

  /* ----------------------------------------------------------------------
     6. Cuộn mượt tới anchor + đưa focus về đích
     ---------------------------------------------------------------------- */
  function headerOffset() { return (hdr ? hdr.offsetHeight : 0) + 14; }
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href');
    if (!id || id === '#') return;
    var target = document.getElementById(id.slice(1));
    if (!target) return;
    e.preventDefault();
    var top = target.getBoundingClientRect().top + window.pageYOffset - headerOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: REDUCED ? 'auto' : 'smooth' });
    target.setAttribute('tabindex', '-1');
    window.setTimeout(function () { target.focus({ preventScroll: true }); }, REDUCED ? 0 : 620);
    if (history.replaceState) history.replaceState(null, '', id);
  });

  /* ----------------------------------------------------------------------
     7. Reveal — luôn có lưới an toàn, không bao giờ ẩn vĩnh viễn
     ---------------------------------------------------------------------- */
  var revealables = $$('[data-rv]');
  function revealAll() { revealables.forEach(function (el) { el.classList.add('is-in'); }); }
  if (revealables.length) {
    if (REDUCED || !('IntersectionObserver' in window) || document.visibilityState === 'hidden') {
      revealAll();
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      revealables.forEach(function (el) { io.observe(el); });
    }
    window.setTimeout(revealAll, 5000);
  }

  /* ----------------------------------------------------------------------
     8. Đánh dấu mục đang xem
     ---------------------------------------------------------------------- */
  var sections = $$('main section[id]');
  var navLinks = $$('.nav a[href^="#"]');
  if (sections.length && navLinks.length && 'IntersectionObserver' in window) {
    var sio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        navLinks.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (s) { sio.observe(s); });
  }
})();
