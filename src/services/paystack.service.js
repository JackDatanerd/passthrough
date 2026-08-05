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
  return res.json()
  // json.data.status — ONE level of .data (native fetch, not Axios)
}

module.exports = { initializeTransaction, verifyTransaction }
