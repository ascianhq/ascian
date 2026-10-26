// End to end through HTTP, the same way the compiled frontend calls it. Mocks stand in for
// PPQ and NOWPayments; everything else (Postgres, ledger, holds, SSE) is the real code.
// Run: node test/e2e.mjs            add --break to prove the checks can fail.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import * as ppq from "../mock/ppq.mjs";
import * as np from "../mock/nowpayments.mjs";
import * as front from "./front.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
// The deployed site, for the static pages and the terminal client the last check runs.
// Default: the site folder next to this one, ../site.
const SITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..",
  process.env.SITE_ROOT || "../site");
const BREAK = process.argv.includes("--break");
const API = 18080, PPQ = 18081, NP = 18082, WEB = 18083, B = `http://localhost:${WEB}`;
ppq.start(PPQ); np.start(NP);
const env = { ...process.env, PORT: String(API), DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://app:app@localhost/ascian_test",
  PPQ_BASE: `http://localhost:${PPQ}`, PPQ_API_KEY: "sk-test", NOWPAYMENTS_BASE: `http://localhost:${NP}`, NOWPAYMENTS_API_KEY: "np-test",
  NOWPAYMENTS_IPN_SECRET: "ipn-secret", ADMIN_TOKEN: "adm-test-token-123", SITE_URL: B, MEDIA_DIR: "/tmp/ascian-media-test", SECURE_COOKIES: "0", DEV_RETURN_CODES: "1" };
{ const pg = (await import("pg")).default; const c = new pg.Client(env.DATABASE_URL); await c.connect(); await c.query("drop schema public cascade; create schema public"); await c.end(); }
const srv = spawn("node", ["src/server.js"], { env, cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => (log += d)); srv.stderr.on("data", d => (log += d));
front.start(WEB, SITE_ROOT, API);
await new Promise(r => { const t = setInterval(() => { if (/api on/.test(log)) { clearInterval(t); r(); } }, 100); setTimeout(r, 8000); });

let pass = 0, failN = 0;
const ok = (cond, name, extra = "") => { if (BREAK && name === "deposit credits the balance") cond = !cond; if (cond) pass++; else { failN++; console.log("FAIL", name, extra); } };
function client() {
  let cookie = "";
  return async (path, opt = {}) => {
    const r = await fetch(B + path, { ...opt, redirect: "manual", headers: { "content-type": "application/json", cookie, ...(opt.headers || {}) }, body: opt.body && typeof opt.body !== "string" ? JSON.stringify(opt.body) : opt.body });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) { const kv = c.split(";")[0]; const k = kv.split("=")[0]; cookie = cookie.split("; ").filter(x => x && !x.startsWith(k + "=")).concat(kv).join("; "); }
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : ct.includes("event-stream") ? null : await r.text();
    return { status: r.status, headers: r.headers, data, raw: ct.includes("event-stream") ? r : { text: async () => JSON.stringify(data) } };
  };
}
const u = "t" + crypto.randomBytes(4).toString("hex");

// Auth
const A = client();
ok((await A("/api/account")).status === 401, "signed out is 401");
ok((await A("/api/auth/login", { method: "POST", body: { username: u, password: "password1" } })).data.unknown === true, "unknown user is 404 unknown:true");
ok((await A("/api/auth/register", { method: "POST", body: { username: u, password: "password1" } })).status === 200, "register");
let acc = (await A("/api/account")).data;
ok(acc.username === u && acc.credits === 0 && acc.hasPassword, "account after register", JSON.stringify(acc));
ok((await A("/api/auth/register", { method: "POST", body: { username: u, password: "password1" } })).status === 409, "duplicate username refused");
const L = client();
ok((await L("/api/auth/login", { method: "POST", body: { username: u, password: "wrongpass" } })).status === 401, "wrong password is 401 not 404");
ok((await L("/api/auth/login", { method: "POST", body: { username: u.toUpperCase(), password: "password1" } })).status === 200, "login is case-insensitive");

// Referral: /r/<code> sets the cookie; the new account is attached to the referrer.
const Rf = client();
const rr = await Rf("/r/" + u); ok(rr.status === 302 && /ascian_ref=/.test(rr.headers.get("set-cookie") || ""), "referral link sets cookie");
const u2 = u + "b";
await Rf("/api/auth/register", { method: "POST", body: { username: u2, password: "password2", ref: u } });
const refs = (await A("/api/account/referrals")).data; ok(refs.referred === 1 && refs.code === u, "referral recorded", JSON.stringify(refs));

// Email code (dev shortcut returns the code)
const E = client(); const em = u + "@example.com";
const rc = await E("/api/auth/request-code", { method: "POST", body: { email: em } });
ok(/^\d{6}$/.test(rc.data.code || ""), "request-code");
ok((await E("/api/auth/verify", { method: "POST", body: { email: em, code: "000000" === rc.data.code ? "111111" : "000000" } })).status === 400, "wrong code refused");
ok((await E("/api/auth/verify", { method: "POST", body: { email: em, code: rc.data.code } })).status === 200, "email verify signs in");
ok((await E("/api/account")).data.email === em, "email account");

// Wallet sign-in with a real Solana signature: ed25519 over the raw message, the way Phantom
// signs it. The address is the public key in base58, case and all.
const { ed25519 } = await import("@noble/curves/ed25519");
const B58A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = b => { let n = 0n; for (const x of b) n = n * 256n + BigInt(x); let o = ""; while (n > 0n) { o = B58A[Number(n % 58n)] + o; n /= 58n; } for (const x of b) { if (x) break; o = "1" + o; } return o; };
const skey = ed25519.utils.randomPrivateKey(), addr = b58(ed25519.getPublicKey(skey));
const Wc = client();
const ch = (await Wc("/api/auth/wallet/challenge", { method: "POST", body: { address: addr } })).data.message;
const sigB58 = b58(ed25519.sign(new TextEncoder().encode(ch), skey));
ok((await Wc("/api/auth/wallet/verify", { method: "POST", body: { message: ch, signature: sigB58 } })).status === 200, "wallet sign-in");
ok((await Wc("/api/auth/wallet/verify", { method: "POST", body: { message: ch, signature: sigB58 } })).status === 400, "challenge is single-use");
ok((await Wc("/api/account")).data.wallet === addr, "wallet account keeps base58 case");
{ // a signature from another key over the same message must be refused
  const other = ed25519.utils.randomPrivateKey();
  const ch2 = (await Wc("/api/auth/wallet/challenge", { method: "POST", body: { address: addr } })).data.message;
  const bad = b58(ed25519.sign(new TextEncoder().encode(ch2), other));
  ok((await Wc("/api/auth/wallet/verify", { method: "POST", body: { message: ch2, signature: bad } })).status === 400, "signature from another wallet is refused");
}
ok((await Wc("/api/auth/wallet/challenge", { method: "POST", body: { address: "0x" + "a".repeat(40) } })).status === 400, "an EVM address is not a wallet address");

// Models and catalogue
const mods = (await A("/api/models")).data; ok(Array.isArray(mods.data) && mods.data.length > 100, "models list");
const vm = (await A("/api/video/models")).data.data; ok(vm.length > 5 && vm[0].prices, "video models", JSON.stringify(vm[0]).slice(0, 200));

// Chat without credits: 402 with needed
const c402 = await A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], stream: true } });
ok(c402.status === 402 && c402.data.needed > 0, "chat without credits is 402", JSON.stringify(c402.data));

// Deposit: assets, create, IPN with a bad and a good signature, idempotent replay
const as = (await A("/api/deposits/assets")).data; ok(as.provider === "nowpayments" && as.assets.some(a => a.id === "btc"), "deposit assets");
ok(as.assets.find(a => a.id === "usdttrc20").minUsd === 15 && as.assets.find(a => a.id === "btc").minUsd === 5, "per-coin minimum from NOWPayments", JSON.stringify(as.assets.map(a => a.id + ":" + a.minUsd)));
const low = await A("/api/deposits", { method: "POST", body: { amountUsd: 10, crypto: "usdttrc20" } });
ok(low.status === 400 && /\$15/.test(low.data.error), "top-up under a coin's minimum refused with the minimum", JSON.stringify(low.data));
const dep = (await A("/api/deposits", { method: "POST", body: { amountUsd: 25, crypto: "btc" } })).data;
ok(dep.depositId && dep.address && dep.amountCrypto, "deposit created", JSON.stringify(dep));
if (!dep.depositId) { console.log(log.slice(-1500)); process.exit(1); }
const pay = [...np.all.values()].find(p => p.order_id === dep.depositId);
const ipnBody = { ...np.setStatus(pay.payment_id, "finished", pay.pay_amount) };
const sign = b => { const s = o => Array.isArray(o) ? o.map(s) : o && typeof o === "object" ? Object.keys(o).sort().reduce((a, k) => ((a[k] = s(o[k])), a), {}) : o; return crypto.createHmac("sha512", "ipn-secret").update(JSON.stringify(s(b))).digest("hex"); };
ok((await A("/api/deposits/ipn", { method: "POST", body: ipnBody, headers: { "x-nowpayments-sig": "00" } })).status === 401, "IPN with bad signature refused");
ok((await A("/api/deposits/ipn", { method: "POST", body: ipnBody, headers: { "x-nowpayments-sig": sign(ipnBody) } })).status === 200, "IPN accepted");
await A("/api/deposits/ipn", { method: "POST", body: ipnBody, headers: { "x-nowpayments-sig": sign(ipnBody) } });
acc = (await A("/api/account")).data;
ok(acc.credits === 25000, "deposit credits the balance", String(acc.credits));
const tr = (await A("/api/deposits/" + dep.depositId)).data; ok(tr.stage === "credited" && tr.creditedUsd === 25, "tracker says credited", JSON.stringify(tr));
const refAcc = (await Rf("/api/account")).data; // Rf is the referred account
const refPay = (await A("/api/account/referrals")).data;
ok(refPay.paidCredits === 0, "no bonus for own deposit");
// Referred account deposits: referrer gets 10%
const d2 = (await Rf("/api/deposits", { method: "POST", body: { amountUsd: 10, crypto: "sol" } })).data;
const p2 = [...np.all.values()].find(p => p.order_id === d2.depositId);
const b2 = { ...np.setStatus(p2.payment_id, "finished", p2.pay_amount) };
await Rf("/api/deposits/ipn", { method: "POST", body: b2, headers: { "x-nowpayments-sig": sign(b2) } });
ok((await A("/api/account/referrals")).data.paidCredits === 1000, "referrer gets 10% of a referred top-up");
// Status read through the tracker when no IPN arrives (partial payment, pro rata)
const d3 = (await A("/api/deposits", { method: "POST", body: { amountUsd: 20, crypto: "eth" } })).data;
const p3 = [...np.all.values()].find(p => p.order_id === d3.depositId);
np.setStatus(p3.payment_id, "partially_paid", p3.pay_amount / 2);
const t3 = (await A("/api/deposits/" + d3.depositId)).data;
ok(t3.stage === "credited" && t3.status === "partially_paid" && t3.creditedUsd === 10, "partial payment credited pro rata via poll", JSON.stringify(t3));

// Chat stream: frames, receipt, balance goes down by exactly the receipt
const before = (await A("/api/account")).data.credits;
const ref = "r" + crypto.randomBytes(12).toString("hex");
const st = await A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "hello" }], stream: true, client_ref: ref } });
ok(/event-stream/.test(st.headers.get("content-type")), "chat answers with SSE");
const txt = await st.raw.text(); const frames = txt.split("\n\n").filter(x => x.startsWith("data:")).map(x => JSON.parse(x.slice(5)));
ok(frames.some(f => f.thinking) && frames.filter(f => f.delta).map(f => f.delta).join("") === "Hello from the mock model.", "thinking and delta frames", txt.slice(0, 300));
const done = frames.find(f => f.done);
const expect = Math.round(((1000 * 2.11 + 2000 * 10.55) / 1e3) * 1e4) / 1e4;
ok(done && Math.abs(done.credits - expect) < 1e-6 && done.thought >= 1, "done frame charges usage x rate", JSON.stringify(done) + " expect " + expect);
const after = (await A("/api/account")).data;
ok(Math.abs(before - after.credits - done.credits) < 1e-6 && after.available === after.credits, "balance moved by the receipt, no hold left", `${before} ${after.credits} ${after.available}`);
const run = (await A("/api/chat/run/" + ref)).data; ok(run.status === "done" && run.text === "Hello from the mock model.", "run registry recovers text");
ok((await Rf("/api/chat/run/" + ref)).status === 404, "runs are per account");
// Empty answer: error frame, nothing charged
const b4 = (await A("/api/account")).data.credits;
const em2 = await (await A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "empty please" }], stream: true } })).raw.text();
ok(/W513/.test(em2) && (await A("/api/account")).data.credits === b4, "empty answer not charged");
// Gateway error: not charged, W412
const ge = await (await A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "fail please" }], stream: true } })).raw.text();
ok(/W41/.test(ge) && (await A("/api/account")).data.credits === b4, "gateway failure not charged", ge.slice(0, 200));
// Stop mid-stream
const ref2 = "r" + crypto.randomBytes(12).toString("hex");
const sp = A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "user", content: "slow please" }], stream: true, client_ref: ref2 } });
await new Promise(r => setTimeout(r, 2200)); await A(`/api/chat/run/${ref2}/stop`, { method: "POST" });
const spt = await (await sp).raw.text(); const sdone = spt.split("\n\n").filter(x => x.startsWith("data:")).map(x => JSON.parse(x.slice(5))).find(f => f.done);
ok(sdone && sdone.stopped === true, "stop ends with stopped:true", spt.slice(-200));
// Validation codes
ok(/W105/.test((await A("/api/chat", { method: "POST", body: { model: "claude-sonnet-5", messages: [{ role: "system", content: "x" }] } })).data.error), "system role W105");
ok(/W201/.test((await A("/api/chat", { method: "POST", body: { model: "nope", messages: [{ role: "user", content: "x" }] } })).data.error), "unknown model W201");

// Image model: JSON answer, stored image under /api/, library lists it
const im = await A("/api/chat", { method: "POST", body: { model: "google/gemini-3.1-flash-image", messages: [{ role: "user", content: "a cat" }], stream: false, client_ref: "r" + "a".repeat(24) } });
ok(im.status === 200 && im.data.images?.[0]?.startsWith("/api/images/") && im.data.credits === 39, "image turn", JSON.stringify(im.data));
const imgr = await A(im.data.images[0]); ok(imgr.status === 200 && imgr.headers.get("content-type") === "image/png", "image served to owner");
ok((await Rf(im.data.images[0])).status === 404, "image hidden from others");
const lib = (await A("/api/library")).data; ok(lib.images.length === 1 && lib.images[0].model === "google/gemini-3.1-flash-image", "library");
ok((await A("/api/images/run/r" + "a".repeat(24))).data.status === "done", "image run recovery");

// Video: start, poll to completed, file served, charged the gateway cost
const vmodel = vm.find(v => v.id === "kling-2.5-turbo") || vm[0];
const vs = await A("/api/video", { method: "POST", body: { model: vmodel.id, prompt: "a boat", aspectRatio: "16:9", duration: "5" } });
ok(vs.status === 200 && vs.data.id, "video started", JSON.stringify(vs.data));
let vj; for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 1500)); vj = (await A("/api/video/" + vs.data.id)).data; if (vj.status === "completed") break; }
ok(vj.status === "completed" && vj.credits === 402.5, "video completed and charged", JSON.stringify(vj));
const vf = await A("/api/video/" + vs.data.id + "/file", { headers: { range: "bytes=0-99" } });
ok(vf.status === 206 && vf.headers.get("content-range") === "bytes 0-99/2048", "video file with Range");

// Conversations
await A("/api/conversations/c1", { method: "PUT", body: { title: "T", door: "ask", messages: [{ role: "user", content: "x" }], updatedAt: 5 } });
await A("/api/conversations/c1", { method: "PUT", body: { title: "old", door: "ask", messages: [], updatedAt: 1 } });
const cv = (await A("/api/conversations")).data.conversations; ok(cv.length === 1 && cv[0].title === "T", "older write does not overwrite newer");
ok((await A("/api/conversations", { method: "DELETE" })).data.deleted === 1, "delete all chats");

// API keys and /v1
const k = (await A("/api/account/keys", { method: "POST", body: { name: "ci", dailyCapCredits: "5" } })).data.key;
ok(/^ascian_live_[A-Za-z0-9]{32}$/.test(k), "key format", k);
const k2 = (await A("/api/account/keys", { method: "POST", body: { name: "cli" } })).data.key;
const V = (p, o = {}) => fetch(B + p, { ...o, headers: { authorization: "Bearer " + k, "content-type": "application/json" } });
ok((await (await V("/v1/models")).json()).data.length > 50, "/v1/models");
const nc = await (await V("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 50 }) })).json();
ok(nc.choices?.[0]?.message?.content === "Hello from the mock model." && typeof nc.ascian?.credits_charged === "number", "/v1 non-stream", JSON.stringify(nc).slice(0, 300));
const capHit = await V("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }) });
ok(capHit.status === 429, "daily cap enforced", String(capHit.status));
ok((await fetch(B + "/v1/models", { headers: { authorization: "Bearer ascian_live_nope" } })).status === 401, "/v1 bad key 401");
const act = (await A("/api/account")).data.activity; ok(act.some(x => x.source === "api") && act.some(x => x.kind === "deposit"), "activity lists api and deposit");

const sc = (await A("/api/site-config")).data;
ok(sc.token === "" && "xUrl" in sc && "buyUrl" in sc, "site-config before launch", JSON.stringify(sc));
const ts = (await A("/api/token-stats")).data; ok(ts.live === false && ts.priceUsd === null, "token-stats before launch");
// Operator panel
const ADM = (p, o = {}) => fetch(B + "/api/admin" + p, { ...o, headers: { "x-admin-token": "adm-test-token-123" } });
{ const r0 = await fetch(B + "/api/admin/summary", { headers: { "x-admin-token": "nope-nope-nope-nope" } }); ok(r0.status === 401, "admin refuses a wrong token", "status " + r0.status); }
const sum = await (await ADM("/summary")).json();
const liabSql = sum.liabilityCredits;
ok(sum.accounts.total >= 4 && sum.deposits.credited >= 3 && liabSql > 0 && sum.ppq.ok === false, "admin summary", JSON.stringify({ a: sum.accounts, d: sum.deposits, l: liabSql, p: sum.ppq }));
const found = (await (await ADM("/accounts?q=" + u2)).json()).accounts;
ok(found.length === 1 && found[0].username === u2, "admin finds an account");
ok((await (await ADM("/accounts/" + found[0].id + "/delete", { method: "POST" })).json()).deleted === 1, "admin deletes an account");
ok((await Rf("/api/account")).status === 401, "deleted account's session is gone");
const bk = await ADM("/backup"); const zlib = await import("node:zlib");
const dumpJ = JSON.parse(zlib.gunzipSync(Buffer.from(await bk.arrayBuffer())).toString());
ok(dumpJ.tables.ledger.length > 5 && dumpJ.tables.accounts.every(a => a.username !== u2), "backup download is a readable dump");
ok((await fetch(B + "/api/admin")).status === 200, "panel page served");
{ // Only misses count; the right token always gets through and clears the counter,
  // otherwise a stranger could lock the owner out of their own panel.
  const wrong = () => fetch(B + "/api/admin/summary", { headers: { "x-admin-token": "nope-nope-nope-nope" } });
  const seen = [];
  for (let i = 0; i < 12; i++) seen.push((await wrong()).status);
  ok(seen.slice(0, 10).every(c => c === 401), "the first ten wrong tokens answer 401", seen.join(","));
  ok(seen.slice(10).every(c => c === 429), "wrong tokens past the limit are refused", seen.join(","));
  ok((await ADM("/summary")).status === 200, "the right token passes even while misses are capped");
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await ADM("/summary")).status);
  ok(codes.every(c => c === 200), "panel calls never lock the operator out", codes.join(","));
  ok((await wrong()).status === 401, "after a right token the miss counter starts over");
}

// Launch settings: the whole point is that pasting the mint in the panel is enough.
// Not through ADM: it replaces the headers object, which would drop the content type and
// leave the server with an unparsed body.
const JPOST = (p, body) => fetch(B + "/api/admin" + p, { method: "POST", headers: { "x-admin-token": "adm-test-token-123", "content-type": "application/json" }, body: JSON.stringify(body) });
{
  const before = (await A("/api/site-config")).data;
  ok(before.token === "" && before.buyUrl === "" && before.explorerUrl === "", "site-config is empty before the mint is set", JSON.stringify(before));

  ok((await JPOST("/launch", { token: "0x" + "a".repeat(40) })).status === 400, "an EVM address is refused as a mint");
  ok((await JPOST("/launch", { token: "notbase58!!!" })).status === 400, "junk is refused as a mint");

  // A mint that is valid base58 but is not a mint on chain is refused too, which needs the
  // chain. If the network is not reachable from here, that one check is skipped, not failed.
  const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC, a real mint
  const chk = await (await JPOST("/launch/check", { token: MINT })).json();
  if (chk.ok === false && /did not answer/.test(chk.reason || "")) console.log("SKIP chain checks: no network to Solana RPC");
  else {
    ok(chk.ok === true && chk.decimals === 6, "check reads a real mint from the chain", JSON.stringify(chk));
    const fake = await (await JPOST("/launch/check", { token: "11111111111111111111111111111112" })).json();
    ok(fake.ok === false, "an address that is not a mint is reported as such", JSON.stringify(fake));
    ok((await JPOST("/launch", { token: "11111111111111111111111111111112" })).status === 400, "a non-mint address is refused on save");
  }

  const saved = await (await JPOST("/launch", { token: MINT, force: true })).json();
  ok(saved.values.token === MINT, "the mint is stored with its base58 case intact", saved.values && saved.values.token);

  // The settings cache holds for 5 s; the panel user waits, the test does not.
  await new Promise(r => setTimeout(r, 5200));
  const after = (await A("/api/site-config")).data;
  ok(after.token === MINT, "site-config serves the saved mint");
  ok(after.buyUrl === "https://pump.fun/coin/" + MINT, "buy link is worked out from the mint", after.buyUrl);
  ok(after.explorerUrl === "https://solscan.io/token/" + MINT, "explorer link points at Solscan", after.explorerUrl);
  ok(/dexscreener\.com\/solana\//.test(after.chartUrl), "chart link points at the Solana pair", after.chartUrl);

  // A link typed by hand wins over the worked-out one, and http is refused.
  ok((await JPOST("/launch", { buyUrl: "http://pump.fun/x" })).status === 400, "a non-https link is refused");
  await JPOST("/launch", { buyUrl: "https://pump.fun/coin/custom" });
  await new Promise(r => setTimeout(r, 5200));
  ok((await A("/api/site-config")).data.buyUrl === "https://pump.fun/coin/custom", "a link set by hand wins");

  // Back to empty, so the rest of the run sees the pre-launch site.
  await JPOST("/launch", { token: "", buyUrl: "" });
  await new Promise(r => setTimeout(r, 5200));
  ok((await A("/api/site-config")).data.token === "", "clearing the mint puts the site back to pre-launch");
}
// A failing query must not take the server down (it did before handlers were wrapped).
ok((await ADM("/accounts/not-a-number/delete", { method: "POST" })).status === 500 && (await fetch(B + "/api/models")).status === 200, "server survives a failed query");

// Terminal client against the real /v1, through the built file
{
  // Async on purpose: the mocks and the proxy live in this process, a sync exec deadlocks them.
  const { execFile } = await import("node:child_process");
  const home = "/tmp/cli-home-" + Date.now(); (await import("node:fs")).mkdirSync(home);
  const out = await new Promise(res => execFile("node", [SITE_ROOT + "/cli/ascian.mjs", "hello there"], { env: { ...process.env, HOME: home, ASCIAN_KEY: k2, ASCIAN_ORIGIN: B }, encoding: "utf8", timeout: 30000 }, (e, so, se) => res(so + (se || "") + (e ? " ERR " + e.message : ""))));
  ok(/Hello from the mock model\./.test(out) && /credits/.test(out), "cli one-shot answers and shows the cost", out);
}

console.log(`${pass} passed, ${failN} failed`);
if (failN) console.log(log.split("\n").slice(-30).join("\n"));
srv.kill(); process.exit(failN ? 1 : 0);
