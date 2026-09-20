-- AUDIT FIX (Section 10 — Database layer).
--
-- PART 1 — SECURITY DEFINER consistency + search_path pinning.
--
-- Every RPC from 0002 through 0009 was declared `security definer`.
-- 0012's two newer ones (increment_referral_code_usage,
-- increment_referral_code_clicks) were left as plain functions — an
-- unexplained inconsistency. It's functionally inert today only because
-- every caller is the service_role key, which bypasses RLS (now enabled —
-- see 0014_enable_rls.sql) regardless of a function's definer/invoker
-- rights. But it's a latent trap: if a genuine invoker-vs-definer
-- distinction ever starts to matter here (a future non-service_role
-- caller), these two would silently behave differently from every other
-- RPC in this file for no principled reason. Made consistent.
--
-- Separately: none of these functions pinned `search_path`, which is the
-- standard defense against search-path hijacking of SECURITY DEFINER
-- functions (this is exactly what Supabase's own database linter flags as
-- "Function Search Path Mutable"). Low exploitability here specifically —
-- no untrusted caller has direct SQL access to this database — but it's a
-- free, standard hardening step that costs nothing to add, and it's the
-- kind of gap that only gets more relevant as more of this schema's
-- original "nothing untrusted ever touches this DB directly" assumptions
-- get revisited (see 0014's RLS comment). Every definer function below is
-- re-declared with `set search_path = public` and its body is otherwise
-- byte-for-byte identical to its original migration.

create or replace function increment_verification_views(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update scans
  set verification_views = verification_views + 1
  where verification_code = p_code;
$$;

create or replace function increment_free_fix_credits(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update users
  set free_fix_credits = free_fix_credits + 1
  where id = p_user_id;
$$;

create or replace function redeem_free_fix_credit(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update users
  set free_fix_credits = free_fix_credits - 1
  where id = p_user_id and free_fix_credits > 0;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function increment_scan_count_if_under_limit(
  p_user_id uuid,
  p_limit int,
  p_today_midnight timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  update users
  set
    scans_today     = case when scans_day_reset < p_today_midnight then 1
                           else scans_today + 1 end,
    scans_day_reset = case when scans_day_reset < p_today_midnight then now()
                           else scans_day_reset end
  where id = p_user_id
    and (
      scans_day_reset < p_today_midnight
      or scans_today < p_limit
    );
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function decrement_scan_count(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update users set scans_today = greatest(scans_today - 1, 0) where id = p_user_id;
$$;

create or replace function increment_fix_retry_if_available(
  p_scan_id uuid,
  p_max_retries int,
  p_badge_threshold int
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count int;
begin
  update scans
  set fix_retry_count = fix_retry_count + 1,
      status          = 'FIX_GENERATING'
  where id = p_scan_id
    and status = 'FIX_DELIVERED'
    and fix_retry_count < p_max_retries
    and (fix_ats_score is null or fix_ats_score < p_badge_threshold)
  returning fix_retry_count into v_new_count;

  return coalesce(v_new_count, -1);
end;
$$;

-- These two now get security definer + search_path pinning for the first
-- time, matching every other function above.
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


-- PART 2 — defensive range CHECK constraints.
--
-- None of the *_score columns (all plain `int`, added across 0001/0004)
-- had any bound, despite the entire product comparing them against fixed
-- thresholds (ATS_PASS_THRESHOLD=75, ATS_BADGE_THRESHOLD=80 in
-- config/constants.js). A scoring bug anywhere upstream could silently
-- write -40 or 250 into one of these with nothing at the DB layer to catch
-- it. Added `not valid` deliberately: this skips validating EXISTING rows
-- at migration time (so it can't fail/block on data already in the table),
-- while still enforcing the bound on every INSERT/UPDATE from this point
-- forward. Run `alter table scans validate constraint <name>` separately,
-- whenever convenient, to confirm existing rows already comply (they
-- should, since nothing in the app has ever intentionally written outside
-- 0-100) and drop the "not valid" flag.
--
-- Guarded with a pg_constraint existence check so this file is safe to
-- re-run, matching the style already established in 0013.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'scans_ats_score_range') then
    alter table scans add constraint scans_ats_score_range check (ats_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_fix_ats_score_range') then
    alter table scans add constraint scans_fix_ats_score_range check (fix_ats_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_keyword_score_range') then
    alter table scans add constraint scans_keyword_score_range check (keyword_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_format_score_range') then
    alter table scans add constraint scans_format_score_range check (format_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_sections_score_range') then
    alter table scans add constraint scans_sections_score_range check (sections_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_content_score_range') then
    alter table scans add constraint scans_content_score_range check (content_score between 0 and 100) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'scans_integrity_score_range') then
    -- integrity_score (0001, "Phase 2") is currently unused anywhere in
    -- src/ — scaffolded but never wired up. Same 0-100 assumption as every
    -- other *_score column here, held for consistency in case/when it is.
    alter table scans add constraint scans_integrity_score_range check (integrity_score between 0 and 100) not valid;
  end if;

  -- commission_rate is a fraction (0.25 = 25%), not a percentage integer —
  -- see 0012's comment. numeric(5,4) allows up to 9.9999 (990%) with
  -- nothing stopping an admin typo (e.g. "2.5" meant as a percent, not a
  -- fraction) from silently creating a nonsensical commission rate. Bounded
  -- to the only sane range for a commission fraction.
  if not exists (select 1 from pg_constraint where conname = 'partners_commission_rate_range') then
    alter table partners add constraint partners_commission_rate_range
      check (commission_rate >= 0 and commission_rate <= 1) not valid;
  end if;
end $$;
