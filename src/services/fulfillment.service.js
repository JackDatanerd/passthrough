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
async function settlePayment(env, supabase, paymentRow, { authCode = null, source = 'unknown', defer = null } = {}) {
  const referralService = require('./referral.service')
  const patch = { status: 'SUCCESS', paid_at: new Date().toISOString() }
  // WEBHOOKS ROUND 7 (G3): `authCode` is accepted for the callers that still pass it but is NOT stored. The
  // reusable card token (payments.paystack_auth_code) was never read back by anything; round 6 stripped it
  // from the stored webhook payloads, and this was the one place it was still kept. Migration 0065 clears
  // the ones already saved.

  const flip = p => supabase.from('payments')
    .update(p).eq('paystack_ref', paymentRow.paystack_ref).in('status', REVIVABLE_STATUSES).select()
  let { data: flipped, error: flipErr } = await flip(patch)
  // Round 8: paid_at (migration 0065) is written in the same UPDATE as the flip, so exactly once. If the code
  // is deployed before that migration, settlement must NOT break — money is already captured — so an
  // unknown-column error retries once without it (receipts then fall back to created_at, as before).
  if (flipErr && (flipErr.code === '42703' || flipErr.code === 'PGRST204')) {
    console.error('[WARN] payments.paid_at column missing — apply migration 0065; settling without it')
    const { paid_at: _omit, ...legacyPatch } = patch
    ;({ data: flipped, error: flipErr } = await flip(legacyPatch))
  }
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

  // SECTION 8 AUDIT FIX (bug): the partner commission and the receipt used to be
  // gated on `won` alone — but `won` is true for exactly ONE caller, and if THAT
  // caller's fulfillPayment() threw (a queue/DB blip right after the flip), its
  // redelivery finishes the fulfilment with won === false and therefore skipped
  // both, permanently: nothing else retries a commission once the scan has moved
  // on from FIX_PURCHASED (the orphan sweep only sees stuck scans). Reproduced:
  // delivery #1 flips + throws, delivery #2 REENQUEUES fine, ledger stays empty.
  // The delivery that actually CLAIMED or RE-ENQUEUED the scan is the one that
  // finished the job, so it takes over. recordConversion is idempotent (one
  // original ledger row per payment) and the receipt is claimed atomically below.
  const finishedJob = result.outcome === 'FULFILLED' || result.outcome === 'REENQUEUED'
  const settledOk   = finishedJob || result.outcome === 'ALREADY_FULFILLED'

  let conversion = null
  if (settledOk && (won || finishedJob))
    conversion = await referralService.recordConversion(supabase, row, env)

  // Payment receipt: exactly once per payment, whichever path gets here first.
  // Best-effort and never blocks fulfilment. `defer` (optional) lets the caller
  // push the email out of the request (waitUntil) — Paystack asks webhook
  // handlers to acknowledge quickly, and the mail provider's retries can take
  // ~30s in the worst case.
  if (won || finishedJob) {
    const task = sendReceiptOnce(env, supabase, row, { legacyOk: won })
    if (typeof defer === 'function') defer(task)
    else await task
  }

  // PAYMENTS & PRICING ROUND 6 (feature gap): a DUPLICATE used to end at an owner alert saying "refund it
  // in Paystack", so a buyer who paid twice stayed double-charged until a human noticed. The second
  // payment bought nothing, so the whole amount now goes back automatically (refund.service — same
  // claim / refund-list guards as the admin button, so a redelivery or a second path can never refund
  // twice). Not gated on `won`: a duplicate is re-classified on every verify / recheck / webhook
  // redelivery, which is exactly what retries a refund that failed the first time. Never throws.
  // With `defer` (the webhook) the Paystack calls run after the response is sent.
  if (result.outcome === 'DUPLICATE') {
    const refundService = require('./refund.service')
    if (typeof defer === 'function') {
      defer(runDuplicateAutoRefund(env, supabase, row, result.ownerPaymentId, source, { alertOnFailure: true }))
      const scheduled = refundService.autoRefundEnabled(env) && !!result.ownerPaymentId
      return { ...result, won, payment: row, conversion, source,
        autoRefund: scheduled ? { status: 'SCHEDULED' } : { status: 'SKIPPED', reason: refundService.autoRefundEnabled(env) ? 'NO_OWNER' : 'DISABLED' } }
    }
    const autoRefund = await runDuplicateAutoRefund(env, supabase, row, result.ownerPaymentId, source, { alertOnFailure: false })
    return { ...result, won, payment: row, conversion, source, autoRefund }
  }

  // PAYMENTS & PRICING ROUND 8 (feature gap): the same for money captured with nothing to deliver — the scan or
  // the account is gone, or the payment never had a scan. Not gated on `won`, for the same reason as above: it is
  // re-classified on every redelivery, which is exactly what retries a refund that failed the first time.
  const refundSvc = require('./refund.service')
  if (refundSvc.UNDELIVERABLE_OUTCOMES.includes(result.outcome)) {
    if (typeof defer === 'function') {
      defer(runUndeliverableAutoRefund(env, supabase, row, result.outcome, source, { alertOnFailure: true }))
      return { ...result, won, payment: row, conversion, source,
        autoRefund: refundSvc.autoRefundUndeliverableEnabled(env) ? { status: 'SCHEDULED' } : { status: 'SKIPPED', reason: 'DISABLED' } }
    }
    const autoRefund = await runUndeliverableAutoRefund(env, supabase, row, result.outcome, source, { alertOnFailure: false })
    return { ...result, won, payment: row, conversion, source, autoRefund }
  }

  return { ...result, won, payment: row, conversion, source }
}

// Wraps refund.service.autoRefundUndeliverable; same alerting contract as runDuplicateAutoRefund below.
async function runUndeliverableAutoRefund(env, supabase, row, outcome, source, { alertOnFailure = false } = {}) {
  const r = await require('./refund.service').autoRefundUndeliverable(env, supabase, row, { outcome })
  if (alertOnFailure && r.status === 'FAILED') {
    try {
      await require('./email.service').sendOwnerAlert(env, 'Automatic refund of an undeliverable payment FAILED — refund it by hand',
        `source: ${source}\noutcome: ${outcome}\nreference: ${row.paystack_ref}\nscanId: ${row.scan_id}\namount: ${row.amount_cents} ${row.currency}\n` +
        `reason: ${r.reason}\n\nRefund it in Paystack or Admin → Payments → Refund. The next verify / webhook redelivery also retries it.`,
        { dedupeKey: `${row.paystack_ref}:autorefund` })
    } catch (_) { /* best effort */ }
  }
  return r
}

// Wraps refund.service.autoRefundDuplicate. When it runs deferred nobody is waiting on its result, so a
// FAILED refund pages the owner itself; inline callers get the result and alert through
// notifySettlementProblem instead. Never throws.
async function runDuplicateAutoRefund(env, supabase, row, ownerPaymentId, source, { alertOnFailure = false } = {}) {
  const r = await require('./refund.service').autoRefundDuplicate(env, supabase, row, { ownerPaymentId })
  if (alertOnFailure && r.status === 'FAILED') {
    try {
      await require('./email.service').sendOwnerAlert(env, 'Automatic refund of a duplicate payment FAILED — refund it by hand',
        `source: ${source}\nreference: ${row.paystack_ref}\nscanId: ${row.scan_id}\namount: ${row.amount_cents} ${row.currency}\n` +
        `reason: ${r.reason}\n\nRefund it in Paystack or Admin → Payments → Refund. The next verify / webhook redelivery also retries it.`,
        { dedupeKey: `${row.paystack_ref}:autorefund` })
    } catch (_) { /* best effort */ }
  }
  return r
}

// receipt_delivered_at (migration 0036) is set only AFTER the send. receipt_sent_at is a CLAIM
// taken before it, and the send normally runs inside waitUntil — a task the runtime cancels
// between the claim and the send used to lose the receipt permanently (the claim only released
// on a thrown error). A claim with no delivery mark after 10 minutes is retried by
// recoverLostReceipts below. Best-effort: with the column missing this is a no-op.
async function markReceiptDelivered(supabase, id) {
  try { await supabase.from('payments').update({ receipt_delivered_at: new Date().toISOString() }).eq('id', id) } catch (_) { /* best effort */ }
}

// ── receipt, exactly once ──────────────────────────────────────────────────
// payments.receipt_sent_at (migration 0033) is claimed with a compare-and-set
// BEFORE the email goes out, so two deliveries racing (or a redelivery after a
// half-finished first attempt) can never mail two receipts, and a receipt the
// first attempt never got to is still sent by the delivery that finishes the
// job. If the send fails, the claim is released so a later path can retry.
// If the column does not exist yet (migration not applied), behaves like the
// old code: only the caller that won the status flip sends (`legacyOk`).
// Never throws.
async function sendReceiptOnce(env, supabase, row, { legacyOk = false } = {}) {
  try {
    const { data: claimed, error: claimErr } = await supabase.from('payments')
      .update({ receipt_sent_at: new Date().toISOString() })
      .eq('id', row.id).is('receipt_sent_at', null).select('id')
    if (claimErr) {
      if (!legacyOk) return false
    } else if (!claimed || claimed.length === 0) {
      return false                       // someone already sent it
    }
    const emailService = require('./email.service')
    const { data: buyer } = await supabase.from('users').select('email, name').eq('id', row.user_id).maybeSingle()
    if (!buyer?.email) { await markReceiptDelivered(supabase, row.id); return false }   // nothing will ever be sent
    try {
      // AUDIT FIX (Payments & Pricing pass 1, bug — B9): email.service's send()
      // NEVER throws — a failed send (Resend down/rejecting) or a throttled one
      // (per-recipient limit) comes back as `false`. This awaited it and
      // stamped receipt_delivered_at unconditionally, so every real send
      // failure was recorded as "delivered": the claim was never released, the
      // hourly recoverLostReceipts (which only retries claimed-but-UNdelivered
      // rows) never saw it, and the customer simply never got a receipt. Only
      // a thrown error used to take the failure path below, and the real
      // sender never throws (the tests stubbed one that did, which is why this
      // stayed invisible). `false` is now a failure like any other.
      const sent = await emailService.sendPaymentReceipt(env, supabase, buyer.email, buyer.name, {
        fixTier: row.fix_tier, amountCents: row.amount_cents, currency: row.currency,
        reference: row.paystack_ref, createdAt: row.paid_at || row.created_at
      })
      if (sent === false) throw new Error('receipt email was not sent (send failed or was throttled)')
      await markReceiptDelivered(supabase, row.id)
      return true
    } catch (sendErr) {
      // The claim (receipt_sent_at) is deliberately KEPT and receipt_delivered_at
      // left null: that exact "claimed, never confirmed delivered" state is what
      // recoverLostReceipts retries hourly for a week. The claim used to be
      // released here, which left the retry to whichever path next happened to
      // re-settle this payment — usually nothing ever did.
      console.error('Payment receipt failed (recoverLostReceipts will retry):', sendErr && sendErr.message)
      return false
    }
  } catch (err) {
    console.error('Payment receipt error:', err && err.message)
    return false
  }
}

// Hourly (see index.js): re-send receipts that were claimed but never confirmed delivered.
// The re-claim is a compare-and-set on the old claim time, so two overlapping runs (or a run
// racing the original send finishing late) cannot both send. Never throws.
async function recoverLostReceipts(env, supabase, { now = Date.now(), limit = 10 } = {}) {
  const result = { checked: 0, resent: 0, failed: 0, error: null }
  try {
    const { data: rows, error } = await supabase.from('payments')
      .select('id, user_id, fix_tier, amount_cents, currency, paystack_ref, created_at, paid_at, receipt_sent_at')
      .eq('status', 'SUCCESS').is('receipt_delivered_at', null).not('receipt_sent_at', 'is', null)
      .lt('receipt_sent_at', new Date(now - 10 * 60 * 1000).toISOString())
      .gt('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString())
      .limit(limit)
    if (error) { result.error = error.message; return result }      // migration 0036 not applied yet → nothing to recover
    result.checked = (rows || []).length
    const emailService = require('./email.service')
    for (const row of rows || []) {
      const { data: claimed, error: claimErr } = await supabase.from('payments')
        .update({ receipt_sent_at: new Date(now).toISOString() })
        .eq('id', row.id).eq('receipt_sent_at', row.receipt_sent_at).is('receipt_delivered_at', null).select('id')
      if (claimErr || !claimed || !claimed.length) continue
      const { data: buyer } = await supabase.from('users').select('email, name').eq('id', row.user_id).maybeSingle()
      if (!buyer?.email) { await markReceiptDelivered(supabase, row.id); continue }
      try {
        // See sendReceiptOnce: send() reports failure as `false`, never a throw.
        const sent = await emailService.sendPaymentReceipt(env, supabase, buyer.email, buyer.name, {
          fixTier: row.fix_tier, amountCents: row.amount_cents, currency: row.currency,
          reference: row.paystack_ref, createdAt: row.paid_at || row.created_at
        })
        if (sent === false) throw new Error('receipt email was not sent (send failed or was throttled)')
        await markReceiptDelivered(supabase, row.id)
        result.resent++
      } catch (err) {
        console.error('recoverLostReceipts: send failed:', err && err.message)
        result.failed++      // the fresh claim time makes it eligible again in 10 minutes
      }
    }
  } catch (err) {
    result.error = err && err.message
  }
  return result
}

// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G4): the receipt was a one-shot
// email with no in-app way to get it again — a buyer whose receipt was lost,
// filtered or deleted (or whose send failed, see B9 above) had nothing to fall
// back on. Re-sends to the buyer's CURRENT account email, independent of the
// exactly-once claim above (that guards the automatic send; this is an explicit
// user request, rate-limited by rl.paymentReceipt). Never throws.
// Returns { sent, reason } — reason: 'NO_EMAIL' | 'SEND_FAILED' | null.
async function resendReceipt(env, supabase, row) {
  try {
    const emailService = require('./email.service')
    const { data: buyer } = await supabase.from('users').select('email, name').eq('id', row.user_id).maybeSingle()
    if (!buyer?.email) return { sent: false, reason: 'NO_EMAIL', email: null }
    const ok = await emailService.sendPaymentReceipt(env, supabase, buyer.email, buyer.name, {
      fixTier: row.fix_tier, amountCents: row.amount_cents, currency: row.currency,
      reference: row.paystack_ref, createdAt: row.paid_at || row.created_at
    })
    if (ok === false) return { sent: false, reason: 'SEND_FAILED', email: buyer.email }
    // A confirmed delivery also settles an automatic send that never was.
    await markReceiptDelivered(supabase, row.id)
    return { sent: true, reason: null, email: buyer.email }
  } catch (err) {
    console.error('resendReceipt error:', err && err.message)
    return { sent: false, reason: 'SEND_FAILED', email: null }
  }
}

// ── closing a scan's other open checkouts ──────────────────────────────────
// FEATURE GAP CLOSED (Payments & Pricing pass 1 — G2): when something OTHER than
// a payment claims a scan (redeemCredit spending a free credit), any Paystack
// checkout still PENDING for that scan is now pointless — and used to be left
// PENDING: showing as a phantom "pending" purchase in the buyer's history until
// the 2-hour sweep, and holding its referral-code usage slot until the
// reservation TTL. Marks them ABANDONED (atomic PENDING-only guard, so a
// checkout that finished in the same instant is untouched) and hands the slots
// back. NOTE what this cannot do: Paystack has no API to cancel an initialized
// transaction, so a checkout page the buyer still has open remains payable —
// if they do pay it, settlePayment's revive path honours the money, the claim
// is lost, and it is reported as a DUPLICATE (which the admin can now refund
// from the app). Never throws; returns how many rows were closed.
async function abandonPendingForScan(supabase, scanId) {
  try {
    const { data, error } = await supabase.from('payments')
      .update({ status: 'ABANDONED' }).eq('scan_id', scanId).eq('status', 'PENDING')
      .select('id, referral_reservation_id')
    if (error) { console.error('abandonPendingForScan failed:', error.message); return 0 }
    const referralService = require('./referral.service')
    for (const row of data || []) await referralService.releaseCodeReservation(supabase, row.referral_reservation_id)
    return (data || []).length
  } catch (err) {
    console.error('abandonPendingForScan error:', err && err.message)
    return 0
  }
}

// ── owner notification for outcomes that need a human ──────────────────────
// Returns true if it sent something. Never throws.
//
// AUDIT FIX (Section 3/4 re-audit, bug): sendOwnerAlert's 10-minute dedupe is
// keyed on `subject` alone unless a `dedupeKey` is passed — and every title
// below is a FIXED string shared across every payment that hits that
// outcome. This function is called from three places (verifyPayment,
// recheckPayment, and reconcile.service.js's automated hourly pending-sweep
// — the sweep is the sharpest case, since one run can genuinely process
// several different problem payments back to back), so without a
// per-payment dedupeKey a second DUPLICATE/SCAN_MISSING/etc. payment inside
// the same 10-minute window silently got no email at all — still logged to
// alert_logs, but nothing proactive. paymentRow.paystack_ref is already
// on hand here, so this needed no change to any of the three call sites.
async function notifySettlementProblem(env, result, paymentRow, source) {
  // MISMATCH (Payments & Pricing round 6, bug): a mismatch found by the checkout guard, the cancel guard
  // or the hourly sweep was never alerted — the sweep skipped it with "webhook already alerted", which is
  // false in exactly the case these paths exist for (the webhook was LOST), while the buyer was told it
  // "is being checked by hand". The admin's own recheck already shows them the answer, so it stays quiet.
  const needs = ['DUPLICATE', 'SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED']
  if (result.outcome === 'MISMATCH') {
    if (source === 'admin-recheck') return false
  } else if (!needs.includes(result.outcome)) return false
  const emailService = require('./email.service')
  const auto = result.autoRefund && result.autoRefund.status
  const autoOk = auto === 'QUEUED' || auto === 'IN_PROGRESS' || auto === 'SCHEDULED'
  const queued = autoOk ? ' — automatic refund queued (no action needed)' : ' — refund needed'
  const titles = {
    DUPLICATE:       autoOk
      ? 'Duplicate payment for an already-purchased scan — automatic refund queued (no action needed)'
      : 'Duplicate payment for an already-purchased scan — refund needed',
    SCAN_MISSING:    `Payment received for a scan that no longer exists${queued}`,
    NO_SCAN:         `Payment received with no scan attached${queued}`,
    ACCOUNT_DELETED: `Payment received for a deleted account${queued}`,
    MISMATCH:        'Payment amount/currency mismatch — NOT fulfilled (found without the webhook)',
  }
  let detail
  if (result.outcome === 'DUPLICATE') {
    const owner = `\nThe scan is already fulfilled by payment ${result.ownerPaymentId || '(earlier payment)'}. NOT re-generated, NO commission recorded for this one.`
    if (autoOk)
      detail = `${owner} The whole amount is being refunded automatically; the refund.processed webhook marks it REFUNDED. Nothing to do unless that webhook never arrives.`
    else if (auto === 'FAILED')
      detail = `${owner} The AUTOMATIC refund failed (${result.autoRefund.reason}). Refund it in Paystack or Admin → Payments → Refund — the refund.processed webhook will mark it REFUNDED. The next verify / webhook redelivery also retries it.`
    else
      detail = `${owner} It was not refunded automatically${auto === 'SKIPPED' ? ` (${result.autoRefund.reason})` : ''}. Refund it in Paystack — the refund.processed webhook will mark it REFUNDED automatically.`
  } else if (result.outcome === 'MISMATCH') {
    detail = `\nexpected: ${result.expectedAmount} ${result.expectedCurrency}\nreceived: ${result.receivedAmount} ${result.receivedCurrency}\n` +
      `Paystack says this was PAID, but it differs from what the row expected, so nothing was generated. The buyer has been told it is being checked by hand. ` +
      `If it is genuine use Admin → Payments → Recheck (accept amount) or POST /api/payments/${paymentRow.paystack_ref}/recheck — currency can never be accepted.`
  } else if (autoOk) {
    detail = `\nNothing was generated. The whole amount is being refunded automatically; the refund.processed webhook marks it REFUNDED. Nothing to do unless that webhook never arrives.`
  } else if (auto === 'FAILED') {
    detail = `\nNothing was generated. The AUTOMATIC refund failed (${result.autoRefund.reason}). Refund it in Paystack or Admin → Payments → Refund — the next verify / webhook redelivery also retries it.`
  } else {
    detail = `\nNothing was generated.${auto === 'SKIPPED' ? ` It was not refunded automatically (${result.autoRefund.reason}).` : ''} Refund it in Paystack.`
  }
  try {
    await emailService.sendOwnerAlert(env, titles[result.outcome],
      `source: ${source}\nreference: ${paymentRow.paystack_ref}\nscanId: ${paymentRow.scan_id}\n` +
      `amount: ${paymentRow.amount_cents} ${paymentRow.currency}${detail}`,
      { dedupeKey: paymentRow.paystack_ref })
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
    currency:              original.currency ?? null,
    reverses_ledger_id:    original.id,
    reversal_reason:       reason,
  })
  if (insErr) {
    if (insErr.code === '23505') return { reversed: false, reason: 'already-reversed' }
    throw insErr
  }
  // The sale no longer counts: free the usage slot it consumed on a limited code.
  // Exactly once — only the call that actually inserted the reversal reaches here.
  // Section 4 round 9 (bug): this used to decide from the `original` row read BEFORE the insert, so a reversal
  // that raced recordConversion's counter bump (usage_counted still false here, flipped a moment later)
  // skipped the decrement and the slot leaked for good. The decision is now taken in SQL under the original
  // row's lock, AFTER the reversal is in — increment_referral_code_usage refuses to count a reversed sale, so
  // the two always net to zero. Best-effort: a failed release must never undo or fail the reversal.
  if (original.referral_code_id && typeof supabase.rpc === 'function') {
    try {
      const { error: decErr } = await supabase.rpc('release_referral_code_usage_for_ledger', { p_ledger_id: original.id })
      if (decErr) console.error('reverseCommission usage release:', decErr.message)
    } catch (err) { console.error('reverseCommission usage release:', err.message) }
  }
  return { reversed: true, alreadyPaidOut: !!original.payout_id, commissionCents: original.commission_amount_cents,
    partnerId: original.partner_id, currency: original.currency ?? null }
}

/**
 * Everything that follows money going back to the customer: mark the payment
 * REFUNDED, reverse the partner commission, and revoke the public credential —
 * but ONLY if this payment is the one that owns the scan (refunding a duplicate
 * payment must not tear down the valid credential from the first).
 * Every step is idempotent, so a redelivered event simply re-checks them.
 * Downloads are deliberately left alone (documented product decision).
 */
async function reversePayment(supabase, payment, { reason, refundReference = null, now = new Date(), env = null, defer = null }) {
  const { revokeVerification, REVOKE_REASON } = require('../lib/verification')
  const patch = { status: 'REFUNDED', refunded_at: now.toISOString() }
  if (refundReference) patch.refund_reference = refundReference

  const { data: moved, error } = await supabase.from('payments')
    .update(patch).eq('id', payment.id).in('status', ['SUCCESS', 'DISPUTED']).select('id')
  if (error) throw error
  const transitioned = !!(moved && moved.length)

  const ledger = await reverseCommission(supabase, payment.id, reason)
  // Tell the partner their commission was clawed back (live paths pass `env`).
  // Best-effort by contract: a notification problem must never fail the reversal itself.
  if (env && ledger.reversed && ledger.commissionCents > 0) {
    try {
      await require('./referral.service').notifyPartnerReversal(env, supabase, ledger.partnerId, ledger.commissionCents, ledger.currency)
    } catch (err) { console.error('reversePayment partner notice:', err.message) }
  }

  let revoked = false
  // A refund of a DUPLICATE (another payment owns the scan) leaves the buyer's purchase fully intact; the
  // buyer email must not say it was "closed" (Payments & Pricing round 6).
  let duplicate = false
  if (payment.scan_id) {
    const { data: scan, error: scanErr } = await supabase.from('scans')
      .select('id, fix_payment_id').eq('id', payment.scan_id).maybeSingle()
    if (scanErr) throw scanErr
    if (scan && (!scan.fix_payment_id || scan.fix_payment_id === payment.id))
      revoked = await revokeVerification(supabase, scan.id, REVOKE_REASON[reason] || REVOKE_REASON.ADMIN, now)
    else if (scan && scan.fix_payment_id && scan.fix_payment_id !== payment.id)
      duplicate = true
  }

  // WEBHOOKS ROUND 5 (feature gap): tell the buyer. Only the call that actually moved the payment to
  // REFUNDED sends it (a redelivery or a second path finds `transitioned` false), so it goes out once.
  // Live paths pass `env`; `defer` (the webhook's waitUntil) keeps the send out of the request.
  if (env && transitioned) {
    const task = notifyBuyerReversal(env, supabase, payment, { reason, revoked, duplicate })
    if (typeof defer === 'function') defer(task)
    else await task
  }
  return { transitioned, ledger, revoked }
}

// Best-effort, never throws. A free-credit redemption ($0 / `credit:` reference) charged nothing and
// has nothing to reverse from the buyer's side, so it never gets one.
async function notifyBuyerReversal(env, supabase, payment, { reason, revoked, duplicate = false }) {
  try {
    if (!payment.user_id || !(payment.amount_cents > 0) || String(payment.paystack_ref || '').startsWith('credit:')) return false
    const { data: buyer } = await supabase.from('users').select('email, name').eq('id', payment.user_id).maybeSingle()
    if (!buyer?.email) return false
    const sent = await require('./email.service').sendPaymentReversed(env, supabase, buyer.email, buyer.name, {
      amountCents: payment.amount_cents, currency: payment.currency, reference: payment.paystack_ref,
      reason, verificationRevoked: !!revoked, duplicate: !!duplicate,
    })
    return sent !== false
  } catch (err) {
    console.error('reversePayment buyer notice:', err && err.message)
    return false
  }
}

/**
 * A payment that was refunded IN FULL on Paystack before this app ever marked it paid (PENDING /
 * ABANDONED / FAILED — the charge.success webhook was lost or still failing). Nothing was delivered
 * and no commission was earned, so there is nothing to take back: the row is closed as REFUNDED so a
 * late charge.success / sweep can never fulfil money that has already gone back to the buyer
 * (settlePayment treats REFUNDED as final). Guarded on the unsettled statuses, so a payment that
 * settles at the same instant simply doesn't match: { transitioned: false, current } is then the
 * fresh row and the caller runs the normal reversal on it. Throws on a DB error (webhook → 500).
 */
async function refundUnsettledPayment(supabase, payment, { refundReference = null, now = new Date() } = {}) {
  const patch = { status: 'REFUNDED', refunded_at: now.toISOString() }
  if (refundReference) patch.refund_reference = refundReference
  const { data: moved, error } = await supabase.from('payments')
    .update(patch).eq('id', payment.id).in('status', REVIVABLE_STATUSES).select('id, referral_reservation_id')
  if (error) throw error
  if (moved && moved.length) {
    // A checkout still PENDING holds a referral-code usage slot; give it back (a no-op if already released).
    // Best-effort: the payment is already closed, so a failure here must never turn into a 500 + retry.
    if (payment.status === 'PENDING') {
      try { await require('./referral.service').releaseCodeReservation(supabase, moved[0].referral_reservation_id) }
      catch (err) { console.error('refundUnsettledPayment: releasing the referral slot failed:', err && err.message) }
    }
    return { transitioned: true, current: null }
  }
  const { data: current, error: curErr } = await supabase.from('payments').select('*').eq('id', payment.id).maybeSingle()
  if (curErr) throw curErr
  return { transitioned: false, current }
}

/** DISPUTED → SUCCESS (the dispute was won). Atomic on the status; false when nothing was DISPUTED. */
async function clearDispute(supabase, payment) {
  const { data, error } = await supabase.from('payments')
    .update({ status: 'SUCCESS', disputed_at: null }).eq('id', payment.id).eq('status', 'DISPUTED').select('id')
  if (error) throw error
  return !!(data && data.length)
}

module.exports = {
  REVIVABLE_STATUSES, REENQUEUE_AFTER_MS,
  generatorFor, chargeMismatch,
  fulfillPayment, settlePayment, notifySettlementProblem, recoverLostReceipts, resendReceipt, abandonPendingForScan,
  referenceCandidates, findPaymentForEvent, reverseCommission, reversePayment,
  refundUnsettledPayment, clearDispute, notifyBuyerReversal,
}
