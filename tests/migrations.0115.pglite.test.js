import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0115 (partners round 38) against a real Postgres (PGlite): the partial-refund adjustment is capped under the sale's lock,
// refused once the sale was reversed, tied to its sale, and the terms-acceptance log accepts both kinds of row.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0115'))
const U1 = '55555555-5555-5555-5555-555555555555', P1 = '66666666-6666-6666-6666-666666666661', C1 = '77777777-7777-7777-7777-777777777771'

let db, n = 0
const q = async (sql, params) => (await db.query(sql, params)).rows
const adjust = async (id, cents) => (await q('select adjust_sale_commission($1,$2,$3,null) as r', [id, cents, 'Partial refund test']))[0].r
async function newSale(commission = 1000) {
  n++
  const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_code, referral_commission_rate)
    values (5000, 'ref${n}', '${U1}', '${C1}', 'ANN10', 0.2) returning id`)
  const [{ id }] = await q(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, usage_counted)
    values ($1, '${P1}', '${C1}', 5000, 0.2, $2, false) returning id`, [pay, commission])
  return { id, pay }
}

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

describe('0115: adjust_sale_commission', () => {
  it('records a negative adjustment tied to the sale, for the partner, in the sale currency', async () => {
    const s = await newSale()
    const r = await adjust(s.id, 400)
    expect(r.status).toBe('ok')
    expect(r.remaining_cents).toBe(600)
    const [row] = await q('select * from commission_ledger where adjusts_ledger_id = $1', [s.id])
    expect(row).toMatchObject({ kind: 'ADJUSTMENT', commission_amount_cents: -400, partner_id: P1, payment_id: null })
  })
  it('never takes back more than the sale still earns, across several partials', async () => {
    const s = await newSale()
    expect((await adjust(s.id, 700)).status).toBe('ok')
    const over = await adjust(s.id, 400)
    expect(over).toMatchObject({ status: 'exceeds', remaining_cents: 300 })
    expect((await adjust(s.id, 300)).remaining_cents).toBe(0)
    expect((await adjust(s.id, 1)).status).toBe('exceeds')
  })
  it('refuses a sale that was already reversed in full', async () => {
    const s = await newSale()
    await db.exec(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, reverses_ledger_id)
      select payment_id, partner_id, referral_code_id, -gross_amount_cents, commission_rate, -commission_amount_cents, id from commission_ledger where id = '${s.id}'`)
    expect((await adjust(s.id, 100)).status).toBe('already_reversed')
  })
  it('refuses anything that is not a sale, and an unknown id', async () => {
    const [{ id: adj }] = await q(`insert into commission_ledger (partner_id, gross_amount_cents, commission_rate, commission_amount_cents, kind, adjustment_reason)
      values ('${P1}', 0, 0, -50, 'ADJUSTMENT', 'manual') returning id`)
    expect((await adjust(adj, 10)).status).toBe('not_a_sale')
    expect((await adjust('99999999-9999-9999-9999-999999999999', 10)).status).toBe('not_found')
  })
  it('a non-positive amount is an error, not a silent positive adjustment', async () => {
    const s = await newSale()
    await expect(adjust(s.id, 0)).rejects.toThrow()
    await expect(adjust(s.id, -5)).rejects.toThrow()
  })
  it('only a service-role caller may run it', async () => {
    const rows = await q(`select has_function_privilege('anon', 'adjust_sale_commission(uuid,int,text,uuid)', 'execute') a,
      has_function_privilege('authenticated', 'adjust_sale_commission(uuid,int,text,uuid)', 'execute') b,
      has_function_privilege('service_role', 'adjust_sale_commission(uuid,int,text,uuid)', 'execute') c`)
    expect(rows[0]).toEqual({ a: false, b: false, c: true })
  })
  it('a SALE row cannot carry adjusts_ledger_id (shape check)', async () => {
    const s = await newSale()
    await expect(db.exec(`update commission_ledger set adjusts_ledger_id = '${s.id}' where id = '${s.id}'`)).rejects.toThrow()
  })
})

describe('0115: partner_terms_acceptances', () => {
  it('takes a dashboard acceptance and an application acceptance, and refuses a row with neither a partner nor an applicant', async () => {
    await db.exec(`insert into partner_terms_acceptances (partner_id, version, source) values ('${P1}', '2026-10b', 'dashboard')`)
    await db.exec(`insert into partner_terms_acceptances (application_email, version, source) values ('a@x.co', '2026-10b', 'application')`)
    await expect(db.exec(`insert into partner_terms_acceptances (version, source) values ('2026-10b', 'dashboard')`)).rejects.toThrow()
    await expect(db.exec(`insert into partner_terms_acceptances (partner_id, version, source) values ('${P1}', 'v', 'somewhere')`)).rejects.toThrow()
  })
  it('records the migration and moves schema_version to 115', async () => {
    expect((await q(`select name from applied_migrations where version = 115`))[0].name).toBe('0115_partners_section4_round38')
    expect((await q(`select (value->>'version')::int v from system_state where key='schema_version'`))[0].v).toBe(115)
  })
})
