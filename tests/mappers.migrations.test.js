import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Every audit round kept finding the same bug: a migration adds a column, a controller writes it,
// and the row mapper never learns to read it back. This replays the migrations (create table /
// add column / drop column / rename column) and fails when a column of a mapped table is neither
// read by its mapper nor listed below as deliberately kept off the API shape.
const root = fileURLToPath(new URL('..', import.meta.url))
const MAPPERS = readFileSync(path.join(root, 'src/lib/mappers.js'), 'utf8')

const TABLE_TO_MAPPER = {
  users: 'userRowToCamel', scans: 'scanRowToCamel', payments: 'paymentRowToCamel', partners: 'partnerRowToCamel',
  payouts: 'payoutRowToCamel', referral_codes: 'referralCodeRowToCamel', commission_ledger: 'commissionLedgerRowToCamel',
  employer_leads: 'leadRowToCamel',
}

// Columns a mapper must NOT surface: single-use secrets/tokens. Anything else missing is a bug.
const DELIBERATELY_UNMAPPED = {
  users: ['email_change_done_token'],
  partners: ['payout_details_token'],
}

function columnsFromMigrations() {
  const dir = path.join(root, 'supabase/migrations')
  const cols = {}
  const add = (t, c) => { (cols[t] = cols[t] || new Set()).add(c) }
  const del = (t, c) => { cols[t] && cols[t].delete(c) }
  for (const f of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '')
    for (const m of sql.matchAll(/create table(?: if not exists)?\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\)\s*;/gi))
      for (const line of m[2].split('\n')) {
        const mm = /^\s*(\w+)\s+(?!primary|unique|check|constraint|foreign)([a-z_]+)/i.exec(line)
        if (mm && !/^(primary|unique|check|constraint|foreign)$/i.test(mm[1])) add(m[1], mm[1].toLowerCase())
      }
    for (const m of sql.matchAll(/alter table(?: if exists)?\s+(?:public\.)?(\w+)([\s\S]*?);/gi)) {
      for (const a of m[2].matchAll(/add column(?: if not exists)?\s+(\w+)/gi)) add(m[1], a[1].toLowerCase())
      for (const a of m[2].matchAll(/drop column(?: if exists)?\s+(\w+)/gi)) del(m[1], a[1].toLowerCase())
      for (const a of m[2].matchAll(/rename column\s+(\w+)\s+to\s+(\w+)/gi)) { del(m[1], a[1].toLowerCase()); add(m[1], a[2].toLowerCase()) }
    }
  }
  return cols
}

function mapperBody(fn) {
  const start = MAPPERS.indexOf(`function ${fn}`)
  expect(start, `${fn} exists in mappers.js`).toBeGreaterThanOrEqual(0)
  const end = MAPPERS.indexOf('\nfunction ', start + 10)
  return MAPPERS.slice(start, end < 0 ? undefined : end)
}

describe('row mappers cover every migrated column', () => {
  const cols = columnsFromMigrations()
  for (const [table, fn] of Object.entries(TABLE_TO_MAPPER)) {
    it(`${table} → ${fn}`, () => {
      expect(cols[table] && cols[table].size, `no columns found for ${table} — did the migration parser break?`).toBeGreaterThan(3)
      const body = mapperBody(fn)
      const missing = [...cols[table]].filter(c => !new RegExp(`\\b(row|rest)\\.${c}\\b`).test(body) && !(DELIBERATELY_UNMAPPED[table] || []).includes(c))
      expect(missing, `${table} columns the mapper never reads (add them to ${fn}, or to DELIBERATELY_UNMAPPED if they are secrets)`).toEqual([])
    })
  }
  it('the allow-list only names columns that exist (no stale entries)', () => {
    for (const [table, list] of Object.entries(DELIBERATELY_UNMAPPED))
      for (const c of list) expect(cols[table].has(c), `${table}.${c}`).toBe(true)
  })
})
