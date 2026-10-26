// The whole stand: Postgres, this API, the static site, and the proxy Vercel does in front of them.
//
//   SITE_ROOT=../site node stack.mjs
//
// Paths resolve from this file, so a clone anywhere works. SITE_ROOT points at the
// deployed site (../site in this repository); DATABASE_URL at a scratch
// database, because the stand drops and recreates the schema on every run.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, process.env.SITE_ROOT || "../site");
const front = await import(path.join(HERE, "test/front.mjs"));

const API = Number(process.env.STAND_API_PORT || 18090);
const WEB = Number(process.env.STAND_WEB_PORT || 18093);
const env = { ...process.env, PORT: String(API),
  DATABASE_URL: process.env.DATABASE_URL || "postgres://app:app@localhost/ascian_stack",
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "stand-token", SITE_URL: `http://localhost:${WEB}`,
  MEDIA_DIR: process.env.MEDIA_DIR || "/tmp/ascian-media-stack", SECURE_COOKIES: "0" };

{ const pg = (await import("pg")).default; const c = new pg.Client(env.DATABASE_URL); await c.connect();
  await c.query("drop schema public cascade; create schema public"); await c.end(); }

const srv = spawn("node", ["src/server.js"], { env, cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; srv.stdout.on("data", d => log += d); srv.stderr.on("data", d => log += d);
front.start(WEB, SITE, API);
await new Promise(r => { const t = setInterval(() => { if (/api on/.test(log)) { clearInterval(t); r(); } }, 100); setTimeout(r, 15000); });
console.log(`stand up: site http://127.0.0.1:${WEB}, api :${API}, admin token ${env.ADMIN_TOKEN}`);
console.log(`site served from ${SITE}`);
process.stdin.resume();
