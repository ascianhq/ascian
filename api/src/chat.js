import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { fail, wmsg, wfail, limited, round4 } from "./util.js";
import { needAuth } from "./auth.js";
import { reserve, release, settle, balanceOf } from "./ledger.js";
import { catalog, DEAD, tokenRates, makesImages, seesImages } from "./catalog.js";
import * as gw from "./gateway.js";
import * as media from "./media.js";

// Measured credits per picture for image models whose token price says little.
const OBSERVED_IMAGE_CREDITS = { "google/gemini-3.1-flash-lite-image": 41, "google/gemini-2.5-flash-image": 47,
  "google/gemini-3.1-flash-image-preview": 82, "google/gemini-3.1-flash-image": 83, "google/gemini-3-pro-image-preview": 163 };
const MAX_OUT = 8192, DEADLINE = 4 * 60e3;

// Runs live in memory for fifteen minutes after they end, so a reloaded page can pick up
// the answer (GET /api/chat/run/:ref). One Railway instance, so memory is enough.
const runs = new Map();
const rkey = (a, ref) => a + ":" + ref;
setInterval(() => { const now = Date.now(); for (const [k, r] of runs) if (r.endedAt && now - r.endedAt > 15 * 60e3) runs.delete(k); }, 60e3).unref();
const validRef = r => typeof r === "string" && /^r[0-9a-f]{8,64}$/.test(r);

const cost = (usage, rates) => usage ? ((usage.prompt_tokens || 0) * rates.in + (usage.completion_tokens || 0) * rates.out) / 1e6 * 1000 : 0;
function reportedCredits(obj) {
  // PPQ reports USD per request; prefer it over our own token maths when present.
  const c = obj && (obj.cost ?? (obj.usage && obj.usage.cost));
  return typeof c === "number" && c >= 0 ? c * 1000 : null;
}

async function prepare(req, res) {
  if (!gw.gatewayOn(req.account)) return wfail(res, 503, "W103");
  const b = req.body || {}, cat = await catalog(), m = cat.byId.get(String(b.model || ""));
  if (!m) return wfail(res, 404, "W201");
  if (DEAD.has(m.id)) return wfail(res, 400, "W204");
  if (["video", "audio", "embedding", "image"].includes(m.type)) return wfail(res, 400, "W202");
  const rates = tokenRates(m); if (!rates) return wfail(res, 400, "W205");
  if (!Array.isArray(b.messages) || !b.messages.length) return wfail(res, 400, "W104");
  let msgs = [], images = 0;
  for (const x of b.messages) {
    if (!x || !["user", "assistant"].includes(x.role)) return wfail(res, 400, "W105");
    let content = x.content, len = 0;
    if (Array.isArray(content)) {
      const parts = [];
      for (const p of content) {
        if (p && p.type === "text") { parts.push({ type: "text", text: String(p.text || "") }); len += String(p.text || "").length; }
        else if (p && p.type === "image_url") {
          const u = p.image_url && p.image_url.url;
          if (!u) return wfail(res, 400, "W603");
          if (!/^data:/.test(u)) return wfail(res, 400, "W601");
          if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(u)) return wfail(res, 400, "W602");
          if (!seesImages(m)) return wfail(res, 400, "W203");
          images++; parts.push({ type: "image_url", image_url: { url: u } });
        }
      }
      content = parts;
    } else { content = String(content ?? ""); len = content.length; }
    if (len > 48000) return wfail(res, 400, "W106");
    msgs.push({ role: x.role, content, _len: len });
  }
  if (images > 8) return wfail(res, 400, "W108");
  const last = msgs[msgs.length - 1];
  if (last._len === 0 && !Array.isArray(last.content)) return wfail(res, 400, "W104");
  if (last._len > 120000) return wfail(res, 400, "W107");
  msgs = msgs.slice(-20);
  // Older turns fall off until the turn fits in 120,000 characters.
  while (msgs.length > 1 && msgs.reduce((s, x) => s + x._len, 0) > 120000) msgs.shift();
  const chars = msgs.reduce((s, x) => s + x._len, 0);
  msgs = msgs.map(({ role, content }) => ({ role, content }));
  if (limited("chat:" + req.account.id, 20, 60e3)) return fail(res, 429, "Twenty turns a minute is the limit. Wait a moment.");
  return { m, rates, msgs, inTokens: Math.ceil(chars / 3) + 1000 * images, ref: validRef(b.client_ref) ? b.client_ref : null };
}

async function imageTurn(req, res, p) {
  const a = req.account, floor = OBSERVED_IMAGE_CREDITS[p.m.id] || 200;
  const inCr = (p.inTokens * p.rates.in) / 1e6 * 1000;
  const h = await reserve(a.id, floor + inCr, 120);
  if (!h.ok) return res.status(402).json({ needed: h.needed, error: wmsg("W301") });
  const run = p.ref ? { status: "running", images: [], startedAt: Date.now() } : null;
  if (run) runs.set(rkey(a.id, p.ref), run);
  const end = (status, extra) => { if (run) { Object.assign(run, { status, endedAt: Date.now() }, extra); } };
  try {
    const r = await gw.chat({ model: p.m.id, messages: p.msgs, stream: false, modalities: ["image", "text"], max_tokens: 4096 }, AbortSignal.timeout(DEADLINE));
    let j; try { j = await r.json(); } catch { await settle(h.holdId, a.id, floor, { model: p.m.id, ref: p.ref }); end("failed", { error: wmsg("W512") }); return res.status(502).json({ error: wmsg("W512") }); }
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const urls = [];
    for (const im of msg.images || []) { const u = im.image_url ? im.image_url.url : im.url; if (u) urls.push(u); }
    if (Array.isArray(msg.content)) for (const c of msg.content) if (c.type === "image_url" && c.image_url) urls.push(c.image_url.url);
    const text = typeof msg.content === "string" ? msg.content : "";
    const prompt = (() => { const lu = [...p.msgs].reverse().find(x => x.role === "user"); return typeof lu.content === "string" ? lu.content : (lu.content.find(c => c.type === "text") || {}).text || ""; })();
    const ids = [];
    for (const u of urls) {
      try { const d = await gw.download(u); ids.push(await media.store(a.id, "image", d.mime.split(";")[0], d.buf, { prompt: prompt.slice(0, 2000), model: p.m.id })); }
      catch (e) { console.error("image download", e.message); }
    }
    if (!ids.length && !text.trim()) { await release(h.holdId); end("failed", { error: wmsg("W513") }); return res.status(502).json({ error: wmsg("W513") }); }
    const credits = round4(reportedCredits(j) ?? (cost(j.usage, p.rates) || floor));
    const charged = await settle(h.holdId, a.id, credits, { model: p.m.id, ref: p.ref });
    for (const id of ids) await media.setCredits(id, charged / ids.length);
    const images = ids.map(id => "/api/images/" + id);
    end("done", { images, credits: charged });
    res.json({ message: text, images, credits: charged, model: p.m.id });
  } catch (e) {
    await release(h.holdId);
    const code = e instanceof gw.GatewayError ? e.code : e.name === "TimeoutError" ? "W411" : "W411";
    console.error("image turn", e.message);
    end("failed", { error: wmsg(code) });
    res.status(502).json({ error: wmsg(code) });
  }
}

async function textTurn(req, res, p) {
  const a = req.account;
  const inCr = (p.inTokens * p.rates.in) / 1e6 * 1000;
  // Reply length shrinks to what the balance can cover, down to a floor of 256 tokens.
  const bal = await balanceOf(a.id);
  let maxOut = MAX_OUT;
  if (p.rates.out > 0) maxOut = Math.min(MAX_OUT, Math.floor(((bal.available - inCr) * 1e6) / 1000 / p.rates.out));
  if (maxOut < 256) return res.status(402).json({ needed: Math.ceil(inCr + (256 * p.rates.out) / 1e3), error: wmsg("W301") });
  const reserveCr = inCr + (maxOut * p.rates.out) / 1e3;
  const h = await reserve(a.id, reserveCr, 5 * 60);
  if (!h.ok) return res.status(402).json({ needed: h.needed, error: wmsg("W301") });

  const ac = new AbortController(), t0 = Date.now();
  const run = { status: "running", text: "", model: p.m.id, credits: 0, startedAt: t0, abort: () => ac.abort("stop"), stopped: false };
  if (p.ref) runs.set(rkey(a.id, p.ref), run);
  const deadline = setTimeout(() => ac.abort("deadline"), DEADLINE);

  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  let open = true; res.on("close", () => { open = false; });
  const send = o => { if (open) res.write("data: " + JSON.stringify(o) + "\n\n"); };
  const ka = setInterval(() => { if (open) res.write(": keepalive\n\n"); }, 15e3);

  let usage = null, reported = null, finish = null, thinkingSince = null, lastThink = 0, thought = 0, sawReasoning = false;
  const finishRun = (status, extra) => { Object.assign(run, { status, endedAt: Date.now() }, extra); clearTimeout(deadline); clearInterval(ka); };
  try {
    const up = await gw.chat({ model: p.m.id, messages: p.msgs, stream: true, max_tokens: maxOut, stream_options: { include_usage: true } }, ac.signal);
    for await (const ch of gw.sse(up)) {
      if (ch.usage) usage = ch.usage;
      const rc = reportedCredits(ch); if (rc != null) reported = rc;
      if (ch.error) throw new gw.GatewayError("W515", 200, JSON.stringify(ch.error).slice(0, 200));
      const c = ch.choices && ch.choices[0]; if (!c) continue;
      if (c.finish_reason) finish = c.finish_reason;
      const d = c.delta || {};
      const reasoning = d.reasoning || d.reasoning_content;
      if (reasoning && !run.text) {
        sawReasoning = true; thinkingSince = thinkingSince || Date.now();
        if (Date.now() - lastThink > 1000) { lastThink = Date.now(); send({ thinking: Math.max(1, Math.round((Date.now() - thinkingSince) / 1000)) }); }
      }
      if (d.content) {
        if (thinkingSince && !thought) thought = Math.max(1, Math.round((Date.now() - thinkingSince) / 1000));
        run.text += d.content; send({ delta: d.content });
      }
    }
  } catch (e) {
    const stopped = ac.signal.aborted && ac.signal.reason === "stop", timedOut = ac.signal.aborted && ac.signal.reason === "deadline";
    if (!stopped && !timedOut) {
      await release(h.holdId);
      const code = e instanceof gw.GatewayError ? e.code : run.text ? "W515" : "W511";
      console.error("chat stream", p.m.id, e.message);
      finishRun("failed", { error: wmsg(code) }); send({ error: wmsg(code) }); if (open) res.end(); return;
    }
    run.stopped = true;
  }
  // Nothing written: not charged, and the reason says whether thinking ate the budget.
  if (!run.text.trim() && !run.stopped) {
    await release(h.holdId);
    const code = sawReasoning && finish === "length" ? "W514" : "W513";
    finishRun("failed", { error: wmsg(code) }); send({ error: wmsg(code) }); if (open) res.end(); return;
  }
  const est = inCr + ((Math.ceil(run.text.length / 4) + (usage ? 0 : 0)) * p.rates.out) / 1e3;
  const credits = round4(reported ?? (usage ? cost(usage, p.rates) : est));
  const charged = round4(await settle(h.holdId, a.id, credits, { model: p.m.id, ref: p.ref }));
  const status = run.stopped ? "stopped" : "done";
  finishRun(status, { credits: charged });
  send({ done: true, credits: charged, model: p.m.id, stopped: run.stopped, truncated: finish === "length", thought });
  if (open) res.end();
}

export function mount(app) {
  const auth = needAuth(true);
  app.post("/api/chat", auth, async (req, res) => {
    const p = await prepare(req, res); if (!p || res.headersSent) return;
    return makesImages(p.m) ? imageTurn(req, res, p) : textTurn(req, res, p);
  });
  app.get("/api/chat/run/:ref", auth, (req, res) => {
    const r = runs.get(rkey(req.account.id, req.params.ref));
    res.set("cache-control", "no-store");
    if (!r) return res.status(404).json({ status: "unknown", error: wmsg("W102") });
    res.json({ status: r.status, text: r.text || "", credits: r.credits || 0, model: r.model, error: r.error || null });
  });
  app.post("/api/chat/run/:ref/stop", auth, (req, res) => {
    const r = runs.get(rkey(req.account.id, req.params.ref));
    if (r && r.status === "running" && r.abort) r.abort();
    res.json({ ok: true });
  });
  app.get("/api/images/run/:ref", auth, (req, res) => {
    const r = runs.get(rkey(req.account.id, req.params.ref));
    res.set("cache-control", "no-store");
    if (!r) return res.json({ status: "unknown" });
    res.json({ status: r.status, images: r.images || [], credits: r.credits || 0, error: r.error || null });
  });
  app.get("/api/images/:id", auth, (req, res) => media.serve(req, res, req.params.id, req.account.id, () => wfail(res, 404, "W701")));

  // Conversations: an opaque blob per chat, newest updatedAt wins on the client.
  app.get("/api/conversations", needAuth(), async (req, res) => {
    const rows = (await q("select id, title, door, messages, updated_at from conversations where account_id=$1 order by updated_at desc limit 200", [req.account.id])).rows;
    res.set("cache-control", "no-store").json({ conversations: rows.map(r => ({ id: r.id, title: r.title, door: r.door, updatedAt: +r.updated_at, messages: r.messages })) });
  });
  app.put("/api/conversations/:id", needAuth(), async (req, res) => {
    const id = String(req.params.id).slice(0, 80), b = req.body || {};
    if (!Array.isArray(b.messages)) return fail(res, 400, "messages must be an array.");
    const n = await one("select count(*)::int n from conversations where account_id=$1", [req.account.id]);
    if (n.n >= 500) await q("delete from conversations where account_id=$1 and id in (select id from conversations where account_id=$1 order by updated_at asc limit 1)", [req.account.id]);
    await q(`insert into conversations (account_id, id, title, door, messages, updated_at) values ($1,$2,$3,$4,$5,$6)
             on conflict (account_id, id) do update set title=$3, door=$4, messages=$5, updated_at=$6 where conversations.updated_at <= $6`,
      [req.account.id, id, String(b.title || "").slice(0, 200), String(b.door || "ask").slice(0, 10), JSON.stringify(b.messages), Math.floor(+b.updatedAt || Date.now())]);
    res.json({ ok: true });
  });
  app.delete("/api/conversations/:id", needAuth(), async (req, res) => { await q("delete from conversations where account_id=$1 and id=$2", [req.account.id, req.params.id]); res.json({ ok: true }); });
  app.delete("/api/conversations", needAuth(), async (req, res) => {
    const r = await q("delete from conversations where account_id=$1", [req.account.id]); res.json({ deleted: r.rowCount });
  });
  app.get("/api/conversations/export", needAuth(), async (req, res) => {
    const rows = (await q("select id, title, door, messages, updated_at from conversations where account_id=$1 order by updated_at desc", [req.account.id])).rows;
    res.set({ "content-type": "application/json", "content-disposition": `attachment; filename="${cfg.brand}-chats.json"` })
      .send(JSON.stringify({ exportedAt: new Date().toISOString(), conversations: rows.map(r => ({ ...r, updated_at: +r.updated_at })) }, null, 2));
  });

  app.get("/api/library", needAuth(), async (req, res) => {
    const img = (await q("select id, prompt, model, credits, created_at from media where account_id=$1 and kind='image' order by created_at desc limit 100", [req.account.id])).rows;
    const vid = (await q("select v.id, v.prompt, v.model, v.credits, v.created_at from video_jobs v where v.account_id=$1 and v.status='completed' order by created_at desc limit 60", [req.account.id])).rows;
    res.set("cache-control", "no-store").json({
      images: img.map(r => ({ id: r.id, url: "/api/images/" + r.id, prompt: r.prompt, model: r.model || "", credits: r.credits, createdAt: r.created_at })),
      videos: vid.map(r => ({ id: r.id, url: "/api/video/" + r.id + "/file", prompt: r.prompt, model: r.model || "", credits: r.credits, createdAt: r.created_at }))
    });
  });
}
export { runs };
