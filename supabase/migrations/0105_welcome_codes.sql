-- Welcome codes (migration 0105).
--
-- Every account that verifies its email gets one personal, single-use discount code on the full fix (see services/welcomeCode.
-- service.js). Two things make that possible:
--
--   1. referral_codes.user_id: the account a code belongs to. A code with a user_id prices ONLY for that account - for anyone else
--      (a guessed string, a leaked screenshot, a ?ref= link passed on) it silently falls back to the normal price, like any
--      other code that does not apply. At most one such code per account (partial unique index; it is also the index the
--      foreign key needs).
--   2. A system partner that owns every welcome code. referral_codes.partner_id is NOT NULL and a code only prices while its
--      partner is ACTIVE, so the codes hang off one internal partner at a 0% commission rate (the same shape as the hardship
--      code). It never logs in and never receives mail: notify_conversions is off, and no job emails partners in bulk (every
--      partner email is sent for one named partner by an admin action). Do not edit, pause or delete it from Admin -> Partners:
--      pausing it stops every welcome code from applying.
--
-- Safe to apply before or after the Worker: the column is nullable (an existing code is a partner code with no user), and a
-- Worker that predates it never reads it.

alter table referral_codes add column if not exists user_id uuid references users(id);

create unique index if not exists referral_codes_one_per_user_uidx
  on referral_codes (user_id) where user_id is not null;

insert into partners (id, name, email, status, commission_rate, notify_conversions, dashboard_token, internal_notes)
values (
  '00000000-0000-4000-8000-00000000e1c0',
  'Passthrough welcome codes (system)',
  'welcome-codes@system.invalid',
  'ACTIVE',
  0,
  false,
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'System partner that owns every personal welcome code. 0% commission. Do not edit, pause or delete: pausing it stops all welcome codes from applying.'
)
on conflict (id) do nothing;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (105, '0105_welcome_codes')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 105, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 105;   -- never move the version BACKWARDS (a re-run of an older file)
