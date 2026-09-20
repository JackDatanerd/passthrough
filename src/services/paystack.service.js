// Identical logic to v8 — already used raw fetch (no SDK), so the only change
// is process.env.PAYSTACK_SECRET_KEY / process.env.PAYSTACK_CALLBACK_URL
// becoming explicit env.* params (Workers have no process.env).

const c = require('../config/constants')

// reference param: caller generates once, passes to both Paystack and DB
async function initializeTransaction(env, { email, amount, userId, scanId, fixTier, reference }) {
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
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
  })
  const json = await res.json()
  if (!json.status) throw new Error(json.message || 'Paystack init failed')
  return {
    authorization_url: json.data.authorization_url,
    access_code:       json.data.access_code,
    reference
  }
}

async function verifyTransaction(env, reference) {
  const res = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { 'Authorization': `Bearer ${env.PAYSTACK_SECRET_KEY}` } }
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

module.exports = { initializeTransaction, verifyTransaction }
