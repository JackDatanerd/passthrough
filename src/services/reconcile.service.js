// Automatic recovery for "paid, but never delivered".
//
// Background: fulfillment (payments.controller.js verifyPayment and
// webhooks.controller.js handlePaystack) is deliberately one-shot — an atomic
// PENDING -> SUCCESS flip decides which caller fulfils, and every later call
// sees SUCCESS and skips. That is what prevents double-fulfilment, but it also
// means any failure AFTER the flip (a transient Supabase error, FIX_QUEUE.send
// throwing, the isolate being killed, or — as actually happened — a plain code
// bug in one path) strands a paying customer with no fix and nothing that will
// ever retry. Both paths now email the owner and expose
// POST /api/payments/:reference/reconcile, but that still depends on a human
// noticing. This sweep (run hourly from the cron in index.js) closes the loop
// automatically.
//
// A payment is "orphaned" when it is SUCCESS, old enough that normal
// fulfilment must have finished (ORPHAN_MIN_AGE_MS), and either:
//   never-fulfilled — its scan still has fix_purchased = false, or
//   job-lost        — its scan has sat in FIX_PURCHASED for STUCK_PURCHASED_MS
//                     (the queue message never produced FIX_GENERATING).
//
// Safety: each recovery is an ATOMIC CLAIM (UPDATE ... WHERE still-orphaned
// RETURNING id). If a concurrent path fixed it first, zero rows come back and
// nothing is enqueued, so this cannot double-fulfil. Capped per run so a
// systemic fault can't flood the queue.
//
// AUDIT FIX (feature gap): this sweep re-ran the scan-update + FIX_QUEUE.send
// half of fulfilment, but never the referralService.recordConversion() half.
// Both payments.controller.js's verifyPayment and webhooks.controller.js's
// handlePaystack call recordConversion BEFORE the scans.update/queue.send —
// so a payment that never got far enough to reach fulfilment at all (an
// exception thrown earlier in the same async block, an isolate killed before
// recordConversion was even invoked) lands here as a "never-fulfilled"
// orphan having never had recordConversion attempted for it even once. The
// admin-triggered POST /:reference/reconcile already retries recordConversion
// for exactly this reason (see partners' commission-ledger comment there) —
// this automatic sweep was the one recovery path that didn't. Net effect: a
// referred sale could get its fix delivered (customer made whole) while the
// partner's commission silently never got recorded and nobody was ever told,
// since the sweep's own alert only covers reenqueued/failed re-delivery, not
// missing commissions. Fixed by attempting recordConversion for every
// claimed orphan, same as reconcilePayment does — it's a no-op for a
// no-referral payment (recorded: false, reason: 'no-referral') and is
// idempotent for one that already has a ledger row (commission_ledger.
// payment_id is unique — see migration 0012), so re-attempting it here for
// BOTH kinds (not just 'never-fulfilled') is always safe.
const ORPHAN_MIN_AGE_MS   = 10 * 60 * 1000
const STUCK_PURCHASED_MS  = 15 * 60 * 1000
const LOOKBACK_MS         = 7 * 24 * 60 * 60 * 1000
const MAX_PER_RUN         = 10

const referralService = require('./referral.service')
const fulfillment = require('./fulfillment.service')

function generatorFor(fixTier) {
  return fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
}

async function sweepOrphanedPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, orphans: 0, reenqueued: [], failed: [] }

  const { data: payments, error: payErr } = await supabase
    .from('payments')
    // referral_code_id + amount_cents added for recordConversion() below —
    // everything else here was already selected.
    .select('id, paystack_ref, scan_id, fix_tier, created_at, referral_code_id, amount_cents')
    .eq('status', 'SUCCESS')
    .gt('created_at', new Date(now - LOOKBACK_MS).toISOString())
    .lt('created_at', new Date(now - ORPHAN_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(200)
  if (payErr) { result.error = payErr.message; return result }
  result.checked = payments?.length || 0
  if (!result.checked) return result

  const scanIds = [...new Set(payments.map(p => p.scan_id).filter(Boolean))]
  const { data: scans, error: scanErr } = await supabase
    .from('scans').select('id, status, fix_purchased, updated_at').in('id', scanIds)
  if (scanErr) { result.error = scanErr.message; return result }
  const scanById = new Map((scans || []).map(s => [s.id, s]))

  const orphans = []
  const seen = new Set()
  for (const p of payments) {
    const scan = scanById.get(p.scan_id)
    if (!scan || seen.has(scan.id)) continue
    if (!scan.fix_purchased) {
      orphans.push({ payment: p, scan, kind: 'never-fulfilled' }); seen.add(scan.id)
    } else if (scan.status === 'FIX_PURCHASED' && Date.parse(scan.updated_at) < now - STUCK_PURCHASED_MS) {
      orphans.push({ payment: p, scan, kind: 'job-lost' }); seen.add(scan.id)
    }
  }
  result.orphans = orphans.length

  for (const { payment, scan, kind } of orphans.slice(0, MAX_PER_RUN)) {
    const fixTier = payment.fix_tier || 'FIX'
    try {
      // SECTION 7/8 AUDIT: record WHICH payment claimed the scan (fix_payment_id,
      // migration — see fulfillment.service.js), same as every other claim in the
      // codebase now does. Only set on the 'never-fulfilled' claim, which is the
      // one actually taking ownership; 'job-lost' is a re-enqueue of a scan this
      // payment already owns, and must not touch it (a DIFFERENT payment must
      // never be able to steal ownership by winning the FIX_PURCHASED-stuck race).
      const patch = kind === 'never-fulfilled'
        ? { fix_purchased: true, fix_tier: fixTier, status: 'FIX_PURCHASED', fix_payment_id: payment.id }
        : { status: 'FIX_PURCHASED' }
      let claim = supabase.from('scans').update(patch).eq('id', scan.id)
      claim = kind === 'never-fulfilled' ? claim.eq('fix_purchased', false) : claim.eq('status', 'FIX_PURCHASED')
      const { data: claimed, error: claimErr } = await claim.select('id')
      if (claimErr) throw claimErr
      if (!claimed || claimed.length === 0) continue   // a live path got there first — nothing to do

      await env.FIX_QUEUE.send({ type: generatorFor(fixTier), scanId: scan.id })

      // Same attribution recording the live fulfilment paths do, retried
      // here for the same reason reconcilePayment retries it — see the
      // AUDIT FIX comment above. Never throws; `env` is passed so a failure
      // pages the owner exactly like a live-path failure would
      // (notifyConversionFailure), independently of this function's own
      // reenqueued/failed alert below.
      const conversion = await referralService.recordConversion(supabase, payment, env)
      result.reenqueued.push({ reference: payment.paystack_ref, scanId: scan.id, kind, conversion })
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, scanId: scan.id, kind, error: err.message })
    }
  }

  if (alert && (result.reenqueued.length || result.failed.length)) {
    try {
      const emailService = require('./email.service')
      const lines = [
        // A separate, dedicated owner alert already fires from
        // recordConversion() itself when `conversion.ok` is false (see the
        // AUDIT FIX comment above) — this line is just so the commission
        // outcome is visible in THIS summary too, next to the delivery
        // outcome for the same payment, rather than only in a second email.
        ...result.reenqueued.map(r => `RECOVERED  ${r.reference}  scan ${r.scanId}  (${r.kind})` +
          (r.conversion && !r.conversion.ok ? `  [commission NOT recorded — see separate alert]` : '')),
        ...result.failed.map(r => `FAILED     ${r.reference}  scan ${r.scanId}  (${r.kind})  ${r.error}`),
      ]
      await emailService.sendOwnerAlert(env,
        `Payment sweep: ${result.reenqueued.length} recovered, ${result.failed.length} failed`,
        `Found ${result.orphans} paid-but-undelivered payment(s) (checked ${result.checked}).\n\n${lines.join('\n')}\n\n` +
        `Recovered items were re-enqueued automatically. Any occurrence means a fulfilment path failed ` +
        `silently — check wrangler tail for "[CRITICAL]" lines around the payment times.`)
    } catch (_) {}
  }
  return result
}

// ── Second concern in this file: stale PENDING -> ABANDONED ────────────────
//
// A DIFFERENT failure mode from the orphan sweep above: a customer opens
// Paystack checkout and simply never finishes — closes the tab, no card
// entered, browser crash. Nothing else in the app ever resolves this. The
// only existing ABANDONED write (initializePayment, payments.controller.js)
// fires solely when the SAME scan starts ANOTHER checkout later; a user who
// never returns at all leaves that row PENDING forever. Effects: a user's
// own getPaymentHistory shows a purchase that looks "still pending"
// indefinitely, and AdminPayments' PENDING filter conflates this completely
// routine case with the very different "amount mismatch held for manual
// review" case (verifyPayment / handlePaystack's amount-check branch), with
// nothing in the data itself to tell them apart.
//
// PENDING_ABANDON_AGE_MS is deliberately well beyond initializePayment's own
// PENDING_REUSE_WINDOW_MS (30 min) — that existing window is already this
// app's judgment call for "this checkout session/access code has expired
// anyway" (see that function's comment). This sweep uses a much wider
// margin on top of it purely to make the atomic guard below airtight: if a
// customer ever DID come back and pay hours after opening checkout (vastly
// outside any realistic Paystack session lifetime), the same
// `.eq('status', 'PENDING')` atomic guard verifyPayment/handlePaystack rely
// on means whichever caller gets to a row first wins — a row THIS sweep has
// already flipped to ABANDONED can never be silently un-flipped by a
// stray-late success, so the wide margin exists to make that race
// vanishingly unlikely, not to paper over it.
//
// No owner alert here, on purpose — same posture as the webhook's
// charge.failed handling: an abandoned checkout is routine, not something
// anyone needs to be paged for.
const PENDING_ABANDON_AGE_MS = 2 * 60 * 60 * 1000        // 2 hours
const PENDING_LOOKBACK_MS    = 30 * 24 * 60 * 60 * 1000  // don't rescan ancient history forever
const MAX_ABANDON_PER_RUN    = 500                       // plain status flips, no queue/email work — safe to be generous

async function sweepStalePendingPayments(env, supabase, { now = Date.now() } = {}) {
  const result = { checked: 0, abandoned: 0 }

  const { data: stale, error } = await supabase
    .from('payments')
    .select('id, paystack_ref')
    .eq('status', 'PENDING')
    .gt('created_at', new Date(now - PENDING_LOOKBACK_MS).toISOString())
    .lt('created_at', new Date(now - PENDING_ABANDON_AGE_MS).toISOString())
    .limit(MAX_ABANDON_PER_RUN)
  if (error) { result.error = error.message; return result }
  result.checked = stale?.length || 0
  if (!result.checked) return result

  // Same atomic per-row claim as every other status flip in this codebase:
  // `.eq('status', 'PENDING')` means a row a concurrent verify/webhook call
  // flips to SUCCESS in the same instant simply won't match here, and vice
  // versa — whichever caller gets there first wins, cleanly.
  for (const row of stale) {
    const { data: claimed, error: updErr } = await supabase
      .from('payments')
      .update({ status: 'ABANDONED' })
      .eq('id', row.id)
      .eq('status', 'PENDING')
      .select('id')
    if (updErr) { console.error('Stale payment sweep update:', updErr.message); continue }
    if (claimed?.length) result.abandoned++
  }
  return result
}


// ── Third concern in this file: PENDING/ABANDONED/FAILED that Paystack says
//    were actually PAID ───────────────────────────────────────────────────
//
// Different again from both sweeps above:
//   sweepOrphanedPayments      SUCCESS in our DB, but delivery never happened.
//   sweepStalePendingPayments  genuinely never paid — times out to ABANDONED.
//   sweepPendingPayments (below) SECTION 8 AUDIT (feature gap): a payment our
//     webhook/verify path never marked SUCCESS at all — the webhook was lost,
//     or the buyer paid and closed the tab before the redirect ever called
//     /verify — even though Paystack DID receive the money. Nothing before
//     this looked at non-SUCCESS rows against Paystack's own record of them.
//     Each candidate is verified against Paystack's API before anything is
//     settled, so this never trusts anything the client could have forged.
//
// Deliberately runs BEFORE sweepStalePendingPayments has a chance to time a
// row out from under it: this checks payments still inside PENDING_RECENT_MS,
// well short of sweepStalePendingPayments's 2-hour PENDING_ABANDON_AGE_MS, so
// the two never race over the same row. A row already abandoned by that sweep
// is still revivable here for a good while longer (fulfillment.service treats
// ABANDONED as revivable) — a very late Paystack success should still be
// honoured, it just won't be caught until the buyer returns or an admin
// recheck is used past that point.
const PENDING_MIN_AGE_MS     = 10 * 60 * 1000          // don't race a checkout still in progress
const PENDING_RECENT_MS      = 60 * 60 * 1000          // stays well inside sweepStalePendingPayments's 2h window
const MAX_VERIFY_PER_RUN     = 25                      // each is one Paystack API call

/**
 * Ask Paystack whether this payment was really paid; if so, settle + deliver it.
 * Shared by the hourly sweep and the admin "Recheck" action.
 *   NOT_PAID   Paystack says it wasn't
 *   MISMATCH   paid, but amount/currency differ from the row (held; currency is
 *              never overridable, amount only with acceptAmountMismatch)
 * otherwise the outcome of settlePayment (FULFILLED, ALREADY_FULFILLED, DUPLICATE, …).
 * Throws when the Paystack lookup itself fails.
 */
async function recheckPayment(env, supabase, payment, { acceptAmountMismatch = false, source = 'recheck' } = {}) {
  // Lazy on purpose, matching fulfillment.service.js's own pattern for
  // email/referral: this module is required ONCE (payments.controller.js
  // holds a long-lived reference to it), so a top-level `require` here would
  // bind forever to whatever paystack.service export existed at that first
  // load — including in tests, where each test wants its own fresh stub.
  const paystackService = require('./paystack.service')
  const pResult = await paystackService.verifyTransaction(env, payment.paystack_ref)
  const d = pResult?.data || {}
  if (d.status !== 'success') return { outcome: 'NOT_PAID', paystackStatus: d.status || 'unknown' }

  const mismatch = fulfillment.chargeMismatch(payment, { amount: d.amount, currency: d.currency })
  if (mismatch && (mismatch.receivedCurrency !== mismatch.expectedCurrency || !acceptAmountMismatch))
    return { outcome: 'MISMATCH', paystackStatus: d.status, ...mismatch }

  const result = await fulfillment.settlePayment(env, supabase, payment, {
    authCode: d.authorization?.authorization_code, source,
  })
  return { ...result, paystackStatus: d.status }
}

async function sweepPendingPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, recovered: [], held: [], failed: [] }
  const cols = 'id, paystack_ref, scan_id, fix_tier, status, amount_cents, currency, referral_code_id, created_at'

  const { data: candidates, error } = await supabase.from('payments').select(cols)
    .in('status', fulfillment.REVIVABLE_STATUSES)
    .gt('created_at', new Date(now - PENDING_RECENT_MS).toISOString())
    .lt('created_at', new Date(now - PENDING_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: false }).limit(MAX_VERIFY_PER_RUN)
  if (error) { result.error = error.message; return result }

  // Free-credit redemptions never touch Paystack — nothing to verify.
  const toCheck = (candidates || []).filter(p => p.paystack_ref && !p.paystack_ref.startsWith('credit:'))
  result.checked = toCheck.length

  for (const payment of toCheck) {
    try {
      const r = await recheckPayment(env, supabase, payment, { source: 'pending-sweep' })
      if (r.outcome === 'NOT_PAID') continue   // routine — sweepStalePendingPayments owns the eventual ABANDON
      if (r.outcome === 'MISMATCH') { result.held.push({ reference: payment.paystack_ref }); continue }  // webhook already alerted
      if (r.won) result.recovered.push({ reference: payment.paystack_ref, scanId: payment.scan_id, outcome: r.outcome })
      await fulfillment.notifySettlementProblem(env, r, payment, 'pending-sweep')
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, error: err.message })
    }
  }

  if (alert && (result.recovered.length || result.failed.length)) {
    try {
      const emailService = require('./email.service')
      const lines = [
        ...result.recovered.map(r => `RECOVERED  ${r.reference}  scan ${r.scanId}  (${r.outcome})`),
        ...result.failed.map(r => `FAILED     ${r.reference}  ${r.error}`),
      ]
      await emailService.sendOwnerAlert(env,
        `Pending-payment sweep: ${result.recovered.length} paid-but-unsettled recovered, ${result.failed.length} failed`,
        `Paystack reports these as PAID although our own records never reached SUCCESS (checked ${result.checked}).\n\n${lines.join('\n')}\n\n` +
        `Recovered items were settled and fulfilled automatically. Any occurrence means a webhook was lost or ` +
        `the buyer never returned to the site after paying — check webhook_events and wrangler tail around the payment times.`)
    } catch (_) {}
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Fourth concern in this file: paid, but generation FAILED.
//
// Every sweep above recovers PAYMENT-side failures (never fulfilled, never
// settled, never confirmed as paid). This covers a FULFILMENT-side failure:
// the scan was correctly marked FIX_PURCHASED/FIX_GENERATING and a job was
// enqueued, but the generation job itself failed (a Claude/Browser Rendering
// error, or the job killed mid-flight, or the hourly stuck-job recovery in
// index.js flipping a hung FIX_GENERATING to ERROR). Before this, such a scan
// was a permanent dead end for a customer who had already paid — initiateFix
// says "Already purchased", retryFix requires FIX_DELIVERED, and nothing else
// ever looked at it again.
//
// Safety, same shape as every other sweep in this file:
//   * the re-queue is an ATOMIC CLAIM (claim_errored_fix, migration 0026):
//     one UPDATE ... WHERE status='ERROR' AND fix_purchased AND recoveries <
//     cap — only one caller can win, so it can never double-enqueue;
//   * a per-scan cap (MAX_AUTO_RECOVERIES) so a DETERMINISTIC failure (an
//     unparseable resume) cannot loop forever burning Claude spend;
//   * a scan that exhausts its attempts is reported to the owner ONCE, then
//     left for a human (admin.controller.js's adminRequeueFix).

const MAX_AUTO_RECOVERIES   = 2
const ERROR_MIN_AGE_MS      = 10 * 60 * 1000       // let the failure email/alert go out first
const EXHAUSTED_ALERT_MS    = 70 * 60 * 1000       // just past one cron interval -> alert once
const FAILED_LOOKBACK_MS    = 7 * 24 * 60 * 60 * 1000

async function sweepFailedFixes(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { candidates: 0, requeued: [], exhausted: [], failed: [] }

  const { data: scans, error } = await supabase
    .from('scans')
    .select('id, fix_tier, fix_error_recoveries, updated_at')
    .eq('status', 'ERROR')
    .eq('fix_purchased', true)
    .gt('updated_at', new Date(now - FAILED_LOOKBACK_MS).toISOString())
    .lt('updated_at', new Date(now - ERROR_MIN_AGE_MS).toISOString())
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) { result.error = error.message; return result }
  result.candidates = scans?.length || 0

  let attempted = 0
  for (const s of scans || []) {
    if ((s.fix_error_recoveries ?? 0) >= MAX_AUTO_RECOVERIES) {
      if (now - Date.parse(s.updated_at) < EXHAUSTED_ALERT_MS) result.exhausted.push({ scanId: s.id })
      continue
    }
    if (attempted >= MAX_PER_RUN) break
    attempted++
    try {
      const { data: claimed, error: claimErr } = await supabase.rpc('claim_errored_fix', { p_scan_id: s.id, p_max: MAX_AUTO_RECOVERIES })
      if (claimErr) throw claimErr
      if (!claimed) continue                     // someone else got there first
      await env.FIX_QUEUE.send({ type: generatorFor(s.fix_tier), scanId: s.id })
      result.requeued.push({ scanId: s.id, attempt: (s.fix_error_recoveries ?? 0) + 1 })
    } catch (err) {
      result.failed.push({ scanId: s.id, error: err.message })
    }
  }

  if (alert && (result.exhausted.length || result.failed.length)) {
    try {
      const emailService = require('./email.service')
      const lines = [
        ...result.exhausted.map(r => `GAVE UP    scan ${r.scanId}  (${MAX_AUTO_RECOVERIES} automatic attempts failed — needs a human)`),
        ...result.failed.map(r => `FAILED     scan ${r.scanId}  ${r.error}`),
      ]
      await emailService.sendOwnerAlert(env,
        `Paid fixes failing: ${result.exhausted.length} exhausted, ${result.failed.length} could not be re-queued`,
        `${lines.join('\n')}\n\nThese customers PAID and did not receive their fix. Investigate the scan's ` +
        `generation error (wrangler tail / alert_logs), then re-run with POST /api/admin/scans/:id/requeue-fix.`)
    } catch (_) {}
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Fifth concern: Paystack REFUNDED it, but we never heard.
//
// Everything about refunds depends on a refund.processed webhook arriving AND processing. If
// one is lost, or FAILED after Paystack stopped retrying (about 72 hours), the payment stays
// SUCCESS, the partner keeps their commission and the public credential stays live — and no
// other sweep looks at a SUCCESS row again once it is delivered.
//
// This asks Paystack about recent SUCCESS/DISPUTED payments (a rotating window, oldest-checked
// first, so each is looked at about every 6 hours for 45 days). A transaction Paystack reports
// as `reversed` is then compared with Paystack's own refund list: processed refunds that add up
// to the amount paid → the sale is reversed exactly as the webhook would have; anything less is
// a partial (goodwill) refund and only tells a human, once a week per payment.
const REVERSAL_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000
const REVERSAL_RECHECK_MS  = 6 * 60 * 60 * 1000
const MAX_REVERSAL_CHECKS_PER_RUN = 20

async function sweepReversedPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, reversed: [], partial: [], failed: [] }
  const base = 'id, paystack_ref, scan_id, status, amount_cents, currency, created_at'
  const since = new Date(now - REVERSAL_LOOKBACK_MS).toISOString()
  const stale = new Date(now - REVERSAL_RECHECK_MS).toISOString()

  let tracked = true
  let { data: rows, error } = await supabase.from('payments').select(`${base}, last_reconciled_at`)
    .in('status', ['SUCCESS', 'DISPUTED']).gt('created_at', since)
    .or(`last_reconciled_at.is.null,last_reconciled_at.lt.${stale}`)
    .order('last_reconciled_at', { ascending: true, nullsFirst: true }).limit(MAX_REVERSAL_CHECKS_PER_RUN)
  if (error && (error.code === '42703' || /last_reconciled_at|column/i.test(error.message || ''))) {
    // migration 0036 not applied: no rotation marker, so just look at the newest payments
    tracked = false
    ;({ data: rows, error } = await supabase.from('payments').select(base)
      .in('status', ['SUCCESS', 'DISPUTED']).gt('created_at', since)
      .order('created_at', { ascending: false }).limit(MAX_REVERSAL_CHECKS_PER_RUN))
  }
  if (error) { result.error = error.message; return result }

  const paystackService = require('./paystack.service')
  const toCheck = (rows || []).filter(p => p.paystack_ref && !p.paystack_ref.startsWith('credit:'))
  result.checked = toCheck.length

  for (const payment of toCheck) {
    try {
      const v = await paystackService.verifyTransaction(env, payment.paystack_ref)
      if (v?.data?.status === 'reversed') {
        const list = await paystackService.listRefunds(env, payment.paystack_ref)
        const total = (list?.data || [])
          .filter(r => String(r.status || '').toLowerCase() === 'processed' && (!r.currency || r.currency === payment.currency))
          .reduce((sum, r) => sum + (Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0), 0)
        if (payment.amount_cents > 0 && total >= payment.amount_cents) {
          await fulfillment.reversePayment(supabase, payment, { reason: 'REFUND' })
          result.reversed.push({ reference: payment.paystack_ref, scanId: payment.scan_id, total })
        } else {
          result.partial.push({ reference: payment.paystack_ref, scanId: payment.scan_id, total, paid: payment.amount_cents })
        }
      }
      if (tracked) await supabase.from('payments').update({ last_reconciled_at: new Date(now).toISOString() }).eq('id', payment.id)
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, error: err.message })
    }
  }

  if (alert) {
    try {
      const emailService = require('./email.service')
      const kv = env.RATE_LIMIT_KV
      const fresh = []
      for (const p of result.partial) {
        const key = `reconcile-partial-refund:${p.reference}`
        try { if (kv && await kv.get(key)) continue; if (kv) await kv.put(key, '1', { expirationTtl: 7 * 24 * 3600 }) } catch (_) { /* over-alert rather than go silent */ }
        fresh.push(p)
      }
      if (result.reversed.length)
        await emailService.sendOwnerAlert(env, `Refund reconciliation: ${result.reversed.length} sale(s) reversed after a missed webhook`,
          `Paystack reports these as fully refunded although our records still said paid — the refund.processed webhook never reached (or never finished on) this app. They were reversed now (payment → REFUNDED, partner commission reversed, public credential revoked):\n\n` +
          result.reversed.map(r => `${r.reference}  scan ${r.scanId}  refunded ${r.total}`).join('\n'))
      if (fresh.length)
        await emailService.sendOwnerAlert(env, `Refund reconciliation: ${fresh.length} partial refund(s) found — NOT actioned`,
          `Paystack reports these transactions as reversed, but the processed refunds add up to less than was paid, so nothing was changed. If a sale should be reversed: Admin → Payments → Reverse.\n\n` +
          fresh.map(r => `${r.reference}  scan ${r.scanId}  refunded ${r.total} of ${r.paid}`).join('\n'))
    } catch (_) { /* alerting is best effort */ }
  }
  return result
}

module.exports = {
  sweepReversedPayments, REVERSAL_LOOKBACK_MS, REVERSAL_RECHECK_MS, MAX_REVERSAL_CHECKS_PER_RUN,
  sweepOrphanedPayments, ORPHAN_MIN_AGE_MS, STUCK_PURCHASED_MS, MAX_PER_RUN,
  sweepStalePendingPayments, PENDING_ABANDON_AGE_MS,
  sweepPendingPayments, recheckPayment, PENDING_MIN_AGE_MS, PENDING_RECENT_MS, MAX_VERIFY_PER_RUN,
  sweepFailedFixes, MAX_AUTO_RECOVERIES,
}
