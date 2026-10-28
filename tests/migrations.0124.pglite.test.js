import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0124 (partners round 44) against a real Postgres (PGlite): a full code (50 channel tags) only displaces a tag that is
// more than 7 days old and unattributed. Spamming fresh made-up ?sub= values can no longer wipe a partner's recent channels.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0124'))
const P1 = '22222222-2222-2222-2222-222222222222'
const C1 = '44444444-4444-4444-4444-444444444444'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const sub = s => db.query('select increment_referral_sub_clicks($1,$2)', ['ANN10', s])
const tags = async () => (await q('select sub from referral_sub_clicks')).map(r => r.sub)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f <= MIG)) await db.exec(read(f))
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','d1')`)
  await db.exec(`insert into referral_codes (id, partner_id, code, tier_prices) values ('${C1}','${P1}','ANN10','{\"FIX\":1900}'::jsonb)`)
}, 240000)
afterAll(async () => { await db?.close() })

describe('0124: channel-tag eviction', () => {
  it('records itself and moves the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 124`))[0].name).toBe('0124_partners_section4_round44')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(124)
  })
  it('fresh tags are never displaced by a newcomer', async () => {
    for (let i = 0; i < 50; i++) await sub(`t${i}`)
    await sub('spam-1')
    const t = await tags()
    expect(t).toHaveLength(50)
    expect(t).not.toContain('spam-1')
  })
  it('a tag older than 7 days and unattributed is displaced, the quietest first', async () => {
    await db.exec(`update referral_sub_clicks set created_at = now() - interval '8 days', clicks = 5`)
    await db.exec(`update referral_sub_clicks set clicks = 1 where sub = 't7'`)
    await sub('real-channel')
    const t = await tags()
    expect(t).toHaveLength(50)
    expect(t).toContain('real-channel')
    expect(t).not.toContain('t7')
  })
  it('an existing tag keeps counting once the cap is reached', async () => {
    await sub('t1')
    expect((await q(`select clicks from referral_sub_clicks where sub='t1'`))[0].clicks).toBe(6)
  })
})
