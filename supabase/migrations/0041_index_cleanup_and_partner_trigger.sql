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

-- ── 3. increment_referral_code_usage / increment_referral_code_clicks ──────
-- CORRECTION (Section 9/10 re-audit): this section originally claimed these
-- two were "the only two atomic-increment RPCs in the whole migration set
-- not marked security definer" — that's wrong.
-- 0015_definer_hardening_and_score_checks.sql already added `security
-- definer` + `set search_path = public` to both, with the exact bodies
-- below, 26 migrations before this file existed. No migration in between
-- ever redefined either function. Re-running the identical CREATE OR
-- REPLACE here is a harmless no-op (same OID, same body, same grants — see
-- 0023 for the EXECUTE lockdown that already covered them), but the comment
-- that justified it mis-stated the migration history. Left in place
-- unchanged (removing it now buys nothing and a no-op CREATE OR REPLACE is
-- not worth a new migration to undo); this note exists so the next audit
-- doesn't re-trust the original claim at face value.
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
