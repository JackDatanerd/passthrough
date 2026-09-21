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

const ORPHAN_MIN_AGE_MS   = 10 * 60 * 1000
const STUCK_PURCHASED_MS  = 15 * 60 * 1000
const LOOKBACK_MS         = 7 * 24 * 60 * 60 * 1000
const MAX_PER_RUN         = 10

function generatorFor(fixTier) {
  return fixTier === 'BADGE' ? 'generateBadge' : 'generateFix'
}

async function sweepOrphanedPayments(env, supabase, { now = Date.now(), alert = true } = {}) {
  const result = { checked: 0, orphans: 0, reenqueued: [], failed: [] }

  const { data: payments, error: payErr } = await supabase
    .from('payments')
    .select('id, paystack_ref, scan_id, fix_tier, created_at')
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
      result.reenqueued.push({ reference: payment.paystack_ref, scanId: scan.id, kind })
    } catch (err) {
      result.failed.push({ reference: payment.paystack_ref, scanId: scan.id, kind, error: err.message })
    }
  }

  if (alert && (result.reenqueued.length || result.failed.length)) {
    try {
      const emailService = require('./email.service')
      const lines = [
        ...result.reenqueued.map(r => `RECOVERED  ${r.reference}  scan ${r.scanId}  (${r.kind})`),
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
