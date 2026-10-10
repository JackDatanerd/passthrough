-- 0071: Section 4 round 9 (bug) — a refund racing a fresh conversion permanently leaked a usage slot.
--
-- recordConversion writes the ledger row with usage_counted=false and THEN calls increment_referral_code_usage.
-- A refund landing between those two steps made reverseCommission read usage_counted=false, skip the decrement,
-- and insert the reversal; the RPC then bumped uses_so_far for a sale that was already reversed. Nothing ever
-- gave that slot back, so a limited code lost a use per occurrence.
--
-- Both sides now serialize on the ORIGINAL ledger row's lock, and the decision is taken inside SQL:
--   * increment_referral_code_usage locks the row, and if a reversal already exists it settles the flag
--     WITHOUT counting (and still frees the reservation);
--   * release_referral_code_usage_for_ledger (called by reverseCommission AFTER it inserted the reversal)
--     locks the same row and decrements only if the usage really was counted.
-- Whichever order the two transactions commit in, the counter ends up net zero for a reversed sale.

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
begin
  if p_ledger_id is not null then
    perform 1 from commission_ledger where id = p_ledger_id for update;
    select exists (select 1 from commission_ledger where reverses_ledger_id = p_ledger_id) into v_reversed;

    update commission_ledger
       set usage_counted = true
     where id = p_ledger_id and usage_counted = false;
    get diagnostics v_flipped = row_count;

    if v_reversed then v_flipped := 0; end if;   -- settled, but the refunded sale never consumes a slot
  end if;

  if v_flipped > 0 then
    update referral_codes set uses_so_far = uses_so_far + 1 where id = p_code_id;
  end if;

  if p_reservation_id is not null then
    delete from referral_code_reservations where id = p_reservation_id;
  end if;

  return v_flipped > 0;
end;
$$;

revoke execute on function increment_referral_code_usage(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function increment_referral_code_usage(uuid, uuid, uuid) to service_role;

-- Frees the slot a reversed sale consumed, atomically with the check that it was consumed.
-- Returns true when a slot was actually given back.
create or replace function release_referral_code_usage_for_ledger(p_ledger_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code    uuid;
  v_counted boolean;
begin
  select referral_code_id, usage_counted into v_code, v_counted
    from commission_ledger where id = p_ledger_id for update;
  if not found or v_code is null or v_counted is not true then
    return false;
  end if;
  update referral_codes set uses_so_far = greatest(uses_so_far - 1, 0) where id = v_code;
  return true;
end;
$$;

revoke execute on function release_referral_code_usage_for_ledger(uuid) from public, anon, authenticated;
grant  execute on function release_referral_code_usage_for_ledger(uuid) to service_role;

-- Always the LAST statement of a migration: records how far this database has been migrated.
insert into system_state (key, value)
values ('schema_version', jsonb_build_object('version', 71, 'applied_at', now()))
on conflict (key) do update set value = excluded.value, updated_at = now();
