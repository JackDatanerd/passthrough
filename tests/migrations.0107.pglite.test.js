import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0107 (partners round 27) against a real Postgres (PGlite): the new columns, a safe re-run, and reattribute_sale()
// - the one transaction that moves an unpaid sale between partners.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0107_partners_section4_round27.sql'
const P1 = '22222222-2222-2222-2222-222222222222'
const P2 = '33333333-3333-3333-3333-333333333333'
const C1 = '44444444-4444-4444-4444-444444444444'
const C2 = '66666666-6666-6666-6666-666666666666'
const U1 = '55555555-5555-5555-5555-555555555555'

let db, n = 0
const q = async (sql, params) => (await db.query(sql, params)).rows
const reattr = async (ledger, code = C2, partner = P2, rate = 0.3, cents = 870) =>
  (await q('select reattribute_sale($1,$2,$3,$4,$5) as r', [ledger, code, partner, rate, cents]))[0].r
async function newSale({ used = true } = {}) {
  n++
  const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_code, referral_sub, referral_commission_rate)
    values (2900, 'ref${n}', '${U1}', '${C1}', 'ANN10', 'yt', 0.2) returning id`)
  const [{ id }] = await q(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, usage_counted, attribution_sub)
    values ($1, '${P1}', '${C1}', 2900, 0.2, 580, $2, 'yt') returning id`, [pay, used])
  if (used) await db.exec(`update referral_codes set uses_so_far = uses_so_far + 1 where id = '${C1}'`)
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
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','legacy-token'),('${P2}','Q','q@x.co','d2')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{"FIX":1900}'::jsonb),('${C2}','${P2}','NEW10','{"FIX":1900}'::jsonb)`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0107: columns', () => {
  it('dashboard_token_version defaults to 0 for existing partners, whose stored token is untouched; new partners need no stored token', async () => {
    const rows = await q(`select email, dashboard_token, dashboard_token_version from partners order by email`)
    expect(rows[0]).toMatchObject({ email: 'p@x.co', dashboard_token: 'legacy-token', dashboard_token_version: 0 })
    await db.exec(`insert into partners (name, email) values ('New', 'new@x.co')`)
    expect((await q(`select dashboard_token, dashboard_token_version from partners where email = 'new@x.co'`))[0]).toEqual({ dashboard_token: null, dashboard_token_version: 0 })
  })
  it('referral_commission_rate is a nullable numeric on payments, empty for existing rows', async () => {
    const [c] = await q(`select data_type, is_nullable from information_schema.columns where table_name = 'payments' and column_name = 'referral_commission_rate'`)
    expect(c).toEqual({ data_type: 'numeric', is_nullable: 'YES' })
  })
  it('re-running the file changes nothing and records itself once, never moving the schema version backwards', async () => {
    await db.exec(read(MIG))
    expect((await q(`select count(*)::int as c from applied_migrations where version = 107`))[0].c).toBe(1)
    expect((await q(`select (value->>'version')::int as v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(107)
  })
})

describe('0107: reattribute_sale()', () => {
  it('moves the ledger row, the payment and BOTH usage counters together', async () => {
    const { id, pay } = await newSale()
    const before = (await q(`select uses_so_far from referral_codes where id='${C1}'`))[0].uses_so_far
    expect(await reattr(id)).toBe('ok')
    expect((await q(`select partner_id, referral_code_id, commission_rate::float8 as rate, commission_amount_cents, attribution_sub from commission_ledger where id=$1`, [id]))[0])
      .toEqual({ partner_id: P2, referral_code_id: C2, rate: 0.3, commission_amount_cents: 870, attribution_sub: null })
    expect((await q(`select referral_code_id, referral_code, referral_sub, referral_commission_rate::float8 as rate from payments where id=$1`, [pay]))[0])
      .toEqual({ referral_code_id: C2, referral_code: 'NEW10', referral_sub: null, rate: 0.3 })
    expect((await q(`select uses_so_far from referral_codes where id='${C1}'`))[0].uses_so_far).toBe(before - 1)
    expect((await q(`select uses_so_far from referral_codes where id='${C2}'`))[0].uses_so_far).toBe(1)
  })
  it('a sale whose slot was never counted moves without touching either counter', async () => {
    const { id } = await newSale({ used: false })
    const c1 = (await q(`select uses_so_far from referral_codes where id='${C1}'`))[0].uses_so_far
    const c2 = (await q(`select uses_so_far from referral_codes where id='${C2}'`))[0].uses_so_far
    expect(await reattr(id)).toBe('ok')
    expect((await q(`select uses_so_far from referral_codes where id='${C1}'`))[0].uses_so_far).toBe(c1)
    expect((await q(`select uses_so_far from referral_codes where id='${C2}'`))[0].uses_so_far).toBe(c2)
  })
  it('refuses a reversed sale, a sale already in a payout, the same code, a code of another partner, an adjustment and an unknown row', async () => {
    const a = await newSale()
    await db.exec(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, reverses_ledger_id)
      values ('${a.pay}', '${P1}', '${C1}', -2900, 0.2, -580, '${a.id}')`)
    expect(await reattr(a.id)).toBe('already_reversed')

    const b = await newSale()
    expect(await reattr(b.id, C1, P1)).toBe('same_code')
    expect(await reattr(b.id, C2, P1)).toBe('target_not_found')   // C2 is not P1's code

    const [{ id: po }] = await q(`insert into payouts (partner_id, amount_cents, payout_method, status, payout_details_snapshot) values ('${P1}', 580, 'BANK', 'PAID', '{}'::jsonb) returning id`)
    await db.exec(`update commission_ledger set payout_id = '${po}' where id = '${b.id}'`)
    expect(await reattr(b.id)).toBe('already_paid')

    const [{ id: adj }] = await q(`insert into commission_ledger (partner_id, gross_amount_cents, commission_rate, commission_amount_cents, kind, adjustment_reason)
      values ('${P1}', 0, 0, 500, 'ADJUSTMENT', 'bonus') returning id`)
    expect(await reattr(adj)).toBe('not_a_sale')
    expect(await reattr('77777777-7777-7777-7777-777777777777')).toBe('not_found')
  })
  it('only the service role can run it', async () => {
    const { id } = await newSale()
    await db.exec('set role anon')
    let denied = false
    try { await db.query('select reattribute_sale($1,$2,$3,$4,$5)', [id, C2, P2, 0.3, 870]) } catch { denied = true }
    await db.exec('reset role')
    expect(denied).toBe(true)
    expect((await q(`select partner_id from commission_ledger where id=$1`, [id]))[0].partner_id).toBe(P1)
  })
})
