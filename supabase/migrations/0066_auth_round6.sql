-- Auth, audit round 6. Idempotent — safe to re-run.
--
-- B4  users.reset_token / email_verify_token / email_change_done_token had no index, so every
--     reset-link check, reset, verification and replay lookup — all reachable without signing in — was
--     a sequential scan of users. Partial indexes (most rows hold NULL in all three), so they stay
--     small and cost almost nothing on the hot write paths. Not unique: the columns hold hashes of
--     random 256-bit tokens, and a unique index would turn a freak collision into a failed write.

create index if not exists idx_users_reset_token
  on users (reset_token) where reset_token is not null;
create index if not exists idx_users_email_verify_token
  on users (email_verify_token) where email_verify_token is not null;
create index if not exists idx_users_email_change_done_token
  on users (email_change_done_token) where email_change_done_token is not null;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 66, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
