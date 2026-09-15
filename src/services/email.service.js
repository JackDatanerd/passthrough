// Replaces Nodemailer (config/email.js -> sendViaResend) and Prisma's
// emailLog.create (-> supabase.from('email_logs').insert). The templates/
// fs.readFileSync mechanism is replaced by src/templates/emails.js's render().
//
// Every public function now takes (env, supabase, ...args) as its first two
// params, since there's no module-level transporter/prisma singleton to close
// over — Workers don't have one. Patch 1 from the v8 history (FRONTEND_URL
// auto-injected into every send so the base.html header link is never broken)
// is preserved here exactly, just sourced from `env.FRONTEND_URL` instead of
// `process.env.FRONTEND_URL`.

const { sendViaResend } = require('../config/email')
const { render } = require('../templates/emails')
const c = require('../config/constants')

// PATCH 1 (carried over): FRONTEND_URL injected automatically so base.html's
// header link is always correct. Individual send calls do not need to pass it.
async function send(env, supabase, to, subject, template, vars) {
  const html = render(template, {
    FRONTEND_URL: env.FRONTEND_URL,  // injected globally
    ...vars                          // caller vars override if needed
  })
  let status = 'sent', error = null
  try {
    await sendViaResend(env, { from: env.EMAIL_FROM, to, subject, html })
  } catch (err) {
    status = 'failed'
    error  = err.message
    console.error(`Email [${template}] to ${to}:`, err.message)
  }
  supabase.from('email_logs')
    .insert({ to, subject, template, status, error })
    .then(() => {}, () => {})
  return status === 'sent'
}

// Email links use FRONTEND_URL — NOT the API URL.
// VerifyEmail.jsx and ResetPassword.jsx read token from URL and call the API.

async function sendWelcome(env, supabase, email, name) {
  return send(env, supabase, email, 'Welcome to Passthrough', 'welcome', { NAME: name })
}

async function sendVerification(env, supabase, email, name, rawToken) {
  return send(env, supabase, email, 'Verify your Passthrough email', 'email_verification', {
    NAME:       name,
    VERIFY_URL: `${env.FRONTEND_URL}/verify-email?token=${rawToken}`
  })
}

async function sendPasswordReset(env, supabase, email, name, rawToken) {
  return send(env, supabase, email, 'Reset your Passthrough password', 'password_reset', {
    NAME:      name,
    RESET_URL: `${env.FRONTEND_URL}/reset-password?token=${rawToken}`
  })
}

async function sendScanFail(env, supabase, email, name, score, cats) {
  return send(env, supabase, email, `Your resume scored ${score}/100`, 'scan_fail', {
    NAME:           name,
    SCORE:          String(score),
    KEYWORD_SCORE:  String(cats.keywordScore  || 0),
    FORMAT_SCORE:   String(cats.formatScore   || 0),
    SECTIONS_SCORE: String(cats.sectionsScore || 0),
    CONTENT_SCORE:  String(cats.contentScore  || 0),
    SCAN_URL:       `${env.FRONTEND_URL}/dashboard`
  })
}

async function sendScanPass(env, supabase, email, name, score) {
  const tpl = score >= c.ATS_BADGE_THRESHOLD ? 'scan_pass_badge' : 'scan_pass_standard'
  const sub = score >= c.ATS_BADGE_THRESHOLD
    ? `✓ Your resume passed — ${score}/100. Verified-eligible.`
    : `Your resume passed — score: ${score}/100`
  return send(env, supabase, email, sub, tpl, {
    NAME:     name,
    SCORE:    String(score),
    SCAN_URL: `${env.FRONTEND_URL}/dashboard`
  })
}

// ── Partner payouts (manual) ────────────────────────────────────────────────

async function sendPartnerPayoutDetailsRequest(env, supabase, email, name, payoutUrl) {
  return send(env, supabase, email, 'Set up your Passthrough payout details', 'partner_payout_details_request', {
    NAME:       name,
    PAYOUT_URL: payoutUrl
  })
}

// amountCents/currency formatted here (not left to the caller) so every
// payout email uses the same "$45.00"-style formatting regardless of who
// calls this — currently only partners.controller.js's adminRecordPayout,
// but this shouldn't silently drift if a second caller is added later.
async function sendPayoutSent(env, supabase, email, name, amountCents, currency) {
  const amount = `${(amountCents / 100).toFixed(2)} ${currency}`
  return send(env, supabase, email, 'Your Passthrough payout is on its way', 'payout_sent', {
    NAME:   name,
    AMOUNT: amount
  })
}

async function sendReferralCodeCreated(env, supabase, email, name, code, dashboardUrl) {
  return send(env, supabase, email, 'Your Passthrough referral code is ready', 'referral_code_created', {
    NAME:          name,
    CODE:          code,
    DASHBOARD_URL: dashboardUrl
  })
}

async function sendFixDelivered(env, supabase, email, name, code, verificationUrl) {
  return send(env, supabase, email, '✓ Your Passthrough Verified resume is ready', 'fix_delivered', {
    NAME:              name,
    VERIFICATION_CODE: code,
    VERIFICATION_URL:  verificationUrl,
    DOWNLOAD_URL:      `${env.FRONTEND_URL}/dashboard`
  })
}

async function sendFixDeliveredPlain(env, supabase, email, name) {
  return send(env, supabase, email, '✓ Your fixed resume is ready', 'fix_delivered_plain', {
    NAME:         name,
    DOWNLOAD_URL: `${env.FRONTEND_URL}/dashboard`
  })
}

async function sendFixFailed(env, supabase, email, name) {
  return send(env, supabase, email, "We hit a snag — we're on it", 'fix_failed', { NAME: name })
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Best-effort critical-failure notification to the site owner — added
// specifically because there was previously zero error monitoring: a
// production failure would only ever be discovered via wrangler tail (if
// someone happened to be watching) or an angry customer email. This isn't
// a replacement for real observability (Sentry, Logpush, etc.) — it's a
// minimal stopgap that needed no new account/DSN/service to set up, since
// Resend was already wired in.
//
// OWNER_ALERT_EMAIL is a plain [vars] entry in wrangler.toml, not a
// secret — it's just an email address, not credential-like. If it's unset,
// this silently no-ops rather than failing — alerting must never itself
// become a reason something else breaks.
async function sendOwnerAlert(env, subject, message) {
  const to = env.OWNER_ALERT_EMAIL
  if (!to) return false
  try {
    await sendViaResend(env, {
      from: env.EMAIL_FROM,
      to,
      subject: `[Passthrough Alert] ${subject}`,
      html: `<pre style="font-family: monospace; white-space: pre-wrap; font-size: 13px;">${escapeHtml(message)}</pre>`
    })
    return true
  } catch (err) {
    console.error('Owner alert failed to send:', err.message)
    return false
  }
}

module.exports = {
  sendWelcome, sendVerification, sendPasswordReset,
  sendScanFail, sendScanPass, sendFixDelivered, sendFixDeliveredPlain, sendFixFailed,
  sendOwnerAlert,
  sendPartnerPayoutDetailsRequest, sendPayoutSent, sendReferralCodeCreated
}
