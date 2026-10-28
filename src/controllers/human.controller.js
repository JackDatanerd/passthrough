// Experts Phase 1 (concierge pilot): the CUSTOMER side of a human order. Behind EXPERTS_ENABLED (routes/human.routes.js answers the
// app's 404 for every route while the flag is off) and an allow-list of accounts.
//
//   GET  /api/human/config                      what may be ordered, at what price, with the exact consent wording
//   POST /api/human/orders                      start an order: brief + consents + Paystack checkout (payment row, job row, frozen documents)
//   GET  /api/human/orders , /orders/:id        the customer's own orders / one order
//   POST /api/human/orders/:id/materials        add a supporting file (before an expert takes the order)
//   POST /api/human/orders/:id/links , DELETE /materials/:mid
//   POST /api/human/orders/:id/questions/:qid   answer an expert's question
//   POST /api/human/orders/:id/accept | revision | rate | cancel
//   GET  /api/human/orders/:id/files/:kind      download the delivered files
//
// What this deliberately does NOT do: resolve a discount / welcome / referral / partner code, reserve a usage slot, stamp attribution
// or commission, apply a promo price. This file imports none of that code; the price is the settings row, nothing else.

const { z } = require('zod')
const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const pilot = require('../lib/humanPilot')
const locks = require('../lib/humanLocks')
const fieldCrypto = require('../lib/fieldCrypto')
const { hasResumeContent } = require('../lib/resumeData')
const paystackService = require('../services/paystack.service')
const emailService = require('../services/email.service')

const bad = (ctx, message, status = 400, extra = {}) => ctx.json({ success: false, message, ...extra }, status)
const readJson = async ctx => { try { return await ctx.req.json() } catch (_) { return undefined } }
const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

// The wording the owner approved in docs/experts/phase0/06-checkout-wording.docx. Rows 5 and 6 carry their bracketed sentences
// as written there: the Phase 0 document marks them "to confirm" and CHANGES-experts-phase-1.txt lists them as such.
const TERMS_VERSION = 'phase0-wording-1'
const WORDING = {
  termsConsent: 'I understand this is a professional writing service. A vetted contractor will see my resume, with my name and contact details hidden. I have read how revisions and refunds work, and I know no result is guaranteed.',
  age: 'I am 18 or older.',
  rights: "If my resume includes other people's details (for example referees), I have the right to share them.",
  learning: 'Let Passthrough use my edited resume, with my contact details removed, to improve its automated fixes.',
  privacy: 'Your name, email, phone, address and links are hidden from the expert. The expert sees the rest of your resume and your brief. The expert may be in a different country from you. Details are in our Privacy Policy.',
  refunds: 'If we deliver late, we credit you the rush premium automatically. If we are more than 48 hours late, we offer a full refund. You can cancel for a full refund until an expert takes your order.',
  terms: 'By paying, you agree to the Terms of Service and the Human Rewrite Addendum, and you have read the Privacy Policy.',
  codes: 'Codes apply to the AI Fix only. Your code was not used on this order and is still saved.',
  materials: 'Optional: the more real numbers and examples you add, the fewer questions we will need to ask.',
}
const REGIONS = ['US', 'UK', 'EU', 'Canada', 'Gulf', 'Africa', 'Other']
const TONES = ['conservative', 'balanced', 'assertive']

const briefSchema = z.object({
  targetRole: z.string().trim().min(2).max(200),
  seniority: z.string().trim().max(100).optional().default(''),
  jobPosting: z.string().trim().max(20000).optional().default(''),
  region: z.enum(REGIONS),
  keepAvoid: z.string().trim().max(1000).optional().default(''),
  story: z.string().trim().max(2000).optional().default(''),
  tone: z.enum(TONES).optional().default('balanced'),
  notes: z.string().trim().max(2000).optional().default(''),
  topResults: z.array(z.object({ result: z.string().trim().max(300), number: z.string().trim().max(100), confirmer: z.string().trim().max(200) }).strict()).max(3).optional().default([]),
}).strict()
const orderBody = z.object({
  scanId: z.string().refine(isUuid, 'Invalid scan.'),
  tier: z.enum(pilot.TIERS),
  addCoverLetter: z.boolean().optional().default(false),
  brief: briefSchema,
  consents: z.object({ terms: z.literal(true), age: z.literal(true), rights: z.literal(true), learning: z.boolean().optional().default(false) }).strict(),
  code: z.string().max(100).optional(),            // accepted and IGNORED: the human line never reads a code (WORDING.codes)
}).strict()

const STATUS_LABEL = {
  awaiting_payment: 'Waiting for payment', offered: 'Order received: waiting for an expert', open: 'Order received: waiting for an expert',
  claimed: 'An expert has your order', in_progress: 'In progress', waiting_customer: 'The expert has a question for you', in_review: 'Final checks',
  final_checks: 'Final checks', delivered: 'Ready: please review', revision: 'Revision in progress', accepted: 'Accepted',
  disputed: 'Payment disputed', refunded: 'Refunded', cancelled: 'Cancelled',
}

const guardUser = (ctx) => {
  const user = ctx.get('user')
  if (!user) return { res: bad(ctx, 'Authentication required.', 401) }
  if (!pilot.userAllowed(ctx.env, user)) return { res: bad(ctx, 'Human rewrite is not available on your account yet.', 403) }
  return { user }
}

async function getConfig(ctx) {
  const user = ctx.get('user')
  if (!user || !pilot.userAllowed(ctx.env, user)) return ctx.json({ success: true, data: { available: false } })
  const supabase = getSupabase(ctx.env)
  const s = await pilot.loadSettings(supabase)
  if (!s || c.activeCurrency(ctx.env) !== 'USD' || !fieldCrypto.hasKey(ctx.env)) return ctx.json({ success: true, data: { available: false } })
  const tiers = pilot.TIERS.filter(t => s.tiers_enabled[t]).map(t => ({
    tier: t, label: pilot.tierLabel(t), priceCents: s.prices[t], turnaroundHours: (s.turnaround_hours && s.turnaround_hours[t]) || null }))
  const full = await capacityLeft(supabase, s)
  return ctx.json({ success: true, data: { available: full > 0, atCapacity: full <= 0, currency: 'USD', tiers, coverLetterCents: s.prices.cover_letter,
    wording: WORDING, termsVersion: TERMS_VERSION, regions: REGIONS, tones: TONES, acceptHours: s.accept_auto_hours,
    materials: { maxFiles: s.materials_max_files, maxBytes: s.materials_max_bytes } } })
}

// Paid orders count against the cap, and so do unpaid orders still inside their payment window (so two people cannot both take the last place).
async function capacityLeft(supabase, s) {
  const since = new Date(Date.now() - (s.pending_expiry_hours || 24) * 3600e3).toISOString()
  // The pilot is a few dozen orders: counting rows is exact and simple (no head/count query to get wrong).
  const { data: paid, error: e1 } = await supabase.from('human_jobs').select('id').not('paid_at', 'is', null)
  if (e1) throw e1
  const { data: pending, error: e2 } = await supabase.from('human_jobs').select('id').eq('state', 'awaiting_payment').gte('created_at', since)
  if (e2) throw e2
  return s.pilot_cap_orders - (paid || []).length - (pending || []).length
}

// Rebuild the shared lock map of a job from its sealed values (so later text, e.g. a material, never collides with earlier ids).
async function loadShared(env, supabase, jobId) {
  const { data, error } = await supabase.from('job_locked_values').select('path, value_enc').eq('job_id', jobId)
  if (error) throw error
  const shared = { locked: {}, n: 0 }
  for (const r of data || []) {
    shared.locked[r.path] = await fieldCrypto.openTaxId(env, r.value_enc)
    const m = /^c:(\d+)$/.exec(r.path); if (m) shared.n = Math.max(shared.n, Number(m[1]))
  }
  return shared
}
async function saveNewLocked(env, supabase, jobId, shared, alreadyStored) {
  const rows = []
  for (const [path, value] of Object.entries(shared.locked)) {
    if (alreadyStored.has(path)) continue
    const sealed = await fieldCrypto.sealTaxId(env, value)
    if (!sealed) throw new Error('field encryption key missing')
    rows.push({ job_id: jobId, path, value_enc: sealed })
  }
  if (rows.length) { const { error } = await supabase.from('job_locked_values').insert(rows); if (error) throw error }
}

async function createOrder(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const { user } = g
  const parsed = orderBody.safeParse(await readJson(ctx))
  if (!parsed.success) return bad(ctx, 'Please check the form: ' + (parsed.error.issues[0]?.message || 'invalid'), 400, { field: parsed.error.issues[0]?.path?.join('.') })
  const body = parsed.data
  if (c.activeCurrency(ctx.env) !== 'USD') return bad(ctx, 'Human rewrite is not available in this currency yet.', 503)
  if (!fieldCrypto.hasKey(ctx.env)) { console.error('[CRITICAL] human order: no field encryption key'); return bad(ctx, 'Human rewrite is not available right now.', 503) }
  const supabase = getSupabase(ctx.env)
  const settings = await pilot.loadSettings(supabase)
  if (!settings) { console.error('[CRITICAL] human order: settings missing'); return bad(ctx, 'Human rewrite is not available right now.', 503) }
  const q = pilot.quote(settings, body.tier, body.addCoverLetter)
  if (!q.ok) return bad(ctx, q.code === 'TIER_UNAVAILABLE' ? 'That option is not available right now.' : 'Unknown option.', q.code === 'TIER_UNAVAILABLE' ? 409 : 400, { code: q.code })

  // the scan: the caller's own, with a structured resume we can freeze
  const { data: scan, error: scanErr } = await supabase.from('scans')
    .select('id, user_id, ats_score, job_description_text, original_resume_data, rewritten_resume_data, cover_letter_text').eq('id', body.scanId).maybeSingle()
  if (scanErr) throw scanErr
  if (!scan || scan.user_id !== user.id) return bad(ctx, 'Scan not found.', 404)
  const source = scan.original_resume_data
  if (!source || !hasResumeContent(source)) return bad(ctx, 'Open your resume in the editor first so we have it in structured form, then order again.', 409, { code: 'NO_STRUCTURED_RESUME' })
  const draft = scan.rewritten_resume_data && hasResumeContent(scan.rewritten_resume_data) ? scan.rewritten_resume_data : null

  // an unpaid earlier attempt for the same resume is replaced; a live paid order blocks a second one
  const { data: prior, error: priorErr } = await supabase.from('human_jobs').select('id, state, payment_id').eq('customer_user_id', user.id).eq('scan_id', scan.id)
  if (priorErr) throw priorErr
  const live = (prior || []).find(j => !['awaiting_payment', 'cancelled', 'refunded'].includes(j.state))
  if (live) return bad(ctx, 'You already have a human order for this resume.', 409, { code: 'ALREADY_ORDERED', orderId: live.id })
  for (const j of (prior || []).filter(j => j.state === 'awaiting_payment')) {
    await supabase.from('payments').update({ status: 'ABANDONED' }).eq('id', j.payment_id).eq('status', 'PENDING')
    await supabase.rpc('human_job_reverse', { p_job: j.id, p_reason: 'replaced by a new attempt' })
  }

  if ((await capacityLeft(supabase, settings)) <= 0) return bad(ctx, 'We are at capacity for human rewrites right now. Please try again later.', 409, { code: 'PILOT_FULL' })

  // freeze: source, AI draft and the working copy, all behind one lock map
  const shared = { locked: {}, n: 0 }
  const src = locks.lockDocument(source, shared)
  const dr = draft ? locks.lockDocument(draft, shared) : null
  const working = dr ? dr.body : src.body
  let cover = null
  if (q.addCoverLetter) cover = { text: locks.lockText(scan.cover_letter_text || '', shared, source.name) }

  // the job's brief: the posting is stored as the customer gave it (the company name is masked from the expert when the job is read)
  const brief = { ...body.brief, jobPosting: body.brief.jobPosting || scan.job_description_text || '' }
  const now = new Date().toISOString()
  const reference = crypto.randomUUID()
  const payRow = { amount_cents: q.priceCents, currency: 'USD', status: 'PENDING', paystack_ref: reference, user_id: user.id, scan_id: null, fix_tier: null, product_kind: q.kind }
  const { data: pay, error: payErr } = await supabase.from('payments').insert(payRow).select('id').single()
  if (payErr) throw payErr
  const jobId = crypto.randomUUID()
  try {
    const { error: jobErr } = await supabase.from('human_jobs').insert({
      id: jobId, job_number: pilot.newJobNumber(), payment_id: pay.id, customer_user_id: user.id, scan_id: scan.id, tier: q.tier, add_cover_letter: q.addCoverLetter,
      tier_price_cents: q.tierPriceCents, cover_price_cents: q.coverPriceCents, price_cents: q.priceCents, expert_pay_cents: q.expertPayCents, currency: 'USD',
      state: 'awaiting_payment', brief, customer_region: body.brief.region, terms_consent_at: now, terms_version: TERMS_VERSION,
      age_attested: true, rights_attested: true, learning_consent: !!body.consents.learning, score_before: Number.isInteger(scan.ats_score) ? scan.ats_score : null })
    if (jobErr) throw jobErr
    const docs = [{ job_id: jobId, kind: 'source', version: 1, body: src.body }]
    if (dr) docs.push({ job_id: jobId, kind: 'ai_draft', version: 1, body: dr.body })
    docs.push({ job_id: jobId, kind: 'working', version: 1, body: working, cover_letter: cover })
    const { error: docErr } = await supabase.from('job_documents').insert(docs)
    if (docErr) throw docErr
    await saveNewLocked(ctx.env, supabase, jobId, shared, new Set())
    await supabase.from('job_events').insert({ job_id: jobId, kind: 'created', actor_kind: 'customer', actor_id: user.id, detail: { tier: q.tier, cover: q.addCoverLetter } })
  } catch (err) {
    console.error('human order: creating the job failed:', err.message)
    await supabase.from('payments').update({ status: 'ABANDONED' }).eq('id', pay.id).eq('status', 'PENDING')
    await supabase.from('human_jobs').delete().eq('id', jobId).eq('state', 'awaiting_payment')   // documents and locked values cascade
    return bad(ctx, 'We could not start your order. Please try again.', 500)
  }

  let init
  try {
    init = await paystackService.initializeTransaction(ctx.env, { email: user.email, amount: q.priceCents, userId: user.id, scanId: scan.id, fixTier: q.kind, reference,
      callbackUrl: `${String(ctx.env.FRONTEND_URL || '').replace(/\/$/, '')}/human/orders?reference=${reference}` })
  } catch (err) {
    await supabase.from('payments').update({ status: 'ABANDONED' }).eq('id', pay.id).eq('status', 'PENDING')
    await supabase.rpc('human_job_reverse', { p_job: jobId, p_reason: 'checkout could not start' })
    if (!err.paystackRejected) {
      console.error('[CRITICAL] Paystack initialize failed (human order):', err.message)
      try { await emailService.sendOwnerAlert(ctx.env, 'Paystack initialize failed  payments may be blocked', `human order checkout\nuserId: ${user.id}\nerror: ${err.message}`) } catch (_) {}
      return bad(ctx, "Payment could not be started right now. We've been notified. Please try again shortly.", 502)
    }
    return bad(ctx, 'Payment could not be started. Please try again.', 400)
  }
  await supabase.from('payments').update({ paystack_access_code: init.access_code }).eq('id', pay.id)
  return ctx.json({ success: true, data: { orderId: jobId, reference, accessCode: init.access_code, authorizationUrl: init.authorization_url || null,
    priceCents: q.priceCents, tier: q.tier, addCoverLetter: q.addCoverLetter, codeIgnored: body.code ? WORDING.codes : null } })
}

const ORDER_COLS = 'id, job_number, state, tier, add_cover_letter, price_cents, currency, brief, expert_id, promised_deadline_at, paid_at, delivered_at, accepted_at, auto_accept_at, revision_count, revision_requested_at, revision_reason, revision_due_at, score_before, score_after, rating_stars, created_at, scan_id'

function shape(j) {
  return { id: j.id, jobNumber: j.job_number, state: j.state, status: STATUS_LABEL[j.state] || j.state, tier: j.tier, tierLabel: pilot.tierLabel(j.tier), addCoverLetter: j.add_cover_letter,
    priceCents: j.price_cents, currency: j.currency, promisedAt: j.promised_deadline_at, paidAt: j.paid_at, deliveredAt: j.delivered_at, acceptedAt: j.accepted_at,
    autoAcceptAt: j.state === 'delivered' ? j.auto_accept_at : null, revisionUsed: (j.revision_count || 0) >= 1, revisionDueAt: j.state === 'revision' ? j.revision_due_at : null,
    scoreBefore: j.score_before, scoreAfter: j.score_after, rated: j.rating_stars != null, ratingStars: j.rating_stars, createdAt: j.created_at, scanId: j.scan_id }
}

async function ownJob(ctx, supabase, user, id, cols = ORDER_COLS) {
  if (!isUuid(id)) return null
  const { data, error } = await supabase.from('human_jobs').select(cols).eq('id', id).eq('customer_user_id', user.id).maybeSingle()
  if (error) throw error
  return data
}

async function listOrders(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const supabase = getSupabase(ctx.env)
  const { data, error } = await supabase.from('human_jobs').select(ORDER_COLS).eq('customer_user_id', g.user.id).order('created_at', { ascending: false }).limit(50)
  if (error) throw error
  return ctx.json({ success: true, data: { orders: (data || []).map(shape) } })
}

async function getOrder(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'))
  if (!j) return bad(ctx, 'Order not found.', 404)
  const [{ data: qs }, { data: dels }, { data: mats }, { data: ex }] = await Promise.all([
    supabase.from('job_questions').select('id, seq, body, status, answer_body, answer_deadline_at, asked_at').eq('job_id', j.id).order('seq'),
    supabase.from('job_deliveries').select('version, score_before, score_after, change_summary, delivered_at, files, confirmation_items').eq('job_id', j.id).order('version', { ascending: false }).limit(1),
    supabase.from('job_materials').select('id, kind, label, link_url, status').eq('job_id', j.id).neq('status', 'removed').order('created_at'),
    j.expert_id ? supabase.from('expert_accounts').select('display_first_name, display_initial').eq('id', j.expert_id).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const d = dels && dels[0]
  const canEditMaterials = ['awaiting_payment', 'offered', 'open'].includes(j.state)
  return ctx.json({ success: true, data: { ...shape(j), brief: j.brief,
    expert: ex ? `${ex.display_first_name} ${ex.display_initial}.` : null,
    questions: (qs || []).map(q => ({ id: q.id, seq: q.seq, body: q.body, status: q.status, answer: q.answer_body, answerBy: q.answer_deadline_at, askedAt: q.asked_at })),
    delivery: d ? { version: d.version, scoreBefore: d.score_before, scoreAfter: d.score_after, summary: d.change_summary, deliveredAt: d.delivered_at,
      files: { docx: !!(d.files && d.files.docx), pdf: !!(d.files && d.files.pdf), cover: !!(d.files && d.files.cover) },
      confirmations: Array.isArray(d.confirmation_items) ? d.confirmation_items.filter(x => x && x.text).map(x => ({ text: x.text, confirmed: !!x.confirmed })) : [] } : null,
    materials: (mats || []).map(m => ({ id: m.id, kind: m.kind, label: m.label, url: m.kind === 'link' ? m.link_url : null, status: m.status })), canEditMaterials,
    canCancel: ['offered', 'open'].includes(j.state), canAccept: j.state === 'delivered', canRevise: j.state === 'delivered' && (j.revision_count || 0) < 1,
    wording: { refunds: WORDING.refunds, privacy: WORDING.privacy } } })
}

const answerBody = z.object({ answer: z.string().trim().min(1).max(2000) }).strict()
async function answerQuestion(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const p = answerBody.safeParse(await readJson(ctx)); if (!p.success) return bad(ctx, 'Please write an answer.')
  const supabase = getSupabase(ctx.env), qid = ctx.req.param('qid')
  if (!isUuid(qid)) return bad(ctx, 'Question not found.', 404)
  const { data, error } = await supabase.rpc('human_job_answer', { p_job: ctx.req.param('id'), p_customer: g.user.id, p_question: qid, p_body: p.data.answer })
  if (error) throw error
  if (!data.ok) return bad(ctx, data.reason === 'closed' ? 'This question is closed.' : 'Question not found.', data.reason === 'closed' ? 409 : 404)
  return ctx.json({ success: true })
}

async function acceptOrder(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state'); if (!j) return bad(ctx, 'Order not found.', 404)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(ctx, 'Not available right now.', 503)
  const { data, error } = await supabase.rpc('human_job_accept', { p_job: j.id, p_actor_kind: 'customer', p_actor: g.user.id, p_hold_days: s.earnings_hold_days })
  if (error) throw error
  if (!data.ok) return bad(ctx, 'This order cannot be accepted yet.', 409, { state: data.state })
  return ctx.json({ success: true, data: { already: !!data.already } })
}

const revisionBody = z.object({ reason: z.string().trim().min(3).max(1500) }).strict()
async function requestRevision(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const p = revisionBody.safeParse(await readJson(ctx)); if (!p.success) return bad(ctx, 'Please tell us what is not right (a few words at least).')
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, tier'); if (!j) return bad(ctx, 'Order not found.', 404)
  const s = await pilot.loadSettings(supabase); if (!s) return bad(ctx, 'Not available right now.', 503)
  const hours = (s.revision_hours && (j.tier === 'twenty_four_hour' ? s.revision_hours.twenty_four_hour : s.revision_hours.other)) || 48
  const { data, error } = await supabase.rpc('human_job_request_revision', { p_job: j.id, p_customer: g.user.id, p_reason: p.data.reason, p_window_days: s.revision_window_days, p_hours: hours })
  if (error) throw error
  if (!data.ok) {
    const msg = { revision_used: 'The one revision included with your order has been used.', window_closed: 'The revision window has closed.', not_delivered: 'You can ask for a revision once the order is delivered.' }[data.reason] || 'This order cannot be revised.'
    return bad(ctx, msg, 409, { code: data.reason })
  }
  return ctx.json({ success: true })
}

const rateBody = z.object({ stars: z.number().int().min(1).max(5), tags: z.array(z.string().max(40)).max(6).optional() }).strict()
async function rateOrder(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const p = rateBody.safeParse(await readJson(ctx)); if (!p.success) return bad(ctx, 'Please choose 1 to 5 stars.')
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id'); if (!j) return bad(ctx, 'Order not found.', 404)
  const { data, error } = await supabase.rpc('human_job_rate', { p_job: j.id, p_customer: g.user.id, p_stars: p.data.stars, p_tags: p.data.tags || null })
  if (error) throw error
  if (!data.ok) return bad(ctx, 'You can rate an order once it has been delivered.', 409)
  return ctx.json({ success: true })
}

// Cancel for a full refund until an expert takes the order. The job closes first (so it cannot be assigned meanwhile), then the refund goes through
// the app's own refund path; if that fails the owner is told and refunds by hand.
async function cancelOrder(ctx) {
  const g = guardUser(ctx); if (g.res) return g.res
  const supabase = getSupabase(ctx.env)
  const j = await ownJob(ctx, supabase, g.user, ctx.req.param('id'), 'id, state, payment_id, job_number'); if (!j) return bad(ctx, 'Order not found.', 404)
  if (!['offered', 'open'].includes(j.state)) return bad(ctx, j.state === 'awaiting_payment' ? 'This order has not been paid.' : 'An expert has already taken this order, so it can no longer be cancelled here. Contact support and quote the order number.', 409)
  const { data: pay } = await supabase.from('payments').select('*').eq('id', j.payment_id).maybeSingle()
  const { data: closed, error } = await supabase.rpc('human_job_reverse', { p_job: j.id, p_reason: 'customer cancelled' })
  if (error) throw error
  if (!closed.ok) return bad(ctx, 'This order cannot be cancelled.', 409)
  let refund = { ok: false }
  try { refund = await require('../services/refund.service').queueRefund(ctx.env, supabase, pay, { merchantNote: `Human order ${j.job_number} cancelled by the customer`, customerNote: 'Human rewrite cancelled before an expert took it' }) } catch (err) { refund = { ok: false, message: err.message } }
  if (!refund.ok) {
    try { await emailService.sendOwnerAlert(ctx.env, `Human order ${j.job_number} cancelled: REFUND IT BY HAND`, `The customer cancelled before an expert took it. The automatic refund did not go through (${refund.message || refund.code}).\nreference: ${pay && pay.paystack_ref}`, { dedupeKey: `human-cancel-${j.id}` }) } catch (_) {}
  }
  return ctx.json({ success: true, data: { refund: refund.ok ? 'QUEUED' : 'REVIEW' } })
}

module.exports = { getConfig, createOrder, listOrders, getOrder, answerQuestion, acceptOrder, requestRevision, rateOrder, cancelOrder, WORDING, TERMS_VERSION, STATUS_LABEL,
  _internal: { loadShared, saveNewLocked, capacityLeft, ownJob, guardUser, bad, isUuid } }
