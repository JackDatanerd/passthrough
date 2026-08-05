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

const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const emailService = require('../services/email.service')

async function handlePaystack(c) {
  const bodyText = await c.req.text()
  const expectedSig = await cryptoLib.hmacSha512Hex(c.env.PAYSTACK_SECRET_KEY, bodyText)
  if (!cryptoLib.timingSafeEqual(expectedSig, c.req.header('x-paystack-signature') || '')) {
    // Worth an immediate alert, not just a log line — this is either a
    // misconfigured PAYSTACK_SECRET_KEY (which would silently break every
    // future payment) or a genuine spoofing attempt against the webhook.
    // Deliberately doesn't include the actual signature/secret values.
    try {
      await emailService.sendOwnerAlert(c.env,
        'Paystack webhook signature mismatch',
        `A webhook request failed signature verification. This could mean\nPAYSTACK_SECRET_KEY is misconfigured (breaks all future payments) or\nsomeone is attempting to spoof a payment webhook.\n\nIP: ${c.req.header('cf-connecting-ip') || 'unknown'}\ntime: ${new Date().toISOString()}`
      )
    } catch (_) {}
    return c.text('Unauthorized', 401)
  }

  // Parse JSON from the same string we already hashed — no second read needed
  let event
  try { event = JSON.parse(bodyText) } catch (_) { return c.text('OK', 200) }
  if (event.event !== 'charge.success') return c.text('OK', 200)

  const reference = event.data?.reference
  const { scanId } = event.data?.metadata || {}
  if (!reference || !scanId) return c.text('OK', 200)

  const supabase = getSupabase(c.env)
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

        await supabase.from('scans').update({
          fix_purchased: true,
          fix_tier,
          status:        'FIX_PURCHASED'
        }).eq('id', scanId)

        const generatorType = fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
        // Enqueue instead of calling generateFix/generateBadge inline — see
        // index.js's queue() handler for why (30s waitUntil wall-clock cap
        // vs. the ~20-45s these functions realistically take).
        await c.env.FIX_QUEUE.send({ type: generatorType, scanId })
      } catch (err) {
        console.error('Webhook error:', err.message)
      }
    })()
  )

  return c.text('OK', 200)
}

module.exports = { handlePaystack }
