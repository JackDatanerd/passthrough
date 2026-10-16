import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0091 (database layer round 4), exercised against a real Postgres (PGlite): the non-negative counters, the tier_prices shape,
// the tighter append-only audit log, the clear-text payout-token ban and the dropped dead objects.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '11111111-1111-1111-1111-111111111112'
const P1 = '22222222-2222-2222-2222-222222222222'
const BAD = '66666666-6666-6666-6666-666666666666'

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  // everything before 0091 first, with a deliberately bad row in place, so the clamp / validation path runs for real
  for (const f of files.filter(f => f < '0091')) await db.exec(read(f))
  await db.exec(`insert into users (id,email,password_hash,name,free_fix_credits) values ('${U1}','a@b.com','h','A',-3)`)
  await db.exec(`insert into users (id,email,password_hash,name) values ('${U2}','c@d.com','h','C')`)
  await db.exec(`insert into partners (id,name,email,payout_details_token,dashboard_token) values ('${P1}','P','p@x.co','legacy-raw','dash1')`)
  await db.exec(`insert into referral_codes (partner_id, code, tier_prices, uses_so_far, clicks, usage_limit) values ('${P1}','NEG','{"FIX":1900}'::jsonb,-2,-5,-1)`)
  for (const f of files.filter(f => f >= '0091')) await db.exec(read(f))
}, 180000)
afterAll(async () => { await db?.close() })

const rejects = (sql) => expect(db.exec(sql)).rejects.toThrow()

describe('non-negative counters', () => {
  it('clamped the pre-existing negative values to 0', async () => {
    expect((await q(`select free_fix_credits c from users where id=$1`, [U1]))[0].c).toBe(0)
    expect(await q(`select uses_so_far u, clicks c, usage_limit l from referral_codes where code='NEG'`)).toEqual([{ u: 0, c: 0, l: 0 }])
  })
  it('refuses a negative credit, retry count, code counter or submission count', async () => {
    await rejects(`update users set free_fix_credits = -1 where id='${U2}'`)
    await rejects(`update referral_codes set uses_so_far = -1 where code='NEG'`)
    await rejects(`update referral_codes set clicks = -1 where code='NEG'`)
    await rejects(`update referral_codes set usage_limit = -1 where code='NEG'`)
  })
  it('still lets a normal decrement-to-zero and a NULL usage_limit through', async () => {
    await db.exec(`update users set free_fix_credits = 1 where id='${U2}'`)
    await db.exec(`update users set free_fix_credits = free_fix_credits - 1 where id='${U2}' and free_fix_credits > 0`)
    await db.exec(`update referral_codes set usage_limit = null where code='NEG'`)
  })
  it('does NOT forbid negative ledger gross (a reversal stores the sale negated)', async () => {
    await db.exec(`insert into commission_ledger (partner_id, kind, adjustment_reason, commission_amount_cents, gross_amount_cents, commission_rate)
                   values ('${P1}','ADJUSTMENT','t',-100,-1000,0)`)
  })
})

describe('referral_codes.tier_prices shape', () => {
  const ins = (code, json) => db.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','${code}','${json}'::jsonb)`)
  it('accepts any non-empty subset of the three tiers with positive whole prices', async () => {
    await ins('OK1', '{"FIX":1900}'); await ins('OK2', '{"FIX":1900,"BADGE":900,"FIX_PLAIN":1500}')
  })
  it.each([
    ['negative', '{"FIX":-5}'], ['zero', '{"FIX":0}'], ['text', '{"FIX":"19"}'], ['fraction', '{"FIX":19.5}'],
    ['unknown tier', '{"STANDARD":1900}'], ['empty', '{}'], ['array', '[1900]'], ['null price', '{"FIX":null}']
  ])('refuses %s', async (_n, json) => { await rejects(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','BAD','${json}'::jsonb)`) })
})

describe('admin_audit_log is closer to append-only', () => {
  it('refuses nulling actor_id while the actor still exists, and any other update, delete or truncate', async () => {
    await db.exec(`insert into admin_audit_log (actor_id, action, target_type, target_id, detail) values ('${U2}','x.test','t','1','{}')`)
    await rejects(`update admin_audit_log set actor_id = null where action='x.test'`)
    await rejects(`update admin_audit_log set action = 'y' where action='x.test'`)
    await rejects(`delete from admin_audit_log where action='x.test'`)
    await rejects(`truncate admin_audit_log`)
    expect((await q(`select actor_id from admin_audit_log where action='x.test'`))[0].actor_id).toBe(U2)
  })
  it('still lets the foreign key null actor_id when the actor account is deleted', async () => {
    await db.exec(`delete from users where id='${U2}'`)
    const r = await q(`select actor_id from admin_audit_log where action='x.test'`)
    expect(r).toEqual([{ actor_id: null }])
  })
})

describe('tier_prices on a database that already holds a bad row', () => {
  it('adds the constraint NOT VALID instead of aborting, and still checks new writes', async () => {
    const d = new PGlite()
    await d.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;`)
    for (const f of files.filter(f => f < '0091')) await d.exec(read(f))
    await d.exec(`insert into partners (id,name,email,dashboard_token,payout_token_hash) values ('${P1}','P','p@x.co','d','h')`)
    await d.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','OLD','{}'::jsonb)`)
    await d.exec(read(files.find(f => f.startsWith('0091'))))
    const r = (await d.query(`select convalidated v from pg_constraint where conname='referral_codes_tier_prices_chk'`)).rows
    expect(r).toEqual([{ v: false }])
    await expect(d.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','NEW','{"FIX":-1}'::jsonb)`)).rejects.toThrow()
    await d.close()
  }, 120000)
})

describe('clear-text payout token', () => {
  it('the legacy raw token is gone and cannot be written again', async () => {
    expect((await q(`select payout_details_token t from partners where id=$1`, [P1]))[0].t).toBeNull()
    await rejects(`update partners set payout_details_token = 'raw' where id='${P1}'`)
    await db.exec(`update partners set payout_details_token = null where id='${P1}'`)
  })
})

describe('dead objects and ledger', () => {
  it('are gone', async () => {
    expect(await q(`select 1 from pg_proc where proname='decrement_referral_code_usage'`)).toEqual([])
    expect(await q(`select 1 from pg_class where relname in ('idx_scans_user_id','payment_refunds_payment_idx')`)).toEqual([])
  })
  it('the covering indexes remain', async () => {
    expect((await q(`select count(*)::int c from pg_class where relname='idx_scans_user_display_score'`))[0].c).toBe(1)
  })
  it('records itself in the ledger and moves schema_version to 91', async () => {
    expect((await q(`select name from applied_migrations where version=91`))[0].name).toBe('0091_database_round4')
    expect((await q(`select (value->>'version')::int v from system_state where key='schema_version'`))[0].v).toBeGreaterThanOrEqual(91)
  })
  it('the new helper function is not callable by anon / authenticated', async () => {
    const r = await q(`select has_function_privilege('anon','referral_tier_prices_valid(jsonb)','execute') a, has_function_privilege('authenticated','referral_tier_prices_valid(jsonb)','execute') b, has_function_privilege('service_role','referral_tier_prices_valid(jsonb)','execute') s`)
    expect(r[0]).toEqual({ a: false, b: false, s: true })
  })
})
