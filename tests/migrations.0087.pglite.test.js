import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// Migration 0087 (database layer round 3), exercised against a real Postgres (PGlite): the behaviour of the payout RPCs, the
// profile-RPC guards, the append-only audit log, the referral-code check, scan-delete pointer clearing, the payout-token backfill, and
// the monotonic schema_version that makes re-running an older migration harmless.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const sha = s => createHash('sha256').update(s).digest('hex')

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const U1 = '11111111-1111-1111-1111-111111111111'
const P1 = '22222222-2222-2222-2222-222222222222'
const P2 = '22222222-2222-2222-2222-222222222223'
const S1 = '33333333-3333-3333-3333-333333333333'
const version = async () => (await q(`select (value->>'version')::int v from system_state where key='schema_version'`))[0].v

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  // everything BEFORE 0087 first, so the token backfill has legacy rows to convert
  for (const f of files.filter(f => f < '0087')) await db.exec(read(f))
  await db.exec(`insert into users (id,email,password_hash,name) values ('${U1}','a@b.com','h','A')`)
  await db.exec(`insert into partners (id,name,email,payout_details_token,dashboard_token) values ('${P1}','P','p@x.co','legacy-raw-token','dash1')`)
  await db.exec(`insert into partners (id,name,email,payout_details_token,dashboard_token) values ('${P2}','Q','q@x.co','other-token','dash2')`)
  const f87 = files.find(f => f.startsWith('0087'))
  await db.exec(read(f87))
  // anything newer than 0087 on top, so "the newest migration" below is really the newest
  for (const f of files.filter(f => f > '0087')) await db.exec(read(f))
}, 180000)
afterAll(async () => { await db?.close() })

describe('hashed payout tokens (partners.payout_token_hash)', () => {
  it('backfills the sha256 of every legacy raw token and clears the raw column', async () => {
    const r = await q(`select payout_details_token t, payout_token_hash h from partners where id=$1`, [P1])
    expect(r[0].h).toBe(sha('legacy-raw-token'))
    expect(r[0].t).toBeNull()
  })
  it('the hash is unique, and new partners may be created with only a hash', async () => {
    await expect(db.exec(`update partners set payout_token_hash='${sha('other-token')}' where id='${P1}'`)).rejects.toThrow()
    await db.exec(`insert into partners (name,email,payout_token_hash,dashboard_token) values ('N','n@x.co','${sha('n')}','dn')`)
  })
})

describe('record_payout_settlement', () => {
  const ins = async (id, partner, cents, payout = null) =>
    db.exec(`insert into commission_ledger (id, partner_id, kind, adjustment_reason, commission_amount_cents, gross_amount_cents, commission_rate, payout_id)
             values ('${id}', '${partner}', 'ADJUSTMENT', 'test', ${cents}, 0, 0, ${payout ? `'${payout}'` : 'null'})`)
  const L = n => `44444444-4444-4444-4444-44444444444${n}`
  const payout = (amount, settled) => JSON.stringify({ amount_cents: amount, currency: 'USD', payout_method: 'BANK', settled_commission_cents: settled })
  const call = async (partner, ids, p, discard = false, auto = false) =>
    (await q(`select record_payout_settlement($1, $2::uuid[], $3::jsonb, $4, $5) r`, [partner, ids, p, discard, auto]))[0].r

  it('claims exactly the rows still unpaid for THIS partner and settles the payout in one transaction', async () => {
    await ins(L(1), P1, 500); await ins(L(2), P1, 700)
    const r = await call(P1, [L(1), L(2)], payout(1200, 1200))
    expect(r).toMatchObject({ requested: 2, claimed: 2, claimed_cents: 1200, discarded: false })
    expect((await q(`select count(*)::int c from commission_ledger where payout_id=$1`, [r.payout.id]))[0].c).toBe(2)
  })
  it('never claims another partner\'s rows, even if their ids are passed', async () => {
    await ins(L(3), P2, 900)
    const r = await call(P1, [L(3)], payout(900, 900), false, false)
    expect(r.claimed).toBe(0)
    expect((await q(`select payout_id from commission_ledger where id=$1`, [L(3)]))[0].payout_id).toBeNull()
  })
  it('a short claim with an auto amount corrects both figures down to what was claimed', async () => {
    await ins(L(4), P1, 300); await ins(L(5), P1, 400, null)
    const taken = (await call(P1, [L(5)], payout(400, 400))).payout.id        // a concurrent payout takes L5 first
    const r = await call(P1, [L(4), L(5)], payout(700, 700), false, true)
    expect(r).toMatchObject({ requested: 2, claimed: 1, claimed_cents: 300, discarded: false })
    expect(r.payout).toMatchObject({ amount_cents: 300, settled_commission_cents: 300 })
    expect((await q(`select payout_id from commission_ledger where id=$1`, [L(5)]))[0].payout_id).toBe(taken)
  })
  it('a short claim with an explicit amount keeps the typed amount and records only the real settled figure', async () => {
    await ins(L(6), P1, 100); await ins(L(7), P1, 100)
    await call(P1, [L(7)], payout(100, 100))
    const r = await call(P1, [L(6), L(7)], payout(5000, 200), false, false)
    expect(r.payout).toMatchObject({ amount_cents: 5000, settled_commission_cents: 100 })
  })
  it('loses the race for EVERY row on an auto payout: the payout row is removed, nothing is left behind', async () => {
    await ins(L(8), P1, 100)
    await call(P1, [L(8)], payout(100, 100))
    const before = (await q(`select count(*)::int c from payouts`))[0].c
    const r = await call(P1, [L(8)], payout(100, 100), true, true)
    expect(r.discarded).toBe(true)
    expect((await q(`select count(*)::int c from payouts`))[0].c).toBe(before)
  })
})

describe('void_payout', () => {
  it('voids the payout and releases its rows atomically; a repeat call is idempotent; unknown payout returns null', async () => {
    const id = '55555555-5555-5555-5555-555555555551'
    await db.exec(`insert into payouts (id, partner_id, amount_cents, currency, payout_method, payout_details_snapshot, settled_commission_cents) values ('${id}','${P2}',900,'USD','BANK','{}'::jsonb,900)`)
    await db.exec(`update commission_ledger set payout_id='${id}' where id='44444444-4444-4444-4444-444444444443'`)
    const first = (await q(`select void_payout($1,$2,$3) r`, [id, P2, 'wrong cycle']))[0].r
    expect(first).toMatchObject({ already_voided: false, released: 1 })
    expect((await q(`select payout_id from commission_ledger where id='44444444-4444-4444-4444-444444444443'`))[0].payout_id).toBeNull()
    const again = (await q(`select void_payout($1,$2,$3) r`, [id, P2, 'again']))[0].r
    expect(again.already_voided).toBe(true)
    expect((await q(`select void_reason from payouts where id=$1`, [id]))[0].void_reason).toBe('wrong cycle')
    expect((await q(`select void_payout($1,$2,$3) r`, ['55555555-5555-5555-5555-5555555555ff', P2, 'x']))[0].r).toBeNull()
    expect((await q(`select void_payout($1,$2,$3) r`, [id, P1, 'x']))[0].r).toBeNull()   // someone else's payout
  })
  it('both payout functions are callable only by service_role', async () => {
    const r = await q(`select p.proname, has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') b, has_function_privilege('service_role', p.oid,'execute') s
                       from pg_proc p where p.proname in ('record_payout_settlement','void_payout')`)
    expect(r).toHaveLength(2)
    for (const x of r) expect(x).toMatchObject({ a: false, b: false, s: true })
  })
})

describe('saved-profile RPC guards (a NULL argument can no longer wipe a profile)', () => {
  const profile = `'{"resumeData":{"name":"x"},"savedAt":"2026-01-01T00:00:00Z"}'::jsonb`
  it('set_saved_profile_resume refuses NULL / non-object resume or NULL edited_at and leaves the profile alone', async () => {
    await db.exec(`update users set saved_profile = ${profile} where id='${U1}'`)
    await expect(q(`select set_saved_profile_resume($1, null::jsonb, now(), null)`, [U1])).rejects.toThrow()
    await expect(q(`select set_saved_profile_resume($1, '{"name":"y"}'::jsonb, null, null)`, [U1])).rejects.toThrow()
    await expect(q(`select set_saved_profile_resume($1, '[1]'::jsonb, now(), null)`, [U1])).rejects.toThrow()
    expect((await q(`select saved_profile->'resumeData'->>'name' n from users where id=$1`, [U1]))[0].n).toBe('x')
  })
  it('save_profile_from_scan refuses a NULL or non-object profile', async () => {
    await expect(q(`select save_profile_from_scan($1, null::jsonb, null, null, null)`, [U1])).rejects.toThrow()
  })
})

describe('admin_audit_log is append-only', () => {
  it('allows inserts, refuses UPDATE and DELETE', async () => {
    await db.exec(`insert into admin_audit_log (id, action, target_type) values ('66666666-6666-6666-6666-666666666661','t','x')`)
    await expect(db.exec(`update admin_audit_log set action='x'`)).rejects.toThrow()
    await expect(db.exec(`delete from admin_audit_log`)).rejects.toThrow()
  })
  it('still lets the actor FK null itself when an admin user is deleted', async () => {
    await db.exec(`insert into users (id,email,password_hash,name) values ('77777777-7777-7777-7777-777777777771','adm@x.co','h','Adm')`)
    await db.exec(`insert into admin_audit_log (id, action, target_type, actor_id) values ('66666666-6666-6666-6666-666666666662','t','x','77777777-7777-7777-7777-777777777771')`)
    await db.exec(`delete from users where id='77777777-7777-7777-7777-777777777771'`)
    expect((await q(`select actor_id from admin_audit_log where id='66666666-6666-6666-6666-666666666662'`))[0].actor_id).toBeNull()
  })
})

describe('referral codes are stored upper-case', () => {
  it('refuses a lower-case code', async () => {
    await expect(db.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','lower','{"FIX":1900}'::jsonb)`)).rejects.toThrow()
    await db.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','UPPER','{"FIX":1900}'::jsonb)`)
  })
})

describe('deleting a scan clears the profile pointers to it', () => {
  it('nulls saved_profiles.source_scan_id (FK) and sourceScanId inside users.saved_profile / saved_profile_prev', async () => {
    await db.exec(`insert into scans (id,user_id,status) values ('${S1}','${U1}','PENDING')`)
    await db.exec(`insert into saved_profiles (user_id, label, resume_data, source_scan_id) values ('${U1}','L','{}'::jsonb,'${S1}')`)
    await db.exec(`update users set saved_profile = '{"resumeData":{},"sourceScanId":"${S1}"}'::jsonb, saved_profile_prev = '{"resumeData":{},"sourceScanId":"${S1}"}'::jsonb where id='${U1}'`)
    await db.exec(`delete from scans where id='${S1}'`)
    expect((await q(`select source_scan_id from saved_profiles where user_id=$1`, [U1]))[0].source_scan_id).toBeNull()
    const u = (await q(`select saved_profile sp, saved_profile_prev pv from users where id=$1`, [U1]))[0]
    expect(u.sp.sourceScanId ?? null).toBeNull(); expect(u.pv.sourceScanId ?? null).toBeNull()
    expect(u.sp.resumeData).toBeTruthy()
  })
})

describe('schema_version only ever moves forward', () => {
  it('is the newest migration after the full chain', async () => { expect(await version()).toBe(Number(files.at(-1).slice(0, 4))) })
  // Only 0082 and later promise to be re-runnable (see DEPLOYMENT.md). Runs LAST: re-applying an old file also re-creates the
  // function bodies it defines, which would undo newer redefinitions for every test that follows.
  it('re-running an OLDER migration that stamps a version does not move it backwards', async () => {
    const before = await version()
    for (const f of files.filter(f => /^008[2-6]_/.test(f))) await db.exec(read(f))
    expect(await version()).toBe(before)
  })
})

