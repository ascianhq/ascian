import { cfg } from "./env.js";
import { q } from "./db.js";
import { fail, limited, ipKey } from "./util.js";
import { needAuth } from "./auth.js";
import { publicCatalog } from "./catalog.js";
import { publicConfig, raw } from "./launch.js";

let prices = null, pricesAt = 0;
const IDS = { BTC: "bitcoin", ETH: "ethereum", BNB: "binancecoin", XRP: "ripple", DOGE: "dogecoin", SOL: "solana", USDT: "tether" };
async function loadPrices() {
  // Binance answers 451 from US hosts, so CoinGecko first, OKX as the fallback.
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + Object.values(IDS).join(",") + "&vs_currencies=usd&include_24hr_change=true");
    if (!r.ok) throw new Error("gecko " + r.status);
    const j = await r.json(), out = {};
    for (const [s, id] of Object.entries(IDS)) if (j[id]) out[s] = { symbol: s, price: j[id].usd, change24h: j[id].usd_24h_change || 0 };
    return { prices: out, source: "CoinGecko" };
  } catch {
    const out = { USDT: { symbol: "USDT", price: 1, change24h: 0 } };
    await Promise.all(Object.keys(IDS).filter(s => s !== "USDT").map(async s => {
      const t = (await (await fetch("https://www.okx.com/api/v5/market/ticker?instId=" + s + "-USDT")).json()).data?.[0];
      if (t) out[s] = { symbol: s, price: +t.last, change24h: (t.last / t.open24h - 1) * 100 };
    }));
    return { prices: out, source: "OKX" };
  }
}

// DexScreener: pairs of our token on this chain; the deepest pool is the price, never a sum
// over pools (summing overstated a token fourfold once). Cached a minute.
const pairCache = { at: 0, data: null, url: "", mint: "" };
async function tokenStats(mint) {
  // The mint can change under us the moment it is saved in the panel, so the cache is keyed
  // on it: otherwise the first minute after launch would serve "not trading yet" forever.
  if (pairCache.data && pairCache.mint === mint && Date.now() - pairCache.at < 60e3) return pairCache.data;
  if (pairCache.mint !== mint) { pairCache.url = ""; pairCache.mint = mint; }
  const r = await fetch(`https://api.dexscreener.com/tokens/v1/${cfg.dexChain}/${mint}`);
  if (!r.ok) throw new Error("dexscreener " + r.status);
  // base58 is case sensitive: comparing lowercased, as the EVM code did, matched nothing.
  const pairs = (await r.json()).filter(p => p.baseToken && p.baseToken.address === mint);
  // No pool yet means not trading yet. live:true with a null price crashes their token
  // widget (null.toFixed), so live is only claimed with every number present.
  if (!pairs.length) { pairCache.data = { live: false }; pairCache.at = Date.now(); return pairCache.data; }
  const p = pairs.sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0))[0];
  pairCache.url = p.url;
  pairCache.data = { live: true, priceUsd: +p.priceUsd, change24h: (p.priceChange || {}).h24 ?? null, marketCapUsd: p.marketCap ?? p.fdv ?? null,
    liquidityUsd: (p.liquidity || {}).usd ?? null, volume24hUsd: (p.volume || {}).h24 ?? null, pairUrl: p.url };
  const d = pairCache.data;
  if (![d.priceUsd, d.change24h, d.marketCapUsd, d.liquidityUsd, d.volume24hUsd].every(v => typeof v === "number" && Number.isFinite(v))) pairCache.data = { live: false };
  pairCache.at = Date.now();
  return pairCache.data;
}

export function mount(app) {
  app.get("/api/models", async (req, res) => {
    try { res.set("cache-control", "public, max-age=60").json(await publicCatalog()); }
    catch { fail(res, 503, "The model list is unavailable right now."); }
  });
  app.get("/api/crypto-prices", async (req, res) => {
    if (!prices || Date.now() - pricesAt > 60e3) {
      try { prices = { ...(await loadPrices()), updatedAt: new Date().toISOString() }; pricesAt = Date.now(); }
      catch (e) { if (!prices) return fail(res, 503, "Prices unavailable."); }
    }
    res.set("cache-control", "no-store").json(prices);
  });
  // Everything the pages need to know about the launch, from env, so it is one variable
  // on Railway and no rebuild. Empty values keep links hidden and the copy button refusing.
  app.get("/api/site-config", async (req, res) => {
    // Thirty seconds of caching, so pasting the mint in the panel reaches every open page
    // within half a minute without a deploy and without hammering this route.
    res.set("cache-control", "public, max-age=30").json(await publicConfig(pairCache.url));
  });
  app.get("/api/token-stats", async (req, res) => {
    const v = await raw();
    const none = { live: false, launchAt: v.launchAt || null, priceUsd: null, change24h: null, marketCapUsd: null, liquidityUsd: null, volume24hUsd: null, pairUrl: null };
    if (!v.token) return res.json(none);
    try { res.set("cache-control", "public, max-age=30").json({ ...none, ...(await tokenStats(v.token)) }); }
    catch (e) { console.error("token stats", e.message); res.json(none); }
  });
  app.post("/api/roadmap/request", async (req, res) => {
    const { text, contact, website } = req.body || {};
    if (website) return res.json({ ok: true }); // honeypot field filled: a bot, pretend it worked
    const t = String(text || "").trim();
    if (t.length < 3 || t.length > 4000) return fail(res, 400, "Write a sentence or two, up to 4,000 characters.");
    if (limited("roadmap:" + ipKey(req), 5, 3600e3)) return fail(res, 429, "That did not send. Try again in a minute.");
    await q("insert into roadmap_requests (text, contact, ip) values ($1,$2,$3)", [t, String(contact || "").slice(0, 200), ipKey(req)]);
    res.json({ ok: true });
  });
  // Collabs are not built yet. The list answers empty so the account tab renders instead of erroring.
  app.get("/api/collabs", needAuth(), (req, res) => res.json({ username: req.account.username, caps: { members: 8, purseCredits: 50000 }, invites: [], collabs: [] }));
  app.all(/^\/api\/collabs\/.*/, needAuth(), (req, res) => fail(res, 503, "Collabs open in a later version."));
  app.post("/api/collabs", needAuth(), (req, res) => fail(res, 503, "Collabs open in a later version."));
  app.get("/healthz", async (req, res) => {
    try { await q("select 1"); res.json({ ok: true, db: "postgres", gateway: !!cfg.ppqKey, standin: !cfg.ppqKey && !!cfg.anthropicKey, payments: !!cfg.npKey, mail: !!(cfg.resendKey && cfg.mailFrom) }); }
    catch (e) { res.status(503).json({ ok: false, error: e.message }); }
  });
}
