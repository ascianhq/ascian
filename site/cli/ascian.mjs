#!/usr/bin/env node
// ascian terminal client. One file, no dependencies, Node 18+.
// Talks only to the public OpenAI-compatible API at <origin>/v1 with your key.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import readline from "node:readline";
const NAME = "ascian";
const ORIGIN = (process.env[NAME.toUpperCase() + "_ORIGIN"] || "https://ascian.fun").replace(/\/$/, "");
const DIR = path.join(os.homedir(), "." + NAME), CFG = path.join(DIR, "config.json");
const load = () => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } };
const save = c => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CFG, JSON.stringify(c, null, 2), { mode: 0o600 }); };
let cfg = load();
const key = () => process.env[NAME.toUpperCase() + "_KEY"] || cfg.key;
const tty = process.stdout.isTTY, c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = s => c(2, s), bold = s => c(1, s), red = s => c(31, s);

async function api(p, opt = {}) {
  const r = await fetch(ORIGIN + "/v1" + p, { ...opt, headers: { authorization: "Bearer " + key(), "content-type": "application/json", ...(opt.headers || {}) } });
  if (!r.ok) {
    let m = `HTTP ${r.status}`; try { const j = await r.json(); m = (j.error && j.error.message) || j.message || m; } catch {}
    if (r.status === 401) m = "That key was rejected. Make a new one and run `" + NAME + " login` again.";
    const e = new Error(m); e.status = r.status; throw e;
  }
  return r;
}
// Markdown-lite for the terminal: bold, inline code, fenced code set apart.
function render(t) {
  let inFence = false;
  return t.split("\n").map(l => {
    if (/^```/.test(l)) { inFence = !inFence; return dim(l); }
    if (inFence) return c(36, l);
    return l.replace(/\*\*([^*]+)\*\*/g, (_, x) => bold(x)).replace(/`([^`]+)`/g, (_, x) => c(36, x)).replace(/^(#+)\s+(.*)$/, (_, h, x) => bold(x));
  }).join("\n");
}
async function ask(messages) {
  const r = await api("/chat/completions", { method: "POST", body: JSON.stringify({ model: cfg.model, messages, stream: true }) });
  const dec = new TextDecoder(); let buf = "", text = "", usage = null, charged = null, line = "";
  for await (const part of r.body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l.startsWith("data:")) continue;
      const d = l.slice(5).trim(); if (d === "[DONE]") continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.usage) usage = j.usage;
      if (j[NAME] && j[NAME].credits_charged != null) charged = j[NAME].credits_charged;
      const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (delta) {
        text += delta; line += delta;
        // Print whole lines so bold and code render; the tail prints at the end.
        let k; while ((k = line.indexOf("\n")) >= 0) { process.stdout.write(render(line.slice(0, k)) + "\n"); line = line.slice(k + 1); }
      }
    }
  }
  if (line) process.stdout.write(render(line) + "\n");
  const u = usage ? `${usage.prompt_tokens} in · ${usage.completion_tokens} out` : "";
  console.log(dim([u, charged != null ? `${charged} credits` : ""].filter(Boolean).join(" · ")));
  return text;
}
async function pickDefaultModel() {
  if (cfg.model) return;
  const j = await (await api("/models")).json(), ids = j.data.map(m => m.id);
  cfg.model = ["claude-sonnet-5", "gpt-5.6-sol", "deepseek/deepseek-v4.1-flash"].find(x => ids.includes(x)) || ids[0];
  save(cfg);
}
async function login() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const k = (await new Promise(r => rl.question(`Paste a key from ${ORIGIN}/account#api: `, r))).trim(); rl.close();
  if (!k) return console.log("Nothing pasted.");
  const r = await fetch(ORIGIN + "/v1", { headers: { authorization: "Bearer " + k, accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!j.authenticated) { console.log(red("That key was rejected.")); process.exit(1); }
  cfg.key = k; save(cfg);
  console.log(`Saved to ${CFG}. Balance: ${j.account && j.account.credits != null ? j.account.credits.toFixed(2) + " credits" : "unknown"}.`);
}
async function balance() {
  const r = await fetch(ORIGIN + "/v1", { headers: { authorization: "Bearer " + key(), accept: "application/json" } });
  const j = await r.json(); console.log(j.account ? `${j.account.credits.toFixed(2)} credits` : "Not signed in.");
}
async function repl() {
  await pickDefaultModel();
  console.log(dim(`${NAME} · ${cfg.model} · /models /model <id> /new /balance /exit`));
  let history = [];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const input of rl) {
    const t = input.trim();
    try {
      if (!t) {}
      else if (t === "/exit" || t === "/quit") break;
      else if (t === "/new") { history = []; console.log(dim("New conversation.")); }
      else if (t === "/balance") await balance();
      else if (t === "/models") { const j = await (await api("/models")).json(); console.log(j.data.map(m => m.id).join("\n")); }
      else if (t === "/model") console.log(cfg.model);
      else if (t.startsWith("/model ")) {
        const id = t.slice(7).trim(), j = await (await api("/models")).json();
        if (!j.data.some(m => m.id === id)) console.log(red(`No model called ${id}. /models lists them.`));
        else { cfg.model = id; save(cfg); console.log(dim(`Now using ${id}. The conversation continues.`)); }
      }
      else if (t.startsWith("/")) console.log(dim("Commands: /models /model <id> /new /balance /exit"));
      else { history.push({ role: "user", content: t }); const a = await ask(history); history.push({ role: "assistant", content: a }); }
    } catch (e) {
      if (history.length && history[history.length - 1].role === "user") history.pop();
      console.log(red(e.status === 402 ? "Not enough credits. Add some at " + ORIGIN + "/account#topup" : e.message));
    }
    rl.prompt();
  }
  rl.close();
}
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "login") await login();
  else if (!key()) { console.log(`Not signed in. Run: ${NAME} login`); process.exit(1); }
  else if (cmd === "logout") { delete cfg.key; save(cfg); console.log("Signed out on this machine."); }
  else if (cmd) { await pickDefaultModel(); await ask([{ role: "user", content: [cmd, ...rest].join(" ") }]); }
  else await repl();
} catch (e) { console.log(red(e.status === 402 ? "Not enough credits. Add some at " + ORIGIN + "/account#topup" : e.message)); process.exit(1); }
