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
      let claim = supabase.from('scans')
        .update({ fix_purchased: true, fix_tier: fixTier, status: 'FIX_PURCHASED' })
        .eq('id', scan.id)
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

module.exports = { sweepOrphanedPayments, ORPHAN_MIN_AGE_MS, STUCK_PURCHASED_MS, MAX_PER_RUN }
