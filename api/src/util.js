import crypto from "node:crypto";
export const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
export const rand = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");
export const urlsafe = n => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const b = crypto.randomBytes(n); let s = "";
  for (let i = 0; i < n; i++) s += abc[b[i] % abc.length];
  return s;
};
// The UI shows data.error verbatim; workspace errors end with "(code Wxxx)".
export function fail(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }
export const W = {
  W101: "Please sign in to use the workspace.", W102: "That run could not be found.",
  W103: "Model access is switched off on this server right now.", W104: "Type a message first.",
  W105: "That request carries a message type the workspace does not accept.", W106: "That message is too long.",
  W107: "That message is too long to send even on its own.", W108: "At most 8 images in one conversation.",
  W201: "That model is not in the catalogue right now.", W202: "That model does not answer chat.",
  W203: "That model cannot see pictures.", W204: "That model's provider is not serving it at the moment.",
  W205: "That model has no price yet.", W301: "Not enough credits for this turn.",
  W411: "We could not reach the model provider.", W412: "The model provider turned this request down.",
  W413: "The model provider is busy.", W414: "Model access is paused for a moment on our side.",
  W511: "The connection to the model dropped before it answered.", W512: "The model answered in a form we could not read.",
  W513: "That model did not answer this time.", W514: "That model spent its whole output budget thinking.",
  W515: "The model's provider reported an error.", W601: "Images must be sent as a data URL.",
  W602: "Images must be PNG, JPEG, WebP or GIF.", W603: "An image part needs image_url.url.",
  W701: "That image could not be found.", W801: "That render failed.", W802: "That video could not be found.",
  W803: "That video is no longer available.", W804: "Describe the video you want.", W805: "That description is too long.",
  W806: "That is not a video model.", W807: "That model does not take a start frame.", W808: "That model needs a start frame.",
  W809: "No published price for this length and shape.", W810: "Not enough credits for this video.",
  W811: "The video provider would not start that render.", W812: "That render is already in progress.",
  W813: "That render could not be found."
};
export const wmsg = (code, extra) => (extra ? `${W[code]} ${extra}` : W[code]) + ` (code ${code})`;
export const wfail = (res, status, code, extra, more) => fail(res, status, wmsg(code, extra), more);

// In-memory sliding-window limiter. One Railway instance, so memory is the right store;
// counting by exact IP is not counting (IPv6 hands out /64s), so key by /24 or /64.
const buckets = new Map();
export function ipKey(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":");
  return ip.split(".").slice(0, 3).join(".");
}
export function limited(key, max, windowMs) {
  const now = Date.now(), arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now); buckets.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600e3) buckets.delete(k); }, 600e3).unref();
export const round4 = n => Math.round(n * 1e4) / 1e4;
