// Operator panel and backups. Everything here needs ADMIN_TOKEN; without it the routes 404,
// so nothing admin-shaped is exposed on a server where it was never set.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { ipKey } from "./util.js";
import { CREDITS_PER_USD, credit, balanceOf } from "./ledger.js";
import { KEYS, raw, save, publicConfig, checkMint, token as liveToken, rpcUrls } from "./launch.js";

const TOKEN = process.env.ADMIN_TOKEN || "";
const TABLES = ["accounts", "sessions", "wallet_links", "ledger", "holds", "conversations", "media", "video_jobs", "deposits", "api_keys", "roadmap_requests"];
const BACKUP_DIR = path.join(path.dirname(cfg.mediaDir), "backups");
const usd = cr => Math.round((cr / CREDITS_PER_USD) * 100) / 100;

// The panel is the only lock on launch day, and a wrong token used to answer instantly and
// without limit. Count ONLY misses: the panel itself calls several routes per login, and a
// shared attempt counter would lock the operator out of their own panel.
const misses = new Map();
const MISS_MAX = 10, MISS_WINDOW = 600e3;
function recentMisses(key) {
  const now = Date.now(), arr = (misses.get(key) || []).filter(t => now - t < MISS_WINDOW);
  if (arr.length) misses.set(key, arr); else misses.delete(key);
  return arr;
}
setInterval(() => { for (const k of [...misses.keys()]) recentMisses(k); }, 600e3).unref();

function guard(req, res, next) {
  if (!TOKEN) return res.status(404).json({ error: "Not found." });
  const key = ipKey(req);
  // The token is compared FIRST. If the counter were checked earlier, a stranger could lock
  // the owner out with ten requests, and it would not slow a guesser down anyway: a guesser
  // has no token and never gets through. The comparison is constant-time, so the order
  // gives nothing away.
  const got = Buffer.from(String(req.headers["x-admin-token"] || "")), want = Buffer.from(TOKEN);
  if (got.length === want.length && crypto.timingSafeEqual(got, want)) {
    misses.delete(key); // a hit means the operator: clear the miss counter
    return next();
  }
  const n = recentMisses(key).concat(Date.now());
  misses.set(key, n);
  if (n.length > MISS_MAX) return res.status(429).json({ error: "Too many tries. Wait ten minutes." });
  return res.status(401).json({ error: "Wrong admin token." });
}

// PPQ balance. Their docs name POST /credits/balance; the exact shape is read defensively and a
// failed read is reported as unknown, never as zero (zero would look like an empty gateway).
async function ppqBalance() {
  if (!cfg.ppqKey) return { ok: false, reason: "no PPQ key" };
  try {
    const r = await fetch(cfg.ppqBase + "/credits/balance", { method: "POST", headers: { authorization: "Bearer " + cfg.ppqKey, "content-type": "application/json" }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    const v = [j.balance, j.balance_usd, j.usd, j.credits, j.data && j.data.balance].find(x => typeof x === "number" || (typeof x === "string" && x !== "" && !isNaN(+x)));
    if (!r.ok || v == null) return { ok: false, reason: `read failed (${r.status})`, raw: JSON.stringify(j).slice(0, 200) };
    return { ok: true, usd: +v };
  } catch (e) { return { ok: false, reason: "read failed: " + e.message }; }
}

async function summary() {
  const [acc, liab, held, dep, spend, jobs] = await Promise.all([
    one("select count(*)::int total, count(*) filter (where created_at > now() - interval '24 hours')::int as last_day from accounts"),
    one("select coalesce(sum(credits),0) c from ledger"),
    one("select coalesce(sum(credits),0) c from holds where expires_at > now()"),
    one("select count(*)::int n, coalesce(sum(credited_usd),0) usd, count(*) filter (where stage='credited')::int credited from deposits"),
    one(`select coalesce(-sum(credits) filter (where created_at > now() - interval '24 hours'),0) as last_day,
                coalesce(-sum(credits) filter (where created_at > now() - interval '7 days'),0) as last_week from ledger where kind='spend'`),
    one("select count(*)::int n from video_jobs where status in ('queued','processing')")
  ]);
  const ppq = await ppqBalance();
  const liabilityUsd = usd(liab.c);
  return {
    at: new Date().toISOString(), accounts: acc, liabilityCredits: liab.c, liabilityUsd, heldCredits: held.c,
    deposits: dep, accountsNew: acc.last_day, spend: { dayCredits: spend.last_day, weekCredits: spend.last_week, dayUsd: usd(spend.last_day), weekUsd: usd(spend.last_week) },
    videoJobsRunning: jobs.n, ppq, cover: ppq.ok ? Math.round((ppq.usd - liabilityUsd) * 100) / 100 : null,
    switches: { gateway: !!cfg.ppqKey, payments: !!cfg.npKey, ipn: !!cfg.npIpnSecret, mail: !!(cfg.resendKey && cfg.mailFrom), token: !!(await liveToken()) },
    recentDeposits: (await q("select d.id, d.created_at, d.crypto, d.amount_usd, d.stage, d.status, d.credited_usd, coalesce(a.username, a.email, a.wallet) who from deposits d join accounts a on a.id=d.account_id order by d.created_at desc limit 20")).rows,
    roadmap: (await q("select created_at, text, contact from roadmap_requests order by id desc limit 20")).rows,
    backups: listBackups()
  };
}

async function dump() {
  const out = { at: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    // Avatars are bytes; dumped as base64 so the file stays valid JSON.
    const rows = (await q(t === "accounts" ? "select *, encode(avatar,'base64') as avatar from accounts" : `select * from ${t}`)).rows;
    out.tables[t] = rows;
  }
  return zlib.gzipSync(Buffer.from(JSON.stringify(out)));
}
function listBackups() { try { return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json.gz")).sort().reverse(); } catch { return []; } }
async function nightly() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = new Date().toISOString().slice(0, 10) + ".json.gz";
    fs.writeFileSync(path.join(BACKUP_DIR, name), await dump());
    for (const old of listBackups().slice(14)) fs.unlinkSync(path.join(BACKUP_DIR, old));
    console.log("backup written", name);
  } catch (e) { console.error("backup failed", e.message); }
}

// Low gateway balance: if PPQ runs dry every chat fails with W414 while the site looks fine.
let lastAlert = 0;
async function watch() {
  const bot = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat || !cfg.ppqKey) return;
  const ppq = await ppqBalance(); if (!ppq.ok) return;
  const liab = usd((await one("select coalesce(sum(credits),0) c from ledger")).c);
  const floor = +(process.env.PPQ_MIN_USD || 20);
  if ((ppq.usd < floor || ppq.usd < liab) && Date.now() - lastAlert > 3 * 3600e3) {
    lastAlert = Date.now();
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `${cfg.brand}: PPQ balance $${ppq.usd.toFixed(2)}, users hold $${liab.toFixed(2)} in credits. Top up PPQ.` }) }).catch(() => {});
  }
}

export function mount(app) {
  if (TOKEN) {
    setTimeout(nightly, 60e3).unref();
    setInterval(nightly, 24 * 3600e3).unref();
    setInterval(() => watch().catch(() => {}), 10 * 60e3).unref();
  }
  app.get("/api/admin", (req, res) => {
    if (!TOKEN) return res.status(404).json({ error: "Not found." });
    res.set({ "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" }).send(PANEL);
  });
  app.get("/api/admin/summary", guard, async (req, res) => res.set("cache-control", "no-store").json(await summary()));
  app.get("/api/admin/accounts", guard, async (req, res) => {
    const s = "%" + String(req.query.q || "") + "%";
    const rows = (await q(`select a.id::text, a.username, a.email, a.wallet, a.created_at,
      coalesce((select sum(credits) from ledger l where l.account_id=a.id),0) credits
      from accounts a where coalesce(a.username,'') ilike $1 or coalesce(a.email,'') ilike $1 or coalesce(a.wallet,'') ilike $1
      order by a.id desc limit 50`, [s])).rows;
    res.json({ accounts: rows });
  });
  app.post("/api/admin/accounts/:id/delete", guard, async (req, res) => {
    // Media files on disk go with their rows; the ledger goes too (cascade), so this is for
    // test accounts and "delete my account" requests only.
    const files = (await q("select path from media where account_id=$1", [req.params.id])).rows;
    const r = await q("delete from accounts where id=$1", [req.params.id]);
    for (const f of files) fs.promises.unlink(f.path).catch(() => {});
    res.json({ deleted: r.rowCount });
  });
  // Test credits for an account (kind 'grant', source 'admin'). Counted as a liability like any balance.
  app.post("/api/admin/accounts/:id/grant", guard, async (req, res) => {
    const n = Number((req.body || {}).credits);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return res.status(400).json({ error: "credits must be between 1 and 100000." });
    if (!(await one("select 1 from accounts where id=$1", [req.params.id]))) return res.status(404).json({ error: "No such account." });
    await credit(req.params.id, "grant", n, { source: "admin" });
    res.json({ ok: true, balance: await balanceOf(req.params.id) });
  });
  // Launch settings. This is the one thing that has to work without a deploy: paste the mint,
  // press save, and every page picks it up within its 30-second cache.
  app.get("/api/admin/launch", guard, async (req, res) => {
    const v = await raw();
    res.set("cache-control", "no-store").json({ values: v, effective: await publicConfig(), rpc: rpcUrls().length });
  });
  app.post("/api/admin/launch/check", guard, async (req, res) => {
    res.set("cache-control", "no-store").json(await checkMint(String((req.body || {}).token || "").trim()));
  });
  app.post("/api/admin/launch", guard, async (req, res) => {
    const body = req.body || {}, patch = {};
    for (const k of KEYS) if (k in body) patch[k] = String(body[k] ?? "").trim();
    // A mint that is not a mint is refused rather than saved: a typo that is still valid
    // base58 would sit here looking right while every balance read came back empty.
    if (patch.token) {
      const c = await checkMint(patch.token);
      if (!c.ok && !body.force) return res.status(400).json({ error: c.reason, check: c });
    }
    for (const k of ["buyUrl", "chartUrl", "explorerUrl", "lockUrl", "xUrl", "telegramUrl", "supportUrl"]) {
      const u = patch[k];
      if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ error: `${k} must be an https link, or empty.` });
    }
    const values = await save(patch);
    res.set("cache-control", "no-store").json({ values, effective: await publicConfig() });
  });
  app.get("/api/admin/backup", guard, async (req, res) => {
    const name = req.query.name && listBackups().includes(String(req.query.name)) ? String(req.query.name) : null;
    const buf = name ? fs.readFileSync(path.join(BACKUP_DIR, name)) : await dump();
    res.set({ "content-type": "application/gzip", "content-disposition": `attachment; filename="${cfg.brand}-${name || new Date().toISOString().slice(0, 16).replace(":", "") + ".json.gz"}"` }).send(buf);
  });
}

const PANEL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Admin</title>
<style>
:root{--bg:#0e0d0d;--panel:#181616;--line:#2a2626;--text:#f2f0ec;--muted:#8a8784;--red:#e0414a;--green:#5fbf7f;--amber:#e0a341;
  /* The built-in CSS curves are too soft: a strong ease-out starts at once. */
  --out:cubic-bezier(.23,1,.32,1)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;padding:20px 16px 60px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px;color:var(--muted);font-weight:600}
.row{display:flex;gap:10px;flex-wrap:wrap}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:170px;flex:1}
.card b{display:block;font:600 20px ui-monospace,monospace;margin-top:4px}.muted{color:var(--muted)}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
input,button{font:inherit;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
button{cursor:pointer;transition:transform 140ms var(--out),border-color 160ms ease,background 160ms ease}
/* Press feedback: 0.97 is enough to feel, small enough not to jump. */
button:active{transform:scale(.97)}
input{transition:border-color 160ms ease}
input:focus{outline:none;border-color:#5a5252}
button.danger{border-color:var(--red);color:var(--red)}
.wrap{overflow-x:auto}#msg{margin:10px 0}
.panelbox{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.panelbox label{display:block;margin:0 0 10px}.panelbox label input{display:block;width:100%;margin-top:4px;font-family:ui-monospace,monospace}
.panelbox summary{cursor:pointer;color:var(--muted);margin:4px 0 10px}
#eff{margin-top:10px;font:12px/1.6 ui-monospace,monospace;word-break:break-all}
/* The check line changes on every typed character. Swapping text in place flickers,
   so it fades out through a blur and comes back. */
#chk{margin:-4px 0 12px;transition:opacity 140ms ease,filter 140ms ease}
#chk.swap,#eff.swap,#lmsg.swap{opacity:.55;filter:blur(2px)}
#eff,#lmsg{transition:opacity 140ms ease,filter 140ms ease}
/* Logging in used to swap the whole page at once. A short rise instead of a jump. */
#app{opacity:0;transform:translateY(6px);transition:opacity 180ms var(--out),transform 180ms var(--out)}
#app.in{opacity:1;transform:none}
/* The operator opens the panel rarely, so a short stagger on the cards is fine. */
.row .card{opacity:0;transform:translateY(6px);animation:cardIn 240ms var(--out) forwards}
.row .card:nth-child(2){animation-delay:40ms}.row .card:nth-child(3){animation-delay:80ms}
.row .card:nth-child(4){animation-delay:120ms}.row .card:nth-child(5){animation-delay:160ms}
.row .card:nth-child(6){animation-delay:200ms}
@keyframes cardIn{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  button:active{transform:none}
  #app,.row .card{transform:none}
  .row .card{animation-duration:140ms}
  #chk.swap,#eff.swap,#lmsg.swap{filter:none}
}
</style></head><body>
<h1>Admin</h1><div class="muted" id="at"></div>
<div id="login" style="margin-top:16px"><input id="tok" type="password" placeholder="ADMIN_TOKEN" style="width:320px"> <button id="go">Log in</button></div>
<div id="msg" role="status" aria-live="polite"></div><div id="app" hidden>
<h2>Launch</h2>
<div id="launch" class="panelbox">
  <label>Token address (mint)<input id="f_token" placeholder="paste the address from pump.fun" spellcheck="false"></label>
  <div id="chk" class="muted" role="status" aria-live="polite">Paste the address, the rest is worked out from it.</div>
  <details id="more"><summary>Links, if you need to set them by hand</summary>
    <label>Buy<input id="f_buyUrl" placeholder="empty = pump.fun/coin/&lt;mint&gt;" spellcheck="false"></label>
    <label>Chart<input id="f_chartUrl" placeholder="empty = the DexScreener pair" spellcheck="false"></label>
    <label>Explorer<input id="f_explorerUrl" placeholder="empty = solscan.io/token/&lt;mint&gt;" spellcheck="false"></label>
    <label>Team lock<input id="f_lockUrl" placeholder="link to the vesting contract" spellcheck="false"></label>
    <label>X<input id="f_xUrl" placeholder="https://x.com/..." spellcheck="false"></label>
    <label>Telegram<input id="f_telegramUrl" placeholder="https://t.me/..." spellcheck="false"></label>
    <label>Support<input id="f_supportUrl" placeholder="empty = Telegram" spellcheck="false"></label>
    <label>Launch time<input id="f_launchAt" placeholder="2026-10-20T18:00:00Z" spellcheck="false"></label>
  </details>
  <div class="row" style="align-items:center"><button id="save">Save</button> <span id="lmsg" class="muted" role="status" aria-live="polite"></span></div>
  <div id="eff" class="muted"></div>
</div>
<h2>Money</h2><div class="row" id="money"></div>
<h2>Switched on</h2><div class="row" id="sw"></div>
<h2>Top-ups</h2><div class="wrap"><table id="deps"></table></div>
<h2>Accounts</h2><div class="row"><input id="q" placeholder="username, email or wallet"> <button id="find">Find</button></div><div class="wrap"><table id="accs"></table></div>
<h2>Database backups</h2><div id="bk"></div>
<h2>Roadmap requests</h2><div class="wrap"><table id="rm"></table></div>
</div>
<script>
var T=sessionStorage.getItem("adm")||"";
// Headers are added, not replaced: replacing them dropped content-type, the body went
// out unparsed and the server got an empty request.
function api(p,o){o=Object.assign({},o);o.headers=Object.assign({},o.headers,{"x-admin-token":T});return fetch("/api/admin"+p,o)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
// Any in-place text swap shows two states overlapping. A short blur joins them:
// the eye sees one change, not two objects.
function swap(el,fn){
  if(!el.textContent){fn();return}
  el.classList.add("swap");
  clearTimeout(el._sw);
  el._sw=setTimeout(function(){fn();el.classList.remove("swap")},120);
}
function card(t,v,cls,sub){return '<div class="card"><span class="muted">'+t+'</span><b class="'+(cls||"")+'">'+v+'</b>'+(sub?'<span class="muted">'+sub+'</span>':'')+'</div>'}
function money(n){return "$"+Number(n).toFixed(2)}
async function load(){
  var r=await api("/summary"); if(r.status===401){sessionStorage.removeItem("adm");document.getElementById("msg").innerHTML='<span class="bad">Wrong token</span>';return}
  var d=await r.json(); document.getElementById("login").hidden=true;
  var app=document.getElementById("app"); app.hidden=false; app.offsetHeight; app.classList.add("in");
  document.getElementById("at").textContent="updated "+new Date(d.at).toLocaleString();
  var ppq=d.ppq.ok?money(d.ppq.usd):"unknown";
  var cov=d.cover==null?"cannot be worked out":money(d.cover);
  document.getElementById("money").innerHTML=
    card("PPQ balance",ppq,d.ppq.ok?"":"warn",d.ppq.ok?"":esc(d.ppq.reason))+
    card("User credits (what we owe)",money(d.liabilityUsd),"",Math.round(d.liabilityCredits).toLocaleString()+" cr")+
    card("PPQ headroom over what we owe",cov,d.cover==null?"warn":d.cover<0?"bad":"ok",d.cover!=null&&d.cover<0?"top up PPQ":"")+
    card("Spent in 24 h",money(d.spend.dayUsd),"","this week "+money(d.spend.weekUsd))+
    card("Topped up in total",money(d.deposits.usd),"",d.deposits.credited+" of "+d.deposits.n+" credited")+
    card("Accounts",d.accounts.total,"","last 24 h +"+d.accounts.last_day);
  var s=d.switches,names={gateway:"PPQ (models)",payments:"NOWPayments",ipn:"IPN secret",mail:"Mail",token:"Token address"};
  document.getElementById("sw").innerHTML=Object.keys(names).map(function(k){return card(names[k],s[k]?"yes":"no",s[k]?"ok":"warn")}).join("");
  document.getElementById("deps").innerHTML="<tr><th>when</th><th>who</th><th>coin</th><th>invoice</th><th>credited</th><th>stage</th></tr>"+d.recentDeposits.map(function(x){return "<tr><td>"+new Date(x.created_at).toLocaleString()+"</td><td>"+esc(x.who)+"</td><td>"+esc(x.crypto)+"</td><td>"+money(x.amount_usd)+"</td><td>"+money(x.credited_usd)+"</td><td>"+esc(x.stage)+" "+esc(x.status||"")+"</td></tr>"}).join("");
  document.getElementById("rm").innerHTML=d.roadmap.map(function(x){return "<tr><td>"+new Date(x.created_at).toLocaleString()+"</td><td>"+esc(x.text)+"</td><td>"+esc(x.contact)+"</td></tr>"}).join("")||"<tr><td class='muted'>none yet</td></tr>";
  document.getElementById("bk").innerHTML='<button id="dl">Download a backup now</button> '+(d.backups.length?'<span class="muted">nightly: </span>'+d.backups.map(function(n){return '<a href="#" data-n="'+esc(n)+'" style="color:var(--text)">'+esc(n)+'</a>'}).join(", "):'<span class="muted">no nightly backups yet</span>');
  document.getElementById("dl").onclick=function(){dl("")};
  document.querySelectorAll("#bk a").forEach(function(a){a.onclick=function(e){e.preventDefault();dl(a.dataset.n)}});
  loadLaunch();
  find();
}
async function dl(n){var r=await api("/backup"+(n?"?name="+encodeURIComponent(n):""));var b=await r.blob();var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=n||"backup.json.gz";a.click()}
async function find(){
  var r=await api("/accounts?q="+encodeURIComponent(document.getElementById("q").value)); var d=await r.json();
  document.getElementById("accs").innerHTML="<tr><th>id</th><th>username</th><th>email</th><th>wallet</th><th>credits</th><th>created</th><th></th></tr>"+d.accounts.map(function(a){return "<tr><td>"+a.id+"</td><td>"+esc(a.username)+"</td><td>"+esc(a.email)+"</td><td>"+esc(a.wallet?a.wallet.slice(0,8)+"…":"")+"</td><td>"+Math.round(a.credits)+"</td><td>"+new Date(a.created_at).toLocaleDateString()+"</td><td><button class='danger' data-id='"+a.id+"'>delete</button></td></tr>"}).join("");
  document.querySelectorAll("#accs button").forEach(function(b){b.onclick=async function(){
    // Two clicks instead of a confirm() dialog: the second click within 4 s deletes.
    if(b.dataset.armed!=="1"){b.dataset.armed="1";b.textContent="really delete?";setTimeout(function(){b.dataset.armed="";b.textContent="delete"},4000);return}
    var r=await api("/accounts/"+b.dataset.id+"/delete",{method:"POST"});var j=await r.json();document.getElementById("msg").textContent=j.deleted?"Account "+b.dataset.id+" deleted":"Could not delete";find()}});
}

var LK=["token","buyUrl","chartUrl","explorerUrl","lockUrl","xUrl","telegramUrl","supportUrl","launchAt"];
function fld(k){return document.getElementById("f_"+k)}
function showEff(e){
  var box=document.getElementById("eff");
  if(box.textContent) swap(box,function(){box.innerHTML=effHtml(e)}); else box.innerHTML=effHtml(e);
}
function effHtml(e){
  return e&&e.token
    ? "Pages will get:<br>address "+esc(e.token)+"<br>buy "+esc(e.buyUrl)+"<br>chart "+esc(e.chartUrl)+"<br>explorer "+esc(e.explorerUrl)
    : "No address set: pages say \u201cnot deployed yet\u201d and the buy and chart buttons are hidden.";
}
async function loadLaunch(){
  var r=await api("/launch"); if(!r.ok) return;
  var d=await r.json();
  LK.forEach(function(k){ if(fld(k)) fld(k).value=d.values[k]||"" });
  if(LK.slice(1).some(function(k){return d.values[k]})) document.getElementById("more").open=true;
  showEff(d.effective);
}
// Checked on-chain on paste: the address either exists as a mint or it does not, no guessing.
var chkT=null;
function chkNow(){
  var v=fld("token").value.trim(), box=document.getElementById("chk");
  function say(cls,txt){swap(box,function(){box.className=cls;box.textContent=txt})}
  if(!v){say("muted","Paste the address, the rest is worked out from it.");return}
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)){say("bad","That does not look like a Solana address: it needs 32 to 44 base58 characters.");return}
  say("muted","Checking on-chain…");
  clearTimeout(chkT); chkT=setTimeout(async function(){
    var r=await api("/launch/check",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:v})});
    var d=await r.json();
    if(d.ok){say("ok","This is a mint: "+d.decimals+" decimals, supply "+(d.supply==null?"unknown":Number(d.supply).toLocaleString())
      +(d.mintAuthority?", mint authority NOT revoked":", no further minting possible")+(d.freezeAuthority?", accounts can be frozen":"")+". Ready to save.")}
    else {say("bad",d.reason||"The check failed.")}
  },400);
}
document.getElementById("f_token").addEventListener("input",chkNow);
document.getElementById("save").onclick=async function(){
  var body={}; LK.forEach(function(k){ if(fld(k)) body[k]=fld(k).value.trim() });
  var m=document.getElementById("lmsg");
  function msg(cls,txt){swap(m,function(){m.className=cls;m.textContent=txt})}
  msg("muted","saving…");
  var r=await api("/launch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  var d=await r.json();
  if(!r.ok){msg("bad",d.error||"Not saved");return}
  msg("ok","saved, pages pick it up shortly");
  showEff(d.effective); load();
};
document.getElementById("go").onclick=function(){T=document.getElementById("tok").value.trim();sessionStorage.setItem("adm",T);load()};
document.getElementById("find").onclick=find;
if(T)load();
</script></body></html>`;
