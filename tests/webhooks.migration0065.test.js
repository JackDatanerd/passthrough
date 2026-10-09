import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Static guard for migration 0065 (Webhooks round 7).
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0065_webhooks_round7.sql'), 'utf8')

describe('migration 0065', () => {
  it('B3: adds the re-drive counter as a non-null integer defaulting to 0, idempotently', () => {
    expect(sql).toMatch(/alter table webhook_events add column if not exists redrives int not null default 0/)
  })
  it('G3: clears the stored reusable card tokens', () => {
    expect(sql).toMatch(/update payments set paystack_auth_code = null where paystack_auth_code is not null/)
  })
  it('G4: reduces stored dispute payloads to the same allowlist the app keeps', () => {
    for (const k of ['id', 'status', 'resolution', 'refund_amount', 'currency', 'category', 'reference', 'transaction_reference', 'due_at', 'resolved_at', 'created_at'])
      expect(sql).toContain(`'${k}'`)
    expect(sql.replace(/--.*$/gm, '')).not.toMatch(/messages|history|attachments|customer/)   // (code only — the header comment names them)
    expect(sql).toMatch(/where event_type like 'charge\.dispute%' and payload is not null/)
  })
  it('ends with the schema_version bump to 65', () => {
    expect(sql.trim().split(/\n/).slice(-3).join('\n')).toMatch(/'version', 65/)
  })
})
