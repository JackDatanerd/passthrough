-- FEATURE GAP CLOSED (Section 5 — Employer Leads, fixing-time pass): the
-- admin leads view (GET /api/employer-leads, AdminLeads.jsx) was read-only
-- with no way to track a lead's outreach lifecycle — every sibling admin
-- list (Users, Partners) supports at least some state-management, but a
-- lead sat in one undifferentiated pile forever with no way to mark it
-- worked, converted, or dismissed as spam short of deleting it outright.
--
-- lead_status_enum mirrors the naming convention of the other _enum types
-- in 0001_init.sql (role_enum, user_status_enum, etc.). NEW is the default
-- so every existing row (and every future public submission) lands there
-- without a backfill step.

create type lead_status_enum as enum ('NEW', 'CONTACTED', 'CONVERTED', 'ARCHIVED');

alter table employer_leads
  add column if not exists status lead_status_enum not null default 'NEW';

create index if not exists idx_employer_leads_status on employer_leads (status);
