// Tiny .env loader: one dependency less than dotenv, and Railway sets real env anyway.
import fs from "node:fs";
try {
  for (const line of fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}
const e = process.env;
export const cfg = {
  port: +(e.PORT || 8080),
  databaseUrl: e.DATABASE_URL || "postgres://app:app@localhost/ascian",
  siteUrl: (e.SITE_URL || "http://localhost:8789").replace(/\/$/, ""),
  mediaDir: e.MEDIA_DIR || "/tmp/ascian-media",
  // Model gateway (PPQ). Empty key = model access switched off (W103), the site still works.
  ppqBase: (e.PPQ_BASE || "https://api.ppq.ai").replace(/\/$/, ""),
  ppqKey: e.PPQ_API_KEY || "",
  // Test stand-in: with no PPQ key, chat for the accounts listed in STANDIN_ACCOUNTS (wallet,
  // username or email, comma separated) is answered by one Anthropic model whatever model was picked.
  // Everyone else still gets W103. Images and video stay off in this mode.
  anthropicKey: e.ANTHROPIC_API_KEY || "",
  anthropicBase: (e.ANTHROPIC_BASE || "https://api.anthropic.com").replace(/\/$/, ""),
  standinModel: e.STANDIN_MODEL || "claude-haiku-4-5",
  standinAccounts: (e.STANDIN_ACCOUNTS || "").split(",").map(s => s.trim()).filter(Boolean),
  // Free credits for every new account. 0 switches it off. One per network (/24) a day and at most
  // SIGNUP_DAILY_CAP a day across the site, so a script making wallets cannot drain the upstream key.
  signupCredits: Math.max(0, +(e.SIGNUP_CREDITS || 0)),
  signupDailyCap: Math.max(0, +(e.SIGNUP_DAILY_CAP || 100)),
  // Payments (NOWPayments). Empty key = top-up shows "could not load payment options".
  npBase: (e.NOWPAYMENTS_BASE || "https://api.nowpayments.io/v1").replace(/\/$/, ""),
  npKey: e.NOWPAYMENTS_API_KEY || "",
  npIpnSecret: e.NOWPAYMENTS_IPN_SECRET || "",
  // Mail (Resend). Empty = email sign-in answers "not switched on yet".
  resendKey: e.RESEND_API_KEY || "",
  mailFrom: e.MAIL_FROM || "",
  // Token holding read. The live mint comes from the settings table (the panel writes it);
  // TOKEN_ADDRESS stays as the fallback for a deployment where nothing has been saved yet.
  // Nothing here is lowercased: a Solana address is base58 and case sensitive.
  tokenExcluded: (e.TOKEN_EXCLUDED || "").split(",").map(s => s.trim()).filter(Boolean),
  dexChain: e.DEX_CHAIN || "solana",
  explorerBase: (e.EXPLORER_BASE || "https://solscan.io").replace(/\/$/, ""),
  brand: e.BRAND || "ascian",
  // Never on in production: hands the email code back to the browser.
  devReturnCodes: e.DEV_RETURN_CODES === "1",
  secureCookies: e.SECURE_COOKIES !== "0",
  roadmapWebhook: e.ROADMAP_WEBHOOK || ""
};
