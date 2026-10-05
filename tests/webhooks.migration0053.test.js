import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Static guard for migration 0053 (Webhooks round 4). The behaviour itself was exercised against a real
// Postgres (see the pull notes); these pin the properties that must not regress silently.
const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/0053_webhooks_round4.sql'), 'utf8')
const fnBody = sql.slice(sql.indexOf('create or replace function record_refund_and_total'), sql.indexOf('$$;', sql.indexOf('as $$')))

describe('migration 0053', () => {
  it('B1: record_refund_and_total never writes webhook_events (the caller marks PROCESSED after the work)', () => {
    expect(fnBody).not.toMatch(/update\s+webhook_events/i)
    expect(fnBody).toMatch(/for update/i)               // still serialises concurrent refunds on the payment row
  })
  it('B3: refund amounts persist in a table the 90-day inbox prune does not touch, unique per payment + event', () => {
    expect(sql).toMatch(/create table if not exists payment_refunds/)
    expect(sql).toMatch(/unique \(payment_id, event_key\)/)
    expect(fnBody).toMatch(/from payment_refunds/)
    expect(fnBody).not.toMatch(/from webhook_events\s+where\s+event_type/i)
  })
  it('replaces the 0042 three-argument function instead of overloading it, and locks EXECUTE down like 0023', () => {
    expect(sql).toMatch(/drop function if exists record_refund_and_total\(uuid, text, uuid\)/)
    expect(sql).toMatch(/revoke execute on function record_refund_and_total\(uuid, text, uuid, boolean\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant\s+execute on function record_refund_and_total\(uuid, text, uuid, boolean\) to service_role/)
  })
  it('RLS is enabled on the new table (service-role only, see 0014)', () => {
    expect(sql).toMatch(/alter table payment_refunds enable row level security/)
  })
})
