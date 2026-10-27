import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0120 (outcome question measured from the FIRST delivery) against a real Postgres (PGlite): the backfill, the trigger that
// stamps scans.first_delivered_at once, and that a retry / edit (which rewrite fix_generated_at) never moves it.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0120'))
const U1 = '00000000-0000-4000-8000-000000000001'
const S_OLD = '00000000-0000-4000-8000-0000000000a1'
const S_NEW = '00000000-0000-4000-8000-0000000000a2'

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
  // a scan delivered (and since retried) BEFORE the migration
  await db.exec(`insert into scans (id, user_id, status, fix_purchased, fix_generated_at) values ('${S_OLD}', '${U1}', 'FIX_DELIVERED', true, '2026-08-20T00:00:00Z')`)
  await db.exec(read(MIG))
}, 180000)

describe('migration 0120', () => {
  it('records itself in the ledger and moves schema_version to 120', async () => {
    expect((await q(`select name from applied_migrations where version = 120`))[0].name).toBe('0120_outcome_ask_first_delivery')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(120)
  })
  it('backfills first_delivered_at from fix_generated_at for scans already delivered', async () => {
    const r = (await q(`select first_delivered_at from scans where id = $1`, [S_OLD]))[0]
    expect(new Date(r.first_delivered_at).toISOString()).toBe('2026-08-20T00:00:00.000Z')
  })
  it('stamps first_delivered_at the first time a scan is delivered, and never moves it again (retry, edit, regeneration)', async () => {
    await db.exec(`insert into scans (id, user_id, status, fix_purchased) values ('${S_NEW}', '${U1}', 'FIX_PURCHASED', true)`)
    expect((await q(`select first_delivered_at from scans where id = $1`, [S_NEW]))[0].first_delivered_at).toBeNull()
    await db.exec(`update scans set fix_generated_at = '2026-09-01T00:00:00Z' where id = '${S_NEW}'`)
    await db.exec(`update scans set fix_generated_at = '2026-09-20T00:00:00Z' where id = '${S_NEW}'`)   // a retry / an owner edit
    const r = (await q(`select first_delivered_at, fix_generated_at from scans where id = $1`, [S_NEW]))[0]
    expect(new Date(r.first_delivered_at).toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(new Date(r.fix_generated_at).toISOString()).toBe('2026-09-20T00:00:00.000Z')
  })
  it('stamps a scan inserted already delivered', async () => {
    const id = '00000000-0000-4000-8000-0000000000a3'
    await db.exec(`insert into scans (id, user_id, status, fix_purchased, fix_generated_at) values ('${id}', '${U1}', 'FIX_DELIVERED', true, '2026-07-01T00:00:00Z')`)
    expect(new Date((await q(`select first_delivered_at from scans where id = $1`, [id]))[0].first_delivered_at).toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })
  it('the stamp function is not callable by anon / authenticated', async () => {
    const r = await q(`select has_function_privilege('anon', 'stamp_first_delivered_at()', 'execute') a, has_function_privilege('authenticated', 'stamp_first_delivered_at()', 'execute') b`)
    expect(r[0]).toEqual({ a: false, b: false })
  })
  it('moves the sweep index to the new column', async () => {
    const r = await q(`select indexdef from pg_indexes where indexname = 'scans_outcome_prompt_idx'`)
    expect(r[0].indexdef).toContain('first_delivered_at')
  })
})
