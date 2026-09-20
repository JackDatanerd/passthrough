-- AUDIT FIX (Section 5 — Employer Leads): employer_leads had no uniqueness
-- constraint at all, so the same hiring manager re-submitting the "get
-- early access" form (e.g. from a different candidate's verification page)
-- silently created a duplicate row every time, with no dedup anywhere in
-- the application layer either.
--
-- employer-leads.controller.js now does an insert-then-fallback-to-update
-- on this constraint: a fresh email creates a new row (and fires an owner
-- alert — see that controller); a repeat email refreshes name/company/role
-- on the existing row instead of duplicating it. That fallback path is what
-- updated_at is for.
--
-- Written to be safely re-run in full (IF NOT EXISTS / guarded constraint
-- add) since the table already had duplicate emails in production before
-- this ran the first time (the smoke-test suite's fixed test address,
-- employer-smoketest@example.com, had been inserted by more than one prior
-- smoke-test run) — the plain `unique (email)` add failed outright against
-- that existing data. The delete below keeps the most recent row per email
-- (by created_at, with id as a tiebreaker for same-timestamp duplicates)
-- and drops the older ones before the constraint goes on.

alter table employer_leads add column if not exists updated_at timestamptz not null default now();

delete from employer_leads a
using employer_leads b
where a.email = b.email
  and (a.created_at, a.id) < (b.created_at, b.id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'employer_leads_email_key'
  ) then
    alter table employer_leads add constraint employer_leads_email_key unique (email);
  end if;
end $$;
