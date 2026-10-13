-- Partners / referral program, round 11.
--
-- B3 (erasure): adminAnonymizePartner could only clean the partner's CURRENT address out of email_logs / alert_logs.
-- After an admin changed the address, the notices sent to (and alerts quoting) the OLD one stayed behind. The
-- addresses a partner used to have are now remembered so the erasure can reach them; the list is emptied by the
-- erasure itself. Addresses changed BEFORE this migration cannot be recovered and age out with the retention sweep.
alter table partners
  add column if not exists previous_emails text[] not null default '{}';

-- Always the LAST statement of a migration: records how far this database has been migrated.
-- (Added by database round 2: this migration shipped without it, so the schema_version guard could not pass.)
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 80, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
