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
//  7. ROUND-3 AUDIT (sections 7/8):
//     * outcome notes ("FULFILLED", "reversed"…) are written to a NEW `note` column, not
//       `error` — the admin table paints `error` red, so every healthy row looked broken;
//     * `charge.failed` is not an event Paystack sends (its documented list has no such
//       event), so that handler was dead code and is gone; PENDING→FAILED is the sweeps' job;
//     * `.remind` events are keyed per hour, not by body hash alone — identical reminders
//       were being swallowed as duplicates, and the 16-hour dispute clock is the reason
//       that alert exists;
//     * refund events with no id no longer collide across unrelated transactions;
//     * refunds are SUMMED per payment (from the inbox itself): two 50% refunds are a full
//       refund and reverse the sale, instead of two alerts and nothing else;
//     * the stored payload no longer keeps the payer's IP address or receipt number;
//     * the inbox has a payload viewer, reference/type search, "needs attention" filter,
//       and records who replayed an event; FAILED/RECEIVED events that Paystack has given
//       up on are re-driven by redriveStaleEvents (hourly cron), HELD ones are escalated once.
//     * the work before the 200 is still inline on purpose (see #1) but is more than "a
//       handful of DB calls" now: recordConversion adds several sequential queries. It stays
//       correct only because every step downstream is idempotent — a slow delivery that
//       Paystack times out and redelivers runs twice, safely.
//
//  8. SECTION 7/8 AUDIT (bug, this pass): `refund.needs-attention` is now hour-bucketed the
//     same way `.remind` events are (see eventKeyFor) — a second stalled-refund notification
//     for the same refund id used to dedupe as "already seen" and never alert again. And every
//     revoke/restore this file triggers (via fulfillment.service's reversePayment →
//     lib/verification.js) now purges that scan's cached SVG badge, so the one surface a
//     viewer never clicks through to double-check can no longer keep showing a pre-revoke
//     "Verified" claim for up to 5 minutes at the edge.
//
//  9. ROUND-4 AUDIT (section 8, independent pass — migration 0053):
//     * B1: record_refund_and_total used to flip the event's inbox row to PROCESSED BEFORE the
//       sale was reversed. A reversePayment failure that coincided with a failed markEvent left
//       the row PROCESSED, so Paystack's redelivery was answered "done" and nothing re-drove it.
//       The RPC now only records the amount; processRefund's caller marks PROCESSED afterwards.
//     * B3: the refund running total is read from payment_refunds (never pruned) instead of a
//       SUM over webhook_events rows that the 90-day prune deletes.
//     * B5: a refund event with no id and no refund_reference shares its key with an equal-amount
//       sibling on the same transaction, so the second of two equal partial refunds deduped as
//       "already seen" and never summed to a full one. Such events are now re-run when seen again
//       (not treated as done), are not added to the local running total (a duplicate delivery
//       would double-count), and take the authoritative total from Paystack's refund list.
//     * B2: the hourly re-drive's query no longer lets exhausted rows (attempts >= MAX_REDRIVES)
//       or payload-less rows fill its window and starve newer failures.
//     * B6: alertAllowedFor checks the per-reference cooldown WITHOUT taking it, then the global
//       ceiling, and only then takes the cooldown — a global-ceiling denial no longer silences
//       that reference for 30 minutes.
//     * G1: a HELD event whose payment has since been settled (admin Recheck, browser verify,
//       sweep) is closed out (closeResolvedHeldEvents) instead of staying HELD forever — which
//       kept the dashboard count lit and re-sent "a customer may have paid and received nothing"
//       every 3 days. The escalation also stopped using an un-ordered limit(10) window.
//
// 10. ROUND-5 AUDIT (section 8, independent pass — no migration):
//     * B1: charge.dispute.create no longer re-marks a payment DISPUTED when that dispute's resolution
//       has already been processed (late delivery, re-drive, Replay) — see disputeResolutionSeen.
//     * B2: a refund that matches no payment is IGNORED (replayable), not PROCESSED (409 on Replay).
//     * B3: an ambiguous refund whose Paystack refund-list lookup fails answers 500 instead of being
//       closed as "partial" — the list is the only authority for it (see processRefund).
//     * G1 (resend-webhook.controller.js): missing secret / failed signature now page the owner.
//
// 11. ROUND-6 AUDIT (section 8, independent pass — no migration):
//     * G1: admin Replay is written to admin_audit_log ('webhook.replay') like every other admin money action.
//     * G2: Resend delivery health — see resend-webhook.controller.js; computeWebhookHealth reports lastResendEventAt.
//     * G3: only events the handlers act on keep a payload (ACTIONABLE_EVENT); everything else stores type/key/
//       reference only, and scrubUnactionablePayloads clears what older deliveries already stored.
//     * G4: a request from outside PAYSTACK_WEBHOOK_IPS that carries a VALID signature pages the owner.
//     * B1: a failed first inbox write (500 before any row exists) now alerts, throttled per event type.
//
// 12. ROUND-7 AUDIT (section 8, independent pass — migration 0065):
//     * G1: the Resend webhook now has the same durable inbox (webhook_events, provider 'resend', keyed on svix-id):
//       deduped, FAILED rows are re-driven/replayable, visible in Admin → Webhooks. recordEvent/markEvent are provider-aware.
//     * G4: dispute events keep an ALLOWLIST of fields (messages/history/attachments are never stored).
//     * B2: the admin list only offers Replay for a row that has a payload; stuck payload-less RECEIVED rows are closed.
//     * B3: re-drive attempts are counted in their own column (`redrives`) — Paystack's own redeliveries used to use
//       the budget up and the "stopped retrying" alert was false.
//     * B4: a refund that states no amount lets Paystack's refund list decide (and fails closed with a 500).
//
// Idempotency lives in fulfillment.service (atomic status flip + scan claim),
// not here — this file only decides WHAT happened and reports it.

const cryptoLib = require('../lib/crypto')
const { getSupabase } = require('../config/supabase')
const emailService = require('../services/email.service')
const fulfillment = require('../services/fulfillment.service')
const paystackService = require('../services/paystack.service')
const { runInBackground } = require('../lib/background')
const { hitQuota } = require('../middleware/rateLimiter')
const { logAdminAction } = require('../lib/adminAudit')

// Real Paystack events are a few KB. Anything near this is not one.
const MAX_BODY_BYTES = 256 * 1024

// Owner alerts for conditions an outside party (or a misconfiguration) can
// trigger repeatedly — bad signatures, an unknown reference — are throttled
// through KV so a scanner poking this public URL can't email-bomb the owner.
// Every occurrence is still logged; only the email is rate-limited.
const ALERT_COOLDOWN_SECONDS = 30 * 60
const SIG_ALERT_KEY = 'webhook-alert-cooldown:paystack-sig-mismatch'

async function alertAllowed(env, key, ttlSeconds = ALERT_COOLDOWN_SECONDS) {
  try {
    const kv = env.RATE_LIMIT_KV
    if (!kv) return true  // no KV bound (some test setups) — fail open to alerting
    if (await kv.get(key)) return false
    await kv.put(key, '1', { expirationTtl: ttlSeconds })
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
// ROUND-4 FIX (B6): the cooldown used to be TAKEN before the global ceiling was consulted, so a
// reference the ceiling turned away was still silenced for the whole cooldown — its retry,
// after the ceiling window rolled over, was swallowed too. The cooldown is now only peeked at
// first and taken once the alert is actually going out.
async function alertAllowedFor(env, kind, reference, { globalMax = 20, ttlSeconds = ALERT_COOLDOWN_SECONDS } = {}) {
  const key = `webhook-alert-cooldown:${kind}:${reference || 'none'}`
  const kv = env.RATE_LIMIT_KV
  try { if (kv && await kv.get(key)) return false } catch (_) { /* KV hiccup — fail open to alerting */ }
  if (!(await hitQuota(env, `webhook-alert-global:${kind}`, globalMax, 60 * 60))) return false
  try { if (kv) await kv.put(key, '1', { expirationTtl: ttlSeconds }) } catch (_) { /* over-alert rather than go silent */ }
  return true
}

function parseIpList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
}

// ── payload helpers ─────────────────────────────────────────────────────────

// Card/customer detail never needs to live in our DB: authorization carries a
// reusable card token, customer carries PII.
// ip_address (the payer's) and receipt_number are personal data the app never reads back.
const STRIP_KEYS = ['authorization', 'customer', 'log', 'plan', 'subaccount', 'split', 'fees_split', 'connect', 'source', 'ip_address', 'receipt_number']
// ROUND-7 (G4): a dispute payload also carries the conversation (messages, history, attachments, the
// customer's own words) that nothing here reads. Dispute events keep ONLY the fields the handler uses.
const DISPUTE_KEEP = ['id', 'status', 'resolution', 'refund_amount', 'currency', 'category', 'reference', 'transaction_reference', 'due_at', 'resolved_at', 'created_at']
const DISPUTE_TX_KEEP = ['id', 'reference', 'amount', 'currency']
const isScalar = v => v != null && typeof v !== 'object'
function minimalDisputeEvent(ev) {
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
  const data = {}
  for (const k of DISPUTE_KEEP) if (isScalar(d[k])) data[k] = d[k]
  if (d.transaction && typeof d.transaction === 'object') {
    const tx = {}
    for (const k of DISPUTE_TX_KEEP) if (isScalar(d.transaction[k])) tx[k] = d.transaction[k]
    data.transaction = tx
  }
  return { event: ev.event, data }
}
function redactEvent(event) {
  try {
    const copy = JSON.parse(JSON.stringify(event))
    if (typeof copy?.event === 'string' && copy.event.startsWith('charge.dispute')) return minimalDisputeEvent(copy)
    if (copy?.data && typeof copy.data === 'object') for (const k of STRIP_KEYS) delete copy.data[k]
    if (copy?.data?.transaction && typeof copy.data.transaction === 'object')
      for (const k of STRIP_KEYS) delete copy.data.transaction[k]
    return copy
  } catch (_) { return null }
}

// ROUND-6 (G3): the payload is only ever read back to re-run an event the handlers act on (Replay, the hourly
// re-drive). Every other event type (transfer.*, subscription.*, dedicated-account events … whatever else this
// Paystack account sends) was stored with its whole body for 90 days — including blocks such as a transfer's
// `recipient` bank details that STRIP_KEYS does not know about. Those keep type, key and reference only.
function isActionableEvent(type) {
  return type === 'charge.success' || type.startsWith('refund.') || type.startsWith('charge.dispute')
}

// A refund event with no `id` and no `refund_reference` cannot be told apart from an equal-amount
// sibling on the same transaction (nor from a duplicate delivery of itself). See eventKeyFor.
function refundIsAmbiguous(event) {
  const d = event?.data || {}
  return d.id == null && d.refund_reference == null
}

function eventKeyFor(event, bodyHash, now = Date.now()) {
  const d = event.data || {}
  // Repeated dispute reminders share an id but are genuinely new events — and, being
  // reminders of the same unresolved dispute, they can arrive byte-for-byte identical, so
  // the body hash alone made every one after the first look like a duplicate and swallowed
  // the alert whose whole point is the 16-hour auto-accept clock. Scoping the key to the
  // hour keeps a redelivery of the same reminder deduped and lets the next one through.
  // (A reminder only alerts; running one twice is harmless.)
  if (event.event.endsWith('.remind')) return `${event.event}:${bodyHash.slice(0, 16)}:${Math.floor(now / 3_600_000)}`

  // SECTION 8 AUDIT FIX (bug): `refund.needs-attention` has the exact same shape as a
  // `.remind` event above — Paystack parks a refund indefinitely until the merchant supplies
  // bank details, and can (most concretely: via the very recovery path this alert itself
  // names, POST /refund/retry_with_customer_details/{refund id}) land the SAME refund id back
  // in `needs-attention` a second time. `d.id` never changes between these deliveries, so
  // without bucketing, the second (and every later) notification deduped against the first
  // PROCESSED inbox row before ever reaching processRefund — recordEvent's mode:'done' path —
  // and the alert whose entire point is "this refund is still stuck, go fix it" fired exactly
  // once, ever, no matter how long the money stayed stalled or how many times the merchant's
  // own retry failed. sweepReversedPayments (reconcile.service.js) does not backstop this: it
  // only notices a transaction Paystack reports as `reversed`, i.e. one that already
  // COMPLETED — a permanently-stalled needs-attention refund never reaches that state. Same
  // hour-bucket fix as `.remind`, for the same reason: a stalled-but-unresolved state, not a
  // one-off.
  if (event.event === 'refund.needs-attention') return `${event.event}:${bodyHash.slice(0, 16)}:${Math.floor(now / 3_600_000)}`
  // Paystack's refund payloads can carry neither `data.id` nor a `refund_reference` (its own
  // sample for refund.pending has refund_reference: null), so the key collapses to
  // `refund.processed:<transaction_reference>:<amount>` — and the second of two equal partial
  // refunds (2 x 50%, the very case the running total exists for) deduped as already-seen and
  // was never looked at.
  //
  // ROUND-4 FIX (B5): the key is unchanged (a delivery cannot be told from its twin by content),
  // but handlePaystack no longer treats a SEEN ambiguous refund event as finished — it runs it
  // again (see refundIsAmbiguous). That is safe because processRefund takes the authoritative
  // total for such an event from Paystack's refund list rather than adding this event's amount to
  // a local one, and reversePayment is idempotent. Events that DO carry an id/reference keep
  // exact keys and exact dedupe.
  if (event.event.startsWith('refund.')) {
    const txRef = d.transaction_reference ?? d.transaction?.reference ?? ''
    const rk = d.id ?? d.refund_reference ?? (txRef ? `${txRef}:${d.amount ?? ''}` : bodyHash.slice(0, 16))
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
async function recordEvent(supabase, { eventKey, eventType, reference, payload, provider = 'paystack' }) {
  const { data, error } = await supabase.from('webhook_events')
    .insert({ provider, event_key: eventKey, event_type: eventType, reference, payload })
    .select('id, attempts').single()
  if (!error) return { mode: 'new', id: data?.id, attempts: data?.attempts || 1 }

  if (error.code === '23505') {
    const { data: existing, error: selErr } = await supabase.from('webhook_events')
      .select('id, status, attempts').eq('provider', provider).eq('event_key', eventKey).maybeSingle()
    if (selErr) throw selErr
    if (!existing) return { mode: 'new', id: null, attempts: 1 }
    if (['PROCESSED', 'IGNORED', 'HELD'].includes(existing.status)) return { mode: 'done', id: existing.id, attempts: existing.attempts || 1 }
    const attempts = (existing.attempts || 1) + 1
    await supabase.from('webhook_events').update({ status: 'RECEIVED', attempts }).eq('id', existing.id)
    return { mode: 'retry', id: existing.id, attempts }
  }
  if (isInboxMissing(error)) return { mode: 'unavailable', id: null, attempts: 0 }
  throw error
}

// Postgres 42703 = undefined_column; PostgREST 'PGRST204' = column not in its schema cache.
function isColumnMissing(err) {
  return err?.code === '42703' || err?.code === 'PGRST204' || /column .* (does not exist|of relation)|schema cache/i.test(err?.message || '')
}

// ROUND-3 AUDIT FIX (bug): outcome notes used to be stored in `error`, which the admin table
// prints in red — so a healthy PROCESSED row read "FULFILLED" or "reversed" as if it were a
// failure, and `error` could not be used to find real ones. Notes now live in `note`
// (migration 0036); `error` is written only for FAILED. Until 0036 is applied the column is
// missing, and the update falls back to the old shape rather than losing the status change.
// SECTION 8 (round 8, B1): returns true only when the status write LANDED (false: no inbox row, or the write
// failed — which is logged, never thrown). Resend callers use it to decide whether the recipient-bearing
// payload may be cleared: clearing it after a lost status write strands a RECEIVED row nothing can re-run.
async function markEvent(supabase, inbox, status, note) {
  if (!inbox?.id) return false
  const base = { status, processed_at: new Date().toISOString() }
  const patch = status === 'FAILED'
    ? { ...base, error: note || null, note: null }
    : { ...base, error: null, note: note || null }
  try {
    const { error } = await supabase.from('webhook_events').update(patch).eq('id', inbox.id)
    if (error && isColumnMissing(error)) {
      const { error: legacyErr } = await supabase.from('webhook_events').update({ ...base, error: note || null }).eq('id', inbox.id)
      if (legacyErr) { console.error('webhook_events status update failed:', legacyErr.message); return false }
      return true
    } else if (error) {
      console.error('webhook_events status update failed:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('webhook_events status update failed:', err.message)
    return false
  }
}

// Update an inbox row; columns that only exist after migration 0036 (`optional`) are dropped
// on the retry if the database says they are not there yet.
async function updateEvent(supabase, id, patch, optional = []) {
  let { error } = await supabase.from('webhook_events').update(patch).eq('id', id)
  if (error && isColumnMissing(error) && optional.some(k => k in patch)) {
    const slim = { ...patch }
    for (const k of optional) delete slim[k]
    ;({ error } = await supabase.from('webhook_events').update(slim).eq('id', id))
  }
  if (error) console.error('webhook_events update failed:', error.message)
  return error || null
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
        ? `A different payment (${result.ownerPaymentId || 'earlier'}) already fulfilled this scan. Nothing was re-generated and no commission was recorded for this one. ` +
          (result.autoRefund && result.autoRefund.status === 'SCHEDULED'
            ? `An automatic refund of the whole amount has been started; the refund.processed webhook will mark it REFUNDED (you are told separately if it fails).`
            : `It was NOT refunded automatically${result.autoRefund && result.autoRefund.reason ? ` (${result.autoRefund.reason})` : ''}. Refund it in Paystack — the refund.processed webhook will mark it REFUNDED.`)
        // Round 8: these outcomes now refund themselves too (refund.service.autoRefundUndeliverable).
        : (result.autoRefund && result.autoRefund.status === 'SCHEDULED'
            ? `Nothing was generated. An automatic refund of the whole amount has been started; the refund.processed webhook will mark it REFUNDED (you are told separately if it fails).`
            : `Nothing was generated. It was NOT refunded automatically${result.autoRefund && result.autoRefund.reason ? ` (${result.autoRefund.reason})` : ''}. Refund it in Paystack.`)), reference)
    return { status: 'PROCESSED', note: result.outcome }
  }
  if (result.outcome === 'UNKNOWN_REFERENCE') return { status: 'IGNORED', note: 'unknown reference' }
  if (result.outcome === 'IGNORED_STATUS') return { status: 'IGNORED', note: `payment is ${result.status}` }
  return { status: 'PROCESSED', note: result.outcome }
}

// Sum of the refunds Paystack itself reports as PROCESSED for this payment's transaction, or null
// when it cannot be read (no key, API error) — callers then keep their local total.
async function paystackRefundTotal(env, payment, { strict = false } = {}) {
  try {
    const list = await paystackService.listRefunds(env, payment.paystack_ref)
    return (list?.data || [])
      .filter(r => String(r.status || '').toLowerCase() === 'processed' && (!r.currency || r.currency === payment.currency))
      .reduce((sum, r) => sum + (Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0), 0)
  } catch (err) {
    console.error(`refund total lookup for ${payment.paystack_ref} failed:`, err.message)
    // WEBHOOKS ROUND 5 (B3): when Paystack's list is the ONLY authority for this event (see the caller),
    // a failed lookup must not be read as "no more refunds" — rethrow so the delivery answers 500.
    if (strict) throw err
    return null
  }
}

async function processRefund(c, supabase, event, eventId) {
  let payment = await fulfillment.findPaymentForEvent(supabase, event)
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
      `Could not match this refund to a payment.\npayload keys: ${Object.keys(event.data || {}).join(', ')}\n\nReview manually. If you create or repair the payment row, Replay this event from Admin → Webhooks.`, incident)
    // WEBHOOKS ROUND 5 (B2, bug): this used to be filed PROCESSED, which the inbox treats as "did its work" —
    // Replay answered 409, so once the missing payment row existed the refund could never be re-run. IGNORED
    // is what an unknown-reference charge.success already gets: finished for Paystack, replayable for an admin.
    return { status: 'IGNORED', note: 'payment not found' }
  }
  // ROUND-5 (B1): a refund for a payment still PENDING / ABANDONED / FAILED used to be filed PROCESSED
  // with a "payment is PENDING" note and never looked at again. That happens when charge.success was
  // lost or is still failing and the money is refunded in the Paystack dashboard meanwhile — and the
  // late charge.success (Paystack's retry, a sweep) then settled and fulfilled a refunded sale. A FULL
  // refund on such a payment now closes it as REFUNDED (below) so that can never happen.
  const unsettled = fulfillment.REVIVABLE_STATUSES.includes(payment.status)
  if (!unsettled && !['SUCCESS', 'DISPUTED', 'REFUNDED'].includes(payment.status)) {
    alert(c, 'Paystack refund.processed on a payment that was never SUCCESS',
      `reference: ${payment.paystack_ref}\nstatus: ${payment.status}\n\nNot actioned. Review manually.`, incident)
    return { status: 'PROCESSED', note: `payment is ${payment.status}` }
  }

  // Only an unambiguous FULL refund is actioned automatically. A partial (or
  // unstated) amount could mean a goodwill partial refund on a delivered
  // product — revoking the credential there would be wrong.
  //
  // ROUND-3 AUDIT FIX (feature gap): each event was judged alone, so two partial refunds that
  // together return the whole payment (2 × 50%) never reversed anything — just two alerts. The
  // refunds Paystack has already confirmed for this transaction are in this very inbox, so the
  // running total is `earlier PROCESSED refund.processed events + this one`.
  //
  // SECTION 8 AUDIT FIX (bug, fresh pass): the total must be computed under a lock — two distinct
  // partial refunds landing on two concurrent Worker invocations could each read the total before
  // the other was counted and neither would reverse the sale. record_refund_and_total locks the
  // payment row, records this event's amount ONCE (unique (payment_id, event_key), so a replay or
  // redelivery never adds twice) and returns the persisted total.
  //
  const refunded = Number(event.data?.amount)
  const ambiguous = refundIsAmbiguous(event)
  let total
  if (eventId) {
    // ROUND-4 (B1/B3): the RPC only RECORDS this event's amount in payment_refunds (it no longer
    // flips the inbox row to PROCESSED — handlePaystack does that once the work below is done)
    // and returns the persisted total. An ambiguous event is not recorded (p_count:false).
    let { data, error } = await supabase.rpc('record_refund_and_total', {
      p_payment_id: payment.id, p_reference: payment.paystack_ref, p_event_id: eventId, p_count: !ambiguous,
    })
    // Migration 0053 not applied yet: the 3-argument function of 0042 is still the only one.
    if (error && /p_count|could not find the function|42883|PGRST202/i.test(`${error.code || ''} ${error.message || ''}`))
      ({ data, error } = await supabase.rpc('record_refund_and_total', {
        p_payment_id: payment.id, p_reference: payment.paystack_ref, p_event_id: eventId,
      }))
    if (error) throw error
    total = Number(data)
    if (!Number.isFinite(total)) total = 0
  } else {
    // No inbox row to record against (webhook_events unavailable) — judge this event alone,
    // the same degraded behavior every other inbox-dependent feature here falls back to.
    total = 0
  }
  // An event that was not recorded (ambiguous, or no inbox row) is at least this refund.
  if ((ambiguous || !eventId) && Number.isFinite(refunded)) total = Math.max(total, refunded)

  // Not yet a full refund by our own books: ask Paystack. Its list of PROCESSED refunds on the
  // transaction is authoritative and cannot double-count, so it covers an event we deliberately
  // did not add (ambiguous), refunds from before payment_refunds existed, and a missed delivery.
  // Only reached when the local total falls short, so the common full refund costs no API call.
  //
  // WEBHOOKS ROUND 5 (B3, bug): for an ambiguous event (or one with no inbox row) the local total does not
  // include this refund, so Paystack's list is the only thing that can say whether the sale is now fully
  // refunded. A failed lookup used to fall through to "partial refund — alerted" and the event was closed
  // PROCESSED (200): Paystack never redelivered and the re-drive never looked at it, so a second equal
  // 50% refund left the sale paid until the rotating reversal sweep happened to reach it. Such an event now
  // throws on a failed lookup (500 → Paystack's retries and the hourly re-drive finish the job).
  // ROUND-7 (B4): an event that states no amount cannot be added to a local total either, so Paystack's list
  // is likewise the only authority for it (it used to be alerted as "partial/unknown" even when the list
  // proved the sale fully refunded, and a failed lookup closed it PROCESSED).
  const remoteIsOnlyAuthority = ambiguous || !eventId || !Number.isFinite(refunded)
  if (payment.amount_cents > 0 && total < payment.amount_cents) {
    const remote = await paystackRefundTotal(c.env, payment, { strict: remoteIsOnlyAuthority })
    if (remote != null) total = Math.max(total, remote)
  }
  const full = payment.amount_cents > 0 && total >= payment.amount_cents
  if (!full) {
    alert(c, 'Paystack refund.processed — partial/unknown amount, NOT actioned',
      `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\npaid: ${payment.amount_cents}\nthis refund: ${event.data?.amount ?? '(not in payload)'}\n` +
      `refunded in total so far (incl. this one): ${total}\n\n` +
      `Payment left as-is. If this should reverse the sale, use Admin → Payments → Reverse. ` +
      `(If further partial refunds bring the total up to the amount paid, the sale is reversed automatically.)`, incident)
    return { status: 'PROCESSED', note: `partial refund — alerted (${total} of ${payment.amount_cents})` }
  }

  if (unsettled) {
    const v = await fulfillment.refundUnsettledPayment(supabase, payment, { refundReference: refundRef })
    if (v.transitioned) {
      alert(c, 'Paystack refund processed — payment closed before it was ever settled',
        `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\nwas: ${payment.status}\n\n` +
        `Paystack refunded this transaction in full before this app had marked it paid (the charge.success webhook was lost or failing). ` +
        `Nothing had been delivered and no commission was recorded; the payment is now REFUNDED, so a late success event can no longer fulfil it.`, incident)
      return { status: 'PROCESSED', note: `refunded before settlement (was ${payment.status}) — payment closed` }
    }
    // It settled at the same instant: reverse the settled row the normal way.
    payment = v.current
    if (!payment || !['SUCCESS', 'DISPUTED', 'REFUNDED'].includes(payment.status))
      return { status: 'PROCESSED', note: `payment is ${payment?.status || 'gone'}` }
  }

  const done = await fulfillment.reversePayment(supabase, payment, {
    reason: 'REFUND', refundReference: refundRef, env: c.env, defer: p => runInBackground(c, p),
  })
  alert(c, 'Paystack refund processed — sale reversed',
    `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\n\n` +
    `payment → REFUNDED: ${done.transitioned ? 'yes' : 'already'}\n` +
    `partner commission reversed: ${done.ledger.reversed ? `yes${done.ledger.alreadyPaidOut ? ' (ALREADY PAID OUT — nets against their next payout)' : ''}` : done.ledger.reason}\n` +
    `public verification revoked: ${done.revoked ? 'yes' : 'no (not applicable / already revoked / another payment owns the scan)'}\n\n` +
    `Downloads were NOT revoked — delete the scan if you want the files gone.`, incident)
  return { status: 'PROCESSED', note: 'reversed' }
}

// WEBHOOKS ROUND 5 (B1): has this dispute's resolution already been processed? Paystack does not promise
// delivery order, and a charge.dispute.create can be re-run long after the fact (a 500 that was retried, the
// hourly re-drive of a FAILED row, an admin Replay). Marking DISPUTED after the resolution has been handled
// leaves the payment DISPUTED for good — nothing later clears it — so create checks the inbox first.
async function disputeResolutionSeen(supabase, event) {
  const id = event.data?.id
  if (id == null) return false
  const { data, error } = await supabase.from('webhook_events').select('id')
    .eq('provider', 'paystack').eq('event_key', `charge.dispute.resolve:${id}`).eq('status', 'PROCESSED').limit(1)
  if (error) {
    if (isInboxMissing(error)) return false   // no inbox → nothing to consult, behave as before
    throw error                               // transient → 500 → Paystack retries
  }
  return !!(data && data.length)
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
  let alreadyResolved = false
  if (event.event === 'charge.dispute.create' && payment?.status === 'SUCCESS')
    alreadyResolved = await disputeResolutionSeen(supabase, event)
  if (event.event === 'charge.dispute.create' && payment?.status === 'SUCCESS' && !alreadyResolved) {
    const { data: updated, error } = await supabase.from('payments')
      .update({ status: 'DISPUTED', disputed_at: new Date().toISOString() })
      .eq('id', payment.id).eq('status', 'SUCCESS').select('id')
    if (error) throw error
    marked = !!(updated && updated.length)
  }

  // ROUND-2 AUDIT (feature gap): dispute.resolve used to say only "no state
  // change", leaving the admin to work out which of Reverse / Clear applies. Paystack's resolutions
  // are `merchant-accepted` (money goes back to the customer — Paystack ALSO auto-accepts after 16
  // hours) and `declined` (you won).
  //
  // ROUND-5 (feature gap): the resolution is final the moment it arrives, so it is now ACTIONED, not
  // just described. Declined → DISPUTED goes back to SUCCESS (reversible, and it was only ever a hold).
  // Accepted → the money has already left, so the sale is reversed: REFUNDED, partner commission
  // reversed, public credential revoked, buyer told — the steps an admin used to have to remember to
  // click, possibly days after an auto-accept nobody saw. Only a FULL dispute is reversed: Paystack's
  // payload carries the disputed amount (`refund_amount`), and a smaller one is a partial chargeback
  // on a delivered product, left for a human like a partial refund.
  const resolution = String(d.resolution || '').toLowerCase()
  const current = payment ? `payment is currently ${payment.status}` : 'no payment could be resolved'
  const disputed = Number(d.refund_amount)
  const partialDispute = Number.isFinite(disputed) && disputed > 0 && payment && payment.amount_cents > 0 && disputed < payment.amount_cents
  let detail
  let auto = null
  if (event.event === 'charge.dispute.resolve') {
    if (/declin/.test(resolution)) {
      if (payment && payment.status === 'DISPUTED' && await fulfillment.clearDispute(supabase, payment)) {
        auto = 'dispute won — payment back to SUCCESS'
        detail = `Resolution: DECLINED — you WON. The payment was moved back from DISPUTED to SUCCESS automatically (it counts as revenue again). Nothing else to do.`
      } else
        detail = `Resolution: DECLINED — you WON. ${current}, so nothing was changed. If it is still DISPUTED, use Admin → Payments → Clear dispute.`
    } else if (/accept/.test(resolution)) {
      // SECTION 8 (round 8, G1): the dispute twin of the refund path's "closed before it was ever settled".
      // A dispute means Paystack took the money, so a payment this app still holds PENDING/ABANDONED/FAILED
      // is one whose charge.success was lost or is failing. If the dispute is lost and the row is left
      // revivable, that late success event (Paystack retries ~72h; the dispute auto-accepts after 16h)
      // fulfils a charged-back sale and earns commission. Close it REFUNDED instead — settlePayment treats
      // REFUNDED as final. Full disputes only, like the settled path.
      let live = payment
      let closedUnsettled = false
      if (payment && fulfillment.REVIVABLE_STATUSES.includes(payment.status) && !partialDispute) {
        const v = await fulfillment.refundUnsettledPayment(supabase, payment)
        if (v.transitioned) closedUnsettled = true
        else live = v.current   // it settled at the same instant: reverse the settled row the normal way
      }
      if (closedUnsettled) {
        auto = `dispute lost before settlement (was ${payment.status}) — payment closed`
        detail = `Resolution: ACCEPTED — the money went back to the customer, and this app had not yet marked the payment paid (the charge.success webhook was lost or failing; it was ${payment.status}). ` +
          `Nothing had been delivered and no commission was recorded; the payment is now REFUNDED, so a late success event can no longer fulfil it.`
      } else if (live && ['SUCCESS', 'DISPUTED'].includes(live.status) && !partialDispute) {
        const done = await fulfillment.reversePayment(supabase, live, { reason: 'DISPUTE', env: c.env, defer: p => runInBackground(c, p) })
        auto = 'dispute lost — sale reversed'
        detail = `Resolution: ACCEPTED — the money went back to the customer, so the sale was reversed automatically.\n\n` +
          `payment → REFUNDED: ${done.transitioned ? 'yes' : 'already'}\n` +
          `partner commission reversed: ${done.ledger.reversed ? `yes${done.ledger.alreadyPaidOut ? ' (ALREADY PAID OUT — nets against their next payout)' : ''}` : done.ledger.reason}\n` +
          `public verification revoked: ${done.revoked ? 'yes' : 'no (not applicable / already revoked / another payment owns the scan)'}\n` +
          `Downloads were NOT revoked — delete the scan if you want the files gone.`
      } else if (partialDispute)
        detail = `Resolution: ACCEPTED, but only ${disputed} of the ${payment.amount_cents} paid was disputed, so nothing was changed automatically. ${current}. Decide in Admin → Payments (Reverse if the whole sale should come back).`
      else
        detail = `Resolution: ACCEPTED — the money went back to the customer. ${current}, so nothing was changed automatically. Use Admin → Payments → Reverse if it still needs reversing.`
    } else
      detail = `Resolution "${d.resolution || 'unknown'}" is not one this app recognises. ${current}. Check the outcome in Paystack, then use Admin → Payments → Reverse (lost) or Clear dispute (won).`
  } else if (event.event === 'charge.dispute.remind') {
    detail = `Reminder: this dispute is still unresolved (Paystack auto-accepts and refunds the customer after 16 hours). ${current}. Respond in the Paystack dashboard.`
  } else if (event.event !== 'charge.dispute.create') {
    detail = `No state change for this event type; the dispute is tracked from charge.dispute.create.`
  } else if (marked) {
    detail = `The payment is now marked DISPUTED (excluded from revenue). Nothing else was changed: ` +
      `access and the public credential stay live and any partner commission stays put until the dispute is resolved. ` +
      `When Paystack reports the resolution this app acts on it: a lost dispute reverses the sale (refund, commission, credential), a won one puts the payment back to SUCCESS.`
  } else if (!payment) {
    detail = `Nothing was marked — no payment could be resolved for this reference. Review manually.`
  } else if (alreadyResolved) {
    detail = `Nothing was marked — this dispute's resolution was already processed (this create event arrived or was re-run after it), so the payment was left as it is (${payment.status}).`
  } else {
    detail = `Nothing was marked — the payment is currently ${payment.status}, not SUCCESS, so it was left as-is.`
  }

  alert(c, `Paystack ${event.event}`, `A "${event.event}" event was received.\n\n${summary}${detail}`,
    `${payment?.paystack_ref || fulfillment.referenceCandidates(event)[0] || d.id || ''}:${event.event}`)
  return { status: 'PROCESSED', note: auto || (alreadyResolved ? 'dispute already resolved — not re-marked' : (payment ? undefined : 'payment not found')) }
}

async function processEvent(c, supabase, event, eventId) {
  const type = event.event
  if (type === 'charge.success') return processChargeSuccess(c, supabase, event)
  if (type.startsWith('refund.')) return processRefund(c, supabase, event, eventId)
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

  // ROUND-6 (G4): a request from outside the allowlist is still refused (403), but it is no longer refused
  // BLIND. Paystack changing its outbound IPs would otherwise fail every webhook with only a console line;
  // so the signature is checked below, and a VALID one from an unlisted IP pages the owner (throttled).
  const allow = parseIpList(c.env.PAYSTACK_WEBHOOK_IPS)
  const sourceIp = c.req.header('cf-connecting-ip') || ''
  const ipRejected = allow.length > 0 && !allow.includes(sourceIp)
  if (ipRejected) console.error(`Webhook rejected: source IP ${sourceIp || '(none)'} is not in PAYSTACK_WEBHOOK_IPS`)

  const declared = Number.parseInt(c.req.header('content-length') || '', 10)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.text('Payload too large', 413)
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer())
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return c.text('Payload too large', 413)

  const expectedSig = await cryptoLib.hmacSha512Hex(secret, bodyBytes)
  const sigOk = cryptoLib.timingSafeEqual(expectedSig, c.req.header('x-paystack-signature') || '')
  if (ipRejected) {
    if (sigOk && await alertAllowed(c.env, 'webhook-alert-cooldown:paystack-ip-rejected'))
      alert(c, 'Paystack webhook refused — source IP not in PAYSTACK_WEBHOOK_IPS',
        `A correctly SIGNED Paystack webhook arrived from ${sourceIp || '(unknown)'}, which is not in PAYSTACK_WEBHOOK_IPS, and was refused with 403.\n\n` +
        `If Paystack changed its outbound IPs, every webhook is failing until the list is updated (payments are still recovered by the buyer's return visit and the hourly sweeps, ` +
        `but refunds and disputes are not). Update it: wrangler secret put PAYSTACK_WEBHOOK_IPS — or delete it to rely on the signature alone. ` +
        `Further occurrences in the next 30 minutes are logged but not emailed.`)
    return c.text('Forbidden', 403)
  }
  if (!sigOk) {
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
      eventKey: eventKeyFor(event, bodyHash), eventType: event.event, reference,
      payload: isActionableEvent(event.event) ? redactEvent(event) : null,
    })
  } catch (err) {
    console.error('webhook_events insert failed:', err.message)
    // ROUND-6 (B1): this is the one failure that answers 500 with NO inbox row and (until now) no alert — a
    // persistent cause (schema drift, a constraint, a payload Postgres refuses) was invisible, and Paystack
    // gives up after ~72h. charge.success and refunds have sweeps behind them; a dispute has none.
    if (await alertAllowedFor(c.env, 'inbox-write-failed', event.event, { globalMax: 10 }))
      alert(c, 'Webhook could not be recorded — Paystack will retry',
        `event: ${event.event}\nreference: ${reference || '(none)'}\nerror: ${err.message}\n\n` +
        `The webhook_events insert failed, so the event was NOT processed and was answered 500; Paystack redelivers for about 72 hours. ` +
        `If this keeps happening the cause is in the database (migration drift, a constraint, an outage) — fix it before Paystack gives up. ` +
        `A lost charge.success is recovered by the hourly sweep, a lost refund by the reversal sweep; a lost charge.dispute.create is not recovered by anything.`,
        `inbox-write:${event.event}`)
    return c.text('Temporary error', 500)   // Paystack retries
  }
  // An ambiguous refund event (no id, no refund_reference) shares its key with an equal-amount
  // sibling, so "seen before" proves nothing — run it again; processRefund is idempotent.
  if (inbox.mode === 'done') {
    if (!(event.event.startsWith('refund.') && refundIsAmbiguous(event))) return c.text('OK', 200)
    // ROUND-5 (B3): this is a re-run of an already-finished row. Count it as an attempt, so a failure
    // here is not announced as a first failure on every redelivery (see the catch below).
    inbox = { ...inbox, attempts: inbox.attempts + 1 }
    await updateEvent(supabase, inbox.id, { attempts: inbox.attempts })
  }
  if (inbox.mode === 'unavailable') {
    console.error('[CRITICAL] webhook_events table is missing — apply migration 0025. Processing without an inbox.')
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:inbox-missing'))
      alert(c, 'webhook_events table missing — apply migration 0025',
        'Webhooks are still being processed, but with no audit trail and no dedupe record.')
  }

  let outcome
  try {
    outcome = await processEvent(c, supabase, event, inbox.id)
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
// A RECEIVED row this old was not merely in flight: the Worker died mid-event.
const STUCK_RECEIVED_MS = 15 * 60 * 1000

// has_event / has_type: whether a payload exists to replay (its top-level key — `event` for Paystack, `type` for
// Resend) without shipping the payload itself in a list.
const LIST_COLS_BASE = 'id, provider, event_type, event_key, reference, status, attempts, error, received_at, processed_at, has_event:payload->>event, has_type:payload->>type'
const LIST_COLS_FULL = `${LIST_COLS_BASE}, note, replayed_by, replayed_at`

// GET /api/admin/webhook-events?status=&reference=&type=&page=&pageSize=
//   status=ATTENTION → FAILED + HELD + RECEIVED-for-over-15-minutes (what needs a person)
//   reference=       → substring of the payment reference (the inbox row's own reference)
//   type=            → exact event type, e.g. refund.processed
async function listWebhookEvents(c) {
  const page     = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') || '25', 10) || 25))
  const from = (page - 1) * pageSize
  const status = c.req.query('status')
  // Letters, digits and the few punctuation marks a Paystack reference / event type uses. Anything
  // else (commas and parentheses would break PostgREST's filter grammar) is dropped.
  const clean = v => String(v || '').trim().replace(/[^A-Za-z0-9_.:\-]/g, '').slice(0, 80)
  const reference = clean(c.req.query('reference'))
  const type = clean(c.req.query('type'))
  const providerQ = c.req.query('provider')

  const build = cols => {
    let q = getSupabase(c.env).from('webhook_events').select(cols, { count: 'exact' })
      .order('received_at', { ascending: false }).range(from, from + pageSize - 1)
    if (status === 'ATTENTION')
      q = q.or(`status.in.(FAILED,HELD),and(status.eq.RECEIVED,received_at.lt.${new Date(Date.now() - STUCK_RECEIVED_MS).toISOString()})`)
    else if (status && EVENT_STATUSES.includes(status)) q = q.eq('status', status)
    if (reference) q = q.ilike('reference', `%${reference}%`)
    if (type) q = q.eq('event_type', type)
    if (providerQ === 'paystack' || providerQ === 'resend') q = q.eq('provider', providerQ)
    return q
  }
  let { data, error, count } = await build(LIST_COLS_FULL)
  if (error && isColumnMissing(error)) ({ data, error, count } = await build(LIST_COLS_BASE))   // 0036 not applied yet
  if (error) throw error
  return c.json({ success: true, data: (data || []).map(r => ({
    id: r.id, provider: r.provider || 'paystack', eventType: r.event_type, eventKey: r.event_key, reference: r.reference, status: r.status,
    attempts: r.attempts,
    // `error` is a real failure (FAILED rows) and nothing else. Outcome notes are `note` now; rows
    // written before migration 0036 still carry theirs in `error`, so those are surfaced as notes.
    error: r.status === 'FAILED' ? (r.error || null) : null,
    note:  r.status === 'FAILED' ? (r.note || null) : (r.note || r.error || null),
    receivedAt: r.received_at, processedAt: r.processed_at,
    replayedBy: r.replayed_by || null, replayedAt: r.replayed_at || null,
    // ROUND-7 (B2): Replay only when there is a payload to re-run (non-actionable events keep none).
    replayable: REPLAYABLE.includes(r.status) && !!(r.has_event || r.has_type || r.payload),
  })), meta: { page, pageSize, total: count || 0 } })
}

// GET /api/admin/webhook-events/:id — the stored (redacted) payload, for "what exactly did
// Paystack send?" without going to SQL.
async function getWebhookEvent(c) {
  const { data: row, error } = await getSupabase(c.env).from('webhook_events')
    .select('id, provider, event_type, event_key, reference, status, attempts, payload, received_at, processed_at')
    .eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Event not found.' }, 404)
  return c.json({ success: true, data: {
    id: row.id, provider: row.provider || 'paystack', eventType: row.event_type, eventKey: row.event_key, reference: row.reference, status: row.status,
    attempts: row.attempts, receivedAt: row.received_at, processedAt: row.processed_at, payload: row.payload || null,
  } })
}

// Re-run a stored event through the same handlers a live delivery uses. Shared by the admin
// replay and the hourly re-drive. `by` (an admin's user id) is recorded when given.
// The top-level key that names a stored event: `event` (Paystack) or `type` (Resend).
function storedKind(row) {
  const p = row && row.payload
  if (!p || typeof p !== 'object') return null
  const k = row.provider === 'resend' ? p.type : p.event
  return typeof k === 'string' ? k : null
}

async function runStoredEvent(c, supabase, row, { by = null, redrive = false } = {}) {
  const attempts = (row.attempts || 1) + 1
  const inbox = { id: row.id, attempts }
  const patch = { status: 'RECEIVED', attempts }
  if (by) { patch.replayed_by = by; patch.replayed_at = new Date().toISOString() }
  if (redrive) patch.redrives = (row.redrives || 0) + 1
  await updateEvent(supabase, row.id, patch, ['replayed_by', 'replayed_at', 'redrives'])
  try {
    const resend = row.provider === 'resend' ? require('./resend-webhook.controller') : null
    const outcome = resend
      ? await resend.processResendEvent(c, supabase, row.payload)
      : await processEvent(c, supabase, row.payload, row.id)
    const marked = await markEvent(supabase, inbox, outcome.status, outcome.note)
    // recipient addresses: kept only while unfinished — and a row whose status write was lost IS unfinished
    if (resend && marked) await resend.clearResendPayload(supabase, row.id)
    return { ok: true, outcome }
  } catch (err) {
    await markEvent(supabase, inbox, 'FAILED', err.message)
    return { ok: false, error: err }
  }
}

// POST /api/admin/webhook-events/:id/replay
// Re-runs the stored (redacted) event through the same handlers a live delivery
// uses. Safe to repeat: every handler is idempotent (atomic claims, unique ledger
// index). Note the redaction: card authorisation data is not stored (and since round 7 the
// reusable card token is not kept anywhere), so a replay has nothing of that kind to redo.
async function replayWebhookEvent(c) {
  const supabase = getSupabase(c.env)
  const { data: row, error } = await supabase.from('webhook_events')
    .select('id, provider, status, attempts, payload, event_type, reference').eq('id', c.req.param('id')).maybeSingle()
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Event not found.' }, 404)
  if (!REPLAYABLE.includes(row.status))
    return c.json({ success: false, message: `This event is ${row.status} — it already did its work; nothing to replay.` }, 409)
  if (!storedKind(row))
    return c.json({ success: false, message: 'No stored payload to replay.' }, 422)

  const actor = c.get ? c.get('user') : null
  const r = await runStoredEvent(c, supabase, row, { by: actor?.id || null })
  // ROUND-6 (G1): a replay can reverse a sale, close a payment, or clear a dispute — the same class of action
  // payments.controller audits. `replayed_by` on the row is overwritten by the next replay and pruned with it.
  await logAdminAction(c, supabase, 'webhook.replay', 'webhook_event', row.id, {
    eventType: row.event_type, provider: row.provider || 'paystack', reference: row.reference || null, from: row.status,
    result: r.ok ? r.outcome.status : 'FAILED',
  })
  if (!r.ok) return c.json({ success: false, message: `Replay failed: ${r.error.message}` }, 500)
  return c.json({ success: true, data: { status: r.outcome.status, note: r.outcome.note || null,
    hint: r.outcome.status === 'HELD' ? 'Still held — an amount/currency mismatch needs Admin → Payments → Recheck (accept amount).' : null } })
}

// ROUND-6 (G3): payloads stored before isActionableEvent existed. Only IGNORED rows of types no handler acts on;
// charge.success / refund.* / charge.dispute.* keep theirs (an unknown-reference charge.success is IGNORED and
// replayable, so it must keep its payload). Best-effort, never throws, no migration.
async function scrubUnactionablePayloads(supabase) {
  try {
    const { error } = await supabase.from('webhook_events').update({ payload: null })
      .eq('status', 'IGNORED').not('payload', 'is', null)
      .neq('event_type', 'charge.success')
      .not('event_type', 'like', 'refund.%')
      .not('event_type', 'like', 'charge.dispute%')
    if (error) console.error('webhook payload scrub failed:', error.message)
    return !error
  } catch (err) {
    console.error('webhook payload scrub error:', err.message)
    return false
  }
}

// ── dead-letter handling (hourly cron, see index.js) ─────────────────────────
// ROUND-3 AUDIT (feature gap): everything above depends on Paystack redelivering. After its
// retry window (about 72 hours) a FAILED event, or one stuck at RECEIVED because the Worker
// died, was never touched again; the alert fired on the first failure only, and nothing on
// the dashboard counted them. This re-drives them (safe: handlers are idempotent) up to a cap,
// says so ONCE when the cap is hit, and escalates a HELD event that has sat for a day — that
// one needs a human decision, not a retry.
const REDRIVE_MIN_AGE_MS = 20 * 60 * 1000
const MAX_REDRIVES = 8
const HELD_ESCALATE_MS = 24 * 60 * 60 * 1000
const REDRIVE_PER_RUN = 10

// G1 (round 4): a HELD event is closed out once its payment is no longer waiting on a human —
// SUCCESS (an admin accepted the amount in Recheck, or the buyer's verify / a sweep settled it),
// DISPUTED or REFUNDED. Before this, nothing ever touched a HELD row again: the dashboard count
// stayed lit and the day-old escalation kept saying "a customer may have paid and received
// nothing" about a payment that had long been delivered. `reference` scopes it to one payment
// (the admin Recheck calls it so the dashboard clears at once); otherwise the oldest HELD rows.
// Best-effort and never throws.
const HELD_RESOLVED_PAYMENT_STATUSES = ['SUCCESS', 'DISPUTED', 'REFUNDED']
async function closeResolvedHeldEvents(supabase, { reference = null, limit = 100 } = {}) {
  const closed = []
  try {
    let q = supabase.from('webhook_events').select('id, reference').eq('status', 'HELD')
    q = reference ? q.eq('reference', reference) : q.order('received_at', { ascending: true }).limit(limit)
    const { data: held, error } = await q
    if (error || !held || !held.length) return closed
    const refs = [...new Set(held.map(h => h.reference).filter(Boolean))]
    if (!refs.length) return closed
    const { data: pays, error: payErr } = await supabase.from('payments').select('paystack_ref, status').in('paystack_ref', refs)
    if (payErr || !pays) return closed
    const statusOf = new Map(pays.map(p => [p.paystack_ref, p.status]))
    for (const h of held) {
      const st = statusOf.get(h.reference)
      if (!HELD_RESOLVED_PAYMENT_STATUSES.includes(st)) continue
      const base = { status: 'PROCESSED', processed_at: new Date().toISOString(), error: null }
      // `.eq('status','HELD')` so a row someone replayed in the meantime is never overwritten.
      let { error: upErr } = await supabase.from('webhook_events')
        .update({ ...base, note: `resolved — payment is ${st}` }).eq('id', h.id).eq('status', 'HELD')
      if (upErr && isColumnMissing(upErr))
        ({ error: upErr } = await supabase.from('webhook_events').update({ ...base, error: `resolved — payment is ${st}` }).eq('id', h.id).eq('status', 'HELD'))
      if (upErr) console.error('closeResolvedHeldEvents update failed:', upErr.message)
      else closed.push(h.id)
    }
  } catch (err) {
    console.error('closeResolvedHeldEvents error:', err.message)
  }
  return closed
}

// ROUND-7 (B2): a RECEIVED row of a type no handler acts on keeps no payload (see isActionableEvent), so when
// its status update was lost it can neither be re-run nor replayed, and sat in "needs attention" for good.
// Nothing happened for it to finish — close it. Actionable types are left alone (a lost charge.success matters).
// ROUND 8 (B1): no longer Paystack-only. Resend rows are payload-less once cleared; before the markEvent/clear
// ordering fix a lost status write could strand one RECEIVED forever (it completed — only the status was lost),
// and nothing else would ever close it. Resend event types are never in the Paystack exclusions below.
async function closeUnrunnableReceived(supabase, { now = Date.now() } = {}) {
  try {
    const iso = new Date(now).toISOString()
    const { data, error } = await supabase.from('webhook_events')
      .update({ status: 'IGNORED', processed_at: iso, note: 'closed — unfinished, nothing stored to re-run' })
      .eq('status', 'RECEIVED').is('payload', null)
      .lt('received_at', new Date(now - REDRIVE_MIN_AGE_MS).toISOString())
      .neq('event_type', 'charge.success').not('event_type', 'like', 'refund.%').not('event_type', 'like', 'charge.dispute%')
      .select('id')
    if (error) { console.error('closeUnrunnableReceived failed:', error.message); return [] }
    return (data || []).map(r => r.id)
  } catch (err) {
    console.error('closeUnrunnableReceived error:', err.message)
    return []
  }
}

async function redriveStaleEvents(env, ctx, { now = Date.now() } = {}) {
  const supabase = getSupabase(env)
  const c = { env, executionCtx: ctx }
  const result = { redriven: [], recovered: [], exhausted: [], heldClosed: [], heldEscalated: [], unrunnableClosed: [], error: null }

  // B2 (round 4): rows at/over MAX_REDRIVES, or without a payload, can never be re-run and are
  // never pruned (only PROCESSED/IGNORED are) — left in this oldest-first window they pile up at
  // the front and, at REDRIVE_PER_RUN * 3 of them, starve every newer failure. The window now
  // holds only rows that can actually run; exhausted rows get their own (alert-only) query below.
  //
  // ROUND-7 (B3): the budget is the `redrives` column (this re-drive's own runs). It used to be `attempts`, which
  // every Paystack redelivery also increments, so a failing event spent it in a few hours of Paystack's retries and
  // was then announced as abandoned while Paystack was still trying. Before migration 0065 the column does not
  // exist: both queries fall back to `attempts`, as before.
  const base = 'id, provider, status, attempts, event_type, reference, received_at'
  const old = new Date(now - REDRIVE_MIN_AGE_MS).toISOString()
  const runnable = (withCol) => supabase.from('webhook_events')
    .select(`${base}, payload${withCol ? ', redrives' : ''}`)
    .in('status', ['FAILED', 'RECEIVED']).lt('received_at', old)
    .lt(withCol ? 'redrives' : 'attempts', MAX_REDRIVES)
    .not('payload', 'is', null)
    .order('received_at', { ascending: true }).limit(REDRIVE_PER_RUN * 3)
  let useRedrives = true
  let { data: rows, error } = await runnable(true)
  if (error && isColumnMissing(error)) { useRedrives = false; ({ data: rows, error } = await runnable(false)) }
  if (error) { result.error = error.message; return result }

  let ran = 0
  for (const row of rows || []) {
    if (ran >= REDRIVE_PER_RUN) break
    if (!storedKind(row)) continue
    ran++
    result.redriven.push(row.id)
    const r = await runStoredEvent(c, supabase, row, { redrive: useRedrives })
    if (r.ok) result.recovered.push({ id: row.id, event: row.event_type, reference: row.reference, status: r.outcome.status })
  }

  // Exhausted: said ONCE per row (7-day cooldown), newest first so a fresh failure is never hidden
  // behind old ones. Their payload stays viewable and replayable from Admin → Webhooks.
  const spentQ = () => supabase.from('webhook_events')
    .select('id, provider, status, attempts, event_type, reference')
    .in('status', ['FAILED', 'RECEIVED']).lt('received_at', old)
    .gte(useRedrives ? 'redrives' : 'attempts', MAX_REDRIVES)
    .order('received_at', { ascending: false }).limit(25)
  const { data: spent, error: spentErr } = await spentQ()
  if (!spentErr) for (const row of spent || []) {
    if (!(await alertAllowed(env, `webhook-alert-cooldown:redrive-exhausted:${row.id}`, 7 * 24 * 3600))) continue
    result.exhausted.push(row.id)
    alert(c, 'Webhook event is stuck — automatic retries exhausted',
      `provider: ${row.provider || 'paystack'}\nevent: ${row.event_type}\nreference: ${row.reference || '(none)'}\nstatus: ${row.status}, deliveries: ${row.attempts}\n\n` +
      `The hourly re-drive has run this event ${MAX_REDRIVES} times without success${row.provider === 'resend' ? '' : ' (the provider may still be redelivering it on its own schedule)'}. ` +
      `Open Admin → Webhooks, look at the payload, and Replay it once the cause (see its error) is fixed.`, `${row.reference || row.id}:stuck`)
  }

  if (result.recovered.length)
    alert(c, `Webhook re-drive recovered ${result.recovered.length} event(s)`,
      `These events had failed (or been left unfinished) and were re-run successfully:\n\n` +
      result.recovered.map(r => `${r.event}  ${r.reference || ''}  → ${r.status}`).join('\n'), 'redrive-recovered')

  result.unrunnableClosed = await closeUnrunnableReceived(supabase, { now })

  // G1: close what a person (or another path) has already settled, THEN escalate what is left.
  result.heldClosed = await closeResolvedHeldEvents(supabase)

  const { data: held, error: heldErr } = await supabase.from('webhook_events')
    .select('id, event_type, reference, note, error').eq('status', 'HELD')
    .lt('received_at', new Date(now - HELD_ESCALATE_MS).toISOString())
    .order('received_at', { ascending: true }).limit(50)
  if (!heldErr) for (const h of held || []) {
    if (result.heldEscalated.length >= 10) break
    if (!(await alertAllowed(env, `webhook-alert-cooldown:held-escalate:${h.id}`, 3 * 24 * 3600))) continue
    result.heldEscalated.push(h.id)
    alert(c, 'A held payment event has been waiting over a day',
      `event: ${h.event_type}\nreference: ${h.reference || '(none)'}\nreason: ${h.note || h.error || 'amount/currency mismatch'}\n\n` +
      `A customer may have paid and received nothing. Admin → Payments → Recheck (accept amount) if the payment is genuine, or refund it.`, `${h.reference || h.id}:held`)
  }
  return result
}

// ── delivery health ──────────────────────────────────────────────────────────
// ROUND-5 (feature gap): every recovery above assumes webhooks arrive. When they stop — the webhook
// URL changed or was never saved in the Paystack dashboard, a rotated key now fails every signature —
// payments keep getting settled by the buyer's /verify call and the hourly sweeps, so nothing looks
// broken; the only symptom is that charge.success never shows up in the inbox. This reads exactly
// that: when the last event / charge.success arrived, and how many recent paid sales have NO
// charge.success on record (older than a grace period, so a webhook still on its way doesn't count).
// Best-effort and never throws; `available: false` when the inbox table cannot be read.
const HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const HEALTH_GRACE_MS = 30 * 60 * 1000
const HEALTH_MAX_PAYMENTS = 200

async function computeWebhookHealth(supabase, { now = Date.now() } = {}) {
  const out = { available: true, lastEventAt: null, lastChargeSuccessAt: null, paidChecked: 0, paidWithoutEvent: 0, missingReferences: [], lastResendEventAt: null }
  try {
    const latest = async type => {
      let q = supabase.from('webhook_events').select('received_at').eq('provider', 'paystack')   // Resend events have their own stamp below
      if (type) q = q.eq('event_type', type)
      const { data, error } = await q.order('received_at', { ascending: false }).limit(1)
      if (error) throw error
      return data && data[0] ? data[0].received_at : null
    }
    out.lastEventAt = await latest(null)
    out.lastChargeSuccessAt = await latest('charge.success')

    const { data: pays, error: payErr } = await supabase.from('payments')
      .select('paystack_ref, amount_cents, status, created_at')
      .in('status', ['SUCCESS', 'DISPUTED', 'REFUNDED'])
      .gte('created_at', new Date(now - HEALTH_WINDOW_MS).toISOString())
      .lt('created_at', new Date(now - HEALTH_GRACE_MS).toISOString())
      .order('created_at', { ascending: false }).limit(HEALTH_MAX_PAYMENTS)
    if (payErr) throw payErr
    // Free-credit redemptions never touch Paystack, so they never have a webhook.
    const refs = (pays || []).filter(p => p.paystack_ref && !String(p.paystack_ref).startsWith('credit:') && p.amount_cents > 0).map(p => p.paystack_ref)
    out.paidChecked = refs.length
    if (refs.length) {
      const seen = new Set()
      for (let i = 0; i < refs.length; i += 100) {
        const { data: evs, error: evErr } = await supabase.from('webhook_events')
          .select('reference').eq('event_type', 'charge.success').in('reference', refs.slice(i, i + 100))
        if (evErr) throw evErr
        for (const e of evs || []) seen.add(e.reference)
      }
      const missing = refs.filter(r => !seen.has(r))
      out.paidWithoutEvent = missing.length
      out.missingReferences = missing.slice(0, 5)
    }
  } catch (err) {
    out.available = false
    console.error('webhook health error:', err && err.message)
  }
  // ROUND-6 (G2): when the Resend webhook last delivered anything (stamped by resend-webhook.controller).
  // Separate from the Paystack reads above so a missing system_state row can never mark them unavailable.
  try {
    const { data } = await supabase.from('system_state').select('value').eq('key', 'resend_webhook').maybeSingle()
    out.lastResendEventAt = data?.value?.last_event_at || null
  } catch (_) { /* optional */ }
  return out
}

// GET /api/admin/webhook-events/health
async function getWebhookHealth(c) {
  return c.json({ success: true, data: await computeWebhookHealth(getSupabase(c.env)) })
}

module.exports = { recordEvent, markEvent, updateEvent, storedKind, closeUnrunnableReceived, computeWebhookHealth, getWebhookHealth, handlePaystack, listWebhookEvents, getWebhookEvent, replayWebhookEvent, redriveStaleEvents, closeResolvedHeldEvents, scrubUnactionablePayloads, isActionableEvent, eventKeyFor, refundIsAmbiguous, redactEvent, MAX_BODY_BYTES }
