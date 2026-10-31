import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0099 (partners section 4 round 20) against a real Postgres (PGlite): the per-code cap on channel tags, the ENDED status,
// the tax columns and their CHECKs, and the one-call signup counts.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0099_partners_section4_round20.sql'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const P1 = '22222222-2222-2222-2222-222222222222'
const P2 = '33333333-3333-3333-3333-333333333333'
const sub = async (code, s) => db.query('select increment_referral_sub_clicks($1,$2)', [code, s])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`insert into partners (id,name,email,dashboard_token) values ('${P1}','P','p@x.co','d1'),('${P2}','Q','q@x.co','d2')`)
  await db.exec(`insert into referral_codes (partner_id, code, tier_prices) values ('${P1}','ANN10','{"FIX":1900}'::jsonb),('${P2}','PAUSED10','{"FIX":1900}'::jsonb)`)
  for (const f of files.filter(f => f >= MIG)) await db.exec(read(f))
}, 180000)
afterAll(async () => { await db?.close() })

describe('0099: channel tags are capped per code', () => {
  // 0100 made a full code EVICT its quietest unattributed tag instead of dropping the newcomer; 0125 (partners round 44) then said a tag can
  // only be displaced once it is 7 days old, so a burst of made-up ?sub= values can no longer wipe fresh real channels. The cap itself
  // (50 distinct tags) is unchanged. Eviction of OLD tags is tested in migrations.0100 / migrations.0125.
  it('keeps at most 50 distinct tags (0125: while every tag is fresh a newcomer is simply not tracked)', async () => {
    for (let i = 0; i < 60; i++) await sub('ANN10', `junk${i}`)
    expect((await q(`select count(*)::int n from referral_sub_clicks`))[0].n).toBe(50)
    expect((await q(`select count(*)::int n from referral_sub_clicks where sub = 'junk59'`))[0].n).toBe(0)
    expect((await q(`select count(*)::int n from referral_sub_clicks where sub = 'junk49'`))[0].n).toBe(1)
  })
  it('a tag that is already stored keeps counting after the cap is reached', async () => {
    await sub('ANN10', 'junk49'); await sub('ANN10', 'junk49')
    expect((await q(`select clicks from referral_sub_clicks where sub = 'junk49'`))[0].clicks).toBe(3)
  })
  it('the cap is per code, not global', async () => {
    await sub('PAUSED10', 'fresh')
    expect((await q(`select count(*)::int n from referral_sub_clicks where sub = 'fresh'`))[0].n).toBe(1)
  })
  it('still ignores a malformed tag, an unknown code, an inactive code and a non-ACTIVE partner', async () => {
    const before = (await q(`select count(*)::int n from referral_sub_clicks`))[0].n
    await sub('ANN10', 'Bad Tag!'); await sub('NOPE', 'x'); await sub('ANN10', '')
    await db.exec(`update referral_codes set active = false where code = 'ANN10'`); await sub('ANN10', 'inactive-try')
    await db.exec(`update referral_codes set active = true where code = 'ANN10'`)
    await db.exec(`update partners set status = 'PAUSED' where id = '${P2}'`); await sub('PAUSED10', 'paused-try')
    await db.exec(`update partners set status = 'ACTIVE' where id = '${P2}'`)
    expect((await q(`select count(*)::int n from referral_sub_clicks`))[0].n).toBe(before)
  })
})

describe('0099: ENDED status', () => {
  it('is a usable partner status, and an ended partner stops counting channel visits', async () => {
    await db.exec(`update partners set status = 'ENDED' where id = '${P2}'`)
    expect((await q(`select status from partners where id = '${P2}'`))[0].status).toBe('ENDED')
    const before = (await q(`select count(*)::int n from referral_sub_clicks`))[0].n
    await sub('PAUSED10', 'after-end')
    expect((await q(`select count(*)::int n from referral_sub_clicks`))[0].n).toBe(before)
    await db.exec(`update partners set status = 'ACTIVE' where id = '${P2}'`)
  })
})

describe('0099: tax details', () => {
  it('accepts a 2-letter upper-case country and a 3-40 character id; rejects the rest', async () => {
    await db.exec(`update partners set tax_country = 'KE', tax_id = 'A123456789B' where id = '${P1}'`)
    expect((await q(`select tax_country, tax_id from partners where id = '${P1}'`))[0]).toEqual({ tax_country: 'KE', tax_id: 'A123456789B' })
    await expect(db.exec(`update partners set tax_country = 'ke' where id = '${P1}'`)).rejects.toThrow()
    await expect(db.exec(`update partners set tax_country = 'KEN' where id = '${P1}'`)).rejects.toThrow()
    await expect(db.exec(`update partners set tax_id = 'ab' where id = '${P1}'`)).rejects.toThrow()
    await db.exec(`update partners set tax_country = null, tax_id = null where id = '${P1}'`)
  })
})

describe('0099: referral_signup_counts', () => {
  it('counts only open-window attributions, grouped by code, in one call', async () => {
    await db.exec(`insert into users (email,password_hash,name,referred_by_code,referred_at) values
      ('u1@x.co','h','A','ANN10', now()), ('u2@x.co','h','B','ANN10', now() - interval '2 days'),
      ('u3@x.co','h','C','ANN10', now() - interval '90 days'), ('u4@x.co','h','D','PAUSED10', now()), ('u5@x.co','h','E', null, null)`)
    const rows = await q(`select code, signups from referral_signup_counts(array['ANN10','PAUSED10','NONE'], now() - interval '30 days') order by code`)
    expect(rows).toEqual([{ code: 'ANN10', signups: 2 }, { code: 'PAUSED10', signups: 1 }])
  })
})

describe('0099: bookkeeping', () => {
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 99`))[0].name).toBe('0099_partners_section4_round20')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(99)
  })
  it('is safe to run again', async () => {
    await db.exec(read(MIG))
    expect((await q(`select count(*)::int n from applied_migrations where version = 99`))[0].n).toBe(1)
  })
})
