import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Contract between the Worker's queries and the migrated schema. supabase-js builds queries from strings, so a misspelled column or a wrong RPC
// argument name is not a type error: PostgREST answers 400/404 at runtime, and several callers turn that into "no rows" (the email_logs probe
// filtered on a column that never existed and could never see an outage). The migrations are applied to a real Postgres (PGlite) and every
// .from('table') chain and .rpc('fn', {args}) in src/ is checked against what exists. Only literal column names are checked; dynamic ones
// (template strings, variables) are skipped.

const here = path.dirname(fileURLToPath(import.meta.url))
const MIG = path.join(here, '..', 'supabase', 'migrations')
const SRC = path.join(here, '..', 'src')

let schema = {}      // table -> Set(columns)
let fns = {}         // name -> [{ params: [{name, hasDefault}] }]

beforeAll(async () => {
  const db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort())
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, ''))
  for (const r of (await db.query(`select table_name t, column_name c from information_schema.columns where table_schema='public'`)).rows)
    (schema[r.t] ||= new Set()).add(r.c)
  const procs = (await db.query(`select p.proname n, pg_get_function_arguments(p.oid) a from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public'`)).rows
  for (const r of procs) {
    const params = r.a.split(/,(?![^()]*\))/).map(x => x.trim()).filter(Boolean).map(x => ({ name: x.replace(/^(in|inout|out|variadic)\s+/i, '').split(/\s+/)[0], hasDefault: /\bdefault\b/i.test(x) }))
    ;(fns[r.n] ||= []).push({ params })
  }
  await db.close()
}, 180000)

const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|cjs|mjs)$/.test(e.name) ? [path.join(d, e.name)] : [])

function balanced(s, i, open, close) {
  let d = 0, qt = null
  for (let k = i; k < s.length; k++) {
    const ch = s[k]
    if (qt) { if (ch === '\\') k++; else if (ch === qt) qt = null; continue }
    if (ch === '"' || ch === "'" || ch === '`') { qt = ch; continue }
    if (ch === open) d++
    else if (ch === close) { d--; if (d === 0) return k }
  }
  return -1
}
function splitTop(s, sep = ',') {
  const out = []; let d = 0, qt = null, cur = ''
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]
    if (qt) { cur += ch; if (ch === '\\') cur += s[++k]; else if (ch === qt) qt = null; continue }
    if (ch === '"' || ch === "'" || ch === '`') { qt = ch; cur += ch; continue }
    if ('({['.includes(ch)) d++
    if (')}]'.includes(ch)) d--
    if (ch === sep && d === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur); return out
}
function objectKeys(obj) {   // top-level keys of an object literal; spreads and computed keys are skipped
  const keys = []
  for (let seg of splitTop(obj.slice(1, -1))) {
    seg = seg.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!seg || seg.startsWith('...')) continue
    const m = seg.match(/^(?:['"`])?([A-Za-z_][A-Za-z0-9_]*)(?:['"`])?\s*(:|$)/)
    if (m) keys.push(m[1])
  }
  return keys
}

function columnProblems() {
  const out = []
  const FILTERS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'order', 'not', 'match', 'filter']
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8')
    const re = /\.from\(\s*(['"`])([a-z_0-9]+)\1\s*\)/g
    let m
    while ((m = re.exec(src))) {
      const table = m[2]
      const rel = `${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`
      if (!schema[table]) { out.push(`${rel} unknown table ${table}`); continue }
      let i = m.index + m[0].length
      const cols = []
      for (;;) {
        const mm = src.slice(i).match(/^\s*\.\s*([a-zA-Z]+)\s*\(/)
        if (!mm) break
        const name = mm[1], open = i + mm[0].length - 1, end = balanced(src, open, '(', ')')
        if (end < 0) break
        const args = src.slice(open + 1, end); i = end + 1
        if (name === 'select') {
          const sm = args.match(/^\s*(['"`])([\s\S]*?)\1/)
          if (sm && !sm[2].includes('${'))
            for (let c of splitTop(sm[2])) { c = c.trim(); if (!c || c === '*' || c.includes('(')) continue; c = c.replace(/^[a-zA-Z_]+:/, '').replace(/::.*$/, '').trim(); if (c !== '*') cols.push(c) }
        } else if (FILTERS.includes(name)) {
          const sm = args.match(/^\s*(['"`])([A-Za-z_][A-Za-z0-9_]*)\1/)
          if (sm) cols.push(sm[2])
        } else if (name === 'or') {
          const sm = args.match(/^\s*(['"`])([\s\S]*?)\1/)
          if (sm && !sm[2].includes('${')) for (const p of splitTop(sm[2])) { const c = p.trim().split('.')[0]; if (/^[a-z_]+$/.test(c)) cols.push(c) }
        } else if (['insert', 'update', 'upsert'].includes(name)) {
          const t = args.trim()
          if (t.startsWith('{')) { const e = balanced(t, 0, '{', '}'); if (e > 0) cols.push(...objectKeys(t.slice(0, e + 1))) }
          else if (t.startsWith('[')) { let k = 0; while ((k = t.indexOf('{', k)) >= 0) { const e = balanced(t, k, '{', '}'); if (e < 0) break; cols.push(...objectKeys(t.slice(k, e + 1))); k = e + 1 } }
        }
      }
      for (const c of new Set(cols)) if (!schema[table].has(c)) out.push(`${rel} ${table}.${c}`)
    }
  }
  return out
}

function rpcProblems() {
  const out = []
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8')
    const re = /\.rpc\(\s*(['"`])([a-z_0-9]+)\1\s*(?:,\s*(\{)?)?/g
    let m
    while ((m = re.exec(src))) {
      const name = m[2], rel = `${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`
      const lineStart = src.lastIndexOf('\n', m.index) + 1
      if (/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index + 1))) continue          // a call quoted in a comment
      const defs = fns[name]
      if (!defs) { out.push(`${rel} unknown rpc ${name}`); continue }
      let given = [], complete = true       // complete = the argument list is a literal with nothing spread into it
      if (m[3]) {
        const s0 = m.index + m[0].length - 1, e = balanced(src, s0, '{', '}'), lit = src.slice(s0, e + 1)
        given = objectKeys(lit); complete = !splitTop(lit.slice(1, -1)).some(x => x.trim().startsWith('...'))
      } else if (/,\s*$/.test(m[0])) complete = false    // arguments passed as a variable: only the names it is built from can be checked
      const ok = defs.some(d => given.every(g => d.params.some(p => p.name === g)) && (!complete || d.params.filter(p => !p.hasDefault).every(p => given.includes(p.name))))
      if (!ok) out.push(`${rel} ${name}(${given.join(', ')}) matches no overload: ${defs.map(d => '(' + d.params.map(p => p.name + (p.hasDefault ? '?' : '')).join(', ') + ')').join(' | ')}`)
    }
  }
  return out
}

describe('queries and RPC calls match the migrated schema', () => {
  it('every literal column in a .from() chain exists on that table', () => { expect(columnProblems()).toEqual([]) })
  it('every .rpc() call names an existing function and passes arguments it accepts', () => { expect(rpcProblems()).toEqual([]) })
  it('the analyser itself sees the schema it is meant to check (guards against a silent no-op)', () => {
    expect(schema.partners.has('payout_token_hash')).toBe(true)
    expect(fns.record_payout_settlement?.[0].params.map(p => p.name)).toContain('p_ledger_ids')
    expect(walk(SRC).length).toBeGreaterThan(20)
  })
})
