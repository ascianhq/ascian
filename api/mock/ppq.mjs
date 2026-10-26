// Stand-in for api.ppq.ai: same routes and shapes, fake content. For tests only.
import http from "node:http";
import fs from "node:fs";
const models = JSON.parse(fs.readFileSync(new URL("../data/models.json", import.meta.url)));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const jobs = new Map(); let n = 0;
export const seen = [];
export function start(port) {
  return http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, body: j, auth: req.headers.authorization });
    const out = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/v1/models") return out(200, { object: "list", data: models.data.filter(m => m.status !== "planned") });
    if (req.headers.authorization !== "Bearer sk-test") return out(401, { error: { message: "no key" } });
    if (u.pathname === "/chat/completions") {
      if (j.messages.at(-1).content === "fail please") return out(500, { error: "boom" });
      if (j.modalities && j.modalities.includes("image"))
        return out(200, { id: "c1", choices: [{ message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1290 }, cost: 0.039 });
      const words = ["Hello", " from", " the", " mock", " model."];
      if (!j.stream) return out(200, { id: "c2", object: "chat.completion", model: j.model, choices: [{ index: 0, message: { role: "assistant", content: words.join("") }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = o => res.write("data: " + JSON.stringify(o) + "\n\n");
      if (j.messages.at(-1).content === "empty please") { send({ choices: [{ delta: {}, finish_reason: "stop" }] }); res.end("data: [DONE]\n\n"); return; }
      send({ id: "s", choices: [{ delta: { reasoning: "hmm" } }] });
      await new Promise(r => setTimeout(r, 1100));
      send({ id: "s", choices: [{ delta: { reasoning: "ok" } }] });
      const slow = j.messages.at(-1).content === "slow please";
      for (const w of words) { send({ id: "s", choices: [{ delta: { content: w } }] }); await new Promise(r => setTimeout(r, slow ? 800 : 30)); if (res.destroyed) return; }
      send({ id: "s", choices: [{ delta: {}, finish_reason: "stop" }] });
      send({ id: "s", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 2000 } });
      return res.end("data: [DONE]\n\n");
    }
    if (u.pathname === "/v1/videos" && req.method === "POST") { const id = "gen_" + (++n); jobs.set(id, { polls: 0, body: j }); return out(202, { id, model: j.model, status: "pending", estimated_cost: 0.4 }); }
    const vm = u.pathname.match(/^\/v1\/videos\/(.+)$/);
    if (vm) {
      const jb = jobs.get(vm[1]); if (!jb) return out(404, { error: "no" });
      if (++jb.polls < 2) return out(202, { id: vm[1], status: "pending" });
      return out(200, { id: vm[1], status: "completed", data: { url: `http://localhost:${port}/media/${vm[1]}.mp4`, content_type: "video/mp4" }, cost: 0.4025 });
    }
    if (u.pathname.startsWith("/media/")) { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(2048, 7)); }
    out(404, { error: "mock: " + u.pathname });
  }).listen(port);
}
