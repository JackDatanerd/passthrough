// SCAN/ATS ROUND 4 (cost ledger). callClaude() reports every call's token usage to env.__usage when a job has put a
// collector there; the job writes the collected rows to claude_usage when it finishes. Best-effort throughout: the
// ledger must never be the reason a scan, a fix or a download fails, and it must keep working if the migration that
// creates the table has not been applied yet (the insert error is logged and swallowed).
function track(env) {
  // A copy, not a mutation: `env` is shared by every request the isolate serves.
  return { ...env, __usage: [] }
}

async function record(supabase, env, { scanId = null } = {}) {
  const rows = Array.isArray(env?.__usage) ? env.__usage.splice(0) : []
  if (!rows.length || !supabase) return
  try {
    const { error } = await supabase.from('claude_usage').insert(rows.map(r => ({
      scan_id: scanId, label: r.label, model: r.model,
      input_tokens: r.input_tokens, output_tokens: r.output_tokens,
    })))
    if (error) console.error('claude_usage insert:', error.message)
  } catch (err) { console.error('claude_usage insert:', err.message) }
}

// Run `fn(trackedEnv)` and write whatever it spent, whether it returned or threw.
async function withUsage(supabase, env, scanId, fn) {
  const tracked = track(env)
  try { return await fn(tracked) }
  finally { await record(supabase, tracked, { scanId }) }
}

module.exports = { track, record, withUsage }
