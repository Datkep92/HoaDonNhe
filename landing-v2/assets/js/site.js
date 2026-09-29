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
