import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0125 (partners round 44) against a real Postgres. Its test used to live in tests/migrations.0124.pglite.test.js, which the Experts
// Phase 1 commit overwrote (same file name); nothing covered the 0125 behaviour until audit A10. Also covers the ledger repair A10 added:
// the file recorded itself as version 124, so no database ever had a ledger row for 125.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0125'))
const P1 = '22222222-2222-2222-2222-222222222222'
const C1 = '44444444-4444-4444-4444-444444444444'
const U1 = '55555555-5555-5555-5555-555555555555'
let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const sub = s => db.query('select increment_referral_sub_clicks($1, $2)', ['ANN10', s])
const tags = async () => (await q(`select sub from referral_sub_clicks order by sub`)).map(r => r.sub)
const reset = () => q(`delete from referral_sub_clicks`)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','d1')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{"FIX":1900}'::jsonb)`)
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@x.co', 'h')`)
}, 180000)
afterAll(async () => { await db?.close() })

describe('0125: channel-tag eviction guard', () => {
  it('a new tag creates created_at, and a full code of FRESH tags does not take a newcomer', async () => {
    for (let i = 0; i < 50; i++) await sub(`t${i}`)
    expect((await q(`select count(*)::int n from referral_sub_clicks where created_at is null`))[0].n).toBe(0)
    await sub('newcomer')
    expect(await tags()).toHaveLength(50)
    expect(await tags()).not.toContain('newcomer')
  })
  it('only a tag older than 7 days can be displaced, the quietest first (ties by name)', async () => {
    for (let i = 1; i < 50; i++) await sub(`t${i}`)           // t0 is the quietest
    await q(`update referral_sub_clicks set created_at = now() - interval '6 days'`)
    await sub('newcomer')
    expect(await tags()).not.toContain('newcomer')              // 6 days: still protected
    await q(`update referral_sub_clicks set created_at = now() - interval '8 days'`)
    await sub('newcomer')
    const t = await tags()
    expect(t).toHaveLength(50); expect(t).toContain('newcomer'); expect(t).not.toContain('t0')
  })
  it('an old tag tied to a payment or to a referred user is never displaced', async () => {
    await reset()
    for (let i = 0; i < 50; i++) await sub(`p${i}`)
    await q(`update referral_sub_clicks set created_at = now() - interval '30 days'`)
    for (let i = 0; i < 49; i++) await q(`insert into payments (amount_cents, paystack_ref, user_id, referral_code_id, referral_sub) values (1900, $1, '${U1}', '${C1}', $2)`, [`pay${i}`, `p${i}`])
    await q(`update users set referred_by_code = 'ANN10', referred_sub = 'p49' where id = '${U1}'`)
    await sub('late')
    expect(await tags()).not.toContain('late')                  // every old tag is attributed: nothing can be evicted
    await q(`update users set referred_sub = null where id = '${U1}'`)
    await sub('late')
    expect(await tags()).toContain('late'); expect(await tags()).not.toContain('p49')
  })
  it('a stored tag keeps counting, and a malformed tag or an unknown code changes nothing', async () => {
    const before = (await q(`select count(*)::int n from referral_sub_clicks`))[0].n
    await sub('late'); await sub('late')
    expect((await q(`select clicks from referral_sub_clicks where sub = 'late'`))[0].clicks).toBe(3)
    await sub('Bad Tag!'); await db.query('select increment_referral_sub_clicks($1, $2)', ['NOPE', 'x'])
    expect((await q(`select count(*)::int n from referral_sub_clicks`))[0].n).toBe(before)
  })
  it('stays closed to anon and authenticated, open to service_role', async () => {
    const [g] = await q(`select has_function_privilege('anon', 'increment_referral_sub_clicks(text,text)', 'execute') a, has_function_privilege('authenticated', 'increment_referral_sub_clicks(text,text)', 'execute') b, has_function_privilege('service_role', 'increment_referral_sub_clicks(text,text)', 'execute') c`)
    expect(g).toEqual({ a: false, b: false, c: true })
  })
})

describe('0125: the ledger records 125 (it used to record itself as 124)', () => {
  it('has its own row, and 124 still belongs to the Experts migration', async () => {
    const m = new Map((await q(`select version, name from applied_migrations where version in (124, 125)`)).map(r => [r.version, r.name]))
    expect(m.get(125)).toBe('0125_partners_section4_round44')
    expect(m.get(124)).toBe('0124_experts_phase1_pilot')
  })
  it('re-running the file is idempotent', async () => {
    await db.exec(read(MIG)); await db.exec(read(MIG))
    expect((await q(`select count(*)::int n from applied_migrations where version = 125`))[0].n).toBe(1)
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(Number(files[files.length - 1].slice(0, 4)))
  })
  it('repairs a database that ran this file under its old number before the Experts migration (row 124 holds the wrong name)', async () => {
    await q(`update applied_migrations set name = '0124_partners_section4_round44' where version = 124`)
    await q(`delete from applied_migrations where version = 125`)
    await db.exec(read(MIG))
    const m = new Map((await q(`select version, name from applied_migrations where version in (124, 125)`)).map(r => [r.version, r.name]))
    expect(m.get(124)).toBe('0124_experts_phase1_pilot')
    expect(m.get(125)).toBe('0125_partners_section4_round44')
  })
  it('leaves row 124 alone when the Experts tables do not exist (it then really is the partners file)', async () => {
    const db2 = new PGlite()
    await db2.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to anon, authenticated, service_role;`)
    for (const f of files.filter(f => f < files.find(x => x.startsWith('0124')))) await db2.exec(read(f))
    await db2.exec(`insert into applied_migrations (version, name) values (124, '0124_partners_section4_round44')`)
    await db2.exec(read(MIG))
    const rows = (await db2.query(`select version, name from applied_migrations where version in (124, 125) order by 1`)).rows
    expect(rows).toEqual([{ version: 124, name: '0124_partners_section4_round44' }, { version: 125, name: '0125_partners_section4_round44' }])
    await db2.close()
  })
})
