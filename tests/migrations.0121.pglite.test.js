import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0121 (one compensating credit per purchase, taken back when the resume reaches the line) against a real Postgres (PGlite).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0121'))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const U1 = id(1), U2 = id(2), S_OLD = id(31), S_OLD_OK = id(32), S1 = id(33), S2 = id(34), S3 = id(35)

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const credits = async u => (await q(`select free_fix_credits n from users where id = $1`, [u]))[0].n

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`
    insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h'), ('${U2}', 'V', 'v@example.com', 'h');
    insert into scans (id, user_id, status, fix_purchased, fix_ats_score, fix_credit_round) values
      ('${S_OLD}',    '${U1}', 'FIX_DELIVERED', true, 62, 2),
      ('${S_OLD_OK}', '${U1}', 'FIX_DELIVERED', true, 88, 0);
    insert into scans (id, user_id) values ('${S1}', '${U1}'), ('${S2}', '${U1}'), ('${S3}', '${U2}');`)
  await db.exec(read(MIG))
}, 180000)

describe('migration 0121', () => {
  it('records itself in the ledger and moves schema_version to 121', async () => {
    expect((await q(`select name from applied_migrations where version = 121`))[0].name).toBe('0121_credit_one_per_purchase')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(121)
  })
  it('backfills: a scan that already granted counts as granted, and holds its credit only while the delivered score is under 80', async () => {
    const a = (await q(`select fix_credit_granted g, fix_credit_held h from scans where id = $1`, [S_OLD]))[0]
    const b = (await q(`select fix_credit_granted g, fix_credit_held h from scans where id = $1`, [S_OLD_OK]))[0]
    expect(a).toEqual({ g: true, h: true })
    expect(b).toEqual({ g: true, h: false })
  })
  it('one failed purchase returns ONE credit: a later round never grants a second', async () => {
    expect((await q(`select grant_fix_credit_once($1, $2, 0) g`, [S1, U1]))[0].g).toBe(true)
    expect((await q(`select grant_fix_credit_once($1, $2, 2) g`, [S1, U1]))[0].g).toBe(false)   // retries exhausted after a round-0 grant
    expect((await q(`select grant_fix_credit_once($1, $2, 0) g`, [S1, U1]))[0].g).toBe(false)
    expect(await credits(U1)).toBe(1)
  })
  it('the credit is taken back once, when the resume reaches the line, and never below zero', async () => {
    expect((await q(`select revoke_compensation_credit($1, $2) r`, [S1, U1]))[0].r).toBe(true)
    expect(await credits(U1)).toBe(0)
    expect((await q(`select revoke_compensation_credit($1, $2) r`, [S1, U1]))[0].r).toBe(false)
    expect(await credits(U1)).toBe(0)
    // a credit already spent elsewhere is not clawed below zero
    await q(`select grant_fix_credit_once($1, $2, 0) g`, [S2, U1])
    await db.exec(`update users set free_fix_credits = 0 where id = '${U1}'`)
    expect((await q(`select revoke_compensation_credit($1, $2) r`, [S2, U1]))[0].r).toBe(true)
    expect(await credits(U1)).toBe(0)
  })
  it('only the owner of a scan can grant or revoke on it', async () => {
    expect((await q(`select grant_fix_credit_once($1, $2, 0) g`, [S3, U1]))[0].g).toBe(false)
    expect((await q(`select revoke_compensation_credit($1, $2) r`, [S3, U1]))[0].r).toBe(false)
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S3, U1]))[0].g).toBe(false)
  })
  it('a failed Badge upgrade hands the credit back once and counts as the scan\'s one credit', async () => {
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S3, U2]))[0].g).toBe(true)
    expect((await q(`select grant_upgrade_credit_once($1, $2) g`, [S3, U2]))[0].g).toBe(false)
    expect((await q(`select grant_fix_credit_once($1, $2, 2) g`, [S3, U2]))[0].g).toBe(false)
    expect(await credits(U2)).toBe(1)
  })
  it('the functions are service-role only', async () => {
    for (const sig of ['grant_fix_credit_once(uuid,uuid,int)', 'grant_upgrade_credit_once(uuid,uuid)', 'revoke_compensation_credit(uuid,uuid)']) {
      const [r] = await q(`select has_function_privilege('anon', '${sig}', 'execute') a, has_function_privilege('authenticated', '${sig}', 'execute') b, has_function_privilege('service_role', '${sig}', 'execute') c`)
      expect(r).toEqual({ a: false, b: false, c: true })
    }
  })
})
