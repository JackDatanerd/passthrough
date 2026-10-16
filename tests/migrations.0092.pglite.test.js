import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0092 against a real Postgres (PGlite): a failed Badge -> Fix upgrade is compensated even though the Badge
// delivery already used round 0 of grant_fix_credit_once.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const U = '11111111-1111-1111-1111-111111111111'
const S = '22222222-2222-2222-2222-222222222222'
let db
const q = async (sql) => (await db.query(sql)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;`)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into users (id,email,password_hash,name) values ('${U}','a@b.com','h','A')`)
  await db.exec(`insert into scans (id, user_id, status) values ('${S}', '${U}', 'FIX_DELIVERED')`)
}, 180000)
afterAll(async () => { await db?.close() })

describe('grant_upgrade_credit_once', () => {
  it('pays once even though the Badge delivery already took the round-0 compensation', async () => {
    expect((await q(`select grant_fix_credit_once('${S}','${U}',0) as ok`))[0].ok).toBe(true)      // the Badge below the bar
    expect((await q(`select grant_fix_credit_once('${S}','${U}',0) as ok`))[0].ok).toBe(false)     // the bug: the upgrade's own round 0
    expect((await q(`select grant_upgrade_credit_once('${S}','${U}') as ok`))[0].ok).toBe(true)    // the fix
    expect((await q(`select grant_upgrade_credit_once('${S}','${U}') as ok`))[0].ok).toBe(false)   // a re-run of a crashed job
    expect(Number((await q(`select free_fix_credits as n from users where id='${U}'`))[0].n)).toBe(2)
  })
  it('later retry rounds are unaffected (the per-round marker is not consumed by the upgrade)', async () => {
    expect((await q(`select grant_fix_credit_once('${S}','${U}',1) as ok`))[0].ok).toBe(true)
  })
  it('is not callable by clients', async () => {
    await db.exec(`set role authenticated`)
    await expect(db.query(`select grant_upgrade_credit_once('${S}','${U}')`)).rejects.toThrow()
    await db.exec(`reset role`)
  })
})
