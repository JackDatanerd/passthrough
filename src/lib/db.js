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
// The thrown value is a real Error carrying the PostgREST fields (code, details,
// hint), with the label prefixed onto its message. supabase-js hands back `error`
// as a PLAIN OBJECT, not an Error — and Hono only routes `instanceof Error` throws
// to app.onError, so throwing the raw object skipped errorHandler.js entirely (no
// JSON body, no CORS/security headers, no 23505 -> 409 mapping, no log line).

// Turns anything thrown into a real Error, keeping the fields errorHandler reads.
// An Error passes through untouched. Never copies `status`/`expose`: those opt an
// error in to choosing our response status, which a database error must not do.
function toError(thrown) {
  if (thrown instanceof Error) return thrown
  if (thrown && typeof thrown === 'object') {
    const e = new Error(typeof thrown.message === 'string' && thrown.message ? thrown.message : 'Unknown error')
    for (const k of ['code', 'details', 'hint']) if (thrown[k] !== undefined) e[k] = thrown[k]
    if (thrown.name === 'ZodError' && Array.isArray(thrown.errors)) { e.name = 'ZodError'; e.errors = thrown.errors }
    e.cause = thrown
    return e
  }
  return new Error(String(thrown ?? 'Unknown error'))
}

function must(result, label) {
  const error = result && result.error
  if (!error) return result
  const err = toError(error)
  if (label && typeof err.message === 'string' && !err.message.startsWith(label))
    err.message = `${label}: ${err.message}`
  throw err
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

// PostgREST answers an offset past the end of the result set with 416
// (PGRST103, "Requested range not satisfiable") whenever a count was asked
// for — which supabase-js surfaces as `{ error }`, and the callers' usual
// `if (error) throw error` turns into a 500. A page number that has outlived
// its data (rows deleted, a stale bookmark, a hand-edited ?page=) is a normal
// thing for a client to send: the right answer is an empty page that still
// reports the real total, not a server error. Callers check this, then fetch
// the total with a head-only count.
function isRangeError(error) {
  if (!error) return false
  return error.code === 'PGRST103' || /range not satisfiable/i.test(String(error.message || ''))
}

module.exports = { must, toError, warnOnError, isRangeError }
