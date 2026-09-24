// POST /api/webhooks/paystack
//
// Section 8 (Webhooks) audit — what changed and why, in one place:
//
//  1. PROCESS BEFORE ACKNOWLEDGING. This handler used to answer 200 first and do
//     the work in waitUntil. Paystack treats any non-200 as a failed delivery and
//     retries it; a 200 means "done, never call again". So a transient Supabase
//     error on the payment lookup/flip was logged and dropped: the buyer paid,
//     the row stayed PENDING, Paystack never retried, nobody was alerted, and
//     the hourly sweep only looks at SUCCESS rows. The work here is a handful of
//     DB calls plus a queue send (the slow generation is already queued), so it
//     now runs inline and a transient failure returns 500 — Paystack's own retry
//     schedule becomes the first line of recovery. Only owner alerts go to
//     waitUntil.
//
//  2. DURABLE INBOX (webhook_events, migration 0025). Every verified event is
//     recorded before it is processed: an audit trail, dedupe on Paystack's own
//     event id, and a FAILED status that makes a redelivery re-run the work
//     instead of being skipped as "already seen".
//
//  3. REFUNDS AND DISPUTES ARE ACTIONED, not just emailed (see fulfillment
//     .service reversePayment): payment → REFUNDED, partner commission reversed
//     with a negative ledger row, public credential revoked. Disputes are marked
//     DISPUTED and paged; the irreversible steps wait for a human (admin
//     Payments → Reverse). Paystack's dispute/refund payloads don't carry the
//     original reference where charge.success does — see referenceCandidates.
//
//  4. NO metadata.scanId GATE. The old guard silently discarded any signed
//     charge.success whose metadata lacked scanId, even though the payment row
//     already knows its own scan. The reference is the only key needed.
//
//  5. HARDENING: HMAC over the raw bytes (not a decode/re-encode round trip), a
//     body size cap before any crypto, a loud failure when the secret is not
//     configured, and an OPTIONAL Paystack IP allowlist (PAYSTACK_WEBHOOK_IPS).
//
//  6. ROUND-2 AUDIT (sections 7/8): refund.needs-attention is now alerted (Paystack
//     stalls that refund until the merchant supplies bank details), refund event
//     keys no longer collapse two refunds on one transaction, money alerts are
//     throttled PER INCIDENT rather than per subject line, the receipt email is
//     pushed out of the request, dispute.resolve tells the admin which action to
//     take, and the inbox is finally visible/replayable (listWebhookEvents /
//     replayWebhookEvent, mounted under /api/admin).
//
// Idempotency lives in fulfillment.service (atomic status flip + scan claim),
// not here — this file only decides WHAT happened and reports it.

const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const emailService = require('../services/email.service')
const fulfillment = require('../services/fulfillment.service')
const { runInBackground } = require('../lib/background')
const { hitQuota } = require('../middleware/rateLimiter')

// Real Paystack events are a few KB. Anything near this is not one.
const MAX_BODY_BYTES = 256 * 1024

// Owner alerts for conditions an outside party (or a misconfiguration) can
// trigger repeatedly — bad signatures, an unknown reference — are throttled
// through KV so a scanner poking this public URL can't email-bomb the owner.
// Every occurrence is still logged; only the email is rate-limited.
const ALERT_COOLDOWN_SECONDS = 30 * 60
const SIG_ALERT_KEY = 'webhook-alert-cooldown:paystack-sig-mismatch'

async function alertAllowed(env, key) {
  try {
    const kv = env.RATE_LIMIT_KV
    if (!kv) return true  // no KV bound (some test setups) — fail open to alerting
    if (await kv.get(key)) return false
    await kv.put(key, '1', { expirationTtl: ALERT_COOLDOWN_SECONDS })
    return true
  } catch (_) {
    return true  // KV hiccup — better to occasionally over-alert than go silent
  }
}

// `incident` (usually the payment reference) scopes sendOwnerAlert's 10-minute
// email dedupe to THIS incident — see email.service.js.
function alert(c, subject, message, incident) {
  return runInBackground(c, emailService.sendOwnerAlert(c.env, subject, message, incident ? { dedupeKey: incident } : undefined))
}

// Per-reference cooldown (an event for the same reference alerts once per window)
// plus a global hourly ceiling, so a burst of genuinely different references is
// still bounded but a second real customer is never silenced by the first.
async function alertAllowedFor(env, kind, reference, { globalMax = 20 } = {}) {
  if (!(await alertAllowed(env, `webhook-alert-cooldown:${kind}:${reference || 'none'}`))) return false
  return hitQuota(env, `webhook-alert-global:${kind}`, globalMax, 60 * 60)
}

function parseIpList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
}

// ── payload helpers ─────────────────────────────────────────────────────────

// Card/customer detail never needs to live in our DB: authorization carries a
// reusable card token, customer carries PII.
const STRIP_KEYS = ['authorization', 'customer', 'log', 'plan', 'subaccount', 'split', 'fees_split', 'connect', 'source']
function redactEvent(event) {
  try {
    const copy = JSON.parse(JSON.stringify(event))
    if (copy?.data && typeof copy.data === 'object') for (const k of STRIP_KEYS) delete copy.data[k]
    if (copy?.data?.transaction && typeof copy.data.transaction === 'object')
      for (const k of STRIP_KEYS) delete copy.data.transaction[k]
    return copy
  } catch (_) { return null }
}

function eventKeyFor(event, bodyHash) {
  const d = event.data || {}
  // Repeated dispute reminders share an id but are genuinely new events.
  if (event.event.endsWith('.remind')) return `${event.event}:${bodyHash.slice(0, 16)}`
  // Paystack's refund payloads carry no `data.id`, so the old key collapsed to
  // `refund.processed:<transaction_reference>` — a second refund (e.g. the second
  // half of two partial refunds) or a second refund.failed on the same
  // transaction was treated as already-seen and never actioned or alerted.
  if (event.event.startsWith('refund.')) {
    const txRef = d.transaction_reference ?? d.transaction?.reference ?? ''
    const rk = d.id ?? d.refund_reference ?? (txRef || d.amount != null ? `${txRef}:${d.amount ?? ''}` : bodyHash.slice(0, 16))
    return `${event.event}:${rk}`
  }
  return `${event.event}:${d.id ?? d.reference ?? d.transaction_reference ?? bodyHash.slice(0, 16)}`
}

// ── inbox ───────────────────────────────────────────────────────────────────

const INBOX_MISSING_CODES = new Set(['42P01', 'PGRST205', 'PGRST204'])
function isInboxMissing(err) {
  return INBOX_MISSING_CODES.has(err?.code) ||
    (/webhook_events/.test(err?.message || '') && /does not exist|schema cache/i.test(err?.message || ''))
}

// mode: 'new' | 'retry' (seen before but not finished) | 'done' | 'unavailable'
async function recordEvent(supabase, { eventKey, eventType, reference, payload }) {
  const { data, error } = await supabase.from('webhook_events')
    .insert({ provider: 'paystack', event_key: eventKey, event_type: eventType, reference, payload })
    .select('id, attempts').single()
  if (!error) return { mode: 'new', id: data?.id, attempts: data?.attempts || 1 }

  if (error.code === '23505') {
    const { data: existing, error: selErr } = await supabase.from('webhook_events')
      .select('id, status, attempts').eq('provider', 'paystack').eq('event_key', eventKey).maybeSingle()
    if (selErr) throw selErr
    if (!existing) return { mode: 'new', id: null, attempts: 1 }
    if (['PROCESSED', 'IGNORED', 'HELD'].includes(existing.status)) return { mode: 'done', id: existing.id }
    const attempts = (existing.attempts || 1) + 1
    await supabase.from('webhook_events').update({ status: 'RECEIVED', attempts }).eq('id', existing.id)
    return { mode: 'retry', id: existing.id, attempts }
  }
  if (isInboxMissing(error)) return { mode: 'unavailable', id: null, attempts: 0 }
  throw error
}

async function markEvent(supabase, inbox, status, note) {
  if (!inbox?.id) return
  try {
    await supabase.from('webhook_events')
      .update({ status, error: note || null, processed_at: new Date().toISOString() }).eq('id', inbox.id)
  } catch (err) {
    console.error('webhook_events status update failed:', err.message)
  }
}

// ── event handlers — each returns { status: PROCESSED|IGNORED|HELD, note? } ──

async function processChargeSuccess(c, supabase, event) {
  const data = event.data || {}
  const reference = data.reference
  if (!reference) return { status: 'IGNORED', note: 'no reference' }

  const { data: paymentRow, error: selErr } = await supabase.from('payments')
    .select('*').eq('paystack_ref', reference).maybeSingle()
  if (selErr) throw selErr   // transient → 500 → Paystack retries

  if (!paymentRow) {
    console.error(`[CRITICAL] charge.success for unknown reference ${reference}`)
    if (await alertAllowedFor(c.env, 'unknown-reference', reference))
      alert(c, 'Paystack charge.success for an unknown reference',
        `reference: ${reference}\namount: ${data.amount} ${data.currency}\n\n` +
        `No payment row exists for this reference. Either the payments insert failed after ` +
        `Paystack initialised the transaction, or this Paystack account also serves another ` +
        `product. If money moved for THIS app, create the row and reconcile by hand.`, reference)
    return { status: 'IGNORED', note: 'unknown reference' }
  }

  const mismatch = fulfillment.chargeMismatch(paymentRow, { amount: data.amount, currency: data.currency })
  if (mismatch) {
    console.error(`[CRITICAL] Webhook amount/currency mismatch on ${reference}:`, mismatch)
    alert(c, 'Payment amount/currency mismatch — NOT fulfilled',
      `reference: ${reference}\nscanId: ${paymentRow.scan_id}\n` +
      `expected: ${mismatch.expectedAmount} ${mismatch.expectedCurrency}\n` +
      `received: ${mismatch.receivedAmount} ${mismatch.receivedCurrency}\n\n` +
      `Held for manual review — no fix was generated. If the payment is genuine, use ` +
      `Admin → Payments → Recheck (accept amount) or POST /api/payments/${reference}/recheck.`, reference)
    return { status: 'HELD', note: 'amount/currency mismatch' }
  }

  const result = await fulfillment.settlePayment(c.env, supabase, paymentRow, {
    authCode: data.authorization?.authorization_code, source: 'webhook',
    // The receipt email runs after the 200 (Paystack: acknowledge quickly).
    defer: p => runInBackground(c, p),
  })

  if (['DUPLICATE', 'SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED'].includes(result.outcome)) {
    console.error(`[CRITICAL] webhook ${reference}: ${result.outcome}`)
    // A duplicate must not earn a second commission — settlePayment already skipped it.
    alert(c, `Payment needs attention: ${result.outcome}`,
      `reference: ${reference}\nscanId: ${paymentRow.scan_id}\n` +
      (result.outcome === 'DUPLICATE'
        ? `A different payment (${result.ownerPaymentId || 'earlier'}) already fulfilled this scan. Nothing was re-generated and no commission was recorded for this one. Refund it in Paystack — the refund.processed webhook will mark it REFUNDED.`
        : `Nothing was generated. Refund it in Paystack.`), reference)
    return { status: 'PROCESSED', note: result.outcome }
  }
  if (result.outcome === 'UNKNOWN_REFERENCE') return { status: 'IGNORED', note: 'unknown reference' }
  if (result.outcome === 'IGNORED_STATUS') return { status: 'IGNORED', note: `payment is ${result.status}` }
  return { status: 'PROCESSED', note: result.outcome }
}

// A declined attempt is routine — no owner alert. Only PENDING rows move: an
// ABANDONED/SUCCESS row must not be touched, and because settlePayment revives
// FAILED rows, a later successful retry on the same reference is still honoured.
async function processChargeFailed(c, supabase, event) {
  const reference = event.data?.reference
  if (!reference) return { status: 'IGNORED', note: 'no reference' }
  const { error } = await supabase.from('payments')
    .update({ status: 'FAILED' }).eq('paystack_ref', reference).eq('status', 'PENDING')
  if (error) throw error
  return { status: 'PROCESSED' }
}

async function processRefund(c, supabase, event) {
  const payment = await fulfillment.findPaymentForEvent(supabase, event)
  const refundRef = event.data?.refund_reference || null
  const incident = payment?.paystack_ref || refundRef || fulfillment.referenceCandidates(event)[0] || null

  // ROUND-2 AUDIT (feature gap): Paystack parks a refund in `needs-attention`
  // when the processing rails did not return the customer's bank account — it
  // then waits, indefinitely, for the merchant to call the Retry Refund API
  // with those details. This used to fall into the IGNORED branch below, so a
  // customer's money could sit stalled with nobody ever told.
  if (event.event === 'refund.needs-attention') {
    alert(c, 'Paystack refund needs attention — bank details required',
      `payment reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n` +
      `refund reference: ${refundRef || '(none yet)'}\namount: ${event.data?.amount ?? '?'} ${event.data?.currency || ''}\n\n` +
      `Paystack could not get the customer's bank account from the original payment, so this refund is STALLED until you ` +
      `supply one: Paystack dashboard → the refund → provide the customer's bank details, or POST ` +
      `/refund/retry_with_customer_details/{refund id} (Retry Refund API). The payment here was NOT changed; ` +
      `when the refund finally completes, refund.processed will reverse the sale.`, incident)
    return { status: 'PROCESSED', note: 'refund needs attention — alerted' }
  }

  // refund.pending / refund.processing are intermediate — nothing to do yet.
  if (event.event !== 'refund.processed' && event.event !== 'refund.failed')
    return { status: 'IGNORED', note: event.event }

  if (event.event === 'refund.failed') {
    alert(c, 'Paystack refund.failed',
      `payment reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n\n` +
      `The refund did not go through. The payment was NOT changed.`, incident)
    return { status: 'PROCESSED', note: 'refund failed — alerted' }
  }

  if (!payment) {
    alert(c, 'Paystack refund.processed — payment not found',
      `Could not match this refund to a payment.\npayload keys: ${Object.keys(event.data || {}).join(', ')}\n\nReview manually.`, incident)
    return { status: 'PROCESSED', note: 'payment not found' }
  }
  if (!['SUCCESS', 'DISPUTED', 'REFUNDED'].includes(payment.status)) {
    alert(c, 'Paystack refund.processed on a payment that was never SUCCESS',
      `reference: ${payment.paystack_ref}\nstatus: ${payment.status}\n\nNot actioned. Review manually.`, incident)
    return { status: 'PROCESSED', note: `payment is ${payment.status}` }
  }

  // Only an unambiguous FULL refund is actioned automatically. A partial (or
  // unstated) amount could mean a goodwill partial refund on a delivered
  // product — revoking the credential there would be wrong.
  const refunded = Number(event.data?.amount)
  const full = Number.isFinite(refunded) && payment.amount_cents > 0 && refunded >= payment.amount_cents
  if (!full) {
    alert(c, 'Paystack refund.processed — partial/unknown amount, NOT actioned',
      `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\npaid: ${payment.amount_cents}\nrefunded: ${event.data?.amount ?? '(not in payload)'}\n\n` +
      `Payment left as-is. If this should reverse the sale, use Admin → Payments → Reverse.`, incident)
    return { status: 'PROCESSED', note: 'partial/unknown refund — alerted' }
  }

  const done = await fulfillment.reversePayment(supabase, payment, { reason: 'REFUND', refundReference: refundRef })
  alert(c, 'Paystack refund processed — sale reversed',
    `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\n\n` +
    `payment → REFUNDED: ${done.transitioned ? 'yes' : 'already'}\n` +
    `partner commission reversed: ${done.ledger.reversed ? `yes${done.ledger.alreadyPaidOut ? ' (ALREADY PAID OUT — nets against their next payout)' : ''}` : done.ledger.reason}\n` +
    `public verification revoked: ${done.revoked ? 'yes' : 'no (not applicable / already revoked / another payment owns the scan)'}\n\n` +
    `Downloads were NOT revoked — delete the scan if you want the files gone.`, incident)
  return { status: 'PROCESSED', note: 'reversed' }
}

async function processDispute(c, supabase, event) {
  const payment = await fulfillment.findPaymentForEvent(supabase, event)
  const d = event.data || {}
  const summary =
    `reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n` +
    `dispute status: ${d.status || '?'}${d.resolution ? `\nresolution: ${d.resolution}` : ''}\n\n`

  // SECTION 8 AUDIT FIX (bug): `marked` records whether the guarded UPDATE
  // below actually ran, so the alert text can say what happened instead of
  // assuming it. Before this fix the alert always claimed "now marked
  // DISPUTED" on a charge.dispute.create event, even when nothing was
  // touched — an unresolved reference, or a payment that wasn't SUCCESS
  // (e.g. a second dispute id opened against a payment already DISPUTED).
  // That's a false state claim in the one email a human uses to decide
  // whether to act — worth getting right even though every case here is
  // otherwise harmless (idempotent / no-op).
  let marked = false
  if (event.event === 'charge.dispute.create' && payment?.status === 'SUCCESS') {
    const { data: updated, error } = await supabase.from('payments')
      .update({ status: 'DISPUTED', disputed_at: new Date().toISOString() })
      .eq('id', payment.id).eq('status', 'SUCCESS').select('id')
    if (error) throw error
    marked = !!(updated && updated.length)
  }

  // ROUND-2 AUDIT (feature gap): dispute.resolve used to say only "no state
  // change", leaving the admin to work out which of Reverse / Clear applies.
  // Paystack's resolutions are `merchant-accepted` (money goes back to the
  // customer — Paystack ALSO auto-accepts after 16 hours) and `declined` (you
  // won). The irreversible steps still wait for a human, but the alert now says
  // exactly which one.
  const resolution = String(d.resolution || '').toLowerCase()
  const current = payment ? `payment is currently ${payment.status}` : 'no payment could be resolved'
  let detail
  if (event.event === 'charge.dispute.resolve') {
    if (/declin/.test(resolution))
      detail = `Resolution: DECLINED — you WON. ${current}. Next: Admin → Payments → Clear dispute (puts it back to SUCCESS and into revenue).`
    else if (/accept/.test(resolution))
      detail = `Resolution: ACCEPTED — the money went back to the customer. ${current}. Next: Admin → Payments → Reverse (marks it REFUNDED, reverses any partner commission, revokes the public credential).`
    else
      detail = `Resolution "${d.resolution || 'unknown'}" is not one this app recognises. ${current}. Check the outcome in Paystack, then use Admin → Payments → Reverse (lost) or Clear dispute (won).`
  } else if (event.event === 'charge.dispute.remind') {
    detail = `Reminder: this dispute is still unresolved (Paystack auto-accepts and refunds the customer after 16 hours). ${current}. Respond in the Paystack dashboard.`
  } else if (event.event !== 'charge.dispute.create') {
    detail = `No state change for this event type; the dispute is tracked from charge.dispute.create.`
  } else if (marked) {
    detail = `The payment is now marked DISPUTED (excluded from revenue). Nothing else was changed: ` +
      `access and the public credential stay live and any partner commission stays put until you decide. ` +
      `If you LOSE the dispute: Admin → Payments → Reverse (refunds the sale, reverses commission, revokes the credential). ` +
      `If you WIN: Admin → Payments → Clear dispute.`
  } else if (!payment) {
    detail = `Nothing was marked — no payment could be resolved for this reference. Review manually.`
  } else {
    detail = `Nothing was marked — the payment is currently ${payment.status}, not SUCCESS, so it was left as-is.`
  }

  alert(c, `Paystack ${event.event}`, `A "${event.event}" event was received.\n\n${summary}${detail}`,
    `${payment?.paystack_ref || fulfillment.referenceCandidates(event)[0] || d.id || ''}:${event.event}`)
  return { status: 'PROCESSED', note: payment ? undefined : 'payment not found' }
}

async function processEvent(c, supabase, event) {
  const type = event.event
  if (type === 'charge.success') return processChargeSuccess(c, supabase, event)
  if (type === 'charge.failed')  return processChargeFailed(c, supabase, event)
  if (type.startsWith('refund.')) return processRefund(c, supabase, event)
  if (type.startsWith('charge.dispute')) return processDispute(c, supabase, event)
  return { status: 'IGNORED', note: type }
}

// ── entry point ─────────────────────────────────────────────────────────────

async function handlePaystack(c) {
  const secret = c.env.PAYSTACK_SECRET_KEY
  if (!secret) {
    // Fail closed (an empty HMAC key can't verify anything) — but LOUDLY. This
    // used to surface as an opaque importKey exception with no alert.
    console.error('[CRITICAL] PAYSTACK_SECRET_KEY is not configured — every webhook will fail')
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:paystack-secret-missing'))
      alert(c, 'Paystack webhook cannot verify signatures — secret not configured',
        'PAYSTACK_SECRET_KEY is missing from this Worker. Every Paystack webhook is being rejected with 500 (so Paystack keeps retrying). Set it: wrangler secret put PAYSTACK_SECRET_KEY')
    return c.text('Webhook not configured', 500)
  }

  const allow = parseIpList(c.env.PAYSTACK_WEBHOOK_IPS)
  if (allow.length) {
    const ip = c.req.header('cf-connecting-ip') || ''
    if (!allow.includes(ip)) {
      console.error(`Webhook rejected: source IP ${ip || '(none)'} is not in PAYSTACK_WEBHOOK_IPS`)
      return c.text('Forbidden', 403)
    }
  }

  const declared = Number.parseInt(c.req.header('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.text('Payload too large', 413)
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer())
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return c.text('Payload too large', 413)

  const expectedSig = await cryptoLib.hmacSha512Hex(secret, bodyBytes)
  if (!cryptoLib.timingSafeEqual(expectedSig, c.req.header('x-paystack-signature') || '')) {
    // Either a misconfigured secret or a spoofing attempt — worth a (throttled) page.
    console.error('[CRITICAL] Paystack webhook signature mismatch')
    if (await alertAllowed(c.env, SIG_ALERT_KEY))
      alert(c, 'Paystack webhook signature mismatch',
        `A request to /api/webhooks/paystack failed HMAC verification.\nsource IP: ${c.req.header('cf-connecting-ip') || '(unknown)'}\n\n` +
        `Either PAYSTACK_SECRET_KEY is wrong/rotated (real payments will not fulfil until fixed) or someone is probing the endpoint. ` +
        `Further mismatches in the next 30 minutes are logged but not emailed.`)
    return c.text('Invalid signature', 401)
  }

  let event
  try {
    event = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch (_) {
    return c.text('OK', 200)   // signed but not JSON — nothing sensible to do or retry
  }
  if (!event || typeof event.event !== 'string') return c.text('OK', 200)

  const supabase = getSupabase(c.env)
  const bodyHash = await cryptoLib.sha256Bytes(bodyBytes)
  const reference = fulfillment.referenceCandidates(event)[0] || null

  let inbox
  try {
    inbox = await recordEvent(supabase, {
      eventKey: eventKeyFor(event, bodyHash), eventType: event.event, reference, payload: redactEvent(event),
    })
  } catch (err) {
    console.error('webhook_events insert failed:', err.message)
    return c.text('Temporary error', 500)   // Paystack retries
  }
  if (inbox.mode === 'done') return c.text('OK', 200)
  if (inbox.mode === 'unavailable') {
    console.error('[CRITICAL] webhook_events table is missing — apply migration 0025. Processing without an inbox.')
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:inbox-missing'))
      alert(c, 'webhook_events table missing — apply migration 0025',
        'Webhooks are still being processed, but with no audit trail and no dedupe record.')
  }

  let outcome
  try {
    outcome = await processEvent(c, supabase, event)
  } catch (err) {
    console.error(`[CRITICAL] webhook ${event.event} (${reference}) failed:`, err.message)
    await markEvent(supabase, inbox, 'FAILED', err.message)
    // First failure pages once; the redeliveries Paystack sends next don't.
    if (!inbox.attempts || inbox.attempts <= 1)
      alert(c, 'Webhook processing failed — Paystack will retry',
        `event: ${event.event}\nreference: ${reference || '(none)'}\nerror: ${err.message}\n\n` +
        `Answered 500, so Paystack redelivers on its retry schedule and the redelivery re-runs this. ` +
        `If it keeps failing: POST /api/payments/${reference || '<reference>'}/reconcile or /recheck (admin).`, reference)
    return c.text('Processing error', 500)
  }

  await markEvent(supabase, inbox, outcome.status, outcome.note)
  return c.text('OK', 200)
}

// ── admin: inbox visibility + replay ───────────────────────────────────────
// ROUND-2 AUDIT (feature gap): webhook_events was described as "an audit trail…
// answerable in SQL", and every alert told the owner to "check webhook_events" —
// but nothing in the app could show it, and a HELD / FAILED / IGNORED row (which
// recordEvent treats as finished) could never be re-run, not even by Paystack's
// own "Resend" tool. Mounted under /api/admin (admin-only) — see admin.routes.js.

const EVENT_STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'HELD', 'FAILED']
// PROCESSED is deliberately not replayable: it already did its work.
const REPLAYABLE = ['RECEIVED', 'IGNORED', 'HELD', 'FAILED']

// GET /api/admin/webhook-events?status=&page=&pageSize=
async function listWebhookEvents(c) {
  const page     = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '25', 10) || 25))
  const from = (page - 1) * pageSize
  const status = c.req.query('status')

  let q = getSupabase(c.env).from('webhook_events')
    .select('id, event_type, event_key, reference, status, attempts, error, received_at, processed_at', { count: 'exact' })
    .order('received_at', { ascending: false }).range(from, from + pageSize - 1)
  if (status && EVENT_STATUSES.includes(status)) q = q.eq('status', status)

  const { data, error, count } = await q
  if (error) throw error
  return c.json({ success: true, data: (data || []).map(r => ({
    id: r.id, eventType: r.event_type, eventKey: r.event_key, reference: r.reference, status: r.status,
    attempts: r.attempts, error: r.error, receivedAt: r.received_at, processedAt: r.processed_at,
    replayable: REPLAYABLE.includes(r.status),
  })), meta: { page, pageSize, total: count || 0 } })
}

// POST /api/admin/webhook-events/:id/replay
// Re-runs the stored (redacted) event through the same handlers a live delivery
// uses. Safe to repeat: every handler is idempotent (atomic claims, unique ledger
// index). Note the redaction: card authorisation data is not stored, so a replayed
// charge.success cannot re-save the reusable card token — nothing else needs it.
async function replayWebhookEvent(c) {
  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('webhook_events')
    .select('id, status, attempts, payload, event_type, reference').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Event not found.' }, 404)
  if (!REPLAYABLE.includes(row.status))
    return c.json({ success: false, message: `This event is ${row.status} — it already did its work; nothing to replay.` }, 409)
  const event = row.payload
  if (!event || typeof event.event !== 'string')
    return c.json({ success: false, message: 'No stored payload to replay.' }, 422)

  const inbox = { id: row.id, attempts: (row.attempts || 1) + 1 }
  await supabase.from('webhook_events').update({ status: 'RECEIVED', attempts: inbox.attempts }).eq('id', row.id)
  try {
    const outcome = await processEvent(c, supabase, event)
    await markEvent(supabase, inbox, outcome.status, outcome.note)
    return c.json({ success: true, data: { status: outcome.status, note: outcome.note || null,
      hint: outcome.status === 'HELD' ? 'Still held — an amount/currency mismatch needs Admin → Payments → Recheck (accept amount).' : null } })
  } catch (err) {
    await markEvent(supabase, inbox, 'FAILED', err.message)
    return c.json({ success: false, message: `Replay failed: ${err.message}` }, 500)
  }
}

module.exports = { handlePaystack, listWebhookEvents, replayWebhookEvent, eventKeyFor, MAX_BODY_BYTES }
