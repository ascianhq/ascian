import crypto from "node:crypto";
import { promisify } from "node:util";
import { cfg } from "./env.js";
import { q, one, tx } from "./db.js";
import { sha256, rand, fail, limited, ipKey } from "./util.js";
import { challenge, verify, isAddr } from "./wallet.js";
import { mailOn, sendMail } from "./mail.js";
const scrypt = promisify(crypto.scrypt);

export const COOKIE = "ascian_session";
// Sessions issued before the rename (24 Oct 2026) still arrive under the old name; they keep
// working until they expire, so nobody is signed out by the rename.
const OLD_COOKIE = "tally_session";
const sessionToken = req => { const c = cookies(req); return c[COOKIE] || c[OLD_COOKIE]; };
const DAY = 86400e3;
export const USER_RE = /^[A-Za-z0-9_]{3,32}$/;
const RESERVED = new Set(["admin", "support", "root", "api", "ascian", "system", "help", "official", "team", "mod", "staff"]);
export const reservedName = u => RESERVED.has(String(u).toLowerCase());
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

export async function hashPassword(p) { const salt = rand(16); return "s1$" + salt + "$" + (await scrypt(p, salt, 64)).toString("hex"); }
async function checkPassword(p, h) {
  if (!h) return false; const [, salt, hex] = h.split("$");
  const got = await scrypt(p, salt, 64); const want = Buffer.from(hex, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function cookies(req) {
  const out = {}; for (const p of (req.headers.cookie || "").split(/;\s*/)) { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); }
  return out;
}
export async function startSession(res, accountId) {
  const token = rand(32);
  await q("insert into sessions (token_hash, account_id, expires_at) values ($1,$2,$3)", [sha256(token), accountId, new Date(Date.now() + 30 * DAY)]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: cfg.secureCookies, sameSite: "lax", maxAge: 30 * DAY, path: "/" });
}
export async function sessionAccount(req) {
  const t = sessionToken(req); if (!t) return null;
  return one("select a.* from sessions s join accounts a on a.id=s.account_id where s.token_hash=$1 and s.expires_at>now()", [sha256(t)]);
}
export function needAuth(code) {
  return async (req, res, next) => {
    const a = await sessionAccount(req);
    if (!a) return fail(res, 401, code ? `Please sign in to use the workspace. (code W101)` : "Please sign in.");
    req.account = a; next();
  };
}
export async function optionalAuth(req, res, next) { req.account = await sessionAccount(req); next(); }

// Free credits for a new account, inside the creating transaction. The ref makes it once per account.
async function signupBonus(c, accountId, req) {
  if (!cfg.signupCredits) return;
  if (limited("signup-bonus:" + ipKey(req), 1, 24 * 3600e3)) return;
  const n = (await c.query("select count(*)::int n from ledger where kind='bonus' and created_at > now() - interval '1 day'")).rows[0].n;
  if (n >= cfg.signupDailyCap) return;
  await c.query("insert into ledger (account_id, kind, credits, source, ref) values ($1,'bonus',$2,'signup',$3) on conflict do nothing", [accountId, cfg.signupCredits, "signup:" + accountId]);
}

// A referral code is attached once, at account creation, and never rewritten. No self-referral.
async function referrerFor(ref, c) {
  if (!ref || !/^[a-z0-9_-]{1,32}$/i.test(ref)) return null;
  const r = (await c.query("select id from accounts where lower(ref_code)=lower($1) or lower(username)=lower($1) limit 1", [ref])).rows[0];
  return r ? r.id : null;
}

export function mount(app) {
  app.post("/api/auth/register", async (req, res) => {
    const { username, password, ref } = req.body || {};
    if (!USER_RE.test(username || "")) return fail(res, 400, "Use 3 to 32 letters, digits or underscores.");
    if (reservedName(username)) return fail(res, 400, "That @ is reserved.");
    if (typeof password !== "string" || password.length < 8 || password.length > 128) return fail(res, 400, "Use a password of 8 to 128 characters.");
    if (limited("reg:" + ipKey(req), 10, 3600e3)) return fail(res, 429, "Too many new accounts from here. Try again later.");
    const ph = await hashPassword(password);
    try {
      const id = await tx(async c => {
        const refId = await referrerFor(ref, c);
        const nid = (await c.query("insert into accounts (username, password_hash, ref_code, referred_by) values ($1,$2,$1,$3) returning id", [username, ph, refId])).rows[0].id;
        await signupBonus(c, nid, req);
        return nid;
      });
      await startSession(res, id); res.json({ ok: true });
    } catch (e) {
      if (e.code === "23505") return fail(res, 409, "That @ is taken. Sign in instead, or pick another.");
      throw e;
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (limited("login:" + ipKey(req), 20, 600e3)) return fail(res, 429, "Too many tries. Wait a few minutes.");
    const a = await one("select id, password_hash from accounts where lower(username)=lower($1)", [String(username || "")]);
    // 404 + unknown:true is how the page learns to offer "Create this account".
    if (!a) return res.status(404).json({ unknown: true, error: "No account with that username yet." });
    if (!(await checkPassword(String(password || ""), a.password_hash))) return fail(res, 401, "That password is not right.");
    await startSession(res, a.id); res.json({ ok: true });
  });

  app.post("/api/auth/request-code", async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail(res, 400, "That does not look like an email address.");
    if (!mailOn() && !cfg.devReturnCodes) return fail(res, 503, "Email sign-in is not switched on yet. Use a username or a wallet for now.");
    const recent = await one("select count(*)::int n from email_codes where lower(email)=$1 and created_at > now() - interval '1 hour'", [email]);
    if (recent.n >= 5 || limited("code:" + ipKey(req), 15, 3600e3)) return fail(res, 429, "Too many codes for that address. Try again within the hour.");
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    await q("insert into email_codes (email, purpose, code_hash, expires_at) values ($1,'signin',$2, now() + interval '10 minutes')", [email, sha256(email + ":" + code)]);
    if (cfg.devReturnCodes && !mailOn()) return res.json({ code });
    try { await sendMail(email, `Your ${cfg.brand} code: ${code}`, `Your sign-in code is ${code}.\n\nIt works for ten minutes. If you did not ask for it, ignore this email.`); }
    catch (e) { console.error("mail", e.message); return fail(res, 502, "The email could not be sent. Try again in a minute."); }
    res.json({ ok: true });
  });

  async function useCode(email, code, purpose) {
    const row = await one("select * from email_codes where lower(email)=$1 and purpose=$2 and not used and expires_at>now() order by id desc limit 1", [email, purpose]);
    if (!row) return false;
    if (row.code_hash !== sha256(email + ":" + String(code))) {
      await q("update email_codes set attempts=attempts+1, used = attempts+1>=5 where id=$1", [row.id]); return false;
    }
    await q("update email_codes set used=true where id=$1", [row.id]); return true;
  }
  app.post("/api/auth/verify", async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase(), { code, ref } = req.body || {};
    if (!/^\d{6}$/.test(String(code || ""))) return fail(res, 400, "That code is not valid.");
    if (!(await useCode(email, code, "signin"))) return fail(res, 400, "That code is not valid.");
    const id = await tx(async c => {
      const a = (await c.query("select id from accounts where lower(email)=$1", [email])).rows[0];
      if (a) return a.id;
      const refId = await referrerFor(ref, c);
      const nid = (await c.query("insert into accounts (email, referred_by) values ($1,$2) returning id", [email, refId])).rows[0].id;
      await signupBonus(c, nid, req);
      return nid;
    });
    await startSession(res, id); res.json({ ok: true });
  });

  app.post("/api/auth/wallet/challenge", async (req, res) => {
    const { address } = req.body || {};
    if (!isAddr(address)) return fail(res, 400, "That is not a wallet address.");
    if (limited("wch:" + ipKey(req), 30, 600e3)) return fail(res, 429, "Too many tries. Wait a few minutes.");
    res.json({ message: await challenge(address, "signin") });
  });
  app.post("/api/auth/wallet/verify", async (req, res) => {
    const { message, signature, ref } = req.body || {};
    let addr; try { addr = await verify(String(message || ""), String(signature || ""), "signin"); } catch (e) { return fail(res, 400, e.message); }
    const id = await tx(async c => {
      const a = (await c.query("select id from accounts where wallet=$1", [addr])).rows[0];
      if (a) return a.id;
      const refId = await referrerFor(ref, c);
      const nid = (await c.query("insert into accounts (wallet, referred_by) values ($1,$2) returning id", [addr, refId])).rows[0].id;
      await c.query("insert into wallet_links (account_id, address) values ($1,$2) on conflict do nothing", [nid, addr]);
      await signupBonus(c, nid, req);
      return nid;
    });
    await startSession(res, id); res.json({ ok: true });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const c = cookies(req);
    for (const t of [c[COOKIE], c[OLD_COOKIE]]) if (t) await q("delete from sessions where token_hash=$1", [sha256(t)]);
    res.clearCookie(COOKIE, { path: "/" }); res.clearCookie(OLD_COOKIE, { path: "/" }); res.json({ ok: true });
  });
  app.post("/api/auth/logout-all", async (req, res) => {
    const a = await sessionAccount(req); if (a) await q("delete from sessions where account_id=$1", [a.id]);
    res.clearCookie(COOKIE, { path: "/" }); res.clearCookie(OLD_COOKIE, { path: "/" }); res.json({ ok: true });
  });

  // Referral link: first touch wins, 30 days, readable by the sign-in page's script.
  app.get("/r/:code", (req, res) => {
    const code = String(req.params.code || "").toLowerCase();
    if (/^[a-z0-9_-]{1,32}$/.test(code) && !cookies(req).ascian_ref && !cookies(req).tally_ref)
      res.cookie("ascian_ref", code, { httpOnly: false, secure: cfg.secureCookies, sameSite: "lax", maxAge: 30 * DAY, path: "/" });
    res.redirect(302, "/signin?ref=" + encodeURIComponent(code));
  });
  return { useCode };
}
