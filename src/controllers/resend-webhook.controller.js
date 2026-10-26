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
// SUPPORT INBOX (support-inboxes round 1): `inbox.thread.created` — Resend Inboxes announces the FIRST email of a new
// conversation in a support inbox — mails the owner ("[Passthrough Support] …", to OWNER_ALERT_EMAIL) with who wrote, the
// subject and a link to the thread. Follow-ups inside an existing thread do not create a new thread, so they do not alert (by
// design for now). Replies that you SEND from the support address and that bounce, fail or draw a complaint also page the
// owner — otherwise a customer's answer silently never arrives. See processInboundThread / the support-reply block below.
//
// Secret: RESEND_WEBHOOK_SECRET (the `whsec_…` signing secret of the Resend webhook). Without it
// the endpoint fails closed with a 500 and a loud log; Resend retries, so nothing is lost once the
// secret is set.
const { getSupabase } = require('../config/supabase')
const { verifySvixSignature } = require('../lib/svix')
const { suppressionHashes } = require('../lib/mailbox')
const { logAdminAction } = require('../lib/adminAudit')
const { performRemoval, EMPLOYER_MAIL_TEMPLATES } = require('./employer-leads.controller')
const inbox = require('./webhooks.controller')
const { recordSuppression, flagAccountBounce } = require('../lib/emailSuppression')
const emailService = require('../services/email.service')
const { bareAddress, supportEmail, fromAddress, ownMailboxes } = require('../lib/supportEmail')
const { sha256 } = require('../lib/crypto')
const { runInBackground } = require('../lib/background')
const { hitQuota, refundQuota } = require('../middleware/rateLimiter')
const rejections = require('../lib/webhookRejections')
const { stripNul } = require('../middleware/bodyLimit')
const { readBodyCapped } = require('../lib/readBody')
// Best-effort, after the answer is decided: a refusal is stamped in the background and can never change or delay the HTTP response.
const noteRejected = (c, provider, reason) => runInBackground(c, Promise.resolve().then(() => rejections.recordRejection(c.env, provider, reason, getSupabase(c.env))))

const MAX_BODY_BYTES = 256 * 1024
const MAX_RECIPIENTS = 20
// ROUND-7 (G1/G2): these are recorded in the webhook inbox (provider 'resend'). Delivered/opened/clicked and the
// rest are acknowledged and dropped — they would only fill the table. email.failed / email.suppressed used to be
// dropped too, which hid every delivery failure of security and payment mail (those are exempt from suppression).
const RECORDED = new Set(['email.complained', 'email.bounced', 'email.failed', 'email.suppressed', 'inbox.thread.created'])

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
    if (!(await hitQuota(c.env, 'resend-health-stamp', 1, rejections.RESEND_STAMP_WINDOW_SECONDS))) return
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
function minimalResendEvent(event, env) {
  const d = event.data || {}
  // Support-inboxes round 1: a new support thread needs who wrote and what about (to build the owner's notice) and nothing
  // more — no body, no attachment names. Like every recipient-bearing payload here it is cleared once the event finishes.
  if (event.type === 'inbox.thread.created') {
    const em = d.email && typeof d.email === 'object' ? d.email : {}
    const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : undefined
    const email = {
      direction: em.direction === 'inbound' || em.direction === 'outbound' ? em.direction : undefined,
      from: str(em.from, 320), subject: str(em.subject, 300), received_at: str(em.received_at, 40),
      to: (Array.isArray(em.to) ? em.to : []).filter(x => typeof x === 'string').slice(0, MAX_RECIPIENTS).map(x => x.slice(0, 320)),
      attachments: Array.isArray(em.attachments) ? em.attachments.length : 0
    }
    return stripNul({ type: event.type, created_at: typeof event.created_at === 'string' ? event.created_at : undefined,
      data: { inbox_id: str(d.inbox_id, 64), thread_id: str(d.thread_id, 64), email_id: str(d.email_id, 64), email } })
  }
  const data = { to: (Array.isArray(d.to) ? d.to : []).filter(x => typeof x === 'string').slice(0, MAX_RECIPIENTS) }
  if (typeof d.email_id === 'string') data.email_id = d.email_id
  if (d.bounce && typeof d.bounce.type === 'string') data.bounce = { type: d.bounce.type }
  const reason = d.failed?.reason
  if (typeof reason === 'string') data.failed = { reason: reason.slice(0, 200) }
  // Support-inboxes round 1: keep the sender ONLY when it is one of our own mailboxes (not personal data) — that is how a
  // bounce of a reply sent from the support address is told apart from bounced app mail once the payload is minimal.
  const from = bareAddress(d.from)
  if (from && env && ownMailboxes(env).has(from)) data.from = from
  // Round 24 (B2): NUL / lone surrogates would make the jsonb insert fail (see webhooks.controller redactEvent).
  return stripNul({ type: event.type, created_at: typeof event.created_at === 'string' ? event.created_at : undefined, data })
}

// Does a registered account use this address? Visibility only (G2): never throws, never changes the outcome.
async function accountIdsFor(supabase, email) {
  try {
    const { data, error } = await supabase.from('users').select('id').eq('email', email)
    return error ? [] : (data || []).map(r => r.id)
  } catch (_) { return [] }
}
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

// ── Support inbox (Resend Inboxes) ────────────────────────────────────────────────────────────────────────────────
// SUPPORT-INBOXES ROUND 1 (feature gap): mail to support@ landed in a Resend Inbox that nobody was told about — the only way to
// learn a customer had written was to open the dashboard. `inbox.thread.created` fires when the FIRST email of a thread lands
// (inbound, or one you composed yourself); the owner gets one notice per new customer conversation.
//
// Guards, because the sender is a stranger and the notice goes to the owner's own inbox:
//   • only INBOUND threads (a thread you start yourself is not a customer writing);
//   • nothing from our own mailboxes (support@/hello@ writing to itself would be a loop), and nothing from obvious machines
//     (mailer-daemon, no-reply, out-of-office replies) — those threads are still in the Inbox, just not announced;
//   • at most INBOUND_SENDER_MAX notices per sender per hour and INBOUND_GLOBAL_MAX per hour overall, so a flood (or a bulk
//     send whose recipients all auto-reply) cannot bury the owner or trip Resend's own limits. The first message past the
//     global cap pages the owner ONCE, so a pause in notices is never silent.
// A failed send throws: the delivery answers 500, Svix redelivers and the hourly re-drive re-runs it. The caps are handed back
// on failure so the retry is not refused by its own earlier attempt, and the notice carries an idempotency key derived from the
// thread, so a redelivery after a send that DID succeed cannot mail the owner twice.
const INBOUND_SENDER_MAX = 3
const INBOUND_GLOBAL_MAX = 30
const INBOUND_WINDOW_SECONDS = 60 * 60
const AUTOMATED_LOCALPART = /^(mailer-daemon|postmaster|no[-_.]?reply|do[-_.]?not[-_.]?reply|bounces?)([+_.-][^@]*)?$/i
const AUTOMATED_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|auto:|out of office|undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail)/i
const cleanLine = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

// Proof of life for the support inbox (Admin → Webhooks shows it, computeWebhookHealth reads it). Best-effort, never
// allowed to affect the answer.
async function stampSupportInbox(supabase) {
  try {
    const at = new Date().toISOString()
    const { error } = await supabase.from('system_state')
      .upsert({ key: 'support_inbox', value: { last_thread_at: at }, updated_at: at }, { onConflict: 'key' })
    if (error) throw error
  } catch (err) {
    console.error('Support inbox health stamp failed:', err && err.message)
  }
}

// Link to the thread in Resend's dashboard (https://resend.com/inboxes/<inbox address>/<thread id>). Only well-formed parts
// are used; anything else falls back to the inbox, then to the list of inboxes.
function threadUrl(env, d, toAddrs) {
  const support = supportEmail(env)
  const domain = support.split('@')[1]
  const own = ownMailboxes(env)
  const inboxAddr = toAddrs.find(a => a.endsWith('@' + domain)) || toAddrs.find(a => own.has(a)) || support
  const base = `https://resend.com/inboxes/${inboxAddr}`
  return typeof d.thread_id === 'string' && /^[0-9a-f-]{8,64}$/i.test(d.thread_id) ? `${base}/${d.thread_id}` : base
}

async function processInboundThread(c, supabase, event) {
  const env = c.env
  const d = event.data || {}
  const em = d.email && typeof d.email === 'object' ? d.email : {}
  if (em.direction !== 'inbound') return { status: 'IGNORED', note: 'not an inbound thread', removed: 0 }
  await stampSupportInbox(supabase)

  const rawFrom = typeof em.from === 'string' ? em.from : ''
  const sender = bareAddress(rawFrom)
  if (sender && ownMailboxes(env).has(sender)) return { status: 'IGNORED', note: 'sent from our own mailbox', removed: 0 }
  if ((sender && AUTOMATED_LOCALPART.test(sender.split('@')[0])) || AUTOMATED_SUBJECT.test(String(em.subject || '')))
    return { status: 'IGNORED', note: 'automated message', removed: 0 }

  const senderKey = `rl:support-inbox:sender:${(await sha256(sender || rawFrom.toLowerCase())).slice(0, 32)}`
  const globalKey = 'rl:support-inbox:all'
  if (!(await hitQuota(env, senderKey, INBOUND_SENDER_MAX, INBOUND_WINDOW_SECONDS)))
    return { status: 'IGNORED', note: 'per-sender notice limit (the thread is in the Inbox)', removed: 0 }
  if (!(await hitQuota(env, globalKey, INBOUND_GLOBAL_MAX, INBOUND_WINDOW_SECONDS))) {
    await refundQuota(env, senderKey, INBOUND_WINDOW_SECONDS, 1)
    await alertOnce(c, 'support-inbox-flood', 'Support inbox: new-thread notices paused',
      `More than ${INBOUND_GLOBAL_MAX} new conversations reached the support inbox within an hour, so notices for further ones are paused until the hour is up. ` +
      `The threads are all in the Resend Inbox (resend.com/inboxes) — check it directly. A burst like this is usually auto-replies to a bulk send or someone flooding the address.`)
    return { status: 'IGNORED', note: 'global notice limit (the thread is in the Inbox)', removed: 0 }
  }

  const toAddrs = (Array.isArray(em.to) ? em.to : []).map(bareAddress).filter(Boolean)
  const subject = cleanLine(em.subject, 200) || '(no subject)'
  const attachments = Number.isFinite(em.attachments) ? em.attachments : (Array.isArray(em.attachments) ? em.attachments.length : 0)
  const message = [
    'A customer started a new conversation in the support inbox.',
    '',
    `From:        ${cleanLine(rawFrom, 320) || '(unknown sender)'}`,
    `To:          ${toAddrs.join(', ') || '(unknown)'}`,
    `Subject:     ${subject}`,
    `Received:    ${cleanLine(em.received_at, 40) || '(unknown)'}`,
    `Attachments: ${attachments}`,
    '',
    'Open the thread and reply from the Inbox:',
    threadUrl(env, d, toAddrs),
    '',
    'All inboxes: https://resend.com/inboxes'
  ].join('\n')

  let sent
  try {
    sent = await emailService.sendSupportInboxNotice(env, subject, message, {
      idempotencyKey: d.thread_id || d.email_id ? `support-thread/${cleanLine(d.thread_id || d.email_id, 80)}` : undefined
    })
  } catch (err) {
    await refundQuota(env, senderKey, INBOUND_WINDOW_SECONDS, 1)
    await refundQuota(env, globalKey, INBOUND_WINDOW_SECONDS, 1)
    throw err
  }
  if (!sent) {
    console.error('[CRITICAL] A customer wrote to the support inbox but OWNER_ALERT_EMAIL is not set — nobody was notified')
    return { status: 'PROCESSED', note: 'OWNER_ALERT_EMAIL not set — owner NOT notified', removed: 0 }
  }
  return { status: 'PROCESSED', note: 'new thread — owner notified', removed: 0 }
}

// Runs one recorded event. Returns { status, note, removed }; THROWS on a database failure so the delivery
// answers 500 and Svix retries (every step is safe to repeat).
async function processResendEvent(c, supabase, event) {
  const type = event && event.type
  if (type === 'inbox.thread.created') return processInboundThread(c, supabase, event)
  const d = event?.data || {}
  const recipients = [...new Set((Array.isArray(d.to) ? d.to : []).slice(0, MAX_RECIPIENTS).map(normalizeRecipient).filter(Boolean))]
  const complaint = type === 'email.complained'
  const permanentBounce = type === 'email.bounced' && isPermanentBounce(d)

  // SUPPORT-INBOXES ROUND 1: a reply you sent FROM the support address (typed in the Resend Inbox) that bounces, fails or draws a
  // complaint never reaches the customer — and nothing tells you, because only account and employer-lead addresses were ever
  // reported. App mail is sent from EMAIL_FROM and keeps its own handling below; this is only for the support address. The
  // alert names the Resend email id, not the recipient (alert_logs keeps no customer addresses); the dashboard has the rest.
  const supportAddr = supportEmail(c.env)
  if (supportAddr !== fromAddress(c.env) && bareAddress(d.from) === supportAddr
      && (complaint || permanentBounce || type === 'email.failed' || type === 'email.suppressed')) {
    await alertOnce(c, `support-reply-undeliverable:${typeof d.email_id === 'string' ? d.email_id.slice(0, 64) : type}`,
      'A reply sent from the support address was not delivered',
      `A message sent from ${supportAddr} (Resend email id: ${typeof d.email_id === 'string' ? d.email_id : 'unknown'}) triggered ${type}` +
      `${isPermanentBounce(d) ? ' (permanent bounce)' : ''}. The customer most likely did NOT receive it. ` +
      `Open it in the Resend dashboard (Emails) to see the recipient and the reason, then contact them another way.`)
  }

  // G2: an address that cannot be reached is worth knowing about when it belongs to an ACCOUNT — verification,
  // reset, sign-in and receipt mail still goes out to it (suppression exempts them) and will keep failing.
  // Round 14 (G1): the accounts are now NAMED — their ids go in the alert and the inbox note (ids are not personal data; the
  // payload with the address is cleared once the event finishes, so this is the only trace of "which account"), the user row is
  // flagged (users.email_bounced_at, migration 0086) so the SPA can tell the person and Admin → Users can list them.
  // `email.failed` is a send failure, not a verdict on the address, so it names the accounts but does not flag them.
  const accountIds = []
  if (complaint || permanentBounce || type === 'email.failed' || type === 'email.suppressed') {
    const flagType = complaint ? 'complaint' : permanentBounce ? 'bounce' : type === 'email.suppressed' ? 'suppressed' : null
    for (const email of recipients) {
      if (flagType) accountIds.push(...await flagAccountBounce(supabase, email, flagType))
      else if (await accountUsesAddress(supabase, email)) accountIds.push(...await accountIdsFor(supabase, email))
    }
  }
  const accounts = accountIds.length
  const accountNote = accounts ? ` — ${accounts} account(s): ${accountIds.slice(0, 5).join(', ')}${accounts > 5 ? ', …' : ''}` : ''
  if (accounts > 0)
    await alertOnce(c, 'resend-account-undeliverable', 'Mail to a registered account address is not being delivered',
      `${accounts} registered account(s) are affected by a ${type} event: ${accountIds.slice(0, 10).join(', ')}${accounts > 10 ? ', …' : ''}.\n` +
      `Security and payment mail (verification, password reset, receipts) is still sent to them and will fail or be refused. ` +
      `Their dashboard now shows a "we can't reach your email" notice and Admin → Users tags them. Further events in the next 30 minutes are logged but not emailed.`)

  if (type === 'email.failed' || type === 'email.suppressed') {
    await alertOnce(c, `resend-${type}`, `Resend ${type}`,
      `Resend reported ${type} for ${recipients.length} recipient(s)${d.failed?.reason ? `: ${String(d.failed.reason).slice(0, 200)}` : ''}.\n` +
      `If this keeps happening, check the sending domain and the Resend dashboard. Further events in the next 30 minutes are logged but not emailed.`)
    return { status: 'PROCESSED', note: `${type} — alerted${accountNote}`, removed: 0 }
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
    if (!(await recordSuppression(supabase, email, complaint ? 'complaint' : 'bounce', c.env))) suppressionFailed = true

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
    await performRemoval(supabase, email, { env: c.env, reason: complaint ? 'complaint' : 'bounce' })
    removed++
    // Hash, not the address — same convention as the admin suppression entries.
    await logAdminAction(c, supabase, 'lead.auto_suppressed', 'employer_lead_suppression', (await suppressionHashes(c.env, email)).write[0], {
      reason: complaint ? 'spam_complaint' : 'hard_bounce', source: 'resend'
    })
  }
  if (suppressionFailed) throw new Error('email suppression write failed')
  return { status: 'PROCESSED', note: `${removed ? `suppressed; ${removed} lead(s) removed` : 'suppressed'}${accountNote}`, removed }
}

async function handleResend(c) {
  const secret = c.env.RESEND_WEBHOOK_SECRET
  if (!secret) {
    console.error('[CRITICAL] RESEND_WEBHOOK_SECRET is not configured — Resend bounce/complaint events cannot be verified or acted on')
    await alertOnce(c, 'resend-secret-missing', 'Resend webhook cannot verify signatures — secret not configured',
      'RESEND_WEBHOOK_SECRET is missing from this Worker. Every Resend bounce / spam-complaint event is being rejected with 500, ' +
      'so complaining and permanently-bounced addresses are NOT being suppressed. Resend retries for a limited time only. ' +
      'Set it: wrangler secret put RESEND_WEBHOOK_SECRET (the whsec_… signing secret of the Resend webhook).')
    noteRejected(c, 'resend', 'not-configured')
    return c.text('Webhook not configured', 500)
  }

  const declared = Number.parseInt(c.req.header('content-length') || '', 10)
  const tooLarge = () => { noteRejected(c, 'resend', 'too-large'); return c.text('Payload too large', 413) }
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge()
  // ROUND-7 (B6): raw bytes, like the Paystack handler — the size cap is in bytes and the signature is checked over
  // exactly what was sent (text() strips a leading BOM and repairs invalid UTF-8, then the HMAC no longer matches).
  const bodyBytes = await readBodyCapped(c, MAX_BODY_BYTES)   // streamed with a cap (round 19, B3)
  if (!bodyBytes) return tooLarge()

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
    noteRejected(c, 'resend', rejections.looksLikeSvixDelivery({ id: c.req.header('svix-id'), timestamp: c.req.header('svix-timestamp'), signature: c.req.header('svix-signature') }) ? 'signature' : 'unsigned')
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
    row = await inbox.recordEvent(supabase, { provider: 'resend', eventKey: svixId, eventType: event.type, reference: null, payload: minimalResendEvent(event, c.env) })
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
        (event.type === 'inbox.thread.created'
          ? `Until it succeeds you are NOT told about this new support conversation — it is still in the Resend Inbox (resend.com/inboxes).`
          : `Until it succeeds the address is not suppressed.`))
    throw err
  }
  // B1 (round 8): clear the recipient-bearing payload only once the status write has landed. If it was lost,
  // the row stays RECEIVED WITH its payload, so the hourly re-drive re-runs it (idempotent) instead of
  // leaving a payload-less RECEIVED row that nothing can re-run, close or prune.
  const marked = await inbox.markEvent(supabase, row, outcome.status, outcome.note)
  if (marked) await clearResendPayload(supabase, row.id)
  return c.json({ success: true, removed: outcome.removed })
}

module.exports = { handleResend, processResendEvent, processInboundThread, clearResendPayload, minimalResendEvent, normalizeRecipient }
