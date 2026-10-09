// Paystack refunds, shared by the admin refund route (payments.controller.refundPayment) and the
// automatic refund of a DUPLICATE payment (fulfillment.settlePayment).
//
// PAYMENTS & PRICING ROUND 6: the queue-a-refund logic used to live inside the admin controller, so
// a buyer who paid twice for one scan only ever got a refund when a human noticed the owner alert.
// It now lives here, unchanged in behaviour, so the automatic path gets exactly the same guards:
//   - a per-payment claim (migration 0048, payments.refund_claimed_at) makes check-then-act atomic;
//   - Paystack's own refund list is read first and the flow FAILS CLOSED when it cannot be read;
//   - an open (pending / processing) refund, or a fully processed one, blocks a second request.
//
// paystack.service and adminAudit are required lazily on purpose (the same reason reconcile.service
// does it): this module is loaded once, so a top-level require would bind forever to whichever
// export existed at first load — including a per-test stub.

const OPEN_REFUND_STATUSES = ['pending', 'processing', 'needs-attention']

// How long an IN-FLIGHT refund claim is held (handed back immediately on any failure).
const REFUND_CLAIM_TTL_MS = 60 * 1000
// PAYMENTS & PRICING ROUND 7 (gap): after a SUCCESSFUL queue the claim used to lapse 60s later and the
// only thing standing between a re-run (auto-refund fires on every verify / recheck / webhook
// redelivery) and a second createRefund was Paystack's refund LIST — which can lag a just-created
// refund by longer than that. A successful queue now holds the claim for this long, so a re-run in
// that window gets CLAIM_LOST / IN_PROGRESS without asking Paystack to refund again. Past it, the
// refund list is authoritative as before (and a refund Paystack later failed becomes retryable).
const REFUND_POST_QUEUE_HOLD_MS = 15 * 60 * 1000

// -> { claimed: boolean, unsupported?: boolean }. `unsupported` = the column does not exist yet
// (migration 0048 not applied): proceed on the old, unlocked behaviour with a loud log rather than
// blocking every refund until deploy.
async function claimRefund(supabase, paymentId, now = Date.now()) {
  const cutoff = new Date(now - REFUND_CLAIM_TTL_MS).toISOString()
  const { data, error } = await supabase.from('payments')
    .update({ refund_claimed_at: new Date(now).toISOString() })
    .eq('id', paymentId)
    .or(`refund_claimed_at.is.null,refund_claimed_at.lt.${cutoff}`)
    .select('id')
  if (error) {
    if (error.code === '42703' || error.code === 'PGRST204') {
      console.error('[refund] refund_claimed_at column missing — apply migration 0048; refunding WITHOUT the concurrency lock')
      return { claimed: true, unsupported: true }
    }
    throw error
  }
  return { claimed: !!(data && data.length > 0) }
}

// Pushes refund_claimed_at into the future so claimRefund's `< now - TTL` test stays false until
// REFUND_POST_QUEUE_HOLD_MS after the queue. Best-effort: the 60s claim and the refund list still apply.
async function holdRefundClaim(supabase, paymentId, now = Date.now()) {
  try {
    const until = new Date(now + REFUND_POST_QUEUE_HOLD_MS - REFUND_CLAIM_TTL_MS).toISOString()
    const { error } = await supabase.from('payments').update({ refund_claimed_at: until }).eq('id', paymentId)
    if (error) console.error('holdRefundClaim:', error.message)
  } catch (err) { console.error('holdRefundClaim unexpected:', err.message) }
}

async function releaseRefundClaim(supabase, paymentId) {
  try {
    const { error } = await supabase.from('payments').update({ refund_claimed_at: null }).eq('id', paymentId)
    if (error) console.error('releaseRefundClaim:', error.message)
  } catch (err) { console.error('releaseRefundClaim unexpected:', err.message) }
}

/**
 * Queue a refund with Paystack for a settled payment.
 *   amountCents  omitted → refund everything still refundable
 *   merchantNote / customerNote  passed to Paystack (never to our audit log)
 *
 * Never throws for an expected refusal; returns
 *   { ok: true,  amountCents, partial, completesRefund, queued }
 *   { ok: false, code, status, message, data? }   (`status` is the HTTP status the admin route uses)
 * codes: CLAIM_LOST, LIST_FAILED, OPEN_REFUND, ALREADY_REFUNDED, OVER_REMAINING, REJECTED, PAYSTACK_ERROR.
 * Unexpected DB errors from the claim still throw.
 */
async function queueRefund(env, supabase, payment, { amountCents: requested = null, merchantNote = null, customerNote = 'Refund from Passthrough' } = {}) {
  const paystackService = require('./paystack.service')
  const reference = payment.paystack_ref

  const claim = await claimRefund(supabase, payment.id)
  if (!claim.claimed)
    return { ok: false, code: 'CLAIM_LOST', status: 409,
      message: 'A refund for this payment was just submitted — check Paystack, and try again in a few minutes only if you need to refund more.' }

  let keepClaim = false
  try {
    // What Paystack already knows about this transaction. Fails CLOSED: if we cannot see existing
    // refunds we must not risk a second one.
    let existing
    try {
      existing = await paystackService.listRefunds(env, reference)
    } catch (err) {
      return { ok: false, code: 'LIST_FAILED', status: 502,
        message: `Could not check existing refunds with Paystack (${err.message}) — nothing was sent. Try again.` }
    }
    const refunds = Array.isArray(existing?.data) ? existing.data : []
    const open = refunds.filter(r => OPEN_REFUND_STATUSES.includes(r?.status))
    if (open.length)
      return { ok: false, code: 'OPEN_REFUND', status: 409,
        message: 'A refund for this payment is already in progress on Paystack — wait for it to finish (or fix it there) before sending another.',
        data: { openRefunds: open.length } }
    const processedSoFar = refunds.filter(r => r?.status === 'processed').reduce((n, r) => n + (Number(r.amount) || 0), 0)
    const remaining = payment.amount_cents - processedSoFar
    if (remaining <= 0)
      return { ok: false, code: 'ALREADY_REFUNDED', status: 409,
        message: 'Paystack already shows this payment fully refunded. Our record follows on its own (hourly sweep), or use Resolve → reverse now.' }

    const amountCents = requested ?? remaining
    if (amountCents > remaining)
      return { ok: false, code: 'OVER_REMAINING', status: 400,
        message: `Only ${remaining} (minor units) is left to refund on this payment.` }

    // The outcome is judged on what the total will be AFTER this refund (payments round 2, B3): the
    // leg that COMPLETES the total is the one the webhook's summed full-refund detection reverses.
    const completesRefund = processedSoFar + amountCents >= payment.amount_cents
    const partial = !completesRefund
    // Omit `amount` only for a genuine first-and-only full refund; any follow-up leg states its amount.
    const sendFull = processedSoFar === 0 && amountCents === payment.amount_cents

    let queued
    try {
      queued = await paystackService.createRefund(env, reference, {
        amount:       sendFull ? undefined : amountCents,
        currency:     payment.currency,
        customerNote,
        merchantNote: merchantNote || 'Refund issued from the Passthrough admin panel',
      })
    } catch (err) {
      if (err.paystackRejected)
        return { ok: false, code: 'REJECTED', status: 409, message: `Paystack rejected the refund: ${err.message}` }
      console.error(`[CRITICAL] Paystack refund failed (ref ${reference}):`, err.message)
      return { ok: false, code: 'PAYSTACK_ERROR', status: 502, message: `Paystack refund failed: ${err.message}. Nothing was refunded.` }
    }
    keepClaim = true
    if (!claim.unsupported) await holdRefundClaim(supabase, payment.id)
    return { ok: true, amountCents, partial, completesRefund, queued }
  } finally {
    if (!keepClaim && !claim.unsupported) await releaseRefundClaim(supabase, payment.id)
  }
}

// Auto-refund is ON unless the operator switches it off (AUTO_REFUND_DUPLICATES=false).
function autoRefundEnabled(env) {
  return String(env && env.AUTO_REFUND_DUPLICATES).trim().toLowerCase() !== 'false'
}

/**
 * Refund a payment that fulfilment classified as a DUPLICATE — a second successful payment for a
 * scan another payment already owns. The buyer got nothing for it, so the whole amount goes back.
 *
 * Deliberately conservative — it refunds only when it can prove the situation:
 *   - the owning payment is known, is a different row, and belongs to the SAME scan;
 *   - this payment is a real, settled charge (SUCCESS, > 0, not a free-credit row).
 * Anything it cannot prove is left for the owner alert (a human decides).
 *
 * Safe to call repeatedly: settlePayment re-classifies a duplicate on every verify / recheck /
 * webhook redelivery, and queueRefund's claim + Paystack refund-list check make a repeat a no-op.
 * Never throws. -> { status, ... } with status one of
 *   QUEUED       a refund was queued just now
 *   IN_PROGRESS  Paystack already has one open or processed (nothing more to do)
 *   SKIPPED      not eligible (reason: DISABLED | NO_OWNER | FREE | NOT_SETTLED | OWNER_MISMATCH)
 *   FAILED       something went wrong (reason) — the owner alert says to refund by hand
 */
async function autoRefundDuplicate(env, supabase, payment, { ownerPaymentId = null } = {}) {
  try {
    if (!autoRefundEnabled(env)) return { status: 'SKIPPED', reason: 'DISABLED' }
    if (!ownerPaymentId || ownerPaymentId === payment.id) return { status: 'SKIPPED', reason: 'NO_OWNER' }
    if (payment.status !== 'SUCCESS') return { status: 'SKIPPED', reason: 'NOT_SETTLED' }
    if (!(payment.amount_cents > 0) || String(payment.paystack_ref || '').startsWith('credit:'))
      return { status: 'SKIPPED', reason: 'FREE' }

    const { data: owner, error: ownerErr } = await supabase.from('payments')
      .select('id, scan_id, status').eq('id', ownerPaymentId).maybeSingle()
    if (ownerErr) throw ownerErr
    if (!owner || owner.scan_id !== payment.scan_id) return { status: 'SKIPPED', reason: 'OWNER_MISMATCH' }

    const r = await queueRefund(env, supabase, payment, {
      merchantNote: 'Automatic refund: duplicate payment for an already-purchased resume',
      customerNote: 'Duplicate payment — refunded automatically',
    })
    if (r.ok) {
      try {
        const { logAdminAction } = require('../lib/adminAudit')
        // System action: no admin on the request, so the actor is null. Ids and numbers only.
        await logAdminAction({ get: () => undefined }, supabase, 'payment.auto_refund_duplicate', 'payment', payment.id,
          { reference: payment.paystack_ref, ownerPaymentId, amountCents: r.amountCents, refundStatus: r.queued?.data?.status || null })
      } catch (_) { /* audit is best-effort */ }
      return { status: 'QUEUED', amountCents: r.amountCents }
    }
    if (['OPEN_REFUND', 'ALREADY_REFUNDED', 'CLAIM_LOST'].includes(r.code)) return { status: 'IN_PROGRESS', code: r.code }
    return { status: 'FAILED', reason: r.message }
  } catch (err) {
    console.error(`autoRefundDuplicate(${payment && payment.paystack_ref}):`, err && err.message)
    return { status: 'FAILED', reason: (err && err.message) || 'unknown error' }
  }
}

// ── paid, but there is nothing to deliver ─────────────────────────────────────
// PAYMENTS & PRICING ROUND 8 (feature gap): round 6 made a DUPLICATE payment refund itself; the other outcomes
// where money was captured and nothing can ever be delivered — the scan is gone (SCAN_MISSING), the payment has
// no scan (NO_SCAN: payments.scan_id is ON DELETE SET NULL, so deleting a scan after its checkout was left open
// more than an hour — deleteScan only waits for a younger one — and then paying it lands here) or the account was
// deleted (ACCOUNT_DELETED) — still ended in an owner email saying "refund it in Paystack", and the buyer stayed
// charged for nothing until a human got to it. Same machinery as the duplicate refund (claim, Paystack
// refund-list guard that fails closed, open/processed refund guards), so a redelivery or a second path can never
// refund twice.
//
// Conservative like autoRefundDuplicate: it refunds only what it can prove undelivered — the payment is a real,
// settled charge, and it does NOT own the scan (a payment that claimed the scan delivered something and is never
// auto-refunded here). Switch off with AUTO_REFUND_UNDELIVERABLE=false; ON by default, like the duplicate refund.
const UNDELIVERABLE_OUTCOMES = ['SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED']

function autoRefundUndeliverableEnabled(env) {
  return String(env && env.AUTO_REFUND_UNDELIVERABLE).trim().toLowerCase() !== 'false'
}

const UNDELIVERABLE_NOTES = {
  SCAN_MISSING:    'the resume it was bought for no longer exists',
  NO_SCAN:         'it has no resume attached',
  ACCOUNT_DELETED: 'the account that bought it was deleted',
}

/**
 * -> { status, ... } with status one of QUEUED | IN_PROGRESS | SKIPPED (reason: DISABLED | NOT_UNDELIVERABLE |
 * NOT_SETTLED | FREE | DELIVERED) | FAILED (reason). Never throws.
 */
async function autoRefundUndeliverable(env, supabase, payment, { outcome } = {}) {
  try {
    if (!autoRefundUndeliverableEnabled(env)) return { status: 'SKIPPED', reason: 'DISABLED' }
    if (!UNDELIVERABLE_OUTCOMES.includes(outcome)) return { status: 'SKIPPED', reason: 'NOT_UNDELIVERABLE' }
    if (payment.status !== 'SUCCESS') return { status: 'SKIPPED', reason: 'NOT_SETTLED' }
    if (!(payment.amount_cents > 0) || String(payment.paystack_ref || '').startsWith('credit:'))
      return { status: 'SKIPPED', reason: 'FREE' }

    // Prove nothing was delivered by THIS payment: if the scan exists and this payment claimed it, it was.
    if (payment.scan_id) {
      const { data: scan, error: scanErr } = await supabase.from('scans')
        .select('id, fix_payment_id').eq('id', payment.scan_id).maybeSingle()
      if (scanErr) throw scanErr
      if (scan && scan.fix_payment_id === payment.id) return { status: 'SKIPPED', reason: 'DELIVERED' }
    }

    const r = await queueRefund(env, supabase, payment, {
      merchantNote: `Automatic refund: nothing could be delivered — ${UNDELIVERABLE_NOTES[outcome]}`,
      customerNote: 'Your Passthrough payment could not be delivered — refunded automatically',
    })
    if (r.ok) {
      try {
        const { logAdminAction } = require('../lib/adminAudit')
        await logAdminAction({ get: () => undefined }, supabase, 'payment.auto_refund_undeliverable', 'payment', payment.id,
          { reference: payment.paystack_ref, outcome, amountCents: r.amountCents, refundStatus: r.queued?.data?.status || null })
      } catch (_) { /* audit is best-effort */ }
      return { status: 'QUEUED', amountCents: r.amountCents }
    }
    if (['OPEN_REFUND', 'ALREADY_REFUNDED', 'CLAIM_LOST'].includes(r.code)) return { status: 'IN_PROGRESS', code: r.code }
    return { status: 'FAILED', reason: r.message }
  } catch (err) {
    console.error(`autoRefundUndeliverable(${payment && payment.paystack_ref}):`, err && err.message)
    return { status: 'FAILED', reason: (err && err.message) || 'unknown error' }
  }
}

module.exports = {
  OPEN_REFUND_STATUSES, REFUND_CLAIM_TTL_MS,
  claimRefund, releaseRefundClaim, holdRefundClaim, REFUND_POST_QUEUE_HOLD_MS, queueRefund, autoRefundDuplicate, autoRefundEnabled,
  UNDELIVERABLE_OUTCOMES, autoRefundUndeliverable, autoRefundUndeliverableEnabled,
}
