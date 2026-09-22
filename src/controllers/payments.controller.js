// Ported from Express/Prisma to Hono/Supabase. The one subtle point worth
// flagging: v8's atomic idempotency check used Prisma's
// `updateMany({ where: { status: 'PENDING' } })` and checked the returned
// `count`. Supabase's equivalent is `.update().eq('status','PENDING').select()`
// — Postgres only returns rows that matched the WHERE clause AT THE MOMENT OF
// THE UPDATE, which is the same atomic guarantee Prisma's updateMany gave:
// under a race between this endpoint and the webhook, only one caller's
// UPDATE...RETURNING will see status='PENDING' and get a row back; the other
// gets an empty array. `updatedRows.length` replaces `count`.
//
// generateFix/generateBadge calls are dispatched via FIX_QUEUE (see
// index.js's queue() handler) rather than run inline — see that handler's
// comment block for why waitUntil() isn't viable here (30s wall-clock cap,
// non-catchable kill on timeout).

const { z } = require('zod')
const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const { scanRowToCamel } = require('../lib/mappers')
const paystackService = require('../services/paystack.service')
const emailService = require('../services/email.service')
const referralService = require('../services/referral.service')
const fulfillmentService = require('../services/fulfillment.service')
const reconcileService = require('../services/reconcile.service')

// POST /api/payments/initialize
async function initializePayment(c2) {
  const user = c2.get('user')
  const body = await c2.req.json()
  const { scanId, fixTier, referralCode } = body
  if (!scanId || !['FIX', 'BADGE', 'FIX_PLAIN'].includes(fixTier))
    return c2.json({ success: false, message: 'scanId and valid fixTier required.' }, 400)

  const supabase = getSupabase(c2.env)
  const { data: row, error } = await supabase.from('scans').select('*').eq('id', scanId).maybeSingle()
  if (error) throw error
  const scan = scanRowToCamel(row)

  if (!scan || scan.userId !== user.id)
    return c2.json({ success: false, message: 'Access denied.' }, 403)
  if (scan.fixPurchased)
    return c2.json({ success: false, message: 'Already purchased.' }, 400)
  if (!['COMPLETE_PASS', 'COMPLETE_FAIL'].includes(scan.status))
    return c2.json({ success: false, message: 'Scan must be complete.' }, 400)
  if (fixTier === 'BADGE' && (scan.atsScore || 0) < c.ATS_BADGE_THRESHOLD)
    return c2.json({ success: false, message: `Badge requires score >= ${c.ATS_BADGE_THRESHOLD}` }, 400)

  // BUGFIX: nothing previously stopped two initializePayment calls for the
  // same scan from both succeeding (double-click, two tabs, retrying after
  // a slow Paystack popup) — the only guard was scan.fixPurchased, which
  // stays false until a payment actually completes. Two live checkouts
  // could both get paid: double-charging the user, enqueueing generateFix
  // twice, and (via referralService.recordConversion) double-crediting a
  // partner's commission for one sale.
  //
  // Deliberately does NOT abandon/overwrite an existing PENDING row here —
  // doing so could mark ABANDONED a checkout the user is mid-way through
  // paying on Paystack's hosted page, which would defeat the atomic
  // idempotency check in verifyPayment/webhooks.controller.js (neither
  // would find a PENDING row left to flip to SUCCESS), leaving a
  // genuinely-paid customer charged with no fix ever delivered. Instead:
  //   - same tier, still fresh  -> resume the exact same checkout
  //   - different tier, fresh   -> block with a clear message
  //   - stale (access code has long since expired anyway) -> fall through,
  //     the old row is harmless dead weight at that point
  const PENDING_REUSE_WINDOW_MS = 30 * 60 * 1000
  const { data: existingPending, error: pendingErr } = await supabase
    .from('payments')
    .select('paystack_ref, paystack_access_code, fix_tier, created_at')
    .eq('scan_id', scanId).eq('status', 'PENDING')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (pendingErr) throw pendingErr

  if (existingPending && (Date.now() - Date.parse(existingPending.created_at)) < PENDING_REUSE_WINDOW_MS) {
    if (existingPending.fix_tier === fixTier && existingPending.paystack_access_code) {
      return c2.json({ success: true, data: {
        access_code: existingPending.paystack_access_code,
        reference:   existingPending.paystack_ref
      }})
    }
    return c2.json({ success: false,
      message: 'A payment is already in progress for this resume. Please finish or cancel it before choosing a different option.',
      // AUDIT FIX (feature gap): this message told the user to "cancel it"
      // with no way to actually do that anywhere in the app — see
      // cancelPayment below. Surfacing the reference here is what lets the
      // frontend offer a real cancel action instead of a 30-minute wait.
      data: { reference: existingPending.paystack_ref, fixTier: existingPending.fix_tier }
    }, 409)
  }

  // AUDIT FIX (feature gap): pay_status_enum defines FAILED and ABANDONED
  // (migration 0001) but nothing anywhere ever wrote either value — a
  // PENDING row that aged out of the reuse window above used to just sit
  // there forever, so a user's own payment history (getPaymentHistory
  // below) showed a phantom "still pending" purchase indefinitely for
  // every checkout they never finished. This is the one place in the app
  // that already knows, for certain, that a given PENDING row is dead: we
  // just decided NOT to resume it. Best-effort and non-blocking — the same
  // atomic PENDING-only guard verifyPayment/handlePaystack rely on means
  // this can never clobber a payment that's genuinely mid-flight on
  // Paystack's side, and a failure here shouldn't stop the fresh checkout
  // below from proceeding.
  if (existingPending) {
    try {
      const { error: abandonErr } = await supabase
        .from('payments')
        .update({ status: 'ABANDONED' })
        .eq('paystack_ref', existingPending.paystack_ref)
        .eq('status', 'PENDING')
      if (abandonErr) console.error('Stale payment abandon failed:', abandonErr.message)
    } catch (err) {
      console.error('Stale payment abandon failed:', err.message)
    }
  }

  // Single source of truth for the amount — same resolver the public
  // /api/pricing quote goes through (pricing.controller.js), so whatever
  // price the checkout screen showed is exactly what gets charged here.
  // An invalid/expired/exhausted code silently falls through to normal
  // promo/standard pricing rather than blocking the payment.
  const priced   = await referralService.resolvePrice(supabase, fixTier, c2.env, referralCode)
  const amount    = priced.amount
  const reference = cryptoLib.uuid()  // generated ONCE — passed to both Paystack and DB

  // Call Paystack FIRST — if it fails, no orphan record is created
  let result
  try {
    result = await paystackService.initializeTransaction(c2.env, {
      email: user.email, amount, userId: user.id, scanId, fixTier, reference
    })
  } catch (err) {
    console.error(`[CRITICAL] Paystack initialize failed (scan ${scanId}):`, err.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Paystack initialize failed — payments may be blocked',
        `Every payment attempt fails until this is resolved.\n\nuserId: ${user.id}\nscanId: ${scanId}\nfixTier: ${fixTier}\namount: ${amount}\nerror: ${err.message}`
      )
    } catch (_) {}
    return c2.json({ success: false,
      message: 'Payment could not be started right now. We\'ve been notified — please try again shortly.'
    }, 502)
  }

  // Paystack confirmed — now safe to create the DB record
  //
  // fix_tier is stored HERE, on the payment row itself, and never touched
  // again. This is the fix for a tier-smuggling bug: fulfillment (verifyPayment
  // and the webhook) used to read scans.fix_tier at completion time, but that
  // column is a single mutable field that got overwritten by every
  // initializePayment call — so paying for a cheap reference while a later,
  // pricier initialize() had run in between would deliver the pricier tier.
  // Binding fix_tier to the immutable payment row closes that: whatever tier
  // this specific reference was created for is what it will always fulfill,
  // regardless of what any other in-flight initialize call does to the scan.
  //
  // referral_code_id/referral_code are bound the same way, for the same
  // reason — whatever code priced THIS reference is what its commission
  // ledger entry (see referral.service.js's recordConversion) will reflect,
  // regardless of what happens to the code afterward.
  const { error: insertErr } = await supabase.from('payments').insert({
    amount_cents:          amount,
    currency:              c2.env.PAYSTACK_CURRENCY || c.CURRENCY,
    status:                'PENDING',
    paystack_ref:          reference,
    paystack_access_code:  result.access_code,
    user_id:               user.id,
    scan_id:               scanId,
    fix_tier:              fixTier,
    referral_code_id:      priced.referralCode?.id || null,
    referral_code:         priced.referralCode?.code || null
  })
  // AUDIT FIX (bug): Paystack has ALREADY been successfully initialized for
  // this reference at this point — every other critical failure in this
  // function (Paystack init itself failing, an amount mismatch at verify
  // time) pages the owner; this write failing used to just `throw` into the
  // generic error handler, which only console.errors. If this is happening,
  // every payment attempt is likely failing the same way — exactly the
  // "every payment attempt fails until this is resolved" case the Paystack-
  // init failure branch above already treats as page-worthy.
  if (insertErr) {
    console.error(`[CRITICAL] payments insert failed after Paystack initialize succeeded (scan ${scanId}, ref ${reference}):`, insertErr.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Payment row insert failed — payments may be blocked',
        `Paystack was successfully initialized for this reference, but saving the payment record failed.\n` +
        `If this isn't a one-off, every payment attempt is likely failing the same way.\n\n` +
        `userId: ${user.id}\nscanId: ${scanId}\nfixTier: ${fixTier}\nreference: ${reference}\namount: ${amount}\nerror: ${insertErr.message}`
      )
    } catch (_) {}
    return c2.json({ success: false,
      message: 'Payment could not be started right now. We\'ve been notified — please try again shortly.'
    }, 502)
  }

  return c2.json({ success: true, data: {
    authorization_url: result.authorization_url,
    access_code:        result.access_code,
    reference
  }})
}

// POST /api/payments/:reference/cancel
//
// AUDIT FIX (feature gap): initializePayment's 409 above ("...before
// choosing a different option") has told the user they can cancel a stuck
// checkout since that message existed — nothing anywhere ever let them.
// Self-serve, ownership- and status-checked in the SAME atomic UPDATE (no
// separate read-then-write): `.eq('user_id', user.id).eq('status','PENDING')`
// means this can only ever touch a still-fresh payment that genuinely
// belongs to the caller, and — same guarantee every other status flip in
// this file relies on — a payment that finishes on Paystack's side in the
// same instant (webhook or /verify winning the race) simply won't match
// here, so a real payment can never be cancelled out from under a paying
// customer.
async function cancelPayment(c2) {
  const user = c2.get('user')
  const reference = c2.req.param('reference')
  const supabase = getSupabase(c2.env)

  const { data: updated, error } = await supabase
    .from('payments')
    .update({ status: 'ABANDONED' })
    .eq('paystack_ref', reference)
    .eq('user_id', user.id)
    .eq('status', 'PENDING')
    .select('id')
  if (error) throw error
  if (!updated || updated.length === 0)
    return c2.json({ success: false,
      message: 'Nothing to cancel — this payment is not pending, or does not belong to you.' }, 404)

  return c2.json({ success: true })
}

// GET /api/payments/verify?reference=xxx
async function verifyPayment(c2) {
  const user = c2.get('user')
  const reference = c2.req.query('reference') || c2.req.query('trxref')
  if (!reference) return c2.json({ success: false, message: 'Missing reference.' }, 400)

  const supabase = getSupabase(c2.env)

  // Ownership check — every other payment/scan-mutating endpoint in this
  // file (and payments.controller.js's sibling initializePayment) checks
  // scan.userId / payment.userId === user.id before doing anything else.
  // This endpoint was the one exception: any authenticated user who had
  // *a* valid reference (their own or someone else's) could trigger
  // fulfillment and read back the associated scanId. references are
  // unguessable UUIDs, so exploitability was low, but this closes the gap
  // the same way the rest of the app already does — checked BEFORE calling
  // out to Paystack, and BEFORE revealing whether the reference exists at
  // all. Also doubles as the "expected payment" row the amount check below
  // needs, so there's no second query for the same row anymore.
  const { data: paymentRow, error: paymentErr } = await supabase
    .from('payments').select('*').eq('paystack_ref', reference).maybeSingle()
  if (paymentErr) throw paymentErr
  if (!paymentRow || paymentRow.user_id !== user.id)
    return c2.json({ success: false, message: 'Payment not found.' }, 404)

  let pResult
  try {
    pResult = await paystackService.verifyTransaction(c2.env, reference)
  } catch (err) {
    console.error(`[CRITICAL] Paystack verify failed (ref ${reference}):`, err.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Paystack verify failed — a payment may be stuck',
        `reference: ${reference}\nerror: ${err.message}`
      )
    } catch (_) {}
    return c2.json({ success: false, message: 'Payment verification failed.' }, 502)
  }
  // BUGFIX: previously compared against the CURRENT env config
  // (c2.env.PAYSTACK_CURRENCY || c.CURRENCY) rather than what THIS payment
  // was actually initialized with. webhooks.controller.js's handlePaystack
  // already checks against paymentRow.currency — the two fulfillment paths
  // could reach different verdicts on the exact same transaction if
  // PAYSTACK_CURRENCY is ever changed between initialize and verify (a
  // mid-flight config change or redeploy). Now both paths trust the same
  // source of truth: what was actually stored on the payment row.
  if (pResult.data?.status !== 'success' || pResult.data?.currency !== paymentRow.currency)
    return c2.json({ success: false, message: 'Payment verification failed.' }, 400)

  // Amount check — defense in depth. Paystack's hosted checkout won't let a
  // user pay a different amount than what initializePayment set, but we've
  // never actually verified that here; this is the same class of "don't
  // trust it just because it looks right" posture the rest of the codebase
  // already applies (see profile.controller.js's SECURITY NOTE). A mismatch
  // is treated as suspicious, not silently reconciled — no fix is generated
  // and the row stays PENDING for manual review rather than either
  // fulfilling on bad data or destructively marking it FAILED before a
  // human looks at it.
  if (pResult.data?.amount !== paymentRow.amount_cents) {
    console.error(`[CRITICAL] Amount mismatch on ${reference}: expected ${paymentRow.amount_cents}, Paystack reports ${pResult.data?.amount}`)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Payment amount mismatch — NOT fulfilled',
        `reference: ${reference}\nscanId: ${paymentRow.scan_id}\nexpected: ${paymentRow.amount_cents}\nreceived: ${pResult.data?.amount}\n\nPayment left PENDING for manual review — no fix was generated.`
      )
    } catch (_) {}
    return c2.json({ success: false, message: 'Payment verification failed.' }, 400)
  }

  const authCode = pResult.data?.authorization?.authorization_code

  // SECTION 8 AUDIT: settlement + fulfilment now live in
  // services/fulfillment.service.js, shared with the webhook, the admin actions
  // and both sweeps (they used to be four hand-copied variants). What this path
  // gains: the flip accepts ABANDONED/FAILED rows (initializePayment's
  // stale-checkout cleanup marks unfinished checkouts ABANDONED — a buyer who
  // then pays that old checkout was silently dropped), a redelivery finishes a
  // half-done fulfilment instead of skipping it, a second payment for an
  // already-purchased scan is reported instead of re-generating the fix, and the
  // customer's fulfilment runs BEFORE the partner-commission bookkeeping.
  let result
  try {
    result = await fulfillmentService.settlePayment(c2.env, supabase, paymentRow, { authCode, source: 'verifyPayment' })
  } catch (fulfillErr) {
    console.error(`[CRITICAL] verifyPayment settlement/fulfillment failed (ref ${reference}, scan ${paymentRow.scan_id}):`, fulfillErr.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Payment succeeded but fulfillment failed — manual reconcile needed',
        `source: verifyPayment\nreference: ${reference}\nscanId: ${paymentRow.scan_id}\nfixTier: ${paymentRow.fix_tier}\nerror: ${fulfillErr.message}\n\n` +
        `Recovery is automatic: Paystack's webhook retries, the buyer's next /verify call, and the hourly sweeps all re-run settlement. ` +
        `To force it now: POST /api/payments/${reference}/reconcile (admin-only).`
      )
    } catch (_) {}
    // The payment itself genuinely succeeded — Paystack was charged and verified
    // above. Don't surface a scary error for something that isn't the payer's fault.
    return c2.json({ success: true, data: { scanId: paymentRow.scan_id } })
  }

  await fulfillmentService.notifySettlementProblem(c2.env, result, paymentRow, 'verifyPayment')
  return c2.json({ success: true, data: { scanId: paymentRow.scan_id } })
}

// POST /api/payments/:reference/reconcile — admin-only manual recovery.
//
// Exists because of the fulfillment sequencing above (and in
// webhooks.controller.js's handlePaystack): once a payment is marked
// SUCCESS, that is the only moment fulfillment (scans.update + a
// FIX_QUEUE.send) will ever automatically run — every later call to either
// fulfillment path sees status !== 'PENDING' and treats it as already
// handled, with no retry. If fulfillment failed after the flip (the owner
// alert those code paths send says exactly this happened), this endpoint
// re-applies the same two steps by hand.
async function reconcilePayment(ctx) {
  const reference = ctx.req.param('reference')
  const supabase = getSupabase(ctx.env)

  const { data: payment, error } = await supabase
    .from('payments').select('*').eq('paystack_ref', reference).maybeSingle()
  if (error) throw error
  if (!payment) return ctx.json({ success: false, message: 'Payment not found.' }, 404)
  if (payment.status !== 'SUCCESS')
    return ctx.json({ success: false, message: `Payment status is ${payment.status}, not SUCCESS — nothing to reconcile. (PENDING/ABANDONED/FAILED: use /recheck.)` }, 400)

  // force: an admin explicitly asked, so re-enqueue a stuck FIX_PURCHASED scan
  // without waiting out the automatic re-enqueue grace period.
  const result = await fulfillmentService.fulfillPayment(ctx.env, supabase, payment, { force: true })

  // Also re-attempt the partner-commission ledger entry. recordConversion is
  // idempotent (one original ledger row per payment -> a repeat is a harmless
  // no-op), and a failed ledger write at fulfillment time is otherwise
  // unrecoverable. Skipped for a duplicate: it must never earn commission.
  const skipCommission = ['DUPLICATE', 'SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED'].includes(result.outcome)
  const conversion = skipCommission ? null : await referralService.recordConversion(supabase, payment)

  const messages = {
    FULFILLED:         'Fulfilled.',
    REENQUEUED:        'Re-enqueued.',
    ALREADY_FULFILLED: 'Already fulfilled — nothing to do.',
    DUPLICATE:         'This is a DUPLICATE payment — the scan was already fulfilled by another payment. Nothing was generated. Refund it in Paystack.',
    SCAN_MISSING:      'Scan not found.',
    NO_SCAN:           'This payment has no scan attached.',
    ACCOUNT_DELETED:   'The account was deleted — nothing to deliver. Refund it in Paystack.',
  }
  const ok = !['SCAN_MISSING', 'NO_SCAN'].includes(result.outcome)
  return ctx.json({ success: ok, message: messages[result.outcome] || result.outcome,
    data: { scanId: payment.scan_id, outcome: result.outcome, fixTier: result.fixTier, conversion } }, ok ? 200 : 404)
}

// POST /api/payments/:reference/recheck — admin-only.
// SECTION 8 AUDIT (feature gap): a payment held for a mismatch (or one whose
// webhook was lost) sits PENDING/ABANDONED/FAILED, and /reconcile refuses
// anything that isn't SUCCESS — so "left PENDING for manual review" had no
// tool behind it. This asks Paystack, and if the money really arrived,
// settles + delivers it. Body: { acceptAmountMismatch?: boolean } — only for a
// genuine amount difference (customer paid fees, etc.); a currency mismatch is
// never accepted.
const recheckSchema = z.object({ acceptAmountMismatch: z.boolean().optional() })

async function recheckPayment(ctx) {
  const reference = ctx.req.param('reference')
  const body = recheckSchema.parse(await ctx.req.json().catch(() => ({})))
  const supabase = getSupabase(ctx.env)

  const { data: payment, error } = await supabase
    .from('payments').select('*').eq('paystack_ref', reference).maybeSingle()
  if (error) throw error
  if (!payment) return ctx.json({ success: false, message: 'Payment not found.' }, 404)
  if (payment.status === 'SUCCESS')
    return ctx.json({ success: false, message: 'Already SUCCESS — use /reconcile to re-run delivery.' }, 400)
  if (['REFUNDED', 'DISPUTED'].includes(payment.status))
    return ctx.json({ success: false, message: `Payment is ${payment.status} — not eligible.` }, 400)
  if (payment.paystack_ref.startsWith('credit:'))
    return ctx.json({ success: false, message: 'Free-credit redemption — nothing to check with Paystack.' }, 400)

  let r
  try {
    r = await reconcileService.recheckPayment(ctx.env, supabase, payment, {
      acceptAmountMismatch: !!body.acceptAmountMismatch, source: 'admin-recheck',
    })
  } catch (err) {
    return ctx.json({ success: false, message: `Paystack lookup failed: ${err.message}` }, 502)
  }
  await fulfillmentService.notifySettlementProblem(ctx.env, r, payment, 'admin-recheck')

  if (r.outcome === 'NOT_PAID')
    return ctx.json({ success: false, message: `Paystack reports this transaction as "${r.paystackStatus}" — not paid.`, data: r }, 409)
  if (r.outcome === 'MISMATCH')
    return ctx.json({ success: false, message: 'Paid, but amount/currency differ from what was expected. Re-send with acceptAmountMismatch:true to accept an amount difference (currency can never be accepted).', data: r }, 409)
  return ctx.json({ success: true, message: r.outcome, data: r })
}

// POST /api/payments/:reference/resolve — admin-only.
// SECTION 8 AUDIT (feature gap): refunds/disputes had no state to move to.
//   reverse         SUCCESS|DISPUTED → REFUNDED, reverse commission, revoke credential
//                   (use when you LOST a dispute, or refunded outside Paystack)
//   clear-dispute   DISPUTED → SUCCESS (you WON the dispute)
const resolveSchema = z.object({ action: z.enum(['reverse', 'clear-dispute']) })

async function resolvePayment(ctx) {
  const reference = ctx.req.param('reference')
  const body = resolveSchema.parse(await ctx.req.json())
  const supabase = getSupabase(ctx.env)

  const { data: payment, error } = await supabase
    .from('payments').select('*').eq('paystack_ref', reference).maybeSingle()
  if (error) throw error
  if (!payment) return ctx.json({ success: false, message: 'Payment not found.' }, 404)

  if (body.action === 'clear-dispute') {
    if (payment.status !== 'DISPUTED')
      return ctx.json({ success: false, message: `Payment is ${payment.status}, not DISPUTED.` }, 400)
    const { error: upErr } = await supabase.from('payments')
      .update({ status: 'SUCCESS', disputed_at: null }).eq('id', payment.id).eq('status', 'DISPUTED')
    if (upErr) throw upErr
    return ctx.json({ success: true, message: 'Dispute cleared — payment is SUCCESS again.' })
  }

  if (!['SUCCESS', 'DISPUTED', 'REFUNDED'].includes(payment.status))
    return ctx.json({ success: false, message: `Payment is ${payment.status} — nothing to reverse.` }, 400)
  const reason = payment.status === 'DISPUTED' ? 'DISPUTE' : 'REFUND'
  const done = await fulfillmentService.reversePayment(supabase, payment, { reason })
  return ctx.json({ success: true, message: 'Reversed.', data: {
    transitioned: done.transitioned, commissionReversed: done.ledger.reversed,
    commissionNote: done.ledger.reason || (done.ledger.alreadyPaidOut ? 'already paid out — nets against next payout' : null),
    verificationRevoked: done.revoked,
  } })
}

// GET /api/payments/history
async function getPaymentHistory(c2) {
  const user = c2.get('user')
  const supabase = getSupabase(c2.env)
  const { data: rows, error } = await supabase
    .from('payments')
    .select('id, amount_cents, currency, status, paystack_ref, created_at, scan_id, fix_tier')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  if (error) throw error

  // AUDIT FIX (Section 9, feature gap): fix_tier was never selected or
  // returned here, so a user's own payment history couldn't tell them
  // which tier (FIX/BADGE/FIX_PLAIN) each past purchase actually was —
  // despite that column existing specifically so downstream consumers
  // could trust it (see migration 0010's comment).
  const payments = rows.map(r => ({
    id: r.id, amountCents: r.amount_cents, currency: r.currency, status: r.status,
    paystackRef: r.paystack_ref, createdAt: r.created_at, scanId: r.scan_id, fixTier: r.fix_tier
  }))

  return c2.json({ success: true, data: { payments } })
}

module.exports = { initializePayment, cancelPayment, verifyPayment, getPaymentHistory, reconcilePayment, recheckPayment, resolvePayment }
