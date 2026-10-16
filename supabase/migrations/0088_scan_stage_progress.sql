-- Scan/fix waiting states, round 2: let the page follow the real pipeline instead of pacing steps by the clock.
--
--   scan_stage    'reading' (file fetched and being read) | 'scoring' (text ready; rule + AI scoring). NULL = no stage
--                 reported (not started, finished, or a row from before this migration).
--   fix_progress  { startedAt, round, phase, attempt, of, scores[] } for the CURRENT fix round (round = fix_retry_count): phase is 'starting' | 'rewriting' |
--                 'scoring' | 'rendering', scores holds each attempt's real score so far. Kept after delivery so the
--                 delivered screen can show the real attempt ladder.
--
-- Both are best-effort telemetry written by the job. Nothing reads them to decide anything (status stays the source
-- of truth), they hold no resume content, and the client only ever sees them through the scan/status allow-lists.
alter table scans add column if not exists scan_stage text;
alter table scans add column if not exists fix_progress jsonb;

alter table scans drop constraint if exists scans_scan_stage_check;
alter table scans add constraint scans_scan_stage_check
  check (scan_stage is null or scan_stage in ('reading', 'scoring'));

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (88, '0088_scan_stage_progress')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 88, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 88;   -- never move the version BACKWARDS (a re-run of an older file)
