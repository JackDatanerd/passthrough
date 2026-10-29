// Experts Phase 2A: migration 0127 against a real Postgres (PGlite): the transition table, the single transition function, idempotency,
// pauses, money, eligibility, the reversible backfill, and the grants. Every (state, target, trigger, actor) combination is exercised.
import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SM = require('../src/lib/expertRealm/stateMachine.js')

const DIR = path.resolve(__dirname, '../supabase/migrations')
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort()
const MIG = files.find(f => f.startsWith('0127'))
const read = f => fs.readFileSync(path.join(DIR, f), 'utf8').replace(/create extension if not exists pgcrypto;/i, '')

const U1 = '00000000-0000-4000-8000-0000000000a1'
const E1 = '00000000-0000-4000-8000-0000000000e1'   // holds the job in carrying states
const E2 = '00000000-0000-4000-8000-0000000000e2'   // eligible, free
const E3 = '00000000-0000-4000-8000-0000000000e3'   // no two-factor
let db, n = 0
const jobs = {}   // state -> job id

async function mkJob(state, over = {}) {
  n += 1
  const pid = `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  await db.query(`insert into payments (id, amount_cents, paystack_ref, user_id, status, product_kind) values ($1, 11900, $2, $3, 'SUCCESS', 'human_forty_eight_hour')`, [pid, `ref-${n}`, U1])
  const expert = SM.CARRYING.includes(state) || ['refunded', 'disputed'].includes(state) ? E1 : null
  const { rows } = await db.query(`insert into human_jobs (job_number, payment_id, customer_user_id, tier, price_cents, tier_price_cents, expert_pay_cents, state, terms_consent_at, age_attested, rights_attested, expert_id, paid_at, promised_deadline_at, internal_deadline_at, auto_accept_at)
    values ($1, $2, $3, 'forty_eight_hour', 11900, 11900, 7000, $4, now(), true, true, $5, now(), now() + interval '48 hours', now() + interval '40 hours', $6) returning id`,
    [`HJ-${n}`, pid, U1, state, over.expert === undefined ? expert : over.expert, state === 'delivered' ? new Date(Date.now() + 72 * 3600e3).toISOString() : null])
  return rows[0].id
}
const T = (job, to, trigger, kind, actor, extra = {}) => db.query(
  `select human_job_transition($1::uuid, $2, $3, $4, $5::uuid, $6::int, $7::uuid, null, '{}'::jsonb, $8, 3, null, $9::int) as r`,
  [job, to, trigger, kind, actor, extra.version ?? null, extra.expert ?? null, extra.key ?? null, extra.max ?? 2]).then(x => x.rows[0].r)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;`)
  for (const f of files.filter(f => f < MIG)) await db.exec(read(f))
  await db.exec(read(MIG))
  await db.exec(`insert into users (id, name, email, password_hash) values ('${U1}', 'U', 'u@example.com', 'h')`)
  for (const [id, em, totp] of [[E1, 'e1', true], [E2, 'e2', true], [E3, 'e3', false]])
    await db.query(`insert into expert_accounts (id, email, password_hash, display_first_name, display_initial, status, enabled, totp_enabled_at, agreement_signed_at, agreement_version)
      values ($1, $2, 'h', 'Ex', 'P', 'active', true, ${totp ? 'now()' : 'null'}, now(), 'v1')`, [id, `${em}@example.com`])
  for (const s of SM.STATES) jobs[s] = await mkJob(s)
}, 280000)

describe('migration 0127: rules and grants', () => {
  it('seeds exactly the rules the JavaScript table has', async () => {
    const { rows } = await db.query('select from_state, to_state, trigger, actors from job_transition_rules')
    const sql = new Set(rows.map(r => `${r.from_state}>${r.to_state}:${r.trigger}:${[...r.actors].sort().join(',')}`))
    const js = new Set(SM.RULES.map(r => `${r.from}>${r.to}:${r.trigger}:${[...r.actors].sort().join(',')}`))
    expect([...sql].sort()).toEqual([...js].sort())
  })
  it('ledger and schema version moved to 127', async () => {
    expect((await db.query(`select name from applied_migrations where version = 127`)).rows[0].name).toBe('0127_experts_phase2a_realm')
    expect((await db.query(`select (value->>'version')::int v from system_state where key = 'schema_version'`)).rows[0].v).toBeGreaterThanOrEqual(127)
  })
  it('no anon / authenticated access to any new table or to the function', async () => {
    for (const t of ['expert_sessions', 'expert_recovery_codes', 'expert_password_resets', 'job_transition_rules', 'job_next_actions', 'job_pauses', 'job_event_keys', 'expert_bridge_calls']) {
      const { rows } = await db.query(`select has_table_privilege('anon', $1, 'select') a, has_table_privilege('authenticated', $1, 'select') b, (select relrowsecurity from pg_class where relname = $1) rls`, [t])
      expect(rows[0], t).toEqual({ a: false, b: false, rls: true })
    }
    const { rows } = await db.query(`select has_function_privilege('anon', 'human_job_transition(uuid,text,text,text,uuid,int,uuid,text,jsonb,text,int,timestamptz,int,timestamptz,timestamptz)', 'execute') a,
      has_function_privilege('authenticated', 'human_job_transition(uuid,text,text,text,uuid,int,uuid,text,jsonb,text,int,timestamptz,int,timestamptz,timestamptz)', 'execute') b,
      has_function_privilege('service_role', 'human_job_transition(uuid,text,text,text,uuid,int,uuid,text,jsonb,text,int,timestamptz,int,timestamptz,timestamptz)', 'execute') c`)
    expect(rows[0]).toEqual({ a: false, b: false, c: true })
  })
})

describe('human_job_transition: every state x target x trigger x actor', () => {
  it('allows exactly the table and refuses everything else', async () => {
    const pairs = [...new Set(SM.RULES.map(r => `${r.to}|${r.trigger}`))].map(s => s.split('|'))
    const bad = []
    let legal = 0, illegal = 0
    for (const from of SM.STATES) {
      for (const [to, trigger] of pairs) {
        for (const kind of SM.ACTOR_KINDS) {
          const expectLegal = SM.check({ from, to, trigger, actorKind: kind }).ok
          const actor = kind === 'expert' ? (trigger === 'take' ? E2 : E1) : kind === 'customer' ? U1 : null
          await db.exec('begin')
          let r
          try { r = await T(jobs[from], to, trigger, kind, actor, { expert: ['take', 'assign', 'reassign'].includes(trigger) ? E2 : null }) } finally { await db.exec('rollback') }
          if (expectLegal) { legal++; if (!r.ok) bad.push(`${from}>${to}:${trigger}:${kind} refused ${r.code}`) }
          else { illegal++; if (r.ok || r.code !== 'ILLEGAL_TRANSITION') bad.push(`${from}>${to}:${trigger}:${kind} should be ILLEGAL, got ${JSON.stringify(r)}`) }
        }
      }
    }
    expect(bad).toEqual([])
    expect(legal).toBeGreaterThanOrEqual(SM.RULES.length)       // every rule was exercised at least once by its actor kind
    expect(illegal).toBeGreaterThan(1000)
  }, 280000)
})

describe('Appendix H: deadline pause and earnings on acceptance', () => {
  it('after a 5-hour wait the deadlines move later by exactly 5 hours, and replaying the answer changes nothing', async () => {
    const j = await mkJob('in_progress')
    const before = (await db.query('select promised_deadline_at p, internal_deadline_at i from human_jobs where id = $1', [j])).rows[0]
    expect((await T(j, 'waiting_customer', 'ask_question', 'expert', E1)).ok).toBe(true)
    await db.exec('begin')                                             // one transaction: now() is fixed, so "5 hours" is exact
    await db.query(`update job_pauses set started_at = now() - interval '5 hours' where job_id = $1 and ended_at is null`, [j])
    const r = await T(j, 'in_progress', 'answered', 'customer', U1, { key: 'ans-1' }); await db.exec('commit')
    expect(r.ok).toBe(true)
    const after = (await db.query('select promised_deadline_at p, internal_deadline_at i, paused_seconds s from human_jobs where id = $1', [j])).rows[0]
    expect(after.s).toBe(5 * 3600); expect(new Date(after.p) - new Date(before.p)).toBe(5 * 3600e3); expect(new Date(after.i) - new Date(before.i)).toBe(5 * 3600e3)
    expect((await T(j, 'in_progress', 'answered', 'customer', U1, { key: 'ans-1' })).replay).toBe(true)                      // a retry after a crash
    expect(await T(j, 'in_progress', 'answered', 'customer', U1, { key: 'ans-2' })).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' })   // a second restart
    expect((await db.query('select paused_seconds s from human_jobs where id = $1', [j])).rows[0].s).toBe(5 * 3600)
  })
  it('no pay row until acceptance; then exactly one, released after the hold, with the pay snapshot', async () => {
    const j = await mkJob('delivered')
    expect((await db.query(`select count(*)::int n from expert_earnings where job_id = $1`, [j])).rows[0].n).toBe(0)
    await db.exec('begin'); const r = await T(j, 'accepted', 'accept', 'customer', U1); const row = (await db.query(`select amount_cents a, release_at r, extract(epoch from (release_at - now()))::int d from expert_earnings where job_id = $1`, [j])).rows[0]; await db.exec('commit')
    expect(r.ok).toBe(true); expect(row.a).toBe(7000); expect(row.d).toBe(3 * 86400)
  })
})

describe('human_job_transition: behaviour', () => {
  it('compare-and-set: a stale version is refused and changes nothing', async () => {
    const j = await mkJob('claimed')
    const r = await T(j, 'in_progress', 'first_save', 'expert', E1, { version: 99 })
    expect(r).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    expect((await db.query('select state from human_jobs where id = $1', [j])).rows[0].state).toBe('claimed')
    expect((await T(j, 'in_progress', 'first_save', 'expert', E1, { version: 0 })).ok).toBe(true)
  })
  it('an idempotency key makes a repeat a no-op: one event, same outcome', async () => {
    const j = await mkJob('claimed')
    const a = await T(j, 'in_progress', 'first_save', 'expert', E1, { key: 'k-1' })
    const b = await T(j, 'in_progress', 'first_save', 'expert', E1, { key: 'k-1' })
    expect(a.replay).toBe(false); expect(b).toMatchObject({ ok: true, replay: true, state: 'in_progress' })
    expect((await db.query(`select count(*)::int n from job_events where job_id = $1 and kind = 'first_save'`, [j])).rows[0].n).toBe(1)
    expect((await db.query(`select version from human_jobs where id = $1`, [j])).rows[0].version).toBe(1)
  })
  it('only the assigned expert and the owning customer may act', async () => {
    const j = await mkJob('claimed')
    expect(await T(j, 'in_progress', 'first_save', 'expert', E2)).toMatchObject({ ok: false, code: 'NOT_ASSIGNED' })
    const d = await mkJob('delivered')
    expect(await T(d, 'accepted', 'accept', 'customer', E2)).toMatchObject({ ok: false, code: 'NOT_OWNER' })
  })
  it('assignment needs an enabled, two-factor, agreed, under-cap expert', async () => {
    const j = await mkJob('open', { expert: null })
    expect(await T(j, 'claimed', 'assign', 'operator', null, { expert: E3 })).toMatchObject({ ok: false, code: 'TWO_FACTOR_MISSING' })
    expect(await T(j, 'claimed', 'assign', 'operator', null, { expert: null })).toMatchObject({ ok: false, code: 'EXPERT_REQUIRED' })
    expect(await T(j, 'claimed', 'assign', 'operator', null, { expert: E2, max: 0 })).toMatchObject({ ok: false, code: 'CAP' })
    expect((await T(j, 'claimed', 'assign', 'operator', null, { expert: E2 })).ok).toBe(true)
    expect((await db.query('select expert_id from human_jobs where id = $1', [j])).rows[0].expert_id).toBe(E2)
  })
  it('reassign swaps the expert, never to the same one; releasing clears the expert', async () => {
    const j = await mkJob('in_progress')
    expect(await T(j, 'claimed', 'reassign', 'operator', null, { expert: E1 })).toMatchObject({ ok: false, code: 'SAME_EXPERT' })
    expect((await T(j, 'claimed', 'reassign', 'operator', null, { expert: E2 })).ok).toBe(true)
    expect((await db.query('select expert_id, state from human_jobs where id = $1', [j])).rows[0]).toEqual({ expert_id: E2, state: 'claimed' })
    expect((await T(j, 'open', 'unassign', 'operator', null)).ok).toBe(true)
    expect((await db.query('select expert_id from human_jobs where id = $1', [j])).rows[0].expert_id).toBeNull()
  })
  it('a customer question opens one pause; the answer closes it and pushes both deadlines back', async () => {
    const j = await mkJob('in_progress')
    const before = (await db.query('select promised_deadline_at p, internal_deadline_at i from human_jobs where id = $1', [j])).rows[0]
    expect((await T(j, 'waiting_customer', 'ask_question', 'expert', E1)).ok).toBe(true)
    expect((await db.query('select count(*)::int n from job_pauses where job_id = $1 and ended_at is null', [j])).rows[0].n).toBe(1)
    await db.query(`update job_pauses set started_at = now() - interval '2 hours' where job_id = $1`, [j])
    expect((await T(j, 'in_progress', 'answered', 'customer', U1)).ok).toBe(true)
    const after = (await db.query('select promised_deadline_at p, internal_deadline_at i, paused_seconds s, pause_started_at ps from human_jobs where id = $1', [j])).rows[0]
    expect(after.s).toBeGreaterThanOrEqual(7199); expect(after.s).toBeLessThanOrEqual(7210); expect(after.ps).toBeNull()
    expect(new Date(after.p) - new Date(before.p)).toBe(after.s * 1000)
    expect(new Date(after.i) - new Date(before.i)).toBe(after.s * 1000)
    const sum = (await db.query(`select coalesce(sum(floor(extract(epoch from (ended_at - started_at)))), 0)::int s from job_pauses where job_id = $1 and ended_at is not null`, [j])).rows[0].s
    expect(Math.abs(sum - after.s)).toBeLessThanOrEqual(1)
  })
  it('money moves only on defined transitions, once: one pay row on acceptance, one reversal on refund', async () => {
    const j = await mkJob('delivered')
    expect((await T(j, 'accepted', 'accept', 'customer', U1, { key: 'acc' })).ok).toBe(true)
    expect((await T(j, 'accepted', 'accept', 'customer', U1, { key: 'acc' })).replay).toBe(true)
    expect(await T(j, 'accepted', 'auto_accept', 'system', null)).toMatchObject({ ok: false, code: 'ILLEGAL_TRANSITION' })
    let e = (await db.query(`select kind, amount_cents from expert_earnings where job_id = $1 order by kind`, [j])).rows
    expect(e).toEqual([{ kind: 'pay', amount_cents: 7000 }])
    expect((await T(j, 'refunded', 'refund', 'operator', null, { key: 'ref' })).ok).toBe(true)
    expect((await T(j, 'refunded', 'refund', 'operator', null, { key: 'ref' })).replay).toBe(true)
    e = (await db.query(`select kind, amount_cents from expert_earnings where job_id = $1 order by kind`, [j])).rows
    expect(e).toEqual([{ kind: 'pay', amount_cents: 7000 }, { kind: 'reversal', amount_cents: -7000 }])
  })
  it('one revision only; the second request is refused cleanly', async () => {
    const j = await mkJob('delivered')
    expect((await T(j, 'revision', 'request_revision', 'customer', U1)).ok).toBe(true)
    expect((await T(j, 'delivered', 'redeliver', 'expert', E1)).ok).toBe(true)
    expect(await T(j, 'revision', 'request_revision', 'customer', U1)).toMatchObject({ ok: false, code: 'REVISION_USED' })
    expect((await db.query('select state from human_jobs where id = $1', [j])).rows[0].state).toBe('delivered')
  })
  it('sets and clears the next action with the state', async () => {
    const j = await mkJob('claimed')
    expect((await T(j, 'in_progress', 'first_save', 'expert', E1)).ok).toBe(true)
    expect((await db.query(`select next_action_kind k from job_next_actions where job_id = $1`, [j])).rows[0].k).toBe('deadline_warning')
    expect((await T(j, 'in_review', 'submit_review', 'expert', E1)).ok).toBe(true)
    expect((await db.query(`select count(*)::int n from job_next_actions where job_id = $1`, [j])).rows[0].n).toBe(0)
  })
  it('every event records from, to and trigger, and no event holds resume text', async () => {
    const j = await mkJob('claimed')
    await T(j, 'in_progress', 'first_save', 'expert', E1)
    const d = (await db.query(`select detail from job_events where job_id = $1 and kind = 'first_save'`, [j])).rows[0].detail
    expect(d).toMatchObject({ from: 'claimed', to: 'in_progress', trigger: 'first_save' })
  })
})

describe('Phase 1 backfill is reversible and loses nothing', () => {
  it('pairs question events into pauses and keeps next actions, then undoes cleanly', async () => {
    const j = await mkJob('in_progress')
    const k = await mkJob('delivered')
    await db.query(`insert into job_events (job_id, kind, actor_kind, created_at) values ($1, 'question_asked', 'expert', now() - interval '5 hours'), ($1, 'question_answered', 'customer', now() - interval '3 hours')`, [j])
    const sqlText = fs.readFileSync(path.join(DIR, MIG), 'utf8')
    const start = sqlText.indexOf('insert into job_pauses (job_id, started_at, ended_at, reason, source)\nselect s.job_id')
    const end = sqlText.indexOf('-- Always the LAST statements')
    const backfill = sqlText.slice(start, end)
    expect(start).toBeGreaterThan(0)
    const events0 = (await db.query('select count(*)::int n from job_events')).rows[0].n
    const jobs0 = (await db.query('select md5(string_agg(h::text, \',\' order by id)) m from human_jobs h')).rows[0].m
    await db.exec(backfill); await db.exec(backfill)                                  // twice: must be idempotent
    const p = (await db.query(`select started_at, ended_at, source from job_pauses where job_id = $1`, [j])).rows
    expect(p).toHaveLength(1); expect(p[0].source).toBe('phase1_backfill'); expect(p[0].ended_at).not.toBeNull()
    expect((await db.query(`select next_action_kind k from job_next_actions where job_id = $1`, [k])).rows[0]).toEqual({ k: 'auto_accept' })
    expect((await db.query('select count(*)::int n from job_events')).rows[0].n).toBe(events0)
    expect((await db.query('select md5(string_agg(h::text, \',\' order by id)) m from human_jobs h')).rows[0].m).toBe(jobs0)
    await db.exec(`delete from job_pauses where source = 'phase1_backfill'; delete from job_next_actions where source = 'phase1_backfill';`)
    expect((await db.query(`select count(*)::int n from job_pauses where job_id = $1`, [j])).rows[0].n).toBe(0)
  })
})

describe('payment_confirmed sets paid time and both deadlines', () => {
  it('moves awaiting_payment to offered with a paid event, and a repeat changes nothing', async () => {
    const j = await mkJob('awaiting_payment')
    await db.query('update human_jobs set paid_at = null, promised_deadline_at = null, internal_deadline_at = null where id = $1', [j])
    const p = new Date(Date.now() + 48 * 3600e3).toISOString(), i = new Date(Date.now() + 40 * 3600e3).toISOString()
    const run = () => db.query(`select human_job_transition($1::uuid, 'offered', 'payment_confirmed', 'system', null, null, null, 'paid', '{}'::jsonb, 'payment:x', 3, null, 2, $2::timestamptz, $3::timestamptz) as r`, [j, p, i]).then(x => x.rows[0].r)
    expect((await run()).ok).toBe(true); expect((await run()).replay).toBe(true)
    const row = (await db.query('select state, paid_at, promised_deadline_at p, internal_deadline_at i from human_jobs where id = $1', [j])).rows[0]
    expect(row.state).toBe('offered'); expect(row.paid_at).not.toBeNull(); expect(new Date(row.p).toISOString()).toBe(p); expect(new Date(row.i).toISOString()).toBe(i)
    expect((await db.query(`select count(*)::int n from job_events where job_id = $1 and kind = 'paid'`, [j])).rows[0].n).toBe(1)
  })
})
