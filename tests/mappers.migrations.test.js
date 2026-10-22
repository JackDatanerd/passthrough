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
  // saved_profile_prev (0075): the one-step-back resume snapshot — a full resume payload the profile endpoints read directly, never part of the user object every request carries.
  users: ['email_change_done_token', 'saved_profile_prev', 'email_bounced_at', 'email_bounce_type'],   // 0086: surfaced as `emailBounce` by getMe and the admin user endpoints, never by the mapper
  // Homepage outcomes (0070): follow-up email bookkeeping only the hourly sweep reads — never part of a scan the API returns.
  // display_score (0076): generated ORDER BY key for the dashboard score sort; the row already exposes atsScore / fixAtsScore it is derived from.
  // prompt_version / letter_prompt_version (0092): which prompt generation wrote the delivery - read by the prompt_outcome_rates view and by hand, never part of the API shape.
  // fix_job_lock_token (0089): the per-job lease token claim_fix_job stores and release_fix_job compares - only the job that owns the lease ever holds it.
  scans: ['outcome_prompted_at', 'outcome_prompt_attempts', 'display_score', 'fix_job_lock_token', 'prompt_version', 'letter_prompt_version', 'fix_model', 'letter_model'],
  // Both partner bearer tokens are secrets: the payout link (write; stored as payout_token_hash since 0087, payout_details_token is legacy) and dashboard_token (read-only, migration 0055).
  // previous_emails (0080): the addresses a partner used to have, kept ONLY so erasure can reach the mail history sent to them — personal data the
  // admin/partner API never needs (partners.controller.js reads it directly for the erasure).
  // 0086: reversal_notice_sent_at is the claim that makes the buyer's reversal email go out once; dispute_id is Paystack's id, read only by the admin dispute actions.
  payments: ['reversal_notice_sent_at', 'dispute_id', 'dispute_evidence_id', 'dispute_checked_at', 'referral_commission_rate'],   // 0107: the partner's rate AT CHECKOUT, read back only by recordConversion
    // 0103: dispute_checked_at is the dispute sweep's own rotation marker   // 0088: dispute_evidence_id is '<disputeId>:<evidenceId>', read only by the admin contest action
  // usage_released_at (0100): stamps that a sale's referral-code slot was given back (so a retried release is a no-op) - bookkeeping only the usage RPCs read.
  commission_ledger: ['usage_released_at'],
    // 0107: dashboard_token_version is the counter the derived dashboard link is signed over (the link itself is never stored).
  partners: ['payout_details_token', 'payout_token_hash', 'dashboard_token', 'dashboard_token_version', 'previous_emails'],
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
  // Comments are stripped: a column merely MENTIONED in one ("row.paid_at …") is not a column that is read.
  return MAPPERS.slice(start, end < 0 ? undefined : end).replace(/\/\/.*$/gm, '')
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
