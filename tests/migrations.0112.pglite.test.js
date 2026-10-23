import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 0112 on a real Postgres: partners_overview_totals gives the same four totals the Worker used to add up row by row.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const WELCOME = '00000000-0000-4000-8000-00000000e1c0'
let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const partner = async (name, email) => (await q(`insert into partners (name, email, commission_rate) values ($1, $2, 0.2) returning id`, [name, email]))[0].id
const adj = (pid, cents, payout = null) => q(`insert into commission_ledger (partner_id, kind, gross_amount_cents, commission_rate, commission_amount_cents, currency, adjustment_reason, payout_id)
  values ($1, 'ADJUSTMENT', 0, 0, $2, 'USD', 'test', $3)`, [pid, cents, payout])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f <= '0112_partners_section4_round33.sql')) await db.exec(read(f))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0112: partners_overview_totals', () => {
  it('on an empty database returns zeros', async () => {
    const [{ r }] = await q('select partners_overview_totals(null) as r')
    expect(r).toEqual({ paid_out_cents: 0, lifetime_commission_cents: 0, owed_cents: 0, credit_cents: 0 })
  })
  it('splits owed from credit per partner, counts voided payouts out, and leaves the excluded partner out', async () => {
    const a = await partner('A', 'a@x.co'), b = await partner('B', 'b@x.co'), w = await partner('W', 'w@x.co')
    await adj(a, 1000); await adj(a, -200)           // A owes 800
    await adj(b, -300)                               // B holds a 300 credit
    await adj(w, 5000)                               // the excluded one
    const mk = async (pid, cents, voided) => (await q(`insert into payouts (partner_id, amount_cents, currency, payout_method, payout_details_snapshot, settled_commission_cents, voided_at)
      values ($1, $2, 'USD', 'BANK', '{}'::jsonb, $2, $3) returning id`, [pid, cents, voided]))[0].id
    const live = await mk(a, 400, null); await mk(a, 999, '2026-01-01T00:00:00Z')
    await adj(a, 400, live)                          // settled by the live payout: not owed, still earned
    const [{ r }] = await q('select partners_overview_totals($1) as r', [w])
    expect(r).toEqual({ paid_out_cents: 400, lifetime_commission_cents: 1000 - 200 - 300 + 400, owed_cents: 800, credit_cents: 300 })
    const [{ r: all }] = await q('select partners_overview_totals(null) as r')
    expect(all.owed_cents).toBe(800 + 5000)
  })
  it('is recorded as 112 and not callable by anon', async () => {
    expect((await q(`select name from applied_migrations where version = 112`)).map(r => r.name)).toEqual(['0112_partners_section4_round33'])
    expect((await q(`select has_function_privilege('anon', 'partners_overview_totals(uuid)', 'execute') as ok`))[0].ok).toBe(false)
  })
})
