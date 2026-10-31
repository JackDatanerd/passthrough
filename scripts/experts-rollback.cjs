#!/usr/bin/env node
// Prints the SQL that takes a database back from migration FROM to migration TO (default: from the newest file down to 126, the last
// migration before the Experts realm). Nothing here is run by the app or by a migration: you read the output, then paste it into the
// Supabase SQL editor with the experts flags OFF and nobody signed in.
//
//   node scripts/experts-rollback.cjs                       # newest -> 126
//   node scripts/experts-rollback.cjs --to 128              # newest -> 128 (undo only the newest ones)
//   node scripts/experts-rollback.cjs --to 123 --include-phase1   # also undoes 0124 (Phase 1) and 0119: DELETES paid-order data
//
// The script is DERIVED from supabase/migrations/*.sql, so it cannot drift from them (audit A10; the old hand-written file had gone out
// of date three times). For each migration, newest first, it emits:
//   1. drop trigger   for every trigger the migration created
//   2. functions      drop what the migration defined, then restore the definition from the latest EARLIER migration that defined the
//                     same name (with execute revoked from public/anon/authenticated and granted to service_role, like every function here)
//   3. drop index     for every index the migration created
//   4. drop table     for every table the migration created (one statement, so tables that reference each other go together)
//   5. data steps     only where a migration changed rows in a table that survives (EXTRA below)
//   6. the ledger row for that migration is deleted
// and at the end moves system_state.schema_version down to TO.
//
// NOT undone, on purpose: columns a migration added to a table that survives (nullable, ignored by older code; dropping one would delete
// data, e.g. a voided payout's reason), settings keys, and data repairs (0129 rebuilt backfilled pauses: the rebuilt rows are the correct ones).
// expert_audit_log is never dropped, even with --include-phase1: it is the record of who read what.
//
// tests/migrations.rollback.pglite.test.js applies every migration to a real Postgres, runs this output, and compares the result with a
// database built only from the older files: tables, functions (bodies and privileges), triggers, indexes, rules, ledger, schema version.

const fs = require('node:fs')
const path = require('node:path')

const KEEP_TABLES = new Set(['expert_audit_log'])
const PHASE1 = new Set([119, 124])   // migrations whose tables hold customer / pilot data

// Row changes a migration made in a table that survives its rollback. Keyed by migration number.
const EXTRA = {
  129: [
    `-- 0129 added three rules and widened who may use two others (the give-back window setting it added is left in place: harmless)`,
    `delete from job_transition_rules where (trigger in ('dispute_resolved_for_expert', 'dispute_dismissed')) or (from_state = 'in_review' and to_state = 'revision' and trigger = 'sent_back');`,
    `update job_transition_rules set actors = array['operator'] where trigger in ('review_approved', 'sent_back');`,
  ],
}

const num = f => parseInt(f.slice(0, 4), 10)
// Comments become spaces of the same length: parsing ignores them, but the text copied out of a function keeps its comments exactly (the
// function body is stored verbatim by Postgres, so a restored function must match the original byte for byte).
const stripComments = sql => sql.replace(/--[^\n]*/g, m => ' '.repeat(m.length))

function listMigrations(dir) {
  return fs.readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort().map(f => ({ n: num(f), file: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }))
}

// Splits "a uuid, b numeric(10,2) default 1, c text[]" on the commas that are not inside brackets.
function splitArgs(s) {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map(x => x.trim()).filter(Boolean)
}
function argTypes(argText) {
  return splitArgs(argText).map(a => {
    const noDefault = a.replace(/\s+default\s[\s\S]*$/i, '').replace(/\s*=\s[\s\S]*$/, '')
    return noDefault.replace(/^(in|out|inout|variadic)\s+/i, '').replace(/^\S+\s+/, '').trim()
  })
}

// Every "create or replace function name(args) ... $$ body $$;" in a migration (comments removed first: a quoted `$$` in a comment must not count).
function functionsIn(sql) {
  const text = stripComments(sql)
  const out = []
  const re = /create\s+or\s+replace\s+function\s+([a-z_0-9]+)\s*\(/gi
  let m
  while ((m = re.exec(text))) {
    const start = m.index
    let i = re.lastIndex, depth = 1
    while (i < text.length && depth > 0) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++ }
    const args = text.slice(re.lastIndex, i - 1)
    const open = text.indexOf('$$', i)
    const close = text.indexOf('$$', open + 2)
    if (open < 0 || close < 0) throw new Error(`function ${m[1]}: no $$ body found`)
    const end = text.indexOf(';', close) + 1
    out.push({ name: m[1], args, types: argTypes(args), text: sql.slice(start, end).trim() })
    re.lastIndex = end
  }
  return out
}

function createdIn(sql) {
  const text = stripComments(sql)
  const names = re => [...text.matchAll(re)].map(x => x[1])
  const triggers = [...text.matchAll(/create\s+trigger\s+([a-z_0-9]+)[\s\S]*?\son\s+([a-z_0-9]+)/gi)].map(x => ({ name: x[1], table: x[2] }))
  return {
    tables: names(/create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)/gi),
    indexes: names(/create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)/gi),
    triggers,
  }
}

const sig = (name, types) => `${name}(${types.join(', ')})`

function buildRollback({ dir, from, to, includePhase1 = false }) {
  const all = listMigrations(dir)
  const newest = all[all.length - 1].n
  from = from == null ? newest : from
  if (to == null) to = 126
  if (!(to < from)) throw new Error(`--to (${to}) must be lower than the version rolled back from (${from})`)
  if (to < 82) throw new Error('the ledger starts at 0082; this script does not go below it')
  const touchesPhase1 = all.some(m => m.n > to && m.n <= from && PHASE1.has(m.n))
  if (touchesPhase1 && !includePhase1)
    throw new Error('that range includes 0124 (Experts Phase 1) or 0119, whose tables hold paid-order and pilot data: pass --include-phase1 if you really mean to delete them')

  const out = []
  out.push(`-- Rollback from migration ${from} to ${to}, generated from supabase/migrations by scripts/experts-rollback.cjs. Review it, then run it once, in one go.`)
  out.push(`-- Run with the experts flags OFF and nobody signed in. Take a backup first. Columns added to surviving tables stay (see the script header).`)
  if (touchesPhase1) out.push(`-- !!! This range includes Phase 1 / demand-test tables: every order, job, document and earning in them is DELETED. expert_audit_log is kept.`)
  out.push('begin;')

  for (let n = from; n > to; n--) {
    const mig = all.find(m => m.n === n)
    if (!mig) throw new Error(`no migration file numbered ${n}`)
    const made = createdIn(mig.sql)
    const fns = functionsIn(mig.sql)
    out.push('', `-- ===== undo ${mig.file} =====`)
    for (const t of made.triggers) out.push(`drop trigger if exists ${t.name} on ${t.table};`)
    for (const f of fns) {
      out.push(`drop function if exists ${sig(f.name, f.types)};`)
      const earlier = all.filter(m => m.n < n).reverse().map(m => ({ m, f: functionsIn(m.sql).filter(x => x.name === f.name).pop() })).find(x => x.f)
      if (earlier) {
        out.push(`-- restored from ${earlier.m.file}`, earlier.f.text)
        out.push(`revoke execute on function ${sig(f.name, earlier.f.types)} from public, anon, authenticated;`)
        out.push(`grant  execute on function ${sig(f.name, earlier.f.types)} to service_role;`)
      }
    }
    for (const i of made.indexes) out.push(`drop index if exists ${i};`)
    const tables = made.tables.filter(t => !KEEP_TABLES.has(t))
    if (tables.length) out.push(`drop table if exists ${tables.join(', ')};`)
    if (made.tables.some(t => KEEP_TABLES.has(t))) out.push(`-- ${[...KEEP_TABLES].join(', ')} is kept on purpose`)
    for (const line of EXTRA[n] || []) out.push(line)
    out.push(`delete from applied_migrations where version = ${n};`)
  }

  out.push('', `update system_state set value = jsonb_build_object('version', ${to}, 'applied_at', now()) where key = 'schema_version' and coalesce((value ->> 'version')::int, 0) > ${to};`)
  out.push('commit;', '',
    `-- Then, in the code: set EXPECTED_SCHEMA_VERSION to ${to} in src/config/constants.js and remove the ledger lines for ${to + 1} to ${from} from src/config/migrationLedger.js,`,
    `-- or /health reports a schema alert. (Or leave the code alone and deploy the previous Worker: a database BEHIND the code is the red state.)`)
  return out.join('\n') + '\n'
}

module.exports = { buildRollback, functionsIn, createdIn, argTypes }

if (require.main === module) {
  const args = process.argv.slice(2)
  const get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  try {
    process.stdout.write(buildRollback({
      dir: path.join(__dirname, '..', 'supabase', 'migrations'),
      from: get('--from') ? Number(get('--from')) : undefined,
      to: get('--to') ? Number(get('--to')) : undefined,
      includePhase1: args.includes('--include-phase1'),
    }))
  } catch (e) { console.error(e.message); process.exit(1) }
}
