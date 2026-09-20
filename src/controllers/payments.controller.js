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

const c = require('../config/constants')
const { getSupabase } = require('../config/supabase')
const cryptoLib = require('../lib/crypto')
const { scanRowToCamel } = require('../lib/mappers')
const paystackService = require('../services/paystack.service')
const emailService = require('../services/email.service')
const referralService = require('../services/referral.service')

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
      message: 'A payment is already in progress for this resume. Please finish or cancel it before choosing a different option.'
    }, 409)
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
  if (insertErr) throw insertErr

  return c2.json({ success: true, data: {
    authorization_url: result.authorization_url,
    access_code:        result.access_code,
    reference
  }})
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
    .from('payments').select('user_id, amount_cents, currency, scan_id, fix_tier').eq('paystack_ref', reference).maybeSingle()
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

  // Atomic idempotency — UPDATE...RETURNING only matches rows that were
  // still PENDING at update time, same guarantee as Prisma's updateMany count.
  const { data: updatedRows, error: updErr } = await supabase
    .from('payments')
    .update({ status: 'SUCCESS', paystack_auth_code: authCode })
    .eq('paystack_ref', reference)
    .eq('status', 'PENDING')
    .select()
  if (updErr) throw updErr

  if (updatedRows.length === 0) {
    // Already processed (webhook got there first, or this is a duplicate
    // client call) — scan_id is already known from the ownership check
    // above, no need to re-query it.
    return c2.json({ success: true, data: { scanId: paymentRow.scan_id } })
  }

  const payment = updatedRows[0]

  // Referral attribution is bound to the payment row itself (referral_code_id,
  // set once at initializePayment time — see that function's comment) — this
  // runs exactly once, gated by the same atomic idempotency check above, so
  // a partner is never double-credited for one sale. recordConversion never
  // throws (it swallows and logs its own errors internally).
  await referralService.recordConversion(supabase, payment)

  // fixTier comes from the PAYMENT row (bound at initializePayment, immutable
  // per reference) — never from scans.fix_tier, which is just a downstream
  // display/logic convenience field. This update is what makes scans.fix_tier
  // trustworthy again: it's now only ever written here, at confirmed-paid
  // time, from the tier that reference actually paid for.
  const fixTier = payment.fix_tier || 'FIX'

  // HARDENING: the atomic UPDATE above is, by design, the only moment
  // fulfillment will ever run for this reference — any future call to this
  // endpoint (or the webhook, in webhooks.controller.js) sees status !==
  // 'PENDING' and returns the early "already processed" success response
  // below, with no retry. That's correct for avoiding double-fulfillment,
  // but it means a failure in the two steps below previously had no path
  // back: the scans.update's own error was never even checked, so a failed
  // write could go unnoticed while this endpoint still reported success —
  // and scan.fixPurchased staying false is exactly what downloadFile in
  // scan.controller.js gates the paid file on, and what initiateFix's
  // already-purchased check relies on to prevent a second charge. Isolated
  // in its own try/catch so a failure here gets an owner alert pointing at
  // the manual recovery path, instead of either an opaque 500 or a false
  // "success" with fulfillment silently incomplete.
  try {
    const { error: scanUpdErr } = await supabase.from('scans').update({
      fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: fixTier
    }).eq('id', payment.scan_id)
    if (scanUpdErr) throw scanUpdErr

    const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
    // Enqueue instead of running inline via waitUntil() — generateFix/
    // generateBadge (two Claude calls + a Browser Rendering PDF render) can
    // easily exceed the 30-second waitUntil wall-clock cap, which silently
    // kills the task with no catchable error. The queue consumer (index.js)
    // has no such cap. See index.js's queue() handler for the full rationale.
    await c2.env.FIX_QUEUE.send({ type: generatorType, scanId: payment.scan_id })
  } catch (fulfillErr) {
    console.error(`[CRITICAL] verifyPayment fulfillment failed after payment marked SUCCESS (ref ${reference}, scan ${payment.scan_id}):`, fulfillErr.message)
    try {
      await emailService.sendOwnerAlert(c2.env,
        'Payment succeeded but fulfillment failed — manual reconcile needed',
        `source: verifyPayment\nreference: ${reference}\nscanId: ${payment.scan_id}\nfixTier: ${fixTier}\nerror: ${fulfillErr.message}\n\n` +
        `This payment is marked SUCCESS and will NOT be automatically retried. Once ` +
        `the underlying issue is fixed, call:\n\n  POST /api/payments/${reference}/reconcile  (admin-only)\n\n` +
        `to re-run the scan update + fix-generation enqueue.`
      )
    } catch (_) {}
    // The payment itself genuinely succeeded — Paystack was charged and
    // verified above. Don't surface a scary error for something that isn't
    // the payer's fault; fulfillment will be completed via the reconcile
    // path once the owner is alerted.
    return c2.json({ success: true, data: { scanId: payment.scan_id } })
  }

  return c2.json({ success: true, data: { scanId: payment.scan_id } })
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
    return ctx.json({ success: false, message: `Payment status is ${payment.status}, not SUCCESS — nothing to reconcile.` }, 400)

  const { data: scan, error: scanErr } = await supabase
    .from('scans').select('id, status, fix_purchased').eq('id', payment.scan_id).maybeSingle()
  if (scanErr) throw scanErr
  if (!scan) return ctx.json({ success: false, message: 'Scan not found.' }, 404)

  if (scan.fix_purchased && ['FIX_GENERATING', 'FIX_DELIVERED'].includes(scan.status)) {
    return ctx.json({ success: true, message: 'Already fulfilled — nothing to do.',
      data: { scanId: scan.id, status: scan.status } })
  }

  const fixTier = payment.fix_tier || 'FIX'
  const { error: updErr } = await supabase.from('scans').update({
    fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: fixTier
  }).eq('id', scan.id)
  if (updErr) throw updErr

  const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
  await ctx.env.FIX_QUEUE.send({ type: generatorType, scanId: scan.id })

  return ctx.json({ success: true, message: 'Re-enqueued.', data: { scanId: scan.id, fixTier } })
}

// GET /api/payments/history
async function getPaymentHistory(c2) {
  const user = c2.get('user')
  const supabase = getSupabase(c2.env)
  const { data: rows, error } = await supabase
    .from('payments')
    .select('id, amount_cents, currency, status, paystack_ref, created_at, scan_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  if (error) throw error

  const payments = rows.map(r => ({
    id: r.id, amountCents: r.amount_cents, currency: r.currency, status: r.status,
    paystackRef: r.paystack_ref, createdAt: r.created_at, scanId: r.scan_id
  }))

  return c2.json({ success: true, data: { payments } })
}

module.exports = { initializePayment, verifyPayment, getPaymentHistory, reconcilePayment }
