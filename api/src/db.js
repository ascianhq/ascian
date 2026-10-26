import pg from "pg";
import fs from "node:fs";
import { cfg } from "./env.js";
pg.types.setTypeParser(1700, v => (v == null ? null : Number(v))); // numeric -> number: credits are fractional, never huge
export const pool = new pg.Pool({
  connectionString: cfg.databaseUrl,
  max: 10,
  ssl: /railway|rlwy|amazonaws/.test(cfg.databaseUrl) && !/\.railway\.internal/.test(cfg.databaseUrl) ? { rejectUnauthorized: false } : undefined
});
export const q = (text, params) => pool.query(text, params);
export async function one(text, params) { return (await pool.query(text, params)).rows[0] || null; }
export async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("begin"); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; }
  finally { c.release(); }
}
export async function migrate() {
  await pool.query(fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
}
