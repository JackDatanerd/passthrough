// Replaces the 9 .html files under backend/templates/emails/. Workers bundle
// JS at build time — there's no fs.readFileSync for arbitrary files at runtime
// without extra build tooling, so each template becomes a JS string constant
// instead of a file on disk. Content is byte-for-byte identical to the v8 spec
// (including the $39 credential pricing and 'credential' copy from the last
// product update — nothing here is a content change, only the loading mechanism).

const BASE = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <style>\n    body { margin:0; padding:0; background:#f4f4f5; font-family: sans-serif; }\n    .wrapper { max-width:600px; margin:32px auto; background:#ffffff;\n               border-radius:8px; overflow:hidden; }\n    .header  { background:#1E40AF; padding:24px 32px; }\n    .header a { color:#ffffff; font-size:20px; font-weight:700; text-decoration:none; }\n    .body    { padding:32px; color:#1f2937; font-size:15px; line-height:1.6; }\n    .footer  { padding:20px 32px; background:#f9fafb; color:#9ca3af;\n               font-size:12px; text-align:center; }\n    .btn     { display:inline-block; background:#1E40AF; color:#ffffff;\n               padding:12px 24px; border-radius:6px; text-decoration:none;\n               font-weight:600; margin:16px 0; }\n  </style>\n</head>\n<body>\n  <div class=\"wrapper\">\n    <div class=\"header\"><a href=\"{{FRONTEND_URL}}\">Passthrough</a></div>\n    <div class=\"body\">{{CONTENT}}</div>\n    <div class=\"footer\">passthrough.dev \u2014 ATS Resume Scanner</div>\n  </div>\n</body>\n</html>\n"

const TEMPLATES = {
  welcome: "<h2>Welcome, {{NAME}}!</h2>\n<p>Your Passthrough account is ready.</p>\n<p>Scan any resume against any job description and find out exactly why\nit's being rejected \u2014 before a recruiter ever sees it.</p>\n<p>Check your inbox for a verification email to unlock file downloads.</p>\n<a href=\"https://passthrough.dev\" class=\"btn\">Start Scanning \u2192</a>\n",
  email_verification: "<h2>Verify your email</h2>\n<p>Hi {{NAME}}, click below to verify your Passthrough email address.</p>\n<p>You need to verify your email before you can download fixed resumes.</p>\n<a href=\"{{VERIFY_URL}}\" class=\"btn\">Verify Email \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link expires in 1 hour.\nIf you didn't create a Passthrough account, ignore this email.</p>\n",
  password_reset: "<h2>Reset your password</h2>\n<p>Hi {{NAME}}, click below to reset your Passthrough password.</p>\n<a href=\"{{RESET_URL}}\" class=\"btn\">Reset Password \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link expires in 1 hour.\nIf you didn't request a reset, ignore this email.</p>\n",
  scan_fail: "<h2>Your resume scored {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume scored {{SCORE}}/100 against the ATS filter.</p>\n<p>Resumes below 75 are typically discarded before a recruiter opens the file.</p>\n<table style=\"width:100%;border-collapse:collapse;margin:16px 0\">\n  <tr><td style=\"padding:8px 0;color:#374151\">Keyword Match</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{KEYWORD_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Formatting</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{FORMAT_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Resume Sections</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{SECTIONS_SCORE}}/100</td></tr>\n  <tr><td style=\"padding:8px 0;color:#374151\">Content Quality</td>\n      <td style=\"padding:8px 0;text-align:right;font-weight:600;color:#dc2626\">{{CONTENT_SCORE}}/100</td></tr>\n</table>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Fix My Resume \u2014 $49 \u2192</a>\n",
  scan_pass_standard: "<h2>Your resume passed \u2014 {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume passed ATS screening with a score of {{SCORE}}/100.</p>\n<p>Your score is just below our Verified threshold (80+). A full fix and rewrite\ncan get you there \u2014 and includes the Passthrough Verified credential.</p>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Polish to Get Verified \u2014 $49 \u2192</a>\n",
  scan_pass_badge: "<h2>\u2713 Your resume passed \u2014 {{SCORE}}/100</h2>\n<p>Hi {{NAME}}, your resume scored {{SCORE}}/100 and is Verified-eligible.</p>\n<p>You can get the Passthrough Verified credential \u2014 an employer-checkable\nverification that confirms your resume passed ATS screening.</p>\n<a href=\"{{SCAN_URL}}\" class=\"btn\">Get Verified \u2014 $39 \u2192</a>\n<p>Or for a full AI polish and rewrite: <a href=\"{{SCAN_URL}}\">Full Package \u2014 $49</a></p>\n",
  fix_delivered: "<h2>\u2713 Your Passthrough Verified resume is ready</h2>\n<p>Hi {{NAME}}, your fixed resume is ready to download from your dashboard.</p>\n<a href=\"{{DOWNLOAD_URL}}\" class=\"btn\">Download Your Files \u2192</a>\n<p><strong>How to use your two files:</strong></p>\n<p>\ud83d\udcc4 <strong>.docx file</strong> \u2192 Upload to job portals, company websites,\nand any online application form.</p>\n<p>\ud83c\udfa8 <strong>PDF file</strong> \u2192 Email hiring managers directly,\nshare with recruiters, use on your portfolio.</p>\n<p><strong>Your Passthrough Verified credential:</strong><br>\nYour verification URL: <a href=\"{{VERIFICATION_URL}}\">{{VERIFICATION_URL}}</a></p>\n<p>Add this to your cover letters:<br>\n<em>\"My resume has been Passthrough Verified. Verify: {{VERIFICATION_URL}}\"</em></p>\n",
  fix_delivered_plain: "<h2>\u2713 Your fixed resume is ready</h2>\n<p>Hi {{NAME}}, your rewritten resume is ready to download from your dashboard.</p>\n<a href=\"{{DOWNLOAD_URL}}\" class=\"btn\">Download Your Files \u2192</a>\n<p><strong>How to use your two files:</strong></p>\n<p>\ud83d\udcc4 <strong>.docx file</strong> \u2192 Upload to job portals, company websites,\nand any online application form.</p>\n<p>\ud83c\udfa8 <strong>PDF file</strong> \u2192 Email hiring managers directly,\nshare with recruiters, use on your portfolio.</p>\n",
  fix_failed: "<h2>We hit a snag</h2>\n<p>Hi {{NAME}}, something went wrong generating your resume.</p>\n<p><strong>You have not been charged again.</strong> We're looking into it\nand will email you when your resume is ready.</p>\n<p>If you need help, email us at support@passthrough.dev</p>\n",
  partner_payout_details_request: "<h2>Set up your payout details</h2>\n<p>Hi {{NAME}}, welcome to the Passthrough partner program.</p>\n<p>Click below to tell us where to send your payouts \u2014 bank account or\nmobile money, whichever you prefer.</p>\n<a href=\"{{PAYOUT_URL}}\" class=\"btn\">Add Payout Details \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">This link is unique to you \u2014 don't share it. You can come back and\nupdate these details anytime.</p>\n",
  payout_sent: "<h2>Payout sent \u2713</h2>\n<p>Hi {{NAME}}, we've sent you a payout of {{AMOUNT}}.</p>\n<p>It should reflect in your account shortly, depending on your bank or\nmobile money provider's processing time.</p>\n<p>Thanks for partnering with Passthrough.</p>\n",
  referral_code_created: "<h2>Your referral code is live</h2>\n<p>Hi {{NAME}}, your Passthrough referral code is ready to share:</p>\n<p style=\"font-size:28px;font-weight:700;letter-spacing:1px;color:#1E40AF\">{{CODE}}</p>\n<p>Anyone who uses it gets a discounted price, and you earn a commission on\nevery sale it brings in.</p>\n<a href=\"{{DASHBOARD_URL}}\" class=\"btn\">View Your Dashboard \u2192</a>\n<p style=\"color:#9ca3af;font-size:13px\">Your dashboard shows clicks, conversions, and earnings for every code\nyou have \u2014 bookmark the link above.</p>\n",
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
function render(templateKey, vars) {
  const template = TEMPLATES[templateKey]
  if (!template) throw new Error(`Unknown email template: ${templateKey}`)
  let html = BASE.replace('{{CONTENT}}', template)
  for (const [k, v] of Object.entries(vars)) {
    // Replacer must be a FUNCTION, not a string. String.replace() treats a
    // string replacement as a pattern — $&, $`, $', $$, $1-$9 all have special
    // meaning — so a user-controlled value (NAME, free text, no character
    // restrictions) containing a literal "$" could corrupt the surrounding
    // HTML or leak the raw {{PLACEHOLDER}} back into the output. A function
    // return value is always inserted literally, sidestepping this entirely.
    const escaped = escapeHtml(v || '')
    html = html.replace(new RegExp(`{{${k}}}`, 'g'), () => escaped)
  }
  return html
}

module.exports = { render }