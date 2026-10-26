/* Solana layer for the copied frontend. The compiled bundle still carries the EVM wiring
   (chain list, eip155, addEthereumChain) from the site this was copied from, and that cannot
   be rewritten inside a minified Next chunk. So the connect buttons are taken over here:
   the old handler never runs, and everything below talks to Solana only.

   What it does: connects Phantom or Solflare, reads the ASCIAN balance from the mint in
   site.config, works out the discount band from the share of supply, and writes it onto the
   page. No signature is asked for: nothing is bound to an account yet, because the product
   side does not exist. Asking for one would be a dialog that buys the person nothing.

   Console beats the server, same rule as site.js:
     localStorage.setItem("site.config", JSON.stringify({ token: "<mint>" })) */
(function () {
  // A single endpoint is a single point of failure, and the default public one rate-limits
  // hard once more than a few people are on the page at once.
  // publicnode answers getHealth but refuses indexed calls ("Indexed requests require a
  // personal token"), which is exactly the call we need, so it is not in this list.
  // Both of these are rate limited and are fine for a page, not for a launch: swap in a
  // paid endpoint before the token exists.
  var RPCS = [
    "https://api.mainnet-beta.solana.com",
    "https://api.mainnet.solana.com"
  ];
  var SUPPLY = 1000000000;
  // The same scale the token page states. Keep one copy: two lists drift apart on the first edit.
  var BANDS = [
    { pct: 4,   label: "fee-free once ascian charges a fee" },
    { pct: 2,   label: "roadmap input and a direct line to the team" },
    { pct: 1,   label: "priority routing and higher rate limits" },
    { pct: 0.5, label: "new models on day one, a 14-day head start" },
    { pct: 0.1, label: "holder status, early feature flags" }
  ];
  var isMint = function (a) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || ""); };
  var short = function (a) { return a.slice(0, 4) + "…" + a.slice(-4); };
  var state = { pubkey: "", balance: null, error: "" };
  var EASE_OUT = "cubic-bezier(.23,1,.32,1)";

  function cfg() { return (window.siteConfig || {}); }

  // The toast here was copied from site.js wholesale, styles and all. Two copies of one
  // thing drift apart on the first edit, so this calls the one already on the page.
  function toast(msg) {
    if (window.siteToast) return window.siteToast(msg, 3000);
    console.warn("[solana] " + msg);
  }

  function provider() {
    // Wallet Standard first, then the injected globals. Phantom and Solflare both answer here.
    var p = window.phantom && window.phantom.solana;
    if (p && p.isPhantom) return p;
    if (window.solflare && window.solflare.isSolflare) return window.solflare;
    if (window.solana && window.solana.isPhantom) return window.solana;
    return null;
  }

  function rpc(method, params) {
    var body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params });
    var i = 0;
    function attempt() {
      if (i >= RPCS.length) return Promise.reject(new Error("no rpc"));
      var u = RPCS[i++];
      return fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: body })
        .then(function (r) { if (!r.ok) throw new Error("rpc " + r.status); return r.json(); })
        .then(function (j) { if (j.error) throw new Error(j.error.message || "rpc error"); return j.result; })
        .catch(function () { return attempt(); });
    }
    return attempt();
  }

  // Reading the balance means summing every token account the owner has for this mint:
  // a wallet can hold the same mint in more than one account, and taking the first one
  // under-reports the holding, which would quietly put someone in a lower band.
  function balanceOf(owner, mint) {
    return rpc("getTokenAccountsByOwner", [owner, { mint: mint }, { encoding: "jsonParsed" }])
      .then(function (res) {
        var rows = (res && res.value) || [];
        var total = 0;
        rows.forEach(function (r) {
          var a = r.account.data.parsed.info.tokenAmount;
          total += parseFloat(a.uiAmountString || a.uiAmount || 0);
        });
        return total;
      });
  }

  function band(pct) {
    for (var i = 0; i < BANDS.length; i++) if (pct >= BANDS[i].pct) return BANDS[i];
    return null;
  }

  // The panel text changes twice per connection: "reading the balance" and the result.
  // Swapping in place shows two states overlapping; 120 ms of blur stitches them into one.
  function setText(el, txt) {
    if (el.textContent === txt) return;
    if (!el.textContent) { el.textContent = txt; return; }
    el.style.filter = "blur(2px)"; el.style.opacity = ".6";
    clearTimeout(el._swap);
    el._swap = setTimeout(function () {
      el.textContent = txt; el.style.filter = "none"; el.style.opacity = "1";
    }, 120);
  }

  function render() {
    document.querySelectorAll("[data-sol-panel]").forEach(function (el) {
      if (state.error) { setText(el, state.error); return; }
      if (!state.pubkey) { setText(el, ""); return; }
      if (state.balance == null) { setText(el, "Wallet " + short(state.pubkey) + ", reading the balance…"); return; }
      var pct = state.balance / SUPPLY * 100;
      var b = band(pct);
      // The scale is linear, not stepped: the token page gives 2.5% off for 0.1% of supply
      // and 12.5% for 0.5%. Rounding the share down to a whole percent wiped both out.
      var off = Math.min(100, pct * 25);
      var offs = (Math.round(off * 10) / 10) + "%";
      setText(el, "Wallet " + short(state.pubkey) + ": " +
        state.balance.toLocaleString("en-US") + " ASCIAN, " + pct.toFixed(3) + "% of supply" +
        (b ? ", " + offs + " off the ascian fee, " + b.label : ", below the first band (0.1%)"));
    });
  }

  function panelFor(btn) {
    var holder = btn.closest("div, li, section") || btn.parentNode;
    var p = holder.querySelector("[data-sol-panel]");
    if (!p) {
      p = document.createElement("p");
      p.setAttribute("data-sol-panel", "1");
      // The row of buttons in the card is a flex container whose flex:1 1 0 squeezed this
      // paragraph into a 67-pixel column. The width is set inline here: a stylesheet rule of
      // the same specificity loses.
      p.setAttribute("style", "flex:0 0 100%;width:100%;min-width:0;overflow-wrap:anywhere;" +
        "margin:10px 0 0;font:500 12px/1.5 ui-monospace,monospace;color:#adafb9;" +
        // The panel appears once per connection, which is rare, so a short entrance fits.
        // Not from scale(0): nothing in the world appears out of nothing.
        "opacity:0;transform:translateY(4px);transition:opacity 200ms " + EASE_OUT +
        ",transform 200ms " + EASE_OUT + ",filter 200ms " + EASE_OUT);
      btn.parentNode.insertBefore(p, btn.nextSibling);
      p.offsetHeight;
      p.style.opacity = "1"; p.style.transform = "none";
    }
    return p;
  }

  function connect(btn) {
    var pr = provider();
    if (!pr) {
      toast("No Solana wallet found. Install Phantom or Solflare and reload.");
      return;
    }
    panelFor(btn);
    pr.connect().then(function (res) {
      var pk = (res && res.publicKey ? res.publicKey : pr.publicKey);
      state.pubkey = pk ? pk.toString() : "";
      state.error = ""; state.balance = null; render();
      var mint = cfg().token;
      if (!isMint(mint)) {
        state.error = "Wallet " + short(state.pubkey) + " connected. The token is not deployed yet, so there is no balance to read.";
        render(); return;
      }
      return balanceOf(state.pubkey, mint).then(function (b) {
        state.balance = b; render();
      }).catch(function () {
        state.error = "Wallet " + short(state.pubkey) + " connected, but the balance could not be read just now. That is about our request, not about your holding.";
        render();
      });
    }).catch(function () {
      toast("Connection cancelled.");
    });
  }

  // The copied markup has its own connect buttons wired to the EVM bundle. Clone each one so
  // the old listeners die with the original node, then wire the clone to Solana.
  function takeOver() {
    // Before the mint exists there is nothing to read, and the markup already says
    // "after launch" on the disabled control. Leave it alone rather than opening a wallet
    // dialog that can only answer "no token yet".
    var live = isMint(cfg().token);
    document.querySelectorAll("button, a, span[aria-disabled], [role=button]").forEach(function (el) {
      if (el.dataset.solWired) return;
      var t = (el.textContent || "").trim().toLowerCase();
      // The markup labels it "Connect wallet AFTER LAUNCH", so match the start, not the whole string.
      if (t.indexOf("connect wallet") !== 0 && t.indexOf("connect holdings") !== 0 && t.indexOf("link wallet") !== 0) return;
      if (!live) return;
      var c = el.cloneNode(true);
      // Before launch this is a disabled <span>. A clone of a span is still a span: it
      // cannot be tabbed to and cannot be pressed from the keyboard, so the wallet connects
      // with a mouse and not with a keyboard. So the tag is swapped for a real button:
      // focus, Enter and Space and the screen-reader role come free, class and look stay.
      if (c.tagName === "SPAN") {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = c.className;
        if (c.getAttribute("title")) btn.title = c.getAttribute("title");
        c.querySelectorAll("small").forEach(function (x) { x.remove(); });
        btn.innerHTML = c.innerHTML;
        c = btn;
      }
      c.dataset.solWired = "1";
      if (c.tagName === "A") { c.removeAttribute("href"); c.setAttribute("role", "button"); c.tabIndex = 0; c.style.cursor = "pointer"; }
      c.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); connect(c); });
      // A link without href is not keyboard-activated on its own: add what a button has.
      if (c.tagName === "A") c.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); }
      });
      el.parentNode.replaceChild(c, el);
    });
  }

  var pending = false;
  function later() { if (pending) return; pending = true; setTimeout(function () { pending = false; takeOver(); render(); }, 80); }
  function boot() {
    takeOver();
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

/* Wallet sign-in and wallet link, on Solana.
   The compiled sign-in and account pages call connectWallet() and then
   provider.request({ method: "personal_sign" }), the EVM way, while the API verifies an
   ed25519 signature from a Solana address. So connectWallet is pointed here (one line in the
   wallet module, chunks 15d5i3n7uyqy0 and 2-bgudv4aiu6i): it connects Phantom or Solflare
   and hands the page a small provider whose personal_sign is Solana signMessage, base58.
   The rest of the page flow (challenge, verify, redirect, errors) stays the page's own.

   The top-up box pays EVM coins with an EVM transaction, so clicks inside it keep the old
   path: window.__ascEvm is set from the click that started the request. */
(function () {
  var B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58(bytes) {
    var digits = [0];
    for (var i = 0; i < bytes.length; i++) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    var out = "";
    for (var k = 0; k < bytes.length && bytes[k] === 0; k++) out += "1";
    for (var d = digits.length - 1; d >= 0; d--) out += B58[digits[d]];
    return out;
  }
  function solProvider() {
    var p = window.phantom && window.phantom.solana;
    if (p && p.isPhantom) return p;
    if (window.solflare && window.solflare.isSolflare) return window.solflare;
    if (window.backpack && window.backpack.solana) return window.backpack.solana;
    if (window.solana && typeof window.solana.signMessage === "function") return window.solana;
    return null;
  }
  function handheld() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  }
  function sigOf(res) {
    var s = res && res.signature ? res.signature : res;
    if (typeof s === "string") return s;
    if (s && s.length === 64) return b58(s instanceof Uint8Array ? s : Uint8Array.from(s));
    throw new Error("The wallet did not return a signature.");
  }

  window.__ascSolProvider = solProvider;
  window.__ascWallet = function () {
    var pr = solProvider();
    if (!pr) {
      if (handheld()) {
        // A phone browser has no extension. Phantom's universal link reopens this page
        // inside the Phantom app, where the provider exists.
        location.href = "https://phantom.app/ul/browse/" + encodeURIComponent(location.href) + "?ref=" + encodeURIComponent(location.origin);
        return Promise.reject(new Error("Opening Phantom. Sign in from the page it opens."));
      }
      return Promise.reject(new Error("No Solana wallet in this browser. Install Phantom or Solflare, then reload this page."));
    }
    return Promise.resolve(pr.connect()).then(function (res) {
      var pk = res && res.publicKey ? res.publicKey : pr.publicKey;
      var address = pk ? pk.toString() : "";
      if (!address) throw new Error("The wallet did not share an address.");
      var shim = {
        isAscianSolana: true,
        request: function (q) {
          var m = q && q.method;
          if (m === "personal_sign") {
            var msg = String(q.params && q.params[0] || "");
            return Promise.resolve(pr.signMessage(new TextEncoder().encode(msg), "utf8")).then(sigOf);
          }
          if (m === "eth_requestAccounts" || m === "eth_accounts") return Promise.resolve([address]);
          // homeChain() asks to switch networks; there is nothing to switch on Solana.
          if (m === "wallet_switchEthereumChain" || m === "wallet_addEthereumChain") return Promise.resolve(null);
          return Promise.reject(new Error("This wallet is on Solana and cannot do that here."));
        }
      };
      return { provider: shim, address: address, peer: null };
    }, function (e) {
      var t = (e && e.message) || "";
      if ((e && e.code === 4001) || /reject|cancel|closed/i.test(t)) throw new Error("Cancelled in the wallet.");
      throw e;
    });
  };
  addEventListener("click", function (e) {
    var t = e.target;
    window.__ascEvm = !!(t && t.closest && t.closest('[class*="payBox"]'));
  }, true);
})();
