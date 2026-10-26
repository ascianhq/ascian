/* Ascian home hero: Fromzero's poster, preloader and WebGL valley (public domain, GetLayers),
   mounted into the home page after React has hydrated it. The old hero stays in the HTML for
   crawlers and is hidden; the scene module loads only here. */
(function () {
  "use strict";
  var REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SPRING = { mass: 1, tension: 46, friction: 24 };
  var GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>[]{}/=+*#";
  var LINES = ["Ask every AI model", "Pay with crypto"];
  var ARROW = '<svg viewBox="0 0 19 19" aria-hidden="true"><path d="M6.49963 19L5.57294 18.0733L14.1466 9.49968L5.57363 0.926697L6.50032 0L16 9.49968L6.49963 19Z"/></svg>';

  /* --- one rAF, many springs --- */
  var springs = [], running = false;
  function stepAll(now) {
    // Wall-clock springs: integrate the real elapsed time in 1/120 s steps, so a slow frame
    // (a scene compiling its shaders) never stretches the motion.
    var el = Math.min(0.25, (now - (stepAll.t || now)) / 1000); stepAll.t = now;
    var steps = Math.max(1, Math.ceil(el / (1 / 120))), dt = el / steps;
    for (var i = springs.length - 1; i >= 0; i--) {
      var s = springs[i];
      if (now < s.start) continue;
      var done = true;
      for (var n = 0; n < steps; n++) for (var k = 0; k < s.x.length; k++) {
        var a = (-s.c.tension * (s.x[k] - s.to[k]) - s.c.friction * s.v[k]) / s.c.mass;
        s.v[k] += a * dt; s.x[k] += s.v[k] * dt;
      }
      for (k = 0; k < s.x.length; k++) if (Math.abs(s.v[k]) > 0.001 || Math.abs(s.x[k] - s.to[k]) > 0.001) done = false;
      if (done) { s.x = s.to.slice(); }
      s.apply(s.x);
      if (done) { springs.splice(i, 1); s.end && s.end(); }
    }
    if (springs.length) requestAnimationFrame(stepAll); else { running = false; stepAll.t = 0; }
  }
  function spring(from, to, cfg, delay, apply, end) {
    if (REDUCED) { apply(to); end && end(); return; }
    springs.push({ x: from.slice(), v: from.map(function () { return 0; }), to: to, c: cfg, start: performance.now() + (delay || 0), apply: apply, end: end });
    apply(from);
    if (!running) { running = true; requestAnimationFrame(stepAll); }
  }

  function reveal(el, delay, kind) {
    if (!el) return;
    if (kind === "rule") {
      spring([0, 0.3], [1, 1], SPRING, delay, function (x) { el.style.opacity = x[0]; el.style.transform = "scaleX(" + x[1] + ")"; });
      return;
    }
    var y0 = kind === "drop" ? -14 : 22, b0 = kind === "drop" ? 6 : 8;
    spring([0, y0, b0], [1, 0, 0], SPRING, delay, function (x) {
      el.style.opacity = x[0];
      el.style.transform = "translateY(" + x[1].toFixed(2) + "px)";
      el.style.filter = x[2] > 0.05 ? "blur(" + x[2].toFixed(2) + "px)" : "";
    }, function () { el.style.transform = ""; el.style.filter = ""; });
  }

  /* --- left-to-right decode of the headline --- */
  function scramble(h1) {
    var spans = h1.querySelectorAll("span"), cells = [], i = 0;
    spans.forEach(function (sp) {
      var t = sp.textContent; sp.textContent = "";
      for (var j = 0; j < t.length; j++) {
        var c = document.createElement("i"); c.style.fontStyle = "normal"; c.textContent = t[j];
        sp.appendChild(c);
        if (t[j] !== " ") cells.push({ el: c, ch: t[j].toUpperCase(), at: (i++) * 42 + 260 });
      }
    });
    if (REDUCED) return;
    var t0 = performance.now(), lastSwap = 0;
    (function tick(now) {
      var el = now - t0, live = false, swap = now - lastSwap > 33;
      if (swap) lastSwap = now;
      for (var k = 0; k < cells.length; k++) {
        var c = cells[k];
        if (el >= c.at) { if (!c.done) { c.el.textContent = c.ch; c.done = true; } continue; }
        live = true;
        if (swap) c.el.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      if (live) requestAnimationFrame(tick);
    })(t0);
  }

  /* --- preloader: the curtain is drawn by CSS pseudo-elements from the first paint (hero.css,
     html.asc-pre-on), because nothing may be added to the DOM before React hydrates. The
     counter runs 00 to 100 in 1.9 s in CSS; here we wait for it, then spring the curtain up. --- */
  function preloader() {
    var html = document.documentElement;
    if (!html.classList.contains("asc-pre-on")) return Promise.resolve();
    var t0 = window.__ascPre || 0, left = Math.max(0, t0 + 1900 - performance.now());
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve();
        var vh = innerHeight;
        spring([0], [-100], { mass: 1, tension: 90, friction: 20 }, 0, function (x) {
          html.style.setProperty("--asc-up", (x[0] / 100 * vh).toFixed(1) + "px");
        }, function () { html.classList.remove("asc-pre-on"); html.style.removeProperty("--asc-up"); });
      }, left);
    });
  }

  function build(stage) {
    var hero = document.createElement("div");
    hero.className = "asc-hero";
    hero.innerHTML =
      '<div class="asc-fallback"></div>' +
      '<canvas class="asc-canvas" role="img" aria-label="A screen floating over a night valley lake: a question is typed, sent to an AI model, and the answer streams in. Lines of API code drift around it."></canvas>' +
      '<div class="asc-poster"><div class="asc-grad"></div><div class="asc-bottom">' +
        '<div class="asc-row"><div class="asc-left"><i class="asc-rule" data-asc="rule1"></i>' +
          '<h1 class="asc-h1" data-asc="h1" aria-label="' + LINES.join(". ") + '."><span aria-hidden="true">' + LINES[0] + '</span><span aria-hidden="true">' + LINES[1] + '</span></h1></div>' +
        '<div class="asc-right"><i class="asc-rule" data-asc="rule2"></i>' +
          '<p class="asc-desc" data-asc="desc">Chat, code, images and video from every major model, paid from one balance you fund with the crypto in your wallet. No subscription, no card.</p>' +
          '<a class="asc-cta" data-asc="cta" href="/chat"><span>Start asking</span><b>' + ARROW + '</b></a>' +
        '</div></div>' +
      '</div></div>';
    stage.insertBefore(hero, stage.firstChild);
    stage.classList.add("asc-on");
    // The old hero keeps rendering underneath; stop its video so it costs nothing.
    stage.querySelectorAll("video").forEach(function (v) { try { v.pause(); v.preload = "none"; } catch (e) {} });
    return hero;
  }

  function start(hero) {
    var q = function (k) { return hero.querySelector('[data-asc="' + k + '"]'); };
    hero.classList.add("is-revealed");
    var header = document.querySelector(".site-header");
    if (header && !REDUCED) reveal(header, 100, "drop");
    reveal(q("h1"), 120); scramble(q("h1"));
    reveal(q("rule1"), 340, "rule");
    reveal(q("rule2"), 400, "rule");
    reveal(q("desc"), 560);
    reveal(q("cta"), 680);
  }

  function scene(hero) {
    var canvas = hero.querySelector(".asc-canvas");
    var gl = null;
    try { gl = canvas.getContext("webgl2") || canvas.getContext("webgl"); } catch (e) {}
    if (!gl) { hero.classList.add("is-fallback"); return; }
    // a context taken here would be the one three.js gets; release the probe
    var lose = gl.getExtension && gl.getExtension("WEBGL_lose_context"); if (lose) lose.loseContext();
    var fresh = canvas.cloneNode(true); canvas.replaceWith(fresh); canvas = fresh;
    import("/hero/scene.js?v=4").then(function (m) { return m.mountScene(canvas, "/hero/"); }).then(function (dispose) {
      hero._dispose = dispose;
      spring([0], [1], { mass: 1, tension: 120, friction: 26 }, 0, function (x) { canvas.style.opacity = x[0]; });
    }).catch(function (e) { console.error("[ascian-hero]", e); hero.classList.add("is-fallback"); });
  }

  function mount() {
    if (location.pathname !== "/") return;
    var stage = document.querySelector("main > section.ascian-stage");
    if (!stage || stage.querySelector(".asc-hero")) return;
    var hero = build(stage);
    scene(hero);
    preloader().then(function () { start(hero); });
  }

  function hydrated() {
    var el = document.querySelector("main") || document.body;
    return Object.keys(el).some(function (k) { return k.indexOf("__react") === 0; });
  }
  (function wait(n) {
    if (hydrated() || n > 200) { mount(); new MutationObserver(function () { if (location.pathname === "/") mount(); }).observe(document.body, { childList: true, subtree: true }); return; }
    setTimeout(function () { wait(n + 1); }, 25);
  })(0);
})();
