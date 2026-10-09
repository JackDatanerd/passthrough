// POST /api/webhooks/resend — Resend's delivery events, signed with Svix.
//
// FEATURE GAP CLOSED (independent audit round 9, Section 5): nothing fed delivery failures back
// into the employer do-not-contact list. The acknowledgement goes to whatever a stranger typed
// into a public form, from the same sending domain as password resets, so:
//   • a person who marks it as SPAM instead of clicking Remove stayed on the list and kept being
//     mailed (candidate-available emails, resubmission acknowledgements) — the one failure an
//     opt-out list exists to prevent, and a direct hit on the domain's sender reputation;
//   • a PERMANENTLY bounced address kept being retried by every resubmission and notify run.
//
// A complaint always suppresses the address (hash recorded, lead row deleted, employer mail history
// cleared — exactly what clicking Remove does, via the same performRemoval). A permanent bounce
// does the same only when the address is currently a lead: a dead mailbox is useless to us, but
// the suppression list should not fill up with every candidate's mistyped address. Transient
// bounces and every other event type are acknowledged and ignored.
//
// Secret: RESEND_WEBHOOK_SECRET (the `whsec_…` signing secret of the Resend webhook). Without it
// the endpoint fails closed with a 500 and a loud log; Resend retries, so nothing is lost once the
// secret is set.
const { getSupabase } = require('../config/supabase')
const { verifySvixSignature } = require('../lib/svix')
const { sha256 } = require('../lib/crypto')
const { logAdminAction } = require('../lib/adminAudit')
const { performRemoval } = require('./employer-leads.controller')
const { recordSuppression } = require('../lib/emailSuppression')
const emailService = require('../services/email.service')
const { runInBackground } = require('../lib/background')
const { hitQuota } = require('../middleware/rateLimiter')

const MAX_BODY_BYTES = 256 * 1024
const MAX_RECIPIENTS = 20
const ACTIONABLE = new Set(['email.complained', 'email.bounced'])

// "Dana Whitfield <dana@acme.com>" or "dana@acme.com" → "dana@acme.com" (lowercased), else null.
function normalizeRecipient(raw) {
  if (typeof raw !== 'string') return null
  const angled = raw.match(/<([^<>]+)>\s*$/)
  const addr = (angled ? angled[1] : raw).trim().toLowerCase()
  return addr.length <= 254 && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(addr) ? addr : null
}

// WEBHOOKS ROUND 5 (G1, feature gap): the Paystack webhook pages the owner when its secret is missing or a
// signature fails; this one only wrote a console line. A missing or rotated RESEND_WEBHOOK_SECRET therefore
// meant spam complaints and hard bounces were silently NOT suppressed — the exact thing this endpoint exists
// to prevent, on the domain that also sends password resets — and nobody learned of it unless they happened
// to be running `wrangler tail`. Same shape as handlePaystack: at most one email per 30 minutes per condition
// (every occurrence is still logged), sent after the response, and never allowed to affect the answer.
const ALERT_COOLDOWN_SECONDS = 30 * 60
async function alertOnce(c, key, subject, message) {
  try {
    if (!(await hitQuota(c.env, `webhook-alert-cooldown:${key}`, 1, ALERT_COOLDOWN_SECONDS))) return
    runInBackground(c, emailService.sendOwnerAlert(c.env, subject, message))
  } catch (err) {
    console.error('Resend webhook alert failed:', err && err.message)
  }
}

// ROUND-6 (G2): proof of life. The alerts above only fire when requests ARRIVE; an endpoint that was never
// registered in Resend, was paused, or points at the wrong URL says nothing, and spam complaints are what is
// lost. Any VERIFIED event stamps system_state (no migration: the table exists), at most once per 10 minutes
// through the same atomic quota the alerts use. Admin → Webhooks shows it (computeWebhookHealth).
// Best-effort: never allowed to affect the answer.
async function stampResendEvent(c, supabase, type) {
  try {
    if (!(await hitQuota(c.env, 'resend-health-stamp', 1, 10 * 60))) return
    const at = new Date().toISOString()
    const { error } = await supabase.from('system_state')
      .upsert({ key: 'resend_webhook', value: { last_event_at: at, last_event_type: type }, updated_at: at }, { onConflict: 'key' })
    if (error) throw error
  } catch (err) {
    console.error('Resend health stamp failed:', err && err.message)
  }
}

const isPermanentBounce = (data) => String(data?.bounce?.type || '').toLowerCase() === 'permanent'

async function handleResend(c) {
  const secret = c.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    console.error('[CRITICAL] RESEND_WEBHOOK_SECRET is not configured — Resend bounce/complaint events cannot be verified or acted on')
    await alertOnce(c, 'resend-secret-missing', 'Resend webhook cannot verify signatures — secret not configured',
      'RESEND_WEBHOOK_SECRET is missing from this Worker. Every Resend bounce / spam-complaint event is being rejected with 500, ' +
      'so complaining and permanently-bounced addresses are NOT being suppressed. Resend retries for a limited time only. ' +
      'Set it: wrangler secret put RESEND_WEBHOOK_SECRET (the whsec_… signing secret of the Resend webhook).')
    return c.text('Webhook not configured', 500)
  }

  const declared = Number.parseInt(c.req.header('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.text('Payload too large', 413)
  const body = await c.req.text()
  if (body.length > MAX_BODY_BYTES) return c.text('Payload too large', 413)

  const valid = await verifySvixSignature({
    secret, body,
    id: c.req.header('svix-id'),
    timestamp: c.req.header('svix-timestamp'),
    signature: c.req.header('svix-signature')
  })
  if (!valid) {
    console.error('Resend webhook signature verification failed')
    await alertOnce(c, 'resend-sig-mismatch', 'Resend webhook signature verification failed',
      `A request to /api/webhooks/resend failed Svix signature verification.\nsource IP: ${c.req.header('cf-connecting-ip') || '(unknown)'}\n\n` +
      `Either RESEND_WEBHOOK_SECRET is wrong or was rotated in Resend (real complaints and bounces are then NOT being suppressed until it is fixed) ` +
      `or someone is probing the endpoint. Further failures in the next 30 minutes are logged but not emailed.`)
    return c.text('Invalid signature', 401)
  }

  let event
  try { event = JSON.parse(body) } catch (_) { return c.text('OK', 200) }   // signed but not JSON: nothing to do or retry
  if (event && typeof event.type === 'string') await stampResendEvent(c, getSupabase(c.env), event.type)
  if (!event || !ACTIONABLE.has(event.type)) return c.text('OK', 200)

  const complaint = event.type === 'email.complained'
  if (!complaint && !isPermanentBounce(event.data)) return c.text('OK', 200)

  const recipients = [...new Set((Array.isArray(event.data?.to) ? event.data.to : []).slice(0, MAX_RECIPIENTS).map(normalizeRecipient).filter(Boolean))]
  if (!recipients.length) return c.text('OK', 200)

  const supabase = getSupabase(c.env)
  let removed = 0
  for (const email of recipients) {
    // GAP CLOSED (cross-cutting infra round 1, G4): every address that complains or permanently
    // bounces is remembered (hash only), whoever it belongs to — a candidate's typo'd address or a
    // user who reported a welcome email as spam — so send() stops mailing it anything non-security.
    // Best-effort and never throws: the employer-lead handling below must run regardless.
    await recordSuppression(supabase, email, complaint ? 'complaint' : 'bounce')
    if (!complaint) {
      const { data: lead, error } = await supabase.from('employer_leads').select('id').eq('email', email).maybeSingle()
      if (error) throw error      // 5xx → Resend redelivers; every step below is safe to repeat
      if (!lead) continue
    }
    await performRemoval(supabase, email)
    removed++
    // Hash, not the address — same convention as the admin suppression entries.
    await logAdminAction(c, supabase, 'lead.auto_suppressed', 'employer_lead_suppression', await sha256(email), {
      reason: complaint ? 'spam_complaint' : 'hard_bounce', source: 'resend'
    })
  }
  return c.json({ success: true, removed })
}

module.exports = { handleResend, normalizeRecipient }
