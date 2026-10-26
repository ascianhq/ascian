/* Runtime wiring for the copied frontend. Addresses and links are not baked into the
   pages: they come from /api/site-config (Railway env), so a launch is one variable, not a
   rebuild. A value typed into the console wins over the server:
     localStorage.setItem("site.config", JSON.stringify({ token: "<mint address>" }))
   Otherwise the page would say "saved" and silently keep the server value. */
(function () {
  // The copied bundle has a placeholder address compiled in; we swap it in text and clipboard.
  var ZERO = "MINTNOTSETYET";
  // The built-in CSS easings are too soft. This is a strong ease-out: it starts at once
  // and settles gently, so the response is visible exactly when the eye is on it.
  var EASE_OUT = "cubic-bezier(.23,1,.32,1)";

  // A Solana mint is 44 characters, not 42, and it only ever appears once the token is live,
  // which is the one day nobody can afford a broken page. Measured on a 390px viewport with a
  // real mint in the config: the header grew to 434px and the page scrolled sideways. So the
  // header copy button is desktop-only (the address and its own Copy control are on the token
  // page anyway), and the address in the page body is allowed to break mid-string.
  (function () {
    var st = document.createElement("style");
    st.textContent =
      "@media (max-width:760px){.site-ca{display:none!important}}" +
      ".token-contract,.token-contract *{overflow-wrap:anywhere;word-break:break-word}" +
      // --faint (#64656b) is the colour of secondary labels and the footer address.
      // Measured: 3.15 on cards, 3.43 on the page, 3.53 in the footer, against 4.5 for
      // small text. #888a91 gives 4.52 on the lightest of the three and more on the rest,
      // same hue, so the look does not change and the reading does.
      ":root{--faint:#888a91}" +
      // Not one button in the copied bundle answers a press: its stylesheet has no
      // :active rule at all. A finger presses and nothing happens. Scale 0.97 answers at
      // once, and children scale with the button, so icons and text come along.
      ".button,.site-ca,[role=button],button{transition:transform 140ms " + EASE_OUT + "}" +
      ".button:active,.site-ca:active,[role=button]:active,button:active{transform:scale(.97)}" +
      // Reduced motion means less motion, not none: opacity and colour help explain what
      // happened, so they stay.
      "@media (prefers-reduced-motion:reduce){" +
      ".button:active,.site-ca:active,[role=button]:active,button:active{transform:none}" +
      "#site-toast,[data-sol-panel]{transition-property:opacity!important}}";
    (document.head || document.documentElement).appendChild(st);
  })();

  var cfg = { token: "", buyUrl: "", chartUrl: "", explorerUrl: "", lockUrl: "", xUrl: "", telegramUrl: "", supportUrl: "" };
  function local() { try { return JSON.parse(localStorage.getItem("site.config") || "{}"); } catch (e) { return {}; } }
  // Solana: base58, 32 to 44 characters. The EVM shape would pass a burn address as valid.
  var isAddr = function (a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || ""); };
  var short = function (a) { return a.slice(0, 6) + "…" + a.slice(-4); };

  // Their Copy buttons copy the address from a constant compiled into the bundle, which is
  // the zero address here. Swap it at the clipboard, and refuse before launch instead of
  // handing people a burn address.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function (t) {
      if (typeof t === "string" && t.indexOf(ZERO) >= 0) {
        if (!isAddr(cfg.token)) { toast("The contract is not deployed yet."); return Promise.reject(new Error("not launched")); }
        t = t.split(ZERO).join(cfg.token);
      }
      return orig(t);
    };
  }
  function toast(msg) { showToast(msg, 2200); }

  // One toast per page, called from both site.js and solana.js, so it lives here and
  // solana.js reaches the same element through window.
  function showToast(msg, hold) {
    var t = document.getElementById("site-toast"), fresh = !t;
    if (fresh) {
      t = document.createElement("div"); t.id = "site-toast";
      // Without this, "no wallet found" and "address copied" reach nobody using a screen
      // reader: the message appears and leaves without entering the accessibility tree.
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      t.setAttribute("aria-atomic", "true");
      // Centring already uses transform, so the entrance travels in the same declaration:
      // translate(-50%, 8px) rising, not a separate property.
      t.setAttribute("style", "position:fixed;left:50%;bottom:24px;z-index:2147483647;" +
        "padding:10px 16px;border-radius:10px;background:#18181b;border:1px solid #35373a;" +
        "color:#f2f0ec;font:500 13px/1.3 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);" +
        "pointer-events:none;opacity:0;transform:translate(-50%,8px);" +
        "transition:opacity 220ms " + EASE_OUT + ",transform 220ms " + EASE_OUT + ",filter 220ms " + EASE_OUT);
      document.body.appendChild(t);
      t.offsetHeight; // force the browser to see the start state, or there is no entrance
    }
    function show() {
      t.textContent = msg;
      t.style.opacity = "1"; t.style.transform = "translate(-50%,0)"; t.style.filter = "none";
      // The exit is faster than the entrance: the person decides slowly, the system answers fast.
      clearTimeout(t._h); t._h = setTimeout(function () {
        t.style.transition = "opacity 140ms " + EASE_OUT + ",transform 140ms " + EASE_OUT;
        t.style.opacity = "0"; t.style.transform = "translate(-50%,8px)";
      }, hold);
    }
    if (fresh || t.style.opacity !== "1") { t.style.transition = t.style.transition.replace(/140ms/g, "220ms"); return show(); }
    // The toast is already up and the text differs: swapping it in place shows two states
    // overlapping. A short blur stitches them into one movement.
    clearTimeout(t._h);
    t.style.filter = "blur(2px)"; t.style.opacity = ".6";
    setTimeout(show, 120);
  }
  window.siteToast = showToast;
  function copy(a) {
    (navigator.clipboard ? navigator.clipboard.writeText(a) : Promise.reject())
      .then(function () { toast("Contract address copied"); }, function () { toast("Copy failed. Select the address by hand: " + a); });
  }

  var LINKS = { "#buy": "buyUrl", "#chart": "chartUrl", "#explorer": "explorerUrl", "#lock": "lockUrl", "#x": "xUrl", "#telegram": "telegramUrl", "#support": "supportUrl" };
  var XICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

  function wire() {
    // Placeholder links: point them at the real URL, or stop being links while there is
    // none, so nothing on the page leads nowhere.
    // Hiding the whole element used to eat the words inside it and leave sentences like
    // "Watch and this page" or "verify it on .". A link with text keeps the text and
    // loses the href; an icon-only link, which has nothing to read, is hidden.
    document.querySelectorAll("a[href^='#']").forEach(function (a) {
      var h = a.getAttribute("href");
      // "#x/status/<id>" points at one post in their feed. Ours does not exist and there is
      // nothing to put there, so this link stays plain text for good.
      if (h.indexOf("#x/") === 0) { a.removeAttribute("href"); a.style.cursor = "default"; return; }
      var k = LINKS[h]; if (!k) return;
      var u = cfg[k];
      if (u) { a.setAttribute("href", u); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); a.dataset.site = k; a.style.display = ""; return; }
      a.dataset.siteHidden = k;
      // A button-shaped link with no address ("Buy on pump.fun", "Chart") is a call to
      // nowhere, so it is hidden. A link inside a sentence ("verify it on Solscan") drops
      // the address and keeps the words, or the sentence breaks: "verify it on ."
      var isBtn = /\bbutton\b/.test(a.className || "") || a.getAttribute("role") === "button";
      if (!isBtn && (a.textContent || "").trim()) { a.removeAttribute("href"); a.style.display = ""; a.style.cursor = "default"; }
      else { a.style.display = "none"; }
    });
    document.querySelectorAll("a[data-site-hidden]").forEach(function (a) {
      var u = cfg[a.dataset.siteHidden]; if (!u) return;
      a.setAttribute("href", u); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
      a.style.display = ""; a.style.cursor = "";
      a.dataset.site = a.dataset.siteHidden; a.removeAttribute("data-site-hidden");
    });
    // Zero address in text: the real one after launch, a plain sentence before.
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n, hits = [];
    while ((n = w.nextNode())) if (n.nodeValue.indexOf(ZERO) >= 0) hits.push(n);
    hits.forEach(function (t) { t.nodeValue = t.nodeValue.split(ZERO).join(isAddr(cfg.token) ? cfg.token : "not deployed yet"); });

    // Collabs (shared rooms) are not built on our server yet: hide the door and the tab
    // instead of leaving buttons that answer "in a later version".
    document.querySelectorAll("button, a, [role='tab']").forEach(function (el) {
      var t = (el.textContent || "").trim();
      if ((t === "Collab" || t === "Collabs") && el.style.display !== "none") el.style.display = "none";
    });

    var act = document.querySelector(".site-header__actions");
    if (act) {
      var ca = act.querySelector(".site-ca");
      if (isAddr(cfg.token) && !ca) {
        ca = document.createElement("button"); ca.type = "button"; ca.className = "token-ticker site-ca";
        ca.title = "Copy the contract address"; ca.setAttribute("aria-label", "Copy contract address " + cfg.token);
        ca.innerHTML = '<strong>CA</strong>&nbsp;<span style="font-family:ui-monospace,monospace;opacity:.85">' + short(cfg.token) + '</span>&nbsp;<span style="opacity:.6">copy</span>';
        ca.style.cursor = "pointer";
        ca.onclick = function (e) { e.preventDefault(); copy(cfg.token); };
        var tick = act.querySelector(".token-ticker");
        tick && tick.nextSibling ? act.insertBefore(ca, tick.nextSibling) : act.prepend(ca);
      }
      if (cfg.xUrl && !act.querySelector(".site-x")) {
        var x = document.createElement("a"); x.className = "button button--ghost site-x"; x.href = cfg.xUrl; x.target = "_blank"; x.rel = "noopener";
        x.setAttribute("aria-label", "X"); x.innerHTML = XICON; x.style.padding = "0 12px";
        var cta = act.querySelector(".header-app-cta"); cta ? act.insertBefore(x, cta) : act.appendChild(x);
      }
    }
    // Footer: an X link next to Telegram, since the original footer has none.
    if (cfg.xUrl) document.querySelectorAll("footer").forEach(function (f) {
      if (f.querySelector(".site-x-foot")) return;
      var tg = f.querySelector("a[data-site='telegramUrl'], a[data-site-hidden='telegramUrl']"); if (!tg) return;
      var x = tg.cloneNode(false); x.className = (tg.className || "") + " site-x-foot"; x.textContent = "X";
      x.href = cfg.xUrl; x.target = "_blank"; x.rel = "noopener"; x.style.display = ""; x.removeAttribute("data-site-hidden");
      tg.parentNode.insertBefore(x, tg.nextSibling);
    });
  }

  var pending = false;
  function later() { if (pending) return; pending = true; setTimeout(function () { pending = false; wire(); }, 60); }
  function start() {
    wire();
    // React re-renders the header and swaps pages on client navigation; re-apply after it.
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  }
  fetch("/api/site-config", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    .then(function (s) {
      var l = local();
      for (var k in cfg) cfg[k] = (l[k] != null && l[k] !== "" ? l[k] : s[k]) || "";
      window.siteConfig = cfg;
      // Touching the DOM before React hydrates makes it throw away the page (error 418).
      // React tags hydrated nodes with __reactFiber keys, so wait for those first.
      var t0 = Date.now();
      (function wait() {
        var h = document.querySelector("header, main, footer");
        var ready = h && Object.keys(h).some(function (k) { return k.indexOf("__reactFiber") === 0; });
        if (ready || Date.now() - t0 > 10000) start(); else setTimeout(wait, 100);
      })();
    });
})();

/* GitHub and X buttons in the header, before the $ASCIAN ticker. Added after hydration (the
   header is React's), re-added if React re-renders the header. GitHub always shows; X shows
   once an X link is set in the admin panel (site-config xUrl). */
(function () {
  var GH = "https://github.com/ascianhq/ascian";
  var IC = {
    gh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z"/></svg>'
  };
  function hydrated(el) { return el && Object.keys(el).some(function (k) { return k.indexOf("__react") === 0; }); }
  function add() {
    var acts = document.querySelector(".site-header__actions");
    if (!acts || !hydrated(acts) || acts.querySelector(".hdr-social")) return;
    var box = document.createElement("span"); box.className = "hdr-social";
    var x = (window.siteConfig || {}).xUrl;
    var html = "";
    if (x) html += '<a class="hdr-ico" href="' + x + '" target="_blank" rel="noreferrer" aria-label="Ascian on X">' + IC.x + "</a>";
    html += '<a class="hdr-ico" href="' + GH + '" target="_blank" rel="noreferrer" aria-label="Ascian on GitHub">' + IC.gh + "</a>";
    box.innerHTML = html;
    acts.insertBefore(box, acts.firstChild);
  }
  var tries = 0;
  (function wait() { add(); if (!document.querySelector(".hdr-social") && tries++ < 200) setTimeout(wait, 60); })();
  var pend = false;
  new MutationObserver(function () { if (pend) return; pend = true; setTimeout(function () { pend = false; add(); }, 120); })
    .observe(document.body, { childList: true, subtree: true });
})();

/* Launch state from the admin panel. A few labels were written into the build as "Soon"
   (the token page's launch row, the $ASCIAN card in the chat sidebar). Once a mint is set in
   the admin panel they switch to "Live" here, after hydration, and stay switched if React
   re-renders them. */
(function () {
  function hydrated() { var h = document.querySelector("header, main"); return h && Object.keys(h).some(function (k) { return k.indexOf("__react") === 0; }); }
  function live() { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test((window.siteConfig || {}).token || ""); }
  function apply() {
    if (!live() || !hydrated()) return;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n, hit = [];
    while ((n = w.nextNode())) {
      var t = n.nodeValue;
      if (t === "Soon on pump.fun") hit.push([n, "Live on pump.fun"]);
      else if (t === "Soon" && n.parentNode && n.parentNode.parentNode && /pump\.fun/.test(n.parentNode.parentNode.textContent || "") && (n.parentNode.parentNode.textContent || "").length < 60) hit.push([n, "Live"]);
      else if (t === "Soon" && n.parentNode && n.parentNode.closest && n.parentNode.closest('[class*="planHead"]')) hit.push([n, "Live"]);
    }
    hit.forEach(function (h) { h[0].nodeValue = h[1]; });
  }
  var tries = 0;
  (function wait() { apply(); if (tries++ < 150) setTimeout(wait, 100); })();
  var pend = false;
  new MutationObserver(function () { if (pend) return; pend = true; setTimeout(function () { pend = false; apply(); }, 150); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
})();
