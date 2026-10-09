-- Section 4 round 6: record that an applicant accepted the partner program terms, and which version.
-- Both columns are nullable: rows created before this migration (and partners an admin creates directly,
-- who never saw the terms form) simply have no acceptance on record.
alter table partner_applications add column if not exists terms_accepted_at timestamptz;
alter table partner_applications add column if not exists terms_version     text;
alter table partners             add column if not exists terms_accepted_at timestamptz;
alter table partners             add column if not exists terms_version     text;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 63, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
