// PPQ client. OpenAI-shaped chat, async video jobs, signed media URLs.
import { cfg } from "./env.js";
// PPQ is the real gateway. Without its key, the Anthropic stand-in answers chat for listed accounts only.
export const standin = () => !cfg.ppqKey && !!cfg.anthropicKey;
// "*" in STANDIN_ACCOUNTS opens the stand-in to every signed-in account (for a closed test only).
export const standinFor = (a) => standin() && !!a && cfg.standinAccounts.some(x => x === "*" || [a.wallet, a.username, a.email].includes(x));
export const gatewayOn = (a) => !!cfg.ppqKey || standinFor(a);
const H = () => ({ authorization: "Bearer " + cfg.ppqKey, "content-type": "application/json", "user-agent": "ascian-api" });

export class GatewayError extends Error { constructor(code, status, detail) { super(detail || code); this.code = code; this.status = status; } }
function mapStatus(s) {
  if (s === 402) return "W414";            // our gateway account is empty
  if (s === 429) return "W413";
  if (s >= 500) return "W412";
  return "W412";
}
export async function chat(body, signal) {
  if (standin()) return (body.modalities || []).includes("image") ? anthropicImage(body, signal) : anthropicChat(body, signal);
  let r;
  try { r = await fetch(cfg.ppqBase + "/chat/completions", { method: "POST", headers: H(), body: JSON.stringify(body), signal }); }
  catch (e) { if (signal && signal.aborted) throw e; throw new GatewayError("W411", 0, e.message); }
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new GatewayError(mapStatus(r.status), r.status, t.slice(0, 300)); }
  return r;
}
// Parse an OpenAI SSE stream into chunk objects.
export async function* sse(resp) {
  const dec = new TextDecoder(); let buf = "";
  for await (const part of resp.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try { yield JSON.parse(d); } catch {}
    }
  }
}
export async function videoSubmit(body) {
  let r;
  try { r = await fetch(cfg.ppqBase + "/v1/videos", { method: "POST", headers: H(), body: JSON.stringify(body) }); }
  catch (e) { throw new GatewayError("W811", 0, e.message); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GatewayError(r.status === 402 ? "W414" : "W811", r.status, JSON.stringify(j).slice(0, 300));
  return j;
}
export async function videoStatus(id) {
  const r = await fetch(cfg.ppqBase + "/v1/videos/" + encodeURIComponent(id), { headers: H() });
  const j = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new GatewayError("W801", r.status, JSON.stringify(j).slice(0, 300));
  return j;
}
export async function download(url) {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    return { mime: m[1] || "application/octet-stream", buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3])) };
  }
  const r = await fetch(url, { headers: url.startsWith(cfg.ppqBase) ? H() : {} });
  if (!r.ok) throw new Error("download " + r.status);
  return { mime: r.headers.get("content-type") || "application/octet-stream", buf: Buffer.from(await r.arrayBuffer()) };
}

// ---- Anthropic stand-in: OpenAI-shaped in, OpenAI-shaped out, so chat.js and v1.js need no changes ----
function toAnthropic(body) {
  const system = [], msgs = [];
  const part = (p) => {
    if (typeof p === "string") return { type: "text", text: p };
    if (p.type === "text") return { type: "text", text: p.text || "" };
    if (p.type === "image_url") {
      const u = p.image_url && p.image_url.url || "";
      const m = u.match(/^data:([^;,]+);base64,(.*)$/s);
      return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url: u } };
    }
    return { type: "text", text: "" };
  };
  for (const m of body.messages || []) {
    if (m.role === "system") { system.push(typeof m.content === "string" ? m.content : (m.content || []).map(x => x.text || "").join("\n")); continue; }
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = (typeof m.content === "string" ? [part(m.content)] : (m.content || []).map(part)).filter(c => c.type !== "text" || c.text);
    if (!content.length) continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === role) prev.content.push(...content); else msgs.push({ role, content });
  }
  if (msgs.length && msgs[0].role !== "user") msgs.unshift({ role: "user", content: [{ type: "text", text: "(conversation continues)" }] });
  return { model: cfg.standinModel, max_tokens: Math.min(body.max_tokens || 4096, 8192), messages: msgs, ...(system.length ? { system: system.join("\n\n") } : {}), ...(body.stream ? { stream: true } : {}) };
}
function anthropicStatus(s, text) {
  if (s === 429 || s === 529) return "W413";
  if (/credit balance/i.test(text)) return "W414";
  return "W412";
}
const finishOf = (r) => r === "max_tokens" ? "length" : "stop";
async function anthropicChat(body, signal) {
  let r;
  try {
    r = await fetch(cfg.anthropicBase + "/v1/messages", { method: "POST", signal, body: JSON.stringify(toAnthropic(body)),
      headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } });
  } catch (e) { if (signal && signal.aborted) throw e; throw new GatewayError("W411", 0, e.message); }
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new GatewayError(anthropicStatus(r.status, t), r.status, t.slice(0, 300)); }
  const id = "chatcmpl-" + Date.now().toString(36), model = body.model;
  if (!body.stream) {
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const u = j.usage || {};
    return new Response(JSON.stringify({ id, object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishOf(j.stop_reason) }],
      usage: { prompt_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), completion_tokens: u.output_tokens || 0 } }), { headers: { "content-type": "application/json" } });
  }
  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(ctl) {
      const send = (o) => ctl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n"));
      const chunk = (delta, finish) => send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: finish || null }] });
      let inTok = 0, outTok = 0, stop = null;
      try {
        for await (const ev of sse(r)) {
          if (ev.type === "message_start") { const u = ev.message && ev.message.usage || {}; inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); outTok = u.output_tokens || 0; }
          else if (ev.type === "content_block_delta" && ev.delta) {
            if (ev.delta.type === "text_delta") chunk({ content: ev.delta.text });
            else if (ev.delta.type === "thinking_delta") chunk({ reasoning: ev.delta.thinking });
          }
          else if (ev.type === "message_delta") { if (ev.usage && ev.usage.output_tokens != null) outTok = ev.usage.output_tokens; if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
          else if (ev.type === "error") throw new Error((ev.error && ev.error.message) || "stream error");
        }
        chunk({}, finishOf(stop));
        send({ id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: inTok, completion_tokens: outTok } });
        ctl.enqueue(enc.encode("data: [DONE]\n\n")); ctl.close();
      } catch (e) { ctl.error(e); }
    }
  });
  return new Response(out, { headers: { "content-type": "text/event-stream" } });
}

// Claude cannot output pictures, so in stand-in mode an image request asks it for one SVG
// illustration and rasterises that to a PNG. Good enough to see the image flow end to end.
const SVG_SYSTEM = "You are an illustrator. Answer with one complete SVG document and nothing else: no prose, no code fences. " +
  "Use viewBox=\"0 0 1024 1024\", width=\"1024\" height=\"1024\", a full-bleed background, flat shapes and gradients, no text, no external references, no scripts.";
async function anthropicImage(body, signal) {
  const prompt = { ...body, stream: false, max_tokens: 8000, messages: [{ role: "system", content: SVG_SYSTEM }, ...(body.messages || []).filter(m => m.role !== "system")] };
  const r = await anthropicChat(prompt, signal);
  const j = await r.json();
  const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  const m = raw.match(/<svg[\s\S]*<\/svg>/i);
  let images = [];
  if (m) {
    try {
      const { Resvg } = await import("@resvg/resvg-js");
      const svg = m[0].replace(/<script[\s\S]*?<\/script>/gi, "");
      const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 }, background: "#000000" }).render().asPng();
      images = [{ type: "image_url", image_url: { url: "data:image/png;base64," + Buffer.from(png).toString("base64") } }];
    } catch (e) { console.error("standin svg", e.message); }
  }
  // No usage on purpose: the image is then charged at the model's per-picture price, like a real one.
  return new Response(JSON.stringify({ id: j.id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "", images }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
}
