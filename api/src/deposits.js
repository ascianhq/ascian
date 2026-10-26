// Top-ups through NOWPayments. An address per deposit; the IPN callback (HMAC-SHA512 over the
// key-sorted body) moves credits, and the tracker also asks NOWPayments directly, so a lost
// callback delays nothing by more than a poll.
import crypto from "node:crypto";
import { cfg } from "./env.js";
import { q, one, tx } from "./db.js";
import { fail, rand } from "./util.js";
import { needAuth } from "./auth.js";
import { credit, CREDITS_PER_USD } from "./ledger.js";

const MIN_USD = 5, MAX_USD = 10000, OVERPAY_CAP = 4;
const H = () => ({ "x-api-key": cfg.npKey, "content-type": "application/json" });
let assetsCache = null, assetsAt = 0;
// Each coin has its own NOWPayments minimum (USDT on Tron was $12.78 against our $5 on
// 22.09). A deposit under it fails at NOWPayments, so the real figure is read per coin,
// padded 10% for price drift, and never shown below our own $5.
const POPULAR = ["btc", "eth", "usdttrc20", "usdterc20", "usdc", "sol", "xrp", "bnbbsc", "ltc", "doge"];
const minCache = new Map();
async function minUsd(coin) {
  const hit = minCache.get(coin);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.v;
  let v = MIN_USD;
  try {
    const j = await np(`/min-amount?currency_from=${encodeURIComponent(coin)}&fiat_equivalent=usd`);
    if (typeof j.fiat_equivalent === "number" && j.fiat_equivalent > 0) v = Math.max(MIN_USD, Math.ceil(j.fiat_equivalent * 1.1));
  } catch (e) { console.error("np min", coin, e.message); if (hit) return hit.v; }
  minCache.set(coin, { v, at: Date.now() });
  return v;
}

async function np(path, opt = {}) {
  const r = await fetch(cfg.npBase + path, { ...opt, headers: { ...H(), ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || "nowpayments " + r.status); e.status = r.status; throw e; }
  return j;
}
async function assets() {
  if (assetsCache && Date.now() - assetsAt < 30 * 60e3) return assetsCache;
  const full = await np("/full-currencies");
  let allowed = null;
  try { const mc = await np("/merchant/coins"); if (Array.isArray(mc.selectedCurrencies) && mc.selectedCurrencies.length) allowed = new Set(mc.selectedCurrencies.map(s => s.toLowerCase())); } catch {}
  assetsCache = (full.currencies || [])
    .filter(c => c.enable !== false && (!allowed || allowed.has(String(c.code).toLowerCase())))
    .map(c => ({ id: String(c.code).toLowerCase(), label: c.name || c.code, network: String(c.network || "").toLowerCase(), minUsd: MIN_USD, maxUsd: MAX_USD }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const mins = await Promise.all(POPULAR.map(minUsd));
  POPULAR.forEach((id, i) => { const a = assetsCache.find(x => x.id === id); if (a) a.minUsd = mins[i]; });
  assetsAt = Date.now();
  return assetsCache;
}

const STAGE = { waiting: "waiting", confirming: "seen", confirmed: "confirmed", sending: "confirmed", partially_paid: "credited", finished: "credited", failed: "failed", refunded: "failed", expired: "expired" };

// Applies one provider status to a deposit. Safe to run any number of times with the same data.
export async function apply(depositId, p) {
  return tx(async c => {
    const d = (await c.query("select * from deposits where id=$1 for update", [depositId])).rows[0];
    if (!d) return null;
    const st = String(p.payment_status || "");
    const payAmount = +p.pay_amount || +d.amount_crypto || 0, paid = +p.actually_paid || 0;
    const receivedUsd = payAmount > 0 ? Math.min(OVERPAY_CAP * d.amount_usd, (paid / payAmount) * d.amount_usd) : 0;
    let stage = STAGE[st] || d.stage;
    if (d.stage === "credited" && stage !== "credited") stage = "credited"; // never walk back after crediting
    let creditedUsd = d.credited_usd, creditedAt = d.credited_at;
    if ((st === "finished" || st === "partially_paid") && receivedUsd > creditedUsd + 0.004) {
      const diff = Math.round((receivedUsd - creditedUsd) * 100) / 100, level = Math.round(receivedUsd * 100);
      const ok = await credit(d.account_id, "deposit", diff * CREDITS_PER_USD, { source: "nowpayments", ref: `deposit:${d.id}:${level}` }, c);
      if (ok) {
        creditedUsd = Math.round(receivedUsd * 100) / 100; creditedAt = new Date();
        const refBy = (await c.query("select referred_by from accounts where id=$1", [d.account_id])).rows[0].referred_by;
        if (refBy && refBy !== d.account_id) await credit(refBy, "referral", 0.1 * diff * CREDITS_PER_USD, { source: "referral", ref: `refbonus:${d.id}:${level}` }, c);
      }
    }
    await c.query(`update deposits set stage=$2, status=$3, received_usd=$4, credited_usd=$5, credits=$6, credited_at=$7, last_callback_at=now() where id=$1`,
      [d.id, stage, st, Math.round(receivedUsd * 100) / 100, creditedUsd, creditedUsd * CREDITS_PER_USD, creditedAt]);
    return stage;
  });
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") return Object.keys(o).sort().reduce((a, k) => ((a[k] = sortKeys(o[k])), a), {});
  return o;
}
export function ipnValid(body, sigHex) {
  if (!cfg.npIpnSecret || !sigHex) return false;
  const want = crypto.createHmac("sha512", cfg.npIpnSecret).update(JSON.stringify(sortKeys(body))).digest("hex");
  const a = Buffer.from(want), b = Buffer.from(String(sigHex));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function mount(app) {
  const auth = needAuth();
  app.get("/api/deposits/assets", async (req, res) => {
    if (!cfg.npKey) return res.json({ provider: "nowpayments", assets: [] });
    try { res.json({ provider: "nowpayments", assets: await assets() }); }
    catch (e) { console.error("np assets", e.message); res.json({ provider: "nowpayments", assets: [] }); }
  });
  app.post("/api/deposits", auth, async (req, res) => {
    if (!cfg.npKey) return fail(res, 503, "Top-ups are not switched on yet.");
    const amountUsd = Math.round(+((req.body || {}).amountUsd) * 100) / 100, crypto_ = String((req.body || {}).crypto || "").toLowerCase();
    if (!(amountUsd >= MIN_USD && amountUsd <= MAX_USD)) return fail(res, 400, `Pick an amount from $${MIN_USD} to $${MAX_USD.toLocaleString("en-US")}.`);
    const list = await assets().catch(() => []);
    if (!list.find(a => a.id === crypto_)) return fail(res, 400, "That coin is not accepted right now.");
    const floor = await minUsd(crypto_);
    if (amountUsd < floor) return fail(res, 400, `The smallest top-up in this coin is $${floor}. Pick a larger amount or another coin.`);
    const id = "dep_" + rand(10);
    try {
      const p = await np("/payment", { method: "POST", body: JSON.stringify({
        price_amount: amountUsd, price_currency: "usd", pay_currency: crypto_, order_id: id,
        order_description: `${cfg.brand} credits`, ipn_callback_url: `${cfg.siteUrl}/api/deposits/ipn`, is_fee_paid_by_user: false }) });
      // No is_fixed_rate: with it NOWPayments refused every $5 and $8 invoice ("amountTo is
      // too small", measured 22.09). Floating rate is fine here: credits follow what actually
      // arrived, pro rata, not the quote.
      const address = p.pay_address + (p.payin_extra_id ? "" : "");
      await q(`insert into deposits (id, account_id, provider_id, crypto, address, amount_crypto, amount_usd, expires_at, status)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, req.account.id, String(p.payment_id), crypto_, address, String(p.pay_amount), amountUsd, p.expiration_estimate_date || null, p.payment_status || "waiting"]);
      res.json({ depositId: id, crypto: crypto_, address, amountCrypto: String(p.pay_amount), amountUsd, expiresAt: p.expiration_estimate_date || null, extraId: p.payin_extra_id || null });
    } catch (e) {
      console.error("np payment", e.message);
      // NOWPayments refuses amounts under a coin's own minimum; say so in its words.
      return fail(res, 400, /minimal|min/i.test(e.message) ? "That amount is below this coin's minimum. Pick a larger amount or another coin." : "Could not get an address. Try again in a minute.");
    }
  });
  app.get("/api/deposits/:id", auth, async (req, res) => {
    let d = await one("select * from deposits where id=$1 and account_id=$2", [req.params.id, req.account.id]);
    if (!d) return fail(res, 404, "That deposit could not be found.");
    // Ask the provider directly when the last word from it is older than 20 s.
    if (!["credited", "expired", "failed"].includes(d.stage) && d.provider_id && cfg.npKey &&
        (!d.last_callback_at || Date.now() - new Date(d.last_callback_at) > 20e3)) {
      try { await apply(d.id, await np("/payment/" + d.provider_id)); d = await one("select * from deposits where id=$1", [d.id]); }
      catch (e) { console.error("np status", e.message); await q("update deposits set last_callback_at=now() where id=$1", [d.id]); }
    }
    res.set("cache-control", "no-store").json({
      stage: d.stage, status: d.status, crypto: d.crypto, address: d.address, createdAt: d.created_at, lastCallbackAt: d.last_callback_at,
      requestedUsd: d.amount_usd, receivedUsd: d.received_usd, creditedUsd: d.credited_usd, credits: d.credits, creditedAt: d.credited_at,
      txHash: d.tx_hash, receiptSentAt: null
    });
  });
  app.post("/api/deposits/:id/tx", auth, async (req, res) => {
    const h = String((req.body || {}).hash || "");
    if (/^0x[0-9a-fA-F]{64}$/.test(h)) await q("update deposits set tx_hash=$3 where id=$1 and account_id=$2", [req.params.id, req.account.id, h]);
    res.json({ ok: true });
  });
  app.post("/api/deposits/ipn", async (req, res) => {
    if (!ipnValid(req.body, req.headers["x-nowpayments-sig"])) return res.status(401).json({ error: "bad signature" });
    const d = await one("select id from deposits where provider_id=$1 or id=$2", [String(req.body.payment_id || ""), String(req.body.order_id || "")]);
    if (!d) return res.status(404).json({ error: "unknown deposit" });
    await apply(d.id, req.body);
    res.json({ ok: true });
  });
}
