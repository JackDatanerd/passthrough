// Experts audit A6 (money): migration 0130 against a real Postgres (PGlite).
import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../supabase/migrations')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const U1 = '00000000-0000-4000-8000-0000000000a1', E1 = '00000000-0000-4000-8000-0000000000e1', E2 = '00000000-0000-4000-8000-0000000000e2'
let db, n = 0
const r1 = async (sql, p) => (await db.query(sql, p)).rows[0]
const fn = async (sql, p) => (await r1(`select ${sql} as r`, p)).r

async function mk(state, { pay = 'SUCCESS', expert = E1, delivered = false, price = 11900 } = {}) {
  n += 1
  const pid = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  await db.query(`insert into payments (id, amount_cents, paystack_ref, user_id, status, product_kind) values ($1, $2, $3, $4, $5, 'human_forty_eight_hour')`, [pid, price, `ref-${n}`, U1, pay])
  const { id } = await r1(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested, expert_id, paid_at, promised_deadline_at, internal_deadline_at, delivered_at, auto_accept_at)
    values ($1,$2,$3,'forty_eight_hour',$4,$4,7000,$5,now(),true,true,$6,now(),now()+interval '48 hours',now()+interval '40 hours',$7,$8) returning id`,
    [`HJ-${n}`, pid, U1, price, state, expert, delivered ? new Date().toISOString() : null, delivered ? new Date(Date.now() - 1000).toISOString() : null])
  return { id, pid }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f <= '0130_experts_a6_money.sql')) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h')`)
  for (const [id, em] of [[E1, 'e1'], [E2, 'e2']])
    await db.query(`insert into expert_accounts (id, email, password_hash, display_first_name, display_initial, status, enabled, totp_enabled_at, agreement_signed_at, agreement_version) values ($1,$2,'h','Ex','P','active',true,now(),now(),'v1')`, [id, `${em}@example.com`])
}, 280000)

describe('0130: accept needs a settled payment (B2)', () => {
  it('refuses REFUNDED and DISPUTED payments and writes no pay row', async () => {
    for (const pay of ['REFUNDED', 'DISPUTED']) {
      const { id } = await mk('delivered', { pay, delivered: true })
      expect(await fn(`human_job_accept($1,'customer',null,3)`, [id])).toMatchObject({ ok: false, reason: 'payment_not_settled' })
      expect((await db.query(`select 1 from expert_earnings where job_id=$1`, [id])).rows).toHaveLength(0)
    }
  })
  it('the sweep accepts a SUCCESS job and leaves a refunded-payment one alone', async () => {
    const bad = await mk('delivered', { pay: 'REFUNDED', delivered: true }); const good = await mk('delivered', { delivered: true })
    await fn(`human_job_auto_accept_due(3)`)
    expect((await r1(`select state from human_jobs where id=$1`, [bad.id])).state).toBe('delivered')
    expect((await r1(`select state from human_jobs where id=$1`, [good.id])).state).toBe('accepted')
  })
  it('the 2A transition function cannot slip past it either (trigger)', async () => {
    const { id } = await mk('delivered', { pay: 'REFUNDED', delivered: true })
    await expect(db.query(`update human_jobs set state='accepted' where id=$1`, [id])).rejects.toThrow(/not settled/)
  })
})

describe('0130: reversal nets with its pay row (B7) and the state guard (B4)', () => {
  it('release_at of the reversal equals the pay row', async () => {
    const { id } = await mk('delivered', { delivered: true })
    await fn(`human_job_accept($1,'system',null,3)`, [id]); await fn(`human_job_reverse($1,'refund')`, [id])
    const rows = (await db.query(`select kind, release_at from expert_earnings where job_id=$1 order by kind`, [id])).rows
    expect(rows).toHaveLength(2); expect(rows[0].release_at.getTime()).toBe(rows[1].release_at.getTime())
  })
  it('only-states: a claimed job is not reversed by a cancel that expected offered/open', async () => {
    const { id } = await mk('claimed')
    expect(await fn(`human_job_reverse($1,'cancel', array['offered','open'])`, [id])).toMatchObject({ ok: false, reason: 'state_changed', state: 'claimed' })
    expect((await r1(`select state from human_jobs where id=$1`, [id])).state).toBe('claimed')
    const o = await mk('offered', { expert: null })
    expect(await fn(`human_job_reverse($1,'cancel', array['offered','open'])`, [o.id])).toMatchObject({ ok: true, state: 'cancelled' })
  })
})

describe('0130: payouts (B3, G3, G4)', () => {
  let pid1
  it('a key used by another expert is a conflict, not another expert\'s payout', async () => {
    const { id } = await mk('delivered', { delivered: true }); await fn(`human_job_accept($1,'system',null,0)`, [id])
    const a = await fn(`expert_record_payout($1,'manual','r1','key-aaaa-0001',1000)`, [E1])
    expect(a).toMatchObject({ ok: true, already: false, amount_cents: 7000 }); pid1 = a.payout_id
    expect(await fn(`expert_record_payout($1,'manual','r1','key-aaaa-0001',1000)`, [E1])).toMatchObject({ ok: true, already: true, payout_id: pid1 })
    expect(await fn(`expert_record_payout($1,'manual','r1','key-aaaa-0001',1000)`, [E2])).toMatchObject({ ok: false, reason: 'key_conflict' })
  })
  it('earnings of a DISPUTED payment are frozen out of the payout and the balances', async () => {
    const { id, pid } = await mk('delivered', { delivered: true }); await fn(`human_job_accept($1,'system',null,0)`, [id])
    await db.query(`update payments set status='DISPUTED' where id=$1`, [pid])
    expect(await fn(`expert_record_payout($1,'manual','r2','key-aaaa-0002',1000)`, [E1])).toMatchObject({ ok: false, reason: 'below_minimum', available_cents: 0 })
    expect(await r1(`select * from expert_balances($1)`, [E1])).toMatchObject({ available_cents: 0, frozen_cents: 7000, paid_cents: 7000 })
    await db.query(`update payments set status='SUCCESS' where id=$1`, [pid])
    expect(await fn(`expert_record_payout($1,'manual','r2','key-aaaa-0002',1000)`, [E1])).toMatchObject({ ok: true, amount_cents: 7000 })
  })
  it('a job in state disputed (0129) is frozen out as well', async () => {
    const { id } = await mk('delivered', { delivered: true }); await fn(`human_job_accept($1,'system',null,0)`, [id])
    await db.query(`update human_jobs set state='disputed' where id=$1`, [id])
    expect(await fn(`expert_record_payout($1,'manual','r2b','key-aaaa-0002b',1000)`, [E1])).toMatchObject({ ok: false, reason: 'below_minimum', available_cents: 0 })
    expect(await r1(`select frozen_cents from expert_balances($1)`, [E1])).toMatchObject({ frozen_cents: 7000 })
    await db.query(`update human_jobs set state='accepted' where id=$1`, [id])
    expect(await fn(`expert_record_payout($1,'manual','r2b','key-aaaa-0002b',1000)`, [E1])).toMatchObject({ ok: true, amount_cents: 7000 })
  })
  it('void puts the rows back and leaves the payout on file; a new key pays them again', async () => {
    expect(await fn(`expert_void_payout($1,'sent to the wrong wallet','op')`, [pid1])).toMatchObject({ ok: true, already: false, amount_cents: 7000, rows_restored: 1 })
    expect(await fn(`expert_void_payout($1,'again','op')`, [pid1])).toMatchObject({ ok: true, already: true })
    expect(await fn(`expert_void_payout($1,'x','op')`, [pid1])).toMatchObject({ ok: false, reason: 'reason_required' })
    expect((await r1(`select voided_at is not null as v from expert_payouts where id=$1`, [pid1])).v).toBe(true)
    expect(await fn(`expert_record_payout($1,'manual','r3','key-aaaa-0001',1000)`, [E1])).toMatchObject({ ok: true, already: true, payout_id: pid1 })   // the voided payout's key stays used
    expect(await fn(`expert_record_payout($1,'manual','r3','key-aaaa-0003',1000)`, [E1])).toMatchObject({ ok: true, already: false, amount_cents: 7000 })
  })
  it('adjustments: signs, reason, key, job ownership, idempotency', async () => {
    const A = (kind, amt, job, reason, key) => fn(`expert_record_adjustment($1,$2,$3,$4,$5,$6,'op',0)`, [E2, kind, amt, job, reason, key])
    expect(await A('bonus', -5, null, 'because', 'adj-key-0001')).toMatchObject({ reason: 'bad_amount' })
    expect(await A('penalty', 5, null, 'because', 'adj-key-0001')).toMatchObject({ reason: 'bad_amount' })
    expect(await A('adjustment', 0, null, 'because', 'adj-key-0001')).toMatchObject({ reason: 'bad_amount' })
    expect(await A('pay', 5, null, 'because', 'adj-key-0001')).toMatchObject({ reason: 'bad_kind' })
    expect(await A('bonus', 500, null, '', 'adj-key-0001')).toMatchObject({ reason: 'reason_required' })
    expect(await A('bonus', 500, null, 'because', 'short')).toMatchObject({ reason: 'bad_key' })
    const ok = await A('bonus', 500, null, 'fast turnaround', 'adj-key-0001'); expect(ok).toMatchObject({ ok: true, already: false })
    expect(await A('bonus', 500, null, 'fast turnaround', 'adj-key-0001')).toMatchObject({ ok: true, already: true, earning_id: ok.earning_id })
    expect(await A('bonus', 600, null, 'fast turnaround', 'adj-key-0001')).toMatchObject({ reason: 'key_conflict' })
    const j = await mk('claimed', { expert: E1 }); expect(await A('penalty', -100, j.id, 'late delivery', 'adj-key-0002')).toMatchObject({ reason: 'job_mismatch' })
    expect(await r1(`select * from expert_balances($1)`, [E2])).toMatchObject({ available_cents: 500 })
    expect(await fn(`expert_record_payout($1,'manual','r','key-bbbb-0001',100)`, [E2])).toMatchObject({ ok: true, amount_cents: 500 })
  })
})

describe('0130: late credit (G3)', () => {
  it('only grows, only on a paid live job, never past the price', async () => {
    const { id } = await mk('in_progress', { price: 1000 })
    expect(await fn(`human_job_add_late_credit($1, 400)`, [id])).toMatchObject({ ok: true, late_credit_cents: 400 })
    expect(await fn(`human_job_add_late_credit($1, 700)`, [id])).toMatchObject({ ok: false, reason: 'over_price' })
    expect(await fn(`human_job_add_late_credit($1, 600)`, [id])).toMatchObject({ ok: false, reason: 'over_price' })   // 400 + 600 = the whole price: that is a refund
    expect(await fn(`human_job_add_late_credit($1, 0)`, [id])).toMatchObject({ ok: false, reason: 'bad_amount' })
    const dead = await mk('refunded'); expect(await fn(`human_job_add_late_credit($1, 10)`, [dead.id])).toMatchObject({ ok: false, reason: 'not_credit_eligible' })
  })
})

describe('0130: ledger and grants', () => {
  it('records the migration and the service-role-only grants', async () => {
    expect((await r1(`select count(*)::int c from applied_migrations where version=130`)).c).toBe(1)
    const { rows } = await db.query(`select proname, has_function_privilege('anon', oid, 'execute') a from pg_proc where proname in ('expert_record_adjustment','expert_void_payout','expert_balances','human_job_add_late_credit','human_job_reverse','expert_record_payout')`)
    expect(rows).toHaveLength(6); rows.forEach(r => expect(r.a).toBe(false))
  })
})
