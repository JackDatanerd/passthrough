import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0102 (document look 3) against a real Postgres (PGlite): every scan that existed keeps the original look
// (1), every scan created afterwards gets the signature presets (2), and a re-run changes nothing.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0102_doc_look_3.sql'
const U1 = '55555555-5555-5555-5555-555555555555'
const V1 = '66666666-6666-6666-6666-666666666611'   // delivered before look versioning
const V2 = '66666666-6666-6666-6666-666666666612'   // created between 0101 and 0102
const NEW = '66666666-6666-6666-6666-666666666613'

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
  for (const f of files.filter(f => f < '0101')) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@x.co', 'h')`)
  await db.exec(`insert into scans (id, user_id, status) values ('${V1}', '${U1}', 'FIX_DELIVERED')`)
  await db.exec(read('0101_doc_template_version.sql'))
  await db.exec(`insert into scans (id, user_id, status) values ('${V2}', '${U1}', 'FIX_DELIVERED')`)   // look 2 era
  await db.exec(read(MIG))
  await db.exec(`insert into scans (id, user_id, status) values ('${NEW}', '${U1}', 'COMPLETE_PASS')`)  // created afterwards
}, 180000)
afterAll(async () => { await db?.close() })

describe('0102: document look 3', () => {
  it('no delivered scan is re-versioned; a scan created afterwards gets look 3', async () => {
    expect(await version(V1)).toBe(1)
    expect(await version(V2)).toBe(2)
    expect(await version(NEW)).toBe(3)
  })
  it('allows 1..3 and refuses anything else', async () => {
    for (const v of [0, 4, -1]) await expect(db.query(`update scans set doc_template_version = $1 where id = $2`, [v, NEW])).rejects.toThrow()
    for (const v of [1, 2, 3]) { await db.query(`update scans set doc_template_version = $1 where id = $2`, [v, NEW]); expect(await version(NEW)).toBe(v) }
  })
  it('is still NOT NULL', async () => {
    await expect(db.query(`update scans set doc_template_version = null where id = $1`, [NEW])).rejects.toThrow()
  })
  it('a re-run changes nothing and the default stays 3', async () => {
    await db.exec(read(MIG))
    expect(await version(V1)).toBe(1)
    expect(await version(V2)).toBe(2)
    await db.exec(`insert into scans (id, user_id, status) values ('66666666-6666-6666-6666-666666666614', '${U1}', 'PENDING')`)
    expect(await version('66666666-6666-6666-6666-666666666614')).toBe(3)
  })
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 102`))[0].name).toBe('0102_doc_look_3')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(102)
  })
})
