// Experts audit A4 pass 1 (state machine and job engine): one regression test per finding, against real Postgres (PGlite) and the real
// service code. Each of these FAILS on the code before migration 0129. See docs/experts/audit/engine-pass1.md for the findings.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const SM = require('../src/lib/expertRealm/stateMachine.js')
const CL = require('../src/lib/expertRealm/clock.js')
const DIR = path.resolve(__dirname, '../supabase/migrations')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')
const U1 = '00000000-0000-4000-8000-0000000000a1'
const E1 = '00000000-0000-4000-8000-0000000000e1', E2 = '00000000-0000-4000-8000-0000000000e2', E4 = '00000000-0000-4000-8000-0000000000e4', G1 = '00000000-0000-4000-8000-0000000000f1'
let db, n = 0
const q1 = (s, p) => db.query(s, p).then(r => r.rows)
const one = async (s, p) => (await q1(s, p))[0]
async function mkJob(state, over = {}) {
  n += 1
  const pid = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  await db.query(`insert into payments (id, amount_cents, paystack_ref, user_id, status, product_kind) values ($1, 11900, $2, $3, 'SUCCESS', 'human_forty_eight_hour')`, [pid, `ref-${n}`, U1])
  const hasExp = SM.CARRYING.includes(state) || ['refunded', 'disputed'].includes(state)
  const { rows } = await db.query(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested, expert_id, paid_at, promised_deadline_at, internal_deadline_at, auto_accept_at, delivered_at, review_required)
    values ($1,$2,$3,'forty_eight_hour',11900,11900,7000,$4,now(),true,true,$5,now(), now() + interval '48 hours', now() + interval '40 hours', $6, $7, $8) returning id`,
    [`HJ-${n}`, pid, U1, state, over.expert === undefined ? (hasExp ? E1 : null) : over.expert,
     state === 'delivered' ? new Date(Date.now() + 72 * 3600e3).toISOString() : null,
     ['delivered', 'accepted', 'revision'].includes(state) || over.delivered ? (over.deliveredAt || new Date().toISOString()) : null, !!over.review])
  if (over.working !== false) await db.query(`insert into job_documents (job_id, kind, version, body) values ($1, 'working', 1, '{}')`, [rows[0].id])
  return rows[0].id
}
const T = (job, to, trigger, kind, actor, x = {}) => db.query(
  `select human_job_transition($1::uuid,$2,$3,$4,$5::uuid,$6::int,$7::uuid,null,'{}'::jsonb,$8,3,$9::timestamptz,$10::int,null,null,$11::jsonb,$12::jsonb,$13::int) as r`,
  [job, to, trigger, kind, actor, x.version ?? null, x.expert ?? null, x.key ?? null, x.autoAccept === undefined ? new Date(Date.now() + 72 * 3600e3).toISOString() : x.autoAccept, x.max ?? 5,
   JSON.stringify(x.payload || { body: 'Which role?', answer: 'Role A', reason: 'too generic' }),
   x.delivery === null ? null : x.delivery === 'null' ? 'null' : JSON.stringify(x.delivery === undefined ? { files: {}, score_before: 50, score_after: 70, summary: 's' } : x.delivery), x.gb ?? 60]).then(r => r.rows[0].r)
const state = async j => (await one('select state from human_jobs where id=$1', [j])).state

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of files) await db.exec(read(f))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h')`)
  for (const [id, em, role, totp] of [[E1, 'e1', '{expert}', true], [E2, 'e2', '{expert}', true], [E4, 'e4', '{expert}', true], [G1, 'g1', '{grader}', true]])
    await db.query(`insert into expert_accounts (id,email,password_hash,roles,display_first_name,display_initial,status,enabled,totp_enabled_at,agreement_signed_at,agreement_version) values ($1,$2,'h',$3,'Ex','P','active',true,now(),now(),'v1')`, [id, `${em}@example.com`, role])
}, 280000)

describe('A4 bugs', () => {
  it('B1: a Phase 1 answer closes the pause, so a later engine question works (it threw on a unique index before)', async () => {
    const j = await mkJob('in_progress')
    const ask = (await one(`select human_job_ask($1,$2,'Which role?',null,24,3) r`, [j, E1])).r
    expect((await one('select count(*)::int c from job_pauses where job_id=$1 and ended_at is null', [j])).c).toBe(1)   // Phase 1 now opens a pause row too
    await q1(`select human_job_answer($1,$2,$3,'Role A')`, [j, U1, ask.question_id])
    expect((await one('select count(*)::int c from job_pauses where job_id=$1 and ended_at is null', [j])).c).toBe(0)
    expect((await T(j, 'waiting_customer', 'ask_question', 'expert', E1)).ok).toBe(true)
  })
  it('B1/B6: the 0129 repair closes stale open pauses and rebuilds backfilled pauses without overlap', async () => {
    const j = await mkJob('offered', { expert: null })
    await q1(`insert into job_events (job_id, kind, actor_kind, created_at) values ($1,'question_asked','expert', now()-interval '10 hours'), ($1,'released','operator', now()-interval '9 hours'), ($1,'question_asked','expert', now()-interval '5 hours'), ($1,'question_answered','customer', now()-interval '4 hours')`, [j])
    await q1(`insert into job_pauses (job_id, started_at, reason, source) values ($1, now()-interval '10 hours', 'customer_question', 'phase1_backfill')`, [j])   // what 0127 left: open on a job that is not waiting
    const sql = read('0129_experts_engine_audit_a4.sql'); const a = sql.indexOf('delete from job_pauses where source'); const b = sql.indexOf('select job_next_action_sync(id) from human_jobs;')
    await db.exec(sql.slice(a, b))
    const rows = await q1('select started_at, ended_at from job_pauses where job_id=$1 order by started_at', [j])
    expect(rows).toHaveLength(2); expect(rows.every(r => r.ended_at)).toBe(true)
    expect(rows[0].ended_at <= rows[1].started_at).toBe(true)                                        // no overlap
    expect(Math.round(CL.pausedSeconds(rows.map(r => ({ started: r.started_at, ended: r.ended_at })), new Date()) / 3600)).toBe(2)   // 1h + 1h, not 6h
  })
  it('B2: a reused idempotency key for a different move is refused, a true repeat reports the original event', async () => {
    const j = await mkJob('claimed')
    const first = await T(j, 'in_progress', 'first_save', 'expert', E1, { key: 'dup-key' })
    const again = await T(j, 'in_progress', 'first_save', 'expert', E1, { key: 'dup-key' })
    expect(again).toMatchObject({ ok: true, replay: true, event_id: first.event_id })
    expect(await T(j, 'disputed', 'dispute', 'customer', U1, { key: 'dup-key' })).toMatchObject({ ok: false, code: 'IDEM_KEY_MISMATCH' })
    expect(await state(j)).toBe('in_progress')
  })
  it('B3: an expert cannot take a job for somebody else', async () => {
    const j = await mkJob('offered', { expert: null })
    expect(await T(j, 'claimed', 'take', 'expert', E2, { expert: E4 })).toMatchObject({ ok: false, code: 'ACTOR_MISMATCH' })
    expect((await T(j, 'claimed', 'take', 'expert', E2, { expert: E2 })).ok).toBe(true)
    expect((await one('select expert_id from human_jobs where id=$1', [j])).expert_id).toBe(E2)
  })
  it('B4: the revision keeps its reason and fresh clock, clears auto-accept, and obeys the window, reason and once-only rules', async () => {
    const j = await mkJob('delivered')
    expect(await T(j, 'revision', 'request_revision', 'customer', U1, { payload: { reason: 'x' } })).toMatchObject({ ok: false, code: 'BAD_REASON' })
    expect((await T(j, 'revision', 'request_revision', 'customer', U1, { payload: { reason: 'Please lead with the sales role' } })).ok).toBe(true)
    const row = await one('select revision_reason r, revision_due_at d, auto_accept_at a, revision_count c from human_jobs where id=$1', [j])
    expect(row.r).toBe('Please lead with the sales role'); expect(row.d).not.toBeNull(); expect(row.a).toBeNull(); expect(row.c).toBe(1)
    expect((await one('select next_action_at at from job_next_actions where job_id=$1', [j])).at.getTime()).toBe(row.d.getTime())   // G6: the revision clock, not the original deadline
    const old = await mkJob('delivered', { deliveredAt: new Date(Date.now() - 30 * 24 * 3600e3).toISOString() })
    expect(await T(old, 'revision', 'request_revision', 'customer', U1)).toMatchObject({ ok: false, code: 'WINDOW_CLOSED' })
  })
  it('B6: unassigning a waiting job credits the wait to both deadlines and closes its question and pause', async () => {
    const j = await mkJob('in_progress')
    await q1(`select human_job_ask($1,$2,'Q1',null,24,3)`, [j, E1])
    await db.exec('begin')
    await db.query(`update human_jobs set pause_started_at = now() - interval '3 hours' where id=$1`, [j])
    const before = await one('select promised_deadline_at p from human_jobs where id=$1', [j])
    await q1(`select human_job_unassign($1,$2,'x')`, [j, G1]); await db.exec('commit')
    const after = await one('select state, paused_seconds s, promised_deadline_at p from human_jobs where id=$1', [j])
    expect(after.state).toBe('offered'); expect(after.s).toBe(3 * 3600); expect(after.p - before.p).toBe(3 * 3600e3)
    expect((await one(`select count(*)::int c from job_questions where job_id=$1 and status='pending'`, [j])).c).toBe(0)
    expect((await one('select count(*)::int c from job_pauses where job_id=$1 and ended_at is null', [j])).c).toBe(0)
  })
  it('B6 (JS): a release event ends the pause the clock derives from events', () => {
    const t = h => new Date(Date.UTC(2026, 9, 1, h)).toISOString()
    const ev = [{ id: 1, kind: 'question_asked', created_at: t(0), detail: {} }, { id: 2, kind: 'released', created_at: t(1), detail: {} }, { id: 3, kind: 'question_asked', created_at: t(5), detail: {} }, { id: 4, kind: 'question_answered', created_at: t(6), detail: {} }]
    expect(CL.pausedSeconds(CL.pausesFromEvents(ev), t(9))).toBe(2 * 3600)
  })
  it('B7: an expert cannot deliver or redeliver around the review when the job requires it', async () => {
    const j = await mkJob('in_progress', { review: true })
    expect(await T(j, 'final_checks', 'deliver', 'expert', E1)).toMatchObject({ ok: false, code: 'REVIEW_REQUIRED' })
    expect((await T(j, 'in_review', 'submit_review', 'expert', E1)).ok).toBe(true)
    expect((await T(j, 'final_checks', 'review_approved', 'expert', G1)).ok).toBe(true)
    const r = await mkJob('revision', { review: true })
    expect(await T(r, 'delivered', 'redeliver', 'expert', E1)).toMatchObject({ ok: false, code: 'REVIEW_REQUIRED' })
  })
  it('B8: reassigning out of a wait expires its question, so nothing is left pending', async () => {
    const j = await mkJob('in_progress')
    expect((await T(j, 'waiting_customer', 'ask_question', 'expert', E1)).ok).toBe(true)
    expect((await one(`select count(*)::int c from job_questions where job_id=$1 and status='pending'`, [j])).c).toBe(1)
    expect((await T(j, 'claimed', 'reassign', 'operator', G1, { expert: E2 })).ok).toBe(true)
    expect((await one(`select count(*)::int c from job_questions where job_id=$1 and status='pending'`, [j])).c).toBe(0)
  })
  it('B9: sent_back during a revision goes back to revision, otherwise to in_progress', async () => {
    const j = await mkJob('delivered'); await T(j, 'revision', 'request_revision', 'customer', U1)
    await T(j, 'in_review', 'submit_review', 'expert', E1)
    expect(await T(j, 'in_progress', 'sent_back', 'expert', G1)).toMatchObject({ ok: true, state: 'revision' })
    const k = await mkJob('in_review')
    expect(await T(k, 'in_progress', 'sent_back', 'operator', G1)).toMatchObject({ ok: true, state: 'in_progress' })
  })
  it('B10: Phase 1 accept and reverse leave no scheduled action behind', async () => {
    const j = await mkJob('delivered')
    expect((await one('select count(*)::int c from job_next_actions where job_id=$1', [j])).c).toBe(0)   // inserted directly: no row yet
    await q1(`update human_jobs set auto_accept_at = auto_accept_at + interval '1 hour' where id=$1`, [j])
    expect((await one('select next_action_kind k from job_next_actions where job_id=$1', [j])).k).toBe('auto_accept')
    await q1(`select human_job_accept($1,'customer',$2,3)`, [j, U1])
    expect((await one('select count(*)::int c from job_next_actions where job_id=$1', [j])).c).toBe(0)
    const k = await mkJob('in_progress'); await q1(`update human_jobs set internal_deadline_at = internal_deadline_at + interval '1 hour' where id=$1`, [k])
    await q1(`select human_job_reverse($1,'refund')`, [k])
    expect((await one('select count(*)::int c from job_next_actions where job_id=$1', [k])).c).toBe(0)
  })
  it('L2: a job given back has no stale claim time or give-back window', async () => {
    const j = await mkJob('offered', { expert: null }); await T(j, 'claimed', 'take', 'expert', E2, { expert: E2 })
    expect((await one('select give_back_until g from human_jobs where id=$1', [j])).g).not.toBeNull()
    expect((await T(j, 'offered', 'give_back_in_window', 'expert', E2)).ok).toBe(true)
    expect(await one('select claimed_at c, give_back_until g, expert_id e from human_jobs where id=$1', [j])).toEqual({ c: null, g: null, e: null })
  })
})

describe('A4 feature gaps', () => {
  it('G1: a disputed job is not paid out, and has ways out other than a refund', async () => {
    const j = await mkJob('delivered'); await T(j, 'accepted', 'accept', 'customer', U1)
    await q1(`update expert_earnings set release_at = now() - interval '1 hour' where job_id=$1`, [j])
    expect((await T(j, 'disputed', 'dispute', 'customer', U1)).ok).toBe(true)
    expect((await one(`select expert_record_payout($1,'bank','r','k-frozen',1) r`, [E1])).r).toMatchObject({ ok: false, reason: 'below_minimum', available_cents: 0 })
    expect((await T(j, 'accepted', 'dispute_resolved_for_expert', 'operator', G1)).ok).toBe(true)
    expect((await one(`select expert_record_payout($1,'bank','r','k-free',1) r`, [E1])).r).toMatchObject({ ok: true, amount_cents: 7000 })
    const w = await mkJob('in_progress'); await T(w, 'disputed', 'dispute', 'customer', U1)
    expect(await T(w, 'accepted', 'dispute_resolved_for_expert', 'operator', G1)).toMatchObject({ ok: false, code: 'NOT_DELIVERED' })
    expect((await T(w, 'in_progress', 'dispute_dismissed', 'operator', G1)).ok).toBe(true)
  })
  it('G2: a grader (not the job\'s expert) can send back and approve; other experts cannot', async () => {
    const j = await mkJob('in_review')
    expect(await T(j, 'in_progress', 'sent_back', 'expert', E2)).toMatchObject({ ok: false, code: 'NOT_GRADER' })
    expect(await T(j, 'in_progress', 'sent_back', 'expert', E1)).toMatchObject({ ok: false, code: 'NOT_GRADER' })
    expect((await T(j, 'final_checks', 'review_approved', 'expert', G1)).ok).toBe(true)
    await q1(`update expert_accounts set roles = '{grader,expert}' where id=$1`, [G1]); const k = await mkJob('in_review', { expert: G1 })
    expect(await T(k, 'final_checks', 'review_approved', 'expert', G1)).toMatchObject({ ok: false, code: 'NOT_GRADER' })       // never their own job
    await q1(`update expert_accounts set roles = '{grader}' where id=$1`, [G1])
  })
  it('G3: give-back window, due-time guards and the delivery guards', async () => {
    const j = await mkJob('offered', { expert: null }); await T(j, 'claimed', 'take', 'expert', E2, { expert: E2 })
    await q1(`update human_jobs set give_back_until = now() - interval '1 minute' where id=$1`, [j])
    expect(await T(j, 'offered', 'give_back_in_window', 'expert', E2)).toMatchObject({ ok: false, code: 'WINDOW_CLOSED' })
    expect((await T(j, 'open', 'give_back_late', 'expert', E2)).ok).toBe(true)
    const d = await mkJob('delivered')
    expect(await T(d, 'accepted', 'auto_accept', 'system', null)).toMatchObject({ ok: false, code: 'NOT_DUE' })
    await q1(`update human_jobs set auto_accept_at = now() - interval '1 minute' where id=$1`, [d])
    expect((await T(d, 'accepted', 'auto_accept', 'system', null)).ok).toBe(true)
    const a = await mkJob('awaiting_payment'); expect(await T(a, 'cancelled', 'expired', 'system', null)).toMatchObject({ ok: false, code: 'NOT_DUE' })
    const f = await mkJob('final_checks')
    expect(await T(f, 'delivered', 'rescan_passed', 'system', null, { autoAccept: null })).toMatchObject({ ok: false, code: 'AUTO_ACCEPT_REQUIRED' })
  })
  it('G4: ask_question creates the question and schedules its timeout in one step; the answer closes it', async () => {
    const j = await mkJob('in_progress')
    expect(await T(j, 'waiting_customer', 'ask_question', 'expert', E1, { payload: { body: '' } })).toMatchObject({ ok: false, code: 'BAD_QUESTION' })
    expect((await T(j, 'waiting_customer', 'ask_question', 'expert', E1, { payload: { body: 'Which role?', answer_hours: 12 } })).ok).toBe(true)
    const na = await one('select next_action_kind k, next_action_at at from job_next_actions where job_id=$1', [j])
    expect(na.k).toBe('question_timeout'); expect(na.at.getTime() - Date.now()).toBeGreaterThan(11 * 3600e3)
    expect(await T(j, 'in_progress', 'answered', 'customer', U1, { payload: { answer: '' } })).toMatchObject({ ok: false, code: 'BAD_ANSWER' })
    expect((await T(j, 'in_progress', 'answered', 'customer', U1, { payload: { answer: 'Sales' } })).ok).toBe(true)
    expect(await one('select status, answer_body from job_questions where job_id=$1', [j])).toEqual({ status: 'answered', answer_body: 'Sales' })
    for (let i = 0; i < 2; i++) { await T(j, 'waiting_customer', 'ask_question', 'expert', E1); await T(j, 'in_progress', 'answered', 'customer', U1) }
    expect(await T(j, 'waiting_customer', 'ask_question', 'expert', E1)).toMatchObject({ ok: false, code: 'QUESTION_LIMIT' })
  })
  it('G4: question_timeout only when the deadline has passed, and it expires the question', async () => {
    const j = await mkJob('in_progress'); await T(j, 'waiting_customer', 'ask_question', 'expert', E1)
    expect(await T(j, 'in_progress', 'question_timeout', 'system', null)).toMatchObject({ ok: false, code: 'NOT_DUE' })
    await q1(`update job_questions set answer_deadline_at = now() - interval '1 minute' where job_id=$1`, [j])
    expect((await T(j, 'in_progress', 'question_timeout', 'system', null)).ok).toBe(true)
    expect((await one('select status from job_questions where job_id=$1', [j])).status).toBe('expired')
  })
  it('G5: delivered writes the delivery rows in the same step, and refuses without them', async () => {
    const f = await mkJob('final_checks')
    expect(await T(f, 'delivered', 'rescan_passed', 'system', null, { delivery: null })).toMatchObject({ ok: false, code: 'DELIVERY_REQUIRED' })
    expect(await T(f, 'delivered', 'rescan_passed', 'system', null, { delivery: 'null' })).toMatchObject({ ok: false, code: 'DELIVERY_REQUIRED' })   // a JSON null is no delivery either
    const nodoc = await mkJob('final_checks', { working: false })
    expect(await T(nodoc, 'delivered', 'rescan_passed', 'system', null)).toMatchObject({ ok: false, code: 'NOTHING_SAVED' })
    expect((await T(f, 'delivered', 'rescan_passed', 'system', null)).ok).toBe(true)
    expect(await one(`select version, score_after from job_deliveries where job_id=$1`, [f])).toEqual({ version: 1, score_after: 70 })
    expect((await one(`select count(*)::int c from job_documents where job_id=$1 and kind='delivered'`, [f])).c).toBe(1)
    expect((await one('select auto_accept_at a from human_jobs where id=$1', [f])).a).not.toBeNull()
  })
  it('G7: an offered, open, in-review or final-checks job is still on its deadline clock', async () => {
    for (const s of ['offered', 'open', 'in_review', 'final_checks']) {
      const j = await mkJob(s, { expert: s === 'offered' || s === 'open' ? null : undefined })
      await q1(`update human_jobs set internal_deadline_at = internal_deadline_at + interval '1 minute' where id=$1`, [j])
      expect((await one('select next_action_kind k from job_next_actions where job_id=$1', [j])).k, s).toBe('deadline_warning')
    }
  })
  it('the SQL next-action rule and nextActionFor agree for every state', async () => {
    const t = new Date(Date.now() + 5 * 3600e3)
    for (const s of SM.STATES) {
      const j = await mkJob(s, { expert: ['offered', 'open', 'awaiting_payment', 'cancelled'].includes(s) ? null : undefined })
      await q1(`update human_jobs set internal_deadline_at = $2, auto_accept_at = $2 where id=$1`, [j, t.toISOString()])
      if (s === 'waiting_customer') await q1(`insert into job_questions (job_id, seq, body, answer_deadline_at) values ($1,1,'q',$2)`, [j, t.toISOString()])
      await q1('select job_next_action_sync($1)', [j])
      const got = await one('select next_action_at at, next_action_kind k from job_next_actions where job_id=$1', [j])
      const j2 = await one('select created_at from human_jobs where id=$1', [j])
      const want = SM.nextActionFor(s, { createdAt: j2.created_at, internalDeadlineAt: t, autoAcceptAt: t, answerDeadlineAt: t, pendingExpiryHours: 24 })
      expect(got ? { at: got.at.toISOString(), kind: got.k } : null, s).toEqual(want)
    }
  })
})

describe('A4 service and bridge', () => {
  it('B5: a bridge retry after a failed first attempt runs the transition again; only a finished call short-cuts', async () => {
    let rpcFails = true; const updates = []; const inserted = new Set()
    const settings = { prices: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 }, pay: { polish: 1, seven_day: 1, forty_eight_hour: 1, twenty_four_hour: 1, cover_letter: 1 }, tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, pilot_cap_orders: 1, accept_auto_hours: 72, revision_window_days: 7, earnings_hold_days: 3, turnaround_hours: { forty_eight_hour: 48 } }
    let prior = { id: 1, outcome: 'started', code: null }
    const supabase = {
      from(t) {
        const c = { t, op: null, row: null }
        const api = { select() { return api }, eq() { return api }, update(v) { c.op = 'update'; c.row = v; return api }, insert(r) { c.op = 'insert'; c.row = r; return api },
          maybeSingle() {
            if (t === 'human_jobs') return Promise.resolve({ data: { id: 'j1', state: 'awaiting_payment', payment_id: 'p1', price_cents: 1, tier: 'forty_eight_hour' } })
            if (t === 'payments') return Promise.resolve({ data: { id: 'p1', status: 'SUCCESS', product_kind: 'human_forty_eight_hour' } })
            if (t === 'system_state') return Promise.resolve({ data: { value: settings } })
            if (t === 'expert_bridge_calls' && c.op === 'insert') { const k = c.row.fn + c.row.idem_key; if (inserted.has(k)) return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint' } }); inserted.add(k); return Promise.resolve({ data: { id: 1 } }) }
            if (t === 'expert_bridge_calls') return Promise.resolve({ data: prior })
            return Promise.resolve({ data: null })
          },
          then(res) { if (t === 'expert_bridge_calls' && c.op === 'update') { updates.push(c.row); prior = { id: 1, ...c.row } } return Promise.resolve({}).then(res) } }
        return api
      },
      rpc: vi.fn(async () => (rpcFails ? { data: null, error: new Error('connection reset') } : { data: { ok: true, state: 'offered', version: 1 } })),
    }
    const { createJobFromPayment } = require('../src/services/expertBridge.service.js')
    await expect(createJobFromPayment(supabase, { jobId: 'j1', actorId: null })).rejects.toThrow('connection reset')
    expect(updates.at(-1)).toMatchObject({ outcome: 'failed' })
    rpcFails = false
    expect(await createJobFromPayment(supabase, { jobId: 'j1', actorId: null })).toMatchObject({ ok: true, state: 'offered' })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)                                   // retried, not short-cut
    expect(updates.at(-1)).toMatchObject({ outcome: 'ok' })
    expect(await createJobFromPayment(supabase, { jobId: 'j1', actorId: null })).toMatchObject({ ok: true, replay: true })
    expect(supabase.rpc).toHaveBeenCalledTimes(2)                                   // now it short-cuts
  })
  it('L1: cancelling, refunding and disputing need no settings row; everything else still fails closed', async () => {
    const { transition } = require('../src/services/humanJobs.service.js')
    const mk = state => ({ from: t => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: t === 'human_jobs' ? { id: 'j', state, version: 1, tier: 'seven_day' } : { value: null } }) }) }) }), rpc: vi.fn(async () => ({ data: { ok: true, state: 'cancelled', version: 2 } })) })
    const a = mk('offered'); expect(await transition(a, { jobId: 'j', to: 'cancelled', trigger: 'admin_cancel', actor: { kind: 'operator', id: 'o' } })).toMatchObject({ ok: true }); expect(a.rpc).toHaveBeenCalled()
    const b = mk('claimed'); expect(await transition(b, { jobId: 'j', to: 'in_progress', trigger: 'first_save', actor: { kind: 'expert', id: 'e' } })).toMatchObject({ ok: false, code: 'SETTINGS_MISSING' }); expect(b.rpc).not.toHaveBeenCalled()
  })
})
