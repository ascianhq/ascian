import fs from "node:fs";
import path from "node:path";
import { cfg } from "./env.js";
import { q, one } from "./db.js";
import { rand } from "./util.js";
fs.mkdirSync(cfg.mediaDir, { recursive: true });
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
export async function store(accountId, kind, mime, buf, meta = {}) {
  const id = rand(12), file = path.join(cfg.mediaDir, `${id}.${EXT[mime] || "bin"}`);
  await fs.promises.writeFile(file, buf);
  await q("insert into media (id, account_id, kind, mime, path, prompt, model, credits) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, accountId, kind, mime, file, meta.prompt || null, meta.model || null, meta.credits ?? null]);
  return id;
}
export async function setCredits(id, credits) { await q("update media set credits=$2 where id=$1", [id, credits]); }
// Owner-only file with Range support (the <video> tag seeks) and ?download.
export async function serve(req, res, id, accountId, missing) {
  const m = await one("select * from media where id=$1 and account_id=$2", [id, accountId]);
  if (!m) return missing();
  let st; try { st = await fs.promises.stat(m.path); } catch { return missing(true); }
  const h = { "content-type": m.mime, "accept-ranges": "bytes", "cache-control": "private, max-age=86400" };
  if ("download" in req.query) h["content-disposition"] = `attachment; filename="${m.kind}-${id}.${EXT[m.mime] || "bin"}"`;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { ...h, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    return fs.createReadStream(m.path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...h, "content-length": st.size });
  fs.createReadStream(m.path).pipe(res);
}
