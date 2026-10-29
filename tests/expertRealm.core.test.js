// Experts Phase 2A: the pure core: state machine table (and its parity with the migration), permission matrix, clocks, audit hygiene, and static
// guards (one place moves state; the realm never reads the main app's secret or a bearer header; no sensitive content in logs).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
const require_ = createRequire(import.meta.url)
const SM = require_('../src/lib/expertRealm/stateMachine.js')
const P = require_('../src/lib/expertRealm/permissions.js')
const K = require_('../src/lib/expertRealm/clock.js')
const { safeDetail } = require_('../src/services/expertAudit.service.js')
const R = path.resolve(__dirname, '..')
const read = f => fs.readFileSync(path.join(R, f), 'utf8')

describe('state machine table', () => {
  it('is exactly the migration seed (same rows, same actors)', () => {
    const sql = read('supabase/migrations/0127_experts_phase2a_realm.sql'); const block = sql.slice(sql.indexOf('insert into job_transition_rules'), sql.indexOf('on conflict do nothing;', sql.indexOf('insert into job_transition_rules')))
    const rows = [...block.matchAll(/\('(\w+)',\s*'(\w+)',\s*'(\w+)',\s*array\[([^\]]*)\]\)/g)].map(m => `${m[1]}>${m[2]}:${m[3]}:${m[4].replace(/'/g, '').split(',').map(x => x.trim()).sort().join(',')}`)
    expect(rows.sort()).toEqual(SM.RULES.map(r => `${r.from}>${r.to}:${r.trigger}:${[...r.actors].sort().join(',')}`).sort())
  })
  it('table-driven: every (from, to, trigger, actor) combination is allowed iff the table says so', () => {
    const pairs = [...new Set(SM.RULES.map(r => `${r.to}|${r.trigger}`))].map(s => s.split('|')); let legal = 0, illegal = 0
    for (const from of SM.STATES) for (const [to, trigger] of pairs) for (const actorKind of SM.ACTOR_KINDS) {
      const expected = SM.RULES.some(r => r.from === from && r.to === to && r.trigger === trigger && r.actors.includes(actorKind)); const got = SM.check({ from, to, trigger, actorKind })
      expect(got.ok, `${from}>${to}:${trigger}:${actorKind}`).toBe(expected); if (!expected) expect(got.code).toBe('ILLEGAL_TRANSITION'); expected ? legal++ : illegal++
    }
    expect(legal).toBeGreaterThanOrEqual(SM.RULES.length); expect(illegal).toBeGreaterThan(1000)
  })
  it('terminal states have no way out, and nothing moves into a state from a state it was never next to', () => {
    for (const s of SM.TERMINAL) expect(SM.RULES.filter(r => r.from === s)).toEqual([])
    expect(SM.check({ from: 'delivered', to: 'in_progress', trigger: 'first_save', actorKind: 'expert' }).ok).toBe(false)
    expect(SM.check({ from: 'accepted', to: 'delivered', trigger: 'redeliver', actorKind: 'expert' }).ok).toBe(false)
    expect(SM.check({ from: 'refunded', to: 'accepted', trigger: 'accept', actorKind: 'customer' }).ok).toBe(false)
  })
  it('only the customer accepts, only the system times out, only an operator assigns', () => {
    for (const r of SM.RULES) { if (r.trigger === 'accept') expect(r.actors).toEqual(['customer']); if (/timeout|auto_|expired|rescan|payment_/.test(r.trigger)) expect(r.actors).toEqual(['system']); if (/^(assign|reassign|unassign|admin_cancel)$/.test(r.trigger)) expect(r.actors).toEqual(['operator']) }
  })
  it('a state holds an expert exactly when the schema says it must', () => { expect([...SM.CARRYING].sort()).toEqual(['accepted', 'claimed', 'delivered', 'final_checks', 'in_progress', 'in_review', 'revision', 'waiting_customer']) })
  it('triggersFrom reports what an actor may do next', () => {
    expect(SM.triggersFrom('delivered', 'customer').map(t => t.trigger).sort()).toEqual(['accept', 'dispute', 'request_revision'].sort())
    expect(SM.triggersFrom('offered', 'expert').map(t => t.trigger)).toEqual(['take'])
  })
  it('the next action per state is the same rule the database applies', () => {
    const t = '2026-10-01T00:00:00Z'
    expect(SM.nextActionFor('in_progress', { internalDeadlineAt: t })).toEqual({ at: '2026-10-01T00:00:00.000Z', kind: 'deadline_warning' })
    expect(SM.nextActionFor('delivered', { autoAcceptAt: t }).kind).toBe('auto_accept'); expect(SM.nextActionFor('waiting_customer', { answerDeadlineAt: t }).kind).toBe('question_timeout')
    expect(SM.nextActionFor('awaiting_payment', { createdAt: t }).at).toBe('2026-10-02T00:00:00.000Z'); for (const s of ['open', 'in_review', 'accepted', 'refunded']) expect(SM.nextActionFor(s, { internalDeadlineAt: t })).toBeNull()
  })
})

describe('permission matrix', () => {
  it('matches the engineering spec table cell by cell', () => {
    const want = { // action: [expert, grader, expert_admin, expert_support]
      'brief.view_anonymised': 'Y-YY', 'job.take': 'Y---', 'job.view_full': 'MMYY', 'job.view_contact': '--Y-', 'job.edit_document': 'M---', 'job.deliver': 'M---', 'review.decide': '-Y Y-'.replace(' ', ''),
      'earnings.view': 'MMYY', 'standing.change': '--Y-', 'money.refund': '--Y-', 'settings.change': '--Y-', 'expert.pause_resume_end': '--Y-' }
    for (const [action, cells] of Object.entries(want)) P.ROLES.forEach((role, i) => expect(P.MATRIX[action][role], `${action} ${role}`).toBe(cells[i]))
  })
  it('money, unmasking and settings need a fresh password; standing, assignment and refunds need a reason', () => {
    for (const a of ['money.refund', 'job.view_contact', 'settings.change']) expect(P.MATRIX[a].stepUp, a).toBe(true)
    for (const a of ['money.refund', 'job.view_contact', 'standing.change', 'job.assign', 'job.reassign', 'expert.pause_resume_end', 'settings.change']) expect(P.MATRIX[a].reason, a).toBe(true)
  })
  it('support has no money, no contact details, no standing changes, no directory, no audit log', () => {
    for (const a of ['money.refund', 'job.view_contact', 'standing.change', 'settings.change', 'directory.view', 'audit.view', 'job.assign']) expect(P.can(['expert_support'], a).allowed, a).toBe(false)
  })
  it('can(): the strongest role wins, unknown roles and unknown actions get nothing', () => {
    expect(P.can(['expert', 'expert_admin'], 'job.view_full').scope).toBe('any'); expect(P.can(['expert'], 'job.view_full').scope).toBe('own')
    expect(P.can(['root'], 'money.refund').allowed).toBe(false); expect(P.can(['expert_admin'], 'not.an.action').allowed).toBe(false); expect(P.can([], 'account.self').allowed).toBe(false)
  })
  it('a route with no policy cannot be defined', () => {
    const fake = { get() {} }; expect(() => P.define(fake, 'x', 'get', '/a', {}, () => {})).toThrow(/no permission policy/); expect(() => P.define(fake, 'x', 'get', '/a', { action: 'nope' }, () => {})).toThrow(/unknown action/)
  })
})

describe('clocks from events', () => {
  const ev = (id, kind, at, detail = {}) => ({ id, kind, created_at: at, detail })
  it('pairs Phase 1 question events and engine events into pauses; an unanswered question is an open pause', () => {
    const p = K.pausesFromEvents([ev(1, 'question_asked', '2026-10-01T00:00:00Z'), ev(2, 'question_answered', '2026-10-01T05:00:00Z'), ev(3, 'ask_question', '2026-10-02T00:00:00Z', { to: 'waiting_customer' })])
    expect(p).toEqual([{ started: '2026-10-01T00:00:00.000Z', ended: '2026-10-01T05:00:00.000Z' }, { started: '2026-10-02T00:00:00.000Z', ended: null }])
    expect(K.pausedSeconds(p, '2026-10-02T01:00:00Z')).toBe(5 * 3600 + 3600)
  })
  it('the deadline moves later by exactly the paused time, and the clock stands still while paused', () => {
    const closed = [{ started: '2026-10-01T10:00:00Z', ended: '2026-10-01T15:00:00Z' }]
    const c = K.clockFrom({ paidAt: '2026-10-01T00:00:00Z', turnaroundHours: 48, bufferHours: 6, pauses: closed, now: '2026-10-02T00:00:00Z' })
    expect(c.promisedAt).toBe('2026-10-03T05:00:00.000Z'); expect(c.internalAt).toBe('2026-10-02T23:00:00.000Z'); expect(c.pausedSeconds).toBe(18000)
    const open = K.clockFrom({ paidAt: '2026-10-01T00:00:00Z', turnaroundHours: 48, pauses: [{ started: '2026-10-01T10:00:00Z', ended: null }], now: '2026-10-01T20:00:00Z' })
    expect(open.paused).toBe(true); expect(open.remainingMs).toBe(38 * 3600e3)           // 48 hours minus the 10 that had passed when the question was asked
    const later = K.clockFrom({ paidAt: '2026-10-01T00:00:00Z', turnaroundHours: 48, pauses: [{ started: '2026-10-01T10:00:00Z', ended: null }], now: '2026-10-01T23:00:00Z' })
    expect(later.remainingMs).toBe(open.remainingMs)                                          // three more hours of waiting cost nothing
  })
  it('reconcile flags a stored paused_seconds that disagrees with the events', () => {
    const p = [{ started: '2026-10-01T00:00:00Z', ended: '2026-10-01T05:00:00Z' }]
    expect(K.reconcile({ paused_seconds: 18000 }, p, '2026-10-05T00:00:00Z').ok).toBe(true); expect(K.reconcile({ paused_seconds: 100 }, p, '2026-10-05T00:00:00Z').ok).toBe(false)
  })
  it('a missing paid time or turnaround gives no clock rather than a wrong one', () => { expect(K.clockFrom({ paidAt: null, turnaroundHours: 48, now: 'x' })).toBeNull(); expect(K.clockFrom({ paidAt: 'x', turnaroundHours: undefined, now: 'x' })).toBeNull() })
})

describe('audit hygiene: no resume text, contact details or secrets', () => {
  it('safeDetail drops anything that could carry content and cuts long strings', () => {
    const d = safeDetail({ email: 'a@b.co', phone: '1', resume_text: 'x', body: 'x', password: 'p', token: 't', url: 'u', cookie: 'c', name: 'n', note_text: 'x', job_id: 'j1', count: 3, ok: true, reason_code: 'duplicate', long: 'x'.repeat(500), nested: { a: 1 }, list: [1, 2, 'a'] })
    expect(Object.keys(d).sort()).toEqual(['count', 'job_id', 'list', 'long', 'ok', 'reason_code'].sort()); expect(d.long).toHaveLength(120)
  })
})

describe('static guards', () => {
  const realmFiles = ['src/lib/expertRealm/config.js', 'src/lib/expertRealm/crypto.js', 'src/lib/expertRealm/permissions.js', 'src/lib/expertRealm/stateMachine.js', 'src/lib/expertRealm/clock.js', 'src/middleware/expertRealm.js',
    'src/services/expertSession.service.js', 'src/services/expertAudit.service.js', 'src/services/expertBridge.service.js', 'src/services/humanJobs.service.js', 'src/services/expertMail.service.js',
    'src/controllers/expert-realm-auth.controller.js', 'src/controllers/expert-realm.controller.js', 'src/controllers/expert-admin.controller.js', 'src/routes/expert-realm.routes.js']
  it('the realm never reads an Authorization header and never signs or verifies with the main app secret', () => {
    for (const f of realmFiles) { const s = read(f).replace(/\/\/.*$/gm, ''); expect(/authorization/i.test(s), f).toBe(f === 'src/services/expertAudit.service.js')       // (the audit writer only NAMES it, in its list of keys to drop)
      ; expect(/JWT_SECRET(?!.*EXPERT)/.test(s.replace(/EXPERT_JWT_SECRET|EXPERT_REALM_SECRET/g, '')), f).toBe(f === 'src/lib/expertRealm/config.js' ? true : false) }
  })
  it('nothing in the realm writes a job\'s state except the engine call (human_job_transition)', () => {
    for (const f of realmFiles) { const s = read(f); expect(/update\(\s*\{[^}]*\bstate\s*:/.test(s), f).toBe(false); expect(/\.rpc\('human_job_(assign|accept|reverse|deliver|ask|submit|unassign|confirm_payment|return)/.test(s), f).toBe(false) }
    expect(read('src/services/humanJobs.service.js')).toContain("rpc('human_job_transition'")
  })
  it('the realm does not call any main-app admin controller or the main auth middleware', () => {
    for (const f of realmFiles) { const s = read(f); expect(/controllers\/admin[-.]/.test(s.replace(/expert-admin\.controller/g, '')), f).toBe(false); expect(/middleware\/(auth|adminOnly|stepUp)/.test(s), f).toBe(false) }
  })
  it('the bridge exposes exactly three functions', () => { expect(Object.keys(require_('../src/services/expertBridge.service.js')).sort()).toEqual(['createJobFromPayment', 'readHumanOrderPayment', 'refundHumanOrder']) })
  it('no realm file logs a request body, a cookie, an email or resume text', () => {
    for (const f of realmFiles) for (const line of read(f).split('\n').filter(l => /console\.(log|error|warn|info)/.test(l))) expect(/(body|cookie|email|password|token|resume|req\.json)/i.test(line.replace(/\[CRITICAL\].*/, '')) && !/failed:|backend error|CRITICAL|err\.message/.test(line), `${f}: ${line.trim()}`).toBe(false)
  })
  it('every new migration object is locked down: RLS on, no anon grant, execute revoked', () => {
    const sql = read('supabase/migrations/0127_experts_phase2a_realm.sql'); const tables = [...sql.matchAll(/create table if not exists (\w+)/g)].map(m => m[1]); expect(tables.length).toBe(8)
    for (const t of tables) { expect(sql).toContain(`alter table ${t} enable row level security;`); expect(sql).toContain(`revoke all on ${t} from anon, authenticated;`) }
    expect(sql).toMatch(/revoke execute on function %s from public, anon, authenticated/); expect(/\b(drop|truncate)\b/i.test(sql.replace(/--.*$/gm, ''))).toBe(false); expect(/alter table (?!\w+ enable row level security)/i.test(sql.replace(/--.*$/gm, ''))).toBe(false)
  })
})
