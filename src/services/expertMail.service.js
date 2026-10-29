// Experts Phase 2A: mail for the expert realm. Its own sender identity (EXPERT_EMAIL_FROM, an address on the expert domain, with its own
// SPF / DKIM / DMARC) so expert mail never shares a reputation with customer mail. Only a password-reset link is sent in 2A; it carries
// the token in the URL fragment (not sent to any server or log when the link is opened) and never any resume or customer detail.
const { sendViaResend } = require('../config/email')

async function sendPasswordReset(env, { to, link }) {
  if (!env.EXPERT_EMAIL_FROM) { console.error('[CRITICAL] EXPERT_EMAIL_FROM is not set: expert password reset email not sent'); return false }
  const html = `<p>Someone asked to reset the password for your Passthrough Experts account.</p><p><a href="${link}">Choose a new password</a></p><p>The link works once and expires soon. If you did not ask for this, you can ignore this email; your password has not changed.</p>`
  const text = `Someone asked to reset the password for your Passthrough Experts account.\n\nChoose a new password: ${link}\n\nThe link works once and expires soon. If you did not ask for this, ignore this email; your password has not changed.`
  try { await sendViaResend(env, { from: env.EXPERT_EMAIL_FROM, to, subject: 'Reset your Passthrough Experts password', html, text }); return true }
  catch (err) { console.error('expert reset email failed:', err.message); return false }
}
module.exports = { sendPasswordReset }
