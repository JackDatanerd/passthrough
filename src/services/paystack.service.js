// Identical logic to v8 — already used raw fetch (no SDK), so the only change
// is process.env.PAYSTACK_SECRET_KEY / process.env.PAYSTACK_CALLBACK_URL
// becoming explicit env.* params (Workers have no process.env).

const c = require('../config/constants')

// AUDIT FIX (bug): neither Paystack call had a timeout, unlike every other
// outbound-fetch service in this codebase (claude.service.js's
// CLAUDE_TIMEOUT_MS, jd.parser.js's 5s job-description fetch, lib/ssrfGuard.js's
// DoH lookups). A hung connection to Paystack (a stalled TLS handshake, a
// half-open socket) could otherwise block indefinitely — initializePayment and
// verifyPayment would simply never resolve within the caller's own try/catch,
// and reconcile.service.js's sweepPendingPayments (up to MAX_VERIFY_PER_RUN
// sequential verify calls in one run) could have a single hung call silently
// stall every candidate behind it for the rest of that run, with no timeout to
// ever surface the problem. 15s comfortably covers a slow-but-real Paystack
// response while still failing fast enough for the existing owner-alert/502
// paths in payments.controller.js to actually run, instead of the platform's
// own hard limits killing the request out from under them uncaught.
const PAYSTACK_TIMEOUT_MS = 15000

async function paystackFetch(url, options, label) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PAYSTACK_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${PAYSTACK_TIMEOUT_MS / 1000}s`)
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// reference param: caller generates once, passes to both Paystack and DB
async function initializeTransaction(env, { email, amount, userId, scanId, fixTier, reference }) {
  const res = await paystackFetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type':   'application/json'
    },
    body: JSON.stringify({
      email, amount, currency: env.PAYSTACK_CURRENCY || c.CURRENCY, reference,
      metadata: { userId, scanId, fixTier, custom_fields: [] },
      callback_url: env.PAYSTACK_CALLBACK_URL
    })
  }, 'Paystack initialize')
  const json = await res.json()
  // AUDIT FIX (bug): this used to throw identically whether Paystack was
  // genuinely down/misconfigured (res.ok false — a real outage or a bad
  // secret key, exactly the "every payment attempt fails until this is
  // resolved" case initializePayment's catch pages the owner for) or simply
  // declined THIS specific request on an ordinary 200 (a duplicate
  // reference, a request Paystack's own validation rejects) — the second
  // case is routine and request-specific, not a systemic outage. Same
  // distinction verifyTransaction below already makes via res.ok vs
  // json.status; mirrored here via `err.paystackRejected` so
  // initializePayment's catch can tell the two apart instead of paging the
  // owner for both alike.
  if (!res.ok) throw new Error(json?.message || `Paystack initialize returned HTTP ${res.status}`)
  if (!json.status) {
    const err = new Error(json.message || 'Paystack init failed')
    err.paystackRejected = true
    throw err
  }
  return {
    authorization_url: json.data.authorization_url,
    access_code:       json.data.access_code,
    reference
  }
}

// AUDIT FIX (bug): Paystack's verify endpoint reports several non-terminal
// statuses for a transaction that is neither confirmed successful nor
// actually failed yet — most commonly seen on payment channels that need an
// extra confirmation step after the customer leaves the checkout page
// (mobile money OTP approval, bank transfer, USSD). payments.controller.js's
// verifyPayment used to treat anything other than 'success' identically —
// including these — as an outright "Payment verification failed", which is
// actively misleading for a customer whose money may already be on its way.
// Exported so payments.controller.js can tell "still processing" apart from
// a genuine failure without duplicating Paystack's vocabulary.
const PENDING_STATUSES = ['ongoing', 'pending', 'processing', 'queued']
function isPendingStatus(status) {
  return PENDING_STATUSES.includes(status)
}

async function verifyTransaction(env, reference) {
  const res = await paystackFetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { 'Authorization': `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
    'Paystack verify'
  )
  const json = await res.json()
  // BUGFIX: this used to return json unconditionally, with no equivalent of
  // initializeTransaction's `if (!json.status) throw`. A genuine Paystack-
  // side failure (rotated/misconfigured secret key, an outage, a malformed
  // response) surfaced identically to an ordinary "payment didn't succeed"
  // outcome — both just fell through to payments.controller.js's generic
  // 400 "Payment verification failed", with no [CRITICAL] owner alert for
  // the case that's actually an operational problem.
  //
  // Checked via res.ok (HTTP status), not json.status: Paystack reports an
  // ordinary "no such successful transaction" as json.status: false on a
  // normal 200 — that's ClientVisible verification failure, not a system
  // fault, and correctly stays on the existing data?.status !== 'success'
  // path in payments.controller.js with no alert. Only a non-2xx HTTP
  // response — auth failures, outages — throws here.
  if (!res.ok) throw new Error(json?.message || `Paystack verify returned HTTP ${res.status}`)
  return json
  // json.data.status — ONE level of .data (native fetch, not Axios)
}

// GET /refund?reference=… — the refunds Paystack has recorded for one transaction. Used by
// reconcile.service.js's sweepReversedPayments to tell a FULL refund (reverse the sale) from a
// partial one (leave it, tell a human) when a refund.processed webhook never reached us.
// Each item carries `status` (pending | processing | needs-attention | failed | processed),
// `amount` (minor units) and `currency`.
async function listRefunds(env, reference) {
  const res = await paystackFetch(
    `https://api.paystack.co/refund?reference=${encodeURIComponent(reference)}&perPage=50`,
    { headers: { 'Authorization': `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
    'Paystack refund list'
  )
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message || `Paystack refund list returned HTTP ${res.status}`)
  return json
}

module.exports = { initializeTransaction, verifyTransaction, listRefunds, isPendingStatus, PENDING_STATUSES }
