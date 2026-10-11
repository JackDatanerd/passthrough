-- Verify, round 8 (0073). Idempotent — safe to re-run.
--
-- Apply BEFORE deploying the code: POST /api/verify/:code/report and the admin reports list answer 500 until
-- the table exists (the rest of the verify surface is unaffected).
--
-- A reader who doubts a verification page (or a candidate whose page is wrong) could only open a mailto: link,
-- which does nothing on a machine with no mail client and leaves no record an admin can act on. Reports now
-- land here; the admin Scans page lists the open ones next to the existing Revoke button.
--
-- reporter_hash is a one-way hash of the reporter's network (never the address itself); with the partial unique
-- index it means one OPEN report per (page, network), so a repeat click is absorbed instead of piling up.
-- reporter_email is optional, supplied by the reporter, and purged with the row (retention: 180 days).
create table if not exists verification_reports (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  reason         text not null check (reason in ('FAKE', 'WRONG', 'MINE', 'OTHER')),
  details        text,
  reporter_email text,
  reporter_hash  text not null,
  status         text not null default 'OPEN' check (status in ('OPEN', 'ACTIONED', 'DISMISSED')),
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  reviewed_by    uuid
);
create index if not exists idx_vreports_status_created on verification_reports (status, created_at desc);
create index if not exists idx_vreports_code on verification_reports (code);
create unique index if not exists uq_vreports_open_per_reporter on verification_reports (code, reporter_hash) where status = 'OPEN';
alter table verification_reports enable row level security;   -- service-role only (see 0014)

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 73, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
