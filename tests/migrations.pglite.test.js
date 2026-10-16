import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalMailbox } from '../src/lib/mailbox.js'

// Database layer: the migrations are applied, in order, to a REAL Postgres (PGlite — Postgres compiled to WASM, no
// server) with Supabase's platform roles and default privileges recreated, and the FINAL schema is interrogated.
// Every other test in this repo reads the .sql files as text or fakes the database; this is the one that can tell
// the schema is actually right. It exists because the same few bugs came back round after round, each one invisible
// to a text match:
//   * a table created without RLS (0016 alert_logs by hand, 0044 referral_code_reservations until 0046),
//   * a function left callable by the anon key (0023, then three more until 0077),
//   * a create-or-replace of scrub_account_data that silently dropped columns (0026 vs 0025; 0079's columns vs 0077),
//   * a foreign key with no index (0082).
// If a check here fails, the message says which object; fix the migration (add a NEW one — applied ones are history).

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()

let db
const failures = []
const rows = async (sql, params) => (await db.query(sql, params)).rows

beforeAll(async () => {
  db = new PGlite()
  // What a Supabase project has before the first migration: the three API roles, and the platform's DEFAULT PRIVILEGES that
  // hand every new table / function / sequence in `public` to them.
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files) {
    // gen_random_uuid() is built in from Postgres 13; PGlite does not ship the pgcrypto extension 0001 asks for.
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
    try { await db.exec(sql) } catch (e) { failures.push(`${f}: ${e.message}`) }
  }
}, 180000)

afterAll(async () => { await db?.close() })

describe('migrations applied to a real Postgres', () => {
  it('every migration applies cleanly, in filename order', () => { expect(failures).toEqual([]) })

  it('records the schema version this code expects', async () => {
    const [{ value }] = await rows(`select value from system_state where key = 'schema_version'`)
    expect(value.version).toBe(Number(files[files.length - 1].slice(0, 4)))
  })

  it('the migration ledger holds a row for every migration from 0082 on, named after its file', async () => {
    const have = new Map((await rows(`select version, name from applied_migrations`)).map(r => [r.version, r.name]))
    for (const f of files.filter(f => Number(f.slice(0, 4)) >= 82)) expect(have.get(Number(f.slice(0, 4))), f).toBe(f.replace(/\.sql$/, ''))
  })
})

describe('RLS and privileges: nothing in public is reachable with the anon key', () => {
  it('every table has row level security enabled', async () => {
    const r = await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`)
    expect(r.map(x => x.relname), 'tables without RLS — enable it in the migration that creates the table').toEqual([])
  })

  it('anon and authenticated hold no privilege on any table or sequence', async () => {
    const t = await rows(`select table_name, grantee, privilege_type from information_schema.role_table_grants
                           where table_schema = 'public' and grantee in ('anon', 'authenticated') order by 1, 2, 3`)
    expect(t, 'table privileges — `revoke all on <table> from anon, authenticated` (0082 does this for every future table by default)').toEqual([])
    const s = await rows(`select object_name, grantee from information_schema.usage_privileges
                           where object_schema = 'public' and grantee in ('anon', 'authenticated')`)
    expect(s).toEqual([])
  })

  it('no function in public is executable by anon or authenticated', async () => {
    const r = await rows(`select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) order by 1`)
    expect(r.map(x => x.fn), 'callable through POST /rest/v1/rpc/<name> with the anon key — add `revoke execute ... from public, anon, authenticated`').toEqual([])
  })

  it('every function the Worker needs is executable by service_role', async () => {
    const r = await rows(`select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.prokind = 'f' and not has_function_privilege('service_role', p.oid, 'execute') order by 1`)
    expect(r.map(x => x.fn)).toEqual([])
  })

  it('every security definer function pins search_path', async () => {
    const r = await rows(`select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.prosecdef
                             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') order by 1`)
    expect(r.map(x => x.fn)).toEqual([])
  })

  it('a table created by a FUTURE migration is born without client-role privileges', async () => {
    await db.exec(`create table zz_future_table (id int)`)
    const r = await rows(`select grantee from information_schema.role_table_grants where table_name = 'zz_future_table' and grantee in ('anon', 'authenticated')`)
    await db.exec(`drop table zz_future_table`)
    expect(r).toEqual([])
  })
})

describe('foreign keys', () => {
  // Parents that are never deleted (users are soft-deleted, partners anonymised, payments never removed): the index would only cost writes.
  const NEVER_DELETED_PARENT = new Set([
    'admin_audit_log.actor_id', 'partner_applications.partner_id', 'scans.fix_payment_id', 'scan_outcomes.story_moderated_by',
  ])
  it('every foreign key has an index led by its column (partial indexes count: an equality lookup implies NOT NULL)', async () => {
    const r = await rows(`
      select c.conrelid::regclass::text || '.' || a.attname as fk
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
       where c.contype = 'f' and c.connamespace = 'public'::regnamespace
         and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
       order by 1`)
    expect(r.map(x => x.fk).filter(x => !NEVER_DELETED_PARENT.has(x)), 'foreign keys with no index — a delete or update of the parent scans the child table').toEqual([])
  })
})

describe('scrub_account_data', () => {
  const U = '11111111-1111-1111-1111-111111111111'
  const S = '22222222-2222-2222-2222-222222222222'
  const P = '33333333-3333-3333-3333-333333333333'

  // Fill EVERY column of a row with a recognisable value, so a column added later and forgotten by the scrub shows up.
  async function fill(table, id, skip = []) {
    const cols = await rows(`select column_name, data_type, is_generated from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])
    const set = {}
    for (const c of cols) {
      if (c.is_generated === 'ALWAYS' || c.column_name === 'id' || skip.includes(c.column_name)) continue
      const v = { text: `sentinel_${c.column_name}`, jsonb: JSON.stringify({ s: `sentinel_${c.column_name}` }), 'timestamp with time zone': '2020-01-01T00:00:00Z',
                  boolean: 'true', integer: '7', smallint: '7', bigint: '7', numeric: '7', date: '2020-01-01' }[c.data_type]
      if (v === undefined) continue
      try { await db.query(`update ${table} set ${c.column_name} = $1 where id = $2`, [v, id]); set[c.column_name] = v } catch { /* a CHECK / enum / key rejected the sentinel: not a free-text column */ }
    }
    return set
  }
  const retained = async (table, id, set) => {
    const [row] = await rows(`select * from ${table} where id = $1`, [id])
    return Object.keys(set).filter(k => {
      const v = row[k]; if (v === null) return false
      const want = set[k]
      return v instanceof Date ? v.toISOString().startsWith('2020-01-01') : typeof v === 'object' ? JSON.stringify(v).includes('sentinel') : String(v) === want
    }).sort()
  }

  let userSet, scanSet, paySet
  beforeAll(async () => {
    await db.exec(`insert into users (id, email, password_hash, name) values ('${U}', 'real@example.com', 'hash', 'Real Name')`)
    await db.exec(`insert into scans (id, user_id, status) values ('${S}', '${U}', 'COMPLETE_PASS')`)
    await db.exec(`insert into payments (id, amount_cents, paystack_ref, user_id, scan_id) values ('${P}', 2900, 'ref1', '${U}', '${S}')`)
    userSet = await fill('users', U, ['email', 'pending_email', 'status', 'role'])
    await db.exec(`update users set email = 'real@example.com', pending_email = 'pending@example.com' where id = '${U}'`)
    scanSet = await fill('scans', S, ['status', 'input_mode', 'fix_tier', 'verification_status', 'verification_revoked_reason', 'anon_token'])
    await db.exec(`update scans set verification_code = 'CODE1', verification_status = 'ACTIVE', resume_hash = '${'a'.repeat(64)}', resume_pdf_hash = '${'b'.repeat(64)}',
                   resume_hash_history = '[{"docx":"${'c'.repeat(64)}","pdf":"${'d'.repeat(64)}"}]'::jsonb, fix_payment_id = '${P}' where id = '${S}'`)
    paySet = await fill('payments', P, ['status', 'fix_tier', 'referral_source', 'paystack_ref'])
    await db.exec(`insert into email_logs ("to", subject, template, status) values ('real@example.com', 'a', 't', 'sent'), ('pending@example.com', 'b', 't', 'sent')`)
    await db.exec(`insert into user_sessions (user_id, absolute_expires_at, ip, user_agent) values ('${U}', now() + interval '1 day', '1.2.3.4', 'UA')`)
    await db.exec(`insert into saved_profiles (user_id, label, resume_data) values ('${U}', 'p2', '{"name":"x"}')`)
    await db.exec(`insert into scan_outcomes (scan_id, user_id, outcome, story_consent, story_status, story_display_name, story_quote, story_text, story_show_credential)
                   values ('${S}', '${U}', 'INTERVIEW', true, 'APPROVED', 'Dn', 'Q', 'T', true)`)
    await db.query(`select scrub_account_data('${U}')`)
  }, 60000)

  // The columns that DELIBERATELY survive an account deletion. Adding a column to users / scans / payments means either scrubbing it in a NEW
  // scrub_account_data (copy the newest body — a replace that starts from an older one drops every column added since) or listing it here on purpose.
  const KEPT = {
    users: ['created_at', 'deleted_at', 'email_bounce_type', 'email_bounced_at', 'email_verified', 'free_fix_credits', 'notify_outcome_followup', 'notify_scan_results', 'scans_day_reset', 'scans_today', 'terms_accepted_at', 'terms_version'],
    scans: ['anon_expires_at', 'created_at', 'fix_ats_score', 'fix_credit_round', 'fix_error_recoveries', 'fix_generated_at', 'fix_job_lock_until', 'fix_purchased', 'fix_retry_count',
            'outcome_prompt_attempts', 'passed', 'outcome_prompted_at', 'resume_mime_type', 'rewrite_failed', 'role_category', 'scan_completed_at', 'scan_slot_spent_at', 'seniority_level', 'verification_downloads',
            'verification_views', 'verified_at', 'ats_score', 'content_score', 'format_score', 'keyword_score', 'sections_score', 'updated_at',
            // waiting-screen telemetry (0088): job phase and per-attempt scores. No resume content, nothing personal.
            'scan_stage', 'fix_progress'],
    payments: ['amount_cents', 'created_at', 'dispute_due_at', 'dispute_id', 'disputed_at', 'last_reconciled_at', 'paid_at', 'paystack_access_code', 'receipt_delivered_at', 'receipt_sent_at', 'referral_code', 'refund_claimed_at', 'refund_reference', 'refunded_at', 'reversal_notice_sent_at', 'currency', 'updated_at'],
  }
  const check = async (table, id, set) => {
    const left = (await retained(table, id, set)).filter(c => !['updated_at'].includes(c))
    const allowed = new Set(KEPT[table])
    expect(left.filter(c => !allowed.has(c)), `${table} columns still holding personal-looking data after scrub_account_data — scrub them, or list them in KEPT on purpose`).toEqual([])
  }
  it('the keep list names only columns that exist (no stale entries masking a new column)', async () => {
    for (const [table, list] of Object.entries(KEPT)) {
      const have = new Set((await rows(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).map(r => r.column_name))
      expect(list.filter(c => !have.has(c)), table).toEqual([])
    }
  })
  it('users: nothing personal survives that is not on the keep list', () => check('users', U, userSet))
  it('scans: nothing personal survives that is not on the keep list', () => check('scans', S, scanSet))
  it('payments: nothing personal survives that is not on the keep list', () => check('payments', P, paySet))

  it('the referral attribution (0079) is cleared with the account', async () => {
    const [u] = await rows(`select referred_by_code, referred_at from users where id = $1`, [U])
    expect(u).toEqual({ referred_by_code: null, referred_at: null })
  })
  it('mail history of the real AND the pending address is renamed; sessions and extra profiles are deleted; the story is erased but the answer stays', async () => {
    expect((await rows(`select distinct "to" from email_logs`)).map(r => r.to)).toEqual([`deleted-${U}@passthrough.dev`])
    expect((await rows(`select count(*)::int c from user_sessions`))[0].c).toBe(0)
    expect((await rows(`select count(*)::int c from saved_profiles`))[0].c).toBe(0)
    expect(await rows(`select outcome, story_status, story_text, story_consent from scan_outcomes`)).toEqual([{ outcome: 'INTERVIEW', story_status: 'NONE', story_text: null, story_consent: false }])
  })
  it('the published page code and every file fingerprint (current and superseded) outlive the page as tombstones', async () => {
    expect((await rows(`select code from verification_tombstones`)).map(r => r.code)).toEqual(['CODE1'])
    expect((await rows(`select hash from verification_tombstone_hashes order by hash`)).map(r => r.hash[0])).toEqual(['a', 'b', 'c', 'd'])
  })
  it('running it again keeps the ORIGINAL deletion time and still bumps token_version', async () => {
    const [a] = await rows(`select deleted_at, token_version from users where id = $1`, [U])
    await new Promise(r => setTimeout(r, 30))
    await db.query(`select scrub_account_data('${U}')`)
    const [b] = await rows(`select deleted_at, token_version from users where id = $1`, [U])
    expect(b.deleted_at.getTime()).toBe(a.deleted_at.getTime())
    expect(b.token_version).toBe(a.token_version + 1)
  })
})

describe('lead_mailbox_key (SQL) matches canonicalMailbox (JS)', () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mailbox-keys.json'), 'utf8'))
  const sql = async s => (await rows(`select lead_mailbox_key($1) k`, [s]))[0].k
  it('agrees on every shared fixture', async () => {
    for (const [input, expected] of fixtures) { expect(await sql(input), input).toBe(expected); expect(canonicalMailbox(input), input).toBe(expected) }
  })
  it('trims every kind of whitespace JS trim() does', async () => {
    for (const ws of ['\n', '\t', '\r', ' ', ' ', '　', '﻿', ' '])
      for (const s of [`${ws}Dana.Jobs+x@Gmail.com${ws}`, `a@b.com${ws}`]) expect(await sql(s), JSON.stringify(s)).toBe(canonicalMailbox(s))
  })
  it('agrees on 600 generated addresses (fixed seed, ASCII)', async () => {
    let seed = 20261013; const rnd = n => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n }
    const alpha = ['a', 'b', 'c', '.', '+', '@', 'g', 'm', 'i', 'l', 'o', 'O', '_', '-', ' ', '\t']
    for (let n = 0; n < 600; n++) {
      let s = ''; for (let i = 0, len = 1 + rnd(14); i < len; i++) s += alpha[rnd(alpha.length)]
      if (rnd(3) === 0) s = s.replace(/@.*/, '') + '@gmail.com'
      expect(await sql(s), JSON.stringify(s)).toBe(canonicalMailbox(s))
    }
  })
})
