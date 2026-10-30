'use strict'

// Experts Phase 1: what a CONFIRMED / REVERSED human payment does. Called from two small, guarded places in
// fulfillment.service.js (settlePayment and reversePayment) and nowhere else, so everything the AI-fix path does on settlement
// (claiming a scan, the fix queue, partner commission, the fix receipt, the duplicate and undeliverable auto-refunds) is skipped
// for a human payment BY CONSTRUCTION: it never reaches that code.
//
// Both entry points are idempotent (the database functions are): the verify call, the webhook, the sweeps and an admin recheck can
// all land here for the same payment and the job moves exactly once.

const pilot = require('../lib/humanPilot')

async function settleHuman(env, supabase, payment, { won = false, defer = null, source = 'unknown' } = {}) {
  const base = { won, payment, conversion: null, source, human: true }
  const { data: job, error: jobErr } = await supabase.from('human_jobs').select('id, tier, customer_user_id, job_number').eq('payment_id', payment.id).maybeSingle()
  if (jobErr) throw jobErr
  if (!job) {
    console.error(`[CRITICAL] human payment ${payment.paystack_ref} has no job`)
    await alertOwner(env, 'Human order payment has no job', `reference: ${payment.paystack_ref}\npayment id: ${payment.id}\nThe payment is SUCCESS but no human_jobs row points at it. Refund it in Paystack or create the job by hand.`, payment.paystack_ref)
    return { ...base, outcome: 'HUMAN_NO_JOB' }
  }

  let promised = null, internal = null
  try {
    const settings = await pilot.loadSettings(supabase)
    if (settings) ({ promised, internal } = pilot.deadlines(settings, job.tier, new Date().toISOString()))
    else await alertOwner(env, 'Human order settings missing', `System settings "human_pilot" are missing or invalid, so job ${job.job_number} was confirmed with no deadline.`, 'human-settings')
  } catch (err) { console.error('humanSettle settings:', err.message) }

  const { data: res, error } = await supabase.rpc('human_job_confirm_payment', { p_payment: payment.id, p_promised: promised, p_internal: internal })
  if (error) throw error
  if (!res || res.ok === false) throw new Error(`human_job_confirm_payment: ${res && res.reason}`)
  if (res.already) {
    // A payment that arrives for a job already closed (the unpaid window passed, or a newer checkout replaced it) has taken real money
    // for nothing. Refund it and tell the owner; the refund webhook then finds the job closed and changes nothing.
    if (res.state === 'cancelled' || res.state === 'refunded') return { ...base, outcome: await refundClosedJob(env, supabase, payment, job, res.state) }
    return { ...base, outcome: 'ALREADY_FULFILLED' }
  }

  // First confirmation only: tell the customer and the operator. Best-effort; never blocks settlement.
  const task = (async () => {
    try {
      const emailService = require('./email.service')
      const { data: user } = await supabase.from('users').select('email, name').eq('id', job.customer_user_id).maybeSingle()
      if (user) await emailService.sendHumanOrderReceived(env, supabase, user.email, user.name, { jobNumber: job.job_number, tier: job.tier, promisedAt: promised })
      await emailService.sendOwnerNotice(env, `New human order ${job.job_number}`, `A paid human order is waiting in Admin > Human orders.\njob: ${job.job_number}\ntier: ${job.tier}`)
    } catch (err) { console.error('humanSettle notice:', err.message) }
  })()
  if (typeof defer === 'function') defer(task); else await task
  return { ...base, outcome: 'FULFILLED' }
}

// Money for a closed job. Refund the whole payment through the shared refund path (claim, Paystack's own refund list and the remaining
// amount are all checked there, so a repeat call can never refund twice). A refund already in flight is not an error and not an alert.
const IN_FLIGHT = ['CLAIM_LOST', 'OPEN_REFUND', 'ALREADY_REFUNDED']
async function refundClosedJob(env, supabase, payment, job, state) {
  try {
    const { queueRefund } = require('./refund.service')
    const r = await queueRefund(env, supabase, payment, { merchantNote: `Order ${job.job_number} was ${state} before this payment arrived`, customerNote: 'Your Passthrough order had already closed, so this payment is being refunded' })
    if (r.ok) {
      await alertOwner(env, `Late payment on closed human order ${job.job_number}`, `A payment arrived for order ${job.job_number}, which was already ${state}. A full refund was sent to Paystack.\nreference: ${payment.paystack_ref}`, `human-late-pay-${payment.id}`)
      return 'LATE_PAYMENT_REFUNDED'
    }
    if (IN_FLIGHT.includes(r.code)) return 'LATE_PAYMENT_REFUND_IN_FLIGHT'
    await alertOwner(env, `Late payment on closed human order ${job.job_number} could not be refunded`, `A payment arrived for order ${job.job_number}, which was already ${state}, and the automatic refund failed: ${r.message}\nreference: ${payment.paystack_ref}\nRefund it in Admin > Payments (or Paystack).`, `human-late-pay-fail-${payment.id}`)
    return 'LATE_PAYMENT_REFUND_FAILED'
  } catch (err) {
    console.error('humanSettle refundClosedJob:', err.message)
    await alertOwner(env, `Late payment on closed human order ${job.job_number} could not be refunded`, `error: ${err.message}\nreference: ${payment.paystack_ref}\nRefund it in Admin > Payments (or Paystack).`, `human-late-pay-fail-${payment.id}`)
    return 'LATE_PAYMENT_REFUND_FAILED'
  }
}

// A refund or lost dispute reversed the payment: close the job and reverse any earnings (once). Never throws.
async function onReversed(env, supabase, payment, { reason = 'refund' } = {}) {
  try {
    const { data: job } = await supabase.from('human_jobs').select('id, job_number, expert_id, state').eq('payment_id', payment.id).maybeSingle()
    if (!job) return { ok: true, noJob: true }
    const { data: res, error } = await supabase.rpc('human_job_reverse', { p_job: job.id, p_reason: String(reason || 'refund') })
    if (error) throw error
    if (res && res.ok && !res.already && job.expert_id) {
      await alertOwner(env, `Human order ${job.job_number} refunded after an expert was assigned`, `The job was ${job.state}; its state is now ${res.state}. Any earnings were reversed. Tell the expert if work was in progress.`, `human-refund-${job.id}`)
    }
    return res
  } catch (err) {
    console.error('humanSettle onReversed:', err.message)
    await alertOwner(env, 'Human order refund could not close the job', `payment: ${payment.paystack_ref}\nerror: ${err.message}\nRe-run it from Admin > Payments > Resolve > Reverse now (that closes the job and reverses any earnings); the expert cannot be paid for it meanwhile.`, `human-refund-fail-${payment.id}`)
    return { ok: false, error: err.message }
  }
}

async function alertOwner(env, subject, message, dedupeKey) {
  try { await require('./email.service').sendOwnerAlert(env, subject, message, { dedupeKey }) } catch (_) { /* best effort */ }
}

module.exports = { settleHuman, onReversed }
