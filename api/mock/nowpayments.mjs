// Stand-in for the NOWPayments API. Tests move a payment along with setStatus().
import http from "node:http";
const pays = new Map(); let n = Date.now() % 1e9; // unique across restarts, like real ids
export function setStatus(id, st, paid) { const p = pays.get(String(id)); Object.assign(p, { payment_status: st, actually_paid: paid }); return p; }
export const all = pays;
export function start(port) {
  return http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {}, u = new URL(req.url, "http://x");
    const out = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-api-key"] !== "np-test") return out(403, { message: "Invalid api key" });
    if (u.pathname === "/full-currencies") return out(200, { currencies: [
      { code: "BTC", name: "Bitcoin", network: "btc", enable: true }, { code: "USDTTRC20", name: "Tether USD (Tron)", network: "trx", enable: true },
      { code: "ETH", name: "Ethereum", network: "eth", enable: true }, { code: "SOL", name: "Solana", network: "sol", enable: true }, { code: "OFF", name: "Off", enable: false }] });
    if (u.pathname === "/min-amount") return out(200, { currency_from: u.searchParams.get("currency_from"), fiat_equivalent: u.searchParams.get("currency_from") === "usdttrc20" ? 12.78 : 1.1 });
    if (u.pathname === "/merchant/coins") return out(200, { selectedCurrencies: ["BTC", "USDTTRC20", "ETH", "SOL"] });
    if (u.pathname === "/payment" && req.method === "POST") {
      const id = String(++n), rate = { btc: 80000, eth: 2600, sol: 110, usdttrc20: 1 }[j.pay_currency] || 1;
      const p = { payment_id: id, payment_status: "waiting", pay_address: "addr_" + j.pay_currency + "_" + id, price_amount: j.price_amount, price_currency: "usd",
        pay_amount: +(j.price_amount / rate).toFixed(8), actually_paid: 0, pay_currency: j.pay_currency, order_id: j.order_id, ipn: j.ipn_callback_url,
        expiration_estimate_date: new Date(Date.now() + 20 * 60e3).toISOString() };
      pays.set(id, p); return out(201, p);
    }
    const m = u.pathname.match(/^\/payment\/(\d+)$/);
    if (m && pays.get(m[1])) return out(200, pays.get(m[1]));
    out(404, { message: "mock: " + u.pathname });
  }).listen(port);
}
