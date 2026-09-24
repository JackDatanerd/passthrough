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
const { hitQuota } = require('../middleware/rateLimiter')
const { sha256 } = require('../lib/crypto')
const { must } = require('../lib/db')

// ── Per-recipient throttle ──────────────────────────────────────────────────
// The per-IP limiters can't stop one address being mailed repeatedly (from many
// IPs, or by any flow that mails a third party's address: registering with
// someone else's email, "forgot password" for someone else's account, or the
// anonymous scan-result email). That is email-bombing a victim, and — since it
// all goes out under our sender domain — the fastest way to earn the spam
// complaints that get the domain blocked, breaking EVERY transactional email.
//
// Only templates a STRANGER can trigger are limited. Mail that follows a real
// customer proving their own identity (a password change, an account
// deletion) is not — those are already gated by the action itself (a correct
// current password, a successful login), not by anything an outsider can
// repeat at will.
//
// AUDIT FIX (Auth section audit, fresh pass): account_lockout_alert was
// missing from this list. It's the one template on the "not limited" side of
// that reasoning that doesn't actually fit it — it fires from
// recordLoginFailure() the moment an account LOCKS, i.e. on repeated FAILED
// attempts, not a proven identity. Knowing a victim's email plus 8 failures
// from >=2 distinct IPs (LOCKOUT_MAX_CONSECUTIVE_FAILURES /
// LOCKOUT_MIN_DISTINCT_IPS in rateLimiter.js) is enough to trigger it, and
// once the 15-minute lock expires the failure counter resets, so a stranger
// could repeat this indefinitely — the exact email-bombing shape this table
// exists to stop, just missed for the one "failure" template among templates
// that otherwise only fire on success.
//
// AUDIT FIX (Section 9/10 pass): email_change_confirm was also missing, and
// for the same reason as account_lockout_alert above — it doesn't actually
// fit the "proven identity" exemption either. updateEmail() in
// auth.controller.js does require the CALLER to prove their own current
// password, but the RECIPIENT of this specific template is whatever
// `newEmail` they typed — an arbitrary, attacker-chosen address, not the
// identity-proven account holder. Nothing stopped a logged-in attacker from
// repeatedly "changing their email" to a victim's address purely to spam
// that inbox; the only throttle was rl.auth (10 req/15min PER IP on the
// route), which bounds nothing per-recipient and resets forever. Capped the
// same as email_verification, since it's the same shape of flow (a
// confirmation link, legitimately retried a few times by a real user who
// fat-fingered an address or didn't see the first email) just reached
// through a different route.
const RECIPIENT_LIMITS = {
  email_verification:    { max: 5, windowSeconds: 3600 },
  password_reset:        { max: 3, windowSeconds: 3600 },
  welcome:                { max: 2, windowSeconds: 24 * 3600 },
  anon_scan_result:       { max: 3, windowSeconds: 3600 },
  account_lockout_alert:  { max: 4, windowSeconds: 3600 },
  email_change_confirm:   { max: 5, windowSeconds: 3600 },
  // One acknowledgement per address per month: the form is public, so the
  // recipient is whatever a stranger typed. A repeat submission never sends a
  // second one (the controller only sends for a NEW lead); this is the
  // backstop for the delete-and-resubmit path.
  employer_lead_ack:      { max: 1, windowSeconds: 30 * 24 * 3600 },
}

async function recipientAllowed(env, to, template) {
  const limit = RECIPIENT_LIMITS[template]
  if (!limit) return true
  const digest = (await sha256(String(to).trim().toLowerCase())).slice(0, 32)
  return hitQuota(env, `rl:mail:${template}:${digest}`, limit.max, limit.windowSeconds)
}

// ── Plain-text alternative ──────────────────────────────────────────────────
// HTML-only mail scores worse with spam filters and is unreadable in text
// clients. Templates are ours and every substituted value is HTML-escaped, so
// this can be a small, predictable converter rather than a general HTML parser.
function htmlToPlainText(html) {
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  const stripTags = s => s.replace(/<[^>]*>/g, '')
  let t = html.replace(/<style>[\s\S]*?<\/style>/i, '')
  t = t.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const l = stripTags(label).trim(), h = decode(href)
    return !l || l === h ? h : `${l} (${h})`
  })
  t = t.replace(/<\/(p|h[1-6]|tr|div|table)>|<br\s*\/?>/gi, '\n')
  t = decode(stripTags(t))
  return t.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Prices and thresholds shown in email copy come from constants.js (the
// single source of truth the site and checkout use), not from text typed
// into a template — a hard-coded "$49" quoted the wrong price for the whole
// launch promo and would drift again with any price change.
function fmtMoney(cents, currency) {
  const amount = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`
}
function globalVars(env) {
  const currency = env.PAYSTACK_CURRENCY || c.CURRENCY
  return {
    FRONTEND_URL:    env.FRONTEND_URL,
    PRICE_FIX:       fmtMoney(c.priceForTier('FIX', env), currency),
    PRICE_BADGE:     fmtMoney(c.priceForTier('BADGE', env), currency),
    PRICE_FIX_PLAIN: fmtMoney(c.priceForTier('FIX_PLAIN', env), currency),
    PASS_THRESHOLD:  String(c.ATS_PASS_THRESHOLD),
    BADGE_THRESHOLD: String(c.ATS_BADGE_THRESHOLD),
  }
}

// PATCH 1 (carried over): FRONTEND_URL injected automatically so base.html's
// header link is always correct. Individual send calls do not need to pass it.
async function send(env, supabase, to, subject, template, vars) {
  let status = 'sent', error = null

  if (!(await recipientAllowed(env, to, template))) {
    status = 'throttled'
    error  = 'per-recipient limit reached'
    console.error(`Email [${template}] to ${to}: throttled (per-recipient limit)`)
  } else {
    const html = render(template, { ...globalVars(env), ...vars })
    try {
      await sendViaResend(env, { from: env.EMAIL_FROM, to, subject, html, text: htmlToPlainText(html) })
    } catch (err) {
      status = 'failed'
      error  = err.message
      console.error(`Email [${template}] to ${to}:`, err.message)
    }
  }

  // email_logs is the one real audit trail for "did this email actually go
  // out" — awaited, and its result CHECKED: supabase-js reports a failed
  // insert as `{ error }`, it never throws, so a try/catch alone could not
  // detect it.
  try {
    must(await supabase.from('email_logs').insert({ to, subject, template, status, error }), 'email_logs insert')
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

// AUDIT FIX (feature gap, Auth section round 2): mirrors the existing
// sendPayoutDetailsChanged pattern below, applied to auth's own — more
// sensitive — credential changes. Called from BOTH changePassword and
// resetPassword in auth.controller.js, since either one leaves the account
// with a different password than a moment ago.
async function sendPasswordChanged(env, supabase, email, name) {
  return send(env, supabase, email, 'Your Passthrough password was changed', 'password_changed', {
    NAME: name
  })
}

// Sent to the OLD address from updateEmail() — the new address gets its own
// sendVerification() call already; this is the notice to the address being
// abandoned, which previously got nothing at all.
// Part of the pending-email flow (auth.controller.js's updateEmail /
// confirmEmailChange) — the confirmation link, sent to the NEW address.
// Companion to sendEmailChangedOldAddress below, which now fires at
// REQUEST time (see that function's own comment) rather than after an
// actual change — this is the function that makes the change actual.
async function sendEmailChangeConfirmation(env, supabase, newEmail, name, rawToken) {
  return send(env, supabase, newEmail, 'Confirm your new Passthrough email', 'email_change_confirm', {
    NAME:        name,
    CONFIRM_URL: `${env.FRONTEND_URL}/confirm-email-change?token=${rawToken}`
  })
}

async function sendEmailChangedOldAddress(env, supabase, oldEmail, name, newEmail) {
  return send(env, supabase, oldEmail, 'Your Passthrough account email was changed', 'email_changed_old_address', {
    NAME:      name,
    NEW_EMAIL: newEmail
  })
}

async function sendAccountDeleted(env, supabase, email, name) {
  return send(env, supabase, email, 'Your Passthrough account has been deleted', 'account_deleted', {
    NAME: name
  })
}

// Sent once, at the moment recordLoginFailure() actually transitions an
// account into a lock — not on every failed attempt. See rateLimiter.js.
async function sendAccountLockoutAlert(env, supabase, email, name, lockoutMinutes) {
  return send(env, supabase, email, 'Passthrough: repeated failed sign-in attempts', 'account_lockout_alert', {
    NAME:             name,
    LOCKOUT_MINUTES:  lockoutMinutes
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

// AUDIT FIX (feature gap): the app never sent any payment confirmation —
// Privacy.jsx explicitly tells visitors Resend "delivers transactional
// emails (verification, delivery, receipts)", but no code path actually sent
// one. Called once, from fulfillment.service.js's settlePayment, the single
// place a payment actually flips to SUCCESS — so it fires exactly once per
// payment regardless of which path (verifyPayment, the webhook, a sweep, an
// admin recheck) won that flip. amountCents/currency/date formatted here for
// the same reason sendPayoutSent formats its own amount: one place to keep
// "$45.00"-style formatting consistent, not left to each caller.
async function sendPaymentReceipt(env, supabase, email, name, { fixTier, amountCents, currency, reference, createdAt }) {
  return send(env, supabase, email, 'Your Passthrough receipt', 'payment_receipt', {
    NAME:       name,
    TIER_LABEL: c.tierLabel(fixTier),
    AMOUNT:     fmtMoney(amountCents, currency),
    DATE:       new Date(createdAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    REFERENCE:  reference
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
// AUDIT FIX (feature gap): adminUpdatePartner (partners.controller.js) could
// change partner.email with no confirmation to anyone — the sole channel for
// every future payout link, payout-sent confirmation, and referral-code
// notification, so this mirrors sendEmailChangedOldAddress's tripwire
// pattern for the user-account case. Called once for the OLD address and
// once for the NEW one (same template either way — the copy already covers
// both readers). Goes through send() like every other partner email here, so
// it inherits the per-recipient throttle, plain-text alternative, and
// awaited email_logs write from the Section 9/10 hardening above.
async function sendPartnerEmailChanged(env, supabase, to, name, oldEmail, newEmail) {
  return send(env, supabase, to, 'Your Passthrough partner account email was changed', 'partner_email_changed', {
    NAME: name, OLD_EMAIL: oldEmail, NEW_EMAIL: newEmail
  })
}

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
// The same alert is EMAILED at most once per 10 minutes. A failure that repeats
// (a broken queue, a payment provider outage) used to send one email per
// occurrence — a flood that buries the signal and trips Resend's own rate
// limit, so the alerts that matter stop arriving. Every occurrence is still
// written to alert_logs (emailed=false for the suppressed ones).
const ALERT_EMAIL_DEDUPE_SECONDS = 600

// SECTION 8 AUDIT FIX (bug): the email dedupe was keyed on the SUBJECT alone, but
// several money-critical alerts use one fixed subject for every occurrence
// ("Payment amount/currency mismatch", "Payment needs attention: DUPLICATE",
// "Paystack refund processed — sale reversed", …). Two DIFFERENT payments failing
// within 10 minutes therefore emailed once — the second customer's "refund
// needed" note existed only as an alert_logs row. `opts.dedupeKey` (e.g. the
// payment reference) scopes the throttle to the specific incident; callers that
// don't pass one keep the old subject-only behaviour.
async function sendOwnerAlert(env, subject, message, opts = {}) {
  const to = env.OWNER_ALERT_EMAIL
  let emailed = false
  const dedupeKey = opts && opts.dedupeKey ? `|${String(opts.dedupeKey)}` : ''
  const subjectDigest = (await sha256(`${String(subject)}${dedupeKey}`)).slice(0, 32)
  const shouldEmail = !!to && await hitQuota(env, `rl:alert:${subjectDigest}`, 1, ALERT_EMAIL_DEDUPE_SECONDS)
  if (shouldEmail) {
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
    must(await supabase.from('alert_logs').insert({ subject, message, emailed }), 'alert_logs insert')
  } catch (err) {
    // Logging the alert must never throw past this function — a broken
    // alert_logs write is exactly the kind of secondary failure that
    // shouldn't take down whatever critical path called sendOwnerAlert.
    console.error('alert_logs write failed:', err.message)
  }
  return emailed
}

// ── Employer-lead notices ───────────────────────────────────────────────────
// BUG FIX (Section 5 audit): this function was called from
// employer-leads.controller.js (createLead's notifyOwner -> sendNotice) but
// never existed here — every employer-lead notification has silently failed
// since that controller was written. The call sat inside a try/catch that
// only logs ("Employer-lead notice failed: ..."), so nothing ever surfaced
// it: leads were still stored and visible in the admin list, so there was no
// user-facing symptom. Nothing else caught it either — the controller's own
// test file stubs this whole module (so it never touches the real export
// list), and scripts/lint-undefined.cjs only flags undefined bare
// identifiers, not a missing property on an untyped require() (see its own
// header comment on exactly this class of bug).
//
// Deliberately NOT sendOwnerAlert: that function also writes an alert_logs
// row — the record of CRITICAL failures (payment/webhook errors, signature
// mismatches) — and a routine lead is not one of those; doubling it in there
// buried real incidents in a 5-row dashboard panel and copied lead PII into
// a table with no delete path (see migration 0028's own cleanup of the rows
// this used to write, back when leads went through sendOwnerAlert). This
// also skips sendOwnerAlert's per-subject dedupe (hitQuota, 1/10min keyed
// off a hash of the subject) — employer-leads.controller.js already runs its
// own hourly budget (withinNoticeBudget) and per-lead 24h resubmission
// cooldown before ever calling this, at a granularity that fits "how many
// leads came in", not "how many identical alert subjects fired".
//
// Errors are NOT swallowed here (unlike sendOwnerAlert) — the caller already
// wraps this call in its own try/catch and logs its own context, so
// swallowing here too would make that branch unreachable. (Confirmed by the
// controller's own test, "a failing mail provider never fails the
// submission", which stubs this function to throw and asserts the
// submission still succeeds.)
async function sendOwnerNotice(env, subject, message) {
  const to = env.OWNER_ALERT_EMAIL
  if (!to) {
    // Not an error (a deployment may deliberately have no owner inbox), but it
    // must not be silent: this is the same "the notification quietly never
    // arrives" shape as the missing-function bug this function was added for.
    console.warn(`OWNER_ALERT_EMAIL is not set — owner notice not sent: ${subject}`)
    return false
  }
  await sendViaResend(env, {
    from: env.EMAIL_FROM,
    to,
    subject: `[Passthrough Lead] ${subject}`,
    html: `<pre style="font-family: monospace; white-space: pre-wrap; font-size: 13px;">${escapeHtml(message)}</pre>`
  })
  return true
}

// Acknowledgement to an employer who just joined the early-access list. Sent
// once per NEW lead (see employer-leads.controller.js): it tells them the
// request landed, states what "Verified" means, and — since the address on a
// public form is whatever a stranger typed — says how to be removed.
async function sendEmployerLeadAck(env, supabase, email, name, fieldLabel) {
  return send(env, supabase, email, "You're on the Passthrough early-access list", 'employer_lead_ack', {
    NAME:          name,
    FIELD_PHRASE:  fieldLabel ? ` in ${fieldLabel}` : '',
    SUPPORT_EMAIL: 'support@passthrough.dev'
  })
}

module.exports = {
  htmlToPlainText, fmtMoney, sendEmployerLeadAck,
  sendWelcome, sendVerification, sendPasswordReset,
  sendPasswordChanged, sendEmailChangedOldAddress, sendEmailChangeConfirmation, sendAccountDeleted, sendAccountLockoutAlert,
  sendScanFail, sendScanPass, sendAnonScanResult, sendFixDelivered, sendFixDeliveredPlain, sendFixFailed,
  sendPaymentReceipt,
  sendOwnerAlert, sendOwnerNotice,
  sendPartnerPayoutDetailsRequest, sendPayoutSent, sendReferralCodeCreated,
  sendPayoutDetailsChanged, sendPartnerLinkRegenerated, sendPartnerEmailChanged
}
