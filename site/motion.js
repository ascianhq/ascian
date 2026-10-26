/* ascian motion layer, the DOM half. motion.css holds every start state; this file only
   flips classes and inserts the how-it-works flow, and it touches nothing until React has
   hydrated (touching it earlier throws the page away with error 418). */
(function () {
  var RM = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // The working surfaces (chat, account, sign-in) are for doing, not watching: no entrances there.
  function isApp() {
    return /^\/(chat|account|signin|wallet)(\/|$|@|\?)/.test(location.pathname) || !!document.querySelector("main [class*='ChatWorkspace']");
  }

  /* ---------- letters ---------- */
  // motion.css hides the h1 until it is split, with a safety reveal at 2.2 s. Splitting after
  // that would replay an animation over a headline that is already on screen, so past 2 s the
  // headline is simply marked done.
  var SAFETY_MS = 2000;
  // fresh: the headline arrived by client navigation just now, so its own safety clock has
  // only just started and the reveal can play.
  function split(h, fresh) {
    if (h.classList.contains("kw-split")) return;
    if (RM || isApp() || (!fresh && performance.now() > SAFETY_MS)) { h.classList.add("kw-split"); return; }
    var label = (h.innerText || h.textContent).replace(/\s+/g, " ").trim();
    var walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT), nodes = [], n;
    while ((n = walker.nextNode())) if (n.nodeValue.trim()) nodes.push(n);
    var k = 0;
    nodes.forEach(function (t) {
      var frag = document.createDocumentFragment();
      t.nodeValue.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
        var w = document.createElement("span"); w.className = "kw-w";
        for (var i = 0; i < part.length; i++) {
          var c = document.createElement("span"); c.className = "kw-ch"; c.textContent = part[i];
          c.style.setProperty("--k", Math.min(k++, 36));   // long headlines finish within ~0.9 s
          w.appendChild(c);
        }
        frag.appendChild(w);
      });
      t.parentNode.replaceChild(frag, t);
    });
    // Screen readers keep reading the heading as words, not as single letters.
    // innerText, not textContent: it honours the line break and skips the hidden caret.
    if (!h.hasAttribute("aria-label")) h.setAttribute("aria-label", label);
    h.classList.add("kw-split");
  }

  /* ---------- scroll reveal ---------- */
  var REVEAL = [
    ".ascian-section__head", ".stepper__head .ascian-lede", ".ascian-card", ".ascian-step", ".ascian-engine__stage",
    ".token-block", ".token-section .ascian-card", ".kw-flow__card", ".kw-flow__loop", "details",
    ".docs-prose > h2", ".docs-prose > p", ".footer__cta"
  ].join(",");
  var io = null;
  function reveal(root) {
    if (RM || isApp() || !("IntersectionObserver" in window)) return;
    if (!io) io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("kw-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    var groups = new Map();
    root.querySelectorAll(REVEAL).forEach(function (el) {
      if (el.classList.contains("kw-rv") || el.closest("header, nav, .site-header")) return;
      // siblings in one row arrive one after another, 70 ms apart
      var p = el.parentElement, i = groups.get(p) || 0; groups.set(p, i + 1);
      el.style.setProperty("--i", Math.min(i, 6));
      el.classList.add("kw-rv"); io.observe(el);
    });
  }

  /* ---------- glyphs ---------- */
  // Small line drawings, each one doing what its step does. 132 x 66, stroke only, the red
  // part is the thing that happens.
  var S = '<svg viewBox="0 0 132 66" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var G = {
    // a window with four rooms; the pointer comes in and picks one
    enter: S + '<rect x="6" y="6" width="84" height="54" rx="5" opacity=".55"/><path d="M6 16h84" opacity=".4"/><circle cx="12" cy="11" r="1.3" fill="currentColor" stroke="none" opacity=".6"/><circle cx="17" cy="11" r="1.3" fill="currentColor" stroke="none" opacity=".6"/>' +
      '<rect x="14" y="23" width="30" height="13" rx="2.5" opacity=".45"/><rect x="50" y="23" width="30" height="13" rx="2.5" opacity=".45"/><rect x="14" y="40" width="30" height="13" rx="2.5" opacity=".45"/>' +
      '<rect x="50" y="40" width="30" height="13" rx="2.5" class="r g-tap" fill="currentColor" fill-opacity=".18"/>' +
      '<g class="g-cursor"><path d="M62 44 L62 58 L66 54 L69 60 L71.5 59 L68.5 53 L74 53 Z" fill="#f2f0ec" stroke="#0e0f10" stroke-width="1"/></g></svg>',
    // three coins, one chosen; the amount slides along its track
    amount: S + '<circle cx="18" cy="20" r="10" opacity=".45"/><circle cx="42" cy="20" r="10" class="r g-sel" stroke-width="1.8"/><circle cx="66" cy="20" r="10" opacity=".45"/>' +
      '<path d="M8 50h96" opacity=".35"/><path d="M8 50h50" class="r g-fill" stroke-width="2.2"/><circle cx="12" cy="50" r="4.5" class="r g-knob" fill="#0e0f10" stroke-width="1.8"/></svg>',
    // a quote card: three lines settle while a scan line reads them, nothing sent yet
    quote: S + '<rect x="6" y="4" width="92" height="58" rx="5" opacity=".55"/><path d="M16 18h40" class="g-row"/><path d="M16 32h56" class="g-row d1"/><path d="M16 46h30" class="r g-row d2" stroke-width="2"/>' +
      '<path d="M84 18h6M84 32h6M84 46h6" opacity=".45"/><path d="M10 12h84" class="r g-scan" opacity=".35"/></svg>',
    // value flows in and the balance rises
    credits: S + '<path d="M6 33h34" opacity=".4"/><circle cx="12" cy="33" r="4" class="r g-pass" fill="currentColor" fill-opacity=".25"/><path d="M36 27l7 6-7 6" opacity=".6"/>' +
      '<rect x="52" y="8" width="54" height="50" rx="5" opacity=".55"/><rect x="62" y="34" width="8" height="18" rx="1.5" class="g-bar" fill="currentColor" fill-opacity=".25"/><rect x="75" y="26" width="8" height="26" rx="1.5" class="g-bar d1" fill="currentColor" fill-opacity=".25"/><rect x="88" y="18" width="8" height="34" rx="1.5" class="r g-bar d2" fill="currentColor" fill-opacity=".35"/></svg>',
    // a grid of models; the choice moves, then stays
    choose: S + '<rect x="6" y="6" width="22" height="16" rx="3" opacity=".45"/><rect x="34" y="6" width="22" height="16" rx="3" opacity=".45"/><rect x="62" y="6" width="22" height="16" rx="3" opacity=".45"/>' +
      '<rect x="6" y="28" width="22" height="16" rx="3" opacity=".45"/><rect x="34" y="28" width="22" height="16" rx="3" opacity=".45"/><rect x="62" y="28" width="22" height="16" rx="3" opacity=".45"/>' +
      '<rect x="3" y="3" width="28" height="22" rx="5" class="r g-hop" stroke-width="1.8"/></svg>',
    // messages go out; the balance steps down once per message, at the shown rate
    create: S + '<rect x="6" y="6" width="50" height="12" rx="6" class="g-msg" opacity=".8"/><rect x="22" y="24" width="54" height="12" rx="6" class="r g-msg d1"/><rect x="6" y="42" width="44" height="12" rx="6" class="g-msg d2" opacity=".8"/>' +
      '<rect x="96" y="6" width="14" height="50" rx="3" opacity=".45"/><rect x="99" y="9" width="8" height="44" rx="1.5" class="r g-step" fill="currentColor" fill-opacity=".3" stroke="none"/></svg>',
    // "What are you making?" panel, one per job tab
    chat: S + '<rect x="10" y="6" width="70" height="30" rx="8" opacity=".55"/><path d="M22 36l-6 10 14-10" opacity=".55"/>' +
      '<circle cx="34" cy="21" r="3" class="r g-dot" fill="currentColor" stroke="none"/><circle cx="45" cy="21" r="3" class="r g-dot d1" fill="currentColor" stroke="none"/><circle cx="56" cy="21" r="3" class="r g-dot d2" fill="currentColor" stroke="none"/>' +
      '<rect x="56" y="42" width="66" height="18" rx="7" class="g-msg d1" opacity=".8"/></svg>',
    code: S + '<path d="M30 18l-14 15 14 15" class="g-brl" stroke-width="2"/><path d="M102 18l14 15-14 15" class="g-brr" stroke-width="2"/>' +
      '<path d="M44 26h26" class="g-row" opacity=".7"/><path d="M44 34h40" class="g-row d1" opacity=".7"/><path d="M44 42h18" class="r g-row d2" stroke-width="2"/><path d="M66 38v8" class="r g-caret" stroke-width="2"/></svg>',
    image: S + '<rect x="20" y="4" width="92" height="58" rx="5" opacity=".55"/><circle cx="46" cy="24" r="6" class="r g-sun" fill="currentColor" fill-opacity=".3"/>' +
      '<path d="M20 54l26-22 18 14 16-12 32 22" opacity=".7"/><path d="M24 10h84" class="r g-scan" opacity=".3"/></svg>',
    video: S + '<g class="g-reel"><rect x="0" y="12" width="36" height="42" rx="3" opacity=".5"/><rect x="42" y="12" width="36" height="42" rx="3" class="r" fill="currentColor" fill-opacity=".15"/><rect x="84" y="12" width="36" height="42" rx="3" opacity=".5"/><rect x="126" y="12" width="36" height="42" rx="3" opacity=".5"/></g>' +
      '<path d="M6 6h120M6 60h120" opacity=".3" stroke-dasharray="3 5"/><path d="M57 26v14l12-7z" class="r" fill="currentColor" stroke="none"/></svg>',
    voice: S + '<rect x="18" y="26" width="6" height="14" rx="3" class="g-wave" fill="currentColor" fill-opacity=".35" stroke="none"/><rect x="30" y="18" width="6" height="30" rx="3" class="g-wave d1" fill="currentColor" fill-opacity=".35" stroke="none"/>' +
      '<rect x="42" y="10" width="6" height="46" rx="3" class="r g-wave d2" fill="currentColor" stroke="none"/><rect x="54" y="20" width="6" height="26" rx="3" class="g-wave d1" fill="currentColor" fill-opacity=".35" stroke="none"/><rect x="66" y="14" width="6" height="38" rx="3" class="r g-wave" fill="currentColor" stroke="none"/>' +
      '<rect x="78" y="24" width="6" height="18" rx="3" class="g-wave d2" fill="currentColor" fill-opacity=".35" stroke="none"/><rect x="90" y="18" width="6" height="30" rx="3" class="g-wave d1" fill="currentColor" fill-opacity=".35" stroke="none"/><rect x="102" y="27" width="6" height="12" rx="3" class="g-wave" fill="currentColor" fill-opacity=".35" stroke="none"/></svg>',
    // home: crypto drops into the balance
    fund: S + '<circle cx="40" cy="14" r="7" class="g-drop" opacity=".8"/><circle cx="62" cy="10" r="7" class="r g-drop d1"/><circle cx="84" cy="14" r="7" class="g-drop d2" opacity=".8"/>' +
      '<path d="M22 34h80l-6 24H28z" opacity=".55"/><path d="M50 34v-2h24v2" opacity=".5"/></svg>',
    // home: one balance becomes credit for many models
    convert: S + '<circle cx="18" cy="33" r="10" opacity=".55"/><circle cx="18" cy="33" r="4" class="r" fill="currentColor" fill-opacity=".3"/>' +
      '<path d="M32 33h20" opacity=".45"/><circle cx="34" cy="33" r="2.5" class="r g-pass" fill="currentColor"/>' +
      '<rect x="62" y="8" width="20" height="14" rx="3" opacity=".5"/><rect x="88" y="8" width="20" height="14" rx="3" opacity=".5"/><rect x="62" y="26" width="20" height="14" rx="3" class="r g-sel"/><rect x="88" y="26" width="20" height="14" rx="3" opacity=".5"/><rect x="62" y="44" width="20" height="14" rx="3" opacity=".5"/><rect x="88" y="44" width="20" height="14" rx="3" opacity=".5"/></svg>',
    // home: the work comes out as text, image and video
    ship: S + '<rect x="6" y="10" width="34" height="44" rx="4" class="g-msg" opacity=".8"/><path d="M12 20h20M12 28h16M12 36h22" class="g-msg" opacity=".6"/>' +
      '<rect x="48" y="10" width="34" height="44" rx="4" class="g-msg d1" opacity=".8"/><path d="M52 46l9-12 7 8 5-5 6 9" class="r g-msg d1"/>' +
      '<rect x="90" y="10" width="34" height="44" rx="4" class="g-msg d2" opacity=".8"/><path d="M103 24l10 8-10 8z" class="r g-msg d2" fill="currentColor" fill-opacity=".25"/></svg>'
  };

  /* ---------- how it works: the page's own six steps, drawn ---------- */
  // The steps come from the page's HowTo data (the same text the accordion holds), so the
  // drawing can never say something the page does not.
  function howSteps() {
    var out = null;
    document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
      try { var d = JSON.parse(s.textContent); (Array.isArray(d) ? d : [d]).forEach(function (x) { if (x && x["@type"] === "HowTo" && x.step) out = x.step; }); } catch (e) {}
    });
    return out;
  }
  var STEP_GLYPH = ["enter", "amount", "quote", "credits", "choose", "create"];

  // Working pieces of the product for the how-it-works steps and the job panel. Same look as
  // the home stages (.kw-ui); every loop is 6 s and driven by CSS.
  var TILE4 = function (labels, cls) { return '<div class="kw-ui__grid4 ' + (cls || "") + '"><b class="kw-ui__hop"></b>' + labels.map(function (l) { return "<span>" + l + "</span>"; }).join("") + "</div>"; };
  var OK = '<i class="kw-ui__ok"></i>';
  var UI = {
    enter: '<div class="kw-ui__head"><span>Workspace</span><em>new</em></div>' + TILE4(["Ask", "Code", "Images", "Video"], "kw-ui__grid4--enter") +
      '<div class="kw-ui__composer"><span>Ask anything</span><i></i></div>',
    amount: '<div class="kw-ui__head"><span>Fund balance</span><em>from your wallet</em></div>' +
      '<div class="kw-ui__coins kw-ui__coins--txt"><b class="kw-ui__sel"></b><span>USDT</span><span>BTC</span><span>ETH</span><span>SOL</span></div>' +
      '<div class="kw-ui__field"><span>Amount</span><em><i class="kw-ui__type">0.25 SOL</i><i class="kw-ui__caret"></i></em></div>',
    quote: '<div class="kw-ui__head"><span>Quote</span><em class="kw-ui__live"><i></i>live</em></div>' +
      '<div class="kw-ui__kv"><span>You send</span><b>0.25 SOL</b></div><div class="kw-ui__kv"><span>Network cost</span><i class="kw-ui__skel"></i></div>' +
      '<div class="kw-ui__kv"><span>Credits you get</span><i class="kw-ui__skel kw-ui__skel--2"></i></div>',
    credits: '<div class="kw-ui__head"><span>Balance</span><em>credits</em></div><div class="kw-ui__bal kw-ui__bal--in"><i></i></div>' +
      '<div class="kw-ui__status"><span class="kw-ui__s1"><i class="kw-ui__spin"></i>Deposit on its way</span><span class="kw-ui__s2">' + OK + "Credits added</span></div>" +
      '<div class="kw-ui__note">One balance for every model</div>',
    choose: '<div class="kw-ui__seg"><b class="kw-ui__segsel"></b><span>Recommended</span><span>Pick a model</span></div>' +
      '<div class="kw-ui__list"><b class="kw-ui__listsel"></b><span>Claude Sonnet 5.5</span><span>GPT-6.1 Sol</span><span>Gemini 3.7 Flash</span></div>',
    create: '<div class="kw-ui__chat"><span class="kw-ui__msg kw-ui__msg--me">Plan a launch week</span><span class="kw-ui__msg kw-ui__msg--ai"><i></i><i></i><i></i></span></div>' +
      '<div class="kw-ui__meter"><span>Balance</span><b class="kw-ui__bal kw-ui__bal--down"><i></i></b></div>',
    // job panel
    chat: '<div class="kw-ui__chat"><span class="kw-ui__msg kw-ui__msg--me">Summarise this thread</span><span class="kw-ui__msg kw-ui__msg--ai"><i></i><i></i><i></i></span></div>',
    code: '<div class="kw-ui__code"><i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i><i class="c5"></i></div>',
    image: '<div class="kw-ui__tiles kw-ui__tiles--one"><div class="kw-ui__tile kw-ui__tile--img"><span></span><b class="kw-ui__done"></b></div></div>',
    video: '<div class="kw-ui__tiles kw-ui__tiles--one"><div class="kw-ui__tile kw-ui__tile--vid"><span class="kw-ui__frames"><i></i><i></i><i></i><i></i></span><span class="kw-ui__play"></span><span class="kw-ui__prog"><i></i></span></div></div>',
    collab: '<div class="kw-ui__people"><i>A</i><i>M</i><i>K</i><span>one balance</span></div><div class="kw-ui__chat"><span class="kw-ui__msg kw-ui__msg--a">@ascian draft the brief</span><span class="kw-ui__msg kw-ui__msg--ai"><i></i><i></i></span></div>',
    voice: '<div class="kw-ui__wave">' + new Array(15).join(".").split(".").map(function (_, k) { return '<i style="--k:' + k + '"></i>'; }).join("") + "</div>",
  };
  function uiPiece(key, extra) { return '<div class="kw-ui kw-ui--sm ' + (extra || "") + ' kw-ui--' + key + '" aria-hidden="true">' + (UI[key] || "") + "</div>"; }

  function flow() {
    var st = document.querySelector(".stepper");
    if (!st || st.classList.contains("kw-flow-on")) return;
    var steps = howSteps(); if (!steps || steps.length < 2) return;
    var head = st.querySelector(".stepper__head"); if (!head) return;
    var sec = document.createElement("div"); sec.className = "kw-flow";
    var ol = document.createElement("ol"); ol.className = "kw-flow__grid";
    steps.forEach(function (s, i) {
      var li = document.createElement("li"); li.className = "kw-flow__card";
      li.innerHTML = '<div class="kw-flow__art">' + uiPiece(["enter", "amount", "quote", "credits", "choose", "create"][i] || "create") + '</div><span class="kw-flow__n">' + String(i + 1).padStart(2, "0") + "</span>";
      var h = document.createElement("h2"); h.textContent = s.name;
      var p = document.createElement("p"); p.textContent = s.text;
      li.appendChild(h); li.appendChild(p); ol.appendChild(li);
    });
    sec.appendChild(ol);
    var loop = document.createElement("p"); loop.className = "kw-flow__loop";
    loop.innerHTML = "<b>crypto</b> → quote → <b>credits</b> → model → <b>output</b>, from one balance";
    sec.appendChild(loop);
    head.parentNode.insertBefore(sec, head.nextSibling);
    st.classList.add("kw-flow-on");
  }

  /* ---------- home: a drawing on each funding card ---------- */
  // Home "Fund / Convert / Ship": small working pieces of the product instead of line drawings.
  // Coin and model marks are taken from the card's own icon row, so they are the real ones.
  function stageGlyphs() {
    document.querySelectorAll(".ascian-engine").forEach(function (eng) {
      eng.querySelectorAll(":scope > .ascian-engine__stage").forEach(function (stg, i) {
        if (i > 2 || stg.querySelector(".kw-ui")) return;
        var body = stg.querySelector(".ascian-engine__body"); if (!body) return;
        var marks = [].slice.call(stg.querySelectorAll(".ascian-engine__marks > span"));
        var mk = function (n) { return marks[n] ? marks[n].innerHTML : ""; };
        var ui = document.createElement("div"); ui.setAttribute("aria-hidden", "true");
        if (i === 0) {
          ui.className = "kw-ui kw-ui--fund";
          ui.innerHTML = '<div class="kw-ui__head"><span>Fund balance</span><em>Solana</em></div>' +
            '<div class="kw-ui__coins"><b class="kw-ui__sel"></b><span>' + mk(0) + '</span><span>' + mk(1) + '</span><span>' + mk(2) + '</span><span>' + mk(3) + '</span></div>' +
            '<div class="kw-ui__field"><span>Amount</span><em><i class="kw-ui__type">0.25 SOL</i><i class="kw-ui__caret"></i></em></div>' +
            '<div class="kw-ui__status"><span class="kw-ui__s1"><i class="kw-ui__spin"></i>Waiting for the transfer</span><span class="kw-ui__s2"><i class="kw-ui__ok"></i>Added to your balance</span></div>';
        } else if (i === 1) {
          ui.className = "kw-ui kw-ui--convert";
          var names = [].slice.call(stg.querySelectorAll(".ascian-engine__marks > span")).slice(0, 3).map(function (s) { return s.getAttribute("title") || ""; });
          ui.innerHTML = '<div class="kw-ui__head"><span>Balance</span><em>credits</em></div><div class="kw-ui__bal"><i></i></div>' +
            [0, 1, 2].map(function (n) { return '<div class="kw-ui__row kw-ui__row--' + n + '"><span class="kw-ui__logo">' + mk(n) + '</span><span class="kw-ui__nm">' + (names[n] || "Model") + '</span><span class="kw-ui__pill"><i></i></span></div>'; }).join("");
        } else {
          ui.className = "kw-ui kw-ui--ship";
          ui.innerHTML = '<div class="kw-ui__head"><span>Outputs</span><em>this session</em></div><div class="kw-ui__tiles">' +
            '<div class="kw-ui__tile kw-ui__tile--text"><i></i><i></i><i></i><i></i><b class="kw-ui__done"></b></div>' +
            '<div class="kw-ui__tile kw-ui__tile--img"><span></span><b class="kw-ui__done"></b></div>' +
            '<div class="kw-ui__tile kw-ui__tile--vid"><span class="kw-ui__play"></span><span class="kw-ui__prog"><i></i></span><b class="kw-ui__done"></b></div></div>';
        }
        body.appendChild(ui);
        stg.classList.add("kw-has-ui");
      });
    });
  }


  // "What are you making?": a pictogram for the chosen job, and the panel content slides in
  // again when the tab changes (React swaps the text in place, so a class is re-triggered).
  var JOBS = [["chat", /chat|research|text/i], ["code", /code|web/i], ["image", /image/i], ["video", /video/i], ["voice", /voice|audio/i]];
  function jobPanel() {
    document.querySelectorAll(".job-panel").forEach(function (p) {
      var tab = p.parentElement && p.parentElement.querySelector(".job-tab.is-active");
      var name = tab ? tab.textContent : "";
      var key = "chat";
      for (var i = 0; i < JOBS.length; i++) if (JOBS[i][1].test(name)) { key = JOBS[i][0]; break; }
      var g = p.querySelector(":scope > .kw-job-glyph");
      if (!g) { g = document.createElement("div"); g.className = "kw-job-glyph"; g.setAttribute("aria-hidden", "true"); p.appendChild(g); p.classList.add("kw-job-on"); }
      if (g.getAttribute("data-k") !== key) {
        g.setAttribute("data-k", key); g.innerHTML = uiPiece(key);
        if (p.getAttribute("data-kw-seen")) { p.classList.remove("kw-swap"); void p.offsetWidth; p.classList.add("kw-swap"); }
        p.setAttribute("data-kw-seen", "1");
      }
    });
  }

  // Workspace door tiles: the job's own piece at the bottom of each tile.
  function doorTiles() {
    var keys = { ask: "chat", code: "code", images: "image", video: "video", collab: "collab" };
    document.querySelectorAll('[class*="__doorGrid"] > [class*="__doorTile"]').forEach(function (t) {
      if (t.querySelector(":scope > .kw-ui")) return;
      var name = (t.querySelector("strong") || {}).textContent || "";
      var key = keys[name.trim().toLowerCase()]; if (!key) return;
      t.insertAdjacentHTML("beforeend", uiPiece(key));
      t.classList.add("kw-door");
    });
  }

  // Workspace door tiles: Phosphor duotone icons (MIT, phosphoricons.com) in a glass chip.
  // The tile's own icon is hidden, not removed (React owns it); the big background icon is hidden by CSS.
  var DOOR_IC = {"ask": "<path d=\"M224,124h0a92,92,0,0,1-92,92H48a8,8,0,0,1-8-8V124a92,92,0,0,1,92-92h0A92,92,0,0,1,224,124Z\" class=\"kw-ic__fill\"/><path d=\"M132,24A100.11,100.11,0,0,0,32,124v84a16,16,0,0,0,16,16h84a100,100,0,0,0,0-200Zm0,184H48V124a84,84,0,1,1,84,84Zm12-80a12,12,0,1,1-12-12A12,12,0,0,1,144,128Zm-44,0a12,12,0,1,1-12-12A12,12,0,0,1,100,128Zm88,0a12,12,0,1,1-12-12A12,12,0,0,1,188,128Z\"/>", "code": "<path d=\"M224,56V200a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V56a8,8,0,0,1,8-8H216A8,8,0,0,1,224,56Z\" class=\"kw-ic__fill\"/><path d=\"M128,128a8,8,0,0,1-3,6.25l-40,32a8,8,0,1,1-10-12.5L107.19,128,75,102.25a8,8,0,1,1,10-12.5l40,32A8,8,0,0,1,128,128Zm48,24H136a8,8,0,0,0,0,16h40a8,8,0,0,0,0-16Zm56-96V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,200V56H40V200H216Z\"/>", "images": "<path d=\"M216,112v24a16,16,0,0,1-16,16H152a8,8,0,0,0-7.92,9.13L152,208a24,24,0,0,1-48,0l7.92-46.87A8,8,0,0,0,104,152H56a16,16,0,0,1-16-16V112Z\" class=\"kw-ic__fill\"/><path d=\"M216,24H72A40,40,0,0,0,32,64v72a24,24,0,0,0,24,24h48l-7.89,46.67A8.42,8.42,0,0,0,96,208a32,32,0,0,0,64,0,8.42,8.42,0,0,0-.11-1.33L152,160h48a24,24,0,0,0,24-24V32A8,8,0,0,0,216,24ZM72,40H176V80a8,8,0,0,0,16,0V40h16v64H48V64A24,24,0,0,1,72,40ZM200,144H152a16,16,0,0,0-15.84,18.26l0,.2L144,208.6a16,16,0,0,1-32,0l7.8-46.14,0-.2A16,16,0,0,0,104,144H56a8,8,0,0,1-8-8V120H208v16A8,8,0,0,1,200,144Z\"/>", "video": "<path d=\"M67.71,64.59l47.79,27.6L40.43,112,32.27,82a7.76,7.76,0,0,1,5.58-9.52ZM199.84,37.76a7.9,7.9,0,0,0-9.66-5.49L126.61,49.05,174.4,76.64,208,67.77Z\" class=\"kw-ic__fill\"/><path d=\"M216,104H102.09L210,75.51a8,8,0,0,0,5.68-9.84l-8.16-30a15.93,15.93,0,0,0-19.42-11.13L35.81,64.74a15.75,15.75,0,0,0-9.7,7.4,15.51,15.51,0,0,0-1.55,12L32,111.56c0,.14,0,.29,0,.44v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V112A8,8,0,0,0,216,104ZM192.16,40l6,22.07-22.62,6L147.42,51.83Zm-66.69,17.6,28.12,16.24-36.94,9.75L88.53,67.37Zm-79.4,44.62-6-22.08,26.5-7L94.69,89.4ZM208,200H48V120H208v80Z\"/>", "collab": "<path d=\"M168,144a40,40,0,1,1-40-40A40,40,0,0,1,168,144ZM64,56A32,32,0,1,0,96,88,32,32,0,0,0,64,56Zm128,0a32,32,0,1,0,32,32A32,32,0,0,0,192,56Z\" class=\"kw-ic__fill\"/><path d=\"M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1,0-16,24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.85,8,57,57,0,0,0-98.15,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z\"/>"};
  function doorIcons() {
    document.querySelectorAll('[class*="__doorTile"] [class*="__doorIcon"]').forEach(function (ic) {
      if (ic.querySelector(".kw-ic")) return;
      var t = ic.closest('[class*="__doorTile"]');
      // the workspace hydrates later than the header; touching it before that is React error 418
      if (!Object.keys(t).some(function (k) { return k.indexOf("__react") === 0; })) {
        if ((doorIcons.n = (doorIcons.n || 0) + 1) < 100 && !doorIcons.t) doorIcons.t = setTimeout(function () { doorIcons.t = 0; doorIcons(); }, 120);
        return;
      }
      var key = ((t.querySelector("strong") || {}).textContent || "").trim().toLowerCase();
      if (!DOOR_IC[key]) return;
      ic.insertAdjacentHTML("beforeend", '<svg class="kw-ic" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">' + DOOR_IC[key] + "</svg>");
      ic.classList.add("kw-ic-on");
    });
  }

  function apply(fresh) {
    document.querySelectorAll("main h1:not(.asc-h1)").forEach(function (h) { split(h, fresh); });
    flow(); stageGlyphs(); jobPanel(); doorIcons(); reveal(document);
  }

  var pending = false;
  function later() { if (pending) return; pending = true; setTimeout(function () { pending = false; apply(true); }, 40); }
  (function wait(t0) {
    var h = document.querySelector("header, main, footer");
    var ready = h && Object.keys(h).some(function (k) { return k.indexOf("__reactFiber") === 0; });
    if (ready || performance.now() - t0 > 10000) {
      apply(false);
      // client navigation swaps the page body; apply again to whatever arrives
      new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
      // a job tab only changes text and classes, which the observer above does not see
      document.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".job-tab")) setTimeout(jobPanel, 0);
      });
    } else setTimeout(function () { wait(t0); }, 16);
  })(performance.now());
})();
