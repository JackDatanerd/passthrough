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
  if (res.already) return { ...base, outcome: 'ALREADY_FULFILLED' }

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
    await alertOwner(env, 'Human order refund could not close the job', `payment: ${payment.paystack_ref}\nerror: ${err.message}\nClose the job by hand in Admin > Human orders.`, `human-refund-fail-${payment.id}`)
    return { ok: false, error: err.message }
  }
}

async function alertOwner(env, subject, message, dedupeKey) {
  try { await require('./email.service').sendOwnerAlert(env, subject, message, { dedupeKey }) } catch (_) { /* best effort */ }
}

module.exports = { settleHuman, onReversed }
