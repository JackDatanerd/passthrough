-- AUDIT FIX (Section 9/10 pass — loose end, not a live bug).
--
-- 0015_definer_hardening_and_score_checks.sql added eight CHECK constraints
-- as `not valid` deliberately — that skips scanning the existing table at
-- migration time, so it can't fail/block on rows already there, while still
-- enforcing the bound on every INSERT/UPDATE from that point forward. Its
-- own comment says to run `alter table ... validate constraint <name>`
-- "separately, whenever convenient" to confirm existing rows already comply
-- and drop the not-valid flag. That follow-up never happened — 15 migrations
-- later, all eight are still sitting in the not-valid state, so
-- `information_schema`/`pg_constraint` still reports them as unverified
-- against historical data, and Postgres's planner can't use them for
-- constraint-exclusion the way it can a validated one. Enforcement on new
-- writes has been in effect since 0015 the whole time; this migration only
-- confirms it against what's already in the table and flips the flag.
--
-- VALIDATE CONSTRAINT only scans the table and updates pg_constraint — it
-- does not touch data, and requires no application change. Safe to re-run:
-- Postgres treats validating an already-valid constraint as a no-op, and the
-- guard below skips the scan entirely when there's nothing to do.
--
-- If any of these ever DOES fail (meaning some row predates 0015 with a
-- score outside 0-100), this migration will error out with that row
-- identified, on the specific constraint that found it — the DO block does
-- NOT swallow that error, and it shouldn't: a violation here means bad data
-- worth looking at, not a migration to silently skip past.

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'scans_ats_score_range' and not convalidated) then
    alter table scans validate constraint scans_ats_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_fix_ats_score_range' and not convalidated) then
    alter table scans validate constraint scans_fix_ats_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_keyword_score_range' and not convalidated) then
    alter table scans validate constraint scans_keyword_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_format_score_range' and not convalidated) then
    alter table scans validate constraint scans_format_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_sections_score_range' and not convalidated) then
    alter table scans validate constraint scans_sections_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_content_score_range' and not convalidated) then
    alter table scans validate constraint scans_content_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'scans_integrity_score_range' and not convalidated) then
    -- integrity_score is still unused anywhere in src/ as of this migration
    -- (scaffolded in 0001, never wired up — see 0015's own note). Validating
    -- it costs nothing since the column is always null today; kept for
    -- consistency with the other seven rather than left the odd one out.
    alter table scans validate constraint scans_integrity_score_range;
  end if;
  if exists (select 1 from pg_constraint where conname = 'partners_commission_rate_range' and not convalidated) then
    alter table partners validate constraint partners_commission_rate_range;
  end if;
end $$;
