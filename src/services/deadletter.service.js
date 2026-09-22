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
    const { type, scanId } = message.body || {}
    try {
      if (scanId) {
        try {
          must(await supabase.from('scans').update({ status: 'ERROR' })
            .eq('id', scanId).in('status', ['FIX_PURCHASED', 'FIX_GENERATING']), 'dead-letter: mark scan ERROR')
        } catch (err) { console.error(`Dead-letter: could not mark scan ${scanId} ERROR:`, err.message) }
      }
      await emailService.sendOwnerAlert(env,
        `Fix job dead-lettered: ${type || 'unknown type'}`,
        `A ${type || 'fix'} job exhausted its queue retries and was dead-lettered.\n\nscanId: ${scanId || '(none)'}\n` +
        `message id: ${message.id || '(n/a)'}\nattempts: ${message.attempts ?? '(n/a)'}\n\n` +
        `The scan was moved to ERROR (if it was still generating). The automatic failed-fix sweep will retry it; ` +
        `if that also fails, re-run with POST /api/admin/scans/${scanId || ':id'}/requeue-fix.`)
    } catch (err) {
      console.error('Dead-letter handler error:', err.message)
    }
    message.ack()
  }
}

module.exports = { handleDeadLetterBatch }
