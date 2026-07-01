// Replaces config/email.js (Nodemailer transporter). Resend's HTTP API is a
// single fetch call — no persistent connection/transporter object needed,
// which fits the Workers fetch-per-request model better than SMTP ever did.

async function sendViaResend(env, { from, to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ from, to, subject, html })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Resend API error (${res.status}): ${body}`)
  }
  return res.json()
}

module.exports = { sendViaResend }
