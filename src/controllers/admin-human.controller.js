// Experts Phase 1: the operator's side, inside the EXISTING admin area (the pilot exception in the spec). The router that mounts this
// is behind the main app's admin auth (adminOnly) and, for anything that moves money or shows a person's resume, the same step-up the
// other money routes use. There is no expert-realm admin in Phase 1.
const bcrypt = require('bcryptjs')
const { z } = require('zod')
const { getSupabase } = require('../config/supabase')
const { logAdminAction } = require('../lib/adminAudit')
const pilot = require('../lib/humanPilot')
const delivery = require('../services/humanDelivery.service')

const bad = (c, message, status = 400, extra = {}) => c.json({ success: false, message, ...extra }, status)
const readJson = async c => { try { return await c.req.json() } catch (_) { return undefined } }
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const opId = c => { const u = c.get('user'); return u && u.id ? u.id : null }
const STATES = ['awaiting_payment', 'offered', 'open', 'claimed', 'in_progress', 'waiting_customer', 'in_review', 'final_checks', 'delivered', 'revision', 'accepted', 'disputed', 'refunded', 'cancelled']

const LIST_COLS = 'id, job_number, state, tier, add_cover_letter, price_cents, expert_pay_cents, customer_user_id, expert_id, paid_at, promised_deadline_at, internal_deadline_at, delivered_at, revision_count, rating_stars, created_at, payment_id'
async function listOrders(c) {
  const supabase = getSupabase(c.env)
  const state = c.req.query('state')
  let q = supabase.from('human_jobs').select(LIST_COLS).order('created_at', { ascending: false }).limit(200)
  if (state) { if (!STATES.includes(state)) return bad(c, 'Unknown state.'); q = q.eq('state', state) }
  const { data, error } = await q; if (error) throw error
  const jobs = data || []
  const [{ data: users }, { data: experts }, { data: pays }, s] = await Promise.all([
    supabase.from('users').select('id, email').in('id', [...new Set(jobs.map(j => j.customer_user_id))]),
    supabase.from('expert_accounts').select('id, display_first_name, display_initial').in('id', [...new Set(jobs.map(j => j.expert_id).filter(Boolean))]),
    supabase.from('payments').select('id, status').in('id', jobs.map(j => j.payment_id)),
    pilot.loadSettings(supabase),
  ])
  const email = Object.fromEntries((users || []).map(u => [u.id, u.email])), ex = Object.fromEntries((experts || []).map(x => [x.id, `${x.display_first_name} ${x.display_initial}.`])), pay = Object.fromEntries((pays || []).map(p => [p.id, p.status]))
  const { data: all } = await supabase.from('human_jobs').select('id, state, paid_at')
  const counts = {}; for (const j of all || []) counts[j.state] = (counts[j.state] || 0) + 1
  return c.json({ success: true, data: { orders: jobs.map(j => ({ id: j.id, jobNumber: j.job_number, state: j.state, tier: j.tier, coverLetter: j.add_cover_letter, priceCents: j.price_cents, payCents: j.expert_pay_cents,
    customer: email[j.customer_user_id] || null, expert: j.expert_id ? ex[j.expert_id] || null : null, expertId: j.expert_id, paymentStatus: pay[j.payment_id] || null, paidAt: j.paid_at,
    dueAt: j.promised_deadline_at, internalDueAt: j.internal_deadline_at, deliveredAt: j.delivered_at, revised: j.revision_count > 0, rating: j.rating_stars, createdAt: j.created_at,
    overdue: !!j.promised_deadline_at && !['delivered', 'accepted', 'refunded', 'cancelled'].includes(j.state) && new Date(j.promised_deadline_at) < new Date() })),
    counts, capacity: s ? { cap: s.pilot_cap_orders, paid: (all || []).filter(j => j.paid_at).length } : null } })
}

async function getOrder(c) {
  const id = c.req.param('id'); if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const supabase = getSupabase(c.env)
  const { data: j, error } = await supabase.from('human_jobs').select('*').eq('id', id).maybeSingle(); if (error) throw error
  if (!j) return bad(c, 'Not found.', 404)
  await delivery.logView(supabase, opId(c), 'view_order', id)
  const [{ data: ev }, { data: qs }, { data: mats }, { data: dels }, { data: user }, { data: pay }, { data: ex }] = await Promise.all([
    supabase.from('job_events').select('kind, actor_kind, created_at, detail').eq('job_id', id).order('id'),
    supabase.from('job_questions').select('seq, body, status, answer_body, asked_at, answer_deadline_at').eq('job_id', id).order('seq'),
    supabase.from('job_materials').select('id, kind, label, link_url, status, extracted_masked_text').eq('job_id', id).neq('status', 'removed'),
    supabase.from('job_deliveries').select('version, score_before, score_after, change_summary, delivered_at, confirmation_items, delivery_note').eq('job_id', id).order('version'),
    supabase.from('users').select('email, name').eq('id', j.customer_user_id).maybeSingle(),
    supabase.from('payments').select('paystack_ref, status, amount_cents, currency').eq('id', j.payment_id).maybeSingle(),
    j.expert_id ? supabase.from('expert_accounts').select('id, display_first_name, display_initial, email').eq('id', j.expert_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const { purged_at, ...job } = j
  return c.json({ success: true, data: { job: { ...job, purged: !!purged_at }, customer: user, payment: pay, expert: ex, events: ev || [], questions: qs || [],
    materials: (mats || []).map(m => ({ id: m.id, kind: m.kind, label: m.label, url: m.link_url, textChars: m.extracted_masked_text ? m.extracted_masked_text.length : 0 })), deliveries: dels || [],
    activeMinutes: Math.round((j.active_edit_seconds || 0) / 60) } })
}

const assignBody = z.object({ expertId: z.string().refine(isUuid) }).strict()
async function assign(c) {
  const p = assignBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Choose an expert.')
  const id = c.req.param('id'); const supabase = getSupabase(c.env)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(c, 'Settings missing.', 503)
  const { data, error } = await supabase.rpc('human_job_assign', { p_job: id, p_expert: p.data.expertId, p_operator: opId(c), p_max_active: s.concurrent_cap || 2 })
  if (error) throw error
  const msg = { not_found: 'Order not found.', not_assignable: 'This order cannot be assigned now.', not_eligible: 'That expert is not switched on, active and a worker.', two_factor_missing: 'That expert has not set up two-factor yet.',
    agreement_missing: 'The expert agreement is not marked signed.', cap: 'That expert is at their limit of open jobs.' }
  if (!data.ok) return bad(c, msg[data.reason] || 'Could not assign.', data.reason === 'not_found' ? 404 : 409, { code: data.reason })
  await logAdminAction(c, supabase, 'human.assign', 'human_job', id, { expertId: p.data.expertId })
  return c.json({ success: true })
}

async function unassign(c) {
  const body = (await readJson(c)) || {}; const id = c.req.param('id'); const supabase = getSupabase(c.env)
  const { data, error } = await supabase.rpc('human_job_unassign', { p_job: id, p_operator: opId(c), p_reason: typeof body.reason === 'string' ? body.reason.slice(0, 120) : null })
  if (error) throw error
  if (!data.ok) return bad(c, 'This order cannot be taken back now.', 409, { code: data.reason })
  await logAdminAction(c, supabase, 'human.unassign', 'human_job', id, {})
  return c.json({ success: true })
}

async function review(c) {
  const id = c.req.param('id'); if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const r = await delivery.buildReview(c.env, getSupabase(c.env), id, opId(c))
  if (!r.ok) return bad(c, r.code === 'NOT_REVIEWABLE' ? 'There is nothing to review in this state.' : 'Nothing to review.', r.code === 'NOT_FOUND' ? 404 : 409, { code: r.code })
  const { job, ...rest } = r
  return c.json({ success: true, data: { ...rest, state: job.state, tier: job.tier, brief: job.brief } })
}

async function returnToExpert(c) {
  const body = (await readJson(c)) || {}; const id = c.req.param('id'); const supabase = getSupabase(c.env)
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length < 3) return bad(c, 'Tell the expert what to change.')
  const { data, error } = await supabase.rpc('human_job_return_to_expert', { p_job: id, p_operator: opId(c), p_note: note })
  if (error) throw error
  if (!data.ok) return bad(c, 'This order is not waiting for review.', 409)
  await logAdminAction(c, supabase, 'human.return', 'human_job', id, {})
  return c.json({ success: true })
}

const deliverBody = z.object({ note: z.string().max(1000).optional(), summary: z.string().max(1000).optional(), confirmed: z.array(z.string().max(40)).max(50).optional(), overrideReason: z.string().max(300).optional() }).strict()
async function deliverOrder(c) {
  const p = deliverBody.safeParse((await readJson(c)) || {}); if (!p.success) return bad(c, 'Check the delivery form.')
  const id = c.req.param('id'); const supabase = getSupabase(c.env)
  const r = await delivery.deliver(c.env, supabase, id, opId(c), p.data)
  if (!r.ok) {
    const msg = { MARKERS_MISSING: 'Locked details are missing from the document. Send it back to the expert.', UNCONFIRMED_FIGURES: 'Some figures are not in anything the customer gave us. Confirm each one, or give a reason to override.',
      NOT_IN_REVIEW: 'This order is not waiting for review.', PDF_FAILED: 'The PDF could not be built. Try again in a minute.', NO_SETTINGS: 'Settings missing.', NOT_FOUND: 'Order not found.', NOTHING_SAVED: 'Nothing was saved.' }
    return bad(c, msg[r.code] || 'Could not deliver.', ['NOT_FOUND'].includes(r.code) ? 404 : r.code === 'PDF_FAILED' ? 502 : 409, { code: r.code, figures: r.figures, missing: r.missing })
  }
  await logAdminAction(c, supabase, 'human.deliver', 'human_job', id, { version: r.deliveryVersion, overridden: !!p.data.overrideReason })
  return c.json({ success: true, data: r })
}

const recordBody = z.object({ expertMinutes: z.number().int().min(0).max(5000).nullable().optional(), otherCostCents: z.number().int().min(0).max(1000000).optional(), lateCreditCents: z.number().int().min(0).max(1000000).optional(), note: z.string().max(500).nullable().optional() }).strict()
async function record(c) {
  const p = recordBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Check the numbers.')
  const patch = {}
  if (p.data.expertMinutes !== undefined) patch.expert_minutes_reported = p.data.expertMinutes
  if (p.data.otherCostCents !== undefined) patch.other_cost_cents = p.data.otherCostCents
  if (p.data.lateCreditCents !== undefined) patch.late_credit_cents = p.data.lateCreditCents
  if (p.data.note !== undefined) patch.operator_note = p.data.note
  if (!Object.keys(patch).length) return bad(c, 'Nothing to record.')
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('human_jobs').update(patch).eq('id', c.req.param('id')).select('id'); if (error) throw error
  if (!data || !data.length) return bad(c, 'Order not found.', 404)
  return c.json({ success: true })
}

async function acceptForCustomer(c) {
  const id = c.req.param('id'); const supabase = getSupabase(c.env); const s = await pilot.loadSettings(supabase); if (!s) return bad(c, 'Settings missing.', 503)
  const { data, error } = await supabase.rpc('human_job_accept', { p_job: id, p_actor_kind: 'operator', p_actor: opId(c), p_hold_days: s.earnings_hold_days }); if (error) throw error
  if (!data.ok) return bad(c, 'This order is not delivered.', 409)
  await logAdminAction(c, supabase, 'human.accept', 'human_job', id, {})
  return c.json({ success: true, data: { already: !!data.already } })
}

// Refund through the app's own refund path. The webhook that follows reverses the payment, which closes the job and reverses earnings (humanSettle).
async function refund(c) {
  const id = c.req.param('id'); const supabase = getSupabase(c.env)
  const { data: j } = await supabase.from('human_jobs').select('id, payment_id, job_number').eq('id', id).maybeSingle(); if (!j) return bad(c, 'Not found.', 404)
  const { data: pay } = await supabase.from('payments').select('*').eq('id', j.payment_id).maybeSingle()
  if (!pay || pay.status !== 'SUCCESS') return bad(c, `The payment is ${pay ? pay.status : 'missing'}, so there is nothing to refund.`, 409)
  const r = await require('../services/refund.service').queueRefund(c.env, supabase, pay, { merchantNote: `Human order ${j.job_number} refunded by the operator`, customerNote: 'Refund from Passthrough' })
  await logAdminAction(c, supabase, 'human.refund', 'human_job', id, { ok: !!r.ok, code: r.code || null })
  if (!r.ok) return bad(c, r.message || 'The refund could not be started.', r.status || 502, { code: r.code })
  return c.json({ success: true, data: { queued: true } })
}

// ── experts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const EXPERT_COLS = 'id, email, display_first_name, display_initial, status, enabled, totp_enabled_at, agreement_signed_at, agreement_version, last_login_at, created_at'
async function listExperts(c) {
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('expert_accounts').select(EXPERT_COLS).order('created_at'); if (error) throw error
  const { data: jobs } = await supabase.from('human_jobs').select('expert_id, state').in('state', ['claimed', 'in_progress', 'waiting_customer', 'in_review', 'revision'])
  const { data: earn } = await supabase.from('expert_earnings').select('expert_id, amount_cents, release_at, payout_id')
  const now = Date.now()
  return c.json({ success: true, data: { experts: (data || []).map(e => {
    const mine = (earn || []).filter(r => r.expert_id === e.id)
    return { id: e.id, email: e.email, name: `${e.display_first_name} ${e.display_initial}.`, status: e.status, enabled: e.enabled, twoFactor: !!e.totp_enabled_at, agreementSigned: !!e.agreement_signed_at,
      lastLoginAt: e.last_login_at, openJobs: (jobs || []).filter(j => j.expert_id === e.id).length,
      availableCents: mine.filter(r => !r.payout_id && new Date(r.release_at).getTime() <= now).reduce((n, r) => n + r.amount_cents, 0),
      onHoldCents: mine.filter(r => !r.payout_id && new Date(r.release_at).getTime() > now).reduce((n, r) => n + r.amount_cents, 0),
      paidCents: mine.filter(r => r.payout_id).reduce((n, r) => n + r.amount_cents, 0) } }) } })
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const tempPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => ALPHABET[b % ALPHABET.length]).join('')
const createBody = z.object({ email: z.string().trim().toLowerCase().email().max(320), firstName: z.string().trim().min(1).max(40), initial: z.string().trim().min(1).max(2) }).strict()
async function createExpert(c) {
  const p = createBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Email, first name and one initial are needed.')
  const supabase = getSupabase(c.env); const password = tempPassword()
  const { data, error } = await supabase.from('expert_accounts').insert({ email: p.data.email, password_hash: await bcrypt.hash(password, 10), display_first_name: p.data.firstName, display_initial: p.data.initial.toUpperCase(), status: 'probation', enabled: false }).select('id').single()
  if (error) { if (error.code === '23505') return bad(c, 'An expert with that email already exists.', 409); throw error }
  await logAdminAction(c, supabase, 'human.expert_create', 'expert_account', data.id, {})
  return c.json({ success: true, data: { id: data.id, temporaryPassword: password, note: 'Shown once. The expert signs in, then sets up two-factor. The account is switched OFF until you enable it.' } })
}

const patchBody = z.object({ enabled: z.boolean().optional(), status: z.enum(['probation', 'active', 'paused', 'ended']).optional(), agreementSigned: z.boolean().optional(), agreementVersion: z.string().max(40).optional(), resetTwoFactor: z.literal(true).optional(), resetPassword: z.literal(true).optional() }).strict()
async function patchExpert(c) {
  const id = c.req.param('id'); if (!isUuid(id)) return bad(c, 'Not found.', 404)
  const p = patchBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Nothing valid to change.')
  const supabase = getSupabase(c.env); const d = p.data
  const { data: cur } = await supabase.from('expert_accounts').select('id, token_version').eq('id', id).maybeSingle(); if (!cur) return bad(c, 'Not found.', 404)
  const patch = { updated_at: new Date().toISOString() }; let password = null
  if (d.enabled !== undefined) patch.enabled = d.enabled
  if (d.status) patch.status = d.status
  if (d.agreementSigned) { patch.agreement_signed_at = new Date().toISOString(); patch.agreement_version = d.agreementVersion || 'pilot-agreement' }
  if (d.resetTwoFactor) { patch.totp_secret_enc = null; patch.totp_enabled_at = null; patch.totp_last_step = null; patch.token_version = (cur.token_version || 0) + 1 }
  if (d.resetPassword) { password = tempPassword(); patch.password_hash = await bcrypt.hash(password, 10); patch.token_version = (cur.token_version || 0) + 1; patch.failed_logins = 0; patch.locked_until = null }
  if (d.enabled === false || d.status === 'paused' || d.status === 'ended') patch.token_version = (cur.token_version || 0) + 1       // switching off ends live sessions
  const { error } = await supabase.from('expert_accounts').update(patch).eq('id', id); if (error) throw error
  await logAdminAction(c, supabase, 'human.expert_update', 'expert_account', id, { fields: Object.keys(d) })
  return c.json({ success: true, data: password ? { temporaryPassword: password } : {} })
}

const payoutBody = z.object({ expertId: z.string().refine(isUuid), method: z.string().trim().min(2).max(40), reference: z.string().trim().max(120).optional(), idempotencyKey: z.string().trim().min(8).max(80), note: z.string().max(300).optional() }).strict()
async function recordPayout(c) {
  const p = payoutBody.safeParse(await readJson(c)); if (!p.success) return bad(c, 'Choose an expert, a method and a payment reference.')
  const supabase = getSupabase(c.env); const s = await pilot.loadSettings(supabase); if (!s) return bad(c, 'Settings missing.', 503)
  const { data, error } = await supabase.rpc('expert_record_payout', { p_expert: p.data.expertId, p_method: p.data.method, p_reference: p.data.reference || null, p_key: p.data.idempotencyKey, p_min_cents: s.payout_min_cents || 2500, p_note: p.data.note || null })
  if (error) throw error
  if (!data.ok) return bad(c, data.reason === 'below_minimum' ? 'Not enough is available to pay out yet.' : 'Could not record the payout.', 409, { code: data.reason, availableCents: data.available_cents })
  await logAdminAction(c, supabase, 'human.payout', 'expert_account', p.data.expertId, { amountCents: data.amount_cents, already: !!data.already })
  return c.json({ success: true, data })
}

// The pilot's numbers (runbook / spec 22): what the gate decision is made from.
async function summary(c) {
  const supabase = getSupabase(c.env)
  const { data, error } = await supabase.from('human_jobs').select('state, tier, price_cents, expert_pay_cents, other_cost_cents, late_credit_cents, paid_at, delivered_at, promised_deadline_at, active_edit_seconds, expert_minutes_reported, revision_count, rating_stars, score_before, score_after'); if (error) throw error
  const paid = (data || []).filter(j => j.paid_at)
  const done = paid.filter(j => j.delivered_at)
  const avg = a => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null)
  const mins = j => (j.expert_minutes_reported != null ? j.expert_minutes_reported : Math.round((j.active_edit_seconds || 0) / 60))
  const onTime = done.filter(j => j.promised_deadline_at).filter(j => new Date(j.delivered_at) <= new Date(j.promised_deadline_at))
  const kept = paid.filter(j => !['refunded', 'cancelled'].includes(j.state))
  const revenue = kept.reduce((n, j) => n + j.price_cents - (j.late_credit_cents || 0), 0), cost = kept.reduce((n, j) => n + j.expert_pay_cents + (j.other_cost_cents || 0), 0)
  return c.json({ success: true, data: { paid: paid.length, delivered: done.length, accepted: paid.filter(j => j.state === 'accepted').length, refunded: paid.filter(j => j.state === 'refunded').length,
    onTimePct: done.filter(j => j.promised_deadline_at).length ? Math.round(100 * onTime.length / done.filter(j => j.promised_deadline_at).length) : null,
    revisionPct: done.length ? Math.round(100 * done.filter(j => j.revision_count > 0).length / done.length) : null, avgMinutes: avg(done.map(mins)), avgRating: avg(paid.filter(j => j.rating_stars).map(j => j.rating_stars)),
    avgScoreGain: avg(done.filter(j => Number.isInteger(j.score_before) && Number.isInteger(j.score_after)).map(j => j.score_after - j.score_before)),
    revenueCents: revenue, costCents: cost, marginCents: revenue - cost, marginPct: revenue ? Math.round(100 * (revenue - cost) / revenue) : null } })
}

module.exports = { listOrders, getOrder, assign, unassign, review, returnToExpert, deliverOrder, record, acceptForCustomer, refund, listExperts, createExpert, patchExpert, recordPayout, summary }
