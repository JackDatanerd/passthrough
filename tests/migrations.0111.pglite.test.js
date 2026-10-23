import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0111 (partners round 29, first shipped as 0110) against a real Postgres: the ledger repair for a database that recorded the
// file under the colliding number, and record_payout_settlement re-checking the payout details under the partner lock.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const WEB = '0110_webhooks_round27.sql', MIG = '0111_partners_section4_round29.sql'
const OLD = '0110_partners_section4_round29'
let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const ledger = async v => (await q('select name from applied_migrations where version = $1', [v])).map(r => r.name)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < WEB)) await db.exec(read(f))
  // What production holds: this file's work recorded under the number the webhooks migration also uses.
  await db.exec(`insert into applied_migrations (version, name) values (110, '${OLD}')`)
}, 240000)
afterAll(async () => { await db?.close() })

describe('0111: ledger repair', () => {
  it('leaves the 110 row alone while the webhooks migration has not run, and records itself as 111', async () => {
    await db.exec(read(MIG))
    expect(await ledger(110)).toEqual([OLD])
    expect(await ledger(111)).toEqual(['0111_partners_section4_round29'])
  })
  it('renames the 110 row once the webhooks migration is applied, and re-runs cleanly', async () => {
    await db.exec(read(WEB))
    expect(await ledger(110)).toEqual([OLD])        // its own insert hit "on conflict do nothing"
    await db.exec(read(MIG))
    expect(await ledger(110)).toEqual(['0110_webhooks_round27'])
    await db.exec(read(MIG))
    expect(await ledger(111)).toHaveLength(1)
    expect((await q(`select (value->>'version')::int as v from system_state where key = 'schema_version'`))[0].v).toBe(111)
  })
})

describe('0111: record_payout_settlement re-checks the details under the lock', () => {
  it('has one seven-argument signature (the old five-argument one is gone)', async () => {
    const r = await q(`select pronargs from pg_proc where proname = 'record_payout_settlement'`)
    expect(r).toEqual([{ pronargs: 7 }])
  })
  it('records nothing and says so when the details changed since they were read', async () => {
    const [{ id }] = await q(`insert into partners (name, email, commission_rate) values ('P', 'p@x.co', 0.2) returning id`)
    const payout = JSON.stringify({ amount_cents: 100, currency: 'USD', payout_method: 'BANK', settled_commission_cents: 100 })
    const [{ r: changed }] = await q(`select record_payout_settlement($1, array[]::uuid[], $2::jsonb, false, false, true, '2020-01-01T00:00:00Z') as r`, [id, payout])
    expect(changed.details_changed).toBe(true)
    expect((await q('select count(*)::int as c from payouts where partner_id = $1', [id]))[0].c).toBe(0)
    const [{ r: ok }] = await q(`select record_payout_settlement($1, array[]::uuid[], $2::jsonb, false, false, true, null) as r`, [id, payout])
    expect(ok.details_changed).toBeUndefined()
    expect(ok.payout.amount_cents).toBe(100)
  })
})
