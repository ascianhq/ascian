// Local stand-in for Vercel: static site with clean URLs, /api, /v1 and /r proxied to the API.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
export function start(port, root, apiPort) {
  const T = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".mp4": "video/mp4", ".webm": "video/webm", ".webp": "image/webp" };
  return http.createServer((q, r) => {
    const u = new URL(q.url, "http://x"); let p = decodeURIComponent(u.pathname);
    if (/^\/(api|v1|r)(\/|$)/.test(p)) {
      const up = http.request({ host: "127.0.0.1", port: apiPort, path: q.url, method: q.method, headers: q.headers }, ur => { r.writeHead(ur.statusCode, ur.headers); ur.pipe(r); });
      up.on("error", e => { r.writeHead(502); r.end(String(e)); });
      q.pipe(up); r.on("close", () => up.destroy()); return;
    }
    if (p === "/_next/image") p = u.searchParams.get("url") || p;
    if (p.endsWith("/")) p += "index";
    const qs = [...u.searchParams].filter(([k]) => k !== "_rsc");
    const c = []; if (qs.length) c.push(p + "@" + qs.map(([k, v]) => k + "=" + v).join("&") + ".html");
    c.push(p, p + ".html");
    const f = c.map(x => path.join(root, x)).find(x => fs.existsSync(x) && fs.statSync(x).isFile());
    if (!f) { r.writeHead(404); return r.end("404"); }
    r.writeHead(200, { "content-type": T[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(r);
  }).listen(port);
}
