import { cfg } from "./env.js";
export const mailOn = () => !!(cfg.resendKey && cfg.mailFrom);
export async function sendMail(to, subject, text) {
  if (!mailOn()) throw new Error("mail off");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: "Bearer " + cfg.resendKey, "content-type": "application/json" },
    body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject, text })
  });
  if (!r.ok) throw new Error("mail " + r.status + " " + (await r.text()).slice(0, 200));
}
