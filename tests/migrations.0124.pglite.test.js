import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Migration 0124 (Experts Phase 1 pilot) against a real Postgres (PGlite): tables only ADD, RLS on with no policy, every function
// closed to anon / authenticated, and the guarantees that live in the database: one winner on assignment, an expert reads and saves
// only a job assigned to them (and every attempt is logged), one pay row per accepted job, one reversal per refund, one payout per key.

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const MIG = files.find(f => f.startsWith('0124'))
const NEW_TABLES = ['expert_accounts', 'expert_audit_log', 'expert_earnings', 'expert_payouts', 'human_jobs', 'job_deliveries', 'job_documents', 'job_events', 'job_locked_values', 'job_materials', 'job_questions']
const FUNCTIONS = ['human_job_assign', 'human_job_unassign', 'human_job_expert_read', 'human_job_expert_save', 'human_job_accept', 'human_job_reverse', 'expert_record_payout',
  'human_job_expert_baseline', 'human_job_confirm_payment', 'human_job_ask', 'human_job_resume_from_wait', 'human_job_answer', 'human_job_expire_questions', 'human_job_submit', 'human_job_return_to_expert',
  'human_job_deliver', 'human_job_request_revision', 'human_job_rate', 'human_job_auto_accept_due']
const U1 = '00000000-0000-4000-8000-000000000001'
const E1 = '00000000-0000-4000-8000-0000000000e1'
const E2 = '00000000-0000-4000-8000-0000000000e2'
const OP = '00000000-0000-4000-8000-0000000000f1'

let db, before
const q = async (sql, params) => (await db.query(sql, params)).rows
const fails = async (sql, params) => { try { await db.query(sql, params) } catch (e) { return e.message } return null }
const cols = async () => q(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' order by 1, 2`)
let n = 0
async function newJob(state = 'offered', over = {}) {
  n++
  const pid = `00000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`
  const jid = `00000000-0000-4000-8000-${String(2000 + n).padStart(12, '0')}`
  await db.query(`insert into payments (id, amount_cents, paystack_ref, user_id, status, product_kind) values ($1, 11900, $2, $3, 'SUCCESS', 'human_forty_eight_hour')`, [pid, `ref-${n}`, U1])
  await db.query(`insert into human_jobs (id, job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested, expert_id, delivered_at)
                  values ($1, $2, $3, $4, 'forty_eight_hour', 11900, 11900, 7000, $5, now(), true, true, $6, $7)`,
    [jid, `HJ-T${n}`, pid, U1, state, over.expert_id ?? null, over.delivered_at ?? null])
  return jid
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h')`)
  before = await cols()
  await db.exec(read(MIG))
  for (const [id, email] of [[E1, 'e1@example.com'], [E2, 'e2@example.com']]) {
    await db.query(`insert into expert_accounts (id, email, password_hash, display_first_name, display_initial, status, enabled, totp_enabled_at, agreement_signed_at, agreement_version)
                    values ($1, $2, 'h', 'Ex', 'P', 'active', true, now(), now(), 'v1')`, [id, email])
  }
}, 240000)

describe('migration 0124', () => {
  it('records itself in the ledger and moves schema_version to 124 (never backwards)', async () => {
    expect((await q(`select name from applied_migrations where version = 124`))[0].name).toBe('0124_experts_phase1_pilot')
    expect((await q(`select (value->>'version')::int v from system_state where key = 'schema_version'`))[0].v).toBe(124)
  })

  it('only adds: every column that existed is unchanged; the new tables are exactly the expected ones; payments gains only product_kind', async () => {
    const after = await cols()
    const key = r => `${r.table_name}.${r.column_name}:${r.data_type}`
    const afterSet = new Set(after.map(key))
    for (const r of before) expect(afterSet.has(key(r)), key(r)).toBe(true)
    const added = [...new Set(after.map(r => r.table_name))].filter(t => !before.some(b => b.table_name === t)).sort()
    expect(added).toEqual(NEW_TABLES)
    const beforeKeys = new Set(before.map(key))
    expect(after.filter(r => !beforeKeys.has(key(r)) && !NEW_TABLES.includes(r.table_name)).map(key)).toEqual(['payments.product_kind:text'])
  })

  it('every new table has row level security on, no policy, and no grant to anon / authenticated', async () => {
    for (const t of NEW_TABLES) {
      expect((await q(`select relrowsecurity from pg_class where relname = $1`, [t]))[0].relrowsecurity, t).toBe(true)
      expect(await q(`select 1 from pg_policies where tablename = $1`, [t]), t).toHaveLength(0)
      expect(await q(`select grantee from information_schema.role_table_grants where table_name = $1 and grantee in ('anon','authenticated')`, [t]), t).toHaveLength(0)
    }
  })

  it('every new function has execute revoked from public / anon / authenticated and granted to the service role', async () => {
    for (const f of FUNCTIONS) {
      const r = await q(`select oid::regprocedure::text sig from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [f])
      expect(r, f).toHaveLength(1)
      const [{ anon, auth, svc }] = await q(`select has_function_privilege('anon', $1::regprocedure, 'execute') anon, has_function_privilege('authenticated', $1::regprocedure, 'execute') auth, has_function_privilege('service_role', $1::regprocedure, 'execute') svc`, [r[0].sig])
      expect({ f, anon, auth, svc }).toEqual({ f, anon: false, auth: false, svc: true })
    }
  })

  it('seeds the settings with the section 15 defaults, polish off, cap 15', async () => {
    const s = (await q(`select value from system_state where key = 'human_pilot'`))[0].value
    expect(s.prices).toEqual({ polish: 5900, seven_day: 8900, forty_eight_hour: 11900, twenty_four_hour: 14900, cover_letter: 2900 })
    expect(s.pay).toEqual({ polish: 2500, seven_day: 5000, forty_eight_hour: 7000, twenty_four_hour: 9000, cover_letter: 1800 })
    expect(s.tiers_enabled).toEqual({ polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true })
    expect(s.pilot_cap_orders).toBe(15)
  })

  it('payments.product_kind accepts the four human kinds and null, nothing else; existing rows are untouched (null)', async () => {
    expect(await fails(`insert into payments (amount_cents, paystack_ref, user_id, product_kind) values (1, 'bad-kind', '${U1}', 'something')`)).toMatch(/check/i)
    await db.query(`insert into payments (amount_cents, paystack_ref, user_id) values (4900, 'plain-1', '${U1}')`)
    expect((await q(`select product_kind from payments where paystack_ref = 'plain-1'`))[0].product_kind).toBeNull()
  })

  it('a job has an expert if and only if its state says so; one job per payment; a job needs both attestations', async () => {
    expect(await fails(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested)
      select 'HJ-X1', id, '${U1}', 'seven_day', 8900, 8900, 5000, 'in_progress', now(), true, true from payments where paystack_ref = 'plain-1'`)).toMatch(/check/i)
    const jid = await newJob('offered')
    const pid = (await q(`select payment_id from human_jobs where id = $1`, [jid]))[0].payment_id
    expect(await fails(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, terms_consent_at, age_attested, rights_attested) values ('HJ-DUP', $1, '${U1}', 'seven_day', 1, 1, 1, now(), true, true)`, [pid])).toMatch(/unique|duplicate/i)
    expect(await fails(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, terms_consent_at, age_attested, rights_attested) select 'HJ-NA', id, '${U1}', 'seven_day', 1, 1, 1, now(), false, true from payments where paystack_ref = 'plain-1'`)).toMatch(/check/i)
  })

  describe('assignment', () => {
    it('only an offered job can be assigned; the first call wins, the second is refused; the event is written', async () => {
      const jid = await newJob('offered')
      const a = (await q(`select human_job_assign($1, $2, $3, 2) r`, [jid, E1, OP]))[0].r
      expect(a.ok).toBe(true)
      const b = (await q(`select human_job_assign($1, $2, $3, 2) r`, [jid, E2, OP]))[0].r
      expect(b).toMatchObject({ ok: false, reason: 'not_assignable' })
      const j = (await q(`select state, expert_id from human_jobs where id = $1`, [jid]))[0]
      expect(j).toEqual({ state: 'claimed', expert_id: E1 })
      expect((await q(`select kind from job_events where job_id = $1`, [jid])).map(r => r.kind)).toEqual(['taken'])
    })
    it('refuses an expert who is disabled, has no two-factor, or has not signed the agreement; and respects the concurrent cap', async () => {
      await db.query(`insert into expert_accounts (id, email, password_hash, display_first_name, display_initial, status, enabled) values ('00000000-0000-4000-8000-0000000000e3', 'e3@example.com', 'h', 'No', 'T', 'active', false)`)
      const jid = await newJob('offered')
      expect((await q(`select human_job_assign($1, '00000000-0000-4000-8000-0000000000e3', $2, 2) r`, [jid, OP]))[0].r.reason).toBe('not_eligible')
      await db.query(`update expert_accounts set enabled = true where id = '00000000-0000-4000-8000-0000000000e3'`)
      expect((await q(`select human_job_assign($1, '00000000-0000-4000-8000-0000000000e3', $2, 2) r`, [jid, OP]))[0].r.reason).toBe('two_factor_missing')
      await db.query(`update expert_accounts set totp_enabled_at = now() where id = '00000000-0000-4000-8000-0000000000e3'`)
      expect((await q(`select human_job_assign($1, '00000000-0000-4000-8000-0000000000e3', $2, 2) r`, [jid, OP]))[0].r.reason).toBe('agreement_missing')
      // cap: E2 takes two, the third is refused
      for (let i = 0; i < 2; i++) expect((await q(`select human_job_assign($1, $2, $3, 2) r`, [await newJob('offered'), E2, OP]))[0].r.ok).toBe(true)
      expect((await q(`select human_job_assign($1, $2, $3, 2) r`, [await newJob('offered'), E2, OP]))[0].r.reason).toBe('cap')
    })
    it('unassign returns a claimed job to offered with no expert', async () => {
      const jid = await newJob('offered')
      await q(`select human_job_assign($1, $2, $3, 9) r`, [jid, E1, OP])
      expect((await q(`select human_job_unassign($1, $2, 'cannot do it') r`, [jid, OP]))[0].r.ok).toBe(true)
      expect((await q(`select state, expert_id from human_jobs where id = $1`, [jid]))[0]).toEqual({ state: 'offered', expert_id: null })
    })
  })

  describe('an expert reads and saves only a job assigned to them', () => {
    it('the assigned expert reads it (and the read is logged); another expert gets null (and the attempt is logged)', async () => {
      const jid = await newJob('offered')
      await q(`select human_job_assign($1, $2, $3, 9) r`, [jid, E1, OP])
      await db.query(`insert into job_documents (job_id, kind, version, body) values ($1, 'source', 1, '{"name":"[[name]]"}')`, [jid])
      const ok = (await q(`select human_job_expert_read($1, $2, 7) r`, [jid, E1]))[0].r
      expect(ok.job.job_number).toMatch(/^HJ-T/)
      expect(ok.source).toEqual({ name: '[[name]]' })
      const no = (await q(`select human_job_expert_read($1, $2, 7) r`, [jid, E2]))[0].r
      expect(no).toBeNull()
      const log = await q(`select actor_id, action from expert_audit_log where target_id = $1 order by id`, [jid])
      expect(log).toEqual([{ actor_id: E1, action: 'view_job' }, { actor_id: E2, action: 'denied_job_access' }])
    })
    it('an unassigned or unknown job is unreadable; access ends once the revision window after delivery has passed', async () => {
      expect((await q(`select human_job_expert_read($1, $2, 7) r`, [await newJob('offered'), E1]))[0].r).toBeNull()
      expect((await q(`select human_job_expert_read('00000000-0000-4000-8000-00000000dead', $1, 7) r`, [E1]))[0].r).toBeNull()
      const recent = await newJob('delivered', { expert_id: E1, delivered_at: new Date().toISOString() })
      expect((await q(`select human_job_expert_read($1, $2, 7) r`, [recent, E1]))[0].r).not.toBeNull()
      const old = await newJob('accepted', { expert_id: E1, delivered_at: new Date(Date.now() - 8 * 86400000).toISOString() })
      expect((await q(`select human_job_expert_read($1, $2, 7) r`, [old, E1]))[0].r).toBeNull()
    })
    it('save is compare-and-set, only in a working state, only by the assigned expert; the first save starts the job and counts seconds (capped)', async () => {
      const jid = await newJob('offered')
      await q(`select human_job_assign($1, $2, $3, 9) r`, [jid, E1, OP])
      expect((await q(`select human_job_expert_save($1, $2, 0, '{"v":1}', null, 5000) r`, [jid, E2]))[0].r.reason).toBe('not_allowed')
      const s1 = (await q(`select human_job_expert_save($1, $2, 0, '{"v":1}', null, 5000) r`, [jid, E1]))[0].r
      expect(s1).toEqual({ ok: true, version: 1 })
      expect((await q(`select human_job_expert_save($1, $2, 0, '{"v":2}', null, 10) r`, [jid, E1]))[0].r).toMatchObject({ ok: false, reason: 'conflict', current_version: 1 })
      expect((await q(`select human_job_expert_save($1, $2, 1, '{"v":2}', null, 10) r`, [jid, E1]))[0].r.version).toBe(2)
      const j = (await q(`select state, active_edit_seconds from human_jobs where id = $1`, [jid]))[0]
      expect(j).toEqual({ state: 'in_progress', active_edit_seconds: 610 })
      await db.query(`update human_jobs set state = 'in_review' where id = $1`, [jid])
      expect((await q(`select human_job_expert_save($1, $2, 2, '{"v":3}', null, 1) r`, [jid, E1]))[0].r.reason).toBe('not_allowed')
    })
  })

  describe('money', () => {
    it('acceptance writes exactly one pay row (repeat and concurrent-style repeat change nothing) and none for a job that is not delivered', async () => {
      const early = await newJob('in_review', { expert_id: E1 })
      expect((await q(`select human_job_accept($1, 'customer', null, 3) r`, [early]))[0].r.reason).toBe('not_delivered')
      const jid = await newJob('delivered', { expert_id: E1, delivered_at: new Date().toISOString() })
      expect((await q(`select human_job_accept($1, 'customer', $2, 3) r`, [jid, U1]))[0].r).toEqual({ ok: true, already: false })
      expect((await q(`select human_job_accept($1, 'system', null, 3) r`, [jid]))[0].r).toEqual({ ok: true, already: true })
      const rows = await q(`select kind, amount_cents, expert_id from expert_earnings where job_id = $1`, [jid])
      expect(rows).toEqual([{ kind: 'pay', amount_cents: 7000, expert_id: E1 }])
      expect(await fails(`insert into expert_earnings (expert_id, job_id, kind, amount_cents, release_at) values ($1, $2, 'pay', 7000, now())`, [E1, jid])).toMatch(/unique|duplicate/i)
    })
    it('a refund after acceptance reverses the pay once; a refund before any work cancels with nothing to reverse; repeats change nothing', async () => {
      const jid = await newJob('delivered', { expert_id: E1, delivered_at: new Date().toISOString() })
      await q(`select human_job_accept($1, 'system', null, 3) r`, [jid])
      const r1 = (await q(`select human_job_reverse($1, 'refund') r`, [jid]))[0].r
      expect(r1).toMatchObject({ ok: true, already: false, state: 'refunded' })
      expect((await q(`select human_job_reverse($1, 'refund') r`, [jid]))[0].r.already).toBe(true)
      expect((await q(`select sum(amount_cents)::int s, count(*)::int c from expert_earnings where job_id = $1`, [jid]))[0]).toEqual({ s: 0, c: 2 })
      const fresh = await newJob('offered')
      expect((await q(`select human_job_reverse($1, 'refund') r`, [fresh]))[0].r).toMatchObject({ ok: true, state: 'cancelled' })
      expect((await q(`select count(*)::int c from expert_earnings where job_id = $1`, [fresh]))[0].c).toBe(0)
    })
    it('a payout run sums what is available (hold passed, reversals netted), is idempotent on its key, and refuses below the minimum', async () => {
      await db.query(`insert into expert_accounts (id, email, password_hash, display_first_name, display_initial, status, enabled) values ('00000000-0000-4000-8000-0000000000e4', 'e4@example.com', 'h', 'Pay', 'E', 'active', true)`)
      const E4 = '00000000-0000-4000-8000-0000000000e4'
      const small = (await q(`select expert_record_payout($1, 'mpesa', 'r0', 'k-small', 2500) r`, [E4]))[0].r
      expect(small).toMatchObject({ ok: false, reason: 'below_minimum', available_cents: 0 })
      await db.query(`insert into expert_earnings (expert_id, kind, amount_cents, release_at) values ($1, 'bonus', 5000, now() - interval '1 day'), ($1, 'penalty', -500, now() - interval '1 day'), ($1, 'bonus', 9999, now() + interval '2 days')`, [E4])
      const a = (await q(`select expert_record_payout($1, 'mpesa', 'r1', 'k-1', 2500) r`, [E4]))[0].r
      expect(a).toMatchObject({ ok: true, already: false, amount_cents: 4500 })
      const b = (await q(`select expert_record_payout($1, 'mpesa', 'r1', 'k-1', 2500) r`, [E4]))[0].r
      expect(b).toMatchObject({ ok: true, already: true, amount_cents: 4500 })
      expect((await q(`select count(*)::int c from expert_payouts where expert_id = $1`, [E4]))[0].c).toBe(1)
      expect((await q(`select count(*)::int c from expert_earnings where expert_id = $1 and payout_id is null`, [E4]))[0].c).toBe(1)   // the one still on hold
    })
  })

  describe('lifecycle (payment, questions, review, delivery, revision, rating, acceptance)', () => {
    const call = async (sql, params) => (await q(sql, params))[0].r
    async function paidJob() {   // a job in awaiting_payment with a payment, ready for confirm
      const jid = await newJob('awaiting_payment')
      const pid = (await q(`select payment_id from human_jobs where id = $1`, [jid]))[0].payment_id
      return { jid, pid }
    }
    async function working(jid, expert = E1) {
      await q(`select human_job_assign($1, $2, $3, 9) r`, [jid, expert, OP])
      await q(`select human_job_expert_save($1, $2, 0, '{"summary":"x"}', null, 30) r`, [jid, expert])
    }

    it('payment confirmation moves awaiting_payment to offered ONCE; repeats change nothing; deadlines are stored', async () => {
      const { jid, pid } = await paidJob()
      const p = new Date(Date.now() + 48 * 3600e3).toISOString(), i = new Date(Date.now() + 44 * 3600e3).toISOString()
      expect(await call(`select human_job_confirm_payment($1, $2, $3) r`, [pid, p, i])).toMatchObject({ ok: true, already: false, state: 'offered' })
      const v1 = (await q(`select version, paid_at from human_jobs where id = $1`, [jid]))[0]
      for (let k = 0; k < 3; k++) expect(await call(`select human_job_confirm_payment($1, $2, $3) r`, [pid, p, i])).toMatchObject({ ok: true, already: true })
      expect((await q(`select version, paid_at from human_jobs where id = $1`, [jid]))[0]).toEqual(v1)
      expect((await q(`select count(*)::int c from job_events where job_id = $1 and kind = 'paid'`, [jid]))[0].c).toBe(1)
      expect((await call(`select human_job_confirm_payment('00000000-0000-4000-8000-00000000beef', $1, $2) r`, [p, i])).reason).toBe('no_job')
    })

    it('a question stops the clock; the answer resumes work and pushes both deadlines back by the wait; at most three; only the assigned expert asks', async () => {
      const jid = await newJob('offered'); await working(jid)
      await db.query(`update human_jobs set promised_deadline_at = '2030-01-02T00:00:00Z', internal_deadline_at = '2030-01-01T20:00:00Z' where id = $1`, [jid])
      expect((await call(`select human_job_ask($1, $2, 'Which role?', null, 24, 3) r`, [jid, E2])).reason).toBe('not_allowed')
      const a = await call(`select human_job_ask($1, $2, 'Which role?', null, 24, 3) r`, [jid, E1])
      expect(a).toMatchObject({ ok: true, seq: 1 })
      expect((await q(`select state from human_jobs where id = $1`, [jid]))[0].state).toBe('waiting_customer')
      await db.query(`update human_jobs set pause_started_at = now() - interval '2 hours' where id = $1`, [jid])
      expect((await call(`select human_job_answer($1, $2, $3, 'The senior one') r`, [jid, '00000000-0000-4000-8000-0000000000aa', a.question_id])).reason).toBe('not_found')
      expect(await call(`select human_job_answer($1, $2, $3, 'The senior one') r`, [jid, U1, a.question_id])).toEqual({ ok: true, already: false })
      expect(await call(`select human_job_answer($1, $2, $3, 'again') r`, [jid, U1, a.question_id])).toMatchObject({ ok: true, already: true })
      const j = (await q(`select state, paused_seconds, to_char(promised_deadline_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI') p, pause_started_at from human_jobs where id = $1`, [jid]))[0]
      expect(j.state).toBe('in_progress'); expect(j.paused_seconds).toBeGreaterThanOrEqual(7200); expect(j.paused_seconds).toBeLessThan(7210)
      expect(j.p).toBe('2030-01-02T02:00'); expect(j.pause_started_at).toBeNull()
      expect((await call(`select human_job_ask($1, $2, 'Second?', null, 24, 3) r`, [jid, E1])).seq).toBe(2)
      expect((await call(`select human_job_ask($1, $2, 'Asked while already waiting', null, 24, 3) r`, [jid, E1])).reason).toBe('not_allowed')
    })

    it('an unanswered question expires and the job resumes; a fourth question is refused', async () => {
      const jid = await newJob('offered'); await working(jid)
      await db.query(`update human_jobs set promised_deadline_at = now() + interval '2 days', internal_deadline_at = now() + interval '1 day' where id = $1`, [jid])
      for (let n = 1; n <= 3; n++) {
        expect((await call(`select human_job_ask($1, $2, 'q', null, 24, 3) r`, [jid, E1])).seq).toBe(n)
        await db.query(`update job_questions set answer_deadline_at = now() - interval '1 minute' where job_id = $1 and status = 'pending'`, [jid])
        await db.query(`update human_jobs set pause_started_at = now() - interval '1 hour' where id = $1`, [jid])
        expect((await q(`select human_job_expire_questions() r`))[0].r).toBeGreaterThanOrEqual(1)
        expect((await q(`select state from human_jobs where id = $1`, [jid]))[0].state).toBe('in_progress')
      }
      expect((await call(`select human_job_ask($1, $2, 'q', null, 24, 3) r`, [jid, E1])).reason).toBe('limit')
      expect((await q(`select status from job_questions where job_id = $1 order by seq`, [jid])).map(r => r.status)).toEqual(['expired', 'expired', 'expired'])
    })

    it('submit -> return -> submit -> deliver: delivery writes version 1 and starts the 72-hour clock; only an in_review job can be delivered', async () => {
      const jid = await newJob('offered')
      expect((await call(`select human_job_submit($1, $2) r`, [jid, E1])).reason).toBe('not_allowed')
      await working(jid)
      expect((await call(`select human_job_deliver($1, $2, '{}', 40, 80, null, null, null, 's', 'n', 72) r`, [jid, OP])).reason).toBe('not_in_review')
      expect((await call(`select human_job_submit($1, $2) r`, [jid, E2])).reason).toBe('not_allowed')
      expect((await call(`select human_job_submit($1, $2) r`, [jid, E1])).ok).toBe(true)
      expect((await call(`select human_job_return_to_expert($1, $2, 'tighten the summary') r`, [jid, OP])).ok).toBe(true)
      expect((await q(`select state from human_jobs where id = $1`, [jid]))[0].state).toBe('in_progress')
      await q(`select human_job_submit($1, $2) r`, [jid, E1])
      const d = await call(`select human_job_deliver($1, $2, '{"docx":"k1"}', 40, 80, '{"ok":true}', '[]', '[]', 'summary', 'note', 72) r`, [jid, OP])
      expect(d).toMatchObject({ ok: true, delivery_version: 1 })
      const j = (await q(`select state, score_before, score_after, extract(epoch from (auto_accept_at - delivered_at))::int / 3600 gap_hours from human_jobs where id = $1`, [jid]))[0]
      expect(j).toMatchObject({ state: 'delivered', score_before: 40, score_after: 80 })
      expect(j.gap_hours).toBe(72)
      expect((await call(`select human_job_deliver($1, $2, '{}', 40, 80, null, null, null, 's', 'n', 72) r`, [jid, OP])).reason).toBe('not_in_review')
    })

    it('one revision only, in the window, by the owner: it returns to the same expert, redelivery is version 2, and the revision cannot be requested twice', async () => {
      const jid = await newJob('offered'); await working(jid)
      await q(`select human_job_submit($1, $2) r`, [jid, E1])
      await q(`select human_job_deliver($1, $2, '{}', 40, 80, null, null, null, 's', 'n', 72) r`, [jid, OP])
      expect((await call(`select human_job_request_revision($1, $2, 'Not my target role', 7, 48) r`, [jid, '00000000-0000-4000-8000-0000000000aa'])).reason).toBe('not_found')
      expect((await call(`select human_job_request_revision($1, $2, 'x', 7, 48) r`, [jid, U1])).reason).toBe('bad_reason')
      expect(await call(`select human_job_request_revision($1, $2, 'Not my target role', 7, 48) r`, [jid, U1])).toEqual({ ok: true, already: false })
      expect(await call(`select human_job_request_revision($1, $2, 'Not my target role', 7, 48) r`, [jid, U1])).toMatchObject({ already: true })
      expect((await q(`select state, expert_id, revision_count, auto_accept_at from human_jobs where id = $1`, [jid]))[0]).toEqual({ state: 'revision', expert_id: E1, revision_count: 1, auto_accept_at: null })
      expect((await call(`select human_job_expert_save($1, $2, 1, '{"summary":"y"}', null, 30) r`, [jid, E1])).ok).toBe(true)
      await q(`select human_job_submit($1, $2) r`, [jid, E1])
      expect(await call(`select human_job_deliver($1, $2, '{}', 40, 85, null, null, null, 's2', 'n', 72) r`, [jid, OP])).toMatchObject({ ok: true, delivery_version: 2 })
      expect((await call(`select human_job_request_revision($1, $2, 'one more please', 7, 48) r`, [jid, U1])).reason).toBe('revision_used')
      expect((await q(`select version from job_deliveries where job_id = $1 order by version`, [jid])).map(r => r.version)).toEqual([1, 2])
    })

    it('a revision cannot be requested after the window; a job in review returns to revision (not in_progress) after a revision request', async () => {
      const old = await newJob('delivered', { expert_id: E1, delivered_at: new Date(Date.now() - 8 * 86400000).toISOString() })
      expect((await call(`select human_job_request_revision($1, $2, 'too late', 7, 48) r`, [old, U1])).reason).toBe('window_closed')
      const jid = await newJob('offered'); await working(jid)
      await q(`select human_job_submit($1, $2) r`, [jid, E1]); await q(`select human_job_deliver($1, $2, '{}', 1, 2, null, null, null, 's', 'n', 72) r`, [jid, OP])
      await q(`select human_job_request_revision($1, $2, 'please redo', 7, 48) r`, [jid, U1])
      await q(`select human_job_submit($1, $2) r`, [jid, E1])
      await q(`select human_job_return_to_expert($1, $2, 'again') r`, [jid, OP])
      expect((await q(`select state from human_jobs where id = $1`, [jid]))[0].state).toBe('revision')
    })

    it('rating: once, by the owner, only after delivery', async () => {
      const early = await newJob('offered')
      expect((await call(`select human_job_rate($1, $2, 5, null) r`, [early, U1])).reason).toBe('not_delivered')
      const jid = await newJob('delivered', { expert_id: E1, delivered_at: new Date().toISOString() })
      expect((await call(`select human_job_rate($1, $2, 9, null) r`, [jid, U1])).reason).toBe('bad_rating')
      expect(await call(`select human_job_rate($1, $2, 4, array['clear']) r`, [jid, U1])).toEqual({ ok: true, already: false })
      expect(await call(`select human_job_rate($1, $2, 1, null) r`, [jid, U1])).toMatchObject({ already: true })
      expect((await q(`select rating_stars from human_jobs where id = $1`, [jid]))[0].rating_stars).toBe(4)
    })

    it('auto-acceptance: only delivered jobs past their 72 hours; each writes exactly one pay row; a second run changes nothing', async () => {
      const due = await newJob('delivered', { expert_id: E1, delivered_at: new Date(Date.now() - 4 * 86400000).toISOString() })
      const notYet = await newJob('delivered', { expert_id: E1, delivered_at: new Date().toISOString() })
      await db.query(`update human_jobs set auto_accept_at = now() - interval '1 hour' where id = $1`, [due])
      await db.query(`update human_jobs set auto_accept_at = now() + interval '30 hours' where id = $1`, [notYet])
      expect((await q(`select human_job_auto_accept_due(3) r`))[0].r).toBeGreaterThanOrEqual(1)
      expect((await q(`select human_job_auto_accept_due(3) r`))[0].r).toBe(0)
      expect((await q(`select state from human_jobs where id = $1`, [due]))[0].state).toBe('accepted')
      expect((await q(`select state from human_jobs where id = $1`, [notYet]))[0].state).toBe('delivered')
      expect((await q(`select count(*)::int c from expert_earnings where job_id = $1 and kind = 'pay'`, [due]))[0].c).toBe(1)
      expect((await q(`select count(*)::int c from expert_earnings where job_id = $1`, [notYet]))[0].c).toBe(0)
    })
  })
})
