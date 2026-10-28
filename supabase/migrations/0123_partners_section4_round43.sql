-- Partners / referral, section 4 round 43.
--
-- increment_referral_code_usage(): migration 0108 replaced this function to read the code from the LOCKED ledger row, and in doing so
-- dropped what 0100 had added: when the sale is ALREADY reversed (a refund that landed before this bump), 0100 stamped
-- usage_released_at on the row, because a refunded sale never holds a slot. Without it the row ends up usage_counted = true with
-- usage_released_at null and nothing added to the counter, and the next release_referral_code_usage_for_ledger() call (a redelivered
-- refund webhook takes that path) found a "counted, unreleased" row and took a slot off uses_so_far that was never put on - a limited
-- code could then be sold one time too many.
--
-- 1. The function keeps 0108's behaviour (the sale's CURRENT code is charged, even after a move) and restores 0100's stamp.
-- 2. Rows 0108 already left in that state are stamped now, so the next redelivery cannot take the extra slot. (A release that already
--    happened wrongly cannot be told apart from a real one afterwards; those rows are stamped, so there is nothing left to repair.)
-- Same signature, create or replace, so a re-run is harmless.

create or replace function increment_referral_code_usage(
  p_code_id        uuid,
  p_reservation_id uuid default null,
  p_ledger_id      uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flipped  int := 1;
  v_reversed boolean := false;
  v_code_id  uuid := p_code_id;
  v_ledger_code uuid;
begin
  if p_ledger_id is not null then
    select referral_code_id into v_ledger_code from commission_ledger where id = p_ledger_id for update;
    if v_ledger_code is not null then v_code_id := v_ledger_code; end if;   -- the sale's CURRENT code, even if it was moved
    select exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) into v_reversed;

    update commission_ledger
       set usage_counted = true,
           -- settled but refunded: it never holds a slot, so a later release must not give one back
           usage_released_at = case when v_reversed then coalesce(usage_released_at, now()) else usage_released_at end
     where id = p_ledger_id and usage_counted = false;
    get diagnostics v_flipped = row_count;

    if v_reversed then v_flipped := 0; end if;   -- settled, but the refunded sale never consumes a slot
  end if;

  if v_flipped > 0 then
    update referral_codes set uses_so_far = uses_so_far + 1 where id = v_code_id;
  end if;

  if p_reservation_id is not null then
    delete from referral_code_reservations where id = p_reservation_id;
  end if;

  return v_flipped > 0;
end;
$$;

revoke execute on function increment_referral_code_usage(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid, uuid, uuid) to service_role;

-- Sales settled while already reversed by the 0108 version: counted, never given a slot, not stamped released.
update commission_ledger o
   set usage_released_at = r.created_at
  from commission_ledger r
 where r.reverses_ledger_id = o.id
   and o.usage_counted
   and o.usage_released_at is null;

-- Always the LAST statements of a migration: the ledger row, then how far this database has been migrated.
insert into applied_migrations (version, name) values (123, '0123_partners_section4_round43')
on conflict (version) do nothing;

insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 123, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now()
  where coalesce((system_state.value ->> 'version')::int, 0) < 123;   -- never move the version BACKWARDS (a re-run of an older file)
