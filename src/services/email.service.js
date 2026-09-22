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
// Used only to persist alert_logs rows from sendOwnerAlert — every other
// function here already receives `supabase` from its caller, but
// sendOwnerAlert historically didn't take one (see its own comment below).
const { getSupabase } = require('../config/supabase')

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
  // AUDIT FIX (Section 9): this insert used to be fire-and-forget
  // (`.then(() => {}, () => {})`, never awaited, no ctx.waitUntil()). On
  // Workers, a promise that's neither awaited nor handed to waitUntil()
  // risks being cancelled the moment the response is returned — exactly
  // the failure mode this codebase's own scheduled-handler/queue-consumer
  // code elsewhere is careful to avoid. Unlike verify.controller.js's
  // increment_verification_views counter (deliberately left fire-and-forget
  // there, since it's just an analytics counter), email_logs is the one
  // real audit trail this app has for "did this email actually go out" —
  // worth the small added latency to guarantee it's written.
  try {
    await supabase.from('email_logs').insert({ to, subject, template, status, error })
  } catch (logErr) {
    console.error(`email_logs insert failed for [${template}] to ${to}:`, logErr.message)
  }
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

// AUDIT FIX (feature gap — section audit "generate a resume from scratch"):
// the only email path for a completed scan (sendScanFail/sendScanPass above)
// requires scan.userId — an anonymous brain-dump submitter has no account,
// so they previously got nothing at all, even though ScanForm.jsx already
// collects a contactEmail from exactly this population. This is the anon
// equivalent: same score info, but the link is a magic link (scanId +
// anonToken) rather than a dashboard link, since there's no login to send
// them to. See runAtsScan in scan.controller.js for the call site and the
// reasoning on why embedding anonToken in this specific email is safe (it's
// the person's own address, just submitted).
async function sendAnonScanResult(env, supabase, email, name, scanId, anonToken, score, passed) {
  const scanUrl = `${env.FRONTEND_URL}/scan/${scanId}?token=${anonToken}`
  return send(env, supabase, email, `Your resume scored ${score}/100`, 'anon_scan_result', {
    NAME:     name,
    SCORE:    String(score),
    PASSED:   passed ? 'passed' : 'is failing',
    SCAN_URL: scanUrl
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

// Confirms a change to a partner's payout destination BACK TO the partner
// themselves — see partners.controller.js's submitPayoutDetails, which
// previously sent no notification to anyone when this happened. This is
// the partner-facing half of that fix; sendOwnerAlert (called from the same
// place) is the admin-facing half.
async function sendPayoutDetailsChanged(env, supabase, email, name, method) {
  return send(env, supabase, email, 'Your Passthrough payout details were updated', 'partner_payout_details_changed', {
    NAME:   name,
    METHOD: method === 'BANK' ? 'Bank transfer' : 'Mobile money'
  })
}

async function sendPartnerLinkRegenerated(env, supabase, email, name, payoutUrl) {
  return send(env, supabase, email, 'Your Passthrough payout link has been reset', 'partner_link_regenerated', {
    NAME:       name,
    PAYOUT_URL: payoutUrl
  })
}

// SECTION 7 AUDIT: `verified` (default true) is false when the fixed resume's
// score finished under the Verified threshold. The email used to congratulate
// the candidate on a "Passthrough Verified resume" and tell them to paste
// "My resume has been Passthrough Verified" into cover letters — for a
// resume whose public page says the opposite.
async function sendFixDelivered(env, supabase, email, name, code, verificationUrl, verified = true) {
  if (!verified) {
    return send(env, supabase, email, 'Your rewritten resume is ready', 'fix_delivered_report', {
      NAME:             name,
      VERIFICATION_URL: verificationUrl,
      DOWNLOAD_URL:     `${env.FRONTEND_URL}/dashboard`
    })
  }
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
// the email leg silently no-ops rather than failing — alerting must never
// itself become a reason something else breaks. The alert_logs write below
// happens regardless of whether OWNER_ALERT_EMAIL is set, for the same
// reason it happens regardless of whether the email send succeeds: this is
// meant to be the durable record that survives even if the email leg is
// broken, missed, or filtered — previously an alert existed ONLY as an
// email, with zero trace in the app or DB if that email never reached
// anyone. The admin panel's System Health view reads this table. Awaited
// for the same Workers-cancellation reason the email_logs insert above
// was just changed to be awaited (see send()'s comment).
async function sendOwnerAlert(env, subject, message) {
  const to = env.OWNER_ALERT_EMAIL
  let emailed = false
  if (to) {
    try {
      await sendViaResend(env, {
        from: env.EMAIL_FROM,
        to,
        subject: `[Passthrough Alert] ${subject}`,
        html: `<pre style="font-family: monospace; white-space: pre-wrap; font-size: 13px;">${escapeHtml(message)}</pre>`
      })
      emailed = true
    } catch (err) {
      console.error('Owner alert failed to send:', err.message)
    }
  }
  try {
    const supabase = getSupabase(env)
    await supabase.from('alert_logs').insert({ subject, message, emailed })
  } catch (err) {
    // Logging the alert must never throw past this function — a broken
    // alert_logs write is exactly the kind of secondary failure that
    // shouldn't take down whatever critical path called sendOwnerAlert.
    console.error('alert_logs write failed:', err.message)
  }
  return emailed
}

module.exports = {
  sendWelcome, sendVerification, sendPasswordReset,
  sendScanFail, sendScanPass, sendAnonScanResult, sendFixDelivered, sendFixDeliveredPlain, sendFixFailed,
  sendOwnerAlert,
  sendPartnerPayoutDetailsRequest, sendPayoutSent, sendReferralCodeCreated,
  sendPayoutDetailsChanged, sendPartnerLinkRegenerated
}
