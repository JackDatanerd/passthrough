import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createWorld } from './helpers/memoryDb.cjs'
import { loadWithStubs } from './helpers/loadWithStubs.cjs'
const require_ = createRequire(import.meta.url)
const { Hono } = require_('hono')
const locks = require_('../src/lib/humanLocks')

// Experts Phase 1: the operator's review and delivery, the admin routes behind the flag, expert accounts, and the hourly sweep.

const SETTINGS = { prices: { polish: 1, seven_day: 1, forty_eight_hour: 11900, twenty_four_hour: 1, cover_letter: 2900 }, pay: { polish: 1, seven_day: 1, forty_eight_hour: 7000, twenty_four_hour: 1, cover_letter: 1800 },
  tiers_enabled: { polish: false, seven_day: true, forty_eight_hour: true, twenty_four_hour: true }, turnaround_hours: { forty_eight_hour: 48 }, pilot_cap_orders: 15, accept_auto_hours: 72, revision_window_days: 7,
  earnings_hold_days: 3, concurrent_cap: 2, payout_min_cents: 2500, retention_drafts_days: 90, pending_expiry_hours: 24 }
const RESUME = { name: 'Wanjiru Kamau', email: 'w@example.com', phone: '+254 712 345 678', summary: 'Product manager. Reach me at w@example.com.',
  experience: [{ company: 'Acme Ltd', title: 'PM', dates: '2019 - 2023', bullets: ['Grew users 40% across 3 markets.'] }], skills: ['SQL'] }
const SHARED = { locked: {}, n: 0 }
const SRC = locks.lockDocument(RESUME, SHARED)
const J = '55555555-5555-4555-8555-555555555555', U = '66666666-6666-4666-8666-666666666666', X = '77777777-7777-4777-8777-777777777777', OP = '88888888-8888-4888-8888-888888888888'
let t
afterEach(() => { t?.restore(); t = null })

function bucket() {
  const store = new Map()
  return { store, put: async (k, v) => { store.set(k, v) }, get: async k => (store.has(k) ? { body: store.get(k) } : null), delete: async keys => { for (const k of [].concat(keys)) store.delete(k) }, list: async () => ({ objects: [], truncated: false }) }
}
function world(over = {}) {
  const working = locks.restoreDocument(SRC.body, SHARED.locked) && SRC.body
  const w = createWorld({
    human_jobs: [{ id: J, job_number: 'HJ-AAAAAA', state: 'in_review', tier: 'forty_eight_hour', customer_user_id: U, expert_id: X, scan_id: 's1', score_before: 41, revision_count: 0, brief: { targetRole: 'PM', topResults: [{ result: 'Grew users', number: '40%', confirmer: 'CEO' }] }, payment_id: 'p1', add_cover_letter: false, ...over.job }],
    job_documents: [{ job_id: J, kind: 'source', version: 1, body: SRC.body }, { job_id: J, kind: 'working', version: 2, body: over.working || working, cover_letter: over.cover ?? null }],
    job_locked_values: Object.entries(SHARED.locked).map(([path, v]) => ({ job_id: J, path, value_enc: `enc:${v}` })),
    job_questions: [], job_materials: [], job_deliveries: [], job_events: [], expert_audit_log: [], expert_accounts: [], expert_earnings: [],
    users: [{ id: U, email: 'c@x.y', name: 'Cust', deleted_at: null }], scans: [{ id: 's1', job_description_text: 'We need a product manager with SQL.' }], payments: [{ id: 'p1', status: 'SUCCESS', paystack_ref: 'r1', amount_cents: 11900 }],
    system_state: [{ key: 'human_pilot', value: SETTINGS }] })
  return w
}
function delivery(w, { pdfFails = false } = {}) {
  const sent = []; const calls = []; const b = bucket()
  w.rpcs.human_job_deliver = a => { calls.push(a); const j = w.t.human_jobs[0]; j.state = 'delivered'; return { data: { ok: true, delivery_version: (j.revision_count || 0) + 1 }, error: null } }
  t = loadWithStubs('services/humanDelivery.service.js', {
    'lib/fieldCrypto.js': { openTaxId: async (e, v) => String(v).replace(/^enc:/, ''), openSealedStrict: async (e, v) => String(v).replace(/^enc:/, ''), hasKey: () => true },
    'services/pdf.service.js': { generateResumePDF: async () => { if (pdfFails) throw new Error('browser busy'); return new Uint8Array([37, 80, 68, 70]) } },
    'services/email.service.js': { sendHumanDelivered: async (...a) => { sent.push(a[2]); return true } },
  })
  return { svc: t.mod, env: { RESUMES_BUCKET: b }, sent, calls, bucket: b }
}

describe('review', () => {
  it('puts the locked values back for the operator, reports nothing missing, scores the result, and writes an audit row for the view', async () => {
    const w = world(); const d = delivery(w)
    const r = await d.svc.buildReview(d.env, w.db, J, OP)
    expect(r.ok).toBe(true); expect(r.resume).toEqual(RESUME); expect(r.missing).toEqual([])
    expect(Number.isInteger(r.scoreAfter)).toBe(true); expect(r.scoreBefore).toBe(41)
    expect(w.t.expert_audit_log).toEqual([expect.objectContaining({ actor_kind: 'operator', actor_id: OP, action: 'review_job_content', target_id: J })])
  })
  it('flags a locked detail that has gone missing, and figures that are in nothing the customer gave us', async () => {
    const body = JSON.parse(JSON.stringify(SRC.body)); delete body.email; body.experience[0].bullets = ['Grew users 40% across 3 markets.', 'Cut churn 55% in a year.']
    const w = world({ working: body }); const d = delivery(w)
    const r = await d.svc.buildReview(d.env, w.db, J, OP)
    expect(r.missing).toContain('lock:email'); expect(r.newFigures).toEqual(['55%'])
  })
  it('A3: a locked value that cannot be read stops the review and the delivery (it used to restore as a blank name and email)', async () => {
    const w = world(); const d = delivery(w)
    const unreadable = Object.assign(new Error('wrong key'), { code: 'LOCKED_VALUE_UNREADABLE' })
    const t2 = loadWithStubs('services/humanDelivery.service.js', {
      'lib/fieldCrypto.js': { openSealedStrict: async () => { throw unreadable }, hasKey: () => true },
      'services/pdf.service.js': { generateResumePDF: async () => new Uint8Array([1]) }, 'services/email.service.js': { sendHumanDelivered: async () => true } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await t2.mod.buildReview(d.env, w.db, J, OP)).toEqual({ ok: false, code: 'LOCKED_UNREADABLE' })
      expect(await t2.mod.deliver(d.env, w.db, J, OP, {})).toMatchObject({ ok: false, code: 'LOCKED_UNREADABLE' })
      expect(d.calls).toHaveLength(0); expect(d.sent).toHaveLength(0)
    } finally { err.mockRestore(); t2.restore() }
  })
  it('figures the customer supplied (brief top results, an answered question) are not flagged', async () => {
    const body = JSON.parse(JSON.stringify(SRC.body)); body.experience[0].bullets = ['Grew users 40% to 12000 accounts.']
    const w = world({ working: body }); w.t.job_questions.push({ job_id: J, status: 'answered', answer_body: 'We had 12000 accounts by year end' })
    const d = delivery(w); expect((await d.svc.buildReview(d.env, w.db, J, OP)).newFigures).toEqual([])
  })
})

describe('review: A5 audit', () => {
  it('a figure only the AI draft or the job posting carries is flagged and labelled; a figure in the customer\'s own edit is not', async () => {
    const body = JSON.parse(JSON.stringify(SRC.body)); body.experience[0].bullets = ['Grew users 40% across 3 markets.', 'Cut churn 70%, 10+ years, 12 reports, 25% faster.']
    const w = world({ working: body, job: { brief: { targetRole: 'PM', jobPosting: 'We need 10+ years of SQL' } } })
    w.t.job_documents.push({ job_id: J, kind: 'ai_draft', version: 1, body: { ...SRC.body, experience: [{ ...SRC.body.experience[0], bullets: ['Cut churn 70%.'] }] } })
    w.t.scans[0].user_edited_resume_data = { summary: 'Made onboarding 25% faster' }
    const d = delivery(w); const r = await d.svc.buildReview(d.env, w.db, J, OP)
    expect(r.newFigures).toEqual(expect.arrayContaining(['70%', '10+', '12'])); expect(r.newFigures).not.toContain('25%')
    expect(r.newFigureDetails).toEqual(expect.arrayContaining([{ text: '70%', origin: 'ai_draft' }, { text: '10+', origin: 'job_posting' }, { text: '12', origin: 'nowhere' }]))
  })
  it('a field the customer\'s draft never carried is not reported missing (the job used to be undeliverable, and nobody could fix it)', async () => {
    const draft = JSON.parse(JSON.stringify(SRC.body)); delete draft.phone
    const w = world({ working: draft }); w.t.job_documents.push({ job_id: J, kind: 'ai_draft', version: 1, body: draft })
    const d = delivery(w); expect((await d.svc.buildReview(d.env, w.db, J, OP)).missing).toEqual([])
    const noEmail = JSON.parse(JSON.stringify(draft)); delete noEmail.email; w.t.job_documents.find(x => x.kind === 'working').body = noEmail
    expect((await d.svc.buildReview(d.env, w.db, J, OP)).missing).toEqual(['lock:email'])
  })
  it('a cover letter that was not ordered is not delivered', async () => {
    const w = world({ cover: { text: 'Dear team, I am keen.' } })
    const d = delivery(w); expect((await d.svc.buildReview(d.env, w.db, J, OP)).cover).toBeNull()
  })
})

describe('delivery', () => {
  it('builds the Word and PDF files, stores them, records the scores and the diff through the database function, and tells the customer once', async () => {
    const w = world(); const d = delivery(w)
    const r = await d.svc.deliver(d.env, w.db, J, OP, { summary: 'Tightened the bullets.', note: 'n' })
    expect(r).toMatchObject({ ok: true, deliveryVersion: 1, files: ['docx', 'pdf'] })
    expect([...d.bucket.store.keys()].sort()).toEqual([`human/${J}/delivery-1/resume.docx`, `human/${J}/delivery-1/resume.pdf`])
    const a = d.calls[0]
    expect(a).toMatchObject({ p_job: J, p_score_before: 41, p_auto_hours: 72, p_summary: 'Tightened the bullets.', p_files: { docx: `human/${J}/delivery-1/resume.docx`, pdf: `human/${J}/delivery-1/resume.pdf` } })
    expect(JSON.stringify(a.p_diff)).not.toContain('w@example.com')
    expect(d.sent).toEqual(['c@x.y'])
    const docx = d.bucket.store.get(`human/${J}/delivery-1/resume.docx`); expect(docx.length || docx.byteLength).toBeGreaterThan(1000)
  })
  it('adds the cover letter file when one was ordered', async () => {
    const w = world({ job: { add_cover_letter: true }, cover: { text: locks.lockText('Dear team, I am Wanjiru. Write to w@example.com.', SHARED, RESUME.name) } }); const d = delivery(w)
    const r = await d.svc.deliver(d.env, w.db, J, OP); expect(r.files).toEqual(['docx', 'pdf', 'cover'])
  })
  it('refuses while a locked detail is missing, while a new figure is unconfirmed (unless confirmed or overridden with a reason); nothing is stored or changed', async () => {
    const body = JSON.parse(JSON.stringify(SRC.body)); body.experience[0].bullets = ['Cut churn 55%.']
    const w = world({ working: body }); const d = delivery(w)
    expect(await d.svc.deliver(d.env, w.db, J, OP)).toMatchObject({ ok: false, code: 'UNCONFIRMED_FIGURES', figures: ['55%'] })
    expect(d.bucket.store.size).toBe(0); expect(w.t.human_jobs[0].state).toBe('in_review')
    expect((await d.svc.deliver(d.env, w.db, J, OP, { confirmed: ['55%'] })).ok).toBe(true)
    const w2 = world({ working: body }); const d2 = delivery(w2)
    expect((await d2.svc.deliver(d2.env, w2.db, J, OP, { overrideReason: 'customer confirmed by phone' })).ok).toBe(true)
    const gone = JSON.parse(JSON.stringify(SRC.body)); delete gone.name
    const w3 = world({ working: gone }); const d3 = delivery(w3)
    expect(await d3.svc.deliver(d3.env, w3.db, J, OP)).toMatchObject({ ok: false, code: 'MARKERS_MISSING', missing: ['lock:name'] })
  })
  it('a PDF that cannot be built aborts the delivery: no files kept, no state change, no email', async () => {
    const w = world(); const d = delivery(w, { pdfFails: true })
    expect(await d.svc.deliver(d.env, w.db, J, OP)).toMatchObject({ ok: false, code: 'PDF_FAILED' })
    expect(d.bucket.store.size).toBe(0); expect(d.calls).toHaveLength(0); expect(d.sent).toHaveLength(0); expect(w.t.human_jobs[0].state).toBe('in_review')
  })
  it('only an order waiting for review can be delivered', async () => {
    const w = world({ job: { state: 'in_progress' } }); const d = delivery(w)
    const r = await d.svc.deliver(d.env, w.db, J, OP); expect(r.ok).toBe(false)
  })
})

describe('the admin routes', () => {
  function build(w, { admin = true } = {}) {
    for (const k of Object.keys(require_.cache)) if (/[\\/]src[\\/](controllers[\\/]admin-human|routes[\\/]admin-human)/.test(k)) delete require_.cache[k]
    const stepUp = vi.fn(async (c, next) => next())
    const adminMw = Object.assign(async (c, next) => next(), { stepUp })
    t = loadWithStubs('routes/admin-human.routes.js', {
      'config/supabase.js': { getSupabase: () => w.db }, 'middleware/adminOnly.js': adminMw, 'lib/adminAudit.js': { logAdminAction: async () => {} },
      'services/humanDelivery.service.js': { buildReview: async () => ({ ok: true, job: { state: 'in_review', tier: 'forty_eight_hour', brief: {} } }), deliver: async () => ({ ok: true }), logView: async () => {} },
    })
    const app = new Hono(); app.use('*', async (c, next) => { c.set('user', { id: OP, role: 'admin' }); return next() }); app.route('/api/admin/human', t.mod); app.notFound(c => c.json({ success: false, message: 'Not found.' }, 404))
    t.stepUp = stepUp; return app
  }
  const call = (a, m, p, body, env = { EXPERTS_ENABLED: 'true' }) => a.request(p, { method: m, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env)

  it('flag off: every admin human route is the ordinary 404', async () => {
    const a = build(world())
    for (const [m, p] of [['GET', '/api/admin/human/orders'], ['GET', '/api/admin/human/summary'], ['GET', '/api/admin/human/experts'], ['POST', '/api/admin/human/experts'], ['POST', '/api/admin/human/payouts'], ['POST', `/api/admin/human/orders/${J}/assign`]])
      expect((await call(a, m, p, m === 'POST' ? {} : undefined, {})).status, p).toBe(404)
  })
  it('lists orders with state filter, counts, payment status and capacity', async () => {
    const w = world(); const a = build(w)
    const d = (await (await call(a, 'GET', '/api/admin/human/orders?state=in_review')).json()).data
    expect(d.orders).toHaveLength(1); expect(d.orders[0]).toMatchObject({ jobNumber: 'HJ-AAAAAA', customer: 'c@x.y', paymentStatus: 'SUCCESS', state: 'in_review' })
    expect(d.counts).toEqual({ in_review: 1 }); expect(d.capacity).toEqual({ cap: 15, paid: 0 })
    expect((await call(a, 'GET', '/api/admin/human/orders?state=nonsense')).status).toBe(400)
  })
  it('assigns through the database function with the cap from settings, and relays its refusals in plain words', async () => {
    const w = world(); const seen = []
    w.rpcs.human_job_assign = args => { seen.push(args); return { data: seen.length === 1 ? { ok: true } : { ok: false, reason: 'two_factor_missing' }, error: null } }
    const a = build(w)
    expect((await call(a, 'POST', `/api/admin/human/orders/${J}/assign`, { expertId: X })).status).toBe(200)
    expect(seen[0]).toEqual({ p_job: J, p_expert: X, p_operator: OP, p_max_active: 2 })
    const r = await call(a, 'POST', `/api/admin/human/orders/${J}/assign`, { expertId: X }); expect(r.status).toBe(409); expect((await r.json()).message).toMatch(/two-factor/)
  })
  it('money and privacy routes go through step-up: review, deliver, refund, create/patch expert, payouts', async () => {
    const w = world(); w.rpcs.expert_record_payout = () => ({ data: { ok: true, payout_id: 'x', amount_cents: 5000 }, error: null }); const a = build(w)
    t.stepUp.mockClear()
    for (const [m, p, body] of [['GET', `/api/admin/human/orders/${J}/review`], ['POST', `/api/admin/human/orders/${J}/deliver`, {}], ['POST', `/api/admin/human/orders/${J}/refund`, {}], ['POST', '/api/admin/human/experts', { email: 'a@b.co', firstName: 'A', initial: 'B' }], ['PATCH', `/api/admin/human/experts/${X}`, { enabled: true }], ['POST', '/api/admin/human/payouts', { expertId: X, method: 'mpesa', idempotencyKey: 'key-12345' }]])
      await call(a, m, p, body)
    expect(t.stepUp).toHaveBeenCalledTimes(6)
  })
  it('creating an expert stores a hashed password, shows the temporary one once, and leaves the account switched OFF', async () => {
    const w = world(); const a = build(w)
    const r = await (await call(a, 'POST', '/api/admin/human/experts', { email: 'New@Ex.com', firstName: 'Ann', initial: 'k' })).json()
    expect(r.data.temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/)
    const row = w.t.expert_accounts[0]
    expect(row).toMatchObject({ email: 'new@ex.com', enabled: false, status: 'probation', display_initial: 'K' }); expect(row.password_hash).toMatch(/^\$2[aby]\$/); expect(JSON.stringify(row)).not.toContain(r.data.temporaryPassword)
    expect((await call(a, 'POST', '/api/admin/human/experts', { email: 'bad', firstName: 'A', initial: 'B' })).status).toBe(400)
  })
  it('resetting two-factor clears it and ends live sessions; switching an expert off ends them too; enabling does not', async () => {
    const w = world(); w.t.expert_accounts.push({ id: X, email: 'e@x.co', token_version: 3, totp_secret_enc: 'enc:S', totp_enabled_at: 'x', totp_last_step: 9, enabled: true, status: 'active' }); const a = build(w)
    await call(a, 'PATCH', `/api/admin/human/experts/${X}`, { resetTwoFactor: true })
    expect(w.t.expert_accounts[0]).toMatchObject({ totp_secret_enc: null, totp_enabled_at: null, totp_last_step: null, token_version: 4 })
    await call(a, 'PATCH', `/api/admin/human/experts/${X}`, { enabled: false }); expect(w.t.expert_accounts[0].token_version).toBe(5)
    await call(a, 'PATCH', `/api/admin/human/experts/${X}`, { enabled: true, agreementSigned: true }); expect(w.t.expert_accounts[0]).toMatchObject({ token_version: 5, enabled: true }); expect(w.t.expert_accounts[0].agreement_signed_at).toBeTruthy()
    const pw = await (await call(a, 'PATCH', `/api/admin/human/experts/${X}`, { resetPassword: true })).json(); expect(pw.data.temporaryPassword).toHaveLength(16)
  })
  it('a payout is requested with an idempotency key and the minimum from settings; below the minimum is a plain 409', async () => {
    const w = world(); let seen; w.rpcs.expert_record_payout = a => { seen = a; return { data: { ok: false, reason: 'below_minimum', available_cents: 900 }, error: null } }; const a = build(w)
    const r = await call(a, 'POST', '/api/admin/human/payouts', { expertId: X, method: 'mpesa', reference: 'ABC', idempotencyKey: 'key-12345' })
    expect(r.status).toBe(409); expect(seen).toMatchObject({ p_expert: X, p_key: 'key-12345', p_min_cents: 2500 })
    expect((await call(a, 'POST', '/api/admin/human/payouts', { expertId: X, method: 'mpesa', idempotencyKey: 'short' })).status).toBe(400)
  })
  it('the summary computes the pilot numbers: on-time, revisions, minutes, rating, margin', async () => {
    const w = world(); w.t.human_jobs.length = 0
    const base = { state: 'accepted', tier: 'forty_eight_hour', price_cents: 11900, expert_pay_cents: 7000, other_cost_cents: 400, late_credit_cents: 0, paid_at: 'x', promised_deadline_at: '2026-11-03T00:00:00Z', revision_count: 0, rating_stars: 5, score_before: 40, score_after: 80, active_edit_seconds: 3600, expert_minutes_reported: null }
    w.t.human_jobs.push({ ...base, delivered_at: '2026-11-02T00:00:00Z' }, { ...base, delivered_at: '2026-11-04T00:00:00Z', revision_count: 1, rating_stars: 3, active_edit_seconds: 7200 }, { ...base, state: 'refunded', delivered_at: null })
    const d = (await (await call(build(w), 'GET', '/api/admin/human/summary')).json()).data
    expect(d).toMatchObject({ paid: 3, delivered: 2, accepted: 2, refunded: 1, onTimePct: 50, revisionPct: 50, avgMinutes: 90, avgRating: 4.3, avgScoreGain: 40, revenueCents: 23800, costCents: 14800, marginCents: 9000, marginPct: 38 })
  })
})

describe('the hourly sweep', () => {
  function sweep(w, env = { EXPERTS_ENABLED: 'true' }) {
    const rpcCalls = []
    w.rpcs.human_job_expire_questions = () => { rpcCalls.push('expire'); return { data: 2, error: null } }
    w.rpcs.human_job_auto_accept_due = a => { rpcCalls.push(['accept', a]); return { data: 1, error: null } }
    w.rpcs.human_job_reverse = ({ p_job }) => { rpcCalls.push(['reverse', p_job]); const j = w.t.human_jobs.find(x => x.id === p_job); j.state = 'cancelled'; return { data: { ok: true, state: 'cancelled' }, error: null } }
    const b = bucket()
    t = loadWithStubs('services/humanSweep.js', { 'config/supabase.js': { getSupabase: () => w.db } })
    return { run: (extra = {}) => t.mod.runHumanSweep({ ...env, RESUMES_BUCKET: b }, extra), purge: id => t.mod.purgeJob({ RESUMES_BUCKET: b }, w.db, id), rpcCalls, b }
  }
  it('does nothing at all while the flag is off', async () => {
    const w = world(); const s = sweep(w, {}); expect(await s.run()).toEqual({ skipped: true }); expect(s.rpcCalls).toEqual([])
  })
  it('expires questions, auto-accepts with the hold from settings, closes and purges unpaid orders past their window, and leaves paid ones', async () => {
    const w = world({ job: { state: 'awaiting_payment', expert_id: null, created_at: '2026-10-01T00:00:00Z' } })
    w.t.payments[0].status = 'PENDING'
    w.t.job_materials.push({ id: 'm1', job_id: J, kind: 'file', original_object_key: 'human/x/m', extracted_masked_text: 't', status: 'ready' })
    const s = sweep(w); await s.b.put('human/x/m', new Uint8Array([1]))
    const r = await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })
    expect(r).toMatchObject({ questions: 2, autoAccepted: 1, unpaid: 1 })
    expect(s.rpcCalls).toEqual(['expire', ['accept', { p_hold_days: 3 }], ['reverse', J]])
    expect(w.t.payments[0].status).toBe('ABANDONED'); expect(w.t.job_documents).toHaveLength(0); expect(w.t.job_locked_values).toHaveLength(0); expect(s.b.store.size).toBe(0)
    expect(w.t.human_jobs[0].purged_at).toBeTruthy()
  })
  it('an unpaid order whose payment actually succeeded is left for settlement', async () => {
    const w = world({ job: { state: 'awaiting_payment', expert_id: null, created_at: '2026-10-01T00:00:00Z' } })
    const s = sweep(w); const r = await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })
    expect(r.unpaid).toBe(0); expect(w.t.job_documents.length).toBeGreaterThan(0)
  })
  it('retention: a finished job past the retention period loses its files, documents and locked values; the row, events and earnings stay; a repeat does nothing', async () => {
    const w = world({ job: { state: 'accepted', updated_at: '2026-06-01T00:00:00Z' } })
    w.t.job_deliveries.push({ id: 'd1', job_id: J, files: { docx: 'human/J/d.docx', pdf: 'human/J/d.pdf' } })
    const s = sweep(w); await s.b.put('human/J/d.docx', new Uint8Array([1])); await s.b.put('human/J/d.pdf', new Uint8Array([1]))
    expect((await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })).retention).toBe(1)
    expect(s.b.store.size).toBe(0); expect(w.t.job_documents).toHaveLength(0); expect(w.t.job_locked_values).toHaveLength(0)
    expect(w.t.human_jobs).toHaveLength(1); expect(w.t.human_jobs[0].brief).toEqual({}); expect(w.t.job_deliveries[0].files).toEqual({})
    expect((await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })).retention).toBe(0)
  })
  it('a job inside the retention period is kept; a deleted account\'s finished job is purged at once; one still delivered is not', async () => {
    const w = world({ job: { state: 'accepted', updated_at: '2026-10-20T00:00:00Z' } })
    const s = sweep(w); expect((await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })).retention).toBe(0)
    w.t.users[0].deleted_at = '2026-10-26T00:00:00Z'
    expect((await s.run({ now: Date.parse('2026-10-27T00:00:00Z') })).retention).toBe(1)
  })
  it('if a stored file cannot be deleted the rows are KEPT so the next run retries', async () => {
    const w = world({ job: { state: 'accepted', updated_at: '2026-06-01T00:00:00Z' } }); w.t.job_deliveries.push({ id: 'd1', job_id: J, files: { pdf: 'human/J/d.pdf' } })
    const s = sweep(w); const env = { RESUMES_BUCKET: { delete: async () => { throw new Error('r2 down') } } }
    const r = await t.mod.purgeJob(env, w.db, J); expect(r.ok).toBe(false); expect(w.t.job_documents.length).toBeGreaterThan(0)
  })
})
