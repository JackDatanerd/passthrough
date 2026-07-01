-- Helper functions used by the Worker at runtime.
-- Run after 0001_init.sql.

-- Atomically increments verification_views on the matching scan.
-- Called from verify.controller.js via supabase.rpc().
-- Using UPDATE directly is the correct atomic approach — no read needed.
create or replace function increment_verification_views(p_code text)
returns void
language sql
security definer
as $$
  update scans
  set verification_views = verification_views + 1
  where verification_code = p_code;
$$;
