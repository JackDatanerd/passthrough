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
// 13. ROUND-10 AUDIT (section 8, independent pass — no migration):
//     * G1: sweepDisputes — the dispute backstop. A lost charge.dispute.create / .resolve was recovered by nothing
//       (Paystack auto-accepts after ~16h). The hourly sweep lists Paystack's disputes and runs any that this app's
//       payments have not caught up with through processDispute, exactly as a live delivery would.
//     * G3: PAYSTACK_SECRET_KEY_PREVIOUS is accepted too, so a key rotation does not 401 (and page as an attack)
//       every delivery Paystack is still retrying with the old signature.
//     * G4: a SIGNED body that is not a Paystack event is logged and (throttled) alerted instead of vanishing.
//     * B2: the PAYSTACK_WEBHOOK_IPS comparison is address-aware (case, brackets, IPv4-mapped), like env.js's check.
//     * B3: the admin inbox answers an out-of-range page with an empty page, not a 500.
//     * B4: a dispute left DISPUTED by a create/resolve race is cleared by sweepDisputes.
//     * B5: a re-driven event that ended HELD is no longer reported as "recovered".
//     (B1, the partner-reversal email blocking the 200, is fixed in fulfillment.service reversePayment.)
//
// 14. ROUND-11 AUDIT (section 8, independent pass — no migration):
//     * G1: a failed automatic refund of a duplicate / undeliverable payment is retried by
//       reconcile.service sweepFailedAutoRefunds (the "next webhook redelivery retries it" promise in the alerts was
//       false: a PROCESSED charge.success is never redelivered). refund.failed's alert now says what happens next.
//     * G2: admin Dismiss (POST /admin/webhook-events/:id/dismiss) closes a FAILED / HELD / RECEIVED row that can never
//       succeed — it used to count on the dashboard and re-email the owner for ever.
//     * G3: delivery health only counts paid sales NEWER than the last charge.success received, so it recovers as soon
//       as webhooks flow again instead of staying red (and /healthz 503) for 7 days.
//     * G4: sweepDisputes pages through Paystack's list and pages the owner about a PARTIAL accepted dispute it leaves alone.
//     * G5: the admin list takes from/to dates; a replay that ends IGNORED no longer toasts as a success.
//     * B1: sweepDisputes no longer re-marks a payment DISPUTED after an admin cleared it (it asks the inbox first).
//     * B3: a re-run that ends IGNORED is not announced as "recovered".   * B4: closeResolvedHeldEvents pages past a backlog.
//
// 15. ROUND-24 AUDIT (section 8, independent pass — migration 0103):
//     * B1: a dispute event that matches no payment ends IGNORED (replayable), like a refund does — it used to be PROCESSED, so Replay answered
//       409 right after the alert told the owner to repair the payment row and Replay.
//     * B2: the stored payload, reference and key are cleaned of NUL / lone-surrogate characters (Postgres refuses them in jsonb/text, which
//       would answer a signed event 500 for ever); a payload the database still refuses is dropped and the event processed without it.
//     * B3: the Resend "deliveries refused" notice allows for the throttled Resend health stamp (see webhookRejections.RESEND_STAMP_LAG_MS).
//     * B4: delivery health judges a sale by when it was PAID (paid_at), not when checkout began.
//     * B5: the old-open-disputes sweep rotates on its own payments.dispute_checked_at instead of last_reconciled_at, which is the
//       reversal sweep's skip marker.
//     * G1: refund.failed stamps payments.refund_failed_at (Admin -> Payments shows it while the payment still holds the money); the full refund clears it.
//
// 16. ROUND-26 AUDIT (section 8, independent pass — no migration):
//     * B1: sweepDisputes re-ran an already-handled charge.dispute.resolve for an OLDER dispute every hour while the payment tracked a newer,
//       still-open one (re-emailing the owner and using a per-run slot); it now skips a resolution for a dispute the payment does not track.
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
const { parseCidr, ipInCidr } = require('../lib/clientIp')
const { buildProofPdf } = require('../lib/proofPdf')
const { readBodyCapped } = require('../lib/readBody')
const constants = require('../config/constants')
const rejections = require('../lib/webhookRejections')
const { stripNul } = require('../middleware/bodyLimit')
// Best-effort, after the answer is decided: a refusal is stamped in the background and can never change or delay the HTTP response.
const noteRejected = (c, provider, reason) => runInBackground(c, Promise.resolve().then(() => rejections.recordRejection(c.env, provider, reason, getSupabase(c.env))))

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

// ROUND-10 (B2): exact-string matching made a list that env.js accepted (brackets, upper-case or IPv4-mapped IPv6) match
// nothing. Entries are now parsed like env.js parses them; a single address stays an exact match (a /32 or /128), and
// an optional `address/prefix` works too. Unusable entries match nothing.
function parseIpList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean)
}
function ipListAllows(raw, ip) {
  const entries = parseIpList(raw).map(parseCidr).filter(Boolean)
  return entries.some(e => ipInCidr(ip, e))
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
// ROUND-12 (W4): Paystack's dispute LIST (what sweepDisputes reads) spells these fields camelCase (dueAt, resolvedAt,
// createdAt) where the webhook uses snake_case, so a swept dispute lost its deadline and resolution time. Either spelling
// is kept, under the snake_case name the handlers read.
const DISPUTE_CAMEL = { due_at: 'dueAt', resolved_at: 'resolvedAt', created_at: 'createdAt' }
function minimalDisputeEvent(ev) {
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
  const data = {}
  for (const k of DISPUTE_KEEP) {
    if (isScalar(d[k])) data[k] = d[k]
    else if (DISPUTE_CAMEL[k] && isScalar(d[DISPUTE_CAMEL[k]])) data[k] = d[DISPUTE_CAMEL[k]]
  }
  if (d.transaction && typeof d.transaction === 'object') {
    const tx = {}
    for (const k of DISPUTE_TX_KEEP) if (isScalar(d.transaction[k])) tx[k] = d.transaction[k]
    data.transaction = tx
  } else if (typeof d.transaction === 'string' && d.transaction) {
    // a bare reference string (referenceCandidates reads it) — the same value, so nothing is lost by normalising a live event
    data.transaction = d.transaction
  }
  return { event: ev.event, data }
}
// ROUND-24 (B2): Postgres refuses U+0000 in text/jsonb and a lone surrogate in jsonb. A signed event carrying either in a field that is kept
// (a refund note, a metadata value) made the inbox insert fail, the handler answer 500, and Paystack redeliver the same poison for ~72 hours.
// bodyLimit already cleans ordinary request bodies this way; the stored copy of a webhook is cleaned the same way. Only what is STORED is changed.
const cleanText = v => (typeof v === 'string' ? stripNul(v) : v)
// ROUND-25 (B1): refund events were redacted by a denylist, so `refunded_by` (the merchant staff member's email), `customer_note` (free text
// a buyer or admin typed) and `merchant_note` were kept for 400 days and shown in the admin payload viewer. Refunds now keep an ALLOWLIST,
// like disputes: only what the handlers and record_refund_and_total read.
const REFUND_KEEP = ['id', 'status', 'amount', 'currency', 'transaction_reference', 'refund_reference', 'reference', 'created_at', 'createdAt', 'expected_at']
function minimalRefundEvent(ev) {
  const d = ev.data && typeof ev.data === 'object' ? ev.data : {}
  const data = {}
  for (const k of REFUND_KEEP) if (isScalar(d[k])) data[k] = d[k]
  if (d.refund_reference === null) data.refund_reference = null   // keeps refundIsAmbiguous() answering the same after a round trip
  if (d.transaction && typeof d.transaction === 'object') {
    const tx = {}
    for (const k of DISPUTE_TX_KEEP) if (isScalar(d.transaction[k])) tx[k] = d.transaction[k]
    data.transaction = tx
  } else if (typeof d.transaction === 'string' && d.transaction) data.transaction = d.transaction
  return { event: ev.event, data }
}
function redactEvent(event) {
  try {
    const copy = JSON.parse(JSON.stringify(event))
    if (typeof copy?.event === 'string' && copy.event.startsWith('charge.dispute')) return stripNul(minimalDisputeEvent(copy))
    if (typeof copy?.event === 'string' && copy.event.startsWith('refund.')) return stripNul(minimalRefundEvent(copy))
    if (copy?.data && typeof copy.data === 'object') for (const k of STRIP_KEYS) delete copy.data[k]
    if (copy?.data?.transaction && typeof copy.data.transaction === 'object')
      for (const k of STRIP_KEYS) delete copy.data.transaction[k]
    return stripNul(copy)
  } catch (_) { return null }
}
const DB_TEXT_REFUSED = new Set(['22021', '22P05', '22P02'])
const isTextRefused = err => !!err && DB_TEXT_REFUSED.has(err.code) && /unicode|surrogate|byte sequence|type json|\\u0000/i.test(String(err.message || ''))

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

// Webhooks round 16 (B1): when did this row last START being worked on? `received_at` is the FIRST receipt and never moves, so a
// FAILED row that Paystack redelivered, an admin replayed or the re-drive picked up was RECEIVED-with-an-old-timestamp — i.e.
// "stuck" the instant it was picked up: Replay/Dismiss were offered, the attention list and dashboard counted it, and the hourly
// re-drive ran it alongside the live delivery. `last_attempt_at` (migration 0090) is stamped at every pickup and is what every
// "is this stuck?" test reads. Before 0090 the column does not exist: the first query that says so flips this to the old clock.
// Webhooks round 17 (B1): that flip used to be permanent for the life of the Worker instance. PostgREST's schema cache can lag a migration
// by seconds to minutes (PGRST204 "could not find the 'last_attempt_at' column"), so a deploy that races migration 0090 pinned every
// warm instance to the old clock — the round-16 bug (a freshly retried FAILED row instantly "stuck" and re-driven beside the live
// delivery) came straight back and the heartbeat stamp stopped, until the instance happened to recycle. The downgrade now expires:
// after STALE_COL_RETRY_MS the next query probes the real column again (and re-downgrades, for another interval, if it is still missing).
const STALE_COL_RETRY_MS = 5 * 60 * 1000
let staleCol = 'last_attempt_at'
let staleColDowngradedAt = 0
function staleColumn() {
  if (staleCol !== 'last_attempt_at' && Date.now() - staleColDowngradedAt >= STALE_COL_RETRY_MS) staleCol = 'last_attempt_at'
  return staleCol
}
function legacyStaleCol(err) {
  if (staleColumn() === 'last_attempt_at' && isColumnMissing(err) && /last_attempt_at/.test(err?.message || '')) {
    staleCol = 'received_at'; staleColDowngradedAt = Date.now(); return true
  }
  return false
}
const touchPatch = () => (staleColumn() === 'last_attempt_at' ? { last_attempt_at: new Date().toISOString() } : {})
async function withStaleCol(fn) {
  let r = await fn()
  if (r && r.error && legacyStaleCol(r.error)) r = await fn()
  return r
}
const staleSelect = cols => (staleColumn() === 'last_attempt_at' ? `${cols}, last_attempt_at` : cols)

// mode: 'new' | 'retry' (seen before but not finished) | 'done' | 'unavailable'
async function recordEvent(supabase, { eventKey, eventType, reference, payload, provider = 'paystack' }) {
  eventKey = cleanText(eventKey); eventType = cleanText(eventType); reference = cleanText(reference)
  const insert = p => supabase.from('webhook_events')
    .insert({ provider, event_key: eventKey, event_type: eventType, reference, payload: p })
    .select('id, attempts').single()
  let { data, error } = await insert(payload)
  let payloadDropped = false
  if (error && payload != null && isTextRefused(error)) {
    // Last resort (round 24, B2): still refused after cleaning. Record the event without its body rather than refuse it for ever; the live
    // delivery is processed from memory, so only a later Replay is lost.
    console.error('webhook_events payload refused by the database — recording the event without it:', error.message)
    ;({ data, error } = await insert(null))
    payloadDropped = true
  }
  // ROUND-25 (B2): `payloadMissing` = the caller meant to store a body and the row has none (the fallback above, or a row an earlier delivery
  // wrote without one). A refund handler reads its amount from that stored body (record_refund_and_total), so it must not trust the local total.
  if (!error) return { mode: 'new', id: data?.id, attempts: data?.attempts || 1, payloadMissing: payloadDropped }

  if (error.code === '23505') {
    const { data: existing, error: selErr } = await supabase.from('webhook_events')
      .select(EXISTING_COLS).eq('provider', provider).eq('event_key', eventKey).maybeSingle()
    if (selErr) throw selErr
    if (!existing) return { mode: 'new', id: null, attempts: 1 }
    const payloadMissing = payload != null && !existing.has_body && !existing.has_type
    if (['PROCESSED', 'IGNORED', 'HELD'].includes(existing.status)) return { mode: 'done', id: existing.id, attempts: existing.attempts || 1, payloadMissing }
    const attempts = (existing.attempts || 1) + 1
    // Webhooks round 17 (B2): the bump used to be keyed on `id` alone, so a redelivery that read FAILED/RECEIVED a moment before another worker
    // (admin Replay, the hourly re-drive, a parallel delivery) finished the row wrote it BACK to RECEIVED — a finished row shown as in-flight
    // and counted as stuck once the clock aged. Now it only moves a row that is still unfinished; if it already finished, this delivery is a duplicate.
    const { data: bumped } = await withStaleCol(() => supabase.from('webhook_events')
      .update({ status: 'RECEIVED', attempts, ...touchPatch() }).eq('id', existing.id).in('status', ['FAILED', 'RECEIVED']).select('id'))
    if (Array.isArray(bumped) && bumped.length === 0) {
      // Nothing moved: either somebody finished the row (a duplicate delivery) or it is in a state this guard does not know. Only a row that is
      // positively finished is answered "done"; anything else is processed as before, so the guard can never turn a retry into a silent drop.
      const { data: now } = await supabase.from('webhook_events').select('status').eq('id', existing.id).maybeSingle()
      if (now && ['PROCESSED', 'IGNORED', 'HELD'].includes(now.status)) return { mode: 'done', id: existing.id, attempts: existing.attempts || 1, payloadMissing }
    }
    // Heal a row that was stored without its body: this delivery carries it (best effort; a refusal just leaves the flag set).
    let healed = false
    if (payloadMissing) {
      try { const { error: hErr } = await supabase.from('webhook_events').update({ payload }).eq('id', existing.id).is('payload', null); healed = !hErr } catch (_) { healed = false }
    }
    return { mode: 'retry', id: existing.id, attempts, payloadMissing: payloadMissing && !healed }
  }
  if (isInboxMissing(error)) return { mode: 'unavailable', id: null, attempts: 0 }
  throw error
}

// Postgres 42703 = undefined_column; PostgREST 'PGRST204' = column not in its schema cache.
// ROUND-14: the message test used to include a bare `schema cache`, which also matches PostgREST's TRANSIENT
// "Could not query the database for the schema cache. Retrying." (PGRST002) — a reload in progress was read as a missing
// column and the status write took the legacy shape (the outcome note written into `error`). Only a column that is named as
// missing counts; PGRST204 is its code.
function isColumnMissing(err) {
  if (err?.code === 'PGRST002') return false
  return err?.code === '42703' || err?.code === 'PGRST204' || /column .* (does not exist|of relation)|could not find the '[^']+' column/i.test(err?.message || '')
}

// ROUND-3 AUDIT FIX (bug): outcome notes used to be stored in `error`, which the admin table
// prints in red — so a healthy PROCESSED row read "FULFILLED" or "reversed" as if it were a
// failure, and `error` could not be used to find real ones. Notes now live in `note`
// (migration 0036); `error` is written only for FAILED. Until 0036 is applied the column is
// missing, and the update falls back to the old shape rather than losing the status change.
// SECTION 8 (round 8, B1): returns true only when the status write LANDED (false: no inbox row, or the write
// failed — which is logged, never thrown). Resend callers use it to decide whether the recipient-bearing
// payload may be cleared: clearing it after a lost status write strands a RECEIVED row nothing can re-run.
async function markEvent(supabase, inbox, status, note, { ms = null } = {}) {
  if (!inbox?.id) return false
  const base = { status, processed_at: new Date().toISOString() }
  // Round 14 (G3): handler duration; migration 0086 — dropped on the legacy retry below if the column is not there yet.
  const timed = Number.isFinite(ms) ? { ...base, processing_ms: Math.max(0, Math.round(ms)) } : base
  const patch = status === 'FAILED'
    ? { ...timed, error: note || null, note: null }
    : { ...timed, error: null, note: note || null }
  try {
    let { error } = await supabase.from('webhook_events').update(patch).eq('id', inbox.id)
    if (error && isColumnMissing(error) && 'processing_ms' in patch) {
      const { processing_ms, ...slim } = patch   // 0086 not applied yet: keep the status write (and 0036's note) without the timing
      ;({ error } = await supabase.from('webhook_events').update(slim).eq('id', inbox.id))
    }
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

  // Webhooks round 23 (G1): the metadata Paystack echoes back is what this app sent at initialize. If it names a different scan or user than
  // the payment row, something is wrong (a reused reference, a tampered row). The row stays authoritative (settlement is unchanged); the owner is told.
  const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : null
  if (meta) {
    const diffs = []
    if (meta.scanId != null && paymentRow.scan_id && String(meta.scanId) !== String(paymentRow.scan_id)) diffs.push(`scanId: metadata ${meta.scanId} vs payment ${paymentRow.scan_id}`)
    if (meta.userId != null && paymentRow.user_id && String(meta.userId) !== String(paymentRow.user_id)) diffs.push(`userId: metadata ${meta.userId} vs payment ${paymentRow.user_id}`)
    if (diffs.length && await alertAllowedFor(c.env, 'metadata-mismatch', reference))
      alert(c, 'Paystack charge.success metadata does not match the payment row',
        `reference: ${reference}\n${diffs.join('\n')}\n\nThe payment row was used (it is what this app recorded at checkout); nothing was changed because of this. Review the payment in Admin → Payments.`, reference)
  }

  // A row that already settled (SUCCESS, or REFUNDED / DISPUTED which can only follow a SUCCESS) may have had an
  // overpayment accepted by an admin recheck, which keeps amount_cents at the expected price. A replayed or late
  // charge.success for it must not be re-held and re-alerted as "NOT fulfilled" (verifyPayment exempts the same way,
  // payments rounds 10/13). A CURRENCY mismatch is never accepted, so it is still flagged.
  const settledRow = ['SUCCESS', 'REFUNDED', 'DISPUTED'].includes(paymentRow.status)
  let mismatch = fulfillment.chargeMismatch(paymentRow, { amount: data.amount, currency: data.currency })
  if (mismatch && settledRow && mismatch.receivedCurrency === mismatch.expectedCurrency) mismatch = null
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
    const list = await paystackService.listRefunds(env, payment.paystack_ref, { currency: payment.currency })
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

// Round 24 (G1): the payment a failed refund belongs to carries the time of the failure. Only a payment that still holds the buyer's money
// (SUCCESS / DISPUTED) is stamped - on a REFUNDED one the refund evidently went through another way. Best-effort, tolerant of migration 0103
// not being applied; it can never change the HTTP answer.
async function markRefundFailed(supabase, payment) {
  try {
    if (!payment || !payment.id) return false
    const { data, error } = await supabase.from('payments').update({ refund_failed_at: new Date().toISOString() })
      .eq('id', payment.id).in('status', ['SUCCESS', 'DISPUTED']).select('id')
    if (error) { if (!isColumnMissing(error)) console.error('refund failure not stored:', error.message); return false }
    return Array.isArray(data) && data.length > 0
  } catch (err) { console.error('refund failure not stored:', err && err.message); return false }
}
async function clearRefundFailed(supabase, payment) {
  try {
    if (!payment || !payment.id || !payment.refund_failed_at) return false
    const { error } = await supabase.from('payments').update({ refund_failed_at: null }).eq('id', payment.id)
    if (error) { if (!isColumnMissing(error)) console.error('refund failure not cleared:', error.message); return false }
    return true
  } catch (err) { console.error('refund failure not cleared:', err && err.message); return false }
}

// Webhooks round 28 (G1): sweepStalledRefunds records a processed refund whose webhook never arrived as payment_refunds.event_key
// `sweep:<refund id>`. When the real event does arrive, the sweep's row for the same amount is replaced by it (never counted twice);
// and a total that still contains a sweep row is confirmed against Paystack's list before it can reverse a sale. Both best-effort.
// Webhooks round 29 (B1): the sweep row is found by the refund's own id (`sweep:<data.id>`). It used to be found by amount alone, so the
// event for refund 42 deleted the row the sweep had recorded for a different refund 41 of the same amount, leaving the books short for good.
// Only an event that carries no refund id (a refund_reference-only event) falls back to an amount match.
async function absorbSweepRefund(supabase, payment, amount, eventId, refundId = null) {
  try {
    if (!payment || !payment.id || !eventId || !Number.isFinite(amount) || amount <= 0) return false
    // A re-run of an event that is ALREADY recorded (Replay, re-drive) has nothing to absorb: its sweep twin, if any, was replaced the first time,
    // and a remaining sweep row of the same amount belongs to a different refund.
    const { data: ev } = await supabase.from('webhook_events').select('event_key').eq('id', eventId).maybeSingle()
    if (!ev || !ev.event_key) return false
    const { data: have } = await supabase.from('payment_refunds').select('id').eq('payment_id', payment.id).eq('event_key', ev.event_key).limit(1)
    if (have && have.length) return false
    const id = refundId == null ? '' : String(refundId).trim()
    let q = supabase.from('payment_refunds').select('id').eq('payment_id', payment.id)
    q = id ? q.eq('event_key', `sweep:${id}`) : q.like('event_key', 'sweep:%').eq('amount_cents', Math.round(amount))
    const { data, error } = await q.limit(1)
    if (error || !data || !data.length) return false
    const { error: delErr } = await supabase.from('payment_refunds').delete().eq('id', data[0].id)
    return !delErr
  } catch (_) { return false }
}
// -> the summed amount of this payment's sweep-recorded refunds (0 when none / unreadable).
async function sweepRefundSum(supabase, payment) {
  try {
    const { data, error } = await supabase.from('payment_refunds').select('amount_cents').eq('payment_id', payment.id).like('event_key', 'sweep:%')
    if (error || !data) return 0
    return data.reduce((n, r) => n + (Number(r.amount_cents) || 0), 0)
  } catch (_) { return 0 }
}

async function processRefund(c, supabase, event, eventId, { payloadMissing = false } = {}) {
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
    await markRefundFailed(supabase, payment)
    // Webhooks round 28 (B2): a queued refund holds refund_claimed_at for ~15 minutes; the alert below tells the owner to refund again, which
    // that hold answered CLAIM_LOST. The refund has failed, so nothing is in flight any more.
    if (payment && payment.id) { try { await require('../services/refund.service').releaseRefundClaim(supabase, payment.id) } catch (_) { /* best effort */ } }
    alert(c, 'Paystack refund.failed',
      `payment reference: ${payment?.paystack_ref || '(could not resolve)'}\nscanId: ${payment?.scan_id || '(could not resolve)'}\n\n` +
      `The refund did not go through (Paystack returns the money to your balance). The payment was NOT changed.\n\n` +
      `If this was the automatic refund of a duplicate / undeliverable payment, the hourly sweep retries it (up to 5 times) and pages you if it gives up. ` +
      `Otherwise refund it again from Paystack or Admin → Payments → Refund — if Paystack says the customer's bank details are needed, supply them in the Paystack dashboard. ` +
      `The payment is marked "refund failed" in Admin → Payments until a refund of it goes through.`, incident)
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
  // ROUND-25 (G1): record_refund_and_total sums amounts without a currency, so a refund stated in another currency than the sale would count
  // toward a "full refund". It is not actioned; the owner decides (Admin → Payments → Reverse).
  const evCur = String(event.data?.currency || '').toUpperCase(), payCur = String(payment.currency || '').toUpperCase()
  if (evCur && payCur && evCur !== payCur) {
    alert(c, 'Paystack refund.processed in a different currency — NOT actioned',
      `reference: ${payment.paystack_ref}\nscanId: ${payment.scan_id}\npaid in: ${payCur}\nrefund currency: ${evCur}\namount: ${event.data?.amount ?? '?'}\n\n` +
      `The refund was not added to the payment's refund total. If it should reverse the sale, use Admin → Payments → Reverse.`, incident)
    return { status: 'PROCESSED', note: `refund currency ${evCur} differs from payment ${payCur} — alerted` }
  }
  const refunded = Number(event.data?.amount)
  const ambiguous = refundIsAmbiguous(event)
  let total
  if (eventId && !ambiguous && !payloadMissing) await absorbSweepRefund(supabase, payment, refunded, eventId, event.data?.id)
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
  if ((ambiguous || !eventId || payloadMissing) && Number.isFinite(refunded)) total = Math.max(total, refunded)

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
  const sweepSum = eventId ? await sweepRefundSum(supabase, payment) : 0
  const remoteIsOnlyAuthority = ambiguous || !eventId || payloadMissing || !Number.isFinite(refunded)
  if (payment.amount_cents > 0 && (total < payment.amount_cents || sweepSum > 0)) {
    // A total containing a sweep-recorded row is trusted only once Paystack agrees (strict: a failed lookup answers 500 and is retried).
    // Paystack's list can lag a just-processed refund, so what the webhooks themselves recorded (total minus the sweep rows) is a floor.
    const remote = await paystackRefundTotal(c.env, payment, { strict: remoteIsOnlyAuthority || (sweepSum > 0 && total >= payment.amount_cents) })
    if (remote != null) total = sweepSum > 0 ? Math.max(remote, total - sweepSum) : Math.max(total, remote)
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

  await clearRefundFailed(supabase, payment)
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

// ROUND-11 (B1): has this exact dispute event already been PROCESSED (live delivery, sweep or replay)? sweepDisputes
// asks before running a `create`: if the create was handled and an admin then used "clear dispute" while Paystack still
// shows the dispute open, re-running it would put the payment straight back to DISPUTED. Fails safe: with no inbox, or
// on a read error, it answers false (the sweep then behaves as before).
async function disputeEventProcessed(supabase, type, id, { noteMatches = null } = {}) {
  if (id == null) return false
  try {
    const { data, error } = await supabase.from('webhook_events').select('id, note')
      .eq('provider', 'paystack').eq('event_key', `${type}:${id}`).eq('status', 'PROCESSED').limit(1)
    if (error || !data || !data.length) return false
    return noteMatches ? noteMatches.test(String(data[0].note || '')) : true
  } catch (_) { return false }
}

// ROUND-9 (G2): Paystack auto-accepts (and refunds the customer) when a dispute is not answered in time; the payload's
// `due_at` says exactly when, and was kept in DISPUTE_KEEP but never shown. Returns a line for the owner alert, or ''.
function disputeDeadlineLine(d, now = Date.now()) {
  const due = Date.parse(d && d.due_at)
  if (!Number.isFinite(due)) return ''
  const hours = (due - now) / 3_600_000
  const when = new Date(due).toISOString()
  if (hours <= 0) return `\nResponse deadline: ${when} — ALREADY PASSED; Paystack may have auto-accepted this dispute.`
  const left = hours < 1 ? `${Math.max(1, Math.round(hours * 60))} minute(s)` : `about ${Math.round(hours)} hour(s)`
  return `\nRespond in the Paystack dashboard by ${when} (${left} left) — after that Paystack accepts the dispute and refunds the customer. (Admin → Payments can send evidence, contest it with a proof of delivery, or accept it.)`
}

// ROUND-13 (G1): the dispute's response deadline, stored on the payment so Admin → Payments and the dashboard can show a
// countdown (it used to exist only inside the webhook inbox and one owner email). Best effort and NEVER throws: the column comes
// from migration 0083, and a Worker deployed ahead of it must still mark the payment DISPUTED — a failed write here is logged.
async function recordDisputeDeadline(supabase, payment, d) {
  try {
    if (!payment || !d || !d.due_at) return false
    const due = Date.parse(d.due_at)
    if (!Number.isFinite(due)) return false
    const { error } = await supabase.from('payments').update({ dispute_due_at: new Date(due).toISOString() })
      .eq('id', payment.id).eq('status', 'DISPUTED')
    if (error) { console.error('dispute deadline not stored:', error.message); return false }
    return true
  } catch (err) { console.error('dispute deadline not stored:', err && err.message); return false }
}

// Round 14 (G2): Paystack's dispute id, kept on the payment for the admin Accept / Submit-evidence actions. Best effort, never throws
// (column from migration 0086).
async function recordDisputeId(supabase, payment, d) {
  try {
    const id = d && (typeof d.id === 'string' || typeof d.id === 'number') ? String(d.id).trim() : ''
    if (!payment || !id || id.length > 64 || payment.dispute_id === id) return false
    const { error } = await supabase.from('payments').update({ dispute_id: id }).eq('id', payment.id).eq('status', 'DISPUTED')
    if (error) { if (!isColumnMissing(error)) console.error('dispute id not stored:', error.message); return false }
    return true
  } catch (err) { console.error('dispute id not stored:', err && err.message); return false }
}

// Round 19 (G2): the merchant's own answer to a dispute (contest / accept / a resolution that left the payment waiting on a human)
// is stamped on the payment, so the deadline pages (B1) and Admin → Payments can tell "unanswered" from "answered, awaiting the bank".
// Best effort and column-tolerant (migration 0097): a Worker deployed before it simply behaves as before.
async function markDisputeAnswered(supabase, payment, kind) {
  try {
    if (!payment || !kind) return false
    let q = supabase.from('payments').update({ dispute_answered_at: new Date().toISOString(), dispute_answer: kind }).eq('status', 'DISPUTED')
    q = payment.id ? q.eq('id', payment.id) : q.eq('paystack_ref', payment.paystack_ref)
    const { error } = await q
    if (error) { if (!isColumnMissing(error)) console.error('dispute answer not stored:', error.message); return false }
    return true
  } catch (err) { console.error('dispute answer not stored:', err && err.message); return false }
}
// Webhooks round 21 (G1/B1): Paystack sends no event when the merchant answers a dispute in ITS dashboard (the very step the alerts
// recommend); the dispute just moves to `awaiting-bank-feedback`. Nothing recorded that, so the payment kept looking unanswered:
// the dashboard card and Admin -> Payments counted it overdue once the response deadline passed (for the weeks the bank takes) and kept
// offering Contest / Accept that Paystack would refuse. Stamps it as answered ('contested' - the only way a dispute reaches the bank).
// Only a still-unanswered DISPUTED payment is touched. Best effort, column-tolerant (0097), never throws. true = a row was stamped.
async function markDisputeAnsweredOutside(supabase, payment) {
  try {
    if (!payment || (!payment.id && !payment.paystack_ref)) return false
    let q = supabase.from('payments').update({ dispute_answered_at: new Date().toISOString(), dispute_answer: 'contested' })
      .eq('status', 'DISPUTED').is('dispute_answered_at', null)
    q = payment.id ? q.eq('id', payment.id) : q.eq('paystack_ref', payment.paystack_ref)
    const { data, error } = await q.select('id')
    if (error) { if (!isColumnMissing(error)) console.error('dispute answer (dashboard) not stored:', error.message); return false }
    return Array.isArray(data) && data.length > 0
  } catch (err) { console.error('dispute answer (dashboard) not stored:', err && err.message); return false }
}
async function resetDisputeAnswer(supabase, payment) {
  try {
    if (!payment || !payment.id) return false
    const { error } = await supabase.from('payments').update({ dispute_answered_at: null, dispute_answer: null }).eq('id', payment.id).eq('status', 'DISPUTED')
    if (error) { if (!isColumnMissing(error)) console.error('dispute answer not reset:', error.message); return false }
    return true
  } catch (err) { console.error('dispute answer not reset:', err && err.message); return false }
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
    if (marked) await resetDisputeAnswer(supabase, payment)   // a new dispute starts unanswered (round 19, G2)
  }
  // create (just marked) and remind (a re-sent, possibly extended deadline) both carry due_at; the guarded update only
  // touches a payment that is DISPUTED right now.
  // Webhooks round 22 (B1): a create for a DIFFERENT dispute id on a payment that is already DISPUTED (a second dispute opened while the
  // first is unresolved) is a new dispute that nobody has answered, yet it overwrote the stored deadline and id and kept the first
  // dispute's `dispute_answered_at` - so the deadline pages and the overdue count skipped it. A redelivery of the SAME create (same id) is
  // left alone. Only when a stored id exists can the two be told apart (migration 0086).
  if (event.event === 'charge.dispute.create' && !marked && payment && payment.status === 'DISPUTED' && payment.dispute_id && d.id != null
      && String(d.id).trim() !== '' && String(d.id).trim() !== String(payment.dispute_id))
    await resetDisputeAnswer(supabase, payment)
  // Round 30: a reminder for a dispute the payment does not track (an older one, while a newer one is open) must not overwrite the tracked
  // deadline / id - it used to flip the payment back to the older dispute.
  const staleRemind = event.event === 'charge.dispute.remind' && payment && payment.dispute_id && d.id != null
    && String(d.id).trim() !== '' && String(d.id).trim() !== String(payment.dispute_id)
  if ((event.event === 'charge.dispute.create' || event.event === 'charge.dispute.remind') && payment && (marked || payment.status === 'DISPUTED') && !staleRemind)
    { await recordDisputeDeadline(supabase, payment, d); await recordDisputeId(supabase, payment, d) }

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
  let otherDisputeOpen = false
  if (event.event === 'charge.dispute.resolve') {
    // ROUND-25 (B3): a resolution for a dispute id other than the one the payment now tracks (a second dispute opened while this one was
    // open) must not clear the hold — the newer dispute is still unanswered. The dispute sweep decides it when it resolves.
    otherDisputeOpen = !!(payment && payment.status === 'DISPUTED' && payment.dispute_id && d.id != null && String(d.id).trim() !== '' && String(d.id).trim() !== String(payment.dispute_id))
    if (/declin/.test(resolution)) {
      if (otherDisputeOpen) {
        auto = null
        detail = `Resolution: DECLINED — you WON this dispute, but the payment is tracking a different, newer dispute (${payment.dispute_id}) that is still open, so it stays DISPUTED. Answer the newer one in Admin → Payments.`
      } else if (payment && payment.status === 'DISPUTED' && await fulfillment.clearDispute(supabase, payment)) {
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
      } else if (live && live.status === 'REFUNDED') {
        // Webhooks round 23 (B2): an admin Accept (or the refund Paystack sends with it) can land refund.processed first, so the sale is
        // already reversed. The generic text below told the owner to use Reverse on a payment that is already REFUNDED.
        auto = 'dispute lost — payment already REFUNDED'
        detail = `Resolution: ACCEPTED — the money went back to the customer, and the payment is already REFUNDED (the refund was processed first), so there is nothing left to do.`
      } else if (partialDispute)
        detail = `Resolution: ACCEPTED, but only ${disputed} of the ${payment.amount_cents} paid was disputed, so nothing was changed automatically. ${current}. Decide in Admin → Payments (Reverse if the whole sale should come back).`
      else
        detail = `Resolution: ACCEPTED — the money went back to the customer. ${current}, so nothing was changed automatically. Use Admin → Payments → Reverse if it still needs reversing.`
    } else
      detail = `Resolution "${d.resolution || 'unknown'}" is not one this app recognises. ${current}. Check the outcome in Paystack, then use Admin → Payments → Reverse (lost) or Clear dispute (won).`
  } else if (event.event === 'charge.dispute.remind') {
    detail = `Reminder: this dispute is still unresolved (Paystack auto-accepts and refunds the customer after 16 hours). ${current}. Respond in the Paystack dashboard, or from Admin → Payments (Send evidence / Contest dispute / Accept dispute).${disputeDeadlineLine(d)}`
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

  if (event.event === 'charge.dispute.resolve' && payment && payment.status === 'DISPUTED' && !auto && !otherDisputeOpen) await markDisputeAnswered(supabase, payment, 'resolved')
  if (event.event === 'charge.dispute.create') detail += disputeDeadlineLine(d)
  alert(c, `Paystack ${event.event}`, `A "${event.event}" event was received.\n\n${summary}${detail}`,
    `${payment?.paystack_ref || fulfillment.referenceCandidates(event)[0] || d.id || ''}:${event.event}`)
  // Round 24 (B1): no payment matched → IGNORED, exactly like a refund with no payment (round 5, B2). The alert says "Replay once you have repaired
  // the payment row"; a PROCESSED row answers Replay with 409. Replay re-runs it through this same handler.
  if (!payment) return { status: 'IGNORED', note: 'payment not found' }
  return { status: 'PROCESSED', note: auto || (alreadyResolved ? 'dispute already resolved — not re-marked' : (marked ? 'marked DISPUTED' : undefined)) }
}

async function processEvent(c, supabase, event, eventId, opts = {}) {
  const type = event.event
  if (type === 'charge.success') return processChargeSuccess(c, supabase, event)
  if (type.startsWith('refund.')) return processRefund(c, supabase, event, eventId, opts)
  // ROUND-14: a LIVE dispute event used to reach the handler raw while Replay and the sweep (which read the stored / API-listed
  // item) went through minimalDisputeEvent, so the two spellings of the deadline (`due_at` / `dueAt`) were honoured on one path
  // and not the other. Every path now reads the same normalised shape.
  if (type.startsWith('charge.dispute')) return processDispute(c, supabase, minimalDisputeEvent(event))
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
    noteRejected(c, 'paystack', 'not-configured')
    return c.text('Webhook not configured', 500)
  }

  // ROUND-6 (G4): a request from outside the allowlist is still refused (403), but it is no longer refused
  // BLIND. Paystack changing its outbound IPs would otherwise fail every webhook with only a console line;
  // so the signature is checked below, and a VALID one from an unlisted IP pages the owner (throttled).
  const allow = parseIpList(c.env.PAYSTACK_WEBHOOK_IPS)
  const sourceIp = (c.req.header('cf-connecting-ip') || '').trim()
  const ipRejected = allow.length > 0 && !ipListAllows(c.env.PAYSTACK_WEBHOOK_IPS, sourceIp)
  if (ipRejected) console.error(`Webhook rejected: source IP ${sourceIp || '(none)'} is not in PAYSTACK_WEBHOOK_IPS`)

  const declared = Number.parseInt(c.req.header('content-length') || '', 10)
  const tooLarge = () => { noteRejected(c, 'paystack', 'too-large'); return c.text('Payload too large', 413) }
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge()
  // Round 19 (B3): streamed with a cap — a chunked body with no Content-Length used to be buffered whole before being measured.
  const bodyBytes = await readBodyCapped(c, MAX_BODY_BYTES)
  if (!bodyBytes) return tooLarge()

  const givenSig = (c.req.header('x-paystack-signature') || '').trim().toLowerCase()
  let sigOk = cryptoLib.timingSafeEqual(await cryptoLib.hmacSha512Hex(secret, bodyBytes), givenSig)
  // ROUND-10 (G3): during a key rotation Paystack's in-flight retries are still signed with the previous key.
  const previousSecret = c.env.PAYSTACK_SECRET_KEY_PREVIOUS
  if (!sigOk && previousSecret && previousSecret !== secret) {
    sigOk = cryptoLib.timingSafeEqual(await cryptoLib.hmacSha512Hex(previousSecret, bodyBytes), givenSig)
    if (sigOk) console.error('[WARN] Paystack webhook verified with PAYSTACK_SECRET_KEY_PREVIOUS — remove it once retries drain (~72h)')
  }
  if (ipRejected) {
    if (sigOk && await alertAllowed(c.env, 'webhook-alert-cooldown:paystack-ip-rejected'))
      alert(c, 'Paystack webhook refused — source IP not in PAYSTACK_WEBHOOK_IPS',
        `A correctly SIGNED Paystack webhook arrived from ${sourceIp || '(unknown)'}, which is not in PAYSTACK_WEBHOOK_IPS, and was refused with 403.\n\n` +
        `If Paystack changed its outbound IPs, every webhook is failing until the list is updated (payments are still recovered by the buyer's return visit and the hourly sweeps, ` +
        `but refunds and disputes are not). Update it: wrangler secret put PAYSTACK_WEBHOOK_IPS — or delete it to rely on the signature alone. ` +
        `Further occurrences in the next 30 minutes are logged but not emailed.`)
    // Round 21 (B2): a bad signature from outside the allow-list cannot be Paystack, so it is scanner noise, not a flagged refusal.
    noteRejected(c, 'paystack', sigOk ? 'ip' : 'unsigned')
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
    noteRejected(c, 'paystack', rejections.looksLikePaystackSignature(givenSig) && rejections.looksLikePaystackEvent(bodyBytes) ? 'signature' : 'unsigned')
    return c.text('Invalid signature', 401)
  }

  let event
  try {
    event = JSON.parse(new TextDecoder().decode(bodyBytes))
  } catch (_) { event = null }
  if (!event || typeof event.event !== 'string') {
    // ROUND-10 (G4): signed, so it came from Paystack (or someone holding the key) — answered 200 (a retry would be
    // identical) but no longer silently: a payload-format change would otherwise be invisible.
    console.error('[WARN] signed Paystack webhook is not a recognisable event (not JSON, or no `event` string)')
    if (await alertAllowed(c.env, 'webhook-alert-cooldown:paystack-unrecognised-body', 24 * 3600))
      alert(c, 'Paystack sent a signed webhook this app cannot read',
        `A correctly signed request to /api/webhooks/paystack was not valid JSON or had no string \`event\` field (${bodyBytes.byteLength} bytes). It was acknowledged (200) and dropped.\n\n` +
        `If this repeats, Paystack may have changed its payload format. Emailed at most once a day.`)
    noteRejected(c, 'paystack', 'unreadable')
    return c.text('OK', 200)
  }

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
  const startedAt = Date.now()
  try {
    outcome = await processEvent(c, supabase, event, inbox.id, { payloadMissing: !!inbox.payloadMissing })
  } catch (err) {
    console.error(`[CRITICAL] webhook ${event.event} (${reference}) failed:`, err.message)
    await markEvent(supabase, inbox, 'FAILED', err.message, { ms: Date.now() - startedAt })
    // First failure pages once; the redeliveries Paystack sends next don't.
    if (!inbox.attempts || inbox.attempts <= 1)
      alert(c, 'Webhook processing failed — Paystack will retry',
        `event: ${event.event}\nreference: ${reference || '(none)'}\nerror: ${err.message}\n\n` +
        `Answered 500, so Paystack redelivers on its retry schedule and the redelivery re-runs this. ` +
        `If it keeps failing: POST /api/payments/${reference || '<reference>'}/reconcile or /recheck (admin).`, reference)
    return c.text('Processing error', 500)
  }

  const tookMs = Date.now() - startedAt
  await markEvent(supabase, inbox, outcome.status, outcome.note, { ms: tookMs })
  // Round 14 (G3): the work is done BEFORE the 200, so an event that nears Paystack's delivery timeout is redelivered (and re-runs
  // its Paystack calls). Say so while it is still only slow.
  if (tookMs >= SLOW_EVENT_MS) {
    console.error(`[WARN] webhook ${event.event} (${reference}) took ${tookMs} ms`)
    if (await alertAllowedFor(c.env, 'slow-event', event.event, { globalMax: 5, ttlSeconds: 6 * 3600 }))
      alert(c, 'Paystack webhook handler is slow',
        `event: ${event.event}\nreference: ${reference || '(none)'}\ntook: ${Math.round(tookMs / 1000)}s\n\n` +
        `The handler finishes its work before answering 200, and Paystack gives up on a delivery after a timeout (30 s in test mode), then redelivers — ` +
        `each redelivery repeats the Paystack calls. This is usually Paystack (or Supabase) being slow; see Admin → Webhooks → Duration. At most 5 of these are emailed per hour, one per event type per 6 hours.`,
        `slow:${event.event}`)
  }
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
// ROUND-11 (G2): the unfinished states a person may close out by hand (see dismissWebhookEvent).
const DISMISSABLE = ['RECEIVED', 'HELD', 'FAILED']
// A RECEIVED row this old was not merely in flight: the Worker died mid-event.
const STUCK_RECEIVED_MS = 15 * 60 * 1000
// Round 14 (G3): a handler run this long is close to Paystack's delivery timeout.
const SLOW_EVENT_MS = 20 * 1000

// `row` carries last_attempt_at (null on rows from before 0090 and on first-time deliveries) and received_at.
function isStuckReceived(row, now = Date.now()) {
  const t = Date.parse(row?.last_attempt_at || row?.received_at)
  return Number.isFinite(t) && now - t > STUCK_RECEIVED_MS
}

// has_event / has_type: whether a payload exists to replay (its top-level key — `event` for Paystack, `type` for
// Resend) without shipping the payload itself in a list.
const EXISTING_COLS = 'id, status, attempts, has_body:payload->>event, has_type:payload->>type'   // recordEvent: is there already a stored body? (a constant: the column lint reads literals)
const LIST_COLS_BASE = 'id, provider, event_type, event_key, reference, status, attempts, error, received_at, processed_at, has_event:payload->>event, has_type:payload->>type'
const LIST_COLS_NOTE = `${LIST_COLS_BASE}, note, replayed_by, replayed_at`
const LIST_COLS_FULL = `${LIST_COLS_NOTE}, processing_ms`

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
  // ROUND-11 (G5): optional received-date window (YYYY-MM-DD, inclusive, UTC). Anything else is ignored.
  // Round 14 (B4): Date.parse rolls 2026-02-31 over to 3 March, so a non-date used to reach Postgres (500) or shift `to` a day. It must round-trip.
  const dayOf = v => {
    const t = String(v || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null
    const ms = Date.parse(`${t}T00:00:00Z`)
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === t ? t : null
  }
  const fromDay = dayOf(c.req.query('from'))
  const toDay = dayOf(c.req.query('to'))

  const build = cols => {
    let q = getSupabase(c.env).from('webhook_events').select(cols, { count: 'exact' })
      .order('received_at', { ascending: false }).range(from, from + pageSize - 1)
    if (status === 'ATTENTION')
      q = q.or(`status.in.(FAILED,HELD),and(status.eq.RECEIVED,${staleColumn()}.lt.${new Date(Date.now() - STUCK_RECEIVED_MS).toISOString()})`)
    else if (status && EVENT_STATUSES.includes(status)) q = q.eq('status', status)
    if (reference) q = q.ilike('reference', `%${reference.replace(/_/g, '\\_')}%`)
    if (type) q = q.eq('event_type', type)
    if (providerQ === 'paystack' || providerQ === 'resend') q = q.eq('provider', providerQ)
    if (fromDay) q = q.gte('received_at', `${fromDay}T00:00:00.000Z`)
    if (toDay) q = q.lt('received_at', new Date(Date.parse(`${toDay}T00:00:00Z`) + 24 * 3600 * 1000).toISOString())
    return q
  }
  // schema tiers, newest first: 0090 (last_attempt_at) → 0086 (processing_ms) → 0083 (note…) → 0036. A missing column drops one tier.
  let tiers = [staleSelect(LIST_COLS_FULL), LIST_COLS_FULL, LIST_COLS_NOTE, LIST_COLS_BASE].filter((t, i, a) => a.indexOf(t) === i)
  let res
  for (let i = 0; ;) {
    res = await build(tiers[i])
    if (!(res.error && isColumnMissing(res.error))) break
    if (legacyStaleCol(res.error)) { tiers = [LIST_COLS_FULL, LIST_COLS_NOTE, LIST_COLS_BASE]; i = 0; continue }
    if (++i >= tiers.length) break
  }
  let { data, error, count } = res
  // ROUND-10 (B3): a page beyond the data is PostgREST's 416 / PGRST103 — an empty page (the UI clamps back), not a 500.
  if (error && (error.code === 'PGRST103' || /range not satisfiable/i.test(error.message || ''))) { data = []; error = null; count = 0 }
  if (error) throw error
  return c.json({ success: true, data: (data || []).map(r => ({
    id: r.id, provider: r.provider || 'paystack', eventType: r.event_type, eventKey: r.event_key, reference: r.reference, status: r.status,
    attempts: r.attempts, processingMs: Number.isFinite(r.processing_ms) ? r.processing_ms : null,
    // `error` is a real failure (FAILED rows) and nothing else. Outcome notes are `note` now; rows
    // written before migration 0036 still carry theirs in `error`, so those are surfaced as notes.
    error: r.status === 'FAILED' ? (r.error || null) : null,
    note:  r.status === 'FAILED' ? (r.note || null) : (r.note || r.error || null),
    receivedAt: r.received_at, processedAt: r.processed_at,
    replayedBy: r.replayed_by || null, replayedAt: r.replayed_at || null,
    // ROUND-7 (B2): Replay only when there is a payload to re-run (non-actionable events keep none).
    // ROUND-14 (B6): a RECEIVED row is only replayable once stuck — replaying one still being worked on ran it twice at once.
    replayable: REPLAYABLE.includes(r.status) && (r.status !== 'RECEIVED' || isStuckReceived(r)) && !!(r.has_event || r.has_type || r.payload),
    // ROUND-11 (G2): a row that is waiting on a person (or a Worker that died) and may never succeed can be closed by hand.
    // ROUND-12 (G3): a RECEIVED row is only dismissable once it is stuck (the same 15 minutes the dashboard counts it after);
    // a fresh one is a delivery still being worked on.
    dismissable: DISMISSABLE.includes(r.status) && (r.status !== 'RECEIVED' || isStuckReceived(r)),
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

// Update a webhook_events row only if it is still exactly as the caller read it (status + attempts). Tolerates the optional
// columns of later migrations being absent. { ok: true } when this caller won the row; { ok: false } when someone else moved it.
async function claimEvent(supabase, row, patch, optional = []) {
  const run = p => supabase.from('webhook_events').update(p).eq('id', row.id).eq('status', row.status).eq('attempts', row.attempts || 1).select('id')
  let { data, error } = await run(patch)
  if (error && isColumnMissing(error) && optional.some(k => k in patch)) {
    legacyStaleCol(error)
    const slim = { ...patch }
    for (const k of optional) delete slim[k]
    ;({ data, error } = await run(slim))
  }
  if (error) { console.error('webhook_events claim failed:', error.message); return { ok: false, error } }
  return { ok: !!(data && data.length) }
}

async function runStoredEvent(c, supabase, row, { by = null, redrive = false } = {}) {
  const attempts = (row.attempts || 1) + 1
  const inbox = { id: row.id, attempts }
  const patch = { status: 'RECEIVED', attempts, ...touchPatch() }
  if (by) { patch.replayed_by = by; patch.replayed_at = new Date().toISOString() }
  if (redrive) patch.redrives = (row.redrives || 0) + 1
  // Webhooks round 15 (B3): claim the row before running it. The update only matches while the row still has the status and
  // delivery count this caller read, so of two simultaneous runs (two admins, an admin and the hourly re-drive, a replay and a
  // live redelivery that bumped the count) only one proceeds. Dismiss already worked this way; replay and re-drive did not.
  const claim = await claimEvent(supabase, row, patch, ['replayed_by', 'replayed_at', 'redrives', 'last_attempt_at'])
  if (!claim.ok) return claim.error ? { ok: false, error: claim.error } : { ok: false, skipped: true }
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
  const { data: row, error } = await withStaleCol(() => supabase.from('webhook_events')
    .select(staleSelect('id, provider, status, attempts, payload, event_type, reference, received_at')).eq('id', c.req.param('id')).maybeSingle())
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Event not found.' }, 404)
  if (row.status === 'RECEIVED' && !isStuckReceived(row))
    return c.json({ success: false, message: 'This event was received moments ago and is still being processed — only a RECEIVED event stuck for over 15 minutes can be replayed.' }, 409)
  if (!REPLAYABLE.includes(row.status))
    return c.json({ success: false, message: `This event is ${row.status} — it already did its work; nothing to replay.` }, 409)
  if (!storedKind(row))
    return c.json({ success: false, message: 'No stored payload to replay.' }, 422)

  const actor = c.get ? c.get('user') : null
  const r = await runStoredEvent(c, supabase, row, { by: actor?.id || null })
  if (r.skipped) return c.json({ success: false, message: 'This event changed while you were looking at it (someone else, or the automatic re-drive, is already running it) — reload and check its status.' }, 409)
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

// POST /api/admin/webhook-events/:id/dismiss  { note?: string }
// ROUND-11 (G2): a FAILED / HELD / stuck-RECEIVED row whose cause can never be fixed (the payment row is gone, a customer
// refunded out of band, a mismatch the owner settled by hand elsewhere) had no way out: it counted on the dashboard for ever,
// was re-driven 8 times and then re-emailed every 7 days (HELD: every 3). Dismiss closes it as IGNORED with the admin's
// note, audited like Replay. A dismissed row is still replayable (its payload is kept) — except a Resend row, whose
// recipient addresses are cleared exactly as a finished one's are. Guarded on the status the admin saw, so a row that
// finished or was replayed in the meantime is never overwritten.
async function dismissWebhookEvent(c) {
  const supabase = getSupabase(c.env)
  let body = {}
  try { body = await c.req.json() } catch (_) { body = {} }
  const rawNote = body && typeof body.note === 'string' ? body.note : ''
  const note = rawNote.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)

  const { data: row, error } = await withStaleCol(() => supabase.from('webhook_events')
    .select(staleSelect('id, provider, status, event_type, reference, received_at')).eq('id', c.req.param('id')).maybeSingle())
  if (error) throw error
  if (!row) return c.json({ success: false, message: 'Event not found.' }, 404)
  if (row.status === 'RECEIVED' && !isStuckReceived(row))
    return c.json({ success: false, message: 'This event was received moments ago and is still being processed — only a RECEIVED event stuck for over 15 minutes can be dismissed.' }, 409)
  if (!DISMISSABLE.includes(row.status))
    return c.json({ success: false, message: `This event is ${row.status} — only FAILED, HELD or stuck RECEIVED events can be dismissed.` }, 409)

  const actor = c.get ? c.get('user') : null
  const text = `dismissed by admin${note ? `: ${note}` : ''}`
  const base = { status: 'IGNORED', processed_at: new Date().toISOString() }
  const run = patch => supabase.from('webhook_events').update(patch).eq('id', row.id).eq('status', row.status).select('id')
  let { data: moved, error: upErr } = await run({ ...base, error: null, note: text })
  if (upErr && isColumnMissing(upErr)) ({ data: moved, error: upErr } = await run({ ...base, error: text }))   // 0036 not applied yet
  if (upErr) throw upErr
  if (!moved || !moved.length)
    return c.json({ success: false, message: 'This event changed while you were looking at it — reload and try again.' }, 409)

  if (row.provider === 'resend') await require('./resend-webhook.controller').clearResendPayload(supabase, row.id)
  await logAdminAction(c, supabase, 'webhook.dismiss', 'webhook_event', row.id, {
    eventType: row.event_type, provider: row.provider || 'paystack', reference: row.reference || null, from: row.status, byNote: !!note, actor: actor?.id || null,
  })
  return c.json({ success: true, data: { status: 'IGNORED', note: text } })
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

// ROUND-25 (B1): refund rows stored before refunds got an allowlist still hold refunded_by / customer_note / merchant_note. Rewrites a batch per run
// through the same minimiser (best-effort, never throws, no migration; returns how many rows it rewrote).
async function scrubRefundPayloads(supabase, { limit = 50 } = {}) {
  let n = 0
  try {
    const { data, error } = await supabase.from('webhook_events').select('id, payload').eq('provider', 'paystack').like('event_type', 'refund.%')
      .or('payload->data->>refunded_by.not.is.null,payload->data->>customer_note.not.is.null,payload->data->>merchant_note.not.is.null').limit(limit)
    if (error) { console.error('refund payload scrub failed:', error.message); return 0 }
    for (const row of data || []) {
      if (!row.payload || typeof row.payload !== 'object') continue
      const { error: upErr } = await supabase.from('webhook_events').update({ payload: stripNul(minimalRefundEvent(row.payload)) }).eq('id', row.id)
      if (upErr) console.error('refund payload scrub update failed:', upErr.message); else n++
    }
  } catch (err) { console.error('refund payload scrub error:', err && err.message) }
  return n
}

// Round 14 (B2/B5): retention. `webhook_events` was pruned by one rule — PROCESSED/IGNORED after 90 days — which (a) never touched a
// Resend row that ended FAILED (its payload holds recipient addresses, kept for ever) and (b) deleted the dispute / refund rows
// that disputeResolutionSeen and the refund dedupe lean on, so a replayed old charge.dispute.create could re-mark a settled sale.
//   · Resend payloads (addresses): nulled after 7 days whatever the status — the row (type, note, user ids) stays.
//   · Resend rows: deleted after 90 days whatever the status.
//   · Other PROCESSED / IGNORED rows: 90 days, except dispute / refund rows: 400 days (past any chargeback window).
// Returns the error messages (empty = clean). Never throws.
const PRUNE_DAY = 24 * 3600 * 1000
async function pruneWebhookEvents(supabase, { now = Date.now() } = {}) {
  const errors = []
  const iso = days => new Date(now - days * PRUNE_DAY).toISOString()
  const run = async (label, q) => {
    try { const { error } = await q; if (error) { errors.push(`${label}: ${error.message}`); console.error(`webhook_events prune (${label}) error:`, error.message) } }
    catch (err) { errors.push(`${label}: ${err.message}`); console.error(`webhook_events prune (${label}) error:`, err.message) }
  }
  const t = () => supabase.from('webhook_events')
  // Webhooks round 15 (B5): only rows that finished. A FAILED / stuck-RECEIVED row keeps its (minimal) payload until the 90-day delete so the
  // re-drive and Replay can still finish it — scrubbing it at 7 days left an unsuppressed address stuck in "needs attention" with nothing to re-run.
  await run('resend payload scrub', t().update({ payload: null }).eq('provider', 'resend').in('status', ['PROCESSED', 'IGNORED', 'HELD']).not('payload', 'is', null).lt('received_at', iso(7)))
  await run('resend rows', t().delete().eq('provider', 'resend').lt('received_at', iso(90)))
  await run('events', t().delete().lt('received_at', iso(90)).in('status', ['PROCESSED', 'IGNORED'])
    .not('event_type', 'like', 'charge.dispute%').not('event_type', 'like', 'refund.%'))
  await run('dispute/refund events', t().delete().lt('received_at', iso(400)).in('status', ['PROCESSED', 'IGNORED']))
  return errors
}

// ── Round 14 (G2): answer a dispute from Admin → Payments ────────────────────────────────────────────────────────────
// Every dispute alert used to say "respond in the Paystack dashboard" against an auto-accept deadline of about 16 hours. These
// are the two actions that can be taken from here. Neither changes the payment itself: Paystack's own charge.dispute.resolve
// webhook (or the dispute sweep) does that through the existing handler, so the sale is reversed / restored in exactly one place.
async function loadDisputedPayment(c, supabase) {
  const reference = c.req.param('reference')
  const cols = 'id, paystack_ref, status, user_id, scan_id, fix_tier, amount_cents, currency, paid_at, created_at, disputed_at, dispute_id'
  const load = fields => supabase.from('payments').select(fields).eq('paystack_ref', reference).maybeSingle()
  let { data: payment, error } = await load(`${cols}, dispute_evidence_id, dispute_answered_at, dispute_answer`)
  if (error && isColumnMissing(error)) ({ data: payment, error } = await load(`${cols}, dispute_evidence_id`))   // 0097 not applied yet
  if (error && isColumnMissing(error)) ({ data: payment, error } = await load(cols))   // 0090 not applied yet
  if (error) throw error
  if (!payment) return { fail: c.json({ success: false, message: 'Payment not found.' }, 404) }
  if (payment.status !== 'DISPUTED')
    return { fail: c.json({ success: false, message: `Payment is ${payment.status} — only a DISPUTED payment has a dispute to answer.` }, 409) }
  return { payment }
}

// The id Paystack gave the dispute: stored when the webhook was processed (0086); a payment disputed before that is looked up in
// Paystack's own list. Returns null when it cannot be found.
// Webhooks round 15: returns { id, claimed } — Paystack's dispute id and the amount the dispute is for (null when unknown).
// `withAmount` makes a stored id cost one GET so an accept can refund what was actually disputed (round 15, B2).
async function resolveDispute(env, supabase, payment, { withAmount = false } = {}) {
  if (payment.dispute_id) {
    if (!withAmount) return { id: payment.dispute_id, claimed: null }
    const json = await paystackService.fetchDispute(env, payment.dispute_id)
    return { id: payment.dispute_id, claimed: json?.data?.refund_amount ?? null }
  }
  const day = ms => new Date(ms).toISOString().slice(0, 10)
  const since = Date.parse(payment.disputed_at || payment.paid_at || payment.created_at)
  const from = Number.isFinite(since) ? day(since - 2 * 24 * 3600 * 1000) : undefined
  for (let page = 1; page <= 3; page++) {
    const json = await paystackService.listDisputes(env, { from, to: day(Date.now() + 24 * 3600 * 1000), perPage: 100, page })
    const items = Array.isArray(json?.data) ? json.data : []
    const hit = items.find(d => d && (d.transaction?.reference === payment.paystack_ref || d.transaction_reference === payment.paystack_ref))
    if (hit && hit.id != null) {
      await recordDisputeId(supabase, payment, { id: hit.id })
      return { id: String(hit.id), claimed: hit.refund_amount ?? null }
    }
    if (items.length < 100) break
  }
  return { id: null, claimed: null }
}

// Webhooks round 16 (G1): the id Paystack gave the evidence we sent, stored as `<disputeId>:<evidenceId>` so it is only ever used for the
// dispute it was made for (a second dispute on the same payment must not quote the first one's evidence). null when there is none.
function evidenceIdFor(payment, disputeId) {
  const raw = typeof payment.dispute_evidence_id === 'string' ? payment.dispute_evidence_id : ''
  const i = raw.indexOf(':')
  return i > 0 && raw.slice(0, i) === String(disputeId) && raw.slice(i + 1) ? raw.slice(i + 1) : undefined
}

// What an accept refunds: the amount the dispute is for, never more than was paid; the whole payment when Paystack states none.
function disputedAmountFor(payment, claimed) {
  const n = Number(claimed)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), payment.amount_cents) : payment.amount_cents
}

// Webhooks round 28 (G2): the UI hides Contest / Accept once a dispute is answered; the API now refuses too instead of leaving it to Paystack.
const alreadyAnswered = (c, payment) => c.json({ success: false, message: `This dispute was already answered (${payment.dispute_answer || 'answered'}) - wait for Paystack's outcome (a won dispute returns to SUCCESS, a lost one is refunded and reversed automatically).` }, 409)
const NOT_FOUND_ID = { success: false, message: 'Paystack\'s id for this dispute is not known yet and was not found in Paystack\'s dispute list. Use the Paystack dashboard for this one.' }
const paystackFailure = (c, err) => err && err.paystackRejected
  ? c.json({ success: false, message: `Paystack refused it: ${err.message}` }, 422)
  : c.json({ success: false, message: `Could not reach Paystack (${err && err.message}) — nothing was changed; try again.` }, 502)

// POST /api/admin/payments/:reference/dispute/accept  { note? } — give in: the buyer is refunded by Paystack.
async function acceptPaymentDispute(c) {
  const supabase = getSupabase(c.env)
  let body = {}
  try { body = await c.req.json() } catch (_) { body = {} }
  const note = typeof body?.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : ''
  const { payment, fail } = await loadDisputedPayment(c, supabase)
  if (fail) return fail
  if (payment.dispute_answered_at) return alreadyAnswered(c, payment)
  let disputeId, refundAmount
  try {
    const r = await resolveDispute(c.env, supabase, payment, { withAmount: true })
    disputeId = r.id
    refundAmount = disputedAmountFor(payment, r.claimed)
  } catch (err) { return paystackFailure(c, err) }
  if (!disputeId) return c.json(NOT_FOUND_ID, 404)
  try {
    await paystackService.acceptDispute(c.env, disputeId, { message: note || 'Dispute accepted by the merchant', refundAmount })
  } catch (err) { return paystackFailure(c, err) }
  const partial = refundAmount < payment.amount_cents
  await markDisputeAnswered(supabase, payment, 'accepted')
  await logAdminAction(c, supabase, 'payment.dispute_accept', 'payment', payment.id, { reference: payment.paystack_ref, hasNote: !!note, refundAmount, partial })
  return c.json({ success: true, message: partial
    ? `Dispute accepted with Paystack for ${refundAmount} of the ${payment.amount_cents} paid. Only that part is refunded, so the payment is NOT reversed automatically — decide in Admin → Payments (Reverse if the whole sale should come back).`
    : 'Dispute accepted with Paystack. The buyer is refunded by Paystack; this payment is marked REFUNDED (commission reversed, credential revoked) when Paystack confirms — usually within minutes.' })
}

// Webhooks round 27 (G2): when this scan's work was last delivered (scans.fix_delivered_at, 0110 - stamped by a trigger whenever the status
// becomes FIX_DELIVERED, so no delivery path can forget it). null when unknown: not applied yet, or delivered before 0110.
async function loadDeliveredAt(supabase, scanId) {
  const { data, error } = await supabase.from('scans').select('fix_delivered_at').eq('id', scanId).maybeSingle()
  if (error) { if (!isColumnMissing(error)) throw error; return null }
  const v = data && data.fix_delivered_at
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null
}

// POST /api/admin/payments/:reference/dispute/evidence  { customerPhone, serviceDetails?, deliveryAddress? }
// Name and email come from the buyer's account; the service description is built from the order unless the admin writes one.
async function submitDisputeEvidence(c) {
  const supabase = getSupabase(c.env)
  let body = {}
  try { body = await c.req.json() } catch (_) { body = {} }
  const clip = (v, n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : ''
  const phone = clip(body?.customerPhone, 40)
  if (!/^[+0-9][0-9 ()\-]{5,}$/.test(phone)) return c.json({ success: false, message: 'Enter the buyer\'s phone number (Paystack requires one with the evidence).' }, 400)
  const { payment, fail } = await loadDisputedPayment(c, supabase)
  if (fail) return fail
  const { data: user, error: userErr } = payment.user_id
    ? await supabase.from('users').select('email, name').eq('id', payment.user_id).maybeSingle() : { data: null, error: null }
  if (userErr) throw userErr
  if (!user || !user.email) return c.json({ success: false, message: 'The buyer\'s account no longer exists — respond in the Paystack dashboard.' }, 409)
  let disputeId
  try { disputeId = (await resolveDispute(c.env, supabase, payment)).id } catch (err) { return paystackFailure(c, err) }
  if (!disputeId) return c.json(NOT_FOUND_ID, 404)

  const when = (payment.paid_at || payment.created_at || '').slice(0, 10)
  // Webhooks round 27 (G2): the delivery date Paystack asks for is when the work was delivered, not when it was paid for.
  const deliveredAt = payment.scan_id ? (await loadDeliveredAt(supabase, payment.scan_id)) : null
  const deliveredDay = deliveredAt ? deliveredAt.slice(0, 10) : ''
  const details = clip(body?.serviceDetails, 1500) ||
    `Digital service delivered online: ${serviceSentence(payment.fix_tier).what}${payment.fix_tier ? ` (${constants.tierLabel(payment.fix_tier)})` : ''} ` +
    `(scan ${payment.scan_id || 'n/a'}), paid on ${when || 'n/a'}${deliveredDay ? `, delivered on ${deliveredDay}` : ''} under Paystack reference ${payment.paystack_ref}. ${serviceSentence(payment.fix_tier).how}`
  const fields = {
    customer_email: user.email, customer_name: clip(user.name, 120) || user.email, customer_phone: phone, service_details: details,
  }
  const deliveryDay = /^\d{4}-\d{2}-\d{2}$/.test(deliveredDay) ? deliveredDay : when
  if (/^\d{4}-\d{2}-\d{2}$/.test(deliveryDay)) fields.delivery_date = deliveryDay
  const addr = clip(body?.deliveryAddress, 300)
  if (addr) fields.delivery_address = addr
  let evidenceJson
  try { evidenceJson = await paystackService.addDisputeEvidence(c.env, disputeId, fields) } catch (err) { return paystackFailure(c, err) }
  // Webhooks round 16 (G1): Paystack wants the evidence's id quoted when a fraud-claim dispute is resolved. It used to be thrown away, so
  // "Send evidence" and "Contest" never connected. Best-effort: the evidence is already with Paystack either way.
  const evId = evidenceJson?.data?.id
  let evidenceLinked = false
  if ((typeof evId === 'string' || typeof evId === 'number') && String(evId).length <= 64) {
    const { error: linkErr } = await supabase.from('payments').update({ dispute_evidence_id: `${disputeId}:${evId}` }).eq('id', payment.id).eq('status', 'DISPUTED')
    if (linkErr) { if (!isColumnMissing(linkErr)) console.error('dispute evidence id not stored:', linkErr.message) } else evidenceLinked = true
  }
  await logAdminAction(c, supabase, 'payment.dispute_evidence', 'payment', payment.id, { reference: payment.paystack_ref, customText: !!clip(body?.serviceDetails, 1) })
  return c.json({ success: true, message: 'Evidence sent to Paystack. It does not close the dispute — watch for the resolution (Paystack\'s auto-accept deadline still applies).' +
    (evidenceLinked ? ' For a fraud claim, press Contest next: the evidence is sent along with your answer.' : '') })
}

// Webhooks round 15 (G1): contest a dispute. Builds a one-page proof of delivery, uploads it through Paystack's signed URL and
// resolves the dispute as `declined`. Only offered when this payment's own fix was actually delivered — otherwise there is nothing
// to prove and the honest answer is to accept. The payment is not touched here: Paystack's resolve webhook moves it (won → back to
// SUCCESS, lost → reversed), exactly as for an accept.
// Webhooks round 18 (B2): was this payment's work delivered? A paid retry round parks the scan at FIX_GENERATING (stuck ones are only
// recovered after 30 minutes) while the files from the first delivery are still there, and contest used to answer "not delivered — accept the
// dispute instead" in that window: with the ~16 h auto-accept clock running, that pushed an admin into giving up a dispute that could be won.
// Delivered = this payment owns the scan AND (FIX_DELIVERED, or FIX_GENERATING for a retry round on files that already exist).
// Round 19 (B2): what was actually sold, per tier. The evidence goes to Paystack and the card network, so it must not describe a
// rewritten resume for the credential-only (BADGE) tier. Tier names come from constants.tierLabel; the sentence is per product.
function serviceSentence(tier) {
  if (tier === 'BADGE')
    return { what: 'a verifiable credential (a public verification page and badge) issued for the buyer\'s own uploaded resume', how: 'The credential is available to the signed-in account holder and is verifiable on the app\'s public verification page.' }
  return { what: 'a rewritten resume generated from the buyer\'s own uploaded resume', how: 'The result is available to the signed-in account holder for download, and the work is verifiable on the app\'s public verification page.' }
}

function workWasDelivered(scan, payment) {
  if (!scan || !payment || scan.fix_payment_id !== payment.id) return false
  if (scan.status === 'FIX_DELIVERED') return true
  return scan.status === 'FIX_GENERATING' && (Number(scan.fix_retry_count) || 0) > 0 && !!scan.resume_ats_path
}

async function contestPaymentDispute(c) {
  const supabase = getSupabase(c.env)
  let body = {}
  try { body = await c.req.json() } catch (_) { body = {} }
  const note = typeof body?.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : ''
  const { payment, fail } = await loadDisputedPayment(c, supabase)
  if (fail) return fail
  if (payment.dispute_answered_at) return alreadyAnswered(c, payment)
  if (!payment.scan_id) return c.json({ success: false, message: 'This payment has no scan, so there is no delivered work to prove — accept the dispute instead.' }, 409)
  const { data: scan, error: scanErr } = await supabase.from('scans')
    .select('id, status, fix_payment_id, fix_tier, fix_retry_count, resume_ats_path, verification_code, verification_status').eq('id', payment.scan_id).maybeSingle()
  if (scanErr) throw scanErr
  if (!workWasDelivered(scan, payment))
    return c.json({ success: false, message: 'The work for this payment was not delivered (or another payment owns it) — there is nothing to prove. Accept the dispute instead.' }, 409)
  const { data: user, error: userErr } = payment.user_id
    ? await supabase.from('users').select('email').eq('id', payment.user_id).maybeSingle() : { data: null, error: null }
  if (userErr) throw userErr
  const deliveredAt = await loadDeliveredAt(supabase, scan.id)
  // receipt_delivered_at (0036) is set only after the receipt email was actually sent - a second, independent proof the buyer was told.
  let receiptAt = null
  {
    const { data: rc, error: rcErr } = await supabase.from('payments').select('receipt_delivered_at').eq('id', payment.id).maybeSingle()
    if (rcErr) { if (!isColumnMissing(rcErr)) throw rcErr } else if (rc && typeof rc.receipt_delivered_at === 'string' && !Number.isNaN(Date.parse(rc.receipt_delivered_at))) receiptAt = new Date(rc.receipt_delivered_at).toISOString()
  }

  let dispute
  try { dispute = await resolveDispute(c.env, supabase, payment, { withAmount: true }) } catch (err) { return paystackFailure(c, err) }
  if (!dispute.id) return c.json(NOT_FOUND_ID, 404)
  const evidence = evidenceIdFor(payment, dispute.id)

  const money = `${(payment.amount_cents / 100).toFixed(2)} ${payment.currency || ''}`.trim()
  const lines = [
    `Merchant: Passthrough (${String(c.env.FRONTEND_URL || '').replace(/^https?:\/\//, '')})`,
    `Paystack reference: ${payment.paystack_ref}`,
    `Amount: ${money}`,
    `Paid on: ${(payment.paid_at || payment.created_at || '').slice(0, 10) || 'n/a'}`,
    ...(user && user.email ? [`Buyer account: ${user.email}`] : []),
    '',
    `Service: ${serviceSentence(scan.fix_tier || payment.fix_tier).what} (${constants.tierLabel(scan.fix_tier || payment.fix_tier)}). It is a digital service delivered online; there is nothing to ship.`,
    `Delivery: completed${deliveredAt ? ` on ${deliveredAt}` : ''}. ${serviceSentence(scan.fix_tier || payment.fix_tier).how.replace(/^The (result|credential) is available/, 'It is available')} (scan ${scan.id}).`,
    ...(receiptAt ? [`Payment receipt emailed to the buyer's account address on ${receiptAt}.`] : []),
    ...(scan.verification_code && scan.verification_status === 'ACTIVE' && c.env.FRONTEND_URL
      ? [`Public verification page for the delivered work: ${c.env.FRONTEND_URL}/v/${scan.verification_code}`] : []),
    ...(note ? ['', `Merchant note: ${note}`] : []),
    '',
    `Generated ${new Date().toISOString()}.`,
  ]
  const bytes = buildProofPdf({ title: 'Proof of service delivery', lines })
  const fileName = `proof-${String(payment.paystack_ref).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'payment'}.pdf`
  try {
    const up = await paystackService.getDisputeUploadUrl(c.env, dispute.id, fileName)
    await paystackService.uploadDisputeProof(up.signedUrl, bytes, 'application/pdf')
    await paystackService.declineDispute(c.env, dispute.id, {
      message: note || 'The digital service was delivered to the buyer. Proof of delivery attached.',
      // Webhooks round 16 (G1): the amount the dispute is for (as accept does since round 15), not always the whole payment; and the evidence id.
      refundAmount: disputedAmountFor(payment, dispute.claimed), uploadedFilename: up.fileName, evidence,
    })
  } catch (err) {
    // A fraud claim needs evidence on file (Paystack: Manage Disputes). Say what to do instead of only relaying the refusal.
    if (err && err.paystackRejected && !evidence && /evidence/i.test(err.message || ''))
      return c.json({ success: false, message: `Paystack refused it: ${err.message} — this looks like a fraud claim. Use "Send evidence" first (it needs the buyer's phone number), then Contest again.` }, 422)
    return paystackFailure(c, err)
  }
  await markDisputeAnswered(supabase, payment, 'contested')
  await logAdminAction(c, supabase, 'payment.dispute_contest', 'payment', payment.id, { reference: payment.paystack_ref, hasNote: !!note, withEvidence: !!evidence })
  return c.json({ success: true, message: 'Dispute contested with Paystack, with a proof of delivery attached. The payment stays DISPUTED until Paystack reports the outcome (won → back to SUCCESS, lost → refunded and reversed automatically).' })
}

// GET /api/admin/payments/:reference/webhook-events — every inbox row for this payment, oldest first (support used to search the
// Webhooks page by reference). Includes how long each took (G3).
async function getPaymentTimeline(c) {
  const supabase = getSupabase(c.env)
  const reference = String(c.req.param('reference') || '').slice(0, 120)
  const cols = 'id, event_type, status, attempts, note, error, received_at, processed_at'
  const run = fields => supabase.from('webhook_events').select(fields).eq('reference', reference).eq('provider', 'paystack')
    .order('received_at', { ascending: false }).limit(100)   // round 25: the NEWEST 100 (a long history used to show the oldest), re-ordered below
  let { data, error } = await run(`${cols}, processing_ms`)
  if (error && isColumnMissing(error)) ({ data, error } = await run(cols))
  if (error && isColumnMissing(error)) ({ data, error } = await run('id, event_type, status, attempts, error, received_at, processed_at'))
  if (error) throw error
  return c.json({ success: true, data: (data || []).slice().reverse().map(r => ({
    id: r.id, eventType: r.event_type, status: r.status, attempts: r.attempts,
    note: r.status === 'FAILED' ? null : (r.note || r.error || null), error: r.status === 'FAILED' ? (r.error || null) : null,
    receivedAt: r.received_at, processedAt: r.processed_at, processingMs: Number.isFinite(r.processing_ms) ? r.processing_ms : null,
  })) })
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
async function closeResolvedHeldEvents(supabase, { reference = null, limit = 100, maxPages = 5 } = {}) {
  const closed = []
  try {
    // ROUND-11 (B4): only the oldest `limit` HELD rows were ever looked at, so a backlog of rows that are still waiting on a
    // person (never closable) at the front hid every newer, resolved one. Page past them (bounded).
    let cursor = null   // received_at of the last row seen: closing rows shifts offsets, a cursor does not
    for (let page = 0; page < (reference ? 1 : maxPages); page++) {
      let q = supabase.from('webhook_events').select('id, reference, received_at').eq('status', 'HELD')
      if (!reference && cursor) q = q.gt('received_at', cursor)
      q = reference ? q.eq('reference', reference) : q.order('received_at', { ascending: true }).limit(limit)
      const { data: held, error } = await q
      if (error || !held || !held.length) break
      const refs = [...new Set(held.map(h => h.reference).filter(Boolean))]
      if (refs.length) {
        const { data: pays, error: payErr } = await supabase.from('payments').select('paystack_ref, status').in('paystack_ref', refs)
        if (payErr || !pays) break
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
      }
      if (held.length < limit) break
      cursor = held[held.length - 1].received_at
      if (!cursor) break
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
    const { data, error } = await withStaleCol(() => supabase.from('webhook_events')
      .update({ status: 'IGNORED', processed_at: iso, note: 'closed — unfinished, nothing stored to re-run' })
      .eq('status', 'RECEIVED').is('payload', null)
      .lt(staleColumn(), new Date(now - REDRIVE_MIN_AGE_MS).toISOString())
      .neq('event_type', 'charge.success').not('event_type', 'like', 'refund.%').not('event_type', 'like', 'charge.dispute%')
      .select('id'))
    if (error) { console.error('closeUnrunnableReceived failed:', error.message); return [] }
    return (data || []).map(r => r.id)
  } catch (err) {
    console.error('closeUnrunnableReceived error:', err.message)
    return []
  }
}

// Closes rows the re-drive window cannot ever run (see B3 in redriveStaleEvents). Conditional on the row still being unfinished, so a
// row another worker finished meanwhile is left alone. Returns the rows actually closed. Never throws.
async function closeUnreadableStored(supabase, rows, { now = Date.now() } = {}) {
  const closed = []
  const iso = new Date(now).toISOString()
  for (const row of rows) {
    try {
      const { data, error } = await supabase.from('webhook_events')
        .update({ status: 'IGNORED', processed_at: iso, note: 'closed — stored payload is not a replayable event' })
        .eq('id', row.id).in('status', ['FAILED', 'RECEIVED']).select('id')
      if (error) { console.error('closeUnreadableStored failed:', error.message); continue }
      if (Array.isArray(data) && data.length) closed.push(row)
    } catch (err) { console.error('closeUnreadableStored error:', err && err.message) }
  }
  return closed
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
    .in('status', ['FAILED', 'RECEIVED']).lt(staleColumn(), old)
    .lt(withCol ? 'redrives' : 'attempts', MAX_REDRIVES)
    .not('payload', 'is', null)
    .order('received_at', { ascending: true }).limit(REDRIVE_PER_RUN * 3)
  let useRedrives = true
  let { data: rows, error } = await withStaleCol(() => runnable(true))
  if (error && isColumnMissing(error)) { useRedrives = false; ({ data: rows, error } = await withStaleCol(() => runnable(false))) }
  if (error) { result.error = error.message; return result }

  let ran = 0
  const unreadable = []
  for (const row of rows || []) {
    if (ran >= REDRIVE_PER_RUN) break
    // Webhooks round 17 (B3): a row whose stored payload has no readable event/type used to be skipped here WITHOUT leaving the window, so
    // enough of them (the window is REDRIVE_PER_RUN * 3 oldest-first) starved every newer failure for ever. They are closed below instead.
    if (!storedKind(row)) { unreadable.push(row); continue }
    const r = await runStoredEvent(c, supabase, row, { redrive: useRedrives })
    if (r.skipped) continue                     // another run (admin replay, live redelivery) has the row — not ours to count
    ran++
    result.redriven.push(row.id)
    // ROUND-11 (B3): only PROCESSED is a recovery — a re-run that ends IGNORED (payment still missing…) or HELD did no work.
    if (r.ok && r.outcome.status === 'PROCESSED') result.recovered.push({ id: row.id, event: row.event_type, reference: row.reference, status: r.outcome.status })
  }

  // Exhausted: said ONCE per row (7-day cooldown), newest first so a fresh failure is never hidden
  // behind old ones. Their payload stays viewable and replayable from Admin → Webhooks.
  const spentQ = () => supabase.from('webhook_events')
    .select('id, provider, status, attempts, event_type, reference')
    .in('status', ['FAILED', 'RECEIVED']).lt(staleColumn(), old)
    .gte(useRedrives ? 'redrives' : 'attempts', MAX_REDRIVES)
    .order('received_at', { ascending: false }).limit(25)
  const { data: spent, error: spentErr } = await withStaleCol(() => spentQ())
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
  if (unreadable.length) {
    const closed = await closeUnreadableStored(supabase, unreadable, { now })
    result.unrunnableClosed = result.unrunnableClosed.concat(closed.map(r => r.id))
    const money = closed.filter(r => isActionableEvent(r.event_type || ''))
    if (money.length && await alertAllowed(env, 'webhook-alert-cooldown:unreadable-stored', 24 * 3600))
      alert(c, `${money.length} stored webhook event(s) could not be re-run`,
        `The stored payload of ${money.map(r => `${r.event_type} (${r.reference || r.id})`).join(', ')} has no readable event type, so it can never be replayed; the row was closed as IGNORED ` +
        `(note: "stored payload is not a replayable event") rather than left to block newer failures from being re-driven. ` +
        `Check each reference under Payments → Reconcile / Recheck.`, 'unreadable-stored')
  }

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

// ── dispute reconciliation (hourly cron, see index.js) ───────────────────────
// ROUND-10 (G1/B4): a lost charge.dispute.create was recovered by nothing, a lost charge.dispute.resolve left the
// payment DISPUTED (or a lost sale never reversed) for good, and Paystack auto-accepts an unanswered dispute after
// ~16 hours. This lists Paystack's own disputes and, for each one whose payment this app has not caught up with,
// runs the same handler a live delivery would (processDispute) on a synthetic event built from the API item:
//   unresolved dispute + payment SUCCESS                       → charge.dispute.create  (marks DISPUTED, pages the owner)
//   resolved dispute  + payment DISPUTED / unsettled           → charge.dispute.resolve (clears it, or reverses the sale)
//   resolved ACCEPTED + payment still SUCCESS                  → charge.dispute.resolve (reverses the sale)
// Anything already in step is left alone, so a healthy system runs no handler and sends nothing. Never throws.
const DISPUTE_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000
const MAX_DISPUTES_PER_RUN = 20
const DISPUTE_PAGE_SIZE = 100
const DISPUTE_MAX_PAGES = 5
const isoDay = ms => new Date(ms).toISOString().slice(0, 10)

function disputeIsResolved(d) {
  // Webhooks round 23 (B3): `archived` is closed too (checkDisputeDeadlines already treats it as past the merchant's turn); an archived
  // dispute with no resolution must never be read as an open one and re-mark a settled payment DISPUTED.
  return !!d && (['resolved', 'archived'].includes(String(d.status || '').toLowerCase()) || !!d.resolution)
}

// Round 19 (G1): the list above only reaches DISPUTE_LOOKBACK_MS back, and sweepReversedPayments only looks at payments created in
// that window — but a bank chargeback can stay open far longer. A lost resolve webhook for such a dispute left the payment DISPUTED
// for good (a lost sale never reversed, a won one never counted again). This walks DISPUTED payments OLDER than the window, a few per
// run, oldest-checked first (dispute_checked_at rotates them), asks Paystack for each by its dispute id, and hands the answers to the
// same decision loop as the listed ones. A payment without a stored dispute id is looked up in Paystack's list around its disputed_at.
const OLD_DISPUTES_PER_RUN = 10
async function fetchOldOpenDisputes(env, supabase, now, alreadyListed = new Set()) {
  const out = []
  try {
    const cutoff = new Date(now - DISPUTE_LOOKBACK_MS).toISOString()
    const cols = 'id, paystack_ref, dispute_id, disputed_at, paid_at, created_at'
    // Round 24 (B5): this sweep rotates on its OWN marker. last_reconciled_at belongs to sweepReversedPayments (it skips a payment stamped
    // recently), so stamping it here made the lost-dispute backstop skip every dispute this sweep had just looked at.
    let { data, error } = await supabase.from('payments').select(`${cols}, dispute_checked_at`)
      .eq('status', 'DISPUTED')
      .or(`disputed_at.lt.${cutoff},and(disputed_at.is.null,created_at.lt.${cutoff})`)
      .order('dispute_checked_at', { ascending: true, nullsFirst: true }).limit(OLD_DISPUTES_PER_RUN)
    let tracked = true
    if (error && isColumnMissing(error)) {
      tracked = false
      ;({ data, error } = await supabase.from('payments').select(cols).eq('status', 'DISPUTED')
        .or(`disputed_at.lt.${cutoff},and(disputed_at.is.null,created_at.lt.${cutoff})`).order('created_at', { ascending: true }).limit(OLD_DISPUTES_PER_RUN))
    }
    if (error) { console.error('old open disputes query:', error.message); return out }
    for (const p of data || []) {
      if (p.dispute_id && alreadyListed.has(String(p.dispute_id))) continue   // the listing already carries it
      try {
        const r = await resolveDispute(env, supabase, p, { withAmount: false })
        if (r.id) {
          const json = await paystackService.fetchDispute(env, r.id)
          const d = json && json.data
          if (d && typeof d === 'object' && !alreadyListed.has(String(d.id ?? r.id))) {
            const tx = d.transaction && typeof d.transaction === 'object' ? d.transaction : {}
            out.push({ ...d, id: d.id ?? r.id, transaction: { ...tx, reference: typeof tx.reference === 'string' && tx.reference ? tx.reference : p.paystack_ref } })
          }
        }
      } catch (err) { console.error(`old open dispute ${p.paystack_ref} not checked:`, err && err.message) }
      if (tracked) { try { await supabase.from('payments').update({ dispute_checked_at: new Date(now).toISOString() }).eq('id', p.id) } catch (_) { /* rotation marker only */ } }
    }
  } catch (err) { console.error('old open disputes error:', err && err.message) }
  return out
}

async function sweepDisputes(env, ctx, supabase = getSupabase(env), { now = Date.now(), list = null } = {}) {
  const result = { checked: 0, actioned: [], failed: [], needsHuman: [], answeredElsewhere: [], error: null }
  try {
    if (!env.PAYSTACK_SECRET_KEY) return result
    // ROUND-11 (G4): the default fetch pages through Paystack's list (it used to read the first 100 only, silently dropping the
    // rest of a busy window). An injected `list` (tests) answers once, as before.
    const fetchList = list || (async () => {
      const all = []
      for (let page = 1; page <= DISPUTE_MAX_PAGES; page++) {
        const r = await paystackService.listDisputes(env, { from: isoDay(now - DISPUTE_LOOKBACK_MS), to: isoDay(now + 24 * 3600 * 1000), page, perPage: DISPUTE_PAGE_SIZE })
        const items = Array.isArray(r?.data) ? r.data : []
        all.push(...items)
        if (items.length < DISPUTE_PAGE_SIZE) break
      }
      return { data: all }
    })
    const body = await fetchList()
    const listed = Array.isArray(body?.data) ? body.data : []
    const seen = new Set(listed.filter(d => d && d.id != null).map(d => String(d.id)))
    const older = await fetchOldOpenDisputes(env, supabase, now, seen)
    const disputes = [...listed, ...older].filter(d => d && d.transaction && typeof d.transaction.reference === 'string')
    result.checked = disputes.length
    if (!disputes.length) return result

    const refs = [...new Set(disputes.map(d => d.transaction.reference))]
    const statusOf = new Map()
    for (let i = 0; i < refs.length; i += 100) {
      // Webhooks round 26 (B1): dispute_id (migration 0086) says which dispute the payment tracks; a Worker deployed ahead of it behaves as before.
      const load = cols => supabase.from('payments').select(cols).in('paystack_ref', refs.slice(i, i + 100))
      let { data, error } = await load('paystack_ref, status, amount_cents, dispute_id')
      if (error && isColumnMissing(error)) ({ data, error } = await load('paystack_ref, status, amount_cents'))
      if (error) { result.error = error.message; return result }
      for (const p of data || []) statusOf.set(p.paystack_ref, { status: p.status, amount: p.amount_cents, disputeId: p.dispute_id != null ? String(p.dispute_id).trim() : '' })
    }

    const c = { env, executionCtx: ctx }
    for (const d of disputes) {
      if (result.actioned.length + result.failed.length >= MAX_DISPUTES_PER_RUN) break   // round 28: failures spend a slot too (a handler that keeps failing used to be run for every listed dispute, every hour)
      const known = statusOf.get(d.transaction.reference)
      if (!known) continue                                   // not one of this app's payments
      const st = known.status
      const resolved = disputeIsResolved(d)
      const resolution = String(d.resolution || '').toLowerCase()
      let type = null
      if (!resolved && st === 'SUCCESS') type = 'charge.dispute.create'
      else if (resolved && (st === 'DISPUTED' || fulfillment.REVIVABLE_STATUSES.includes(st))) type = 'charge.dispute.resolve'
      else if (resolved && /accept/.test(resolution) && st === 'SUCCESS') type = 'charge.dispute.resolve'
      if (!type) continue
      // Skip what processDispute would leave unchanged, or the sweep would re-run (and re-email) it every hour:
      // an unrecognised resolution, a declined dispute on a payment that is not DISPUTED, and a PARTIAL accepted dispute
      // (left for a human, like a partial refund).
      if (type === 'charge.dispute.resolve') {
        if (!/accept|declin/.test(resolution)) {
          // Round 30: a resolved / archived dispute with no resolution this app recognises used to be skipped in silence, leaving the payment
          // DISPUTED. Mark it answered (it is past our turn) and page the owner once a week per dispute.
          if (st === 'DISPUTED') {
            await markDisputeAnswered(supabase, { paystack_ref: d.transaction.reference }, 'resolved')
            if (await alertAllowed(env, `webhook-alert-cooldown:dispute-unrecognised:${d.id ?? d.transaction.reference}`, 7 * 24 * 3600))
              alert(c, 'Dispute closed on Paystack with an unrecognised outcome',
                `reference: ${d.transaction.reference}\ndispute: ${d.id ?? '?'}\nstatus: ${d.status || '?'}\nresolution: ${d.resolution || '(none)'}\n\n` +
                `Paystack reports this dispute as closed, but not as accepted or declined, so the payment was left DISPUTED. Check the outcome in Paystack, then use Admin → Payments → Reverse (lost) or Clear dispute (won). Emailed once a week per dispute.`, `${d.transaction.reference}:dispute-unrecognised`)
          }
          continue
        }
        // Webhooks round 26 (B1): a DECLINED resolution for a dispute the payment no longer tracks (a newer one is open) changes nothing in
        // processDispute (round 25, B3), so the sweep must not pick it again every hour - each run re-emailed the owner until the newer dispute
        // resolved. Round 27 (B1): only declined. An ACCEPTED resolution is money returned to the buyer whichever dispute it was, and
        // processDispute reverses the sale for it regardless of which dispute is tracked - skipping it here left a lost older dispute
        // unreversed (and silent) for as long as the newer one stayed open whenever its resolve webhook was the thing that got lost.
        if (/declin/.test(resolution) && st === 'DISPUTED' && known.disputeId && d.id != null && String(d.id).trim() !== '' && String(d.id).trim() !== known.disputeId) continue
        if (/declin/.test(resolution) && st !== 'DISPUTED') continue
        const disputed = Number(d.refund_amount)
        if (/accept/.test(resolution) && Number.isFinite(disputed) && disputed > 0 && known.amount > 0 && disputed < known.amount) {
          // ROUND-11 (G4): left for a human — but if the resolve webhook was the thing that got lost, nobody has been told.
          result.needsHuman.push({ reference: d.transaction.reference, dispute: d.id ?? null, disputed, paid: known.amount })
          await markDisputeAnswered(supabase, { paystack_ref: d.transaction.reference }, 'resolved')   // resolved by Paystack, now waiting on a person (round 19)
          continue
        }
      }
      // ROUND-11 (B1): a create this app already acted on (a live delivery, or an earlier run of this sweep) is not re-run: an admin may
      // have cleared the dispute since while Paystack still lists it open, and re-running would put the payment straight back to DISPUTED.
      if (type === 'charge.dispute.create' && await disputeEventProcessed(supabase, 'charge.dispute.create', d.id, { noteMatches: /marked DISPUTED/ })) continue
      try {
        const event = minimalDisputeEvent({ event: type, data: d })
        const outcome = await processDispute(c, supabase, event)
        // Record it in the inbox as a finished event under the key a live delivery would use. Without this a LATE real
        // charge.dispute.create (Paystack's retries run ~72h) is not deduped and — disputeResolutionSeen reads the inbox —
        // would re-mark a payment this sweep just cleared (round 5 B1, reintroduced by the sweep).
        if (d.id != null) {
          try {
            const rec = await recordEvent(supabase, { eventKey: eventKeyFor(event, ''), eventType: type, reference: d.transaction.reference, payload: { ...redactEvent(event), swept: true } })
            if (rec.mode !== 'done') await markEvent(supabase, rec, 'PROCESSED', `${SWEEP_NOTE}${outcome.note ? ` — ${outcome.note}` : ''}`)
            // Webhooks round 20 (B2): a LIVE create that was already PROCESSED (it ran while the payment was still PENDING, so its note is empty) comes back
            // 'done' and was never annotated — so the guard above ("this create already marked DISPUTED") could not recognise the sweep's own marking, and
            // after an admin used Clear dispute the next hourly run put the payment straight back to DISPUTED. Record the marking on the existing row.
            else if (rec.id && /marked DISPUTED/.test(String(outcome.note || ''))) await updateEvent(supabase, rec.id, { note: `${SWEEP_NOTE} — ${outcome.note}` })
          } catch (err) { console.error('dispute sweep: inbox record failed:', err && err.message) }
        }
        result.actioned.push({ reference: d.transaction.reference, dispute: d.id ?? null, type, note: outcome.note || null })
      } catch (err) {
        console.error(`dispute sweep failed for ${d.transaction.reference}:`, err && err.message)
        result.failed.push({ reference: d.transaction.reference, error: err && err.message })
      }
    }
    // Webhooks round 21 (G1): a dispute Paystack lists as awaiting the BANK was answered by the merchant (in its dashboard); record that on the payment.
    for (const d of disputes) {
      if (disputeIsResolved(d) || String(d.status || '').toLowerCase() !== 'awaiting-bank-feedback') continue
      if (!statusOf.has(d.transaction.reference)) continue
      if (await markDisputeAnsweredOutside(supabase, { paystack_ref: d.transaction.reference })) result.answeredElsewhere.push(d.transaction.reference)
    }
    for (const n of result.needsHuman) {
      if (!(await alertAllowed(env, `webhook-alert-cooldown:dispute-partial:${n.dispute ?? n.reference}`, 7 * 24 * 3600))) continue
      alert(c, 'Partially accepted dispute needs a decision',
        `reference: ${n.reference}\ndispute: ${n.dispute ?? '?'}\ndisputed: ${n.disputed} of ${n.paid} paid\n\n` +
        `Paystack reports this dispute as ACCEPTED for only part of the payment (the charge.dispute.resolve webhook did not arrive, so this was found by the sweep). ` +
        `The payment was left as it is: decide in Admin → Payments (Reverse if the whole sale should come back, Clear dispute if it should count again). Emailed once a week per dispute.`, `${n.reference}:dispute-partial`)
    }
    // ROUND-12 (G2): a dispute the sweep could not process used to reach only the console — the one recovery for a lost
    // dispute webhook failing, with Paystack's 16-hour auto-accept clock running, paged nobody. One summary, at most every 6 hours.
    if (result.failed.length && await alertAllowed(env, 'webhook-alert-cooldown:dispute-sweep-failed', 6 * 3600))
      alert(c, `Dispute sweep could not process ${result.failed.length} dispute(s)`,
        `The hourly dispute sweep found these disputes on Paystack but the handler failed, so this app has NOT caught up with them (Paystack auto-accepts an unanswered dispute after about 16 hours). It retries every hour; if it keeps failing, fix the cause (see the error) or handle them in Admin → Payments:\n\n` +
        result.failed.map(f => `${f.reference}  ${f.error || 'unknown error'}`).join('\n') + `\n\nEmailed at most every 6 hours.`, 'dispute-sweep-failed')
    if (result.actioned.length) console.error(`[CRITICAL] dispute sweep caught up with ${result.actioned.length} dispute(s) the webhooks did not deliver`)
    if (result.actioned.length && await alertAllowed(env, 'webhook-alert-cooldown:dispute-sweep', 6 * 3600))
      alert(c, `Dispute sweep: ${result.actioned.length} dispute(s) the webhook never delivered`,
        `Paystack reports these disputes, but this app's payments had not caught up (the charge.dispute.* webhook was lost or is not arriving). ` +
        `Each was run through the normal dispute handler (you also get that handler's own email):\n\n` +
        result.actioned.map(a => `${a.reference}  dispute ${a.dispute ?? '?'}  ${a.type}${a.note ? ` → ${a.note}` : ''}`).join('\n') +
        `\n\nCheck the webhook URL and signing key in the Paystack dashboard.`, 'dispute-sweep')
  } catch (err) {
    result.error = err && err.message
    console.error('dispute sweep error:', result.error)
  }
  return result
}

// ── dispute countdown (hourly cron, see index.js) ──────────────────────────────
// Webhooks round 18 (G1): payments.dispute_due_at (migration 0083) is stored the moment a dispute opens, but only the dashboard and the
// payments list ever read it. An open dispute that nobody answered was announced once (the create email) plus whatever reminders Paystack
// itself sends — both are emails that can be missed — and then Paystack auto-accepts and refunds the buyer after about 16 hours with nothing
// from this app in between. Each hour: a still-DISPUTED payment whose deadline is within DISPUTE_WARN_HOURS (default 6, env-tunable 1-15)
// pages the owner, at most once every 3 hours per payment, and says whether Contest is available (the work was delivered). A deadline that has
// just passed is reported too (Paystack may already have auto-accepted; its resolve webhook / the dispute sweep then reverses the sale).
// Notify-only, best effort, never throws; without migration 0083 there is no deadline to read and it does nothing.
const DISPUTE_WARN_DEFAULT_HOURS = 6
const DISPUTE_OVERDUE_GRACE_MS = 3 * 3_600_000
function disputeWarnMs(env) {
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')   // strict (round 14 convention): malformed / outside 1-15 -> the default 6
  return numEnv(env && env.DISPUTE_WARN_HOURS, DISPUTE_WARN_DEFAULT_HOURS, NUMERIC_ENV.DISPUTE_WARN_HOURS) * 3_600_000
}
// Paystack's own view: once a dispute is past the merchant's turn (answered in the dashboard, with the bank, or closed) the deadline
// page is noise. Any doubt (no key, Paystack down, an unfamiliar status) means "still ours" — an extra page beats a missed one.
const PAST_MERCHANT_TURN = new Set(['awaiting-bank-feedback', 'resolved', 'archived'])
async function disputeStatusOf(env, disputeId) {
  try {
    const json = await paystackService.fetchDispute(env, disputeId)
    return String(json && json.data && json.data.status || '').toLowerCase()
  } catch (_) { return '' }
}
async function disputeNoLongerAwaitingUs(env, disputeId) { return PAST_MERCHANT_TURN.has(await disputeStatusOf(env, disputeId)) }
async function checkDisputeDeadlines(env, ctx, supabase = getSupabase(env), { now = Date.now() } = {}) {
  const result = { checked: 0, alerted: [], error: null }
  try {
    const horizon = new Date(now + disputeWarnMs(env)).toISOString()
    const floor = new Date(now - DISPUTE_OVERDUE_GRACE_MS).toISOString()
    // Round 19 (B1): an answered dispute (contested / accepted here, or already past the merchant's turn on Paystack) is not paged again.
    // dispute_answered_at is migration 0097, dispute_id 0086: each tier degrades to the one before it.
    const base = 'id, paystack_ref, scan_id, amount_cents, currency, dispute_due_at'
    let data = null, error = null
    for (const cols of [`${base}, dispute_id, dispute_answered_at`, `${base}, dispute_id`, base]) {
      ;({ data, error } = await supabase.from('payments').select(cols)
        .eq('status', 'DISPUTED').not('dispute_due_at', 'is', null)
        .lte('dispute_due_at', horizon).gte('dispute_due_at', floor)
        .order('dispute_due_at', { ascending: true }).limit(25))
      if (!(error && isColumnMissing(error) && !/dispute_due_at/.test(error.message || ''))) break
    }
    if (error) { if (!isColumnMissing(error)) result.error = error.message; return result }
    const rows = data || []
    result.checked = rows.length
    for (const p of rows) {
      const due = Date.parse(p.dispute_due_at)
      if (!Number.isFinite(due)) continue
      if (p.dispute_answered_at) { result.answered = (result.answered || 0) + 1; continue }
      if (p.dispute_id) {
        const st = await disputeStatusOf(env, p.dispute_id)
        if (PAST_MERCHANT_TURN.has(st)) {
          // Round 21 (G1): remember it, so the dashboard card and Admin -> Payments stop treating it as unanswered.
          if (st === 'awaiting-bank-feedback') await markDisputeAnsweredOutside(supabase, p)
          result.answered = (result.answered || 0) + 1; continue
        }
      }
      if (!(await alertAllowed(env, `webhook-alert-cooldown:dispute-deadline:${p.id}`, 3 * 3600))) continue
      result.alerted.push(p.paystack_ref)
      const line = disputeDeadlineLine({ due_at: p.dispute_due_at }, now).trim()
      alert({ env, executionCtx: ctx }, due <= now ? 'Dispute deadline has passed' : 'Dispute deadline approaching — answer it now',
        `reference: ${p.paystack_ref}\nscanId: ${p.scan_id || '(none)'}\namount: ${p.amount_cents} ${p.currency || ''}\n\n${line}\n\n` +
        `Admin → Payments → this payment: Contest dispute (sends a generated proof of delivery; only offered when the work was delivered), ` +
        `Send evidence, or Accept dispute. Emailed at most once every 3 hours per payment.`, `${p.paystack_ref}:dispute-deadline`)
    }
  } catch (err) {
    result.error = err && err.message
    console.error('dispute deadline check error:', result.error)
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

// ROUND-13 (G1): how many payments sit DISPUTED right now and which deadline is nearest — the dashboard card. Best effort:
// without migration 0083 (dispute_due_at) the count still works and the deadline is simply absent. Never throws.
async function openDisputeSummary(supabase) {
  const out = { count: 0, nextDueAt: null, overdue: 0, answered: 0 }
  try {
    const { count, error } = await supabase.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'DISPUTED')
    if (error) throw error
    out.count = count || 0
    if (!out.count) return out
    // Webhooks round 20 (B3): a dispute already answered (contested / accepted here, or resolved and waiting on a person) is past our turn —
    // its stored deadline is history, yet it was counted "past deadline" and, being the oldest, hid the next REAL deadline. Only disputes
    // still awaiting us feed nextDueAt / overdue. dispute_answered_at is migration 0097: without it every dispute counts as awaiting.
    let rows = null, answeredKnown = true
    {
      const r = await supabase.from('payments').select('dispute_due_at, dispute_answered_at')
        .eq('status', 'DISPUTED').not('dispute_due_at', 'is', null).order('dispute_due_at', { ascending: true }).limit(200)
      if (!r.error) rows = r.data
      else {
        answeredKnown = false
        const r2 = await supabase.from('payments').select('dispute_due_at')
          .eq('status', 'DISPUTED').not('dispute_due_at', 'is', null).order('dispute_due_at', { ascending: true }).limit(200)
        if (r2.error) return out                  // column missing (0083 not applied): the count above is still right
        rows = r2.data
      }
    }
    const list = rows || []
    const awaiting = answeredKnown ? list.filter(r => !r.dispute_answered_at) : list
    if (answeredKnown) out.answered = list.length - awaiting.length
    const times = awaiting.map(r => Date.parse(r.dispute_due_at)).filter(Number.isFinite)
    if (times.length) {
      out.nextDueAt = new Date(Math.min(...times)).toISOString()
      out.overdue = times.filter(t => t <= Date.now()).length
    }
  } catch (err) { console.error('open dispute summary:', err && err.message) }
  return out
}

// A webhook_events row the dispute sweep wrote (see sweepDisputes): flagged in its payload, and its note starts "caught up by the dispute sweep".
const SWEEP_NOTE = 'caught up by the dispute sweep'
const SWEEP_LOOKBACK = 50
function isSweepRow(r) {
  return !!(r && ((r.payload && r.payload.swept === true) || /^caught up by the dispute sweep/i.test(String(r.note || ''))))
}

async function computeWebhookHealth(supabase, { now = Date.now() } = {}) {
  const out = { available: true, lastEventAt: null, lastChargeSuccessAt: null, paidChecked: 0, paidWithoutEvent: 0, missingReferences: [], unrecovered: 0, unrecoveredReferences: [], lastResendEventAt: null, lastRejected: { paystack: null, resend: null }, rejectedSinceLastEvent: [] }
  try {
    // Webhooks round 20 (B1): the hourly dispute sweep writes its own inbox rows (stamped `swept` / "caught up by the dispute sweep") — they
    // are this app talking to Paystack, not Paystack reaching this app. Counting them as the "last event received" made one sweep clear the
    // red "deliveries are being refused" notice and the delivery-health clock while nothing real had got through. Look past them.
    const latest = async type => {
      let q = supabase.from('webhook_events').select('received_at, note, payload').eq('provider', 'paystack')   // Resend events have their own stamp below
      if (type) q = q.eq('event_type', type)
      const { data, error } = await q.order('received_at', { ascending: false }).limit(SWEEP_LOOKBACK)
      if (error) throw error
      const real = (data || []).find(r => !isSweepRow(r))
      return real ? real.received_at : null
    }
    out.lastEventAt = await latest(null)
    out.lastChargeSuccessAt = await latest('charge.success')

    // Round 24 (B4): a sale is judged by when it was PAID (paid_at, 0064), not when checkout began. A payment started before another one's webhook
    // arrived but paid after it was compared with the wrong clock and never counted as missing its event; and a checkout opened an hour ago
    // but paid a minute ago was held to a grace period it had long used up. Payments without paid_at fall back to created_at.
    const payCols = 'paystack_ref, amount_cents, status, created_at'
    const loadPays = cols => supabase.from('payments').select(cols)
      .in('status', ['SUCCESS', 'DISPUTED', 'REFUNDED'])
      .gte('created_at', new Date(now - HEALTH_WINDOW_MS).toISOString())
      .lt('created_at', new Date(now - HEALTH_GRACE_MS).toISOString())
      .order('created_at', { ascending: false }).limit(HEALTH_MAX_PAYMENTS)
    let { data: pays, error: payErr } = await loadPays(`${payCols}, paid_at`)
    if (payErr && isColumnMissing(payErr)) ({ data: pays, error: payErr } = await loadPays(payCols))
    if (payErr) throw payErr
    const paidAtMs = p => { const t = Date.parse(p.paid_at || p.created_at); return Number.isFinite(t) ? t : Date.parse(p.created_at) }
    // Free-credit redemptions never touch Paystack, so they never have a webhook.
    const paid = (pays || []).filter(p => p.paystack_ref && !String(p.paystack_ref).startsWith('credit:') && p.amount_cents > 0
      && paidAtMs(p) <= now - HEALTH_GRACE_MS && paidAtMs(p) >= now - HEALTH_WINDOW_MS)
    const refs = paid.map(p => p.paystack_ref)
    out.paidChecked = refs.length
    if (refs.length) {
      const seen = new Set()
      let latestSeenMs = 0   // when the newest charge.success for one of THIS app's payments arrived
      for (let i = 0; i < refs.length; i += 100) {
        const { data: evs, error: evErr } = await supabase.from('webhook_events')
          .select('reference, received_at').eq('event_type', 'charge.success').in('reference', refs.slice(i, i + 100))
        if (evErr) throw evErr
        for (const e of evs || []) { seen.add(e.reference); const t = Date.parse(e.received_at); if (t > latestSeenMs) latestSeenMs = t }
      }
      const missing = paid.filter(p => !seen.has(p.paystack_ref))
      out.paidWithoutEvent = missing.length
      out.missingReferences = missing.slice(0, 5).map(p => p.paystack_ref)
      // ROUND-11 (G3): a sale older than the newest charge.success we DID receive for our own payments is history — webhooks have
      // reached this app since. Only sales newer than that still point at a delivery problem, so the alert (and /healthz) clear as
      // soon as webhooks flow again instead of staying red until the sale ages out of the 7-day window.
      const unrecovered = missing.filter(p => !latestSeenMs || paidAtMs(p) > latestSeenMs)
      out.unrecovered = unrecovered.length
      out.unrecoveredReferences = unrecovered.slice(0, 5).map(p => p.paystack_ref)
    } else { out.unrecovered = 0; out.unrecoveredReferences = [] }
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
  // Support-inboxes round 1: when a customer last started a conversation in the support inbox (stamped by
  // resend-webhook.controller). Visibility only — "never" can simply mean nobody has written yet. Optional, like the stamp above.
  out.lastSupportThreadAt = null
  try {
    const { data } = await supabase.from('system_state').select('value').eq('key', 'support_inbox').maybeSingle()
    out.lastSupportThreadAt = data?.value?.last_thread_at || null
  } catch (_) { /* optional */ }
  // Webhooks round 17 (G1): the newest refused delivery per provider (stamped by handlePaystack / handleResend), and which providers
  // have been refused since the last delivery they got through. Never throws; a missing row reads as "none".
  out.lastRejected = await rejections.readRejections(supabase)
  out.rejectedSinceLastEvent = rejections.rejectedSinceLastEvent(out.lastRejected, { paystack: out.lastEventAt, resend: out.lastResendEventAt }, now)
  return out
}

// ── delivery-health alerting ──────────────────────────────────────────────────
// ROUND-9 (G1): computeWebhookHealth was only ever DISPLAYED (admin dashboard / Webhooks page). A webhook URL that was
// never saved, or points elsewhere, produces no requests at all — so not even the signature alert fires — while payments
// keep settling through the buyer's return visit and the sweeps. Refunds and disputes (16-hour auto-accept clock) have
// no such fallback. Returns a description of the problem, or null when delivery looks healthy / cannot be judged.
function deliveryProblem(health) {
  if (!health || health.available === false) return null
  // `unrecovered` (round 11) when the health object has it; older shapes fall back to the raw count.
  const n = typeof health.unrecovered === 'number' ? health.unrecovered : health.paidWithoutEvent
  if (!(n > 0)) return null
  const refs = (typeof health.unrecovered === 'number' ? (health.unrecoveredReferences || []) : (health.missingReferences || [])).join(', ')
  return `${n} paid sale(s) in the last 7 days (of ${health.paidChecked} checked) have no charge.success webhook on record and are newer than the last one received${refs ? ` — e.g. ${refs}` : ''}`
}

// Hourly (index.js) — emails the owner once per day while the condition holds. Never throws.
async function checkWebhookDelivery(env, ctx, supabase = getSupabase(env), { now = Date.now() } = {}) {
  try {
    const health = await computeWebhookHealth(supabase, { now })
    const problem = deliveryProblem(health)
    if (!problem) return { alerted: false, problem: null }
    console.error(`[CRITICAL] webhook delivery: ${problem}`)
    if (!(await alertAllowed(env, 'webhook-alert-cooldown:delivery-health', 24 * 3600))) return { alerted: false, problem }
    alert({ env, executionCtx: ctx }, 'Paystack webhooks may not be reaching this app',
      `${problem}.\n\nThey were settled by the buyer's return visit or the hourly sweeps, so payments still work — but refunds and disputes are announced by webhook first ` +
      `(a dispute is auto-accepted by Paystack after 16 hours), so they are being missed too. The hourly reversal and dispute sweeps ask Paystack ` +
      `directly and catch most of them within hours, but only for payments that sweep window still covers.\n\nCheck the webhook URL (…/api/webhooks/paystack) and the ` +
      `signing key in the Paystack dashboard, and PAYSTACK_WEBHOOK_IPS if set. Admin → Webhooks shows the same figures. Emailed at most once a day.`, 'webhook-delivery')
    return { alerted: true, problem }
  } catch (err) {
    console.error('webhook delivery check error:', err && err.message)
    return { alerted: false, problem: null }
  }
}

// Webhooks round 15 (G2): PAYSTACK_SECRET_KEY_PREVIOUS keeps verifying webhooks for as long as it is set, and nothing said so once
// the old key's retries had drained — a retired (possibly leaked) key kept signing valid refund / dispute events for ever.
// Hourly sweep: while it is set, tell the owner once a week to remove it. Never throws.
async function checkRetiredSecret(env, ctx) {
  try {
    const prev = env.PAYSTACK_SECRET_KEY_PREVIOUS
    if (!prev || prev === env.PAYSTACK_SECRET_KEY) return { alerted: false }
    if (!(await alertAllowed(env, 'webhook-alert-cooldown:previous-secret-set', 7 * 24 * 3600))) return { alerted: false }
    alert({ env, executionCtx: ctx }, 'PAYSTACK_SECRET_KEY_PREVIOUS is still set',
      'The Worker still accepts webhooks signed with the previous Paystack key. That is only meant for the ~72 hours after a key rotation, ' +
      'while Paystack finishes retrying events signed with the old key. If the rotation was more than a few days ago, remove it: ' +
      'wrangler secret delete PAYSTACK_SECRET_KEY_PREVIOUS. Emailed at most once a week while it stays set.', 'previous-secret-set')
    return { alerted: true }
  } catch (err) {
    console.error('retired secret check error:', err && err.message)
    return { alerted: false }
  }
}

// ── setup self-test ─────────────────────────────────────────────────────────────────────────────────────────────────
// Webhooks round 18 (G2): the only way to learn that the webhook URL, a signing secret, the IP list or a migration was wrong was for a
// real payment (or a real bounce) to fail first — Admin → Webhooks reports refusals only AFTER they happen. This checks what it can check
// from here, without sending a fake event (a synthetic delivery would land in the inbox and read as "a delivery got through", clearing the
// very warning it exists to protect). GET /api/admin/webhook-events/self-test → { endpoints, checks: [{ id, label, status: ok|warn|fail, detail }] }.
// Never throws; each check is independent.
const SELFTEST_PROBES = [
  { table: 'webhook_events', column: 'id', mig: '0025' }, { table: 'webhook_events', column: 'note', mig: '0036' },
  { table: 'webhook_events', column: 'redrives', mig: '0065' }, { table: 'webhook_events', column: 'processing_ms', mig: '0086' },
  { table: 'webhook_events', column: 'last_attempt_at', mig: '0090' }, { table: 'payment_refunds', column: 'id', mig: '0053' },
  { table: 'payments', column: 'dispute_due_at', mig: '0083' }, { table: 'payments', column: 'dispute_id', mig: '0086' },
  { table: 'payments', column: 'dispute_evidence_id', mig: '0090' },
  { table: 'payments', column: 'dispute_answered_at', mig: '0097' }, { table: 'users', column: 'email_bounced_at', mig: '0086' },
  { table: 'payments', column: 'refund_failed_at', mig: '0103' }, { table: 'payments', column: 'dispute_checked_at', mig: '0103' },
]
async function svixRoundTrip(secret) {
  // Sign a sample exactly as Svix does and verify it with the code that checks real deliveries: proves the secret decodes and verifies.
  const { verifySvixSignature } = require('../lib/svix')
  const raw = atob(String(secret).replace(/^whsec_/, ''))
  const keyBytes = Uint8Array.from(raw, ch => ch.charCodeAt(0))
  if (!keyBytes.length) return false
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const id = 'msg_selftest', ts = String(Math.floor(Date.now() / 1000)), body = '{"type":"selftest"}'
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))
  let bin = ''; for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b)
  return verifySvixSignature({ secret, id, timestamp: ts, signature: `v1,${btoa(bin)}`, body })
}

async function buildSelfTest(env, supabase, { origin = '' } = {}) {
  const checks = []
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail })
  const guard = async (id, label, fn) => { try { await fn() } catch (err) { add(id, label, 'fail', `could not be checked: ${err && err.message}`) } }
  const base = String(origin || '').replace(/\/+$/, '')

  await guard('paystack-secret', 'Paystack signing secret', async () => {
    const key = env.PAYSTACK_SECRET_KEY
    if (!key) return add('paystack-secret', 'Paystack signing secret', 'fail', 'PAYSTACK_SECRET_KEY is not set — every Paystack webhook is refused with 500.')
    const sample = new TextEncoder().encode('{"event":"selftest"}')
    const sig = await cryptoLib.hmacSha512Hex(key, sample)
    const ok = cryptoLib.timingSafeEqual(sig, await cryptoLib.hmacSha512Hex(key, sample)) && rejections.looksLikePaystackSignature(sig)
    const mode = /^sk_live_/.test(key) ? 'live' : /^sk_test_/.test(key) ? 'test' : null
    if (!ok) return add('paystack-secret', 'Paystack signing secret', 'fail', 'A sample could not be signed and verified with this key.')
    if (mode === 'test' && /^https:\/\//.test(base) && !/^https:\/\/(localhost|127\.0\.0\.1)/.test(base))
      return add('paystack-secret', 'Paystack signing secret', 'warn', 'A TEST-mode secret key (sk_test_) is set on a public https URL. Fine for staging; on the live site real payments will not go through and live webhooks will fail their signature.')
    if (!mode) return add('paystack-secret', 'Paystack signing secret', 'warn', 'The key does not start with sk_live_ / sk_test_ — check it is the secret key, not the public one.')
    add('paystack-secret', 'Paystack signing secret', 'ok', `A ${mode}-mode secret key is set and signs / verifies a sample. Paystack signs webhooks with this same key.`)
  })

  await guard('paystack-api', 'Paystack accepts the key', async () => {
    if (!env.PAYSTACK_SECRET_KEY) return add('paystack-api', 'Paystack accepts the key', 'fail', 'No key to try.')
    try {
      await paystackService.listDisputes(env, { perPage: 1 })
      add('paystack-api', 'Paystack accepts the key', 'ok', 'Paystack answered an authenticated request (dispute list) — the key is valid and the dispute sweep can run.')
    } catch (err) { add('paystack-api', 'Paystack accepts the key', 'fail', `Paystack refused or did not answer: ${err.message}. A wrong key also fails every webhook signature.`) }
  })

  await guard('paystack-previous', 'Retired Paystack key', async () => {
    if (!env.PAYSTACK_SECRET_KEY_PREVIOUS) return add('paystack-previous', 'Retired Paystack key', 'ok', 'No previous key is accepted.')
    if (env.PAYSTACK_SECRET_KEY_PREVIOUS === env.PAYSTACK_SECRET_KEY) return add('paystack-previous', 'Retired Paystack key', 'warn', 'PAYSTACK_SECRET_KEY_PREVIOUS equals the current key — remove it.')
    add('paystack-previous', 'Retired Paystack key', 'warn', 'PAYSTACK_SECRET_KEY_PREVIOUS is set: webhooks signed with the old key still verify. Remove it once retries have drained (~72 h after a rotation).')
  })

  await guard('paystack-ips', 'Paystack IP allow-list', async () => {
    const raw = env.PAYSTACK_WEBHOOK_IPS
    if (!raw || !String(raw).trim()) return add('paystack-ips', 'Paystack IP allow-list', 'ok', 'Not set — deliveries are accepted on the signature alone.')
    const { valid, invalid } = require('../lib/clientIp').parseIpAllowList(raw)
    if (!valid.length) return add('paystack-ips', 'Paystack IP allow-list', 'fail', 'PAYSTACK_WEBHOOK_IPS has no usable entry — EVERY Paystack webhook is refused with 403.')
    if (invalid.length) return add('paystack-ips', 'Paystack IP allow-list', 'warn', `${valid.length} usable entr${valid.length === 1 ? 'y' : 'ies'}; these match nothing: ${invalid.join(', ')}.`)
    add('paystack-ips', 'Paystack IP allow-list', 'ok', `${valid.length} entr${valid.length === 1 ? 'y' : 'ies'}. If Paystack changes its outbound IPs, deliveries are refused until this is updated.`)
  })

  await guard('resend-secret', 'Resend signing secret', async () => {
    const secret = env.RESEND_WEBHOOK_SECRET
    if (!secret) return add('resend-secret', 'Resend signing secret', 'fail', 'RESEND_WEBHOOK_SECRET is not set — bounces and spam complaints are refused with 500 and nobody is suppressed.')
    let ok = false
    try { ok = await svixRoundTrip(secret) } catch (_) { ok = false }
    if (!ok) return add('resend-secret', 'Resend signing secret', 'fail', 'The secret does not decode as a Svix signing secret (whsec_…) — every Resend delivery will fail verification.')
    add('resend-secret', 'Resend signing secret', 'ok', 'Decodes as a Svix secret and verifies a sample signed with it.')
  })

  await guard('schema', 'Database migrations', async () => {
    const missing = []
    for (const pr of SELFTEST_PROBES) {
      const { error } = await supabase.from(pr.table).select(pr.column).limit(1)
      if (error) missing.push(`${pr.mig} (${pr.table}.${pr.column})`)
    }
    // The refund total is one RPC (0053): without it a partial-refund total silently falls back to Paystack's list alone.
    // A nil-uuid payment, no event, p_count false: the function locks nothing, writes nothing and returns 0.
    if (typeof supabase.rpc === 'function') {
      const { error: rpcErr } = await supabase.rpc('record_refund_and_total', { p_payment_id: '00000000-0000-0000-0000-000000000000', p_reference: 'selftest', p_event_id: null, p_count: false })
      if (rpcErr && /could not find the function|42883|PGRST202/i.test(`${rpcErr.code || ''} ${rpcErr.message || ''}`)) missing.push('0053 (function record_refund_and_total)')
    }
    if (!missing.length) return add('schema', 'Database migrations', 'ok', 'Every table and column the webhook code reads is present.')
    add('schema', 'Database migrations', 'warn', `Not readable: ${[...new Set(missing)].join(', ')}. The code degrades gracefully, but apply these migrations.`)
  })

  await guard('delivery', 'Deliveries reaching the app', async () => {
    const h = await computeWebhookHealth(supabase)
    if (!h.available) return add('delivery', 'Deliveries reaching the app', 'warn', 'The inbox could not be read.')
    if (h.rejectedSinceLastEvent && h.rejectedSinceLastEvent.length)
      return add('delivery', 'Deliveries reaching the app', 'fail', `${h.rejectedSinceLastEvent.join(' and ')} deliveries are being refused (wrong signing key, blocked IP or missing secret) and nothing has got through since.`)
    if (deliveryProblem(h)) return add('delivery', 'Deliveries reaching the app', 'fail', deliveryProblem(h))
    add('delivery', 'Deliveries reaching the app', h.lastEventAt ? 'ok' : 'warn',
      h.lastEventAt ? `Last Paystack event ${h.lastEventAt}; last Resend event ${h.lastResendEventAt || 'never'}.` : 'No Paystack event has ever been received — register the URL below in the Paystack dashboard.')
  })

  return { endpoints: { paystack: base ? `${base}/api/webhooks/paystack` : null, resend: base ? `${base}/api/webhooks/resend` : null }, checks,
    ok: checks.every(c => c.status !== 'fail') }
}

// GET /api/admin/webhook-events/self-test
async function getWebhookSelfTest(c) {
  let origin = ''
  try { origin = new URL(c.req.url).origin } catch (_) { origin = '' }
  return c.json({ success: true, data: await buildSelfTest(c.env, getSupabase(c.env), { origin }) })
}

// GET /api/admin/webhook-events/health
async function getWebhookHealth(c) {
  return c.json({ success: true, data: await computeWebhookHealth(getSupabase(c.env)) })
}

module.exports = { scrubRefundPayloads, minimalRefundEvent, markDisputeAnsweredOutside, buildSelfTest, getWebhookSelfTest, checkDisputeDeadlines, disputeWarnMs, workWasDelivered, STALE_COL_RETRY_MS, closeUnreadableStored, checkRetiredSecret, claimEvent, acceptPaymentDispute, contestPaymentDispute, submitDisputeEvidence, getPaymentTimeline, pruneWebhookEvents, recordDisputeId, SLOW_EVENT_MS, recordEvent, markEvent, updateEvent, storedKind, closeUnrunnableReceived, computeWebhookHealth, getWebhookHealth, checkWebhookDelivery, deliveryProblem, disputeDeadlineLine, recordDisputeDeadline, openDisputeSummary, handlePaystack, listWebhookEvents, getWebhookEvent, replayWebhookEvent, dismissWebhookEvent, disputeEventProcessed, redriveStaleEvents, sweepDisputes, closeResolvedHeldEvents, scrubUnactionablePayloads, isActionableEvent, eventKeyFor, refundIsAmbiguous, redactEvent, MAX_BODY_BYTES }
