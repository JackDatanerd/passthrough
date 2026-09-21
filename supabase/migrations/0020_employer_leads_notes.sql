-- FEATURE GAP CLOSED (Section 5, fixing-time pass): the leads list had a
-- status enum (0018) but no free-text place to record WHY a lead is in that
-- state — "left voicemail, follow up Thu", "not a fit, wrong industry",
-- etc. Every sibling admin list that supports lifecycle state (Users via
-- role/status changes with an audit trail, Partners) can carry more context
-- than a single enum value; leads couldn't record any of it short of an
-- admin's own memory or an external note-taking tool.
--
-- Purely additive, nullable, no backfill needed — every existing lead
-- simply has no notes yet, which is correct.

alter table employer_leads add column if not exists notes text;
