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
    .from('payments').select('user_id, amount_cents, scan_id, fix_tier').eq('paystack_ref', reference).maybeSingle()
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
  if (pResult.data?.status !== 'success' || pResult.data?.currency !== (c2.env.PAYSTACK_CURRENCY || c.CURRENCY))
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
  // a partner is never double-credited for one sale.
  await referralService.recordConversion(supabase, payment)

  // fixTier comes from the PAYMENT row (bound at initializePayment, immutable
  // per reference) — never from scans.fix_tier, which is just a downstream
  // display/logic convenience field. This update is what makes scans.fix_tier
  // trustworthy again: it's now only ever written here, at confirmed-paid
  // time, from the tier that reference actually paid for.
  const fixTier = payment.fix_tier || 'FIX'
  await supabase.from('scans').update({
    fix_purchased: true, status: 'FIX_PURCHASED', fix_tier: fixTier
  }).eq('id', payment.scan_id)

  const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
  // Enqueue instead of running inline via waitUntil() — generateFix/
  // generateBadge (two Claude calls + a Browser Rendering PDF render) can
  // easily exceed the 30-second waitUntil wall-clock cap, which silently
  // kills the task with no catchable error. The queue consumer (index.js)
  // has no such cap. See index.js's queue() handler for the full rationale.
  await c2.env.FIX_QUEUE.send({ type: generatorType, scanId: payment.scan_id })

  return c2.json({ success: true, data: { scanId: payment.scan_id } })
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

module.exports = { initializePayment, verifyPayment, getPaymentHistory }
