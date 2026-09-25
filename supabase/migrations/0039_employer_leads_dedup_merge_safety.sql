-- 0039_employer_leads_dedup_merge_safety.sql
-- AUDIT FIX (Section 9/10 pass, bug). Idempotent — safe to re-run.
--
-- 0013, 0021, and 0032 each collapse duplicate employer_leads rows (same
-- email, or the same email under different casing) with the same pattern:
--
--   delete from employer_leads a using employer_leads b
--   where a.email = b.email and (a.created_at, a.id) < (b.created_at, b.id);
--
-- i.e. keep the newest row per email, drop the rest. That's fine when the
-- duplicates are truly interchangeable — which is all 0013 ever had to
-- consider, since `status`/`notes` didn't exist yet.
--
-- By the time 0021 (case-insensitive email fix) runs, `status` (0018) and
-- `notes` (0020) already exist on the table. By 0032, so do `contacted_at`/
-- `confirmed_at`/`submission_count` (0028). If an admin had already worked a
-- lead — moved it to CONTACTED, written notes — on the OLDER of two
-- duplicate rows, while a newer duplicate (a stale mixed-case resubmission,
-- or one that predates the app's lowercasing) sat untouched at the default
-- NEW with no notes, 0021/0032's blind "keep newest" delete keeps the empty
-- row and silently destroys the admin's work. This isn't hypothetical: it's
-- exactly what those two migrations do, on whatever real duplicate rows
-- exist in a given deployment's `employer_leads` table at the moment they
-- are actually applied.
--
-- This migration doesn't edit 0021/0032 in place — same reasoning as every
-- other multi-pass fix in this schema (see scrub_account_data's five
-- create-or-replace generations): a migration that already ran against a
-- real database doesn't get retroactively fixed by editing its file, only
-- confused by it. Instead, this runs the same collapse the safe way, and is
-- a genuine no-op everywhere the original migrations already ran cleanly
-- (the common case — an admin rarely works a lead in the same instant a
-- case-duplicate of it exists). It only matters for: a deployment applying
-- migrations from scratch today against imported/legacy data, or one that
-- skipped straight to a later migration number and is only now catching up
-- through 0021/0032's original logic for the first time.
--
-- MERGE RULE: for each group of rows sharing the same lower(email), pick one
-- "source of truth" row for status/notes/contacted_at/confirmed_at — a row
-- that shows real engagement (status <> 'NEW', or notes/contacted_at/
-- confirmed_at set) outranks an untouched default; among engaged rows, the
-- most recently updated one wins (it reflects the current true state, not a
-- stale intermediate one). submission_count is SUMMED and last_submitted_at
-- takes the MAX across the whole group — those were always meant to track
-- total engagement, not just whichever row happened to survive. The row that
-- survives is still the newest by (created_at, id), unchanged from the
-- original migrations' own identity/created_at semantics.
--
-- Requires 0034 to have already run (confirmed_at) — true for anyone
-- following DEPLOYMENT.md's "run every file, in filename order" instruction,
-- same precondition every migration in this schema already assumes.

with source as (
  -- One row per email group: the best available status/notes/contacted_at/
  -- confirmed_at, per the MERGE RULE above.
  select distinct on (lower(email))
    lower(email) as email_norm,
    status, notes, contacted_at, confirmed_at
  from employer_leads
  order by lower(email),
    (status <> 'NEW' or notes is not null or contacted_at is not null or confirmed_at is not null) desc,
    updated_at desc nulls last,
    id desc
),
agg as (
  -- Group-wide totals that should never have depended on which physical row survives.
  select lower(email) as email_norm,
         sum(submission_count) as submission_count,
         max(last_submitted_at) as last_submitted_at
  from employer_leads
  group by lower(email)
),
keeper as (
  -- Same "keep newest" identity the original migrations used.
  select distinct on (lower(email)) id, lower(email) as email_norm
  from employer_leads
  order by lower(email), created_at desc, id desc
)
update employer_leads e
set status            = source.status,
    notes             = source.notes,
    contacted_at      = source.contacted_at,
    confirmed_at      = source.confirmed_at,
    submission_count  = agg.submission_count,
    last_submitted_at = agg.last_submitted_at
from source, agg, keeper
where e.id = keeper.id
  and keeper.email_norm = source.email_norm
  and keeper.email_norm = agg.email_norm
  and (
    e.status is distinct from source.status or
    e.notes is distinct from source.notes or
    e.contacted_at is distinct from source.contacted_at or
    e.confirmed_at is distinct from source.confirmed_at or
    e.submission_count is distinct from agg.submission_count or
    e.last_submitted_at is distinct from agg.last_submitted_at
  );

-- Same normalize-then-collapse the original migrations did — now safe, since
-- anything worth keeping from a row about to be deleted was already merged
-- onto its keeper above.
update employer_leads set email = lower(email) where email <> lower(email);

delete from employer_leads a
using employer_leads b
where a.email = b.email
  and (a.created_at, a.id) < (b.created_at, b.id);
