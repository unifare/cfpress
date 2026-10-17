/* 手记 · blog behaviors: theme, nav, progress, TOC, search */
(function () {
  "use strict";

  var root = document.documentElement;

  /* ---------- theme ---------- */
  function applyTheme(t, animate) {
    root.setAttribute("data-theme", t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t === "dark" ? "#0a0a0a" : "#ffffff");
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.setAttribute("aria-label", t === "dark" ? "切换到浅色模式" : "切换到深色模式");
      if (animate) {
        b.classList.remove("pop");
        void b.offsetWidth;
        b.classList.add("pop");
        setTimeout(function () { b.classList.remove("pop"); }, 440);
      }
    });
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("od-theme"); } catch (e) {}
    applyTheme(saved || "dark");
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.addEventListener("click", function () {
        var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
        applyTheme(next, true);
        try { localStorage.setItem("od-theme", next); } catch (e) {}
      });
    });
  }

  /* ---------- mobile nav ---------- */
  function initNav() {
    var btn = document.querySelector("[data-nav-toggle]");
    var links = document.querySelector("[data-nav-links]");
    if (!btn || !links) return;
    btn.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") links.classList.remove("open");
    });
  }

  /* ---------- reading progress ---------- */
  function initProgress() {
    var bar = document.querySelector("[data-progress]");
    var article = document.querySelector("[data-article]");
    if (!bar || !article) return;
    var rail = bar.parentElement;
    rail.hidden = false;
    function update() {
      var rect = article.getBoundingClientRect();
      var total = rect.height - window.innerHeight;
      var scrolled = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
      var pct = total > 0 ? (scrolled / total) * 100 : 100;
      bar.style.width = pct.toFixed(1) + "%";
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
  }

  /* ---------- TOC active state ---------- */
  function initTOC() {
    var toc = document.querySelector("[data-toc]");
    if (!toc || !("IntersectionObserver" in window)) return;
    var links = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    if (!links.length) return;
    var map = {};
    var heads = [];
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute("href").slice(1));
      if (el) { map[el.id] = a; heads.push(el); }
    });
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting ? en.boundingClientRect.top : null; });
      var active = null;
      heads.forEach(function (h) { if (visible[h.id] !== null && visible[h.id] !== void 0 && visible[h.id] < 140) active = h.id; });
      links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + active); });
    }, { rootMargin: "-72px 0px -70% 0px", threshold: [0, 1] });
    heads.forEach(function (h) { io.observe(h); });
  }

  /* ---------- search ---------- */
  function initSearch() {
    var input = document.querySelector("[data-search-input]");
    if (!input) return;
    var list = document.querySelector("[data-search-results]");
    var countEl = document.querySelector("[data-search-count]");
    var emptyEl = document.querySelector("[data-search-empty]");
    var posts = window.OD_POSTS || [];
    var tagRow = document.querySelector("[data-search-tags]");

    function render(q) {
      var query = (q || "").trim().toLowerCase();
      var words = query ? query.split(/\s+/) : [];
      var hits = posts.filter(function (p) {
        if (!words.length) return true;
        var hay = (p.title + " " + p.excerpt + " " + p.tags.join(" ") + " " + p.category).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) !== -1; });
      });
      list.innerHTML = hits.map(function (p) {
        return '<article class="post-item" data-od-id="search-result">' +
          '<div class="date">' + p.date + '</div>' +
          '<div><h3><a href="' + p.href + '">' + p.title + '</a></h3>' +
          '<p>' + p.excerpt + '</p>' +
          '<div class="meta">' + p.tags.map(function (t) { return '<span>#' + t + '</span>'; }).join("") + '<span>· ' + p.read + ' 分钟</span></div></div>' +
          '<a class="arrow" href="' + p.href + '">→</a></article>';
      }).join("");
      if (countEl) countEl.textContent = query ? '找到 ' + hits.length + ' 篇' : '共 ' + posts.length + ' 篇';
      if (emptyEl) emptyEl.hidden = hits.length !== 0;
    }

    render("");
    input.addEventListener("input", function () { render(input.value); });

    if (tagRow) {
      tagRow.addEventListener("click", function (e) {
        var a = e.target.closest("[data-q]");
        if (!a) return;
        input.value = a.getAttribute("data-q");
        render(input.value);
        input.focus();
      });
    }

    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); input.focus();
      }
    });
  }

  /* ---------- scroll reveal (timeline fade-up) ---------- */
  function initReveal() {
    var groups = document.querySelectorAll("[data-reveal]");
    if (!groups.length || !("IntersectionObserver" in window)) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    Array.prototype.forEach.call(groups, function (group) {
      var items = Array.prototype.slice.call(group.children);
      items.forEach(function (el, i) {
        el.classList.add("reveal");
        el.style.transitionDelay = Math.min(i * 60, 360) + "ms";
      });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            items.forEach(function (el) { el.classList.add("in"); });
            io.disconnect();
          }
        });
      }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
      io.observe(group);
    });
  }

  /* ---------- live clock ---------- */
  function initClock() {
    var els = document.querySelectorAll("[data-clock]");
    if (!els.length) return;
    function tick() {
      var d = new Date();
      var s = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2);
      Array.prototype.forEach.call(els, function (el) { el.textContent = s; });
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- background fx (innei 式：鼠标跟随光晕 + 漂移微粒 + 连线) ---------- */
  function initFx() {
    var canvas = document.getElementById("bg-fx");
    if (!canvas || !canvas.getContext) return;
    var toggle = document.querySelector("[data-fx-toggle]");
    var fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
    var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var saved = null;
    try { saved = localStorage.getItem("od-fx"); } catch (e) {}
    var on = saved !== null ? saved === "1" : (fine && !calm);
    var ctx = canvas.getContext("2d");
    var W = 0, H = 0, parts = [], raf = 0;
    var mx = -9999, my = -9999, gx = -9999, gy = -9999;
    var ring = null, rx = -9999, ry = -9999;
    function ensureFxEls() {
      if (ring || !fine || calm) return;
      ring = document.createElement("div");
      ring.id = "cursor-ring";
      ring.setAttribute("aria-hidden", "true");
      document.body.appendChild(ring);
      document.addEventListener("mouseover", function (e) {
        if (!ring) return;
        var t = e.target && e.target.closest ? e.target.closest("a,button") : null;
        ring.classList.toggle("hot", !!t);
      });
    }
    function label() { if (toggle) toggle.textContent = on ? "背景特效 · 开" : "背景特效 · 关"; }
    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function dark() { return root.getAttribute("data-theme") === "dark"; }
    function seed() {
      parts = [];
      var n = Math.max(24, Math.min(90, Math.floor(W * H / 22000)));
      for (var i = 0; i < n; i++) {
        parts.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
          r: 0.8 + Math.random() * 1.8, ci: (Math.random() * 3) | 0 });
      }
    }
    function frame() {
      ctx.clearRect(0, 0, W, H);
      var d = dark(), i, j, p, q, dx, dy, dist;
      if (gx < -9000) {
        if (mx > -9000) { gx = mx; gy = my; }
      } else if (mx > -9000) {
        gx += (mx - gx) * 0.08;
        gy += (my - gy) * 0.08;
      } else {
        gx = gy = -9999;
      }

      if (ring) {
        if (rx < -9000) { rx = mx; ry = my; }
        else { rx += (mx - rx) * 0.16; ry += (my - ry) * 0.16; }
        ring.classList.toggle("on", mx > -9000);
        var rs = ring.offsetWidth || 26;
        ring.style.transform = "translate(" + (rx - rs / 2) + "px," + (ry - rs / 2) + "px)";
      }

      var hasSpotlight = gx > -9000;
      if (hasSpotlight) {
        var g = ctx.createRadialGradient(gx, gy, 0, gx, gy, 280);
        g.addColorStop(0, d ? "rgba(255,214,10,.12)" : "rgba(138,109,0,.08)");
        g.addColorStop(0.5, d ? "rgba(255,214,10,.05)" : "rgba(138,109,0,.03)");
        g.addColorStop(1, "rgba(255,214,10,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(gx, gy, 280, 0, 6.2832);
        ctx.fill();
      }

      var spotAlphas = [];
      for (i = 0; i < parts.length; i++) {
        p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (hasSpotlight) {
          dx = p.x - gx; dy = p.y - gy; dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 160 && dist > 1) { p.x += (dx / dist) * 0.6; p.y += (dy / dist) * 0.6; }
          spotAlphas[i] = dist < 280 ? Math.max(0, 1 - dist / 280) : 0;
        } else {
          spotAlphas[i] = 0;
        }
        if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
        if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;

        if (spotAlphas[i] > 0.02) {
          var a = spotAlphas[i];
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832);
          ctx.fillStyle = p.ci === 1
            ? (d ? "rgba(255,107,53," + (0.75 * a).toFixed(3) + ")" : "rgba(194,65,12," + (0.55 * a).toFixed(3) + ")")
            : p.ci === 2
            ? (d ? "rgba(255,255,255," + (0.75 * a).toFixed(3) + ")" : "rgba(24,24,27," + (0.6 * a).toFixed(3) + ")")
            : (d ? "rgba(255,214,10," + (0.8 * a).toFixed(3) + ")" : "rgba(138,109,0," + (0.55 * a).toFixed(3) + ")");
          ctx.fill();
        }
      }

      if (hasSpotlight) {
        ctx.lineWidth = 1;
        for (i = 0; i < parts.length; i++) {
          if (spotAlphas[i] <= 0.02) continue;
          for (j = i + 1; j < parts.length; j++) {
            if (spotAlphas[j] <= 0.02) continue;
            p = parts[i]; q = parts[j];
            dx = p.x - q.x; dy = p.y - q.y;
            if (dx > 110 || dx < -110 || dy > 110 || dy < -110) continue;
            dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 110) {
              var la = Math.min(spotAlphas[i], spotAlphas[j]) * (d ? 0.22 : 0.18);
              ctx.strokeStyle = d ? "rgba(255,214,10," + la.toFixed(3) + ")" : "rgba(138,109,0," + la.toFixed(3) + ")";
              ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
            }
          }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    function start() { ensureFxEls(); resize(); seed(); if (!raf) raf = requestAnimationFrame(frame); label(); }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; ctx.clearRect(0, 0, W, H); if (ring) ring.classList.remove("on", "hot"); label(); }
    window.addEventListener("resize", function () { if (on) { resize(); seed(); } });
    window.addEventListener("pointermove", function (e) { mx = e.clientX; my = e.clientY; }, { passive: true });
    document.addEventListener("mouseleave", function () { mx = my = gx = gy = -9999; });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; }
      else if (on && !raf) raf = requestAnimationFrame(frame);
    });
    if (toggle) toggle.addEventListener("click", function () {
      on = !on;
      try { localStorage.setItem("od-fx", on ? "1" : "0"); } catch (e) {}
      if (on) start(); else stop();
    });
    if (on) start(); else label();
  }

  window.ODBlog = { applyTheme: applyTheme };

  document.addEventListener("DOMContentLoaded", function () {
    initTheme(); initNav(); initProgress(); initTOC(); initSearch(); initReveal(); initClock(); initFx();
  });
})();
