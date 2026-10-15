-- Partners / referral program, round 14.
--
-- B7 (performance): round 13 added the "sign-ups" step to the partner dashboard and the admin partner page
-- (attachSignupCounts): one head-only `count(*) from users where referred_by_code = <code>` per code, on every dashboard
-- load. users.referred_by_code (0079) has no index, so each of those counts scans the whole users table. A partial index
-- keeps it an index-only count and stays tiny, because only attributed accounts are in it. (Anonymising a user nulls the
-- column, 0082, which removes the row from the index.)
create index if not exists idx_users_referred_by_code
  on users (referred_by_code)
  where referred_by_code is not null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (85, '0085_partners_section4_round14')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 85, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 85;   -- never move the version BACKWARDS (a re-run of an older file)
