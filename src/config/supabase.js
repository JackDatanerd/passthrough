// Replaces config/database.js (Prisma singleton). Workers are stateless and
// short-lived per-request, so there's no module-level singleton to maintain —
// each request creates a lightweight client bound to that request's env
// bindings. @supabase/supabase-js is fetch-based and works natively on Workers.
//
// IMPORTANT: always use the service_role key (SUPABASE_SERVICE_ROLE_KEY), never
// the anon key — the Worker is the trusted backend, not a browser client.
// AUDIT FIX (Section 9/10 pass): this used to say "RLS is off" — stale since
// 0014_enable_rls.sql turned RLS ON, with zero policies, on every table (see
// that migration's own reasoning). service_role bypasses RLS by design
// regardless of whether it's on or off, so nothing here behaved differently
// — but the comment was actively misleading about the DB's actual posture.
// Do not swap in the anon key: with RLS on and no policies, it would get
// zero rows back everywhere, not the open access this comment used to imply.

const { createClient } = require('@supabase/supabase-js')

// supabase-js has NO request timeout of its own, and every other upstream this app calls
// (Claude, Paystack, Resend, Turnstile) has one. A hung PostgREST call otherwise holds the
// request — or a queue consumer's whole batch — until the platform gives up on it. Every
// request is now aborted after SUPABASE_TIMEOUT_MS (default 25s: well above any real query here,
// well below "stuck"). An abort surfaces as an ordinary Supabase error, so every caller's existing
// error path (must(), the fail-open/fail-closed choices) handles it.
const DEFAULT_TIMEOUT_MS = 25_000

function linkSignals(a, b) {
  const ctl = new AbortController()
  for (const sig of [a, b]) {
    if (sig.aborted) { ctl.abort(sig.reason); break }
    sig.addEventListener('abort', () => ctl.abort(sig.reason), { once: true })
  }
  return ctl.signal
}

function timeoutFetch(ms = DEFAULT_TIMEOUT_MS, baseFetch = (...a) => fetch(...a)) {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(ms)
    const signal = init.signal ? linkSignals(init.signal, timeout) : timeout
    return baseFetch(input, { ...init, signal })
  }
}

function getSupabase(env) {
  const ms = parseInt(env.SUPABASE_TIMEOUT_MS, 10)
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: timeoutFetch(ms > 0 ? ms : DEFAULT_TIMEOUT_MS) }
  })
}

module.exports = { getSupabase, timeoutFetch, DEFAULT_TIMEOUT_MS }
