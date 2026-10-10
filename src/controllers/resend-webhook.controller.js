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
const { performRemoval, EMPLOYER_MAIL_TEMPLATES } = require('./employer-leads.controller')
const inbox = require('./webhooks.controller')
const { recordSuppression } = require('../lib/emailSuppression')
const emailService = require('../services/email.service')
const { runInBackground } = require('../lib/background')
const { hitQuota } = require('../middleware/rateLimiter')

const MAX_BODY_BYTES = 256 * 1024
const MAX_RECIPIENTS = 20
// ROUND-7 (G1/G2): these are recorded in the webhook inbox (provider 'resend'). Delivered/opened/clicked and the
// rest are acknowledged and dropped — they would only fill the table. email.failed / email.suppressed used to be
// dropped too, which hid every delivery failure of security and payment mail (those are exempt from suppression).
const RECORDED = new Set(['email.complained', 'email.bounced', 'email.failed', 'email.suppressed'])

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

// What the inbox keeps of a Resend event: enough to re-run it (type, recipients, bounce type) and nothing else —
// not the subject, sender, tags or body.
function minimalResendEvent(event) {
  const d = event.data || {}
  const data = { to: (Array.isArray(d.to) ? d.to : []).filter(x => typeof x === 'string').slice(0, MAX_RECIPIENTS) }
  if (typeof d.email_id === 'string') data.email_id = d.email_id
  if (d.bounce && typeof d.bounce.type === 'string') data.bounce = { type: d.bounce.type }
  const reason = d.failed?.reason
  if (typeof reason === 'string') data.failed = { reason: reason.slice(0, 200) }
  return { type: event.type, created_at: typeof event.created_at === 'string' ? event.created_at : undefined, data }
}

// Does a registered account use this address? Visibility only (G2): never throws, never changes the outcome.
async function accountUsesAddress(supabase, email) {
  try {
    const { data, error } = await supabase.from('users').select('id').eq('email', email).maybeSingle()
    return !error && !!data
  } catch (_) { return false }
}

// The payload holds recipient addresses, and this codebase keeps only hashes of them (see recordSuppression). It is
// needed ONLY while an event is unfinished (to retry it), so once it completes it is cleared. Best effort: a failure
// here leaves the row to the normal 90-day prune, never changes the outcome.
async function clearResendPayload(supabase, id) {
  if (!id) return
  try {
    const { error } = await supabase.from('webhook_events').update({ payload: null }).eq('id', id)
    if (error) console.error('Resend webhook_events payload clear failed:', error.message)
  } catch (err) { console.error('Resend webhook_events payload clear failed:', err.message) }
}

// Runs one recorded event. Returns { status, note, removed }; THROWS on a database failure so the delivery
// answers 500 and Svix retries (every step is safe to repeat).
async function processResendEvent(c, supabase, event) {
  const type = event && event.type
  const d = event?.data || {}
  const recipients = [...new Set((Array.isArray(d.to) ? d.to : []).slice(0, MAX_RECIPIENTS).map(normalizeRecipient).filter(Boolean))]
  const complaint = type === 'email.complained'
  const permanentBounce = type === 'email.bounced' && isPermanentBounce(d)

  // G2: an address that cannot be reached is worth knowing about when it belongs to an ACCOUNT — verification,
  // reset, sign-in and receipt mail still goes out to it (suppression exempts them) and will keep failing.
  let accounts = 0
  if (complaint || permanentBounce || type === 'email.failed' || type === 'email.suppressed')
    for (const email of recipients) if (await accountUsesAddress(supabase, email)) accounts++
  if (accounts > 0)
    await alertOnce(c, 'resend-account-undeliverable', 'Mail to a registered account address is not being delivered',
      `${accounts} recipient(s) of a ${type} event belong to registered accounts. Security and payment mail (verification, password reset, receipts) is still ` +
      `sent to them and will fail or be refused. See Admin → Webhooks (provider: resend) for the event. Further events in the next 30 minutes are logged but not emailed.`)

  if (type === 'email.failed' || type === 'email.suppressed') {
    await alertOnce(c, `resend-${type}`, `Resend ${type}`,
      `Resend reported ${type} for ${recipients.length} recipient(s)${d.failed?.reason ? `: ${String(d.failed.reason).slice(0, 200)}` : ''}.\n` +
      `If this keeps happening, check the sending domain and the Resend dashboard. Further events in the next 30 minutes are logged but not emailed.`)
    return { status: 'PROCESSED', note: `${type} — alerted`, removed: 0 }
  }
  if (!complaint && !permanentBounce) return { status: 'IGNORED', note: type === 'email.bounced' ? 'transient bounce' : String(type), removed: 0 }
  if (!recipients.length) return { status: 'IGNORED', note: 'no usable recipient', removed: 0 }

  let removed = 0
  let suppressionFailed = false
  for (const email of recipients) {
    // GAP CLOSED (cross-cutting infra round 1, G4): every address that complains or permanently
    // bounces is remembered (hash only), whoever it belongs to — a candidate's typo'd address or a
    // user who reported a welcome email as spam — so send() stops mailing it anything non-security.
    //
    // ROUND-7 (B1): recordSuppression never throws and answers false on failure — that was ignored, so a database
    // blip (or migration 0059 missing) answered 200 and the address kept being mailed with nothing to retry it.
    // The employer handling below still runs when it fails (it is what an opt-out is owed, and it must not wait on
    // a missing table); the failure is raised after the loop so the delivery is retried.
    if (!(await recordSuppression(supabase, email, complaint ? 'complaint' : 'bounce'))) suppressionFailed = true

    // ROUND-7 (B5): the employer do-not-contact removal (lead row, employer mail history, lead suppression hash,
    // 'lead.auto_suppressed' audit entry) is for addresses that ARE an employer lead — or, for a complaint, ones we
    // sent employer mail to (the lead may already be gone). It used to run for every complaint, so an ordinary
    // account holder who reported a welcome email also got blocked from the employer-lead form and logged as a lead.
    const { data: lead, error } = await supabase.from('employer_leads').select('id').eq('email', email).maybeSingle()
    if (error) throw error      // 5xx → Resend redelivers; every step below is safe to repeat
    let employer = !!lead
    if (!employer && complaint) {
      const { data: logs, error: logErr } = await supabase.from('email_logs').select('template')
        .eq('to', email).in('template', EMPLOYER_MAIL_TEMPLATES).limit(1)
      if (logErr) throw logErr
      employer = !!(logs && logs.length)
    }
    if (!employer) continue
    await performRemoval(supabase, email)
    removed++
    // Hash, not the address — same convention as the admin suppression entries.
    await logAdminAction(c, supabase, 'lead.auto_suppressed', 'employer_lead_suppression', await sha256(email), {
      reason: complaint ? 'spam_complaint' : 'hard_bounce', source: 'resend'
    })
  }
  if (suppressionFailed) throw new Error('email suppression write failed')
  return { status: 'PROCESSED', note: removed ? `suppressed; ${removed} lead(s) removed` : 'suppressed', removed }
}

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
  // ROUND-7 (B6): raw bytes, like the Paystack handler — the size cap is in bytes and the signature is checked over
  // exactly what was sent (text() strips a leading BOM and repairs invalid UTF-8, then the HMAC no longer matches).
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer())
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return c.text('Payload too large', 413)

  const valid = await verifySvixSignature({
    secret, body: bodyBytes,
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
  try { event = JSON.parse(new TextDecoder().decode(bodyBytes)) } catch (_) { return c.text('OK', 200) }   // signed but not JSON: nothing to do or retry
  const supabase = getSupabase(c.env)
  if (event && typeof event.type === 'string') await stampResendEvent(c, supabase, event.type)
  if (!event || !RECORDED.has(event.type)) return c.text('OK', 200)

  // ROUND-7 (G1): durable inbox, deduped on Svix's message id (stable across its retries).
  const svixId = c.req.header('svix-id')
  let row
  try {
    row = await inbox.recordEvent(supabase, { provider: 'resend', eventKey: svixId, eventType: event.type, reference: null, payload: minimalResendEvent(event) })
  } catch (err) {
    console.error('Resend webhook_events insert failed:', err.message)
    await alertOnce(c, 'resend-inbox-write-failed', 'Resend webhook could not be recorded — Resend will retry',
      `event: ${event.type}\nerror: ${err.message}\n\nThe webhook_events insert failed, so the event was NOT processed and was answered 500; Resend redelivers for a limited time. ` +
      `Complaints and hard bounces are not suppressed until this works. Check the database (migration drift, an outage).`)
    return c.text('Temporary error', 500)
  }
  if (row.mode === 'done') return c.text('OK', 200)

  let outcome
  try {
    outcome = await processResendEvent(c, supabase, event)
  } catch (err) {
    console.error(`[CRITICAL] Resend ${event.type} failed:`, err.message)
    await inbox.markEvent(supabase, row, 'FAILED', err.message)
    if (!row.attempts || row.attempts <= 1)
      await alertOnce(c, 'resend-processing-failed', 'Resend webhook processing failed — Resend will retry',
        `event: ${event.type}\nerror: ${err.message}\n\nAnswered 500, so Resend redelivers and the hourly re-drive also re-runs it (Admin → Webhooks, provider: resend). ` +
        `Until it succeeds the address is not suppressed.`)
    throw err
  }
  // B1 (round 8): clear the recipient-bearing payload only once the status write has landed. If it was lost,
  // the row stays RECEIVED WITH its payload, so the hourly re-drive re-runs it (idempotent) instead of
  // leaving a payload-less RECEIVED row that nothing can re-run, close or prune.
  const marked = await inbox.markEvent(supabase, row, outcome.status, outcome.note)
  if (marked) await clearResendPayload(supabase, row.id)
  return c.json({ success: true, removed: outcome.removed })
}

module.exports = { handleResend, processResendEvent, clearResendPayload, minimalResendEvent, normalizeRecipient }
