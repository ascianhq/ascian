// Whole stack on localhost with mocks: node test/dev.mjs  -> http://localhost:18083
import { spawn } from "node:child_process";
import * as ppq from "../mock/ppq.mjs"; import * as np from "../mock/nowpayments.mjs"; import * as front from "./front.mjs";
import crypto from "node:crypto"; import http from "node:http";
const API = 18080, PPQ = 18081, NP = 18082, WEB = 18083, B = `http://localhost:${WEB}`;
ppq.start(PPQ); np.start(NP);
const env = { ...process.env, PORT: String(API), DATABASE_URL: "postgres://app:app@localhost/ascian_test", PPQ_BASE: `http://localhost:${PPQ}`, PPQ_API_KEY: "sk-test",
  NOWPAYMENTS_BASE: `http://localhost:${NP}`, NOWPAYMENTS_API_KEY: "np-test", NOWPAYMENTS_IPN_SECRET: "ipn-secret", SITE_URL: B, MEDIA_DIR: "/tmp/ascian-media-test", SECURE_COOKIES: "0", DEV_RETURN_CODES: "1" };
const srv = spawn("node", ["src/server.js"], { env, cwd: new URL("..", import.meta.url).pathname, stdio: "inherit" });
front.start(WEB, process.env.SITE_ROOT || "../site", API);
// Test helper: pay every waiting mock payment in full and send the signed IPN.
http.createServer(async (req, res) => {
  for (const p of np.all.values()) if (p.payment_status === "waiting") {
    const b = { ...np.setStatus(p.payment_id, "finished", p.pay_amount) };
    const s = o => Array.isArray(o) ? o.map(s) : o && typeof o === "object" ? Object.keys(o).sort().reduce((a, k) => ((a[k] = s(o[k])), a), {}) : o;
    await fetch(B + "/api/deposits/ipn", { method: "POST", headers: { "content-type": "application/json", "x-nowpayments-sig": crypto.createHmac("sha512", "ipn-secret").update(JSON.stringify(s(b))).digest("hex") }, body: JSON.stringify(b) });
  }
  res.end("paid");
}).listen(18084);
process.on("SIGTERM", () => { srv.kill(); process.exit(0); });
