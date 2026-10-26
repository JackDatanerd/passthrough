import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0119 (Experts Phase 0A demand test) against a real Postgres (PGlite): the two new tables, their constraints, the
// idempotency key, row level security, and that the migration only ADDS (every pre-existing table is untouched).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0119'))
const U1 = '00000000-0000-4000-8000-000000000001'
const VID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

let db
const q = async (sql, params) => (await db.query(sql, params)).rows
const fails = async (sql, params) => { try { await db.query(sql, params) } catch (e) { return e.message } return null }
const tablesAndColumns = async () => q(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2`)
let before

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
  before = await tablesAndColumns()
  await db.exec(read(MIG))
}, 180000)

describe('migration 0119', () => {
  it('is the newest migration, records itself in the ledger and moves schema_version to 119', async () => {
    expect(files[files.length - 1]).toBe('0119_human_demand_test.sql')
    expect((await q(`select name from applied_migrations where version = 119`))[0].name).toBe('0119_human_demand_test')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(119)
  })

  it('only adds: every table and column that existed before is unchanged', async () => {
    const after = await tablesAndColumns()
    const key = r => `${r.table_name}.${r.column_name}:${r.data_type}`
    const afterSet = new Set(after.map(key))
    for (const r of before) expect(afterSet.has(key(r)), key(r)).toBe(true)
    const added = [...new Set(after.map(r => r.table_name))].filter(n => !before.some(b => b.table_name === n)).sort()
    expect(added).toEqual(['human_demand_events', 'human_demand_waitlist'])
  })

  it('adds no function (so there is nothing to revoke execute on)', async () => {
    const sql = fs.readFileSync(path.join(dir, MIG), 'utf8').replace(/--.*$/gm, '')
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i)
  })

  it('both tables have row level security on, no policy, and no grant to anon / authenticated', async () => {
    for (const t of ['human_demand_events', 'human_demand_waitlist']) {
      expect((await q(`select relrowsecurity from pg_class where relname = $1`, [t]))[0].relrowsecurity, t).toBe(true)
      expect(await q(`select 1 from pg_policies where tablename = $1`, [t]), t).toHaveLength(0)
      const g = await q(`select grantee from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated')`, [t])
      expect(g, t).toHaveLength(0)
    }
  })

  describe('events', () => {
    const ins = (over = {}) => {
      const r = { event: 'button_shown', visitor_id: VID, price_variant: 'base', tier: null, cover_letter: null, ...over }
      return db.query(`insert into human_demand_events (event, visitor_id, price_variant, tier, cover_letter) values ($1,$2,$3,$4,$5)`, [r.event, r.visitor_id, r.price_variant, r.tier, r.cover_letter])
    }
    it('accepts all six steps', async () => {
      for (const event of ['button_shown', 'button_clicked', 'tier_selected', 'cover_letter_toggled', 'waitlist_submitted', 'modal_dismissed']) await ins({ event, tier: 'polish' })
      expect((await q(`select count(*)::int n from human_demand_events`))[0].n).toBe(6)
    })
    it('rejects an unknown event, variant or tier and a malformed visitor id', async () => {
      expect(await fails(`insert into human_demand_events (event, visitor_id, price_variant) values ('purchase', '${VID}', 'base')`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_events (event, visitor_id, price_variant) values ('button_shown', '${VID}', 'mid')`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_events (event, visitor_id, price_variant, tier) values ('button_shown', '${VID}', 'base', 'gold')`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_events (event, visitor_id, price_variant) values ('button_shown', 'jane@example.com', 'base')`)).toMatch(/check/i)
    })
    it('has no column that could hold text, a name or a contact detail', async () => {
      const cols = (await q(`select column_name from information_schema.columns where table_name = 'human_demand_events' order by 1`)).map(r => r.column_name)
      expect(cols).toEqual(['cover_letter', 'created_at', 'event', 'id', 'price_variant', 'tier', 'visitor_id'])
    })
  })

  describe('waitlist', () => {
    const base = { tier: 'polish', variant: 'base', cents: 5900, cl: 2900 }
    const joinAccount = (tier = 'polish') => db.query(
      `insert into human_demand_waitlist (identity_key, user_id, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ($1,$2,$3,'base',5900,2900)`, [`u:${U1}`, U1, tier])
    const joinEmail = (email, tier = 'polish') => db.query(
      `insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ($1,$2,$3,'base',5900,2900)`, ['e:' + email, email, tier])

    it('one row per person and tier: the same person and tier twice is refused, another tier is fine (the upsert path is ON CONFLICT DO NOTHING)', async () => {
      await joinAccount('polish')
      expect(await fails(`insert into human_demand_waitlist (identity_key, user_id, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('u:${U1}', '${U1}', 'polish', 'low', 4900, 2500)`)).toMatch(/unique|duplicate/i)
      await joinAccount('seven_day')
      const r = await db.query(`insert into human_demand_waitlist (identity_key, user_id, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('u:${U1}', '${U1}', 'polish', 'high', 6900, 3900) on conflict (identity_key, tier) do nothing returning id`)
      expect(r.rows).toHaveLength(0)
      expect((await q(`select price_variant from human_demand_waitlist where identity_key = 'u:${U1}' and tier = 'polish'`))[0].price_variant).toBe('base')   // first quote kept
    })
    it('a visitor without an account is keyed on the lower-cased email, and must have a well-formed one', async () => {
      await joinEmail('jane@example.com')
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:jane@example.com', 'jane@example.com', 'polish', 'base', 5900, 2900)`)).toMatch(/unique|duplicate/i)
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:Jane@Example.com', 'Jane@Example.com', 'polish', 'base', 5900, 2900)`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:no-at-sign', 'no-at-sign', 'polish', 'base', 5900, 2900)`)).toMatch(/check/i)
    })
    it('needs exactly one of an account or an email; never both, never neither', async () => {
      expect(await fails(`insert into human_demand_waitlist (identity_key, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:x@y.co', 'polish', 'base', 5900, 2900)`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_waitlist (identity_key, user_id, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('u:${U1}', '${U1}', 'a@b.co', 'seven_day', 'base', 5900, 2900)`)).toMatch(/check/i)
    })
    it('rejects an unknown tier or variant and a zero or negative quote', async () => {
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:q@y.co', 'q@y.co', 'gold', 'base', 5900, 2900)`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:q@y.co', 'q@y.co', 'polish', 'mid', 5900, 2900)`)).toMatch(/check/i)
      expect(await fails(`insert into human_demand_waitlist (identity_key, email, tier, price_variant, quoted_cents, cover_letter_quoted_cents) values ('e:q@y.co', 'q@y.co', 'polish', 'base', 0, 2900)`)).toMatch(/check/i)
    })
    it('defaults: no cover letter interest, no contact consent', async () => {
      const r = (await q(`select cover_letter_interest, contact_consent from human_demand_waitlist where identity_key = 'u:${U1}' and tier = 'polish'`))[0]
      expect(r).toEqual({ cover_letter_interest: false, contact_consent: false })
    })
  })

  describe('results queries (docs/experts/phase-0a-results.sql)', () => {
    it('every statement runs, is read-only, and the funnel query counts what it should', async () => {
      const sqlText = fs.readFileSync(path.join(dir, '..', '..', 'docs', 'experts', 'phase-0a-results.sql'), 'utf8')
      const statements = sqlText.replace(/^--.*$/gm, '').split(/;\s*\n/).map(x => x.trim()).filter(Boolean)
      expect(statements.length).toBe(7)
      for (const st of statements) expect(st, st.slice(0, 40)).toMatch(/^(with|select)\b/i)
      // two viewers on low (one clicks and joins), one on high
      const V2 = 'b1b2c3d4e5f60718293a4b5c6d7e8f91', V3 = 'c1b2c3d4e5f60718293a4b5c6d7e8f92'
      await db.exec(`delete from human_demand_events; delete from human_demand_waitlist;
        insert into human_demand_events (event, visitor_id, price_variant, tier, cover_letter) values
          ('button_shown','${VID}','low',null,null), ('button_clicked','${VID}','low',null,null), ('tier_selected','${VID}','low','polish',null),
          ('cover_letter_toggled','${VID}','low','polish',true), ('waitlist_submitted','${VID}','low','polish',true),
          ('button_shown','${V2}','low',null,null),
          ('button_shown','${V3}','high',null,null), ('button_clicked','${V3}','high',null,null), ('modal_dismissed','${V3}','high',null,null);
        insert into human_demand_waitlist (identity_key, user_id, tier, cover_letter_interest, price_variant, quoted_cents, cover_letter_quoted_cents, contact_consent)
          values ('u:${U1}', '${U1}', 'polish', true, 'low', 4900, 2500, true);`)
      const rows = []
      for (const st of statements) rows.push((await db.query(st)).rows)
      const low = rows[0].find(r => r.price_variant === 'low'), high = rows[0].find(r => r.price_variant === 'high')
      expect(low).toMatchObject({ viewers: 2, clickers: 1, joiners: 1 })
      expect(Number(low.click_through_pct)).toBe(50)
      expect(Number(low.waitlist_rate_pct)).toBe(50)
      expect(high).toMatchObject({ viewers: 1, clickers: 1, joiners: 0 })
      expect(rows[1].find(r => r.tier === 'polish' && r.price_variant === 'low')).toMatchObject({ visitors_who_picked_it: 1, waitlist_rows: 1 })
      expect(rows[2][0]).toMatchObject({ price_variant: 'low', people_on_waitlist: 1, want_cover_letter: 1 })
      expect(Number(rows[2][0].cover_letter_attach_pct)).toBe(100)
      expect(rows[5]).toHaveLength(0)                       // sanity query: nobody under two variants
    })
  })
})
