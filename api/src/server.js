import "./env.js";
import express from "express";
import { cfg } from "./env.js";
import { migrate } from "./db.js";
import * as auth from "./auth.js";
import * as account from "./account.js";
import * as chat from "./chat.js";
import * as video from "./video.js";
import * as deposits from "./deposits.js";
import * as v1 from "./v1.js";
import * as misc from "./misc.js";
import * as admin from "./admin.js";

const app = express();
// Express 4 does not catch a rejected promise from an async handler: one failed query took
// the whole server down (found 22.09). Every handler is wrapped so errors reach the error
// middleware and the process keeps serving everyone else.
for (const m of ["get", "post", "put", "delete", "patch", "all", "use"]) {
  const orig = app[m].bind(app);
  app[m] = (...args) => orig(...args.map(f => typeof f === "function" && f.length < 4
    ? (req, res, next) => { try { const r = f(req, res, next); if (r && typeof r.catch === "function") r.catch(next); } catch (e) { next(e); } }
    : f));
}
process.on("unhandledRejection", e => console.error("unhandled", e));
app.set("trust proxy", true);
app.disable("x-powered-by");
// Chat bodies carry full-size images as data URLs, so 8 MB there; /v1 keeps 256 KB.
app.use("/api/chat", express.json({ limit: "8mb" }));
app.use("/api/video", express.json({ limit: "8mb" }));
app.use("/api/conversations", express.json({ limit: "8mb" }));
app.use("/v1", express.json({ limit: "256kb" }));
app.use(express.json({ limit: "1mb" }));
for (const m of [misc, admin, auth, account, chat, video, deposits, v1]) m.mount(app);
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That request is too large." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "That request is not valid JSON." });
  console.error(err); if (!res.headersSent) res.status(500).json({ error: "Something broke on our side. Nothing was charged." });
});
await migrate();
app.listen(cfg.port, () => console.log(`api on :${cfg.port}, gateway ${cfg.ppqKey ? "on" : "off"}, payments ${cfg.npKey ? "on" : "off"}`));
