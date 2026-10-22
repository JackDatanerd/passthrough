import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0106 on a REAL Postgres (PGlite): refund payloads are cut down to the allow-list, other rows are untouched, a re-run changes nothing.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
let db
const failures = []
const rows = async (sql, params) => (await db.query(sql, params)).rows

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
    try { await db.exec(sql) } catch (e) { failures.push(`${f}: ${e.message}`) }
  }
}, 120000)

const insert = (key, type, payload) => db.query(
  `insert into webhook_events (provider, event_key, event_type, status, payload) values ('paystack', $1, $2, 'PROCESSED', $3::jsonb)`, [key, type, JSON.stringify(payload)])
const payloadOf = async key => (await rows(`select payload from webhook_events where event_key = $1`, [key]))[0].payload
const rerun = () => db.exec(fs.readFileSync(path.join(dir, '0106_webhooks_round25.sql'), 'utf8'))

describe('migration 0106', () => {
  it('applies with every migration before and after it, and records itself', async () => {
    expect(failures).toEqual([])
    expect((await rows(`select name from applied_migrations where version = 106`))[0]?.name).toBe('0106_webhooks_round25')
    const v = (await rows(`select value from system_state where key = 'schema_version'`))[0].value
    expect(Number(v.version)).toBeGreaterThanOrEqual(106)
  })
  it('cuts a stored refund payload to the allow-list and keeps what record_refund_and_total reads', async () => {
    await insert('refund.processed:1', 'refund.processed', { event: 'refund.processed', data: { id: 1, amount: 500, currency: 'USD', status: 'processed',
      transaction_reference: 'r1', refund_reference: null, refunded_by: 'staff@merchant.com', customer_note: 'call 0712 345 678', merchant_note: 'internal',
      customer: { email: 'a@b.co' }, metadata: { x: 1 }, transaction: { id: 7, reference: 'r1', amount: 900, currency: 'USD', authorization: { last4: '4081' } } } })
    await rerun()
    const p = await payloadOf('refund.processed:1')
    expect(p).toEqual({ event: 'refund.processed', data: { id: 1, amount: 500, currency: 'USD', status: 'processed', transaction_reference: 'r1', transaction: { id: 7, reference: 'r1', amount: 900, currency: 'USD' } } })
    expect(JSON.stringify(p)).not.toMatch(/staff@|0712|internal|a@b\.co/)
  })
  it('keeps a bare transaction string', async () => {
    await insert('refund.processed:2', 'refund.processed', { event: 'refund.processed', data: { id: 2, amount: 10, transaction: 'r9', customer_note: 'x' } })
    await rerun()
    expect((await payloadOf('refund.processed:2')).data).toEqual({ id: 2, amount: 10, transaction: 'r9' })
  })
  it('leaves a clean refund row, other event types and body-less rows alone, and a re-run changes nothing', async () => {
    const clean = { event: 'refund.processed', data: { id: 3, amount: 5 } }
    const charge = { event: 'charge.success', data: { id: 4, amount: 5, metadata: { userId: 'u' }, customer_note: 'kept: not a refund' } }
    await insert('refund.processed:3', 'refund.processed', clean)
    await insert('charge.success:4', 'charge.success', charge)
    await db.query(`insert into webhook_events (provider, event_key, event_type, status) values ('paystack', 'refund.failed:5', 'refund.failed', 'PROCESSED')`)
    await rerun(); await rerun()
    expect(await payloadOf('refund.processed:3')).toEqual(clean)
    expect(await payloadOf('charge.success:4')).toEqual(charge)
    expect((await rows(`select payload from webhook_events where event_key = 'refund.failed:5'`))[0].payload).toBeNull()
  })
})
