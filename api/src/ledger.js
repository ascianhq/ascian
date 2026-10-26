import { q, one, tx } from "./db.js";
export const CREDITS_PER_USD = 1000;

export async function balanceOf(accountId, c = null) {
  const run = c ? c.query.bind(c) : q;
  const r = (await run(
    `select coalesce((select sum(credits) from ledger where account_id=$1),0) as credits,
            coalesce((select sum(credits) from holds where account_id=$1 and expires_at>now()),0) as held`, [accountId])).rows[0];
  return { credits: r.credits, available: r.credits - r.held };
}

// Reserve the worst case before calling the gateway. The account row is locked so two
// parallel turns cannot both pass the check with the same credits.
export async function reserve(accountId, credits, ttlSec) {
  return tx(async c => {
    await c.query("select id from accounts where id=$1 for update", [accountId]);
    const b = await balanceOf(accountId, c);
    if (b.available < credits) return { ok: false, needed: Math.ceil(credits), available: b.available };
    const h = (await c.query("insert into holds (account_id, credits, expires_at) values ($1,$2, now() + ($3 || ' seconds')::interval) returning id",
      [accountId, credits, String(ttlSec)])).rows[0];
    return { ok: true, holdId: h.id };
  });
}
export async function release(holdId) { if (holdId) await q("delete from holds where id=$1", [holdId]); }

// Settle: drop the hold and write the real charge, never more than the account holds.
export async function settle(holdId, accountId, credits, { model, source = null, ref = null, keyId = null } = {}) {
  return tx(async c => {
    await c.query("select id from accounts where id=$1 for update", [accountId]);
    if (holdId) await c.query("delete from holds where id=$1", [holdId]);
    const b = await balanceOf(accountId, c);
    const amt = Math.max(0, Math.min(credits, Math.max(0, b.credits)));
    if (amt > 0) await c.query("insert into ledger (account_id, kind, credits, source, model, ref, key_id) values ($1,'spend',$2,$3,$4,$5,$6) on conflict do nothing",
      [accountId, -amt, source, model, ref, keyId]);
    return amt;
  });
}
export async function credit(accountId, kind, credits, { source = null, ref = null, model = null } = {}, c = null) {
  const run = c ? c.query.bind(c) : q;
  const r = await run("insert into ledger (account_id, kind, credits, source, ref, model) values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning id",
    [accountId, kind, credits, source, ref, model]);
  return r.rowCount > 0;
}
setInterval(() => q("delete from holds where expires_at < now() - interval '1 minute'").catch(() => {}), 60e3).unref();
