import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0100 (database round 5) against a real Postgres (PGlite). Concurrency of the same functions was verified on a
// multi-connection Postgres 16 outside the suite (PGlite is single-connection).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0100_database_round5.sql'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const P1 = '22222222-2222-2222-2222-222222222222'
const C1 = '44444444-4444-4444-4444-444444444444'
const U1 = '55555555-5555-5555-5555-555555555555'
let n = 0
const newSale = async () => {
  n++
  const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id) values (1900, 'ref${n}', '${U1}') returning id`)
  const [{ id }] = await q(`insert into commission_ledger (payment_id, partner_id, referral_code_id, gross_amount_cents, commission_rate, commission_amount_cents)
                            values ($1, '${P1}', '${C1}', 1900, 0.1, 190) returning id`, [pay])
  return id
}
const uses = async () => (await q(`select uses_so_far from referral_codes where id='${C1}'`))[0].uses_so_far

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','d1')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{"FIX":1900}'::jsonb)`)
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@x.co', 'h')`)
  for (const f of files.filter(f => f >= MIG)) await db.exec(read(f))
}, 180000)
afterAll(async () => { await db?.close() })

describe('0100: views and function hygiene', () => {
  it('both outcome views are security_invoker and closed to anon/authenticated', async () => {
    for (const v of ['prompt_outcome_rates', 'letter_prompt_outcome_rates']) {
      const [r] = await q(`select reloptions from pg_class where relname = $1`, [v])
      expect(r.reloptions, v).toContain('security_invoker=true')
      const [g] = await q(`select has_table_privilege('anon', $1, 'select') a, has_table_privilege('authenticated', $1, 'select') b, has_table_privilege('service_role', $1, 'select') c`, [v])
      expect(g, v).toEqual({ a: false, b: false, c: true })
    }
  })
  it('the trigger helpers pin their search_path', async () => {
    const rows = await q(`select proname, proconfig from pg_proc where proname in ('set_updated_at','employer_leads_set_mailbox_key','lead_mailbox_key')`)
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.proconfig, r.proname).toContain('search_path=public')
  })
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 100`))[0].name).toBe('0100_database_round5')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(100)
  })
})

describe('0100: tier price bounds match the payments column', () => {
  const ok = async p => { try { await db.query(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}', $1, $2::jsonb)`, ['T' + Math.random().toString(36).slice(2, 8).toUpperCase(), JSON.stringify(p)]); return true } catch { return false } }
  it('2147483647 is accepted, 2147483648 and 3000000000 are refused, normal prices pass', async () => {
    expect(await ok({ FIX: 2147483647 })).toBe(true)
    expect(await ok({ FIX: 2147483648 })).toBe(false)
    expect(await ok({ FIX: 3000000000 })).toBe(false)
    expect(await ok({ FIX: 3900, BADGE: 1900 })).toBe(true)
  })
})

describe('0100: releasing a code slot is idempotent', () => {
  it('three releases of one counted sale give back exactly one slot', async () => {
    const id = await newSale()
    await q(`update commission_ledger set usage_counted = false where id = $1`, [id])   // recordConversion writes it uncounted, then counts it
    await q(`select increment_referral_code_usage('${C1}', null, $1)`, [id])
    expect(await uses()).toBe(1)
    expect((await q(`select release_referral_code_usage_for_ledger($1) r`, [id]))[0].r).toBe(true)
    expect((await q(`select release_referral_code_usage_for_ledger($1) r`, [id]))[0].r).toBe(false)
    expect((await q(`select release_referral_code_usage_for_ledger($1) r`, [id]))[0].r).toBe(false)
    expect(await uses()).toBe(0)
  })
  it('a sale that never counted releases nothing', async () => {
    const id = await newSale()
    await q(`update commission_ledger set usage_counted = false where id = $1`, [id])
    expect((await q(`select release_referral_code_usage_for_ledger($1) r`, [id]))[0].r).toBe(false)
  })
})

describe('0100: drift report', () => {
  it('is empty when counters match the ledger and names a code when they do not', async () => {
    await q(`update referral_codes set uses_so_far = 0 where id = '${C1}'`)
    const held = (await q(`select count(*)::int n from commission_ledger where usage_counted and usage_released_at is null and reverses_ledger_id is null and kind = 'SALE'`))[0].n
    await q(`update referral_codes set uses_so_far = $1 where id = '${C1}'`, [held])
    expect(await q(`select * from referral_usage_drift()`)).toEqual([])
    await q(`update referral_codes set uses_so_far = $1 where id = '${C1}'`, [held + 4])
    const d = await q(`select code, uses_so_far, expected from referral_usage_drift()`)
    expect(d).toEqual([{ code: 'ANN10', uses_so_far: held + 4, expected: held }])
  })
})

describe('0100: channel tags and sessions', () => {
  const sub = (s) => db.query('select increment_referral_sub_clicks($1,$2)', ['ANN10', s])
  it('a full code evicts its quietest unattributed tag for a new one', async () => {
    for (let i = 0; i < 50; i++) await sub(`t${i}`)
    for (let i = 1; i < 50; i++) await sub(`t${i}`)       // t0 stays quietest
    await sub('real-channel')
    const tags = (await q(`select sub from referral_sub_clicks`)).map(r => r.sub)
    expect(tags).toHaveLength(50)
    expect(tags).toContain('real-channel')
    expect(tags).not.toContain('t0')
  })
  it('tags tied to a payment are never evicted', async () => {
    const { rows } = await db.query(`select sub from referral_sub_clicks`)
    for (const r of rows) {
      const [{ id: pay }] = await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_sub) values (1900, $1, '${U1}', '${C1}', $2) returning id`, ['att' + Math.random(), r.sub])
    }
    await sub('late-one')
    expect((await q(`select count(*)::int n from referral_sub_clicks`))[0].n).toBe(50)
    expect((await q(`select count(*)::int n from referral_sub_clicks where sub='late-one'`))[0].n).toBe(0)
  })
})

describe('0100: grant_upgrade_credit_once', () => {
  it('a missing user does not burn the once-only marker', async () => {
    const scan = '66666666-6666-6666-6666-666666666666'
    const before = (await q(`select count(*)::int n from system_state`))[0].n
    await db.query(`select grant_upgrade_credit_once($1, $2)`, [scan, '77777777-7777-7777-7777-777777777777'])
    expect((await q(`select count(*)::int n from system_state`))[0].n).toBe(before)
  })
})
