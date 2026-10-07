// Consumer for the fix-jobs DEAD-LETTER queue.
//
// A message lands in the DLQ after the main queue has retried it max_retries
// times without the consumer ever acking — i.e. a platform-level failure that
// generateFix/generateBadge's own error handling could not absorb. Until now
// nothing consumed that queue, so those jobs (each one a paying customer's
// resume) sat there silently for as long as Cloudflare retains them.
//
// This does three things for each dead-lettered job, and never throws (a bad
// message must not wedge the DLQ consumer into retrying it forever):
//   1. tells the owner, with the scan id and the queue's own error context;
//   2. marks the scan ERROR if it is still mid-generation, so the customer's
//      page stops showing an endless spinner — and so the failed-fix sweep in
//      reconcile.service.js (which only looks at status='ERROR') can retry it
//      automatically or an admin can re-run it;
//   3. acks the message.

const { must } = require('../lib/db')

async function handleDeadLetterBatch(batch, env, supabase, emailService) {
  for (const message of batch.messages) {
    const { type, scanId, anonRlKey } = message.body || {}
    try {
      if (scanId && type === 'runAtsScan') {
        // A free scan that never ran: nothing was produced, so the person gets the
        // daily slot back (only for a scan created today — after the daily reset
        // the counter belongs to another day) exactly as an in-pipeline failure does.
        try {
          const { data: failed } = await supabase.from('scans').update({ status: 'ERROR' })
            .eq('id', scanId).in('status', ['PENDING', 'SCANNING']).select('id, user_id, created_at')
          for (const row of Array.isArray(failed) ? failed : []) {
            // An anonymous scan has no daily counter — it spent the visitor's one-an-hour slot.
            if (!row.user_id && anonRlKey && row.created_at && Date.now() - Date.parse(row.created_at) < 55 * 60 * 1000)
              await require('../middleware/rateLimiter').refundAnonScanSlot(env, anonRlKey)
            const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0)
            if (row.user_id && row.created_at && new Date(row.created_at) >= startOfToday) {
              const { error: refundErr } = await supabase.rpc('decrement_scan_count', { p_user_id: row.user_id })
              if (refundErr) console.error(`Dead-letter: quota refund failed for scan ${scanId}:`, refundErr.message)
            }
          }
        } catch (err) { console.error(`Dead-letter: could not fail scan ${scanId}:`, err.message) }
      } else if (scanId) {
        try {
          must(await supabase.from('scans').update({ status: 'ERROR' })
            .eq('id', scanId).in('status', ['FIX_PURCHASED', 'FIX_GENERATING']), 'dead-letter: mark scan ERROR')
        } catch (err) { console.error(`Dead-letter: could not mark scan ${scanId} ERROR:`, err.message) }
      }
      await emailService.sendOwnerAlert(env,
        `Fix job dead-lettered: ${type || 'unknown type'}`,
        `A ${type || 'fix'} job exhausted its queue retries and was dead-lettered.\n\nscanId: ${scanId || '(none)'}\n` +
        `message id: ${message.id || '(n/a)'}\nattempts: ${message.attempts ?? '(n/a)'}\n\n` +
        (type === 'runAtsScan'
          ? `The free scan was moved to ERROR and the person's daily scan slot handed back; they can simply scan again.`
          : `The scan was moved to ERROR (if it was still generating). The automatic failed-fix sweep will retry it; ` +
            `if that also fails, re-run with POST /api/admin/scans/${scanId || ':id'}/requeue-fix.`))
    } catch (err) {
      console.error('Dead-letter handler error:', err.message)
    }
    message.ack()
  }
}

module.exports = { handleDeadLetterBatch }
