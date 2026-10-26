import crypto from "node:crypto";
import { cfg } from "./env.js";
import { q, one, tx } from "./db.js";
import { fail, sha256, urlsafe, limited, ipKey } from "./util.js";
import { balanceOf, CREDITS_PER_USD } from "./ledger.js";
import { needAuth, USER_RE, reservedName, hashPassword } from "./auth.js";
import { challenge, verify, isAddr, tokenBalance } from "./wallet.js";
import { token as liveToken } from "./launch.js";
import { mailOn, sendMail } from "./mail.js";

const SUPPLY = 1e9;
const BANDS = [[0.1, "Holder"], [0.5, "Day-one models"], [1, "Priority routing"], [2, "Roadmap input"], [4, "Fee-free"]];
function walletInfo(w) {
  if (!w) return null;
  const pct = w.balance == null ? null : (100 * w.balance) / SUPPLY;
  const band = pct == null ? null : ([...BANDS].reverse().find(b => pct >= b[0]) || [null, null])[1];
  const next = pct == null ? null : BANDS.find(b => pct < b[0]);
  return { address: w.address, verifiedAt: w.verified_at, balance: w.balance, pctHeld: pct, band,
    nextBand: next ? { pct: next[0], name: next[1] } : null, feeDiscount: pct == null ? 0 : Math.min(100, Math.round(25 * pct * 100) / 100) };
}
async function readHolding(accountId, address) {
  // Balances come from the token contract, never from an explorer.
  const bal = await tokenBalance(address);
  if (bal == null) return null;
  await q("update wallet_links set balance=$2, read_at=now() where account_id=$1", [accountId, bal]);
  return bal;
}

export function mount(app) {
  const auth = needAuth();
  app.get("/api/account", auth, async (req, res) => {
    const a = req.account, b = await balanceOf(a.id);
    const act = (await q("select created_at as at, kind, credits, source, model from ledger where account_id=$1 order by id desc limit 200", [a.id])).rows;
    const used = await one("select coalesce(-sum(credits),0) s from ledger where account_id=$1 and kind='spend'", [a.id]);
    res.set("cache-control", "no-store").json({
      email: a.email, username: a.username, wallet: a.wallet, hasPassword: !!a.password_hash, hasAvatar: !!a.avatar,
      avatarVersion: a.avatar_v, createdAt: a.created_at, credits: b.credits, available: b.available,
      usageValueUsd: Math.round((used.s / CREDITS_PER_USD) * 100) / 100, activity: act
    });
  });
  app.get("/api/me", auth, (req, res) => { const a = req.account; res.json({ id: String(a.id), email: a.email, username: a.username, wallet: a.wallet }); });

  app.post("/api/account/username", auth, async (req, res) => {
    const u = String((req.body || {}).username || "");
    if (!USER_RE.test(u)) return fail(res, 400, "Use 3 to 32 letters, digits or underscores.");
    if (reservedName(u)) return fail(res, 400, "That @ is reserved.");
    try {
      // The @ doubles as the referral code while the account has none.
      await q("update accounts set username=$2, ref_code=coalesce(ref_code,$2) where id=$1", [req.account.id, u]);
    } catch (e) { if (e.code === "23505") return fail(res, 409, "That @ is taken."); throw e; }
    res.json({ ok: true });
  });

  app.post("/api/account/avatar", auth, async (req, res) => {
    const m = String((req.body || {}).image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return fail(res, 400, "Send a JPEG, PNG or WebP picture.");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 300e3) return fail(res, 413, "That picture is too big.");
    await q("update accounts set avatar=$2, avatar_v=avatar_v+1 where id=$1", [req.account.id, buf]); res.json({ ok: true });
  });
  app.delete("/api/account/avatar", auth, async (req, res) => { await q("update accounts set avatar=null where id=$1", [req.account.id]); res.json({ ok: true }); });
  app.get("/api/avatars/:username", async (req, res) => {
    const a = await one("select avatar from accounts where lower(username)=lower($1)", [req.params.username]);
    if (!a || !a.avatar) return res.status(404).end();
    const b = a.avatar, mime = b[0] === 0x89 ? "image/png" : b[0] === 0x52 ? "image/webp" : "image/jpeg";
    res.set({ "content-type": mime, "cache-control": "public, max-age=300" }).send(b);
  });

  app.post("/api/account/email/request", auth, async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return fail(res, 400, "That does not look like an email address.");
    if (!mailOn()) return fail(res, 503, "Email is not switched on yet.");
    if (await one("select 1 from accounts where lower(email)=$1 and id<>$2", [email, req.account.id])) return fail(res, 409, "That email belongs to another account.");
    if (limited("attach:" + req.account.id, 5, 3600e3)) return fail(res, 429, "Too many codes. Try again within the hour.");
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    await q("insert into email_codes (email, purpose, account_id, code_hash, expires_at) values ($1,'attach',$2,$3, now() + interval '10 minutes')", [email, req.account.id, sha256(email + ":" + code)]);
    try { await sendMail(email, `Your ${cfg.brand} code: ${code}`, `Enter ${code} to add this email to your account. It works for ten minutes.`); }
    catch { return fail(res, 502, "The email could not be sent. Try again in a minute."); }
    res.json({ ok: true });
  });
  app.post("/api/account/email/verify", auth, async (req, res) => {
    const email = String((req.body || {}).email || "").trim().toLowerCase(), code = String((req.body || {}).code || "");
    const row = await one("select * from email_codes where lower(email)=$1 and purpose='attach' and account_id=$2 and not used and expires_at>now() order by id desc limit 1", [email, req.account.id]);
    if (!row || row.code_hash !== sha256(email + ":" + code)) {
      if (row) await q("update email_codes set attempts=attempts+1, used = attempts+1>=5 where id=$1", [row.id]);
      return fail(res, 400, "That code is not valid.");
    }
    await q("update email_codes set used=true where id=$1", [row.id]);
    try { await q("update accounts set email=$2 where id=$1", [req.account.id, email]); }
    catch (e) { if (e.code === "23505") return fail(res, 409, "That email belongs to another account."); throw e; }
    res.json({ ok: true });
  });

  app.post("/api/account/password", auth, async (req, res) => {
    const { password, current, username } = req.body || {}, a = req.account;
    if (typeof password !== "string" || password.length < 8 || password.length > 128) return fail(res, 400, "Use a password of 8 to 128 characters.");
    if (a.password_hash) {
      const { default: c } = await import("node:crypto");
      const [, salt, hex] = a.password_hash.split("$");
      const got = await new Promise((ok, no) => c.scrypt(String(current || ""), salt, 64, (e, k) => (e ? no(e) : ok(k))));
      if (!c.timingSafeEqual(got, Buffer.from(hex, "hex"))) return fail(res, 401, "The current password is not right.");
    }
    let u = a.username;
    if (!u) {
      if (!USER_RE.test(username || "")) return fail(res, 400, "Pick an @ first: 3 to 32 letters, digits or underscores.");
      if (reservedName(username)) return fail(res, 400, "That @ is reserved.");
      u = username;
    }
    try { await q("update accounts set password_hash=$2, username=$3, ref_code=coalesce(ref_code,$3) where id=$1", [a.id, await hashPassword(password), u]); }
    catch (e) { if (e.code === "23505") return fail(res, 409, "That @ is taken."); throw e; }
    res.json({ ok: true });
  });

  // Wallet link for the token holding.
  app.get("/api/account/wallet", auth, async (req, res) => {
    res.set("cache-control", "no-store").json({ wallet: walletInfo(await one("select * from wallet_links where account_id=$1", [req.account.id])) });
  });
  app.post("/api/account/wallet/challenge", auth, async (req, res) => {
    const { address } = req.body || {};
    if (!isAddr(address)) return fail(res, 400, "That is not a wallet address.");
    res.json({ message: await challenge(address, "link", req.account.id) });
  });
  app.post("/api/account/wallet", auth, async (req, res) => {
    let addr; try { addr = await verify(String(req.body?.message || ""), String(req.body?.signature || ""), "link", req.account.id); } catch (e) { return fail(res, 400, e.message); }
    // base58 is case sensitive, so the address is compared as it is, not lowercased.
    const other = await one("select account_id from wallet_links where address=$1 and account_id<>$2", [addr, req.account.id]);
    if (other) return fail(res, 409, "That wallet is linked to another account.");
    await q("insert into wallet_links (account_id, address) values ($1,$2) on conflict (account_id) do update set address=$2, verified_at=now(), balance=null, read_at=null", [req.account.id, addr]);
    await readHolding(req.account.id, addr).catch(() => {});
    res.json({ wallet: walletInfo(await one("select * from wallet_links where account_id=$1", [req.account.id])) });
  });
  app.delete("/api/account/wallet", auth, async (req, res) => {
    const a = req.account;
    // A wallet that is the only way in cannot be unlinked, or the account is lost.
    if (a.wallet && !a.email && !a.password_hash) return fail(res, 400, "This wallet is your only way in. Add an email or a password first.");
    await q("delete from wallet_links where account_id=$1", [a.id]); res.json({ ok: true });
  });
  app.post("/api/account/wallet/refresh", auth, async (req, res) => {
    if (!(await liveToken())) return fail(res, 503, "The balance read is not switched on yet.");
    const w = await one("select * from wallet_links where account_id=$1", [req.account.id]);
    if (!w) return fail(res, 400, "Link a wallet first.");
    try { await readHolding(req.account.id, w.address); } catch { return fail(res, 502, "The chain did not answer. Try again in a minute."); }
    res.json({ wallet: walletInfo(await one("select * from wallet_links where account_id=$1", [req.account.id])) });
  });

  // Referrals.
  app.get("/api/account/referrals", auth, async (req, res) => {
    const a = req.account;
    const refs = (await q(`select r.created_at as joined, exists(select 1 from ledger l where l.account_id=r.id and l.kind='deposit') as funded
                           from accounts r where r.referred_by=$1 order by r.id desc`, [a.id])).rows;
    const paid = await one("select coalesce(sum(credits),0) s from ledger where account_id=$1 and kind='referral'", [a.id]);
    const by = a.referred_by ? await one("select coalesce(username, ref_code) n from accounts where id=$1", [a.referred_by]) : null;
    res.set("cache-control", "no-store").json({
      code: a.ref_code, suggested: a.username || null, shareRate: 0.1, depositBonusRate: 0.1,
      referred: refs.length, funded: refs.filter(r => r.funded).length, paidCredits: paid.s, accruedCredits: 0,
      referredBy: by ? by.n : null, recent: refs.slice(0, 5)
    });
  });
  app.post("/api/account/referral-code", auth, async (req, res) => {
    const c = String((req.body || {}).code || "");
    if (!USER_RE.test(c)) return fail(res, 400, "Use 3 to 32 letters, digits or underscores.");
    if (reservedName(c)) return fail(res, 400, "That code is reserved.");
    const clash = await one("select 1 from accounts where (lower(ref_code)=lower($1) or lower(username)=lower($1)) and id<>$2", [c, req.account.id]);
    if (clash) return fail(res, 409, "That code is taken.");
    await q("update accounts set ref_code=$2 where id=$1", [req.account.id, c]); res.json({ ok: true });
  });

  // API keys: shown once, stored as a hash.
  app.get("/api/account/keys", auth, async (req, res) => {
    const keys = (await q("select id::text, name, prefix, daily_cap as \"dailyCapCredits\", last_used_at as \"lastUsedAt\" from api_keys where account_id=$1 and revoked_at is null order by id desc", [req.account.id])).rows;
    res.json({ keys });
  });
  app.post("/api/account/keys", auth, async (req, res) => {
    const name = String((req.body || {}).name || "Untitled key").slice(0, 60) || "Untitled key";
    const capRaw = (req.body || {}).dailyCapCredits, cap = capRaw == null || capRaw === "" ? null : Number(capRaw);
    if (cap != null && !(cap > 0)) return fail(res, 400, "The daily cap must be a positive number of credits.");
    const n = await one("select count(*)::int n from api_keys where account_id=$1 and revoked_at is null", [req.account.id]);
    if (n.n >= 20) return fail(res, 400, "At most 20 active keys. Revoke one first.");
    if (limited("keys:" + req.account.id, 10, 3600e3)) return fail(res, 429, "Too many new keys this hour.");
    const key = `${cfg.brand}_live_` + urlsafe(32);
    await q("insert into api_keys (account_id, name, prefix, key_hash, daily_cap) values ($1,$2,$3,$4,$5)", [req.account.id, name, key.slice(0, key.length - 28), sha256(key), cap]);
    res.json({ key });
  });
  app.delete("/api/account/keys/:id", auth, async (req, res) => {
    await q("update api_keys set revoked_at=now() where id=$1 and account_id=$2", [req.params.id, req.account.id]); res.json({ ok: true });
  });
}
