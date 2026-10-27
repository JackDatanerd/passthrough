-- "Did your fix lead to an interview?" — when a person is asked (My Story tab / dashboard / follow-up email).
--
-- scans.fix_generated_at is rewritten by EVERY generation: a retry, an owner edit, a regeneration. The question's clocks
-- (14 days on the dashboard, 30 days for the email, a 120-day limit on both) were measured from it, so a person who tidied a
-- bullet on day 20 was not asked until day 34, and one who keeps editing was never asked. What the question is about is how long
-- the person has had a resume from us, so it is measured from the FIRST delivery.
--
--  1. scans.first_delivered_at — stamped once, by a trigger, the first time fix_generated_at becomes non-null. It covers every
--     writer (the three delivery paths in scan.controller.js and anything added later) without touching them. Backfilled from
--     fix_generated_at: for a scan that was already retried or edited that is the best value still known.
--  2. The follow-up sweep's working-set index moves to the new column (same predicate as 0070, new key).
--
-- No data is deleted, no existing column changes meaning.

alter table scans add column if not exists first_delivered_at timestamptz;

update scans set first_delivered_at = fix_generated_at
 where fix_generated_at is not null and first_delivered_at is null;

create or replace function stamp_first_delivered_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.fix_generated_at is not null and new.first_delivered_at is null then
    new.first_delivered_at := new.fix_generated_at;
  end if;
  return new;
end;
$$;

revoke execute on function stamp_first_delivered_at() from public, anon, authenticated;

drop trigger if exists scans_first_delivered_trg on scans;
create trigger scans_first_delivered_trg
  before insert or update of fix_generated_at on scans
  for each row execute function stamp_first_delivered_at();

drop index if exists scans_outcome_prompt_idx;
create index if not exists scans_outcome_prompt_idx
  on scans (first_delivered_at)
  where fix_purchased and first_delivered_at is not null and outcome_prompted_at is null and user_id is not null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (120, '0120_outcome_ask_first_delivery')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 120, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 120;   -- never move the version BACKWARDS (a re-run of an older file)
