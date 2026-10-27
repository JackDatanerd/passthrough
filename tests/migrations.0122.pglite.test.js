import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0122 (the outcome clock starts at the first REAL delivery) against a real Postgres (PGlite): a failed rewrite does not start
// it, a Badge -> Fix upgrade restarts it, a rolled-back upgrade restores it, and edits / retries never move it.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0122'))
const U1 = '00000000-0000-4000-8000-000000000001'
const S_GOOD = '00000000-0000-4000-8000-0000000000a1'
const S_FAILED = '00000000-0000-4000-8000-0000000000a2'

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
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h')`)
  // before 0122: one scan delivered fine, one whose rewrite FAILED (0120's trigger stamped both)
  await db.exec(`insert into scans (id, user_id, status, fix_purchased, fix_generated_at) values ('${S_GOOD}', '${U1}', 'FIX_DELIVERED', true, '2026-08-20T00:00:00Z')`)
  await db.exec(`insert into scans (id, user_id, status, fix_purchased, fix_generated_at, rewrite_failed) values ('${S_FAILED}', '${U1}', 'FIX_DELIVERED', true, '2026-08-21T00:00:00Z', true)`)
  await db.exec(read(MIG))
}, 180000)

describe('migration 0122', () => {
  const at = async id => { const r = (await q(`select first_delivered_at f from scans where id = $1`, [id]))[0].f; return r ? new Date(r).toISOString() : null }
  const mk = async (id, cols = '', vals = '') => db.exec(`insert into scans (id, user_id, status, fix_purchased${cols ? ', ' + cols : ''}) values ('${id}', '${U1}', 'FIX_PURCHASED', true${vals ? ', ' + vals : ''})`)
  const ID = n => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

  it('records itself in the ledger and moves schema_version to 122', async () => {
    expect((await q(`select name from applied_migrations where version = 122`))[0].name).toBe('0122_outcome_clock_real_delivery')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(122)
  })
  it('backfill: a scan whose delivery was a failed rewrite has no real delivery yet; a good one keeps its stamp', async () => {
    expect(await at(S_FAILED)).toBeNull()
    expect(await at(S_GOOD)).toBe('2026-08-20T00:00:00.000Z')
  })
  it('a delivery whose rewrite failed does not start the clock; the successful retry does, and later edits never move it', async () => {
    await mk(ID(1))
    await db.exec(`update scans set fix_generated_at = '2026-09-01T00:00:00Z', rewrite_failed = true where id = '${ID(1)}'`)
    expect(await at(ID(1))).toBeNull()
    await db.exec(`update scans set fix_generated_at = '2026-09-13T00:00:00Z', rewrite_failed = false where id = '${ID(1)}'`)
    expect(await at(ID(1))).toBe('2026-09-13T00:00:00.000Z')
    await db.exec(`update scans set fix_generated_at = '2026-10-02T00:00:00Z' where id = '${ID(1)}'`)
    expect(await at(ID(1))).toBe('2026-09-13T00:00:00.000Z')
  })
  it('an update that only names the column again does not stamp', async () => {
    await mk(ID(2), 'fix_generated_at, rewrite_failed', "'2026-09-05T00:00:00Z', true")
    expect(await at(ID(2))).toBeNull()
    await db.exec(`update scans set rewrite_failed = false, fix_generated_at = fix_generated_at where id = '${ID(2)}'`)
    expect(await at(ID(2))).toBeNull()      // fix_generated_at did not change: nothing was delivered
  })
  it('a Badge to Fix upgrade clears the stamp; the upgraded delivery stamps it again', async () => {
    await mk(ID(3), 'fix_tier, fix_generated_at', "'BADGE', '2026-08-01T00:00:00Z'")
    expect(await at(ID(3))).toBe('2026-08-01T00:00:00.000Z')
    await db.exec(`update scans set fix_tier = 'FIX', status = 'FIX_PURCHASED' where id = '${ID(3)}'`)
    expect(await at(ID(3))).toBeNull()
    await db.exec(`update scans set fix_tier = 'FIX' where id = '${ID(3)}'`)      // naming the tier again must not bring the badge date back
    expect(await at(ID(3))).toBeNull()
    await db.exec(`update scans set fix_generated_at = '2026-08-25T00:00:00Z' where id = '${ID(3)}'`)
    expect(await at(ID(3))).toBe('2026-08-25T00:00:00.000Z')
  })
  it('an upgrade that is rolled back to Badge restores the badge delivery date', async () => {
    await mk(ID(4), 'fix_tier, fix_generated_at', "'BADGE', '2026-08-02T00:00:00Z'")
    await db.exec(`update scans set fix_tier = 'FIX' where id = '${ID(4)}'`)
    expect(await at(ID(4))).toBeNull()
    await db.exec(`update scans set fix_tier = 'BADGE' where id = '${ID(4)}'`)
    expect(await at(ID(4))).toBe('2026-08-02T00:00:00.000Z')
  })
  it('a scan inserted already delivered is stamped; one inserted with a failed rewrite is not', async () => {
    await mk(ID(5), 'fix_generated_at', "'2026-07-01T00:00:00Z'")
    await mk(ID(6), 'fix_generated_at, rewrite_failed', "'2026-07-01T00:00:00Z', true")
    expect(await at(ID(5))).toBe('2026-07-01T00:00:00.000Z')
    expect(await at(ID(6))).toBeNull()
  })
  it('the stamp function is not callable by anon / authenticated', async () => {
    const r = await q(`select has_function_privilege('anon', 'stamp_first_delivered_at()', 'execute') a, has_function_privilege('authenticated', 'stamp_first_delivered_at()', 'execute') b`)
    expect(r[0]).toEqual({ a: false, b: false })
  })
})
