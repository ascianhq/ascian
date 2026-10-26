import crypto from "node:crypto";
import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { fail, wmsg, wfail, rand, limited, round4 } from "./util.js";
import { needAuth } from "./auth.js";
import { reserve, release, settle } from "./ledger.js";
import { videoModels } from "./catalog.js";
import * as gw from "./gateway.js";
import * as media from "./media.js";

const SECRET = process.env.MEDIA_SECRET || crypto.createHash("sha256").update(cfg.databaseUrl + "frames").digest("hex");
const sig = id => crypto.createHmac("sha256", SECRET).update(id).digest("hex").slice(0, 32);

async function poll(job) {
  try {
    const s = await gw.videoStatus(job.upstream_id);
    if (s.status === "completed" && s.data && s.data.url) {
      const d = await gw.download(s.data.url);
      const credits = round4(typeof s.cost === "number" ? s.cost * 1000 : job.reserved);
      const mid = await media.store(job.account_id, "video", d.mime.split(";")[0] || "video/mp4", d.buf, { prompt: job.prompt, model: job.model });
      const charged = await settle(job.hold_id, job.account_id, credits, { model: job.model, ref: "video:" + job.id });
      await media.setCredits(mid, charged);
      await q("update video_jobs set status='completed', credits=$2, media_id=$3, updated_at=now() where id=$1", [job.id, charged, mid]);
    } else if (s.status === "failed") {
      await release(job.hold_id);
      await q("update video_jobs set status='failed', error=$2, updated_at=now() where id=$1", [job.id, wmsg("W801", "Nothing was charged.")]);
    } else if (Date.now() - new Date(job.created_at) > 20 * 60e3) {
      await release(job.hold_id);
      await q("update video_jobs set status='failed', error=$2, updated_at=now() where id=$1", [job.id, wmsg("W801", "It took too long. Nothing was charged.")]);
    } else if (job.status === "queued") await q("update video_jobs set status='processing', updated_at=now() where id=$1", [job.id]);
  } catch (e) { console.error("video poll", job.id, e.message); }
}
let busy = false;
setInterval(async () => {
  if (busy || !gw.gatewayOn()) return; busy = true;
  try { for (const j of (await q("select * from video_jobs where status in ('queued','processing') order by created_at limit 20")).rows) await poll(j); }
  finally { busy = false; }
}, 5e3).unref();

export function mount(app) {
  const auth = needAuth(true);
  app.get("/api/video/models", async (req, res) => {
    res.json({ data: (await videoModels()).map(({ _grid, ...v }) => v) });
  });
  app.post("/api/video", auth, async (req, res) => {
    if (!gw.gatewayOn()) return wfail(res, 503, "W103");
    const b = req.body || {}, a = req.account;
    const spec = (await videoModels()).find(v => v.id === b.model);
    if (!spec) return wfail(res, 400, "W806");
    const prompt = String(b.prompt || "").trim();
    if (!prompt) return wfail(res, 400, "W804");
    if (prompt.length > 2000) return wfail(res, 400, "W805");
    if (b.imageUrl && !spec.acceptsImage) return wfail(res, 400, "W807");
    if (!b.imageUrl && spec.requiresImage) return wfail(res, 400, "W808");
    const cell = spec._grid.get(`${b.aspectRatio || "16:9"}|${b.duration || "5"}`) || (!spec.aspectRatios.length && spec._grid.get(`16:9|${b.duration || "5"}`));
    if (!cell) return wfail(res, 400, "W809");
    if (limited("video:" + a.id, 10, 60e3)) return fail(res, 429, "Ten renders a minute is the limit.");
    const dup = await one("select 1 from video_jobs where account_id=$1 and model=$2 and prompt=$3 and status in ('queued','processing') and created_at > now() - interval '20 seconds'", [a.id, spec.id, prompt]);
    if (dup) return wfail(res, 409, "W812");
    const h = await reserve(a.id, cell.credits, 20 * 60);
    if (!h.ok) return wfail(res, 402, "W810", `This one needs ${Math.ceil(cell.credits)} credits.`);
    const body = { model: spec.id, prompt, duration: cell.up.duration };
    if (cell.up.aspect_ratio) body.aspect_ratio = cell.up.aspect_ratio;
    if (cell.up.resolution) body.quality = cell.up.resolution;
    else if (cell.up.quality && cell.up.quality !== "standard") body.quality = cell.up.quality;
    if (b.imageUrl) {
      // The gateway fetches the start frame by URL, so it is hosted here behind a signature.
      const m = String(b.imageUrl).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
      if (!m) { await release(h.holdId); return wfail(res, 400, "W602"); }
      const fid = await media.store(a.id, "frame", m[1], Buffer.from(m[2], "base64"));
      body.image_url = `${cfg.siteUrl}/api/frames/${fid}?s=${sig(fid)}`;
    }
    const id = "v" + rand(10);
    try {
      const j = await gw.videoSubmit(body);
      await q("insert into video_jobs (id, account_id, upstream_id, model, prompt, status, hold_id, reserved) values ($1,$2,$3,$4,$5,'queued',$6,$7)",
        [id, a.id, j.id, spec.id, prompt, h.holdId, cell.credits]);
      res.json({ id });
    } catch (e) {
      await release(h.holdId); console.error("video submit", e.message);
      return wfail(res, 502, e.code === "W414" ? "W414" : "W811");
    }
  });
  app.get("/api/video/:id", auth, async (req, res) => {
    const j = await one("select * from video_jobs where id=$1 and account_id=$2", [req.params.id, req.account.id]);
    res.set("cache-control", "no-store");
    if (!j) return wfail(res, 404, "W813");
    res.json({ status: j.status, url: j.status === "completed" ? `/api/video/${j.id}/file` : null, credits: j.credits ?? j.reserved, error: j.error });
  });
  app.get("/api/video/:id/file", auth, async (req, res) => {
    const j = await one("select media_id from video_jobs where id=$1 and account_id=$2", [req.params.id, req.account.id]);
    if (!j || !j.media_id) return wfail(res, 404, "W802");
    media.serve(req, res, j.media_id, req.account.id, gone => wfail(res, gone ? 410 : 404, gone ? "W803" : "W802"));
  });
  app.get("/api/frames/:id", async (req, res) => {
    if (req.query.s !== sig(req.params.id)) return res.status(403).end();
    const m = await one("select account_id from media where id=$1 and kind='frame'", [req.params.id]);
    if (!m) return res.status(404).end();
    media.serve(req, res, req.params.id, m.account_id, () => res.status(404).end());
  });
}
