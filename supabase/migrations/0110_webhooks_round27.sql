-- Webhooks round 27 (G2): when was the work delivered? Dispute evidence (proof PDF + Paystack's delivery_date) used to say only
-- "delivered" with the PAYMENT date. A trigger stamps it so every one of the code paths that sets FIX_DELIVERED is covered without
-- touching them. A retry round that delivers again re-stamps: the value is the latest delivery. Rows delivered before this
-- migration stay NULL on purpose - an approximated date must not go to a card network as evidence.
alter table scans add column if not exists fix_delivered_at timestamptz;

create or replace function scans_stamp_fix_delivered() returns trigger
language plpgsql as $$
begin
  if new.status = 'FIX_DELIVERED' and (tg_op = 'INSERT' or old.status is distinct from 'FIX_DELIVERED') then
    new.fix_delivered_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists scans_stamp_fix_delivered on scans;
create trigger scans_stamp_fix_delivered
  before insert or update of status on scans
  for each row execute function scans_stamp_fix_delivered();

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (110, '0110_webhooks_round27')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 110, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 110;   -- never move the version BACKWARDS (a re-run of an older file)
