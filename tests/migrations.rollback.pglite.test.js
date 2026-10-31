import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// Audit A10: the rollback SQL (scripts/experts-rollback.cjs, derived from the migration files) is EXECUTED against a real Postgres and the
// result is compared with a database built only from the older files. The hand-written rollback-0127.sql this replaced had never been run:
// its 0129 block came after the table drop and failed, and it ended with a schema version no instruction agreed on.
const require = createRequire(import.meta.url)
const { buildRollback, functionsIn, createdIn, argTypes } = require('../scripts/experts-rollback.cjs')
const dir = path.resolve(__dirname, '../supabase/migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const num = f => parseInt(f.slice(0, 4), 10)
const NEWEST = num(files[files.length - 1])
const FLOOR = 126
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const ROLES = `create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`

async function snapshot(db) {
  const q = async s => (await db.query(s)).rows
  const tables = (await q(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).map(r => r.relname)
  const functions = (await q(`select p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) def, coalesce(p.proacl::text, '') acl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`))
  const triggers = (await q(`select tgname, tgrelid::regclass::text tbl, pg_get_triggerdef(oid) def from pg_trigger where not tgisinternal order by 1`))
  const indexes = (await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1`))
  const columns = (await q(`select table_name || '.' || column_name x from information_schema.columns where table_schema = 'public' order by 1`)).map(r => r.x)
  const rules = tables.includes('job_transition_rules') ? (await q(`select from_state, to_state, trigger, actors::text from job_transition_rules order by 1, 2, 3`)) : null
  const ledger = (await q(`select version, name from applied_migrations order by 1`))
  const sv = (await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v
  return { tables, functions, triggers, indexes, columns, rules, ledger, sv }
}
// What a rollback must restore. Columns added to surviving tables are left in place on purpose (script header), so they only have to be a superset.
function diff(got, want) {
  const bad = []
  for (const k of ['tables', 'functions', 'triggers', 'indexes', 'rules', 'ledger'])
    if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) {
      const g = new Set((got[k] || []).map(x => JSON.stringify(x))), w = new Set((want[k] || []).map(x => JSON.stringify(x)))
      bad.push(`${k}: extra ${JSON.stringify([...g].filter(x => !w.has(x)).slice(0, 4))} missing ${JSON.stringify([...w].filter(x => !g.has(x)).slice(0, 4))}`)
    }
  const missingCols = want.columns.filter(c => !got.columns.includes(c))
  if (missingCols.length) bad.push(`columns lost: ${missingCols.slice(0, 5)}`)
  if (got.sv !== want.sv) bad.push(`schema_version ${got.sv}, want ${want.sv}`)
  return bad
}

let live, ref, once
const want = {}
const stepResults = {}

beforeAll(async () => {
  ref = new PGlite(); await ref.exec(ROLES)
  for (const f of files) {
    await ref.exec(read(f))
    if (num(f) >= FLOOR) want[num(f)] = await snapshot(ref)
  }
  live = new PGlite(); await live.exec(ROLES)
  for (const f of files) await live.exec(read(f))
  once = new PGlite(); await once.exec(ROLES)
  for (const f of files) await once.exec(read(f))
}, 280000)
afterAll(async () => { await Promise.all([live?.close(), ref?.close(), once?.close()]) })

describe('rollback generator: parsing', () => {
  it('reads argument types without names or defaults, even with nested brackets', () => {
    expect(argTypes('p_job uuid, p_x int default 3, p_t text[], p_n numeric(10,2) default 1')).toEqual(['uuid', 'int', 'text[]', 'numeric(10,2)'])
  })
  it('keeps comments inside a function body byte for byte', () => {
    const f = functionsIn(read(files.find(x => x.startsWith('0124')))).find(x => x.name === 'human_job_reverse')
    expect(f.text).toContain('-- a refunded job returns to a state with no expert')
  })
  it('finds what 0130 created', () => {
    const c = createdIn(read(files.find(x => x.startsWith('0130'))))
    expect(c.triggers.map(t => t.name)).toEqual(['expert_earnings_reversal_release_trg', 'human_jobs_accept_needs_settled_payment_trg'])
    expect(c.indexes).toContain('expert_earnings_idem_key')
  })
  it('refuses a range that would delete Phase 1 data unless asked, and a range that goes the wrong way', () => {
    expect(() => buildRollback({ dir, to: 123 })).toThrow(/--include-phase1/)
    expect(() => buildRollback({ dir, from: 126, to: 130 })).toThrow(/lower/)
    expect(buildRollback({ dir, to: 123, includePhase1: true })).toContain('expert_audit_log is kept')
  })
})

describe('rollback: running it gives the schema of the older files', () => {
  for (let to = NEWEST - 1; to >= FLOOR; to--) {
    it(`${to + 1} -> ${to} (one step, on top of the previous steps)`, async () => {
      await live.exec(buildRollback({ dir, from: to + 1, to }))
      expect(diff(await snapshot(live), want[to])).toEqual([])
      stepResults[to] = true
    }, 120000)
  }
  it(`${NEWEST} -> ${FLOOR} in ONE script (the default the CLI prints)`, async () => {
    await once.exec(buildRollback({ dir }))
    expect(diff(await snapshot(once), want[FLOOR])).toEqual([])
  }, 120000)
  it('the schema and the ledger agree after the full rollback (no row above the version, none missing below)', async () => {
    const s = await snapshot(once)
    expect(s.sv).toBe(FLOOR)
    expect(Math.max(...s.ledger.map(r => r.version))).toBe(FLOOR)
  })
  it('after rolling back, the migrations apply again cleanly and reach the newest version (a rollback is not a dead end)', async () => {
    for (const f of files.filter(f => num(f) > FLOOR)) await once.exec(read(f))
    const s = await snapshot(once)
    expect(diff(s, want[NEWEST])).toEqual([])
  }, 120000)
})
