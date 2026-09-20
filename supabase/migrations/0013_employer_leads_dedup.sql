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

alter table employer_leads add column updated_at timestamptz not null default now();
alter table employer_leads add constraint employer_leads_email_key unique (email);
