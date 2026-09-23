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

function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

module.exports = { getSupabase }
