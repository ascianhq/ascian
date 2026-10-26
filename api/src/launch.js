// Launch settings and the Solana reads that depend on them.
//
// Everything the site needs to come alive at launch (the mint, and the links that only exist
// once it does) used to be environment variables: changing one meant a redeploy, during the
// one hour nobody wants to redeploy. They live in the settings table now, editable from the
// panel, with the old variables kept as the fallback so an existing deployment keeps working
// unchanged until somebody saves in the panel.
import { q } from "./db.js";

export const KEYS = ["token", "buyUrl", "chartUrl", "explorerUrl", "lockUrl", "xUrl", "telegramUrl", "supportUrl", "launchAt"];
const ENV = { token: "TOKEN_ADDRESS", buyUrl: "BUY_URL", chartUrl: "CHART_URL", explorerUrl: "EXPLORER_URL",
  lockUrl: "LOCK_URL", xUrl: "X_URL", telegramUrl: "TELEGRAM_URL", supportUrl: "SUPPORT_URL", launchAt: "LAUNCH_AT" };

// A Solana address is base58 and case sensitive: lowercasing one, which the EVM code did
// everywhere, turns a real mint into a string that matches nothing.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const isMint = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || "");
export function base58decode(s) {
  let n = 0n;
  for (const c of String(s)) { const i = B58.indexOf(c); if (i < 0) throw new Error("not base58"); n = n * 58n + BigInt(i); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of String(s)) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// Read-only endpoints. The public one is rate limited per method and is fine for a page;
// set SOLANA_RPC to a paid endpoint before launch day.
export const rpcUrls = () => (process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com,https://api.mainnet.solana.com")
  .split(",").map(s => s.trim()).filter(Boolean);

export async function rpc(method, params) {
  let last = null;
  for (const url of rpcUrls()) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error("no rpc endpoint answered");
}

// One row per setting, so saving the mint does not rewrite anything else.
let cache = null, cacheAt = 0;
export function forget() { cache = null; cacheAt = 0; }
async function stored() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  let rows = [];
  try { rows = (await q("select key, value from settings")).rows; }
  catch { return cache || {}; } // before the first migrate, fall through to env
  cache = Object.fromEntries(rows.map(r => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

// What the panel saved, or the environment variable, or "". Nothing is lowercased.
export async function raw() {
  const s = await stored(), out = {};
  for (const k of KEYS) out[k] = (s[k] ?? process.env[ENV[k]] ?? "").trim();
  if (!isMint(out.token)) out.token = "";
  return out;
}

// What the pages get. The three links that can be worked out from the mint are worked out,
// so pasting the mint alone is enough: buy, chart, explorer and the copy button all wake up.
export async function publicConfig(pairUrl = "") {
  const v = await raw(), t = v.token;
  return {
    token: t,
    buyUrl: v.buyUrl || (t ? `https://pump.fun/coin/${t}` : ""),
    chartUrl: v.chartUrl || pairUrl || (t ? `https://dexscreener.com/solana/${t}` : ""),
    explorerUrl: v.explorerUrl || (t ? `https://solscan.io/token/${t}` : ""),
    lockUrl: v.lockUrl || "",
    xUrl: v.xUrl || "",
    telegramUrl: v.telegramUrl || "",
    supportUrl: v.supportUrl || v.telegramUrl || ""
  };
}

export const token = async () => (await raw()).token;

export async function save(patch) {
  const rows = Object.entries(patch).filter(([k]) => KEYS.includes(k));
  for (const [k, val] of rows) {
    await q(`insert into settings (key, value, updated_at) values ($1,$2,now())
             on conflict (key) do update set value=$2, updated_at=now()`, [k, String(val ?? "").trim()]);
  }
  forget();
  return raw();
}

// Is this really an SPL mint on mainnet? Answered from the chain, not from the shape of the
// string: a typo that is still valid base58 would otherwise sit in the config looking right
// while every balance read came back empty.
export async function checkMint(mint) {
  if (!isMint(mint)) return { ok: false, reason: "Not a Solana address: expected 32 to 44 base58 characters." };
  let info;
  try { info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]); }
  catch (e) { return { ok: false, reason: "The chain did not answer: " + e.message }; }
  const v = info && info.value;
  if (!v) return { ok: false, reason: "No account with that address on mainnet." };
  const p = v.data && v.data.parsed;
  if (!p || p.type !== "mint") return { ok: false, reason: "That address exists but is not a token mint." };
  const i = p.info || {};
  return {
    ok: true, decimals: i.decimals, supply: i.supply ? Number(i.supply) / 10 ** (i.decimals || 0) : null,
    mintAuthority: i.mintAuthority || null, freezeAuthority: i.freezeAuthority || null,
    program: v.owner || null
  };
}

// Every token account the owner has for this mint, summed. A wallet can hold one mint in more
// than one account, and reading only the first under-reports the holding, which would quietly
// drop somebody into a lower band.
export async function splBalance(owner, mint) {
  const res = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  let total = 0;
  for (const r of (res && res.value) || []) {
    const a = r.account.data.parsed.info.tokenAmount;
    total += parseFloat(a.uiAmountString || a.uiAmount || 0);
  }
  return total;
}
