-- AUDIT FIX (Auth section audit — critical): every function created in the
-- public schema on Supabase is, by platform default, automatically granted
-- EXECUTE to `anon`, `authenticated`, AND `service_role` the moment it's
-- created — this is Supabase's own documented default-privilege behavior
-- (an ALTER DEFAULT PRIVILEGES rule set at the platform level for the
-- `public` schema on every project). None of the 22 migrations before this
-- one ever issued a single GRANT or REVOKE statement, so every RPC function
-- in this schema has been sitting there directly callable via
-- `POST /rest/v1/rpc/<function_name>` by anyone holding the project's anon
-- key — no JWT, no app logic, no rate limiting, completely bypassing this
-- Worker.
--
-- 0014_enable_rls.sql already reasoned carefully about the anon-key-leak
-- threat model — but RLS only governs table ROWS. It does nothing for
-- these FUNCTIONS: every one below is `security definer`, which means it
-- bypasses RLS entirely by design and runs with the elevated privilege of
-- whichever role owns it. That's a completely separate privilege surface
-- from the one 0014 closed, and it was never addressed.
--
-- Every one of these functions is meant to be called from EXACTLY ONE
-- place: this app's own backend, using the service_role key, with a
-- user_id/scan_id it already derived from a verified JWT/ownership check.
-- None of them are meant to be reachable directly by a client holding only
-- the anon key. Locking EXECUTE down to service_role only closes that gap
-- without changing any application behavior — the app never called these
-- any other way to begin with.
--
-- scrub_account_data is the most severe of these left open: an arbitrary
-- UUID passed directly to it anonymizes/soft-deletes that account, no
-- auth required, if EXECUTE is left at its default grant.

revoke execute on function scrub_account_data(uuid) from public, anon, authenticated;
grant  execute on function scrub_account_data(uuid) to service_role;

revoke execute on function redeem_free_fix_credit(uuid) from public, anon, authenticated;
grant  execute on function redeem_free_fix_credit(uuid) to service_role;

revoke execute on function increment_free_fix_credits(uuid) from public, anon, authenticated;
grant  execute on function increment_free_fix_credits(uuid) to service_role;

revoke execute on function increment_scan_count_if_under_limit(uuid, int, timestamptz) from public, anon, authenticated;
grant  execute on function increment_scan_count_if_under_limit(uuid, int, timestamptz) to service_role;

revoke execute on function decrement_scan_count(uuid) from public, anon, authenticated;
grant  execute on function decrement_scan_count(uuid) to service_role;

revoke execute on function increment_fix_retry_if_available(uuid, int, int) from public, anon, authenticated;
grant  execute on function increment_fix_retry_if_available(uuid, int, int) to service_role;

revoke execute on function increment_referral_code_usage(uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid) to service_role;

revoke execute on function increment_referral_code_clicks(text) from public, anon, authenticated;
grant  execute on function increment_referral_code_clicks(text) to service_role;

revoke execute on function increment_verification_views(text) from public, anon, authenticated;
grant  execute on function increment_verification_views(text) to service_role;

-- set_updated_at() is a trigger function (fires via `before update` triggers,
-- never called directly by the app or by PostgREST as an RPC) — has no
-- business being directly callable either, same posture as the rest.
revoke execute on function set_updated_at() from public, anon, authenticated;
grant  execute on function set_updated_at() to service_role;

-- Forward-looking: without this, the NEXT function anyone adds in a future
-- migration silently reopens this exact gap again, since the platform
-- default re-applies to every newly created function. This rule makes
-- "callable by anon/authenticated" an explicit opt-in from here on, not
-- the silent default — any future RPC that genuinely needs client-side
-- reachability grants EXECUTE explicitly in its own migration, the same
-- way real, intentionally-public Postgres functions always should.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
