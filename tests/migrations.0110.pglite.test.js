import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0110 (webhooks round 27, G2) against a real Postgres: scans.fix_delivered_at is stamped by a trigger when status becomes FIX_DELIVERED.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0110_webhooks_round27.sql'
const U1 = '55555555-5555-5555-5555-555555555555'
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
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@x.co', 'h')`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0110: fix_delivered_at', () => {
  it('adds a nullable timestamptz column', async () => {
    const c = await q(`select data_type, is_nullable from information_schema.columns where table_name = 'scans' and column_name = 'fix_delivered_at'`)
    expect(c).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }])
  })
  it('stamps on the transition into FIX_DELIVERED, not on other updates, and re-stamps a later delivery', async () => {
    const [{ id }] = await q(`insert into scans (user_id) values ('${U1}') returning id`)
    expect((await q('select fix_delivered_at from scans where id = $1', [id]))[0].fix_delivered_at).toBeNull()
    await db.query(`update scans set status = 'FIX_DELIVERED' where id = $1`, [id])
    const first = (await q('select fix_delivered_at from scans where id = $1', [id]))[0].fix_delivered_at
    expect(first).not.toBeNull()
    await db.query(`update scans set status = 'FIX_DELIVERED', updated_at = now() where id = $1`, [id])   // same status: untouched
    expect((await q('select fix_delivered_at from scans where id = $1', [id]))[0].fix_delivered_at).toEqual(first)
    await db.query(`update scans set status = 'FIX_GENERATING' where id = $1`, [id])
    expect((await q('select fix_delivered_at from scans where id = $1', [id]))[0].fix_delivered_at).toEqual(first)   // kept while a retry round runs
    await db.query(`select pg_sleep(0.01)`)
    await db.query(`update scans set status = 'FIX_DELIVERED' where id = $1`, [id])
    const second = (await q('select fix_delivered_at from scans where id = $1', [id]))[0].fix_delivered_at
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime())
  })
  it('records itself in the ledger and re-runs cleanly', async () => {
    expect((await q('select count(*)::int as c from applied_migrations where version = 110'))[0].c).toBe(1)
    await db.exec(read(MIG))
    expect((await q('select count(*)::int as c from applied_migrations where version = 110'))[0].c).toBe(1)
    expect((await q(`select (value->>'version')::int as v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(110)
  })
})
