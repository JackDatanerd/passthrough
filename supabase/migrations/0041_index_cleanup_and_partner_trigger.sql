-- 0041_index_cleanup_and_partner_trigger.sql
-- Section 9/10 audit pass, bugs (no live incident — schema hygiene only).
-- Idempotent — safe to re-run.

-- ── 1. Drop four redundant duplicate indexes (0001_init.sql) ──────────────
-- users.email, scans.verification_code, scans.anon_token and
-- payments.paystack_ref are each declared `unique` at the column level,
-- which already backs them with Postgres's own unique btree index. 0001 then
-- ALSO created a second, separate, non-unique index on each of those exact
-- same single columns (idx_users_email, idx_scans_verification_code,
-- idx_scans_anon_token, idx_payments_paystack_ref). The explicit index is
-- never used for anything — the unique constraint's own index already
-- serves every equality lookup on these columns — so this was pure
-- write-amplification and storage overhead on scans and payments, the two
-- highest-write tables in the schema, since the app's first deploy.
drop index if exists idx_users_email;
drop index if exists idx_scans_verification_code;
drop index if exists idx_scans_anon_token;
drop index if exists idx_payments_paystack_ref;

-- ── 2. partners.updated_at never refreshes ─────────────────────────────────
-- users/scans/payments each got a trg_<table>_updated_at trigger wired to
-- set_updated_at() in 0001_init.sql. partners (0011_partners_and_payouts.sql)
-- got the same `updated_at timestamptz not null default now()` column shape
-- but no matching trigger — checked the full migration history, it was never
-- added. Every partner mutation since (status flip, commission-rate change,
-- payout-details submission, email change) has left updated_at frozen at
-- the row's original creation time. set_updated_at() already exists from
-- 0001; this just wires it up for the one table that was missing it.
create trigger trg_partners_updated_at
  before update on partners
  for each row execute function set_updated_at();

-- ── 3. Missing security definer on two referral RPCs ───────────────────────
-- increment_referral_code_usage and increment_referral_code_clicks
-- (0012_referral_pricing_and_commission_ledger.sql) were the only two
-- atomic-increment RPCs in the whole migration set not marked `security
-- definer`, unlike every sibling (increment_verification_views,
-- increment_free_fix_credits, redeem_free_fix_credit,
-- increment_scan_count_if_under_limit, decrement_scan_count,
-- increment_fix_retry_if_available). No live effect — 0023 already locked
-- EXECUTE on both down to service_role only, and it bypasses RLS regardless —
-- but it silently depended on that grant rather than being correct on its
-- own terms. CREATE OR REPLACE keeps each function's OID, so 0023's existing
-- grants need no re-grant.
create or replace function increment_referral_code_usage(p_code_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update referral_codes set uses_so_far = uses_so_far + 1 where id = p_code_id;
$$;

create or replace function increment_referral_code_clicks(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update referral_codes set clicks = clicks + 1 where code = p_code;
$$;
