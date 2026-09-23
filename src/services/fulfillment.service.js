// Single source of truth for "a payment succeeded → deliver the product", and for
// the reverse ("that payment was refunded/charged back → take it back").
//
// Section 8 (Webhooks) audit. Before this file the same fulfilment steps were
// copy-pasted into four places (webhooks.controller, payments.controller's
// verifyPayment, reconcilePayment, reconcile.service's sweep) and every copy
// shared the same three flaws:
//
//   1. UNGUARDED: `update scans set status='FIX_PURCHASED'` + enqueue ran for ANY
//      SUCCESS payment. A second payment for an already-delivered scan re-ran
//      generation over the delivered fix (new code, new hash, two concurrent
//      generators), double-credited the partner, and never told anyone.
//   2. NO TARGET CHECK: a payment whose scan or account no longer existed
//      "succeeded" with zero rows updated and still enqueued a doomed job.
//   3. WRONG ORDER: the partner-commission write (up to ~8 sequential DB calls)
//      ran BEFORE the customer's own fulfilment, inside the 30s waitUntil budget.
//
// The fix is one CLAIM: `UPDATE scans ... WHERE fix_purchased = false`, recording
// WHICH payment claimed it (scans.fix_payment_id). Exactly one payment can ever
// claim a scan; a retried delivery of the SAME payment recognises itself; any
// other payment is a DUPLICATE and is reported for refund instead of re-run.

const REVIVABLE_STATUSES = ['PENDING', 'ABANDONED', 'FAILED']
// A scan that has sat in FIX_PURCHASED this long after being claimed almost
// certainly lost its queue message (normal queue latency is seconds).
const REENQUEUE_AFTER_MS = 2 * 60 * 1000

function generatorFor(fixTier) {
  return fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
}

// Currency must match what the row was initialised with; amount must match exactly.
// (Kept strict on purpose — a mismatch is held for a human, see admin recheck.)
function chargeMismatch(paymentRow, { amount, currency }) {
  if (currency !== paymentRow.currency || amount !== paymentRow.amount_cents)
    return { expectedAmount: paymentRow.amount_cents, expectedCurrency: paymentRow.currency,
             receivedAmount: amount, receivedCurrency: currency }
  return null
}

/**
 * Deliver what a SUCCESS payment paid for. Idempotent and safe to call from any
 * number of paths at once — the claim below is atomic.
 *
 * Returns { outcome }:
 *   FULFILLED         this call claimed the scan and enqueued the job
 *   ALREADY_FULFILLED this same payment already claimed it (no-op)
 *   REENQUEUED        same payment, but the job looked lost → enqueued again
 *   DUPLICATE         a DIFFERENT payment already owns this scan → needs a refund
 *   SCAN_MISSING / NO_SCAN / ACCOUNT_DELETED   nothing valid to deliver to
 * Throws on DB/queue errors so callers can retry (webhook → 500 → Paystack retries).
 */
async function fulfillPayment(env, supabase, payment, { force = false, now = Date.now() } = {}) {
  const scanId = payment.scan_id
  if (!scanId) return { outcome: 'NO_SCAN' }
  const fixTier = payment.fix_tier || 'FIX'

  const { data: scan, error: scanErr } = await supabase.from('scans')
    .select('id, user_id, status, fix_purchased, fix_payment_id, updated_at').eq('id', scanId).maybeSingle()
  if (scanErr) throw scanErr
  if (!scan) return { outcome: 'SCAN_MISSING' }

  if (scan.user_id) {
    const { data: owner, error: ownerErr } = await supabase.from('users')
      .select('deleted_at').eq('id', scan.user_id).maybeSingle()
    if (ownerErr) throw ownerErr
    if (!owner || owner.deleted_at) return { outcome: 'ACCOUNT_DELETED' }
  }

  // ── the claim ──
  const { data: claimed, error: claimErr } = await supabase.from('scans')
    .update({ fix_purchased: true, fix_tier: fixTier, status: 'FIX_PURCHASED', fix_payment_id: payment.id })
    .eq('id', scanId).eq('fix_purchased', false)
    .select('id')
  if (claimErr) throw claimErr
  if (claimed && claimed.length > 0) {
    await env.FIX_QUEUE.send({ type: generatorFor(fixTier), scanId })
    return { outcome: 'FULFILLED', fixTier }
  }

  // Lost the claim (or it was already ours). Re-read for the current owner —
  // the row we read above may be stale by now.
  const { data: fresh, error: freshErr } = await supabase.from('scans')
    .select('id, status, fix_payment_id, updated_at').eq('id', scanId).maybeSingle()
  if (freshErr) throw freshErr
  const current = fresh || scan

  let ours = current.fix_payment_id === payment.id
  if (!current.fix_payment_id) {
    // Legacy row (purchased before fix_payment_id existed). If no OTHER successful
    // payment exists for this scan, this one is the legitimate purchase.
    const { data: others, error: othersErr } = await supabase.from('payments')
      .select('id').eq('scan_id', scanId).eq('status', 'SUCCESS').neq('id', payment.id).limit(1)
    if (othersErr) throw othersErr
    ours = !others || others.length === 0
  }
  if (!ours) return { outcome: 'DUPLICATE', ownerPaymentId: current.fix_payment_id || null }

  // Ours — but did the queue message survive? (claim succeeded, send() threw)
  const stuckFor = now - Date.parse(current.updated_at || 0)
  if (current.status === 'FIX_PURCHASED' && (force || stuckFor > REENQUEUE_AFTER_MS)) {
    // AUDIT FIX (bug): sending to FIX_QUEUE here used to be unguarded — two
    // callers reading the same stale `current.updated_at` (two rapid admin
    // reconcile clicks, an admin reconcile racing this same sweep, two admin
    // tabs) would BOTH pass this check and BOTH enqueue a second generation
    // job for the same scan: double Claude spend, double PDF render, a
    // last-write-wins race on the delivered file. Same atomic-claim idiom as
    // the initial claim above: set_updated_at() (migration 0001) bumps
    // scans.updated_at on every UPDATE — even one that writes the same
    // value — so it doubles as a compare-and-swap token here. Only the
    // caller whose read is still current wins the row and gets to enqueue.
    const { data: reclaimed, error: reclaimErr } = await supabase.from('scans')
      .update({ status: 'FIX_PURCHASED' })
      .eq('id', scanId).eq('updated_at', current.updated_at)
      .select('id')
    if (reclaimErr) throw reclaimErr
    if (reclaimed && reclaimed.length > 0) {
      await env.FIX_QUEUE.send({ type: generatorFor(fixTier), scanId })
      return { outcome: 'REENQUEUED', fixTier }
    }
    // Lost the race — a concurrent call already reclaimed it and is
    // sending (or has already sent) the queue message.
  }
  return { outcome: 'ALREADY_FULFILLED' }
}

/**
 * Mark a payment SUCCESS (from any not-yet-successful state) and deliver it.
 * `paymentRow` is the payments row as read by the caller.
 *
 * FIX-FIRST ORDERING: the customer's fulfilment runs before the partner
 * commission bookkeeping, so a slow/failing ledger can never delay or lose it.
 *
 * Revivable statuses include ABANDONED and FAILED — both are set by code that
 * only KNOWS the checkout looked dead (initializePayment's stale-checkout
 * cleanup, a charge.failed event). Paystack allows a retry on the same
 * reference, so real money arriving on such a row must still be honoured; the
 * flip used to require PENDING and silently dropped it.
 */
async function settlePayment(env, supabase, paymentRow, { authCode = null, source = 'unknown' } = {}) {
  const referralService = require('./referral.service')
  const patch = { status: 'SUCCESS' }
  if (authCode) patch.paystack_auth_code = authCode

  const { data: flipped, error: flipErr } = await supabase.from('payments')
    .update(patch).eq('paystack_ref', paymentRow.paystack_ref).in('status', REVIVABLE_STATUSES).select()
  if (flipErr) throw flipErr

  let row = flipped && flipped[0]
  const won = !!row
  if (!won) {
    const { data: current, error: curErr } = await supabase.from('payments')
      .select('*').eq('paystack_ref', paymentRow.paystack_ref).maybeSingle()
    if (curErr) throw curErr
    if (!current) return { outcome: 'UNKNOWN_REFERENCE', won: false }
    // REFUNDED / DISPUTED must never be re-fulfilled by a late duplicate event.
    if (current.status !== 'SUCCESS') return { outcome: 'IGNORED_STATUS', status: current.status, won: false, payment: current }
    row = current
  }

  // Not gated on `won`: if the flip winner died before fulfilling, a redelivery
  // (webhook retry, browser verify, admin recheck) lands here and finishes the job.
  const result = await fulfillPayment(env, supabase, row, { source })

  let conversion = null
  if (won && (result.outcome === 'FULFILLED' || result.outcome === 'ALREADY_FULFILLED' || result.outcome === 'REENQUEUED'))
    conversion = await referralService.recordConversion(supabase, row, env)

  // AUDIT FIX (feature gap): `won` is true exactly once per payment — the
  // one caller whose UPDATE...RETURNING actually saw the PENDING/ABANDONED/
  // FAILED row and flipped it. That makes this the single correct place to
  // send the payment receipt (see email.service.js's sendPaymentReceipt):
  // it fires exactly once regardless of which path won (verifyPayment, the
  // webhook, a sweep, an admin recheck), unlike a receipt sent from any one
  // of those callers individually, which would either miss the other paths
  // or double-send on a redelivery. Best-effort and never blocks fulfilment
  // — a failed receipt email is not a reason to fail a payment that already
  // went through and was already delivered.
  if (won) {
    try {
      const emailService = require('./email.service')
      const { data: buyer } = await supabase.from('users').select('email, name').eq('id', row.user_id).maybeSingle()
      if (buyer?.email) {
        await emailService.sendPaymentReceipt(env, supabase, buyer.email, buyer.name, {
          fixTier: row.fix_tier, amountCents: row.amount_cents, currency: row.currency,
          reference: row.paystack_ref, createdAt: row.created_at
        }).catch(() => {})
      }
    } catch (_) {}
  }

  return { ...result, won, payment: row, conversion, source }
}

// ── owner notification for outcomes that need a human ──────────────────────
// Returns true if it sent something. Never throws.
async function notifySettlementProblem(env, result, paymentRow, source) {
  const needs = ['DUPLICATE', 'SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED']
  if (!needs.includes(result.outcome)) return false
  const emailService = require('./email.service')
  const titles = {
    DUPLICATE:       'Duplicate payment for an already-purchased scan — refund needed',
    SCAN_MISSING:    'Payment received for a scan that no longer exists — refund needed',
    NO_SCAN:         'Payment received with no scan attached — refund needed',
    ACCOUNT_DELETED: 'Payment received for a deleted account — refund needed',
  }
  const detail = result.outcome === 'DUPLICATE'
    ? `\nThe scan is already fulfilled by payment ${result.ownerPaymentId || '(earlier payment)'}. ` +
      `NOT re-generated, NO commission recorded for this one. Refund it in Paystack — the refund.processed ` +
      `webhook will mark it REFUNDED automatically.`
    : `\nNothing was generated. Refund it in Paystack.`
  try {
    await emailService.sendOwnerAlert(env, titles[result.outcome],
      `source: ${source}\nreference: ${paymentRow.paystack_ref}\nscanId: ${paymentRow.scan_id}\n` +
      `amount: ${paymentRow.amount_cents} ${paymentRow.currency}${detail}`)
    return true
  } catch (_) { return false }
}

// ── refunds & chargebacks ──────────────────────────────────────────────────

// Paystack does not put the ORIGINAL charge's reference in the same place for
// every event: charge.dispute.* nests it under data.transaction.reference,
// refund.* uses data.transaction_reference, and data.reference on a refund
// event can be the refund's own id. Try each, and only accept one that maps to
// a payment row we actually have (a refund id never collides with a payment ref).
function referenceCandidates(event) {
  const d = event?.data || {}
  return [...new Set([
    d.transaction_reference, d.transaction?.reference, d.reference,
  ].filter(v => typeof v === 'string' && v.length > 0))]
}

async function findPaymentForEvent(supabase, event) {
  for (const ref of referenceCandidates(event)) {
    const { data, error } = await supabase.from('payments').select('*').eq('paystack_ref', ref).maybeSingle()
    if (error) throw error
    if (data) return data
  }
  return null
}

// Reverse the partner's commission for a payment with a NEGATIVE ledger row.
// Idempotent: the unique index (reverses_ledger_id) makes a repeat a no-op.
async function reverseCommission(supabase, paymentId, reason) {
  const { data: original, error } = await supabase.from('commission_ledger')
    .select('*').eq('payment_id', paymentId).is('reverses_ledger_id', null).maybeSingle()
  if (error) throw error
  if (!original) return { reversed: false, reason: 'no-commission' }

  const { error: insErr } = await supabase.from('commission_ledger').insert({
    payment_id:            paymentId,
    partner_id:            original.partner_id,
    referral_code_id:      original.referral_code_id,
    gross_amount_cents:    -original.gross_amount_cents,
    commission_rate:       original.commission_rate,
    commission_amount_cents: -original.commission_amount_cents,
    reverses_ledger_id:    original.id,
    reversal_reason:       reason,
  })
  if (insErr) {
    if (insErr.code === '23505') return { reversed: false, reason: 'already-reversed' }
    throw insErr
  }
  return { reversed: true, alreadyPaidOut: !!original.payout_id, commissionCents: original.commission_amount_cents }
}

/**
 * Everything that follows money going back to the customer: mark the payment
 * REFUNDED, reverse the partner commission, and revoke the public credential —
 * but ONLY if this payment is the one that owns the scan (refunding a duplicate
 * payment must not tear down the valid credential from the first).
 * Every step is idempotent, so a redelivered event simply re-checks them.
 * Downloads are deliberately left alone (documented product decision).
 */
async function reversePayment(supabase, payment, { reason, refundReference = null, now = new Date() }) {
  const { revokeVerification, REVOKE_REASON } = require('../lib/verification')
  const patch = { status: 'REFUNDED', refunded_at: now.toISOString() }
  if (refundReference) patch.refund_reference = refundReference

  const { data: moved, error } = await supabase.from('payments')
    .update(patch).eq('id', payment.id).in('status', ['SUCCESS', 'DISPUTED']).select('id')
  if (error) throw error
  const transitioned = !!(moved && moved.length)

  const ledger = await reverseCommission(supabase, payment.id, reason)

  let revoked = false
  if (payment.scan_id) {
    const { data: scan, error: scanErr } = await supabase.from('scans')
      .select('id, fix_payment_id').eq('id', payment.scan_id).maybeSingle()
    if (scanErr) throw scanErr
    if (scan && (!scan.fix_payment_id || scan.fix_payment_id === payment.id))
      revoked = await revokeVerification(supabase, scan.id, REVOKE_REASON[reason] || REVOKE_REASON.ADMIN, now)
  }
  return { transitioned, ledger, revoked }
}

module.exports = {
  REVIVABLE_STATUSES, REENQUEUE_AFTER_MS,
  generatorFor, chargeMismatch,
  fulfillPayment, settlePayment, notifySettlementProblem,
  referenceCandidates, findPaymentForEvent, reverseCommission, reversePayment,
}
