-- Experts Phase 2A rollback for migration 0127. MANUAL and optional: turning the flag off (EXPERT_REALM_ENABLED unset or not "true") already makes the whole
-- realm answer 404 and changes nothing else, and is the rollback to use first. Nothing here is run by the app or by a migration.
--
-- LEVEL 1 (undo only the data copied in from Phase 1; leaves every new table and function in place and the flag-off app unchanged)
delete from job_pauses       where source = 'phase1_backfill';
delete from job_next_actions where source = 'phase1_backfill';

-- LEVEL 2 (remove everything 0127 added). Run ONLY with the flag off and no expert signed in. Phase 1 tables, functions and rows are not touched.
-- This loses: realm sessions, recovery codes, password reset rows, engine pause/next-action/idempotency rows and the bridge call log. The audit log
-- (expert_audit_log, from 0124) is NOT dropped: it is the record of what happened.
--   drop function if exists human_job_transition(uuid, text, text, text, uuid, int, uuid, text, jsonb, text, int, timestamptz, int, timestamptz, timestamptz);
--   drop table if exists expert_bridge_calls, job_event_keys, job_pauses, job_next_actions, job_transition_rules, expert_password_resets, expert_recovery_codes, expert_sessions;
--   delete from applied_migrations where version = 127;
--   update system_state set value = jsonb_set(value, '{version}', '126') where key = 'schema_version';
-- After level 2, set EXPECTED_SCHEMA_VERSION back to 126 in src/config/constants.js and remove the 0127 line from src/config/migrationLedger.js, or /health reports a schema alert.
