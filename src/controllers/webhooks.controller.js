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
  if (expectedSig !== c.req.header('x-paystack-signature')) {
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
        // Atomic idempotency — same pattern as payments.controller.js
        const { data: updatedRows, error: updErr } = await supabase
          .from('payments')
          .update({ status: 'SUCCESS', paystack_auth_code: authCode })
          .eq('paystack_ref', reference)
          .eq('status', 'PENDING')
          .select()
        if (updErr) { console.error('Webhook payment update:', updErr.message); return }
        if (updatedRows.length === 0) return  // already processed — idempotent skip

        // fixTier is read from OUR OWN scans row (set by initializePayment),
        // not from event.data.metadata.fixTier — same trust pattern
        // verifyPayment already uses. The webhook payload is HMAC-verified
        // so metadata isn't spoofable in the usual sense, but having two
        // payment-completion paths trust two different origins for the same
        // fact is exactly the kind of thing that quietly drifts the next
        // time either path changes. One extra query keeps a single source
        // of truth.
        const { data: scanRow } = await supabase.from('scans').select('fix_tier').eq('id', scanId).maybeSingle()
        const fixTier = scanRow?.fix_tier || 'FIX'

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
