// Replaces the 9 .html files under backend/templates/emails/. Workers bundle
// JS at build time — there's no fs.readFileSync for arbitrary files at runtime
// without extra build tooling, so each template becomes a JS string constant
// instead of a file on disk. Content is byte-for-byte identical to the v8 spec
// (including the $39 credential pricing and 'credential' copy from the last
// product update — nothing here is a content change, only the loading mechanism).

const BASE = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <style>\n    body { margin:0; padding:0; background:#f4f4f5; font-family: sans-serif; }\n    .wrapper { max-width:600px; margin:32px auto; background:#ffffff;\n               border-radius:8px; overflow:hidden; }\n    .header  { background:#1E40AF; padding:24px 32px; }\n    .header a { color:#ffffff; font-size:20px; font-weight:700; text-decoration:none; }\n    .body    { padding:32px; color:#1f2937; font-size:15px; line-height:1.6; }\n    .footer  { padding:20px 32px; background:#f9fafb; color:#9ca3af;\n               font-size:12px; text-align:center; }\n    .btn     { display:inline-block; background:#1E40AF; color:#ffffff;\n               padding:12px 24px; border-radius:6px; text-decoration:none;\n               font-weight:600; margin:16px 0; }\n  </style>\n</head>\n<body>\n  <div class=\"wrapper\">\n    <div class=\"header\"><a href=\"{{FRONTEND_URL}}\">Passthrough</a></div>\n    <div class=\"body\">{{CONTENT}}</div>\n    <div class=\"footer\">passthrough.dev \u2014 ATS Resume Scanner</div>\n  </div>\n</body>\n</html>\n"

const TEMPLATES = {
  welcome: "<h2>Welcome, {{NAME}}!</h2>\n<p>Your Passthrough account is ready.</p>\n<p>Scan any resume against any job description and find out exactly why\nit's being rejected \u2014 before a recruiter ever sees it.</p>\n<p>Check your inbox for a verification email to unlock file downloads.</p>\n<a href=\"{{FRONTEND_URL}}\" class=\"btn\">Start Scanning \u2192</a>\n",
  email_verification: "<h2>Verify your email</h2>\n<p>Hi {{NAME}}, click below to verify your Passthrough email address.</p>\n<p>You need to verify your email before you can download fixed resumes.</p>\n<a href=\"{{VERIFY_URL}}\" class=\"btn\">Verify Email \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link expires in 1 hour.\nIf you didn't create a Passthrough account, ignore this email.</p>\n",
  password_reset: "<h2>Reset your password</h2>\n<p>Hi {{NAME}}, click below to reset your Passthrough password.</p>\n<a href=\"{{RESET_URL}}\" class=\"btn\">Reset Password \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link expires in 1 hour.\nIf you didn't request a reset, ignore this email.</p>\n",
  // AUDIT FIX (feature gap, Auth section round 2): the app already has this
  // exact pattern for a partner's payout details (partner_payout_details_changed
  // below) \u2014 a confirmation to the affected party whenever something sensitive
  // changes, framed as the tripwire that tells them if it wasn't them. Auth's
  // own credential changes (password, email, account deletion) never got the
  // same treatment despite being more sensitive than a payout method. Sent
  // after BOTH changePassword and resetPassword succeed, since either one
  // means the password is now different.
  password_changed: "<h2>Your password was changed</h2>\n<p>Hi {{NAME}}, this confirms your Passthrough password was just changed. Every other signed-in session has been signed out.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't make this change, reset your password immediately and contact support@passthrough.dev \u2014 your account may be compromised.</p>\n",
  // Sent to the OLD address when updateEmail() succeeds \u2014 the new address
  // already gets a verification email (email_verification, above), but the
  // old one previously heard nothing at all. This is the one place a real
  // account-takeover victim can still be reached once the address on file
  // has changed out from under them.
  email_changed_old_address: "<h2>Your account email was changed</h2>\n<p>Hi {{NAME}}, the email address on your Passthrough account was just changed from this address to {{NEW_EMAIL}}.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't make this change, contact support@passthrough.dev immediately \u2014 your account may be compromised. This is the only notice sent to this address; future account emails will go to the new one.</p>\n",
  // Sent right before the scrub/soft-delete commits (deleteAccount already
  // has the user's current, pre-scrub email in hand at that point). No link
  // or CTA \u2014 deletion is immediate and irreversible by the time this sends.
  account_deleted: "<h2>Your account has been deleted</h2>\n<p>Hi {{NAME}}, this confirms your Passthrough account and all associated data have been permanently deleted, as requested.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't request this, contact support@passthrough.dev immediately.</p>\n",
  // Sent once, at the moment an account actually locks (not on every failed
  // attempt) \u2014 see recordLoginFailure's lockedAt transition in rateLimiter.js.
  // Previously the only signal a real owner had that something was wrong was
  // stumbling onto the 429 toast themselves during the lock window.
  account_lockout_alert: "<h2>Repeated failed sign-in attempts</h2>\n<p>Hi {{NAME}}, we've temporarily locked your Passthrough account for {{LOCKOUT_MINUTES}} minutes after several failed sign-in attempts from multiple locations.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If this wasn't you, no action is needed right now \u2014 the account stays locked and your password hasn't been changed. If you're not sure your password is still safe, reset it once the lock clears.</p>\n",
  scan_fail: "<h2>Your resume scored {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume scored {{SCORE}}/100 against the ATS filter.</p>\n<p>Resumes below {{PASS_THRESHOLD}} are typically discarded before a recruiter opens the file.</p>\n<table style=\"width:100%;border-collapse:collapse;margin:16px 0\">\n  <tr><td style=\"padding:8px 0;color:#374151\">Keyword Match</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{KEYWORD_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Formatting</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{FORMAT_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Resume Sections</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{SECTIONS_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Content Quality</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{CONTENT_SCORE}}/100</td></tr>\n</table>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Fix My Resume \u2014 {{PRICE_FIX}} \u2192</a>\n",
  scan_pass_standard: "<h2>Your resume passed \u2014 {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume passed ATS screening with a score of {{SCORE}}/100.</p>\n<p>Your score is just below our Verified threshold ({{BADGE_THRESHOLD}}+). A full fix and rewrite\ncan get you there \u2014 and includes the Passthrough Verified credential.</p>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Polish to Get Verified \u2014 {{PRICE_FIX}} \u2192</a>\n",
  scan_pass_badge: "<h2>\u2713 Your resume passed \u2014 {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume scored {{SCORE}}/100 and is Verified-eligible.</p>\n<p>You can get the Passthrough Verified credential \u2014 an employer-checkable\nverification that confirms your resume passed ATS screening.</p>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Get Verified \u2014 {{PRICE_BADGE}} \u2192</a>\n<p>Or for a full AI polish and rewrite: <a href=\"{{SCAN_URL}}\">Full Package \u2014 {{PRICE_FIX}}</a></p>\n",
  // AUDIT FIX (feature gap — section audit "generate a resume from
  // scratch"): anonymous brain-dump submitters previously got no email at
  // all. SCAN_URL here is a magic link (scan id + anon token), not a
  // dashboard link, since there's no account to send them to — the whole
  // point of this email is to be the way back in.
  anon_scan_result: "<h2>Your resume scored {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, the resume we built from what you told us {{PASSED}} ATS screening, scoring {{SCORE}}/100.</p>\n<p>This link is how you get back to it — bookmark it, or create a free account to keep it permanently and unlock the full fix.</p>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">View Your Resume →</a>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't request this, you can ignore this email — no account was created and nothing else will happen.</p>\n",
  fix_delivered: "<h2>\u2713 Your Passthrough Verified resume is ready</h2>\n<p>Hi {{NAME}}, your fixed resume is ready to download from your dashboard.</p>\n<a href=\"{{DOWNLOAD_URL}}\" class=\"btn\">Download Your Files \u2192</a>\n<p><strong>How to use your two files:</strong></p>\n<p>\ud83d\udcc4 <strong>.docx file</strong> \u2192 Upload to job portals, company websites,\nand any online application form.</p>\n<p>\ud83c\udfa8 <strong>PDF file</strong> \u2192 Email hiring managers directly,\nshare with recruiters, use on your portfolio.</p>\n<p><strong>Your Passthrough Verified credential:</strong><br>\nYour verification URL: <a href=\"{{VERIFICATION_URL}}\">{{VERIFICATION_URL}}</a></p>\n<p>Add this to your cover letters:<br>\n<em>\"My resume has been Passthrough Verified. Verify: {{VERIFICATION_URL}}\"</em></p>\n",
  // SECTION 7 AUDIT: delivered when the rewrite finished under the Verified
  // threshold — honest wording, no credential claim, no cover-letter blurb.
  fix_delivered_report: "<h2>Your rewritten resume is ready</h2>\n<p>Hi {{NAME}}, your rewritten resume is ready to download from your dashboard.</p>\n<a href=\"{{DOWNLOAD_URL}}\" class=\"btn\">Download Your Files \u2192</a>\n<p><strong>How to use your two files:</strong></p>\n<p>\ud83d\udcc4 <strong>.docx file</strong> \u2192 Upload to job portals, company websites,\nand any online application form.</p>\n<p>\ud83c\udfa8 <strong>PDF file</strong> \u2192 Email hiring managers directly,\nshare with recruiters, use on your portfolio.</p>\n<p><strong>About the Passthrough Verified credential:</strong><br>\nThis version scored just under our Verified threshold, so it carries a scan report link rather than the Verified credential: <a href=\"{{VERIFICATION_URL}}\">{{VERIFICATION_URL}}</a></p>\n<p>You can use \"Try Again\" on your dashboard to have it re-worked \u2014 if a later version clears the threshold, the same link becomes your Verified credential.</p>\n",
  fix_delivered_plain: "<h2>\u2713 Your fixed resume is ready</h2>\n<p>Hi {{NAME}}, your rewritten resume is ready to download from your dashboard.</p>\n<a href=\"{{DOWNLOAD_URL}}\" class=\"btn\">Download Your Files \u2192</a>\n<p><strong>How to use your two files:</strong></p>\n<p>\ud83d\udcc4 <strong>.docx file</strong> \u2192 Upload to job portals, company websites,\nand any online application form.</p>\n<p>\ud83c\udfa8 <strong>PDF file</strong> \u2192 Email hiring managers directly,\nshare with recruiters, use on your portfolio.</p>\n",
  fix_failed: "<h2>We hit a snag</h2>\n<p>Hi {{NAME}}, something went wrong generating your resume.</p>\n<p><strong>You have not been charged again.</strong> We're looking into it\nand will email you when your resume is ready.</p>\n<p>If you need help, email us at support@passthrough.dev</p>\n",
  partner_payout_details_request: "<h2>Set up your payout details</h2>\n<p>Hi {{NAME}}, welcome to the Passthrough partner program.</p>\n<p>Click below to tell us where to send your payouts \u2014 bank account or\nmobile money, whichever you prefer.</p>\n<a href=\"{{PAYOUT_URL}}\" class=\"btn\">Add Payout Details \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link is unique to you \u2014 don't share it. You can come back and\nupdate these details anytime.</p>\n",
  payout_sent: "<h2>Payout sent \u2713</h2>\n<p>Hi {{NAME}}, we've sent you a payout of {{AMOUNT}}.</p>\n<p>It should reflect in your account shortly, depending on your bank or\nmobile money provider's processing time.</p>\n<p>Thanks for partnering with Passthrough.</p>\n",
  referral_code_created: "<h2>Your referral code is live</h2>\n<p>Hi {{NAME}}, your Passthrough referral code is ready to share:</p>\n<p style=\"font-size:28px;font-weight:700;letter-spacing:1px;color:#1E40AF\">{{CODE}}</p>\n<p>Anyone who uses it gets a discounted price, and you earn a commission on\nevery sale it brings in.</p>\n<a href=\"{{DASHBOARD_URL}}\" class=\"btn\">View Your Dashboard \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">Your dashboard shows clicks, conversions, and earnings for every code\nyou have \u2014 bookmark the link above.</p>\n",
  // Sent to the PARTNER whenever their payout method/details are
  // added or changed via the token-gated form, so a change to where their
  // money goes is never silent to them either \u2014 if they didn't make this
  // change, this email is the tripwire that tells them so.
  partner_payout_details_changed: "<h2>Your payout details were updated</h2>\n<p>Hi {{NAME}}, this confirms your Passthrough payout details (method: {{METHOD}}) were just added or changed.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't make this change, reply to this email immediately \u2014\nyour payout link may have been shared or compromised.</p>\n",
  // AUDIT FIX (feature gap): mirrors email_changed_old_address's tripwire
  // pattern for the user-account case, applied to partner.email — the sole
  // channel for every future payout link, payout-sent confirmation, and
  // referral-code notification a partner ever receives. Sent to BOTH the
  // old and new address (see partners.controller.js's adminUpdatePartner).
  partner_email_changed: "<h2>Your partner account email was changed</h2>\n<p>Hi {{NAME}}, the email address on file for your Passthrough partner account was just changed from {{OLD_EMAIL}} to {{NEW_EMAIL}}.</p>\n<p style=\"color:#9ca3af;font-size:13px\">If you didn't request this, reply to this email or contact support@passthrough.dev immediately \u2014 future payout links, payout confirmations, and referral-code notifications will go to the new address.</p>\n",
  // Sent when an admin regenerates a partner's payout-details link \u2014
  // the OLD link stops working the moment this is sent.
  partner_link_regenerated: "<h2>Your payout link has been reset</h2>\n<p>Hi {{NAME}}, for security your Passthrough payout-details link has been reset.</p>\n<p>Your previous link no longer works. Use the new one below \u2014 it's unique to you, so don't share it.</p>\n<a href=\"{{PAYOUT_URL}}\" class=\"btn\">Open Your Payout Details \u2192</a>\n",
}

// Every var gets HTML-entity-escaped before substitution. NAME in
// particular comes straight from user registration input (max length 100,
// no character restrictions) and was previously substituted raw — a
// crafted display name like `<img src=x onerror=...>` got injected as
// live markup into every email that account subsequently received
// (welcome, verify, reset, scan results). The URL vars (FRONTEND_URL,
// VERIFY_URL, etc.) are server-constructed, not user text, but escaping
// them too is correct regardless: a literal "&" in a URL query string
// must be "&amp;" to be valid inside an href="..." attribute anyway.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/**
 * render(templateKey, vars) -> full HTML string
 * Same two-pass substitution as v8: inject the template into {{CONTENT}} inside
 * base.html, then replace every {{VAR}} placeholder (including FRONTEND_URL,
 * which callers must include in `vars` since there's no global injection point
 * equivalent to v8's email.service.js reading from a shared BASE constant scope —
 * see email.service.js, which injects it automatically exactly like the v8 patch did).
 */
// FOUND DURING SECTION 9/10 HARDENING: the multi-pass loop above (one
// `html.replace()` per variable, over the WHOLE accumulating string) already
// used a function replacer to stop $-pattern reinterpretation ($&, $$, ...) —
// but it has a second, worse hole: substituting NAME first and FRONTEND_URL
// second means the FRONTEND_URL pass re-scans text that NAME's OWN
// substitution just inserted. A display name containing the literal text
// "{{FRONTEND_URL}}" — free text, no character restrictions — gets that
// placeholder replaced a second time by a LATER loop iteration, so
// attacker-controlled input can inject template syntax that gets resolved
// against real values. Verified directly: render('welcome', { NAME:
// '{{FRONTEND_URL}}', FRONTEND_URL: 'https://real.example' }) puts the real
// URL, not the literal text, into the rendered NAME.
//
// Fixed by doing every substitution in ONE pass over the fully-assembled
// string: a single regex sweep that looks up each {{KEY}} in a pre-escaped
// map, so a value's own content is never re-scanned by another key's
// substitution, however many passes there would otherwise have been.
// Placeholders with no supplied value are left visible (not blanked), so a
// template/sender mismatch stays obvious in review.
function render(templateKey, vars) {
  const template = TEMPLATES[templateKey]
  if (!template) throw new Error(`Unknown email template: ${templateKey}`)
  const escaped = {}
  for (const [k, v] of Object.entries(vars)) escaped[k] = escapeHtml(v ?? '')
  return BASE.replace('{{CONTENT}}', () => template)
    .replace(/{{(\w+)}}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(escaped, key) ? escaped[key] : whole))
}

module.exports = { render }