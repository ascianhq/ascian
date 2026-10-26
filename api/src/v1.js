// Public OpenAI-compatible API. Same balance as the workspace, keyed by ascian_live_ keys.
import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { sha256, limited, ipKey, round4 } from "./util.js";
import { reserve, release, settle, balanceOf } from "./ledger.js";
import { catalog, DEAD, tokenRates, makesImages } from "./catalog.js";
import * as gw from "./gateway.js";

const oerr = (res, status, type, message) => res.status(status).json({ error: { message, type, param: null, code: null } });
async function keyAccount(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  return one(`select k.id as key_id, k.name as key_name, k.prefix, k.daily_cap, a.* from api_keys k join accounts a on a.id=k.account_id
              where k.key_hash=$1 and k.revoked_at is null`, [sha256(m[1])]);
}
function usable(m) { return m && m.type === "chat" && !DEAD.has(m.id) && tokenRates(m); }

export function mount(app) {
  app.use("/v1", (req, res, next) => {
    if (limited("v1:" + ipKey(req), 120, 60e3)) return res.status(429).json({ statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded, retry in 1 minute" });
    next();
  });
  app.get("/v1", async (req, res) => {
    const a = await keyAccount(req), cat = await catalog();
    const n = cat.data.filter(usable).length, b = a ? await balanceOf(a.id) : null;
    if (/^(curl|wget|httpie|powershell|node-fetch|undici)/i.test(req.headers["user-agent"] || ""))
      return res.type("text/plain").send(`${cfg.brand} api  ${cfg.siteUrl}/v1\nmodels ${n}\n` + (a ? `key    ${a.key_name} (${a.prefix}...)\nbalance ${b.credits.toFixed(2)} credits\n` : "no key: send Authorization: Bearer <key>\n"));
    res.json({ object: `${cfg.brand}.api`, base_url: cfg.siteUrl + "/v1", models: n, streaming: true, authenticated: !!a,
      account: a ? { email: a.email, credits: b.credits } : null, endpoints: ["/v1/models", "/v1/chat/completions"], docs: cfg.siteUrl + "/docs/api" });
  });
  app.get("/v1/models", async (req, res) => {
    if (!(await keyAccount(req))) return oerr(res, 401, "authentication_error", "Missing or invalid API key.");
    const cat = await catalog();
    res.json({ object: "list", data: cat.data.filter(usable).map(m => ({ id: m.id, object: "model", created: 0, owned_by: m.owned_by })) });
  });
  app.post("/v1/chat/completions", async (req, res) => {
    const a = await keyAccount(req);
    if (!a) return oerr(res, 401, "authentication_error", "Missing or invalid API key.");
    if (!gw.gatewayOn(a)) return oerr(res, 503, "api_error", "Model access is temporarily unavailable. Nothing was charged.");
    const b = req.body || {}, cat = await catalog(), m = cat.byId.get(String(b.model || ""));
    if (!usable(m)) return oerr(res, 404, "invalid_request_error", `The model '${b.model}' does not exist.`);
    if (!Array.isArray(b.messages) || !b.messages.length) return oerr(res, 400, "invalid_request_error", "messages is required and must be a non-empty array.");
    let msgs = [];
    for (const x of b.messages) {
      if (!x || !["system", "user", "assistant"].includes(x.role)) return oerr(res, 400, "invalid_request_error", `Unsupported message role: ${x && x.role}`);
      if (typeof x.content === "string") msgs.push({ role: x.role, content: x.content });
    }
    if (!msgs.length) return oerr(res, 400, "invalid_request_error", "No usable messages were provided.");
    msgs = msgs.slice(-40);
    const chars = msgs.reduce((s, x) => s + x.content.length, 0);
    if (chars > 120000) return oerr(res, 400, "invalid_request_error", "The conversation is too long.");
    const rates = tokenRates(m), maxTokens = Math.min(8192, Math.max(1, +b.max_tokens || 4096));
    const reserveCr = ((Math.ceil(chars / 3) * rates.in) + maxTokens * rates.out) / 1e3 + (makesImages(m) ? 200 : 0);
    if (a.daily_cap) {
      const spent = await one("select coalesce(-sum(credits),0) s from ledger where key_id=$1 and created_at > now() - interval '24 hours'", [a.key_id]);
      if (spent.s + reserveCr > a.daily_cap) return oerr(res, 429, "rate_limit_error", `This key's daily cap of ${a.daily_cap} credits would be exceeded. It has spent ${round4(spent.s)} in the last 24 hours.`);
    }
    const h = await reserve(a.id, reserveCr, 5 * 60);
    if (!h.ok) return oerr(res, 402, "insufficient_quota", `Not enough credits. This request needs about ${h.needed}. Add credits at ${cfg.siteUrl}/account#topup`);
    await q("update api_keys set last_used_at=now() where id=$1", [a.key_id]);
    const ac = new AbortController(), meta = { model: m.id, source: "api", keyId: a.key_id };
    const priced = u => (u ? ((u.prompt_tokens || 0) * rates.in + (u.completion_tokens || 0) * rates.out) / 1e3 : 0);
    let up;
    try { up = await gw.chat({ model: m.id, messages: msgs, max_tokens: maxTokens, stream: !!b.stream, ...(b.stream ? { stream_options: { include_usage: true } } : {}) }, ac.signal); }
    catch (e) { await release(h.holdId); return oerr(res, 502, "api_error", e.code === "W413" ? "The upstream gateway is busy. Retry shortly." : "The model gateway is unavailable."); }
    if (!b.stream) {
      let j; try { j = await up.json(); } catch { await settle(h.holdId, a.id, reserveCr, meta); return oerr(res, 502, "api_error", "The gateway sent an unreadable response. It was billed upstream, so the reserved credits were charged."); }
      const text = j.choices?.[0]?.message?.content;
      if (!text && !j.choices?.[0]?.message?.images) { await release(h.holdId); return oerr(res, 502, "api_error", "The model returned no content. Nothing was charged."); }
      const charged = round4(await settle(h.holdId, a.id, typeof j.cost === "number" ? j.cost * 1000 : priced(j.usage), meta));
      delete j.cost;
      return res.json({ ...j, [cfg.brand]: { credits_charged: charged } });
    }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let closed = false, text = "", usage = null, cost = null, id = null;
    // Closing the connection cancels upstream; what was generated is charged.
    res.on("close", () => { closed = true; ac.abort(); });
    const ka = setInterval(() => res.write(`: ${cfg.brand}\n\n`), 15e3);
    try {
      for await (const ch of gw.sse(up)) {
        id = id || ch.id;
        if (ch.usage) usage = ch.usage;
        if (typeof ch.cost === "number") cost = ch.cost;
        const d = ch.choices?.[0]?.delta; if (d && d.content) text += d.content;
        if (ch.choices && ch.choices.length) { const { cost: _c, usage: _u, ...rest } = ch; res.write("data: " + JSON.stringify(rest) + "\n\n"); }
      }
    } catch {}
    clearInterval(ka);
    const charged = round4(await settle(h.holdId, a.id, cost != null ? cost * 1000 : usage ? priced(usage) : (Math.ceil(chars / 3) * rates.in + Math.ceil(text.length / 4) * rates.out) / 1e3, meta));
    if (!closed) {
      res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", model: m.id, choices: [], usage, [cfg.brand]: { credits_charged: charged } }) + "\n\n");
      res.write("data: [DONE]\n\n"); res.end();
    }
  });
}
