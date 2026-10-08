-- Cross-cutting infra round 1 (gaps G3 + G4).
--
-- 1. system_state — a tiny key/value table the Worker uses to know about ITSELF:
--      schema_version  which migration this database has been brought up to. The deploy notes
--                      repeatedly say "apply migration NNNN BEFORE deploying the Worker"; nothing
--                      could notice a database that was behind the code. The Worker now compares
--                      this value with constants.EXPECTED_SCHEMA_VERSION (admin health, deep
--                      /healthz, and an hourly owner alert when they differ).
--      cron_heartbeat  written by the hourly cron. If the cron stops, every sweep stops (stuck-scan
--                      recovery, payment reconciliation, retention) and nothing used to say so.
--    EVERY LATER MIGRATION must end by bumping schema_version (see the last statement below) and
--    constants.EXPECTED_SCHEMA_VERSION — tests/schemaVersion.test.js fails otherwise.
--
-- 2. email_suppressions — addresses whose mailbox provider told us (through the Resend webhook) that
--    they permanently bounce or marked our mail as spam. Hash only, never the address. send() skips
--    every non-security, non-payment template for them: mailing a dead or hostile address again only
--    hurts the sending domain that password resets also go out from.
--
-- Both tables get row level security with no policies, like every other table (0014): only the
-- service_role key the Worker uses can reach them.

create table if not exists system_state (
  key         text primary key,
  value       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
alter table system_state enable row level security;

create table if not exists email_suppressions (
  email_hash  text primary key,                       -- sha256 of the lowercased address
  reason      text not null check (reason in ('bounce', 'complaint')),
  created_at  timestamptz not null default now()
);
alter table email_suppressions enable row level security;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 59, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
