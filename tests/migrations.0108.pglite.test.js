import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0108 (partners round 28) against a real Postgres (PGlite): the usage counter follows a MOVED sale, and a move cannot
// overdraw the target code's usage limit.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0108_partners_section4_round28.sql'
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

const uses = async id => (await q(`select uses_so_far from referral_codes where id='${id}'`))[0].uses_so_far
const bump = async (code, ledger) => (await q('select increment_referral_code_usage($1, null, $2) as r', [code, ledger]))[0].r

describe('0108: increment_referral_code_usage()', () => {
  it('charges the code the sale CURRENTLY belongs to, even when it was moved after the caller resolved the old one', async () => {
    const { id } = await newSale({ used: false })        // recordConversion has written the row, not yet bumped
    expect(await reattr(id)).toBe('ok')                  // an admin moves it to NEW10 in that gap
    const c1 = await uses(C1), c2 = await uses(C2)
    expect(await bump(C1, id)).toBe(true)                // the caller still passes the OLD code id
    expect(await uses(C1)).toBe(c1)
    expect(await uses(C2)).toBe(c2 + 1)
    expect((await q(`select usage_counted from commission_ledger where id=$1`, [id]))[0].usage_counted).toBe(true)
  })
  it('an unmoved sale still charges its own code, once; a repeat call changes nothing', async () => {
    const { id } = await newSale({ used: false })
    const c1 = await uses(C1)
    expect(await bump(C1, id)).toBe(true)
    expect(await uses(C1)).toBe(c1 + 1)
    expect(await bump(C1, id)).toBe(false)
    expect(await uses(C1)).toBe(c1 + 1)
  })
  it('with no ledger id it falls back to the code id it was given', async () => {
    const c1 = await uses(C1)
    expect((await q('select increment_referral_code_usage($1) as r', [C1]))[0].r).toBe(true)
    expect(await uses(C1)).toBe(c1 + 1)
  })
  it('a reversed sale settles its flag without consuming a slot', async () => {
    const { id, pay } = await newSale({ used: false })
    await db.exec(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, reverses_ledger_id)
      values ('${pay}', '${P1}', '${C1}', -2900, 0.2, -580, '${id}')`)
    const c1 = await uses(C1)
    expect(await bump(C1, id)).toBe(false)
    expect(await uses(C1)).toBe(c1)
  })
})

describe('0108: reattribute_sale() and the target code\'s usage limit', () => {
  it('refuses a counted sale when the target is at its limit, and moves nothing', async () => {
    await db.exec(`update referral_codes set usage_limit = uses_so_far where id = '${C2}'`)
    const { id, pay } = await newSale()
    const c1 = await uses(C1), c2 = await uses(C2)
    expect(await reattr(id)).toBe('target_exhausted')
    expect((await q(`select partner_id, referral_code_id from commission_ledger where id=$1`, [id]))[0]).toEqual({ partner_id: P1, referral_code_id: C1 })
    expect((await q(`select referral_code_id from payments where id=$1`, [pay]))[0].referral_code_id).toBe(C1)
    expect(await uses(C1)).toBe(c1)
    expect(await uses(C2)).toBe(c2)
  })
  it('allows it once the limit is raised, and always allows an uncounted sale (no slot moves)', async () => {
    const counted = await newSale()
    await db.exec(`update referral_codes set usage_limit = usage_limit + 1 where id = '${C2}'`)
    expect(await reattr(counted.id)).toBe('ok')
    await db.exec(`update referral_codes set usage_limit = uses_so_far where id = '${C2}'`)
    const free = await newSale({ used: false })
    expect(await reattr(free.id)).toBe('ok')
  })
  it('a code with no limit is never exhausted', async () => {
    await db.exec(`update referral_codes set usage_limit = null where id = '${C2}'`)
    const { id } = await newSale()
    expect(await reattr(id)).toBe('ok')
  })
})

describe('0108: housekeeping', () => {
  it('re-running the file changes nothing, records itself once and never moves the schema version backwards', async () => {
    await db.exec(read(MIG))
    expect((await q(`select count(*)::int as c from applied_migrations where version = 108`))[0].c).toBe(1)
    expect((await q(`select (value->>'version')::int as v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(108)
  })
  it('only the service role can run either function', async () => {
    const { id } = await newSale({ used: false })
    await db.exec('set role anon')
    let denied = 0
    try { await q('select increment_referral_code_usage($1, null, $2)', [C1, id]) } catch (_) { denied++ }
    try { await reattr(id) } catch (_) { denied++ }
    await db.exec('reset role')
    expect(denied).toBe(2)
  })
})
