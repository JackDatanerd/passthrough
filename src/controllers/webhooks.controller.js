// Two key differences from v8:
//
// 1. NO raw body parsing ceremony. In v8, the webhook route was registered
//    in app.js BEFORE express.json() with express.raw() specifically because
//    Express's global body parser would destroy the Buffer needed for HMAC.
//    Hono has no global body parser — every handler reads its own body lazily
//    via c.req.text() / c.req.json() / c.req.arrayBuffer(). We just call
//    c.req.text() first, compute HMAC, compare, then JSON.parse the same
//    string. This is a normal Hono route file; there's nothing special about
//    where or how it's registered in index.js.
//
// 2. setImmediate is gone; waitUntil is required.  setImmediate's intent was
//    "finish the webhook background work after the 200 is sent". On Workers
//    that intent must be expressed as c.executionCtx.waitUntil(promise)
//    called BEFORE returning the response — the Worker runtime tracks the
//    promise and keeps the isolate alive until it settles. A bare unawaited
//    promise after `return c.text('OK')` can be killed before it finishes.
//
// Idempotency: same UPDATE...RETURNING pattern as payments.controller.js.
//
// FULFILLMENT-FAILURE HARDENING (added on audit):
// The atomic PENDING->SUCCESS flip below is, by design, the only moment
// fulfillment (scans.update + FIX_QUEUE.send) will ever run for a given
// payment reference — every later call (a Paystack retry of this same
// webhook, or the client's own payments.controller.js verifyPayment) sees
// status !== 'PENDING' and treats it as already handled, with no retry.
// That's correct for avoiding double-fulfillment, but it also means a
// failure AFTER the flip (a transient Supabase error, FIX_QUEUE.send
// throwing, the isolate getting killed mid-flight) previously had no path
// back: the payment stays SUCCESS forever, the scan stays stuck at
// FIX_PURCHASED (a status the hourly stuck-scan recovery cron in index.js
// doesn't cover — it only recovers SCANNING/FIX_GENERATING), and the old
// catch-all around this whole function only did console.error — no owner
// alert, unlike every other critical-failure path in this file. Fulfillment
// now has its own try/catch specifically so that failure gets a same-day
// owner alert pointing at the manual recovery path: POST
// /api/payments/:reference/reconcile (admin-only, payments.controller.js).
// The same fix is applied to verifyPayment for the identical reason.

const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const emailService = require('../services/email.service')
const referralService = require('../services/referral.service')

// Owner alerts for a bad webhook signature are useful the FIRST time (it's
// either a misconfigured secret or a real spoofing attempt) but this route
// is a public, documented URL (see DEPLOYMENT.md) — background internet
// scanning/bots will eventually poke it with no signature at all, and
// without any throttling every single one of those would fire an email.
// KV-backed cooldown: at most one alert per window, regardless of how many
// bad-signature requests land in it. Every occurrence is still logged to
// console (visible via `wrangler tail`), just not each one emailed.
const SIG_ALERT_COOLDOWN_KEY = 'webhook-alert-cooldown:paystack-sig-mismatch'
const SIG_ALERT_COOLDOWN_SECONDS = 30 * 60

async function shouldSendSigMismatchAlert(env) {
  try {
    const kv = env.RATE_LIMIT_KV
    if (!kv) return true  // no KV bound (e.g. some test setups) — fail open to alerting
    const existing = await kv.get(SIG_ALERT_COOLDOWN_KEY)
    if (existing) return false
    await kv.put(SIG_ALERT_COOLDOWN_KEY, '1', { expirationTtl: SIG_ALERT_COOLDOWN_SECONDS })
    return true
  } catch (_) {
    return true  // KV hiccup — better to occasionally over-alert than go silent
  }
}

// Wraps the two DB/queue side effects that MUST happen exactly once per
// successfully-fulfilled payment. Isolated from recordConversion (which
// already swallows its own errors and never throws) so that a failure here
// — and only here — gets the owner alert described above.
async function fulfill(env, supabase, { reference, scanId, fixTier }) {
  const { error: scanUpdErr } = await supabase.from('scans').update({
    fix_purchased: true,
    fix_tier,
    status:        'FIX_PURCHASED'
  }).eq('id', scanId)
  if (scanUpdErr) throw scanUpdErr

  const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
  // Enqueue instead of calling generateFix/generateBadge inline — see
  // index.js's queue() handler for why (30s waitUntil wall-clock cap
  // vs. the ~20-45s these functions realistically take).
  await env.FIX_QUEUE.send({ type: generatorType, scanId })
}

async function alertFulfillmentFailed(env, { reference, scanId, fixTier, err, source }) {
  console.error(`[CRITICAL] ${source} fulfillment failed after payment marked SUCCESS (ref ${reference}, scan ${scanId}):`, err.message)
  try {
    await emailService.sendOwnerAlert(env,
      'Payment succeeded but fulfillment failed — manual reconcile needed',
      `source: ${source}\nreference: ${reference}\nscanId: ${scanId}\nfixTier: ${fixTier}\nerror: ${err.message}\n\n` +
      `This payment is marked SUCCESS and will NOT be automatically retried — the ` +
      `idempotency guard means no future webhook or client call will re-attempt ` +
      `fulfillment for this reference. Once the underlying issue is fixed, call:\n\n` +
      `  POST /api/payments/${reference}/reconcile  (admin-only)\n\n` +
      `to re-run the scan update + fix-generation enqueue.`
    )
  } catch (_) {}
}

// Chargebacks/refunds get a same-day owner alert with everything needed to
// act, rather than being silently no-op'd. Deliberately does NOT auto-revoke
// anything (verify_expose_docx/pdf, deleting the scan) — an automatic
// revocation on a false positive or a partial/ambiguous dispute event would
// be worse than a short delay before a human looks at it.
async function alertDisputeOrRefund(env, supabase, event) {
  const reference = event.data?.reference || null
  try {
    let scanId = null
    if (reference) {
      const { data: p } = await supabase.from('payments')
        .select('scan_id').eq('paystack_ref', reference).maybeSingle()
      scanId = p?.scan_id || null
    }
    await emailService.sendOwnerAlert(env,
      `Paystack ${event.event}`,
      `A "${event.event}" webhook event was received.\n\n` +
      `reference: ${reference || '(none in payload)'}\nscanId: ${scanId || '(could not resolve)'}\n\n` +
      `This was NOT automatically actioned — no credential/download access was ` +
      `revoked. Review manually; the scan's verify-visibility toggle ` +
      `(verify_expose_docx/verify_expose_pdf) or deleting the scan are the ` +
      `available levers if revocation is warranted.`
    )
  } catch (_) {}
}

async function handlePaystack(c) {
  const bodyText = await c.req.text()
  const expectedSig = await cryptoLib.hmacSha512Hex(c.env.PAYSTACK_SECRET_KEY, bodyText)
  if (!cryptoLib.timingSafeEqual(expectedSig, c.req.header('x-paystack-signature') || '')) {
    // Worth an immediate alert (throttled — see shouldSendSigMismatchAlert
    // above), not just a log line — this is either a misconfigured
    // PAYSTACK_SECRET_KEY (which would silently break every future payment)
    // or a genuine spoofing attempt against the webhook. Deliberately
    // doesn't include the actual signature/secret values.
    console.error(`Paystack webhook signature mismatch (IP: ${c.req.header('cf-connecting-ip') || 'unknown'})`)
    try {
      if (await shouldSendSigMismatchAlert(c.env)) {
        await emailService.sendOwnerAlert(c.env,
          'Paystack webhook signature mismatch',
          `A webhook request failed signature verification. This could mean\nPAYSTACK_SECRET_KEY is misconfigured (breaks all future payments) or\nsomeone is attempting to spoof a payment webhook.\n\nIP: ${c.req.header('cf-connecting-ip') || 'unknown'}\ntime: ${new Date().toISOString()}\n\n(Further mismatches in the next 30 minutes are logged, not re-emailed.)`
        )
      }
    } catch (_) {}
    return c.text('Unauthorized', 401)
  }

  // Parse JSON from the same string we already hashed — no second read needed
  let event
  try { event = JSON.parse(bodyText) } catch (_) { return c.text('OK', 200) }

  const supabase = getSupabase(c.env)

  // Chargebacks/refunds — not fulfillment, just a defense-in-depth alert
  // (see alertDisputeOrRefund above for why nothing is auto-revoked).
  if (event.event?.startsWith('charge.dispute') || event.event?.startsWith('refund.')) {
    c.executionCtx?.waitUntil(alertDisputeOrRefund(c.env, supabase, event))
    return c.text('OK', 200)
  }

  if (event.event !== 'charge.success') return c.text('OK', 200)

  const reference = event.data?.reference
  const { scanId } = event.data?.metadata || {}
  if (!reference || !scanId) return c.text('OK', 200)

  const authCode = event.data?.authorization?.authorization_code

  // waitUntil keeps the isolate alive while the background work runs —
  // we respond 200 to Paystack immediately, then process
  c.executionCtx?.waitUntil(
    (async () => {
      try {
        // Amount/currency check — defense in depth, same posture as
        // verifyPayment's equivalent check. Signature verification above
        // means this event genuinely came from Paystack, so this isn't
        // about forgery — it's about not fulfilling on a legitimately-signed
        // event whose amount/currency doesn't match what we expected for
        // this reference (a future currency misconfig, a race between two
        // initializePayment calls, etc). The webhook is the primary
        // fulfillment path in practice — it fires regardless of whether the
        // user's browser ever hits /verify — so it's the one that most
        // needs this check, not the one that can skip it.
        const { data: paymentRow, error: selErr } = await supabase
          .from('payments').select('amount_cents, currency').eq('paystack_ref', reference).maybeSingle()
        if (selErr) { console.error('Webhook payment lookup:', selErr.message); return }
        if (!paymentRow) { console.error(`Webhook for unknown reference: ${reference}`); return }

        if (event.data?.amount !== paymentRow.amount_cents || event.data?.currency !== paymentRow.currency) {
          console.error(`[CRITICAL] Webhook amount/currency mismatch on ${reference}: expected ${paymentRow.amount_cents} ${paymentRow.currency}, received ${event.data?.amount} ${event.data?.currency}`)
          try {
            await emailService.sendOwnerAlert(c.env,
              'Webhook amount/currency mismatch — NOT fulfilled',
              `reference: ${reference}\nscanId: ${scanId}\nexpected: ${paymentRow.amount_cents} ${paymentRow.currency}\nreceived: ${event.data?.amount} ${event.data?.currency}\n\nPayment left PENDING for manual review — no fix was generated. The verify-payment fallback (if the user's browser hits /verify) will independently apply the same check.`
            )
          } catch (_) {}
          return
        }

        // Atomic idempotency — same pattern as payments.controller.js
        const { data: updatedRows, error: updErr } = await supabase
          .from('payments')
          .update({ status: 'SUCCESS', paystack_auth_code: authCode })
          .eq('paystack_ref', reference)
          .eq('status', 'PENDING')
          .select()
        if (updErr) { console.error('Webhook payment update:', updErr.message); return }
        if (updatedRows.length === 0) return  // already processed — idempotent skip

        // Same attribution recording as payments.controller.js's verifyPayment
        // — gated by the same atomic check above, so whichever of the two
        // fulfillment paths (webhook or client verify) gets here first is the
        // only one that ever records it. recordConversion never throws (it
        // swallows and logs its own errors internally), so it can't take
        // down the fulfillment below.
        await referralService.recordConversion(supabase, updatedRows[0])

        // fixTier comes from the PAYMENT row itself (bound at
        // initializePayment, immutable per reference), not from
        // event.data.metadata.fixTier and not from scans.fix_tier. Same fix
        // as verifyPayment: scans.fix_tier used to be the source of truth
        // here and is a mutable field that a later initializePayment() call
        // (for a different tier, same scan) can overwrite before this
        // reference gets redeemed — letting someone pay for the cheap tier
        // and receive whatever tier was initialized last. The payment row is
        // the only thing immutably tied to what THIS reference actually paid
        // for, so it's the only thing fulfillment should trust.
        const fixTier = updatedRows[0]?.fix_tier || 'FIX'

        // From here on this is the ONE invocation that will ever run these
        // two steps for this reference (see the file-level comment above) —
        // isolated in its own try/catch specifically so a failure gets an
        // owner alert + a pointer to the manual reconcile endpoint, instead
        // of vanishing into the outer catch's console.error.
        try {
          await fulfill(c.env, supabase, { reference, scanId, fixTier })
        } catch (fulfillErr) {
          await alertFulfillmentFailed(c.env, { reference, scanId, fixTier, err: fulfillErr, source: 'webhook' })
        }
      } catch (err) {
        console.error('Webhook error:', err.message)
      }
    })()
  )

  return c.text('OK', 200)
}

module.exports = { handlePaystack }
