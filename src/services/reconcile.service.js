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

// Webhooks round 13 (B3): the sweeps hand a partial payments row to recordConversion, which reads referral_source (the
// 'link' | 'typed' | 'account' attribution, migration 0079), currency and user_id off it. A narrow select silently dropped them:
// a recovered commission lost its attribution_source and was priced in the default currency. referral_source is optional so a
// database that has not applied 0079 yet still sweeps (the column-missing error is retried without it).
function isMissingColumn(error, col) {
  return !!error && (error.code === '42703' || new RegExp(col + '|column', 'i').test(error.message || ''))
}
async function selectPaymentsWithSource(buildQuery, cols) {
  // Round 16: referral_sub (0093, the partner's channel tag) rides along; a database without it retries without, then without
  // referral_source as before.
  const first = await buildQuery(`${cols}, referral_source, referral_sub`)
  if (!first.error || !isMissingColumn(first.error, 'referral_s')) return first
  const second = await buildQuery(`${cols}, referral_source`)
  if (second.error && isMissingColumn(second.error, 'referral_source')) return buildQuery(cols)
  return second
}

function generatorFor(fixTier) {
  return fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
}

async function sweepOrphanedPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, orphans: 0, reenqueued: [], failed: [] }

  // referral_code_id, amount_cents, currency, user_id and referral_source are all read by recordConversion() below.
  const { data: payments, error: payErr } = await selectPaymentsWithSource(cols => supabase
    .from('payments')
    .select(cols)
    .eq('status', 'SUCCESS')
    .gt('created_at', new Date(now - LOOKBACK_MS).toISOString())
    .lt('created_at', new Date(now - ORPHAN_MIN_AGE_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(200),
    'id, paystack_ref, scan_id, fix_tier, created_at, referral_code_id, referral_reservation_id, amount_cents, currency, user_id')
  if (payErr) { result.error = payErr.message; return result }
  result.checked = payments?.length || 0
  if (!result.checked) return result

  const scanIds = [...new Set(payments.map(p => p.scan_id).filter(Boolean))]
  const { data: scans, error: scanErr } = await supabase
    .from('scans').select('id, status, fix_purchased, fix_tier, fix_payment_id, updated_at').in('id', scanIds)
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
      // PAYMENTS & PRICING ROUND 7 (bug): rows arrive newest-first, so with a duplicate charge on the
      // scan this used to pick the DUPLICATE — re-enqueueing the generator for ITS tier (a BADGE scan
      // with a stray FIX duplicate got generateFix) and recording a commission on a payment that is
      // about to be refunded. A lost job belongs to the payment that OWNS the scan; skip the others
      // (without marking the scan seen, so the owner row, further down the list, still gets its turn).
      if (scan.fix_payment_id && scan.fix_payment_id !== p.id) continue
      orphans.push({ payment: p, scan, kind: 'job-lost' }); seen.add(scan.id)
    }
  }
  result.orphans = orphans.length

  for (const { payment, scan, kind } of orphans.slice(0, MAX_PER_RUN)) {
    // A lost job re-runs the generator the scan was actually purchased with (scans.fix_tier);
    // only a never-fulfilled claim takes its tier from the payment.
    const fixTier = (kind === 'job-lost' ? scan.fix_tier : null) || payment.fix_tier || 'FIX'
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
    .select('id, paystack_ref, referral_reservation_id')
    .eq('status', 'PENDING')
    .gt('created_at', new Date(now - PENDING_LOOKBACK_MS).toISOString())
    .lt('created_at', new Date(now - PENDING_ABANDON_AGE_MS).toISOString())
    .limit(MAX_ABANDON_PER_RUN)
  if (error) { result.error = error.message; return result }

  // Reservation-table hygiene (migration 0044) — see referral.service.js's
  // pruneReferralCodeReservations. Runs even when nothing is stale, never
  // throws, never affects this sweep's own result.
  await referralService.pruneReferralCodeReservations(supabase, { now })
  // Round 10: partners hear (once) that a code expires within a week. Same hourly cadence, never throws.
  try { await referralService.sweepExpiringCodes?.(supabase, env) } catch (_) {}
  // Round 11: one owner alert per closed payout cycle ("N partners are ready to be paid"). Never throws.
  try { await require('../controllers/partners.controller').sweepPayoutDue(env, supabase) } catch (_) {}

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
    if (claimed?.length) {
      result.abandoned++
      // Section 3/4 (usage-limit reservation, migration 0044): only the
      // caller that won the PENDING -> ABANDONED claim releases the slot; a
      // row a concurrent verify/webhook settled is consumed by
      // recordConversion instead. Best-effort, never throws.
      await referralService.releaseCodeReservation(supabase, row.referral_reservation_id)
    }
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
// Rows the stale sweep has already ABANDONED (PENDING_ABANDON_AGE_MS, 2h) stay inside this sweep's
// window (PENDING_RECENT_MS) and are revivable (fulfillment.service treats ABANDONED as revivable),
// so a late Paystack success is still honoured; past the window it is caught only when the buyer
// returns or an admin rechecks.
const PENDING_MIN_AGE_MS     = 10 * 60 * 1000          // don't race a checkout still in progress
// PAYMENTS & PRICING ROUND 7 (bug): this window was 50 minutes wide (10-60 min) while the sweep runs
// HOURLY, so a payment created in the last 10 minutes before a run was too young at that run and too
// old at the next — never looked at (~1 in 6 payments), and every other payment was looked at exactly
// once, so a buyer still approving a mobile-money prompt at that moment was never rechecked. The
// window must be wider than the cron interval; 3 hours gives every row two to three looks. Rows the
// stale sweep already ABANDONED (at 2h) stay revivable inside it, so a late Paystack success is still
// honoured. A held MISMATCH re-alerts at most once per look, which is the point of an unresolved hold.
const PENDING_RECENT_MS      = 3 * 60 * 60 * 1000
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

  // PAYMENTS & PRICING ROUND 6 (bug): an accepted amount mismatch settled the payment but left
  // amount_cents at what was EXPECTED. After accepting an underpayment (4500 paid of 4900) every later
  // figure was wrong: the commission was computed on money never received, and a full refund of what
  // WAS received (4500) summed to less than amount_cents, so the refund webhook judged it "partial" and
  // never reversed the sale. The row now records what Paystack actually captured when that is LESS than
  // expected. An overpayment (the buyer covered a fee) keeps the expected amount — that is the real
  // price, the commission base, and a refund request that omits the amount still returns everything.
  let toSettle = payment
  let amountAdjusted = null
  if (mismatch && Number.isInteger(d.amount) && d.amount > 0 && d.amount < payment.amount_cents) {
    const { data: adj, error: adjErr } = await supabase.from('payments')
      .update({ amount_cents: d.amount }).eq('id', payment.id).in('status', fulfillment.REVIVABLE_STATUSES).select('id')
    if (adjErr) throw adjErr
    if (adj && adj.length) {
      amountAdjusted = { from: payment.amount_cents, to: d.amount }
      toSettle = { ...payment, amount_cents: d.amount }
    }
  }

  const result = await fulfillment.settlePayment(env, supabase, toSettle, {
    authCode: d.authorization?.authorization_code, source,
  })
  return { ...result, paystackStatus: d.status, ...(amountAdjusted ? { amountAdjusted } : {}) }
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
      if (r.outcome === 'MISMATCH') {
        // Payments & Pricing round 6 (bug): this used to skip with "webhook already alerted" — untrue
        // when the webhook was the thing that got lost, and the row is abandoned 2h later. Alert now.
        result.held.push({ reference: payment.paystack_ref })
        await fulfillment.notifySettlementProblem(env, r, payment, 'pending-sweep')
        continue
      }
      if (r.won) result.recovered.push({ reference: payment.paystack_ref, scanId: payment.scan_id, outcome: r.outcome })
      await fulfillment.notifySettlementProblem(env, r, payment, 'pending-sweep')
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, error: err.message })
    }
  }

  if (alert && (result.recovered.length || result.failed.length || result.held.length)) {
    try {
      const emailService = require('./email.service')
      const lines = [
        ...result.recovered.map(r => `RECOVERED  ${r.reference}  scan ${r.scanId}  (${r.outcome})`),
        ...result.failed.map(r => `FAILED     ${r.reference}  ${r.error}`),
        ...result.held.map(r => `HELD       ${r.reference}  (paid, but amount/currency differ — see the separate mismatch alert)`),
      ]
      await emailService.sendOwnerAlert(env,
        `Pending-payment sweep: ${result.recovered.length} paid-but-unsettled recovered, ${result.failed.length} failed, ${result.held.length} held`,
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
    .select('id, fix_tier, fix_error_recoveries, updated_at, fix_payment_id')
    .eq('status', 'ERROR')
    .eq('fix_purchased', true)
    .gt('updated_at', new Date(now - FAILED_LOOKBACK_MS).toISOString())
    .lt('updated_at', new Date(now - ERROR_MIN_AGE_MS).toISOString())
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error) { result.error = error.message; return result }
  result.candidates = scans?.length || 0

  // A refunded / disputed purchase is not recovered: the generator would stand down anyway, and each pass would burn one of
  // the scan's recoveries and then raise a false "exhausted" alert.
  const reversed = new Set()
  const payIds = [...new Set((scans || []).map(s => s.fix_payment_id).filter(Boolean))]
  if (payIds.length) {
    const { data: pays } = await supabase.from('payments').select('id, status').in('id', payIds)
    for (const p of pays || []) if (['REFUNDED', 'DISPUTED'].includes(p.status)) reversed.add(p.id)
  }

  let attempted = 0
  for (const s of scans || []) {
    if (s.fix_payment_id && reversed.has(s.fix_payment_id)) continue
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
// Webhooks round 13 (G5): each payment costs a verify call (and a row update) per look, so 20 an hour re-checks about 120 payments
// every 6 hours — beyond that the rotation stretches (1000 live payments -> each looked at about every 2 days, long after a dispute's
// 16-hour auto-accept). REVERSAL_CHECKS_PER_RUN raises it for a busy shop; capped at 100 because a cron run has a subrequest budget
// shared with the other sweeps (50 on the Workers free plan, 1000 on paid).
const MAX_REVERSAL_CHECKS_CEILING = 100
function reversalChecksPerRun(env) {
  const { numEnv, NUMERIC_ENV } = require('../lib/numEnv')   // strict: out of range / malformed -> the default 20
  return numEnv(env && env.REVERSAL_CHECKS_PER_RUN, MAX_REVERSAL_CHECKS_PER_RUN, NUMERIC_ENV.REVERSAL_CHECKS_PER_RUN)
}

async function sweepReversedPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, reversed: [], partial: [], failed: [] }
  const perRun = reversalChecksPerRun(env)
  // user_id + fix_tier: reversePayment hands this row to notifyBuyerReversal, which skips the buyer email without a user_id
  // (webhooks round 13, B1 — a sweep-recovered refund or lost dispute never told the buyer).
  const base = 'id, paystack_ref, scan_id, user_id, status, amount_cents, currency, fix_tier, created_at'
  const since = new Date(now - REVERSAL_LOOKBACK_MS).toISOString()
  const stale = new Date(now - REVERSAL_RECHECK_MS).toISOString()

  let tracked = true
  let { data: rows, error } = await supabase.from('payments').select(`${base}, last_reconciled_at`)
    .in('status', ['SUCCESS', 'DISPUTED']).gt('created_at', since)
    // WEBHOOKS ROUND 15 (B1): free-credit rows ('credit:<scan>:<ts>', SUCCESS, never sent to Paystack, so never stamped) sorted
    // first forever under NULLS FIRST and, once perRun of them existed, filled every run's slots: real sales were never checked.
    // Excluded in the query so the limit only counts payments this sweep can actually verify.
    .not('paystack_ref', 'like', 'credit:%')
    .or(`last_reconciled_at.is.null,last_reconciled_at.lt.${stale}`)
    .order('last_reconciled_at', { ascending: true, nullsFirst: true }).limit(perRun)
  if (error && (error.code === '42703' || /last_reconciled_at|column/i.test(error.message || ''))) {
    // migration 0036 not applied: no rotation marker, so just look at the newest payments
    tracked = false
    ;({ data: rows, error } = await supabase.from('payments').select(base)
      .in('status', ['SUCCESS', 'DISPUTED']).gt('created_at', since)
      .not('paystack_ref', 'like', 'credit:%')
      .order('created_at', { ascending: false }).limit(perRun))
  }
  if (error) { result.error = error.message; return result }

  const paystackService = require('./paystack.service')
  const toCheck = (rows || []).filter(p => p.paystack_ref && !p.paystack_ref.startsWith('credit:'))
  result.checked = toCheck.length

  for (const payment of toCheck) {
    try {
      const v = await paystackService.verifyTransaction(env, payment.paystack_ref)
      if (v?.data?.status === 'reversed') {
        const list = await paystackService.listRefunds(env, payment.paystack_ref, { currency: payment.currency, transactionId: v.data.id ?? null })
        const total = (list?.data || [])
          .filter(r => String(r.status || '').toLowerCase() === 'processed' && (!r.currency || r.currency === payment.currency))
          .reduce((sum, r) => sum + (Number.isFinite(Number(r.amount)) ? Number(r.amount) : 0), 0)
        if (payment.amount_cents > 0 && total >= payment.amount_cents) {
          await fulfillment.reversePayment(supabase, payment, { reason: 'REFUND', env })
          result.reversed.push({ reference: payment.paystack_ref, scanId: payment.scan_id, total })
        } else if (payment.status === 'DISPUTED' && payment.amount_cents > 0 && total === 0) {
          // WEBHOOKS ROUND 10 (G2): Paystack reports a charged-back transaction as `reversed` too, but with NO
          // processed refund. A payment this app already holds as DISPUTED that Paystack now calls reversed, with
          // nothing refunded, is a LOST dispute whose resolve webhook never arrived: the money is gone, so the
          // sale is reversed (it used to be filed as a "partial refund — NOT actioned" and stayed SUCCESS-like forever).
          await fulfillment.reversePayment(supabase, payment, { reason: 'DISPUTE', env })
          result.reversed.push({ reference: payment.paystack_ref, scanId: payment.scan_id, total: payment.amount_cents, chargeback: true })
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
          result.reversed.map(r => `${r.reference}  scan ${r.scanId}  ${r.chargeback ? 'CHARGED BACK (lost dispute — resolve webhook missed)' : `refunded ${r.total}`}`).join('\n'))
      if (fresh.length)
        await emailService.sendOwnerAlert(env, `Refund reconciliation: ${fresh.length} partial refund(s) found — NOT actioned`,
          `Paystack reports these transactions as reversed, but the processed refunds add up to less than was paid (a chargeback on a payment this app never saw disputed looks the same), so nothing was changed. If a sale should be reversed: Admin → Payments → Reverse.\n\n` +
          fresh.map(r => `${r.reference}  scan ${r.scanId}  refunded ${r.total} of ${r.paid}`).join('\n'))
    } catch (_) { /* alerting is best effort */ }
  }
  return result
}

// ── Missing partner commissions ────────────────────────────────────────────
// Webhooks round 4 (B4). recordConversion NEVER throws: a failed ledger write comes back as
// { ok: false } and the webhook (like verifyPayment) carries on, answers 200 and marks the event
// PROCESSED — so Paystack never redelivers it, and settlePayment only re-attempts a conversion for
// the one call that flipped/claimed the payment. The owner is paged (notifyConversionFailure) and
// POST /:reference/reconcile repairs it, but that is a human having to notice an email: a transient
// Supabase error at exactly that moment cost a partner their commission until someone did.
//
// This hourly sweep closes the loop: a SUCCESS payment that carries a referral code but has no
// original ledger row (or one whose usage counter was never bumped, usage_counted = false) is
// re-run through recordConversion, which is idempotent (unique original ledger row per payment).
// Payments whose commission was deliberately not recorded (code or partner deleted, bad rate) come
// back ok with recorded:false and are simply re-checked until they leave the look-back window — a
// couple of cheap lookups per run, bounded by MAX_COMMISSION_REPAIRS_PER_RUN.
//
// `env` IS passed to recordConversion with { quietFailures: true } (round 13): without it the partner never got the
// "you earned a commission" email for a sale this sweep recovered. quietFailures stops its own failure alert (no cooldown,
// it would page the owner every hourly run); this sweep reports instead, once per payment per week for failures, plus one
// summary for what it actually recovered.
const COMMISSION_MIN_AGE_MS   = 15 * 60 * 1000
const COMMISSION_LOOKBACK_MS  = 3 * 24 * 60 * 60 * 1000
const MAX_COMMISSION_REPAIRS_PER_RUN = 20

async function sweepMissingCommissions(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, missing: 0, recovered: [], failed: [], error: null }
  const { data: pays, error } = await selectPaymentsWithSource(cols => supabase.from('payments')
    .select(cols)
    .eq('status', 'SUCCESS').not('referral_code_id', 'is', null)
    .lt('created_at', new Date(now - COMMISSION_MIN_AGE_MS).toISOString())
    .gt('created_at', new Date(now - COMMISSION_LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false }).limit(200),
    'id, paystack_ref, scan_id, status, amount_cents, currency, referral_code_id, referral_reservation_id, user_id, created_at')
  if (error) { result.error = error.message; return result }
  const candidates = (pays || []).filter(p => p.referral_code_id)
  result.checked = candidates.length
  if (!candidates.length) return result

  const { data: ledger, error: ledErr } = await supabase.from('commission_ledger')
    .select('payment_id, usage_counted').in('payment_id', candidates.map(p => p.id)).is('reverses_ledger_id', null)
  if (ledErr) { result.error = ledErr.message; return result }
  const have = new Map((ledger || []).map(l => [l.payment_id, l.usage_counted]))
  const todo = candidates.filter(p => !have.has(p.id) || have.get(p.id) === false).slice(0, MAX_COMMISSION_REPAIRS_PER_RUN)
  result.missing = todo.length

  for (const payment of todo) {
    try {
      // env is passed (webhooks round 13, B2) so the PARTNER hears about a recovered sale and the over-limit / code-limit
      // notices fire; quietFailures keeps the owner from being paged every hour — failures are reported once a week below.
      const conv = await referralService.recordConversion(supabase, payment, env, { quietFailures: true })
      if (conv.ok && (conv.recorded || conv.usageRepaired)) result.recovered.push({ reference: payment.paystack_ref, scanId: payment.scan_id })
      else if (!conv.ok) result.failed.push({ reference: payment.paystack_ref, scanId: payment.scan_id, reason: conv.reason, error: conv.error })
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, scanId: payment.scan_id, reason: 'exception', error: err.message })
    }
  }

  if (alert && (result.recovered.length || result.failed.length)) {
    try {
      const emailService = require('./email.service')
      const kv = env.RATE_LIMIT_KV
      const freshFailures = []
      for (const f of result.failed) {
        const key = `commission-sweep-failed:${f.reference}`
        try { if (kv && await kv.get(key)) continue; if (kv) await kv.put(key, '1', { expirationTtl: 7 * 24 * 3600 }) } catch (_) { /* over-alert rather than go silent */ }
        freshFailures.push(f)
      }
      if (result.recovered.length || freshFailures.length)
        await emailService.sendOwnerAlert(env,
          `Commission sweep: ${result.recovered.length} recovered, ${freshFailures.length} still failing`,
          `These referred sales were paid but had no commission recorded (a ledger write failed after the payment settled):\n\n` +
          [...result.recovered.map(r => `RECOVERED  ${r.reference}  scan ${r.scanId}`),
           ...freshFailures.map(f => `FAILING    ${f.reference}  scan ${f.scanId}  step ${f.reason}: ${f.error}`)].join('\n') +
          (freshFailures.length ? `\n\nFailures are retried hourly for 3 days and reported once. Manual retry: POST /api/payments/<reference>/reconcile (admin).` : ''))
    } catch (_) { /* alerting is best effort */ }
  }
  return result
}

// ── Stalled refunds and refunds this app never recorded ─────────────────────
// Webhooks round 13 (G3). Everything refund-related here starts from a webhook or from ONE payment's own refund list. Two things
// had no backstop at all:
//   * a refund Paystack parked in `needs-attention` (it waits indefinitely for the customer's bank details), or that `failed`, or
//     sat `pending`/`processing` for days. The owner was told ONCE, by the webhook (an email that can be missed), and never again;
//     if the webhook itself was lost nobody was ever told. The customer's money is stuck either way.
//   * a PARTIAL refund whose refund.processed webhook was lost. sweepReversedPayments only looks at transactions Paystack calls
//     `reversed` (fully refunded), so a partial one left payment_refunds short and the dashboard revenue overstated, silently.
// This asks Paystack for the merchant's recent refunds (one paged list for the whole account), keeps the ones that belong to THIS
// app's payments, and tells the owner — notify-only, once per refund/payment per week, never changing any money state: what to do
// about a stalled refund is a decision for a person with the Paystack dashboard open.
const STALLED_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const STALLED_ATTENTION_MS = 24 * 60 * 60 * 1000      // needs-attention / failed for this long
const STALLED_INFLIGHT_MS = 72 * 60 * 60 * 1000       // pending / processing for this long
const STALLED_PAGE_SIZE = 50
const STALLED_MAX_PAGES = 4
const MAX_STALLED_REPORTED = 25

async function sweepStalledRefunds(env, supabase, { now = Date.now(), alert = true, list = null } = {}) {
  const result = { checked: 0, stalled: [], missedPartial: [], recorded: [], error: null }
  try {
    if (!env.PAYSTACK_SECRET_KEY && !list) return result
    const paystackService = require('./paystack.service')
    const isoDay = ms => new Date(ms).toISOString().slice(0, 10)
    const items = []
    if (list) items.push(...((await list())?.data || []))
    else for (let page = 1; page <= STALLED_MAX_PAGES; page++) {
      const r = await paystackService.listRecentRefunds(env, { from: isoDay(now - STALLED_LOOKBACK_MS), to: isoDay(now + 24 * 3600 * 1000), page, perPage: STALLED_PAGE_SIZE })
      const got = Array.isArray(r?.data) ? r.data : []
      items.push(...got)
      if (got.length < STALLED_PAGE_SIZE) break
    }
    const refs = new Map()                       // reference -> its refund items
    for (const it of items) {
      const { reference } = paystackService.refundItemTransaction(it)
      if (!reference) continue                   // cannot be tied to a payment: never guess
      if (!refs.has(reference)) refs.set(reference, [])
      refs.get(reference).push(it)
    }
    if (!refs.size) return result

    const known = new Map()
    const all = [...refs.keys()]
    for (let i = 0; i < all.length; i += 100) {
      const { data, error } = await supabase.from('payments').select('id, paystack_ref, scan_id, status, amount_cents, currency').in('paystack_ref', all.slice(i, i + 100))
      if (error) { result.error = error.message; return result }
      for (const p of data || []) known.set(p.paystack_ref, p)
    }
    result.checked = known.size

    const when = it => Date.parse(it.updated_at || it.updatedAt || it.created_at || it.createdAt || '')
    const live = s => ['pending', 'processing', 'needs-attention', 'processed'].includes(s)
    const processedSum = new Map()               // payment id -> Paystack's processed total in the payment's own currency
    const processedAmounts = new Map()           // payment id -> each processed refund's amount (webhooks round 22, B2)
    const processedItems = new Map()             // payment id -> [{ id, amount }] (webhooks round 28, G1: what the sweep records)
    for (const [ref, its] of refs) {
      const p = known.get(ref)
      if (!p) continue
      const statuses = its.map(it => String(it.status || '').toLowerCase())
      for (const it of its) {
        const status = String(it.status || '').toLowerCase()
        const at = when(it)
        const age = Number.isFinite(at) ? now - at : null
        const amount = Number.isFinite(Number(it.amount)) ? Number(it.amount) : null
        if (status === 'processed') {
          if (amount != null && (!it.currency || it.currency === p.currency)) {
            processedSum.set(p.id, (processedSum.get(p.id) || 0) + amount)
            if (!processedAmounts.has(p.id)) processedAmounts.set(p.id, [])
            processedAmounts.get(p.id).push(amount)
            if (!processedItems.has(p.id)) processedItems.set(p.id, [])
            processedItems.get(p.id).push({ id: it.id ?? null, amount })
          }
          continue
        }
        let why = null
        if (status === 'needs-attention' && (age == null || age >= STALLED_ATTENTION_MS)) why = 'needs-attention — Paystack is waiting for the customer\'s bank details'
        else if (status === 'failed' && p.status !== 'REFUNDED' && age != null && age >= STALLED_ATTENTION_MS
                 && !statuses.some((s, i) => live(s) && its[i] !== it)) why = 'failed — the money is still with the merchant and no other refund is in progress'
        else if ((status === 'pending' || status === 'processing') && age != null && age >= STALLED_INFLIGHT_MS) why = `${status} for ${Math.floor(age / 3_600_000)}h`
        if (why) result.stalled.push({ reference: ref, scanId: p.scan_id, refundId: it.id ?? null, status, amount, currency: it.currency || p.currency, why })
      }
    }

    // Processed refunds Paystack knows of that payment_refunds does not (partial only — a full one is sweepReversedPayments' job).
    const partialIds = [...processedSum].filter(([id, sum]) => {
      const p = [...known.values()].find(x => x.id === id)
      return p && ['SUCCESS', 'DISPUTED'].includes(p.status) && p.amount_cents > 0 && sum > 0 && sum < p.amount_cents
    }).map(([id]) => id)
    if (partialIds.length) {
      const ours = new Map()
      const ourRows = []
      for (let i = 0; i < partialIds.length; i += 100) {
        const { data, error } = await supabase.from('payment_refunds').select('payment_id, amount_cents').in('payment_id', partialIds.slice(i, i + 100))
        if (error) throw error
        for (const r of data || []) { ours.set(r.payment_id, (ours.get(r.payment_id) || 0) + (Number(r.amount_cents) || 0)); ourRows.push(r) }
      }
      // Webhooks round 22 (B2): processRefund deliberately does NOT record an ambiguous refund event (no id, no refund_reference) in
      // payment_refunds - a duplicate delivery could not be told from a second refund. Such a refund DID reach this app (its inbox row is
      // PROCESSED and it was alerted as a partial refund), but payment_refunds stayed short, so this sweep reported it as "the webhook was lost or
      // failed" - every time Paystack's total moved. A Paystack refund whose amount is already covered by a recorded refund OR by a PROCESSED
      // refund.processed inbox row for that reference is therefore not reported. Best effort: if the inbox cannot be read, behaves as before.
      const covered = new Map()                  // payment id -> Set of amounts this app has seen
      for (const id of partialIds) covered.set(id, new Set())
      for (const r of ourRows) { const set = covered.get(r.payment_id); if (set) set.add(Number(r.amount_cents)) }
      try {
        const refByPayment = new Map(partialIds.map(id => [[...known.values()].find(x => x.id === id).paystack_ref, id]))
        const refList = [...refByPayment.keys()]
        for (let i = 0; i < refList.length; i += 100) {
          const { data, error } = await supabase.from('webhook_events').select('reference, payload')
            .eq('provider', 'paystack').eq('event_type', 'refund.processed').eq('status', 'PROCESSED').in('reference', refList.slice(i, i + 100))
          if (error) throw error
          for (const row of data || []) {
            const amt = Number(row.payload && row.payload.data && row.payload.data.amount)
            const set = covered.get(refByPayment.get(row.reference))
            if (set && Number.isFinite(amt)) set.add(amt)
          }
        }
      } catch (err) { console.error('stalled-refund sweep: inbox lookup failed (reporting without it):', err && err.message) }
      for (const id of partialIds) {
        const p = [...known.values()].find(x => x.id === id)
        const theirs = processedSum.get(id), mine = ours.get(id) || 0
        const seen = covered.get(id) || new Set()
        if (theirs > mine && (processedAmounts.get(id) || []).some(a => !seen.has(a))) {
          // Webhooks round 28 (G1): this was notify-only ("note it in Admin -> Payments" - no such action existed), so payment_refunds stayed short and
          // dashboard revenue kept counting money Paystack had returned. The refunds Paystack confirms as processed and this app never saw are now
          // recorded under `sweep:<refund id>`. processRefund absorbs such a row when the real event arrives later (no double count) and checks
          // Paystack before trusting a total that contains one.
          const added = []
          for (const it of processedItems.get(id) || []) {
            if (it.id == null || seen.has(it.amount)) continue
            try {
              const { error: insErr } = await supabase.from('payment_refunds').insert({ payment_id: id, event_key: `sweep:${it.id}`, amount_cents: Math.round(it.amount) })
              if (!insErr) added.push(it.amount)
              else if (insErr.code !== '23505') console.error('stalled-refund sweep: refund not recorded:', insErr.message)
            } catch (err) { console.error('stalled-refund sweep: refund not recorded:', err && err.message) }
          }
          const addedSum = added.reduce((n, a) => n + a, 0)
          if (added.length) result.recorded.push({ reference: p.paystack_ref, scanId: p.scan_id, amounts: added })
          result.missedPartial.push({ reference: p.paystack_ref, scanId: p.scan_id, paystack: theirs, recorded: mine + addedSum, paid: p.amount_cents, currency: p.currency, autoRecorded: addedSum > 0 })
        }
      }
    }

    if (alert && (result.stalled.length || result.missedPartial.length)) {
      const kv = env.RATE_LIMIT_KV
      const fresh = async (key, rows) => {
        const out = []
        for (const r of rows) {
          const k = `${key}:${r.reference}:${r.refundId ?? ''}:${r.status ?? ''}:${r.paystack ?? ''}`
          try { if (kv && await kv.get(k)) continue; if (kv) await kv.put(k, '1', { expirationTtl: 7 * 24 * 3600 }) } catch (_) { /* over-alert rather than go silent */ }
          out.push(r)
        }
        return out
      }
      const stalled = (await fresh('stalled-refund', result.stalled)).slice(0, MAX_STALLED_REPORTED)
      const missed = (await fresh('unrecorded-partial-refund', result.missedPartial)).slice(0, MAX_STALLED_REPORTED)
      if (stalled.length || missed.length) {
        const emailService = require('./email.service')
        await emailService.sendOwnerAlert(env,
          `Refund sweep: ${stalled.length} stalled, ${missed.length} not recorded here`,
          (stalled.length ? `Refunds that are not completing (Paystack dashboard → Refunds; for needs-attention supply the customer's bank details, or POST /refund/retry_with_customer_details/{id}):\n\n` +
            stalled.map(s => `${s.reference}  scan ${s.scanId}  refund ${s.refundId ?? '?'}  ${s.amount ?? '?'} ${s.currency || ''}  ${s.why}`).join('\n') + '\n\n' : '') +
          (missed.length ? `Partial refunds Paystack has PROCESSED that this app had not recorded (the refund.processed webhook was lost or failed). Where Paystack gave a refund id the sweep has now recorded the amount itself (dashboard revenue is net of it); the payment stays SUCCESS because it is not fully refunded:\n\n` +
            missed.map(m => `${m.reference}  scan ${m.scanId}  Paystack refunded ${m.paystack}, recorded ${m.recorded}${m.autoRecorded ? ' (by this sweep)' : ''}, paid ${m.paid} ${m.currency || ''}`).join('\n') + '\n\n' : '') +
          `Each item is reported once a week. Payments are never reversed or changed by this sweep.`)
      }
    }
  } catch (err) {
    result.error = err && err.message ? err.message : String(err)
    console.error('stalled refund sweep:', result.error)
  }
  return result
}

// ── Failed automatic refunds (duplicate / undeliverable payments) ──────────
// Webhooks round 11 (G1). settlePayment refunds a DUPLICATE payment (a second charge for a scan another payment owns) and an
// UNDELIVERABLE one (scan or account gone) automatically — once, right after the charge.success webhook, and again only on a
// verify / recheck. If that refund failed (Paystack error, a lost claim race) or Paystack later failed it (refund.failed), nothing
// ever tried again: the alerts said "the next verify / webhook redelivery also retries it", but a PROCESSED charge.success is never
// redelivered and the buyer has no reason to verify again, so the buyer stayed charged for nothing until a human noticed.
//
// This hourly sweep finds SUCCESS payments that are provably duplicate / undeliverable and still not refunded, and runs the same
// guarded auto-refund (claim + Paystack refund-list check that fails closed). Classification is read-only and local; Paystack is
// only asked about the (rare) payments that classify. Bounded: MAX_AUTO_REFUND_RETRIES attempts per payment per week, then ONE page
// to the owner and it is left for a human. A payment already refunded (REFUNDED) or with an open/processed refund is left alone by
// queueRefund itself (OPEN_REFUND / ALREADY_REFUNDED → IN_PROGRESS), so a healthy refund in flight costs one list call per run.
const AUTO_REFUND_MIN_AGE_MS = 20 * 60 * 1000
const AUTO_REFUND_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000
const MAX_AUTO_REFUND_RETRIES = 5
const MAX_AUTO_REFUND_PER_RUN = 10

async function sweepFailedAutoRefunds(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, candidates: 0, queued: [], inProgress: 0, failed: [], gaveUp: [], error: null }
  const refundService = require('./refund.service')
  if (!refundService.autoRefundEnabled(env) && !refundService.autoRefundUndeliverableEnabled(env)) return result

  const { data: pays, error } = await supabase.from('payments')
    .select('id, paystack_ref, scan_id, user_id, status, amount_cents, currency, fix_tier, created_at')
    .eq('status', 'SUCCESS').gt('amount_cents', 0)
    .lt('created_at', new Date(now - AUTO_REFUND_MIN_AGE_MS).toISOString())
    .gt('created_at', new Date(now - AUTO_REFUND_LOOKBACK_MS).toISOString())
    .order('created_at', { ascending: false }).limit(300)
  if (error) { result.error = error.message; return result }
  const paid = (pays || []).filter(p => p.paystack_ref && !String(p.paystack_ref).startsWith('credit:'))
  result.checked = paid.length
  if (!paid.length) return result

  const scanIds = [...new Set(paid.map(p => p.scan_id).filter(Boolean))]
  const scanById = new Map()
  for (let i = 0; i < scanIds.length; i += 100) {
    const { data: scans, error: scanErr } = await supabase.from('scans')
      .select('id, user_id, fix_purchased, fix_payment_id').in('id', scanIds.slice(i, i + 100))
    if (scanErr) { result.error = scanErr.message; return result }
    for (const sc of scans || []) scanById.set(sc.id, sc)
  }
  // Owners of scans nothing has claimed yet: a deleted account can never be delivered to.
  const unclaimedOwners = [...new Set([...scanById.values()].filter(sc => !sc.fix_payment_id && sc.user_id).map(sc => sc.user_id))]
  const deletedOwner = new Set()
  for (let i = 0; i < unclaimedOwners.length; i += 100) {
    const { data: users, error: userErr } = await supabase.from('users').select('id, deleted_at').in('id', unclaimedOwners.slice(i, i + 100))
    if (userErr) { result.error = userErr.message; return result }
    for (const u of users || []) if (u.deleted_at) deletedOwner.add(u.id)
  }

  const todo = []
  for (const p of paid) {
    if (!p.scan_id) { todo.push({ p, outcome: 'NO_SCAN' }); continue }
    const sc = scanById.get(p.scan_id)
    if (!sc) { todo.push({ p, outcome: 'SCAN_MISSING' }); continue }
    if (sc.fix_payment_id && sc.fix_payment_id !== p.id) { todo.push({ p, outcome: 'DUPLICATE', ownerPaymentId: sc.fix_payment_id }); continue }
    if (!sc.fix_payment_id && !sc.fix_purchased && sc.user_id && deletedOwner.has(sc.user_id)) todo.push({ p, outcome: 'ACCOUNT_DELETED' })
  }
  result.candidates = todo.length

  let attempted = 0
  for (const { p, outcome, ownerPaymentId } of todo) {
    if (attempted >= MAX_AUTO_REFUND_PER_RUN) break
    // Bounded retries per payment per week (shared with nothing else): a Paystack that keeps failing the refund must not be hammered hourly for ever.
    const { hitQuota } = require('../middleware/rateLimiter')
    if (!(await hitQuota(env, `autorefund-retry:${p.id}`, MAX_AUTO_REFUND_RETRIES, 7 * 24 * 3600))) {
      try {
        const kv = env.RATE_LIMIT_KV
        const key = `autorefund-gaveup:${p.id}`
        let fresh = true
        try { if (kv && await kv.get(key)) fresh = false; else if (kv) await kv.put(key, '1', { expirationTtl: 7 * 24 * 3600 }) } catch (_) { /* over-alert rather than go silent */ }
        if (fresh) result.gaveUp.push({ reference: p.paystack_ref, scanId: p.scan_id, outcome })
      } catch (_) { /* never throws */ }
      continue
    }
    attempted++
    try {
      const r = outcome === 'DUPLICATE'
        ? await refundService.autoRefundDuplicate(env, supabase, p, { ownerPaymentId })
        : await refundService.autoRefundUndeliverable(env, supabase, p, { outcome })
      if (r.status === 'QUEUED') result.queued.push({ reference: p.paystack_ref, scanId: p.scan_id, outcome })
      else if (r.status === 'FAILED') result.failed.push({ reference: p.paystack_ref, scanId: p.scan_id, outcome, reason: r.reason })
      else {
        // A refund already open / processed at Paystack (or an ineligible payment) is not an attempt: hand the slot back, or a refund
        // that legitimately takes days would burn the budget and be reported as "gave up".
        if (r.status === 'IN_PROGRESS') result.inProgress++
        await require('../middleware/rateLimiter').refundQuota(env, `autorefund-retry:${p.id}`, 7 * 24 * 3600, 1000)
      }
    } catch (err) {
      result.failed.push({ reference: p.paystack_ref, scanId: p.scan_id, outcome, reason: err.message })
    }
  }

  if (alert && (result.queued.length || result.gaveUp.length)) {
    try {
      const emailService = require('./email.service')
      if (result.queued.length)
        await emailService.sendOwnerAlert(env, `Auto-refund sweep: ${result.queued.length} refund(s) re-queued`,
          `These payments bought nothing (duplicate / undeliverable) and their automatic refund had failed or never completed. A refund was queued with Paystack now; refund.processed will mark each REFUNDED:\n\n` +
          result.queued.map(q => `${q.reference}  scan ${q.scanId || '(none)'}  ${q.outcome}`).join('\n'), { dedupeKey: 'autorefund-sweep-queued' })
      if (result.gaveUp.length)
        await emailService.sendOwnerAlert(env, `Auto-refund sweep gave up on ${result.gaveUp.length} payment(s) — refund by hand`,
          `The hourly sweep tried ${MAX_AUTO_REFUND_RETRIES} times this week to refund these duplicate / undeliverable payments and could not. The buyers are still charged for nothing. ` +
          `Refund each in Paystack (or Admin → Payments → Refund); if Paystack asks for the customer's bank details, supply them there:\n\n` +
          result.gaveUp.map(q => `${q.reference}  scan ${q.scanId || '(none)'}  ${q.outcome}`).join('\n'), { dedupeKey: 'autorefund-sweep-gaveup' })
    } catch (_) { /* alerting is best effort */ }
  }
  return result
}

module.exports = {
  sweepStalledRefunds, STALLED_LOOKBACK_MS, STALLED_ATTENTION_MS, STALLED_INFLIGHT_MS,
  sweepFailedAutoRefunds, AUTO_REFUND_MIN_AGE_MS, AUTO_REFUND_LOOKBACK_MS, MAX_AUTO_REFUND_RETRIES, MAX_AUTO_REFUND_PER_RUN,
  sweepMissingCommissions, COMMISSION_MIN_AGE_MS, COMMISSION_LOOKBACK_MS, MAX_COMMISSION_REPAIRS_PER_RUN,
  sweepReversedPayments, REVERSAL_LOOKBACK_MS, REVERSAL_RECHECK_MS, MAX_REVERSAL_CHECKS_PER_RUN, reversalChecksPerRun,
  sweepOrphanedPayments, ORPHAN_MIN_AGE_MS, STUCK_PURCHASED_MS, MAX_PER_RUN,
  sweepStalePendingPayments, PENDING_ABANDON_AGE_MS,
  sweepPendingPayments, recheckPayment, PENDING_MIN_AGE_MS, PENDING_RECENT_MS, MAX_VERIFY_PER_RUN,
  sweepFailedFixes, MAX_AUTO_RECOVERIES,
}
