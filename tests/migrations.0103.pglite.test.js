import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0103 (webhooks round 24) against a real Postgres (PGlite): two nullable timestamp columns on payments, nothing backfilled,
// nothing about an existing row changes, a re-run changes nothing, and it records itself.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = '0103_webhooks_round24.sql'
const U1 = '77777777-7777-7777-7777-777777777701'

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
  await db.exec(`insert into payments (amount_cents, paystack_ref, user_id, status) values (2900, 'before', '${U1}', 'DISPUTED')`)
  await db.exec(read(MIG))
}, 240000)
afterAll(async () => { await db?.close() })

describe('0103: refund_failed_at and dispute_checked_at', () => {
  it('both columns exist as nullable timestamptz with no default, and nothing is backfilled', async () => {
    const cols = await q(`select column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_name = 'payments' and column_name in ('refund_failed_at', 'dispute_checked_at') order by column_name`)
    expect(cols).toEqual([
      { column_name: 'dispute_checked_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
      { column_name: 'refund_failed_at', data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null },
    ])
    const [row] = await q(`select refund_failed_at, dispute_checked_at, status from payments where paystack_ref = 'before'`)
    expect(row).toEqual({ refund_failed_at: null, dispute_checked_at: null, status: 'DISPUTED' })
  })
  it('the statements the Worker runs work: stamp a SUCCESS / DISPUTED payment only, clear it, rotate by dispute_checked_at', async () => {
    await db.exec(`insert into payments (amount_cents, paystack_ref, user_id, status) values (2900, 'ok', '${U1}', 'SUCCESS'), (2900, 'gone', '${U1}', 'REFUNDED')`)
    const stamped = await q(`update payments set refund_failed_at = now() where status in ('SUCCESS','DISPUTED') and paystack_ref in ('ok','gone','before') returning paystack_ref`)
    expect(stamped.map(r => r.paystack_ref).sort()).toEqual(['before', 'ok'])
    await db.exec(`update payments set refund_failed_at = null where paystack_ref = 'ok'`)
    expect((await q(`select refund_failed_at from payments where paystack_ref = 'ok'`))[0].refund_failed_at).toBeNull()
    await db.exec(`update payments set dispute_checked_at = now() where paystack_ref = 'before'`)
    await db.exec(`insert into payments (amount_cents, paystack_ref, user_id, status, disputed_at) values (2900, 'never-checked', '${U1}', 'DISPUTED', now())`)
    const order = await q(`select paystack_ref from payments where status = 'DISPUTED' order by dispute_checked_at asc nulls first`)
    expect(order.map(r => r.paystack_ref)).toEqual(['never-checked', 'before'])
  })
  it('the rotation index is partial on DISPUTED payments', async () => {
    const [ix] = await q(`select indexdef from pg_indexes where indexname = 'idx_payments_dispute_rotation'`)
    expect(ix.indexdef).toMatch(/dispute_checked_at/)
    expect(ix.indexdef).toMatch(/DISPUTED/)
  })
  it('a re-run changes nothing', async () => {
    await db.exec(read(MIG))
    expect((await q(`select count(*)::int n from payments`))[0].n).toBe(4)
    expect((await q(`select count(*)::int n from applied_migrations where version = 103`))[0].n).toBe(1)
  })
  it('records itself and the schema version', async () => {
    expect((await q(`select name from applied_migrations where version = 103`))[0].name).toBe('0103_webhooks_round24')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBeGreaterThanOrEqual(103)
  })
})
