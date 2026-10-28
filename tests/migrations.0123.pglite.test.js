import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0123 (partners round 43) against a real Postgres (PGlite): increment_referral_code_usage() again stamps usage_released_at
// on a sale that was already refunded when its counter was bumped (0108 dropped that), so a redelivered refund cannot take a slot
// that was never added. 0108's "charge the sale's CURRENT code" behaviour is kept, and rows 0108 left unstamped are repaired.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0123'))
const P1 = '22222222-2222-2222-2222-222222222222'
const P2 = '33333333-3333-3333-3333-333333333333'
const C1 = '44444444-4444-4444-4444-444444444444'
const C2 = '66666666-6666-6666-6666-666666666666'
const U1 = '55555555-5555-5555-5555-555555555555'

let db, n = 0, legacy
const q = async (sql, params) => (await db.query(sql, params)).rows
const uses = async id => (await q(`select uses_so_far from referral_codes where id='${id}'`))[0].uses_so_far
const bump = async (code, ledger) => (await q('select increment_referral_code_usage($1, null, $2) as r', [code, ledger]))[0].r
const release = async ledger => (await q('select release_referral_code_usage_for_ledger($1) as r', [ledger]))[0].r
const row = async id => (await q('select usage_counted, usage_released_at from commission_ledger where id=$1', [id]))[0]
async function newSale({ reversed = false } = {}) {
  n++
  const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_code, referral_commission_rate)
    values (2900, 'ref${n}', '${U1}', '${C1}', 'ANN10', 0.2) returning id`)
  const [{ id }] = await q(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, usage_counted)
    values ($1, '${P1}', '${C1}', 2900, 0.2, 580, false) returning id`, [pay])
  if (reversed) await db.exec(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents, reverses_ledger_id)
    values ('${pay}', '${P1}', '${C1}', -2900, 0.2, -580, '${id}')`)
  return id
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
  // The state the 0108 function leaves behind: a refunded sale settled by the bump, not stamped released.
  legacy = await newSale({ reversed: true })
  await bump(C1, legacy)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0123: increment_referral_code_usage()', () => {
  it('records itself in the ledger and moves schema_version to 123', async () => {
    expect((await q(`select name from applied_migrations where version = 123`))[0].name).toBe('0123_partners_section4_round43')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(123)
  })
  it('repairs a refunded sale the 0108 function left unstamped, so a release cannot take a slot', async () => {
    expect((await row(legacy)).usage_released_at).not.toBeNull()
    const before = await uses(C1)
    expect(await release(legacy)).toBe(false)
    expect(await uses(C1)).toBe(before)
  })
  it('a sale already refunded when it is settled consumes no slot, and a redelivered refund gives none back', async () => {
    const id = await newSale({ reversed: true })
    const before = await uses(C1)
    expect(await bump(C1, id)).toBe(false)
    expect(await uses(C1)).toBe(before)
    const r = await row(id)
    expect(r.usage_counted).toBe(true)
    expect(r.usage_released_at).not.toBeNull()
    expect(await release(id)).toBe(false)           // the redelivered-refund path
    expect(await uses(C1)).toBe(before)             // was before - 1 with the 0108 function
  })
  it('a normal sale still takes one slot once and gives it back once', async () => {
    const id = await newSale()
    const before = await uses(C1)
    expect(await bump(C1, id)).toBe(true)
    expect(await bump(C1, id)).toBe(false)
    expect(await uses(C1)).toBe(before + 1)
    expect((await row(id)).usage_released_at).toBeNull()
    expect(await release(id)).toBe(true)
    expect(await release(id)).toBe(false)
    expect(await uses(C1)).toBe(before)
  })
  it('still charges the code the sale CURRENTLY belongs to (0108 behaviour kept)', async () => {
    const id = await newSale()
    expect((await q('select reattribute_sale($1,$2,$3,$4,$5) as r', [id, C2, P2, 0.3, 870]))[0].r).toBe('ok')
    const c1 = await uses(C1), c2 = await uses(C2)
    expect(await bump(C1, id)).toBe(true)
    expect(await uses(C1)).toBe(c1)
    expect(await uses(C2)).toBe(c2 + 1)
  })
})
