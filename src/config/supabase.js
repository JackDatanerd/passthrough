// Replaces config/database.js (Prisma singleton). Workers are stateless and
// short-lived per-request, so there's no module-level singleton to maintain —
// each request creates a lightweight client bound to that request's env
// bindings. @supabase/supabase-js is fetch-based and works natively on Workers.
//
// IMPORTANT: always use the service_role key (SUPABASE_SERVICE_ROLE_KEY), never
// the anon key — the Worker is the trusted backend, not a browser client.
// RLS is off (see migration file) precisely because this key bypasses it by
// design; do not swap in the anon key without adding RLS policies first.

const { createClient } = require('@supabase/supabase-js')

function getSupabase(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

module.exports = { getSupabase }
