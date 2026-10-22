import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0109 (model stamp) against a real Postgres (PGlite): the two columns, the per-model outcome view, and re-run safety.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0109_model_stamp.sql'
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

describe('0109: model stamp', () => {
  it('adds fix_model and letter_model as nullable text', async () => {
    const cols = await q(`select column_name, data_type, is_nullable from information_schema.columns where table_name = 'scans' and column_name in ('fix_model','letter_model') order by 1`)
    expect(cols).toEqual([
      { column_name: 'fix_model', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'letter_model', data_type: 'text', is_nullable: 'YES' },
    ])
  })

  it('model_outcome_rates groups answered outcomes by the model that wrote the fix', async () => {
    const mk = async (model, outcome, i) => {
      const [{ id }] = await q(`insert into scans (user_id, fix_model) values ('${U1}', $1) returning id`, [model])
      await db.query(`insert into scan_outcomes (scan_id, user_id, outcome) values ($1, '${U1}', $2)`, [id, outcome])
    }
    await mk('claude-sonnet-4-6', 'INTERVIEW'); await mk('claude-sonnet-4-6', 'NO_INTERVIEW'); await mk('claude-sonnet-4-6', 'NO_INTERVIEW')
    await mk('claude-sonnet-5-5', 'INTERVIEW')
    const rows = await q('select model, responses, interviews, interview_pct from model_outcome_rates order by model')
    expect(rows.map(r => [r.model, Number(r.responses), Number(r.interviews), Number(r.interview_pct)])).toEqual([
      ['claude-sonnet-4-6', 3, 1, 33.3], ['claude-sonnet-5-5', 1, 1, 100],
    ])
  })

  it('re-running the file changes nothing, records itself once and never moves the schema version backwards', async () => {
    await db.exec(read(MIG))
    expect((await q('select count(*)::int as c from applied_migrations where version = 109'))[0].c).toBe(1)
    expect((await q(`select (value->>'version')::int as v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(109)
  })
})
