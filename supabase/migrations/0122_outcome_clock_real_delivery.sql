-- The "did it lead to an interview?" clock starts when the person first RECEIVED A REAL RESUME from us.
--
-- 0120 stamped scans.first_delivered_at the first time fix_generated_at became non-null. Two cases made that the wrong moment:
--   * a delivery whose rewrite FAILED (rewrite_failed = true) hands back the unchanged resume and writes fix_generated_at in the same
--     update. A fix that failed and was retried successfully twelve days later was asked fourteen days after the FAILED delivery.
--   * a Badge -> Fix upgrade keeps the badge's delivery stamp, while the rewrite the question is about arrives later.
--
-- New rule, in the same trigger (still one place, still covers every writer):
--   - a delivery stamps only when its rewrite did not fail, and only when fix_generated_at actually changed (an UPDATE that merely
--     names the column again never re-stamps);
--   - moving a scan from the BADGE tier to FIX clears the stamp, so the next successful delivery stamps it again; moving it back to
--     BADGE (an upgrade that could not be delivered is rolled back) restores it from the badge delivery that is still on the scan.
-- Backfill: a scan whose current delivery is a failed one has no real delivery yet, so its stamp is cleared.

create or replace function stamp_first_delivered_at()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  failed boolean := coalesce(new.rewrite_failed, false);
begin
  if tg_op = 'UPDATE' then
    if old.fix_tier is distinct from new.fix_tier and old.fix_tier = 'BADGE' and new.fix_tier = 'FIX' then
      new.first_delivered_at := null;            -- the rewrite is what is being delivered now
      return new;
    end if;
    if old.fix_tier is distinct from new.fix_tier and old.fix_tier = 'FIX' and new.fix_tier = 'BADGE'
       and new.first_delivered_at is null and new.fix_generated_at is not null and not failed then
      new.first_delivered_at := new.fix_generated_at;   -- rolled-back upgrade: the badge delivery is still the delivery
      return new;
    end if;
  end if;
  if new.fix_generated_at is not null and new.first_delivered_at is null and not failed
     and (tg_op = 'INSERT' or new.fix_generated_at is distinct from old.fix_generated_at) then
    new.first_delivered_at := new.fix_generated_at;
  end if;
  return new;
end;
$$;

revoke execute on function stamp_first_delivered_at() from public, anon, authenticated;

drop trigger if exists scans_first_delivered_trg on scans;
create trigger scans_first_delivered_trg
  before insert or update of fix_generated_at, fix_tier, rewrite_failed on scans
  for each row execute function stamp_first_delivered_at();

update scans set first_delivered_at = null where rewrite_failed and first_delivered_at is not null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (122, '0122_outcome_clock_real_delivery')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 122, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 122;   -- never move the version BACKWARDS (a re-run of an older file)
