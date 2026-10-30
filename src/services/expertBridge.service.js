// Experts Phase 2A: the bridge between the expert realm and the main app. Exactly three functions, each doing ONE thing, called server to
// server from the realm's own routes, each logged in expert_bridge_calls (and the realm audit log by the caller). The realm never gets
// main-admin rights: it cannot call any main admin route, it holds no main admin token, and these three are the whole surface.
//
//   refundHumanOrder(...)       queue a refund on the payment behind one HUMAN order, through the app's existing refund path
//   readHumanOrderPayment(...)  read that payment's status (amount, currency, status, refunded or not): nothing about the customer
//   createJobFromPayment(...)   move a paid human order from awaiting_payment to offered (idempotent, keyed on the payment)
const { queueRefund } = require('./refund.service')
const { transition } = require('./humanJobs.service')
const pilot = require('../lib/humanPilot')
const { isHumanKind } = pilot

const PAYMENT_COLS = 'id, amount_cents, currency, status, paystack_ref, product_kind, user_id'

async function paymentOfJob(supabase, jobId) {
  const { data: job } = await supabase.from('human_jobs').select('id, state, payment_id, price_cents').eq('id', jobId).maybeSingle()
  if (!job) return { error: { ok: false, code: 'NOT_FOUND', status: 404 } }
  const { data: payment } = await supabase.from('payments').select(PAYMENT_COLS).eq('id', job.payment_id).maybeSingle()
  // never a non-human order, even if somebody passes a job id that points at one by mistake
  if (!payment || !isHumanKind(payment.product_kind)) return { error: { ok: false, code: 'NOT_A_HUMAN_ORDER', status: 409 } }
  return { job, payment }
}

// one row per call; a repeated (fn, idem_key) cannot start a second action: the unique index refuses it and we return what the first did
async function begin(supabase, row) {
  const { data, error } = await supabase.from('expert_bridge_calls').insert({ ...row, outcome: 'started' }).select('id').maybeSingle()
  if (error) {
    if (row.idem_key && /duplicate|unique/i.test(error.message || '')) {
      const { data: prior } = await supabase.from('expert_bridge_calls').select('id, outcome, code, job_id, amount_cents').eq('fn', row.fn).eq('idem_key', row.idem_key).maybeSingle()
      return { replay: true, prior }
    }
    throw error
  }
  return { id: data.id }
}
const finish = (supabase, id, outcome, code) => supabase.from('expert_bridge_calls').update({ outcome, code: code || null }).eq('id', id)

async function refundHumanOrder(env, supabase, { jobId, amountCents = null, reason, actorId, idemKey }) {
  if (!idemKey) return { ok: false, code: 'KEY_REQUIRED', status: 400 }
  if (amountCents !== null && !(Number.isInteger(amountCents) && amountCents > 0)) return { ok: false, code: 'BAD_AMOUNT', status: 400 }
  const found = await paymentOfJob(supabase, jobId); if (found.error) return found.error
  const b = await begin(supabase, { fn: 'refund_human_order', job_id: jobId, actor_id: actorId, idem_key: idemKey, amount_cents: amountCents, reason: String(reason || '').slice(0, 300) })
  if (b.replay) {
    // AUDIT A2 (B1, B2): a key is the identity of ONE request. It only replays for the same job and amount; anything else is refused loudly
    // (it used to answer "queued, replay" for a different job while nothing was queued for it). A first attempt that never finished
    // ('started') is not an answer either way, and says so. A refusal replays as a refusal, never as a 200.
    const p = b.prior
    if (!p || p.job_id !== jobId || (p.amount_cents ?? null) !== amountCents) return { ok: false, code: 'KEY_REUSED', status: 409, message: 'That request key was already used for a different refund. Use a new key.' }
    if (p.outcome === 'ok') return { ok: true, replay: true, status: 200 }
    if (p.outcome === 'started') return { ok: false, replay: true, code: 'UNFINISHED', status: 409, message: 'A refund with this key started but did not finish. Check the payment before trying again with a new key.' }
    return { ok: false, replay: true, code: p.code || 'PRIOR_REFUSED', status: 409 }
  }
  let r
  try { r = await queueRefund(env, supabase, found.payment, { amountCents, merchantNote: 'Passthrough Experts refund', customerNote: 'Refund from Passthrough' }) }
  catch (err) { await finish(supabase, b.id, 'failed', 'EXCEPTION'); throw err }
  await finish(supabase, b.id, r.ok ? 'ok' : 'refused', r.ok ? null : r.code)
  return r.ok ? { ok: true, amountCents: r.amountCents, partial: r.partial, queued: r.queued, status: 200 } : { ok: false, code: r.code, status: r.status || 409, message: r.message }
}

async function readHumanOrderPayment(supabase, { jobId, actorId }) {
  const found = await paymentOfJob(supabase, jobId); if (found.error) return found.error
  await supabase.from('expert_bridge_calls').insert({ fn: 'read_human_order_payment', job_id: jobId, actor_id: actorId, outcome: 'ok' })
  const p = found.payment
  return { ok: true, status: 200, data: { amountCents: p.amount_cents, currency: p.currency, paymentStatus: p.status, jobState: found.job.state } }
}

async function createJobFromPayment(supabase, { jobId, actorId }) {
  const found = await paymentOfJob(supabase, jobId); if (found.error) return found.error
  if (found.payment.status !== 'SUCCESS') return { ok: false, code: 'NOT_PAID', status: 409 }
  const key = `payment:${found.payment.id}`
  const b = await begin(supabase, { fn: 'create_job_from_payment', job_id: jobId, actor_id: actorId || null, idem_key: key })
  // A repeat only short-cuts when the first call really finished. A call that threw, was refused or never recorded its end is RETRIED: the
  // transition carries the same key, so it cannot act twice, and the existing row is updated instead of a second one being written.
  if (b.replay && b.prior && b.prior.outcome === 'ok') return { ok: true, replay: true, status: 200 }
  const rowId = b.replay ? b.prior && b.prior.id : b.id
  const done = (outcome, code) => (rowId ? finish(supabase, rowId, outcome, code) : null)
  // deadlines come from the same settings Phase 1 uses (a missing settings row confirms the job with no deadline, as Phase 1 does)
  let promised = null, internal = null
  const { data: job } = await supabase.from('human_jobs').select('tier').eq('id', jobId).maybeSingle()
  const settings = await pilot.loadSettings(supabase)
  if (settings && job) ({ promised, internal } = pilot.deadlines(settings, job.tier, new Date().toISOString()))
  let r
  try { r = await transition(supabase, { jobId, to: 'offered', trigger: 'payment_confirmed', actor: { kind: 'system', id: null }, idemKey: key, eventKind: 'paid', promisedAt: promised, internalAt: internal, detail: { reason_code: 'payment_confirmed' } }) }
  catch (err) { await done('failed', 'EXCEPTION'); throw err }
  // Phase 1's settlement may have confirmed the payment first: the job is then already past awaiting_payment, which is the outcome wanted
  const already = !r.ok && r.code === 'ILLEGAL_TRANSITION' && r.state && !['awaiting_payment', 'cancelled'].includes(r.state)
  await done(r.ok || already ? 'ok' : 'refused', r.ok || already ? null : r.code)
  if (already) return { ok: true, replay: true, state: r.state, status: 200 }
  return r.ok ? { ok: true, state: r.state, status: 200 } : r
}

module.exports = { refundHumanOrder, readHumanOrderPayment, createJobFromPayment }
