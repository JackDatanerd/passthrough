import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0101 (document look versioning) against a real Postgres (PGlite): every scan that existed keeps the original look
// (1), every scan created afterwards gets the signature presets (2), and a re-run changes nothing.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0101_doc_template_version.sql'
const U1 = '55555555-5555-5555-5555-555555555555'
const OLD = '66666666-6666-6666-6666-666666666601'
const NEW = '66666666-6666-6666-6666-666666666602'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const version = async id => (await q(`select doc_template_version v from scans where id = $1`, [id]))[0].v

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
  await db.exec(`insert into scans (id, user_id, status) values ('${OLD}', '${U1}', 'FIX_DELIVERED')`)   // delivered before the column existed
  await db.exec(read(MIG))                                  // 0101 only: later look migrations have their own test
  await db.exec(`insert into scans (id, user_id, status) values ('${NEW}', '${U1}', 'COMPLETE_PASS')`)   // created afterwards, no version named
}, 180000)
afterAll(async () => { await db?.close() })

describe('0101: document look versioning', () => {
  it('a scan that existed before keeps the original look, a scan created after gets the signature presets', async () => {
    expect(await version(OLD)).toBe(1)
    expect(await version(NEW)).toBe(2)
  })
  it('refuses a version the code does not know', async () => {
    for (const v of [0, 3, -1]) {
      await expect(db.query(`update scans set doc_template_version = $1 where id = $2`, [v, NEW])).rejects.toThrow()
    }
    await db.query(`update scans set doc_template_version = 1 where id = $1`, [NEW])
    expect(await version(NEW)).toBe(1)
    await db.query(`update scans set doc_template_version = 2 where id = $1`, [NEW])
  })
  it('is NOT NULL, so a missing value can never silently mean "latest"', async () => {
    await expect(db.query(`update scans set doc_template_version = null where id = $1`, [NEW])).rejects.toThrow()
  })
  it('a re-run changes nothing: no scan is re-versioned, the default stays 2', async () => {
    await db.exec(read(MIG))
    expect(await version(OLD)).toBe(1)
    expect(await version(NEW)).toBe(2)
    await db.exec(`insert into scans (id, user_id, status) values ('66666666-6666-6666-6666-666666666603', '${U1}', 'PENDING')`)
    expect(await version('66666666-6666-6666-6666-666666666603')).toBe(2)
  })
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 101`))[0].name).toBe('0101_doc_template_version')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(101)
  })
})
