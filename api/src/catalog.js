// Model catalogue straight from the gateway (public, no key), cached for five minutes.
// If the gateway is down the last good copy is served with live:false, never an empty list.
import { cfg } from "./env.js";
import fs from "node:fs";
let cache = null, at = 0, inflight = null;
const TTL = 5 * 60e3;
// Ids the gateway lists but whose providers refuse every request. Extend from logs.
export const DEAD = new Set((process.env.DEAD_MODELS || "").split(",").map(s => s.trim()).filter(Boolean));

async function load() {
  const r = await fetch(cfg.ppqBase + "/v1/models?type=all", { headers: { "user-agent": "ascian-api" } });
  if (!r.ok) throw new Error("catalog " + r.status);
  const j = await r.json();
  const data = (j.data || []).map(m => {
    const o = { id: m.id, name: m.name || m.id, type: m.type, owned_by: m.owned_by, popular: !!m.popular, status: "live" };
    if (m.context_length) o.context_length = m.context_length;
    if (m.architecture) o.architecture = { modality: m.architecture.modality, input_modalities: m.architecture.input_modalities, output_modalities: m.architecture.output_modalities };
    if (m.pricing) o.pricing = m.pricing;
    if (m.description) o.description = m.description;
    return o;
  });
  return { data, byId: new Map(data.map(m => [m.id, m])), updatedAt: new Date().toISOString() };
}
export async function catalog() {
  if (cache && Date.now() - at < TTL) return cache;
  if (!inflight) inflight = load().then(c => { cache = c; at = Date.now(); return c; }).catch(e => {
    console.error("catalog", e.message);
    if (!cache) {
      // Cold start with the gateway down: fall back to the snapshot shipped in the repo.
      try {
        const j = JSON.parse(fs.readFileSync(new URL("../data/models.json", import.meta.url), "utf8"));
        cache = { data: j.data, byId: new Map(j.data.map(m => [m.id, m])), updatedAt: j.updatedAt, stale: true }; at = Date.now() - TTL + 30e3;
      } catch { throw e; }
    }
    cache.stale = true; return cache;
  }).finally(() => { inflight = null; });
  return inflight;
}
export async function publicCatalog() {
  const c = await catalog();
  return { data: c.data, dead: [...DEAD], live: !c.stale, source: c.stale ? "cached catalogue" : "live gateway",
    gatewayCount: c.data.length, plannedCount: 0, updatedAt: c.updatedAt };
}
export function tokenRates(m) {
  const p = m && m.pricing; if (!p) return null;
  const i = +p.input_per_1M_tokens, o = +p.output_per_1M_tokens;
  if (!Number.isFinite(i) || !Number.isFinite(o) || (i <= 0 && o <= 0)) return null;
  return { in: i, out: o };
}
export const makesImages = m => ((m.architecture && m.architecture.output_modalities) || []).includes("image");
export const seesImages = m => ((m.architecture && m.architecture.input_modalities) || []).includes("image");

// Video: turn the gateway's size strings ("16:9_5", "720p_10", "5_no_audio", "default") into
// the aspect/duration grid the workspace offers, remembering what to send upstream for each cell.
export function videoSpec(m) {
  const p = m.pricing || {}, grid = new Map();
  const add = (aspect, duration, usd, up) => {
    const k = `${aspect || "16:9"}|${duration}`, cr = Math.round(usd * 1000 * 100) / 100;
    if (!grid.has(k) || grid.get(k).credits > cr) grid.set(k, { credits: cr, aspect, duration, up });
  };
  for (const v of p.variants || []) for (const o of v.options || []) {
    const parts = String(o.size).split("_");
    if (parts.includes("no") || /no_audio/.test(o.size)) continue;
    let aspect = null, duration = null, res = null;
    for (const x of parts) {
      if (/^\d+:\d+$/.test(x)) aspect = x; else if (/^\d+p$/i.test(x)) res = x; else if (/^\d+$/.test(x)) duration = x;
    }
    if (o.size === "default") duration = duration || "5";
    if (!duration) continue;
    add(aspect, duration, +o.price, { quality: v.quality, size: o.size, aspect_ratio: aspect || undefined, duration, resolution: res || undefined });
  }
  if (!grid.size && p.base_price) add(null, "5", +p.base_price, { duration: "5" });
  if (!grid.size) return null;
  const cells = [...grid.values()];
  const aspects = [...new Set(cells.map(c => c.aspect).filter(Boolean))];
  const durations = [...new Set(cells.map(c => c.duration))].sort((a, b) => a - b);
  const prices = Object.fromEntries([...grid].map(([k, v]) => [k, v.credits]));
  const id = m.id;
  const i2v = /i2v|image-to-video|img2vid/i.test(id), t2v = /t2v|text-to-video/i.test(id);
  return { id, name: m.name, owned_by: m.owned_by, fromCredits: Math.min(...cells.map(c => c.credits)),
    aspectRatios: aspects, durations, prices, acceptsImage: !t2v, requiresImage: i2v, _grid: grid };
}
export async function videoModels() {
  const c = await catalog();
  return c.data.filter(m => m.type === "video" && !DEAD.has(m.id)).map(videoSpec).filter(Boolean);
}
