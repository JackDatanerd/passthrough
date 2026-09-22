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
//  2. DURABLE INBOX (webhook_events, migration 0021). Every verified event is
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
// Idempotency lives in fulfillment.service (atomic status flip + scan claim),
// not here — this file only decides WHAT happened and reports it.

const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const emailService = require('../services/email.service')
const fulfillment = require('../services/fulfillment.service')
const { runInBackground } = require('../lib/background')

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

function alert(c, subject, message) {
  return runInBackground(c, emailService.sendOwnerAlert(c.env, subject, message))
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
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:unknown-reference'))
      alert(c, 'Paystack charge.success for an unknown reference',
        `reference: ${reference}\namount: ${data.amount} ${data.currency}\n\n` +
        `No payment row exists for this reference. Either the payments insert failed after ` +
        `Paystack initialised the transaction, or this Paystack account also serves another ` +
        `product. If money moved for THIS app, create the row and reconcile by hand.`)
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
      `Admin → Payments → Recheck (accept amount) or POST /api/payments/${reference}/recheck.`)
    return { status: 'HELD', note: 'amount/currency mismatch' }
  }

  const result = await fulfillment.settlePayment(c.env, supabase, paymentRow, {
    authCode: data.authorization?.authorization_code, source: 'webhook',
  })

  if (['DUPLICATE', 'SCAN_MISSING', 'NO_SCAN', 'ACCOUNT_DELETED'].includes(result.outcome)) {
    console.error(`[CRITICAL] webhook ${reference}: ${result.outcome}`)
    // A duplicate must not earn a second commission — settlePayment already skipped it.
    alert(c, `Payment needs attention: ${result.outcome}`,
      `reference: ${reference}\nscanId: ${paymentRow.scan_id}\n` +
      (result.outcome === 'DUPLICATE'
        ? `A different payment (${result.ownerPaymentId || 'earlier'}) already fulfilled this scan. Nothing was re-generated and no commission was recorded for this one. Refund it in Paystack — the refund.processed webhook will mark it REFUNDED.`
        : `Nothing was generated. Refund it in Paystack.`))
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
  // refund.pending / refund.processing are intermediate — nothing to do yet.
  if (event.event !== 'refund.processed' && event.event !== 'refund.failed')
    return { status: 'IGNORED', note: event.event }

  const payment = await fulfillment.findPaymentForEvent(supabase, event)
  const refundRef = event.data?.refund_reference || null

  if (event.event === 'refund.failed') {
    alert(c, 'Paystack refund.failed',
      `payment reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n\n` +
      `The refund did not go through. The payment was NOT changed.`)
    return { status: 'PROCESSED', note: 'refund failed — alerted' }
  }

  if (!payment) {
    alert(c, 'Paystack refund.processed — payment not found',
      `Could not match this refund to a payment.\npayload keys: ${Object.keys(event.data || {}).join(', ')}\n\nReview manually.`)
    return { status: 'PROCESSED', note: 'payment not found' }
  }
  if (!['SUCCESS', 'DISPUTED', 'REFUNDED'].includes(payment.status)) {
    alert(c, 'Paystack refund.processed on a payment that was never SUCCESS',
      `reference: ${payment.paystack_ref}\nstatus: ${payment.status}\n\nNot actioned. Review manually.`)
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
      `Payment left as-is. If this should reverse the sale, use Admin → Payments → Reverse.`)
    return { status: 'PROCESSED', note: 'partial/unknown refund — alerted' }
  }

  const done = await fulfillment.reversePayment(supabase, payment, { reason: 'REFUND', refundReference: refundRef })
  alert(c, 'Paystack refund processed — sale reversed',
    `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\n\n` +
    `payment → REFUNDED: ${done.transitioned ? 'yes' : 'already'}\n` +
    `partner commission reversed: ${done.ledger.reversed ? `yes${done.ledger.alreadyPaidOut ? ' (ALREADY PAID OUT — nets against their next payout)' : ''}` : done.ledger.reason}\n` +
    `public verification revoked: ${done.revoked ? 'yes' : 'no (not applicable / already revoked / another payment owns the scan)'}\n\n` +
    `Downloads were NOT revoked — delete the scan if you want the files gone.`)
  return { status: 'PROCESSED', note: 'reversed' }
}

async function processDispute(c, supabase, event) {
  const payment = await fulfillment.findPaymentForEvent(supabase, event)
  const d = event.data || {}
  const summary =
    `reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n` +
    `dispute status: ${d.status || '?'}${d.resolution ? `\nresolution: ${d.resolution}` : ''}\n\n`

  if (event.event === 'charge.dispute.create' && payment?.status === 'SUCCESS') {
    const { error } = await supabase.from('payments')
      .update({ status: 'DISPUTED', disputed_at: new Date().toISOString() })
      .eq('id', payment.id).eq('status', 'SUCCESS')
    if (error) throw error
  }

  alert(c, `Paystack ${event.event}`,
    `A "${event.event}" event was received.\n\n${summary}` +
    (event.event === 'charge.dispute.create'
      ? `The payment is now marked DISPUTED (excluded from revenue). Nothing else was changed: ` +
        `access and the public credential stay live and any partner commission stays put until you decide. ` +
        `If you LOSE the dispute: Admin → Payments → Reverse (refunds the sale, reverses commission, revokes the credential). ` +
        `If you WIN: Admin → Payments → Clear dispute.`
      : `No state change for this event type; the dispute is tracked from charge.dispute.create.`))
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
    console.error('[CRITICAL] webhook_events table is missing — apply migration 0021. Processing without an inbox.')
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:inbox-missing'))
      alert(c, 'webhook_events table missing — apply migration 0021',
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
        `If it keeps failing: POST /api/payments/${reference || '<reference>'}/reconcile or /recheck (admin).`)
    return c.text('Processing error', 500)
  }

  await markEvent(supabase, inbox, outcome.status, outcome.note)
  return c.text('OK', 200)
}

module.exports = { handlePaystack, MAX_BODY_BYTES }
