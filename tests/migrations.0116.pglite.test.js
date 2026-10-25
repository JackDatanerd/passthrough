import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0116 (partners round 39) against a real Postgres (PGlite): one open code request per partner, the orphaned terms-acceptance
// purge, and the once-only give-back index.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0116'))
const U1 = '55555555-5555-5555-5555-555555555555', P1 = '66666666-6666-6666-6666-666666666661', C1 = '77777777-7777-7777-7777-777777777771'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@x.co', 'h')`)
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','legacy-token')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{"FIX":1900}'::jsonb)`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0116: partner_code_requests', () => {
  it('allows one OPEN request per partner, and a new one once it is answered', async () => {
    await q(`insert into partner_code_requests (partner_id, wanted_code) values ($1, 'A')`, [P1])
    await expect(q(`insert into partner_code_requests (partner_id) values ($1)`, [P1])).rejects.toThrow()
    await q(`update partner_code_requests set status = 'DONE', resolved_at = now() where partner_id = $1`, [P1])
    await q(`insert into partner_code_requests (partner_id) values ($1)`, [P1])
    expect((await q(`select count(*)::int n from partner_code_requests where partner_id = $1`, [P1]))[0].n).toBe(2)
  })
  it('rejects an unknown status', async () => {
    await expect(q(`insert into partner_code_requests (partner_id, status) values ($1, 'WHATEVER')`, [P1])).rejects.toThrow()
  })
})

describe('0116: purge_unlinked_terms_acceptances', () => {
  it('removes old email-only rows whose application is gone, keeps the rest', async () => {
    await q(`insert into partner_applications (name, email, status) values ('Kept', 'kept@x.co', 'PENDING')`)
    await q(`insert into partner_terms_acceptances (application_email, version, source, accepted_at) values
      ('gone@x.co', 'v1', 'application', now() - interval '3 days'),
      ('KEPT@x.co', 'v1', 'application', now() - interval '3 days'),
      ('fresh@x.co', 'v1', 'application', now())`)
    await q(`insert into partner_terms_acceptances (partner_id, version, source, accepted_at) values ($1, 'v1', 'dashboard', now() - interval '9 days')`, [P1])
    const [{ n }] = await q(`select purge_unlinked_terms_acceptances(100) n`)
    expect(n).toBe(1)
    const left = (await q(`select application_email e from partner_terms_acceptances order by 1 nulls first`)).map(r => r.e)
    expect(left).toEqual([null, 'KEPT@x.co', 'fresh@x.co'])
  })
})

describe('0116: one give-back per sale', () => {
  it('refuses a second positive adjustment tied to the same sale, but not negative partials', async () => {
    const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_code, referral_commission_rate)
      values (5000, 'gbref', '${U1}', '${C1}', 'ANN10', 0.2) returning id`)
    const [{ id: sale }] = await q(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, usage_counted)
      values ($1, '${P1}', '${C1}', 5000, 0.2, 1000, false) returning id`, [pay])
    const adj = amt => q(`insert into commission_ledger (partner_id, kind, gross_amount_cents, commission_rate, commission_amount_cents, adjustment_reason, adjusts_ledger_id)
      values ('${P1}', 'ADJUSTMENT', 0, 0, $1, 'x', $2)`, [amt, sale])
    await adj(-300); await adj(-200)
    await adj(500)
    await expect(adj(500)).rejects.toThrow()
  })
})
