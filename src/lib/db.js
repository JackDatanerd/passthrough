// supabase-js NEVER throws on a failed query — a Postgres error, an HTTP error
// from PostgREST, and even a network failure all come back as
// `{ data: null, error }`. That makes this pattern a silent no-op:
//
//     try { await supabase.from('users').update(...) } catch (e) { ...never runs... }
//     await supabase.rpc('increment_free_fix_credits', ...)   // failure ignored
//
// A password reset that "succeeded" without writing the new password, a credit
// refund whose failure alert could never fire, an email_logs row that vanished
// silently — all of those were this bug. `must()` converts a result into the
// thing the surrounding code was written to expect: a throw.
//
//     const { data } = must(await supabase.from('scans').select('*').eq('id', id).single(), 'load scan')
//
// The thrown value is the original PostgrestError (an Error subclass), with the
// label prefixed onto its message, so errorHandler.js / 23505 handling / stack
// traces keep working exactly as they do for the existing `if (error) throw error`.

function must(result, label) {
  const error = result && result.error
  if (!error) return result
  if (label && typeof error.message === 'string' && !error.message.startsWith(label))
    error.message = `${label}: ${error.message}`
  throw error
}

// For best-effort writes where failure must be visible in logs but must not
// change the outcome (e.g. an analytics counter). Returns true when it worked.
function warnOnError(result, label) {
  if (result && result.error) {
    console.error(`${label}:`, result.error.message)
    return false
  }
  return true
}

module.exports = { must, warnOnError }
